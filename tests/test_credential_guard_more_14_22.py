# -*- coding: utf-8 -*-
"""PUT /config 凭据护栏——四类地址族缺口 400 / 继承 /
显式清除单测（B 组）。

与既有 test_credential_guard_14_22.py（钉 controller 族 + merge 口径）
互补，本文件钉其余地址族与反向口径：

- B1 gateway_admin_urls（Higress）缺口 → 400，detail 点名族 + 位置；
- B2 sglang.urls（SGLang）缺口 → 400（bearer 空 token）；
- B3 matrix 继承成功 → 200 + credential_check + 落盘密码继承；
- B4 反向类型不匹配（旧 basic → 新 bearer 空 token）→ 400
  （类型不匹配 = 无字段可继承 = 同缺口）；
- B5 显式清除（type=none）→ 200，落盘降级 str，credential_check "str"；
- B6 多族同批：一缺口整单拒（400 只点缺口族，不受影响族不落盘）。

fixture 为本文件自带副本（不 import 其他测试文件的 fixture）：tmp 配置
目录 + refresh_effective 置 no-op（PUT /config 的后台探测任务不拨号）。
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from agentteams_connector import config as config_mod
from agentteams_connector import selfcheck as selfcheck_mod
from agentteams_connector.router import build_router


@pytest.fixture()
def client(monkeypatch, tmp_path):
    """tmp 配置目录 + build_router + TestClient（同既有 14.22 护栏测试范式）。"""
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


def test_b1_gateway_admin_urls_gap_400(client):
    """B1：Higress 管理网关地址 basic 空密码、无已存凭据 → 400。"""
    r = client.put("/config", json={"config": {
        "gateway_admin_urls": [
            {"url": "https://gw.example.com",
             "auth": {"type": "basic", "username": "admin", "password": ""}},
        ],
    }})
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert "Higress" in detail
    assert "第 1 个地址" in detail
    assert "admin" in detail
    assert "Basic 认证" in detail
    # 400 在保存前拦截 → 不落盘
    assert (config_mod.load_config().get("gateway_admin_urls") or []) == []


def test_b2_sglang_urls_gap_400(client):
    """B2：SGLang 地址 bearer 空 token、无已存凭据 → 400。"""
    r = client.put("/config", json={"config": {
        "sglang": {"enabled": True, "urls": [
            {"url": "https://sg.example.com",
             "auth": {"type": "bearer", "token": ""}},
        ]},
    }})
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert "SGLang" in detail
    assert "第 1 个地址" in detail
    assert "API Key" in detail


def test_b3_matrix_inherit_success_200(client):
    """B3：basic 先存 p0，再同位置空密码保存 → 200 + 落盘继承 p0。"""
    r1 = client.put("/config", json={"config": {
        "matrix_homeservers": [
            {"url": "https://matrix.example.com",
             "auth": {"type": "basic", "username": "luo", "password": "p0"}},
        ],
    }})
    assert r1.status_code == 200
    assert r1.json()["credential_check"]["matrix"] == ["basic"]

    r2 = client.put("/config", json={"config": {
        "matrix_homeservers": [
            {"url": "https://matrix.example.com",
             "auth": {"type": "basic", "username": "luo", "password": ""}},
        ],
    }})
    assert r2.status_code == 200
    assert r2.json()["credential_check"]["matrix"] == ["basic"]
    # 落盘密码继承旧值（空串=继承口径）
    assert (config_mod.load_config()["matrix_homeservers"][0]
            ["auth"]["password"] == "p0")


def test_b4_type_mismatch_gap_400(client):
    """B4：反向类型不匹配——旧 basic，新同位置 bearer 空 token → 400。

    credential_gaps 口径：同位置旧凭据与新类型不同 → old_auth=None
    （无字段可继承）→ 同缺口 400。"""
    r0 = client.put("/config", json={"config": {
        "matrix_homeservers": [
            {"url": "https://m.example.com",
             "auth": {"type": "basic", "username": "luo", "password": "p0"}},
        ],
    }})
    assert r0.status_code == 200

    r = client.put("/config", json={"config": {
        "matrix_homeservers": [
            {"url": "https://m.example.com",
             "auth": {"type": "bearer", "token": ""}},
        ],
    }})
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert "Matrix" in detail
    assert "API Key" in detail
    assert "第 1 个地址" in detail


def test_b5_explicit_clear_200(client):
    """B5：显式清除（type=none）→ 200，落盘降级 str，credential_check "str"。

    显式清除=用户意图（不报缺口）；落盘形态 str（无凭据条目），
    persisted_credential_kinds 口径「非 dict 条目/无有效 auth → str」。"""
    r0 = client.put("/config", json={"config": {
        "matrix_homeservers": [
            {"url": "https://m.example.com",
             "auth": {"type": "basic", "username": "luo", "password": "p0"}},
        ],
    }})
    assert r0.status_code == 200

    r = client.put("/config", json={"config": {
        "matrix_homeservers": [
            {"url": "https://m.example.com", "auth": {"type": "none"}},
        ],
    }})
    assert r.status_code == 200
    assert r.json()["credential_check"]["matrix"] == ["str"]
    # 落盘降级 str 条目（显式清除口径）
    assert config_mod.load_config()["matrix_homeservers"] == [
        "https://m.example.com"]


def test_b6_multi_family_batch_reject(client):
    """B6：多族同批——matrix 缺口 + controller 继承成功 → 400 整单拒，只点 matrix 缺口。

    前置：controller 第 2 地址已存 basic（luo/p0）。同批 PUT 发 controller
    空密码（可继承）+ matrix 缺口（无已存凭据）。400 在 update_config 前
    抛出 → 整单不落盘（controller 密码仍 p0，matrix 未保存）。"""
    r0 = client.put("/config", json={"config": {
        "controller_urls": [
            "http://10.0.0.20:6866",
            {"url": "https://wan.example.com",
             "auth": {"type": "basic", "username": "luo", "password": "p0"}},
        ],
    }})
    assert r0.status_code == 200

    r = client.put("/config", json={"config": {
        "matrix_homeservers": [
            {"url": "https://m.example.com",
             "auth": {"type": "basic", "username": "newuser", "password": ""}},
        ],
        "controller_urls": [
            "http://10.0.0.20:6866",
            {"url": "https://wan.example.com",
             "auth": {"type": "basic", "username": "luo", "password": ""}},
        ],
    }})
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert "Matrix 第 1 个地址" in detail
    assert "newuser" in detail
    assert "Controller" not in detail
    # 整单拒 → 落盘仍为前置态：controller 密码 p0、matrix 未保存
    cfg = config_mod.load_config()
    assert cfg["controller_urls"][1]["auth"]["password"] == "p0"
    assert (cfg.get("matrix_homeservers") or []) == []
