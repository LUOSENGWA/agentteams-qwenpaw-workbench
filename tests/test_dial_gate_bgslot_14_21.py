# -*- coding: utf-8 -*-
# dial_gate 后台共用通道（bg_slot / bg_lock）+
# dial_stats 计数行为单测。
# bg_slot 是 worker_status / projects_workflow / KB 刷新三类后台扫描的
# 共用通道（让权 + 单飞 + 等锁超时防堆积），此前仅有静态护栏、无行为
# 测试。异步行为全部用 asyncio.Event 可控桩驱动，不靠 sleep 猜时序；
# 每个测试 dial_gate._reset_for_tests() 起步（计数/信号量/通道锁独立）。
from __future__ import annotations

import asyncio

from agentteams_connector import dial_gate as dg


def test_bg_slot_yield_boundary_by_inflight():
    """让权线是严格 >：inflight == threshold 放行；> threshold 让权 False。"""
    dg._reset_for_tests()
    thr = dg._BG_YIELD_THRESHOLD

    async def main():
        # 恰好压线（== thr）：前台不忙 → 正常过通道
        for _ in range(thr):
            dg._enter("async", "/busy")
        try:
            async with dg.bg_slot() as ok:
                assert ok is True
        finally:
            for _ in range(thr):
                dg._exit("async")
        # 超线一格（== thr+1）：前台忙 → 让权
        for _ in range(thr + 1):
            dg._enter("async", "/busy")
        try:
            async with dg.bg_slot(timeout=0.01) as ok:
                assert ok is False
        finally:
            for _ in range(thr + 1):
                dg._exit("async")
        assert dg.dial_stats()["async"]["inflight"] == 0

    asyncio.run(main())
    dg._reset_for_tests()


def test_bg_slot_normal_yields_true_and_releases_lock():
    """正常路径 → yield True（执行期持共用锁）；退出后锁释放、可再 acquire。"""
    dg._reset_for_tests()

    async def main():
        lock = dg.bg_lock()
        assert not lock.locked()
        async with dg.bg_slot() as ok:
            assert ok is True
            assert lock.locked()  # 执行期持锁（单飞）
        assert not lock.locked()  # 退出后释放
        assert await asyncio.wait_for(lock.acquire(), timeout=1.0)
        lock.release()

    asyncio.run(main())
    dg._reset_for_tests()


def test_bg_slot_wait_lock_timeout_yields_false():
    """另一协程持锁不放 + 短 timeout → yield False；超时等待不偷锁/不释放。"""
    dg._reset_for_tests()

    async def main():
        holder_ok = []
        holder_started = asyncio.Event()
        holder_release = asyncio.Event()

        async def holder():
            async with dg.bg_slot() as ok:
                holder_ok.append(ok)
                holder_started.set()
                await holder_release.wait()  # 持锁不放

        h = asyncio.create_task(holder())
        await asyncio.wait_for(holder_started.wait(), timeout=2.0)
        async with dg.bg_slot(timeout=0.05) as ok:
            assert ok is False  # 等锁超时 → 本轮放弃
        assert dg.bg_lock().locked()  # 锁仍在第一方手里，未被超时方动过
        assert holder_ok == [True]
        holder_release.set()
        await asyncio.wait_for(h, timeout=2.0)

    asyncio.run(main())
    dg._reset_for_tests()


