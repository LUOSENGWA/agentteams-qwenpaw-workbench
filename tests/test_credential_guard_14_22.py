# -*- coding: utf-8 -*-
"""凭据意图检查 + 回读校验 + SWR TTL 自适应。

覆盖（14.22 凭据护栏：「地址/模式保存后跳回默认」「凭据显示已保存
但拨号仍 401」两类现象的代码侧
收口——安装层已证清白，剩余缺口=凭据静默降级无痕 + 长重载窗配置
默认态）：
- credential_gaps：选覆盖凭据但凭据空且旧条目无同类型可继承 → 报缺口
 （类型不同=不可继承，同缺口）；
- 继承成功/显式清除（type=none）/bearer 同语义 → 无缺口；
- PUT /config：缺口 → 400 文案点名地址位置；无缺口 → 200 +
 credential_check 回读形态逐位置正确；
- persisted_credential_kinds：str/basic/bearer 三态识别；
- kb_swr_ttl_for：wan=180 / lan=auto=非法=60。
"""
from __future__ import annotations

import pytest

from agentteams_connector import config as config_mod
from agentteams_connector.router import build_router, kb_swr_ttl_for


# ── credential_gaps ──────────────────────────────────────────────────────


def test_gaps_basic_empty_no_old_auth():
    # 用户选 basic 填了用户名但没填密码，旧条目是纯 str（无凭据可继承）
    gaps = config_mod.credential_gaps(
        ["http://lan", "https://wan"],
        ["http://lan",
         {"url": "https://wan",
          "auth": {"type": "basic", "username": "testuser", "password": ""}}],
    )
    assert gaps == [{"index": 1, "type": "basic", "username": "testuser"}]


def test_gaps_basic_empty_masked_no_old_auth():
    # 脱敏占位 *** + 无旧凭据 = 同样无法继承（前端回显协议下的缺口）。
    gaps = config_mod.credential_gaps(
        ["https://wan"],
        [{"url": "https://wan",
          "auth": {"type": "basic", "username": "u", "password": "***"}}],
    )
    assert gaps == [{"index": 0, "type": "basic", "username": "u"}]


def test_gaps_basic_inherit_same_type_ok():
    # 旧条目有 basic 凭据 → 空密码=继承成功，无缺口。
    old = [{"url": "https://wan",
            "auth": {"type": "basic", "username": "u", "password": "old"}}]
    new = [{"url": "https://wan",
             "auth": {"type": "basic", "username": "u", "password": ""}}]
    assert config_mod.credential_gaps(old, new) == []


def test_gaps_basic_type_mismatch_is_gap():
    # 旧条目是 bearer、新选 basic → 无字段可继承（merge 静默降级 str）。
    old = [{"url": "https://wan",
            "auth": {"type": "bearer", "token": "k"}}]
    new = [{"url": "https://wan",
             "auth": {"type": "basic", "username": "u", "password": ""}}]
    gaps = config_mod.credential_gaps(old, new)
    assert gaps == [{"index": 0, "type": "basic", "username": "u"}]


def test_gaps_bearer_empty_no_old_auth():
    gaps = config_mod.credential_gaps(
        ["https://higress"],
        [{"url": "https://higress",
          "auth": {"type": "bearer", "token": ""}}],
    )
    assert gaps == [{"index": 0, "type": "bearer"}]


def test_gaps_explicit_clear_not_gap():
    # type=none / 缺 auth = 显式清除，无继承语义 → 不报缺口。
    old = [{"url": "https://wan",
            "auth": {"type": "basic", "username": "u", "password": "p"}}]
    new = [{"url": "https://wan", "auth": {"type": "none"}}]
    assert config_mod.credential_gaps(old, new) == []
    assert config_mod.credential_gaps(old, ["https://wan"]) == []


def test_gaps_fresh_credentials_no_gap():
    new = [{"url": "https://wan",
            "auth": {"type": "basic", "username": "u", "password": "new"}}]
    assert config_mod.credential_gaps(None, new) == []
    assert config_mod.credential_gaps([], new) == []


