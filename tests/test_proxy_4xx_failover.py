# -*- coding: utf-8 -*-
"""代理 4xx failover + 直拨族 failover 回归（v0.5.0-beta.14.2，F1）。

问题真根因（14.2 装验「切外网 controller 401、知识图谱 500、连不上」）：
1. catch-all 代理对**任何** HTTP 响应都 _mark_working（含 401）→ 一次 401
   污染 working cache → 切回内网死地址仍居首恒 401；
2. 代理 GET/HEAD 遇 4xx 立即原样返回，不试下一地址（外网入口=网关会话门、
   直连健康时永不 failover）；
3. 直拨族（_kb_docker / _ctl_json / _dial_workers）单地址直拨、4xx 立即
   返回 → 切网窗口恒 401 或卡满超时。

护栏（5 例）：
- proxy GET：地址1 401 → 地址2 200 → 最终 200，working 标地址2。
- proxy GET：全 401 → 首个 401 原样返回（body 保留），working 不标。
- proxy POST：地址1 401 → 立即 401，不试地址2（写请求不重放）。
- teams/structure：_dial_workers 地址1 401 → 地址2 200 → 采用地址2 数据。
- /kb/agents：Docker 通道全 401 → fallback → _ctl_json 地址1 401 →
  地址2 200 → KB 形状 {agents, count}（w1 + manager）。
"""
from __future__ import annotations

import json

import pytest

from agentteams_connector import config as cfgmod
from agentteams_connector import router as router_mod

LAN = "http://10.0.0.1:8090"
WAN = "http://wan.example:8090"


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


class _P4Client:
    """httpx.AsyncClient 替身：spec = [(url 子串, _Resp)]，按插入序首中。

    records = [(method, url)] 供断言调用顺序/地址。
    """

    def __init__(self, spec: list) -> None:
        self.spec = spec
        self.records: list[tuple[str, str]] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a, **k):
        return False

    async def request(self, method: str, url: str, **k) -> _Resp:
        self.records.append((method, url))
        for key, resp in self.spec:
            if key in url:
                return resp
        return _Resp(404)

    async def get(self, url, **k) -> _Resp:
        return await self.request("GET", url, **k)

    async def head(self, url, **k) -> _Resp:
        return await self.request("HEAD", url, **k)


_WORKERS = {
    "workers": [
        {
            "name": "w1",
            "team": "t",
            "role": "worker",
            "matrixUserID": "@w1:matrix.example",
            "roomID": "!r:matrix.example",
            "runtime": "qwenpaw",
            "phase": "Running",
        }
    ]
}


@pytest.fixture
def p4(monkeypatch):
    state = {
        "controller_urls": [LAN, WAN],
        "controller_token": "ctok",
        "matrix_homeservers": ["http://matrix.example"],
        "matrix": {"user_id": "@me:matrix.example", "access_token": "mtok"},
    }

    def fake_load():
        return json.loads(json.dumps(state))

    monkeypatch.setattr(cfgmod, "load_config", fake_load)
    clients: list[_P4Client] = []
    spec: list = []  # [(url 子串, _Resp)]，测试填充

    def factory(*a, **k):
        c = _P4Client(spec)
        clients.append(c)
        return c

    monkeypatch.setattr(
        "agentteams_connector.router.GatedAsyncClient", factory
    )
    monkeypatch.setattr(router_mod, "_working_cache", {})
    return clients, spec


def _app():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(router_mod.build_router())
    return TestClient(app)


def test_proxy_get_failover_on_401(p4):
    clients, spec = p4
    spec.append((LAN, _Resp(401, b'{"detail":"proxy session required"}')))
    spec.append((WAN, _Resp(200, b'{"ok":true}', {"ok": True})))
    with _app() as tc:
        r = tc.get("/controller/healthz")
    assert r.status_code == 200
    assert json.loads(r.content) == {"ok": True}
    urls = [u for c in clients for (_m, u) in c.records]
    assert any(LAN in u for u in urls)
    assert any(WAN in u for u in urls)
    assert router_mod._working_cache.get("controller") == WAN


def test_proxy_get_all_401_returns_first(p4):
    clients, spec = p4
    spec.append((LAN, _Resp(401, b'{"detail":"proxy session required"}')))
    spec.append((WAN, _Resp(401, b'{"detail":"unauthenticated"}')))
    with _app() as tc:
        r = tc.get("/controller/healthz")
    assert r.status_code == 401
    assert r.content == b'{"detail":"proxy session required"}'
    assert router_mod._working_cache.get("controller") is None


