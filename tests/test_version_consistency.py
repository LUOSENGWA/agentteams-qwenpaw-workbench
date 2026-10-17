# -*- coding: utf-8 -*-
"""版本三源一致性门（防 bump 漏同步——一次 bump 漏同步教训：
agentteams_connector/__init__.py 的 Python 版本常量在 release 时未随
plugin.json / frontend/package.json 同步，导致宿主日志与 /selfcheck
打印旧版本号，而安装目录与前端已是新版本）。

三源必须恒等：
- plugin.json（loader/安装目录的权威版本）
- frontend/package.json（vite 构建期注入前端的版本）
- agentteams_connector/__init__.py 的 __version__（后端日志/selfcheck）
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _py_version() -> str:
    import agentteams_connector

    return agentteams_connector.__version__


def test_three_version_sources_agree():
    plugin = json.loads((ROOT / "plugin.json").read_text(encoding="utf-8"))
    frontend = json.loads(
        (ROOT / "frontend" / "package.json").read_text(encoding="utf-8")
    )
    py = _py_version()

    trio = {
        "plugin.json": plugin.get("version"),
        "frontend/package.json": frontend.get("version"),
        "agentteams_connector.__version__": py,
    }
    assert len(set(trio.values())) == 1, f"version sources diverge: {trio}"
