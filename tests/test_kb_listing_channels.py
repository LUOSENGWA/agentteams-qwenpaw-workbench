# -*- coding: utf-8 -*-
"""KB 目录列取双通道回归测试（v0.5.0-beta.13.9 真根因修）。

背景（真机反馈 9/22）：worker 工作区总体积 >20MB（实测 180MB）→ 旧版
kb_tree 顶层（worker 支）/ memory / digest 子树全走「先整目录递归 tar
下载完、下载完才查大小」→ 413「工作区顶层超过 20MB，无法列取」。

真根因修 = 列取路径不再依赖整树下载：
- 主通道  _kb_find_list：exec find（零下载，manager live 大工作区生产
  已验证的链路）；
- 兜底    _kb_tar_list ：Docker archive tar（小工作区保留旧精确解析 +
  413 守卫，仅主通道失败时可达）。

本文件护栏：

- **大工作区无 413 且零下载**：180MB 级工作区顶层 + 30MB 单文件 → 200，
  且不发任何 archive GET（主通道零下载实证）。
- **mtime 真值**：find %T@ 落地（旧 manager 支 mtime=0）。
- **敏感过滤/隐藏项/②③ 专属分类**：顶层目录不含 memory/digest、
  credentials.yaml 不入列、隐藏项不入列（旧语义保持）。
- **exec 挂 → tar 兜底**：/exec 500 → 切 archive，小工作区精确解析
  （深度过滤：顶层列取只返一层）。
- **兜底超限 413 守卫保留**：exec 挂 + tar >20MB → 413（兜底路径
  才可达，主通道正常时永不触达）。
- **kb_ls 懒加载**：一级条目 + 目录可继续展开；零下载。
- **kb_ls 目录不存在 404**：exec 空输出 + HEAD 404 → 404（不误报
  502）；空目录 HEAD 200 → 200 空清单（旧版误 404 的改善）。
- **kb_ls exec 挂 + tar 404 → 404**（通道失败与路径不存在区分）。
"""
from __future__ import annotations

import io
import json
import tarfile

import pytest

from agentteams_connector import config as cfgmod
from agentteams_connector.router import build_router

WS = "/root/agentteams-fs/agents/big/.qwenpaw/workspaces/default"
MAXTAR = 20 * 1024 * 1024

TOP_FIND = (
    "f 1234 1758000000.0 AGENTS.md\n"
    "f 31457280 1758000001.0 bigfile.bin\n"
    "d 4096 1758000002.0 memory\n"
    "d 4096 1758000003.0 digest\n"
    "f 55 1758000004.0 .hidden\n"
    "d 4096 1758000005.0 docs\n"
)
MEM_FIND = (
    "f 100 1758000100.5 2026-09-22.md\n"
    "f 66 1758000101.0 2026-09-21.md\n"
    "f 10 1758000102.0 sub/topic.md\n"
    "f 9 1758000103.0 credentials.yaml\n"
)
DIG_FIND = "f 200 1758000200.0 wiki/x.md\n"


def _frame(payload: bytes, stream: int = 1) -> bytes:
    """Docker exec 多路复用帧（8 字节头 + payload）。"""
    return bytes([stream, 0, 0, 0]) + len(payload).to_bytes(4, "big") + payload


def _tar(root: str, members: dict) -> bytes:
    """构造 Docker archive 形态 tar：root=所请求路径 basename 前缀。
    members={相对路径: 字节|None(目录)}。"""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        for rel, payload in members.items():
            full = f"{root}/{rel}" if rel else root
            info = tarfile.TarInfo(full)
            if payload is None:
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                tf.addfile(info)
            else:
                info.size = len(payload)
                info.mtime = 1758000000
                tf.addfile(info, io.BytesIO(payload))
    return buf.getvalue()


class _Resp:
    def __init__(self, status_code: int, json_body=None, content: bytes = b""):
        self.status_code = status_code
        self._j = json_body
        self.content = content
        self.headers = {}

    def json(self):
        if self._j is None:
            raise AttributeError("no json body")
        return self._j


