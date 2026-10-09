# -*- coding: utf-8 -*-
"""凭证持久化加固——持久化语义回归钉死。

覆盖：
- address_mode 往返（wan 持久 / 无效值降级 auto / 空串不动）
- controller_urls 地址 + Basic 凭据往返（空串 / *** 继承语义）
- 落盘后文件权限 600（posix 守卫）
- save 后无 .json.tmp 残留（原子写）

隔离：monkeypatch config 模块的 _CONFIG_PATH/_CONFIG_DIR/_SECRET_DIR 到
tmp_path，不碰真实 secret 目录。
"""

import os

import pytest

from agentteams_connector import config as config_mod


@pytest.fixture()
def tmp_config(monkeypatch, tmp_path):
    """配置文件/目录隔离到 tmp_path（真实 secret 目录零接触）。"""
    cfg_dir = tmp_path / "agentteams-qwenpaw-workbench"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    # 实况核对：_ensure_dir 用的目录变量是 _CONFIG_DIR（非任务书所写
    # _SECRET_DIR）——两者都 patch，按实况隔离。
    monkeypatch.setattr(config_mod, "_SECRET_DIR", tmp_path)
    monkeypatch.setattr(config_mod, "_CONFIG_DIR", cfg_dir)
    monkeypatch.setattr(config_mod, "_CONFIG_PATH", cfg_dir / "config.json")
    yield cfg_dir / "config.json"


# ── address_mode 往返 ─────────────────────────────────────────────────────


def test_address_mode_roundtrip(tmp_config):
    config_mod.update_config({"address_mode": "wan"})
    assert config_mod.load_config()["address_mode"] == "wan"

    # 无效值降级 auto（14.1 既有语义）。
    config_mod.update_config({"address_mode": "bogus"})
    assert config_mod.load_config()["address_mode"] == "auto"

    # 空串 = no-op（当前值不变）。
    # 实况说明：任务书第 3 步写「保持 wan」，但与第 2 步状态矛盾
    # （bogus 已把当前值降为 auto）；代码语义 = 空串不动当前值，
    # 故此处钉 auto。wan 场景下的空串 no-op 见下方专项测试。
    config_mod.update_config({"address_mode": ""})
    assert config_mod.load_config()["address_mode"] == "auto"


def test_address_mode_empty_string_noop_on_wan(tmp_config):
    """空串不动当前值——wan 场景（任务书「保持 wan 不变」意图的专项钉死）。"""
    config_mod.update_config({"address_mode": "wan"})
    config_mod.update_config({"address_mode": ""})
    assert config_mod.load_config()["address_mode"] == "wan"


# ── controller_urls + Basic 凭据往返（继承语义）──────────────────────────


def _wan_patch(password: str):
    return {
        "controller_urls": [
            "http://10.0.0.1:6866",
            {
                "url": "https://wan.example:7113",
                "auth": {"type": "basic", "username": "testuser", "password": password},
            },
        ]
    }


def test_address_auth_roundtrip(tmp_config):
    config_mod.update_config(_wan_patch("secret123"))
    urls = config_mod.load_config()["controller_urls"]
    assert urls[1]["auth"]["password"] == "secret123"

    # 同结构再次提交、password 空串 → 继承保留旧值。
    config_mod.update_config(_wan_patch(""))
    assert config_mod.load_config()["controller_urls"][1]["auth"]["password"] == "secret123"

    # 脱敏占位符 *** → 同样保留。
    config_mod.update_config(_wan_patch("***"))
    assert config_mod.load_config()["controller_urls"][1]["auth"]["password"] == "secret123"


# ── 落盘权限（安全实锤修复的回归钉死）────────────────────────────────────


@pytest.mark.skipif(os.name != "posix", reason="权限位检查仅 posix 可验证")
def test_config_file_perms_600(tmp_config):
    config_mod.update_config({"address_mode": "wan"})
    mode = os.stat(tmp_config).st_mode & 0o777
    assert mode == 0o600


# ── 原子写无残留 ─────────────────────────────────────────────────────────


def test_save_config_atomic_tmp(tmp_config):
    config_mod.update_config({"address_mode": "wan"})
    tmp_file = tmp_config.with_suffix(".json.tmp")
    assert not tmp_file.exists()
