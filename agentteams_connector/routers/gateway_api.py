from __future__ import annotations

import asyncio

from typing import Any, Dict, Optional

from fastapi import APIRouter, Body

from .. import router as router_mod
from ..dial_gate import GatedAsyncClient
from ..router import _address_list, _mark_working


def build_gateway_router() -> APIRouter:
    """gateway 透传域子路由（build_router 原段逐字搬移，任务 190）。"""
    router = APIRouter()
    async def _gateway_passthrough(
        path: str,
        method: str = "GET",
        json_body: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """v0.5.0-beta.12: 网关面透传（Higress Console，8001）。

 v0.5.0-beta.12.13：加写面（POST，「添加提供商/添加路由」P7b）；
 v0.5.0-beta.14.4：加编辑/删除面（PUT/DELETE，与 dashboard higress
 BFF `/api/higress/ai-{routes,providers}` 同款 Console 端点）；
 写失败时透出 Console 的 message/detail 供 UI 显示。

 消费密码模式持有的 Console 管理员会话（console_session）；
 无会话/不可达 → available=false（前端优雅降级：模型选择器
 alias 层隐藏，SGLang 列表+Worker 现值+自由输入不受影响）。
 原始 JSON 直出，形状由前端解析（与 dashboard higress-api 同义）。
 """
        from .. import config as cfgmod

        cfg = await asyncio.to_thread(cfgmod.load_config)
        session = str(cfg.get("console_session") or "")
        # v0.5.0-beta.14.7: Higress 双地址（canonical=gateway_admin_urls，空则
        # 回退 legacy 单值）——按序降级。
        gateways = _address_list(cfg, "gateway")
        if not session or not gateways:
            return {"available": False, "data": None, "reason": "no_console_session"}
        # v0.5.0-beta.14.7: 逐地址降级——传输错误换下一地址；拿到响应=地址可达，
        # 状态码由下方既有逻辑处理（会话 cookie 由 Console 后端校验、跨入口通用）。
        r = None
        last_err = ""
        for console_url in gateways:
            try:
                async with GatedAsyncClient(timeout=8.0, verify=False) as client:
                    if method == "POST":
                        r = await client.post(
                            f"{console_url}{path}",
                            headers={
                                "Cookie": session,
                                "Content-Type": "application/json",
                            },
                            json=json_body or {},
                        )
                    elif method == "PUT":
                        r = await client.put(
                            f"{console_url}{path}",
                            headers={
                                "Cookie": session,
                                "Content-Type": "application/json",
                            },
                            json=json_body or {},
                        )
                    elif method == "DELETE":
                        r = await client.delete(
                            f"{console_url}{path}", headers={"Cookie": session}
                        )
                    else:
                        r = await client.get(
                            f"{console_url}{path}", headers={"Cookie": session}
                        )
                _mark_working("gateway", console_url)
                break
            except Exception as exc:  # noqa: BLE001 - 逐地址降级
                r = None
                last_err = exc.__class__.__name__
                continue
        if r is None:
            return {
                "available": False,
                "data": None,
                "reason": "unreachable",
                "detail": last_err,
            }
        try:
            if r.status_code not in (200, 201, 204):
                out: Dict[str, Any] = {
                    "available": False,
                    "data": None,
                    "reason": f"http_{r.status_code}",
                }
                # v0.5.0-beta.14.19: 带 Cookie 的网关面 401 = 会话过期
                # （Higress Console 对失效 session 回 401 + JSON）。
                if r.status_code == 401:
                    # 任务 190：跨域共享状态，经 router 模块属性写入（勿改回 global）。
                    router_mod._console_session_expired = True
                detail = ""
                try:
                    j = r.json()
                    msg = j.get("message") or j.get("error") or j.get("detail")
                    if msg:
                        detail = str(msg)
                except Exception:
                    detail = ""
                if not detail:
                    text = getattr(r, "text", "") or ""
                    if isinstance(text, str):
                        detail = text[:300]
                if detail:
                    out["detail"] = detail
                return out
            return {"available": True, "data": r.json()}
        except Exception as exc:
            return {"available": False, "data": None, "reason": exc.__class__.__name__}

    @router.get("/gateway/ai-routes")
    async def gateway_ai_routes() -> Dict[str, Any]:
        """网关 AI 路由（请求模型 alias → provider 映射，模型选择 alias 层）。"""
        return await _gateway_passthrough("/v1/ai/routes")

    @router.get("/gateway/ai-providers")
    async def gateway_ai_providers() -> Dict[str, Any]:
        """网关 LLM Provider 列表（alias 可解析性判定用）。"""
        return await _gateway_passthrough("/v1/ai/providers")

    @router.post("/gateway/ai-routes")
    async def gateway_ai_routes_create(
        payload: Dict[str, Any] = Body(...),
    ) -> Dict[str, Any]:
        """网关 AI 路由创建（Console 写面透传；12.13 P7b「添加路由」）。"""
        if not str(payload.get("name") or "").strip():
            return {"available": False, "data": None, "reason": "invalid", "detail": "name 必填"}
        return await _gateway_passthrough("/v1/ai/routes", method="POST", json_body=payload)

    @router.post("/gateway/ai-providers")
    async def gateway_ai_providers_create(
        payload: Dict[str, Any] = Body(...),
    ) -> Dict[str, Any]:
        """网关 LLM Provider 创建（Console 写面透传；12.13 P7b「添加提供商」）。"""
        if not str(payload.get("name") or "").strip():
            return {"available": False, "data": None, "reason": "invalid", "detail": "name 必填"}
        return await _gateway_passthrough("/v1/ai/providers", method="POST", json_body=payload)

    # ---- v0.5.0-beta.14.4：模型配置编辑/删除（Console 写面透传，与 dashboard
    # higress BFF `/api/higress/ai-{routes,providers}/{name}` 同款端点）----

    @router.put("/gateway/ai-routes/{name}")
    async def gateway_ai_route_update(
        name: str, payload: Dict[str, Any] = Body(...)
    ) -> Dict[str, Any]:
        """网关 AI 路由编辑（Console 写面透传；名称在路径上，body 全量提交）。"""
        if not name.strip():
            return {"available": False, "data": None, "reason": "invalid", "detail": "路由名必填"}
        return await _gateway_passthrough(
            f"/v1/ai/routes/{name}", method="PUT", json_body=payload
        )

    @router.delete("/gateway/ai-routes/{name}")
    async def gateway_ai_route_delete(name: str) -> Dict[str, Any]:
        """网关 AI 路由删除（Console 写面透传）。"""
        if not name.strip():
            return {"available": False, "data": None, "reason": "invalid", "detail": "路由名必填"}
        return await _gateway_passthrough(f"/v1/ai/routes/{name}", method="DELETE")

    @router.put("/gateway/ai-providers/{name}")
    async def gateway_ai_provider_update(
        name: str, payload: Dict[str, Any] = Body(...)
    ) -> Dict[str, Any]:
        """网关 LLM Provider 编辑（Console 写面透传）。

 与 dashboard serializeProviderForm(isUpdate) 同款：名称在路径上，
 body 不含 name（tokens 留空=Console 保持现有凭据）。
 """
        if not name.strip():
            return {"available": False, "data": None, "reason": "invalid", "detail": "提供商名必填"}
        return await _gateway_passthrough(
            f"/v1/ai/providers/{name}", method="PUT", json_body=payload
        )

    @router.delete("/gateway/ai-providers/{name}")
    async def gateway_ai_provider_delete(name: str) -> Dict[str, Any]:
        """网关 LLM Provider 删除（Console 写面透传）。"""
        if not name.strip():
            return {"available": False, "data": None, "reason": "invalid", "detail": "提供商名必填"}
        return await _gateway_passthrough(f"/v1/ai/providers/{name}", method="DELETE")

    return router
