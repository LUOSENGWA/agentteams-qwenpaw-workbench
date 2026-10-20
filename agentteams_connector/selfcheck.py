# -*- coding: utf-8 -*-
"""Layered connectivity self-check (L0-L2 for the skeleton release).

L0 local environment: plugin backend alive + QwenPaw version.
L1 connectivity: every configured Matrix/Controller address, with error
 classification (DNS vs refused vs TLS vs timeout) and
 the effective (working) address highlighted.
L2 auth/API: Matrix whoami + joined_rooms (and optional Controller
 project listing when a token is available).

L3 (per-room permission + ping message) and L4 (end-to-end) land after the
skeleton passes real-machine validation.
"""

from __future__ import annotations

import asyncio
import datetime
import json
import logging
import os
import platform
import re
import socket
import ssl
import time
import traceback
import urllib.parse
from typing import Any, Dict, List, Optional

import httpx

from . import config as config_mod
from . import matrix_client
from .dial_gate import GatedAsyncClient, sync_dial_slot

logger = logging.getLogger("qwenpaw.plugins.agentteams_qwenpaw_workbench")

# Import lazily to avoid a circular import with router.py.
def _working_cache() -> Dict[str, str]:
    from . import router as router_mod

    return router_mod._working_cache


def _mark_working(kind: str, url: str) -> None:
    from . import router as router_mod

    router_mod._mark_working(kind, url)


