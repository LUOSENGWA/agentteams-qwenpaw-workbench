# -*- coding: utf-8 -*-
"""L1 管理员验证二选一（v0.5.0-beta.12）单测。

覆盖 plan 件 4 的三组护栏：

- **verify-admin 两路径**：admin 账号密码 → Console /session/login（成功持
  会话 / 失败 / 不可达）；Controller token → GET /api/v1/teams（无尾斜杠，
  beta.12：Gin 对 /teams/ 返 404；成功 / 无效）；凭据全空 → 「二选一」错误。
- **网关地址必填（beta.12）**：Console 宿主端口部署时自选（安装脚本
  AGENTTEAMS_PORT_CONSOLE，默认 18001，人人不同）→ 8001/6868 探测已移除；
  gateway_admin_url 留空 → 可操作错误（不再盲探）。
- **脱敏**：redact() 对 admin_password / console_session 打 ***，
  admin_username 保留（非机密，前端回显）。

httpx.AsyncClient 与 config 模块均以假对象 monkeypatch——单测不依赖真实
Console/Controller 网络，也不碰真实配置文件。
"""
from __future__ import annotations

import json

import pytest

from agentteams_connector import config as cfgmod
from agentteams_connector.router import build_router


# ── 假对象 ─────────────────────────────────────────────
class _FakeResponse:
    def __init__(
        self,
        status_code: int,
        headers: dict | None = None,
        json_body: object = None,
    ):
        self.status_code = status_code
        self.headers = headers or {}
        self._json_body = json_body

    def json(self):
        if self._json_body is None:
            raise AttributeError("no json body")
        return self._json_body


class _RaiseOnCall:
    def __init__(self, exc):
        self._exc = exc

    def __call__(self, *a, **k):
        raise self._exc


