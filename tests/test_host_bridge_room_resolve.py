# -*- coding: utf-8 -*-
"""宿主收件箱审批桥——房间侧决议传导（v0.5.0-beta.11.1）单测。

回归护栏（re7 后发现的正确性缺陷）：

- **插件卡路径**：用户从插件审批卡批准/拒绝 → 命令直接发房间 →
  watcher 检出 → ``note_room_resolved`` 必须立即消解宿主记录。
  否则宿主记录挂到 30 分钟超时 → 桥补发一条**陈旧的 deny** 回房间。
- **宿主卡路径**：用户从宿主收件箱卡批准 → 决议回调必须发 Matrix
  命令回房间（带三重 @Worker）——这是正常路径，不能被房间侧逻辑误伤。

宿主 ``qwenpaw.app.approvals`` / ``qwenpaw.security.tool_guard.approval``
以假模块注入 sys.modules（单测不依赖真实宿主服务）。
"""
from __future__ import annotations

import asyncio
import sys
import types
from types import SimpleNamespace

import pytest


# ── 假宿主模块 ─────────────────────────────────────────────
class _FakeDecision:
    APPROVED = "APPROVED"
    DENIED = "DENIED"
    TIMEOUT = "TIMEOUT"


class _FakeSummary:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class _FakeApprovalService:
    def __init__(self) -> None:
        self.created = []
        self.resolved = []

    def create_pending_summary(self, **kw):
        async def _impl():
            rid = f"rid-{len(self.created):03d}"
            loop = asyncio.get_running_loop()
            p = SimpleNamespace(
                request_id=rid,
                future=loop.create_future(),
                extra=kw.get("extra") or {},
                summary=kw.get("summary"),
            )
            self.created.append(p)
            return p
        return _impl()

    async def resolve_request(self, rid, decision, scope=None):
        self.resolved.append((rid, decision))
        for p in self.created:
            if p.request_id == rid and not p.future.done():
                p.future.set_result(decision)
        return None


_FAKE_SVC = _FakeApprovalService()


def _install_fake_host() -> None:
    """把假 qwenpaw 模块装进 sys.modules（幂等）。"""
    mods = {
        "qwenpaw": types.ModuleType("qwenpaw"),
        "qwenpaw.app": types.ModuleType("qwenpaw.app"),
        "qwenpaw.app.approvals": types.ModuleType("qwenpaw.app.approvals"),
        "qwenpaw.security": types.ModuleType("qwenpaw.security"),
        "qwenpaw.security.tool_guard": types.ModuleType(
            "qwenpaw.security.tool_guard"),
        "qwenpaw.security.tool_guard.approval": types.ModuleType(
            "qwenpaw.security.tool_guard.approval"),
    }
    mods["qwenpaw"].app = mods["qwenpaw.app"]
    mods["qwenpaw.app"].approvals = mods["qwenpaw.app.approvals"]
    mods["qwenpaw"].security = mods["qwenpaw.security"]
    mods["qwenpaw.security"].tool_guard = mods["qwenpaw.security.tool_guard"]
    mods["qwenpaw.security.tool_guard"].approval = (
        mods["qwenpaw.security.tool_guard.approval"])
    mods["qwenpaw.app.approvals"].get_approval_service = (
        lambda: _FAKE_SVC)
    mods["qwenpaw.app.approvals"].ApprovalRequestSummary = _FakeSummary
    mods["qwenpaw.security.tool_guard.approval"].ApprovalDecision = (
        _FakeDecision)
    for name, mod in mods.items():
        sys.modules.setdefault(name, mod)


@pytest.fixture()
def bridge(monkeypatch):
    _install_fake_host()
    from agentteams_connector import host_bridge as hb

    fresh = hb.HostApprovalBridge()
    monkeypatch.setattr(hb, "bridge", fresh)
    _FAKE_SVC.created.clear()
    _FAKE_SVC.resolved.clear()
    # 发送/配置面：记录式假实现
    from agentteams_connector import config, matrix_client, router

    sent: list = []
    monkeypatch.setattr(
        config, "load_config",
        lambda: {"matrix": {"access_token": "tok-test"}},
    )
    monkeypatch.setattr(
        router, "_ordered_addresses",
        lambda cfg, kind: ["https://hs.example"],
    )
    monkeypatch.setattr(
        matrix_client, "send_message",
        lambda hs, tok, rid, body, msgtype="m.text", content=None:
        sent.append({"room": rid, "body": body, "content": content}),
    )
    fresh._sent = sent  # 测试断言句柄
    return fresh


