# -*- coding: utf-8 -*-
"""v0.5.0-beta.14.11：KB 刷新轻探针（变更检测——变才刷）单测。

背景：60s 过期后 必跑一次深扫（容器多目录递归读，3-17s）。改为
conditional revalidation：刷新门前先跑轻探针（只列条目元数据
name/mtime/size，不读文件内容）；签名与上次一致 → 只重置 60s 时钟
（零深扫），不一致/探针失败 → 深扫（安全）。

覆盖（3 例）：

1. probe/touch 往返：save_probe/load_probe 一致；touch 后 load 的 ts
 更新且 payload 原样、probe 不动；缺失键 touch 静默。
2. 刷新门-未变：预置 probe="S1" + 旧磁盘缓存（ts=now-120s）→ 端点
 stale 秒回并触发刷新；假探针返回 "S1"（一致）→ compute 未被调用、
 磁盘 ts 被 touch、payload 与 probe 原样。
3. 刷新门-已变/探针失败：probe 返回 "S2"（≠ 预置 "S1"）→ compute 被
 调用、磁盘更新新值且 save_probe 记录 "S2"；probe 返回 None（失败）
 → compute 同样被调用（退回深扫，安全）且旧签名保留。

隔离纪律：磁盘目录由 conftest autouse fixture 重定向到本测 tmp（不碰
真实 secret 目录）；计算体/探针经模块级注册表（_KB_PREWARM_HOOKS /
_KB_PROBE_HOOKS）假注入——零真实网络拨号。TestClient 以 ``with`` 上下文
持有 = portal 事件循环跨请求存活（后台刷新任务不被请求收尾切断）。
"""
from __future__ import annotations

import json
import pathlib
import threading
import time

import pytest

from agentteams_connector import config as cfgmod
from agentteams_connector import kb_cache
from agentteams_connector import router as router_mod


# ── 公共件 ────────────────────────────────────────────────────────────


class _FakeCompute:
    """假计算体：记录调用次数、set 事件（供等待完成）、返回固定 payload。"""

    def __init__(self, payload: dict) -> None:
        self.payload = payload
        self.event = threading.Event()
        self.calls = 0

    async def __call__(self, *a, **k):
        self.calls += 1
        self.event.set()
        return self.payload


def _fake_probe(sig):
    """假探针工厂：固定返回签名（或 None=探针失败）。"""

    async def _probe(agent):
        return sig

    return _probe


def _wait_disk(key: str, older_than: float, timeout: float = 5.0):
    """轮询等磁盘缓存 ts 更新（> older_than）。

 后台刷新是 fire-and-forget 任务（portal 循环在 with 块内持续运转）；
 「未变」路径的时钟重置（kb_cache.touch）同样表现为 ts 更新，同一
 轮询可等。超时返回最后一次读（None=未更新）。"""
    deadline = time.time() + timeout
    while True:
        hit = kb_cache.load(key)
        if hit is not None and hit[0] > older_than:
            return hit
        if time.time() >= deadline:
            return kb_cache.load(key)
        time.sleep(0.02)


def _seed_disk(key: str, ts: float, payload: dict) -> None:
    """直接向隔离磁盘目录 seed 一条旧缓存（绕过 save 的时间戳）。"""
    p = pathlib.Path(kb_cache.cache_dir()) / f"{key}.json"
    p.write_text(json.dumps({"ts": ts, "payload": payload}),
                 encoding="utf-8")


@pytest.fixture
def client(monkeypatch):
    """TestClient（with 上下文 = portal 循环跨请求存活）+ 最小配置。"""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    cfg = {
        "controller_urls": ["http://ctl.test"],
        "controller_token": "ctok123",
        "matrix_homeservers": [],
        "matrix": {"user_id": "", "access_token": ""},
    }
    monkeypatch.setattr(
        cfgmod, "load_config", lambda: json.loads(json.dumps(cfg))
    )
    app = FastAPI()
    app.include_router(router_mod.build_router())
    with TestClient(app) as tc:
        yield tc


def _seed_tree() -> tuple:
    """预置 stale tree 缓存（ts=now-120s）+ 探针签名 "S1"，返回 (payload)。"""
    seed = {
        "agent": "big", "workspace": "/fake/ws",
        "files": [{"path": "MEMORY.md", "name": "MEMORY.md", "size": 1,
                   "mtime": 0, "category": "profile", "openable": True}],
        "dirs": [], "count": 1,
    }
    old_ts = time.time() - 120
    _seed_disk("tree-big", old_ts, seed)
    kb_cache.save_probe("tree-big", "S1")
    return seed, old_ts


# ── 1) probe/touch 往返 ───────────────────────────────────────────────


