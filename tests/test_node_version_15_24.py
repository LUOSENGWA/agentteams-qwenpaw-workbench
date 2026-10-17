# -*- coding: utf-8 -*-
"""节点版本域（/node-version/{name}）单测——15.24 版本语义修复。

10/17 需求反馈：「v1.2.5 是 AgentTeams 版本，不是运行时版本，当前
QwenPaw 版本是 2.2.1，还要覆盖其他运行时的版本显示。」

护栏：
- N1 L1 门：无 controller token → 403（docker 代理=ActionGateway）。
- N2 成功路径：CRD 列表（worker 优先）→ 容器候选 → exec 探测 →
  200 {agentteams_version: 镜像 tag, runtime_version: exec 版本}。
- N3 缓存：10min 内二次调用零重探（exec start 计数不变）。
- N4 refresh=1 强制重探。
- N5 节点不存在 → 404（worker/manager 双查后）。
- N6 探测失败降级：HTTP 恒 200，runtime_version=null + error 文案。
- N7 探测输出解析：qwenpaw 直出 "2.2.1" / openclaw 带产品名首行
  "OpenClaw 1.2.3" → 首个版本样 token。
- N8 manager（name=default，openclaw profile 镜像）→ 容器
  agentteams-manager 候选命中。
- N9 docker 清单不可用（500）→ 候选名仍信（approval 域同款约定）。
- N10 非法节点名 → 400（不进 shell/路径）。
"""
from __future__ import annotations

import json

import pytest

from conftest import patch_shared_name

from agentteams_connector import config as cfgmod
from agentteams_connector.router import build_router

WORKER = {
    "name": "test-multimodal",
    "runtime": "qwenpaw",
    "image": "higress-registry.cn-hangzhou.cr.aliyuncs.com"
             "/agentteams/agentteams-qwenpaw-worker:v1.2.5",
    "state": "Running",
    "phase": "Running",
}
MANAGER = {
    "name": "default",
    "runtime": "openclaw",
    "image": "higress-registry.cn-hangzhou.cr.aliyuncs.com"
             "/agentteams/agentteams-manager-qwenpaw:v1.2.5",
    "state": "Running",
    "phase": "Running",
}
DOCKER_LIST = [
    {"Names": ["/agentteams-worker-test-multimodal"],
     "Image": "higress-registry.cn-hangzhou.cr.aliyuncs.com"
              "/agentteams/agentteams-qwenpaw-worker:v1.2.5"},
    {"Names": ["/agentteams-manager"],
     "Image": "higress-registry.cn-hangzhou.cr.aliyuncs.com"
              "/agentteams/agentteams-manager-qwenpaw:v1.2.5"},
]


class _FakeResponse:
    def __init__(self, status_code: int, json_body=None,
                 content: bytes = b"", text: str = ""):
        self.status_code = status_code
        self.headers = {}
        self._json_body = json_body
        self.content = content
        self.text = text or (json.dumps(json_body) if json_body is not None else "")

    def json(self):
        if self._json_body is None:
            raise AttributeError("no json body")
        return self._json_body


class _FakeClient:
    instances: list = []
    get_spec: dict = {}      # url 子串 → (status, json_body, content)
    write_spec: dict = {}    # url 子串 → (status, json_body, content)

    def __init__(self, *a, **k):
        self.calls: list = []
        _FakeClient.instances.append(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a, **k):
        return False

    @classmethod
    def _match(cls, url: str, spec: dict):
        for key, val in spec.items():
            if key in url:
                st, body = val[0], val[1]
                content = val[2] if len(val) > 2 and val[2] is not None else b""
                return _FakeResponse(st, body, content=content)
        return None

    async def get(self, url, headers=None, **k):
        self.calls.append(("GET", url))
        r = self._match(url, _FakeClient.get_spec)
        return r if r is not None else _FakeResponse(404)

    async def post(self, url, json=None, headers=None, **k):
        self.calls.append(("POST", url))
        r = self._match(url, _FakeClient.write_spec)
        return r if r is not None else _FakeResponse(404)

    @classmethod
    def exec_start_count(cls) -> int:
        return sum(
            1 for inst in cls.instances
            for m, u in inst.calls
            if m == "POST" and "/exec/" in u and "/start" in u
        )


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
    monkeypatch.delenv("AGENTTEAMS_CONTROLLER_TOKEN", raising=False)
    _FakeClient.instances = []
    _FakeClient.get_spec = {}
    _FakeClient.write_spec = {}
    patch_shared_name(monkeypatch, "GatedAsyncClient",
                      lambda *a, **k: _FakeClient(*a, **k))

    app = FastAPI()
    app.include_router(build_router())
    return TestClient(app), state


def _base_specs(get_spec=None, write_spec=None):
    if get_spec is None:
        get_spec = {
            "/api/v1/workers": (200, {"workers": [WORKER]}),
            "/api/v1/managers": (200, {"managers": [MANAGER]}),
            "/docker/v1.41/containers/json": (200, DOCKER_LIST),
        }
    if write_spec is None:
        write_spec = {
            "/containers/agentteams-worker-test-multimodal/exec": (
                201, {"Id": "exec1"}),
            "/exec/exec1/start": (200, None, b"\x01" * 8 + b"2.2.1"),
        }
    return get_spec, write_spec