def _item(room="!r:hs", sender="@worker1:hs", event_id="$ev1",
          body="🛡️ 审批请求：shell") -> dict:
    return {
        "room_id": room,
        "sender": sender,
        "body": body,
        "event_id": event_id,
        "kind": "shell",
        "approve_cmd": "/approval approve",
        "deny_cmd": "/approval deny",
    }


async def _drain(seconds: float = 0.05) -> None:
    await asyncio.sleep(seconds)


# ── 命令检测（@Worker 前缀形态兼容）────────────────────────
def test_is_approval_command_both_forms():
    from agentteams_connector.sync_watcher import (
        _approval_command_kind,
        _is_approval_command,
    )

    cases = [
        # (body, 是命令, 方向)
        ("/approval approve", True, "approve"),
        ("/approval deny", True, "deny"),
        ("/approve", True, "approve"),
        ("@worker1 /approval approve", True, "approve"),
        ("@worker1 /approval deny", True, "deny"),
        ("@worker1 /approve", True, "approve"),
        ("@worker1 请批准", False, None),
        ("", False, None),
        ("这是一条普通消息 /approval", False, None),
    ]
    for body, is_cmd, kind in cases:
        assert _is_approval_command(body) is is_cmd, body
        if is_cmd:
            assert _approval_command_kind(body) == kind, body


# ── 场景 ──────────────────────────────────────────────────
def test_host_card_path_sends_matrix_command(bridge):
    """正常路径：宿主卡决议 → 回调发 Matrix 命令（三重 @）。"""

    async def main():
        rid = await bridge.inject(_item())
        assert rid
        await _FAKE_SVC.resolve_request(rid, _FakeDecision.APPROVED)
        await _drain()
        assert len(bridge._sent) == 1
        msg = bridge._sent[0]
        # 命令带 @Worker 前缀（无 @ 不进 Worker 消费队列）
        assert msg["body"].startswith("@worker1 ")
        assert msg["body"].endswith("/approval approve")
        # 三重 @：m.mentions + matrix.to 链接 + 正文 @localpart
        assert (msg["content"] or {}).get("m.mentions", {}).get(
            "user_ids") == ["@worker1:hs"]
        assert "matrix.to" in str((msg["content"] or {}).get(
            "formatted_body", ""))
        assert "@worker1" in msg["body"]
        assert bridge._by_request == {}  # 记录已消解

    asyncio.run(main())


def test_room_side_resolve_suppresses_stale_send(bridge):
    """插件卡路径：房间侧先行批准 → 宿主记录立即消解 + 不补发命令。"""

    async def main():
        rid = await bridge.inject(_item(event_id="$ev1"))
        assert rid
        # watcher 检出房间里的 /approval approve 命令（thread reply → $ev1）
        bridge.note_room_resolved(True, event_id="$ev1", room_id="!r:hs")
        await _drain()
        # 宿主记录已消解（方向 = 房间侧实际决议 approve）
        assert _FAKE_SVC.resolved == [(rid, _FakeDecision.APPROVED)]
        # 决议回调被 sent 守卫抑制——Matrix 零发送（命令已在房间）
        assert bridge._sent == []
        assert bridge._by_request == {}

    asyncio.run(main())


def test_room_side_fallback_single_pending_in_room(bridge):
    """reply 链缺失 + 房间仅一条 pending → 兜底匹配并消解。"""

    async def main():
        rid = await bridge.inject(_item(event_id=""))
        assert rid
        bridge.note_room_resolved(False, event_id="", room_id="!r:hs")
        await _drain()
        assert _FAKE_SVC.resolved == [(rid, _FakeDecision.DENIED)]
        assert bridge._sent == []

    asyncio.run(main())


def test_room_side_ambiguous_noop(bridge):
    """同房间两条 pending 且无 reply 链 → 不猜：都不动（30 分钟超时兜底）。"""

    async def main():
        rid_a = await bridge.inject(
            _item(event_id="$a", sender="@wa:hs"))
        rid_b = await bridge.inject(
            _item(event_id="$b", sender="@wb:hs"))
        assert rid_a and rid_b and rid_a != rid_b
        bridge.note_room_resolved(True, event_id="", room_id="!r:hs")
        await _drain()
        assert _FAKE_SVC.resolved == []
        assert set(bridge._by_request) == {rid_a, rid_b}
        # 精确匹配仍可用（$b 是审批 event_id）
        bridge.note_room_resolved(True, event_id="$b", room_id="!r:hs")
        await _drain()
        assert _FAKE_SVC.resolved == [(rid_b, _FakeDecision.APPROVED)]
        assert set(bridge._by_request) == {rid_a}

    asyncio.run(main())
