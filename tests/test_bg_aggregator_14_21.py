# -*- coding: utf-8 -*-
# BgTicker 后台聚合骨架行为单测。
# worker_status / projects_workflow 共用的后台聚合骨架（ensure_fresh
# TTL 门/force/单飞/fire-and-forget、_sweep bg_slot 让权/异常吞没/单飞
# 复位、start/stop 生命周期）此前零行为测试，本批为后续改动上安全网。
# 风格：照 tests/test_dial_gate_14_6.py——同步测试体 + asyncio.run；
# 后台异步行为用 asyncio.Event 可控桩驱动，不靠 sleep 猜时序；
# 每个测试 dial_gate._reset_for_tests() + 全新 BgTicker 实例（自建
# state dict，形状与生产一致：scan_at/scanning + 数据键）起步。
from __future__ import annotations

import asyncio
import time

from agentteams_connector import dial_gate as dg
from agentteams_connector.bg_aggregator import BgTicker


def _make_state(**overrides) -> dict:
    """全新状态容器（生产形状：骨架只碰 scan_at / scanning 两键）。"""
    state = {"scan_at": 0.0, "scanning": False}
    state.update(overrides)
    return state


# ── ensure_fresh：前台入口（非阻塞 / 不抛 / TTL / force / 单飞） ──────────


def test_ensure_fresh_unexpired_no_scan():
    """未过期（now - scan_at < ttl）且非 force → 不触发扫描。"""
    dg._reset_for_tests()
    state = _make_state(scan_at=time.time())
    calls = []

    async def do_sweep():
        calls.append(1)

    t = BgTicker("t", state, do_sweep, ttl=60.0)

    async def main():
        t.ensure_fresh()
        # TTL 门拦住 → 未建后台任务（循环里只剩 main 自己）
        assert len(asyncio.all_tasks()) == 1

    asyncio.run(main())
    assert calls == []
    assert state["scanning"] is False
    dg._reset_for_tests()


def test_ensure_fresh_force_bypasses_ttl():
    """force=True → 无视 TTL（未过期也触发），扫描跑完单飞位复位。"""
    dg._reset_for_tests()
    state = _make_state(scan_at=time.time())  # 未过期
    calls = []
    finished = asyncio.Event()

    async def do_sweep():
        calls.append(1)
        finished.set()

    t = BgTicker("t", state, do_sweep, ttl=60.0)

    async def main():
        t.ensure_fresh(force=True)
        await asyncio.wait_for(finished.wait(), timeout=2.0)

    asyncio.run(main())
    assert calls == [1]
    assert state["scanning"] is False  # 收尾复位
    dg._reset_for_tests()


def test_ensure_fresh_scanning_no_reentry():
    """scanning=True（单飞）→ force+过期也不重入，不动既有扫描。"""
    dg._reset_for_tests()
    state = _make_state(scan_at=0.0, scanning=True)
    calls = []

    async def do_sweep():
        calls.append(1)

    t = BgTicker("t", state, do_sweep, ttl=1.0)

    async def main():
        t.ensure_fresh(force=True)
        assert len(asyncio.all_tasks()) == 1  # 未建第二个后台任务

    asyncio.run(main())
    assert calls == []
    assert state["scanning"] is True  # 既有扫描标记不变
    dg._reset_for_tests()


def test_ensure_fresh_no_running_loop_silent_skip():
    """无运行事件循环上下文 → 静默跳过：不抛、不建悬挂协程/任务。"""
    dg._reset_for_tests()
    state = _make_state(scan_at=0.0)  # 已过期（否则测试不到循环分支）
    calls = []

    async def do_sweep():
        calls.append(1)

    t = BgTicker("t", state, do_sweep, ttl=1.0)

    # 运行事件循环之外：必须不抛
    t.ensure_fresh(force=True)
    assert calls == []
    assert state["scanning"] is False

    # 新起的干净循环里没有残留后台任务（无悬挂协程）
    async def probe():
        await asyncio.sleep(0)
        return asyncio.all_tasks(), asyncio.current_task()

    tasks, me = asyncio.run(probe())
    assert tasks == {me}
    dg._reset_for_tests()


def test_ensure_fresh_fire_and_forget():
    """触发是 fire-and-forget：ensure_fresh 立即返回，do_sweep 后台跑。"""
    dg._reset_for_tests()
    state = _make_state(scan_at=0.0)
    calls = []
    started = asyncio.Event()
    release = asyncio.Event()
    finished = asyncio.Event()

    async def do_sweep():
        calls.append(1)
        started.set()
        await release.wait()  # 可控桩：被放行前不完成
        finished.set()

    t = BgTicker("t", state, do_sweep, ttl=1.0)

    async def main():
        t.ensure_fresh()  # 立即返回（非阻塞）
        await asyncio.wait_for(started.wait(), timeout=2.0)
        assert state["scanning"] is True  # 扫描进行中的单飞位
        release.set()
        await asyncio.wait_for(finished.wait(), timeout=2.0)

    asyncio.run(main())
    assert calls == [1]
    assert state["scanning"] is False  # 收尾复位
    dg._reset_for_tests()


