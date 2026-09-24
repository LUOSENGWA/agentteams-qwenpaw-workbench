# -*- coding: utf-8 -*-
"""房间列表增量 diff 回归测试（v0.5.0-beta.13.21 房间列表 Element 化）。

背景（用户反馈「房间列表刷新慢有点笨，看看 Element」）：Element 的 room
list 从不全量重拉——/sync 增量事件就地合并。插件此前每次房间列表更新=
全量 /teams/sync（一次带全房间 state 的 Matrix 全量 /sync）。
现 watcher 每轮 /sync 调 ``build_room_list_diff`` 收集元数据增量
（room_list_update SSE），前端就地合并。

护栏：

- 基线轮（baseline=True）：只建基线，不产 diff（存量房间不轰炸）。
- 基线后新房间：diff 项 new=True + summary（name/member_count/last_ts）。
- 已有房间：名字变更 / 成员 join 增减 / 未读 / typing 各自产变更字段，
  无变更不产项。
- leave 段：房间从基线移除并进 left。
"""
from __future__ import annotations

import agentteams_connector.sync_watcher as sw

R1 = "!room1:example.org"
R2 = "!room2:example.org"
W1 = "@worker-1:example.org"
HUMAN = "@human:example.org"


def _member(mxid: str, membership: str = "join") -> dict:
    return {
        "type": "m.room.member",
        "state_key": mxid,
        "content": {"membership": membership},
    }


def _name(name: str) -> dict:
    return {"type": "m.room.name", "content": {"name": name}}


def _msg(sender: str, body: str, ts: int) -> dict:
    return {
        "type": "m.room.message",
        "sender": sender,
        "origin_server_ts": ts,
        "content": {"body": body},
    }


def test_baseline_builds_no_diff():
    sw._room_meta.clear()
    payload = {
        "rooms": {
            "join": {
                R1: {
                    "state": {
                        "events": [
                            _name("alpha"),
                            _member(W1),
                            _member(HUMAN),
                        ]
                    },
                    "timeline": {"events": [_msg(W1, "hi", 100)]},
                }
            }
        }
    }
    diff, left = sw.build_room_list_diff(payload, baseline=True)
    assert diff == []
    assert left == []
    assert sw._room_meta[R1] == {"name": "alpha", "member_count": 2}


def test_new_room_after_baseline_gets_summary():
    sw._room_meta.clear()
    # 先基线
    sw.build_room_list_diff(
        {
            "rooms": {
                "join": {
                    R1: {
                        "state": {"events": [_name("alpha"), _member(W1)]},
                        "timeline": {"events": []},
                    }
                }
            }
        },
        baseline=True,
    )
    # 再增量：新房间 R2（/sync 新房间带全 state）
    payload = {
        "rooms": {
            "join": {
                R2: {
                    "state": {"events": [_name("beta"), _member(W1), _member(HUMAN)]},
                    "timeline": {"events": [_msg(W1, "first", 500)]},
                }
            }
        }
    }
    diff, left = sw.build_room_list_diff(payload, baseline=False)
    assert left == []
    assert len(diff) == 1
    it = diff[0]
    assert it["room_id"] == R2
    assert it["new"] is True
    assert it["name"] == "beta"
    assert it["member_count"] == 2
    assert it["last_ts"] == 500
    assert it["last_sender"] == W1
    assert it["last_body"] == "first"


def test_name_change_diff():
    sw._room_meta.clear()
    sw.build_room_list_diff(
        {
            "rooms": {
                "join": {
                    R1: {
                        "state": {"events": [_name("alpha"), _member(W1)]},
                        "timeline": {"events": []},
                    }
                }
            }
        },
        baseline=True,
    )
    diff, _ = sw.build_room_list_diff(
        {
            "rooms": {
                "join": {
                    R1: {
                        "state": {"events": [_name("alpha renamed")]},
                        "timeline": {"events": []},
                    }
                }
            }
        },
        baseline=False,
    )
    assert len(diff) == 1
    assert diff[0]["name"] == "alpha renamed"
    assert diff[0].get("new") is None
    # 基线已更新——同名再来一次不产 diff
    diff2, _ = sw.build_room_list_diff(
        {
            "rooms": {
                "join": {
                    R1: {
                        "state": {"events": [_name("alpha renamed")]},
                        "timeline": {"events": []},
                    }
                }
            }
        },
        baseline=False,
    )
    assert diff2 == []


