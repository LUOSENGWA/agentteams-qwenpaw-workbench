# -*- coding: utf-8 -*-
"""KB 域 SWR 刷新/存储入口（ctx 携带 per-build inflight 单飞状态）。

自 routers/kb_api.py build_kb_router 原体搬移；_kb_probe_signature 与
_spawn_kb_refresh 携带 per-build 状态/绑定，SWR 注册表
（_KB_PREWARM_HOOKS/_KB_PROBE_HOOKS）经 router_mod 调用时属性读
（单测假注入 / 启动预热均解析同一表对象）。
"""
from __future__ import annotations

import asyncio
import time
from typing import Any, Dict, List, Optional

from fastapi import HTTPException

from .. import config as config_mod
from .. import kb_cache
from .. import router as router_mod
from ..dial_gate import bg_slot
from ..router import (
    _kb_agents_cache,
    _kb_file_cache,
    _kb_graph_cache,
    _kb_merged_cache,
    _kb_prewarm_agent,
    _kb_tree_cache,
    _KB_AGENTS_TTL_SECONDS,
    _KB_FILE_TTL_SECONDS,
    _KB_GRAPH_TTL_SECONDS,
    _KB_MERGED_TTL_SECONDS,
    _KB_TREE_TTL_SECONDS,
    kb_swr_ttl_for,
    logger,
)
from .kb_core import (
    _KB_AGENT_RE,
    _kb_find_list,
    _kb_require_token,
    _kb_tar_list,
)
from .kb_workspace import _kb_docker_available, _kb_workspace


# ── SWR 刷新/存储助手（tree/graph/agents 共用）──
# 单飞：同 key 刷新任务在飞不重复起；刷新失败保旧值（磁盘缓存不覆写）。
# _kb_swr_ttl_now() = 磁盘 stale 阈值（超过 → 触发后台刷新；未超旧值
# 也先回，SWR 语义；起随 address_mode 自适应
# wan=180s / 其余 60s）；内存缓存 TTL 以现有常量为准对齐（tree 30s /
# graph 60s / agents 60s）。

def _kb_swr_ttl_now() -> float:
    """SWR TTL 随生效网路自适应（见
 kb_swr_ttl_for）。配置读取走 load_config 读缓存（零磁盘）；异常回退
 内网值（TTL 不是安全边界，降级无害）。"""
    try:
        return kb_swr_ttl_for(
            config_mod.load_config().get("address_mode") or "auto")
    except Exception:  # noqa: BLE001
        return 60.0

# ── 轻探针（变更检测——变才刷）──────────
# 刷新门前先跑轻探针：只列条目元数据（name/mtime/size，绝不读文件
# 内容）。签名一致 → 只重置 60s 时钟（零深扫）；不一致/失败 → 深扫
# （安全）。目录集 = tree 同款数据源（ws 顶层 + memory/ + digest/）。
# 列取复用 tree 计算体同款双通道（find 主=零下载 + tar 兜底，参考其
# 状态码/降级处理）——纯 archive 在大工作区（实测 180MB）必 413，
# 探针将恒 None、优化失效，故以 tree 实际通道为准。
async def _kb_probe_signature(ctx: Dict[str, Any], agent: str) -> Optional[str]:
    """KB 轻探针——只列工作区顶层 +
 memory/ + digest/ 的条目元数据（name/mtime/size），不读文件内容。
 签名=排序后的 sha1；任何失败 → None（调用方退回深扫，安全）。
 复用 tree 计算体里同款 archive 列目录通道（参考其状态码/降级处理）。
 """
    if not _KB_AGENT_RE.match(agent):
        return None  # 与端点同款正则（agents 刷新 agent="" → 无探针）
    try:
        token, base = _kb_require_token()
    except HTTPException:
        return None
    container = (
        "agentteams-manager" if agent == "manager"
        else f"agentteams-worker-{agent}"
    )
    # 预探可用性沿用 _kb_docker_available（与 tree 同款）；失败 → None。
    if not await _kb_docker_available(ctx, token, base, container):
        return None
    try:
        ws = await _kb_workspace(ctx, token, base, agent)
    except HTTPException:
        return None
    parts: List[str] = []
    for sub in ("ws", "memory", "digest"):
        target = ws if sub == "ws" else f"{ws}/{sub}"
        maxdepth = 1 if sub == "ws" else None
        entries = None
        try:
            entries = await _kb_find_list(
                token, base, container, target, maxdepth=maxdepth)
            if entries is None:  # find 通道挂 → tar 兜底（tree 同款）
                entries = await _kb_tar_list(
                    token, base, container, target,
                    maxdepth=maxdepth, include_dirs=True)
        except Exception:  # noqa: BLE001 - 通道异常（413/502/连接错）
            # 一律按探针失败处理（退回深扫，安全）。
            entries = None
        if entries is None:
            if sub == "digest":
                entries = []  # digest 缺失不报错（tree 同款 continue）
            else:
                return None  # ws 顶层 / memory 不可用 → 深扫（安全）
        for e in entries:
            parts.append(
                f"{sub}/{e['rel']}|{e['type']}|{e['size']}|{e['mtime']}"
            )
    import hashlib as _hashlib
    return _hashlib.sha1(
        "\n".join(sorted(parts)).encode("utf-8")
    ).hexdigest()

