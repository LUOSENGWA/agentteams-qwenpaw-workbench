"""房间详情信息（Element 同款房间详情面板）单测。

覆盖：

- **room_info 聚合**：7 个 state 事件 + joined_members 全量路径
 （name/topic/alias/creator/join_rule/encrypted/成员列表 + 角色
 映射 owner/moderator/member + owner 在前排序）。
- **state 缺失（404 = 无该事件）**：name/topic/alias 缺失 → 空串；
 encryption 缺失 → False；join_rules 缺失 → 协议默认 public；
 power_levels 缺失 → 全员 0（member）。
- **成员空**：joined_members.joined={} → member_count=0 / members=[]。
- **power level 缺省**：users 无该用户 → users_default；权限表
 content=null（Controller 建队房间 null 权限表实锤）→ 全员 0。
- **硬错上抛**：joined_members 404（房间不存在）/ 403（未加入）/
 401（token 失效）→ MatrixError。
- **路由映射**：200 聚合 shape；404/403 → 502（附 Matrix 摘要）；
 401 → 401；未登录（无 token）→ 401。

httpx 一律 monkeypatch（room_info 的 ``_request`` 模块属性）——
单测不拨真实 homeserver。
"""
from __future__ import annotations

from agentteams_connector import config as cfgmod
from agentteams_connector import matrix_client
from agentteams_connector.matrix_client import MatrixError, room_info

HS = "https://hs.example"
ROOM = "!room:hs.example"
BASE = f"/_matrix/client/v3/rooms/{ROOM}"
ALICE = "@alice:hs.example"
BOB = "@bob:hs.example"
CAROL = "@carol:hs.example"


# ── 假对象 ─────────────────────────────────────────────
class _FakeRequest:
    """按 (method, path 子串) 路由的 _request 替身，记录全部调用。"""

    def __init__(self, spec: dict):
        # spec: {(method, path_substring): handler(call) | Exception}
        self.spec = spec
        self.calls: list[tuple[str, str, str, object]] = []

    def __call__(self, method, homeserver, path, token=None, json_body=None):
        self.calls.append((method, path, homeserver, json_body))
        for (m, sub), handler in self.spec.items():
            if m == method and sub in path:
                if isinstance(handler, Exception):
                    raise handler
                return handler()
        raise AssertionError(f"unexpected request: {method} {path}")


def _state404(path: str) -> Exception:
    return MatrixError(f"Matrix GET {path} -> 404: {{\"errcode\":\"M_NOT_FOUND\"}}")


_UNSET = object()  # power_content 缺省哨兵（None = content 为 null）


def _full_spec(power_content=_UNSET, joined=None):
    """全量 state 事件 + joined_members 的默认 spec（可覆盖）。"""
    pc = (
        {"users_default": 0, "users": {ALICE: 100, BOB: 50}}
        if power_content is _UNSET
        else power_content
    )
    spec = {
        ("GET", "/state/m.room.name"): lambda: {"name": "Team: 数据组"},
        ("GET", "/state/m.room.topic"): lambda: {"topic": "日常协作"},
        ("GET", "/state/m.room.canonical_alias"): lambda: {"alias": "#data:hs.example"},
        ("GET", "/state/m.room.create"): lambda: {"creator": ALICE, "room_version": "10"},
        ("GET", "/state/m.room.join_rules"): lambda: {"join_rule": "invite"},
        ("GET", "/state/m.room.encryption"): _state404("/state/m.room.encryption"),
        ("GET", "/state/m.room.power_levels"): lambda: {"content": pc},
        ("GET", "/joined_members"): lambda: {
            "joined": joined if joined is not None else {
                ALICE: {"display_name": "alice", "avatar_url": "mxc://hs/a"},
                BOB: {"display_name": "bob", "avatar_url": ""},
                CAROL: {"display_name": "carol"},
            },
        },
    }
    return spec


def _mk(monkeypatch, spec: dict) -> _FakeRequest:
    fake = _FakeRequest(spec)
    monkeypatch.setattr(matrix_client, "_request", fake)
    return fake