def test_proxy_post_no_failover_on_401(p4):
    clients, spec = p4
    spec.append((LAN, _Resp(401, b'{"detail":"denied"}')))
    spec.append((WAN, _Resp(200, b'{"ok":true}')))
    with _app() as tc:
        r = tc.post("/controller/api/v1/teams", json={"x": 1})
    assert r.status_code == 401
    post_urls = [
        u for c in clients for (m, u) in c.records if m == "POST"
    ]
    assert post_urls, "POST 未发出"
    assert all(WAN not in u for u in post_urls), "写请求不应试下一地址"


def test_teams_structure_dial_workers_failover_401(p4):
    clients, spec = p4
    spec.append((f"{LAN}/api/v1/workers", _Resp(401, b"{}", None)))
    spec.append((f"{WAN}/api/v1/workers", _Resp(200, b"", _WORKERS)))
    with _app() as tc:
        r = tc.get("/teams/structure?force=true")
    assert r.status_code == 200
    body = r.json()
    assert body.get("source") == "controller-workers"
    assert body["tree"][0]["team_name"] == "t"
    assert any("harmony" not in w["worker_name"] for w in body["tree"][0]["workers"])
    # 地址1 401 不应被标 working；地址2 成功应标 working。
    assert router_mod._working_cache.get("controller") == WAN


def test_kb_agents_docker_degraded_ctl_fallback(p4):
    clients, spec = p4
    # Docker 通道两地址全 401 → 触发 KB fallback；fallback 的 workers
    # 查询：地址1 401 → 地址2 200（_ctl_json failover）。
    spec.append(("containers/json", _Resp(401, b"{}", None)))
    spec.append((f"{LAN}/api/v1/workers", _Resp(401, b"{}", None)))
    spec.append((f"{WAN}/api/v1/workers", _Resp(200, b"", _WORKERS)))
    with _app() as tc:
        r = tc.get("/kb/agents")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 2  # w1 + manager
    names = {a["name"] for a in body["agents"]}
    assert names == {"w1", "manager"}
    kinds = {a["name"]: a["kind"] for a in body["agents"]}
    assert kinds == {"w1": "worker", "manager": "manager"}


def test_proxy_get_409_no_failover(p4):
    """R4：确定性 409 不换下一地址，原样立即返回。"""
    clients, spec = p4
    spec.append((LAN, _Resp(409, b'{"detail":"ambiguous"}')))
    spec.append((WAN, _Resp(200, b'{"ok":true}')))
    with _app() as tc:
        r = tc.get("/controller/healthz")
    assert r.status_code == 409
    assert r.content == b'{"detail":"ambiguous"}'
    urls = [u for c in clients for (_m, u) in c.records]
    assert any(LAN in u for u in urls)
    assert all(WAN not in u for u in urls), "409 不应换地址"


def test_teams_structure_dial_workers_409_no_failover(p4):
    """R4：_dial_workers 遇 409 不换地址。"""
    clients, spec = p4
    spec.append((f"{LAN}/api/v1/workers", _Resp(409, b"{}", None)))
    spec.append((f"{WAN}/api/v1/workers", _Resp(200, b"", _WORKERS)))
    with _app() as tc:
        tc.get("/teams/structure?force=true")
    urls = [u for c in clients for (_m, u) in c.records]
    assert any(f"{LAN}/api/v1/workers" in u for u in urls)
    assert all(f"{WAN}/api/v1/workers" not in u for u in urls), "409 不应换地址"


def test_kb_agents_ctl_json_409_no_failover(p4):
    """R4：KB fallback 的 _ctl_json 遇 409 不换地址。"""
    clients, spec = p4
    spec.append(("containers/json", _Resp(401, b"{}", None)))
    spec.append((f"{LAN}/api/v1/workers", _Resp(409, b"{}", None)))
    spec.append((f"{WAN}/api/v1/workers", _Resp(200, b"", _WORKERS)))
    with _app() as tc:
        tc.get("/kb/agents")
    urls = [u for c in clients for (_m, u) in c.records]
    assert any(f"{LAN}/api/v1/workers" in u for u in urls)
    assert all(f"{WAN}/api/v1/workers" not in u for u in urls), "409 不应换地址"