def test_member_join_leave_counts():
    sw._room_meta.clear()
    sw.build_room_list_diff(
        {
            "rooms": {
                "join": {
                    R1: {
                        "state": {"events": [_member(W1), _member(HUMAN)]},
                        "timeline": {"events": []},
                    }
                }
            }
        },
        baseline=True,
    )
    assert sw._room_meta[R1]["member_count"] == 2
    # join → 3
    diff, _ = sw.build_room_list_diff(
        {
            "rooms": {
                "join": {
                    R1: {
                        "state": {"events": [_member("@w2:example.org", "join")]},
                        "timeline": {"events": []},
                    }
                }
            }
        },
        baseline=False,
    )
    assert diff[0]["member_count"] == 3
    # leave → 2（不击穿 0）
    diff, _ = sw.build_room_list_diff(
        {
            "rooms": {
                "join": {
                    R1: {
                        "state": {"events": [_member("@w2:example.org", "leave")]},
                        "timeline": {"events": []},
                    }
                }
            }
        },
        baseline=False,
    )
    assert diff[0]["member_count"] == 2


def test_unread_and_typing_diff():
    sw._room_meta.clear()
    sw.build_room_list_diff(
        {
            "rooms": {
                "join": {
                    R1: {
                        "state": {"events": [_member(W1)]},
                        "timeline": {"events": []},
                    }
                }
            }
        },
        baseline=True,
    )
    diff, _ = sw.build_room_list_diff(
        {
            "rooms": {
                "join": {
                    R1: {
                        "state": {"events": []},
                        "timeline": {"events": [_msg(HUMAN, "ping", 900)]},
                        "ephemeral": {
                            "events": [
                                {
                                    "type": "m.typing",
                                    "content": {"user_ids": [HUMAN]},
                                }
                            ]
                        },
                        "unread_notifications": {
                            "notification_count": 3,
                            "highlight_count": 1,
                        },
                    }
                }
            }
        },
        baseline=False,
    )
    assert len(diff) == 1
    it = diff[0]
    assert it["unread"] == 3
    assert it["unread_highlight"] == 1
    assert it["typing"] == [HUMAN]
    assert it["last_ts"] == 900
    assert it["last_body"] == "ping"


def test_leave_removes_room():
    sw._room_meta.clear()
    sw.build_room_list_diff(
        {
            "rooms": {
                "join": {
                    R1: {
                        "state": {"events": [_member(W1)]},
                        "timeline": {"events": []},
                    }
                }
            }
        },
        baseline=True,
    )
    diff, left = sw.build_room_list_diff(
        {"rooms": {"leave": {R1: {}}, "join": {}}},
        baseline=False,
    )
    assert diff == []
    assert left == [R1]
    assert R1 not in sw._room_meta
    # 重复 leave 不重复报
    _, left2 = sw.build_room_list_diff(
        {"rooms": {"leave": {R1: {}}, "join": {}}},
        baseline=False,
    )
    assert left2 == []


def test_edit_message_does_not_update_preview():
    sw._room_meta.clear()
    sw.build_room_list_diff(
        {
            "rooms": {
                "join": {
                    R1: {
                        "state": {"events": [_member(W1)]},
                        "timeline": {"events": []},
                    }
                }
            }
        },
        baseline=True,
    )
    edited = _msg(W1, "v1", 900)
    edited["content"]["m.new_content"] = {"body": "v2"}
    diff, _ = sw.build_room_list_diff(
        {
            "rooms": {
                "join": {
                    R1: {
                        "state": {"events": []},
                        "timeline": {"events": [edited]},
                    }
                }
            }
        },
        baseline=False,
    )
    it = diff[0]
    assert it.get("last_body") != "v2"
    assert it["last_ts"] == 900