class _FakeClient:
    calls: list = []
    get_spec: dict = {}      # url 子串 → (status, json|None, content?)
    head_spec: dict = {}     # url 子串 → status
    exec_spec: list = []     # [(cmd 子串, stdout str)] 首个命中优先
    exec_create_status: int = 201

    def __init__(self, *a, **k):
        self.last_cmd: list = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a, **k):
        return False

    async def get(self, url, headers=None, **k):
        _FakeClient.calls.append(("GET", url))
        for key, val in _FakeClient.get_spec.items():
            if key in url:
                st = val[0]
                body = val[1] if len(val) > 1 else None
                content = val[2] if len(val) > 2 else b""
                return _Resp(st, body, content)
        return _Resp(404)

    async def head(self, url, headers=None, **k):
        _FakeClient.calls.append(("HEAD", url))
        for key, st in _FakeClient.head_spec.items():
            if key in url:
                return _Resp(st)
        return _Resp(404)

    async def post(self, url, json=None, headers=None, **k):
        _FakeClient.calls.append(("POST", url))
        if url.endswith("/exec"):
            if _FakeClient.exec_create_status != 201:
                return _Resp(_FakeClient.exec_create_status)
            self.last_cmd = (json or {}).get("Cmd", [])
            return _Resp(201, {"Id": "exec-1"})
        if "/exec/exec-1/start" in url:
            cmd_s = " ".join(self.last_cmd or [])
            for key, out in _FakeClient.exec_spec:
                if key in cmd_s:
                    return _Resp(200, content=_frame(out.encode()))
            return _Resp(200, content=_frame(b""))
        return _Resp(404)


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
    _FakeClient.get_spec = {"/json": (200, {})}
    _FakeClient.head_spec = {f"archive?path={WS}": 200}
    _FakeClient.exec_spec = []
    _FakeClient.exec_create_status = 201

    monkeypatch.setattr(
        "agentteams_connector.router.httpx.AsyncClient",
        lambda *a, **k: _FakeClient(*a, **k),
    )
    app = FastAPI()
    app.include_router(build_router())
    return TestClient(app), state


def _archive_gets() -> list:
    return [u for m, u in _FakeClient.calls
            if m == "GET" and "archive" in u]


def _dir_archive_gets() -> list:
    """目录级 archive GET（整树/整子树下载）——修复目标面。
    ④ 档案兜底的单文件 archive GET（≤5 次、文件天然小）是既有行为，
    不在断言面内。"""
    return [u for u in _archive_gets()
            if u.endswith(f"archive?path={WS}")
            or u.endswith(f"archive?path={WS}/memory")
            or u.endswith(f"archive?path={WS}/digest")]


def _exec_find_spec():
    return [
        (f"find {WS}/memory", MEM_FIND),
        (f"find {WS}/digest", DIG_FIND),
        (f"find {WS} -maxdepth 1", TOP_FIND),
    ]


# ── 主通道：大工作区零下载无 413 ────────────────────────────────────────
def test_tree_large_workspace_exec_primary_zero_download(client):
    """180MB 级工作区 + 30MB 单文件：旧版必 413，新版 200 且零下载。"""
    tc, _ = client
    _FakeClient.exec_spec = _exec_find_spec()
    r = tc.get("/kb/big/tree")
    assert r.status_code == 200, r.text
    body = r.json()
    files = {f["path"]: f for f in body["files"]}
    # 200 = 核心（旧版整树 tar 到 20MB 就 413，连一个文件都拿不到）；
    # 顶层文本过滤口径不变（KB 树只列知识文本，bigfile.bin 不入列=预期）
    assert "bigfile.bin" not in files
    assert "AGENTS.md" in files
    # 档案分类 + mtime 真值（旧 manager 支恒 0）
    assert files["AGENTS.md"]["category"] == "profile"
    assert files["AGENTS.md"]["mtime"] == 1758000000
    # memory/digest 子树递归 + 分类
    assert files["memory/2026-09-22.md"]["category"] == "daily"
    assert files["memory/2026-09-22.md"]["mtime"] == 1758000100
    assert files["memory/sub/topic.md"]["category"] == "daily"
    assert files["digest/wiki/x.md"]["category"] == "digest"
    # 敏感过滤（credentials.yaml）+ 隐藏项（.hidden）
    assert "memory/credentials.yaml" not in files
    assert ".hidden" not in files
    # 顶层目录：memory/digest 专属分类不入 dirs
    assert {d["path"] for d in body["dirs"]} == {"docs"}
    # 核心：主通道零目录下载——无整树/整子树 archive GET
    assert _dir_archive_gets() == [], _dir_archive_gets()
    assert body["count"] == len(files)


