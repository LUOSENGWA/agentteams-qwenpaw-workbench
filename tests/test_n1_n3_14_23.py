# -*- coding: utf-8 -*-
"""14.23 回归：N1 验证分离 + N3 PATCH 代理。

N1（Higress 验证不再触碰 Controller token）：
- 路径 A（admin 账密）在 token 含非法字符时不得报 token 错（旧版前置
  _resolve_controller_token → TokenValidationError → 误报）。
- 路径 B（Controller token）行为不变。

N3（catch-all 代理加 PATCH）：
- PATCH /{target}/{path} 不再 405（beta.12.3 起潜伏）。
- PATCH body 读取与 POST/PUT 同语义。
"""
from __future__ import annotations

import json

import pytest

from agentteams_connector import config as cfgmod
from agentteams_connector import router as router_mod
from agentteams_connector.router import build_router


# ── N1 假对象（复用 test_verify_admin.py 范式） ─────────────
class _FakeResponse:
    def __init__(self, status_code, headers=None, json_body=None, text=""):
        self.status_code = status_code
        self.headers = headers or {}
        self._json_body = json_body
        self.text = text
        self.content = text.encode() if isinstance(text, str) else (text or b"")

    def json(self):
        if self._json_body is None:
            raise AttributeError("no json body")
        return self._json_body


