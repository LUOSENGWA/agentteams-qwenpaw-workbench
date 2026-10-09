# -*- coding: utf-8 -*-
"""v0.5.0-beta.14.7: Higress 内外网双地址（canonical 列表 gateway_admin_urls）回归。

覆盖（5 例）：
- test_gateway_migration: legacy 单值 → load_config() 提升为列表 + legacy 键镜像一致。
- test_gateway_update_merge: update_config 双地址（含 Basic 凭据）回读顺序/凭据
 保留（空密码 = 继承旧值，与 controller_urls 同语义）。
- test_gateway_list_order: _address_list(cfg, "gateway") 顺序 == 配置序
 （dict 条目取 url；legacy 单值回退）。
- test_verify_admin_dual_failover: 地址1 连接异常 → 地址2 /session/login 201
 → ok:true；update_config 收到 gateway_admin_urls 两项（拦截断言）。
- test_gateway_passthrough_failover: 地址1 抛异常 → 地址2 200 →
 available:true；两个地址都被尝试（顺序断言）。

隔离：monkeypatch config 模块 _CONFIG_PATH（tmp_path，同
test_config_persistence_14_7 风格）+ router GatedAsyncClient（FakeClient，
同 test_proxy_4xx_failover 风格）+ cfgmod.update_config（捕获），不碰真实
secret 目录 / 真实网络。
"""
from __future__ import annotations

import json

import pytest

from conftest import patch_shared_name

from agentteams_connector import config as config_mod
from agentteams_connector import router as router_mod

LAN_GW = "http://10.0.0.1:18001"
WAN_GW = "http://wan.example:18001"


# ── config 层（tmp_path 隔离）────────────────────────────────────────────


@pytest.fixture()
def tmp_config(monkeypatch, tmp_path):
    """配置文件/目录隔离到 tmp_path（真实 secret 目录零接触）。"""
    cfg_dir = tmp_path / "agentteams-qwenpaw-workbench"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(config_mod, "_SECRET_DIR", tmp_path)
    monkeypatch.setattr(config_mod, "_CONFIG_DIR", cfg_dir)
    monkeypatch.setattr(config_mod, "_CONFIG_PATH", cfg_dir / "config.json")
    yield cfg_dir / "config.json"


def test_gateway_migration(tmp_config):
    """legacy 单值配置 → load_config() 提升为 canonical 列表，legacy 键镜像一致。"""
    tmp_config.write_text(
        json.dumps({"gateway_admin_url": "http://legacy:18001"}),
        encoding="utf-8",
    )
    cfg = config_mod.load_config()
    assert cfg["gateway_admin_urls"] == ["http://legacy:18001"]
    assert cfg["gateway_admin_url"] == "http://legacy:18001"


def test_gateway_update_merge(tmp_config):
    """update_config 双地址（含 Basic 凭据）：回读顺序/凭据保留；空密码=继承旧值。"""
    config_mod.update_config(
        {
            "gateway_admin_urls": [
                "http://lan:18001",
                {
                    "url": "https://wan.example:18001",
                    "auth": {
                        "type": "basic",
                        "username": "testuser",
                        "password": "secret123",
                    },
                },
            ]
        }
    )
    cfg = config_mod.load_config()
    urls = cfg["gateway_admin_urls"]
    assert urls[0] == "http://lan:18001"
    assert urls[1]["url"] == "https://wan.example:18001"
    assert urls[1]["auth"]["password"] == "secret123"
    # 加载时 legacy 键镜像 urls[0]（老读者兼容）。
    assert cfg["gateway_admin_url"] == "http://lan:18001"

    # 同结构再次提交、password 空串 → 继承保留旧值（同 controller_urls 语义）。
    config_mod.update_config(
        {
            "gateway_admin_urls": [
                "http://lan:18001",
                {
                    "url": "https://wan.example:18001",
                    "auth": {
                        "type": "basic",
                        "username": "testuser",
                        "password": "",
                    },
                },
            ]
        }
    )
    urls = config_mod.load_config()["gateway_admin_urls"]
    assert urls[1]["auth"]["password"] == "secret123"


def test_gateway_list_order():
    """_address_list(cfg, "gateway") 顺序 == 配置序（dict 条目取 url；legacy 回退）。"""
    cfg = {
        "gateway_admin_urls": [
            "http://lan:18001",
            {
                "url": "https://wan.example:18001",
                "auth": {"type": "basic", "username": "u", "password": "p"},
            },
        ]
    }
    assert router_mod._address_list(cfg, "gateway") == [
        "http://lan:18001",
        "https://wan.example:18001",
    ]
    # 列表空 → 回退 legacy 单值。
    legacy = {"gateway_admin_url": "http://only:18001", "gateway_admin_urls": []}
    assert router_mod._address_list(legacy, "gateway") == ["http://only:18001"]
    # 两者皆空 → 空列表。
    assert router_mod._address_list({}, "gateway") == []


# ── router 层（FakeClient）──────────────────────────────────────────────


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


RAISE = object()  # spec 值哨兵：模拟连接层失败（地址不可达）


