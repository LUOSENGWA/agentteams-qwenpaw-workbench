# -*- coding: utf-8 -*-
"""插件存储域（/storage/chat + state/prune）离线单测。

设计依据：方案与设计/AgentTeams/下版本1.2.6-1.2.7/10-客户端同步与缓存/
QwenPaw插件存储与缓存-设计-20261107.md §3/§4/§6。
介质：chat.db（SQLite 单库，永久保留 + 全局 2GB 房间 LRU）。
全部离线：tmp_path 根 + monkeypatch ``storage_api._store``，不碰真实工作区。
"""
from __future__ import annotations

import pytest

from agentteams_connector.routers import storage_api
from agentteams_connector.sync_store import (
    MAX_CHAT_MESSAGES,
    MAX_CHAT_TOTAL_BYTES,
    SyncStore,
)


@pytest.fixture()
def store(tmp_path):
    s = SyncStore(tmp_path / ".qwenpaw" / "agentteams")
    s.ensure_dirs()
    yield s
    s.close()


@pytest.fixture()
def client(store, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    monkeypatch.setattr(storage_api, "_store", lambda: store)
    app = FastAPI()
    app.include_router(storage_api.build_storage_router())
    return TestClient(app)


ROOM = "!room123:matrix.example.com"


def msgs(n: int, base: int = 0):
    return [
        {"event_id": f"$m{i}", "origin_server_ts": i, "body": f"b{i}"}
        for i in range(base, base + n)
    ]


# ── GET 空库 → 200 空窗口（不 404） ────────────────────────────────
def test_get_empty_room_returns_empty_window(client):
    r = client.get(f"/storage/chat/{ROOM}")
    assert r.status_code == 200, r.text
    assert r.json() == {"messages": [], "end": None}


# ── PUT 不截断历史（永久保留）+ GET 回读 ───────────────────────────
def test_put_keeps_full_history_and_get_roundtrip(client, store):
    payload = {"messages": msgs(600), "end": "cursor-599"}
    r = client.put(f"/storage/chat/{ROOM}", json=payload)
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "count": 600}
    # 库里 = 全部 600 条（不按 500 截断）
    on_disk = store.chat_get(ROOM)
    assert len(on_disk["messages"]) == 600
    assert on_disk["messages"][0]["event_id"] == "$m0"
    # GET 默认只回最近 500 条（单次窗口上限）
    back = client.get(f"/storage/chat/{ROOM}")
    assert back.status_code == 200
    body = back.json()
    assert body["end"] == "cursor-599"
    assert len(body["messages"]) == MAX_CHAT_MESSAGES
    assert body["messages"][0]["event_id"] == "$m100"
    assert body["messages"][-1]["event_id"] == "$m599"


def test_put_incremental_upsert_dedupes(client, store):
    assert client.put(f"/storage/chat/{ROOM}", json={"messages": msgs(3)}).json() == {
        "ok": True,
        "count": 3,
    }
    # 二次增量：重复 1 条 + 新增 2 条 → 写入条数 = 去重后 3 条（含覆盖）
    payload = {
        "messages": [
            {"event_id": "$m2", "origin_server_ts": 2, "body": "edited"},
            *msgs(2, base=3),
        ]
    }
    assert client.put(f"/storage/chat/{ROOM}", json=payload).json() == {
        "ok": True,
        "count": 3,
    }
    got = client.get(f"/storage/chat/{ROOM}").json()["messages"]
    assert [m["event_id"] for m in got] == ["$m0", "$m1", "$m2", "$m3", "$m4"]
    assert got[2]["body"] == "edited"


def test_get_limit_slices_newest(client):
    client.put(f"/storage/chat/{ROOM}", json={"messages": msgs(20), "end": "e20"})
    got = client.get(f"/storage/chat/{ROOM}", params={"limit": 5}).json()
    assert [m["event_id"] for m in got["messages"]] == [
        f"$m{i}" for i in range(15, 20)
    ]
    assert got["end"] == "e20"


# ── GET ?event_id= 按目标取窗口（免拉整窗）─────────────────────────
def test_get_event_window(client):
    client.put(f"/storage/chat/{ROOM}", json={"messages": msgs(50), "end": "e50"})
    got = client.get(
        f"/storage/chat/{ROOM}",
        params={"event_id": "$m20", "before": 2, "after": 2},
    ).json()
    assert [m["event_id"] for m in got["messages"]] == [
        "$m18",
        "$m19",
        "$m20",
        "$m21",
        "$m22",
    ]
    assert got["end"] == "e50"
    # 目标不存在（房在）→ 空窗口 200（end 仍可回）
    miss = client.get(f"/storage/chat/{ROOM}", params={"event_id": "$nope"})
    assert miss.status_code == 200
    assert miss.json() == {"messages": [], "end": "e50"}
    # 未知房 → 空窗口 + end null
    other = client.get(
        f"/storage/chat/!other:hs", params={"event_id": "$m20"}
    )
    assert other.status_code == 200
    assert other.json() == {"messages": [], "end": None}


