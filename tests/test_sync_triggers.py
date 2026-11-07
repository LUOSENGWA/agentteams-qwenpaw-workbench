# -*- coding: utf-8 -*-
"""同步时机补齐（设计 §6 行 5/6/9/10）离线单测。

覆盖：暂停不调 ctl / watch 去抖后只触发一轮 / agent_stop 回调触发 /
关机 flush 只小文件且超时快退 / pause-resume API / watcher 过滤。
全部 fake ctl_call，不碰真实网络/控制器。
"""
from __future__ import annotations

import asyncio
import json

import pytest

from agentteams_connector import file_sync_engine as fse
from agentteams_connector.file_sync_engine import (
    HttpResult,
    SyncEngine,
    SyncTriggers,
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


def responder_for(
    *,
    generation=1,
    manifest=None,
    manifest_etag="M1",
    put_manifest_status=200,
):
    """最小控制器剧本：status/manifest GET+PUT、文件 presign 405 + 直 PUT。"""

    def resp(method, path, **kw):
        params = kw.get("params") or {}
        if method == "GET" and path == f"{BASE}/sync/status":
            return jresult(200, {"generation": generation})
        if method == "GET" and path == f"{BASE}/sync/manifest":
            return jresult(
                200, manifest or {"entries": []}, {"ETag": manifest_etag}
            )
        if method == "PUT" and path == f"{BASE}/sync/manifest":
            return jresult(put_manifest_status, {"ok": True})
        if method == "POST" and params.get("presign") == "1":
            return jresult(405, {"error": "presign unavailable"})
        if method == "PUT" and path.startswith(f"{BASE}/files/"):
            return jresult(200, {"ok": True})
        return jresult(404, {"error": "unhandled"})

    return resp


def state_with(gen, etags=None, local=None):
    return {
        "humans": {
            HUMAN: {
                "generation": gen,
                "etags": etags or {},
                "local": local or {},
                "lastRunAt": "2026-11-06T00:00:00.000Z",
            }
        }
    }


def make_engine(tmp_path, fake: FakeCtl, clock: Clock, *, state=None) -> SyncEngine:
    root = tmp_path / "agentteams"
    files_dir = root / "workspace" / HUMAN / "files"
    files_dir.mkdir(parents=True, exist_ok=True)
    (root / ".sync").mkdir(parents=True, exist_ok=True)
    if state is not None:
        (root / ".sync" / "state.json").write_text(
            json.dumps(state, ensure_ascii=False), encoding="utf-8"
        )
    return SyncEngine(root, human=HUMAN, ctl_call=fake, now=clock)


# ── 1) 暂停：每轮只更新状态，零 ctl 调用、零传输 ─────────────────────


def test_paused_round_skips_ctl(tmp_path):
    clock = Clock()
    fake = FakeCtl(responder_for(generation=1))
    eng = make_engine(tmp_path, fake, clock, state=state_with(1))
    assert eng.set_paused(True)["paused"] is True
    assert eng.paused() is True

    res = eng.run_once()
    assert res == {"paused": True}
    assert fake.call_count == 0
    assert eng.state()["paused"] is True
    assert eng.progress()["state"] == "paused"

    # 恢复后正常走一轮（generation 未变 → same-generation）
    eng.set_paused(False)
    res2 = eng.run_once()
    assert res2.get("skipped") == "same-generation"
    assert fake.call_count == 1


# ── 2) watch：去抖窗内多次变更合并成一轮 ─────────────────────────────


@pytest.mark.asyncio
async def test_watch_changes_debounce_to_one_round(tmp_path):
    clock = Clock()
    fake = FakeCtl(responder_for(generation=1))
    eng = make_engine(tmp_path, fake, clock, state=state_with(1))
    trig = SyncTriggers(eng, debounce=0.05, watch=False)
    trig.start()
    try:
        trig.mark("watch")
        trig.mark("watch")
        trig.mark("agent_stop")
        await asyncio.sleep(0.3)
        assert trig.rounds == 1
        # 一轮 = 一次 status（same-generation 提前返回）
        assert fake.call_count == 1
        assert trig.last_result.get("skipped") == "same-generation"
    finally:
        await trig.stop()


def test_watch_filter_ignores_own_writes():
    assert fse.watch_change_relevant([(1, "files/a.txt")]) is True
    assert (
        fse.watch_change_relevant(
            [(1, "files/a.txt.conflict-20261107T000000Z")]
        )
        is False
    )
    assert fse.watch_change_relevant([(1, "files/x.part")]) is False
    assert fse.watch_change_relevant([(2, "files/x.sync-tmp")]) is False
    assert fse.watch_change_relevant([(2, "files/~$draft.docx")]) is False
    assert fse.watch_change_relevant([(2, "files/x.swp")]) is False
    assert fse.watch_change_relevant([]) is False
    # 混合变更里只要有一条正经文件就触发
    assert (
        fse.watch_change_relevant(
            [(1, "files/x.part"), (3, "files/notes/real.md")]
        )
        is True
    )


# ── 3) AT 回合结束回调：标 dirty → 2s 去抖后跑一轮 ───────────────────


@pytest.mark.asyncio
async def test_agent_stop_callback_triggers_round(tmp_path, monkeypatch):
    clock = Clock()
    fake = FakeCtl(responder_for(generation=1))
    eng = make_engine(tmp_path, fake, clock, state=state_with(1))
    trig = SyncTriggers(eng, debounce=0.05, watch=False)
    monkeypatch.setattr(fse, "_triggers", trig)
    trig.start()
    try:
        fse.notify_agent_stop()
        assert trig.pending() is True
        await asyncio.sleep(0.3)
        assert trig.rounds == 1
        assert fake.call_count == 1
    finally:
        await trig.stop()


def test_notify_agent_stop_without_engine_is_noop(monkeypatch):
    monkeypatch.setattr(fse, "_triggers", None)
    fse.notify_agent_stop()  # 不抛


# ── 4) 关机 flush：只小文件 + 写回清单；超时快退 ─────────────────────


def test_flush_small_only_small_files(tmp_path):
    clock = Clock()
    fake = FakeCtl(responder_for(generation=1))
    eng = make_engine(tmp_path, fake, clock, state=state_with(1))
    (eng.files_dir / "small.txt").write_bytes(b"bye")
    big = eng.files_dir / "big.bin"
    big.write_bytes(b"x" * (fse.SHUTDOWN_FLUSH_MAX_BYTES + 1))

    res = eng.flush_small()
    assert res["uploaded"] == 1
    uploaded = [
        c[1]
        for c in fake.calls
        if c[0] == "PUT" and c[1].startswith(f"{BASE}/files/")
    ]
    assert uploaded == [f"{BASE}/files/small.txt"]
    assert any(
        c[0] == "PUT" and c[1] == f"{BASE}/sync/manifest" for c in fake.calls
    )
    st = json.loads((eng.root / ".sync" / "state.json").read_text())
    assert "small.txt" in st["humans"][HUMAN]["etags"]
    assert "big.bin" not in st["humans"][HUMAN]["etags"]


def test_flush_small_timeout_abandons_fast(tmp_path):
    clock = Clock()
    fake = FakeCtl(responder_for(generation=1))
    eng = make_engine(tmp_path, fake, clock, state=state_with(1))
    (eng.files_dir / "small.txt").write_bytes(b"bye")

    res = eng.flush_small(timeout=0)
    assert res["timeout"] is True
    assert res["uploaded"] == 0
    assert fake.call_count == 0


def test_flush_small_skips_when_paused_or_locked(tmp_path):
    clock = Clock()
    fake = FakeCtl(responder_for(generation=1))
    eng = make_engine(tmp_path, fake, clock, state=state_with(1))
    (eng.files_dir / "small.txt").write_bytes(b"bye")

    eng.set_paused(True)
    assert eng.flush_small()["skipped"] == "paused"
    eng.set_paused(False)

    eng.lock_file.write_text(json.dumps({"pid": 1, "at": "2026-11-07T00:00:00.000Z"}))
    assert eng.flush_small()["skipped"] == "locked"
    eng.lock_file.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_stop_runs_shutdown_flush(tmp_path, monkeypatch):
    clock = Clock()
    fake = FakeCtl(responder_for(generation=1))
    eng = make_engine(tmp_path, fake, clock, state=state_with(1))
    (eng.files_dir / "bye.txt").write_bytes(b"bye")
    monkeypatch.setattr(fse, "_engine", eng)
    monkeypatch.setattr(fse, "_triggers", None)
    monkeypatch.setattr(fse, "_task", None)

    await fse.stop()
    uploaded = [
        c[1]
        for c in fake.calls
        if c[0] == "PUT" and c[1].startswith(f"{BASE}/files/")
    ]
    assert uploaded == [f"{BASE}/files/bye.txt"]


# ── 5) pause / resume API ────────────────────────────────────────────


def test_pause_resume_api(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from agentteams_connector.routers import sync_api

    clock = Clock()
    fake = FakeCtl(responder_for(generation=1))
    eng = make_engine(tmp_path, fake, clock, state=state_with(1))
    monkeypatch.setattr(fse, "ensure_engine", lambda: eng)
    monkeypatch.setattr(fse, "get_triggers", lambda: None)
    monkeypatch.setattr(fse, "_triggers", None)

    app = FastAPI()
    app.include_router(sync_api.build_sync_router(), prefix="/agentteams-proxy")
    client = TestClient(app)

    r = client.post("/agentteams-proxy/sync/pause")
    assert r.status_code == 200
    assert r.json()["paused"] is True
    cfg = json.loads(eng.config_file.read_text(encoding="utf-8"))
    assert cfg["sync_paused"] is True

    r = client.get("/agentteams-proxy/sync/config")
    assert r.status_code == 200
    assert r.json()["paused"] is True

    r = client.post("/agentteams-proxy/sync/resume")
    assert r.status_code == 200
    assert r.json()["paused"] is False
    assert eng.paused() is False

    # 暂停态下 /sync/run 不调 ctl（run_manual → run_once → paused 早退）
    eng.set_paused(True)
    r = client.post("/agentteams-proxy/sync/run")
    assert r.status_code == 200
    assert r.json() == {"paused": True}
    assert fake.call_count == 0
