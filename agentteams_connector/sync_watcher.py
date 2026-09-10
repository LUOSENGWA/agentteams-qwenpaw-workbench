# -*- coding: utf-8 -*-
"""Matrix /sync 长轮询事件监听（IM 式触发，替代前端 30s 轮询）。

用户 8/15：「30s 轮询是不是太笨了，不能像 IM 那样通过什么触发」——
Matrix /sync 本身就是 IM 事件流（Element 同款长轮询）。本模块在插件后端
起一个常驻 /sync 循环：长连接挂 30s 等事件，事件到达立即解析（延迟≈0）。

检测两类事件：
① @提到我 → 写宿主收件箱（os_notify → 白名单 source_type → 桌面 toast +
铃铛，与 useOsNotifyPoller 同一事件源）+ SSE 广播前端即时刷新。
② agentteams.workflow 任务状态变化（进行中→完成 等）→ 通知 + SSE，
前端刷新工作流三视图。多 homeserver 自动 failover（working 优先）。
SSE 不可用时前端回退轮询。
"""

from __future__ import annotations

import asyncio
import json as _json
import logging
import urllib.parse as _urlparse
from collections import deque
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger("qwenpaw.plugins.agentteams_qwenpaw_workbench.sync_watcher")

# 精简 sync filter：只收 timeline 最新事件 + m.muted_room account data
# （v0.4.98 再版 9 房间静音——Element 同款状态源，此处是通知引擎侧的消费点）。
_SYNC_FILTER = {
    "presence": {"not_types": ["*"]},
    "account_data": {"types": ["m.muted_room"]},
    "room": {"timeline": {"limit": 10}},
}

# ── SSE hub ────────────────────────────────────────────────────────────
_subscribers: List[asyncio.Queue] = []
_task: Optional[asyncio.Task] = None
_stop_event = asyncio.Event()
# 事件去重：sync 重连可能重放，按 event_id 去重。
_recent_ids: deque = deque(maxlen=2000)
_since: Optional[str] = None
_first_sync_done = False
_consecutive_failures = 0  # v0.4.97: 连续 /sync 失败计数（token 失效/切账号自愈用）


def reset_state() -> None:
    """v0.4.97: 账号切换 → 丢弃旧账号的 sync 游标。

    since（next_batch）只对产生它的账号有效——切账号后拿旧 since 请求
    新账号的 /sync 会一直 401，循环空转（@提到我/任务状态通知全断）。
    账号切换（/login、config.matrix 身份变更）必须调用。
    """
    global _since, _first_sync_done, _consecutive_failures
    _since = None
    _first_sync_done = False
    _consecutive_failures = 0
    _recent_ids.clear()
    _muted_rooms.clear()  # v0.4.98 再版 9：静音集合是账号级状态，切账号重建
    _mention_buffer.clear()  # 0.4.99 B5：@我缓冲是账号级状态
    _mention_eids.clear()
    _approval_buffer.clear()  # v0.5.0-beta.10：审批缓冲是账号级状态
    _approval_eids.clear()
    _invited_rooms.clear()  # v0.5.0-beta.10：邀请基线是账号级状态


async def restart(reason: str = "") -> None:
    """v0.4.97: 账号切换 → 重启 sync 循环并重置游标（router /login、put_config 调用）。"""
    await stop()
    reset_state()
    start()
    logger.info("sync watcher restarted (%s)", reason or "no reason")

# ── 任务状态记忆（① 状态变化检测）────────────────────────────────────
# 项目级：runId -> status；任务级："{runId}:{stepId}" -> status。
# 只在「旧状态存在且不同」时通知——首次见到只记录不通知（防噪音）。
_PROJECT_STATES: Dict[str, str] = {}
_TASK_STATES: Dict[str, str] = {}
# v0.4.98 再版 9：已静音房间集合（account_data m.muted_room，Element 同款
# 跨客户端状态源）。首轮 /sync=全量，增量=diff（muted:false=取消静音）。
# 静音效果：该房间的 @提到我/任务状态变化不再写收件箱+不广播（消息本体
# 仍可见——静音≠退群，Element 语义一致）。
_muted_rooms: set = set()

