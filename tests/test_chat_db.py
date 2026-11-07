# -*- coding: utf-8 -*-
"""聊天消息 SQLite 库（``chat_db``）离线单测。

覆盖：upsert 去重/覆盖、ts 排序、按 event 取窗口、跨实例持久化、旧 JSON
迁移（幂等）、全局 2GB LRU 整理、并发写、游标 COALESCE、删除。
全部离线：tmp_path 建库，不碰真实工作区/网络。
"""
from __future__ import annotations

import json
import threading

import pytest

from agentteams_connector.chat_db import (
    DEFAULT_MAX_BYTES,
    MIGRATED_KEY,
    ChatDB,
)

ROOM = "!room123:matrix.example.com"


def m(eid: str, ts: int, **kw):
    return {"event_id": eid, "origin_server_ts": ts, "body": f"b-{eid}", **kw}


@pytest.fixture()
def db(tmp_path):
    d = ChatDB(tmp_path / "agentteams")
    yield d
    d.close()


# ── 1) upsert：去重 / 同 id 覆盖 / 非法条目跳过 ─────────────────────


def test_upsert_dedupes_and_overrides(db):
    assert db.put_messages(ROOM, [m("$a", 100), m("$b", 200)]) == 2
    # 重复 id + 同 id 新载荷：只算 2 条（去重后），同 id 被覆盖
    n = db.put_messages(ROOM, [m("$a", 100, body="edited"), m("$c", 300), m("$c", 300)])
    assert n == 2
    got = db.get_recent(ROOM)
    assert [x["event_id"] for x in got] == ["$a", "$b", "$c"]
    assert got[0]["body"] == "edited"


def test_upsert_skips_invalid_items(db):
    n = db.put_messages(
        ROOM,
        [m("$a", 1), {"origin_server_ts": 1}, {"event_id": ""}, "junk", None],
    )
    assert n == 1
    assert [x["event_id"] for x in db.get_recent(ROOM)] == ["$a"]


def test_put_messages_empty_room_id_is_noop(db):
    assert db.put_messages("", [m("$a", 1)]) == 0


# ── 2) ts 排序 + 窗口切片 ──────────────────────────────────────────


def test_ts_ordering_and_recent_limit(db):
    db.put_messages(ROOM, [m("$c", 300), m("$a", 100), m("$b", 200)])
    assert [x["event_id"] for x in db.get_recent(ROOM)] == ["$a", "$b", "$c"]
    assert [x["event_id"] for x in db.get_recent(ROOM, 2)] == ["$b", "$c"]
    assert db.get_recent(ROOM, 0) == []


def test_no_per_room_truncation(db):
    """用户口径：历史永久保留（不再每房 500 条截断）。"""
    msgs = [m(f"$m{i}", i) for i in range(1200)]
    assert db.put_messages(ROOM, msgs) == 1200
    got = db.get_recent(ROOM)
    assert len(got) == 1200
    assert got[0]["event_id"] == "$m0"
    assert got[-1]["event_id"] == "$m1199"


# ── 3) get_window：按目标 ts 取两侧 ────────────────────────────────


def test_get_window_around_target(db):
    db.put_messages(ROOM, [m(f"$m{i}", 100 + i) for i in range(10)])
    got = db.get_window(ROOM, "$m5", 2, 2)
    assert [x["event_id"] for x in got] == ["$m3", "$m4", "$m5", "$m6", "$m7"]
    # 边界：目标在头/尾
    assert [x["event_id"] for x in db.get_window(ROOM, "$m0", 5, 1)] == ["$m0", "$m1"]
    assert [x["event_id"] for x in db.get_window(ROOM, "$m9", 1, 5)] == ["$m8", "$m9"]
    # 目标不同房间/不存在 → 空
    assert db.get_window("!other:hs", "$m5", 2, 2) == []
    assert db.get_window(ROOM, "$missing", 2, 2) == []


def test_get_window_includes_same_ts_neighbours(db):
    # 同 ts（编辑簇）按 event_id 稳定排序，窗口不重不漏
    db.put_messages(ROOM, [m("$a", 100), m("$b", 100), m("$c", 100)])
    got = [x["event_id"] for x in db.get_window(ROOM, "$b", 1, 1)]
    assert got == ["$a", "$b", "$c"]


# ── 4) 游标 COALESCE + 跨实例持久化 ────────────────────────────────


