# -*- coding: utf-8 -*-
"""coding CLI 检查更新域：宿主侧查 npm registry latest。

10/17 需求（检查更新在插件做、走宿主）：浏览器直连 npm registry 在操作机
内网连不上外网时会恒失败，改由插件后端（宿主，有外网/代理）server-side 查。
宿主也连不上 → 逐 CLI 优雅降级（error 文案，HTTP 恒 200）。

数据面：
- 各 coding CLI 的 npm 包名 = 上游 CliSpec.NpmPackage（正源 =
  worker_coding_cli.go）：qwen-code→@qwen-code/qwen-code /
  opencode→opencode-ai / qoder→@qoder-ai/qodercli。
- latest 版本 = registry ``GET <base>/<pkg>/latest`` 的 version 字段（小载荷，
  低带宽友好；非整包 packument）。
- npm registry latest 是包的全局属性（同一 registry 下与具体 worker 无关），
  故无需 per-worker docker exec；本域仅"提示"，实际升级仍走 worker 容器内
  npm install（Controller #1360 install 端点 = 发指令），install 才是权威。

安全：
- L1 only（管理面，同 node-version / upgrade 域）——无 token 403。
- clis 白名单校验（仅 3 个已知 id，防任意包名 / 路径注入）。
- registry base 固定 npmjs（不开放 query 覆写，避免 SSRF / 任意 URL 探测）。
- verify=False + trust_env=True（与 connector 其余出站一致；trust_env 吃
  HTTP(S)_PROXY 代理 env；只读版本串，失败降级不致命）。
- 5min 结果缓存 + in-flight 去重（latest 慢变；避免连点刷 registry）。
"""
from __future__ import annotations

import asyncio
import time
from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from .. import config as config_mod
from ..dial_gate import GatedAsyncClient
from ..router import _token_or_none

# CLI id → npm 包名（正源 = 上游 worker_coding_cli.go CliSpec.NpmPackage）。
_NPM_PACKAGE: Dict[str, str] = {
    "qwen-code": "@qwen-code/qwen-code",
    "opencode": "opencode-ai",
    "qoder": "@qoder-ai/qodercli",
}
_KNOWN_IDS = tuple(_NPM_PACKAGE)
# 固定 registry base（不开放 query 覆写 → 防 SSRF / 任意 URL）。
_REGISTRY_BASE = "https://registry.npmjs.org/"
_TTL = 300.0        # latest 缓存 5min（慢变事实）
_TIMEOUT = 15.0     # 单 CLI 查 latest 超时（低带宽留余量）


def build_coding_cli_latest_router() -> APIRouter:
    router = APIRouter()

    # 装配方状态（build_router 每建一次全新，测试隔离随装配成立）。
    _cache: Dict[str, tuple] = {}          # cli_id -> (ts, item)
    _inflight: Dict[str, asyncio.Lock] = {}

    async def _fetch_latest(url: str) -> tuple:
        """宿主 server-side 查 registry latest → (version|None, error)。"""
        try:
            async with GatedAsyncClient(
                timeout=_TIMEOUT, verify=False, trust_env=True) as client:
                r = await client.get(url)
        except Exception as exc:  # noqa: BLE001 - 网络失败降级
            return None, f"registry 不可达（{exc.__class__.__name__}）"
        if r.status_code != 200:
            return None, f"registry {r.status_code}"
        try:
            j = r.json()
        except Exception:  # noqa: BLE001 - 非 JSON 降级
            return None, "registry 响应非 JSON"
        ver = j.get("version") if isinstance(j, dict) else None
        if not ver or not isinstance(ver, str):
            return None, "registry 响应无 version"
        return ver, ""

    @router.get("/coding-cli/latest")
    async def coding_cli_latest(
        clis: str = "", refresh: int = 0) -> Dict[str, Any]:
        """宿主侧查各 coding CLI 的 npm registry latest。

        clis = 逗号分隔子集（qwen-code/opencode/qoder），空 = 全部 3 个。
        refresh=1 绕过缓存重查。逐 CLI 失败降级为该项 error（HTTP 恒 200）。
        403 = 无 L1 token；400 = 含未知 CLI id。
        """
        if not _token_or_none(config_mod.load_config()):
            raise HTTPException(
                status_code=403,
                detail="需要 Controller 管理员 token（L1）才能检查更新")
        wanted = [c.strip() for c in (clis or "").split(",") if c.strip()]
        if not wanted:
            wanted = list(_KNOWN_IDS)
        for c in wanted:
            if c not in _NPM_PACKAGE:
                raise HTTPException(status_code=400, detail=f"未知 CLI：{c}")

        items: Dict[str, Any] = {}
        for cid in wanted:
            if not refresh:
                hit = _cache.get(cid)
                if hit and time.time() - hit[0] < _TTL:
                    items[cid] = dict(hit[1])
                    continue
            lock = _inflight.setdefault(cid, asyncio.Lock())
            async with lock:
                hit = _cache.get(cid)
                if not refresh and hit and time.time() - hit[0] < _TTL:
                    items[cid] = dict(hit[1])
                    continue
                pkg = _NPM_PACKAGE[cid]
                url = f"{_REGISTRY_BASE}{pkg}/latest"
                latest, err = await _fetch_latest(url)
                item: Dict[str, Any] = {
                    "cli": cid,
                    "npm_package": pkg,
                    "latest": latest,
                    "registry": _REGISTRY_BASE,
                    "checked_at": time.time(),
                }
                if err:
                    item["error"] = err
                _cache[cid] = (time.time(), item)
                items[cid] = dict(item)
        return {"items": items, "registry": _REGISTRY_BASE}

    return router
