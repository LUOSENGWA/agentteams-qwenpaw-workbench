# -*- coding: utf-8 -*-
"""AgentTeams QwenPaw Workbench backend package."""

import json as _json
from pathlib import Path as _Path

# 版本单一真相源 = 插件根目录的 plugin.json（打包/安装即生效）。
# 历史坑：此处曾硬编码版本，发版只改 plugin.json → /health 与界面标题长期
# 停在旧版本（16.95），而安装版本已经 16.107。现在运行时读取，缺失才回退。
_FALLBACK_VERSION = "0.0.0-unknown"


def _plugin_version() -> str:
    try:
        p = _Path(__file__).resolve().parent.parent / "plugin.json"
        v = _json.loads(p.read_text(encoding="utf-8")).get("version")
        return str(v) if v else _FALLBACK_VERSION
    except Exception:  # noqa: BLE001 - 版本读不到不应影响后端启动
        return _FALLBACK_VERSION


__version__ = _plugin_version()
