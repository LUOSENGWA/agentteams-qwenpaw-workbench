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
    ├── cache/chat.db                        聊天消息 SQLite（永久保留 + 2GB LRU）
    └── cache/lru/<key>.json                  memoryLru 落盘快照

- 工作区内 ``.qwenpaw/`` = 备份覆盖（include_agents）且 checkpoint 排除
  （静态排除名单）——设计 §2；
- 一次性迁移（§6）：旧根 ``<workspace>/agentteams`` 存在且新根不存在 →
  搬一次（``files/`` → ``workspace/<human>/files/``），state.json 记
  ``migratedFrom``；幂等（旧根已搬 / 新根已存在 → 不动）；
- 缓存写入全部原子（tmp + os.replace）；读回退 = 内存未命中读磁盘
  （lru 载回内存）。单写锁 ``.sync/lock`` 由 file_sync_engine 承担
  （PID + 时间戳，10 分钟过期可夺）。

容量上限（§5）：http ``.body`` 单文件 ≤256KB；chat 落 SQLite（``chat_db``，
**不按房间截断历史**，库总量 >2GB 才按房间 LRU 整房淘汰）；lru 条目数
200（与前端 memoryLru 上限一致）。
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

from .chat_db import ChatDB

logger = logging.getLogger(
    "qwenpaw.plugins.agentteams_qwenpaw_workbench.sync_store"
)

# state.json 顶层版本号（SYNC-STORE 新形状标记）。
STATE_VERSION = 1
# 容量上限（设计 §5 / 本仓实现口径）。
MAX_HTTP_BODY_BYTES = 256 * 1024  # cache/http .body 单文件 ≤256KB
MAX_CHAT_MESSAGES = 500  # 单次 GET 默认/最大窗口（DB 永久保留，不截断历史）
MAX_CHAT_TOTAL_BYTES = 2 * 1024 * 1024 * 1024  # chat.db 全局上限 2GB（房间 LRU）
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
    写：http/lru 原子落盘（tmp + os.replace），chat 走 SQLite（``chat_db``，
    ``event_id`` 增量 upsert，永久保留 + 全局 2GB 房间 LRU）。全部失败
    静默（缓存不佳不影响主流程，kb_cache 同款口径）。
    """

    def __init__(
        self,
        root: Path,
        *,
        now: Optional[Callable[[], float]] = None,
        chat_max_bytes: int = MAX_CHAT_TOTAL_BYTES,
    ) -> None:
        self.root = Path(root)
        self.cache_dir = self.root / "cache"
        self.http_dir = self.cache_dir / "http"
        # 旧 JSON 目录（仅迁移源；运行路径不再读写，见 chat_db）。
        self.chat_dir = self.cache_dir / "chat"
        self.lru_dir = self.cache_dir / "lru"
        self._now = now or time.time
        self._mu = threading.Lock()
        self._lru_mem: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        self._chat_max_bytes = int(chat_max_bytes)
        self._chat_db: Optional["ChatDB"] = None

    def ensure_dirs(self) -> None:
        """建 http/lru 缓存目录（mkdir -p）。

        ``cache/chat/``（旧 JSON 布局）不再强制创建；chat.db 由 ChatDB 首次
        使用时建。旧目录若存在，留给 ChatDB 一次性迁移处理。
        """
        for d in (self.http_dir, self.lru_dir):
            d.mkdir(parents=True, exist_ok=True)

    @property
    def chat_db(self) -> "ChatDB":
        """聊天消息库（惰性创建：不在 import/构造期连库）。"""
        db = self._chat_db
        if db is None:
            with self._mu:
                if self._chat_db is None:
                    self._chat_db = ChatDB(
                        self.root, now=self._now, max_bytes=self._chat_max_bytes
                    )
                db = self._chat_db
        return db

    def close(self) -> None:
        """关闭聊天库连接（幂等；测试/退出用）。"""
        with self._mu:
            db = self._chat_db
        if db is not None:
            db.close()

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

    # ── chat：SQLite 消息库（永久保留；见 chat_db）──────────────────

    def chat_get(
        self, room_id: Any, limit: Optional[int] = None
    ) -> Optional[Dict[str, Any]]:
        """读房间消息 ``{messages, end}``（升序）。

        ``limit``：最近 N 条；None = 整房全部。房间不存在 → None（路由
        层据此返回 200 空窗口，语义由 storage_api 承担）。
        """
        db = self.chat_db
        rid = str(room_id)
        if not db.has_room(rid):
            return None
        return {
            "messages": db.get_recent(rid, limit),
            "end": db.get_end_cursor(rid),
        }

    def chat_window(
        self, room_id: Any, event_id: str, before: int = 25, after: int = 25
    ) -> Optional[Dict[str, Any]]:
        """目标消息前后各 N 条（升序，含目标）；房间不存在 → None。"""
        db = self.chat_db
        rid = str(room_id)
        if not db.has_room(rid):
            return None
        return {
            "messages": db.get_window(rid, str(event_id), before, after),
            "end": db.get_end_cursor(rid),
        }

    def chat_put(
        self, room_id: Any, messages: List[Any], *, end: Any = None
    ) -> int:
        """增量 upsert（``event_id`` 去重；不截断历史）；返回本批条数。

        写失败向上抛（路由层映射 503，前端静默降级）。
        """
        return self.chat_db.put_messages(
            str(room_id), list(messages or []), end=end if isinstance(end, str) else None
        )

    def chat_drop(self, room_id: Any) -> None:
        """删单房消息 + 游标（如退群）；缺失 → no-op。"""
        try:
            self.chat_db.drop_room(str(room_id))
        except Exception:  # noqa: BLE001 - 删除失败不炸路由
            pass

    def chat_bytes(self) -> int:
        """chat.db 占用字节（状态面用；库未建 → 0）。"""
        try:
            return self.chat_db.size_bytes()
        except Exception:  # noqa: BLE001
            return 0

    def chat_prune(
        self,
        max_rooms: int = 0,
        max_bytes: Optional[int] = None,
    ) -> Dict[str, int]:
        """全局容量整理：库 > ``max_bytes`` 时按 ``rooms.last_access`` LRU
        整房淘汰（至少保留 1 房）。

        ``max_rooms`` 仅为兼容旧签名而保留（旧「每房/30 房」策略已退役；
        用户口径：历史永久保留）。``max_bytes=None`` → 用本 store 的上限
        （构造参数 ``chat_max_bytes``，默认 2GB）。返回
        ``{removedFiles, freedBytes}``（沿用旧 JSON 口径的字段名，
        状态面/测试零改动）。
        """
        del max_rooms  # 旧房间数预算：不再使用
        try:
            return self.chat_db.prune(max_bytes=max_bytes)
        except Exception as exc:  # noqa: BLE001 - 整理失败不炸路由
            logger.warning("chat prune failed: %s", exc)
            return {"removedFiles": 0, "freedBytes": 0}

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
