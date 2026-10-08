from __future__ import annotations

import asyncio

from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from .. import __version__, config as config_mod, selfcheck
from ..dial_gate import GatedAsyncClient
from ..router import (
    _headers_for,
    _mark_working,
    _ordered_addresses,
    _pinned_note,
)


def build_status_router() -> APIRouter:
    """状态/监控域子路由（build_router 原段逐字搬移，任务 190）。"""
    router = APIRouter()
    @router.get("/health")
    async def health() -> Dict[str, Any]:
        """L0 probe: backend alive + plugin version."""
        return {"ok": True, "plugin": "agentteams-qwenpaw-workbench", "version": __version__}

    @router.get("/debug/tasks")
    async def debug_tasks() -> Dict[str, Any]:
        """v0.5.0-beta.14.12：asyncio 任务清单（按协程名聚合）
 ——CPU 吃满/疑似循环类问题的第一诊断（看谁在反复跑）。零副作用。"""
        import collections as _col  # noqa: PLC0415

        tasks = asyncio.all_tasks()
        agg = _col.Counter()
        for t in tasks:
            try:
                n = t.get_coro().__qualname__
            except Exception:  # noqa: BLE001
                n = "?"
            agg[n] += 1
        return {
            "ok": True,
            "total": len(tasks),
            "byCoroutine": dict(agg.most_common(30)),
        }

    @router.get("/workers-status")
    async def workers_status(refresh: int = 0) -> Dict[str, Any]:
        """v0.5.0-beta.14.9：Worker session 状态聚合（前端一次
 拿全量；数据由 worker_status 后台 30s 扫描维护，过期时本端点触发
 后台补扫、零等待返回上轮快照）。

 v0.5.0-beta.14.12：?refresh=1 → 无视 TTL 触发后台
 补扫（前端手动刷新按钮用；仍 fire-and-forget 零等待返回当前快照，
 响应字段不变）。
 """
        from .. import worker_status  # noqa: PLC0415

        worker_status.ensure_fresh(force=bool(refresh))
        return worker_status.snapshot()

    @router.get("/projects-workflow")
    async def projects_workflow_snapshot(refresh: int = 0) -> Dict[str, Any]:
        """v0.5.0-beta.14.9：项目+工作流取数聚合（前端一次拿
 {projects, workflows} 原始件；数据由后台 30s 扫描维护，过期时本端点
 触发后台补扫、零等待返回上轮快照）。

 v0.5.0-beta.14.12：?refresh=1 → 无视 TTL 触发后台
 补扫（前端手动刷新按钮用；仍 fire-and-forget 零等待返回当前快照，
 响应字段不变）。
 """
        from .. import projects_workflow  # noqa: PLC0415

        projects_workflow.ensure_fresh(force=bool(refresh))
        return projects_workflow.snapshot()

    @router.get("/sglang/loads")
    async def sglang_loads() -> Dict[str, Any]:
        """可选模块：集群负载（L1 专属，增强版）。

 SGLang /v1/loads 每 DP rank 返回 num_running_reqs/num_waiting_reqs/
 token 用量/utilization（源码已查证：SC/sglang-latest
 entrypoints/v1_loads.py + managers/load_snapshot.py LoadSnapshot）。
 未启用（config.sglang.enabled=false）→ 404 = 模块不存在语义，前端
 不渲染卡片。启用后代理 SGLang 地址，解析核心字段返回。
 """
        import httpx as _httpx

        cfg = config_mod.load_config()
        sglang = cfg.get("sglang") or {}
        if not sglang.get("enabled"):
            raise HTTPException(
                status_code=404,
                detail="集群负载模块未启用（配置页开启并填写 SGLang 地址）",
            )
        # v0.5.0-beta.12: 双地址（内网/外网）failover——working cache 优先（自动重排
        # 选出的最快可达），其余按配置顺序；兼容旧配置单地址 "url"。
        # v0.5.0-beta.14.3: 条目 str | {url, auth?}——统一取 url（auth 按 url 反查）。
        bases = [
            config_mod.address_url(u).rstrip("/")
            for u in (sglang.get("urls") or [])
            if config_mod.address_url(u)
        ]
        legacy = str(sglang.get("url") or "").strip().rstrip("/")
        if legacy and legacy not in bases:
            bases.append(legacy)
        ordered = (
            _ordered_addresses(
                {"sglang": {"urls": bases}, "address_mode": cfg.get("address_mode")},
                "sglang",
            )
            or bases
        )
        if not ordered:
            raise HTTPException(
                status_code=502, detail="未配置 SGLang 地址"
            )
        payload = None
        last_err = "无可用地址"
        for base in ordered:
            try:
                async with GatedAsyncClient(timeout=8.0, verify=False) as client:
                    # v0.5.0-beta.14.3: WAN 地址 key 门（bearer 覆盖；无则无头）。
                    resp = await client.get(
                        f"{base}/v1/loads",
                        headers=_headers_for(cfg, "sglang", base, {}),
                    )
                if resp.status_code != 200:
                    last_err = f"{base} HTTP {resp.status_code}"
                    continue
                payload = resp.json()
                _mark_working("sglang", base)
                break
            except Exception as exc:  # noqa: BLE001 - 网络错误换下一地址
                last_err = f"{base} {selfcheck._classify_error(exc)}"
        if payload is None:
            raise HTTPException(status_code=502, detail=f"SGLang 全部地址失败：{last_err}{_pinned_note(cfg)}")

        loads = payload.get("loads") or []
        # 提取前端需要的核心字段（dp_rank 维度）。
        ranks = []
        for l in loads:
            if not isinstance(l, dict):
                continue
            # 显存段（memory section）——旧版 /v1/loads 无此段时整组 0
            mem = l.get("memory")
            mem_ok = isinstance(mem, dict)
            ranks.append(
                {
                    "dp_rank": int(l.get("dp_rank") or 0),
                    "num_running_reqs": int(l.get("num_running_reqs") or 0),
                    "num_waiting_reqs": int(l.get("num_waiting_reqs") or 0),
                    "num_used_tokens": int(l.get("num_used_tokens") or 0),
                    "num_total_tokens": int(l.get("num_total_tokens") or 0),
                    # KV 池容量（max_total_num_tokens）——num_total_tokens 是在途请求
                    # token 总量（SGLang load_snapshot.LoadSnapshot），不是池容量，
                    # 单请求时与 num_used_tokens 相等，当分母显示会假满（2026-08-19 bug）。
                    # 旧版 /v1/loads 无此字段时为 0，前端隐藏分母。
                    "pool_total_tokens": int(l.get("max_total_num_tokens") or 0),
                    # 并发上限（0=旧版无字段，前端隐藏 "/cap"）
                    "max_running_requests": int(l.get("max_running_requests") or 0),
                    "token_usage": float(l.get("token_usage") or 0),
                    "utilization": float(l.get("utilization") or 0),
                    "cache_hit_rate": float(l.get("cache_hit_rate") or 0),
                    "gen_throughput": float(l.get("gen_throughput") or 0),
                    # 显存分段（memory section，/v1/loads 默认 include=all 全返回；
                    # 旧版无段时全 0，前端整行隐藏）
                    "mem_weight_gb": float(mem.get("weight_gb") or 0) if mem_ok else 0.0,
                    "mem_kv_gb": float(mem.get("kv_cache_gb") or 0) if mem_ok else 0.0,
                    "mem_graph_gb": float(mem.get("graph_gb") or 0) if mem_ok else 0.0,
                    "mem_token_capacity": int(mem.get("token_capacity") or 0) if mem_ok else 0,
                }
            )
        return {
            "ok": True,
            "timestamp": payload.get("timestamp") or "",
            "accelerator": payload.get("accelerator") or "",
            "num_accelerators": int(payload.get("num_accelerators") or 0),
            "version": payload.get("version") or "",
            "ranks": ranks,
        }

    @router.get("/sglang/models")
    async def sglang_models() -> Dict[str, Any]:
        """模型列表：代理 SGLang OpenAI 兼容 /v1/models（创建 Worker 表单用）。

 历史缺陷：插件创建 Worker 无模型候选（model 自由文本，留空=controller
 默认）→ 拉真实在服模型列表供选择。与 /sglang/loads 同款
 enabled 门 + 双地址 failover；404=模块未启用（前端降级自由输入）。
 """
        import httpx as _httpx

        cfg = config_mod.load_config()
        sglang = cfg.get("sglang") or {}
        if not sglang.get("enabled"):
            raise HTTPException(
                status_code=404,
                detail="SGLang 模块未启用（配置页开启并填写地址）",
            )
        # v0.5.0-beta.14.3: 条目 str | {url, auth?}——统一取 url（auth 按 url 反查）。
        bases = [
            config_mod.address_url(u).rstrip("/")
            for u in (sglang.get("urls") or [])
            if config_mod.address_url(u)
        ]
        legacy = str(sglang.get("url") or "").strip().rstrip("/")
        if legacy and legacy not in bases:
            bases.append(legacy)
        ordered = (
            _ordered_addresses(
                {"sglang": {"urls": bases}, "address_mode": cfg.get("address_mode")},
                "sglang",
            )
            or bases
        )
        if not ordered:
            raise HTTPException(status_code=502, detail="未配置 SGLang 地址")
        last_err = "无可用地址"
        for base in ordered:
            try:
                async with GatedAsyncClient(timeout=8.0, verify=False) as client:
                    # v0.5.0-beta.14.3: WAN 地址 key 门（bearer 覆盖；无则无头）。
                    resp = await client.get(
                        f"{base}/v1/models",
                        headers=_headers_for(cfg, "sglang", base, {}),
                    )
                if resp.status_code != 200:
                    last_err = f"{base} HTTP {resp.status_code}"
                    continue
                payload = resp.json()
                _mark_working("sglang", base)
                data = payload.get("data") or []
                models = [
                    str(m.get("id")) for m in data
                    if isinstance(m, dict) and m.get("id")
                ]
                return {"ok": True, "models": models, "source": base}
            except Exception as exc:  # noqa: BLE001 - 网络错误换下一地址
                last_err = f"{base} {selfcheck._classify_error(exc)}"
        raise HTTPException(
            status_code=502, detail=f"SGLang 全部地址失败：{last_err}{_pinned_note(cfg)}"
        )

    return router
