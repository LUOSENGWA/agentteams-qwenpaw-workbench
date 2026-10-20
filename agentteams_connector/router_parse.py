# -*- coding: utf-8 -*-
"""路由域解析层：JSON 序列化 + /sync 解析 + docker 日志流 + ctl 薄包装。

自 router.py 逐字搬移（模块级函数，无缩进变化）。spawn_tree/ctl_client
保持函数内惰性 import（形态不变）；_SYNC_FILTER 为只读常量；不 import
router（无循环依赖）；router.py 以 re-export 壳保持原路径可达。
"""
from __future__ import annotations

import json as _json_mod
from typing import Any, Dict, List, Optional


def _json_dumps(obj: Any) -> str:
    return _json_mod.dumps(obj, ensure_ascii=False, separators=(",", ":"))

# Matrix paths the proxy will forward (everything else → 400).
MATRIX_ALLOWED_PREFIX = "/_matrix/client/"
# Controller paths the proxy will forward.
CONTROLLER_ALLOWED_PREFIXES = ("/api/", "/healthz")


# Sync filter: only room name + membership state, 1 timeline event, no
# presence/ephemeral — keeps the first sync payload small (dashboard 同款做法).
_SYNC_FILTER: Dict[str, Any] = {
    "presence": {"types": []},
    # m.muted_room（房间静音，Element 同款 account data——
    # 插件通知引擎 sync_watcher 与前端静音状态同一数据源）。
    "account_data": {"types": ["m.muted_room"]},
    "room": {
        "state": {"types": ["m.room.name", "m.room.member"]},
        "timeline": {"limit": 1},
        # m.typing 事件（打字指示，Element 同款交互——60s 快照新鲜度够用）。
        "ephemeral": {"types": ["m.typing"]},
    },
}


