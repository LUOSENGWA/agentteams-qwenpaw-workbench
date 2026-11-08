# -*- coding: utf-8 -*-
"""SYNC-STORE 落盘存储离线单测（根布局/迁移/state/锁/http·chat·lru 缓存）。

设计依据：方案与设计/AgentTeams/下版本1.2.6-1.2.7/10-客户端同步与缓存/
QwenPaw插件存储与缓存-设计-20261107.md。
全部离线：tmp_path 根 + fake ctl_call + 可注入时钟，不碰真实网络/控制器。
"""
from __future__ import annotations

import json
import os

from agentteams_connector import file_sync_engine as fse
from agentteams_connector.file_sync_engine import (
    HttpResult,
    LOCK_STALE_SECONDS,
    SyncEngine,
    _iso,
)
from agentteams_connector.sync_store import (
    MAX_HTTP_BODY_BYTES,
    MAX_LRU_ENTRIES,
    SyncStore,
    http_key,
    legacy_root_for,
    migrate_root,
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


def jresult(status: int, obj, headers=None) -> HttpResult:
    return HttpResult(
        status, dict(headers or {}), json.dumps(obj, ensure_ascii=False).encode()
    )


def empty_ctl():
    """应答器：控制器无 manifest 接口（404）——引擎 init/state/锁测试
    不需要 sync 轮跑完整完成。"""

    def resp(method, path, **kw):
        return jresult(404, {"error": "no manifest api"})

    return resp


def new_ws(tmp_path, name="ws"):
    """干净的 agent 工作区（新根 = <ws>/.qwenpaw/agentteams）。"""
    ws = tmp_path / name
    ws.mkdir(parents=True, exist_ok=True)
    return ws


def new_root(ws):
    return ws / ".qwenpaw" / "agentteams"


def make_engine(root, human=HUMAN, clock=None):
    return SyncEngine(
        root, human=human, ctl_call=empty_ctl(), now=clock or Clock()
    )


# ── 1) 路径布局（设计 §3）──────────────────────────────────────────


def test_path_layout(tmp_path):
    ws = new_ws(tmp_path)
    root = new_root(ws)
    eng = make_engine(root)
    # 镜像：workspace/<human>/files/
    assert eng.files_dir == root / "workspace" / HUMAN / "files"
    assert eng.files_dir.is_dir()
    # .sync 三件套（state/lock/conflicts）所在目录
    assert (root / ".sync").is_dir()
    assert eng.state_file == root / ".sync" / "state.json"
    assert eng.lock_file == root / ".sync" / "lock"
    assert eng.conflicts_log == root / ".sync" / "conflicts.log"
    # cache：http/lru 目录 + 聊天库（chat.db 惰性建；旧 cache/chat 不再创建）
    st = eng.store
    assert st.http_dir == root / "cache" / "http"
    assert st.chat_dir == root / "cache" / "chat"  # 旧布局：仅作迁移源
    assert st.lru_dir == root / "cache" / "lru"
    assert st.http_dir.is_dir() and st.lru_dir.is_dir()
    assert not st.chat_dir.exists()
    assert st.chat_db.db_path == root / "cache" / "chat.db"
    assert not st.chat_db.db_path.exists()  # 构造不连库（首次使用时才建）
    st.close()
    # http 文件名 key = sha1(method+url)（method 归一大写）
    assert http_key("GET", "https://x.example/a") == http_key(
        "get", "https://x.example/a"
    )
    assert len(http_key("GET", "https://x.example/a")) == 40  # sha1 hex


# ── 2) 首启自动迁移（旧根 → 新根，记 migratedFrom）─────────────────


def test_migration_on_first_start(tmp_path):
    ws = new_ws(tmp_path)
    old = ws / "agentteams"
    (old / "files" / "notes").mkdir(parents=True)
    (old / "files" / "notes" / "a.txt").write_bytes(b"hello")
    (old / ".sync").mkdir(parents=True)
    (old / ".sync" / "state.json").write_text(
        json.dumps(
            {
                "humans": {
                    HUMAN: {
                        "generation": 3,
                        "etags": {"notes/a.txt": "e1"},
                        "local": {},
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    root = new_root(ws)
    assert not root.exists()
    eng = make_engine(root)  # init 自动迁移
    # 旧根消失、新根就位
    assert not old.exists()
    assert root.is_dir()
    # files/ → workspace/<human>/files/
    assert (root / "workspace" / HUMAN / "files" / "notes" / "a.txt").read_bytes() == (
        b"hello"
    )
    assert not (root / "files").exists()
    # state.json：migratedFrom + 旧 etag 表保留 + 新顶层字段
    st = json.loads(eng.state_file.read_text(encoding="utf-8"))
    assert st["migratedFrom"] == str(old)
    assert st["humans"][HUMAN]["etags"]["notes/a.txt"] == "e1"
    assert st["humans"][HUMAN]["generation"] == 3
    assert st["root"] == str(root)
    assert st["human"] == HUMAN
    assert st["version"] == 1


# ── 3) 迁移幂等（重跑 no-op / 旧新并存不碰）────────────────────────


def test_migration_idempotent_and_skip_when_new_exists(tmp_path):
    # A) 迁移一次后重跑 → None，文件完好
    ws = new_ws(tmp_path)
    old = ws / "agentteams"
    (old / "files").mkdir(parents=True)
    (old / "files" / "x.txt").write_bytes(b"x")
    root = new_root(ws)
    assert migrate_root(root, HUMAN) == str(old)
    assert migrate_root(root, HUMAN) is None  # 旧根已搬走
    assert (root / "workspace" / HUMAN / "files" / "x.txt").read_bytes() == b"x"
    # B) 旧新并存 → 不碰（只在「旧存在且新不存在」时迁）
    ws2 = new_ws(tmp_path, "ws2")
    old2 = ws2 / "agentteams"
    (old2 / "files").mkdir(parents=True)
    (old2 / "files" / "keep.txt").write_bytes(b"keep")
    root2 = new_root(ws2)
    (root2 / "workspace" / HUMAN / "files").mkdir(parents=True)
    (root2 / "workspace" / HUMAN / "files" / "new.txt").write_bytes(b"new")
    assert migrate_root(root2, HUMAN) is None
    assert (old2 / "files" / "keep.txt").read_bytes() == b"keep"
    assert (root2 / "workspace" / HUMAN / "files" / "new.txt").read_bytes() == b"new"
    # C) 不在 .qwenpaw/ 下的根（测试 tmp 根形态）→ 无迁移概念
    bare = tmp_path / "somewhere" / "agentteams"
    assert legacy_root_for(bare) is None
    assert legacy_root_for(root) == old


# ── 4) state.json 原子写 + 顶层字段 ────────────────────────────────


def test_state_atomic_write_fields(tmp_path):
    ws = new_ws(tmp_path)
    root = new_root(ws)
    clock = Clock()

    def resp(method, path, **kw):
        if path == f"{BASE}/sync/status":
            return jresult(200, {"generation": 7})
        if path == f"{BASE}/sync/manifest":
            return jresult(200, {"entries": []}, {"ETag": "M1"})
        if method == "PUT":
            return jresult(200, {"ok": True})
        return jresult(404, {"error": "unhandled"})

    eng = SyncEngine(
        root, human=HUMAN, ctl_call=lambda m, p, **kw: resp(m, p, **kw), now=clock
    )
    res = eng.run_once()
    assert res.get("error") is None
    assert res["generation"] == 7
    st = json.loads(eng.state_file.read_text(encoding="utf-8"))  # 必须可解析
    assert st["version"] == 1
    assert st["root"] == str(root)
    assert st["human"] == HUMAN
    assert st["generation"] == 7
    assert st["lastRunAt"] == _iso(clock())
    assert st["conflicts"] == 0
    assert st["humans"][HUMAN]["generation"] == 7
    # 原子写不留 tmp 残留
    assert not (root / ".sync" / "state.json.tmp").exists()


# ── 5) cursor 携带（可选字段，已有则保留）──────────────────────────


def test_state_cursor_preserved(tmp_path):
    ws = new_ws(tmp_path)
    root = new_root(ws)
    (root / ".sync").mkdir(parents=True)
    (root / ".sync" / "state.json").write_text(
        json.dumps({"cursor": "v1:13001", "humans": {}}), encoding="utf-8"
    )

    def resp(method, path, **kw):
        if path == f"{BASE}/sync/status":
            return jresult(200, {"generation": 2})
        if path == f"{BASE}/sync/manifest":
            return jresult(200, {"entries": []}, {"ETag": "M2"})
        if method == "PUT":
            return jresult(200, {"ok": True})
        return jresult(404, {"error": "unhandled"})

    eng = SyncEngine(
        root, human=HUMAN, ctl_call=lambda m, p, **kw: resp(m, p, **kw), now=Clock()
    )
    assert eng.run_once().get("error") is None
    st = json.loads(eng.state_file.read_text(encoding="utf-8"))
    assert st["cursor"] == "v1:13001"
    assert eng.state()["cursor"] == "v1:13001"
    # 无 cursor 的 state → state() 报告 None（不造假）
    ws2 = new_ws(tmp_path, "ws2")
    eng2 = make_engine(new_root(ws2))
    assert eng2.state()["cursor"] is None


# ── 6/7) 锁：10 分钟过期可夺（任务书口径）──────────────────────────


def test_lock_fresh_blocks(tmp_path):
    ws = new_ws(tmp_path)
    root = new_root(ws)
    clock = Clock()
    eng = make_engine(root, clock=clock)
    # 新鲜锁（他人 pid，at=当前时钟）→ 不可夺
    (root / ".sync" / "lock").write_text(
        json.dumps({"pid": 99999, "at": _iso(clock())}), encoding="utf-8"
    )
    assert eng._acquire_lock() is False
    # 锁内容未被动过
    assert json.loads((root / ".sync" / "lock").read_text(encoding="utf-8"))["pid"] == (
        99999
    )


def test_lock_stale_10min_seized(tmp_path):
    assert LOCK_STALE_SECONDS == 10 * 60  # 任务书口径：10 分钟过期
    ws = new_ws(tmp_path)
    root = new_root(ws)
    clock = Clock()
    eng = make_engine(root, clock=clock)
    # 9 分钟锁仍新鲜 → 不可夺
    (root / ".sync" / "lock").write_text(
        json.dumps({"pid": 99999, "at": _iso(clock() - 9 * 60)}), encoding="utf-8"
    )
    assert eng._acquire_lock() is False
    # 11 分钟锁已过期 → 夺锁（本进程 pid 覆盖写）
    (root / ".sync" / "lock").write_text(
        json.dumps({"pid": 99999, "at": _iso(clock() - 11 * 60)}), encoding="utf-8"
    )
    assert eng._acquire_lock() is True
    assert (
        json.loads((root / ".sync" / "lock").read_text(encoding="utf-8"))["pid"]
        == os.getpid()
    )
    # 释放后锁消失
    eng._release_lock()
    assert not (root / ".sync" / "lock").exists()


# ── 8/9) lru 条目数上限（200）+ 磁盘读回退 ─────────────────────────


def test_lru_capacity_evicts_oldest(tmp_path):
    store = SyncStore(tmp_path / "agentteams")
    store.ensure_dirs()
    total = MAX_LRU_ENTRIES + 1  # 201 条
    for i in range(total):
        store.lru_put(f"k{i:04d}", {"n": i})
    # 超上限 1 条 → 淘汰最久未用的 k0000
    assert store.lru_count() == MAX_LRU_ENTRIES
    # Path.glob 返回生成器（恒真）——必须取 list 判空。
    assert not list(store.lru_dir.glob("k0000.json"))
    assert list(store.lru_dir.glob("k0200.json"))
    assert store.lru_get("k0000") is None
    got = store.lru_get("k0200")
    assert got is not None
    assert got["value"] == {"n": 200}


def test_lru_read_fallback_from_disk(tmp_path):
    """新实例（内存空）读旧实例的磁盘条目 → 读回退命中。"""
    root = tmp_path / "agentteams"
    a = SyncStore(root)
    a.ensure_dirs()
    a.lru_put("shared-key", {"v": 42})
    b = SyncStore(root)  # 内存为空
    got = b.lru_get("shared-key")
    assert got is not None
    assert got["value"] == {"v": 42}
    # 载回内存后二次读命中内存层（值一致）
    assert b.lru_get("shared-key") == got


# ── 10) http 缓存：命中 / 过期（etag 保留）/ 超限 body ─────────────


def test_http_cache_hit(tmp_path):
    store = SyncStore(tmp_path / "agentteams")
    store.ensure_dirs()
    url = "https://ctl.example/api/v1/teams"
    body = b'{"teams": ["a"]}'
    ok = store.http_put("GET", url, etag="ETAG-1", last_modified="LM-1", body=body)
    assert ok is True
    f = store.http_dir / f"{http_key('GET', url)}.json"
    assert f.is_file()
    assert f.with_suffix(".body").is_file()
    got = store.http_get("GET", url)
    assert got is not None
    assert got["etag"] == "ETAG-1"
    assert got["lastModified"] == "LM-1"
    assert got["body"] == body
    assert got["size"] == len(body)
    assert got["bodyHash"]
    assert got["savedAt"]
    # 304 复验材料：etag 可读
    assert store.http_etag("GET", url) == "ETAG-1"
    # 未命中：未知 url
    assert store.http_get("GET", "https://ctl.example/other") is None
    assert store.http_etag("GET", "https://ctl.example/other") is None


def test_http_cache_expired_keeps_etag(tmp_path):
    clock = Clock()
    store = SyncStore(tmp_path / "agentteams", now=clock)
    store.ensure_dirs()
    url = "https://ctl.example/api/v1/workers"
    assert store.http_put("GET", url, etag="E9", body=b"abc") is True
    assert store.http_fresh("GET", url, max_age=300.0) is not None
    clock.advance(301)
    # 过期 → 新鲜度判定 None（调用方带 If-None-Match 复验）
    assert store.http_fresh("GET", url, max_age=300.0) is None
    # 但 etag 不随过期失效（复验材料，设计 §4）
    assert store.http_etag("GET", url) == "E9"


def test_http_oversized_body_not_persisted(tmp_path):
    store = SyncStore(tmp_path / "agentteams")
    store.ensure_dirs()
    url = "https://ctl.example/api/v1/big"
    big = b"x" * (MAX_HTTP_BODY_BYTES + 1)
    assert store.http_put("GET", url, etag="EB", body=big) is False
    f = store.http_dir / f"{http_key('GET', url)}.json"
    assert f.is_file()
    assert not f.with_suffix(".body").exists()
    got = store.http_get("GET", url)
    assert got is not None
    assert got["body"] is None
    assert got["size"] == len(big)
    # 换小 body → .body 正常落盘
    assert store.http_put("GET", url, etag="E2", body=b"small") is True
    assert store.http_get("GET", url)["body"] == b"small"


# ── 11) chat：SQLite 增量 upsert（永久保留）+ 回读 ─────────────────


def test_chat_store_incremental_roundtrip(tmp_path):
    store = SyncStore(tmp_path / "agentteams")
    store.ensure_dirs()
    room = "!room123:matrix.example.com"
    msgs = [{"event_id": f"$m{i}", "origin_server_ts": i, "body": f"m{i}"} for i in range(600)]
    n = store.chat_put(room, msgs, end="cursor-599")
    assert n == 600  # 不按 500 截断历史
    assert store.chat_db.db_path.is_file()
    assert not store.chat_dir.exists()  # 不再写 JSON 目录
    got = store.chat_get(room)
    assert got is not None
    assert got["end"] == "cursor-599"
    assert len(got["messages"]) == 600
    assert got["messages"][0]["event_id"] == "$m0"
    assert got["messages"][-1]["event_id"] == "$m599"
    # 增量写：同一个 id 覆盖、旧历史保留
    assert store.chat_put(room, [{"event_id": "$m0", "origin_server_ts": 0, "body": "edited"}]) == 1
    got2 = store.chat_get(room)
    assert len(got2["messages"]) == 600
    assert got2["messages"][0]["body"] == "edited"
    assert got2["end"] == "cursor-599"  # 不带 end → 游标保留
    # 按 event 取窗口（服务端切片，前端免拉整窗）
    win = store.chat_window(room, "$m10", 1, 1)
    assert [m["event_id"] for m in win["messages"]] == ["$m9", "$m10", "$m11"]
    # 未知房间 → None（路由层转 200 空窗口）
    assert store.chat_get("!nobody:matrix.example.com") is None
    assert store.chat_window("!nobody:matrix.example.com", "$m10") is None
    store.close()


def test_chat_prune_evicts_by_lru_over_db_size(tmp_path):
    store = SyncStore(tmp_path / "agentteams")
    store.ensure_dirs()
    for i in range(4):
        store.chat_put(
            f"!room{i}:hs",
            [
                {"event_id": f"$r{i}-{k}", "origin_server_ts": k, "body": "x" * 400}
                for k in range(100)
            ],
        )
        # 显式 last_access 序：room0 最旧 … room3 最新
        store.chat_db._conn.execute(
            "UPDATE rooms SET last_access=? WHERE room_id=?",
            (1_760_000_000 + i, f"!room{i}:hs"),
        )
        store.chat_db._conn.commit()
    store.chat_db._checkpoint()  # WAL 落主库后度量（上限口径不含虚高 WAL）
    size = store.chat_bytes()
    # 1) 上限内 → no-op
    assert store.chat_prune(max_bytes=size * 10) == {"removedFiles": 0, "freedBytes": 0}
    # 2) 上限压到一半 → 按 last_access 淘汰最旧房间，至少留 1 房
    got = store.chat_prune(max_bytes=size // 2)
    assert got["removedFiles"] >= 1
    assert got["freedBytes"] > 0
    assert store.chat_bytes() <= size // 2
    assert not store.chat_db.has_room("!room0:hs")
    assert store.chat_db.has_room("!room3:hs")
    store.close()


def test_chat_prune_missing_dir_is_noop(tmp_path):
    store = SyncStore(tmp_path / "agentteams")  # 不 ensure_dirs
    assert store.chat_prune() == {"removedFiles": 0, "freedBytes": 0}
    store.close()



# ── 12) /sync/state 端点字段补充（root/lastRunAt/conflicts）────────


def test_sync_state_endpoint_fields(tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from agentteams_connector.routers import sync_api

    ws = new_ws(tmp_path)
    root = new_root(ws)
    eng = make_engine(root)
    fse._engine = eng  # ensure_engine() 直接取到 fake 引擎，不碰真实网络
    try:
        app = FastAPI()
        app.include_router(sync_api.build_sync_router())
        tc = TestClient(app)
        r = tc.get("/sync/state")
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["root"] == str(root)
        assert data["human"] == HUMAN
        assert data["conflicts"] == 0
        assert data["lastRunAt"] is None  # 尚未跑过一轮
        assert data["enabled"] is True
        assert data["locked"] is False
        # 首跑前 state.json 未落盘 → version/cursor 诚实报 None
        assert data["version"] is None
        assert data["cursor"] is None
    finally:
        fse._engine = None


# ── S5 冲突日志（列表 + 删本地副本） ─────────────────────────────


def test_list_conflicts_newest_first_and_skips_bad_lines(tmp_path):
    from agentteams_connector.file_sync_engine import SyncEngine

    eng = SyncEngine.__new__(SyncEngine)  # 只测日志读取，不建真实引擎
    eng.sync_dir = tmp_path
    eng.conflicts_log = tmp_path / "conflicts.log"
    eng.conflicts_log.write_text(
        '{"ts":"t1","path":"files/a.md","conflictCopy":"files/a.md.conflict-1"}\n'
        "not json\n"
        '{"ts":"t2","path":"files/b.md","conflictCopy":"files/b.md.conflict-2"}\n',
        encoding="utf-8",
    )
    got = SyncEngine.list_conflicts(eng, limit=10)
    assert [c["path"] for c in got] == ["files/b.md", "files/a.md"]


def test_remove_conflict_copy_only_conflict_files(tmp_path):
    from agentteams_connector.file_sync_engine import SyncEngine

    eng = SyncEngine.__new__(SyncEngine)
    eng.root = tmp_path
    f = tmp_path / "files" / "a.md.conflict-20260101T000000Z"
    f.parent.mkdir(parents=True)
    f.write_text("x", encoding="utf-8")
    assert SyncEngine.remove_conflict_copy(eng, "files/a.md.conflict-20260101T000000Z")[
        "removed"
    ]
    assert not f.exists()
    # 非冲突文件拒绝
    plain = tmp_path / "files" / "a.md"
    plain.write_text("y", encoding="utf-8")
    assert not SyncEngine.remove_conflict_copy(eng, "files/a.md")["removed"]
    assert plain.exists()
