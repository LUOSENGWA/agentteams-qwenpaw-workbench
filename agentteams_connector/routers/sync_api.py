# -*- coding: utf-8 -*-
"""工作区文件镜像同步域（手动触发 + 状态 + 范围配置 + 取消同步 + 进度）。

设计依据：方案与设计/AgentTeams/下版本1.2.6-1.2.7/文件同步-工作区镜像设计-20261107.md §5/§7。
- ``GET  /agentteams-proxy/sync/state``    → 引擎状态（generation/files/
  conflicts/lastRunAt/lastError/locked）+ root/human。
- ``POST /agentteams-proxy/sync/run``      → 立即跑一轮（asyncio.to_thread
  不阻塞事件循环；单写者锁被占时诚实返回 ``{"locked": true}``）。
- ``GET  /agentteams-proxy/sync/config``   → S1 同步范围配置（整份 + 当前
  human 生效值）。
- ``PUT  /agentteams-proxy/sync/config``   → S1 写范围（pattern 校验：
  必须 ``files/`` 开头、禁 ``..``/空段，非法 → 400）。
- ``POST /agentteams-proxy/sync/unsync``   → S2 取消同步（只删本地镜像、
  远端零调用零 DELETE；证据不足 remote_missing 拒绝）。
- ``GET  /agentteams-proxy/sync/progress`` → S6 进度快照（无统计 →
  ``state: "idle"``）。

引擎经 ``file_sync_engine.ensure_engine()`` 惰性取——startup hook
（agentteams-file-sync）正常会先建好；惰性建仅为容错（hook 未跑 /
单测直调本域）。handler 内惰性 import，与 routers 包其余域同款，
避免与 router 模块的循环导入。
"""
from __future__ import annotations

import asyncio

from typing import Any, Dict

from fastapi import APIRouter, HTTPException


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

    @router.get("/sync/config")
    async def sync_config() -> Dict[str, Any]:
        """S1 范围读：整份配置 + 当前 human 生效值（缺省项已补齐）。"""
        from .. import file_sync_engine

        eng = file_sync_engine.ensure_engine()
        cfg = eng.load_config()
        return {
            "humans": cfg.get("humans") or {},
            "human": eng.human,
            "effective": file_sync_engine.human_cfg(cfg, eng.human),
        }

    @router.put("/sync/config")
    async def sync_config_put(body: Dict[str, Any]) -> Dict[str, Any]:
        """S1 范围写：per-human include/exclude。

        校验（逐 pattern）：非空、无 ``..``/空段、必须 ``files/`` 开头
        ——非法 → 400 ``{"error": "invalid_path", "path": ...}``，且
        不落盘（先校验后写）。include 缺省/空 = ``["files/**"]``。
        """
        from .. import file_sync_engine

        body = body or {}
        eng = file_sync_engine.ensure_engine()
        human = str(body.get("human") or eng.human).strip()
        if not human:
            raise HTTPException(status_code=400, detail={"error": "invalid_body"})
        new_hc: Dict[str, Any] = {}
        for key in ("include", "exclude"):
            if key not in body:
                continue
            v = body.get(key)
            if v is None:
                new_hc[key] = []
                continue
            if not isinstance(v, list):
                raise HTTPException(
                    status_code=400, detail={"error": "invalid_body", "key": key}
                )
            out = []
            for p in v:
                ok = file_sync_engine.validate_sync_pattern(p)
                if ok is None:
                    raise HTTPException(
                        status_code=400,
                        detail={"error": "invalid_path", "path": str(p)},
                    )
                out.append(ok)
            new_hc[key] = out
        cfg = eng.load_config()
        entry = cfg.setdefault("humans", {}).setdefault(human, {})
        entry.update(new_hc)
        eng.save_config(cfg)
        return {"ok": True, "human": human, "humans": cfg.get("humans") or {}}

    @router.post("/sync/unsync")
    async def sync_unsync(body: Dict[str, Any]) -> Dict[str, Any]:
        """S2 取消同步：删本地镜像（目录递归），**远端零调用零 DELETE**。

        body ``{"human"?, "paths": [...], "force"?}``。远端证据
        （GET …/files?recursive=1，旧控制器降级普通列表）不足 →
        ``remote_missing`` 拒绝（force 不放行）；etag/size 不一致 →
        ``etag_mismatch``/``size_mismatch`` 拒绝（force 可绕过）。
        返回 ``{"removed": [...], "refused": [{"path", "refused"}]}``。
        """
        from .. import file_sync_engine

        body = body or {}
        paths = body.get("paths")
        if not isinstance(paths, list) or not paths:
            raise HTTPException(status_code=400, detail={"error": "invalid_body"})
        eng = file_sync_engine.ensure_engine()
        return await asyncio.to_thread(
            eng.unsync, paths, human=body.get("human"), force=bool(body.get("force"))
        )

    @router.get("/sync/progress")
    async def sync_progress() -> Dict[str, Any]:
        """S6 进度快照（state/files_*/bytes_*/speed_bps/eta_sec/…；
        无统计 → ``state: "idle"`` 零值形）。"""
        from .. import file_sync_engine

        eng = file_sync_engine.ensure_engine()
        return eng.progress()

    return router
