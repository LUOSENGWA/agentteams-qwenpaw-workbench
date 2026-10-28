# -*- coding: utf-8 -*-
"""attention 决策面回归（GET /attention 聚合 + POST /attention/answer）。

数据契约 = controller GET /api/v1/projects/{id}/attention（并行任务
attention-api）；404 = 端点未部署（旧 controller）→ 诚实降级
``{"deployed": false, "items": []}``（HTTP 200）。答 = 工作台以人类身份
（Matrix 登录 token）发 ``DECISION: <task_id> → <answer>`` 回任务房间，
不写任务 meta。

护栏：
- A1 聚合：逐项目拉取合并 + resolved 过滤 + requested_at 倒序 + count
  + project_id 补全。
- A2 旧 controller 404 → HTTP 200 + deployed=false（不报错）。
- A3 逐项目失败不致命：一项目 500 → errors 非空 + 其余照常返回。
- A4 无 controller token → 502（零拨号）。
- A5 30s 缓存：第二次 GET 命中（不重新拨号）；refresh=1 绕过。
- B0 task_id/answer 缺失 → 400（零拨号）。
- B1 有 options 时 answer 必须是 option id 之一，否则 400。
- B2 无 options 时自由文本 >500 → 400。
- B3 重复回答 → 409（本地去重拦截，零发送）。
- B4 成功路径：DECISION 行格式（含补充/basis 行）+ 人类 token 发送 +
  本地记录落盘 + 再次 409 + GET 反映 answered_locally/answered_history。
- B5 room 缺失 → 502（校验前置，零拨号）。
- B6 Matrix 发送失败 → 502 + 不写本地记录。
"""
from __future__ import annotations

import json

import pytest

from conftest import patch_shared_name

import agentteams_connector.attention_api as att_api
from agentteams_connector import config as cfgmod
from agentteams_connector import matrix_client as matrix_client_mod
from agentteams_connector.router import build_router


# ── 假 controller（URL 子串匹配，插入序优先——attention URL 含
# /api/v1/projects 前缀，必须排在通用键之前） ─────────────────────────


class _FakeResponse:
    def __init__(self, status_code: int, json_body=None, text: str = ""):
        self.status_code = status_code
        self.headers = {}
        self._json_body = json_body
        self.content = b""
        self.text = text or (json.dumps(json_body) if json_body is not None else "")

    def json(self):
        if self._json_body is None:
            raise AttributeError("no json body")
        return self._json_body


class _FakeClient:
    instances: list = []
    get_spec: dict = {}

    def __init__(self, *a, **k):
        self.calls: list = []
        _FakeClient.instances.append(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a, **k):
        return False

    @classmethod
    def _match(cls, url: str, spec: dict):
        for key, val in spec.items():
            if key in url:
                return _FakeResponse(val[0], val[1])
        return None

    async def get(self, url, headers=None, **k):
        self.calls.append(("GET", url))
        r = self._match(url, _FakeClient.get_spec)
        return r if r is not None else _FakeResponse(404)

    async def post(self, url, json=None, headers=None, **k):
        self.calls.append(("POST", url))
        return _FakeResponse(404)

    async def request(self, method, url, json=None, headers=None, **k):
        # ctl_client.ctl_json 统一走 client.request(method, url, ...)
        # （非 get/post 直调）——假客户端须暴露同款入口。
        if method.upper() == "GET":
            return await self.get(url, headers=headers, **k)
        return await self.post(url, json=json, headers=headers, **k)

    @classmethod
    def get_calls(cls) -> list:
        return [c[1] for inst in cls.instances for c in inst.calls if c[0] == "GET"]