def test_end_cursor_coalesce(db):
    db.put_messages(ROOM, [m("$a", 1)], end="cursor-1")
    assert db.get_end_cursor(ROOM) == "cursor-1"
    # 增量写不带 end → 既有游标保留（不被抹成 NULL）
    db.put_messages(ROOM, [m("$b", 2)])
    assert db.get_end_cursor(ROOM) == "cursor-1"
    db.put_messages(ROOM, [m("$c", 3)], end="cursor-3")
    assert db.get_end_cursor(ROOM) == "cursor-3"
    # 未知房间 → None
    assert db.get_end_cursor("!nobody:hs") is None


def test_cross_instance_persistence(tmp_path):
    root = tmp_path / "agentteams"
    a = ChatDB(root)
    a.put_messages(ROOM, [m("$a", 1), m("$b", 2)], end="e2")
    a.close()
    b = ChatDB(root)  # 新实例（模拟库重启）：磁盘数据可读
    try:
        assert [x["event_id"] for x in b.get_recent(ROOM)] == ["$a", "$b"]
        assert b.get_end_cursor(ROOM) == "e2"
        # 重启后窗口查询仍命中
        assert [x["event_id"] for x in b.get_window(ROOM, "$b", 1, 0)] == ["$a", "$b"]
    finally:
        b.close()


def test_wal_pragmas_applied(db):
    db.get_recent(ROOM)  # 触发建库
    mode = db._conn.execute("PRAGMA journal_mode").fetchone()[0]
    assert str(mode).lower() == "wal"
    assert int(db._conn.execute("PRAGMA user_version").fetchone()[0]) == 1


# ── 5) 旧 JSON 迁移（一次性 + 幂等）────────────────────────────────


def _legacy_file(root, stem, messages, end=None):
    d = root / "cache" / "chat"
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"{stem}.json"
    p.write_text(
        json.dumps({"messages": messages, "end": end}, ensure_ascii=False),
        encoding="utf-8",
    )
    return p


def test_legacy_json_migration_and_dir_backup(tmp_path):
    root = tmp_path / "agentteams"
    # 旧文件名 = 安全化后的 roomId（! / : → _）
    _legacy_file(root, "_room123_matrix.example.com", [m("$a", 1), m("$b", 2)], "e2")
    db = ChatDB(root)
    try:
        got = db.get_recent(ROOM)
        assert [x["event_id"] for x in got] == ["$a", "$b"]
        assert db.get_end_cursor(ROOM) == "e2"
        # 旧目录改名备份（不删除）
        assert not (root / "cache" / "chat").exists()
        backups = list((root / "cache").glob("chat.json.bak-*"))
        assert len(backups) == 1
        assert (backups[0] / "_room123_matrix.example.com.json").is_file()
        row = db._conn.execute(
            "SELECT value FROM meta WHERE key=?", (MIGRATED_KEY,)
        ).fetchone()
        assert row is not None and row[0] == "1"
    finally:
        db.close()


def test_legacy_json_migration_idempotent(tmp_path):
    root = tmp_path / "agentteams"
    _legacy_file(root, "_r_hs", [m("$a", 1)])
    a = ChatDB(root)
    try:
        assert [x["event_id"] for x in a.get_recent("!r:hs")] == ["$a"]
    finally:
        a.close()
    # 再次启动：不重复导入（标记已落 + 旧目录已改名）
    b = ChatDB(root)
    try:
        assert [x["event_id"] for x in b.get_recent("!r:hs")] == ["$a"]
        assert len(list((root / "cache").glob("chat.json.bak-*"))) == 1
    finally:
        b.close()


def test_legacy_bad_file_keeps_dir_for_retry(tmp_path):
    root = tmp_path / "agentteams"
    _legacy_file(root, "_r_hs", [m("$a", 1)])
    bad = root / "cache" / "chat" / "broken.json"
    bad.write_text("{not json", encoding="utf-8")
    db = ChatDB(root)
    try:
        # 好文件已导入，坏文件保留旧目录待下次重试（不删数据）
        assert [x["event_id"] for x in db.get_recent("!r:hs")] == ["$a"]
        assert (root / "cache" / "chat").is_dir()
        assert len(list((root / "cache").glob("chat.json.bak-*"))) == 0
    finally:
        db.close()


