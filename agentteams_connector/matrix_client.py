# -*- coding: utf-8 -*-
"""Matrix Client-Server API wrapper (Tuwunel standard CS API v3).

Minimal surface for the first skeleton release: versions, password login,
whoami, joined_rooms, joined_members, send message. All calls take an
explicit homeserver so profiles can switch without touching client state.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

import httpx

from .dial_gate import sync_dial_slot

logger = logging.getLogger("qwenpaw.plugins.agentteams_qwenpaw_workbench")

TIMEOUT = 20.0


class MatrixError(Exception):
    """Raised for a non-2xx Matrix response."""


def _request(
    method: str,
    homeserver: str,
    path: str,
    token: Optional[str] = None,
    json_body: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    base = homeserver.rstrip("/")
    url = f"{base}{path}"
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    # 该地址覆盖凭据（WAN 门）——无覆盖=原生认证零变化。
    # 低频用户态调用（whoami/房间列表/发送），每调用一次 load_config 可接受。
    try:
        from . import config as _config

        _auth = _config.auth_for_url(
            _config.load_config().get("matrix_homeservers"), homeserver
        )
        headers = _config.headers_with_auth(_auth, headers)
    except Exception:  # noqa: BLE001 - 配置不可用回退原生认证
        pass
    with sync_dial_slot(), httpx.Client(timeout=TIMEOUT, verify=False) as client:
        resp = client.request(method, url, json=json_body, headers=headers)
    if resp.status_code >= 400:
        raise MatrixError(
            f"Matrix {method} {path} -> {resp.status_code}: "
            f"{resp.text[:200]}"
        )
    return resp.json()


def versions(homeserver: str) -> Dict[str, Any]:
    """GET /_matrix/client/versions — protocol check, not just reachability."""
    return _request("GET", homeserver, "/_matrix/client/versions")


def login(homeserver: str, user: str, password: str) -> Dict[str, Any]:
    """m.login.password → {user_id, access_token, device_id, ...}."""
    data = _request(
        "POST",
        homeserver,
        "/_matrix/client/v3/login",
        json_body={
            "type": "m.login.password",
            "identifier": {"type": "m.id.user", "user": user},
            "password": password,
            "initial_device_display_name": "AgentTeams QwenPaw Workbench",
        },
    )
    return data


def whoami(homeserver: str, token: str) -> Dict[str, Any]:
    return _request("GET", homeserver, "/_matrix/client/v3/account/whoami", token)


def joined_rooms(homeserver: str, token: str) -> Dict[str, Any]:
    return _request("GET", homeserver, "/_matrix/client/v3/joined_rooms", token)


def joined_members(homeserver: str, token: str, room_id: str) -> Dict[str, Any]:
    return _request(
        "GET",
        homeserver,
        f"/_matrix/client/v3/rooms/{room_id}/joined_members",
        token,
    )


def room_info(homeserver: str, token: str, room_id: str) -> Dict[str, Any]:
    """房间详情信息（Element 同款房间详情面板数据源）。

 聚合 7 个房间 state 事件（name/topic/canonical_alias/create/
 join_rules/encryption/power_levels）+ joined_members，返回
 ``{room_id, name, topic, canonical_alias, creator, join_rule,
 encrypted, member_count, members[]}``（members 含 power_level +
 角色）。

 state 事件 404 = 无该事件（按空处理，best-effort）；joined_members
 404/403 = 房间不存在/未加入，硬错抛 MatrixError（路由层 502 附
 Matrix 摘要）。401（token 失效）原样上抛（路由层 401）。

 角色映射（Element 同款）：power_level >= 100 → owner，>= 50 →
 moderator，否则 member。power level 取 m.room.power_levels.users
 [user_id]，缺省 users_default；权限表缺失（404）或 content 为
 null（Controller 建队房间权限表 null 实锤）→ 全员 0。成员按
 power level 降序、名字升序排列（owner 在前）。
 """
    import urllib.parse

    encoded_room = urllib.parse.quote(room_id, safe="")
    base = f"/_matrix/client/v3/rooms/{encoded_room}"

    def _state(event_type: str) -> Optional[Dict[str, Any]]:
        """读单个 state 事件；404 = 无该事件（返回 None），其余错误上抛。"""
        try:
            data = _request(
                "GET", homeserver, f"{base}/state/{event_type}", token
            )
        except MatrixError as exc:
            if "-> 404:" in str(exc):
                return None
            raise
        return data if isinstance(data, dict) else None

    name_ev = _state("m.room.name")
    topic_ev = _state("m.room.topic")
    alias_ev = _state("m.room.canonical_alias")
    create_ev = _state("m.room.create")
    join_ev = _state("m.room.join_rules")
    encryption_ev = _state("m.room.encryption")
    power_ev = _state("m.room.power_levels")

    members_raw = _request(
        "GET", homeserver, f"{base}/joined_members", token
    )
    joined = (members_raw or {}).get("joined") or {}
    if not isinstance(joined, dict):
        joined = {}

    # 权限表：content 为 null（平台房间 null 权限表实锤）或缺失 → 默认 0。
    power_content = power_ev.get("content") if power_ev else None
    if not isinstance(power_content, dict):
        power_content = {}
    users = power_content.get("users")
    if not isinstance(users, dict):
        users = {}
    try:
        users_default = int(power_content.get("users_default") or 0)
    except (TypeError, ValueError):
        users_default = 0

    members: List[Dict[str, Any]] = []
    for user_id, profile in joined.items():
        profile = profile if isinstance(profile, dict) else {}
        try:
            level = int(users.get(user_id, users_default))
        except (TypeError, ValueError):
            level = users_default
        if level >= 100:
            role = "owner"
        elif level >= 50:
            role = "moderator"
        else:
            role = "member"
        members.append(
            {
                "user_id": str(user_id),
                "display_name": str(profile.get("display_name") or ""),
                "avatar_url": str(profile.get("avatar_url") or ""),
                "power_level": level,
                "role": role,
            }
        )
    members.sort(key=lambda m: (-m["power_level"], m["display_name"], m["user_id"]))

    return {
        "room_id": room_id,
        "name": str((name_ev or {}).get("name") or "").strip(),
        "topic": str((topic_ev or {}).get("topic") or "").strip(),
        "canonical_alias": str((alias_ev or {}).get("alias") or "").strip(),
        "creator": str((create_ev or {}).get("creator") or ""),
        "join_rule": str((join_ev or {}).get("join_rule") or "public"),
        # m.room.encryption 事件存在且 content 非 null 才是加密
        # （content=null = 关闭加密事件）。
        "encrypted": bool(encryption_ev and encryption_ev.get("content")),
        "member_count": len(members),
        "members": members,
    }


def send_message(
    homeserver: str,
    token: str,
    room_id: str,
    body: str,
    msgtype: str = "m.text",
    content: Dict[str, Any] = None,
) -> Dict[str, Any]:
    """Send an m.room.message event. Returns {event_id}.

 ``content`` 传完整结构化事件 content（带
 m.mentions/formatted_body 的 @mention 消息用）；None → 纯文本。
 """
    import time
    import uuid

    txn = f"wb-{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"
    return _request(
        "PUT",
        homeserver,
        f"/_matrix/client/v3/rooms/{room_id}/send/m.room.message/{txn}",
        token,
        json_body=content
        if content is not None
        else {"msgtype": msgtype, "body": body},
    )


def create_dm(
    homeserver: str,
    token: str,
    mxid: str,
    name: str = "",
    topic: str = "",
) -> Dict[str, Any]:
    """Create (or reuse) a trusted-private DM room with *mxid*.

 Reuses an existing direct room from m.direct account data when present;
 otherwise POST /createRoom with preset=trusted_private_chat + invite.
 Returns {room_id, created}.

 ``name``/``topic``：房间创建时的显示名与话题——缺省 ``私聊 · <localpart>``
 / ``Direct chat with <mxid>``。根因修复：此前 createRoom 只发
 preset/invite/is_direct，建出**无名空房间**（用户要等对方回复才知道
 是谁的私聊）；现在创建即命名。
 复用已有 DM 时：房间名为空则 PUT ``m.room.name`` 补名（best-effort，
 失败仅记日志不影响返回）——顺带修复之前建出来的无名房间（下次打开
 即命名）；已有名字（含用户重命名）不覆盖。
 """
    localpart = mxid.lstrip("@").split(":", 1)[0] or mxid
    room_name = (name or "").strip() or f"私聊 · {localpart}"
    room_topic = (topic or "").strip() or f"Direct chat with {mxid}"

    existing = _existing_direct_room(homeserver, token, mxid)
    if existing:
        _ensure_room_name(homeserver, token, existing, room_name)
        return {"room_id": existing, "created": False}
    created = _request(
        "POST",
        homeserver,
        "/_matrix/client/v3/createRoom",
        token,
        json_body={
            "preset": "trusted_private_chat",
            "invite": [mxid],
            "is_direct": True,
            "name": room_name,
            "topic": room_topic,
        },
    )
    return {"room_id": created.get("room_id", ""), "created": True}


def _ensure_room_name(
    homeserver: str, token: str, room_id: str, name: str
) -> None:
    """无名已有 DM 房间补 ``m.room.name``（best-effort，失败仅记日志）。

 GET /state/m.room.name：404 = 无名事件（无名房间）→ PUT 补名；
 200 且名字非空 → 跳过（不覆盖已有名字）。任何一步失败只 warning，
 不影响 create_dm 的返回（补名是增值动作，不是 DM 打开的前提）。
 """
    import urllib.parse

    encoded_room = urllib.parse.quote(room_id, safe="")
    state_path = (
        f"/_matrix/client/v3/rooms/{encoded_room}/state/m.room.name"
    )
    try:
        data = _request("GET", homeserver, state_path, token)
    except MatrixError as exc:
        if "-> 404:" in str(exc):
            pass  # 无名房间 → 补名
        else:
            logger.warning(
                "create_dm: read room name failed %s: %s", room_id, exc
            )
            return
    else:
        if str((data or {}).get("name") or "").strip():
            return
    try:
        _request(
            "PUT",
            homeserver,
            state_path,
            token,
            json_body={"name": name},
        )
    except Exception as exc:  # noqa: BLE001 - best-effort 补名
        logger.warning(
            "create_dm: room name backfill failed %s: %s", room_id, exc
        )


def _existing_direct_room(
    homeserver: str, token: str, mxid: str
) -> Optional[str]:
    """Look up m.direct account data for an existing DM with *mxid*."""
    import urllib.parse

    url = (
        f"{homeserver.rstrip('/')}/_matrix/client/v3/user/"
        f"{urllib.parse.quote(mxid)}/account_data/m.direct"
    )
    headers = {"Authorization": f"Bearer {token}"}
    try:
        with sync_dial_slot(), httpx.Client(timeout=TIMEOUT, verify=False) as client:
            resp = client.get(url, headers=headers)
        if resp.status_code != 200:
            return None
        direct_map = resp.json() or {}
        rooms = direct_map.get(mxid) or []
        return rooms[0] if rooms else None
    except Exception:  # noqa: BLE001 - best-effort lookup
        return None


def direct_rooms(
    homeserver: str, token: str, user_id: str
) -> Dict[str, str]:
    """m.direct 账号数据 → {room_id: 对方 mxid}（倒排）。

 DM 房间名权威来源（Element 同款）：新 DM 对方未 accept invite 时
 members 只有自己，无名字可取——m.direct 记录的是"这个房间是跟谁
 私聊"，不依赖对方是否已加入。best-effort：失败返回 {}。
 """
    import urllib.parse

    url = (
        f"{homeserver.rstrip('/')}/_matrix/client/v3/user/"
        f"{urllib.parse.quote(user_id)}/account_data/m.direct"
    )
    headers = {"Authorization": f"Bearer {token}"}
    out: Dict[str, str] = {}
    try:
        with sync_dial_slot(), httpx.Client(timeout=TIMEOUT, verify=False) as client:
            resp = client.get(url, headers=headers)
        if resp.status_code != 200:
            return out
        direct_map = resp.json() or {}
        for peer, rooms in direct_map.items():
            if isinstance(rooms, list) and rooms:
                out[str(rooms[0])] = str(peer)
    except Exception:  # noqa: BLE001 - best-effort lookup
        pass
    return out


def search(
    homeserver: str,
    token: str,
    term: str,
    room_id: Optional[str] = None,
    next_batch: Optional[str] = None,
    limit: int = 20,
) -> Dict[str, Any]:
    """POST /_matrix/client/v3/search — 全文检索历史消息（room_events）。

 Tuwunel（conduwuit 系）要求 search_categories.room_events.filter 字段
 必填（缺 → M_BAD_JSON "missing field 'filter'"）——传 {} 即搜全部可见
 房间；房间内搜索传 {"rooms": [room_id]}。group_by room_id 让跨房间
 结果按房间聚合，include_profile 附带发送者资料。分页走 next_batch。
 """
    search_body: Dict[str, Any] = {
        "search_term": term,
        "filter": {"rooms": [room_id]} if room_id else {},
        "order_by": "recent",
        "groupings": {"group_by": [{"key": "room_id"}]},
        "include_profile": True,
        "limit": limit,
    }
    if next_batch:
        search_body["next_batch"] = next_batch
    return _request(
        "POST",
        homeserver,
        "/_matrix/client/v3/search",
        token,
        json_body={"search_categories": {"room_events": search_body}},
    )


def latest_event_id(homeserver: str, token: str, room_id: str) -> str:
    """房间最新消息 event_id（GET /messages?dir=b&limit=1）。

 已读回执的落点：m.read 指向具体事件，m.fully_read 指向读线位置。
 空房间 / 无可见历史时返回 ""。
 """
    import urllib.parse

    encoded_room = urllib.parse.quote(room_id, safe="")
    try:
        data = _request(
            "GET",
            homeserver,
            f"/_matrix/client/v3/rooms/{encoded_room}/messages"
            f"?dir=b&limit=1",
            token,
        )
    except MatrixError:
        return ""
    chunk = data.get("chunk") or []
    if not chunk:
        return ""
    first = chunk[0] if isinstance(chunk[0], dict) else {}
    return str(first.get("event_id") or "")


def send_read_receipt(
    homeserver: str, token: str, room_id: str, event_id: str
) -> None:
    """m.read 回执（event 级，Element 侧显示「已读给你」）。

 POST /receipt/m.read/{eventId}，无 body。协议与 dashboard
 src/app/api/matrix/rooms/[roomId]/receipt/route.ts 对齐（交叉验证）。
 """
    import urllib.parse

    encoded_room = urllib.parse.quote(room_id, safe="")
    encoded_event = urllib.parse.quote(event_id, safe="")
    _request(
        "POST",
        homeserver,
        f"/_matrix/client/v3/rooms/{encoded_room}/receipt/m.read/{encoded_event}",
        token,
    )


def set_fully_read(
    homeserver: str,
    token: str,
    user_id: str,
    room_id: str,
    event_id: str,
) -> None:
    """m.fully_read 读线（房间级，清 Element 侧未读 badge 的关键）。

 PUT /user/{userId}/rooms/{roomId}/account_data/m.fully_read，
 body {"event_id": ...}。协议与 dashboard read-marker route 对齐
 （交叉验证）。
 """
    import urllib.parse

    encoded_user = urllib.parse.quote(user_id, safe="")
    encoded_room = urllib.parse.quote(room_id, safe="")
    _request(
        "PUT",
        homeserver,
        f"/_matrix/client/v3/user/{encoded_user}/rooms/{encoded_room}"
        f"/account_data/m.fully_read",
        token,
        json_body={"event_id": event_id},
    )


def sync(
    homeserver: str,
    token: str,
    since: Optional[str] = None,
    timeout_ms: int = 30000,
    sync_filter: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Long-poll /sync. Returns the raw sync response (may contain
 rooms.join.<room_id>.timeline.events)."""
    params = {"timeout": str(timeout_ms)}
    if since:
        params["since"] = since
    if sync_filter:
        import json as _json

        params["filter"] = _json.dumps(sync_filter, separators=(",", ":"))
    import urllib.parse

    qs = urllib.parse.urlencode(params)
    url = f"{homeserver.rstrip('/')}/_matrix/client/v3/sync?{qs}"
    headers = {"Authorization": f"Bearer {token}"}
    with sync_dial_slot(), httpx.Client(timeout=timeout_ms / 1000.0 + 10.0, verify=False) as client:
        resp = client.get(url, headers=headers)
    if resp.status_code >= 400:
        raise MatrixError(
            f"Matrix GET /sync -> {resp.status_code}: {resp.text[:200]}"
        )
    return resp.json()
