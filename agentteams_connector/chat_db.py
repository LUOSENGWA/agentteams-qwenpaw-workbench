# -*- coding: utf-8 -*-
"""聊天消息 SQLite 单库（``<root>/cache/chat.db``，永久保留 + 全局 2GB LRU）。

介质替换：原先每房一个 ``cache/chat/<roomId>.json``（整窗覆盖、每房
500 条截断）；用户裁决「点过『加载原消息』后要永久保存，以后不再加载」
→ 改为单库按 ``event_id`` 增量 upsert，**不按房间截断历史**，只在库
总体积超过上限时按 ``rooms.last_access`` LRU 整房淘汰。

库结构（``PRAGMA user_version = 1``）::

    messages(event_id PK, room_id, ts, json)   -- json = 单条 RoomMessage
    rooms(room_id PK, last_access, end_cursor) -- LRU + 窗口游标
    meta(key PK, value)                        -- 迁移标记等

并发：单连接（``check_same_thread=False``）+ ``threading.Lock`` 串行化
（FastAPI 路由经 ``asyncio.to_thread`` 落线程池，连接必须跨线程可用）。

一次性迁移（无网络）：初始化时若存在旧 ``cache/chat/*.json`` → 逐个导入
``{messages, end}``（``event_id`` 去重），成功后把目录改名为
``cache/chat.json.bak-<ts>``（**不删除**），``meta`` 记
``chat_json_migrated=1``（重复启动幂等）。旧文件名是安全化后的 roomId
（``!room:hs`` → ``_room_hs``），导入时按「首字符 ``_``→``!``、最后一个
``_``→``:``」最佳努力还原（不可逆，仅迁移路径使用）；无法还原的房间
保留安全化名，数据不丢但不会被真实 roomId 命中。
"""
from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(
    "qwenpaw.plugins.agentteams_qwenpaw_workbench.chat_db"
)