# ── N1 L1 门 ──────────────────────────────────────────────────────────
def test_node_version_no_token_403(client, monkeypatch):
    tc, state = client
    state["data"]["controller_token"] = ""
    r = tc.get("/node-version/test-multimodal")
    assert r.status_code == 403, r.text


# ── N2 成功路径 ───────────────────────────────────────────────────────
def test_node_version_worker_success(client):
    tc, _ = client
    g, w = _base_specs()
    _FakeClient.get_spec, _FakeClient.write_spec = g, w
    r = tc.get("/node-version/test-multimodal")
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["kind"] == "worker"
    assert b["name"] == "test-multimodal"
    assert b["runtime"] == "qwenpaw"
    assert b["agentteams_version"] == "1.2.5"
    assert b["runtime_version"] == "2.2.1"
    assert b["runtime_version_error"] == ""
    assert _FakeClient.exec_start_count() == 1


# ── N3 缓存：二次调用零重探 ───────────────────────────────────────────
def test_node_version_cache_no_reprobe(client):
    tc, _ = client
    g, w = _base_specs()
    _FakeClient.get_spec, _FakeClient.write_spec = g, w
    r1 = tc.get("/node-version/test-multimodal")
    assert r1.status_code == 200
    tc.get("/node-version/test-multimodal")
    assert _FakeClient.exec_start_count() == 1
    # CRD 列表也走 30s 缓存（二次调用不再拉 workers）。
    worker_gets = sum(
        1 for inst in _FakeClient.instances
        for m, u in inst.calls
        if m == "GET" and "/api/v1/workers" in u
    )
    assert worker_gets == 1


# ── N4 refresh=1 强制重探 ─────────────────────────────────────────────
def test_node_version_refresh_reprobes(client):
    tc, _ = client
    g, w = _base_specs()
    _FakeClient.get_spec, _FakeClient.write_spec = g, w
    tc.get("/node-version/test-multimodal")
    r = tc.get("/node-version/test-multimodal?refresh=1")
    assert r.status_code == 200
    assert r.json()["runtime_version"] == "2.2.1"
    assert _FakeClient.exec_start_count() == 2


# ── N5 节点不存在 → 404 ───────────────────────────────────────────────
def test_node_version_unknown_node_404(client):
    tc, _ = client
    g, w = _base_specs()
    _FakeClient.get_spec, _FakeClient.write_spec = g, w
    r = tc.get("/node-version/no-such-node")
    assert r.status_code == 404, r.text
    assert _FakeClient.exec_start_count() == 0


# ── N6 探测失败降级（HTTP 恒 200）─────────────────────────────────────
def test_node_version_probe_empty_output_degrades(client):
    tc, _ = client
    g, w = _base_specs()
    w["/exec/exec1/start"] = (200, None, b"\x01" * 8 + b"")
    _FakeClient.get_spec, _FakeClient.write_spec = g, w
    r = tc.get("/node-version/test-multimodal")
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["runtime_version"] is None
    assert "未找到" in b["runtime_version_error"]
    # AgentTeams 版本仍正常（镜像 tag 不依赖探测）。
    assert b["agentteams_version"] == "1.2.5"


# ── N7 输出解析（openclaw 带产品名首行）──────────────────────────────
def test_node_version_openclaw_prefixed_line(client):
    tc, _ = client
    g, w = _base_specs()
    w["/exec/exec1/start"] = (200, None, b"\x01" * 8 + b"OpenClaw 1.2.3\n")
    _FakeClient.get_spec, _FakeClient.write_spec = g, w
    r = tc.get("/node-version/test-multimodal")
    assert r.status_code == 200
    assert r.json()["runtime_version"] == "1.2.3"


# ── N8 manager（default / openclaw profile）───────────────────────────
def test_node_version_manager_default(client):
    tc, _ = client
    g, w = _base_specs()
    w["/containers/agentteams-manager/exec"] = (201, {"Id": "execm"})
    w["/exec/execm/start"] = (200, None, b"\x01" * 8 + b"2.2.1")
    _FakeClient.get_spec, _FakeClient.write_spec = g, w
    r = tc.get("/node-version/default")
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["kind"] == "manager"
    assert b["agentteams_version"] == "1.2.5"
    assert b["runtime_version"] == "2.2.1"


# ── N9 docker 清单不可用 → 候选名仍信 ────────────────────────────────
def test_node_version_docker_list_down_trusts_candidate(client):
    tc, _ = client
    g, w = _base_specs()
    g["/docker/v1.41/containers/json"] = (500, {"message": "daemon down"})
    _FakeClient.get_spec, _FakeClient.write_spec = g, w
    r = tc.get("/node-version/test-multimodal")
    assert r.status_code == 200, r.text
    assert r.json()["runtime_version"] == "2.2.1"


# ── N10 非法节点名 → 400 ──────────────────────────────────────────────
def test_node_version_bad_name_400(client):
    tc, _ = client
    g, w = _base_specs()
    _FakeClient.get_spec, _FakeClient.write_spec = g, w
    r = tc.get("/node-version/../../etc")
    # TestClient 归一化路径 → 404 亦可（关键=不 500/不执行探测）
    assert r.status_code in (400, 404), r.text
    assert _FakeClient.exec_start_count() == 0
