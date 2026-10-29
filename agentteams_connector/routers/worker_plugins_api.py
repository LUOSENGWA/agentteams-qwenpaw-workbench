# -*- coding: utf-8 -*-
"""Worker 插件域：worker 已装插件列表的 Controller 只读代理。

背景：worker 装了哪些插件（builtin/team/custom）由 worker 容器内自报；
Controller 另有一单加 ``GET /api/v1/workers/{name}/plugins`` 只读代理
（**可能尚未合并**）。工作台此前没有「该 worker 装了哪些插件」的入口
——本端点补读路径，前端 WorkerPluginsPanel 以
id / name / version / enabled / loaded / plugin_type 六列表格展示。

诚实降级（任务书口径）：
- Controller 404（端点未合 / 路径不存在）→ HTTP 200
  ``{"available": false, "reason": "controller_too_old"}``
  ——不抛 500、不吞成空数组；前端显示「需升级 controller」一行提示。
- 无本地 controller token → HTTP 200
  ``{"available": false, "reason": "no_token"}``（不拨号、不 500）。
- 其他错误（401/403/5xx/传输全败）→ 透传/映射状态码 + 简短原因
  （前端行内 warning，无弹窗）。

字段直传（无需脱敏）：插件条目不含凭据（无 env/headers/command），
条目原样透传——后端只做 ① 列表/包装对象拆壳（顶层 dict 带 plugins 列表
取该列表）② 非 dict 条目跳过（不伪造）。

安全：只读；worker 名正则门控后才进 controller 路径（零注入面）；
走 router 共享 _ctl_json（ordered 地址 failover + 该地址覆盖凭据）。
"""
from __future__ import annotations

import re
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException

from .. import config as config_mod
from ..router import _ctl_json, _token_or_none

_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9\-]{0,62}$")


def _extract_plugins(data: Any) -> List[Dict[str, Any]]:
    """Controller 响应防御性拆壳：

    ① 条目数组 → 原样；② 包装对象（``plugins`` 键为列表）→ 取该列表；
    ③ 其他形态 → 空列表（不伪造条目）。非 dict 条目跳过。
    """
    if isinstance(data, dict):
        v = data.get("plugins")
        if isinstance(v, list):
            data = v
    if not isinstance(data, list):
        return []
    return [e for e in data if isinstance(e, dict)]


def build_worker_plugins_router() -> APIRouter:
    router = APIRouter()

    @router.get("/workers/{worker}/plugins")
    async def worker_plugins(worker: str) -> Dict[str, Any]:
        """worker 已装插件（Controller 只读代理，字段直传无脱敏）。

        404（Controller 端点未合/路径不存在）→ 200 available=false
        reason=controller_too_old（诚实降级）；401/403/5xx → 透传
        状态码 + 简短原因；无 token → 200 available=false no_token。
        """
        worker = (worker or "").strip()
        if not _NAME_RE.match(worker):
            raise HTTPException(status_code=400, detail="worker 名称非法")
        token = _token_or_none(config_mod.load_config())
        if not token:
            return {"available": False, "worker": worker,
                    "reason": "no_token"}
        st, data, _text = await _ctl_json(
            "GET", f"/api/v1/workers/{worker}/plugins", token)
        if st == 404:
            return {"available": False, "worker": worker,
                    "reason": "controller_too_old"}
        if st == 200:
            return {"available": True, "worker": worker,
                    "plugins": _extract_plugins(data)}
        if st == 0:
            raise HTTPException(
                status_code=502, detail="Controller 不可达（无可用地址或拨号失败）")
        if st >= 500:
            raise HTTPException(
                status_code=502, detail=f"Controller 内部错误（HTTP {st}）")
        # 401/403 及其他 4xx：透传状态码 + 简短原因。
        raise HTTPException(status_code=st, detail=f"Controller 返回 HTTP {st}")

    return router
