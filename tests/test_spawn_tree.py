# -*- coding: utf-8 -*-
"""spawn_tree 桥接纯函数单测（表驱动）。

覆盖四个纯函数（无网络、无磁盘、无宿主依赖）：

1. ``normalize_room_session_id``——room id / ``matrix:`` 前缀 session id
 → 规范 room id（小写化 / 去空白 / 非法输入 → None）；
2. ``room_id_to_session_id``——逆桥（加 ``matrix:`` 前缀），幂等；
3. ``infer_worker_role``——成员名 → 角色徽章（lead/critic/manager 分支 +
  display_name 缺失回退 mxid + 优先级）；
4. ``build_worker_groups``——joined_members → worker 维度分组
 （角色排序 / 同角色按名小写排序 / is_self / spawns 空占位）。
"""
from __future__ import annotations

import pytest

from agentteams_connector.spawn_tree import (
    build_worker_groups,
    infer_worker_role,
    normalize_room_session_id,
    room_id_to_session_id,
)


# ── 1) normalize_room_session_id ──────────────────────────────────────

NORM_CASES = [
    pytest.param("!abc:homeserver", "!abc:homeserver", id="bare"),
    pytest.param("matrix:!abc:homeserver", "!abc:homeserver", id="prefixed"),
    pytest.param("matrix:!ABC:homeserver", "!abc:homeserver", id="room-case"),
    pytest.param("MATRIX:!abc:hs", "!abc:hs", id="prefix-case"),
    pytest.param("  !abc:hs  ", "!abc:hs", id="strip"),
    pytest.param("#alias:hs", "#alias:hs", id="alias-kept"),
    pytest.param("!abc", None, id="no-server"),
    pytest.param("!abc:", None, id="empty-server"),
    pytest.param("!abc:hs extra", None, id="trailing-token"),
    pytest.param("", None, id="empty"),
    pytest.param("   ", None, id="blank"),
    pytest.param("notaroom", None, id="no-bang"),
    pytest.param(None, None, id="none-input"),
    pytest.param(123, None, id="non-str"),
]


@pytest.mark.parametrize("raw,want", NORM_CASES)
def test_normalize_room_session_id(raw, want):
    assert normalize_room_session_id(raw) == want


# ── 2) room_id_to_session_id ─────────────────────────────────────────

SESSION_CASES = [
    pytest.param("!abc:hs", "matrix:!abc:hs", id="plain"),
    pytest.param("matrix:!abc:hs", "matrix:!abc:hs", id="idempotent"),
    pytest.param("!ABC:HS", "matrix:!abc:hs", id="lowercased"),
    pytest.param("  !abc:hs ", "matrix:!abc:hs", id="stripped"),
    pytest.param("bad", None, id="invalid"),
    pytest.param("", None, id="empty"),
]


@pytest.mark.parametrize("room_id,want", SESSION_CASES)
def test_room_id_to_session_id(room_id, want):
    assert room_id_to_session_id(room_id) == want


# ── 3) infer_worker_role ─────────────────────────────────────────────

ROLE_CASES = [
    pytest.param("Team Lead", "@x:hs", "leader", id="lead"),
    pytest.param("coordinator", "@x:hs", "leader", id="coordinator"),
    pytest.param("Manager", "@x:hs", "leader", id="manager-as-leader"),
    pytest.param("LEAD", "@x:hs", "leader", id="case-insensitive"),
    pytest.param("", "@coordinator:hs", "leader", id="mxid-fallback"),
    pytest.param("Critic", "@x:hs", "critic", id="critic"),
    pytest.param("Code Reviewer", "@x:hs", "critic", id="review"),
    pytest.param("Audit Bot", "@x:hs", "critic", id="audit"),
    pytest.param("lead-audit", "@x:hs", "leader", id="lead-beats-critic"),
    pytest.param("Worker-1", "@x:hs", "worker", id="worker"),
    pytest.param("alice", "@x:hs", "worker", id="plain-name"),
    pytest.param("", "@worker7:hs", "worker", id="mxid-worker"),
    pytest.param("", "", "worker", id="all-empty"),
    pytest.param("", None, "worker", id="mxid-none"),
]


@pytest.mark.parametrize("display_name,mxid,want", ROLE_CASES)
def test_infer_worker_role(display_name, mxid, want):
    assert infer_worker_role(display_name, mxid) == want


# ── 4) build_worker_groups ────────────────────────────────────────────

def test_groups_order_is_self_and_spawns():
    """角色序（leader < worker < critic）+ is_self + spawns 空占位。"""
    members = {
        "@carol:hs": {"display_name": "Carol Critic", "avatar_url": "u1"},
        "@alice:hs": {"display_name": "Alice", "avatar_url": "u2"},
        "@bob:hs": {"display_name": "Bob Lead", "avatar_url": "u3"},
    }
    groups = build_worker_groups(members, user_id="@alice:hs")
    assert [g["worker_name"] for g in groups] == [
        "Bob Lead", "Alice", "Carol Critic",
    ]
    assert [g["role"] for g in groups] == ["leader", "worker", "critic"]
    assert [g["is_self"] for g in groups] == [False, True, False]
    assert [g["mxid"] for g in groups] == [
        "@bob:hs", "@alice:hs", "@carol:hs",
    ]
    assert all(g["spawns"] == [] for g in groups)


def test_groups_missing_display_name_falls_back_to_mxid():
    """profile 非 dict / 无 display_name → 取 mxid localpart（去 @）。"""
    members = {
        "@dave:hs": None,
        "@eve:hs": {"avatar_url": "u"},
    }
    groups = build_worker_groups(members, user_id="@other:hs")
    assert [(g["worker_name"], g["role"], g["is_self"]) for g in groups] == [
        ("dave", "worker", False),
        ("eve", "worker", False),
    ]


def test_groups_same_role_sorted_by_name_lower():
    """同角色按 worker_name 小写排序。"""
    members = {
        "@zed:hs": {"display_name": "Zeta"},
        "@ann:hs": {"display_name": "Ann"},
    }
    groups = build_worker_groups(members, user_id="@u:hs")
    assert [g["worker_name"] for g in groups] == ["Ann", "Zeta"]


def test_groups_empty_members():
    assert build_worker_groups({}, user_id="@u:hs") == []
