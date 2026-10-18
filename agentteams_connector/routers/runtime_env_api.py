# -*- coding: utf-8 -*-
"""Worker 运行时环境（容器 PID 1 实际生效 env，只读）。

背景（15.27 反馈：「QwenPaw 运行时环境变量没有预填充」）——
Controller GET /workers/{name} 响应结构不暴露 env 键（detail keys
无 env；写路径 PUT env 可用），WorkerEnvPanel 的自定义变量区
因此读不到已保存值。本端点补「实际生效值」的读路径：

数据面 = Controller Docker API 代理 docker exec（与 upgrade 域同通道，
复用 upgrade_api 模块级 _exec），命令=固定常量（零注入面）：
  head -c 65536 /proc/1/environ | tr '\0' '\n' | sort
（environ NUL 分隔；64KB 上限远超实盘 55 条规模；sort=稳定展示序）。

语义：
- PID 1 env = 容器实际生效全集：Controller 从 llm*/spec 渲染的
  QWENPAW_* + 平台注入 AGENTTEAMS_* + 镜像内置 + spec.env 自定义变量
  ——「QwenPaw 运行时环境变量」的预填充正源。
- 脱敏：敏感键（TOKEN/SECRET/GATEWAY_KEY/PASSWORD/CREDENTIAL/API_KEY/
  AUTH）值默认掩码（前 4+…+后 4）；?reveal=1 返回明文（L1 门控在前，
  面板「显示」按钮显式请求）。
- 权限：L1 only（docker exec 需 Controller admin 鉴权）。
- 只读：本域零写路径。
"""
from __future__ import annotations

import re
import time
from typing import Any, Dict

from fastapi import APIRouter, HTTPException, Request

from .. import config as config_mod
from ..router import _token_or_none
from .upgrade_api import _exec

_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9\-]{0,62}$")
_SENSITIVE_RE = re.compile(
    r"(TOKEN|SECRET|GATEWAY_KEY|PASSWORD|PASSWD|CREDENTIAL|API_KEY|AUTH)",
    re.IGNORECASE)
_CMD = "head -c 65536 /proc/1/environ | tr '\\0' '\\n' | sort"


def _mask(value: str) -> str:
    if len(value) <= 8:
        return "•" * max(4, min(len(value), 12))
    return f"{value[:4]}…{value[-4:]}"


def _group(key: str) -> str:
    if key.startswith("QWENPAW_"):
        return "qwenpaw"
    if key.startswith("AGENTTEAMS_"):
        return "platform"
    return "other"


def build_runtime_env_router() -> APIRouter:
    router = APIRouter()

    @router.get("/workers/{worker}/runtime-env")
    async def worker_runtime_env(worker: str,
                                 request: Request) -> Dict[str, Any]:
        """容器 PID 1 实际生效环境变量（预填充正源，只读）。L1 only。"""
        token = _token_or_none(config_mod.load_config())
        if not token:
            raise HTTPException(
                status_code=403,
                detail="需要 Controller 管理员 token（L1）才能查看运行时环境")
        worker = (worker or "").strip()
        if not _NAME_RE.match(worker):
            raise HTTPException(status_code=400, detail="worker 名称非法")
        reveal = request.query_params.get("reveal") == "1"
        container = f"agentteams-worker-{worker}"
        st, text = await _exec(token, container, _CMD, timeout=30.0)
        entries: list[Dict[str, Any]] = []
        for line in text.splitlines():
            if "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            if not k:
                continue
            sensitive = bool(_SENSITIVE_RE.search(k))
            entries.append({
                "key": k,
                "value": v if (reveal or not sensitive) else _mask(v),
                "masked": sensitive and not reveal,
                "sensitive": sensitive,
                "group": _group(k),
            })
        return {
            "worker": worker,
            "count": len(entries),
            "reveal": reveal,
            "fetched_at": time.time(),
            "env": entries,
        }

    return router
