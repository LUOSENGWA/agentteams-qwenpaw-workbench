# -*- coding: utf-8 -*-
"""15.27 批后端回归：check-all 批量轻探 + versions 表格 + runtime-env。

护栏（对应「检查更新慢 / 版本要表格 / 运行时 env 没预填充」三反馈）：
- C1 check-all 200：workers 行含 current（来自 exec 轻探）+ latest（PyPI）；
  非 qwenpaw runtime 行 skipped=true 不探。
- C2 check-all 缓存：二次调用零新 exec（服务端 10min 缓存命中）。
- C3 check-all run 后缓存失效：POST /upgrade/run 后该 worker 重新探测。
- C4 check-all latest 失败降级：PyPI 502 且无缓存 → latest=null + error，
  workers 侧仍返回。
- C5 versions 200：rows 按 upload_time 倒序、is_latest 锚定、prerelease
  分类（2.3.0rc1=预发布）、yanked 透传、≤30 条截断。
- C6 versions 无缓存断网 → 502。
- R1 runtime-env 200：解析 NUL 分隔 environ 为 entries（key/value/group）；
  敏感键默认脱敏（masked=true 且 value≠原值）。
- R2 runtime-env reveal=1：敏感键明文（masked=false, reveal=true）。
- R3 runtime-env 无 token → 403；worker 名非法 → 400。
- R4 runtime-env group 分类：QWENPAW_*=qwenpaw / AGENTTEAMS_*=platform /
  其余=other。
"""
from __future__ import annotations

import json

import pytest

from conftest import patch_shared_name

from agentteams_connector import config as cfgmod
from agentteams_connector.router import build_router

WORKERS = [
    {"name": "w-qp1", "runtime": "qwenpaw",
     "image": "reg/agentteams-qwenpaw-worker:v1.2.5"},
    {"name": "w-qp2", "runtime": "qwenpaw",
     "image": "reg/agentteams-qwenpaw-worker:v1.2.5"},
    {"name": "w-oc", "runtime": "openclaw", "image": "reg/oc:v1.2.5"},
]

# 容器内 `tr '\0' '\n'` 之后的形态=换行分隔（生产 _CMD 已做 NUL→\n）。
ENV_RAW = (
    "AGENTTEAMS_WORKER_CR_NAME=w-qp1\n"
    "QWENPAW_LLM_STREAM_FIRST_CONTENT_TIMEOUT=300\n"
    "AGENTTEAMS_WORKER_GATEWAY_KEY=abcdef1234567890abcdef1234567890abcd\n"
    "MY_CUSTOM_VAR=hello world\n"
    "PATH=/usr/bin\n"
)


def _frame(payload: bytes) -> bytes:
    return b"\x01" + b"\x00" * 3 + len(payload).to_bytes(4, "big") + payload


LIGHT_RAW = b"2.2.1\nHAS\nHAS\n"


class _FakeResponse:
    def __init__(self, status_code, json_body=None, content=b""):
        self.status_code = status_code
        self.headers = {}
        self._json = json_body
        self.content = content or (
            json.dumps(json_body).encode() if json_body is not None else b"")
        # 容错解码：exec 响应是二进制帧（含 NUL/帧头），生产侧只读 .content，
        # .text 仅兜底——严格 decode 会在二进制帧上炸（0xb8 帧长字节）。
        self.text = self.content.decode("utf-8", "replace")

    def json(self):
        if self._json is None:
            raise AttributeError("no json body")
        return self._json


class _FakeClient:
    instances: list = []
    get_spec: dict = {}
    write_spec: dict = {}

    def __init__(self, *a, **k):
        self.calls = []
        _FakeClient.instances.append(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a, **k):
        return False

    @classmethod
    def _match(cls, url, spec):
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
        self.calls.append(("POST", url, json))
        r = self._match(url, _FakeClient.write_spec)
        return r if r is not None else _FakeResponse(404)

    @classmethod
    def exec_create_count(cls):
        return sum(1 for i in cls.instances for c in i.calls
                   if c[0] == "POST" and "/exec" in c[1] and "/start" not in c[1])

    @classmethod
    def worker_list_get_count(cls):
        return sum(1 for i in cls.instances for c in i.calls
                   if c[0] == "GET" and "/api/v1/workers" in c[1])


