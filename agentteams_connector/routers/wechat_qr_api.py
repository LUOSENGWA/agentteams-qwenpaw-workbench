# -*- coding: utf-8 -*-
"""微信二维码状态直连（绕过 Controller 频道代理的长轮询超时）。

背景：iLink 的 ``get_qrcode_status`` 是**长轮询**——服务端挂约 30s 才返回
（2026-10-26 实测 30.86s）。Controller 的频道代理固定 5s
（``channelProxyTimeout``）、插件后端通用代理 6s（``_PROXY_TIMEOUT`` read），
都会在长轮询返回前掐断 → 扫码后永远读不到 ``confirmed``，微信绑定无法完成
（手机端显示腾讯的通用失败文案）。

本模块让**插件后端直连 iLink** 拉状态（45s 超时），拿到 ``bot_token`` 后由
前端走原有频道 PUT（快写，5s 足够）落盘。仅微信通道使用；其它通道仍走
Controller 代理。

安全：QR token 是扫码轮询标识（非密钥）；``confirmed`` 时的 bot_token 只
回给本机前端，不写日志。
"""
from __future__ import annotations

import base64
import secrets
from typing import Any, Dict

import httpx
from fastapi import APIRouter, HTTPException

_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com"
# Same bound as the Controller's long-poll route: well above the ~31s server
# hold, well below an indefinite connection.
_STATUS_TIMEOUT = httpx.Timeout(connect=5.0, read=45.0, write=10.0, pool=5.0)


def _headers() -> Dict[str, str]:
    """iLink request headers (mirrors the QwenPaw WeChat channel)."""
    uin = base64.b64encode(str(secrets.randbelow(0xFFFFFFFF)).encode()).decode()
    return {
        "Content-Type": "application/json",
        "AuthorizationType": "ilink_bot_token",
        "X-WECHAT-UIN": uin,
    }


def build_wechat_qr_router() -> APIRouter:
    """固定路由 ``/wechat-qr/status``（必须在 catch-all 之前注册）。"""
    router = APIRouter(tags=["wechat-qr"])

    @router.get("/wechat-qr/status")
    async def wechat_qr_status(
        token: str = "",
        base_url: str = "",
    ) -> Dict[str, Any]:
        """Poll the iLink QR status directly (long-poll, up to ~31s).

        Returns the same shape as the Controller route:
        ``{"status": str, "credentials": {"bot_token": str, "base_url": str}}``
        — credentials are only populated on ``confirmed``.
        """
        if not token:
            raise HTTPException(status_code=400, detail="token is required")
        base = (base_url or _DEFAULT_BASE_URL).rstrip("/")
        url = f"{base}/ilink/bot/get_qrcode_status"
        try:
            async with httpx.AsyncClient(timeout=_STATUS_TIMEOUT) as client:
                resp = await client.get(
                    url, params={"qrcode": token}, headers=_headers()
                )
        except httpx.HTTPError as exc:
            raise HTTPException(
                status_code=502,
                detail=f"iLink status request failed: {exc.__class__.__name__}",
            ) from exc
        if resp.status_code != 200:
            raise HTTPException(
                status_code=502,
                detail=f"iLink status HTTP {resp.status_code}",
            )
        try:
            data = resp.json()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=502, detail="iLink status returned non-JSON"
            ) from exc
        status = str(data.get("status") or "wait")
        creds: Dict[str, Any] = {}
        if status == "confirmed":
            if data.get("bot_token"):
                creds["bot_token"] = data["bot_token"]
            if data.get("baseurl"):
                creds["base_url"] = data["baseurl"]
        return {"status": status, "credentials": creds}

    return router
