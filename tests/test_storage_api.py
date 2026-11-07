# -*- coding: utf-8 -*-
"""插件存储域（/storage/chat + state/prune）离线单测。

设计依据：方案与设计/AgentTeams/下版本1.2.6-1.2.7/10-客户端同步与缓存/
QwenPaw插件存储与缓存-设计-20261107.md §3/§4/§6。
全部离线：tmp_path 根 + monkeypatch ``storage_api._store``，不碰真实工作区。
"""
from __future__ import annotations

import os

import pytest

from agentteams_connector.routers import storage_api
from agentteams_connector.sync_store import MAX_CHAT_MESSAGES, SyncStore


@pytest.fixture()
def store(tmp_path):
    s = SyncStore(tmp_path / ".qwenpaw" / "agentteams")
    s.ensure_dirs()
    return s


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
    return [{"event_id": f"$m{i}", "origin_server_ts": i, "body": f"b{i}"} for i in range(base, base + n)]


# ── GET 空缓存 → 200 空窗口（不 404） ──────────────────────────────
def test_get_empty_room_returns_empty_window(client):
    r = client.get(f"/storage/chat/{ROOM}")
    assert r.status_code == 200, r.text
    assert r.json() == {"messages": [], "end": None}


# ── PUT 截断到 500（保留最新）+ GET 回读 ───────────────────────────
def test_put_truncates_to_500_and_get_roundtrip(client, store):
    payload = {"messages": msgs(600), "end": "cursor-599"}
    r = client.put(f"/storage/chat/{ROOM}", json=payload)
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "count": MAX_CHAT_MESSAGES}
    # 磁盘落盘 = 最新 500 条
    on_disk = store.chat_get(ROOM)
    assert len(on_disk["messages"]) == 500
    assert on_disk["messages"][0]["event_id"] == "$m100"
    back = client.get(f"/storage/chat/{ROOM}")
    assert back.status_code == 200
    body = back.json()
    assert body["end"] == "cursor-599"
    assert len(body["messages"]) == 500
    assert body["messages"][-1]["event_id"] == "$m599"


def test_get_limit_slices_newest(client):
    client.put(f"/storage/chat/{ROOM}", json={"messages": msgs(20), "end": "e20"})
    got = client.get(f"/storage/chat/{ROOM}", params={"limit": 5}).json()
    assert [m["event_id"] for m in got["messages"]] == [f"$m{i}" for i in range(15, 20)]
    assert got["end"] == "e20"


# ── DELETE 幂等 ────────────────────────────────────────────────────
def test_delete_room_cache(client, store):
    client.put(f"/storage/chat/{ROOM}", json={"messages": msgs(3)})
    assert client.delete(f"/storage/chat/{ROOM}").json() == {"ok": True}
    assert store.chat_get(ROOM) is None
    assert client.get(f"/storage/chat/{ROOM}").json() == {"messages": [], "end": None}
    # 再删一次仍 200
    assert client.delete(f"/storage/chat/{ROOM}").status_code == 200


# ── state：字节数 + 上限 ───────────────────────────────────────────
def test_state_reports_cache_bytes_and_limits(client, store):
    client.put(f"/storage/chat/{ROOM}", json={"messages": msgs(3)})
    store.http_put("GET", "https://x/y", etag="e1", body=b"abc")
    store.lru_put("k1", {"v": 1})
    data = client.get("/storage/state").json()
    assert data["cache"]["chatBytes"] > 0
    assert data["cache"]["httpBytes"] >= 3
    assert data["cache"]["lruBytes"] > 0
    assert data["limits"] == {"chatMessages": 500, "chatBytes": 64 * 1024 * 1024}


# ── prune：超房间数按 mtime LRU 淘汰 ───────────────────────────────
def test_prune_evicts_oldest_rooms(client, store):
    for i in range(32):
        store.chat_put(f"!room{i}:hs", msgs(1))
    # 显式把 mtime 拉开（写入太快，mtime 可能同秒）
    for i, p in enumerate(sorted(store.chat_dir.glob("*.json"))):
        os.utime(p, (1_760_000_000 + i, 1_760_000_000 + i))
    data = client.post("/storage/prune").json()
    assert data["removedFiles"] == 2
    assert data["freedBytes"] > 0
    left = list(store.chat_dir.glob("*.json"))
    assert len(left) == 30


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
