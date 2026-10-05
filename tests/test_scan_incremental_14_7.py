# -*- coding: utf-8 -*-
"""T6 增量扫描（v0.5.0-beta.14.7）单测。

覆盖三处扫描（/room-mentions、/room-approvals、/workflow/events）的
「无推进零重扫 / 推进只重扫该房 / 600s 兜底全扫」语义：

- 首扫（state 未建）= 全量；
- 缓存过期但房间无推进 → 复用上次条目，**零 /messages 拨号**；
- 探针（sync_watcher.room_last_ts）推进 → 只重扫该房；
- full_at 超 600s → 兜底全量。

httpx（GatedAsyncClient）与 config 均以假对象 monkeypatch；不碰真实
网络与配置文件。
"""
from __future__ import annotations

import json
import time
import urllib.parse as _up

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from agentteams_connector import config as cfgmod
from agentteams_connector import router as router_mod
from agentteams_connector import sync_watcher
from agentteams_connector.router import build_router

HS = "http://hs.test"
ROOM_A = "!roomA:hs.test"
ROOM_B = "!roomB:hs.test"

CFG = {
    "address_mode": "lan",
    "matrix_homeservers": [HS],
    "matrix": {"access_token": "tok", "user_id": "@me:hs.test"},
    "controller_urls": [],
}


class _FakeResponse:
    def __init__(self, status_code: int, json_body: object = None):
        self.status_code = status_code
        self._jb = json_body

    def json(self):
        return self._jb


