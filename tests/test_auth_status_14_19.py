# v0.5.0-beta.14.19: 登录态/凭据健康（/auth-status + token 失效检测）。
#
# 背景：matrix access_token 失效（改密/踢设备/admin 重置）后，
# sync 循环此前无限 15s 空转 401、@通知静默全断、前端零感知；
# Higress console_session 过期后 alias 层静默消失同样无感知。
# 本批：确定性检测（401+Matrix auth errcode 才判死，网关门 401 不误报）
# + 低频复核（180s）+ /auth-status 端点（零外发）+ 前端横幅。
from __future__ import annotations

import json

import pytest

from agentteams_connector import config as cfgmod
from agentteams_connector import router as router_mod
from agentteams_connector import sync_watcher as sw


@pytest.fixture(autouse=True)
def _reset_auth_state(monkeypatch):
    """进程内登录态标记逐测清零（模块级全局，测试间不互污）。"""
    monkeypatch.setattr(sw, "_auth_invalid", False)
    monkeypatch.setattr(router_mod, "_console_session_expired", False)
    yield


def _app():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(router_mod.build_router())
    return TestClient(app)


def _patch_config(monkeypatch, state: dict):
    def fake_load():
        return json.loads(json.dumps(state))

    monkeypatch.setattr(cfgmod, "load_config", fake_load)


# ── is_auth_invalid_401 判据（确定性信号，非连续失败推断） ──────────


def test_auth_invalid_on_unknown_token():
    assert sw.is_auth_invalid_401(
        401, '{"errcode":"M_UNKNOWN_TOKEN","error":"token dead"}'
    )


def test_auth_invalid_on_missing_token():
    assert sw.is_auth_invalid_401(
        401, '{"errcode":"M_MISSING_TOKEN","error":"no token"}'
    )


def test_auth_invalid_on_forbidden():
    assert sw.is_auth_invalid_401(401, '{"errcode":"M_FORBIDDEN"}')


def test_not_auth_invalid_gateway_basic_401():
    # 网关 Basic 门（Caddy）：401 + 空 body → 地址/门问题，不是 token 死。
    assert not sw.is_auth_invalid_401(401, "")
    assert not sw.is_auth_invalid_401(401, "Unauthorized")


def test_not_auth_invalid_other_status():
    assert not sw.is_auth_invalid_401(403, '{"errcode":"M_FORBIDDEN"}')
    assert not sw.is_auth_invalid_401(502, '{"errcode":"M_UNKNOWN_TOKEN"}')
    assert not sw.is_auth_invalid_401(400, '{"errcode":"M_UNKNOWN_TOKEN"}')


def test_not_auth_invalid_non_matrix_json():
    # 401 + 非 Matrix JSON body（别家网关）→ 不判 token 死。
    assert not sw.is_auth_invalid_401(401, '{"detail":"proxy session required"}')


def test_auth_status_roundtrip():
    assert sw.auth_status() == "valid"
    sw._auth_invalid = True
    assert sw.auth_status() == "invalid"
    sw.reset_state()  # 重登/切账号 → 清零
    assert sw.auth_status() == "valid"


# ── /auth-status 端点（零外发请求，纯进程内状态） ──────────────────


def test_auth_status_no_login(monkeypatch):
    _patch_config(
        monkeypatch,
        {
            "matrix": {"user_id": "", "access_token": "", "device_id": ""},
            "controller_token": "",
            "console_session": "",
        },
    )
    with _app() as tc:
        r = tc.get("/auth-status")
    assert r.status_code == 200
    body = r.json()
    assert body["matrix_token"] == "none"
    assert body["console_session"] == "none"
    assert body["controller_token"] == "none"


def test_auth_status_healthy(monkeypatch):
    _patch_config(
        monkeypatch,
        {
            "matrix": {"user_id": "@me:ex", "access_token": "mtok", "device_id": "d"},
            "controller_token": "ctok",
            "console_session": "sid=123",
        },
    )
    with _app() as tc:
        body = tc.get("/auth-status").json()
    assert body["matrix_token"] == "valid"
    assert body["console_session"] == "active"
    assert body["controller_token"] == "config"


def test_auth_status_matrix_invalid(monkeypatch):
    _patch_config(
        monkeypatch,
        {
            "matrix": {"user_id": "@me:ex", "access_token": "mtok", "device_id": "d"},
            "controller_token": "",
            "console_session": "",
        },
    )
    sw._auth_invalid = True  # /sync 401+errcode 置位（_run 路径）
    with _app() as tc:
        body = tc.get("/auth-status").json()
    assert body["matrix_token"] == "invalid"


def test_auth_status_console_expired(monkeypatch):
    _patch_config(
        monkeypatch,
        {
            "matrix": {"user_id": "@me:ex", "access_token": "mtok", "device_id": "d"},
            "controller_token": "",
            "console_session": "sid=123",
        },
    )
    router_mod._console_session_expired = True  # 网关面 401 被动置位
    with _app() as tc:
        body = tc.get("/auth-status").json()
    assert body["console_session"] == "expired"
    assert body["matrix_token"] == "valid"  # 两态独立，不互扰