class _FakeClient:
    instances: list = []

    def __init__(self, *a, **k):
        self.calls: list[tuple[str, str]] = []
        self.last_post_json = None
        self.last_get_headers = {}
        _FakeClient.instances.append(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    def _match(self, url, spec):
        for key, resp in spec.items():
            if key in url:
                return resp
        return _FakeResponse(404)

    async def post(self, url, json=None, **k):
        self.calls.append(("POST", url))
        self.last_post_json = json
        return self._match(url, _FakeClient.post_spec)

    async def get(self, url, headers=None, **k):
        self.calls.append(("GET", url))
        self.last_get_headers = headers or {}
        return self._match(url, _FakeClient.get_spec)

    async def request(self, method, url, **k):
        self.calls.append((method, url))
        return self._match(url, _FakeClient.post_spec if method != "GET" else _FakeClient.get_spec)


@pytest.fixture
def client(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    state = {
        "data": {
            "controller_urls": ["http://10.0.0.1:8090"],
            "controller_token": "",
            "admin_username": "",
            "admin_password": "",
            "gateway_admin_url": "http://10.0.0.1:6868",
            "console_session": "",
            "matrix_homeservers": [],
            "matrix": {"user_id": "", "access_token": ""},
        },
        "updates": [],
    }

    def fake_load():
        return json.loads(json.dumps(state["data"]))

    def fake_update(patch):
        for key, val in patch.items():
            if val:
                state["data"][key] = val
        state["updates"].append(dict(patch))
        return json.loads(json.dumps(state["data"]))

    monkeypatch.setattr(cfgmod, "load_config", fake_load)
    monkeypatch.setattr(cfgmod, "update_config", fake_update)
    # 清 env，防 AGENTTEAMS_CONTROLLER_TOKEN 干扰
    monkeypatch.delenv("AGENTTEAMS_CONTROLLER_TOKEN", raising=False)

    _FakeClient.instances = []
    _FakeClient.post_spec = {}
    _FakeClient.get_spec = {}

    def fake_client_cls(*a, **k):
        return _FakeClient(*a, **k)

    monkeypatch.setattr(
        "agentteams_connector.router.GatedAsyncClient", fake_client_cls
    )

    app = FastAPI()
    app.include_router(build_router())
    return TestClient(app), state


# ── N1 测试 ─────────────────────────────────────────────
def test_n1_higress_verify_ignores_invalid_token(client):
    """路径 A（admin 账密）在 config token 含非法字符时不得报 token 错。"""
    tc, state = client
    state["data"]["admin_username"] = "admin"
    state["data"]["admin_password"] = "pw123"
    state["data"]["controller_token"] = "bad\ttoken\x00\x01"  # 非法字符
    _FakeClient.post_spec["/session/login"] = _FakeResponse(
        200, {"set-cookie": "higress-session=abc; Path=/; HttpOnly"}
    )
    _FakeClient.get_spec["/v1/ai/routes"] = _FakeResponse(200, json_body={"routes": []})
    _FakeClient.get_spec["/v1/ai/providers"] = _FakeResponse(200, json_body={"providers": []})

    r = tc.post(
        "/config/verify-admin",
        json={"admin_username": "admin", "admin_password": "pw123"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True, f"Expected success, got: {body}"
    assert body["mode"] == "password"


def test_n1_token_verify_still_works(client):
    """路径 B（Controller token）正常验证通过。"""
    tc, state = client
    _FakeClient.get_spec["/api/v1/teams"] = _FakeResponse(
        200, json_body={"teams": []}
    )
    r = tc.post(
        "/config/verify-admin",
        json={"controller_token": "valid-token-123"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["mode"] == "token"


def test_n1_token_verify_invalid_token_still_reports(client):
    """路径 B 收到非法字符 token 仍报 TokenValidationError。"""
    tc, state = client
    r = tc.post(
        "/config/verify-admin",
        json={"controller_token": "bad\x00\x01token"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert "token" in body.get("error", "").lower() or "非法" in body.get("error", "")


def test_n1_no_creds_no_token_empty(client):
    """两路径凭据全空 → 二选一错误。"""
    tc, state = client
    r = tc.post(
        "/config/verify-admin",
        json={},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert "二选一" in body.get("error", "") or "token" in body.get("error", "")


# ── N3 测试（PATCH 代理） ────────────────────────────────
class _ProxyResp:
    def __init__(self, status_code, content=b'{"detail":"ok"}', headers=None):
        self.status_code = status_code
        self.content = content
        self.headers = headers or {"content-type": "application/json"}
        self._text = content.decode("utf-8", "replace")

    @property
    def text(self):
        return self._text

    def json(self):
        return json.loads(self._text)


class _P4Client:
    """代理专用 httpx 替身（与 test_proxy_4xx_failover.py 同范式）。"""

    def __init__(self, spec):
        self.spec = spec
        self.records = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a, **k):
        return False

    async def request(self, method, url, **k):
        self.records.append((method, url, k.get("json")))
        for key, resp in self.spec:
            if key in url:
                return resp
        return _ProxyResp(404)

    async def get(self, url, **k):
        return await self.request("GET", url, **k)

    async def post(self, url, **k):
        return await self.request("POST", url, **k)

    async def put(self, url, **k):
        return await self.request("PUT", url, **k)

    async def patch(self, url, **k):
        return await self.request("PATCH", url, **k)

    async def delete(self, url, **k):
        return await self.request("DELETE", url, **k)


@pytest.fixture
def proxy_client(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    cfg = {
        "controller_urls": ["http://10.0.0.1:8090"],
        "controller_token": "ctok",
        "matrix_homeservers": [],
        "matrix": {"user_id": "", "access_token": ""},
    }
    monkeypatch.setattr(cfgmod, "load_config", lambda: json.loads(json.dumps(cfg)))
    monkeypatch.delenv("AGENTTEAMS_CONTROLLER_TOKEN", raising=False)
    _P4Client.spec = []
    _P4Client.records = []

    def fake_client_cls(*a, **k):
        c = _P4Client(_P4Client.spec)
        c.records = _P4Client.records  # 共享
        return c

    monkeypatch.setattr(
        "agentteams_connector.router.GatedAsyncClient", fake_client_cls
    )
    app = FastAPI()
    app.include_router(build_router())
    return TestClient(app)


def test_n3_patch_proxy_not_405(proxy_client):
    """PATCH /controller/api/v1/workers/w1/tools/tool1 不再 405。"""
    _P4Client.spec = [("/tools/tool1", _ProxyResp(200, b'{"name":"tool1","enabled":true}'))]
    r = proxy_client.patch(
        "/controller/api/v1/workers/w1/tools/tool1",
        json={"enabled": True},
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
    assert r.json()["enabled"] is True


def test_n3_patch_proxy_405_passthrough(proxy_client):
    """上游 405（方法不被上游支持）原样透传 + warning 日志（非静默）。"""
    _P4Client.spec = [("/tools/tool1", _ProxyResp(405, b'Method Not Allowed'))]
    r = proxy_client.patch(
        "/controller/api/v1/workers/w1/tools/tool1",
        json={"enabled": False},
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 405
    assert r.text == "Method Not Allowed"


def test_n3_patch_body_read(proxy_client):
    """PATCH body 读取与 POST/PUT 同语义（JSON 传透）。"""
    _P4Client.spec = [("/tools/tool1", _ProxyResp(200, b'{}'))]
    r = proxy_client.patch(
        "/controller/api/v1/workers/w1/tools/tool1",
        json={"enabled": True, "asyncExecution": False},
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 200
    # 验证 _P4Client 收到的 json body
    methods = [m for m, _, _ in _P4Client.records]
    assert "PATCH" in methods
