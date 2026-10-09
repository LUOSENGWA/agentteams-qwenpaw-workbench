# -*- coding: utf-8 -*-
"""v0.5.0-beta.14.12：保存提速 + 闸门让权 + 快照参数。

覆盖三组对外钉死语义：

1. PUT /config 快速路径：
 - 保存即时返回（<1s）——探测转后台（假 refresh_effective 睡 2s；
 回归旧同步 await 行为 → 请求 ~2s，被耗时断言抓住）；
 - 后台探测任务真实执行（保存返回后假探测完成并记录，非被吞掉）；
 - 保存失败显性化：update_config 抛 OSError → 500 且 detail 含原因
 （此前裸抛 = 500 无详情）。
2. bg_slot 后台共用通道（dial_gate）：
 - 多路假后台扫描并发 → 实际串行（并发峰值 = 1）；
 - 前台负载高（async inflight=13 > 12）→ 让权 False，本轮跳过；
 - 锁被另一路扫描持占 → 等锁超时放弃本轮（False）；释放后正常
 获取（True）。
3. ?refresh=1 快照参数：
 - /workers-status 与 /projects-workflow 无参 → ensure_fresh(force=False)
 （TTL 门保留）；refresh=1 → ensure_fresh(force=True)（无视 TTL）；
 响应字段形状不变（仍是快照）；
 - ensure_fresh(force=True) 直接语义：TTL 内普通调用不扫、force 触发
 一轮（假取数注入）。

隔离：config 模块重定向 tmp_path；探测/取数全部 monkeypatch 假注入，
不碰真实网络与真实 secret 目录。
"""
from __future__ import annotations

import asyncio
import time

import pytest

from agentteams_connector import config as config_mod
from agentteams_connector import dial_gate as dg
from agentteams_connector import projects_workflow as pw
from agentteams_connector import selfcheck as selfcheck_mod
from agentteams_connector import worker_status as ws
from agentteams_connector.router import build_router


@pytest.fixture()
def client(monkeypatch, tmp_path):
    """TestClient + 真实 config（重定向 tmp）+ 慢速假探测（2s）。

 with 块保持 portal 存活：保存请求返回后，后台探测任务可在块内
 自然跑完（不留悬挂 task，也证明「探测在保存返回之后执行」）。
 """
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    cfg_dir = tmp_path / "agentteams-qwenpaw-workbench"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(config_mod, "_SECRET_DIR", tmp_path)
    monkeypatch.setattr(config_mod, "_CONFIG_DIR", cfg_dir)
    monkeypatch.setattr(config_mod, "_CONFIG_PATH", cfg_dir / "config.json")

    probe = {"entered": False, "done": False}

    async def slow_probe(cfg, kinds=("matrix", "controller")):
        probe["entered"] = True
        await asyncio.sleep(2.0)  # 模拟全地址探测耗时（远大于保存返回耗时）
        probe["done"] = True
        return {}

    monkeypatch.setattr(selfcheck_mod, "refresh_effective", slow_probe)

    app = FastAPI()
    app.include_router(build_router())
    return TestClient(app), probe


# ── 1) PUT /config 快速路径 ────────────────────────────────────────────


def test_put_config_fast_return_probe_background(client):
    """1a) 保存即时返回（<1s）；探测在后台执行且真实跑完。

 回归旧行为（同步 await refresh_effective）→ 请求 ~2s，被
 elapsed < 1.0 抓住；probe["done"] 证明后台任务被创建并执行
 （fire-and-forget 不是被吞掉）。
 """
    tc, probe = client
    with tc:
        t0 = time.monotonic()
        r = tc.put(
            "/config",
            json={"config": {"controller_urls": ["http://10.0.0.1:8091"]}},
        )
        elapsed = time.monotonic() - t0
        assert r.status_code == 200
        assert elapsed < 1.0  # 快返回：不等 2s 探测
        # 合并值已落盘（真实 update_config 路径，tmp 隔离）。
        assert config_mod.load_config()["controller_urls"] == [
            "http://10.0.0.1:8091"
        ]
        # 等后台探测（2s 假）自然完成——无悬挂 task，且证明探测发生在
        # 保存返回之后。
        deadline = time.monotonic() + 3.0
        while not probe["done"] and time.monotonic() < deadline:
            time.sleep(0.05)
        assert probe["entered"] and probe["done"]


def test_put_config_write_failure_500_with_detail(client, monkeypatch):
    """1b) 保存失败显性化：落盘失败 → 500 + detail 含原因（非裸抛
 500 无详情）。

 v0.5.0-beta.14.12：OSError（=IOError）现归入「磁盘写入
 问题」分类分支——措辞由「配置写入失败」细化为「配置保存失败（磁盘写
 入问题）」，此处钉新措辞。
 """
    tc, _ = client

    def boom(patch, **kw):
        raise OSError("No space left on device")

    monkeypatch.setattr(config_mod, "update_config", boom)
    with tc:
        r = tc.put("/config", json={"config": {"address_mode": "lan"}})
    assert r.status_code == 500
    detail = r.json()["detail"]
    assert "配置保存失败（磁盘写入问题）" in detail
    assert "No space left on device" in detail


