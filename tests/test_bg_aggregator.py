# -*- coding: utf-8 -*-
"""v0.5.0-beta.14.25（任务 190）BgTicker 生命周期骨架单测。

只测骨架语义（扫描体 do_sweep 以 mock 协程注入，不碰真实网络；bg_slot
取真身——测试进程空闲时立即获锁，与生产路径一致）：

1. **单飞**：扫描进行中（scanning=True）ensure_fresh 不重入；
2. **去重（TTL）**：TTL 内非 force 跳过；force 无视 TTL；
3. **无事件循环静默跳过**：ensure_fresh 不抛、不起任务；
4. **单轮异常不杀循环**：扫描体异常被吞、scanning 复位、下一轮可用。
"""
from __future__ import annotations

import asyncio
import time

from agentteams_connector.bg_aggregator import BgTicker


def _state(scan_at: float = 0.0, scanning: bool = False) -> dict:
    return {"scan_at": scan_at, "scanning": scanning, "data": None}


async def test_single_flight_no_reentry():
    """单飞：扫描进行中，ensure_fresh（含 force）不重入。"""
    started = asyncio.Event()
    release = asyncio.Event()
    calls: list[int] = []

    async def do_sweep():
        calls.append(1)
        started.set()
        await release.wait()

    state = _state()
    t = BgTicker("t-sf", state, do_sweep)
    task = asyncio.create_task(t._sweep())
    await started.wait()
    assert state["scanning"] is True
    t.ensure_fresh(force=True)  # 扫描中 → 忽略
    await asyncio.sleep(0.01)
    assert calls == [1]
    release.set()
    await task
    assert state["scanning"] is False
    assert calls == [1]


async def test_ttl_dedup_and_force():
    """去重：TTL 内非 force 跳过；force 无视 TTL 触发。"""
    calls: list[int] = []

    async def do_sweep():
        calls.append(1)

    state = _state(scan_at=time.time())  # 视为刚扫完
    t = BgTicker("t-ttl", state, do_sweep, ttl=30.0)
    t.ensure_fresh()
    await asyncio.sleep(0.02)
    assert calls == []  # TTL 内 → 跳过
    t.ensure_fresh(force=True)
    await asyncio.sleep(0.02)
    assert calls == [1]
    assert state["scanning"] is False


def test_ensure_fresh_no_loop_silent_skip():
    """无运行事件循环：ensure_fresh 静默跳过（不抛、不起任务）。"""
    state = _state(scan_at=0.0)

    async def do_sweep():  # pragma: no cover - 不得被调用
        raise AssertionError("do_sweep must not run without a loop")

    t = BgTicker("t-nol", state, do_sweep)
    t.ensure_fresh(force=True)  # 必须不抛
    assert state["scanning"] is False


async def test_sweep_exception_swallowed_and_flag_reset():
    """单轮扫描体异常只告警：scanning 复位、下一轮可再扫。"""

    class _Boom(Exception):
        pass

    async def do_sweep_boom():
        raise _Boom()

    state = _state()
    t = BgTicker("t-boom", state, do_sweep_boom)
    await t._sweep()  # 不得抛出
    assert state["scanning"] is False

    ok: list[int] = []

    async def do_sweep_ok():
        ok.append(1)

    t._do_sweep = do_sweep_ok
    await t._sweep()
    assert ok == [1]
