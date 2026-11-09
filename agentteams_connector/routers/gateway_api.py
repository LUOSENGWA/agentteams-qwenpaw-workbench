from __future__ import annotations

import asyncio

from typing import Any, Dict, Optional

from fastapi import APIRouter, Body

from .. import router as router_mod
from .. import controller_auth
from ..dial_gate import GatedAsyncClient
from ..router import TokenValidationError, _address_list, _mark_working

# 旧 Controller = 无网关管理端点（能力探测报 legacy）。现代路径仅在这三类
# 状态上回落 Console——401/403 绝不回落（那会把鉴权/权限问题伪装成可用）。
_CONSOLE_FALLBACK_STATUSES = (404, 405, 501)


def _controller_gateway_path(path: str) -> str:
    """插件网关路径 → Controller 管理端点路径。

 插件/Console 契约：``/v1/ai/{routes,providers}[/{name}]``；
 Controller（#1573+）：``/api/v1/gateway/ai/{routes,providers}[/{name}]``。
 """
    if path.startswith("/v1/ai/"):
        return "/api/v1/gateway" + path[len("/v1"):]
    return "/api/v1/gateway" + path


def _error_detail(resp: Any) -> str:
    detail = ""
    try:
        j = resp.json()
        msg = j.get("message") or j.get("error") or j.get("detail")
        if msg:
            detail = str(msg)
    except Exception:  # noqa: BLE001 - 非 JSON 错误体
        detail = ""
    if not detail:
        text = getattr(resp, "text", "") or ""
        if isinstance(text, str):
            detail = text[:300]
    return detail


