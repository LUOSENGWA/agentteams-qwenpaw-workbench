# -*- coding: utf-8 -*-
"""同步引擎落盘存储（SYNC-STORE：根布局 + 缓存落盘 + 一次性迁移）。

设计依据：方案与设计/AgentTeams/下版本1.2.6-1.2.7/10-客户端同步与缓存/
QwenPaw插件存储与缓存-设计-20261107.md

根布局（§3）::

    <workspace>/.qwenpaw/agentteams/
    ├── workspace/<human>/files/**        镜像（唯一同步面）
    ├── .sync/{state.json, lock, conflicts.log}
    ├── cache/http/<sha1(method+url)>.json   {etag,lastModified,bodyHash,savedAt,size}
    ├── cache/http/<sha1>.body                响应体（≤256KB 才落盘）
    ├── cache/chat/<roomId>.json              {messages[], end}（窗口+游标）
    └── cache/lru/<key>.json                  memoryLru 落盘快照

- 工作区内 ``.qwenpaw/`` = 备份覆盖（include_agents）且 checkpoint 排除
  （静态排除名单）——设计 §2；
- 一次性迁移（§6）：旧根 ``<workspace>/agentteams`` 存在且新根不存在 →
  搬一次（``files/`` → ``workspace/<human>/files/``），state.json 记
  ``migratedFrom``；幂等（旧根已搬 / 新根已存在 → 不动）；
- 缓存写入全部原子（tmp + os.replace）；读回退 = 内存未命中读磁盘
  （lru 载回内存）。单写锁 ``.sync/lock`` 由 file_sync_engine 承担
  （PID + 时间戳，10 分钟过期可夺）。

容量上限（§5）：http ``.body`` 单文件 ≤256KB；chat 每房窗口 ≤500 条；
lru 条目数 200（与前端 memoryLru 上限一致）。
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(
    "qwenpaw.plugins.agentteams_qwenpaw_workbench.sync_store"
)

# state.json 顶层版本号（SYNC-STORE 新形状标记）。
STATE_VERSION = 1
# 容量上限（设计 §5 / 本仓实现口径）。
MAX_HTTP_BODY_BYTES = 256 * 1024  # cache/http .body 单文件 ≤256KB
MAX_CHAT_MESSAGES = 500  # cache/chat 每房窗口 ≤500 条
MAX_LRU_ENTRIES = 200  # cache/lru 条目数（前端 memoryLru(200) 同口径）
HTTP_DEFAULT_MAX_AGE = 300.0  # http 新鲜度判定默认窗口（秒）

# 落盘 key 安全过滤（kb_cache 同款口径：字母数字 + _ . -，
# 防路径穿越 / 特殊字符进文件名）。
_KEY_RE = re.compile(r"[^A-Za-z0-9_.-]")


def _safe_name(name: Any) -> str:
    s = _KEY_RE.sub("_", str(name or ""))
    return s or "_"


def http_key(method: str, url: str) -> str:
    """sha1(method+url) hex——``cache/http/<sha>.json`` 的文件名 stem。

    method 归一大写：同一请求不因调用方 method 大小写不同而分叉。
    """
    return hashlib.sha1(f"{str(method).upper()}{url}".encode("utf-8")).hexdigest()


def legacy_root_for(new_root: Path) -> Optional[Path]:
    """新根对应的旧镜像根（``.qwenpaw/agentteams`` 的同级 ``agentteams``）。

    ``<ws>/.qwenpaw/agentteams`` → ``<ws>/agentteams``（WORKING_DIR 级
    兜底根同规则）；不在 ``.qwenpaw/`` 下（如测试 tmp 根）→ None（无迁移
    概念，不会误搬）。
    """
    p = Path(new_root)
    if p.name == "agentteams" and p.parent.name == ".qwenpaw":
        return p.parent.parent / "agentteams"
    return None


def migrate_root(new_root: Path, human: str) -> Optional[str]:
    """一次性迁移（首启自动）：旧根存在 **且** 新根不存在 → 把旧根整体
    搬到新根位置，并把 ``files/`` 重排为 ``workspace/<human>/files/``。

    幂等：重跑时旧根已搬走 → None；新根已存在 → None（不碰既有新布局
    数据，旧根留给用户自行处置）。搬移失败 → None（只告警不炸启动，
    调用方按全新初始化继续）。

    返回迁移发生时的旧根路径字符串（调用方记 state.json ``migratedFrom``）；
    否则 None。
    """
    new_root = Path(new_root)
    old = legacy_root_for(new_root)
    if old is None or not old.is_dir() or new_root.exists():
        return None
    try:
        new_root.parent.mkdir(parents=True, exist_ok=True)  # <ws>/.qwenpaw 尚不存在
        shutil.move(str(old), str(new_root))
    except Exception as exc:  # noqa: BLE001 - 迁移失败不阻塞启动
        logger.warning("sync root migration failed (%s -> %s): %s", old, new_root, exc)
        return None
    old_files = new_root / "files"
    if old_files.is_dir():
        dest = new_root / "workspace" / str(human) / "files"
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            if dest.is_dir():  # 理论上不可达（前提=新根不存在）；防御性逐文件合并
                for p in sorted(old_files.rglob("*")):
                    if p.is_file():
                        t = dest / p.relative_to(old_files).as_posix()
                        t.parent.mkdir(parents=True, exist_ok=True)
                        shutil.move(str(p), str(t))
                shutil.rmtree(old_files, ignore_errors=True)
            else:
                shutil.move(str(old_files), str(dest))
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "sync files re-layout failed (%s -> %s): %s", old_files, dest, exc
            )
    return str(old)


class SyncStore:
    """同步根的磁盘缓存存储（http/chat/lru 三类；内存+磁盘双层，读回退）。

    读：内存命中 → 直接返回；未命中 → 读磁盘（lru 载回内存）。
    写：一律原子落盘（tmp + os.replace）；lru 同时更新内存并做条目数
    淘汰。全部失败静默（缓存不佳不影响主流程，kb_cache 同款口径）。
    """

    def __init__(
        self, root: Path, *, now: Optional[Callable[[], float]] = None
    ) -> None:
        self.root = Path(root)
        self.cache_dir = self.root / "cache"
        self.http_dir = self.cache_dir / "http"
        self.chat_dir = self.cache_dir / "chat"
        self.lru_dir = self.cache_dir / "lru"
        self._now = now or time.time
        self._mu = threading.Lock()
        self._lru_mem: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()

    def ensure_dirs(self) -> None:
        """建 cache/ 三级目录（mkdir -p）。"""
        for d in (self.http_dir, self.chat_dir, self.lru_dir):
            d.mkdir(parents=True, exist_ok=True)

    # ── 原子写 ─────────────────────────────────────────────────────

    @staticmethod
    def _atomic_write(path: Path, data: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, path)

    def _atomic_json(self, path: Path, obj: Any) -> None:
        self._atomic_write(path, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    # ── http：ETag 条件复验缓存（设计 §4）──────────────────────────

    def _http_meta_file(self, method: str, url: str) -> Path:
        return self.http_dir / f"{http_key(method, url)}.json"

    def http_get(
        self, method: str, url: str, *, max_age: Optional[float] = None
    ) -> Optional[Dict[str, Any]]:
        """读 http 缓存条目（读回退：直接读磁盘，无内存层）。

        返回 ``{etag, lastModified, bodyHash, savedAt, size, body}``
        （body 未落盘时为 None）；给了 ``max_age`` 且已过期 → None
        （调用方凭 ``http_etag`` 带 If-None-Match 复验）；条目缺失/
        损坏 → None。
        """
        f = self._http_meta_file(method, url)
        try:
            if not f.is_file():
                return None
            meta = json.loads(f.read_text(encoding="utf-8"))
            if not isinstance(meta, dict):
                return None
        except Exception:  # noqa: BLE001 - 缓存不佳不抛
            return None
        if max_age is not None:
            try:
                if self._now() - float(meta.get("savedAt", 0)) > max_age:
                    return None
            except Exception:  # noqa: BLE001
                return None
        body: Optional[bytes] = None
        try:
            bf = f.with_suffix(".body")
            if bf.is_file():
                body = bf.read_bytes()
        except Exception:  # noqa: BLE001
            body = None
        return {**meta, "body": body}

    def http_fresh(
        self, method: str, url: str, *, max_age: float = HTTP_DEFAULT_MAX_AGE
    ) -> Optional[Dict[str, Any]]:
        """新鲜度判定（TTL）：未过期 → 条目（命中）；过期/缺失 → None。"""
        return self.http_get(method, url, max_age=max_age)

    def http_etag(self, method: str, url: str) -> Optional[str]:
        """只读 etag（**不随过期失效**——下次回源 If-None-Match 的材料）。"""
        entry = self.http_get(method, url)
        if entry is None:
            return None
        e = entry.get("etag")
        return str(e) if e else None

    def http_put(
        self,
        method: str,
        url: str,
        *,
        etag: Optional[str] = None,
        last_modified: Optional[str] = None,
        body: Optional[bytes] = None,
    ) -> bool:
        """落 http 缓存（meta 写 ``<sha>.json``；body ≤256KB 才写 ``.body``）。

        返回 body 是否落盘（无 body / 超上限 → 只落 meta，并清掉陈旧
        ``.body`` 防旧体残留）。写失败 → False（静默）。
        """
        f = self._http_meta_file(method, url)
        meta: Dict[str, Any] = {
            "etag": str(etag) if etag else None,
            "lastModified": str(last_modified) if last_modified else None,
            "bodyHash": (
                hashlib.sha256(body).hexdigest()[:16] if body is not None else None
            ),
            "savedAt": self._now(),
            "size": len(body) if body is not None else None,
        }
        store_body = body is not None and len(body) <= MAX_HTTP_BODY_BYTES
        try:
            self._atomic_json(f, meta)
            bf = f.with_suffix(".body")
            if store_body:
                self._atomic_write(bf, body)
            else:
                bf.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001 - 缓存不佳不抛
            return False
        return store_body

    # ── chat：逐房窗口+游标（设计 §4）─────────────────────────────

    def _chat_file(self, room_id: Any) -> Path:
        return self.chat_dir / f"{_safe_name(room_id)}.json"

    def chat_get(self, room_id: Any) -> Optional[Dict[str, Any]]:
        """读单房缓存 ``{messages, end}``；缺失/损坏 → None。"""
        try:
            data = json.loads(self._chat_file(room_id).read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return None
        if isinstance(data, dict) and isinstance(data.get("messages"), list):
            return data
        return None

    def chat_put(self, room_id: Any, messages: List[Any], *, end: Any = None) -> int:
        """落单房窗口（截断到 ≤500 条，**保留最新**）；返回实际条数。

        0 = 写失败（静默）。整窗口覆盖写（原子替换）。
        """
        msgs = list(messages or [])[-MAX_CHAT_MESSAGES:]
        try:
            self._atomic_json(self._chat_file(room_id), {"messages": msgs, "end": end})
        except Exception:  # noqa: BLE001
            return 0
        return len(msgs)

    def chat_drop(self, room_id: Any) -> None:
        """删单房缓存（如退群）；缺失 → no-op。"""
        try:
            self._chat_file(room_id).unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass

    # ── lru：memoryLru 落盘快照（设计 §4）──────────────────────────

    def _lru_file(self, key: Any) -> Path:
        return self.lru_dir / f"{_safe_name(key)}.json"

    def lru_get(
        self, key: str, *, max_age: Optional[float] = None
    ) -> Optional[Dict[str, Any]]:
        """读 lru 条目（内存 → 磁盘回退并载回内存）。

        返回 ``{"value": ..., "savedAt": ...}``；缺失/过期/损坏 → None。
        """
        k = str(key)
        with self._mu:
            if k in self._lru_mem:
                self._lru_mem.move_to_end(k)
                entry = self._lru_mem[k]
                if max_age is not None and (
                    self._now() - float(entry.get("savedAt", 0)) > max_age
                ):
                    self._lru_mem.pop(k, None)
                    return None
                return dict(entry)
        try:
            raw = json.loads(self._lru_file(k).read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                return None
        except Exception:  # noqa: BLE001
            return None
        if max_age is not None:
            try:
                if self._now() - float(raw.get("savedAt", 0)) > max_age:
                    return None
            except Exception:  # noqa: BLE001
                return None
        with self._mu:
            self._lru_mem[k] = dict(raw)  # 读回退：磁盘 → 内存
            self._lru_evict_locked()
        return dict(raw)

    def lru_put(self, key: str, value: Any) -> None:
        """落 lru 条目（原子写盘 + 内存缓存 + 条目数淘汰）。

        超上限（200）→ 淘汰最久未用（内存按 LRU 序、磁盘按 mtime 序，
        并列按文件名）。写失败静默。
        """
        k = str(key)
        entry: Dict[str, Any] = {"value": value, "savedAt": self._now()}
        try:
            self._atomic_json(self._lru_file(k), entry)
        except Exception:  # noqa: BLE001
            return
        with self._mu:
            self._lru_mem[k] = dict(entry)
            self._lru_mem.move_to_end(k)
            self._lru_evict_locked()

    def lru_drop(self, key: str) -> None:
        """删单个 lru 条目（内存+磁盘）；缺失 → no-op。"""
        k = str(key)
        with self._mu:
            self._lru_mem.pop(k, None)
        try:
            self._lru_file(k).unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass

    def lru_count(self) -> int:
        """磁盘 lru 条目数（容量可观测）。"""
        try:
            return len(
                [
                    p
                    for p in self.lru_dir.glob("*.json")
                    if not p.name.endswith(".tmp")
                ]
            )
        except Exception:  # noqa: BLE001
            return 0

    def _lru_evict_locked(self) -> None:
        """条目数收敛到上限内（持 _mu 调用）。"""
        while len(self._lru_mem) > MAX_LRU_ENTRIES:
            self._lru_mem.popitem(last=False)
        try:
            files = [
                p
                for p in self.lru_dir.glob("*.json")
                if not p.name.endswith(".tmp")
            ]
            files.sort(key=lambda p: (p.stat().st_mtime, p.name))
            for p in files[: max(0, len(files) - MAX_LRU_ENTRIES)]:
                p.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass
