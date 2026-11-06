# -*- coding: utf-8 -*-
"""catch-all 代理文件类超时（PATCH-1666b）。

背景（主控实测）：文件上传/下载不走 ctl_json，走 approval_api 的
catch-all 代理，其超时 = router._PROXY_TIMEOUT（read 6s）。控制器侧
PUT 256KB 实测 ~34s（minio 写路径待优化）→ 浏览器 PUT /api/.../humans/
luo/files/job-logs.txt（256KB）必 502「响应超时」。

改法：proxy() 的超时选择由二分支改三分支（顺序固定不可换）：
1. /qrcode/status → _LONG_POLL_TIMEOUT（原样）；
2. controller 文件读写（_is_controller_file_io）→ _FILE_PROXY_TIMEOUT
   （connect 5s / read 120s / write 120s / pool 5s）；
3. 其余 → _PROXY_TIMEOUT（原样）。

护栏：
- _is_controller_file_io 纯函数四例（PUT/GET humans+files → True；
  GET /teams、DELETE → False）+ 大小写/缺省方法边界。
- 静态源码断言：proxy_timeout 赋值块内三分支常量按序
  （_LONG_POLL_TIMEOUT < _FILE_PROXY_TIMEOUT < _PROXY_TIMEOUT），
  且文件分支带 target == "controller" 门控。
- 行为断言：假 GatedAsyncClient 捕获 timeout kwarg——PUT 文件上传
  拿到 _FILE_PROXY_TIMEOUT、普通 GET 拿到 _PROXY_TIMEOUT、qrcode
  长轮询仍拿 _LONG_POLL_TIMEOUT、matrix 同名 /files/ 路径不被误判。
"""
from __future__ import annotations

import json
import pathlib
import re

import pytest

from conftest import patch_shared_name

from agentteams_connector import config as cfgmod
from agentteams_connector import router as router_mod
from agentteams_connector.routers import approval_api

LAN = "http://10.0.0.1:8090"


# ── ① 纯函数判定 ─────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("method", "path", "expected"),
    [
        # 任务书四例
        ("PUT", "/api/v1/humans/luo/files/a.txt", True),
        ("GET", "/api/v1/humans/luo/files/a.txt", True),
        ("GET", "/api/v1/teams", False),
        ("DELETE", "/api/v1/humans/luo/files/a.txt", False),
        # 边界：POST 上传同路径 / 小写方法 / 缺省方法 / 非文件 PUT
        ("POST", "/api/v1/humans/luo/files/a.txt", True),
        ("put", "/api/v1/humans/luo/files/a.txt", True),
        ("", "/api/v1/humans/luo/files/a.txt", False),
        ("PUT", "/api/v1/teams", False),
    ],
)
def test_is_controller_file_io(method, path, expected):
    assert approval_api._is_controller_file_io(method, path) is expected


# ── ② 静态断言：三分支顺序 + target 门控 ─────────────────────────────


def test_proxy_timeout_branch_order_static():
    """proxy_timeout 赋值块内：长轮询 → 文件 → 通用，顺序不可换；
 文件分支必须带 target == "controller" 门控（matrix 同名 /files/ 防误判）。"""
    src = pathlib.Path(approval_api.__file__).read_text(encoding="utf-8")
    m = re.search(r"proxy_timeout\s*=\s*\(", src)
    assert m, "proxy_timeout 赋值块未找到"
    block = src[m.end():]
    i_long = block.index("_LONG_POLL_TIMEOUT")
    i_file = block.index("_FILE_PROXY_TIMEOUT")
    m_plain = re.search(r"(?<!_FILE)_PROXY_TIMEOUT", block)
    assert m_plain, "通用分支 _PROXY_TIMEOUT 缺失"
    assert (
        i_long < i_file < m_plain.start()
    ), "三分支顺序应为 长轮询 → 文件 → 通用"
    assert 'target == "controller"' in block, "文件分支缺 controller 门控"


# ── ③ 行为断言：proxy() 实际传入的 timeout 常量 ─────────────────────


class _Resp:
    def __init__(
        self,
        status_code: int = 200,
        content: bytes = b'{"ok":true}',
        headers: dict | None = None,
    ):
        self.status_code = status_code
        self.content = content
        self.headers = headers or {"content-type": "application/json"}

    def json(self):
        return json.loads(self.content.decode("utf-8", "replace"))

    @property
    def text(self) -> str:
        return self.content.decode("utf-8", "replace")


class _TClient:
    """httpx.AsyncClient 替身：恒 200，timeout 由 fixture 工厂捕获。"""

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a, **k):
        return False

    async def request(self, method: str, url: str, **k) -> _Resp:
        return _Resp(200)


@pytest.fixture
def p66(monkeypatch):
    state = {
        "controller_urls": [LAN],
        "controller_token": "ctok",
        "matrix_homeservers": [LAN],
        "matrix": {},
    }

    def fake_load():
        return json.loads(json.dumps(state))

    monkeypatch.setattr(cfgmod, "load_config", fake_load)
    timeouts: list = []

    def factory(*a, **k):
        timeouts.append(k.get("timeout"))
        return _TClient()

    patch_shared_name(monkeypatch, "GatedAsyncClient", factory)
    monkeypatch.setattr(router_mod, "_working_cache", {})
    return timeouts


def _app():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(router_mod.build_router())
    return TestClient(app)


def test_proxy_put_file_upload_uses_file_timeout(p66):
    """浏览器实案路径：PUT /api/v1/humans/luo/files/job-logs.txt（非
 JSON 体，走 raw_body 透传）→ 必须拿到 _FILE_PROXY_TIMEOUT。"""
    with _app() as tc:
        r = tc.put(
            "/controller/api/v1/humans/luo/files/job-logs.txt",
            content=b"x" * 1024,
        )
    assert r.status_code == 200
    assert p66, "代理未拨号"
    assert p66[-1] is approval_api._FILE_PROXY_TIMEOUT
    t = p66[-1]
    assert (t.connect, t.read, t.write, t.pool) == (5.0, 120.0, 120.0, 5.0)


def test_proxy_get_file_download_uses_file_timeout(p66):
    with _app() as tc:
        r = tc.get("/controller/api/v1/humans/luo/files/a.txt")
    assert r.status_code == 200
    assert p66[-1] is approval_api._FILE_PROXY_TIMEOUT


def test_proxy_plain_get_keeps_generic_timeout(p66):
    with _app() as tc:
        r = tc.get("/controller/api/v1/teams")
    assert r.status_code == 200
    assert p66[-1] is approval_api._PROXY_TIMEOUT
    t = p66[-1]
    assert (t.connect, t.read, t.write, t.pool) == (3.0, 6.0, 10.0, 3.0)


def test_proxy_qrcode_status_keeps_long_poll_timeout(p66):
    """分支①优先级：qrcode/status 长轮询不变。"""
    with _app() as tc:
        r = tc.get("/controller/api/v1/ilink/qrcode/status")
    assert r.status_code == 200
    assert p66[-1] is approval_api._LONG_POLL_TIMEOUT


def test_proxy_matrix_files_path_not_misjudged(p66):
    """target 门控：matrix 的 /files/ 路径（rooms/{id}/files/{mxcId}
 同形）不得吃到文件超时，仍走通用 _PROXY_TIMEOUT。"""
    with _app() as tc:
        r = tc.get("/matrix/rooms/!r:example/files/mxc://example/abc")
    assert r.status_code == 200
    assert p66[-1] is approval_api._PROXY_TIMEOUT