# ── room_info 纯逻辑 ──────────────────────────────────
def test_room_info_happy_path(monkeypatch):
    """全量 state + 3 成员：字段齐、角色映射、owner 在前。"""
    fake = _mk(monkeypatch, _full_spec())

    out = room_info(HS, "tok", ROOM)

    assert out["room_id"] == ROOM
    assert out["name"] == "Team: 数据组"
    assert out["topic"] == "日常协作"
    assert out["canonical_alias"] == "#data:hs.example"
    assert out["creator"] == ALICE
    assert out["join_rule"] == "invite"
    assert out["encrypted"] is False
    assert out["member_count"] == 3
    roles = {m["user_id"]: m["role"] for m in out["members"]}
    assert roles == {ALICE: "owner", BOB: "moderator", CAROL: "member"}
    levels = {m["user_id"]: m["power_level"] for m in out["members"]}
    assert levels == {ALICE: 100, BOB: 50, CAROL: 0}
    # owner 在前（power level 降序）。
    assert out["members"][0]["user_id"] == ALICE
    # 成员 profile 字段透传。
    alice = out["members"][0]
    assert alice["display_name"] == "alice"
    assert alice["avatar_url"] == "mxc://hs/a"


def test_room_info_missing_state_events_default(monkeypatch):
    """name/topic/alias/encryption/join_rules/power_levels 全 404 →
 空串/False/public/全员 0；create 缺失 → creator 空。"""
    spec = _full_spec()
    for sub in (
        "/state/m.room.name",
        "/state/m.room.topic",
        "/state/m.room.canonical_alias",
        "/state/m.room.create",
        "/state/m.room.join_rules",
        "/state/m.room.encryption",
        "/state/m.room.power_levels",
    ):
        spec[("GET", sub)] = _state404(sub)
    _mk(monkeypatch, spec)

    out = room_info(HS, "tok", ROOM)

    assert out["name"] == ""
    assert out["topic"] == ""
    assert out["canonical_alias"] == ""
    assert out["creator"] == ""
    assert out["join_rule"] == "public"  # 协议默认
    assert out["encrypted"] is False
    assert out["member_count"] == 3
    assert all(m["power_level"] == 0 for m in out["members"])
    assert all(m["role"] == "member" for m in out["members"])


def test_room_info_encrypted_true(monkeypatch):
    """m.room.encryption content 非 null → True；content null → False。"""
    spec = _full_spec()
    spec[("GET", "/state/m.room.encryption")] = (
        lambda: {"content": {"algorithm": "m.megolm.v1.aes-sha2"}}
    )
    _mk(monkeypatch, spec)
    assert room_info(HS, "tok", ROOM)["encrypted"] is True

    spec[("GET", "/state/m.room.encryption")] = lambda: {"content": None}
    _mk(monkeypatch, spec)
    assert room_info(HS, "tok", ROOM)["encrypted"] is False


def test_room_info_empty_members(monkeypatch):
    """joined_members 空 → member_count=0 / members=[]。"""
    _mk(monkeypatch, _full_spec(joined={}))

    out = room_info(HS, "tok", ROOM)

    assert out["member_count"] == 0
    assert out["members"] == []


def test_room_info_power_level_users_default_fallback(monkeypatch):
    """users 无该用户 → users_default（50 → moderator）。"""
    _mk(
        monkeypatch,
        _full_spec(power_content={"users_default": 50, "users": {}}),
    )

    out = room_info(HS, "tok", ROOM)

    assert all(m["power_level"] == 50 for m in out["members"])
    assert all(m["role"] == "moderator" for m in out["members"])


def test_room_info_power_levels_null_content(monkeypatch):
    """权限表 content=null（Controller 建队房间 null 权限表实锤）→ 全员 0。"""
    _mk(monkeypatch, _full_spec(power_content=None))

    out = room_info(HS, "tok", ROOM)

    assert all(m["power_level"] == 0 for m in out["members"])
    assert all(m["role"] == "member" for m in out["members"])


def test_room_info_state_403_raises(monkeypatch):
    """state 403（非 404）→ 硬错上抛（不吞）。"""
    spec = _full_spec()
    spec[("GET", "/state/m.room.name")] = MatrixError(
        "Matrix GET /state/m.room.name -> 403: {\"errcode\":\"M_FORBIDDEN\"}"
    )
    _mk(monkeypatch, spec)

    try:
        room_info(HS, "tok", ROOM)
    except MatrixError as exc:
        assert "403" in str(exc)
    else:
        raise AssertionError("expected MatrixError for state 403")


def test_room_info_joined_members_404_raises(monkeypatch):
    """joined_members 404（房间不存在）→ MatrixError 上抛。"""
    spec = _full_spec()
    spec[("GET", "/joined_members")] = MatrixError(
        f"Matrix GET {BASE}/joined_members -> 404: {{\"errcode\":\"M_NOT_FOUND\"}}"
    )
    _mk(monkeypatch, spec)

    try:
        room_info(HS, "tok", ROOM)
    except MatrixError as exc:
        assert "404" in str(exc)
    else:
        raise AssertionError("expected MatrixError for joined_members 404")


