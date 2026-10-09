# -*- coding: utf-8 -*-
"""：写盘审计 + 防呆 + 并发保护。

背景：config.json 的 address_mode 曾在无人操作的情况下 lan→auto
被改写，且全部写路径零日志——难查的真因是写发生时无从取证。本批：
1. save_config 记审计环（source + 关键字段形态 diff，秘密值不入日志）；
2. update_config 在 defaults-fallback 态（主文件缺失/损坏且无备份）
   拒绝落盘——堵住「表单默认值静默覆盖全配置」；
3. PUT /config 乐观锁（config_rev 对不上 → 409，旧前端不传=跳过）；
4. GET /config 暴露 config_rev + config_health（加载态可被 UI 显形）。

隔离：config 模块重定向 tmp_path；后台探测 monkeypatch 假 no-op
（沿用 14.12 config 测试模式，不碰真实 secret 目录与真实网络）。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from agentteams_connector import config as config_mod
from agentteams_connector import selfcheck as selfcheck_mod
from agentteams_connector.router import build_router


@pytest.fixture()
def tmp_config(monkeypatch, tmp_path):
    """配置文件/目录隔离到 tmp_path（真实 secret 目录零接触）。"""
    cfg_dir = tmp_path / "agentteams-qwenpaw-workbench"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(config_mod, "_SECRET_DIR", tmp_path)
    monkeypatch.setattr(config_mod, "_CONFIG_DIR", cfg_dir)
    monkeypatch.setattr(config_mod, "_CONFIG_PATH", cfg_dir / "config.json")
    # 每测重置审计环与加载态（模块级，防测试间互污）。
    config_mod._CONFIG_WRITE_AUDIT.clear()
    config_mod._last_load_state = "unknown"
    yield cfg_dir / "config.json"


@pytest.fixture()
def client(monkeypatch, tmp_path):
    """TestClient + config 重定向 tmp + 后台探测假 no-op。"""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    cfg_dir = tmp_path / "agentteams-qwenpaw-workbench"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(config_mod, "_SECRET_DIR", tmp_path)
    monkeypatch.setattr(config_mod, "_CONFIG_DIR", cfg_dir)
    monkeypatch.setattr(config_mod, "_CONFIG_PATH", cfg_dir / "config.json")
    config_mod._CONFIG_WRITE_AUDIT.clear()
    config_mod._last_load_state = "unknown"

    async def noop_probe(cfg, kinds=("matrix", "controller")):
        return {}

    monkeypatch.setattr(selfcheck_mod, "refresh_effective", noop_probe)

    app = FastAPI()
    app.include_router(build_router())
    return TestClient(app)


# ── 1) 写盘审计 ─────────────────────────────────────────────────────────


def test_save_config_records_audit_with_source(tmp_config):
    """每次真实写盘入审计环：source 可查、签名 diff 正确、秘密值不入环。"""
    config_mod.save_config(
        {
            "address_mode": "lan",
            "admin_username": "u1",
            "admin_password": "SECRET-PWD",
            "matrix": {"access_token": "SECRET-TOK"},
        },
        source="PUT /config",
    )
    audit = list(config_mod._CONFIG_WRITE_AUDIT)
    assert len(audit) == 1
    assert audit[0]["source"] == "PUT /config"
    assert audit[0]["after"]["mode"] == "lan"
    assert audit[0]["after"]["admin_user"] is True
    assert audit[0]["before"]["mode"] is None  # 写前文件不存在
    # 秘密值永不入审计。
    assert "SECRET-PWD" not in json.dumps(audit[0])
    assert "SECRET-TOK" not in json.dumps(audit[0])


def test_save_config_audit_changed_keys(tmp_config):
    """二次写盘：changed = 签名差异键（只记形态变化，值变化=changed 空）。"""
    base = {"address_mode": "lan", "admin_password": "p1"}
    config_mod.save_config(base, source="t1")
    config_mod.save_config({"address_mode": "wan", "admin_password": "p2"}, source="t2")
    second = list(config_mod._CONFIG_WRITE_AUDIT)[1]
    assert second["changed"] == ["mode"]
    assert second["before"]["mode"] == "lan"
    assert second["after"]["mode"] == "wan"
    # admin_password 值变了但有无不变（都有）→ 不进 changed。
    assert "admin_pass" not in second["changed"]


def test_save_config_audit_ring_capped(tmp_config):
    """审计环 maxlen=20——超过只留最近 20 条。"""
    for i in range(25):
        config_mod.save_config({"address_mode": "lan"}, source=f"s{i}")
    audit = list(config_mod._CONFIG_WRITE_AUDIT)
    assert len(audit) == 20
    assert audit[0]["source"] == "s5"
    assert audit[-1]["source"] == "s24"


def test_self_heal_restore_records_audit(tmp_config):
    """自愈恢复（主文件损坏→从备份写回）也入审计环（source=self-heal）。"""
    config_mod.save_config({"address_mode": "wan"}, source="seed")
    config_mod.save_config({"address_mode": "lan"}, source="latest")
    tmp_config.write_text("{corrupt", encoding="utf-8")
    config_mod.load_config()  # 触发自愈（备份=latest）
    on_disk = json.loads(tmp_config.read_text(encoding="utf-8"))
    assert on_disk["address_mode"] == "lan"
    audit = list(config_mod._CONFIG_WRITE_AUDIT)
    assert any(a["source"].startswith("self-heal") for a in audit)


# ── 2) defaults-fallback 防呆 ───────────────────────────────────────────


def test_update_config_skips_persist_when_file_corrupt(tmp_config):
    """主文件损坏且无备份 → update_config 不落盘（保留损坏现场，
  不拿全默认值盖掉它——UI 健康横幅显形，用户走导入/重存恢复）。"""
    tmp_config.write_text("{corrupt!!", encoding="utf-8")
    config_mod.load_config()  # → defaults-fallback（无备份）
    assert config_mod._last_load_state == "defaults-fallback"
    merged = config_mod.update_config(
        {"address_mode": "wan", "admin_password": "x"}, source="test"
    )
    assert merged["address_mode"] == "wan"  # 内存态本次请求可用
    assert tmp_config.read_text(encoding="utf-8") == "{corrupt!!"


def test_update_config_first_write_fresh_install(tmp_config):
    """全新安装（文件不存在）→ update_config 正常首写（回归锁：
  防呆守卫不得误伤首装——否则用户第一次保存静默丢失）。"""
    config_mod.load_config()  # 文件不存在 → defaults-fallback
    config_mod.update_config({"address_mode": "wan"}, source="first-save")
    assert tmp_config.exists(), "首装必须落盘"
    on_disk = json.loads(tmp_config.read_text(encoding="utf-8"))
    assert on_disk["address_mode"] == "wan"


def test_update_config_persists_when_file_ok(tmp_config):
    """文件存在且合法（state=ok）→ update_config 正常落盘（回归锁）。"""
    config_mod.save_config({"address_mode": "auto"}, source="seed")
    config_mod.load_config()
    assert config_mod._last_load_state == "ok"
    config_mod.update_config({"address_mode": "wan"}, source="test")
    on_disk = json.loads(tmp_config.read_text(encoding="utf-8"))
    assert on_disk["address_mode"] == "wan"


def test_update_config_persists_after_recovery(tmp_config):
    """defaults-fallback 后主文件恢复（用户重存/导入）→ 补丁重新可写。"""
    config_mod.load_config()
    assert config_mod._last_load_state == "defaults-fallback"
    config_mod.save_config({"address_mode": "auto"}, source="user-resave")
    config_mod.load_config()
    assert config_mod._last_load_state == "ok"
    config_mod.update_config({"console_session": "s1"}, source="test")
    on_disk = json.loads(tmp_config.read_text(encoding="utf-8"))
    assert on_disk["console_session"] == "s1"


# ── 3) PUT /config 乐观锁（config_rev）─────────────────────────────────


def test_put_config_stale_rev_returns_409(client, tmp_config):
    """页面加载后磁盘配置被外部改动 → 旧 rev 保存 409（不覆盖）。"""
    config_mod.save_config({"address_mode": "lan"}, source="seed")
    r1 = client.get("/config")
    rev = r1.json()["config_rev"]
    assert rev is not None
    # 外部改动（模拟另一 tab/手工编辑）。
    config_mod.save_config({"address_mode": "auto"}, source="external")
    r2 = client.put(
        "/config",
        json={"config": {"address_mode": "wan"}, "config_rev": rev},
    )
    assert r2.status_code == 409
    on_disk = json.loads(tmp_config.read_text(encoding="utf-8"))
    assert on_disk["address_mode"] == "auto", "409 后磁盘保持外部新值"


def test_put_config_matching_rev_succeeds(client, tmp_config):
    """rev 对得上 → 正常保存（含 address_mode 变更落盘）。"""
    config_mod.save_config({"address_mode": "lan"}, source="seed")
    rev = client.get("/config").json()["config_rev"]
    r = client.put(
        "/config",
        json={"config": {"address_mode": "wan"}, "config_rev": rev},
    )
    assert r.status_code == 200
    on_disk = json.loads(tmp_config.read_text(encoding="utf-8"))
    assert on_disk["address_mode"] == "wan"


def test_put_config_without_rev_backward_compat(client, tmp_config):
    """旧前端不传 config_rev → 跳过校验（向后兼容，正常保存）。"""
    config_mod.save_config({"address_mode": "lan"}, source="seed")
    config_mod.save_config({"address_mode": "auto"}, source="external")
    r = client.put(
        "/config",
        json={"config": {"address_mode": "wan"}},
    )
    assert r.status_code == 200
    on_disk = json.loads(tmp_config.read_text(encoding="utf-8"))
    assert on_disk["address_mode"] == "wan"


# ── 4) GET /config 暴露 rev + health ───────────────────────────────────


def test_get_config_exposes_rev_and_health_ok(client, tmp_config):
    """文件正常：config_rev 非空 + config_health.state=ok + 原有诊断字段保留。"""
    config_mod.save_config({"address_mode": "lan"}, source="seed")
    out = client.get("/config").json()
    assert out["config_rev"] is not None
    assert out["config_health"]["state"] == "ok"
    assert out["config_health"]["writable"] is True
    assert out["configPath"] == str(tmp_config)
    assert out["configSavedAt"] > 0


def test_get_config_health_defaults_fallback(client):
    """主文件缺失且无备份 → health.state=defaults-fallback（UI 显形依据）。"""
    out = client.get("/config").json()
    assert out["config_health"]["state"] == "defaults-fallback"
    assert out["config_health"]["mtime"] == 0


def test_update_config_force_persist_recovers_corrupt_file(tmp_config):
    """损坏态下 force_persist=True（健康横幅警示下的显式恢复）→
  放行守卫落盘（重建文件）；不带 force 仍被拦（双路径锁）。"""
    tmp_config.write_text("{corrupt!!", encoding="utf-8")
    config_mod.load_config()
    assert config_mod._last_load_state == "defaults-fallback"
    config_mod.update_config({"address_mode": "wan"}, source="t")
    assert tmp_config.read_text(encoding="utf-8") == "{corrupt!!"
    config_mod.load_config()  # 刷新加载态
    config_mod.update_config(
        {"address_mode": "wan", "admin_password": "recovered"},
        source="explicit-recovery",
        force_persist=True,
    )
    on_disk = json.loads(tmp_config.read_text(encoding="utf-8"))
    assert on_disk["address_mode"] == "wan"
    assert on_disk["admin_password"] == "recovered"


def test_put_config_force_persist_endpoint(client, tmp_config):
    """PUT /config force_persist=true 显式恢复路径（端到端）。"""
    tmp_config.write_text("{corrupt!!", encoding="utf-8")
    config_mod.load_config()
    out = client.get("/config").json()
    assert out["config_health"]["state"] == "defaults-fallback"
    r = client.put(
        "/config",
        json={
            "config": {"address_mode": "wan", "admin_password": "recovered"},
            "force_persist": True,
        },
    )
    assert r.status_code == 200
    on_disk = json.loads(tmp_config.read_text(encoding="utf-8"))
    assert on_disk["address_mode"] == "wan"
    assert on_disk["admin_password"] == "recovered"
    # 恢复后健康态回到 ok，后续普通写不再被拦。
    out = client.get("/config").json()
    assert out["config_health"]["state"] == "ok"


def test_get_config_exposes_write_audit(client, tmp_config):
    """GET /config 返回 write_audit（最近写盘审计——「谁改了配置」
  当场可查）：空环=空列表；写一次后条目含 source，秘密值不出现。"""
    assert client.get("/config").json()["write_audit"] == []
    config_mod.save_config(
        {"address_mode": "lan", "admin_password": "TOP-SECRET"},
        source="PUT /config",
    )
    audit = client.get("/config").json()["write_audit"]
    assert len(audit) == 1
    assert audit[0]["source"] == "PUT /config"
    assert audit[0]["after"]["mode"] == "lan"
    body = client.get("/config").text
    assert "TOP-SECRET" not in body, "秘密值不得经 GET /config 外泄"
