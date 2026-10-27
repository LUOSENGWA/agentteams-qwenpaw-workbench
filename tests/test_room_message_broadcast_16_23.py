# -*- coding: utf-8 -*-
"""R1（16.23）room_message 广播过滤统一回归测试。

背景：旧过滤 ``not baseline and sender and sender != me`` 排除自己的
消息（假设「乐观回显路径已自行刷新」）。但乐观回显只覆盖**当前打开
房间**的 React 状态——自己在非活动房间（左侧房间列表 / WorkerChats
抽屉）发的消息，要切房/手动刷新才进前端消息缓存（「发了消息却看不到」
根因）。修复：去掉 ``sender != me``，自己的消息也广播；前端乐观回显与
SSE 合并按 event_id 去重，重复合并幂等无副作用。排除保留：基线轮
（存量不重放）、无 sender 事件。

护栏：

- 非基线 + 有 sender（含自己）→ 广播；
- 基线轮 → 不广播（reason=baseline）；
- 无 sender → 不广播（reason=no-sender）；
- debug 计数 acquire/release 配对、release 0 处截断；
- SSE fan-out 端到端：subscribe → _broadcast → 队列收到事件。
"""
from __future__ import annotations

import asyncio

import pytest

from agentteams_connector import sync_watcher as sw

ME = "@human:example.org"
OTHER = "@worker-1:example.org"


@pytest.fixture(autouse=True)
def _reset_debug():
    # debug 计数强制归零——逐测隔离（失败半途不留状态）。
    sw._debug_refs = 0
    yield
    sw._debug_refs = 0


def test_self_message_now_broadcast():
    # R1 核心语义：自己的消息不再被排除（前端 event_id 去重，
    # 重复合并幂等）。
    assert sw.room_message_broadcast_decision(False, ME) == (True, "")


def test_other_message_broadcast():
    assert sw.room_message_broadcast_decision(False, OTHER) == (True, "")


def test_baseline_round_still_skipped():
    # 首轮存量不重放（语义不变）。
    ok, reason = sw.room_message_broadcast_decision(True, OTHER)
    assert ok is False
    assert reason == "baseline"


def test_no_sender_skipped():
    ok, reason = sw.room_message_broadcast_decision(False, "")
    assert ok is False
    assert reason == "no-sender"


def test_debug_refcount_pairs():
    assert sw.debug_enabled() is False
    sw.debug_acquire()
    assert sw.debug_enabled() is True
    sw.debug_acquire()
    sw.debug_release()
    assert sw.debug_enabled() is True  # 另一连接仍在
    sw.debug_release()
    assert sw.debug_enabled() is False
    sw.debug_release()  # 多余 release：0 处截断，不变负
    assert sw.debug_enabled() is False


def test_broadcast_delivers_to_subscribers():
    """端到端：subscribe → _broadcast → 队列收到事件（SSE fan-out 不破坏）。"""

    async def main():
        q = sw.subscribe()
        try:
            await sw._broadcast(
                {
                    "type": "room_message",
                    "room_id": "!r:example.org",
                    "sender": ME,
                    "event_id": "$e1",
                }
            )
            event = q.get_nowait()
            assert event["type"] == "room_message"
            assert event["sender"] == ME
        finally:
            sw.unsubscribe(q)

    asyncio.run(main())