class _FakeClient:
    """按 URL 子串分发：joined_rooms / 房间 messages / 其余 404。"""

    instances: list = []
    msg_spec: dict = {}  # room_id -> {"chunk": [...], "state": [...]}

    def __init__(self, *a, **k):
        self.calls: list[str] = []
        _FakeClient.instances.append(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get(self, url: str, **kw):
        self.calls.append(url)
        if url.endswith("/joined_rooms"):
            return _FakeResponse(200, {"joined_rooms": [ROOM_A, ROOM_B]})
        for rid, body in _FakeClient.msg_spec.items():
            if _up.quote(rid, safe="") in url and "messages" in url:
                return _FakeResponse(200, body)
        return _FakeResponse(404, {})


def _msg(ts: int, body: str, sender: str = "@bob:hs.test", eid: str = "e1",
         mentions=None, wf=None) -> dict:
    content: dict = {"body": body}
    if mentions:
        content["m.mentions"] = {"user_ids": mentions}
    if wf is not None:
        content["agentteams.workflow"] = wf
    return {
        "type": "m.room.message",
        "sender": sender,
        "event_id": eid,
        "origin_server_ts": ts,
        "content": content,
    }


def _room_body(evs, name: str = "Room") -> dict:
    return {
        "chunk": evs,
        "state": [{"type": "m.room.name", "content": {"name": name}}],
    }


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(cfgmod, "load_config", lambda: json.loads(json.dumps(CFG)))
    # 扫描态与探针归零（conftest 只清 *_cache，不碰这两个结构）。
    router_mod._room_scan_state["mentions"].clear()
    router_mod._room_scan_state["approvals"].clear()
    router_mod._room_scan_state["workflow"].clear()
    now = time.time()
    router_mod._room_scan_state["full_at"].update(
        {"mentions": now, "approvals": now, "workflow": now}
    )
    sync_watcher._room_last_ts.clear()
    # conftest 的通用清空会把 *_cache dict 清成 {} —— 端点直接按键读取，
    # 需回填骨架。
    for cache in (
        router_mod._room_mentions_cache,
        router_mod._room_approvals_cache,
        router_mod._workflow_cache,
        router_mod._rooms_cache,
    ):
        cache.clear()
        cache.update({"data": None, "ts": 0.0})
    _FakeClient.instances = []
    _FakeClient.msg_spec = {}
    monkeypatch.setattr(
        "agentteams_connector.router.GatedAsyncClient",
        lambda *a, **k: _FakeClient(*a, **k),
    )
    with router_mod._cache_lock:
        router_mod._working_cache.clear()
    app = FastAPI()
    app.include_router(build_router())
    return TestClient(app)


def _msgs_total() -> int:
    """全实例累计 /messages 拨号数（measure 起点用增量差）。"""
    return sum(
        ("messages" in u) for inst in _FakeClient.instances for u in inst.calls
    )


# ── mentions ──────────────────────────────────────────────────────────
def test_mentions_full_then_zero_dial_skip(client):
    _FakeClient.msg_spec[ROOM_A] = _room_body(
        [_msg(1000, "hi @me", mentions=["@me:hs.test"], eid="a1")], "Room A"
    )
    _FakeClient.msg_spec[ROOM_B] = _room_body([_msg(900, "hello", eid="b1")], "Room B")
    r = client.get("/room-mentions")
    assert r.status_code == 200 and r.json()["count"] == 1
    assert _msgs_total() == 2  # 首扫全量
    # 过期缓存触发再扫路径——但房间无推进 → 零 /messages 拨号、条目复用。
    t0 = _msgs_total()
    router_mod._room_mentions_cache["ts"] = 0.0
    r2 = client.get("/room-mentions")
    assert r2.status_code == 200 and r2.json()["count"] == 1
    assert _msgs_total() - t0 == 0


def test_mentions_rescan_only_changed_room(client):
    _FakeClient.msg_spec[ROOM_A] = _room_body(
        [_msg(1000, "hi @me", mentions=["@me:hs.test"], eid="a1")], "Room A"
    )
    _FakeClient.msg_spec[ROOM_B] = _room_body([_msg(900, "hello", eid="b1")], "Room B")
    assert client.get("/room-mentions").json()["count"] == 1
    t0 = _msgs_total()
    # 房间 A 有新消息（探针推进）→ 只重扫 A；B 沿用。
    _FakeClient.msg_spec[ROOM_A] = _room_body(
        [
            _msg(2000, "again @me", mentions=["@me:hs.test"], eid="a2"),
            _msg(1000, "hi @me", mentions=["@me:hs.test"], eid="a1"),
        ],
        "Room A",
    )
    sync_watcher._room_last_ts[ROOM_A] = 2000
    router_mod._room_mentions_cache["ts"] = 0.0
    r = client.get("/room-mentions")
    assert r.json()["count"] == 2  # a1 复用 + a2 新扫
    assert _msgs_total() - t0 == 1  # 只有 A 重扫


def test_mentions_600s_full_pass_fallback(client):
    _FakeClient.msg_spec[ROOM_A] = _room_body([_msg(1000, "x", eid="a1")], "Room A")
    _FakeClient.msg_spec[ROOM_B] = _room_body([_msg(900, "y", eid="b1")], "Room B")
    client.get("/room-mentions")
    t0 = _msgs_total()
    router_mod._room_scan_state["full_at"]["mentions"] = 0.0  # 超 600s
    router_mod._room_mentions_cache["ts"] = 0.0
    client.get("/room-mentions")
    assert _msgs_total() - t0 == 2  # 兜底全量重扫


# ── approvals ─────────────────────────────────────────────────────────
def test_approvals_incremental_and_resolution(client):
    _FakeClient.msg_spec[ROOM_A] = _room_body(
        [
            _msg(
                1000,
                "🛡️ Approval Required — 工具执行审批：rm -rf /tmp/x",
                sender="@worker:hs.test",
                eid="ap1",
            )
        ],
        "Room A",
    )
    _FakeClient.msg_spec[ROOM_B] = _room_body([_msg(900, "idle", eid="b1")], "Room B")
    r = client.get("/room-approvals")
    assert r.status_code == 200 and r.json()["count"] == 1
    assert _msgs_total() == 2
    # 无推进 → 复用（零拨号）。
    t0 = _msgs_total()
    router_mod._room_approvals_cache["ts"] = 0.0
    r2 = client.get("/room-approvals")
    assert r2.json()["count"] == 1 and _msgs_total() - t0 == 0
    t1 = _msgs_total()
    # A 出现审批命令 → 只重扫 A，pending 消解。
    _FakeClient.msg_spec[ROOM_A] = _room_body(
        [
            _msg(2000, "/approval approve", sender="@human:hs.test", eid="c1"),
            _msg(
                1000,
                "🛡️ Approval Required — 工具执行审批：rm -rf /tmp/x",
                sender="@worker:hs.test",
                eid="ap1",
            ),
        ],
        "Room A",
    )
    sync_watcher._room_last_ts[ROOM_A] = 2000
    router_mod._room_approvals_cache["ts"] = 0.0
    r3 = client.get("/room-approvals")
    assert r3.json()["count"] == 0
    assert _msgs_total() - t1 == 1


# ── workflow/events ───────────────────────────────────────────────────
def test_workflow_incremental_skip(client):
    router_mod._rooms_cache.update(
        {
            "data": {
                "rooms": [
                    {"room_id": ROOM_A, "name": "Room A", "member_count": 3},
                    {"room_id": ROOM_B, "name": "Room B", "member_count": 2},
                ]
            },
            "ts": time.time(),  # 新鲜 → 不走 sync 路径
        }
    )
    _FakeClient.msg_spec[ROOM_A] = _room_body(
        [_msg(1000, "wf", eid="w1", wf={"runId": "r1", "title": "T", "status": "done"})],
        "Room A",
    )
    _FakeClient.msg_spec[ROOM_B] = _room_body([_msg(800, "idle", eid="w0")], "Room B")
    r = client.get("/workflow/events")
    assert r.status_code == 200 and len(r.json()["events"]) == 1
    assert _msgs_total() == 2
    t0 = _msgs_total()
    router_mod._workflow_cache["ts"] = 0.0  # 过期 → 走扫描路径
    r2 = client.get("/workflow/events")
    assert len(r2.json()["events"]) == 1
    assert _msgs_total() - t0 == 0  # 无推进零重扫
