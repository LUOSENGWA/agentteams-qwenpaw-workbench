# -*- coding: utf-8 -*-
"""Controller 双认证（#1573+ Matrix L1 / 旧版 1.2.6 管理员 token）回归。

覆盖：
- 能力探测：matrix_l1 / matrix_scoped / legacy / matrix_invalid /
  unreachable / none + admin/tokenRequired/credentialSource 派生；
- 凭据选择：matrix_l1 用 Matrix token，否则显式 token 优先、Matrix 兜底；
- 30s 缓存：TTL 内第二次探测零请求；
- 网关双路径：现代 Controller 网关管理 API（Bearer）vs 旧 Console 会话；
  403 不静默回落 Console；
- /controller-auth 端点契约。

全程 FakeClient，无真实网络；config.load_config 被替换，零真实配置写。
"""
from __future__ import annotations

import asyncio
import json

from agentteams_connector import config as config_mod
from agentteams_connector import controller_auth
from agentteams_connector import router as router_mod
from conftest import patch_shared_name

CTL = "http://ctl.local:8666"
GW = "http://higress.local:18001"
MATRIX_TOKEN = "matrix-token-abc"
CTL_TOKEN = "ctl-admin-token-xyz"

RAISE = object()  # spec 哨兵：模拟连接层失败


class _Resp:
    def __init__(
        self,
        status_code: int,
        json_body: object = None,
        content: bytes = b"",
        headers: dict | None = None,
    ):
        self.status_code = status_code
        self.content = content
        self._json_body = json_body
        self.headers = headers or {"content-type": "application/json"}

    def json(self):
        if self._json_body is None:
            raise ValueError("no json body")
        return self._json_body

    @property
    def text(self) -> str:
        return self.content.decode("utf-8", "replace")


class _FakeClient:
    """GatedAsyncClient 替身：spec=[(url 子串, _Resp | RAISE)]，插入序首中。"""

    records: list = []

    def __init__(self, spec: list) -> None:
        self.spec = spec
        self.records = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a, **k):
        return False

    def _match(self, method: str, url: str, headers: dict | None) -> _Resp:
        self.records.append((method, url, headers or {}))
        _FakeClient.records.append((method, url, headers or {}))
        for key, resp in self.spec:
            if key in url:
                if resp is RAISE:
                    raise ConnectionError(f"unreachable: {url}")
                return resp
        return _Resp(404)

    async def get(self, url, **k) -> _Resp:
        return self._match("GET", url, k.get("headers"))

    async def post(self, url, **k) -> _Resp:
        return self._match("POST", url, k.get("headers"))

    async def put(self, url, **k) -> _Resp:
        return self._match("PUT", url, k.get("headers"))

    async def delete(self, url, **k) -> _Resp:
        return self._match("DELETE", url, k.get("headers"))


def _install_probe_client(monkeypatch, spec: list) -> list:
    """替换 controller_auth 的 GatedAsyncClient；返回创建的 client 列表。"""
    clients: list = []

    def factory(*a, **k):
        c = _FakeClient(spec)
        clients.append(c)
        return c

    monkeypatch.setattr(controller_auth, "GatedAsyncClient", factory)
    _FakeClient.records = []
    return clients


def _cfg(matrix: bool = True, token: str = "") -> dict:
    cfg = {"controller_urls": [CTL], "matrix": {"access_token": MATRIX_TOKEN if matrix else ""}}
    if token:
        cfg["controller_token"] = token
    return cfg


def _probe(cfg: dict) -> dict:
    return asyncio.run(controller_auth.probe_controller_auth(cfg))


LEGACY = _Resp(404, {"error": "not found"})


# ── 能力探测 ───────────────────────────────────────────────────────────


