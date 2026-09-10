# -*- coding: utf-8 -*-
"""Matrix Client-Server API wrapper (Tuwunel standard CS API v3).

Minimal surface for the first skeleton release: versions, password login,
whoami, joined_rooms, joined_members, send message. All calls take an
explicit homeserver so profiles can switch without touching client state.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

import httpx

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
    with httpx.Client(timeout=TIMEOUT, verify=False) as client:
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


def send_message(
    homeserver: str,
    token: str,
    room_id: str,
    body: str,
    msgtype: str = "m.text",
    content: Dict[str, Any] = None,
) -> Dict[str, Any]:
    """Send an m.room.message event. Returns {event_id}.

    v0.5.0-beta.11 re7: ``content`` 传完整结构化事件 content（带
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


def create_dm(homeserver: str, token: str, mxid: str) -> Dict[str, Any]:
    """Create (or reuse) a trusted-private DM room with *mxid*.

    Reuses an existing direct room from m.direct account data when present;
    otherwise POST /createRoom with preset=trusted_private_chat + invite.
    Returns {room_id, created}.
    """
    existing = _existing_direct_room(homeserver, token, mxid)
    if existing:
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
        },
    )
    return {"room_id": created.get("room_id", ""), "created": True}


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
        with httpx.Client(timeout=TIMEOUT, verify=False) as client:
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
        with httpx.Client(timeout=TIMEOUT, verify=False) as client:
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
    src/app/api/matrix/rooms/[roomId]/receipt/route.ts 对齐（8/18 交叉验证）。
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
    （8/18 交叉验证）。
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
    with httpx.Client(timeout=timeout_ms / 1000.0 + 10.0, verify=False) as client:
        resp = client.get(url, headers=headers)
    if resp.status_code >= 400:
        raise MatrixError(
            f"Matrix GET /sync -> {resp.status_code}: {resp.text[:200]}"
        )
    return resp.json()
