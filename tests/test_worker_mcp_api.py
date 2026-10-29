# -*- coding: utf-8 -*-
"""Worker MCP 域（/workers/{worker}/mcp）单测——自注册 MCP 只读代理。

护栏（任务书口径：诚实降级、字段脱敏、防御性归一化）：
- M1 无本地 controller token → 200 {available:false, reason:no_token}
  且不拨号（不 500、不吞成空数组）。
- M2 Controller 404（端点未合/路径不存在）→ 200
  {available:false, reason:controller_too_old}。
- M3 Controller 200 条目数组 → 归一化 + 脱敏（env/headers 值=***；
  /home/<u>、/root 路径→~；URL 剥 user:pass@；敏感值零残留）。
- M4 Controller 200 name→config 映射（QwenPaw mcp.clients 形态）。
- M5 Controller 200 {"mcpServers": [...]} 包装对象形态。
- M6 401 / M7 403 → 状态码透传（带简短原因）。
- M8 Controller 500 → 502；M9 传输全败（st=0）→ 502。
- M10 非法 worker 名 → 400 且不拨号。
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
    """替换 worker_mcp_api 模块命名空间的 _ctl_json（调用时解析）。"""
    from agentteams_connector.routers import worker_mcp_api

    calls: list = []

    async def fake_ctl(method, url, token, json_body=None):
        calls.append((method, url, token))
        return st, data, (json.dumps(data) if data is not None else "")

    monkeypatch.setattr(worker_mcp_api, "_ctl_json", fake_ctl)
    return calls


# ── M1 无 token → 诚实降级且不拨号 ────────────────────────────────────
def test_no_token_honest_degrade(client):
    tc, state, monkeypatch = client
    state["controller_token"] = ""
    calls = _patch_ctl(monkeypatch, 200, [])
    r = tc.get("/workers/webdev/mcp")
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["available"] is False
    assert b["reason"] == "no_token"
    assert calls == []


# ── M2 Controller 404（端点未合）→ controller_too_old ─────────────────
def test_controller_404_too_old(client):
    tc, _, monkeypatch = client
    _patch_ctl(monkeypatch, 404, None)
    r = tc.get("/workers/webdev/mcp")
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["available"] is False
    assert b["reason"] == "controller_too_old"


# ── M3 200 条目数组 → 归一化 + 脱敏 ──────────────────────────────────
def test_200_list_form_normalized_masked(client):
    tc, _, monkeypatch = client
    data = [
        {
            "name": "teamharness",
            "command": "/home/lsw/qwenpaw/mcp/server.py",
            "args": ["/home/lsw/qwenpaw/agent", "--stdio"],
            "env": {"AGENTTEAMS_AUTH_TOKEN": "secret123"},
            "transport": "stdio",
            "enabled": True,
        },
        {
            "name": "remote",
            "url": "http://user:pass@10.0.0.9:3000/mcp",
            "headers": {"Authorization": "Bearer s3cr3t"},
            "transport": "http",
        },
    ]
    calls = _patch_ctl(monkeypatch, 200, data)
    r = tc.get("/workers/webdev/mcp")
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["available"] is True
    assert b["worker"] == "webdev"
    entries = {e["name"]: e for e in b["mcpServers"]}
    th = entries["teamharness"]
    assert th["command"] == "~/qwenpaw/mcp/server.py"
    assert th["args"] == ["~/qwenpaw/agent", "--stdio"]
    assert th["env"] == {"AGENTTEAMS_AUTH_TOKEN": "***"}
    assert th["enabled"] is True
    assert th["transport"] == "stdio"
    rm = entries["remote"]
    assert rm["url"] == "http://10.0.0.9:3000/mcp"
    assert rm["headers"] == {"Authorization": "***"}
    assert rm["enabled"] is None
    # 敏感值零残留。
    assert "secret123" not in r.text
    assert "s3cr3t" not in r.text
    assert "user:pass@" not in r.text
    assert calls == [("GET", "/api/v1/workers/webdev/mcp", "ctok123")]


# ── M4 200 name→config 映射（QwenPaw mcp.clients 形态）──────────────
def test_200_map_form(client):
    tc, _, monkeypatch = client
    data = {
        "teamharness": {
            "command": "/root/mp/server.py",
            "args": [],
            "transport": "stdio",
            "disabled": False,
        }
    }
    _patch_ctl(monkeypatch, 200, data)
    r = tc.get("/workers/webdev/mcp")
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["available"] is True
    assert len(b["mcpServers"]) == 1
    e = b["mcpServers"][0]
    assert e["name"] == "teamharness"
    assert e["command"] == "~/mp/server.py"
    assert e["enabled"] is True  # disabled=False → enabled=True


# ── M5 200 包装对象 {"mcpServers": [...]} ────────────────────────────
def test_200_wrapper_form(client):
    tc, _, monkeypatch = client
    data = {"mcpServers": [
        {"name": "alpha", "url": "http://10.0.0.9:1/mcp", "transport": "http"},
    ], "count": 1}
    _patch_ctl(monkeypatch, 200, data)
    r = tc.get("/workers/webdev/mcp")
    assert r.status_code == 200, r.text
    names = [e["name"] for e in r.json()["mcpServers"]]
    assert names == ["alpha"]


# ── M6/M7 401/403 → 状态码透传 + 简短原因 ─────────────────────────────
def test_401_passthrough(client):
    tc, _, monkeypatch = client
    _patch_ctl(monkeypatch, 401, {})
    r = tc.get("/workers/webdev/mcp")
    assert r.status_code == 401, r.text
    assert r.json()["detail"]


def test_403_passthrough(client):
    tc, _, monkeypatch = client
    _patch_ctl(monkeypatch, 403, {})
    r = tc.get("/workers/webdev/mcp")
    assert r.status_code == 403, r.text
    assert r.json()["detail"]


# ── M8/M9 500 → 502；传输全败 → 502 ──────────────────────────────────
def test_500_maps_to_502(client):
    tc, _, monkeypatch = client
    _patch_ctl(monkeypatch, 500, {"message": "boom"})
    r = tc.get("/workers/webdev/mcp")
    assert r.status_code == 502, r.text


def test_transport_failure_maps_to_502(client):
    tc, _, monkeypatch = client
    _patch_ctl(monkeypatch, 0, {})
    r = tc.get("/workers/webdev/mcp")
    assert r.status_code == 502, r.text


# ── M10 非法 worker 名 → 400 且不拨号 ─────────────────────────────────
def test_bad_name_400_no_dial(client):
    tc, _, monkeypatch = client
    calls = _patch_ctl(monkeypatch, 200, [])
    r = tc.get("/workers/UPPER/mcp")
    assert r.status_code == 400, r.text
    assert calls == []


# ── M11 QwenPaw MCPClientInfo：key=身份 / name=显示名（不拆成两行）──────
def test_key_identity_and_display_name(client):
    tc, _, monkeypatch = client
    from agentteams_connector.routers import worker_mcp_api

    async def fake_ctl(method, url, token, json_body=None):
        return 200, [
            {
                "key": "teamharness",
                "name": "TeamHarness",
                "enabled": True,
                "transport": "stdio",
            }
        ], ""

    monkeypatch.setattr(worker_mcp_api, "_ctl_json", fake_ctl)
    r = tc.get("/workers/webdev/mcp")
    assert r.status_code == 200, r.text
    e = r.json()["mcpServers"][0]
    assert e["name"] == "teamharness"      # identity = key
    assert e["displayName"] == "TeamHarness"  # display name kept separately