def _store_kb(agent: str, payload: Dict[str, Any], kind: str,
              probe: Optional[str] = None) -> None:
    """SWR 内存+磁盘同点写（端点冷取与后台刷新共用）。

 语义保留：#1208 WSF 兜底 payload（标记
 source:"controller"，见 _kb_tree_wsf_fallback）不写任何缓存——
 单点收口在此，后台刷新同样不会用降级值污染磁盘缓存。

 probe = 本次深扫时的轻探针签名；
 非 None 时一并落盘（下轮刷新门「变才刷」的比对基准）。端点冷取
 路径不跑探针（传 None）→ 不记，由下轮后台刷新的深扫补记。
 """
    if kind == "tree" and payload.get("source") == "controller":
        return
    # file 的 WSF 兜底 payload 同样
    # 不缓存（14.7 不变式扩展到 file 支）。
    if kind == "file" and payload.get("source") == "controller":
        return
    if kind == "tree":
        _kb_tree_cache[agent] = (
            time.monotonic() + _KB_TREE_TTL_SECONDS, payload
        )
        kb_cache.save(f"tree-{agent}", payload)
    elif kind == "graph":
        _kb_graph_cache[agent] = (
            time.monotonic() + _KB_GRAPH_TTL_SECONDS, payload
        )
        kb_cache.save(f"graph-{agent}", payload)
    elif kind == "merged":  # ：键=csv
        _kb_merged_cache[agent] = (
            time.monotonic() + _KB_MERGED_TTL_SECONDS, payload
        )
        kb_cache.save(f"merged-{agent}", payload)
        return  # 不记 last-agent / 探针（csv 非 agent 名）
    elif kind == "file":  # ：键=agent/path
        _a, _, _p = agent.partition("/")
        _kb_file_cache[f"file-{_a}-{_p}"] = (
            time.monotonic() + _KB_FILE_TTL_SECONDS, payload
        )
        kb_cache.save(f"file-{_a}-{_p}", payload)
        return  # 不记 last-agent / 探针
    else:  # agents：agent 无关单键，不记 last-agent（仅 tree/graph
        # 访问计「上次访问」）
        _kb_agents_cache["agents"] = (
            time.monotonic() + _KB_AGENTS_TTL_SECONDS, payload
        )
        kb_cache.save("agents", payload)
        return
    kb_cache.save("last-agent", {"agent": agent})
    # 记本次深扫的轻探针签名（端点
    # 冷取不跑探针 → probe=None 不记，下轮后台刷新补记）。agents 支
    # 已早退且 agent="" 探针恒 None → 天然不记。
    if probe is not None:
        kb_cache.save_probe(f"{kind}-{agent}", probe)

def _spawn_kb_refresh(ctx: Dict[str, Any], kind: str, agent: str) -> None:
    """SWR 后台单飞刷新（fire-and-forget；调用路径零等待）。

 计算体调用时从模块级注册表 _KB_PREWARM_HOOKS 解析（单测可换假
 计算体；T9 _ctl_get 同款唯一注入点）。
 """
    key = f"{kind}-{agent}" if agent else kind
    t = ctx["inflight"].get(key)
    if t is not None and not t.done():
        return
    compute = router_mod._KB_PREWARM_HOOKS.get(kind)
    if compute is None:
        return  # 注册表未填（build_router 未完成）→ 跳过
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:  # pragma: no cover - 防御（T9 教训：无循环
        # 时先查循环再建协程，避免悬挂 coroutine 警告）
        logger.debug("kb %s refresh: no running event loop, skip", kind)
        return

    async def _run() -> None:
        try:
            # 后台共用通道——执行期
            # 持锁（与两路 sweep 共享，同一时刻至多一路后台扫描）；
            # 前台忙让权/等锁超时 → 本轮放弃（单飞槽位由 finally
            # 释放，下轮重试）。
            async with bg_slot() as _bg:
                if not _bg:
                    return
                # 变才刷——轻探针与上次
                # 签名一致 → 只重置 60s 时钟，零深扫；不一致/探针失败 →
                # 深扫（安全）。探针经注册表调用时解析（单测假注入）。
                probe_fn = router_mod._KB_PROBE_HOOKS.get("probe") or (lambda a: _kb_probe_signature(ctx, a))
                probe = await probe_fn(agent)
                if probe is not None and kb_cache.load_probe(key) == probe:
                    kb_cache.touch(key)
                    return
                # agents 计算体无参（单键 agent 无关）；tree/graph 带 agent。
                payload = (
                    await compute() if kind == "agents" else await compute(agent)
                )
                _store_kb(agent, payload, kind, probe=probe)
        except Exception as exc:  # noqa: BLE001 - 后台刷新失败保旧
            logger.debug("kb %s refresh failed for %s: %s", kind, agent, exc)
        finally:
            ctx["inflight"].pop(key, None)
    ctx["inflight"][key] = loop.create_task(_run())

def _kb_prewarm_last(payload: Optional[Dict[str, Any]]) -> None:
    """/kb/agents 响应后后台预热 last-agent 的
 tree+graph——外网「打开知识库」时缓存大概率已暖（首屏 graph 冷读
 3–5s 的 WAN 往返）。last-agent 缺失/非 dict/空名/不在本次清单
 （防预热已删除的 agent）→ 静默跳过；单飞由 _spawn_kb_refresh 的
 _kb_inflight 保证（重复 /kb/agents 请求在飞即跳过）；异常全吞
 （预热失败不得影响主响应）。"""
    try:
        hit = kb_cache.load("last-agent")
        if hit is None:
            return
        meta = hit[1]
        agent = meta.get("agent") if isinstance(meta, dict) else None
        if not isinstance(agent, str) or not agent:
            return
        names = {
            str(a.get("name") or "")
            for a in ((payload or {}).get("agents") or [])
            if isinstance(a, dict)
        }
        if agent not in names:
            return
        asyncio.create_task(_kb_prewarm_agent(agent))
    except Exception as exc:  # noqa: BLE001
        logger.debug("kb last-agent prewarm skipped: %s", exc)
