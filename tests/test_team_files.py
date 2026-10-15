# -*- coding: utf-8 -*-
"""#87 团队共享文件端点回归（team-files 列取 / team-file 单文件读）。

数据通道 = KB 域同款（Controller Docker 代理 × admin token）：
team→/api/v1/workers（team 字段）→worker 容器→shared 根探测→
find -H 列取 / archive 单文件读。

护栏：
- 列取：dirs+files 分区、key 相对 shared 根、隐藏项/敏感过滤、
  prefix 子目录导航（key 带前缀）。
- 穿越：team 名 / prefix / key 非法段（..、斜杠）→ 400。
- 读文件：tar 单条目 → 文本 200；二进制（NUL）→ 415；
  敏感直读 → 404（反探测）；team 不存在 → 404。
- L2（非 admin token）：Docker 网关 403 → 诚实 403（无假兜底）。
"""
from __future__ import annotations

import io
import json
import tarfile

import pytest

from conftest import patch_shared_name

from agentteams_connector import config as cfgmod
from agentteams_connector.router import build_router

WORKER = "data-analyst"
CONTAINER = f"agentteams-worker-{WORKER}"
SHARED = (f"/root/agentteams-fs/agents/{WORKER}"
          "/.qwenpaw/workspaces/default/shared")

# A0 探针同款 find -printf 输出（起始行 %P 为空=目标目录自身，须跳过）。
FIND_TOP = (
    "d 4096 1791665596.8607852230 \n"
    "d 4096 1791665596.8732608960 tasks\n"
    "d 4096 1789999449.3908682800 cross-projects\n"
    "f 0 1791665596.8607852230 .agentteams-keep\n"
    "d 4096 1791665596.8617852520 projects\n"
    "f 1234 1791665590.0 plan.md\n"
    "f 9 1791665590.0 credentials.yaml\n"
)
FIND_PROJECTS = (
    "d 4096 1791665596.9000000000 \n"
    "d 4096 1791665596.9100000000 alpha\n"
    "f 100 1791665596.9200000000 notes.md\n"
)


def _frame(payload: bytes, stream: int = 1) -> bytes:
    """Docker exec 多路复用帧（8 字节头 + payload）。"""
    return bytes([stream, 0, 0, 0]) + len(payload).to_bytes(4, "big") + payload


def _tar_single(name: str, payload: bytes) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        info = tarfile.TarInfo(name)
        info.size = len(payload)
        info.mtime = 1791665590
        tf.addfile(info, io.BytesIO(payload))
    return buf.getvalue()


class _Resp:
    def __init__(self, status_code: int, json_body=None, content: bytes = b""):
        self.status_code = status_code
        self._j = json_body
        self.content = content
        self.headers = {}
        self.text = content.decode("utf-8", "replace") if content else ""

    def json(self):
        if self._j is None:
            raise AttributeError("no json body")
        return self._j


class _FakeClient:
    calls: list = []
    get_spec: dict = {}      # url 子串 → (status, json|None, content?)
    exec_spec: list = []     # [(cmd 子串, stdout str)] 首个命中优先

    def __init__(self, *a, **k):
        self.last_cmd: list = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a, **k):
        return False

    def _match_get(self, url):
        for key, val in _FakeClient.get_spec.items():
            if key in url:
                st = val[0]
                body = val[1] if len(val) > 1 else None
                content = val[2] if len(val) > 2 else b""
                return _Resp(st, body, content)
        return _Resp(404)

    async def get(self, url, headers=None, **k):
        _FakeClient.calls.append(("GET", url))
        return self._match_get(url)

    async def head(self, url, headers=None, **k):
        _FakeClient.calls.append(("HEAD", url))
        return _Resp(404)

    async def post(self, url, json=None, headers=None, **k):
        _FakeClient.calls.append(("POST", url))
        if url.endswith("/exec"):
            self.last_cmd = (json or {}).get("Cmd", [])
            return _Resp(201, {"Id": "exec-1"})
        if "/exec/exec-1/start" in url:
            cmd_s = " ".join(self.last_cmd or [])
            for key, out in _FakeClient.exec_spec:
                if key in cmd_s:
                    return _Resp(200, content=_frame(out.encode()))
            return _Resp(200, content=_frame(b""))
        return _Resp(404)

    async def request(self, method, url, json=None, headers=None, **k):
        # ctl_client.ctl_json 走 client.request（method 参数化）。
        if method.upper() == "GET":
            return await self.get(url, headers=headers)
        if method.upper() == "POST":
            return await self.post(url, json=json, headers=headers)
        return _Resp(405)


WORKERS = [
    {"name": WORKER, "team": "biz-team"},
    {"name": "other", "team": "sysdev-team"},
]


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
    _FakeClient.calls = []
    _FakeClient.get_spec = {
        "api/v1/workers": (200, WORKERS),
        "/json": (200, {}),
    }
    _FakeClient.exec_spec = [
        ("for c in", SHARED + "\n"),
        (f"find -H {SHARED}/projects -maxdepth 1", FIND_PROJECTS),
        (f"find -H {SHARED} -maxdepth 1", FIND_TOP),
    ]
    patch_shared_name(
        monkeypatch, "GatedAsyncClient", lambda *a, **k: _FakeClient(*a, **k)
    )
    app = FastAPI()
    app.include_router(build_router())
    return TestClient(app), state


