# -*- coding: utf-8 -*-
"""Controller 双认证能力探测（Matrix L1 / 旧版管理员 token）。

新 Controller（main / #1573+）：Human 权限等级 1（L1）用 Matrix 登录即可
直接调管理 API；``GET /api/v1/me`` 返回 ``permissionLevel`` 等能力字段。
旧 Controller 1.2.6 没有该路由（404/405），管理面仍需 Controller 管理员
token（粘贴或 env ``AGENTTEAMS_CONTROLLER_TOKEN``）。

本模块提供唯一的能力口径：
- ``probe_controller_auth(cfg)``：探测 ``/me`` → 归一化状态（30s 缓存，
  缓存键含 Matrix token 身份哈希 + Controller 地址列表 + 是否配置了
  管理员 token；token 值不进日志/响应）；
- ``preferred_controller_token(cfg)``：按能力状态选择拨号凭据
 （Matrix L1 → Matrix token；否则显式 token > Matrix token）；
- ``explicit_controller_token(cfg)``：仅显式配置（config/env）的 token；
- ``invalidate_controller_auth_cache()``：登录/配置变更时清缓存。

状态语义：
- ``matrix_l1``：``/me`` 200 且 permissionLevel==1 → Matrix 即管理员；
- ``matrix_scoped``：``/me`` 200 且 permissionLevel∈(2,3)（只读）；
- ``legacy``：``/me`` 404/405/501 → 旧 Controller，管理面要管理员 token；
- ``matrix_invalid``：``/me`` 401/403 → Matrix 身份不被 Controller 接受；
- ``unreachable``：连接/超时/未知 5xx → 无法判定（不弹 token 框）；
- ``none``：没有 Matrix 访问 token（未登录）。
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import threading
import time
from typing import Any, Dict, Optional, Tuple

import httpx

from .dial_gate import GatedAsyncClient
from .router_models import TokenValidationError, _sanitize_token

_CACHE_TTL_SECONDS = 30.0
# 键 = "<matrix token 哈希>|<controller 地址列表>|<是否配置管理员 token>"
# 值 = (expiry_monotonic, payload)。并发首探由 _probe_lock 单飞合并。
_controller_auth_cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}
_cache_lock = threading.Lock()
_probe_lock: Optional[asyncio.Lock] = None
_probe_lock_loop: Optional[asyncio.AbstractEventLoop] = None

# 短超时：能力探测只是页面加载时的轻探针，不是业务请求。
_PROBE_TIMEOUT = httpx.Timeout(connect=2.0, read=4.0, write=4.0, pool=2.0)

_LEGACY_STATUSES = (404, 405, 501)
_DENIED_STATUSES = (401, 403)


def _matrix_token(cfg: Dict[str, Any]) -> str:
    matrix = cfg.get("matrix") or {}
    try:
        return _sanitize_token(str(matrix.get("access_token") or ""))
    except TokenValidationError:
        # Matrix token 内容非法 = 不可用；错误由 /auth-status 报，探测不裸抛。
        return ""


def explicit_controller_token(cfg: Dict[str, Any]) -> Tuple[str, str]:
    """显式配置的 Controller 管理员 token（不探测、不含 Matrix token）。

 返回 (token, source)；source ∈ {"", "config", "env"}。token 内容非法 →
 抛 TokenValidationError（与旧 ``_resolve_controller_token`` 语义一致，
 调用方报明确错误）。
 """
    t = _sanitize_token(str(cfg.get("controller_token") or ""))
    if t and t != "***":
        return t, "config"
    e = _sanitize_token(os.environ.get("AGENTTEAMS_CONTROLLER_TOKEN", ""))
    if e:
        return e, "env"
    return "", ""


def _explicit_configured(cfg: Dict[str, Any]) -> Tuple[str, str, bool, bool]:
    """(token, source, configured, invalid) —— 非法 token 不抛，标记 invalid。"""
    try:
        token, source = explicit_controller_token(cfg)
        return token, source, bool(token), False
    except TokenValidationError:
        return "", "", True, True


def _controller_urls(cfg: Dict[str, Any]) -> list:
    from .router import _address_list  # noqa: PLC0415 - 避免模块级循环导入

    return [str(u).rstrip("/") for u in _address_list(cfg, "controller") if u]


def _cache_key(cfg: Dict[str, Any]) -> str:
    token = _matrix_token(cfg)
    digest = (
        hashlib.sha256(token.encode("utf-8", "replace")).hexdigest()[:16]
        if token
        else ""
    )
    _t, _src, configured, _invalid = _explicit_configured(cfg)
    return "|".join(("|".join(_controller_urls(cfg)), digest, "1" if configured else "0"))


def _peek_cached(cfg: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """已缓存且未过期的能力快照（不触发探测）。"""
    try:
        key = _cache_key(cfg)
    except Exception:  # noqa: BLE001 - 缓存键异常不阻塞凭据解析
        return None
    with _cache_lock:
        hit = _controller_auth_cache.get(key)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    return None


def cached_controller_auth_state(cfg: Dict[str, Any]) -> str:
    """缓存中的能力状态（"" = 尚未探测）。"""
    hit = _peek_cached(cfg)
    return str(hit.get("state") or "") if hit else ""


def invalidate_controller_auth_cache() -> None:
    """Matrix 登录/配置变更后清空能力缓存（下次请求重新探测）。"""
    with _cache_lock:
        _controller_auth_cache.clear()


def _get_probe_lock() -> asyncio.Lock:
    """按事件循环惰性建锁（测试逐 loop 重建）——并发首探只发一次。"""
    global _probe_lock, _probe_lock_loop
    loop = asyncio.get_running_loop()
    if _probe_lock is None or _probe_lock_loop is not loop:
        _probe_lock = asyncio.Lock()
        _probe_lock_loop = loop
    return _probe_lock


def _base_payload(configured: bool) -> Dict[str, Any]:
    return {
        "state": "none",
        "name": "",
        "permissionLevel": 0,
        "accessibleTeams": [],
        "accessibleWorkers": [],
        "capabilities": [],
        "credentialSource": "none",
        "controllerTokenConfigured": configured,
        "tokenRequired": False,
        "admin": configured,
        "legacy": False,
        "reachable": False,
    }


def _str_list(value: Any) -> list:
    if not isinstance(value, list):
        return []
    return [str(v) for v in value]


async def _probe_uncached(cfg: Dict[str, Any]) -> Dict[str, Any]:
    matrix_token = _matrix_token(cfg)
    ctl_token, ctl_source, configured, ctl_invalid = _explicit_configured(cfg)
    payload = _base_payload(configured and not ctl_invalid)
    if ctl_invalid:
        payload["detail"] = "Controller token 内容非法（含非 ASCII 字符）"
    urls = _controller_urls(cfg)

    if not matrix_token:
        payload["credentialSource"] = ctl_source if configured and not ctl_invalid else "none"
        return payload

    if not urls:
        payload["state"] = "unreachable"
        payload["detail"] = "未配置 Controller 地址"
        payload["credentialSource"] = (
            ctl_source if configured and not ctl_invalid else "matrix"
        )
        return payload

    for base in urls:
        try:
            async with GatedAsyncClient(
                timeout=_PROBE_TIMEOUT, verify=False
            ) as client:
                resp = await client.get(
                    f"{base}/api/v1/me",
                    headers={"Authorization": f"Bearer {matrix_token}"},
                )
        except Exception as exc:  # noqa: BLE001 - 逐地址降级
            payload["detail"] = exc.__class__.__name__
            continue

        if resp.status_code == 200:
            try:
                body = resp.json()
            except Exception:  # noqa: BLE001 - 非 JSON 视作无法判定
                body = {}
            if not isinstance(body, dict):
                body = {}
            try:
                level = int(body.get("permissionLevel"))
            except (TypeError, ValueError):
                level = 0
            payload.update(
                {
                    "state": "matrix_l1" if level == 1 else "matrix_scoped",
                    "name": str(body.get("name") or ""),
                    "permissionLevel": level,
                    "accessibleTeams": _str_list(body.get("accessibleTeams")),
                    "accessibleWorkers": _str_list(body.get("accessibleWorkers")),
                    "capabilities": _str_list(body.get("capabilities")),
                    "reachable": True,
                }
            )
            break
        if resp.status_code in _LEGACY_STATUSES:
            payload.update(
                {"state": "legacy", "legacy": True, "reachable": True}
            )
            break
        if resp.status_code in _DENIED_STATUSES:
            payload.update({"state": "matrix_invalid", "reachable": True})
            break
        # 其他状态（5xx/网关异常）：换下一地址再判；全败=unreachable。
        payload["detail"] = f"HTTP {resp.status_code}"
    else:
        payload["state"] = "unreachable"

    state = payload["state"]
    if state == "matrix_l1":
        payload["credentialSource"] = "matrix"
    elif configured and not ctl_invalid:
        payload["credentialSource"] = ctl_source
    elif state != "none":
        payload["credentialSource"] = "matrix"
    else:
        payload["credentialSource"] = "none"
    payload["admin"] = state == "matrix_l1" or (
        configured and not ctl_invalid
    )
    payload["tokenRequired"] = (
        state in ("legacy", "matrix_invalid") and not (configured and not ctl_invalid)
    )
    return payload


async def probe_controller_auth(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """探测/返回 Controller 认证能力（30s 缓存 + 并发单飞）。"""
    key = _cache_key(cfg)
    with _cache_lock:
        hit = _controller_auth_cache.get(key)
        if hit and hit[0] > time.monotonic():
            return dict(hit[1])

    async with _get_probe_lock():
        with _cache_lock:
            hit = _controller_auth_cache.get(key)
            if hit and hit[0] > time.monotonic():
                return dict(hit[1])
        payload = await _probe_uncached(cfg)
        with _cache_lock:
            _controller_auth_cache[key] = (
                time.monotonic() + _CACHE_TTL_SECONDS,
                payload,
            )
        return dict(payload)


def preferred_controller_token(cfg: Dict[str, Any]) -> Tuple[str, str]:
    """Controller 拨号凭据（唯一策略）。

 1. 缓存状态 = ``matrix_l1`` → Matrix 访问 token（source ``matrix``）；
 2. 显式配置的管理员 token（config/env）；
 3. 兜底 Matrix 访问 token（旧 Controller 上只读路径可能被接受）。

 返回 (token, source)；source ∈ {"", "config", "env", "matrix"}。
 显式 token 内容非法 → 抛 TokenValidationError（调用方报明确错误）。
 """
    ctl_token, ctl_source = explicit_controller_token(cfg)
    matrix_token = _matrix_token(cfg)
    if cached_controller_auth_state(cfg) == "matrix_l1" and matrix_token:
        return matrix_token, "matrix"
    if ctl_token:
        return ctl_token, ctl_source
    if matrix_token:
        return matrix_token, "matrix"
    return "", ""