def test_matrix_l1(monkeypatch) -> None:
    _install_probe_client(
        monkeypatch,
        [
            (
                f"{CTL}/api/v1/me",
                _Resp(
                    200,
                    {
                        "name": "alice",
                        "permissionLevel": 1,
                        "accessibleTeams": ["t1", "t2"],
                        "accessibleWorkers": ["w1"],
                        "capabilities": ["admin"],
                    },
                ),
            )
        ],
    )
    out = _probe(_cfg())
    assert out["state"] == "matrix_l1"
    assert out["permissionLevel"] == 1
    assert out["name"] == "alice"
    assert out["accessibleTeams"] == ["t1", "t2"]
    assert out["accessibleWorkers"] == ["w1"]
    assert out["capabilities"] == ["admin"]
    assert out["admin"] is True
    assert out["tokenRequired"] is False
    assert out["credentialSource"] == "matrix"
    assert out["reachable"] is True
    # 能力判定后 → 拨号凭据用 Matrix token（source=matrix）。
    assert controller_auth.preferred_controller_token(_cfg()) == (
        MATRIX_TOKEN,
        "matrix",
    )


def test_matrix_scoped_l2(monkeypatch) -> None:
    _install_probe_client(
        monkeypatch,
        [(f"{CTL}/api/v1/me", _Resp(200, {"name": "bob", "permissionLevel": 2}))],
    )
    out = _probe(_cfg())
    assert out["state"] == "matrix_scoped"
    assert out["permissionLevel"] == 2
    assert out["admin"] is False
    assert out["tokenRequired"] is False
    assert out["credentialSource"] == "matrix"


def test_matrix_scoped_l3(monkeypatch) -> None:
    _install_probe_client(
        monkeypatch,
        [(f"{CTL}/api/v1/me", _Resp(200, {"name": "carol", "permissionLevel": 3}))],
    )
    out = _probe(_cfg())
    assert out["state"] == "matrix_scoped"
    assert out["permissionLevel"] == 3
    assert out["admin"] is False
    assert out["tokenRequired"] is False


def test_legacy_without_token(monkeypatch) -> None:
    _install_probe_client(monkeypatch, [(f"{CTL}/api/v1/me", LEGACY)])
    out = _probe(_cfg())
    assert out["state"] == "legacy"
    assert out["legacy"] is True
    assert out["admin"] is False
    assert out["tokenRequired"] is True
    assert out["credentialSource"] == "matrix"


def test_legacy_with_token(monkeypatch) -> None:
    _install_probe_client(monkeypatch, [(f"{CTL}/api/v1/me", LEGACY)])
    cfg = _cfg(token=CTL_TOKEN)
    out = _probe(cfg)
    assert out["state"] == "legacy"
    assert out["admin"] is True
    assert out["tokenRequired"] is False
    assert out["credentialSource"] == "config"
    assert controller_auth.preferred_controller_token(cfg) == (CTL_TOKEN, "config")


def test_invalid_identity_without_token(monkeypatch) -> None:
    _install_probe_client(monkeypatch, [(f"{CTL}/api/v1/me", _Resp(401, {}))])
    out = _probe(_cfg())
    assert out["state"] == "matrix_invalid"
    assert out["admin"] is False
    assert out["tokenRequired"] is True


def test_invalid_identity_with_token(monkeypatch) -> None:
    _install_probe_client(monkeypatch, [(f"{CTL}/api/v1/me", _Resp(403, {}))])
    out = _probe(_cfg(token=CTL_TOKEN))
    assert out["state"] == "matrix_invalid"
    assert out["admin"] is True
    assert out["tokenRequired"] is False
    assert out["credentialSource"] == "config"


def test_unreachable_does_not_prompt(monkeypatch) -> None:
    _install_probe_client(monkeypatch, [(f"{CTL}/api/v1/me", RAISE)])
    out = _probe(_cfg())
    assert out["state"] == "unreachable"
    assert out["reachable"] is False
    assert out["admin"] is False
    assert out["tokenRequired"] is False


def test_no_matrix_login_state_none(monkeypatch) -> None:
    clients = _install_probe_client(monkeypatch, [])
    out = _probe(_cfg(matrix=False))
    assert out["state"] == "none"
    assert out["credentialSource"] == "none"
    assert clients == []  # 未登录不发探测请求