class _FakeClient:
    """假 httpx.AsyncClient——记录请求，按 (method, url 子串) 返回预设响应。"""

    instances: list[["_FakeClient"]] = []

    def __init__(self, *a, **k):
        self.calls: list[tuple[str, str]] = []
        _FakeClient.instances.append(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    def _match(self, url: str, spec: dict):
        for key, resp in spec.items():
            if key in url:
                if isinstance(resp, Exception):
                    raise resp
                return resp
        return _FakeResponse(404)

    async def post(self, url, json=None, **k):
        self.calls.append(("POST", url))
        return self._match(url, _FakeClient.post_spec)

    async def get(self, url, headers=None, **k):
        self.calls.append(("GET", url))
        self.last_get_headers = headers or {}
        return self._match(url, _FakeClient.get_spec)


@pytest.fixture
def client(monkeypatch):
    """TestClient + 假 config 存储 + 假 httpx。"""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    state = {
        "data": {
            "controller_urls": ["http://10.0.0.1:8090"],
            "controller_token": "",
            "admin_username": "",
            "admin_password": "",
            "gateway_admin_url": "",
            "console_session": "",
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

    _FakeClient.instances = []
    _FakeClient.post_spec = {}
    _FakeClient.get_spec = {}

    def fake_client_cls(*a, **k):
        return _FakeClient(*a, **k)

    monkeypatch.setattr(
        "agentteams_connector.router.httpx.AsyncClient", fake_client_cls
    )

    app = FastAPI()
    app.include_router(build_router())
    return TestClient(app), state


def _last_client():
    assert _FakeClient.instances, "fake httpx client never constructed"
    return _FakeClient.instances[-1]


# ── 路径 A：admin 账号密码 → Console /session/login ──────────────────
def test_verify_admin_password_success(client):
    tc, state = client
    state["data"]["gateway_admin_url"] = "http://10.0.0.1:6868"
    _FakeClient.post_spec["/session/login"] = _FakeResponse(
        200, {"set-cookie": "higress-session=abc123; Path=/; HttpOnly"}
    )
    # beta.12：验证成功后立即自检 alias 层——fixture 用实测环境实况
    # （Console {code,data} 信封 + EQUAL 精确匹配 + 3 provider），把解包
    # 契约钉死：data 信封必须解开，providers 键必须取 .providers。
    _FakeClient.get_spec["/v1/ai/routes"] = _FakeResponse(
        200,
        json_body={
            "code": 0,
            "data": {
                "routes": [
                    {
                        "name": "deepseek-v4-flash",
                        "modelPredicates": [
                            {"matchType": "EQUAL", "matchValue": "deepseek-v4-flash"}
                        ],
                        "upstreams": [{"provider": "deepseek"}],
                    },
                    {
                        "name": "qwen3.6-local",
                        "modelPredicates": [
                            {"matchType": "EQUAL", "matchValue": "qwen3.6-27b-fp8"}
                        ],
                        "upstreams": [{"provider": "qwen3.6-local"}],
                    },
                    {
                        "name": "qwen3.6-plus-local",
                        "modelPredicates": [
                            {"matchType": "EQUAL", "matchValue": "qwen3.6-plus"}
                        ],
                        "upstreams": [{"provider": "qwen3.6-plus-local"}],
                    },
                ]
            },
        },
    )
    _FakeClient.get_spec["/v1/ai/providers"] = _FakeResponse(
        200,
        json_body={
            "code": 0,
            "data": {
                "providers": [
                    {"name": "deepseek"},
                    {"name": "qwen3.6-local"},
                    {"name": "qwen3.6-plus-local"},
                ]
            },
        },
    )
    r = tc.post(
        "/config/verify-admin",
        json={"admin_username": "admin", "admin_password": "pw"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["mode"] == "password"
    assert body["has_console_session"] is True
    # beta.12：无探测——只打显式配置的网关地址（登录 client 是第一个实例，
    # beta.12 自检 client 是第二个）
    login_client = _FakeClient.instances[0]
    assert ("POST", "http://10.0.0.1:6868/session/login") in login_client.calls
    # beta.12：自检计数 + alias 名单（信封解包 + EQUAL + provider 存在性）
    assert body["gateway_routes"] == 3
    assert body["gateway_aliases"] == [
        "deepseek-v4-flash",
        "qwen3.6-27b-fp8",
        "qwen3.6-plus",
    ]
    # 自检 GET 必须带新会话 cookie
    selfcheck_client = _FakeClient.instances[-1]
    assert ("GET", "http://10.0.0.1:6868/v1/ai/routes") in selfcheck_client.calls
    assert selfcheck_client.last_get_headers.get("Cookie") == "higress-session=abc123"
    # 会话 cookie 首段原样持久化
    assert state["data"]["console_session"] == "higress-session=abc123"
    assert state["data"]["gateway_admin_url"] == "http://10.0.0.1:6868"
    assert state["data"]["admin_password"] == "pw"


def test_verify_admin_password_selfcheck_degraded(client):
    """beta.12：自检 GET 失败（404/异常）不挡验证主流程——
    ok 仍 True，gateway_routes=0/aliases=[]（降级计数）。"""
    tc, state = client
    state["data"]["gateway_admin_url"] = "http://10.0.0.1:6868"
    _FakeClient.post_spec["/session/login"] = _FakeResponse(
        200, {"set-cookie": "higress-session=xyz; Path=/; HttpOnly"}
    )
    # 不设 get_spec → 默认 404 → 自检降级
    r = tc.post(
        "/config/verify-admin",
        json={"admin_username": "admin", "admin_password": "pw"},
    )
    body = r.json()
    assert body["ok"] is True
    assert body["has_console_session"] is True
    assert body["gateway_routes"] == 0
    assert body["gateway_aliases"] == []


def test_verify_admin_password_empty_gateway_url(client):
    """beta.12：网关地址留空 → 可操作错误（端口是部署时自选的，不盲探）。"""
    tc, _ = client
    _FakeClient.post_spec["/session/login"] = _FakeResponse(200)
    r = tc.post(
        "/config/verify-admin",
        json={"admin_username": "admin", "admin_password": "pw"},
    )
    body = r.json()
    assert body["ok"] is False
    assert "Higress 地址未配置" in body["error"]
    assert "18001" in body["error"]  # 默认端口提示
    # 未发生任何探测请求
    assert _FakeClient.instances == []


def test_verify_admin_password_failure(client):
    tc, state = client
    state["data"]["gateway_admin_url"] = "http://10.0.0.1:6868"
    _FakeClient.post_spec["/session/login"] = _FakeResponse(401)
    r = tc.post(
        "/config/verify-admin",
        json={"admin_username": "admin", "admin_password": "wrong"},
    )
    body = r.json()
    assert body["ok"] is False
    assert "验证失败" in body["error"]
    # 失败不持久化凭据
    assert state["data"]["admin_password"] == ""


def test_verify_admin_password_unreachable(client):
    tc, state = client
    state["data"]["gateway_admin_url"] = "http://10.0.0.1:6868"
    _FakeClient.post_spec["/session/login"] = ConnectionError("boom")
    r = tc.post(
        "/config/verify-admin",
        json={"admin_username": "admin", "admin_password": "pw"},
    )
    body = r.json()
    assert body["ok"] is False
    assert "不可达" in body["error"]


def test_verify_admin_password_star_placeholder(client):
    """admin_password='***' = 用已存值（脱敏占位符语义，与 token 同）。"""
    tc, state = client
    state["data"]["admin_password"] = "stored-pw"
    state["data"]["gateway_admin_url"] = "http://10.0.0.1:6868"
    _FakeClient.post_spec["/session/login"] = _FakeResponse(
        200, {"set-cookie": "s=2; Path=/"}
    )
    r = tc.post(
        "/config/verify-admin",
        json={"admin_username": "admin", "admin_password": "***"},
    )
    assert r.json()["ok"] is True
    assert state["data"]["admin_password"] == "stored-pw"


def test_verify_admin_password_no_gateway_url(client):
    """beta.12：网关地址留空（无论 Controller 是否配置）→ 明确报错。"""
    tc, state = client
    state["data"]["controller_urls"] = []
    r = tc.post(
        "/config/verify-admin",
        json={"admin_username": "admin", "admin_password": "pw"},
    )
    body = r.json()
    assert body["ok"] is False
    assert "Higress 地址未配置" in body["error"]


# ── 路径 B：Controller 管理员 token ──────────────────────
def test_verify_admin_token_success(client):
    tc, state = client
    # beta.12：探测 URL 无尾斜杠（Gin 对 /api/v1/teams/ 返 404）
    _FakeClient.get_spec["/api/v1/teams"] = _FakeResponse(200)
    r = tc.post(
        "/config/verify-admin", json={"controller_token": "tok123"}
    )
    body = r.json()
    assert body["ok"] is True
    assert body["mode"] == "token"
    assert state["data"]["controller_token"] == "tok123"
    c = _last_client()
    assert ("GET", "http://10.0.0.1:8090/api/v1/teams") in c.calls
    assert not any(u.endswith("teams/") for _m, u in c.calls)


def test_verify_admin_token_invalid(client):
    tc, state = client
    _FakeClient.get_spec["/api/v1/teams"] = _FakeResponse(401)
    r = tc.post(
        "/config/verify-admin", json={"controller_token": "bad"}
    )
    body = r.json()
    assert body["ok"] is False
    assert "无效" in body["error"]
    assert state["data"]["controller_token"] == ""


# ── 凭据全空 ───────────────────────────────────────────
def test_verify_admin_no_credentials(client):
    tc, _ = client
    r = tc.post("/config/verify-admin", json={})
    body = r.json()
    assert body["ok"] is False
    assert "二选一" in body["error"]


# ── 网关面透传（模型选择 alias 层数据源）────────────────────
def test_gateway_ai_routes_without_session(client):
    tc, state = client
    assert state["data"]["console_session"] == ""
    r = tc.get("/gateway/ai-routes")
    body = r.json()
    assert body["available"] is False
    assert body["reason"] == "no_console_session"
    # 无会话不应发起任何 HTTP 调用（client 都未构造）
    assert _FakeClient.instances == []


def test_gateway_ai_routes_with_session(client):
    tc, state = client
    state["data"]["console_session"] = "higress-session=abc123"
    state["data"]["gateway_admin_url"] = "http://10.0.0.1:8001"
    _FakeClient.get_spec["/v1/ai/routes"] = _FakeResponse(
        200,
        headers={"cookie-sent": "1"},
        json_body={"routes": [{"name": "route-a"}]},
    )
    r = tc.get("/gateway/ai-routes")
    body = r.json()
    assert body["available"] is True
    assert body["data"] == {"routes": [{"name": "route-a"}]}
    c = _last_client()
    assert ("GET", "http://10.0.0.1:8001/v1/ai/routes") in c.calls


def test_gateway_ai_providers_http_error(client):
    """上游 4xx/5xx → available=false + reason=http_<code>（优雅降级）。"""
    tc, state = client
    state["data"]["console_session"] = "s=1"
    state["data"]["gateway_admin_url"] = "http://10.0.0.1:8001"
    _FakeClient.get_spec["/v1/ai/providers"] = _FakeResponse(503)
    r = tc.get("/gateway/ai-providers")
    body = r.json()
    assert body["available"] is False
    assert body["reason"] == "http_503"


# ── 脱敏（纯函数，无网络）────────────────────────────────
def test_redact_masks_admin_credentials():
    out = cfgmod.redact(
        {
            "admin_username": "admin",
            "admin_password": "secret-pw",
            "gateway_admin_url": "http://10.0.0.1:8001",
            "console_session": "higress-session=abc123",
            "controller_token": "tok",
        }
    )
    assert out["admin_password"] == "***"
    assert out["console_session"] == "***"
    assert out["controller_token"] == "***"
    # 用户名非机密——保留（前端回显）
    assert out["admin_username"] == "admin"
    # 网关地址非机密——保留
    assert out["gateway_admin_url"] == "http://10.0.0.1:8001"


# ── v0.5.0-beta.12: env 注入（AGENTTEAMS_CONTROLLER_TOKEN）──────────────────
def test_verify_admin_token_env_fallback(client, monkeypatch):
    """cfg token 空 + env 已设 → 自动用 env（不落盘，tokenSource=env）。"""
    tc, state = client
    monkeypatch.setenv("AGENTTEAMS_CONTROLLER_TOKEN", "envtok")
    _FakeClient.get_spec["/api/v1/teams"] = _FakeResponse(200)
    r = tc.post("/config/verify-admin", json={})
    body = r.json()
    assert body["ok"] is True
    assert body["mode"] == "token"
    assert body["tokenSource"] == "env"
    assert state["data"]["controller_token"] == ""  # env 不落盘
    assert _last_client().last_get_headers.get("Authorization") == "Bearer envtok"


def test_verify_admin_token_config_beats_env(client, monkeypatch):
    """cfg 有值 + env 已设 → cfg 优先（粘贴可覆盖 env，轮换语义）。"""
    tc, state = client
    state["data"]["controller_token"] = "cfgtok"
    monkeypatch.setenv("AGENTTEAMS_CONTROLLER_TOKEN", "envtok")
    _FakeClient.get_spec["/api/v1/teams"] = _FakeResponse(200)
    r = tc.post("/config/verify-admin", json={})
    body = r.json()
    assert body["ok"] is True
    assert body["tokenSource"] == "config"
    assert _last_client().last_get_headers.get("Authorization") == "Bearer cfgtok"


def test_config_get_exposes_controller_token_source(client, monkeypatch):
    """GET /config 只暴露来源标记，token 值永不离开连接器进程。"""
    tc, _ = client
    r = tc.get("/config")
    assert r.json().get("controllerTokenSource") == ""
    monkeypatch.setenv("AGENTTEAMS_CONTROLLER_TOKEN", "envtok")
    r = tc.get("/config")
    body = r.json()
    assert body["controllerTokenSource"] == "env"
    assert body["controller_token"] == ""


def test_verify_admin_token_non_ascii_rejected(client):
    """token 含非 ASCII（复制混入）→ 明确报错，不裸抛 UnicodeEncodeError。"""
    tc, state = client
    r = tc.post(
        "/config/verify-admin", json={"controller_token": "tok\u4e2d123"}
    )
    body = r.json()
    assert body["ok"] is False
    assert "非 ASCII" in body["error"]
    assert state["data"]["controller_token"] == ""


def test_verify_admin_password_no_blind_probe(client):
    """beta.12：网关地址留空时**不得发起任何探测请求**（端口人人不同，
    8001/6868 盲探已移除）——直接报可操作错误。"""
    tc, _ = client

    async def _forbid_post(self, url, json=None, **k):
        raise AssertionError(f"盲探请求不应存在: {url}")

    # 用会抛错的 post 兜底：任何探测调用都会让测试失败
    import agentteams_connector.router as rt
    _orig_post = _FakeClient.post
    _FakeClient.post = _forbid_post
    try:
        r = tc.post(
            "/config/verify-admin",
            json={"admin_username": "admin", "admin_password": "pw"},
        )
    finally:
        _FakeClient.post = _orig_post
    body = r.json()
    assert body["ok"] is False
    assert "Higress 地址未配置" in body["error"]
