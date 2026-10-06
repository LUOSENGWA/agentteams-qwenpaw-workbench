# -*- coding: utf-8 -*-
"""/approval/list 性能护栏（v0.5.0-beta.14.5，/）。

背景：``approval_list`` 旧实现串行遍历全部容器（31 容器 WAN 实测 ≈23s），
且无缓存——每次展开/切页都重扫一遍。beta.14.5 把遍历改为并发
（semaphore 12）+ 20s TTL 缓存（``approval_set`` 成功后主动失效）。

本文件用 fake 每-archive 延迟（0.05s/请求）钉住性能契约，不打真网络：

- **P1 并发生效**：31 容器 × 0.05s 墙钟 < 1.0s（串行需 ≥1.5s）。
- **P2 缓存命中 + set 失效**：TTL 内第二次 list 零新增 archive 调用；
 清缓存 + 一次成功 set（wsf 兜底）后，再 list 重新扫描。
- **P3 容错不回归**：31 容器中 1 个 archive 500 → 该项 error 非空、
 其余正常、整体 200。

风格参照 ``tests/test_kb_approval_fallback.py``（monkeypatch
``cfgmod.load_config`` + fake ``router.httpx.AsyncClient`` + TestClient）。
"""
from __future__ import annotations

import asyncio
import io
import json
import tarfile
import time

import pytest

from agentteams_connector import config as cfgmod
from agentteams_connector import router as router_mod
from agentteams_connector.router import build_router


def _agent_json_tar(level: str = "AUTO") -> bytes:
    """合法 docker archive tar（唯一文件 agent.json）。"""
    bio = io.BytesIO()
    with tarfile.open(fileobj=bio, mode="w") as tf:
        data = json.dumps({"approval_level": level}).encode("utf-8")
        info = tarfile.TarInfo(name="agent.json")
        info.size = len(data)
        tf.addfile(info, io.BytesIO(data))
    return bio.getvalue()


def _containers_payload() -> list:
    """30 个 worker（w00..w29）+ manager = 31 个目标。"""
    out = [{"Names": ["/agentteams-manager"], "State": "running"}]
    for i in range(30):
        out.append({"Names": [f"/agentteams-worker-w{i:02d}"], "State": "running"})
    return out


class _Resp:
    def __init__(self, status_code: int, content: bytes = b"",
                 json_body: object = None):
        self.status_code = status_code
        self.headers = {}
        self.content = content
        self.text = (
            json.dumps(json_body) if json_body is not None
            else content.decode("utf-8", "replace")
        )
        self._json_body = json_body

    def json(self):
        if self._json_body is None:
            raise AttributeError("no json body")
        return self._json_body


class _PerfClient:
    """AsyncClient fake：archive GET 带固定延迟 + 调用计数。

 url 子串 → _Resp；dict 顺序 = 匹配优先级（更具体的键放前面）。
 """

    instances: list[["_PerfClient"]] = []
    get_spec: dict = {}
    write_spec: dict = {}
    archive_calls: int = 0
    archive_latency: float = 0.05

    def __init__(self, *a, **k):
        self.calls: list[tuple[str, str]] = []
        _PerfClient.instances.append(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a, **k):
        return False

    def _find(self, url: str, spec: dict) -> "_Resp | None":
        for key, resp in spec.items():
            if key in url:
                return resp
        return None

    async def get(self, url, headers=None, **k):
        self.calls.append(("GET", url))
        if "archive?path=" in url:
            _PerfClient.archive_calls += 1
            await asyncio.sleep(_PerfClient.archive_latency)
        r = self._find(url, _PerfClient.get_spec)
        return r if r is not None else _Resp(404)

    async def head(self, url, headers=None, **k):
        self.calls.append(("HEAD", url))
        r = self._find(url, _PerfClient.get_spec)
        return r if r is not None else _Resp(404)

    async def request(self, method, url, json=None, headers=None, **k):
        self.calls.append((method, url))
        spec = _PerfClient.get_spec if method == "GET" else _PerfClient.write_spec
        r = self._find(url, spec)
        return r if r is not None else _Resp(404)

    async def put(self, url, json=None, headers=None, **k):
        return await self.request("PUT", url, json=json, headers=headers, **k)

    async def post(self, url, json=None, headers=None, **k):
        return await self.request("POST", url, json=json, headers=headers, **k)