PYPY_BODY = {
    "info": {"version": "2.2.2"},
    "releases": {
        "2.2.2": [{"upload_time_iso_8601": "2026-10-10T01:00:00Z",
                   "size": 901120, "yanked": False}],
        "2.2.1": [{"upload_time_iso_8601": "2026-09-20T01:00:00Z",
                   "size": 899000, "yanked": False}],
        "2.3.0rc1": [{"upload_time_iso_8601": "2026-10-12T01:00:00Z",
                      "size": 910000, "yanked": False}],
        "2.2.0": [{"upload_time_iso_8601": "2026-09-01T01:00:00Z",
                   "size": 890000, "yanked": True}],
    },
}


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
    import agentteams_connector.routers.upgrade_api as _upg
    _upg._latest_cache.update({"version": None, "releases": None,
                               "fetched_at": 0.0})
    _upg._probe_cache.clear()
    patch_shared_name(monkeypatch, "GatedAsyncClient",
                      lambda *a, **k: _FakeClient(*a, **k))

    app = FastAPI()
    app.include_router(build_router())
    yield TestClient(app), state
    import agentteams_connector.routers.upgrade_api as _upg2
    _upg2._latest_cache.update({"version": None, "releases": None,
                                "fetched_at": 0.0})
    _upg2._probe_cache.clear()


def _specs(env_raw: bytes = ENV_RAW, pypi: int = 200):
    g = {
        "/api/v1/workers?limit=40": (200, {"workers": WORKERS}),
        "/api/v1/workers/w-qp1": (200, {"name": "w-qp1", "runtime": "qwenpaw"}),
        "/api/v1/workers/w-qp2": (200, {"name": "w-qp2", "runtime": "qwenpaw"}),
        "/api/v1/workers/w-oc": (200, {"name": "w-oc", "runtime": "openclaw"}),
    }
    if pypi == 200:
        g["pypi.org/pypi/qwenpaw/json"] = (200, PYPY_BODY)
    else:
        g["pypi.org/pypi/qwenpaw/json"] = (pypi, None)
    w = {
        "/containers/agentteams-worker-w-qp1/exec": (201, {"Id": "e1"}),
        "/containers/agentteams-worker-w-qp2/exec": (201, {"Id": "e2"}),
        "/exec/e1/start": (200, None, _frame(LIGHT_RAW)),
        "/exec/e2/start": (200, None, _frame(LIGHT_RAW)),
    }
    _FakeClient.get_spec, _FakeClient.write_spec = g, w


def test_check_all_200(client):
    tc, _ = client
    _specs()
    r = tc.get("/upgrade/check-all")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["latest"] == "2.2.2"
    assert d["source"] == "pypi"
    by = {w["name"]: w for w in d["workers"]}
    assert by["w-qp1"]["current"] == "2.2.1"
    assert by["w-qp1"]["supported"] is True
    assert by["w-qp2"]["current"] == "2.2.1"
    assert by["w-oc"]["skipped"] is True
    assert "current" not in by["w-oc"]
    # 2 qwenpaw worker → 2 exec（openclaw 跳过不探）
    assert _FakeClient.exec_create_count() == 2


def test_check_all_cache_zero_exec(client):
    tc, _ = client
    _specs()
    r1 = tc.get("/upgrade/check-all")
    assert r1.status_code == 200
    n1 = _FakeClient.exec_create_count()
    assert n1 == 2
    r2 = tc.get("/upgrade/check-all")
    assert r2.status_code == 200
    n2 = _FakeClient.exec_create_count()
    assert n2 == n1, "二次调用命中缓存=零新 exec"
    assert r2.json()["workers"][0].get("cached") in (True, False)
    # worker 列表 60s 缓存：二次点击不再拨 /api/v1/workers（29-worker 集群
    # 该端点实测 2–2.9s——缓存后重复点击=纯本地匹配毫秒级）。
    assert _FakeClient.worker_list_get_count() == 1, (
        "worker 列表应只拉一次（60s 缓存）")
    # latest 也命中 PyPI 缓存（PyPI 不再被拨）
    pypi_calls = sum(1 for i in _FakeClient.instances for c in i.calls
                     if "pypi.org" in c[1])
    assert pypi_calls == 1, "PyPI 应只拉一次（10min 缓存）"


