# -*- coding: utf-8 -*-
"""Controller 双认证（#1573+ Matrix L1 / 旧版 1.2.6 管理员 token）回归。

覆盖：
- 能力探测：matrix_l1 / matrix_scoped / legacy / matrix_invalid /
  unreachable / none + admin/tokenRequired/credentialSource 派生；
- 显式 token 实测（GET /api/v1/teams）：有效/401/不可达 → admin 与
  tokenRequired 翻转；Matrix L1 仍优先；地址覆盖凭据（Basic/Bearer）
  同时作用于 /me 与 /teams；
- 凭据选择：matrix_l1 用 Matrix token，否则显式 token 优先、Matrix 兜底；
- 30s 缓存：TTL 内第二次探测零请求；显式 token 轮换不复用旧结果；
- 网关双路径：现代 Controller 网关管理 API（Bearer）vs 旧 Console 会话；
  403 不静默回落 Console；
- /controller-auth 端点契约。

全程 FakeClient，无真实网络；config.load_config 被替换，零真实配置写。
"""
from __future__ import annotations

import asyncio
import base64
import json

from agentteams_connector import config as config_mod
from agentteams_connector import controller_auth
from agentteams_connector import router as router_mod
from conftest import patch_shared_name

CTL = "http://ctl.local:8666"
GW = "http://higress.local:18001"
MATRIX_TOKEN = "matrix-token-abc"
CTL_TOKEN = "ctl-admin-token-xyz"
# 内容非法（非 ASCII）→ _sanitize_token 抛 TokenValidationError，不能进 header。
BAD_TOKEN = "ctl-admin-token-中文"

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
    assert out["controllerTokenValid"] is False
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
    """(1) 旧 Controller + 显式 token 实测有效 → admin，不要求重贴。"""
    _install_probe_client(
        monkeypatch,
        [
            (f"{CTL}/api/v1/me", LEGACY),
            (f"{CTL}/api/v1/teams", _Resp(200, {"teams": []})),
        ],
    )
    cfg = _cfg(token=CTL_TOKEN)
    out = _probe(cfg)
    assert out["state"] == "legacy"
    assert out["admin"] is True
    assert out["controllerTokenValid"] is True
    assert out["tokenRequired"] is False
    assert out["credentialSource"] == "config"
    # token 值绝不进响应。
    assert CTL_TOKEN not in json.dumps(out)
    assert controller_auth.preferred_controller_token(cfg) == (CTL_TOKEN, "config")


def test_legacy_with_stale_token(monkeypatch) -> None:
    """(2) 旧 Controller + 显式 token 被 401 拒绝 → 必须重新弹 token 框。"""
    _install_probe_client(
        monkeypatch,
        [
            (f"{CTL}/api/v1/me", LEGACY),
            (f"{CTL}/api/v1/teams", _Resp(401, {"message": "unauthorized"})),
        ],
    )
    out = _probe(_cfg(token=CTL_TOKEN))
    assert out["state"] == "legacy"
    assert out["admin"] is False
    assert out["controllerTokenValid"] is False
    assert out["tokenRequired"] is True


def test_invalid_identity_without_token(monkeypatch) -> None:
    _install_probe_client(monkeypatch, [(f"{CTL}/api/v1/me", _Resp(401, {}))])
    out = _probe(_cfg())
    assert out["state"] == "matrix_invalid"
    assert out["admin"] is False
    assert out["tokenRequired"] is True


def test_invalid_identity_with_token(monkeypatch) -> None:
    _install_probe_client(
        monkeypatch,
        [
            (f"{CTL}/api/v1/me", _Resp(403, {})),
            (f"{CTL}/api/v1/teams", _Resp(200, {"teams": []})),
        ],
    )
    out = _probe(_cfg(token=CTL_TOKEN))
    assert out["state"] == "matrix_invalid"
    assert out["admin"] is True
    assert out["controllerTokenValid"] is True
    assert out["tokenRequired"] is False
    assert out["credentialSource"] == "config"


def test_no_matrix_login_with_valid_token(monkeypatch) -> None:
    """(3) 无 Matrix 登录 + 有效显式 token → state=none 但 admin。"""
    _install_probe_client(
        monkeypatch, [(f"{CTL}/api/v1/teams", _Resp(200, {"teams": []}))]
    )
    out = _probe(_cfg(matrix=False, token=CTL_TOKEN))
    assert out["state"] == "none"
    assert out["admin"] is True
    assert out["controllerTokenValid"] is True
    assert out["tokenRequired"] is False
    assert out["credentialSource"] == "config"


