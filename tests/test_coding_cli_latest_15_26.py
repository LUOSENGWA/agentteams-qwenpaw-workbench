# -*- coding: utf-8 -*-
"""coding CLI 检查更新域（/coding-cli/latest）单测——10/17「走宿主」。

定案（检查更新在插件做、走宿主）：浏览器在内网连不上外网 npm
registry，改由插件后端（宿主）server-side 查；宿主也连不上 → 逐 CLI
优雅降级。本测覆盖：

- C1 L1 门：无 controller token → 403（管理面，不发出站）。
- C2 成功路径：clis 空=全部 3 个 → 各 CLI latest 版本（registry GET 命中）。
- C3 白名单：含未知 CLI id → 400（不进 URL，零出站）。
- C4 缓存：5min 内二次调用零重查（registry GET 计数不变）。
- C5 refresh=1 强制重查。
- C6 registry 500 → 该项 error + HTTP 恒 200（其余 CLI 正常）。
- C7 registry 响应非 JSON → 该项 error（降级不抛）。
- C8 指定 clis 子集只查该子集。
"""
from __future__ import annotations

import json

import pytest

from agentteams_connector import config as cfgmod
from agentteams_connector.router import build_router

# 三包 registry latest 真值（2026-10-17 实测 registry.npmjs.org）。
_LATEST = {
    "/@qwen-code/qwen-code/latest": "0.25.2",
    "/opencode-ai/latest": "1.19.3",
    "/@qoder-ai/qodercli/latest": "1.1.73",
}


class _FakeResponse:
    def __init__(self, status_code: int, json_body=None,
                 content: bytes = b"", raw: bytes | None = None):
        self.status_code = status_code
        self.headers = {}
        self._json_body = json_body
        self._raw = raw
        self.content = content if raw is None else raw
        self.text = (content or b"").decode("utf-8", "replace")

    def json(self):
        if self._raw is not None:
            raise ValueError("raw non-json body")
        if self._json_body is None:
            raise AttributeError("no json body")
        return self._json_body


class _FakeClient:
    instances: list = []
    get_spec: dict = {}      # url 子串 → (status, json_body, content, raw)

    def __init__(self, *a, **k):
        self.calls: list = []
        _FakeClient.instances.append(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a, **k):
        return False

    @classmethod
    def _match(cls, url: str):
        for key, val in cls.get_spec.items():
            if key in url:
                st, body = val[0], val[1]
                content = val[2] if len(val) > 2 and val[2] is not None else b""
                raw = val[3] if len(val) > 3 else None
                return _FakeResponse(st, body, content=content, raw=raw)
        return _FakeResponse(404)

    async def get(self, url, headers=None, **k):
        self.calls.append(("GET", url))
        return self._match(url)

    @classmethod
    def registry_get_count(cls) -> int:
        """命中 registry.npmjs.org 的 GET 次数（缓存/重查判定）。"""
        return sum(
            1 for inst in cls.instances
            for m, u in inst.calls
            if m == "GET" and "registry.npmjs.org" in u
        )


def _default_get_spec(over: dict | None = None) -> dict:
    spec = {k: (200, {"version": v}) for k, v in _LATEST.items()}
    if over:
        spec.update(over)
    return spec