# 0.4.99 B5：@我 实时缓冲——/sync 长轮询事件流即时写入（Element 同款：事件
# 驱动，非轮询扫描）；/room-mentions 端点直接读，零额外房间扫描。
# Element 机制 = Matrix /sync 长连接（事件到达即返回）；QwenPaw 宿主 =
# 2s 轮询本地收件箱（无外部连接只能轮询）；本插件两者都有 = 事件主路 + 轮询兜底。
from collections import OrderedDict

_mention_buffer: "deque[Dict[str, Any]]" = deque(maxlen=50)
_mention_eids: "OrderedDict[str, None]" = OrderedDict()


def get_mention_buffer(limit: int = 30) -> List[Dict[str, Any]]:
    """最近 @我 事件（新→旧），来自 /sync 事件流。"""
    items = list(_mention_buffer)
    items.reverse()
    return items[: max(1, min(int(limit), 50))]

# v0.5.0-beta.10：工具审批请求（Tool Guard HITL）实时缓冲。
# Worker 受控工具调用会在房间发「🛡️ Approval Required」/旧版「⏳ Waiting
# for approval」——不带 @人类（旧逻辑只检测 @我 → 用户无提示，只能去
# Element 翻房间找，9/4 用户真机反馈）。/sync 事件流检测 → 宿主收件箱
# （桌面 toast）+ SSE + 本缓冲；解决检测 = 该房间后续出现 /approval
# 命令消息 → 移除最早一条未决项。
_approval_buffer: "deque[Dict[str, Any]]" = deque(maxlen=50)
_approval_eids: "OrderedDict[str, None]" = OrderedDict()

# v0.5.0-beta.10：已通知的邀请房间集合（新邀请只通知一次；sync 重连/
# 重放时 rooms.invite 段会重复出现，按 room_id 去重）。首轮 /sync=基线
# （只建集合不通知，防插件启动把存量邀请轰炸成 toast）。
_invited_rooms: set = set()


def get_approval_buffer(limit: int = 30) -> List[Dict[str, Any]]:
    """最近未决工具审批请求（新→旧），来自 /sync 事件流。"""
    items = list(_approval_buffer)
    items.reverse()
    return items[: max(1, min(int(limit), 50))]


def parse_approval_request(body: str):
    """识别 Worker 审批请求消息（前端 RoomChat parseApproval 同款判据）。

    返回 (kind, approve_cmd, deny_cmd)；非审批请求 → None。
    """
    if "🛡️" in body and "Approval Required" in body:
        return ("approval", "/approval approve", "/approval deny")
    if "⏳" in body and "Waiting for approval" in body:
        return ("legacy", "/approve", "拒绝")
    return None


def _approval_command_body(body: str) -> str:
    """剥掉审批命令的 @Worker 前缀，返回纯命令部分。

    插件审批卡发的命令是 ``@worker1 /approval approve``（无 @ 不进
    Worker 消费队列，必须带前缀）；历史/手工命令可能是裸 ``/approval
    approve``。两种形态都要识别——否则房间侧决议传导（宿主桥消解 +
    缓冲清理）对插件卡路径完全失效（v0.5.0-beta.11.1 修复）。
    """
    b = (body or "").strip()
    if b.startswith("@") and " " in b:
        b = b.split(" ", 1)[1].strip()
    return b


def _is_approval_command(body: str) -> bool:
    """人类发出的审批命令消息（批准/拒绝）——审批解决信号。"""
    return _approval_command_body(body).startswith(
        ("/approval approve", "/approval deny", "/approve"),
    )