def test_bg_slot_single_flight_serializes_two_coroutines():
    """单飞：两协程并发进 bg_slot → 严格串行，同一时刻只有一个持有 True。"""
    dg._reset_for_tests()

    async def main():
        order = []
        a_in = asyncio.Event()
        a_out = asyncio.Event()
        b_in = asyncio.Event()
        b_out = asyncio.Event()
        hold_a = asyncio.Event()
        hold_b = asyncio.Event()

        async def worker(tag, ev_in, ev_out, hold):
            async with dg.bg_slot() as ok:
                assert ok is True
                order.append(f"{tag}:in")
                ev_in.set()
                await hold.wait()  # 持锁至被放行
                order.append(f"{tag}:out")
                ev_out.set()

        ta = asyncio.create_task(worker("A", a_in, a_out, hold_a))
        await asyncio.wait_for(a_in.wait(), timeout=2.0)
        tb = asyncio.create_task(worker("B", b_in, b_out, hold_b))
        await asyncio.sleep(0)  # 让 B 走到共用通道（A 持锁期间 B 不得进入）
        assert not b_in.is_set()  # A 持锁期间 B 进不去
        hold_a.set()
        await asyncio.wait_for(a_out.wait(), timeout=2.0)
        hold_b.set()
        await asyncio.wait_for(b_out.wait(), timeout=2.0)
        await asyncio.gather(ta, tb)
        assert order == ["A:in", "A:out", "B:in", "B:out"]

    asyncio.run(main())
    dg._reset_for_tests()


def test_stats_counters_enter_exit_bytes():
    """_enter/_exit/_record_bytes：total/inflight/peak/bytes/top_paths 精确。"""
    dg._reset_for_tests()
    s = dg.dial_stats()
    assert s["async"]["total"] == 0
    assert s["async"]["inflight"] == 0
    assert s["async"]["peak"] == 0
    assert s["async"]["bytes_total"] == 0
    assert s["async"]["top_paths"] == []
    assert s["sync"]["total"] == 0

    dg._enter("async", "/a")
    dg._enter("async", "/a")
    dg._enter("async", "/b")
    dg._enter("async", "")  # 空 path：只计总数，不记路径
    s = dg.dial_stats()
    assert s["async"]["total"] == 4
    assert s["async"]["inflight"] == 4
    assert s["async"]["peak"] == 4
    counts = {p["path"]: p["count"] for p in s["async"]["top_paths"]}
    assert counts == {"/a": 2, "/b": 1}

    dg._exit("async")
    s = dg.dial_stats()
    assert s["async"]["total"] == 4  # total 不随 exit 回退
    assert s["async"]["inflight"] == 3
    assert s["async"]["peak"] == 4  # 峰值只增不减

    dg._record_bytes("/a", 100)
    dg._record_bytes("/b", 50)
    s = dg.dial_stats()
    assert s["async"]["bytes_total"] == 150
    by_path = {p["path"]: p for p in s["async"]["top_paths"]}
    assert by_path["/a"]["bytes"] == 100
    assert by_path["/b"]["bytes"] == 50

    # 空 path / 非正字节 → 忽略（不抛、不计数）
    dg._record_bytes("", 999)
    dg._record_bytes("/a", 0)
    dg._record_bytes("/a", -5)
    assert dg.dial_stats()["async"]["bytes_total"] == 150

    dg._enter("sync", "")
    assert dg.dial_stats()["sync"]["total"] == 1
    dg._exit("sync")
    dg._reset_for_tests()


def test_reset_for_tests_zeroes_counters_and_locks():
    """_reset_for_tests：计数归零、后台通道锁重建（新锁未持）。"""
    dg._reset_for_tests()
    dg._enter("async", "/x")
    dg._enter("async", "/x")
    dg._record_bytes("/x", 42)
    dg._enter("sync", "")

    s = dg.dial_stats()
    assert s["async"]["total"] == 2
    assert s["async"]["inflight"] == 2
    assert s["async"]["peak"] == 2
    assert s["async"]["bytes_total"] == 42
    assert s["sync"]["total"] == 1

    dg._reset_for_tests()
    s = dg.dial_stats()
    assert s["async"]["total"] == 0
    assert s["async"]["inflight"] == 0
    assert s["async"]["peak"] == 0
    assert s["async"]["bytes_total"] == 0
    assert s["async"]["top_paths"] == []
    assert s["sync"]["total"] == 0

    async def probe():
        assert not dg.bg_lock().locked()  # 锁已重建 → 新锁未持

    asyncio.run(probe())
    dg._reset_for_tests()
