# -*- coding: utf-8 -*-
"""文件镜像同步的弱网/背压单测（任务书 20261107）。

覆盖：单轮预算（30s）到点收尾、200 文件上限、大文件延后（无速率历史 /
估算超出剩余预算）、429/500 退避重试成功、重试耗尽只记 retry_exhausted
不中断整轮、已同步文件不重复写、状态面字段。

全部用 fake ctl_call（剧本应答）+ 注入时钟/休眠，不碰真实网络。
"""
from __future__ import annotations

import json

from agentteams_connector import file_sync_engine as fse
from agentteams_connector.file_sync_engine import HttpResult, SyncEngine

HUMAN = "luo"
BASE = f"/api/v1/humans/{HUMAN}"


class Clock:
    """假时钟：``sleep`` 推进时间并记账（退避不真睡）。"""

    def __init__(self, t: float = 1_760_000_000.0) -> None:
        self.t = t
        self.sleeps: list = []

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.t += seconds


class FakeCtl:
    """记录全部调用；responder(method, path, **kw) -> HttpResult。"""

    def __init__(self, responder) -> None:
        self.responder = responder
        self.calls: list = []

    def __call__(self, method, path, **kw) -> HttpResult:
        self.calls.append((method.upper(), path, kw))
        return self.responder(method.upper(), path, **kw)

    def downloads(self) -> list:
        """本轮发起的文件下载（presign=1 的 GET），按调用顺序。"""
        return [
            path[len(f"{BASE}/files/"):]
            for method, path, kw in self.calls
            if method == "GET"
            and path.startswith(f"{BASE}/files/")
            and (kw.get("params") or {}).get("presign") == "1"
        ]


def jresult(status: int, obj, headers=None) -> HttpResult:
    return HttpResult(
        status, dict(headers or {}), json.dumps(obj, ensure_ascii=False).encode()
    )


def bresult(status: int, data: bytes, headers=None) -> HttpResult:
    return HttpResult(status, dict(headers or {}), data)


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


def make_engine(tmp_path, fake, clock, *, state=None, files=None) -> SyncEngine:
    root = tmp_path / "agentteams"
    files_dir = root / "workspace" / HUMAN / "files"
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
    return SyncEngine(
        root, human=HUMAN, ctl_call=fake, now=clock, sleep=clock.sleep
    )


def responder(
    *,
    files,
    generation: int = 2,
    statuses=None,
    download_statuses=None,
    on_download=None,
):
    """剧本应答：status / manifest / PUT / 文件下载（presign 200 直读）。

    ``statuses`` / ``download_statuses`` 是"按调用顺序消费"的响应码队列，
    队空回落 200（用来制造 429/5xx 后成功或一直失败）。
    """
    status_q = list(statuses or [])
    dl_q = {k: list(v) for k, v in (download_statuses or {}).items()}

    def resp(method, path, **kw):
        params = kw.get("params") or {}
        if method == "GET" and path == f"{BASE}/sync/status":
            code = status_q.pop(0) if status_q else 200
            if code != 200:
                return jresult(code, {"error": "transient"})
            return jresult(200, {"generation": generation})
        if method == "GET" and path == f"{BASE}/sync/manifest":
            entries = [
                {"path": rel, "etag": f"e-{rel}", "size": len(data)}
                for rel, data in files.items()
            ]
            return jresult(200, {"entries": entries}, {"ETag": "M1"})
        if method == "PUT" and path == f"{BASE}/sync/manifest":
            return jresult(200, {"ok": True})
        if (
            method == "GET"
            and path.startswith(f"{BASE}/files/")
            and params.get("presign") == "1"
        ):
            rel = path[len(f"{BASE}/files/"):]
            if on_download is not None:
                on_download(rel)
            queue = dl_q.get(rel) or []
            code = queue.pop(0) if queue else 200
            if code != 200:
                return jresult(code, {"error": "transient"})
            return bresult(200, files.get(rel, b""))
        if method in ("PUT", "POST"):
            return jresult(200, {"ok": True})
        return jresult(404, {"error": "unhandled"})

    return resp


# ── 1) 单轮预算：到点收尾 partial，下一轮从 state 续、不重复写 ────────