def _approval_command_kind(body: str) -> str:
    """'approve' | 'deny'——审批命令方向（房间侧决议传导宿主桥用）。
    仅在 _is_approval_command 为 True 时调用。"""
    b = _approval_command_body(body)
    if b.startswith("/approval deny"):
        return "deny"
    return "approve"  # /approval approve / /approve


_MAX_STATES = 500

# 状态 → 中文标签（通知文案用）。
_STATUS_LABEL = {
    "pending": "待办",
    "planned": "待办",
    "assigned": "已派发",
    "delegated": "已派发",
    "in_progress": "进行中",
    "in-progress": "进行中",
    "submitted": "已提交",
    "completed": "已完成",
    "done": "已完成",
    "success": "已完成",
    "failed": "失败",
    "error": "失败",
    "blocked": "阻塞",
    "cancelled": "已取消",
    "revision": "需修订",
}


def _status_label(status: str) -> str:
    return _STATUS_LABEL.get(status, status or "未知")


def _status_severity(status: str) -> str:
    if status in ("completed", "done", "success"):
        return "success"
    if status in ("failed", "error", "blocked", "cancelled"):
        return "warning"
    return "info"


def _remember(d: Dict[str, str], key: str, value: str) -> None:
    """记录状态并控制容量：超限时清掉最早的一半（近似 LRU，够用）。"""
    if len(d) >= _MAX_STATES:
        keys = list(d.keys())
        for k in keys[: _MAX_STATES // 2]:
            d.pop(k, None)
    d[key] = value


def subscribe() -> "asyncio.Queue":
    q: asyncio.Queue = asyncio.Queue(maxsize=64)
    _subscribers.append(q)
    return q


def unsubscribe(q: "asyncio.Queue") -> None:
    if q in _subscribers:
        _subscribers.remove(q)


async def _broadcast(event: Dict[str, Any]) -> None:
    for q in list(_subscribers):
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:  # noqa: PERF203 - 慢消费者丢事件不阻塞
            pass


def start() -> None:
    """启动后台 /sync 循环（幂等）。由 plugin.register_startup_hook 调用。"""
    global _task
    if _task and not _task.done():
        return
    _stop_event.clear()
    _task = asyncio.create_task(_run())
    logger.info("sync watcher started")


async def stop() -> None:
    """停止后台循环。由 plugin.register_shutdown_hook 调用。"""
    _stop_event.set()
    if _task and not _task.done():
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:  # pragma: no cover
            pass
    logger.info("sync watcher stopped")


def _mention_body(sender: str, body: str) -> str:
    local = sender.split(":", 1)[0].lstrip("@")
    return f"{local}：{(body or '').strip().replace(chr(10), ' ')[:100]}"


async def _append_inbox(
    title: str,
    body: str,
    severity: str,
    source_id: str = "agentteams-qwenpaw-workbench",
) -> None:
    """写宿主收件箱（os_notify → 白名单 source_type → 桌面 toast + 铃铛）。"""
    try:
        from qwenpaw.app.inbox_store import append_event

        await append_event(
            agent_id=None,
            source_type="cron",  # OS 通知白名单 PUSH_MESSAGE_SOURCES
            source_id=source_id,
            event_type="plugin",
            status="info",
            title=title,
            body=body,
            severity=severity,
        )
    except Exception as exc:  # noqa: BLE001 - 非 QwenPaw 宿主/IO 失败不阻塞
        logger.debug("inbox append failed: %s", exc)


def _is_muted(room_id: str) -> bool:
    """v0.4.98 再版 9：房间静音门（@通知/任务状态通知共用）。"""
    return room_id in _muted_rooms


async def _notify_mention(
    sender: str,
    body: str,
    room_id: str,
    event_id: str = "",
    ts: int = 0,
) -> None:
    """@提到我：实时缓冲（B5）+ 收件箱 + SSE 广播。"""
    if _is_muted(room_id):
        return  # 静音房间不通知（消息本体仍可见）
    # 0.4.99 B5：实时缓冲（event_id 去重；sync 重放安全）。
    if event_id and event_id not in _mention_eids:
        _mention_buffer.append(
            {
                "room_id": room_id,
                "event_id": event_id,
                "sender": sender,
                "body": (body or "")[:200],
                "ts": int(ts or 0),
            }
        )
        _mention_eids[event_id] = None
        while len(_mention_eids) > 200:
            _mention_eids.popitem(last=False)
    payload = {
        "type": "mention",
        "room_id": room_id,
        "sender": sender,
        "body": _mention_body(sender, body),
    }
    await _append_inbox("@ 提到你", payload["body"], "warning")
    await _broadcast(payload)


async def _notify_approval(
    kind: str,
    approve_cmd: str,
    deny_cmd: str,
    sender: str,
    body: str,
    room_id: str,
    event_id: str = "",
    ts: int = 0,
) -> None:
    """v0.5.0-beta.10：工具审批请求 → 缓冲 + 收件箱（桌面 toast）+ SSE。"""
    if _is_muted(room_id):
        return  # 静音房间不通知（与 @我 同语义）
    if event_id and event_id not in _approval_eids:
        _approval_buffer.append(
            {
                "room_id": room_id,
                "event_id": event_id,
                "sender": sender,
                "body": (body or "")[:200],
                "ts": int(ts or 0),
                "kind": kind,
                "approve_cmd": approve_cmd,
                "deny_cmd": deny_cmd,
            }
        )
        _approval_eids[event_id] = None
        while len(_approval_eids) > 200:
            _approval_eids.popitem(last=False)
    local = sender.split(":", 1)[0].lstrip("@")
    payload = {
        "type": "approval_request",
        "room_id": room_id,
        "sender": sender,
        "body": f"{local}：{(body or '').strip().replace(chr(10), ' ')[:100]}",
        "kind": kind,
        "approve_cmd": approve_cmd,
        "deny_cmd": deny_cmd,
        "ts": int(ts or 0),
    }
    await _append_inbox(
        "🛡️ 工具审批请求", payload["body"], "warning",
        source_id="agentteams-qwenpaw-workbench-approval",
    )
    await _broadcast(payload)
    # v0.5.0-beta.11 re7：桥接宿主收件箱审批（导航抖动+红点+审批条目+
    # 一键批准/拒绝）。特性探测降级：宿主无 create_pending_summary → 静默
    # 跳过（插件内审批卡不受影响）。决议回传走 host_bridge 的 future 回调。
    try:
        from . import host_bridge

        asyncio.create_task(
            host_bridge.bridge.inject(
                {
                    "room_id": room_id,
                    "event_id": event_id,
                    "sender": sender,
                    "body": body,
                    "approve_cmd": approve_cmd,
                    "deny_cmd": deny_cmd,
                    "ts": int(ts or 0),
                },
            ),
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("host approval bridge inject skipped: %s", exc)


async def _resolve_approval(
    room_id: str,
    reply_to: str = "",
    thread_root: str = "",
    approved: bool = True,
) -> None:
    """v0.5.0-beta.10：审批已解决（该房间出现 /approval 命令）→
    移除未决项 + SSE 通知前端刷新。
    v0.5.0-beta.11.1：优先按 reply 链精确匹配删除（命令 thread reply →
    审批 event_id），并把房间侧决议通知宿主桥——宿主收件箱记录立即
    消解，防 30 分钟超时兜底补发陈旧反向命令。"""
    removed = None
    targets = {e for e in (reply_to, thread_root) if e}
    if targets:
        for i, item in enumerate(_approval_buffer):
            if (item.get("room_id") == room_id
                    and str(item.get("event_id") or "") in targets):
                removed = _approval_buffer.pop(i)
                break
    if removed is None:
        for i, item in enumerate(_approval_buffer):
            if item.get("room_id") == room_id:
                removed = _approval_buffer.pop(i)
                break
    if removed is not None:
        _approval_eids.pop(str(removed.get("event_id") or ""), None)
    await _broadcast({"type": "approval_resolved", "room_id": room_id})
    # 房间侧决议传导宿主桥（<2.1 宿主 bridge=None → 静默 no-op）。
    try:
        from . import host_bridge
        hb = host_bridge.bridge
        if hb is not None and removed is not None:
            hb.note_room_resolved(
                approved,
                event_id=str(removed.get("event_id") or ""),
                room_id=room_id,
            )
    except Exception:  # noqa: BLE001
        pass


async def _notify_invite(
    room_id: str,
    name: str,
    inviter: str,
    ts: int = 0,
) -> None:
    """v0.5.0-beta.10：新房间邀请 → 收件箱（桌面 toast）+ SSE。
    接受/拒绝 UI 在团队概览（chat tab）邀请区，单一事实源。"""
    if _is_muted(room_id):
        return
    local = inviter.split(":", 1)[0].lstrip("@") if inviter else ""
    body = f"{local or '未知用户'} 邀请你加入房间：{name}"
    await _append_inbox(
        "📩 新邀请", body, "warning",
        source_id="agentteams-qwenpaw-workbench-invite",
    )
    await _broadcast(
        {
            "type": "invite",
            "room_id": room_id,
            "name": name,
            "inviter": inviter,
            "ts": int(ts or 0),
        }
    )


async def _notify_task_status(
    kind: str,
    title: str,
    old_status: str,
    new_status: str,
    room_id: str,
    project: str,
) -> None:
    """任务状态变化：收件箱（severity 按终态区分）+ SSE 广播。"""
    if _is_muted(room_id):
        return  # 静音房间不通知（消息本体仍可见）
    subject = "任务完成" if new_status in ("completed", "done", "success") else "任务状态变化"
    body = (
        f"{title}：{_status_label(old_status)} → {_status_label(new_status)}"
        f"（{project}）"
    )
    payload = {
        "type": "task_status",
        "kind": kind,
        "room_id": room_id,
        "title": title,
        "old_status": old_status,
        "new_status": new_status,
        "project": project,
        "body": body,
    }
    await _append_inbox(subject, body, _status_severity(new_status))
    await _broadcast(payload)


def _track_workflow(wf: Dict[str, Any], room_id: str) -> None:
    """跟踪 agentteams.workflow 状态：项目级 + steps 任务级。
    同步调用（轻量内存操作），通知经 asyncio 队列由 _run 驱动。"""
    run_id = str(wf.get("runId") or wf.get("run_id") or "")
    project = str(wf.get("title") or wf.get("name") or run_id or "未命名任务")
    project_status = str(wf.get("status") or "")

    # 项目级状态变化。
    if run_id and project_status:
        prev = _PROJECT_STATES.get(run_id)
        if prev and prev != project_status:
            # 项目状态变化也走任务通知（kind=project）。
            asyncio.create_task(
                _notify_task_status(
                    "project", project, prev, project_status, room_id, project
                )
            )
        _remember(_PROJECT_STATES, run_id, project_status)

    # steps 任务级。
    steps = wf.get("steps") or []
    if not isinstance(steps, list):
        return
    for step in steps:
        if not isinstance(step, dict):
            continue
        step_id = str(step.get("id") or step.get("name") or "")
        step_title = str(step.get("name") or step.get("title") or step_id or "任务")
        step_status = str(step.get("status") or "")
        if not step_id or not step_status:
            continue
        key = f"{run_id}:{step_id}"
        prev = _TASK_STATES.get(key)
        if prev and prev != step_status:
            asyncio.create_task(
                _notify_task_status(
                    "task", step_title, prev, step_status, room_id, project
                )
            )
        _remember(_TASK_STATES, key, step_status)


async def _run() -> None:
    """常驻 /sync 循环：长连接（timeout=30s）等事件，到达即处理。
    多 homeserver failover：working 地址优先，逐个尝试，失败换下一个。"""
    global _since, _first_sync_done, _consecutive_failures
    from . import config as config_mod
    from .router import _mark_working, _ordered_addresses  # noqa: PLC0415

    while not _stop_event.is_set():
        cfg = config_mod.load_config()
        matrix_cfg = cfg.get("matrix") or {}
        token = (matrix_cfg.get("access_token") or "").strip()
        me = (matrix_cfg.get("user_id") or "").strip()
        homeservers = _ordered_addresses(cfg, "matrix")
        if not token or not me or not homeservers:
            # 未配置/未登录：等配置页填写。
            await asyncio.sleep(20)
            continue

        params = {
            "timeout": "30000" if _since else "0",
            "filter": _json.dumps(_SYNC_FILTER, separators=(",", ":")),
        }
        if _since:
            params["since"] = _since

        synced = False
        for hs in homeservers:
            url = (
                f"{hs.rstrip('/')}/_matrix/client/v3/sync?"
                f"{_urlparse.urlencode(params)}"
            )
            try:
                async with httpx.AsyncClient(
                    timeout=40.0, verify=False
                ) as client:
                    resp = await client.get(
                        url, headers={"Authorization": f"Bearer {token}"}
                    )
                if resp.status_code >= 400:
                    # 该地址拒绝（token 失效/服务异常）→ 换下一个。
                    logger.warning(
                        "sync -> %s: %s", hs, resp.text[:120]
                    )
                    continue
                payload = resp.json()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - 网络抖动换下一地址
                logger.debug("sync via %s failed: %s", hs, exc)
                continue
            _mark_working("matrix", hs)
            synced = True
            break

        if not synced:
            # v0.4.97: 自愈——连续失败（token 失效/账号切换/服务重启）达到阈值
            # → 重置游标重建基线，不等人工重启（/login 已显式 restart，这里
            # 兜底 Matrix 侧 token 过期等边缘场景）。
            _consecutive_failures += 1
            if _consecutive_failures >= 4 and _since:
                logger.warning(
                    "sync failures x%d — resetting cursor (token invalid? account switch?)",
                    _consecutive_failures,
                )
                reset_state()
            await asyncio.sleep(15)
            continue
        _consecutive_failures = 0

        _since = str(payload.get("next_batch") or _since or "")
        # v0.4.98 再版 9：m.muted_room 增量合并（首轮=全量、增量=diff；
        # muted:false=取消静音）。在首轮基线判断之前——静音状态不依赖事件。
        for ev in ((payload.get("account_data") or {}).get("events") or []):
            if not isinstance(ev, dict) or ev.get("type") != "m.muted_room":
                continue
            _c = ev.get("content") or {}
            _rid = str(_c.get("room_id") or "")
            if not _rid:
                continue
            if _c.get("muted"):
                _muted_rooms.add(_rid)
            else:
                _muted_rooms.discard(_rid)
        rooms_invite = (
            ((payload.get("rooms") or {}).get("invite") or {})
        )
        baseline = not _first_sync_done
        if baseline:
            # 首轮（since 为空）邀请只建基线集合不通知——防止插件启动把
            # 存量邀请轰炸成 toast。
            # v0.5.0-beta.10 再版 2：首轮 timeline 仍走审批请求/命令检测——
            # 插件停机/重装重启窗口内到达的审批消息还挂着未处理（用户 9/5
            # 「通知没有」：旧逻辑整轮 continue=离线审批永远漏检，RoomChat
            # 12s 轮询能看到卡片但 toast/缓冲/首页卡全空）。@我仍抑制
            # （旧 @ 记录轰炸问题不变），workflow 跟踪跳过（旧事件只产噪音）。
            _invited_rooms.update(str(rid) for rid in rooms_invite)
            _first_sync_done = True

        # ④ 新房间邀请（rooms.invite 段；每房只通知一次，重连/重放不重复）。
        for inv_room_id, inv_data in rooms_invite.items():
            rid = str(inv_room_id)
            if rid in _invited_rooms:
                continue
            _invited_rooms.add(rid)
            inv_name, inviter, inviter_ts = "", "", 0
            for ev in (
                (((inv_data or {}).get("invite_state") or {}).get("events") or [])
            ):
                if not isinstance(ev, dict):
                    continue
                _et = ev.get("type")
                _ct = ev.get("content") or {}
                if _et == "m.room.name":
                    inv_name = (_ct.get("name") or "").strip()
                elif (
                    _et == "m.room.member"
                    and (_ct.get("membership") == "invite")
                ):
                    inviter = ev.get("sender") or ""
                    inviter_ts = int(ev.get("origin_server_ts") or 0)
            asyncio.create_task(
                _notify_invite(rid, inv_name or rid, inviter, inviter_ts)
            )

        rooms = (payload.get("rooms") or {}).get("join") or {}
        for room_id, room_data in rooms.items():
            events = ((room_data.get("timeline") or {}).get("events")) or []
            for ev in events:
                if not isinstance(ev, dict):
                    continue
                if ev.get("type") != "m.room.message":
                    continue
                eid = str(ev.get("event_id") or "")
                if eid and eid in _recent_ids:
                    continue
                if eid:
                    _recent_ids.append(eid)
                sender = str(ev.get("sender") or "")
                content = ev.get("content") or {}
                if not isinstance(content, dict):
                    continue
                # ① 任务状态变化：agentteams.workflow payload（基线轮跳过）。
                if not baseline:
                    wf = content.get("agentteams.workflow")
                    new_content = content.get("m.new_content")
                    if isinstance(new_content, dict) and new_content.get(
                        "agentteams.workflow"
                    ):
                        wf = new_content.get("agentteams.workflow")
                    if isinstance(wf, dict):
                        _track_workflow(wf, str(room_id))
                # ③ 工具审批请求（Tool Guard HITL）/④ 审批命令（解决信号）。
                # 编辑消息（m.replace 带 m.new_content）不算新请求/新命令。
                body0 = str(content.get("body") or "")
                if not content.get("m.new_content"):
                    if sender and sender != me:
                        _ap = parse_approval_request(body0)
                        if _ap:
                            await _notify_approval(
                                _ap[0], _ap[1], _ap[2], sender, body0,
                                str(room_id), event_id=eid,
                                ts=int(ev.get("origin_server_ts") or 0),
                            )
                            continue
                    if _is_approval_command(body0):
                        # 命令是审批消息的 thread reply：reply-to/线程根
                        # = 审批 event_id → 精确匹配 + 方向传导宿主桥。
                        _relates = content.get("m.relates_to") or {}
                        await _resolve_approval(
                            str(room_id),
                            reply_to=str(
                                ((_relates.get("m.in_reply_to") or {})
                                 .get("event_id")) or ""
                            ),
                            thread_root=str(_relates.get("event_id") or ""),
                            approved=_approval_command_kind(body0) == "approve",
                        )
                        continue
                # ② @提到我（沿用主判据 m.mentions.user_ids + 正文兜底；
                # 基线轮抑制——旧 @ 记录不通知，与存量邀请同语义）。
                if baseline or not sender or sender == me:
                    continue
                mentions = content.get("m.mentions") or {}
                user_ids = list(mentions.get("user_ids") or [])
                body = str(content.get("body") or "")
                localpart = me.split(":", 1)[0].lstrip("@")
                if me in user_ids or f"@{localpart}" in body:
                    await _notify_mention(
                        sender, body, str(room_id),
                        event_id=eid, ts=int(ev.get("origin_server_ts") or 0),
                    )
        # 立即进入下一轮长连接（事件到达即返回，无需额外 sleep）。
