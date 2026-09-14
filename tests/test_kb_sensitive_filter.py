# -*- coding: utf-8 -*-
"""KB 敏感文件过滤回归测试（v0.5.0-beta.12.3）。

背景（产物部分对齐 dashboard）：dashboard ChatRoom 文件面板
（FilesBrowserPanel）用 SENSITIVE_PATTERNS 从 MinIO 树里滤掉
``.hermes/config.yaml`` / ``.ssh/`` / ``credentials/`` / ``openclaw.json`` /
``*.lock``。插件 KB 走容器 archive/exec，隐藏文件（.ssh/、.hermes/）各列取
点已 skip，但非隐藏部分此前缺失——openclaw.json（runtime 配置，含 provider
信息）可经 /kb/{agent}/file 直读。

本文件护栏：

- 敏感路径直读 → 404「文件不存在」（不泄露存在性，W8 反探测同款），
  且**不发起任何 docker 调用**（guard 在数据通道之前）。
- 非敏感路径（MEMORY.md）→ guard 不触发，继续走数据通道（docker 调用发生）。
"""
from __future__ import annotations

import json

import pytest

from agentteams_connector import config as cfgmod
from agentteams_connector.router import build_router


class _FakeResponse:
    def __init__(self, status_code: int, json_body: object = None,
                 content: bytes = b""):
        self.status_code = status_code
        self.headers = {}
        self._json_body = json_body
        # docker archive/inspect 通道（_kb_docker）读 .content，非 .json()
        self.content = content

    def json(self):
        if self._json_body is None:
            raise AttributeError("no json body")
        return self._json_body


class _FakeClient:
    instances: list[["_FakeClient"]] = []
    get_spec: dict = {}

    def __init__(self, *a, **k):
        self.calls: list[tuple[str, str]] = []
        _FakeClient.instances.append(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a, **k):
        return False

    async def get(self, url, headers=None, **k):
        self.calls.append(("GET", url))
        for key, resp in _FakeClient.get_spec.items():
            if key in url:
                return resp
        return _FakeResponse(404)


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

    def fake_client_cls(*a, **k):
        return _FakeClient(*a, **k)

    monkeypatch.setattr(
        "agentteams_connector.router.httpx.AsyncClient", fake_client_cls
    )

    app = FastAPI()
    app.include_router(build_router())
    return TestClient(app), state


def _docker_call_count() -> int:
    return sum(
        1
        for inst in _FakeClient.instances
        for method, url in inst.calls
        if method == "GET" and "/containers/" in url
    )


@pytest.mark.parametrize(
    "path",
    [
        "credentials/secret.txt",
        "credentials",
        "openclaw.json",
        "memory/2026-09-13.md.lock",
        ".hermes/config.yaml",
    ],
)
def test_kb_file_sensitive_paths_404_no_docker(client, path):
    """敏感路径 → 404 且 guard 在数据通道之前（零 docker 调用）。"""
    tc, _ = client
    r = tc.get("/kb/test-agent/file", params={"path": path})
    assert r.status_code == 404, r.text
    assert "文件不存在" in r.text
    assert _docker_call_count() == 0, "敏感 guard 必须拦截在任何 docker 调用前"


def test_kb_file_normal_path_passes_guard(client):
    """非敏感路径（MEMORY.md）→ guard 不触发，继续走数据通道。"""
    tc, _ = client
    r = tc.get("/kb/test-agent/file", params={"path": "MEMORY.md"})
    # guard 未触发 → 请求落到 docker 通道（_kb_workspace 先打
    # /containers/{name}/json；fake 404 → 「容器不存在」。关键断言是
    # docker 调用**发生了**，证明 guard 只拦敏感路径、放行普通路径）。
    assert _docker_call_count() >= 1, "MEMORY.md 应穿过 guard 进入数据通道"
    assert r.status_code == 404, r.text  # fake 环境容器不存在


def test_kb_file_invalid_path_still_400(client):
    """既有格式校验不被敏感 guard 改变：绝对路径/.. 仍 400。"""
    tc, _ = client
    assert tc.get("/kb/test-agent/file", params={"path": "/etc/passwd"}).status_code == 400
    assert tc.get("/kb/test-agent/file", params={"path": "../x"}).status_code == 400
    assert _docker_call_count() == 0
