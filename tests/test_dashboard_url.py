# -*- coding: utf-8 -*-
"""dashboard_url 配置项回归（R3：Worker 详情「打开 Tracing」跳转目标）。

- 默认值为空（未配置 → 前端入口隐藏）；
- 落盘值 load 后保留（不漏进 defaults 合并）；
- update_config 支持设置/清空（空串=清空，与秘密字段的「空=不动」不同）；
- redact 不改写（非秘密，前端设置页需回显）。

隔离：conftest 的 _isolate_real_config 自动把主文件重定向到本测 tmp。
"""
from __future__ import annotations

from agentteams_connector import config as config_mod


def test_dashboard_url_default_is_empty() -> None:
    assert config_mod._DEFAULTS["dashboard_url"] == ""


def test_dashboard_url_load_preserves_persisted_value(tmp_path, monkeypatch) -> None:
    p = tmp_path / "config.json"
    monkeypatch.setattr(config_mod, "_CONFIG_PATH", p)
    p.write_text(
        '{"dashboard_url": "https://dash.example.com"}', encoding="utf-8"
    )
    assert config_mod.load_config()["dashboard_url"] == "https://dash.example.com"


def test_dashboard_url_update_roundtrip_and_clear() -> None:
    config_mod.update_config({"dashboard_url": "  https://dash.example.com/  "})
    assert config_mod.load_config()["dashboard_url"] == "https://dash.example.com/"

    # 空串=清空（入口重新隐藏）。
    config_mod.update_config({"dashboard_url": ""})
    assert config_mod.load_config()["dashboard_url"] == ""


def test_dashboard_url_non_string_patch_ignored() -> None:
    config_mod.update_config({"dashboard_url": "https://dash.example.com"})
    config_mod.update_config({"dashboard_url": 123})  # type: ignore[dict-item]
    assert config_mod.load_config()["dashboard_url"] == "https://dash.example.com"


def test_dashboard_url_survives_redact() -> None:
    cfg = config_mod.load_config()
    cfg["dashboard_url"] = "https://dash.example.com"
    out = config_mod.redact(cfg)
    assert out["dashboard_url"] == "https://dash.example.com"
