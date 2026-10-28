"""DM 房间命名 + /dm 透传（发起任务流程无名空房间根因修复）单测。

覆盖：

- **create_dm 建房带名**：POST /createRoom body 含 ``name``/``topic``
 （显式传 = 透传；缺省 = ``私聊 · <localpart>`` / ``Direct chat with <mxid>``）。
- **复用已有 DM 补名**：m.direct 命中 → GET state 404（无名）→ PUT
 ``m.room.name`` 补名；已命名房间不重复 PUT；补名 PUT 失败仍正常返回
 （best-effort，只记日志）。
- **/dm 路由透传**：``DmRequest.name``/``topic`` → ``create_dm``（缺省空串
 = 后端兜底命名，旧前端向后兼容）。

httpx 一律 monkeypatch（``_request``/``_existing_direct_room``/``create_dm``
模块属性）——单测不拨真实 homeserver。
"""
from __future__ import annotations

from agentteams_connector import config as cfgmod
from agentteams_connector import matrix_client
from agentteams_connector.matrix_client import MatrixError, create_dm

HS = "https://hs.example"
ALICE = "@alice:hs.example"


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
    return MatrixError(
        f"Matrix GET {path} -> 404: {{\"errcode\":\"M_NOT_FOUND\"}}"
    )


# ── create_dm 纯逻辑 ──────────────────────────────────
def test_create_dm_new_room_body_has_default_name_topic(monkeypatch):
    """新房间：body 含 name=私聊·<localpart> / topic=Direct chat with <mxid>。"""
    monkeypatch.setattr(matrix_client, "_existing_direct_room", lambda *a: None)
    fake = _FakeRequest(
        {
            ("POST", "/createRoom"): lambda: {"room_id": "!new:hs.example"},
        }
    )
    monkeypatch.setattr(matrix_client, "_request", fake)

    out = create_dm(HS, "tok", ALICE)

    assert out == {"room_id": "!new:hs.example", "created": True}
    (method, path, hs, body) = fake.calls[0]
    assert method == "POST" and path == "/_matrix/client/v3/createRoom" and hs == HS
    assert body["preset"] == "trusted_private_chat"
    assert body["invite"] == [ALICE]
    assert body["is_direct"] is True
    assert body["name"] == "私聊 · alice"
    assert body["topic"] == "Direct chat with @alice:hs.example"


def test_create_dm_explicit_name_topic_passthrough(monkeypatch):
    """显式 name/topic（发起任务流程带团队上下文）原样透传。"""
    monkeypatch.setattr(matrix_client, "_existing_direct_room", lambda *a: None)
    fake = _FakeRequest(
        {("POST", "/createRoom"): lambda: {"room_id": "!new:hs.example"}}
    )
    monkeypatch.setattr(matrix_client, "_request", fake)

    create_dm(
        HS, "tok", ALICE, name="私聊 · 数据组 · 阿福", topic="自定义话题"
    )

    body = fake.calls[0][3]
    assert body["name"] == "私聊 · 数据组 · 阿福"
    assert body["topic"] == "自定义话题"


def _mk_reuse_env(monkeypatch, spec: dict, existing: str):
    """复用路径公共环境：m.direct 命中 existing，_request 走 spec。"""
    monkeypatch.setattr(
        matrix_client, "_existing_direct_room", lambda *a: existing
    )
    fake = _FakeRequest(spec)
    monkeypatch.setattr(matrix_client, "_request", fake)
    return fake


def test_create_dm_reuse_unnamed_room_backfills_name(monkeypatch):
    """已有无名房间（GET state 404）→ PUT m.room.name 补名。"""
    fake = _mk_reuse_env(
        monkeypatch,
        {
            ("GET", "/state/m.room.name"): _state404("/state/m.room.name"),
            ("PUT", "/state/m.room.name"): lambda: {"name": "私聊 · alice"},
        },
        "!old:hs.example",
    )

    out = create_dm(HS, "tok", ALICE)

    assert out == {"room_id": "!old:hs.example", "created": False}
    puts = [c for c in fake.calls if c[0] == "PUT"]
    assert len(puts) == 1
    assert puts[0][1].endswith("/state/m.room.name")
    assert puts[0][3] == {"name": "私聊 · alice"}


def test_create_dm_reuse_named_room_skips_put(monkeypatch):
    """已命名房间（含用户重命名）→ 不覆盖、不 PUT。"""
    fake = _mk_reuse_env(
        monkeypatch,
        {("GET", "/state/m.room.name"): lambda: {"name": "我的重命名"}},
        "!old:hs.example",
    )

    out = create_dm(HS, "tok", ALICE)

    assert out == {"room_id": "!old:hs.example", "created": False}
    assert [c for c in fake.calls if c[0] == "PUT"] == []


def test_create_dm_reuse_backfill_put_failure_still_returns(monkeypatch):
    """补名 PUT 失败 = best-effort（只记日志），create_dm 正常返回。"""
    fake = _mk_reuse_env(
        monkeypatch,
        {
            ("GET", "/state/m.room.name"): _state404("/state/m.room.name"),
            ("PUT", "/state/m.room.name"): MatrixError(
                "Matrix PUT /state/m.room.name -> 403: {\"errcode\":\"M_FORBIDDEN\"}"
            ),
        },
        "!old:hs.example",
    )

    out = create_dm(HS, "tok", ALICE)

    assert out == {"room_id": "!old:hs.example", "created": False}


# ── /dm 路由透传 ──────────────────────────────────────
def test_dm_route_passes_name_topic(monkeypatch):
    """DmRequest.name/topic → create_dm 位置透传；缺省空串 = 后端兜底。"""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from agentteams_connector.router import build_router
    from agentteams_connector.routers import matrix_api

    def fake_load():
        return {
            "matrix": {"access_token": "tok", "user_id": "@me:hs.example"}
        }

    recorded: list[tuple[str, str, str]] = []

    def fake_create_dm(homeserver, token, mxid, name="", topic=""):
        recorded.append((mxid, name, topic))
        return {"room_id": "!dm:hs.example", "created": True}

    monkeypatch.setattr(cfgmod, "load_config", fake_load)
    monkeypatch.setattr(
        matrix_api, "_pick_address", lambda cfg, kind: HS
    )
    monkeypatch.setattr(matrix_client, "create_dm", fake_create_dm)

    app = FastAPI()
    app.include_router(build_router())
    tc = TestClient(app)

    # 显式 name/topic（前端发起任务流程）
    r = tc.post(
        "/dm",
        json={
            "user": ALICE,
            "name": "私聊 · 数据组 · 阿福",
            "topic": "自定义话题",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["room_id"] == "!dm:hs.example"
    assert body["created"] is True
    assert recorded[-1] == ("@alice:hs.example", "私聊 · 数据组 · 阿福", "自定义话题")

    # 缺省（旧前端不传）→ 空串透传，由 create_dm 兜底命名
    r = tc.post("/dm", json={"user": ALICE})
    assert r.status_code == 200
    assert recorded[-1] == ("@alice:hs.example", "", "")
