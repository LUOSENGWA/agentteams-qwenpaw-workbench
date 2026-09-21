# -*- coding: utf-8 -*-
"""/teams/sync last_sender 回归测试（v0.5.0-beta.13.2 灯源修正）。

背景（用户反馈「状态灯一直绿」根因）：session 灯 done 回退原用**房间级
last_ts**——用户自己在房间里发消息也会刷新 last_ts → 该房间所有 Worker
被点绿。修正为 **per-sender**（与 dashboard 9a9cc8d 同源）：后端在房间
条目上携带最后一条消息的发送者 ``last_sender``，前端 done 回退只认
Worker 自己的消息。

护栏：

- 最后一条是消息 → last_sender = 该事件 sender。
- 最后一条不是消息（如 m.reaction）→ last_sender = ""（last_ts 不受影响）。
- 无 timeline → last_sender = "" 且 last_ts = 0。
"""
from __future__ import annotations

from agentteams_connector.router import _parse_sync_rooms

W1 = "@worker-1:example.org"
HUMAN = "@human:example.org"


def _sync_resp(last_event: dict | None) -> dict:
    timeline = {"events": [last_event] if last_event else []}
    return {
        "rooms": {
            "join": {
                "!room1:example.org": {
                    "state": {
                        "events": [
                            {
                                "type": "m.room.name",
                                "content": {"name": "test-room"},
                            },
                            {
                                "type": "m.room.member",
                                "state_key": W1,
                                "content": {"membership": "join"},
                            },
                        ]
                    },
                    "ephemeral": {"events": []},
                    "timeline": timeline,
                    "unread_notifications": {
                        "notification_count": 0,
                        "highlight_count": 0,
                    },
                }
            }
        }
    }


def _room(result: dict) -> dict:
    (room,) = result["rooms"]
    assert room["room_id"] == "!room1:example.org"
    return room


def test_last_sender_is_message_sender():
    resp = _sync_resp(
        {
            "type": "m.room.message",
            "sender": W1,
            "origin_server_ts": 1_700_000_100,
            "content": {"msgtype": "m.text", "body": "done"},
        }
    )
    room = _room(_parse_sync_rooms(resp, HUMAN))
    assert room["last_sender"] == W1
    assert room["last_ts"] == 1_700_000_100


def test_last_sender_tracks_human_messages_too():
    # 人类消息同样携带 sender——「不点绿」的判定在前端 per-sender 门
    # （last_sender !== worker_mxid），后端只负责如实透传。
    resp = _sync_resp(
        {
            "type": "m.room.message",
            "sender": HUMAN,
            "origin_server_ts": 1_700_000_200,
            "content": {"msgtype": "m.text", "body": "go"},
        }
    )
    room = _room(_parse_sync_rooms(resp, HUMAN))
    assert room["last_sender"] == HUMAN


def test_non_message_last_event_yields_empty_sender():
    resp = _sync_resp(
        {
            "type": "m.reaction",
            "sender": W1,
            "origin_server_ts": 1_700_000_300,
            "content": {},
        }
    )
    room = _room(_parse_sync_rooms(resp, HUMAN))
    assert room["last_sender"] == ""
    # last_ts 仍取最后事件时间（排序语义不变）。
    assert room["last_ts"] == 1_700_000_300


def test_empty_timeline_defaults():
    room = _room(_parse_sync_rooms(_sync_resp(None), HUMAN))
    assert room["last_sender"] == ""
    assert room["last_ts"] == 0