# ── DELETE 幂等 ────────────────────────────────────────────────────
def test_delete_room_cache(client, store):
    client.put(f"/storage/chat/{ROOM}", json={"messages": msgs(3)})
    assert client.delete(f"/storage/chat/{ROOM}").json() == {"ok": True}
    assert store.chat_get(ROOM) is None
    assert client.get(f"/storage/chat/{ROOM}").json() == {"messages": [], "end": None}
    # 再删一次仍 200
    assert client.delete(f"/storage/chat/{ROOM}").status_code == 200


# ── state：chat.db 字节数 + 上限 ───────────────────────────────────
def test_state_reports_cache_bytes_and_limits(client, store):
    client.put(f"/storage/chat/{ROOM}", json={"messages": msgs(3)})
    store.http_put("GET", "https://x/y", etag="e1", body=b"abc")
    store.lru_put("k1", {"v": 1})
    data = client.get("/storage/state").json()
    assert data["cache"]["chatBytes"] > 0
    assert store.chat_db.db_path.is_file()
    assert data["cache"]["httpBytes"] >= 3
    assert data["cache"]["lruBytes"] > 0
    assert data["limits"] == {
        "chatMessages": MAX_CHAT_MESSAGES,
        "chatBytes": MAX_CHAT_TOTAL_BYTES,
    }
    assert data["limits"]["chatBytes"] == 2 * 1024 ** 3


# ── prune：库超上限 → 按 last_access LRU 整房淘汰 ──────────────────
def test_prune_evicts_oldest_rooms(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    s = SyncStore(tmp_path / "ws", chat_max_bytes=10 ** 9)
    s.ensure_dirs()
    monkeypatch.setattr(storage_api, "_store", lambda: s)
    app = FastAPI()
    app.include_router(storage_api.build_storage_router())
    tc = TestClient(app)
    try:
        for i in range(4):
            s.chat_put(
                f"!room{i}:hs",
                [
                    {"event_id": f"$r{i}-{k}", "origin_server_ts": k, "body": "x" * 400}
                    for k in range(100)
                ],
            )
            # 显式 last_access 序（写入太快，秒级时间戳可能相同）
            s.chat_db._conn.execute(
                "UPDATE rooms SET last_access=? WHERE room_id=?",
                (1_700_000_000 + i, f"!room{i}:hs"),
            )
            s.chat_db._conn.commit()
        s.chat_db._checkpoint()  # WAL 落主库：上限口径不含虚高 WAL
        size = s.chat_bytes()
        s.chat_db.max_bytes = size // 2  # 上限压到一半 → 必须淘汰
        data = tc.post("/storage/prune").json()
        assert data["removedFiles"] >= 1
        assert data["freedBytes"] > 0
        assert s.chat_bytes() <= size // 2
        assert not s.chat_db.has_room("!room0:hs")
        assert s.chat_db.has_room("!room3:hs")
    finally:
        s.close()


# ── 参数校验：room_id 非法 → 400 ───────────────────────────────────
def test_invalid_room_id_400(client):
    assert client.get("/storage/chat/%20").status_code == 400
    too_long = "!" + "a" * 300
    assert client.get(f"/storage/chat/{too_long}").status_code == 400
    assert (
        client.put(f"/storage/chat/{too_long}", json={"messages": []}).status_code == 400
    )


def test_put_invalid_body_400(client):
    assert client.put(f"/storage/chat/{ROOM}", json={"messages": "nope"}).status_code == 400
    assert (
        client.put(f"/storage/chat/{ROOM}", json={"messages": [], "end": 1}).status_code
        == 400
    )


# ── 写失败 → 503 storage_unavailable ───────────────────────────────
def test_put_write_failure_503(client, store, monkeypatch):
    def boom(*_a, **_kw):
        raise OSError("disk gone")

    monkeypatch.setattr(store, "chat_put", boom)
    r = client.put(f"/storage/chat/{ROOM}", json={"messages": msgs(1)})
    assert r.status_code == 503
    assert r.json()["detail"]["error"] == "storage_unavailable"


# ── 存储实例按根复用（SQLite 连接不得每请求新建）────────────────────
def test_store_is_cached_per_root(tmp_path, monkeypatch):
    from agentteams_connector import file_sync_engine as fse

    root = tmp_path / "ws" / ".qwenpaw" / "agentteams"
    monkeypatch.setattr(fse, "resolve_workspace_root", lambda *a, **k: root)
    storage_api._STORES.clear()
    try:
        a = storage_api._store()
        b = storage_api._store()
        assert a is b  # 同根复用同一实例（同一 SQLite 连接）
        a.chat_put(ROOM, msgs(1))
        assert [m["event_id"] for m in b.chat_get(ROOM)["messages"]] == ["$m0"]
    finally:
        for s in list(storage_api._STORES.values()):
            s.close()
        storage_api._STORES.clear()
