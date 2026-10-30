# -*- coding: utf-8 -*-
"""Worker 插件域（/workers/{worker}/plugins）单测——Controller 只读代理。

护栏（任务书口径：诚实降级、字段直传、防御性拆壳）：
- P1 无本地 controller token → 200 {available:false, reason:no_token}
  且不拨号（不 500、不吞成空数组）。
- P2 Controller 404（端点未合/路径不存在）→ 200
  {available:false, reason:controller_too_old}。
- P3 Controller 200 条目数组 → 字段直传（enabled/loaded/plugin_type/
  version 等逐字段零改动，非 dict 条目跳过）。
- P4 Controller 200 {"plugins": [...]} 包装对象形态 → 拆壳取列表。
- P5 Controller 200 非列表形态（裸 dict 无 plugins 键）→ 空列表，不伪造。
- P6 401 / P7 403 → 状态码透传（带简短原因）。
- P8 Controller 500 → 502；P9 传输全败（st=0）→ 502。
- P10 非法 worker 名 → 400 且不拨号。
"""
from __future__ import annotations

import json

import pytest

from agentteams_connector import config as cfgmod
from agentteams_connector.router import build_router


@pytest.fixture
def client(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    state = {
        "controller_urls": ["http://10.0.0.1:8090"],
        "controller_token": "ctok123",
        "matrix_homeservers": [],
        "matrix": {"user_id": "", "access_token": ""},
    }

    def fake_load():
        return json.loads(json.dumps(state))

    monkeypatch.setattr(cfgmod, "load_config", fake_load)
    monkeypatch.delenv("AGENTTEAMS_CONTROLLER_TOKEN", raising=False)

    app = FastAPI()
    app.include_router(build_router())
    return TestClient(app), state, monkeypatch


def _patch_ctl(monkeypatch, st: int, data):
    """替换 worker_plugins_api 模块命名空间的 _ctl_json（调用时解析）。"""
    from agentteams_connector.routers import worker_plugins_api

    calls: list = []

    async def fake_ctl(method, url, token, json_body=None):
        calls.append((method, url, token))
        return st, data, (json.dumps(data) if data is not None else "")

    monkeypatch.setattr(worker_plugins_api, "_ctl_json", fake_ctl)
    return calls


# ── P1 无 token → 诚实降级且不拨号 ────────────────────────────────────
def test_no_token_honest_degrade(client):
    tc, state, monkeypatch = client
    state["controller_token"] = ""
    calls = _patch_ctl(monkeypatch, 200, [])
    r = tc.get("/workers/webdev/plugins")
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["available"] is False
    assert b["reason"] == "no_token"
    assert calls == []


# ── P2 Controller 404（端点未合）→ controller_too_old ─────────────────
def test_controller_404_too_old(client):
    tc, _, monkeypatch = client
    _patch_ctl(monkeypatch, 404, None)
    r = tc.get("/workers/webdev/plugins")
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["available"] is False
    assert b["reason"] == "controller_too_old"


# ── P3 200 条目数组 → 字段直传（无脱敏、零改动）───────────────────────
def test_200_list_form_verbatim(client):
    tc, _, monkeypatch = client
    data = [
        {
            "id": "teamharness",
            "name": "TeamHarness",
            "version": "1.4.0",
            "enabled": True,
            "loaded": True,
            "plugin_type": "builtin",
            "source": "image",
        },
        {
            "id": "custom-pkg",
            "name": "Custom Package",
            "version": "0.1.0",
            "enabled": False,
            "loaded": False,
            "plugin_type": "custom",
        },
        "junk-entry",  # 非 dict 条目 → 跳过（不伪造）
    ]
    calls = _patch_ctl(monkeypatch, 200, data)
    r = tc.get("/workers/webdev/plugins")
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["available"] is True
    assert b["worker"] == "webdev"
    # 条目直传：与源数组逐字段一致（junk 条目被跳过）。
    assert b["plugins"] == [data[0], data[1]]
    assert b["plugins"][0]["version"] == "1.4.0"
    assert b["plugins"][0]["enabled"] is True
    assert b["plugins"][0]["loaded"] is True
    assert b["plugins"][0]["plugin_type"] == "builtin"
    assert b["plugins"][1]["enabled"] is False
    assert calls == [("GET", "/api/v1/workers/webdev/plugins", "ctok123")]


# ── P4 200 包装对象 {"plugins": [...]} → 拆壳 ─────────────────────────
def test_200_wrapper_form(client):
    tc, _, monkeypatch = client
    data = {"plugins": [
        {"id": "alpha", "name": "Alpha", "version": "0.2.0",
         "enabled": True, "loaded": True, "plugin_type": "team"},
    ], "count": 1}
    _patch_ctl(monkeypatch, 200, data)
    r = tc.get("/workers/webdev/plugins")
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["available"] is True
    assert len(b["plugins"]) == 1
    assert b["plugins"][0]["id"] == "alpha"
    assert b["plugins"][0]["plugin_type"] == "team"


# ── P5 200 非列表形态 → 空列表（不伪造）──────────────────────────────
def test_200_unrecognized_shape_empty(client):
    tc, _, monkeypatch = client
    _patch_ctl(monkeypatch, 200, {"message": "hello"})
    r = tc.get("/workers/webdev/plugins")
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["available"] is True
    assert b["plugins"] == []


# ── P6/P7 401/403 → 状态码透传 + 简短原因 ─────────────────────────────
def test_401_passthrough(client):
    tc, _, monkeypatch = client
    _patch_ctl(monkeypatch, 401, {})
    r = tc.get("/workers/webdev/plugins")
    assert r.status_code == 401, r.text
    assert r.json()["detail"]


def test_403_passthrough(client):
    tc, _, monkeypatch = client
    _patch_ctl(monkeypatch, 403, {})
    r = tc.get("/workers/webdev/plugins")
    assert r.status_code == 403, r.text
    assert r.json()["detail"]


# ── P8/P9 500 → 502；传输全败 → 502 ──────────────────────────────────
def test_500_maps_to_502(client):
    tc, _, monkeypatch = client
    _patch_ctl(monkeypatch, 500, {"message": "boom"})
    r = tc.get("/workers/webdev/plugins")
    assert r.status_code == 502, r.text


def test_transport_failure_maps_to_502(client):
    tc, _, monkeypatch = client
    _patch_ctl(monkeypatch, 0, {})
    r = tc.get("/workers/webdev/plugins")
    assert r.status_code == 502, r.text


# ── P10 非法 worker 名 → 400 且不拨号 ─────────────────────────────────
def test_bad_name_400_no_dial(client):
    tc, _, monkeypatch = client
    calls = _patch_ctl(monkeypatch, 200, [])
    r = tc.get("/workers/UPPER/plugins")
    assert r.status_code == 400, r.text
    assert calls == []
