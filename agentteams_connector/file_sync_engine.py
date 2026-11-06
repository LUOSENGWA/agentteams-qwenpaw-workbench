# -*- coding: utf-8 -*-
"""工作区文件镜像同步引擎（files/** ↔ Controller 文件区）。

设计依据：方案与设计/AgentTeams/下版本1.2.6-1.2.7/文件同步-工作区镜像设计-20261107.md
- 同步引擎跑在**插件后端**（浏览器无文件系统）；镜像落在 QwenPaw 工作区内
  ``agentteams/``（``.sync/`` 状态 + ``files/`` 镜像，随工作区持久化/备份）。
- 服务端只存清单不合并（#1499）；写回是条件 PUT（``If-Match`` → 412 本轮
  结束并标记 retry，**不循环**，下一轮重来）。
- 命名：仓库已有 ``sync_watcher.py``（Matrix /sync 长轮询）易混 → 本单模块名
  ``file_sync_engine``，钩子名 ``agentteams-file-sync``。

骨架级实现：``run_once`` 全链路可注入（``ctl_call``/``now`` 可 fake），
单测（tests/test_sync_engine.py）全部离线；真实 ``ctl_call`` 基于连接器既有
拨号原语构建（router._ordered_addresses/_headers_for + httpx 同步客户端——
run_once 经 asyncio.to_thread 调用，必须是同步函数）。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import random
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .dial_gate import sync_dial_slot

logger = logging.getLogger(
    "qwenpaw.plugins.agentteams_qwenpaw_workbench.file_sync"
)

# .sync/lock 过期阈值（秒）——O_EXCL 创建 + 30 分钟过期可夺（设计 §5）。
LOCK_STALE_SECONDS = 30 * 60
# 定时：启动 60s 后首跑，之后每 300s（±30s jitter）（设计 §5 / 任务书）。
# 定时器先用常量，配置项后续加（设计 §8）。
FIRST_DELAY_SECONDS = 60.0
INTERVAL_SECONDS = 300.0
JITTER_SECONDS = 30.0
# 默认同步的 human（设计 §6：当前用户）；AGENTTEAMS_SYNC_HUMAN 可覆盖。
DEFAULT_HUMAN = "luo"
# 禁入目录（设计 §6 路径校验：.trash/.sync/.control 不同步）。
_FORBIDDEN_ROOTS = (".trash", ".sync", ".control")


# ── 时间/路径工具 ─────────────────────────────────────────────────────


def _iso(ts: float) -> str:
    return (
        datetime.fromtimestamp(ts, tz=timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _parse_iso(s: str) -> float:
    s2 = (s or "").strip()
    if s2.endswith("Z"):
        s2 = s2[:-1] + "+00:00"
    dt = datetime.fromisoformat(s2)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def _utc_stamp(ts: float) -> str:
    """冲突副本时间戳：``20261106T183000Z``（无冒号，文件系统安全）。"""
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime(
        "%Y%m%dT%H%M%SZ"
    )


def _sha16(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


def safe_rel_path(path: Any) -> Optional[str]:
    """路径校验（设计 §6）：拒绝绝对路径/``..``/保留目录，返回规范化相对路径。

    宽松但严格：只接受纯相对 POSIX 路径；反斜杠归一为正斜杠后按段检查。
    非法 → None（调用方跳过该条目，不报错——远端清单里混入脏路径不应
    打挂整轮同步）。
    """
    p = str(path or "").strip()
    if not p or "\0" in p:
        return None
    if p.startswith(("/", "\\")) or (len(p) > 1 and p[1] == ":"):
        return None
    parts = p.replace("\\", "/").split("/")
    if any(part in ("", ".", "..") for part in parts):
        return None
    if parts[0] in _FORBIDDEN_ROOTS:
        return None
    return "/".join(parts)


# ── HTTP 结果（统一形状：status_code / headers(小写键) / content） ────


class HttpResult:
    """ctl_call 的统一返回形状。

    真实实现由 httpx 响应构造；测试 fake 直接构造本类——引擎只依赖
    ``status_code`` / ``headers`` / ``content`` / ``json()`` 四个面。
    """

    __slots__ = ("status_code", "headers", "content")

    def __init__(
        self,
        status_code: int,
        headers: Optional[Dict[str, str]] = None,
        content: Optional[bytes] = None,
    ) -> None:
        self.status_code = int(status_code)
        self.headers = {
            str(k).lower(): str(v) for k, v in (headers or {}).items()
        }
        self.content = content or b""

    def json(self) -> Any:
        return json.loads(self.content.decode("utf-8"))

    def text(self) -> str:
        return self.content.decode("utf-8", "replace")


# ── 同步引擎 ─────────────────────────────────────────────────────────


class SyncEngine:
    """单 human 的镜像同步引擎（骨架级，全链路可注入）。

    参数
    ----
    root:
        镜像根（``<workspace>/agentteams``）。引擎在 ``root`` 下自建
        ``.sync/``（state.json/lock/conflicts.log）与 ``files/``。
    human:
        要同步的 Controller human（默认当前用户 luo）。
    ctl_call:
        同步 HTTP 调用 ``ctl_call(method, path, *, params=None,
        headers=None, json_body=None, content=None) -> HttpResult``。
        ``path`` 为相对 Controller 的路径（如
        ``/api/v1/humans/{h}/sync/status``），预签名直链可传绝对
        http(s) URL。
    now:
        时钟注入（默认 ``time.time``），测试用固定时钟验证锁过期等。
    """

    def __init__(
        self,
        root: Path,
        *,
        human: str,
        ctl_call: Callable[..., HttpResult],
        now: Optional[Callable[[], float]] = None,
    ) -> None:
        self.root = Path(root)
        self.human = str(human or DEFAULT_HUMAN)
        self.ctl_call = ctl_call
        self._now = now or time.time
        self.sync_dir = self.root / ".sync"
        self.state_file = self.sync_dir / "state.json"
        self.lock_file = self.sync_dir / "lock"
        self.conflicts_log = self.sync_dir / "conflicts.log"
        self.files_dir = self.root / "files"
        self.sync_dir.mkdir(parents=True, exist_ok=True)
        self.files_dir.mkdir(parents=True, exist_ok=True)
        self._holding_lock = False
        self._last_error: Optional[str] = None

    # ── 对外接口 ─────────────────────────────────────────────────────

    def state(self) -> Dict[str, Any]:
        """供 GET /sync/state（设计 §7 可观测面）。"""
        st = self._load_state()
        rec = (st.get("humans") or {}).get(self.human) or {}
        etags = rec.get("etags") or {}
        return {
            "enabled": True,
            "generation": rec.get("generation"),
            "files": len(etags),
            "conflicts": self._conflict_count(),
            "lastRunAt": rec.get("lastRunAt"),
            "lastError": self._last_error,
            "locked": self._lock_held(),
            "humans": st.get("humans") or {},
        }

    def run_once(self) -> Dict[str, Any]:
        """跑一轮同步（同步函数，供 asyncio.to_thread 调用）。

        返回形态：
        - 锁被占 → ``{"locked": True}``
        - 控制器无清单接口（404/405/501）→ ``{"enabled": False, "reason":
          "controller_without_manifest"}``（**不重试**）
        - generation 未变 → ``{"skipped": "same-generation"}``
        - 清单写回 412 → ``{"retry": True, ...计数}``（本轮结束，不循环）
        - 正常 → ``{changed, downloaded, uploaded, conflicts, skipped,
          retry: False, generation, lastRunAt}``
        - 异常 → ``{"error": "..."}``（吞掉不抛，宿主不受影响）
        """
        if not self._acquire_lock():
            return {"locked": True}
        try:
            try:
                result = self._run_locked()
            except Exception as exc:  # noqa: BLE001 - 骨架级：任何异常不逃逸
                result = {"error": f"{type(exc).__name__}: {exc}"}
        finally:
            self._release_lock()
        self._last_error = result.get("error")
        return result

    # ── 锁 ───────────────────────────────────────────────────────────

    def _lock_payload(self) -> str:
        return json.dumps(
            {"pid": os.getpid(), "at": _iso(self._now())},
            ensure_ascii=False,
        )

    def _acquire_lock(self) -> bool:
        """O_EXCL 抢锁；>30min 视为过期可夺（按内容 at，回退 mtime）。"""
        try:
            fd = os.open(
                str(self.lock_file),
                os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                0o644,
            )
        except FileExistsError:
            try:
                data = json.loads(self.lock_file.read_text(encoding="utf-8"))
                at = data.get("at") if isinstance(data, dict) else None
            except Exception:  # noqa: BLE001 - 锁内容损坏按 mtime 判
                at = None
            try:
                if at:
                    age = self._now() - _parse_iso(str(at))
                else:
                    age = self._now() - self.lock_file.stat().st_mtime
            except Exception:  # noqa: BLE001
                age = 0.0
            if age <= LOCK_STALE_SECONDS:
                return False
            try:  # 过期 → 夺锁（覆盖写）
                self.lock_file.write_text(self._lock_payload(), encoding="utf-8")
                self._holding_lock = True
                return True
            except Exception:  # noqa: BLE001
                return False
        except Exception:  # noqa: BLE001 - 创建失败当被占（保守不跑）
            return False
        self._holding_lock = True
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(self._lock_payload())
        except Exception:  # noqa: BLE001
            pass
        return True

    def _release_lock(self) -> None:
        if not self._holding_lock:
            return
        self._holding_lock = False
        try:
            data = json.loads(self.lock_file.read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("pid") == os.getpid():
                self.lock_file.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001 - 兜底：自己持锁则删
            try:
                self.lock_file.unlink(missing_ok=True)
            except Exception:  # noqa: BLE001
                pass

    def _lock_held(self) -> bool:
        if not self.lock_file.exists():
            return False
        try:
            data = json.loads(self.lock_file.read_text(encoding="utf-8"))
            at = data.get("at") if isinstance(data, dict) else None
            if at:
                return (self._now() - _parse_iso(str(at))) <= LOCK_STALE_SECONDS
        except Exception:  # noqa: BLE001
            pass
        try:
            return (
                self._now() - self.lock_file.stat().st_mtime
            ) <= LOCK_STALE_SECONDS
        except Exception:  # noqa: BLE001
            return True

    # ── 状态文件 ─────────────────────────────────────────────────────

    def _load_state(self) -> Dict[str, Any]:
        try:
            data = json.loads(self.state_file.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("humans"), dict):
                return data
        except Exception:  # noqa: BLE001 - 状态缺失/损坏 → 从零重建
            pass
        return {"humans": {}}

    def _save_state(self, st: Dict[str, Any]) -> None:
        tmp = self.state_file.with_name(self.state_file.name + ".tmp")
        tmp.write_text(
            json.dumps(st, ensure_ascii=False, indent=1), encoding="utf-8"
        )
        os.replace(tmp, self.state_file)

    def _conflict_count(self) -> int:
        try:
            with open(self.conflicts_log, "r", encoding="utf-8") as f:
                return sum(1 for line in f if line.strip())
        except Exception:  # noqa: BLE001
            return 0

    # ── 轮内主流程 ───────────────────────────────────────────────────

    def _run_locked(self) -> Dict[str, Any]:
        # 1) status——404/405/501 = 控制器无清单接口（旧版）→ 降级不重试。
        r = self.ctl_call(
            "GET", f"/api/v1/humans/{self.human}/sync/status"
        )
        if r.status_code in (404, 405, 501):
            return {
                "enabled": False,
                "reason": "controller_without_manifest",
            }
        if r.status_code != 200:
            return {"error": f"sync/status HTTP {r.status_code}"}
        status = r.json()
        if not isinstance(status, dict):
            status = {}
        generation = status.get("generation")

        st = self._load_state()
        rec = (st.get("humans") or {}).get(self.human) or {}
        if generation is not None and generation == rec.get("generation"):
            return {"skipped": "same-generation"}

        # 2) manifest（响应头 ETag 用于条件写回——真实实现走 httpx 直连）。
        r = self.ctl_call(
            "GET", f"/api/v1/humans/{self.human}/sync/manifest"
        )
        if r.status_code in (404, 405, 501):
            return {
                "enabled": False,
                "reason": "controller_without_manifest",
            }
        if r.status_code != 200:
            return {"error": f"sync/manifest HTTP {r.status_code}"}
        manifest = r.json()
        manifest_etag = self._etag_from(r, manifest)
        entries = self._parse_entries(manifest)

        # 3) 本地扫描 + 逐条比对。
        local = self._scan_local()
        prev_etags = rec.get("etags") or {}
        prev_local = rec.get("local") or {}
        entry_paths = {e["path"] for e in entries}

        new_etags: Dict[str, str] = dict(prev_etags)
        new_local: Dict[str, Dict[str, float]] = dict(prev_local)
        new_entries: Dict[str, Dict[str, Any]] = {
            e["path"]: dict(e) for e in entries
        }
        changed = downloaded = uploaded = conflicts = skipped = 0

        for e in entries:
            rel, etag = e["path"], e["etag"]
            lnow = local.get(rel)
            prev_l = prev_local.get(rel)
            local_changed = lnow is not None and (
                prev_l is None
                or lnow["mtime"] != prev_l.get("mtime")
                or lnow["size"] != prev_l.get("size")
            )
            remote_changed = etag != prev_etags.get(rel)

            if remote_changed and local_changed:
                # 4) 两侧都变 → 本地另存冲突副本并上传；远端覆盖主文件；
                #    追加 conflicts.log（设计 §4，Dropbox 双版本同构）。
                ts = self._now()
                cname = f"{rel}.conflict-{_utc_stamp(ts)}"
                try:
                    local_bytes = (self.files_dir / rel).read_bytes()
                except Exception:  # noqa: BLE001 - 本地已删按纯远端变处理
                    local_bytes = None
                # 本地版本另存 <name>.conflict-<UTCts>（先落盘再上传）
                if (
                    local_bytes is not None
                    and self._write_file(cname, local_bytes)
                    and self._upload(cname, local_bytes)
                ):
                    uploaded += 1
                    cst = (self.files_dir / cname).stat()
                    c_etag = f"local:{_sha16(local_bytes)}"
                    new_local[cname] = {
                        "mtime": cst.st_mtime, "size": cst.st_size
                    }
                    new_etags[cname] = c_etag
                    new_entries[cname] = {
                        "path": cname, "etag": c_etag, "size": cst.st_size
                    }
                    self._log_conflict(rel, prev_etags.get(rel), etag, cname)
                if self._download(rel):
                    downloaded += 1
                    changed += 1
                    new_etags[rel] = etag
                    new_local[rel] = self._stat_rel(rel)
                conflicts += 1
            elif remote_changed:
                if self._download(rel):
                    downloaded += 1
                    changed += 1
                    new_etags[rel] = etag
                    new_local[rel] = self._stat_rel(rel)
            elif local_changed:
                try:
                    data = (self.files_dir / rel).read_bytes()
                except Exception:  # noqa: BLE001
                    data = None
                if data is not None and self._upload(rel, data):
                    uploaded += 1
                    changed += 1
                    u_etag = f"local:{_sha16(data)}"
                    new_etags[rel] = u_etag
                    new_local[rel] = {
                        "mtime": lnow["mtime"], "size": lnow["size"]
                    }
                    new_entries[rel] = {
                        "path": rel, "etag": u_etag, "size": len(data)
                    }
            else:
                skipped += 1
                new_local[rel] = dict(lnow)

        # 本地新文件（manifest 与 state 都未见）→ 上传；远端已删（state
        # 见过、本轮 manifest 无）→ 骨架级不实现删除语义，本地保留不追。
        for rel, lnow in local.items():
            if rel in entry_paths:
                continue
            if rel in prev_local:
                continue
            try:
                data = (self.files_dir / rel).read_bytes()
            except Exception:  # noqa: BLE001
                continue
            if self._upload(rel, data):
                uploaded += 1
                changed += 1
                u_etag = f"local:{_sha16(data)}"
                new_etags[rel] = u_etag
                new_local[rel] = dict(lnow)
                new_entries[rel] = {
                    "path": rel, "etag": u_etag, "size": len(data)
                }

        # 5) 条件写回清单（If-Match；412 → 本轮结束不循环，state 不更新，
        #    下一轮重来）。
        put_headers: Dict[str, str] = {}
        if manifest_etag:
            put_headers["If-Match"] = manifest_etag
        r = self.ctl_call(
            "PUT",
            f"/api/v1/humans/{self.human}/sync/manifest",
            json_body=self._rebuild_manifest(manifest, new_entries),
            headers=put_headers,
        )
        counts = {
            "changed": changed,
            "downloaded": downloaded,
            "uploaded": uploaded,
            "conflicts": conflicts,
            "skipped": skipped,
        }
        if r.status_code == 412:
            return {"retry": True, **counts}
        if r.status_code not in (200, 201):
            return {"error": f"sync/manifest PUT HTTP {r.status_code}", **counts}

        # 6) 更新 state（generation/etags/lastRunAt），释放锁在 run_once。
        last_run_at = _iso(self._now())
        st.setdefault("humans", {})[self.human] = {
            "generation": generation,
            "etags": new_etags,
            "local": new_local,
            "lastRunAt": last_run_at,
        }
        self._save_state(st)
        return {
            "retry": False,
            **counts,
            "generation": generation,
            "lastRunAt": last_run_at,
        }

    # ── manifest 宽松解析 / 重建 ─────────────────────────────────────

    @staticmethod
    def _etag_from(r: HttpResult, manifest: Any) -> Optional[str]:
        etag = r.headers.get("etag")
        if etag:
            return str(etag)
        if isinstance(manifest, dict):
            v = manifest.get("etag") or manifest.get("ETag")
            if v:
                return str(v)
        return None

    @staticmethod
    def _parse_entries(manifest: Any) -> List[Dict[str, Any]]:
        """宽松解析 manifest 条目（条目形状以实际返回为准，设计 §3）。

        接受：裸 list；dict 的 entries/files/items 键；dict 的
        path→meta 映射。字段别名：path|name|file|rel、etag|ETag|
        digest|hash、size|length。非法路径条目静默丢弃。
        """
        if manifest is None:
            return []
        raw: List[Any] = []
        if isinstance(manifest, list):
            raw = manifest
        elif isinstance(manifest, dict):
            for key in ("entries", "files", "items"):
                v = manifest.get(key)
                if isinstance(v, list):
                    raw = v
                    break
            else:
                raw = [
                    {"path": k, **v}
                    for k, v in manifest.items()
                    if isinstance(v, dict)
                ]
        else:
            return []
        seen: Dict[str, Dict[str, Any]] = {}
        for e in raw:
            if not isinstance(e, dict):
                continue
            path = e.get("path") or e.get("name") or e.get("file") or e.get("rel")
            if not isinstance(path, str):
                continue
            rel = safe_rel_path(path)
            if rel is None:
                continue
            etag = (
                e.get("etag")
                or e.get("ETag")
                or e.get("digest")
                or e.get("hash")
            )
            size = e.get("size", e.get("length"))
            seen[rel] = {
                "path": rel,
                "etag": str(etag) if etag is not None else None,
                "size": size,
            }
        return list(seen.values())

    @staticmethod
    def _rebuild_manifest(
        original: Any, entries_map: Dict[str, Dict[str, Any]]
    ) -> Any:
        """按原始 manifest 形状重建（list 回 list；dict 保其余键、
        更新 entries 段；未知形状回裸 list）。"""
        entries = [dict(v) for v in entries_map.values()]
        if isinstance(original, list):
            return entries
        if isinstance(original, dict):
            out = {
                k: v
                for k, v in original.items()
                if k not in ("entries", "files", "items")
            }
            key = next(
                (k for k in ("entries", "files", "items") if k in original),
                "entries",
            )
            out[key] = entries
            return out
        return entries

    # ── 本地扫描 / 读写 ──────────────────────────────────────────────

    def _scan_local(self) -> Dict[str, Dict[str, float]]:
        out: Dict[str, Dict[str, float]] = {}
        if not self.files_dir.is_dir():
            return out
        for p in self.files_dir.rglob("*"):
            try:
                if not p.is_file():
                    continue
            except Exception:  # noqa: BLE001
                continue
            rel = safe_rel_path(p.relative_to(self.files_dir).as_posix())
            if rel is None:
                continue
            st = p.stat()
            out[rel] = {"mtime": st.st_mtime, "size": st.st_size}
        return out

    def _stat_rel(self, rel: str) -> Dict[str, float]:
        st = (self.files_dir / rel).stat()
        return {"mtime": st.st_mtime, "size": st.st_size}

    def _write_file(self, rel: str, data: bytes) -> bool:
        rel = safe_rel_path(rel)
        if rel is None:
            return False
        p = self.files_dir / rel
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_name(p.name + ".sync-tmp")
            tmp.write_bytes(data)
            os.replace(tmp, p)
            return True
        except Exception:  # noqa: BLE001
            try:
                p.with_name(p.name + ".sync-tmp").unlink(missing_ok=True)
            except Exception:  # noqa: BLE001
                pass
            return False

    # ── 下载 / 上传 ──────────────────────────────────────────────────

    def _download(self, rel: str) -> bool:
        """GET …/files/{path}?presign=1：200 且带 url → 用 url 直取；
        否则直读 body；presign 不可用（4xx/5xx）→ 退回无参 GET。"""
        base = f"/api/v1/humans/{self.human}/files/{rel}"
        try:
            r = self.ctl_call("GET", base, params={"presign": "1"})
        except Exception as exc:  # noqa: BLE001
            logger.debug("file sync download presign failed: %s", exc)
            return False
        candidates: List[tuple] = []  # (kind, target, inline_body)
        if r.status_code == 200:
            url = None
            try:
                j = r.json()
                if isinstance(j, dict):
                    url = (
                        j.get("url")
                        or j.get("presignedUrl")
                        or j.get("presigned_url")
                    )
            except Exception:  # noqa: BLE001 - 非 JSON body 按直读处理
                pass
            if url:
                candidates.append(("GET", str(url), None))
            elif r.content:
                candidates.append(("_body", None, r.content))
        if not candidates and r.status_code in (400, 404, 405, 501):
            candidates.append(("GET", base, None))
        for kind, target, body in candidates:
            if kind == "_body":
                if body and self._write_file(rel, body):
                    return True
                continue
            try:
                r2 = self.ctl_call("GET", target)
            except Exception as exc:  # noqa: BLE001
                logger.debug("file sync download %s failed: %s", target, exc)
                continue
            if r2.status_code == 200 and r2.content:
                if self._write_file(rel, r2.content):
                    return True
        return False

    def _upload(self, rel: str, data: bytes) -> bool:
        """POST …/files/{path}?presign=1 → 直传 → /commit；
        presign 不可用 → 直接 PUT …/files/{path}。"""
        if safe_rel_path(rel) is None:
            return False
        base = f"/api/v1/humans/{self.human}/files/{rel}"
        presign: Optional[Dict[str, Any]] = None
        try:
            r = self.ctl_call("POST", base, params={"presign": "1"})
            if r.status_code == 200:
                try:
                    j = r.json()
                    if isinstance(j, dict) and (
                        j.get("url") or j.get("presignedUrl")
                    ):
                        presign = j
                except Exception:  # noqa: BLE001
                    presign = None
        except Exception as exc:  # noqa: BLE001
            logger.debug("file sync presign request failed: %s", exc)
        if presign is not None:
            url = str(presign.get("url") or presign.get("presignedUrl"))
            method = str(presign.get("method") or "PUT").upper()
            hdrs = presign.get("headers")
            if not isinstance(hdrs, dict):
                hdrs = {}
            try:
                up = self.ctl_call(method, url, headers=dict(hdrs), content=data)
            except Exception as exc:  # noqa: BLE001
                logger.debug("file sync presigned upload failed: %s", exc)
                return False
            if up.status_code not in (200, 201, 204):
                return False
            try:
                c = self.ctl_call(
                    "POST",
                    f"{base}/commit",
                    json_body={"size": len(data), "source": "plugin-file-sync"},
                )
            except Exception as exc:  # noqa: BLE001
                logger.debug("file sync commit failed: %s", exc)
                return False
            return c.status_code in (200, 201, 204)
        try:
            p = self.ctl_call("PUT", base, content=data)
        except Exception as exc:  # noqa: BLE001
            logger.debug("file sync direct PUT failed: %s", exc)
            return False
        return p.status_code in (200, 201, 204)

    def _log_conflict(
        self, rel: str, local_etag: Any, remote_etag: Any, cname: str
    ) -> None:
        line = json.dumps(
            {
                "ts": _iso(self._now()),
                "path": rel,
                "localEtag": local_etag,
                "remoteEtag": remote_etag,
                "conflictCopy": cname,
            },
            ensure_ascii=False,
        )
        try:
            with open(self.conflicts_log, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception as exc:  # noqa: BLE001 - 日志失败不影响主流程
            logger.debug("file sync conflicts.log write failed: %s", exc)


# ── 工作区解析 / 真实 ctl_call / 单例与后台循环 ───────────────────────


def _working_dir() -> Path:
    """QwenPaw 工作区根。优先 qwenpaw.constant.WORKING_DIR（不硬编码）；
    隔离导入（无宿主）时走与 config.py SECRET_DIR 同款 fallback。"""
    try:  # pragma: no cover - 宿主内走这里
        from qwenpaw.constant import WORKING_DIR

        p = Path(WORKING_DIR)
        if p.is_dir():
            return p
    except Exception:  # noqa: BLE001
        pass
    return Path.home() / ".qwenpaw" / "working"


# 「插件当前 agent」注入点——QwenPaw 插件 SDK 目前未向全局插件暴露
# agent 上下文（PluginApi/RuntimeHelpers 均无），宿主后续暴露时由装配侧
# 在 register 期调用本函数；在此之前以 AGENTTEAMS_SYNC_AGENT env 为准。
_current_agent: Optional[str] = None


def set_current_agent(agent: Optional[str]) -> None:
    """宿主装配侧注入插件当前 agent（可选；env 优先于本注入）。"""
    global _current_agent
    _current_agent = str(agent).strip() if agent else None


def resolve_workspace_root(
    agent: Optional[str] = None, working: Optional[Path] = None
) -> Path:
    """镜像根解析（任务书顺序）：

    1. ``<WORKING_DIR>/workspaces/<agent>/agentteams``——agent 默认取插件
       当前 agent（注入 > ``AGENTTEAMS_SYNC_AGENT`` env）；
    2. 该 agent 工作区不存在 → ``<WORKING_DIR>/agentteams``。
    """
    base = Path(working) if working is not None else _working_dir()
    a = str(
        agent
        or os.environ.get("AGENTTEAMS_SYNC_AGENT")
        or _current_agent
        or ""
    ).strip()
    if a:
        ws = base / "workspaces" / a
        if ws.is_dir():
            return ws / "agentteams"
    return base / "agentteams"


def build_ctl_call() -> Callable[..., HttpResult]:
    """真实 ctl_call：httpx 同步客户端 + 连接器既有拨号原语。

    run_once 经 asyncio.to_thread 跑在工作线程里，这里必须同步。复用
    ``router._ordered_addresses``（地址 failover 顺序）与
    ``router._headers_for``（该地址覆盖凭据）；token 走
    ``router_models._resolve_controller_token``。绝对 http(s) 路径
    （预签名直链）原样直拨、不套 controller 凭据。

    惰性 import router/config——避免与 routers 包的循环导入
    （sync_api 在 router.build_router 内装配）。
    """
    from urllib.parse import urlencode

    def ctl_call(
        method: str,
        path: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
        json_body: Optional[Dict[str, Any]] = None,
        content: Optional[bytes] = None,
    ) -> HttpResult:
        import httpx

        method = str(method or "GET").upper()
        if str(path).startswith(("http://", "https://")):
            with sync_dial_slot(), httpx.Client(timeout=120.0, verify=False) as client:
                r = client.request(
                    method, str(path), headers=dict(headers or {}),
                    content=content,
                )
            return HttpResult(r.status_code, dict(r.headers), r.content)

        from . import config as config_mod
        from . import router as router_mod
        from .router_models import _resolve_controller_token

        cfg = config_mod.load_config()
        bases = [b.rstrip("/") for b in router_mod._ordered_addresses(cfg, "controller")]
        if not bases:
            raise ConnectionError("controller 未配置地址")
        token = ""
        try:
            token, _src = _resolve_controller_token(cfg)
        except Exception:  # noqa: BLE001 - token 非法按无 token 处理
            token = ""
        qs = f"?{urlencode(params)}" if params else ""
        m = method
        timeout = (
            120.0
            if (m in ("PUT", "POST") and "/humans/" in path)
            or (m == "GET" and "/files/" in path)
            else 30.0
        )
        last_exc: Optional[Exception] = None
        for base in bases:
            hdrs = router_mod._headers_for(
                cfg,
                "controller",
                base,
                {"Authorization": f"Bearer {token}"} if token else {},
            )
            if headers:
                hdrs = {**hdrs, **headers}
            try:
                with sync_dial_slot(), httpx.Client(timeout=timeout, verify=False) as client:
                    r = client.request(
                        m,
                        f"{base}{path}{qs}",
                        headers=hdrs,
                        json=json_body,
                        content=content,
                    )
            except Exception as exc:  # noqa: BLE001 - 下一地址
                last_exc = exc
                continue
            return HttpResult(r.status_code, dict(r.headers), r.content)
        raise ConnectionError(f"controller 全部地址失败：{last_exc}")

    return ctl_call


_engine: Optional[SyncEngine] = None
_task: Optional[asyncio.Task] = None
_stop_event = asyncio.Event()


def get_engine() -> Optional[SyncEngine]:
    return _engine


def ensure_engine() -> SyncEngine:
    """取（或惰性建）默认引擎——路由端点容错用：startup hook 未跑
    （如单测直调 /sync/*）时也能工作。"""
    global _engine
    if _engine is None:
        human = os.environ.get("AGENTTEAMS_SYNC_HUMAN", "").strip() or DEFAULT_HUMAN
        root = resolve_workspace_root()
        _engine = SyncEngine(root, human=human, ctl_call=build_ctl_call())
    return _engine


def reset_for_tests() -> None:
    """测试隔离：清单例（任务循环由 start/stop 自管）。"""
    global _engine, _task
    _engine = None
    _task = None


def start() -> None:
    """启动后台同步循环（幂等）。由 plugin.register_startup_hook 调用。

    启动 60s 后首跑，之后每 300s（±30s jitter）；每轮 run_once 经
    asyncio.to_thread 跑在工作线程（引擎是同步的）；异常吞掉并记日志
    ——不影响宿主。
    """
    global _task
    if _engine is None:
        ensure_engine()
    if _task and not _task.done():
        return
    _stop_event.clear()
    _task = asyncio.create_task(_loop())
    logger.info(
        "file sync engine started (root=%s human=%s first in %.0fs, "
        "then every %.0fs±%.0fs)",
        _engine.root,
        _engine.human,
        FIRST_DELAY_SECONDS,
        INTERVAL_SECONDS,
        JITTER_SECONDS,
    )


async def _loop() -> None:
    try:
        await asyncio.sleep(FIRST_DELAY_SECONDS)
        while not _stop_event.is_set():
            try:
                res = await asyncio.to_thread(_engine.run_once)
                if isinstance(res, dict) and "error" in res:
                    logger.warning("file sync run error: %s", res["error"])
                else:
                    logger.info("file sync run: %s", res)
            except Exception as exc:  # noqa: BLE001 - 单轮失败不杀循环
                logger.warning("file sync run failed: %s", exc)
            try:
                await asyncio.wait_for(
                    _stop_event.wait(),
                    timeout=INTERVAL_SECONDS + random.uniform(-JITTER_SECONDS, JITTER_SECONDS),
                )
            except asyncio.TimeoutError:
                pass
    except asyncio.CancelledError:
        raise


async def stop() -> None:
    """停止后台循环。由 plugin.register_shutdown_hook 调用。"""
    global _task
    _stop_event.set()
    if _task and not _task.done():
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:  # pragma: no cover
            pass
        _task = None
    logger.info("file sync engine stopped")