def test_room_info_joined_members_401_raises(monkeypatch):
    """joined_members 401（token 失效）→ MatrixError 上抛。"""
    spec = _full_spec()
    spec[("GET", "/joined_members")] = MatrixError(
        f"Matrix GET {BASE}/joined_members -> 401: {{\"errcode\":\"M_UNKNOWN_TOKEN\"}}"
    )
    _mk(monkeypatch, spec)

    try:
        room_info(HS, "tok", ROOM)
    except MatrixError as exc:
        assert "401" in str(exc)
    else:
        raise AssertionError("expected MatrixError for joined_members 401")


# ── 路由映射 ─────────────────────────────────────────
def _route_env(monkeypatch, with_token=True):
    from agentteams_connector.routers import matrix_api

    def fake_load():
        return {
            "matrix": {
                "access_token": "tok" if with_token else "",
                "user_id": "@me:hs.example",
            }
        }

    monkeypatch.setattr(cfgmod, "load_config", fake_load)
    monkeypatch.setattr(matrix_api, "_pick_address", lambda cfg, kind: HS)
    return matrix_api


def _client(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from agentteams_connector.router import build_router

    app = FastAPI()
    app.include_router(build_router())
    return TestClient(app)


def _raiser(exc: Exception):
    def _f(*args, **kwargs):
        raise exc

    return _f


def test_room_info_route_happy(monkeypatch):
    """200：ok + 聚合 shape 透传。"""
    _route_env(monkeypatch)
    fake_out = {
        "room_id": ROOM,
        "name": "Team: 数据组",
        "topic": "",
        "canonical_alias": "",
        "creator": ALICE,
        "join_rule": "invite",
        "encrypted": False,
        "member_count": 1,
        "members": [
            {
                "user_id": ALICE,
                "display_name": "alice",
                "avatar_url": "",
                "power_level": 100,
                "role": "owner",
            }
        ],
    }
    monkeypatch.setattr(matrix_client, "room_info", lambda *a: fake_out)

    r = _client(monkeypatch).get(f"/matrix/rooms/{ROOM}/info")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["room_id"] == ROOM
    assert body["name"] == "Team: 数据组"
    assert body["member_count"] == 1
    assert body["members"][0]["role"] == "owner"


def test_room_info_route_404_to_502(monkeypatch):
    """joined_members 404（房间不存在）→ 502 + Matrix 摘要。"""
    _route_env(monkeypatch)
    monkeypatch.setattr(
        matrix_client,
        "room_info",
        _raiser(
            MatrixError(
                f"Matrix GET {BASE}/joined_members -> 404: "
                "{\"errcode\":\"M_NOT_FOUND\"}"
            )
        ),
    )

    r = _client(monkeypatch).get(f"/matrix/rooms/{ROOM}/info")
    assert r.status_code == 502
    assert "404" in r.json()["detail"]


def test_room_info_route_403_to_502(monkeypatch):
    """403（未加入/无权限）→ 502 + Matrix 摘要。"""
    _route_env(monkeypatch)
    monkeypatch.setattr(
        matrix_client,
        "room_info",
        _raiser(
            MatrixError(
                f"Matrix GET {BASE}/joined_members -> 403: "
                "{\"errcode\":\"M_FORBIDDEN\"}"
            )
        ),
    )

    r = _client(monkeypatch).get(f"/matrix/rooms/{ROOM}/info")
    assert r.status_code == 502
    assert "403" in r.json()["detail"]


def test_room_info_route_401(monkeypatch):
    """401（token 失效）→ 401。"""
    _route_env(monkeypatch)
    monkeypatch.setattr(
        matrix_client,
        "room_info",
        _raiser(
            MatrixError(
                f"Matrix GET {BASE}/joined_members -> 401: "
                "{\"errcode\":\"M_UNKNOWN_TOKEN\"}"
            )
        ),
    )

    r = _client(monkeypatch).get(f"/matrix/rooms/{ROOM}/info")
    assert r.status_code == 401


def test_room_info_route_not_logged_in(monkeypatch):
    """未登录（无 token）→ 401，不拨上游。"""
    _route_env(monkeypatch, with_token=False)
    monkeypatch.setattr(
        matrix_client, "room_info", lambda *a: AssertionError("不应拨上游")
    )

    r = _client(monkeypatch).get(f"/matrix/rooms/{ROOM}/info")
    assert r.status_code == 401