def _parse_sync_rooms(
    sync_resp: Dict[str, Any],
    user_id: str,
    dm_peers: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Parse /sync rooms.join into room list + worker TREE (one shot).

 Worker tree shape (design): team room → its Workers (领/工/审)
 → each Worker's spawn tree (spawns stay empty until the spawn endpoint merges).
 DM rooms (<=2 members) are excluded from the tree.

 dm_peers: m.direct 倒排 {room_id: 对方 mxid}——新 DM 对方未接受邀请时
 成员列表只有自己，房间名靠它取对方名（Element 同款命名源）。
 """
    from . import spawn_tree as spawn_tree_mod

    join = (sync_resp.get("rooms") or {}).get("join") or {}
    rooms: List[Dict[str, Any]] = []
    worker_tree: List[Dict[str, Any]] = []
    for room_id, room_data in join.items():
        state_events = (room_data.get("state") or {}).get("events") or []
        members: Dict[str, Dict[str, Any]] = {}
        name = ""
        for ev in state_events:
            ev_type = ev.get("type")
            content = ev.get("content") or {}
            if ev_type == "m.room.name":
                name = (content.get("name") or "").strip()
            elif ev_type == "m.room.member":
                mxid = ev.get("state_key") or ""
                membership = content.get("membership")
                if mxid and membership == "join":
                    members[mxid] = {
                        "display_name": content.get("displayname") or "",
                        "avatar_url": content.get("avatar_url") or "",
                    }
        member_count = len(members)
        # typing 指示：ephemeral m.typing 事件的 user_ids。
        typing_users: List[str] = []
        for eph in (room_data.get("ephemeral") or {}).get("events") or []:
            if eph.get("type") == "m.typing":
                for uid in (eph.get("content") or {}).get("user_ids") or []:
                    if isinstance(uid, str) and uid != user_id and uid not in typing_users:
                        typing_users.append(uid)
        # 最后一条消息（聊天 tab「最后消息时间 + 新到旧排序」数据源）。
        # /sync 无 since（每次全量快照）→ timeline(limit=1) 恒为该房间最新事件。
        last_ts = 0
        last_body = ""
        last_sender = ""
        tl_events = (room_data.get("timeline") or {}).get("events") or []
        if tl_events:
            last_ev = tl_events[-1]
            try:
                last_ts = int(last_ev.get("origin_server_ts") or 0)
            except (TypeError, ValueError):
                last_ts = 0
            lc = last_ev.get("content") or {}
            if (
                last_ev.get("type") == "m.room.message"
                and lc.get("msgtype") in ("m.text", "m.notice", "m.file", "m.image")
            ):
                last_body = str(lc.get("body") or "")[:120]
                # 最后一条消息的发送者——
                # session 灯 done 回退只认 Worker 自己的消息（per-sender，
                # 与 dashboard 9a9cc8d 同源），用户消息不再点绿整个房间。
                last_sender = str(last_ev.get("sender") or "")
        # 未读计数（sync 的 unread_notifications：highlight+notification）。
        unread = 0
        unread_high = 0
        unread_notifications = (room_data.get("unread_notifications") or {}) if isinstance(room_data, dict) else {}
        if isinstance(unread_notifications, dict):
            try:
                unread_high = int(unread_notifications.get("highlight_count") or 0)
                unread = int(unread_notifications.get("notification_count") or 0)
            except (TypeError, ValueError):
                unread_high = 0
                unread = 0
        entry: Dict[str, Any] = {
            "room_id": room_id,
            "name": name,
            "members": members,
            "member_count": member_count,
            "name_fallback": False,
            "unread": unread,
            "unread_highlight": unread_high,
            "typing": typing_users,
            "last_ts": last_ts,
            "last_body": last_body,
            "last_sender": last_sender,
        }
        if not entry["name"]:
            # 无名房间命名优先级（）：
            # ① m.direct 对方（新 DM 对方未 accept 邀请时 members 只有自己，
            # 此前直接落「（空房间）」——用户真机反馈"空房间，说过话才有名字"）
            # ② 其他已加入成员 ③（空房间）兜底
            peer = (dm_peers or {}).get(room_id, "")
            if peer and peer != user_id and member_count <= 2:
                peer_member = members.get(peer) or {}
                entry["name"] = (
                    peer_member.get("display_name")
                    or peer.lstrip("@").split(":")[0]
                    or peer
                )
            else:
                others = [
                    (m.get("display_name") or uid)
                    for uid, m in members.items()
                    if uid != user_id
                ]
                entry["name"] = "、".join(others[:3]) or "（空房间）"
            entry["name_fallback"] = True
        if member_count > 2:
            # Team room → tree node with its Workers.
            worker_tree.append(
                {
                    "team_name": entry["name"],
                    "room_id": room_id,
                    "workers": spawn_tree_mod.build_worker_groups(
                        members, user_id
                    ),
                }
            )
        rooms.append(entry)

    rooms.sort(key=lambda r: (r["name_fallback"], r["name"]))
    # Tree: named teams first, then fallback-named rooms.
    worker_tree.sort(
        key=lambda t: (
            t["team_name"] in ("（空房间）",) or not t["team_name"],
            t["team_name"].lower(),
        )
    )

    # 解析 /sync rooms.invite 段（此前只读 join——邀请房间
    # 在插件里完全不可见，用户真机「没有 Element 的接受入群按钮和接口」根因）。
    # invite_state.events 带 m.room.name + 邀请人的 m.room.member（membership=invite）；
    # 接受=POST /rooms/{roomId}/invite/{userId}/accept，拒绝=POST /rooms/{roomId}/leave
    # （CS-API v3 标准端点，前端走通用代理，零新后端路由）。
    invites: List[Dict[str, Any]] = []
    for room_id, room_data in (
        ((sync_resp.get("rooms") or {}).get("invite") or {})
    ).items():
        name = ""
        inviter = ""
        inviter_ts = 0
        for ev in ((room_data.get("invite_state") or {}).get("events") or []):
            ev_type = ev.get("type")
            content = ev.get("content") or {}
            if ev_type == "m.room.name":
                name = (content.get("name") or "").strip()
            elif (
                ev_type == "m.room.member"
                and content.get("membership") == "invite"
            ):
                inviter = ev.get("sender") or ""
                inviter_ts = int(ev.get("origin_server_ts") or 0)
        name = name or room_id
        invites.append(
            {
                "room_id": room_id,
                "name": name,
                "name_fallback": not name or name == room_id,
                "inviter": inviter,
                "inviter_ts": inviter_ts,
            }
        )
    invites.sort(key=lambda r: -r["inviter_ts"])

    # 静音房间集合（account_data m.muted_room 聚合，
    # Element 同款状态源；前端 RoomChat 静音按钮 + 通知引擎共读）。
    muted_rooms: List[str] = []
    for ev in ((sync_resp.get("account_data") or {}).get("events") or []):
        if ev.get("type") != "m.muted_room":
            continue
        content = ev.get("content") or {}
        room_id = content.get("room_id") or ""
        if room_id and content.get("muted") and room_id not in muted_rooms:
            muted_rooms.append(room_id)
    return {
        "rooms": rooms,
        "worker_tree": worker_tree,
        "invites": invites,
        "muted_rooms": muted_rooms,
    }


def _parse_docker_stream(data: bytes, component: str) -> List[Dict[str, Any]]:
    """解析 docker logs 二进制流（8 字节头：type+padding+size BE + payload）。

 dashboard `parseDockerLogs` 同款逻辑；时间戳 RFC3339 前缀行。
 """
    import re as _re

    lines: List[Dict[str, Any]] = []
    offset = 0
    n = len(data)
    ts_re = _re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s(.*)$")
    while offset + 8 <= n:
        stream = data[offset]
        size = int.from_bytes(data[offset + 4 : offset + 8], "big")
        if size <= 0 or offset + 8 + size > n:
            break
        payload = data[offset + 8 : offset + 8 + size].decode("utf-8", "replace")
        for raw in payload.split("\n"):
            if not raw.strip():
                continue
            m = ts_re.match(raw)
            if m:
                lines.append(
                    {
                        "timestamp": m.group(1),
                        "level": "error" if stream == 2 else "info",
                        "component": component,
                        "message": m.group(2).rstrip(),
                    }
                )
            else:
                lines.append(
                    {
                        "timestamp": "",
                        "level": "error" if stream == 2 else "info",
                        "component": component,
                        "message": raw.rstrip(),
                    }
                )
        offset += 8 + size
    return lines