def test_check_all_run_invalidates_probe_cache(client):
    tc, _ = client
    _specs()
    tc.get("/upgrade/check-all")
    n1 = _FakeClient.exec_create_count()
    assert n1 == 2
    # 触发 w-qp1 升级（detached exec=另 1 个 exec create）→ 其探测缓存失效
    r = tc.post("/upgrade/run", json={"worker": "w-qp1", "version": "2.2.2"})
    assert r.status_code == 202, r.text
    n_after_run = _FakeClient.exec_create_count()  # n1(探) + 1(run detached)
    # 再次 check-all：w-qp1 重新探（+1 exec），w-qp2 仍缓存（+0）
    r2 = tc.get("/upgrade/check-all")
    assert r2.status_code == 200
    n2 = _FakeClient.exec_create_count()
    assert n2 == n_after_run + 1, (
        f"仅升级过的 worker 应重新探（run 后 {n_after_run}→{n2}，期望 +1）")


def test_check_all_pypi_down_no_cache(client):
    tc, _ = client
    _specs(pypi=502)
    r = tc.get("/upgrade/check-all")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["latest"] is None
    assert d["error"]
    # workers 侧仍返回（当前版可用，匹配列前端降级）
    by = {w["name"]: w for w in d["workers"]}
    assert by["w-qp1"]["current"] == "2.2.1"


def test_versions_table(client):
    tc, _ = client
    _specs()
    r = tc.get("/upgrade/versions")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["latest"] == "2.2.2"
    rows = {v["version"]: v for v in d["versions"]}
    assert set(rows) == {"2.2.2", "2.2.1", "2.3.0rc1", "2.2.0"}
    # 倒序=按 upload_time：2.3.0rc1(10-12) > 2.2.2(10-10) > 2.2.1 > 2.2.0
    order = [v["version"] for v in d["versions"]]
    assert order == ["2.3.0rc1", "2.2.2", "2.2.1", "2.2.0"]
    assert rows["2.2.2"]["is_latest"] is True
    assert rows["2.2.2"]["upload_time"] == "2026-10-10"
    assert rows["2.3.0rc1"]["prerelease"] is True
    assert rows["2.2.2"]["prerelease"] is False
    assert rows["2.2.0"]["yanked"] is True
    assert rows["2.2.2"]["size"] == 901120


def test_versions_pypi_down_no_cache_502(client):
    tc, _ = client
    _specs(pypi=502)
    r = tc.get("/upgrade/versions")
    assert r.status_code == 502, r.text


def test_runtime_env_200_masked(client):
    tc, _ = client
    # runtime-env 走同一 exec 通道：w-qp1 的 exec start 返回 ENV_RAW 帧
    w = {
        "/containers/agentteams-worker-w-qp1/exec": (201, {"Id": "e1"}),
        "/exec/e1/start": (200, None, _frame(ENV_RAW.encode())),
    }
    _FakeClient.write_spec = w
    r = tc.get("/workers/w-qp1/runtime-env")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["worker"] == "w-qp1"
    assert d["count"] == 5
    assert d["reveal"] is False
    by = {e["key"]: e for e in d["env"]}
    # 非敏感键：明文 + group 分类
    assert by["QWENPAW_LLM_STREAM_FIRST_CONTENT_TIMEOUT"]["value"] == "300"
    assert by["QWENPAW_LLM_STREAM_FIRST_CONTENT_TIMEOUT"]["group"] == "qwenpaw"
    assert by["AGENTTEAMS_WORKER_CR_NAME"]["group"] == "platform"
    assert by["MY_CUSTOM_VAR"]["value"] == "hello world"
    assert by["MY_CUSTOM_VAR"]["group"] == "other"
    assert by["PATH"]["group"] == "other"
    # 敏感键：默认脱敏
    gw = by["AGENTTEAMS_WORKER_GATEWAY_KEY"]
    assert gw["sensitive"] is True
    assert gw["masked"] is True
    assert gw["value"] != "abcdef1234567890abcdef1234567890abcd"
    assert gw["value"].startswith("abcd")
    assert gw["value"].endswith("abcd")


