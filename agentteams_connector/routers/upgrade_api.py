"""运行时升级域子路由：/upgrade/{check,run,status}。

代理到同宿主 QwenPaw 实例内置的 agentteams-upgrade 插件
（1.2.5+ worker 镜像内置，提供 /api/upgrade/{check,run,status}；
见上游 #1364/#1343）。该服务与本插件同进程（同一 QwenPaw 宿主），
故无需新代理目标——后端经 127.0.0.1 回环宿主自身端口
（QWENPAW_PORT 由宿主进程注入）直达。controller/matrix catch-all
不服务此域；本路由在 catch-all 之前注册（固定路径优先）。

无升级服务的实例（旧镜像 / 非 worker 形态宿主）：上游 404 →
本层归一为 404 + "upgrade service unavailable" detail，前端显
降级空态（不报错）。job_not_found 保留上游 404 语义（detail 区分）。

安全面：/run 是破坏性操作（两阶段编排器会重启容器、可能中断在跑
任务、失败自动回滚）。本层继承宿主 API 鉴权，且 body 只透传
上游 UpgradeRunBody 白名单键（version 必填），调用方不可注入
白名单外字段。
"""
from __future__ import annotations

import os
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, Request

from ..dial_gate import GatedAsyncClient


def _loopback_base() -> str:
    """宿主自身端口（宿主进程环境注入；缺省 8088 = 发行默认）。"""
    port = os.environ.get("QWENPAW_PORT", "") or "8088"
    return f"http://127.0.0.1:{port}"


# 与上游 UpgradeRunBody 对齐的白名单（qwenpaw_worker.upgrade.runner）。
# 白名单外键一律不透传（调用方不可注入越权面）。
_RUN_BODY_KEYS = (
    "version",
    "mode",
    "venv",
    "restart_mode",
    "container",
    "index_url",
    "timeout",
    "settle",
    "skip_check",
)


def _safe_json(resp: Any) -> Any:
    """响应体安全解析（非 JSON → None，交给上层归一）。"""
    try:
        return resp.json()
    except Exception:  # noqa: BLE001
        return None


def _upstream_error(resp_status: int, body: Any) -> HTTPException:
    """上游扁平错误体 {"error": ...} / FastAPI {"detail": ...} → 本层异常。"""
    detail = ""
    if isinstance(body, dict):
        err = body.get("error")
        det = body.get("detail")
        if isinstance(err, str) and err:
            detail = err
        elif isinstance(det, str) and det:
            detail = det
    return HTTPException(status_code=resp_status, detail=detail or f"HTTP {resp_status}")


def build_upgrade_router() -> APIRouter:
    router = APIRouter()

    @router.get("/upgrade/check")
    async def upgrade_check(request: Request) -> Dict[str, Any]:
        """预检（上游恒 200：索引/网络问题落 errors[]，不 5xx）。

        query 原样透传（verify / include_prerelease / index_url）。
        verify=true 触发 C3 轮下载（wheelhouse 持久缓存）——耗时显著
        更长，客户端超时随 verify 放宽（30s → 300s）。
        """
        url = f"{_loopback_base()}/api/upgrade/check"
        params = dict(request.query_params)
        try:
            timeout = 300.0 if request.query_params.get("verify") == "true" else 30.0
            async with GatedAsyncClient(timeout=timeout) as client:
                resp = await client.get(url, params=params or None)
        except Exception as exc:  # noqa: BLE001 — 回环不可达=本实例无该服务形态
            raise HTTPException(
                status_code=404, detail="upgrade service unavailable"
            ) from exc
        if resp.status_code != 200:
            raise _upstream_error(resp.status_code, _safe_json(resp))
        return _safe_json(resp)  # type: ignore[return-value]

    @router.post("/upgrade/run", status_code=202)
    async def upgrade_run(request: Request) -> Dict[str, Any]:
        """触发两阶段升级（202 job handle）。409=已有 job 在跑 /
        400=校验拒绝 / 501=mode=docker 保留位。破坏性：UI 须二次
        确认（本层保持薄代理，不重复拦截）。"""
        raw = await request.json()
        if not isinstance(raw, dict):
            raise HTTPException(status_code=400, detail="body must be a JSON object")
        version = raw.get("version")
        if not isinstance(version, str) or not version.strip():
            raise HTTPException(status_code=400, detail="version is required")
        payload = {
            k: raw[k]
            for k in _RUN_BODY_KEYS
            if k in raw and raw[k] is not None
        }
        url = f"{_loopback_base()}/api/upgrade/run"
        try:
            async with GatedAsyncClient(timeout=60.0) as client:
                resp = await client.post(url, json=payload)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=404, detail="upgrade service unavailable"
            ) from exc
        data = _safe_json(resp)
        if resp.status_code in (400, 404, 409, 501):
            raise _upstream_error(resp.status_code, data)
        if resp.status_code != 202:
            raise HTTPException(
                status_code=502, detail=f"upgrade run HTTP {resp.status_code}"
            )
        return data if isinstance(data, dict) else {"detail": "unexpected run response"}

    @router.get("/upgrade/status")
    async def upgrade_status(request: Request) -> Dict[str, Any]:
        """job 状态（on-disk 单一真相源，跨容器重启可读）。
        job_id 缺省 = 最近一个 job；无 job → 上游 404 job_not_found。"""
        url = f"{_loopback_base()}/api/upgrade/status"
        job_id = request.query_params.get("job_id")
        params = {"job_id": job_id} if job_id else None
        try:
            async with GatedAsyncClient(timeout=15.0) as client:
                resp = await client.get(url, params=params)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=404, detail="upgrade service unavailable"
            ) from exc
        data = _safe_json(resp)
        if resp.status_code != 200:
            raise _upstream_error(resp.status_code, data)
        return data if isinstance(data, dict) else {"detail": "unexpected status response"}

    return router
