# -*- coding: utf-8 -*-
"""v0.5.0-beta.14.22：kb/agents runtime 透传单一实现（_kb_apply_runtime_fields）单测。

背景（E2E 实锤）：本部署 Controller 的 Docker 通道对插件 token 不可用
（401/403/502）→ /kb/agents 全量走 ``_kb_agents_ctl_fallback``。D4 初版
只在主（Docker）路径内联透传 runtime/runtimeDeprecated → 兜底面 0 透传，
前端运行时提醒在真实环境全灭。收口：两路径共用模块级
``_kb_apply_runtime_fields`` 单一实现（消除双实现漂移温床），本文件锁死
该实现的透传口径：

1. runtime 非空 + runtimeDeprecated 真值 → 键存在且值正确；
2. 旧 controller（无字段）→ 键缺失（非 None，前端 undefined 放行）；
3. runtime 空串 / runtimeDeprecated=False → 不写键；
4. 非 dict 条目 / name 缺失 / 条目不在 found → 安全跳过不抛。
"""
from __future__ import annotations

from agentteams_connector.router import _kb_apply_runtime_fields


def _found(names):
    return {n: {"name": n, "kind": "worker"} for n in names}


def test_runtime_and_deprecated_written():
    """runtime 非空 + runtimeDeprecated 真值 → 两键透传。"""
    found = _found(["w-oc", "w-qw"])
    _kb_apply_runtime_fields(found, [
        {"name": "w-oc", "runtime": "openclaw", "runtimeDeprecated": True},
        {"name": "w-qw", "runtime": "qwenpaw", "runtimeDeprecated": False},
    ])
    assert found["w-oc"]["runtime"] == "openclaw"
    assert found["w-oc"]["runtimeDeprecated"] is True
    assert found["w-qw"]["runtime"] == "qwenpaw"
    assert "runtimeDeprecated" not in found["w-qw"]


def test_legacy_controller_no_keys():
    """旧 controller（无 runtime 字段）→ 键缺失，不是 None。"""
    found = _found(["w-old"])
    _kb_apply_runtime_fields(found, [
        {"name": "w-old", "team": "t", "role": "worker", "state": "stopped"},
    ])
    assert "runtime" not in found["w-old"]
    assert "runtimeDeprecated" not in found["w-old"]


def test_empty_runtime_and_false_deprecated_not_written():
    """runtime 空串 / runtimeDeprecated=False → 不写键（主路径同口径）。"""
    found = _found(["w-empty"])
    _kb_apply_runtime_fields(found, [
        {"name": "w-empty", "runtime": "", "runtimeDeprecated": False},
    ])
    assert "runtime" not in found["w-empty"]
    assert "runtimeDeprecated" not in found["w-empty"]


def test_malformed_entries_safe():
    """非 dict / name 缺失 / 条目不在 found → 跳过不抛。"""
    found = _found(["w1"])
    _kb_apply_runtime_fields(found, [
        None,
        "not-a-dict",
        {"runtime": "openclaw"},                    # 无 name
        {"name": "", "runtime": "openclaw"},        # name 空串
        {"name": "ghost", "runtime": "openclaw"},   # 不在 found
    ])
    assert "runtime" not in found["w1"]
