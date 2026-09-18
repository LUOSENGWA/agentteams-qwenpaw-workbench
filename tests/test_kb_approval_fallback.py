# -*- coding: utf-8 -*-
"""KB/approval 的 #1208/#1216 兜底数据面回归测试（v0.5.0-beta.12.5）。

背景（L2 实损修复）：插件 KB 与 approval 此前全走 Controller Docker 代理
（archive/exec），而 ``/docker/`` 挂 ``ActionGateway``（L1-only）→ L2
（team-scoped token）恒 403，KB/审批整面不可用。

本文件护栏（docker 优先、controller 兜底，manager 无 #1208/#1216 端点保持
L1-only）：

- **B1 KB tree 兜底**：docker ``/containers/{w}/json`` 返 403（L2）→ 切
  ``#1208 /workspace-files``（memory/digest/MEMORY.md 三分类），source=controller。
- **B1 KB file 兜底**：docker 403 + path 在 #1208 allowlist → #1208 file-content。
- **B1 非 allowlist 不兜底**：AGENTS.md（档案，#1208 不覆盖）+ docker 403 →
  走 docker 路径 → 404（不泄露、不误走 controller）。
- **B2 approval list 兜底**：docker ``/containers/json`` 403 → #1216
  ``GET /api/v1/workers`` + 逐个 ``GET /workers/{w}/approval``；manager 标 L1-only。
- **B2 approval set 兜底**：docker ``/json`` 403 → #1216 ``PUT /workers/{w}/approval``，
  回读 verified；L2 设 OFF → 403 透传。
"""
from __future__ import annotations

import json

import pytest

from agentteams_connector import config as cfgmod
from agentteams_connector.router import build_router


