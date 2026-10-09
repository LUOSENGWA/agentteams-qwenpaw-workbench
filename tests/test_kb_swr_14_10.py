# -*- coding: utf-8 -*-
"""KB 端点 SWR 持久缓存单测。

背景（实测）：冷读容器 tree 最慢 13.8s、graph 同级、/kb/agents 3.3s 且无
缓存（每次全量）；命中缓存 = 4-5ms。修法 = stale-while-revalidate + 磁盘
持久缓存（重启/换页后旧值秒回 + 后台单飞静默刷新）。

覆盖（4 例）：

1. ``kb_cache`` 往返：save/load 一致（ts 新鲜）；key 特殊字符过滤；
 缺失/损坏/形状异常 → None。
2. tree 端点 SWR：seed 磁盘缓存（旧 ts=now-120s）→ 请求秒回
 ``cached=True`` + 原 payload + ``age≈120``，且超 TTL 触发后台单飞
 刷新（注册表换假 compute → 等待完成 → 磁盘被新值更新、last-agent
 落记）。
3. 冷路径落盘：无磁盘缓存 + 假 compute → 响应正常（无 cached 标记）且
 ``kb_cache.load("tree-<agent>")`` 非空 + 内存缓存同值。
4. agents 同款：seed "agents" 旧值 → ``cached=True`` + 原 payload +
 刷新更新磁盘；agents 路径不记 last-agent。

隔离纪律：磁盘目录由 conftest autouse fixture 重定向到本测 tmp（不碰
真实 secret 目录）；计算体经模块级注册表 ``_KB_PREWARM_HOOKS`` 换假
函数——零真实网络拨号。TestClient 以 ``with`` 上下文持有 = portal 事件
循环跨请求存活（后台刷新任务不被请求收尾切断）。
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
    """假计算体：记录调用次数、set 事件（供等待完成）、返回固定 payload。

 兼容两种签名：tree/graph 带 agent 参数；agents 无参。"""

    def __init__(self, payload: dict) -> None:
        self.payload = payload
        self.event = threading.Event()
        self.calls = 0

    async def __call__(self, *a, **k):
        self.calls += 1
        self.event.set()
        return self.payload


def _wait_disk(key: str, older_than: float, timeout: float = 5.0):
    """轮询等磁盘缓存出现新值（ts > older_than）。

 后台刷新是 fire-and-forget 任务（portal 循环在 with 块内持续运转），
 假 compute 毫秒级完成；轮询等 ts 更新避免「事件已 set 但 _store_kb
 尚未写盘」的竞态。超时返回最后一次读（None=未更新）。"""
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


# ── 1) kb_cache 往返 + 损坏容错 ───────────────────────────────────────


def test_kb_cache_roundtrip_and_corrupt():
    """save/load 一致；key 特殊字符过滤；缺失/损坏/形状异常 → None。"""
    payload = {"agent": "w1", "files": [{"path": "a.md", "size": 1}]}
    kb_cache.save("tree-w1", payload)
    ts, got = kb_cache.load("tree-w1")
    assert got == payload
    assert ts > time.time() - 5  # ts = 写入时 epoch

    # key 过滤：路径分隔/特殊字符 → _（防穿越出缓存目录）。
    p = kb_cache._file_for("tree/a:b")
    assert p.name == "tree_a_b.json"
    assert p.parent == pathlib.Path(kb_cache.cache_dir())

    # 缺失 → None。
    assert kb_cache.load("nope") is None
    # 损坏 JSON → None（读失败不抛）。
    bad = pathlib.Path(kb_cache.cache_dir()) / "corrupt.json"
    bad.write_text("{not-json", encoding="utf-8")
    assert kb_cache.load("corrupt") is None
    # 形状异常（payload 非 dict）→ None（视同损坏）。
    bad2 = pathlib.Path(kb_cache.cache_dir()) / "shape.json"
    bad2.write_text(json.dumps({"ts": 1.0, "payload": [1, 2]}),
                    encoding="utf-8")
    assert kb_cache.load("shape") is None


# ── 2) tree 端点 SWR：stale 秒回 + 后台单飞刷新 ───────────────────────


def test_tree_swr_stale_hit_and_refresh(client, monkeypatch):
    """seed 旧磁盘缓存（ts=now-120s > TTL 60s）→ 请求秒回旧值
 （cached/age 标记）+ 触发后台刷新 → 磁盘被新值更新。"""
    tc = client
    seed = {
        "agent": "big", "workspace": "/fake/ws",
        "files": [{"path": "MEMORY.md", "name": "MEMORY.md", "size": 1,
                   "mtime": 0, "category": "profile", "openable": True}],
        "dirs": [], "count": 1,
    }
    old_ts = time.time() - 120
    _seed_disk("tree-big", old_ts, seed)

    fresh = {
        "agent": "big", "workspace": "/fake/ws", "files": [],
        "dirs": [], "count": 0, "fresh": True,
    }
    fake = _FakeCompute(fresh)
    monkeypatch.setitem(router_mod._KB_PREWARM_HOOKS, "tree", fake)

    r = tc.get("/kb/big/tree")
    assert r.status_code == 200, r.text
    body = r.json()
    # stale 秒回：payload 原样 + SWR 标记。
    assert body["cached"] is True
    assert 110 <= body["age"] <= 130
    assert body["files"] == seed["files"]
    assert body["workspace"] == "/fake/ws"
    # 后台单飞刷新：假 compute 被调一次并写新值落盘。
    assert fake.event.wait(5.0), "刷新任务未在 5s 内运行"
    hit = _wait_disk("tree-big", old_ts)
    assert hit is not None, "刷新未更新磁盘缓存"
    assert hit[1] == fresh
    assert hit[0] > old_ts
    assert fake.calls == 1  # 单飞：无重复任务
    # last-agent 落记（预热输入）。
    assert kb_cache.load("last-agent")[1] == {"agent": "big"}


# ── 3) 冷路径落盘 ─────────────────────────────────────────────────────


def test_tree_cold_path_persists(client, monkeypatch):
    """无磁盘缓存 + 假 compute → 响应正常（无 SWR 标记）且磁盘/内存
 缓存同值落位（重启/换页后秒开的前提）。"""
    tc = client
    fresh = {
        "agent": "big", "workspace": "/fake/ws", "files": [],
        "dirs": [], "count": 0, "fresh": True,
    }
    fake = _FakeCompute(fresh)
    monkeypatch.setitem(router_mod._KB_PREWARM_HOOKS, "tree", fake)
    assert kb_cache.load("tree-big") is None  # 前置：磁盘冷

    r = tc.get("/kb/big/tree")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["fresh"] is True
    assert "cached" not in body  # 冷路径不带 SWR 标记
    # 冷取落盘 + 内存缓存同值。
    hit = kb_cache.load("tree-big")
    assert hit is not None and hit[1] == fresh
    exp, mem_payload = router_mod._kb_tree_cache["big"]
    assert mem_payload == fresh
    assert exp > time.monotonic()  # TTL 未过期
    # last-agent 落记。
    assert kb_cache.load("last-agent")[1] == {"agent": "big"}
    assert fake.calls == 1


# ── 4) agents 同款（单键、不记 last-agent）────────────────────────────


def test_agents_swr_stale_hit_and_refresh(client, monkeypatch):
    """seed "agents" 旧值（ts=now-120s）→ cached=True + 原 payload +
 后台刷新更新磁盘；agents 路径不记 last-agent。"""
    tc = client
    seed = {
        "agents": [{"name": "w1", "container": "agentteams-worker-w1",
                    "state": "running", "kind": "worker"}],
        "count": 1,
    }
    old_ts = time.time() - 120
    _seed_disk("agents", old_ts, seed)

    fresh = {
        "agents": seed["agents"] + [
            {"name": "w2", "container": "agentteams-worker-w2",
             "state": "running", "kind": "worker"},
        ],
        "count": 2,
    }
    fake = _FakeCompute(fresh)
    monkeypatch.setitem(router_mod._KB_PREWARM_HOOKS, "agents", fake)

    r = tc.get("/kb/agents")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["cached"] is True
    assert 110 <= body["age"] <= 130
    assert body["count"] == 1  # stale 原样（旧名单）
    assert body["agents"] == seed["agents"]
    # 后台刷新（无参 compute）更新磁盘为新名单。
    assert fake.event.wait(5.0), "刷新任务未在 5s 内运行"
    hit = _wait_disk("agents", old_ts)
    assert hit is not None, "刷新未更新磁盘缓存"
    assert hit[1] == fresh
    assert fake.calls == 1
    # agents 不计「上次访问」。
    assert kb_cache.load("last-agent") is None