DB_NAME = "chat.db"
SCHEMA_VERSION = 1
# 全局库总量上限（用户口径：永久保留，只在超 2GB 时按房间 LRU 淘汰）。
DEFAULT_MAX_BYTES = 2 * 1024 ** 3
MIGRATED_KEY = "chat_json_migrated"
# 写入若干批后做一次体积检查（挂载上 stat 有成本，不能每批都查）。
SIZE_CHECK_EVERY = 64

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS messages (
  event_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_room_ts ON messages(room_id, ts);
CREATE TABLE IF NOT EXISTS rooms (
  room_id TEXT PRIMARY KEY,
  last_access INTEGER NOT NULL,
  end_cursor TEXT
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""

_UPSERT_MESSAGE_SQL = """
INSERT INTO messages(event_id, room_id, ts, json) VALUES (?, ?, ?, ?)
ON CONFLICT(event_id) DO UPDATE SET json=excluded.json, ts=excluded.ts
"""

_UPSERT_ROOM_SQL = """
INSERT INTO rooms(room_id, last_access, end_cursor) VALUES (?, ?, ?)
ON CONFLICT(room_id) DO UPDATE SET
  last_access=excluded.last_access,
  end_cursor=COALESCE(excluded.end_cursor, rooms.end_cursor)
"""


def _loads(raw: Any) -> Optional[Dict[str, Any]]:
    """单行 json → dict；损坏行返回 None（坏行不炸整窗）。"""
    try:
        obj = json.loads(raw)
    except Exception:  # noqa: BLE001
        return None
    return obj if isinstance(obj, dict) else None


def _legacy_room_id(stem: str, messages: List[Any]) -> str:
    """旧 JSON 文件名 → roomId（最佳努力；见模块头「一次性迁移」）。

    优先取消息里显式带的 room_id（未来若有），否则按安全化规则反向猜：
    ``_room123_matrix.example.com`` → ``!room123:matrix.example.com``。
    """
    for m in messages:
        if isinstance(m, dict):
            rid = m.get("room_id") or m.get("roomId")
            if isinstance(rid, str) and rid:
                return rid
    if stem.startswith("_"):
        body = stem[1:]
        cut = body.rfind("_")
        if cut > 0:
            return f"!{body[:cut]}:{body[cut + 1:]}"
        return f"!{body}"
    return stem


def _backup_name(cache_dir: Path) -> Path:
    """``cache/chat.json.bak-<ts>``（重名加序号，绝不覆盖既有备份）。"""
    ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    base = cache_dir / f"chat.json.bak-{ts}"
    if not base.exists():
        return base
    n = 2
    while True:
        cand = cache_dir / f"{base.name}-{n}"
        if not cand.exists():
            return cand
        n += 1


class ChatDB:
    """聊天消息库：upsert / 窗口读取 / LRU 淘汰 / 旧 JSON 迁移。

    所有方法都可在任意线程调用（内部单连接 + 锁）。构造不连库——首次
    使用时才 ``open()``（插件 import 期零磁盘副作用）。
    """

    def __init__(
        self,
        root: Path,
        *,
        now: Optional[Callable[[], float]] = None,
        max_bytes: int = DEFAULT_MAX_BYTES,
    ) -> None:
        self.root = Path(root)
        self.cache_dir = self.root / "cache"
        self.db_path = self.cache_dir / DB_NAME
        self.legacy_dir = self.cache_dir / "chat"
        self.max_bytes = int(max_bytes)
        self._now = now or time.time
        self._mu = threading.Lock()
        self._conn: Optional[sqlite3.Connection] = None
        self._puts_since_size_check = 0

    # ── 连接 / schema / 迁移 ───────────────────────────────────────

    def _conn_locked(self) -> sqlite3.Connection:
        """取连接（首调建库建表 + 迁移旧 JSON）；调用方须持 ``_mu``。"""
        if self._conn is not None:
            return self._conn
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.db_path), timeout=5.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA busy_timeout=5000")
            conn.executescript(_SCHEMA_SQL)
            ver = int(conn.execute("PRAGMA user_version").fetchone()[0] or 0)
            if ver < SCHEMA_VERSION:
                conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
                conn.commit()
            elif ver > SCHEMA_VERSION:
                logger.warning(
                    "chat.db user_version=%s newer than supported %s", ver, SCHEMA_VERSION
                )
            self._conn = conn
            self._migrate_legacy_locked(conn)
        except Exception:
            conn.close()
            self._conn = None
            raise
        return conn

    def _meta_get_locked(self, conn: sqlite3.Connection, key: str) -> Optional[str]:
        row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return None if row is None else str(row[0])

    def _meta_set_locked(self, conn: sqlite3.Connection, key: str, value: str) -> None:
        conn.execute(
            "INSERT INTO meta(key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )

    def _migrate_legacy_locked(self, conn: sqlite3.Connection) -> Optional[Path]:
        """一次性迁移旧 ``cache/chat/*.json``（成功才改名 + 打标记）。"""
        if self._meta_get_locked(conn, MIGRATED_KEY) == "1":
            return None
        if not self.legacy_dir.is_dir():
            return None  # 无旧数据：不落标记，后续若出现旧目录仍可迁移
        files = sorted(
            p for p in self.legacy_dir.glob("*.json") if p.is_file()
        )
        failures = 0
        imported = 0
        for p in files:
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                msgs = data.get("messages") if isinstance(data, dict) else None
                if not isinstance(msgs, list):
                    raise ValueError("legacy chat json missing messages[]")
                room_id = _legacy_room_id(p.stem, msgs)
                end = data.get("end") if isinstance(data, dict) else None
                try:
                    access_at = int(p.stat().st_mtime)
                except OSError:
                    access_at = int(self._now())
                imported += self._put_locked(
                    conn,
                    room_id,
                    msgs,
                    end if isinstance(end, str) else None,
                    access_at,
                )
            except Exception as exc:  # noqa: BLE001 - 单文件坏不阻其他文件
                failures += 1
                logger.warning("legacy chat import failed (%s): %s", p.name, exc)
        if failures:
            # 保留旧目录（下次启动重试；event_id 去重 → 重复导入无副作用）
            logger.warning(
                "legacy chat migration incomplete: %s/%s files failed", failures, len(files)
            )
            return None
        try:
            target = _backup_name(self.cache_dir)
            self.legacy_dir.rename(target)
        except OSError as exc:
            logger.warning("legacy chat dir rename failed: %s", exc)
            return None
        self._meta_set_locked(conn, MIGRATED_KEY, "1")
        conn.commit()
        logger.info("legacy chat json migrated (%s files, %s messages)", len(files), imported)
        return target

    # ── 写：批量 upsert ───────────────────────────────────────────

    def _put_locked(
        self,
        conn: sqlite3.Connection,
        room_id: str,
        messages: List[Any],
        end: Optional[str],
        access_at: int,
    ) -> int:
        rows: Dict[str, tuple] = {}
        for m in messages or []:
            if not isinstance(m, dict):
                continue
            eid = m.get("event_id")
            if not isinstance(eid, str) or not eid:
                continue
            try:
                ts = int(m.get("origin_server_ts") or 0)
            except (TypeError, ValueError):
                ts = 0
            rows[eid] = (
                eid,
                str(room_id),
                ts,
                json.dumps(m, ensure_ascii=False),
            )
        with conn:  # 单事务：消息批 + rooms 游标一起提交
            if rows:
                conn.executemany(_UPSERT_MESSAGE_SQL, list(rows.values()))
            conn.execute(_UPSERT_ROOM_SQL, (str(room_id), int(access_at), end))
        return len(rows)

    def put_messages(
        self,
        room_id: str,
        messages: List[Any],
        end: Optional[str] = None,
        *,
        access_at: Optional[int] = None,
    ) -> int:
        """批量 upsert（``event_id`` 去重；同 id 以本次载荷覆盖）。

        返回本批实际写入的不同 ``event_id`` 条数。``end=None`` 保留既有
        房间游标（``COALESCE``），避免增量写把游标抹掉。
        """
        if not room_id:
            return 0
        at = int(access_at if access_at is not None else self._now())
        with self._mu:
            conn = self._conn_locked()
            count = self._put_locked(conn, str(room_id), messages, end, at)
            self._puts_since_size_check += 1
            due = self._puts_since_size_check >= SIZE_CHECK_EVERY
            if due:
                self._puts_since_size_check = 0
        if due:  # 全局 LRU 兜底（每若干批一次；显式 prune 仍是主路径）
            try:
                self.prune()
            except Exception as exc:  # noqa: BLE001 - 整理失败不影响写入
                logger.warning("chat.db auto prune failed: %s", exc)
        return count

    # ── 读 ───────────────────────────────────────────────────────

    def get_recent(
        self, room_id: str, limit: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """最近 ``limit`` 条（升序返回）；``limit=None`` = 整房全部。"""
        with self._mu:
            conn = self._conn_locked()
            if limit is None:
                rows = conn.execute(
                    "SELECT json FROM messages WHERE room_id=? "
                    "ORDER BY ts ASC, event_id ASC",
                    (str(room_id),),
                ).fetchall()
                return [obj for obj in (_loads(r[0]) for r in rows) if obj is not None]
            n = max(0, int(limit))
            rows = conn.execute(
                "SELECT json FROM messages WHERE room_id=? "
                "ORDER BY ts DESC, event_id DESC LIMIT ?",
                (str(room_id), n),
            ).fetchall()
        return [
            obj
            for obj in (_loads(r[0]) for r in reversed(rows))
            if obj is not None
        ]

    def get_window(
        self,
        room_id: str,
        event_id: str,
        before: int = 25,
        after: int = 25,
    ) -> List[Dict[str, Any]]:
        """目标消息前后各 N 条（升序，含目标）；目标不在库 → []。"""
        rid = str(room_id)
        with self._mu:
            conn = self._conn_locked()
            target = conn.execute(
                "SELECT ts, event_id FROM messages WHERE event_id=? AND room_id=?",
                (str(event_id), rid),
            ).fetchone()
            if target is None:
                return []
            ts = int(target[0])
            head = conn.execute(
                "SELECT json FROM messages WHERE room_id=? AND (ts<? OR (ts=? AND event_id<=?)) "
                "ORDER BY ts DESC, event_id DESC LIMIT ?",
                (rid, ts, ts, str(event_id), max(0, int(before)) + 1),
            ).fetchall()
            tail = conn.execute(
                "SELECT json FROM messages WHERE room_id=? AND (ts>? OR (ts=? AND event_id>?)) "
                "ORDER BY ts ASC, event_id ASC LIMIT ?",
                (rid, ts, ts, str(event_id), max(0, int(after))),
            ).fetchall()
        out = [
            obj
            for obj in (_loads(r[0]) for r in list(reversed(head)) + list(tail))
            if obj is not None
        ]
        return out

    def get_end_cursor(self, room_id: str) -> Optional[str]:
        """房间游标（无房/无游标 → None）。"""
        with self._mu:
            conn = self._conn_locked()
            row = conn.execute(
                "SELECT end_cursor FROM rooms WHERE room_id=?", (str(room_id),)
            ).fetchone()
        if row is None or row[0] is None:
            return None
        return str(row[0])

    def has_room(self, room_id: str) -> bool:
        with self._mu:
            conn = self._conn_locked()
            row = conn.execute(
                "SELECT 1 FROM rooms WHERE room_id=?", (str(room_id),)
            ).fetchone()
        return row is not None

    # ── 删除 / 容量 ──────────────────────────────────────────────

    def drop_room(self, room_id: str) -> int:
        """整房删除（消息 + rooms 行）；返回删除的消息条数。"""
        rid = str(room_id)
        with self._mu:
            conn = self._conn_locked()
            with conn:
                cur = conn.execute("DELETE FROM messages WHERE room_id=?", (rid,))
                conn.execute("DELETE FROM rooms WHERE room_id=?", (rid,))
            removed = cur.rowcount if isinstance(cur.rowcount, int) else 0
        self._checkpoint()
        return max(0, removed)

    def size_bytes(self) -> int:
        """库文件占用（``chat.db`` + WAL，缺失 → 0）。"""
        total = 0
        for suffix in ("", "-wal"):
            p = Path(str(self.db_path) + suffix)
            try:
                total += p.stat().st_size
            except OSError:
                continue
        return total

    def _checkpoint(self) -> None:
        """WAL 落主库（整理/度量前用；失败静默）。"""
        try:
            with self._mu:
                conn = self._conn_locked()
                conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except Exception:  # noqa: BLE001
            pass

    def stats(self) -> Dict[str, Any]:
        """库现状：房间数 / 消息数 / 字节数 / 上限。"""
        with self._mu:
            conn = self._conn_locked()
            rooms = int(conn.execute("SELECT COUNT(*) FROM rooms").fetchone()[0] or 0)
            msgs = int(conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0] or 0)
        return {
            "dbPath": str(self.db_path),
            "rooms": rooms,
            "messages": msgs,
            "bytes": self.size_bytes(),
            "maxBytes": self.max_bytes,
        }

    def _room_bytes_locked(self, conn: sqlite3.Connection, room_id: str) -> int:
        """单房占用估算（json 正文 + 主键/行开销）；仅用于 LRU 挑选。"""
        row = conn.execute(
            "SELECT COALESCE(SUM(LENGTH(json)), 0), COUNT(*) FROM messages WHERE room_id=?",
            (room_id,),
        ).fetchone()
        body = int(row[0] or 0) if row is not None else 0
        count = int(row[1] or 0) if row is not None else 0
        return body + count * 64

    def _vacuum_locked(self, conn: sqlite3.Connection) -> None:
        """释放删除留下的页空洞（VACUUM 必须无未决事务）。"""
        try:
            conn.execute("VACUUM")
        except sqlite3.Error as exc:
            logger.warning("chat.db vacuum failed: %s", exc)
        try:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except sqlite3.Error:
            pass

    def prune(self, max_bytes: Optional[int] = None) -> Dict[str, int]:
        """按 ``rooms.last_access`` LRU 整房淘汰，直到库 ≤ ``max_bytes``。

        **至少保留 1 个房间**（最近使用的那个）。先按每房正文大小估算该删
        几个最旧房间（批量删，避免逐房 VACUUM 的大库抖动），VACUUM 后
        复查；估算偏差 → 再来一轮。返回
        ``{"removedFiles": 淘汰房间数, "freedBytes": 释放字节}``
        （与旧 JSON 目录口径同名，前端/状态面零改动）。
        """
        limit = int(max_bytes if max_bytes is not None else self.max_bytes)
        with self._mu:
            conn = self._conn_locked()
            start = self.size_bytes()
            if start <= limit:
                return {"removedFiles": 0, "freedBytes": 0}
            removed = 0
            rounds = 0
            while True:
                rounds += 1
                before = self.size_bytes()
                if before <= limit:
                    break
                rows = conn.execute(
                    "SELECT room_id FROM rooms ORDER BY last_access ASC, room_id ASC"
                ).fetchall()
                if len(rows) <= 1:
                    break  # 至少留一房
                need = before - limit
                pick: List[str] = []
                freed_est = 0
                for row in rows[:-1]:  # 最近访问的那个永远保留
                    rid = str(row[0])
                    pick.append(rid)
                    freed_est += self._room_bytes_locked(conn, rid) + 128
                    # 1.3 系数：页/索引/WAL 开销使实际释放小于正文估算
                    if freed_est * 1.3 >= need:
                        break
                if not pick:
                    break
                with conn:
                    for rid in pick:
                        conn.execute("DELETE FROM messages WHERE room_id=?", (rid,))
                        conn.execute("DELETE FROM rooms WHERE room_id=?", (rid,))
                removed += len(pick)
                self._vacuum_locked(conn)
                if rounds > len(rows) + 1:  # 防御：估算异常时不死循环
                    break
            after = self.size_bytes()
        return {"removedFiles": removed, "freedBytes": max(0, start - after)}

    # ── 生命周期 ─────────────────────────────────────────────────

    def close(self) -> None:
        """关闭连接（幂等；测试/进程退出用）。"""
        with self._mu:
            conn = self._conn
            self._conn = None
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass
