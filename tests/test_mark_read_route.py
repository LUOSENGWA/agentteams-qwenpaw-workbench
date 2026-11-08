# -*- coding: utf-8 -*-
"""mark-read 路由 body 解析回归：局部 Pydantic 类 + future annotations 会把
body 误判成 query（422 `loc: ["query","req"]`）。"""
from fastapi import FastAPI
from fastapi.testclient import TestClient

from agentteams_connector.router import build_router


def _client():
    app = FastAPI()
    app.include_router(build_router())
    return TestClient(app)


def test_mark_read_accepts_json_body(monkeypatch):
    r = _client().post("/matrix/mark-read", json={"room_id": "!none:test"})
    # 未配置 token → 401；配置了也不该是 body 解析失败
    assert r.status_code != 422, r.text
    assert "query" not in r.text