def test_round_budget_stops_partial_and_next_round_resumes(tmp_path):
    clock = Clock()
    files = {f"f{i}.txt": f"data{i}".encode() for i in range(5)}

    def on_download(rel):  # 每个文件 10s → 第 4 个后 elapsed=40s > 30s
        clock.advance(10.0)

    fake = FakeCtl(responder(files=files, on_download=on_download))
    eng = make_engine(tmp_path, fake, clock, state=state_with(1, {}, {}))

    res = eng.run_once()
    assert res.get("error") is None
    assert res["partial"] is True
    assert res["processed"] == 4
    assert res["downloaded"] == 4
    assert res["remaining"] == 1
    assert eng.state()["partial"] is True
    written = sorted(p.name for p in eng.files_dir.glob("*.txt"))
    assert written == ["f0.txt", "f1.txt", "f2.txt", "f3.txt"]
    round1 = fake.downloads()
    assert round1 == ["f0.txt", "f1.txt", "f2.txt", "f3.txt"]

    fake.calls.clear()
    res2 = eng.run_once()
    assert res2.get("error") is None
    assert res2["partial"] is False
    assert res2["downloaded"] == 1
    assert eng.state()["partial"] is False
    assert eng.state()["pending"] == 0
    round2 = fake.downloads()
    assert round2 == ["f4.txt"]
    # 已同步的文件两轮不重复写
    assert not (set(round1) & set(round2))
    assert len(list(eng.files_dir.glob("*.txt"))) == 5


# ── 2) 200 文件上限：跳过（未变）不计入上限 ─────────────────────────


def test_round_max_files_cap(tmp_path):
    clock = Clock()
    files = {f"n{i:03d}.txt": b"x" for i in range(250)}
    fake = FakeCtl(responder(files=files))
    eng = make_engine(tmp_path, fake, clock, state=state_with(1, {}, {}))

    res = eng.run_once()
    assert res.get("error") is None
    assert fse.ROUND_MAX_FILES == 200
    assert res["processed"] == 200
    assert res["downloaded"] == 200
    assert res["partial"] is True
    assert res["remaining"] == 50
    assert len(list(eng.files_dir.glob("*.txt"))) == 200

    fake.calls.clear()
    res2 = eng.run_once()
    assert res2["partial"] is False
    # 第二轮前 200 个是"未变→跳过"，不占上限 → 余下 50 个照常传完
    assert res2["downloaded"] == 50
    assert res2["processed"] == 50
    assert len(list(eng.files_dir.glob("*.txt"))) == 250


# ── 3) 大文件延后：无速率历史 → 直接延后；下一轮优先 ─────────────────


def test_large_file_deferred_without_rate_history(tmp_path, monkeypatch):
    monkeypatch.setattr(fse, "LARGE_FILE_BYTES", 1024)
    clock = Clock()
    files = {"small.txt": b"1234", "big.bin": b"z" * 2048}
    fake = FakeCtl(responder(files=files))
    eng = make_engine(tmp_path, fake, clock, state=state_with(1, {}, {}))

    res = eng.run_once()
    assert res.get("error") is None
    assert res["downloaded"] == 1
    assert res["deferred"] == 1
    assert res["partial"] is True
    assert fake.downloads() == ["small.txt"]  # 大文件排到队尾且被延后
    assert not (eng.files_dir / "big.bin").exists()
    st = json.loads((eng.root / ".sync" / "state.json").read_text(encoding="utf-8"))
    assert st["humans"][HUMAN]["largeDeferred"] == ["big.bin"]
    assert st["humans"][HUMAN]["partial"] is True

    fake.calls.clear()
    res2 = eng.run_once()
    assert res2.get("error") is None
    assert res2["deferred"] == 0
    assert res2["downloaded"] == 1
    assert res2["partial"] is False
    assert fake.downloads() == ["big.bin"]  # 上轮延后 → 本轮优先
    assert (eng.files_dir / "big.bin").read_bytes() == b"z" * 2048


# ── 4) 大文件延后：历史速率估算超出剩余预算 ──────────────────────────