def test_probe_cached_within_ttl(monkeypatch) -> None:
    clients = _install_probe_client(
        monkeypatch, [(f"{CTL}/api/v1/me", _Resp(200, {"permissionLevel": 1}))]
    )
    cfg = _cfg()
    first = _probe(cfg)
    second = _probe(cfg)
    assert first["state"] == second["state"] == "matrix_l1"
    assert len(clients) == 1  # TTL 内第二次探测不发请求


def test_cache_invalidated(monkeypatch) -> None:
    clients = _install_probe_client(
        monkeypatch, [(f"{CTL}/api/v1/me", _Resp(200, {"permissionLevel": 2}))]
    )
    cfg = _cfg()
    _probe(cfg)
    controller_auth.invalidate_controller_auth_cache()
    _probe(cfg)
    assert len(clients) == 2


def test_token_or_none_gates_matrix_fallback(monkeypatch) -> None:
    """管理面取 token：未探测/旧 Controller → None（保持旧语义）；
 能力确认 matrix_l1 → Matrix token。"""
    from agentteams_connector.router_models import _token_or_none

    cfg = _cfg()
    # 未探测：Matrix token 不被当作管理员凭据（旧 Controller 的降级路径）。
    assert _token_or_none(cfg) is None
    _install_probe_client(
        monkeypatch, [(f"{CTL}/api/v1/me", _Resp(200, {"permissionLevel": 1}))]
    )
    _probe(cfg)
    assert _token_or_none(cfg) == MATRIX_TOKEN


# ── /controller-auth 端点契约 ─────────────────────────────────────────


def _app():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(router_mod.build_router())
    return TestClient(app)


async def _fake_probe(cfg: dict) -> dict:
    return {
        "state": "legacy",
        "name": "",
        "permissionLevel": 0,
        "accessibleTeams": [],
        "accessibleWorkers": [],
        "capabilities": [],
        "credentialSource": "matrix",
        "controllerTokenConfigured": False,
        "tokenRequired": True,
        "admin": False,
        "legacy": True,
        "reachable": True,
    }


def test_controller_auth_endpoint(monkeypatch) -> None:
    monkeypatch.setattr(
        config_mod,
        "load_config",
        lambda: {"controller_urls": [CTL], "matrix": {"access_token": MATRIX_TOKEN}},
    )
    monkeypatch.setattr(controller_auth, "probe_controller_auth", _fake_probe)
    with _app() as tc:
        r = tc.get("/controller-auth")
    assert r.status_code == 200
    body = r.json()
    for key in (
        "state",
        "name",
        "permissionLevel",
        "accessibleTeams",
        "accessibleWorkers",
        "capabilities",
        "credentialSource",
        "controllerTokenConfigured",
        "tokenRequired",
        "admin",
        "legacy",
        "reachable",
    ):
        assert key in body
    assert body["state"] == "legacy"
    assert body["tokenRequired"] is True
    assert body["admin"] is False


# ── 网关双路径 ─────────────────────────────────────────────────────────


def _gw_cfg(**extra) -> dict:
    cfg = {
        "controller_urls": [CTL],
        "gateway_admin_urls": [GW],
        "console_session": "sess=abc",
        "matrix": {"access_token": MATRIX_TOKEN},
    }
    cfg.update(extra)
    return cfg


def _install_gateway(monkeypatch, cfg: dict, spec: list, auth: dict) -> list:
    """装配网关测试：假配置 + 假能力探测 + FakeClient。"""
    monkeypatch.setattr(
        config_mod, "load_config", lambda: json.loads(json.dumps(cfg))
    )
    monkeypatch.setattr(
        config_mod,
        "update_config",
        lambda patch, source="": cfg,
    )
    monkeypatch.setattr(
        controller_auth, "probe_controller_auth", lambda c: _async_return(auth)
    )
    monkeypatch.setattr(
        controller_auth,
        "preferred_controller_token",
        lambda c: (MATRIX_TOKEN, "matrix"),
    )
    clients: list = []

    def factory(*a, **k):
        c = _FakeClient(spec)
        clients.append(c)
        return c

    patch_shared_name(monkeypatch, "GatedAsyncClient", factory)
    monkeypatch.setattr(router_mod, "_working_cache", {})
    return clients


