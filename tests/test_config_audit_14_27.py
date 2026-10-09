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


def test_update_config_refused_when_file_corrupt(tmp_config):
    """主文件损坏且无备份（14.30: state=read-error）→ update_config
  拒绝（IOError）——保留损坏现场，不拿默认值盖掉它；恢复走 import。
  （14.27 原语义=skip 落盘仍返回内存态；14.30 收紧为拒绝：read-error
  下内存基线不可信，连「本次请求可用」都不给。）"""
    tmp_config.write_text("{corrupt!!", encoding="utf-8")
    config_mod.load_config()  # → read-error（14.30 细分）
    assert config_mod._last_load_state == "read-error"
    with pytest.raises(IOError):
        config_mod.update_config(
            {"address_mode": "wan", "admin_password": "x"}, source="test"
        )
    assert tmp_config.read_text(encoding="utf-8") == "{corrupt!!"


def test_update_config_first_write_fresh_install(tmp_config):
    """全新安装（文件不存在，14.30: state=fresh）→ update_config 正常
  首写（回归锁：防呆守卫不得误伤首装——否则用户第一次保存静默丢失）。"""
    config_mod.load_config()  # 文件不存在 → fresh（14.30 细分）
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
    """fresh（无文件）后首写落盘（用户重存/导入）→ 后续补丁正常可写。"""
    config_mod.load_config()
    assert config_mod._last_load_state == "fresh"
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


def test_put_config_without_rev_409_when_file_exists(client, tmp_config):
    """无 config_rev + 磁盘有文件 → 409（14.30 废除「不传 rev=跳过」
    向后兼容——那是 10/8 wipe 的放行后门：默认表单/脚本/旧标签页
    拿不到 rev 也能直接盖盘。首启（无文件）不受影响，见 14_30 测试。"""
    config_mod.save_config({"address_mode": "lan"}, source="seed")
    config_mod.save_config({"address_mode": "auto"}, source="external")
    r = client.put(
        "/config",
        json={"config": {"address_mode": "wan"}},
    )
    assert r.status_code == 409
    on_disk = json.loads(tmp_config.read_text(encoding="utf-8"))
    assert on_disk["address_mode"] == "auto", "无 rev 保存被拒，磁盘保持原值"


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


def test_get_config_health_fresh_on_first_boot(client):
    """主文件从未存在（全新首启）→ 200 + health.state=fresh（合法
    初始态，表单可填可存；14.30 从 defaults-fallback 细分出来——
    首启流程不得被 read-error 的 503/拒保存误伤）。"""
    out = client.get("/config").json()
    assert out["config_health"]["state"] == "fresh"
    assert out["config_health"]["mtime"] == 0


def test_update_config_force_persist_not_exempt_on_read_error(tmp_config):
    """14.30 语义收紧：read-error（文件在但读失败）下 force_persist
    不再豁免——「显式恢复」的语义是重建缺失文件，而 read-error 的
    文件很可能完好，拿默认值盖=10/8 wipe 链的最后一步。损坏文件
    的恢复通道=POST /config/import（用户显式粘贴，带备份回滚点）。"""
    tmp_config.write_text("{corrupt!!", encoding="utf-8")
    config_mod.load_config()
    assert config_mod._last_load_state == "read-error"
    with pytest.raises(IOError):
        config_mod.update_config(
            {"address_mode": "wan", "admin_password": "recovered"},
            source="explicit-recovery",
            force_persist=True,
        )
    assert tmp_config.read_text(encoding="utf-8") == "{corrupt!!"


def test_put_config_force_persist_409_then_import_recovers(client, tmp_config):
    """14.30 端到端：read-error 下 GET=503、PUT（含 force_persist）=409，
    恢复走 import（用户显式粘贴完整配置）→ 落盘 → health 回 ok。"""
    tmp_config.write_text("{corrupt!!", encoding="utf-8")
    config_mod.load_config()
    assert client.get("/config").status_code == 503
    r = client.put(
        "/config",
        json={
            "config": {"address_mode": "wan", "admin_password": "recovered"},
            "force_persist": True,
        },
    )
    assert r.status_code == 409
    # 恢复通道=import（绕过 update_config 守卫，自带备份回滚点）。
    r2 = client.post(
        "/config/import",
        json={
            "address_mode": "wan",
            "admin_password": "recovered",
            "controller_urls": [],
        },
    )
    assert r2.status_code == 200
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
