# -*- coding: utf-8 -*-
"""/teams/structure 回归测试（v0.5.0-beta.12）。

背景（历史缺陷：团队管理页 HTTP 500）：``_token_or_none`` 曾被 3 个端点
调用但**从未定义** → 每次请求 NameError → 500。本文件护栏：

- 带 token 时打 Controller /api/v1/workers 成功 → 200 + 树含 runtime/room_id
  （基础字段）+ source=controller-workers。
- 无 Controller 配置 → 200 优雅降级（空树），不 500。
- ``_token_or_none`` 纯函数：空配置 → None；有 token → token；内容非法 →
  None（不裸抛）。
"""
from __future__ import annotations

import json

import pytest

from agentteams_connector import config as cfgmod
from agentteams_connector.router import (
    _ROOMS_CACHE_TTL,
    _STRUCTURE_NEGATIVE_TTL,
    _structure_cache,
    _token_or_none,
    build_router,
)


class _FakeResponse:
    def __init__(self, status_code: int, json_body: object = None):
        self.status_code = status_code
        self.headers = {}
        self._json_body = json_body

    def json(self):
        if self._json_body is None:
            raise AttributeError("no json body")
        return self._json_body


class _FakeClient:
    instances: list[["_FakeClient"]] = []
    get_spec: dict = {}

    def __init__(self, *a, **k):
        self.calls: list[tuple[str, str]] = []
        _FakeClient.instances.append(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a, **k):
        return False

    async def get(self, url, headers=None, **k):
        self.calls.append(("GET", url))
        for key, resp in _FakeClient.get_spec.items():
            if key in url:
                return resp
        return _FakeResponse(404)


_WORKERS = {
    "workers": [
        {
            "name": "team-a-lead",
            "team": "team-a",
            "role": "team_leader",
            "matrixUserID": "@lead:matrix-local.hiclaw.io:6867",
            "roomID": "!leadroom:matrix-local.hiclaw.io",
            "runtime": "qwenpaw",
            "phase": "Running",
        },
        {
            "name": "harmony-dev",
            "team": "team-a",
            "role": "worker",
            "matrixUserID": "@harmony:matrix-local.hiclaw.io:6867",
            "roomID": "!harmonyroom:matrix-local.hiclaw.io",
            "runtime": "qwenpaw",
            "phase": "Running",
        },
    ]
}