class _GWC:
    """GatedAsyncClient 替身：spec = [(url 子串, _Resp | RAISE)]，插入序首中。

 records = [(method, url)] 供断言调用顺序/地址。
 """

    def __init__(self, spec: list) -> None:
        self.spec = spec
        self.records: list[tuple[str, str]] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a, **k):
        return False

    async def _do(self, method: str, url: str, **k) -> _Resp:
        self.records.append((method, url))
        for key, resp in self.spec:
            if key in url:
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
def gw_router(monkeypatch):
    """假配置（双地址 + Console 会话）+ FakeClient 工厂 + update_config 捕获。"""
    state = {
        "gateway_admin_urls": [LAN_GW, WAN_GW],
        "console_session": "sess=xyz",
        "admin_username": "admin",
        "admin_password": "oldpw",
    }

    def fake_load():
        return json.loads(json.dumps(state))

    update_calls: list[dict] = []

    def fake_update(patch, source=""):
        update_calls.append(json.loads(json.dumps(patch)))
        return json.loads(json.dumps(state))

    monkeypatch.setattr(config_mod, "load_config", fake_load)
    monkeypatch.setattr(config_mod, "update_config", fake_update)
    clients: list[_GWC] = []
    spec: list = []  # [(url 子串, _Resp | RAISE)]，测试填充

    def factory(*a, **k):
        c = _GWC(spec)
        clients.append(c)
        return c

    patch_shared_name(monkeypatch, "GatedAsyncClient", factory)
    monkeypatch.setattr(router_mod, "_working_cache", {})
    return state, update_calls, clients, spec


def _app():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(router_mod.build_router())
    return TestClient(app)


def test_verify_admin_dual_failover(gw_router):
    """地址1 连接异常 → 地址2 /session/login 201 → ok:true；
 update_config 收到 gateway_admin_urls 两项（拦截断言）。"""
    _state, update_calls, clients, spec = gw_router
    spec.append((LAN_GW, RAISE))
    spec.append(
        (
            f"{WAN_GW}/session/login",
            _Resp(
                201,
                b"",
                None,
                {"set-cookie": "higress-console=abc123; Path=/; HttpOnly"},
            ),
        )
    )
    with _app() as tc:
        r = tc.post(
            "/config/verify-admin",
            json={"admin_username": "admin", "admin_password": "pw123"},
        )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["mode"] == "password"
    assert body["console"] == WAN_GW
    assert body["has_console_session"] is True
    # update_config 收到完整两地址列表（原序），非仅成功单值。
    assert len(update_calls) == 1
    patch = update_calls[0]
    assert patch["gateway_admin_urls"] == [LAN_GW, WAN_GW]
    assert patch["gateway_admin_url"] == WAN_GW
    assert patch["console_session"] == "higress-console=abc123"
    # 两地址都被尝试（地址1 连接层失败 → 降级地址2）。
    urls = [
        u for c in clients for (_m, u) in c.records if u.endswith("/session/login")
    ]
    assert urls == [f"{LAN_GW}/session/login", f"{WAN_GW}/session/login"]


def test_gateway_passthrough_failover(gw_router):
    """地址1 抛异常 → 地址2 200 → 透传 available:true；两个地址都被尝试。"""
    _state, _update_calls, clients, spec = gw_router
    spec.append((LAN_GW, RAISE))
    spec.append(
        (f"{WAN_GW}/v1/ai/routes", _Resp(200, b'{"items": []}', {"items": []}))
    )
    with _app() as tc:
        r = tc.get("/gateway/ai-routes")
    assert r.status_code == 200
    body = r.json()
    assert body["available"] is True
    assert body["data"] == {"items": []}
    urls = [u for c in clients for (_m, u) in c.records]
    assert f"{LAN_GW}/v1/ai/routes" in urls
    assert f"{WAN_GW}/v1/ai/routes" in urls
    # 先内网后外网（配置序）。
    assert urls.index(f"{WAN_GW}/v1/ai/routes") > urls.index(
        f"{LAN_GW}/v1/ai/routes"
    )


# ── ：固定档覆盖 gateway ─────────────────────────────────────
def test_gateway_pinned_by_address_mode() -> None:
    from agentteams_connector import router as router_mod

    base = {
        "gateway_admin_urls": ["http://lan.higress:6868", "https://wan.example.com"],
        "matrix_homeservers": [],
        "controller_urls": [],
        "sglang": {"enabled": False, "urls": []},
    }
    assert router_mod._pinned_url({**base, "address_mode": "lan"}, "gateway") == "http://lan.higress:6868"
    assert router_mod._pinned_url({**base, "address_mode": "wan"}, "gateway") == "https://wan.example.com"
    assert router_mod._pinned_url({**base, "address_mode": "auto"}, "gateway") is None
    # 单址时 lan/wan 均回退首址（与 _pinned_url 既有语义一致）。
    one = {**base, "gateway_admin_urls": ["http://only:6868"]}
    assert router_mod._pinned_url({**one, "address_mode": "wan"}, "gateway") == "http://only:6868"