# ── 列取 ────────────────────────────────────────────────────────────
def test_team_files_list_dirs_files_filtered(client):
    """dirs+files 分区、key 相对根、隐藏项与敏感文件过滤、目录优先排序。"""
    tc, _ = client
    r = tc.get("/team-files", params={"team": "biz-team"})
    assert r.status_code == 200, r.text
    entries = r.json()
    assert [e["name"] for e in entries] == [
        "cross-projects", "projects", "tasks", "plan.md"]
    assert [e["key"] for e in entries] == [
        "cross-projects", "projects", "tasks", "plan.md"]
    assert [e["isPrefix"] for e in entries] == [True, True, True, False]
    assert entries[3]["size"] == 1234
    # 隐藏项 + 敏感文件不入列
    assert not any(e["name"] == ".agentteams-keep" for e in entries)
    assert not any(e["name"] == "credentials.yaml" for e in entries)


def test_team_files_list_prefix_nav(client):
    """prefix 子目录导航：find 目标带前缀，key 拼回前缀。"""
    tc, _ = client
    r = tc.get("/team-files", params={"team": "biz-team", "prefix": "projects"})
    assert r.status_code == 200, r.text
    entries = r.json()
    assert [e["key"] for e in entries] == ["projects/alpha", "projects/notes.md"]
    assert [e["isPrefix"] for e in entries] == [True, False]
    # find 确实带上了 prefix 目标（exec 命令面）
    find_calls = [c for c in _FakeClient.calls if c[0] == "POST"
                  and c[1].endswith("/exec")]
    assert find_calls, "未发生 find exec"


def test_team_files_prefix_trailing_slash_normalized(client):
    tc, _ = client
    r = tc.get("/team-files", params={"team": "biz-team", "prefix": "projects/"})
    assert r.status_code == 200, r.text
    assert [e["key"] for e in r.json()] == ["projects/alpha", "projects/notes.md"]


# ── 校验（穿越 400）─────────────────────────────────────────────────
@pytest.mark.parametrize("bad_team", ["../etc", "a/b", "..", "", "x\\y"])
def test_team_files_bad_team_400(client, bad_team):
    tc, _ = client
    r = tc.get("/team-files", params={"team": bad_team})
    assert r.status_code == 400, r.text


@pytest.mark.parametrize("bad_key", ["../../x", "a/../../b", "a\\b", ""])
def test_team_file_bad_key_400(client, bad_key):
    tc, _ = client
    r = tc.get("/team-file", params={"team": "biz-team", "key": bad_key})
    assert r.status_code == 400, r.text


# ── 读文件 ──────────────────────────────────────────────────────────
def test_team_file_read_text(client):
    tc, _ = client
    _FakeClient.get_spec[f"archive?path={SHARED}/plan.md"] = (
        200, None, _tar_single("plan.md", b"hello shared"))
    r = tc.get("/team-file", params={"team": "biz-team", "key": "plan.md"})
    assert r.status_code == 200, r.text
    assert r.text == "hello shared"
    assert "text/plain" in r.headers["content-type"]


def test_team_file_read_nested_key(client):
    tc, _ = client
    _FakeClient.get_spec[
        f"archive?path={SHARED}/projects/notes.md"] = (
        200, None, _tar_single("notes.md", b"n1\nn2"))
    r = tc.get("/team-file",
               params={"team": "biz-team", "key": "projects/notes.md"})
    assert r.status_code == 200, r.text
    assert r.text == "n1\nn2"


def test_team_file_binary_415(client):
    tc, _ = client
    _FakeClient.get_spec[f"archive?path={SHARED}/blob.bin"] = (
        200, None, _tar_single("blob.bin", b"\x00\x01\x02\x03"))
    r = tc.get("/team-file", params={"team": "biz-team", "key": "blob.bin"})
    assert r.status_code == 415, r.text


def test_team_file_sensitive_404(client):
    """敏感直读 404（不泄露存在性）——不发 archive 请求。"""
    tc, _ = client
    r = tc.get("/team-file", params={"team": "biz-team", "key": "credentials.yaml"})
    assert r.status_code == 404, r.text
    assert not [u for m, u in _FakeClient.calls
                if m == "GET" and "archive" in u]


def test_team_file_missing_404(client):
    tc, _ = client
    # archive 404 → 文件不存在
    _FakeClient.get_spec[f"archive?path={SHARED}/nope.md"] = (404, None)
    r = tc.get("/team-file", params={"team": "biz-team", "key": "nope.md"})
    assert r.status_code == 404, r.text


# ── team 解析 / 作用域 ──────────────────────────────────────────────
def test_team_files_unknown_team_404(client):
    tc, _ = client
    r = tc.get("/team-files", params={"team": "ghost-team"})
    assert r.status_code == 404, r.text


def test_team_files_l2_forbidden_403(client):
    """L2 token（Docker 网关 403）→ 诚实 403，无假兜底。"""
    tc, _ = client
    _FakeClient.get_spec = {
        "api/v1/workers": (200, WORKERS),
        "/json": (403, None),
    }
    r = tc.get("/team-files", params={"team": "biz-team"})
    assert r.status_code == 403, r.text
    assert "管理员" in r.text