@pytest.fixture
def client(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    state = {
        "data": {
            "controller_urls": ["http://10.0.0.1:8090"],
            "controller_token": "ctok123",
            "matrix_homeservers": [],
            "matrix": {"user_id": "", "access_token": ""},
        }
    }

    def fake_load():
        return json.loads(json.dumps(state["data"]))

    monkeypatch.setattr(cfgmod, "load_config", fake_load)
    monkeypatch.setattr(
        cfgmod, "update_config", lambda p: json.loads(json.dumps(state["data"]))
    )

    _FakeClient.instances = []
    _FakeClient.get_spec = {}

    def fake_client_cls(*a, **k):
        return _FakeClient(*a, **k)

    monkeypatch.setattr(
        "agentteams_connector.router.httpx.AsyncClient", fake_client_cls
    )

    app = FastAPI()
    app.include_router(build_router())
    return TestClient(app), state


def test_teams_structure_with_controller_token(client):
    """v0.5.0-beta.12 回归：修复前此端点恒 500（_token_or_none NameError）。"""
    tc, _ = client
    _FakeClient.get_spec["/api/v1/workers"] = _FakeResponse(200, _WORKERS)
    r = tc.get("/teams/structure", params={"force": True})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["source"] == "controller-workers"
    teams = {t["team_name"]: t["workers"] for t in body["tree"]}
    assert "team-a" in teams
    by_name = {w["worker_name"]: w for w in teams["team-a"]}
    assert by_name["team-a-lead"]["role"] == "leader"
    assert by_name["harmony-dev"]["role"] == "worker"
    # 基础字段：runtime/room_id 必须从 CR 带出（实锤此前恒空）
    assert by_name["harmony-dev"]["runtime"] == "qwenpaw"
    assert by_name["harmony-dev"]["room_id"] == "!harmonyroom:matrix-local.hiclaw.io"


def test_teams_structure_no_controller_graceful(client):
    """无 Controller 配置 → 200 空树（优雅降级，不 500）。"""
    tc, state = client
    state["data"]["controller_urls"] = []
    state["data"]["controller_token"] = ""
    r = tc.get("/teams/structure", params={"force": True})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["tree"] == []


def test_token_or_none_empty_config():
    assert _token_or_none({}) is None


def test_token_or_none_returns_token():
    assert _token_or_none({"controller_token": "abc"}) == "abc"


def test_token_or_none_invalid_content_no_raise():
    """token 内容非法（非 ASCII）→ None，不裸抛 TokenValidationError。"""
    assert _token_or_none({"controller_token": "tok\u4e2d123"}) is None


# ── v0.5.0-beta.13.12：/teams/structure 缓存 TTL 正负分离回归 ──────────
# 13.11 装验「团队管理 tab 刷不出完整信息，手动刷新也不行，要等 30s 自动
# 刷新」后端半真根因：首次失败/空树结果被正缓存 60s（负缓存），锁死后续
# 手动刷新。修法：成功（controller-workers 且非空）= 60s；降级/空树 = 5s。
# 本文件护栏：两条 TTL 分支 + force 旁路 + 负缓存快速过期语义。


def test_structure_positive_cache_ttl_on_success(client):
    """成功（controller-workers 非空树）→ 正缓存 60s。"""
    from agentteams_connector.router import invalidate_data_caches

    invalidate_data_caches("test-reset")
    tc, _ = client
    _FakeClient.get_spec["/api/v1/workers"] = _FakeResponse(200, _WORKERS)
    r = tc.get("/teams/structure", params={"force": True})
    assert r.status_code == 200, r.text
    assert r.json()["source"] == "controller-workers"
    assert _structure_cache["ttl"] == _ROOMS_CACHE_TTL
    assert _structure_cache["ttl"] == 60.0


def test_structure_negative_cache_ttl_on_empty(client):
    """降级/空树 → 负缓存 5s（不锁死 60s）。"""
    from agentteams_connector.router import invalidate_data_caches

    invalidate_data_caches("test-reset")
    tc, state = client
    state["data"]["controller_urls"] = []
    state["data"]["controller_token"] = ""
    r = tc.get("/teams/structure", params={"force": True})
    assert r.status_code == 200, r.text
    assert r.json()["tree"] == []
    assert _structure_cache["ttl"] == _STRUCTURE_NEGATIVE_TTL
    assert _structure_cache["ttl"] == 5.0


def test_structure_negative_cache_hit_within_ttl(client):
    """空树负缓存 5s 内非 force 命中缓存（cached=True，不再重算）。"""
    import time as _time

    from agentteams_connector.router import invalidate_data_caches

    invalidate_data_caches("test-reset")
    tc, state = client
    state["data"]["controller_urls"] = []
    state["data"]["controller_token"] = ""
    # 首拉（force）写入空树 + 5s TTL。
    r1 = tc.get("/teams/structure", params={"force": True})
    assert r1.status_code == 200 and r1.json()["tree"] == []
    # 把 ts 拨到"刚刚"（now - ts ≈ 0 < 5s）→ 非 force 请求应命中缓存。
    _structure_cache["ts"] = _time.time()
    r2 = tc.get("/teams/structure")  # 非 force
    assert r2.status_code == 200
    assert r2.json().get("cached") is True


def test_structure_force_bypasses_negative_cache(client):
    """force=true 绕过负缓存（前端手动刷新=force，5s 内也可强制重拉）。"""
    from agentteams_connector.router import invalidate_data_caches

    invalidate_data_caches("test-reset")
    tc, state = client
    state["data"]["controller_urls"] = []
    state["data"]["controller_token"] = ""
    r1 = tc.get("/teams/structure", params={"force": True})
    assert r1.status_code == 200
    # force 请求恒不带 cached 标记（即使缓存未过期）。
    r2 = tc.get("/teams/structure", params={"force": True})
    assert r2.status_code == 200
    assert r2.json().get("cached") is None