def test_no_matrix_login_with_stale_token(monkeypatch) -> None:
    """无 Matrix 登录 + token 被拒 → 仍要重贴（不因未登录而放过）。"""
    _install_probe_client(
        monkeypatch, [(f"{CTL}/api/v1/teams", _Resp(403, {"message": "forbidden"}))]
    )
    out = _probe(_cfg(matrix=False, token=CTL_TOKEN))
    assert out["state"] == "none"
    assert out["admin"] is False
    assert out["controllerTokenValid"] is False
    assert out["tokenRequired"] is True
    assert out["credentialSource"] == "none"


def test_matrix_scoped_with_valid_token(monkeypatch) -> None:
    """(4) L2 只读 + 有效显式 token → token 提供 admin。"""
    _install_probe_client(
        monkeypatch,
        [
            (f"{CTL}/api/v1/me", _Resp(200, {"name": "bob", "permissionLevel": 2})),
            (f"{CTL}/api/v1/teams", _Resp(200, {"teams": []})),
        ],
    )
    out = _probe(_cfg(token=CTL_TOKEN))
    assert out["state"] == "matrix_scoped"
    assert out["admin"] is True
    assert out["controllerTokenValid"] is True
    assert out["tokenRequired"] is False
    assert out["credentialSource"] == "config"


def test_matrix_l1_wins_over_stale_token(monkeypatch) -> None:
    """(6) Matrix L1 时陈旧 token 不让 Matrix 丢管理员、也不弹框。"""
    _install_probe_client(
        monkeypatch,
        [
            (
                f"{CTL}/api/v1/me",
                _Resp(200, {"name": "alice", "permissionLevel": 1}),
            ),
            (f"{CTL}/api/v1/teams", _Resp(401, {"message": "unauthorized"})),
        ],
    )
    out = _probe(_cfg(token=CTL_TOKEN))
    assert out["state"] == "matrix_l1"
    assert out["admin"] is True
    assert out["controllerTokenValid"] is False
    assert out["tokenRequired"] is False
    assert out["credentialSource"] == "matrix"


def test_invalid_configured_token_without_matrix(monkeypatch) -> None:
    """非法配置 token：仍报「已配置」，但无效且要求重填（不发请求）。"""
    clients = _install_probe_client(monkeypatch, [])
    out = _probe(_cfg(matrix=False, token=BAD_TOKEN))
    assert out["controllerTokenConfigured"] is True
    assert out["controllerTokenValid"] is False
    assert out["admin"] is False
    assert out["tokenRequired"] is True
    assert out["detail"]
    assert BAD_TOKEN not in json.dumps(out)
    assert clients == []  # 内容非法 = 不进 HTTP 请求


def test_legacy_with_invalid_configured_token(monkeypatch) -> None:
    """旧 Controller（/me 404）+ 非法配置 token → 仍要求重填 token。"""
    _install_probe_client(monkeypatch, [(f"{CTL}/api/v1/me", LEGACY)])
    out = _probe(_cfg(token=BAD_TOKEN))
    assert out["state"] == "legacy"
    assert out["controllerTokenConfigured"] is True
    assert out["controllerTokenValid"] is False
    assert out["admin"] is False
    assert out["tokenRequired"] is True


def test_matrix_l1_with_invalid_configured_token(monkeypatch) -> None:
    """Matrix L1 + 非法配置 token → Matrix 即管理员，不弹 token 框。"""
    _install_probe_client(
        monkeypatch,
        [
            (
                f"{CTL}/api/v1/me",
                _Resp(200, {"name": "alice", "permissionLevel": 1}),
            )
        ],
    )
    out = _probe(_cfg(token=BAD_TOKEN))
    assert out["state"] == "matrix_l1"
    assert out["controllerTokenConfigured"] is True
    assert out["controllerTokenValid"] is False
    assert out["admin"] is True
    assert out["tokenRequired"] is False


def test_address_auth_applied_to_me_and_teams(monkeypatch) -> None:
    """(7) 地址覆盖凭据（Basic）替换原生 Authorization——探测/验证同口径。"""
    clients = _install_probe_client(
        monkeypatch,
        [
            (f"{CTL}/api/v1/me", LEGACY),
            (f"{CTL}/api/v1/teams", _Resp(200, {"teams": []})),
        ],
    )
    cfg = {
        "controller_urls": [
            {
                "url": CTL,
                "auth": {"type": "basic", "username": "u", "password": "p"},
            }
        ],
        "matrix": {"access_token": MATRIX_TOKEN},
        "controller_token": CTL_TOKEN,
    }
    out = _probe(cfg)
    assert out["state"] == "legacy"
    assert out["controllerTokenValid"] is True
    expected = "Basic " + base64.b64encode(b"u:p").decode("ascii")
    calls = [rec for c in clients for rec in c.records]
    me_headers = [h for _m, u, h in calls if u.endswith("/api/v1/me")]
    teams_headers = [h for _m, u, h in calls if u.endswith("/api/v1/teams")]
    assert me_headers and all(h["Authorization"] == expected for h in me_headers)
    assert teams_headers and all(h["Authorization"] == expected for h in teams_headers)


