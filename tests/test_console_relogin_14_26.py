# -*- coding: utf-8 -*-
"""v0.5.0-beta.14.26（F2）: Console 会话自动重登（透明重试）回归。

实盘反馈 10/8「每次搞完，basic 登录状态也没了」——真根因：Console
管理会话 cookie 有服务端 TTL，过期后旧版**只被动判死
（_console_session_expired=True）、无任何自动重登**，用户每次插件
重载/会话过期必须手动重验证。凭据（admin_username/admin_password）
本来就持久化在 config.json（600 权限），但从未用于自动恢复。

修：gateway 透传 401 → console_try_relogin（config 持久账密走 Console
/session/login，与 /config/verify 路径 A 同端点同语义）→ 成功落盘新
会话 + 透明重放本次请求（调用方无感）；失败维持 14.19 判死语义。
防风暴三闸：60s 冷却窗 / asyncio.Lock 并发合并 / 400/401/403 凭据错
即停（地址无关不逐地址空转）。

覆盖（5 例）：
- test_relogin_transparent_retry: 401 → 重登 201 → 重试 200 →
  available:true + update_config 落盘新 session + expired 旗清零。
- test_relogin_auth_rejected: 重登 401（凭据错）→ 不重试原请求、
  维持判死、available:false http_401。
- test_relogin_no_credentials: 无 admin 凭据 → 零 /session/login 调用、
  判死维持（行为不回退 14.19）。
- test_relogin_cooldown_suppresses_second: 第一次重登后冷却窗内第二次
  401 → 不再尝试登录（/session/login 仅 1 次）。
- test_relogin_concurrent_single_attempt: 同刻 2 个 401 请求 → 登录只
  发生 1 次（锁合并），两请求都拿到新会话。

隔离：同 test_gateway_dual_14_7 模式——monkeypatch config load/update
（纯 dict，不碰真实 secret 目录）+ GatedAsyncClient 替身（spec 首中）
+ router 模块全局（_console_last_relogin_attempt / _working_cache /
_console_session_expired）每例重置。
"""
from __future__ import annotations

import asyncio
import json

import pytest

from conftest import patch_shared_name

from agentteams_connector import config as config_mod
from agentteams_connector import router as router_mod

LAN_GW = "http://10.0.0.1:18001"


class _Resp:
    def __init__(
        self,
        status_code: int,
        content: bytes = b"",
        json_body: object = None,
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


RAISE = object()


class _GWC:
    """GatedAsyncClient 替身：spec = [(url 子串, _Resp | RAISE | list)] 插入序首中。

    list 段=按**调用次序**消费（counts 由 fixture 共享——每次真实请求都新建
    客户端，次序计数必须跨实例，透明重试「先 401 后 200」才成立）。
    records = [(method, url)]。
    """

    def __init__(self, spec: list, counts: dict) -> None:
        self.spec = spec
        self.records: list[tuple[str, str]] = []
        self._counts = counts  # fixture 级共享（跨客户端实例）

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a, **k):
        return False

    async def _do(self, method: str, url: str, **k) -> _Resp:
        self.records.append((method, url))
        for key, resp in self.spec:
            if key in url:
                if isinstance(resp, list):
                    i = min(self._counts.get(key, 0), len(resp) - 1)
                    self._counts[key] = self._counts.get(key, 0) + 1
                    resp = resp[i]
                if resp is RAISE:
                    raise ConnectionError(f"unreachable: {url}")
                return resp
        return _Resp(404)

    async def get(self, url, **k) -> _Resp:
        return await self._do("GET", url, **k)

    async def post(self, url, **k) -> _Resp:
        return await self._do("POST", url, **k)

    async def put(self, url, **k) -> _Resp:
        return await self._do("PUT", url, **k)

    async def delete(self, url, **k) -> _Resp:
        return await self._do("DELETE", url, **k)


@pytest.fixture()
def relogin_env(monkeypatch):
    """假配置（单地址 + 死会话 + 持久账密）+ 假客户端 + 全局重置。"""
    state = {
        "gateway_admin_urls": [LAN_GW],
        "console_session": "sess=dead",
        "admin_username": "admin",
        "admin_password": "pw123",
    }

    def fake_load():
        return json.loads(json.dumps(state))

    update_calls: list[dict] = []

    def fake_update(patch, source=""):
        # v0.5.0-beta.14.27：update_config 新增 source 参（写盘审计）——
        # fake 同步签名（relogin 以位置参传入）。
        update_calls.append(json.loads(json.dumps(patch)))
        return json.loads(json.dumps(state))

    monkeypatch.setattr(config_mod, "load_config", fake_load)
    monkeypatch.setattr(config_mod, "update_config", fake_update)
    # 每例重置冷却窗与判死旗（单调钟全局，跨例污染）。
    monkeypatch.setattr(router_mod, "_console_last_relogin_attempt", 0.0)
    monkeypatch.setattr(router_mod, "_console_session_expired", False)
    monkeypatch.setattr(router_mod, "_working_cache", {})
    clients: list[_GWC] = []
    spec: list = []
    counts: dict[str, int] = {}  # 次序消费计数（跨客户端实例共享）

    def factory(*a, **k):
        c = _GWC(spec, counts)
        clients.append(c)
        return c

    patch_shared_name(monkeypatch, "GatedAsyncClient", factory)
    return state, update_calls, clients, spec


def _app():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(router_mod.build_router())
    return TestClient(app)