def _list_resp() -> _Resp:
    body = _containers_payload()
    return _Resp(200, content=json.dumps(body).encode("utf-8"), json_body=body)


def _archive_resp() -> _Resp:
    return _Resp(200, content=_agent_json_tar())


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
    monkeypatch.setattr(
        cfgmod, "update_config", lambda p: json.loads(json.dumps(state["data"]))
    )

    _PerfClient.instances = []
    _PerfClient.get_spec = {}
    _PerfClient.write_spec = {}
    _PerfClient.archive_calls = 0
    # ⚠️ 模块级缓存跨测试残留——每个测试开头清空。
    router_mod._approval_list_cache.clear()

    def fake_client_cls(*a, **k):
        return _PerfClient(*a, **k)

    monkeypatch.setattr(
        "agentteams_connector.router.GatedAsyncClient", fake_client_cls
    )

    app = FastAPI()
    app.include_router(build_router())
    return TestClient(app), state


# ── P1 并发生效 ─────────────────────────────────────────────────────────
def test_approval_list_concurrent(client):
    """31 目标 × 0.05s archive 延迟：墙钟 < 1.0s（串行需 ≥1.5s）。"""
    tc, _ = client
    _PerfClient.get_spec = {
        "/containers/json": _list_resp(),
        "/archive?path=": _archive_resp(),
    }
    started = time.monotonic()
    r = tc.get("/approval/list")
    wall = time.monotonic() - started
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["items"]) == 31
    assert all(i["approval_level"] == "AUTO" for i in body["items"])
    assert _PerfClient.archive_calls == 31
    # 并发上限 12：31 × 0.05s 串行 = 1.55s，并发版应快一个数量级。
    assert wall < 1.0, f"approval_list 耗时 {wall:.2f}s（疑似串行扫描）"


# ── P2 缓存命中 + set 失效 ──────────────────────────────────────────────
def test_approval_list_cache(client):
    """TTL 内第二次 list 零新增 archive 调用；清缓存 + set 成功 → 重新扫描。"""
    tc, _ = client
    _PerfClient.get_spec = {
        # set 的 docker 探活（L2 403 → #1216 兜底）；具体键必须在前
        "/containers/agentteams-worker-w01/json": _Resp(403),
        "/containers/json": _list_resp(),
        "/archive?path=": _archive_resp(),
        "/api/v1/workers/w01/approval": _Resp(
            200, json_body={"approval_level": "STRICT"}),
    }
    _PerfClient.write_spec = {
        "/api/v1/workers/w01/approval": _Resp(
            200, json_body={"approval_level": "STRICT"}),
    }

    r1 = tc.get("/approval/list")
    assert r1.status_code == 200, r1.text
    k = _PerfClient.archive_calls
    assert k == 31

    # 缓存命中：下游零新增。
    r2 = tc.get("/approval/list")
    assert r2.status_code == 200, r2.text
    assert r2.json()["items"] == r1.json()["items"]
    assert _PerfClient.archive_calls == k

    # 失效：清缓存，走一次成功 set（wsf 兜底链），再 list。
    router_mod._approval_list_cache.clear()
    rs = tc.post("/approval/set", json={"agent": "w01", "level": "STRICT"})
    assert rs.status_code == 200, rs.text
    assert rs.json()["ok"] is True
    assert rs.json().get("source") == "controller"

    r3 = tc.get("/approval/list")
    assert r3.status_code == 200, r3.text
    assert _PerfClient.archive_calls > k


# ── P3 容错不回归 ───────────────────────────────────────────────────────
def test_approval_list_partial_failure(client):
    """31 容器中 1 个 archive 500 → 该项 error、其余正常、整体 200。"""
    tc, _ = client
    _PerfClient.get_spec = {
        # w03 的 archive 坏掉（具体键在前）
        "/containers/agentteams-worker-w03/archive": _Resp(500, content=b"boom"),
        "/containers/json": _list_resp(),
        "/archive?path=": _archive_resp(),
    }
    r = tc.get("/approval/list")
    assert r.status_code == 200, r.text
    by_agent = {i["agent"]: i for i in r.json()["items"]}
    assert len(by_agent) == 31
    assert by_agent["w03"]["error"], "w03 应带 error"
    assert by_agent["w03"]["approval_level"] is None
    assert by_agent["w01"]["approval_level"] == "AUTO"
    assert by_agent["manager"]["approval_level"] == "AUTO"