class _FakeResponse:
    def __init__(self, status_code: int, json_body: object = None,
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
    instances: list[["_FakeClient"]] = []
    # url 子串 → (status, json_body, text)。GET 走 get_spec；PUT/POST 走 write_spec。
    get_spec: dict = {}
    write_spec: dict = {}

    def __init__(self, *a, **k):
        self.calls: list[tuple[str, str]] = []
        _FakeClient.instances.append(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a, **k):
        return False

    def _match(self, url: str, spec: dict) -> "_FakeResponse | None":
        for key, val in spec.items():
            if key in url:
                st, body = val[0], val[1]
                text = val[2] if len(val) > 2 else ""
                return _FakeResponse(st, body, text=text)
        return None

    async def get(self, url, headers=None, **k):
        self.calls.append(("GET", url))
        r = self._match(url, _FakeClient.get_spec)
        return r if r is not None else _FakeResponse(404)

    async def request(self, method, url, json=None, headers=None, **k):
        self.calls.append((method, url))
        if method == "GET":
            r = self._match(url, _FakeClient.get_spec)
            return r if r is not None else _FakeResponse(404)
        r = self._match(url, _FakeClient.write_spec)
        return r if r is not None else _FakeResponse(404)

    async def put(self, url, json=None, headers=None, **k):
        return await self.request("PUT", url, json=json, headers=headers, **k)

    async def post(self, url, json=None, headers=None, **k):
        return await self.request("POST", url, json=json, headers=headers, **k)


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

    _FakeClient.instances = []
    _FakeClient.get_spec = {}
    _FakeClient.write_spec = {}

    def fake_client_cls(*a, **k):
        return _FakeClient(*a, **k)

    monkeypatch.setattr(
        "agentteams_connector.router.httpx.AsyncClient", fake_client_cls
    )

    app = FastAPI()
    app.include_router(build_router())
    return TestClient(app), state


def _all_calls() -> list[tuple[str, str]]:
    return [c for inst in _FakeClient.instances for c in inst.calls]


def _docker_json_probe_count() -> int:
    return sum(
        1 for m, u in _all_calls()
        if m == "GET" and "/json" in u and "/containers/" in u
    )


# ── B1 KB tree 兜底 ────────────────────────────────────────────────────
def test_kb_tree_l2_fallback_to_workspace_files(client):
    """docker /json 403（L2）→ #1208 三分类（memory/digest/MEMORY.md）。"""
    tc, _ = client
    _FakeClient.get_spec = {
        # docker 探活 → 403（L2 无 ActionGateway）
        "/json": (403, None),
        # #1208 tree memory（一个文件）
        "workspace-files/tree?path=memory": (
            200, {"directory": "memory",
                  "entries": [{"kind": "file", "name": "2026-09-13.md",
                               "path": "memory/2026-09-13.md",
                               "size": 100, "modified_at": "2026-09-13T00:00:00Z"}],
                  "has_more": False, "next_cursor": None}),
        # #1208 tree digest（空）
        "workspace-files/tree?path=digest": (
            200, {"directory": "digest", "entries": [], "has_more": False}),
        # 顶层懒加载探 memory/digest 存在性（limit=1）
        "workspace-files/tree?path=memory&limit=1": (
            200, {"directory": "memory", "entries": [], "has_more": False}),
        # #1208 file-metadata MEMORY.md
        "workspace-files/file-metadata?path=MEMORY.md": (
            200, {"path": "MEMORY.md", "size": 50,
                  "modified_at": "2026-09-13T00:00:00Z"}),
    }
    r = tc.get("/kb/alpha/tree")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("source") == "controller"
    paths = {f["path"]: f.get("category") for f in body["files"]}
    assert paths.get("memory/2026-09-13.md") == "daily"
    assert paths.get("MEMORY.md") == "profile"
    # 兜底确走了 #1208（有 workspace-files 调用）
    assert any("workspace-files" in u for m, u in _all_calls())


def test_kb_file_l2_fallback_to_workspace_files(client):
    """docker /json 403 + path 在 #1208 allowlist → #1208 file-content。"""
    tc, _ = client
    _FakeClient.get_spec = {
        "/json": (403, None),
        "workspace-files/file-content?path=memory%2Fa.md": (
            200, {"content": "hello-kb", "encoding": "utf-8",
                  "eof": True, "offset": 0, "next_offset": 0}),
    }
    r = tc.get("/kb/alpha/file", params={"path": "memory/a.md"})
    assert r.status_code == 200, r.text
    assert r.json()["content"] == "hello-kb"
    assert r.json().get("source") == "controller"


def test_kb_file_non_allowlist_no_fallback(client):
    """AGENTS.md（档案，#1208 不覆盖）+ docker 403 → 不兜底，走 docker → 404。"""
    tc, _ = client
    _FakeClient.get_spec = {
        "/json": (403, None),
        # docker archive 探活（_kb_workspace 的 HEAD/GET 候选）→ 403/404
        "archive": (403, None),
    }
    r = tc.get("/kb/alpha/file", params={"path": "AGENTS.md"})
    # 非 allowlist → 不切 controller → docker 路径 403/404 → 404 文件不存在
    assert r.status_code == 404, r.text
    # 关键：没有发 workspace-files 请求（未走兜底）
    assert not any("workspace-files" in u for m, u in _all_calls()), \
        "非 allowlist 路径不应触发 #1208 兜底"


# ── B2 approval 兜底 ───────────────────────────────────────────────────
def test_approval_list_l2_fallback_to_1216(client):
    """docker /containers/json 403 → #1216 列表（worker+approval，manager L1-only）。"""
    tc, _ = client
    # 注意：dict 顺序=匹配优先级，更具体的键必须在前（/api/v1/workers 是
    # /api/v1/workers/alpha/approval 的子串）。
    _FakeClient.get_spec = {
        # docker 容器列表 → 403（L2）
        "/containers/json": (403, None),
        # #1216 alpha approval（具体，先）
        "/api/v1/workers/alpha/approval": (200, {"approval_level": "SMART"}),
        # #1216 worker 列表（泛，后）
        "/api/v1/workers": (200, {"workers": [
            {"name": "alpha", "state": "running", "team": "biz"},
        ], "total": 1}),
    }
    r = tc.get("/approval/list")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("source") == "controller"
    by_agent = {i["agent"]: i for i in body["items"]}
    assert by_agent["alpha"]["approval_level"] == "SMART"
    assert by_agent["alpha"]["kind"] == "worker"
    # manager 无 #1216 端点 → 标 L1-only 错误
    assert by_agent["manager"]["approval_level"] is None
    assert "L1" in by_agent["manager"]["error"]


def test_approval_set_l2_fallback_to_1216(client):
    """docker /json 403 → #1216 PUT + 回读 verified。"""
    tc, _ = client
    _FakeClient.get_spec = {
        "/json": (403, None),
        # 回读
        "/api/v1/workers/alpha/approval": (200, {"approval_level": "STRICT"}),
    }
    _FakeClient.write_spec = {
        "/api/v1/workers/alpha/approval": (200, {"approval_level": "STRICT"}),
    }
    r = tc.post("/approval/set", json={"agent": "alpha", "level": "STRICT"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["verified"] == "STRICT"
    assert body.get("source") == "controller"
    # 确发了 PUT
    assert any(m == "PUT" and "approval" in u for m, u in _all_calls())


def test_approval_set_l2_off_403_passthrough(client):
    """L2 设 OFF → #1216 403 → 透传 403。"""
    tc, _ = client
    _FakeClient.get_spec = {"/json": (403, None)}
    _FakeClient.write_spec = {
        "/api/v1/workers/alpha/approval": (403, {"detail": "L2 cannot set OFF"}),
    }
    r = tc.post("/approval/set", json={"agent": "alpha", "level": "OFF"})
    assert r.status_code == 403, r.text
    assert "OFF" in r.text or "无权限" in r.text