# ── _sweep：单飞 + 共用通道 + 异常隔离 ───────────────────────────────────


def test_sweep_single_flight_early_return():
    """scanning 已 True → 直接返回：do_sweep 不调用、既有标记不复位。"""
    dg._reset_for_tests()
    state = _make_state(scanning=True)
    calls = []

    async def do_sweep():
        calls.append(1)

    t = BgTicker("t", state, do_sweep)

    async def main():
        await t._sweep()  # 直接返回，不抛

    asyncio.run(main())
    assert calls == []
    assert state["scanning"] is True  # 早退路径不碰既有标记
    dg._reset_for_tests()


def test_sweep_bg_slot_yield_skips_round():
    """bg_slot 让权（前台忙，inflight 超让权线）→ 本轮跳过。"""
    dg._reset_for_tests()
    state = _make_state(scan_at=0.0)
    calls = []
    busy = dg._BG_YIELD_THRESHOLD + 1

    async def do_sweep():
        calls.append(1)

    t = BgTicker("t", state, do_sweep)

    async def main():
        for _ in range(busy):
            dg._enter("async", "/busy")  # 模拟前台 busy
        try:
            await t._sweep()  # 让权 → 跳过本轮，不抛
        finally:
            for _ in range(busy):
                dg._exit("async")

    asyncio.run(main())
    assert calls == []
    assert state["scanning"] is False  # 收尾复位（下 tick 可重试）
    assert dg.dial_stats()["async"]["inflight"] == 0
    dg._reset_for_tests()


def test_sweep_swallows_do_sweep_exception():
    """do_sweep 抛异常 → 被吞（不向上抛）、scanning 复位 False。"""
    dg._reset_for_tests()
    state = _make_state()
    calls = []

    async def do_sweep():
        calls.append(1)
        raise ValueError("sweep boom")

    t = BgTicker("t", state, do_sweep)

    async def main():
        await t._sweep()  # 不得向上抛（否则 asyncio.run 会传播）

    asyncio.run(main())
    assert calls == [1]
    assert state["scanning"] is False
    dg._reset_for_tests()


def test_sweep_normal_calls_once_and_resets():
    """正常路径：do_sweep 恰好一次；扫描中 scanning=True、收尾 False。"""
    dg._reset_for_tests()
    state = _make_state()
    calls = []
    scanning_during = []

    async def do_sweep():
        calls.append(1)
        scanning_during.append(state["scanning"])

    t = BgTicker("t", state, do_sweep)

    async def main():
        await t._sweep()

    asyncio.run(main())
    assert calls == [1]
    assert scanning_during == [True]  # 扫描体执行期间持单飞位
    assert state["scanning"] is False
    dg._reset_for_tests()


# ── 生命周期：start 幂等 / stop 取消 ─────────────────────────────────────


def test_start_idempotent_and_stop_cancels():
    """重复 start 只起一个 task；stop 取消 task；stop 后再 start 起新 task。"""
    dg._reset_for_tests()
    state = _make_state()
    calls = []

    async def do_sweep():
        calls.append(1)

    # startup_delay=10s：tick 循环停在启动让行，不会真到 ensure_fresh
    t = BgTicker("t", state, do_sweep, tick=1.0, ttl=1.0, startup_delay=10.0)

    async def main():
        t.start()
        first = t._task
        assert first is not None and not first.done()
        t.start()  # 幂等：不另起
        t.start()
        assert t._task is first
        assert len(asyncio.all_tasks()) == 2  # main + 恰好一个 tick task
        await t.stop()
        assert first.done()
        assert first.cancelled()
        # stop 后再 start：旧 task 已终态 → 允许起新 task
        t.start()
        assert t._task is not first
        assert not t._task.done()
        await t.stop()

    asyncio.run(main())
    assert calls == []  # 从未走到 ensure_fresh
    dg._reset_for_tests()


def test_stop_without_start_is_safe():
    """未 start 直接 stop（task=None）→ 不抛。"""
    dg._reset_for_tests()

    async def do_sweep():
        return None

    t = BgTicker("t", _make_state(), do_sweep)

    async def main():
        await t.stop()

    asyncio.run(main())
    dg._reset_for_tests()