def test_migration_uses_file_mtime_for_lru(tmp_path):
    import os

    root = tmp_path / "agentteams"
    old = _legacy_file(root, "_old_hs", [m("$a", 1)])
    new = _legacy_file(root, "_new_hs", [m("$b", 1)])
    os.utime(old, (1_700_000_000, 1_700_000_000))
    os.utime(new, (1_700_000_100, 1_700_000_100))
    db = ChatDB(root)
    try:
        db.get_recent("!old:hs")  # 触发建库/迁移
        rows = db._conn.execute(
            "SELECT room_id, last_access FROM rooms ORDER BY last_access"
        ).fetchall()
        assert [r[0] for r in rows] == ["!old:hs", "!new:hs"]
        assert rows[0][1] == 1_700_000_000
    finally:
        db.close()


# ── 6) 全局 LRU 整理（房间级，至少留 1 房）──────────────────────────


def test_prune_is_noop_under_limit(tmp_path):
    db = ChatDB(tmp_path / "agentteams")
    try:
        db.put_messages(ROOM, [m("$a", 1)])
        assert db.prune() == {"removedFiles": 0, "freedBytes": 0}
        assert DEFAULT_MAX_BYTES == 2 * 1024 ** 3
    finally:
        db.close()


def _bulk_rooms(db, rooms=4, per_room=100, body=400):
    for r in range(rooms):
        rid = f"!room{r}:hs"
        db.put_messages(
            rid,
            [m(f"$r{r}-{i}", i, body="x" * body) for i in range(per_room)],
            access_at=1_700_000_000 + r,
        )


def test_prune_evicts_oldest_rooms(tmp_path):
    root = tmp_path / "agentteams"
    db = ChatDB(root)
    try:
        _bulk_rooms(db)
        db._checkpoint()  # WAL 落主库后再度量（否则上限口径含 WAL 虚高）
        size = db.size_bytes()
        assert size > 20_000
        got = db.prune(max_bytes=size // 2)
        assert got["removedFiles"] >= 1
        assert got["freedBytes"] > 0
        assert db.size_bytes() <= size // 2
        # 最旧房间先淘汰；最新房间保留
        assert not db.has_room("!room0:hs")
        assert db.has_room("!room3:hs")
    finally:
        db.close()


def test_prune_keeps_at_least_one_room(tmp_path):
    db = ChatDB(tmp_path / "agentteams")
    try:
        _bulk_rooms(db, rooms=3, per_room=10)
        db.prune(max_bytes=1)  # 不可能满足 → 仍保留 1 房
        rows = db._conn.execute("SELECT room_id FROM rooms").fetchall()
        assert len(rows) == 1
        assert rows[0][0] == "!room2:hs"  # 最近访问的房间
    finally:
        db.close()


def test_sync_store_prune_signature_compat(tmp_path):
    from agentteams_connector.sync_store import SyncStore

    store = SyncStore(tmp_path / "agentteams")
    try:
        assert store.chat_prune(max_rooms=1, max_bytes=10 ** 9) == {
            "removedFiles": 0,
            "freedBytes": 0,
        }
    finally:
        store.close()


# ── 7) 并发写（单连接 + 锁）────────────────────────────────────────


def test_concurrent_puts_no_loss(db):
    workers = 8
    each = 25

    def _run(w: int) -> None:
        db.put_messages(
            ROOM, [m(f"$w{w}-{i}", w * 1000 + i) for i in range(each)]
        )

    threads = [threading.Thread(target=_run, args=(w,)) for w in range(workers)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    got = db.get_recent(ROOM)
    assert len(got) == workers * each
    assert len({x["event_id"] for x in got}) == workers * each
    ts = [x["origin_server_ts"] for x in got]
    assert ts == sorted(ts)


# ── 8) 删除 / 状态面 ───────────────────────────────────────────────


def test_drop_room(db):
    db.put_messages(ROOM, [m("$a", 1), m("$b", 2)])
    db.put_messages("!other:hs", [m("$c", 1)])
    assert db.drop_room(ROOM) == 2
    assert not db.has_room(ROOM)
    assert db.get_recent(ROOM) == []
    assert [x["event_id"] for x in db.get_recent("!other:hs")] == ["$c"]
    assert db.drop_room(ROOM) == 0  # 幂等


def test_stats(tmp_path):
    db = ChatDB(tmp_path / "agentteams", max_bytes=1234)
    try:
        db.put_messages(ROOM, [m("$a", 1), m("$b", 2)])
        st = db.stats()
        assert st["rooms"] == 1
        assert st["messages"] == 2
        assert st["bytes"] > 0
        assert st["maxBytes"] == 1234
        assert st["dbPath"].endswith("cache/chat.db")
    finally:
        db.close()