# ── persisted_credential_kinds ───────────────────────────────────────────


def test_persisted_kinds_three_states():
    entries = [
        "http://lan",
        {"url": "https://a", "auth": {"type": "basic",
                                      "username": "u", "password": "p"}},
        {"url": "https://b", "auth": {"type": "bearer", "token": "k"}},
        {"url": "https://c", "auth": {"type": "basic",
                                      "username": "u", "password": ""}},
    ]
    assert config_mod.persisted_credential_kinds(entries) == [
        "str", "basic", "bearer", "str",
    ]
    assert config_mod.persisted_credential_kinds(None) == []


# ── PUT /config 集成 ──────────────────────────────────────────────────────


@pytest.fixture()
def client(monkeypatch, tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from agentteams_connector import selfcheck as selfcheck_mod

    cfg_dir = tmp_path / "agentteams-qwenpaw-workbench"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(config_mod, "_SECRET_DIR", tmp_path)
    monkeypatch.setattr(config_mod, "_CONFIG_DIR", cfg_dir)
    monkeypatch.setattr(config_mod, "_CONFIG_PATH", cfg_dir / "config.json")

    async def noop_probe(cfg, kinds=("matrix", "controller")):
        return {}

    monkeypatch.setattr(selfcheck_mod, "refresh_effective", noop_probe)
    app = FastAPI()
    app.include_router(build_router())
    return TestClient(app)


def test_put_config_credential_gap_400(client):
    resp = client.put("/config", json={
        "config": {
            "controller_urls": [
                "http://lan:6866",
                {"url": "https://wan:7113",
                 "auth": {"type": "basic", "username": "testuser",
                          "password": ""}},
            ],
        },
    })
    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert "Controller" in detail and "Basic" in detail
    assert "第 2 个地址" in detail


def test_put_config_credential_inherit_ok_200(client):
    # 先落一组 basic 凭据。
    r1 = client.put("/config", json={
        "config": {"controller_urls": [
            "http://lan:6866",
            {"url": "https://wan:7113",
             "auth": {"type": "basic", "username": "testuser",
                      "password": "p1"}},
        ]},
    })
    assert r1.status_code == 200
    # 再保存：空密码=继承 → 200，回读校验=第 2 条 basic。
    r2 = client.put("/config", json={
        "config": {"controller_urls": [
            "http://lan:6866",
            {"url": "https://wan:7113",
             "auth": {"type": "basic", "username": "testuser",
                      "password": ""}},
        ]},
    })
    assert r2.status_code == 200
    check = r2.json()["credential_check"]
    assert check["controller"] == ["str", "basic"]
    # 落盘值确实继承了旧密码（拨号凭据不丢）。
    stored = config_mod.load_config()["controller_urls"][1]
    assert stored["auth"]["password"] == "p1"


def test_put_config_credential_check_shapes(client):
    r = client.put("/config", json={
        "config": {
            "matrix_homeservers": ["http://lan:6867"],
            "sglang": {"enabled": True, "urls": [
                {"url": "https://higress:7113",
                 "auth": {"type": "bearer", "token": "key"}},
            ]},
        },
    })
    assert r.status_code == 200
    check = r.json()["credential_check"]
    assert check["matrix"] == ["str"]
    assert check["sglang"] == ["bearer"]
    assert check["gateway"] == []  # 未提交=保持原样（默认空）


# ── kb_swr_ttl_for ───────────────────────────────────────────────────────


def test_kb_swr_ttl_adaptive():
    assert kb_swr_ttl_for("wan") == 180.0
    assert kb_swr_ttl_for("lan") == 60.0
    assert kb_swr_ttl_for("auto") == 60.0
    assert kb_swr_ttl_for("") == 60.0
    assert kb_swr_ttl_for(None) == 60.0
    assert kb_swr_ttl_for("WAN") == 60.0  # 非法值=auto 口径（load_config 已降级）