@pytest.fixture
def client(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    state = {
        "data": {
            "controller_urls": ["http://10.0.0.1:8090"],
            "controller_token": "ctok123",
            "matrix_homeservers": ["http://10.0.0.1:8008"],
            "matrix": {"user_id": "@human:hs", "access_token": "mtok123"},
        }
    }

    def fake_load():
        return json.loads(json.dumps(state["data"]))

    monkeypatch.setattr(cfgmod, "load_config", fake_load)
    monkeypatch.delenv("AGENTTEAMS_CONTROLLER_TOKEN", raising=False)
    _FakeClient.instances = []
    _FakeClient.get_spec = {}
    patch_shared_name(monkeypatch, "GatedAsyncClient",
                      lambda *a, **k: _FakeClient(*a, **k))

    app = FastAPI()
    app.include_router(build_router())
    return TestClient(app), state


@pytest.fixture
def fake_send(monkeypatch):
    """matrix_client.send_message 假注入（捕获 (homeserver, token, room, body)）。"""
    calls = []

    def fake(homeserver, token, room_id, body, msgtype="m.text", content=None):
        calls.append(
            {"homeserver": homeserver, "token": token,
             "room_id": room_id, "body": body}
        )
        return {"event_id": f"$evt-{len(calls)}"}

    monkeypatch.setattr(matrix_client_mod, "send_message", fake)
    return calls


# ── 假数据（契约字段集） ──────────────────────────────────────────────

P1_ATTENTION = {
    "project_id": "p1",
    "count": 2,
    "items": [
        {
            "task_id": "t-older",
            "task_title": "旧任务",
            "task_status": "running",
            "kind": "decision",
            "question": "旧问题？",
            "attempt": 1,
            "requested_at": "2026-10-25T08:00:00Z",
            "resolved": False,
            "event_id": "$att-1",
            "options": [
                {"id": "proceed_once", "label": "继续一次"},
                {"id": "escalate", "label": "升级人工"},
            ],
            "suggested": "proceed_once",
            "expires_at": "2026-10-25T12:00:00Z",
        },
        {
            "task_id": "t-resolved",
            "task_title": "已处理",
            "task_status": "done",
            "kind": "other",
            "question": "旧问题",
            "attempt": 1,
            "requested_at": "2026-10-25T09:00:00Z",
            "resolved": True,
        },
    ],
}

P2_ATTENTION = {
    "project_id": "p2",
    "count": 1,
    "items": [
        {
            "task_id": "t-new",
            "task_title": "新任务",
            "task_status": "blocked",
            "kind": "escalation",
            "question": "要升级吗？",
            "attempt": 2,
            "requested_at": "2026-10-25T10:00:00Z",
            "resolved": False,
            "worker": "w1",
            "room_id": "!r2:hs",
            "expires_at": "2026-10-25T11:00:00Z",
        },
    ],
}

PROJECTS = {
    "projects": [
        {"project_id": "p1", "team_id": "tm1"},
        {"project_id": "p2"},
    ]
}


def _default_spec() -> dict:
    return {
        "/api/v1/projects/p1/attention": (200, P1_ATTENTION),
        "/api/v1/projects/p2/attention": (200, P2_ATTENTION),
        "/api/v1/projects": (200, PROJECTS),
    }


# ── A 读侧 ───────────────────────────────────────────────────────────


def test_aggregate_sort_filter_count(client):
    tc, _ = client
    _FakeClient.get_spec = _default_spec()
    r = tc.get("/attention")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["deployed"] is True
    assert d["count"] == 2
    # requested_at 倒序 + resolved 过滤（t-resolved 不出）
    assert [it["task_id"] for it in d["items"]] == ["t-new", "t-older"]
    # 聚合补全 project_id
    assert d["items"][0]["project_id"] == "p2"
    assert d["items"][1]["project_id"] == "p1"
    assert d["errors"] == []
    assert d["answered_history"] == []
    assert d["cached"] is False


def test_not_deployed_404_degrades(client):
    tc, _ = client
    _FakeClient.get_spec = {
        "/api/v1/projects/p1/attention": (404, None),
        "/api/v1/projects": (200, {"projects": [{"project_id": "p1"}]}),
    }
    r = tc.get("/attention")
    # 诚实降级：HTTP 200 + deployed=false（UI 不显示 badge、不报错）
    assert r.status_code == 200
    d = r.json()
    assert d["deployed"] is False
    assert d["items"] == []
    assert d["count"] == 0


def test_per_project_failure_tolerated(client):
    tc, _ = client
    _FakeClient.get_spec = {
        "/api/v1/projects/p1/attention": (500, None),
        "/api/v1/projects/p2/attention": (200, P2_ATTENTION),
        "/api/v1/projects": (200, PROJECTS),
    }
    r = tc.get("/attention")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["deployed"] is True
    assert [it["task_id"] for it in d["items"]] == ["t-new"]
    assert any("p1" in e for e in d["errors"]), d["errors"]


def test_no_token_502_no_dial(client):
    tc, state = client
    state["data"]["controller_token"] = ""
    _FakeClient.get_spec = _default_spec()
    r = tc.get("/attention")
    assert r.status_code == 502
    assert _FakeClient.get_calls() == []  # 零拨号


def test_cache_hit_and_refresh_bypass(client):
    tc, _ = client
    _FakeClient.get_spec = _default_spec()
    r1 = tc.get("/attention")
    assert r1.status_code == 200, r1.text
    assert r1.json()["cached"] is False
    n1 = len(_FakeClient.get_calls())
    assert n1 == 3  # 1 项目列表 + 2 attention
    # 第二次 GET 命中 30s 缓存 → 不重新拨号
    r2 = tc.get("/attention")
    assert r2.json()["cached"] is True
    assert len(_FakeClient.get_calls()) == n1
    # 上游变 404（旧 controller）——缓存命中仍见旧值（诚实：缓存窗口内）
    _FakeClient.get_spec = {
        "/api/v1/projects/p1/attention": (404, None),
        "/api/v1/projects/p2/attention": (404, None),
        "/api/v1/projects": (200, PROJECTS),
    }
    r3 = tc.get("/attention")
    assert r3.json()["deployed"] is True
    # refresh=1 绕过缓存 → 命中新 404 → 降级
    r4 = tc.get("/attention", params={"refresh": 1})
    assert r4.json()["cached"] is False
    assert r4.json()["deployed"] is False


# ── B 答侧 ───────────────────────────────────────────────────────────


ANSWER_BODY = {
    "room_id": "!r1:hs",
    "task_id": "t-older",
    "kind": "decision",
    "attempt": 1,
    "answer": "proceed_once",
}


def test_answer_missing_fields_400(client, fake_send):
    tc, _ = client
    r = tc.post("/attention/answer",
                json={"room_id": "!r1:hs", "task_id": "", "answer": "x"})
    assert r.status_code == 400
    r = tc.post("/attention/answer",
                json={"room_id": "!r1:hs", "task_id": "t-older", "answer": ""})
    assert r.status_code == 400
    assert fake_send == []
    assert _FakeClient.get_calls() == []  # 校验前置零拨号


def test_answer_option_validation_400(client, fake_send):
    tc, _ = client
    _FakeClient.get_spec = _default_spec()
    r = tc.post("/attention/answer", json={**ANSWER_BODY, "answer": "bogus"})
    assert r.status_code == 400
    assert "proceed_once" in r.json()["detail"]
    assert fake_send == []


def test_answer_free_text_too_long_400(client, fake_send):
    tc, _ = client
    _FakeClient.get_spec = _default_spec()
    # t-new（P2）无 options → 自由文本 ≤500
    r = tc.post("/attention/answer", json={
        "room_id": "!r2:hs", "task_id": "t-new", "kind": "escalation",
        "attempt": 2, "answer": "x" * 501,
    })
    assert r.status_code == 400
    assert "500" in r.json()["detail"]
    assert fake_send == []


def test_answer_duplicate_409(client, fake_send):
    tc, _ = client
    key = att_api._answer_key("t-older", "decision", 1)
    att_api._save_answered({key: {
        "key": key, "task_id": "t-older", "kind": "decision", "attempt": 1,
        "answer": "proceed_once", "room_id": "!r1:hs",
        "answered_at": "2026-10-25T00:00:00Z", "event_id": "$old",
    }})
    r = tc.post("/attention/answer", json=ANSWER_BODY)
    assert r.status_code == 409
    assert fake_send == []


def test_answer_missing_room_502(client, fake_send):
    tc, _ = client
    r = tc.post("/attention/answer", json={**ANSWER_BODY, "room_id": ""})
    assert r.status_code == 502
    assert fake_send == []
    assert _FakeClient.get_calls() == []  # 校验前置零拨号


def test_answer_success(client, fake_send):
    tc, _ = client
    _FakeClient.get_spec = _default_spec()
    r = tc.post("/attention/answer", json={
        **ANSWER_BODY,
        "text": "风险可控，先按一次继续",
        "basis": "已复现稳定，根因确认",
    })
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["ok"] is True
    assert d["event_id"] == "$evt-1"
    assert d["room_id"] == "!r1:hs"
    # 消息格式：DECISION 行 + 补充行 + basis 行（固定格式，不另造）
    assert fake_send[0]["body"] == (
        "DECISION: t-older → proceed_once\n"
        "风险可控，先按一次继续\n"
        "basis: 已复现稳定，根因确认"
    )
    # 人类身份（Matrix 登录 token，非插件服务账号）
    assert fake_send[0]["token"] == "mtok123"
    assert fake_send[0]["room_id"] == "!r1:hs"
    assert fake_send[0]["homeserver"] == "http://10.0.0.1:8008"
    # 本地记录落盘（key=task_id:kind:attempt）
    key = att_api._answer_key("t-older", "decision", 1)
    entries = att_api._load_answered()
    assert key in entries
    assert entries[key]["answer"] == "proceed_once"
    assert entries[key]["basis"] == "已复现稳定，根因确认"
    # 再次回答 → 409
    r2 = tc.post("/attention/answer", json=ANSWER_BODY)
    assert r2.status_code == 409
    # GET 反映 answered_locally + answered_history（绕过缓存取新值）
    r3 = tc.get("/attention", params={"refresh": 1})
    older = [it for it in r3.json()["items"] if it["task_id"] == "t-older"][0]
    assert older["answered_locally"] is True
    assert len(r3.json()["answered_history"]) == 1


def test_answer_send_failure_502(client, monkeypatch):
    tc, _ = client
    _FakeClient.get_spec = _default_spec()

    def boom(homeserver, token, room_id, body, msgtype="m.text", content=None):
        raise matrix_client_mod.MatrixError("connection reset by peer")

    monkeypatch.setattr(matrix_client_mod, "send_message", boom)
    r = tc.post("/attention/answer", json=ANSWER_BODY)
    assert r.status_code == 502
    assert "发送回答失败" in r.json()["detail"]
    # 发送失败不写本地记录（下次可重答）
    assert att_api._load_answered() == {}
