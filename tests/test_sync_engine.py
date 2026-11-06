# -*- coding: utf-8 -*-
"""文件镜像同步引擎（file_sync_engine）离线单测。

全部用 fake ctl_call（记录调用 + 剧本应答），不碰真实网络/控制器。
覆盖任务书 7 条硬门 + 工作区解析 + 异常吞噬。
"""
from __future__ import annotations

import json
import os

import pytest

from agentteams_connector import file_sync_engine as fse
from agentteams_connector.file_sync_engine import (
    HttpResult,
    SyncEngine,
    _iso,
    _utc_stamp,
)

HUMAN = "luo"
BASE = f"/api/v1/humans/{HUMAN}"


class Clock:
    """固定时钟（now 注入）。"""

    def __init__(self, t: float = 1_760_000_000.0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


class FakeCtl:
    """记录全部调用；responder(method, path, **kw) -> HttpResult。"""

    def __init__(self, responder) -> None:
        self.responder = responder
        self.calls: list = []

    def __call__(self, method, path, **kw) -> HttpResult:
        self.calls.append((method.upper(), path, kw))
        return self.responder(method.upper(), path, **kw)

    @property
    def call_count(self) -> int:
        return len(self.calls)


def jresult(status: int, obj, headers=None) -> HttpResult:
    return HttpResult(
        status, dict(headers or {}), json.dumps(obj, ensure_ascii=False).encode()
    )


def bresult(status: int, data: bytes, headers=None) -> HttpResult:
    return HttpResult(status, dict(headers or {}), data)


def local_rec(path) -> dict:
    st = path.stat()
    return {"mtime": st.st_mtime, "size": st.st_size}


def make_engine(
    tmp_path,
    fake: FakeCtl,
    clock: Clock,
    *,
    state: dict | None = None,
    files: dict | None = None,
    human: str = HUMAN,
) -> SyncEngine:
    root = tmp_path / "agentteams"
    files_dir = root / "files"
    files_dir.mkdir(parents=True, exist_ok=True)
    (root / ".sync").mkdir(parents=True, exist_ok=True)
    for rel, data in (files or {}).items():
        p = files_dir / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    if state is not None:
        (root / ".sync" / "state.json").write_text(
            json.dumps(state, ensure_ascii=False), encoding="utf-8"
        )
    return SyncEngine(root, human=human, ctl_call=fake, now=clock)


def state_with(gen, etags, local):
    return {
        "humans": {
            HUMAN: {
                "generation": gen,
                "etags": etags,
                "local": local,
                "lastRunAt": "2026-11-06T00:00:00.000Z",
            }
        }
    }


def responder_for(
    *,
    generation,
    manifest=None,
    manifest_etag="M1",
    presign_get=None,   # path -> bytes（200 直读 body）
    put_manifest_status=200,
    presign_post=None,  # path -> {"url":...} | None（None=405 不可用）
):
    def resp(method, path, **kw):
        params = kw.get("params") or {}
        if method == "GET" and path == f"{BASE}/sync/status":
            return jresult(200, {"generation": generation})
        if method == "GET" and path == f"{BASE}/sync/manifest":
            return jresult(200, manifest or {"entries": []}, {"ETag": manifest_etag})
        if method == "PUT" and path == f"{BASE}/sync/manifest":
            return jresult(put_manifest_status, {"ok": True})
        if method == "GET" and path.startswith(f"{BASE}/files/") and params.get("presign") == "1":
            rel = path[len(f"{BASE}/files/"):]
            if rel in (presign_get or {}):
                return bresult(200, presign_get[rel])
            return jresult(404, {"error": "not found"})
        if method == "GET":  # 预签名 url / 无参直读
            return bresult(200, b"remote-bytes")
        if method == "POST" and params.get("presign") == "1":
            rel = path[len(f"{BASE}/files/"):]
            grant = (presign_post or {}).get(rel)
            if grant:
                return jresult(200, grant)
            return jresult(405, {"error": "presign unavailable"})
        if path.endswith("/commit"):
            return jresult(200, {"ok": True})
        if method in ("PUT", "POST"):
            return jresult(200, {"ok": True})
        return jresult(404, {"error": "unhandled"})

    return resp


# ── 1) generation 未变 → skipped，零下载零上传 ───────────────────────


def test_same_generation_skips(tmp_path):
    clock = Clock()
    fake = FakeCtl(
        responder_for(generation=5, manifest={"entries": []})
    )
    eng = make_engine(
        tmp_path, fake, clock, state=state_with(5, {}, {})
    )
    res = eng.run_once()
    assert res["skipped"] == "same-generation"
    # 只调了 status 一次，零下载零上传
    assert fake.call_count == 1
    assert fake.calls[0][0] == "GET"
    assert fake.calls[0][1] == f"{BASE}/sync/status"
    assert not list((eng.root / "files").glob("*"))


# ── 2) status 404 → enabled=False，且只调用一次（不重试） ────────────


def test_status_404_disabled_no_retry(tmp_path):
    clock = Clock()
    fake = FakeCtl(lambda m, p, **kw: jresult(404, {"error": "no manifest api"}))
    eng = make_engine(tmp_path, fake, clock, state=state_with(1, {}, {}))
    res = eng.run_once()
    assert res["enabled"] is False
    assert res["reason"] == "controller_without_manifest"
    assert fake.call_count == 1
    assert fake.calls[0] == ("GET", f"{BASE}/sync/status", {})


# ── 3) 远端新增文件 → 下载落地，内容正确 ─────────────────────────────


def test_remote_new_file_downloaded(tmp_path):
    clock = Clock()
    fake = FakeCtl(
        responder_for(
            generation=2,
            manifest={
                "entries": [
                    {"path": "notes/a.txt", "etag": "e1", "size": 11}
                ]
            },
            manifest_etag="M1",
            presign_get={"notes/a.txt": b"hello world"},
        )
    )
    eng = make_engine(
        tmp_path, fake, clock, state=state_with(1, {}, {})
    )
    res = eng.run_once()
    assert res["downloaded"] == 1
    assert res["changed"] == 1
    assert res.get("error") is None
    got = (eng.root / "files" / "notes" / "a.txt").read_bytes()
    assert got == b"hello world"
    # 清单写回带 If-Match（条件 PUT，#1499）
    put = [c for c in fake.calls if c[0] == "PUT" and c[1] == f"{BASE}/sync/manifest"]
    assert len(put) == 1
    assert put[0][2].get("headers", {}).get("If-Match") == "M1"
    # state 更新：generation=2 + 新 etag
    st = json.loads((eng.root / ".sync" / "state.json").read_text())
    assert st["humans"][HUMAN]["generation"] == 2
    assert st["humans"][HUMAN]["etags"]["notes/a.txt"] == "e1"
    # 二轮：generation 已对齐 → 跳过，零新增 HTTP 文件操作
    res2 = eng.run_once()
    assert res2["skipped"] == "same-generation"


# ── 4) 本地修改 → 触发上传（fake 记录 presign PUT + commit） ─────────


def test_local_change_uploaded(tmp_path):
    clock = Clock()
    root = tmp_path / "agentteams"
    files_dir = root / "files"
    files_dir.mkdir(parents=True)
    p = files_dir / "a.txt"
    p.write_bytes(b"old")
    fake = FakeCtl(
        responder_for(
            generation=2,
            manifest={"entries": [{"path": "a.txt", "etag": "e1", "size": 3}]},
            presign_post={"a.txt": {"url": "https://oss.example/upload-1"}},
        )
    )
    eng = make_engine(
        tmp_path, fake, clock, state=state_with(1, {"a.txt": "e1"}, {"a.txt": local_rec(p)})
    )
    # 本地改动：内容 + mtime 双变
    p.write_bytes(b"old-changed!")
    os.utime(p, (p.stat().st_mtime + 100, p.stat().st_mtime + 100))

    res = eng.run_once()
    assert res["uploaded"] == 1
    assert res["downloaded"] == 0
    assert res.get("error") is None
    # presign 直传（PUT 到预签名 url）+ /commit 两步都被记录
    assert any(
        c[0] == "PUT" and c[1] == "https://oss.example/upload-1" for c in fake.calls
    )
    assert any(c[1] == f"{BASE}/files/a.txt/commit" for c in fake.calls)
    # state 记录本地 etag（local:<sha16>）
    st = json.loads((root / ".sync" / "state.json").read_text())
    assert st["humans"][HUMAN]["etags"]["a.txt"].startswith("local:")


# ── 5) 两侧都改 → 冲突副本 + 主文件为远端版本 + conflicts.log ────────


def test_both_changed_conflict(tmp_path):
    clock = Clock()
    root = tmp_path / "agentteams"
    files_dir = root / "files"
    files_dir.mkdir(parents=True)
    p = files_dir / "b.txt"
    p.write_bytes(b"local-v1")
    fake = FakeCtl(
        responder_for(
            generation=2,
            manifest={"entries": [{"path": "b.txt", "etag": "e2", "size": 9}]},
            manifest_etag="M5",
            presign_get={"b.txt": b"remote-v2"},
            presign_post=None,  # presign 上传不可用 → 走直接 PUT
        )
    )
    eng = make_engine(
        tmp_path, fake, clock, state=state_with(1, {"b.txt": "e1"}, {"b.txt": local_rec(p)})
    )
    p.write_bytes(b"local-v2")
    os.utime(p, (p.stat().st_mtime + 100, p.stat().st_mtime + 100))

    res = eng.run_once()
    assert res["conflicts"] == 1
    assert res.get("error") is None
    # 主文件 = 远端版本
    assert p.read_bytes() == b"remote-v2"
    # 冲突副本：本地版本另存 <name>.conflict-<UTCts> 且已上传
    copies = list(files_dir.glob("b.txt.conflict-*"))
    assert len(copies) == 1
    assert copies[0].name == f"b.txt.conflict-{_utc_stamp(clock())}"
    assert copies[0].read_bytes() == b"local-v2"
    assert any(
        c[0] == "PUT" and f"/files/{copies[0].name}" in c[1] for c in fake.calls
    )
    # conflicts.log 有记录（path + 两侧 etag）
    log = (root / ".sync" / "conflicts.log").read_text(encoding="utf-8")
    line = json.loads(log.strip().splitlines()[-1])
    assert line["path"] == "b.txt"
    assert line["localEtag"] == "e1"
    assert line["remoteEtag"] == "e2"
    assert line["conflictCopy"] == copies[0].name


# ── 6) 锁被占用 → locked=True，不发起任何 HTTP ──────────────────────


def test_lock_held_blocks_run(tmp_path):
    clock = Clock()
    fake = FakeCtl(responder_for(generation=2))
    eng = make_engine(tmp_path, fake, clock, state=state_with(1, {}, {}))
    # 新鲜锁（他人 pid，at=当前时钟）→ 不可夺
    (eng.root / ".sync" / "lock").write_text(
        json.dumps({"pid": 99999, "at": _iso(clock())}), encoding="utf-8"
    )
    res = eng.run_once()
    assert res["locked"] is True
    assert fake.call_count == 0
    # 锁未被我们动过
    assert json.loads((eng.root / ".sync" / "lock").read_text())["pid"] == 99999


def test_stale_lock_seized(tmp_path):
    clock = Clock()
    fake = FakeCtl(responder_for(generation=1, manifest={"entries": []}))
    eng = make_engine(
        tmp_path, fake, clock, state=state_with(1, {}, {})
    )
    # 过期锁（at 早于 30min）→ 可夺，正常开跑
    (eng.root / ".sync" / "lock").write_text(
        json.dumps({"pid": 99999, "at": _iso(clock() - 31 * 60)}), encoding="utf-8"
    )
    res = eng.run_once()
    assert res.get("locked") is not True
    assert fake.call_count >= 1
    # 跑完锁已释放
    assert not (eng.root / ".sync" / "lock").exists()


# ── 7) 清单写回 412 → retry=True，不抛异常，state 不更新 ─────────────


def test_manifest_412_retry_no_persist(tmp_path):
    clock = Clock()
    fake = FakeCtl(
        responder_for(
            generation=2,
            manifest={"entries": [{"path": "c.txt", "etag": "e9", "size": 2}]},
            manifest_etag="M9",
            presign_get={"c.txt": b"cc"},
            put_manifest_status=412,
        )
    )
    eng = make_engine(
        tmp_path, fake, clock, state=state_with(1, {}, {})
    )
    res = eng.run_once()  # 不得抛异常
    assert res["retry"] is True
    assert res["downloaded"] == 1  # 下载已发生，本轮就此结束
    # state 未持久化新 generation（下一轮重来）
    st = json.loads((eng.root / ".sync" / "state.json").read_text())
    assert st["humans"][HUMAN]["generation"] == 1
    # 锁已释放（下轮可跑）
    assert not (eng.root / ".sync" / "lock").exists()


# ── 8) 工作区解析（任务书顺序，不硬编码 WORKING_DIR） ────────────────


def test_resolve_workspace_root(tmp_path, monkeypatch):
    working = tmp_path / "working"
    ws_a = working / "workspaces" / "AgentA"
    ws_b = working / "workspaces" / "AgentB"
    ws_a.mkdir(parents=True)
    ws_b.mkdir(parents=True)
    monkeypatch.delenv("AGENTTEAMS_SYNC_AGENT", raising=False)
    fse.set_current_agent(None)
    try:
        # 无 agent → fallback 到 <WORKING_DIR>/agentteams
        assert fse.resolve_workspace_root(working=working) == working / "agentteams"
        # 显式 agent → <WORKING_DIR>/workspaces/<agent>/agentteams
        assert (
            fse.resolve_workspace_root("AgentA", working=working)
            == ws_a / "agentteams"
        )
        # 不存在的工作区 → 回退
        assert (
            fse.resolve_workspace_root("Ghost", working=working)
            == working / "agentteams"
        )
        # env 覆盖（agent 默认取插件当前 agent 的替代通道）
        monkeypatch.setenv("AGENTTEAMS_SYNC_AGENT", "AgentB")
        assert fse.resolve_workspace_root(working=working) == ws_b / "agentteams"
        # 显式参数优先于 env
        assert (
            fse.resolve_workspace_root("AgentA", working=working)
            == ws_a / "agentteams"
        )
        # 插件当前 agent 注入点（宿主装配侧 set_current_agent）
        monkeypatch.delenv("AGENTTEAMS_SYNC_AGENT", raising=False)
        fse.set_current_agent("AgentB")
        assert fse.resolve_workspace_root(working=working) == ws_b / "agentteams"
    finally:
        fse.set_current_agent(None)


# ── 9) 异常吞噬：ctl_call 抛错 → {"error": ...}，不逃逸、锁释放 ─────


def test_ctl_exception_swallowed(tmp_path):
    clock = Clock()

    def boom(method, path, **kw):
        raise ConnectionError("controller down")

    fake = FakeCtl(boom)
    eng = make_engine(tmp_path, fake, clock, state=state_with(1, {}, {}))
    res = eng.run_once()
    assert "error" in res
    assert "controller down" in res["error"]
    assert not (eng.root / ".sync" / "lock").exists()
    # lastError 记入 state 面（可观测）
    assert eng.state()["lastError"] == res["error"]