# ── 2) bg_slot 后台共用通道 ────────────────────────────────────────────


def test_bg_slot_serializes_background_tasks():
    """2a) 通道互斥：3 路假后台扫描并发 → 实际串行（并发峰值 = 1）。"""
    dg._reset_for_tests()
    state = {"cur": 0, "peak": 0}

    async def bg():
        async with dg.bg_slot() as ok:
            assert ok
            state["cur"] += 1
            state["peak"] = max(state["peak"], state["cur"])
            await asyncio.sleep(0.02)
            state["cur"] -= 1

    async def main():
        await asyncio.gather(bg(), bg(), bg())

    asyncio.run(main())
    assert state["peak"] == 1
    assert state["cur"] == 0


def test_bg_slot_yields_when_foreground_busy():
    """2b) 让权：async inflight=13（>12 让权线）→ False，本轮跳过。"""
    dg._reset_for_tests()
    for _ in range(13):
        dg._enter("async", "/api/hot")

    out: list[bool] = []

    async def main():
        async with dg.bg_slot() as ok:
            out.append(ok)

    asyncio.run(main())
    assert out == [False]


def test_bg_slot_gives_up_on_wait_timeout():
    """2c) 锁被另一路扫描持占 → 等锁超时（0.2s）放弃本轮（False）；
 释放后正常获取（True）。"""
    dg._reset_for_tests()
    out: list[bool] = []

    async def main():
        lock = dg.bg_lock()
        await lock.acquire()  # 模拟另一路后台扫描占着通道
        try:
            async with dg.bg_slot(timeout=0.2) as ok:
                out.append(ok)
        finally:
            lock.release()
        async with dg.bg_slot(timeout=0.5) as ok:
            out.append(ok)

    asyncio.run(main())
    assert out == [False, True]


# ── 3) ?refresh=1 快照参数 ─────────────────────────────────────────────


def test_endpoints_refresh_param_forces_fresh(client, monkeypatch):
    """3a) ?refresh=1：两端点传 force=True（无视 TTL）；无参 force=False
 （TTL 门保留）。响应字段形状不变（仍是快照）。"""
    tc, _ = client
    calls: dict[str, bool] = {}

    def rec_ws(force: bool = False):
        calls["ws"] = force

    def rec_pw(force: bool = False):
        calls["pw"] = force

    monkeypatch.setattr(ws, "ensure_fresh", rec_ws)
    monkeypatch.setattr(pw, "ensure_fresh", rec_pw)
    with tc:
        r1 = tc.get("/workers-status")
        assert r1.status_code == 200
        assert calls["ws"] is False
        r2 = tc.get("/workers-status", params={"refresh": 1})
        assert r2.status_code == 200
        assert calls["ws"] is True
        r3 = tc.get("/projects-workflow")
        assert r3.status_code == 200
        assert calls["pw"] is False
        r4 = tc.get("/projects-workflow", params={"refresh": 1})
        assert r4.status_code == 200
        assert calls["pw"] is True
    # 响应字段形状不变（原快照字段全在）。
    for r in (r1, r2):
        assert {"ok", "workers", "scanAt", "scanning"} <= set(r.json())
    for r in (r3, r4):
        assert (
            {"ok", "projects", "workflows", "projectsStatus", "scanAt", "scanning"}
            <= set(r.json())
        )


def test_ensure_fresh_force_bypasses_ttl(monkeypatch):
    """3b) ensure_fresh force 直接语义：TTL 内普通调用不扫；force=True
 触发一轮（假取数注入；单飞门与通道正常收拢）。"""
    calls: list[str] = []

    async def fake_get(url, token):
        calls.append(url)
        return 200, {"workers": [{"name": "w1"}]}, ""

    monkeypatch.setattr(
        config_mod,
        "load_config",
        lambda: {
            "controller_urls": ["http://ctl.test"],
            "controller_token": "tok",
        },
    )
    monkeypatch.setattr(ws, "_ctl_get", fake_get)
    ws._agg["workers"] = {}
    ws._agg["scan_at"] = time.time()  # 新鲜（TTL 未过期）
    ws._agg["scanning"] = False
    ws._names_cache["names"] = []
    ws._names_cache["ts"] = 0.0

    async def drive():
        ws.ensure_fresh()
        assert calls == []  # TTL 内 → 不扫
        ws.ensure_fresh(force=True)  # force → 无视 TTL 起一轮
        await asyncio.sleep(0.05)  # 让后台任务跑完一轮

    asyncio.run(drive())
    assert any("/api/v1/workers" in u for u in calls)
    assert ws._agg["scanning"] is False