def build_gateway_router() -> APIRouter:
    """gateway 透传域子路由（build_router 原段逐字搬移）。"""
    router = APIRouter()

    async def _controller_gateway_passthrough(
        cfg: Dict[str, Any],
        path: str,
        method: str,
        json_body: Optional[Dict[str, Any]],
    ) -> Optional[Dict[str, Any]]:
        """现代 Controller 网关管理面（Bearer 凭据，无 Console 会话）。

 返回 None = 上游 404/405/501（旧 Controller 无该端点）→ 调用方回落
 Console；其余状态一律显式包装（401/403 不回落，避免掩盖鉴权问题）。
 """
        from ..router import _headers_for, _ordered_addresses  # noqa: PLC0415

        try:
            token, _source = controller_auth.preferred_controller_token(cfg)
        except TokenValidationError as exc:
            return {
                "available": False,
                "data": None,
                "reason": "invalid_token",
                "detail": str(exc),
            }
        if not token:
            return {
                "available": False,
                "data": None,
                "reason": "no_controller_credential",
            }
        urls = _ordered_addresses(cfg, "controller")
        if not urls:
            return {
                "available": False,
                "data": None,
                "reason": "no_controller_address",
            }
        ctl_path = _controller_gateway_path(path)
        resp = None
        last_err = ""
        for base in urls:
            headers = _headers_for(
                cfg,
                "controller",
                base,
                {
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
            )
            try:
                async with GatedAsyncClient(timeout=8.0, verify=False) as client:
                    if method == "POST":
                        resp = await client.post(
                            f"{base}{ctl_path}", headers=headers, json=json_body or {}
                        )
                    elif method == "PUT":
                        resp = await client.put(
                            f"{base}{ctl_path}", headers=headers, json=json_body or {}
                        )
                    elif method == "DELETE":
                        resp = await client.delete(f"{base}{ctl_path}", headers=headers)
                    else:
                        resp = await client.get(f"{base}{ctl_path}", headers=headers)
                _mark_working("controller", base)
                break
            except Exception as exc:  # noqa: BLE001 - 逐地址降级
                resp = None
                last_err = exc.__class__.__name__
                continue
        if resp is None:
            return {
                "available": False,
                "data": None,
                "reason": "unreachable",
                "detail": last_err,
            }
        if resp.status_code in _CONSOLE_FALLBACK_STATUSES:
            return None
        if resp.status_code not in (200, 201, 204):
            out: Dict[str, Any] = {
                "available": False,
                "data": None,
                "reason": f"http_{resp.status_code}",
            }
            detail = _error_detail(resp)
            if detail:
                out["detail"] = detail
            return out
        try:
            data = resp.json()
        except Exception:  # noqa: BLE001 - 204/非 JSON 成功体
            data = None
        return {"available": True, "data": data, "reason": None}

    async def _console_gateway_passthrough(
        cfg: Dict[str, Any],
        path: str,
        method: str,
        json_body: Optional[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """旧 Controller 路径：Higress Console 会话透传（既有行为）。"""
        session = str(cfg.get("console_session") or "")
        # Higress 双地址（canonical=gateway_admin_urls，空则
        # 回退 legacy 单值）——按序降级。
        gateways = _address_list(cfg, "gateway")
        if not session or not gateways:
            return {"available": False, "data": None, "reason": "no_console_session"}
        # 逐地址降级——传输错误换下一地址；拿到响应=地址可达，
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
            # 带 Cookie 的网关面 401 = 会话过期
            # （Higress Console 对失效 session 回 401 + JSON）。
            # # 过期不再只判死——用 config 持久账密自动重登一次（冷却 60s/
            # 并发合并/凭据错即停三闸防风暴），成功则新会话落盘 +
            # **透明重放本次请求**（调用方无感，模型下拉等面不再静默消失，
            # 用户不必手动重验证）。自愈前置到降级响应构建之前：重放成功
            # → 直接走下方 2xx 路径；重放/重登未遂 → 落到降级构建。
            if r.status_code == 401:
                new_session = await router_mod.console_try_relogin(cfg)
                if new_session:
                    retry_ok = None
                    for retry_url in gateways:
                        try:
                            async with GatedAsyncClient(
                                timeout=8.0, verify=False
                            ) as client:
                                if method == "POST":
                                    resp2 = await client.post(
                                        f"{retry_url}{path}",
                                        headers={
                                            "Cookie": new_session,
                                            "Content-Type": "application/json",
                                        },
                                        json=json_body or {},
                                    )
                                elif method == "PUT":
                                    resp2 = await client.put(
                                        f"{retry_url}{path}",
                                        headers={
                                            "Cookie": new_session,
                                            "Content-Type": "application/json",
                                        },
                                        json=json_body or {},
                                    )
                                elif method == "DELETE":
                                    resp2 = await client.delete(
                                        f"{retry_url}{path}",
                                        headers={"Cookie": new_session},
                                    )
                                else:
                                    resp2 = await client.get(
                                        f"{retry_url}{path}",
                                        headers={"Cookie": new_session},
                                    )
                            _mark_working("gateway", retry_url)
                            retry_ok = resp2
                            break
                        except Exception:  # noqa: BLE001 - 逐地址降级
                            continue
                    if retry_ok is not None and retry_ok.status_code in (
                        200,
                        201,
                        204,
                    ):
                        r = retry_ok  # 透明重放成功 → 下方 2xx 路径
                    elif retry_ok is not None and retry_ok.status_code == 401:
                        r = retry_ok  # 新会话仍 401 → 判死路径
                    # 其余（传输全败/其他状态）：保留原 401 响应。
            if r is None or r.status_code not in (200, 201, 204):
                out: Dict[str, Any] = {
                    "available": False,
                    "data": None,
                    "reason": f"http_{r.status_code}",
                }
                if r is not None and r.status_code == 401:
                    # 重登未遂（无凭据/冷却窗/凭据错/网络）→ 维持 14.19
                    # 判死语义（前端横幅提示手动重新验证）。
                    # 跨域共享状态，经 router 模块属性写入（勿改回 global）。
                    router_mod._console_session_expired = True
                detail = _error_detail(r)
                if detail:
                    out["detail"] = detail
                return out
            return {"available": True, "data": r.json()}
        except Exception as exc:
            return {"available": False, "data": None, "reason": exc.__class__.__name__}

    async def _gateway_passthrough(
        path: str,
        method: str = "GET",
        json_body: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """网关面双路径透传（现代 Controller 网关管理 API / 旧 Console）。

 现代 Controller（#1573+，``GET /api/v1/gateway/ai/*``）优先：能力探测
 状态 matrix_l1/matrix_scoped/matrix_invalid 或已配置管理员 token 时
 走 Controller + Bearer，并把结果包进既有前端契约
 ``{available, data, reason}``。仅 404/405/501 回落 Console；401/403
 原样暴露（不伪装成 Console 可用）。旧 Controller 保持 Higress Console
 会话透传（无会话 → available=false / no_console_session）。
 """
        from .. import config as cfgmod  # noqa: PLC0415

        cfg = await asyncio.to_thread(cfgmod.load_config)
        try:
            auth = await controller_auth.probe_controller_auth(cfg)
        except Exception:  # noqa: BLE001 - 探测异常退化为旧路径判定
            auth = {}
        state = str(auth.get("state") or "")
        configured = bool(auth.get("controllerTokenConfigured"))
        use_modern = state in ("matrix_l1", "matrix_scoped", "matrix_invalid") or (
            state in ("none", "unreachable") and configured
        )
        if use_modern:
            out = await _controller_gateway_passthrough(cfg, path, method, json_body)
            if out is not None:
                return out
        return await _console_gateway_passthrough(cfg, path, method, json_body)

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

    # ---- 模型配置编辑/删除（Console 写面透传，与 dashboard
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