async def _async_return(value):
    return value


def test_gateway_modern_uses_controller_endpoint(monkeypatch) -> None:
    """matrix_l1 → Controller /api/v1/gateway/ai/routes + Bearer，契约包装。"""
    spec = [
        (
            f"{CTL}/api/v1/gateway/ai/routes",
            _Resp(200, {"routes": [{"name": "r1"}]}),
        )
    ]
    clients = _install_gateway(
        monkeypatch,
        _gw_cfg(),
        spec,
        {
            "state": "matrix_l1",
            "controllerTokenConfigured": False,
        },
    )
    with _app() as tc:
        r = tc.get("/gateway/ai-routes")
    assert r.status_code == 200
    body = r.json()
    assert body["available"] is True
    assert body["data"] == {"routes": [{"name": "r1"}]}
    assert body["reason"] is None
    calls = [rec for c in clients for rec in c.records]
    assert any("/api/v1/gateway/ai/routes" in u for _m, u, _h in calls)
    auth_headers = [
        h for m, u, h in calls if m == "GET" and "/api/v1/gateway/ai/routes" in u
    ]
    assert auth_headers[0]["Authorization"] == f"Bearer {MATRIX_TOKEN}"
    # 不得回落 Console。
    assert not any(f"{GW}/v1/ai/routes" in u for _m, u, _h in calls)


def test_gateway_legacy_uses_console_session(monkeypatch) -> None:
    spec = [(f"{GW}/v1/ai/routes", _Resp(200, {"items": []}))]
    clients = _install_gateway(
        monkeypatch,
        _gw_cfg(),
        spec,
        {
            "state": "legacy",
            "controllerTokenConfigured": False,
        },
    )
    with _app() as tc:
        r = tc.get("/gateway/ai-routes")
    assert r.status_code == 200
    body = r.json()
    assert body["available"] is True
    assert body["data"] == {"items": []}
    calls = [rec for c in clients for rec in c.records]
    assert any(f"{GW}/v1/ai/routes" in u for _m, u, _h in calls)
    console_headers = [
        h for m, u, h in calls if m == "GET" and f"{GW}/v1/ai/routes" in u
    ]
    assert console_headers[0]["Cookie"] == "sess=abc"
    # 不得拨 Controller 网关管理端点。
    assert not any("/api/v1/gateway/" in u for _m, u, _h in calls)


def test_gateway_403_does_not_fall_back(monkeypatch) -> None:
    """现代路径 403（L2）→ 明确 available=false，不伪装 Console 可用。"""
    spec = [
        (f"{CTL}/api/v1/gateway/ai/routes", _Resp(403, {"message": "forbidden"})),
        (f"{GW}/v1/ai/routes", _Resp(200, {"items": ["should-not-be-used"]})),
    ]
    clients = _install_gateway(
        monkeypatch,
        _gw_cfg(),
        spec,
        {
            "state": "matrix_scoped",
            "controllerTokenConfigured": False,
        },
    )
    with _app() as tc:
        r = tc.get("/gateway/ai-routes")
    assert r.status_code == 200
    body = r.json()
    assert body["available"] is False
    assert body["reason"] == "http_403"
    assert body["detail"] == "forbidden"
    calls = [rec for c in clients for rec in c.records]
    assert not any(f"{GW}/v1/ai/routes" in u for _m, u, _h in calls)


def test_gateway_404_falls_back_to_console(monkeypatch) -> None:
    spec = [
        (f"{CTL}/api/v1/gateway/ai/routes", _Resp(404, {})),
        (f"{GW}/v1/ai/routes", _Resp(200, {"items": ["legacy"]})),
    ]
    _install_gateway(
        monkeypatch,
        _gw_cfg(),
        spec,
        {
            "state": "unreachable",
            "controllerTokenConfigured": True,
        },
    )
    with _app() as tc:
        r = tc.get("/gateway/ai-routes")
    body = r.json()
    assert body["available"] is True
    assert body["data"] == {"items": ["legacy"]}
