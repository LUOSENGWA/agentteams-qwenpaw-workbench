# -*- coding: utf-8 -*-
"""KB 域子路由装配（薄壳）。

路由注册与全部嵌套 helper 已移入 kb_handlers.py 的 build_kb_routes
工厂（原 build_kb_router 原体逐字搬入工厂函数）；纯数据通道 helper 在
kb_core.py，WSF 兜底通道在 kb_workspace.py，SWR 刷新/存储入口在
kb_refresh.py。本模块只把装配方 build_router 创建的 3 个可变状态接成
ctx 参数，并把返回的 SWR 计算体/轻探针注册入 router 模块级表
（调用时解析）。
"""
from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from .. import router as router_mod
from .kb_handlers import build_kb_routes


def build_kb_router(
        _kb_ws_cache: Dict[str, Dict[str, Any]],
        _kb_docker_ok_cache: Dict[str, tuple],
        _kb_inflight: Dict[str, Any],
    ) -> tuple:
    """KB 域子路由（状态由装配方创建并显式传入）。

    三个可变状态（_kb_ws_cache/_kb_docker_ok_cache/_kb_inflight）由装配方
    build_router 创建并显式传入；返回 (router, _kb_shared)，_kb_shared 携带
    与 approval 域共享的四个 helper。"""
    router = APIRouter()
    ctx = {
        "ws_cache": _kb_ws_cache,
        "docker_ok_cache": _kb_docker_ok_cache,
        "inflight": _kb_inflight,
    }
    prewarm_hooks, probe_hooks, _kb_shared = build_kb_routes(router, ctx)
    # SWR 计算体 + 刷新入口注册入模块级表（端点
    # 调用时解析 / 单测假注入 / 启动预热
    # _kb_prewarm_agent 均读本表）。
    router_mod._KB_PREWARM_HOOKS.update(prewarm_hooks)
    # 轻探针注册（SWR 刷新门变更检测用）。
    router_mod._KB_PROBE_HOOKS.update(probe_hooks)
    return router, _kb_shared