def test_relogin_transparent_retry(relogin_env):
    """401（会话死）→ 重登 201 新会话 → 透明重试 200 → available:true。"""
    _state, update_calls, clients, spec = relogin_env
    spec.append(
        (
            "/v1/ai/routes",
            [
                _Resp(401, b'{"message": "unauthorized"}', {"message": "unauthorized"}),
                _Resp(200, b'{"items": []}', {"items": []}),
            ],
        )
    )
    spec.append(
        (
            "/session/login",
            _Resp(
                201,
                b"",
                None,
                {"set-cookie": "higress-console=fresh456; Path=/; HttpOnly"},
            ),
        )
    )
    with _app() as tc:
        r = tc.get("/gateway/ai-routes")
    assert r.status_code == 200
    body = r.json()
    # 透明重试成功——调用方看到的是正常数据（非 http_401 降级）。
    assert body["available"] is True
    assert body["data"] == {"items": []}
    # 新会话落盘（下次请求直接带新 cookie）。
    assert any(
        p.get("console_session") == "higress-console=fresh456"
        for p in update_calls
    )
    # 判死旗清零（重登成功 = 会话已自愈，前端横幅不该再亮）。
    assert router_mod._console_session_expired is False
    urls = [u for c in clients for (_m, u) in c.records]
    assert urls.count(f"{LAN_GW}/session/login") == 1
    assert urls.count(f"{LAN_GW}/v1/ai/routes") == 2  # 401 + 透明重试


def test_relogin_auth_rejected(relogin_env):
    """重登 401（凭据错）→ 地址无关立即停、不重试原请求、维持判死。"""
    _state, _update_calls, clients, spec = relogin_env
    spec.append(
        ("/v1/ai/routes", [
            _Resp(401, b"{}", None),
            _Resp(401, b"{}", None),  # 若误重试也会命中 401（断言它没发生）
        ])
    )
    spec.append(("/session/login", _Resp(401, b'{"message": "bad credentials"}', None)))
    with _app() as tc:
        r = tc.get("/gateway/ai-routes")
    assert r.status_code == 200
    body = r.json()
    assert body["available"] is False
    assert body["reason"] == "http_401"
    assert router_mod._console_session_expired is True  # 维持 14.19 判死
    urls = [u for c in clients for (_m, u) in c.records]
    # 原请求只发 1 次（凭据错不透明重试——新会话没到手）。
    assert urls.count(f"{LAN_GW}/v1/ai/routes") == 1
    assert urls.count(f"{LAN_GW}/session/login") == 1


def test_relogin_no_credentials(relogin_env):
    """config 无 admin 凭据 → 零 /session/login 调用、判死维持（=14.19 行为）。"""
    state, _update_calls, clients, spec = relogin_env
    state["admin_username"] = ""
    state["admin_password"] = ""
    spec.append(("/v1/ai/routes", _Resp(401, b"{}", None)))
    with _app() as tc:
        r = tc.get("/gateway/ai-routes")
    assert r.json()["available"] is False
    assert router_mod._console_session_expired is True
    urls = [u for c in clients for (_m, u) in c.records]
    assert not any("/session/login" in u for u in urls)


def test_relogin_cooldown_suppresses_second(relogin_env):
    """第一次重登成功后冷却窗内（60s）第二次 401 → 不再尝试登录。"""
    _state, _update_calls, clients, spec = relogin_env
    # 第一次：401 → 重登成功 → 200。
    spec.append(
        ("/v1/ai/routes", [
            _Resp(401, b"{}", None),
            _Resp(200, b'{"items": []}', {"items": []}),
            # 第二次请求（冷却窗内）直接 401 且不再有新会话。
            _Resp(401, b'{"message": "unauthorized"}', {"message": "unauthorized"}),
        ])
    )
    spec.append(
        ("/session/login", [
            _Resp(201, b"", None, {"set-cookie": "higress-console=fresh456"}),
            _Resp(201, b"", None, {"set-cookie": "higress-console=fresh456"}),
        ])
    )
    with _app() as tc:
        r1 = tc.get("/gateway/ai-routes")
        assert r1.json()["available"] is True
        # 第二次：模拟新会话又死（直接 401）——冷却窗内不重登。
        r2 = tc.get("/gateway/ai-routes")
        assert r2.json()["available"] is False
        assert r2.json()["reason"] == "http_401"
    urls = [u for c in clients for (_m, u) in c.records]
    # /session/login 仅第一次 1 次（第二次被冷却窗抑制）。
    assert urls.count(f"{LAN_GW}/session/login") == 1


def test_relogin_concurrent_single_attempt(relogin_env):
    """同刻 2 个重登请求 → asyncio.Lock + 冷却窗双闸合并：登录只发 1 次；
 胜者拿到新会话，另一方拿到 None（按既有判死语义降级，不重复登录）。"""
    state, _update_calls, clients, spec = relogin_env
    spec.append(
        (
            "/session/login",
            _Resp(201, b"", None, {"set-cookie": "higress-console=fresh456"}),
        )
    )

    async def hit() -> object:
        cfg = json.loads(json.dumps(state))
        return await router_mod.console_try_relogin(cfg)

    async def main() -> list:
        return list(await asyncio.gather(hit(), hit()))

    results = asyncio.run(main())
    assert sorted(results, key=lambda x: str(x)) == [
        None,
        "higress-console=fresh456",
    ]
    urls = [u for c in clients for (_m, u) in c.records]
    assert urls.count(f"{LAN_GW}/session/login") == 1  # 只登录 1 次