def test_large_file_deferred_when_estimate_exceeds_budget(tmp_path, monkeypatch):
    monkeypatch.setattr(fse, "LARGE_FILE_BYTES", 1024)
    clock = Clock()
    files = {"a.txt": b"a" * 1024, "big.bin": b"b" * 2048}

    def on_download(rel):
        if rel == "a.txt":  # 25s 传 1KiB ≈ 41 B/s → big.bin 估算 ≈ 50s
            clock.advance(25.0)

    fake = FakeCtl(responder(files=files, on_download=on_download))
    eng = make_engine(tmp_path, fake, clock, state=state_with(1, {}, {}))

    res = eng.run_once()
    assert res.get("error") is None
    assert res["downloaded"] == 1
    assert res["deferred"] == 1
    assert res["remaining"] == 1
    assert res["partial"] is True
    assert not (eng.files_dir / "big.bin").exists()


# ── 5) 429/500 退避重试成功 ─────────────────────────────────────────


def test_retry_on_429_and_500_then_success(tmp_path):
    clock = Clock()
    fake = FakeCtl(responder(files={"a.txt": b"abc"}, statuses=[429, 500]))
    eng = make_engine(tmp_path, fake, clock, state=state_with(1, {}, {}))

    res = eng.run_once()
    assert res.get("error") is None
    assert res["downloaded"] == 1
    assert res["retries"] == 2
    assert len(clock.sleeps) == 2
    # 指数退避 0.5s / 1.0s，±20% jitter
    assert 0.4 <= clock.sleeps[0] <= 0.6
    assert 0.8 <= clock.sleeps[1] <= 1.2
    assert eng.progress()["retries"] == 2
    assert (eng.files_dir / "a.txt").read_bytes() == b"abc"


# ── 6) 重试耗尽：记 retry_exhausted、不中断整轮、不算冲突 ────────────


def test_retry_exhausted_logged_and_round_continues(tmp_path):
    clock = Clock()
    files = {"a.txt": b"aaa", "b.txt": b"bbb"}
    fake = FakeCtl(
        responder(
            files=files,
            download_statuses={"a.txt": [500, 500, 500, 500]},
        )
    )
    eng = make_engine(tmp_path, fake, clock, state=state_with(1, {}, {}))

    res = eng.run_once()
    assert res.get("error") is None
    assert res["retries"] == fse.RETRY_MAX == 3
    assert res["processed"] == 2  # 失败的文件不打断整轮
    assert res["downloaded"] == 1
    assert res["partial"] is True  # 失败 = 未完成工作，下一轮继续
    assert res["remaining"] == 1
    assert not (eng.files_dir / "a.txt").exists()
    assert (eng.files_dir / "b.txt").read_bytes() == b"bbb"

    log = (eng.root / ".sync" / "conflicts.log").read_text(encoding="utf-8")
    recs = [json.loads(line) for line in log.splitlines() if line.strip()]
    exhausted = [r for r in recs if r.get("kind") == "retry_exhausted"]
    assert len(exhausted) == 1
    assert exhausted[0]["status"] == 500
    assert exhausted[0]["attempts"] == fse.RETRY_MAX + 1
    assert "a.txt" in exhausted[0]["path"]
    # 诊断记录不进冲突面
    assert eng.state()["conflicts"] == 0
    assert eng.list_conflicts() == []
    assert eng.progress()["retry_exhausted"] == 1

    # 下一轮（失败标记未清）继续补传：a.txt 这次 200 → 补齐
    fake.calls.clear()
    res2 = eng.run_once()
    assert res2.get("error") is None
    assert res2["downloaded"] == 1
    assert res2["partial"] is False
    assert (eng.files_dir / "a.txt").read_bytes() == b"aaa"


# ── 7) 状态面字段（GET /sync/state、/sync/progress 增量）─────────────


def test_backpressure_fields_in_progress_and_state(tmp_path):
    clock = Clock()
    fake = FakeCtl(responder(files={"a.txt": b"abc"}))
    eng = make_engine(tmp_path, fake, clock, state=state_with(1, {}, {}))

    eng.run_once()
    pg = eng.progress()
    for key in ("partial", "processed", "deferred", "retries"):
        assert key in pg, f"进度缺字段 {key}"
    assert pg["partial"] is False
    assert pg["processed"] == 1
    assert pg["retries"] == 0
    assert pg["deferred"] == 0

    st = eng.state()
    for key in ("partial", "processed", "deferred", "retries"):
        assert key in st, f"状态缺字段 {key}"
    assert st["partial"] is False
    assert st["processed"] == 1
    assert st["retries"] == 0
    assert st["deferred"] == 0
