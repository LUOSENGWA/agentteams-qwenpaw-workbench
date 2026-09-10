# -*- coding: utf-8 -*-
"""宿主收件箱审批桥（v0.5.0-beta.11 再版 7）。

把 AgentTeams Worker 的 Tool Guard 审批请求（🛡️ Approval Required）桥接进
宿主 QwenPaw 收件箱审批体系，让用户不必进 Element/房间翻找：

1. **注入**：sync_watcher 检出 Worker 审批请求 → 宿主
   ``ApprovalService.create_pending_summary(source_type="agentteams")``
   建收件箱审批记录。宿主 2.1+ 内建行为自动生效：收件箱导航抖动
   （inboxShake）、红点、审批条目、标题闪烁——零前端依赖。
2. **决议**：用户批准/拒绝（宿主自定义审批卡 POST /approval/approve|deny，
   或默认卡聊天命令、HTTP API、超时 GC 自动拒绝）殊途同归——宿主把决议
   写进 ``pending.future``。注入时挂 ``add_done_callback`` **单回调**
   捕获（零轮询、零 monkey-patch）→ 发对应 Matrix 命令回房间。
   命令带三重 @Worker（m.mentions + matrix.to + 正文 @localpart）——
   无 @ 不进 Worker 消费队列（_require_mention）。

会话绑定：记录挂在合成 root session ``agentteams`` 下。抖动/红点/审批
条目均不过滤 session（宿主 /console/push-messages 无参=全量）；收件箱
审批 tab 按当前 session 过滤时可能不显示本记录（降级：页面内审批卡
与抖动红点仍完整可用）。

特性探测降级：宿主无 ``create_pending_summary``（<2.1 或未来重构）→
整桥静默禁用，插件内审批卡不受影响。
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections import OrderedDict
from typing import Any, Dict, List, Optional

from . import config as config_mod

logger = logging.getLogger(
    "qwenpaw.plugins.agentteams_qwenpaw_workbench.host_bridge",
)

SOURCE_TYPE = "agentteams"
SYNTHETIC_SESSION = "agentteams"
MAX_INFLIGHT = 20          # 同时未决的宿主审批记录上限（防积压）
SEEN_CAP = 200             # 去重窗口（sync 重连/重放同事件多次）
INJECT_TIMEOUT_SECONDS = 1800  # 宿主侧自动拒绝时限（Worker 工具可能长跑）


class HostApprovalBridge:
    """Worker 工具审批 → 宿主收件箱审批记录的桥。

    单进程 asyncio 单线程模型——所有方法在同一事件循环，无需锁。
    """

    def __init__(self) -> None:
        self._by_request: Dict[str, Dict[str, Any]] = {}
        self._by_event: Dict[str, str] = {}  # 审批消息 event_id → rid
        self._seen: "OrderedDict[str, None]" = OrderedDict()
        self._available: Optional[bool] = None
        self._stats: Dict[str, int] = {
            "injected": 0, "resolved": 0, "failed": 0, "skipped": 0,
        }

    # ── 特性探测（宿主能力缺失 → 整桥禁用）──────────────────
    def available(self) -> bool:
        if self._available is None:
            try:
                from qwenpaw.app.approvals import get_approval_service

                svc = get_approval_service()
                self._available = hasattr(svc, "create_pending_summary")
                if not self._available:
                    logger.info(
                        "host approval bridge disabled: "
                        "create_pending_summary not present (host <2.1?)",
                    )
            except Exception as exc:  # noqa: BLE001
                self._available = False
                logger.info("host approval bridge disabled: %s", exc)
        return self._available

    def init(self) -> None:
        """plugin register 时调用：早探测一次（结果缓存，失败不重试——
        宿主能力在进程生命周期内不变）。"""
        self.available()

    # ── 注入：房间审批条目 → 宿主收件箱审批记录 ──────────────
    async def inject(self, item: Dict[str, Any]) -> Optional[str]:
        """item: {room_id, event_id, sender, body, approve_cmd, deny_cmd, ts}。
        返回宿主 request_id（注入失败/跳过 → None，静默降级）。"""
        room_id = str(item.get("room_id") or "")
        if not self.available() or not room_id:
            return None
        event_id = str(item.get("event_id") or "")
        key = event_id or f"{room_id}:{item.get('ts', 0)}"
        if key in self._seen or len(self._by_request) >= MAX_INFLIGHT:
            self._stats["skipped"] += 1
            return None
        try:
            from qwenpaw.app.approvals import (  # noqa: PLC0415
                ApprovalRequestSummary,
                get_approval_service,
            )
        except Exception:  # noqa: BLE001
            self._available = False
            return None

        sender = str(item.get("sender") or "")
        local = sender.split(":", 1)[0].lstrip("@") or "worker"
        body = str(item.get("body") or "").strip()
        approve_cmd = str(item.get("approve_cmd") or "/approval approve")
        deny_cmd = str(item.get("deny_cmd") or "/approval deny")
        try:
            svc = get_approval_service()
            pending = await svc.create_pending_summary(
                session_id=SYNTHETIC_SESSION,
                root_session_id=SYNTHETIC_SESSION,
                owner_agent_id="",
                user_id="",
                # console → 抑制宿主自己的 channel 通知（我们自有 UX 链路）
                channel="console",
                agent_id="agentteams",
                summary=ApprovalRequestSummary(
                    source_type=SOURCE_TYPE,
                    name=local,
                    severity="medium",
                    findings_count=1,
                    result_summary=(
                        f"AgentTeams Worker「{local}」有工具调用等待审批。"
                        f"批准后该调用在团队房间继续执行。"
                    ),
                ),
                timeout_seconds=INJECT_TIMEOUT_SECONDS,
                extra={
                    "agentteams": {
                        "room_id": room_id,
                        "event_id": event_id,
                        "worker": local,
                        "sender": sender,
                        "approve_cmd": approve_cmd,
                        "deny_cmd": deny_cmd,
                    },
                    # tool_call.input → 前端卡 toolParams；reasoning →
                    # 前端卡「调用理由」字段（push-messages 序列化读取）
                    "tool_call": {
                        "id": event_id or f"{room_id}:{int(time.time())}",
                        "name": local,
                        "input": {
                            "worker": local,
                            "room": room_id,
                            "request": body[:300],
                            "approve_cmd": approve_cmd,
                            "deny_cmd": deny_cmd,
                        },
                    },
                    "reasoning": body[:300],
                },
            )
        except Exception as exc:  # noqa: BLE001
            self._stats["failed"] += 1
            logger.warning("host approval inject failed: %s", exc)
            return None

        rid = str(pending.request_id)
        self._by_request[rid] = {
            "room_id": room_id,
            "event_id": event_id,
            "worker": local,
            "sender_mxid": sender,
            "approve_cmd": approve_cmd,
            "deny_cmd": deny_cmd,
            "ts": time.time(),
            # 房间侧已解决（插件卡/房间命令先行）→ 决议回调不再补发 Matrix
            "sent": False,
        }
        if event_id:
            self._by_event[event_id] = rid
        self._seen[key] = None
        while len(self._seen) > SEEN_CAP:
            self._seen.popitem(last=False)
        self._stats["injected"] += 1

        # 决议回调：任何决议路径（自定义卡 POST /approval/*、默认卡聊天
        # 命令、HTTP API、超时 GC）最终都写 pending.future → 单回调全覆盖，
        # 零轮询零 monkey-patch。
        try:
            fut = getattr(pending, "future", None)
            if fut is not None and hasattr(fut, "add_done_callback"):
                fut.add_done_callback(
                    lambda f, r=rid: self._on_decision(r, f),
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "approval future callback attach failed (rid=%s): %s",
                rid[:8], exc,
            )
        logger.info(
            "host approval injected: rid=%s worker=%s room=%s",
            rid[:8], local, room_id,
        )
        return rid

    # ── 房间侧决议（插件卡/房间命令先行）─────────────────────
    def note_room_resolved(
        self, approved: bool, event_id: str = "", room_id: str = "",
    ) -> None:
        """watcher 在房间检出 /approval 命令时调用。

        防陈旧的 deny 补发：用户从插件卡（或房间直接）批准/拒绝后，
        宿主记录若不立即消解，会挂到 30 分钟超时 → 桥补发一条陈旧的
        反向命令。这里精确匹配（命令是审批消息的 thread reply，
        reply-to/线程根 = 审批 event_id）标记 sent + resolve 宿主记录；
        决议回调随后看到 sent=True 跳过 Matrix 发送。

        匹配不到（reply 链缺失 + 房间有多条 pending）→ 不动，保持旧
        行为（30 分钟超时兜底），宁可不消也不错消。
        """
        rid = self._by_event.pop(event_id, None) if event_id else None
        if (not rid or rid not in self._by_request) and room_id:
            cands = [
                r for r, i in self._by_request.items()
                if i.get("room_id") == room_id
            ]
            if len(cands) == 1:
                rid = cands[0]
            else:
                return  # 歧义/无匹配 → 不猜
        if not rid or rid not in self._by_request:
            return
        info = self._by_request.get(rid)
        if info:
            info["sent"] = True
        try:
            from qwenpaw.app.approvals import get_approval_service
            from qwenpaw.security.tool_guard.approval import ApprovalDecision

            svc = get_approval_service()
            dec = (
                ApprovalDecision.APPROVED
                if approved else ApprovalDecision.DENIED
            )
            coro = svc.resolve_request(rid, dec)
            try:
                asyncio.get_running_loop().create_task(
                    coro,
                    name=f"agentteams-approval-room-resolve-{rid[:8]}",
                )
            except RuntimeError:
                coro.close()  # 无运行循环（单测上下文）——丢弃
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "note_room_resolved: resolve failed rid=%s: %s",
                rid[:8], exc,
            )

    # ── 决议捕获 → Matrix 命令回房间 ─────────────────────────
    def _on_decision(self, rid: str, fut: Any) -> None:
        """future 完成回调（宿主决议后同步触发）。"""
        info = self._by_request.pop(rid, None)
        if info is None:
            return  # 非本桥记录 / 已处理
        if info.get("sent"):
            # 房间侧已解决（插件卡/房间命令先行，watcher 已标记）——
            # 决议是桥自己 resolve 的，Matrix 命令已在房间，不补发。
            logger.info(
                "host approval decision suppressed (in-room already sent): "
                "rid=%s worker=%s",
                rid[:8], info.get("worker"),
            )
            return
        decision = "UNKNOWN"
        try:
            if fut.cancelled():
                decision = "CANCELLED"
            else:
                d = fut.result()
                decision = str(getattr(d, "value", None) or d)
        except Exception:  # noqa: BLE001
            pass
        approve = decision.upper() == "APPROVED"
        self._stats["resolved"] += 1
        logger.info(
            "host approval resolved: rid=%s decision=%s worker=%s",
            rid[:8], decision, info.get("worker"),
        )
        cmd = info["approve_cmd"] if approve else info["deny_cmd"]
        try:
            asyncio.get_running_loop().create_task(
                self._send_room_command(info, cmd),
                name=f"agentteams-approval-reply-{rid[:8]}",
            )
        except RuntimeError:
            logger.warning(
                "no running loop for approval Matrix send (rid=%s)", rid[:8],
            )

    async def _send_room_command(
        self, info: Dict[str, Any], cmd: str,
    ) -> None:
        """带三重 @Worker 发审批命令（无 @ 不进 Worker 消费队列）。"""
        from . import matrix_client  # noqa: PLC0415
        from .router import _ordered_addresses  # noqa: PLC0415

        try:
            cfg = config_mod.load_config()
        except Exception as exc:  # noqa: BLE001
            logger.warning("approval send: config load failed: %s", exc)
            return
        token = str((cfg.get("matrix") or {}).get("access_token") or "").strip()
        homeservers: List[str] = []
        try:
            homeservers = _ordered_addresses(cfg, "matrix")
        except Exception:  # noqa: BLE001
            homeservers = [
                str(h) for h in (cfg.get("matrix_homeservers") or [])
            ]
        if not token or not homeservers:
            logger.warning(
                "approval send skipped: matrix token/homeserver not configured",
            )
            return
        target = str(info.get("sender_mxid") or "")
        local = str(info.get("worker") or "worker")
        body_txt = f"@{local} {cmd}"
        content: Dict[str, Any] = {
            "msgtype": "m.text",
            "body": body_txt,
        }
        if target:
            content.update({
                "format": "org.matrix.custom.html",
                "formatted_body": (
                    f'<a href="https://matrix.to/#/{target}">'
                    f"@{local}</a> {cmd}"
                ),
                "m.mentions": {"user_ids": [target]},
            })
        last_exc: Optional[Exception] = None
        for hs in homeservers:
            try:
                await asyncio.to_thread(
                    matrix_client.send_message,
                    hs, token, str(info["room_id"]), body_txt,
                    content=content,
                )
                logger.info(
                    "approval command sent: %s → room=%s worker=%s",
                    cmd, info["room_id"], local,
                )
                return
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
        logger.warning(
            "approval command send failed on all homeservers: %s", last_exc,
        )

    # ── 状态（router /host-bridge/status + selfcheck 用）──────
    def status(self) -> Dict[str, Any]:
        return {
            "available": self.available(),
            "inflight": len(self._by_request),
            "stats": dict(self._stats),
        }


bridge = HostApprovalBridge()


def init() -> None:
    """plugin.py register 时调用（幂等）。"""
    bridge.init()