@pytest.fixture
def client(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    state = {"data": {
        "controller_urls": ["http://10.0.0.1:8090"],
        "controller_token": "ctok123",
        "matrix_homeservers": [],
        "matrix": {"user_id": "", "access_token": ""},
    }}

    def fake_load():
        return json.loads(json.dumps(state["data"]))

    monkeypatch.setattr(cfgmod, "load_config", fake_load)
    monkeypatch.delenv("AGENTTEAMS_CONTROLLER_TOKEN", raising=False)
    _FakeClient.instances = []
    _FakeClient.get_spec = _default_get_spec()
    monkeypatch.setattr(
        "agentteams_connector.dial_gate.GatedAsyncClient",
        lambda *a, **k: _FakeClient(*a, **k),
    )
    # 新 router 也 import 了 GatedAsyncClient（从 ..dial_gate）——同样 patch 落点。
    import agentteams_connector.routers.coding_cli_latest_api as mod
    monkeypatch.setattr(mod, "GatedAsyncClient",
                        lambda *a, **k: _FakeClient(*a, **k))

    app = FastAPI()
    app.include_router(build_router())
    return TestClient(app), state


# ── C1 L1 门 ─────────────────────────────────────────────────────────
def test_latest_no_token_403(client):
    tc, state = client
    state["data"]["controller_token"] = ""
    r = tc.get("/coding-cli/latest")
    assert r.status_code == 403, r.text
    assert _FakeClient.registry_get_count() == 0  # 未发出站


# ── C2 成功路径（clis 空=全部 3 个）─────────────────────────────────
def test_latest_all_default(client):
    tc, _ = client
    r = tc.get("/coding-cli/latest")
    assert r.status_code == 200, r.text
    b = r.json()
    assert set(b["items"]) == {"qwen-code", "opencode", "qoder"}
    assert b["items"]["qwen-code"]["latest"] == "0.25.2"
    assert b["items"]["opencode"]["latest"] == "1.19.3"
    assert b["items"]["qoder"]["latest"] == "1.1.73"
    assert b["items"]["qwen-code"]["npm_package"] == "@qwen-code/qwen-code"
    assert _FakeClient.registry_get_count() == 3


# ── C3 白名单：未知 CLI → 400 ────────────────────────────────────────
def test_latest_unknown_cli_400(client):
    tc, _ = client
    r = tc.get("/coding-cli/latest?clis=qwen-code,evildoer")
    assert r.status_code == 400, r.text
    assert _FakeClient.registry_get_count() == 0  # 白名单校验在前，零出站


# ── C4 缓存：二次调用零重查 ─────────────────────────────────────────
def test_latest_cache_no_refetch(client):
    tc, _ = client
    tc.get("/coding-cli/latest")
    assert _FakeClient.registry_get_count() == 3
    r2 = tc.get("/coding-cli/latest")
    assert r2.status_code == 200
    assert r2.json()["items"]["qwen-code"]["latest"] == "0.25.2"
    assert _FakeClient.registry_get_count() == 3  # 命中缓存


# ── C5 refresh=1 强制重查 ────────────────────────────────────────────
def test_latest_refresh_refetches(client):
    tc, _ = client
    tc.get("/coding-cli/latest")
    assert _FakeClient.registry_get_count() == 3
    r = tc.get("/coding-cli/latest?refresh=1")
    assert r.status_code == 200
    assert _FakeClient.registry_get_count() == 6  # 重查 3 个


# ── C6 registry 500 → 该项 error，HTTP 恒 200 ───────────────────────
def test_latest_registry_500_degrades(client):
    tc, _ = client
    _FakeClient.get_spec = _default_get_spec({
        "/@qwen-code/qwen-code/latest": (500, {"message": "down"}),
    })
    r = tc.get("/coding-cli/latest")
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["items"]["qwen-code"]["latest"] is None
    assert "registry 500" in b["items"]["qwen-code"]["error"]
    # 其余 CLI 正常。
    assert b["items"]["opencode"]["latest"] == "1.19.3"


# ── C7 registry 响应非 JSON → 该项 error ─────────────────────────────
def test_latest_non_json_degrades(client):
    tc, _ = client
    _FakeClient.get_spec = _default_get_spec({
        "/opencode-ai/latest": (200, None, b"", b"<html>not json</html>"),
    })
    r = tc.get("/coding-cli/latest")
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["items"]["opencode"]["latest"] is None
    assert b["items"]["opencode"]["error"]
    assert b["items"]["qoder"]["latest"] == "1.1.73"


# ── C8 指定子集只查该子集 ───────────────────────────────────────────
def test_latest_subset_only(client):
    tc, _ = client
    r = tc.get("/coding-cli/latest?clis=qwen-code,opencode")
    assert r.status_code == 200, r.text
    b = r.json()
    assert set(b["items"]) == {"qwen-code", "opencode"}
    assert _FakeClient.registry_get_count() == 2  # 只查 2 个