def test_probe_touch_roundtrip():
    """save_probe/load_probe 往返一致；touch 只更新 ts，payload/probe
 原样不动；缺失键 touch 静默（不抛）。"""
    old_ts = time.time() - 100
    payload = {"agent": "w1", "files": [{"path": "a.md", "size": 1}]}
    p = pathlib.Path(kb_cache.cache_dir()) / "tree-w1.json"
    p.write_text(json.dumps({"ts": old_ts, "payload": payload}),
                 encoding="utf-8")

    kb_cache.save_probe("tree-w1", "abc123")
    assert kb_cache.load_probe("tree-w1") == "abc123"

    ts0, got0 = kb_cache.load("tree-w1")
    assert got0 == payload
    assert ts0 < time.time() - 90  # 仍是旧 ts
    kb_cache.touch("tree-w1")
    ts1, got1 = kb_cache.load("tree-w1")
    assert ts1 > time.time() - 5  # 60s 时钟已重置
    assert got1 == payload  # payload 原样
    assert kb_cache.load_probe("tree-w1") == "abc123"  # probe 未动

    # 缺失键：touch 静默、load/load_probe → None。
    kb_cache.touch("nope")
    assert kb_cache.load("nope") is None
    assert kb_cache.load_probe("nope") is None


# ── 2) 刷新门-未变：零深扫、只重置时钟 ─────────────────────────────────


def test_refresh_gate_unchanged_no_deep_scan(client, monkeypatch):
    """预置 probe="S1" + stale 缓存 → 端点 stale 秒回并触发刷新；假探针
 返回 "S1"（一致）→ compute 未被调用、ts 被 touch、payload/probe 原样。"""
    tc = client
    seed, old_ts = _seed_tree()

    fake = _FakeCompute({"agent": "big", "workspace": "/fake/ws",
                         "files": [], "dirs": [], "count": 0,
                         "fresh": True})
    monkeypatch.setitem(router_mod._KB_PREWARM_HOOKS, "tree", fake)
    monkeypatch.setitem(router_mod._KB_PROBE_HOOKS, "probe",
                        _fake_probe("S1"))

    r = tc.get("/kb/big/tree")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["cached"] is True
    assert body["files"] == seed["files"]  # stale 秒回旧值

    # 刷新门：探针一致 → 零深扫，只重置时钟。
    hit = _wait_disk("tree-big", old_ts)
    assert hit is not None and hit[0] > old_ts, "刷新门未重置时钟"
    assert hit[1] == seed  # payload 原样（compute 未跑、磁盘未被覆写）
    assert fake.calls == 0  # 零深扫
    assert kb_cache.load_probe("tree-big") == "S1"  # probe 原样


# ── 3) 刷新门-已变 / 探针失败：退回深扫（安全）─────────────────────────


def test_refresh_gate_changed_or_probe_failure(client, monkeypatch):
    """已变：probe "S2" ≠ 预置 "S1" → compute 被调、磁盘更新新值且
 save_probe 记录 "S2"。探针失败：probe None → compute 同样被调（安全
 深扫）且旧签名保留（下轮再比）。"""
    tc = client
    seed, old_ts = _seed_tree()

    fresh = {"agent": "big", "workspace": "/fake/ws", "files": [],
             "dirs": [], "count": 0, "fresh": True}
    fake = _FakeCompute(fresh)
    monkeypatch.setitem(router_mod._KB_PREWARM_HOOKS, "tree", fake)

    # 轮 1：探针已变（S1→S2）→ 深扫 + 记录新签名。
    monkeypatch.setitem(router_mod._KB_PROBE_HOOKS, "probe",
                        _fake_probe("S2"))
    r = tc.get("/kb/big/tree")
    assert r.status_code == 200, r.text
    assert r.json()["cached"] is True  # stale 值仍先秒回
    assert fake.event.wait(5.0), "已变刷新未在 5s 内运行"
    hit = _wait_disk("tree-big", old_ts)
    assert hit is not None and hit[1] == fresh, "已变未触发深扫"
    assert fake.calls == 1
    assert kb_cache.load_probe("tree-big") == "S2"  # save_probe 记录

    # 轮 2：探针失败（None）→ 即便签名本可一致，也退回深扫（安全）。
    # 清内存门（轮 1 已写入 30s TTL）+ 重 seed stale 磁盘，触发新一轮。
    router_mod._kb_tree_cache.clear()
    fake2 = _FakeCompute({**fresh, "round": 2})
    monkeypatch.setitem(router_mod._KB_PREWARM_HOOKS, "tree", fake2)
    monkeypatch.setitem(router_mod._KB_PROBE_HOOKS, "probe",
                        _fake_probe(None))
    t2_old = time.time() - 120
    _seed_disk("tree-big", t2_old, fresh)
    r2 = tc.get("/kb/big/tree")
    assert r2.status_code == 200, r2.text
    assert fake2.event.wait(5.0), "探针失败未退回深扫"
    hit2 = _wait_disk("tree-big", t2_old)
    assert hit2 is not None and hit2[1] == {**fresh, "round": 2}
    assert fake2.calls == 1
    assert kb_cache.load_probe("tree-big") == "S2"  # 失败不抹旧签名