def test_address_bearer_override_replaces_native_auth(monkeypatch) -> None:
    """Bearer 覆盖凭据同样整体替换 Matrix / 显式 token 的 Authorization。"""
    clients = _install_probe_client(
        monkeypatch,
        [
            (f"{CTL}/api/v1/me", _Resp(200, {"permissionLevel": 2})),
        ],
    )
    cfg = {
        "controller_urls": [
            {"url": CTL, "auth": {"type": "bearer", "token": "addr-bearer"}}
        ],
        "matrix": {"access_token": MATRIX_TOKEN},
    }
    _probe(cfg)
    calls = [rec for c in clients for rec in c.records]
    assert calls
    assert all(h.get("Authorization") == "Bearer addr-bearer" for _m, _u, h in calls)


def test_cache_key_changes_with_explicit_token(monkeypatch) -> None:
    """(8) 显式 token 轮换不复用旧的验证结果。"""
    cfg_a = _cfg(token="token-a")
    cfg_b = _cfg(token="token-b")
    assert controller_auth._cache_key(cfg_a) != controller_auth._cache_key(cfg_b)

    clients = _install_probe_client(
        monkeypatch,
        [
            (f"{CTL}/api/v1/me", LEGACY),
            (f"{CTL}/api/v1/teams", _Resp(200, {"teams": []})),
        ],
    )
    first = _probe(cfg_a)
    assert first["admin"] is True and first["controllerTokenValid"] is True
    # 一次探测 = token 验证 + /me 各一次拨号。
    assert len(clients) == 2

    second_clients = _install_probe_client(
        monkeypatch,
        [
            (f"{CTL}/api/v1/me", LEGACY),
            (f"{CTL}/api/v1/teams", _Resp(401, {"message": "unauthorized"})),
        ],
    )
    second = _probe(cfg_b)
    # TTL 内换 token 必须重新实测（否则旧「有效」结果会被复用）。
    assert len(second_clients) == 2
    assert second["controllerTokenValid"] is False
    assert second["admin"] is False
    assert second["tokenRequired"] is True


def test_matrix_scoped_without_token_no_prompt(monkeypatch) -> None:
    """(5) L2/L3 只读 + 无 token → 不弹 token 框。"""
    _install_probe_client(
        monkeypatch,
        [(f"{CTL}/api/v1/me", _Resp(200, {"permissionLevel": 3}))],
    )
    out = _probe(_cfg())
    assert out["state"] == "matrix_scoped"
    assert out["admin"] is False
    assert out["tokenRequired"] is False


def test_unreachable_does_not_prompt(monkeypatch) -> None:
    _install_probe_client(monkeypatch, [(f"{CTL}/api/v1/me", RAISE)])
    out = _probe(_cfg())
    assert out["state"] == "unreachable"
    assert out["reachable"] is False
    assert out["admin"] is False
    assert out["tokenRequired"] is False


def test_unreachable_with_configured_token_does_not_prompt(monkeypatch) -> None:
    """网络错误不升级成 token 提示（即使已配置 token 无法验证）。"""
    _install_probe_client(
        monkeypatch,
        [
            (f"{CTL}/api/v1/me", RAISE),
            (f"{CTL}/api/v1/teams", RAISE),
        ],
    )
    out = _probe(_cfg(token=CTL_TOKEN))
    assert out["state"] == "unreachable"
    assert out["admin"] is False
    assert out["controllerTokenValid"] is False
    assert out["tokenRequired"] is False


def test_no_matrix_login_unreachable_token_unverified(monkeypatch) -> None:
    """仅显式 token + Controller 不可达 → state=none、只透 detail，不弹框。"""
    _install_probe_client(monkeypatch, [(f"{CTL}/api/v1/teams", RAISE)])
    out = _probe(_cfg(matrix=False, token=CTL_TOKEN))
    assert out["state"] == "none"
    assert out["admin"] is False
    assert out["controllerTokenValid"] is False
    assert out["tokenRequired"] is False
    assert out["credentialSource"] == "none"
    assert "不可达" in (out.get("detail") or "")


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
        "controllerTokenValid": False,
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
        "controllerTokenValid",
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
