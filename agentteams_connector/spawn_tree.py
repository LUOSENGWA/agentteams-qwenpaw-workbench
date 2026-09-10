# -*- coding: utf-8 -*-
"""Spawn tree aggregation + room_id ↔ session_id bridge.

Worker-dimension tree (设计定案 §6.5): Leader and Workers are all Workers;
each Worker owns its spawn tree. Main data source = Controller O20 endpoint
(`GET /api/v1/projects/{id}/spawns`, W-PR #1169) once merged; until then the
Worker list comes from Matrix joined_members (real) and the spawn lists are
empty placeholders (no PR dependency for Phase 2).

The bridge pure functions below are unit-tested (variant list in §6.5).
"""

from __future__ import annotations

import re
from typing import Optional


# 【预埋，勿删】以下三个定义为 room id ↔ Worker session id 桥接——
# §6.5「团队桥接」（"看 spawn 树"跳转定位）待做时消费；v0.2.0 骨架期即为此预埋。
_SESSION_ID_RE = re.compile(
    r"^(matrix:)?(?P<room>[!#][^:]+:[^ ]+)$", re.IGNORECASE
)


def normalize_room_session_id(raw: str) -> Optional[str]:
    """Normalize a Matrix room id / Worker session id to a canonical room id.

    Accepts: bare room id (``!abc:server``), ``matrix:`` prefixed session id
    (``matrix:!abc:server``), case variants. Returns the lowercased room id
    or None for invalid input.
    """
    if not isinstance(raw, str):
        return None
    raw = raw.strip()
    if not raw:
        return None
    match = _SESSION_ID_RE.match(raw)
    if not match:
        return None
    return match.group("room").lower()


def room_id_to_session_id(room_id: str) -> Optional[str]:
    """Inverse bridge: room id → Worker session id (``matrix:`` prefix)."""
    normalized = normalize_room_session_id(room_id)
    if normalized is None:
        return None
    return f"matrix:{normalized}"


def infer_worker_role(display_name: str, mxid: str) -> str:
    """Best-effort role badge from a team member name (第一版无 Controller teams API).

    Returns one of ``leader`` / ``worker`` / ``critic`` / ``unknown``.
    """
    name = (display_name or mxid or "").lower()
    if re.search(r"lead|leader|coordinator", name):
        return "leader"
    if re.search(r"critic|review|audit", name):
        return "critic"
    if re.search(r"manager", name):
        return "leader"  # Manager runs NMH + project group creation
    return "worker"


def build_worker_groups(members: dict, user_id: str) -> list:
    """Worker-dimension groups from Matrix joined_members.

    ``members``: {mxid: {display_name, avatar_url}} from joined_members.
    Returns [{"worker_name", "mxid", "role", "is_self", "spawns": []}].
    Spawns stay empty until O20 merges (adapter swaps the data source).
    """
    groups = []
    for mxid, profile in members.items():
        display_name = (
            profile.get("display_name") if isinstance(profile, dict) else None
        ) or mxid.split(":")[0].lstrip("@")
        groups.append(
            {
                "worker_name": display_name,
                "mxid": mxid,
                "role": infer_worker_role(display_name, mxid),
                "is_self": mxid == user_id,
                "spawns": [],
            }
        )
    groups.sort(
        key=lambda g: (
            {"leader": 0, "worker": 1, "critic": 2, "unknown": 3}[g["role"]],
            g["worker_name"].lower(),
        )
    )
    return groups