def test_runtime_env_reveal(client):
    tc, _ = client
    w = {
        "/containers/agentteams-worker-w-qp1/exec": (201, {"Id": "e1"}),
        "/exec/e1/start": (200, None, _frame(ENV_RAW.encode())),
    }
    _FakeClient.write_spec = w
    r = tc.get("/workers/w-qp1/runtime-env", params={"reveal": "1"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["reveal"] is True
    by = {e["key"]: e for e in d["env"]}
    gw = by["AGENTTEAMS_WORKER_GATEWAY_KEY"]
    assert gw["masked"] is False
    assert gw["value"] == "abcdef1234567890abcdef1234567890abcd"


def test_runtime_env_empty_retry_recovers(client, monkeypatch):
    """docker exec attach 流偶发空读（竞态）→ 带短退避重试，最终非空（15.30）。

    前 2 次返回空（模拟丢帧）、第 3 次真值 → 端点返回 5 条而非 0。
    直接 monkeypatch _exec（绕过 HTTP mock 的无状态帧），sleep 打快。
    """
    import agentteams_connector.routers.runtime_env_api as reapi
    tc, _ = client
    calls = {"n": 0}

    async def flaky_exec(token, container, cmd, timeout=30.0):
        calls["n"] += 1
        return (200, "") if calls["n"] < 3 else (200, ENV_RAW)

    async def _fast_sleep(_s):
        return None

    monkeypatch.setattr(reapi, "_exec", flaky_exec)
    monkeypatch.setattr(reapi.asyncio, "sleep", _fast_sleep)
    r = tc.get("/workers/w-qp1/runtime-env")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["count"] == 5, d
    assert calls["n"] == 3  # 空→空→真值


def test_runtime_env_empty_persist_graceful(client, monkeypatch):
    """持续空（≤3 次后放弃）→ 优雅返回 count=0，不 5xx、不无限循环。"""
    import agentteams_connector.routers.runtime_env_api as reapi
    tc, _ = client
    calls = {"n": 0}

    async def always_empty(token, container, cmd, timeout=30.0):
        calls["n"] += 1
        return 200, ""

    async def _fast_sleep(_s):
        return None

    monkeypatch.setattr(reapi, "_exec", always_empty)
    monkeypatch.setattr(reapi.asyncio, "sleep", _fast_sleep)
    r = tc.get("/workers/w-qp1/runtime-env")
    assert r.status_code == 200, r.text
    assert r.json()["count"] == 0
    assert calls["n"] == 3  # 恰好 3 次，不更多


def test_runtime_env_no_token_403(client):
    tc, state = client
    state["data"]["controller_token"] = ""
    r = tc.get("/workers/w-qp1/runtime-env")
    assert r.status_code == 403


def test_runtime_env_bad_worker_400(client):
    tc, _ = client
    r = tc.get("/workers/BAD%2FNAME/runtime-env")
    assert r.status_code == 400


def test_check_light_uses_shared_cache(client):
    """单 worker 轻探与 check-all 共享缓存（check-all 后=零 exec）。"""
    tc, _ = client
    _specs()
    tc.get("/upgrade/check-all")
    n1 = _FakeClient.exec_create_count()
    r = tc.get("/upgrade/check", params={"worker": "w-qp1"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["current"] == "2.2.1"
    assert d["cached"] is True
    assert _FakeClient.exec_create_count() == n1


def test_check_all_no_token_403(client):
    tc, state = client
    state["data"]["controller_token"] = ""
    r = tc.get("/upgrade/check-all")
    assert r.status_code == 403


def test_versions_no_token_403(client):
    tc, state = client
    state["data"]["controller_token"] = ""
    r = tc.get("/upgrade/versions")
    assert r.status_code == 403