async def test_addresses(
    matrix_urls: List[str],
    controller_urls: List[str],
    sglang_urls: List[str],
    token: str = "",
    timeout: float = 3.0,  # 4→3s（可达地址 <1s 不受影响；死地址配合 _probe_with_retry 超时不重试 = 单程成本）
    with_diag: bool = False,
    auth_maps: Optional[Dict[str, Dict[str, Dict[str, str]]]] = None,
    gateway_urls: Optional[List[str]] = None,
    gateway_session_cookie: str = "",
) -> Dict[str, Any]:
    """连通性测试——全部地址并行探测（失败重试一次），
 返回每地址 {url, ok, ms, detail}。手动测试与后台自动重排共用。

 with_diag=True（仅手动测试路径）时每地址附加 diag 结构化
 诊断（分步+全栈 traceback+客户端环境）——后台自动重排不传，零成本。
 auth_maps={kind: {url: auth}}——该地址配了覆盖凭据时
 探测也带（否则 WAN basic/key 门地址永远 401，自动重排选不上）；行级
 auth 字段=该地址实际生效的凭据类型（none/basic/bearer）。
 gateway_urls——Higress Console 探测（可达性+会话三态，
 诊断面：不参与自动重排；后台 refresh 不传=零额外开销）。
 """
    maps = auth_maps or {}

    def _am(kind: str, url: str) -> Optional[Dict[str, str]]:
        return (maps.get(kind) or {}).get(url.rstrip("/")) or (
            (maps.get(kind) or {}).get(url)
        )

    async def _probe_m(url: str, _token: str, t: float) -> Dict[str, Any]:
        auth = _am("matrix", url)
        row = await _probe_matrix(url, t, auth)
        row["auth"] = (auth or {}).get("type") or "none"
        return row

    async def _probe_c(url: str, _token: str, t: float) -> Dict[str, Any]:
        auth = _am("controller", url)
        row = await _probe_controller(url, token, t, auth)
        row["auth"] = (auth or {}).get("type") or "none"
        return row

    # SGLang 双地址（内网/外网）逐地址探测（失败重试一次，与其他类型同构）。
    # wrapper 对齐 _probe_with_retry 的 (url, token, timeout) 签名（SGLang 无鉴权）。
    async def _probe_s(url: str, _token: str, t: float) -> Dict[str, Any]:
        auth = _am("sglang", url)
        row = await _probe_sglang(url, t, auth)
        row["auth"] = (auth or {}).get("type") or "none"
        return row

    # Higress 探测闭包（wrapper 对齐 _probe_with_retry 的
    # (url, token, timeout) 签名；session_cookie 自外层参数闭包）。
    _gw_urls = list(gateway_urls or [])

    async def _probe_g(url: str, _token: str, t: float) -> Dict[str, Any]:
        auth = _am("gateway", url)
        row = await _probe_gateway(url, t, auth, gateway_session_cookie)
        row["auth"] = (auth or {}).get("type") or "none"
        return row

    # 四类地址（matrix/controller/sglang/gateway）
    # 原来三段串行 await gather——WAN 上每类都含一个不可达内网地址吃满
    # (timeout+重试+timeout)=12.5s，三段相加≈37.5s（连通性测试很慢
    # 根因）。改为各段嵌套进同一个外层 gather=全并行：总时长=最慢单地址，
    # 37.5s→8.3s（配合下方 timeout 4s）。逐地址语义/重试/凭据完全不变。
    # gateway 段并入（未配置=空列表，gather 零任务）。
    matrix_rows, controller_rows, sglang_rows, gateway_rows = await asyncio.gather(
        asyncio.gather(
            *[_probe_with_retry(_probe_m, u, "", timeout) for u in matrix_urls]
        ),
        asyncio.gather(
            *[
                _probe_with_retry(_probe_c, u, token, timeout)
                for u in controller_urls
            ]
        ),
        asyncio.gather(
            *[_probe_with_retry(_probe_s, u, "", timeout) for u in sglang_urls]
        ),
        asyncio.gather(
            *[_probe_with_retry(_probe_g, u, "", timeout) for u in _gw_urls]
        ),
    )

    async def _attach_one(r: Dict[str, Any]) -> Dict[str, Any]:
        # 网络层失败时附加解析诊断（fake-ip/私有段提示）
        # with_diag 时附结构化诊断（分步+traceback+环境）
        # getaddrinfo / diagnose_target 均同步阻塞——to_thread
        # 化（DNS 慢时不再冻结事件循环）。
        if not r.get("ok"):
            hint = await asyncio.to_thread(_resolve_ip_hint, r["url"])
            if hint:
                r = {**r, "detail": f"{r['detail']}｜{hint}"}
        if with_diag:
            try:
                diag = await asyncio.to_thread(
                    diagnose_target, r["url"], timeout
                )
                r = {**r, "diag": diag}
            except Exception:  # noqa: BLE001 - 诊断坏了不拖垮测试
                pass
        return r

    async def _attach(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        # 诊断并行化——
        # 旧版逐行串行 diagnose_target（死地址每行烧满 timeout，N 死地址
        # 串行 N×timeout，2 死地址实测 9s）；现 gather 并行，墙钟=
        # max(单行诊断) 与 N 无关（2 死地址 → ~6s，3 死地址仍 ~6s）。
        if not rows:
            return []
        return list(await asyncio.gather(*[_attach_one(r) for r in rows]))

    # 列表形态（0 地址 → None，1/2 地址 → 逐地址行），_attach 统一挂诊断。
    # 四族 _attach 并行——
    # 旧版 dict 字面量内逐族 await（+ sglang_out 先行）= 族间串行：N 族有死
    # 地址时诊断段 N×timeout（2 死地址实测 9s=3s 探测+6s 串行诊断）；
    # 现单 gather，诊断段=max(单族诊断) 与族数无关。
    matrix_out, controller_out, sglang_out, gateway_out = await asyncio.gather(
        _attach([{"url": u, **r} for u, r in zip(matrix_urls, matrix_rows)]),
        _attach(
            [
                {"url": u, **r}
                for u, r in zip(controller_urls, controller_rows)
            ]
        ),
        _attach([{"url": u, **r} for u, r in zip(sglang_urls, sglang_rows)])
        if sglang_urls
        else asyncio.sleep(0, result=None),
        _attach([{"url": u, **r} for u, r in zip(_gw_urls, gateway_rows)])
        if _gw_urls
        else asyncio.sleep(0, result=[]),
    )

    return {
        "matrix": matrix_out,
        "controller": controller_out,
        "sglang": sglang_out,
        # Higress 探测行（未配置=空列表）。诊断面，不参与重排。
        "gateway": gateway_out,
    }


# 防抖滞回：当前生效地址可达时，挑战者必须「明显更快」才切换——
# 差值 > max(100ms, 当前 30%)，防内/外网延迟抖动时来回翻。
_HYSTERESIS_MIN_MS = 100.0
_HYSTERESIS_RATIO = 0.3


def _select_and_mark(
    kind: str, rows: List[Dict[str, Any]], pinned_url: str | None = None
) -> str:
    """延迟排序选最优并写 working cache。返回选中的 url（无则 ""）。

 排序资格 = http_ok（状态码 <400）——401/403 是「已连通但
 未鉴权」，当选生效地址会让真实请求吃 401，不能入选。
 """
    ok_rows = [
        r
        for r in rows
        if r.get("ok") and r.get("http_ok") and r.get("ms") is not None
    ]
    if not ok_rows:
        return ""
    # 固定档——显示层跟固定值（即使另一条更快）；固定
    # 地址本轮不可达 → 回退最快可达（对用户诚实：显示「固定地址挂了」）。
    # 请求层仍拨固定地址并在失败时报错——两层不混。
    if pinned_url:
        pinned_row = next(
            (r for r in ok_rows if r["url"] == pinned_url), None
        )
        if pinned_row is not None:
            _mark_working(kind, pinned_url)
            return pinned_url
    best = min(ok_rows, key=lambda r: r["ms"])
    cache = _working_cache()
    current = cache.get(kind, "")
    if current:
        cur_row = next((r for r in ok_rows if r["url"] == current), None)
        if cur_row is None:
            # 当前生效地址本轮不可达 → 切最快
            _mark_working(kind, best["url"])
            return best["url"]
        if best["url"] != current:
            gap = cur_row["ms"] - best["ms"]
            threshold = max(
                _HYSTERESIS_MIN_MS, _HYSTERESIS_RATIO * cur_row["ms"]
            )
            if gap <= threshold:
                return current  # 差异不显著，保持（防抖）
    _mark_working(kind, best["url"])
    return best["url"]


async def refresh_effective(
    cfg: Dict[str, Any], kinds: tuple = ("matrix", "controller")
) -> Dict[str, str]:
    """并行探测地址（测延迟），按「最快可达」更新 working cache。

 旧逻辑=按配置顺序取第一个可达（顺序即优先级，不测延迟、不重排）——
 切网后旧地址仍可达时会一直用慢路径。现在：后台自适应周期自动重排，
 外网/内网切换自动识别（延迟差异远超防抖阈值）。
 kinds: 只重排指定类型（后台循环省资源用——单地址类型跳过）。
 """
    from . import router as router_mod  # noqa: PLC0415 - lazy 防循环依赖

    token = (cfg.get("controller_token") or "").strip()

    def _urls(raw: Any) -> List[str]:
        # 条目 str | {url, auth?}——统一取 url。
        return [config_mod.address_url(u) for u in (raw or []) if config_mod.address_url(u)]

    matrix_urls = _urls(cfg.get("matrix_homeservers")) if "matrix" in kinds else []
    controller_urls = _urls(cfg.get("controller_urls")) if "controller" in kinds else []
    # SGLang 双地址纳入自动重排（外/内网切换自动识别，与 matrix/controller 同机制）。
    sglang_urls = (
        _urls((cfg.get("sglang") or {}).get("urls")) if "sglang" in kinds else []
    )
    if not matrix_urls and not controller_urls and not sglang_urls:
        return {}
    # 覆盖凭据随探测下发——WAN 门地址带凭据探测才可能
    # 200，自动重排才选得上（不带=恒 401，永远轮不上）。
    auth_maps = {
        "matrix": config_mod.build_auth_map(cfg.get("matrix_homeservers")),
        "controller": config_mod.build_auth_map(cfg.get("controller_urls")),
        "sglang": config_mod.build_auth_map((cfg.get("sglang") or {}).get("urls")),
    }
    results = await test_addresses(
        matrix_urls, controller_urls, sglang_urls, token, 4.0,
        auth_maps=auth_maps,
    )
    effective: Dict[str, str] = {}
    if "matrix" in kinds:
        picked = _select_and_mark("matrix", results["matrix"], router_mod._pinned_url(cfg, "matrix"))
        if picked:
            effective["matrix"] = picked
    if "controller" in kinds:
        picked = _select_and_mark("controller", results["controller"], router_mod._pinned_url(cfg, "controller"))
        if picked:
            effective["controller"] = picked
    if "sglang" in kinds and results.get("sglang"):
        picked = _select_and_mark("sglang", results["sglang"], router_mod._pinned_url(cfg, "sglang"))
        if picked:
            effective["sglang"] = picked
    return effective



# ── re-export 壳（拆分后原路径仍可达；单测 monkeypatch 目标是
# 本模块属性，调用时解析与拆分前一致）。──
from .selfcheck_levels import (  # noqa: E402
    _run_l3_l4,
    run_all,
    run_l0,
    run_l1,
    run_l2,
    run_l3,
    run_l4,
)
from .selfcheck_probes import (  # noqa: E402
    _FAKE_IP_HINTS,
    _challenge_hint,
    _classify_challenge,
    _classify_error,
    _client_env,
    _failing_process_identity,
    _ip_hint_cache,
    _probe_controller,
    _probe_gateway,
    _probe_matrix,
    _probe_sglang,
    _probe_with_retry,
    _resolve_ip_hint,
    _resolve_ip_hint_uncached,
    diagnose_target,
)
