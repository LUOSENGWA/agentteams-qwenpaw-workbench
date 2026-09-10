# -*- coding: utf-8 -*-
"""/teams/structure 回归测试（v0.5.0-beta.12）。

背景（9/10 装验实报：团队管理页 HTTP 500）：``_token_or_none`` 曾被 3 个端点
调用但**从未定义** → 每次请求 NameError → 500。本文件护栏：

- 带 token 时打 Controller /api/v1/workers 成功 → 200 + 树含 runtime/room_id
  （批次 0 字段）+ source=controller-workers。
- 无 Controller 配置 → 200 优雅降级（空树），不 500。
- ``_token_or_none`` 纯函数：空配置 → None；有 token → token；内容非法 →
  None（不裸抛）。
"""
from __future__ import annotations

import json

import pytest

from agentteams_connector import config as cfgmod
from agentteams_connector.router import _token_or_none, build_router


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
            "name": "sysdev-lead",
            "team": "sysdev-team",
            "role": "team_leader",
            "matrixUserID": "@lead:matrix-local.hiclaw.io:6867",
            "roomID": "!leadroom:matrix-local.hiclaw.io",
            "runtime": "qwenpaw",
            "phase": "Running",
        },
        {
            "name": "harmony-dev",
            "team": "sysdev-team",
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
    """beta.12 回归：修复前此端点恒 500（_token_or_none NameError）。"""
    tc, _ = client
    _FakeClient.get_spec["/api/v1/workers"] = _FakeResponse(200, _WORKERS)
    r = tc.get("/teams/structure", params={"force": True})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["source"] == "controller-workers"
    teams = {t["team_name"]: t["workers"] for t in body["tree"]}
    assert "sysdev-team" in teams
    by_name = {w["worker_name"]: w for w in teams["sysdev-team"]}
    assert by_name["sysdev-lead"]["role"] == "leader"
    assert by_name["harmony-dev"]["role"] == "worker"
    # 批次 0 字段：runtime/room_id 必须从 CR 带出（9/7 实锤此前恒空）
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

