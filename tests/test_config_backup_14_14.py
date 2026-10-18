# -*- coding: utf-8 -*-
"""配置持久化硬化 + 导出/导入。

覆盖：
1. save_config 自动写备份：保存成功后 config.bak.json 与主文件内容一致；
 备份写失败不拖累主文件保存（仅告警，备份保持旧值）。
2. load_config 自愈：主文件缺失 / 损坏（坏 JSON、顶层非对象）→ 自动从备份
 恢复（主文件重建 = 备份内容）；无备份 / 备份也坏 / 备份非对象 → 默认值
 （不抛异常）。
3. GET /config/export 返回完整配置（真实凭据值）——GET /config 仍脱敏
 （两通道互不串扰）。
4. POST /config/import：
 - schema 校验失败 → 400 可读错误（零落盘，现有配置不动）；
 - 脱敏占位符 "***" → 400 拒收（防误贴脱敏导出顶掉真实凭据）；
 - 成功 → 主文件 = 导入值、备份 = 覆盖前状态（回滚点）、响应 config 脱敏；
 - Matrix 身份变更 → 同步自动重启（restart="none"），同身份 restart="page"。

隔离：config 路径 monkeypatch 到 tmp_path 全程——真实 secret 目录零接触，
不遗留脏值（任务书验收要求）。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

from agentteams_connector import config as config_mod
from agentteams_connector import selfcheck as selfcheck_mod
from agentteams_connector import sync_watcher as sync_watcher_mod
from agentteams_connector.router import build_router

# 完整备份门密码（P0 门控）——export/import 测试须先设密码 + 带头。
EXPORT_PW = "test-export-pw-123"
EXPORT_HDR = {"X-Export-Password": EXPORT_PW}

# 身份变更测试断言 sync_watcher.restart 调用（fixture 假实现追加）。
_restart_calls: List[str] = []


@pytest.fixture()
def tmp_config(monkeypatch, tmp_path):
    """配置文件/目录隔离到 tmp_path（真实 secret 目录零接触）。"""
    cfg_dir = tmp_path / "agentteams-qwenpaw-workbench"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(config_mod, "_SECRET_DIR", tmp_path)
    monkeypatch.setattr(config_mod, "_CONFIG_DIR", cfg_dir)
    monkeypatch.setattr(config_mod, "_CONFIG_PATH", cfg_dir / "config.json")
    yield cfg_dir / "config.json"


@pytest.fixture()
def client(monkeypatch, tmp_path):
    """TestClient + config 重定向 tmp + 后台探测/同步重启假 no-op。"""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    cfg_dir = tmp_path / "agentteams-qwenpaw-workbench"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(config_mod, "_SECRET_DIR", tmp_path)
    monkeypatch.setattr(config_mod, "_CONFIG_DIR", cfg_dir)
    monkeypatch.setattr(config_mod, "_CONFIG_PATH", cfg_dir / "config.json")

    async def noop_probe(cfg, kinds=("matrix", "controller")):
        return {}

    monkeypatch.setattr(selfcheck_mod, "refresh_effective", noop_probe)

    _restart_calls.clear()

    async def fake_restart(reason: str = "") -> None:
        _restart_calls.append(reason)

    monkeypatch.setattr(sync_watcher_mod, "restart", fake_restart)

    app = FastAPI()
    app.include_router(build_router())
    return TestClient(app)


# ── 1) save_config 自动写备份 ─────────────────────────────────────────────


def test_save_writes_backup_with_same_content(tmp_config):
    """保存成功 → config.bak.json 存在且内容 = 主文件（含明文凭据）。"""
    config_mod.update_config({"controller_token": "tok-123", "address_mode": "lan"})
    bak = config_mod._config_bak_path()
    assert bak.exists()
    assert bak.name == "config.bak.json"
    bak_disk = json.loads(bak.read_text(encoding="utf-8"))
    main_disk = json.loads(tmp_config.read_text(encoding="utf-8"))
    assert bak_disk == main_disk
    assert bak_disk["controller_token"] == "tok-123"
    assert bak_disk["address_mode"] == "lan"


def test_backup_write_failure_does_not_fail_save(tmp_config, monkeypatch):
    """备份写失败 → 主文件保存照常成功（仅告警）；备份保持上一次值。"""
    config_mod.update_config({"address_mode": "lan"})  # 先建立主文件 + 旧备份

    real_write = config_mod._atomic_write_config

    def poisoned(path: Path, data: Dict[str, Any]) -> None:
        if path == config_mod._config_bak_path():
            raise OSError("disk full (injected)")
        real_write(path, data)

    monkeypatch.setattr(config_mod, "_atomic_write_config", poisoned)
    config_mod.update_config({"address_mode": "wan"})  # 不抛 = 保存成功
    main_disk = json.loads(tmp_config.read_text(encoding="utf-8"))
    assert main_disk["address_mode"] == "wan"
    bak_disk = json.loads(config_mod._config_bak_path().read_text(encoding="utf-8"))
    assert bak_disk["address_mode"] == "lan"  # 备份保持旧值


# ── 2) load_config 备份自愈 ───────────────────────────────────────────────


def test_load_self_heals_missing_main(tmp_config):
    """主文件丢失 → 从备份恢复（返回值 + 主文件重建）。"""
    config_mod.update_config({"controller_token": "tok-heal", "address_mode": "lan"})
    tmp_config.unlink()
    cfg = config_mod.load_config()
    assert cfg["controller_token"] == "tok-heal"
    assert cfg["address_mode"] == "lan"
    assert tmp_config.exists()  # 主文件已重建
    rebuilt = json.loads(tmp_config.read_text(encoding="utf-8"))
    assert rebuilt["controller_token"] == "tok-heal"


def test_load_self_heals_corrupt_main(tmp_config):
    """主文件损坏（坏 JSON / 顶层非对象）→ 从备份恢复。"""
    config_mod.update_config({"controller_token": "tok-heal2"})
    bak_content = config_mod._config_bak_path().read_text(encoding="utf-8")

    tmp_config.write_text("{not valid json!!", encoding="utf-8")
    cfg = config_mod.load_config()
    assert cfg["controller_token"] == "tok-heal2"
    assert tmp_config.read_text(encoding="utf-8") == bak_content

    tmp_config.write_text("[1, 2, 3]", encoding="utf-8")  # 顶层非对象
    cfg2 = config_mod.load_config()
    assert cfg2["controller_token"] == "tok-heal2"


def test_load_no_backup_falls_back_to_defaults(tmp_config):
    """无备份 → 默认值（不抛）；备份也坏/非对象 → 默认值（不抛）。"""
    cfg = config_mod.load_config()  # 主文件不存在、无备份
    assert cfg["controller_token"] == ""
    assert cfg["address_mode"] == "auto"
    assert not tmp_config.exists()  # load 不凭空造主文件

    config_mod.update_config({"controller_token": "x"})
    tmp_config.write_text("corrupt", encoding="utf-8")
    bak = config_mod._config_bak_path()
    bak.write_text("also corrupt", encoding="utf-8")
    cfg2 = config_mod.load_config()
    assert cfg2["controller_token"] == ""

    bak.write_text("[1, 2]", encoding="utf-8")  # 备份非对象
    tmp_config.write_text("corrupt", encoding="utf-8")
    cfg3 = config_mod.load_config()
    assert cfg3["controller_token"] == ""


# ── 3) GET /config/export 完整 vs GET /config 脱敏 ────────────────────────


def test_export_full_config_while_get_config_stays_redacted(client):
    """导出含真实凭据值；GET /config 仍是 ***（两通道互不串扰）。"""
    tc = client
    with tc:
        config_mod.set_export_password(EXPORT_PW)
        config_mod.update_config(
            {
                "controller_token": "real-token-123",
                "admin_password": "real-pass",
                "matrix": {
                    "user_id": "@user1:example.com",
                    "access_token": "matrix-tok",
                    "device_id": "dev1",
                },
            }
        )
        r_exp = tc.get("/config/export", headers=EXPORT_HDR)
        r_cfg = tc.get("/config")
    assert r_exp.status_code == 200
    exp = r_exp.json()
    assert exp["controller_token"] == "real-token-123"
    assert exp["admin_password"] == "real-pass"
    assert exp["matrix"]["access_token"] == "matrix-tok"

    assert r_cfg.status_code == 200
    red = r_cfg.json()
    assert red["controller_token"] == "***"
    assert red["admin_password"] == "***"
    assert red["matrix"]["access_token"] == "***"


# ── 4) POST /config/import ────────────────────────────────────────────────


def test_import_validation_failures_400_and_zero_write(client):
    """schema 失败 → 400 可读错误；现有配置零改动。"""
    tc = client
    with tc:
        config_mod.set_export_password(EXPORT_PW)
        config_mod.update_config({"controller_token": "keep-me"})

        # 顶层非对象
        r1 = tc.post("/config/import", json=["a", "list"], headers=EXPORT_HDR)
        assert r1.status_code == 400
        assert "JSON 对象" in r1.json()["detail"]

        # 关键键类型错误
        r2 = tc.post(
            "/config/import",
            json={"matrix_homeservers": "http://x", "controller_token": "t"},
            headers=EXPORT_HDR,
        )
        assert r2.status_code == 400
        d2 = r2.json()["detail"]
        assert "matrix_homeservers" in d2
        assert "list" in d2

        # 无已知配置键（包裹结构）
        r3 = tc.post("/config/import", json={"foo": 1}, headers=EXPORT_HDR)
        assert r3.status_code == 400
        assert "未识别任何配置键" in r3.json()["detail"]

        # 脱敏占位符拒收
        r4 = tc.post(
            "/config/import",
            json={"controller_token": "***", "matrix_homeservers": []},
            headers=EXPORT_HDR,
        )
        assert r4.status_code == 400
        assert "***" in r4.json()["detail"]

        # 请求体非 JSON
        r5 = tc.post(
            "/config/import",
            content=b"not json",
            headers={**EXPORT_HDR, "Content-Type": "application/json"},
        )
        assert r5.status_code == 400

        # 全程零落盘
        assert config_mod.load_config()["controller_token"] == "keep-me"


def test_import_success_overwrites_and_keeps_pre_import_backup(client):
    """成功导入 → 主文件=导入值；备份=覆盖前状态（回滚点）；响应脱敏。"""
    tc = client
    with tc:
        config_mod.set_export_password(EXPORT_PW)
        config_mod.update_config(
            {
                "controller_token": "old-token",
                "matrix_homeservers": ["http://old-lan:6867"],
                "matrix": {
                    "user_id": "@old:hs",
                    "access_token": "old-matrix-tok",
                    "device_id": "old-dev",
                },
            }
        )
        r = tc.post(
            "/config/import",
            json={
                "controller_token": "new-token",
                "matrix_homeservers": ["http://new-lan:6867"],
                "matrix": {
                    "user_id": "@old:hs",
                    "access_token": "new-matrix-tok",
                    "device_id": "new-dev",
                },
            },
            headers=EXPORT_HDR,
        )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["restart"] == "page"  # 同身份 → 页面级
    assert body["config"]["controller_token"] == "***"  # 响应仍脱敏
    assert not _restart_calls  # 未触发同步重启

    main_disk = json.loads(config_mod._CONFIG_PATH.read_text(encoding="utf-8"))
    assert main_disk["controller_token"] == "new-token"
    assert main_disk["matrix"]["access_token"] == "new-matrix-tok"

    bak_disk = json.loads(config_mod._config_bak_path().read_text(encoding="utf-8"))
    assert bak_disk["controller_token"] == "old-token"
    assert bak_disk["matrix_homeservers"] == ["http://old-lan:6867"]
    assert bak_disk["matrix"]["access_token"] == "old-matrix-tok"


def test_import_wrapped_body_unwrapped(client):
    """{"config": {...}} 包裹（PUT 同形）→ 拆包后正常导入。"""
    tc = client
    with tc:
        config_mod.set_export_password(EXPORT_PW)
        r = tc.post(
            "/config/import",
            json={"config": {"address_mode": "wan", "controller_token": "w-tok"}},
            headers=EXPORT_HDR,
        )
    assert r.status_code == 200
    main_disk = json.loads(config_mod._CONFIG_PATH.read_text(encoding="utf-8"))
    assert main_disk["address_mode"] == "wan"
    assert main_disk["controller_token"] == "w-tok"


def test_import_identity_change_restarts_sync(client):
    """matrix.user_id 变更 → 同步自动重启（restart="none"）。"""
    tc = client
    with tc:
        config_mod.set_export_password(EXPORT_PW)
        config_mod.update_config(
            {
                "matrix": {
                    "user_id": "@a:hs",
                    "access_token": "t1",
                    "device_id": "d1",
                }
            }
        )
        r = tc.post(
            "/config/import",
            json={
                "matrix": {
                    "user_id": "@b:hs",
                    "access_token": "t2",
                    "device_id": "d2",
                }
            },
            headers=EXPORT_HDR,
        )
    assert r.status_code == 200
    assert r.json()["restart"] == "none"
    assert "config.import" in _restart_calls


# ── 5) 完整备份门密码（P0：宿主鉴权可关 + 8088 绑 0.0.0.0 → 防匿名 dump）──


def test_export_without_password_refused_secure_by_default(client):
    """未设门密码 → export/import 默认拒绝（403）——真正关掉洞，而非
  等用户补设。脱敏端点 /config 不受门影响（仍 200）。"""
    tc = client
    with tc:
        config_mod.update_config({"controller_token": "secret-1"})
        r_exp = tc.get("/config/export")
        r_imp = tc.post("/config/import", json={"controller_token": "x"})
        r_red = tc.get("/config")
    assert r_exp.status_code == 403
    assert "尚未设置" in r_exp.json()["detail"]
    assert r_imp.status_code == 403
    assert r_red.status_code == 200  # 脱敏展示面不被门拦


def test_export_wrong_password_refused(client):
    """设了密码但头错/空 → 403（不泄露是「未设」还是「错」之外的信息）。"""
    tc = client
    with tc:
        config_mod.set_export_password(EXPORT_PW)
        config_mod.update_config({"controller_token": "secret-1"})
        r_wrong = tc.get(
            "/config/export", headers={"X-Export-Password": "wrong-password-9"}
        )
        r_empty = tc.get("/config/export", headers={"X-Export-Password": ""})
        r_none = tc.get("/config/export")
    for r in (r_wrong, r_empty, r_none):
        assert r.status_code == 403


def test_export_password_endpoints_set_status_clear(client):
    """门密码端点：set（<8 位 400）→ status true → clear → status false。"""
    tc = client
    with tc:
        # 未设
        assert tc.get("/config/export-password-status").json() == {
            "has_password": False
        }
        # 过短 → 400
        r_short = tc.post(
            "/config/export-password", json={"password": "short"}
        )
        assert r_short.status_code == 400
        # 正常设置
        r_set = tc.post(
            "/config/export-password", json={"password": EXPORT_PW}
        )
        assert r_set.status_code == 200
        assert r_set.json()["has_password"] is True
        assert tc.get("/config/export-password-status").json() == {
            "has_password": True
        }
        # 设置后门控放行（正确头）
        r_ok = tc.get("/config/export", headers=EXPORT_HDR)
        assert r_ok.status_code == 200
        # 清除
        r_clr = tc.delete("/config/export-password")
        assert r_clr.status_code == 200
        assert r_clr.json()["has_password"] is False
        assert tc.get("/config/export-password-status").json() == {
            "has_password": False
        }
        # 清除后重新默认拒绝
        assert tc.get("/config/export").status_code == 403


def test_export_output_never_contains_password_material(client):
    """门密码只存哈希、且 hash 在独立文件（不在 config.json）→ 导出
  输出绝不含密码/哈希材料。"""
    tc = client
    with tc:
        config_mod.set_export_password(EXPORT_PW)
        config_mod.update_config({"controller_token": "secret-1"})
        exp = tc.get("/config/export", headers=EXPORT_HDR).json()
    key = json.loads(config_mod._export_key_path().read_text(encoding="utf-8"))
    # 导出体不含明文密码，也不含哈希/salt 材料
    assert EXPORT_PW not in json.dumps(exp, ensure_ascii=False)
    assert key["hash"] not in json.dumps(exp, ensure_ascii=False)
    assert key["salt"] not in json.dumps(exp, ensure_ascii=False)
    # 哈希文件本身不含明文
    raw = config_mod._export_key_path().read_text(encoding="utf-8")
    assert EXPORT_PW not in raw


def test_import_requires_password(client):
    """import（覆盖式恢复=高敏）同门控：无密码 403，正确密码 200。"""
    tc = client
    with tc:
        config_mod.set_export_password(EXPORT_PW)
        r_no = tc.post("/config/import", json={"controller_token": "x"})
        assert r_no.status_code == 403
        r_ok = tc.post(
            "/config/import",
            json={"controller_token": "imported-tok"},
            headers=EXPORT_HDR,
        )
    assert r_ok.status_code == 200
    assert config_mod.load_config()["controller_token"] == "imported-tok"
