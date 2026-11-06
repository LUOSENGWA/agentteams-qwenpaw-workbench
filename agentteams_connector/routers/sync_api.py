# -*- coding: utf-8 -*-
"""工作区文件镜像同步域（手动触发 + 状态）。

设计依据：方案与设计/AgentTeams/下版本1.2.6-1.2.7/文件同步-工作区镜像设计-20261107.md §5/§7。
- ``GET  /agentteams-proxy/sync/state`` → 引擎状态（generation/files/
  conflicts/lastRunAt/lastError/locked）+ root/human。
- ``POST /agentteams-proxy/sync/run``   → 立即跑一轮（asyncio.to_thread
  不阻塞事件循环；单写者锁被占时诚实返回 ``{"locked": true}``）。

引擎经 ``file_sync_engine.ensure_engine()`` 惰性取——startup hook
（agentteams-file-sync）正常会先建好；惰性建仅为容错（hook 未跑 /
单测直调本域）。handler 内惰性 import，与 routers 包其余域同款，
避免与 router 模块的循环导入。
"""
from __future__ import annotations

import asyncio

from typing import Any, Dict

from fastapi import APIRouter


def build_sync_router() -> APIRouter:
    router = APIRouter()

    @router.get("/sync/state")
    async def sync_state() -> Dict[str, Any]:
        """同步状态（设计 §7 可观测面 + 镜像根/human 供 UI 展示）。"""
        from .. import file_sync_engine

        eng = file_sync_engine.ensure_engine()
        return {**eng.state(), "root": str(eng.root), "human": eng.human}

    @router.post("/sync/run")
    async def sync_run() -> Dict[str, Any]:
        """手动触发一轮同步（UI「立即同步」按钮）。

        与后台定时循环互斥由引擎内 .sync/lock 保证（O_EXCL 单写者）——
        后台轮跑中时本端点返回 locked，前端提示「同步进行中」。
        """
        from .. import file_sync_engine

        eng = file_sync_engine.ensure_engine()
        return await asyncio.to_thread(eng.run_once)

    return router