# ── 兜底通道：exec 挂 → tar 精确解析 ────────────────────────────────────
def test_tree_exec_down_tar_fallback(client):
    """/exec 500 → 切 archive 兜底：顶层只返一层、子树全递归。"""
    tc, _ = client
    _FakeClient.exec_create_status = 500
    top_tar = _tar("default", {
        "AGENTS.md": b"agents",
        "MEMORY.md": b"mem",
        "docs": None,
        "docs/notes.md": b"notes",   # 深度 2 → 顶层列取不返
        ".hidden": b"h",
        "bigfile.bin": b"b" * 100,
    })
    mem_tar = _tar("memory", {
        "2026-09-22.md": b"x" * 100,
        "credentials.yaml": b"c",
    })
    dig_tar = _tar("digest", {"wiki/x.md": b"y" * 200})
    # 更具体的键在前（archive?path=WS 是 archive?path=WS/memory 的子串）；
    # ④ 档案兜底 6 文件（顶层 tar 未含者）→ 404（不存在，不返顶层 tar）
    _FakeClient.get_spec = {
        "/json": (200, {}),
        f"archive?path={WS}/memory": (200, None, mem_tar),
        f"archive?path={WS}/digest": (200, None, dig_tar),
        f"archive?path={WS}/SOUL.md": (404, None),
        f"archive?path={WS}/PROFILE.md": (404, None),
        f"archive?path={WS}/HEARTBEAT.md": (404, None),
        f"archive?path={WS}/BOOTSTRAP.md": (404, None),
        f"archive?path={WS}": (200, None, top_tar),
    }
    r = tc.get("/kb/big/tree")
    assert r.status_code == 200, r.text
    files = {f["path"]: f for f in r.json()["files"]}
    assert files["AGENTS.md"]["category"] == "profile"
    assert files["MEMORY.md"]["category"] == "profile"
    assert "bigfile.bin" not in files  # 顶层文本过滤口径不变
    assert "docs/notes.md" not in files  # 顶层列取只返一层
    assert files["memory/2026-09-22.md"]["category"] == "daily"
    assert "memory/credentials.yaml" not in files
    assert files["digest/wiki/x.md"]["category"] == "digest"
    assert {d["path"] for d in r.json()["dirs"]} == {"docs"}
    # 兜底确走目录 archive（顶层/memory/digest 三次；④ 单文件 404 探
    # 索 SOUL/PROFILE/HEARTBEAT/BOOTSTRAP 4 次=既有行为，不在断言面）
    assert len(_dir_archive_gets()) == 3, _dir_archive_gets()


def test_tree_fallback_tar_over_limit_413(client):
    """exec 挂 + 兜底 tar >20MB → 413 守卫保留（仅兜底路径可触达）。"""
    tc, _ = client
    _FakeClient.exec_create_status = 500
    _FakeClient.get_spec = {
        "/json": (200, {}),
        f"archive?path={WS}": (200, None, b"\x00" * (MAXTAR + 1)),
    }
    r = tc.get("/kb/big/tree")
    assert r.status_code == 413, r.text
    assert "20MB" in r.text


# ── kb_ls 懒加载 ────────────────────────────────────────────────────────
def test_ls_lazy_one_level_zero_download(client):
    tc, _ = client
    _FakeClient.exec_spec = [
        (f"find {WS} -maxdepth 1", TOP_FIND),
    ]
    r = tc.get("/kb/big/ls")
    assert r.status_code == 200, r.text
    body = r.json()
    names = {f["name"] for f in body["files"]}
    assert names == {"AGENTS.md"}  # 只文本文件；bigfile.bin/.hidden 不入
    assert {d["name"] for d in body["dirs"]} == {"memory", "digest", "docs"}
    assert _archive_gets() == []

    # 展开 memory 子层
    _FakeClient.exec_spec = [
        (f"find {WS}/memory -maxdepth 1",
         "f 100 1758000100.5 2026-09-22.md\n"
         "f 9 1758000103.0 credentials.yaml\n"
         "d 4096 1758000104.0 sub\n"),
    ]
    r2 = tc.get("/kb/big/ls", params={"dir": "memory"})
    assert r2.status_code == 200, r2.text
    b2 = r2.json()
    assert [f["path"] for f in b2["files"]] == ["memory/2026-09-22.md"]
    assert [d["path"] for d in b2["dirs"]] == ["memory/sub"]


def test_ls_missing_dir_404(client):
    """exec 通道正常但输出空（find 报错走 stderr）+ HEAD 404 → 404。"""
    tc, _ = client
    _FakeClient.exec_spec = [(f"find {WS}/nope -maxdepth 1", "")]
    _FakeClient.head_spec = {
        # 更具体的键在前（archive?path=WS 是 archive?path=WS/nope 的子串）
        f"archive?path={WS}/nope": 404,
        f"archive?path={WS}": 200,
    }
    r = tc.get("/kb/big/ls", params={"dir": "nope"})
    assert r.status_code == 404, r.text
    assert "目录不存在" in r.text


def test_ls_empty_dir_200(client):
    """exec 空输出 + HEAD 200 → 空目录 200（旧版误报 404 的改善）。"""
    tc, _ = client
    _FakeClient.exec_spec = [(f"find {WS}/empty -maxdepth 1", "")]
    _FakeClient.head_spec = {
        f"archive?path={WS}": 200,
        f"archive?path={WS}/empty": 200,
    }
    r = tc.get("/kb/big/ls", params={"dir": "empty"})
    assert r.status_code == 200, r.text
    assert r.json()["files"] == []
    assert r.json()["dirs"] == []


def test_ls_exec_down_tar_404_is_404(client):
    """exec 挂 + 兜底 tar 404 → 404（不把通道失败误报成 502/500）。"""
    tc, _ = client
    _FakeClient.exec_create_status = 500
    _FakeClient.get_spec = {
        "/json": (200, {}),
        f"archive?path={WS}/nope2": (404, None),
    }
    r = tc.get("/kb/big/ls", params={"dir": "nope2"})
    assert r.status_code == 404, r.text
    assert "目录不存在" in r.text
