# -*- coding: utf-8 -*-
# v0.5.0-beta.14.13（UIPERF-T20·屎山治理）：Controller JSON 客户端单一实现。
# 合并自 router._ctl_json（超集语义）与 worker_status._ctl_get（GET 包装）——
# 此前「ordered 地址 failover」逻辑双实现，现唯一实现在此；两处旧调用点
# 均保留为薄包装（注入点/调用面语义不变）。
"""v0.5.0-beta.14.13（UIPERF-T20·屎山治理）：Controller JSON 客户端单一实现。

- ``router.build_router`` 的 ``_ctl_json`` 闭包 → 薄包装（调用点零改动）。
- ``worker_status._ctl_get`` → 薄包装（projects_workflow 与测试的既有
  取数注入点，保持本名，语义不变）。
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional

# 本模块自建 logger（原实现走 router 模块 logger；可观测语义不变）。
logger = logging.getLogger("agentteams_connector.ctl_client")


async def ctl_json(method: str, url: str, token: str,
                   json_body: Optional[Dict[str, Any]] = None) -> tuple:
    """通用 Controller JSON 调用。返回 (status_code, 解析 JSON|str, 原始 text)。

    v0.5.0-beta.14.2（F1 外网 401 真根因③）：单地址直拨改 ordered 地址
    failover——同 _kb_docker：拆出 url 的 path（含 query），在 ordered
    控制器地址上依次试；200 即止；4xx/5xx/传输错 → 下一地址；全败 →
    返回最后一个 (status, json, text)（调用方按 st 判降级），全传输错 →
    旧 (0, {}, "请求失败：…")。
    """
    # v0.5.0-beta.14.13：router._ctl_json 闭包体逐行迁入——惰性 import
    # 照原样保留（_h 原实现即未再引用，逐字保真不删）。
    import httpx as _h
    from urllib.parse import urlparse as _urlparse
    # 防循环：router 亦经薄包装惰性 import 本模块，双方均不在模块级互引。
    # 拨号原语（_ordered_addresses / _headers_for / GatedAsyncClient /
    # should_failover_status）一律经 router 模块命名空间在**调用时**解析——
    # 与原闭包的全局名解析方式一致，既有测试注入点
    # （monkeypatch "agentteams_connector.router.GatedAsyncClient"）不变。
    from . import config as _c
    from . import router as _r

    cfg = _c.load_config()
    urls = [u.rstrip("/") for u in _r._ordered_addresses(cfg, "controller")]
    if not urls:
        urls = [url.rsplit("/api/", 1)[0]]
    p = _urlparse(url)
    path_and_query = (p.path or "") + (f"?{p.query}" if p.query else "")
    last: Optional[tuple] = None
    for b in urls:
        u = f"{b}{path_and_query}"
        try:
            async with _r.GatedAsyncClient(timeout=30.0, verify=False) as client:
                r = await client.request(
                    method, u,
                    json=json_body,
                    # v0.5.0-beta.14.3: 该地址覆盖凭据（无则原生 Bearer）。
                    headers=_r._headers_for(
                        cfg, "controller", b,
                        {"Authorization": f"Bearer {token}"},
                    ),
                )
        except Exception as exc:  # noqa: BLE001 - try the next address
            last = (0, {}, f"请求失败：{exc}")
            continue
        try:
            data = r.json()
        except Exception:  # noqa: BLE001
            data = {}
        if r.status_code == 200:
            return r.status_code, data, r.text
        if not _r.should_failover_status(r.status_code):
            # v0.5.0-beta.14.6（R4）：确定性 4xx 地址无关——立即返回。
            return r.status_code, data, r.text
        last = (r.status_code, data, r.text)
    if last is None:
        return 0, {}, "请求失败：无可用地址"
    return last
