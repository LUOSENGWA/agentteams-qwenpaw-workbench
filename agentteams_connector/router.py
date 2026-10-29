# -*- coding: utf-8 -*-
"""HTTP router for the AgentTeams QwenPaw Workbench backend plugin.

Mounted by the plugin host under ``/api`` + prefix ``/agentteams-proxy``.
Frontend plugin fetches these same-origin endpoints (no CORS):

- ``GET/PUT /agentteams-proxy/config`` user config (secrets redacted)
- ``GET /agentteams-proxy/config/export`` full config backup (with credentials, user's own restore)
- ``POST /agentteams-proxy/config/import`` full config restore (validate → backup → overwrite)
- ``POST /agentteams-proxy/login`` Matrix m.login.password
- ``POST /agentteams-proxy/selfcheck/{level}`` L0/L1/L2/all
- ``GET /agentteams-proxy/health`` backend liveness + version
- ``GET /agentteams-proxy/team-files`` team shared dir listing (#87, L1)
- ``GET /agentteams-proxy/team-file`` team shared file text preview (#87, L1)
- ``GET /agentteams-proxy/attention`` attention 决策聚合（404→deployed=false 诚实降级；30s 缓存，refresh=1 绕过）
- ``POST /agentteams-proxy/attention/answer`` 人类身份答回（DECISION 行发回任务房间；本地去重 409）
- ``POST /agentteams-proxy/templates/import`` 千锻模板导入（https+host 白名单+ref 白名单；git clone --depth 1 → 本地 pack）
- ``GET /agentteams-proxy/templates`` 模板 pack 列表 + INDEX.yaml 四组解析（单包 parse_error 隔离）
- ``GET /agentteams-proxy/templates/{pack}/file?path=`` 模板单文件只读预览（.md/.yaml + 防穿越）
- ``DELETE /agentteams-proxy/templates/{pack}`` 删除模板 pack（幂等）
- ``GET/PUT /agentteams-proxy/millforge/source`` 千锻源配置（github/gitcode/custom 持久化 + 派生 URL）
- ``POST /agentteams-proxy/millforge/import`` 按源配置导入整包（compiler/core/PHILOSOPHY，≤60MB，整包覆盖）
- ``GET /agentteams-proxy/millforge/packs`` / ``.../packs/{pack}/file`` pack 列表/单文件预览
- ``POST /agentteams-proxy/millforge/compile`` 千锻编译（成功 build 落盘留 20；失败 422 + exit/stage/stderr 摘要）
- ``POST /agentteams-proxy/millforge/inject`` 注入（更新现有 Worker / 新建 Worker + core skill 追加）
- ``POST /agentteams-proxy/millforge/prompt`` 自定义团队「描述需求」提示词（PHILOSOPHY + schema + §十骨架）
- ``POST /agentteams-proxy/millforge/parse-team-json`` LLM JSON 校验（Draft7，逐字段 path+message）
- ``GET /agentteams-proxy/millforge/builds`` / ``.../injections`` 编译/注入历史
- ``{METHOD}/{agentteams-proxy}/{matrix|controller}/{path}`` forwarded

Auto-failover: addresses are ordered lists (LAN first, WAN second). Every
request tries the cached working address first and falls back to the next
one on failure, refreshing the cache on success. One Matrix token works on
both paths (same homeserver behind different network routes).
"""

from __future__ import annotations

import asyncio
import base64
import gzip
import json as _json_mod
import logging
import os
import re
import threading
import time
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, Body, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import __version__, config as config_mod
from . import matrix_client, selfcheck
# KB 端点 SWR 磁盘缓存。
from . import kb_cache
# 全局拨号闸门 + failover 判定 + 计数。
# + 后台扫描共用通道（bg_slot）。
from .dial_gate import GatedAsyncClient, bg_slot, should_failover_status

logger = logging.getLogger("qwenpaw.plugins.agentteams_qwenpaw_workbench")


# Per-process cache of the currently working address, keyed by target kind.
_cache_lock = threading.Lock()
_working_cache: Dict[str, str] = {}  # {"matrix": url, "controller": url}
# Higress Console 管理会话（console_session）过期被动检测
# ——网关面请求带 Cookie 收到 401 = 会话已死（此前前端只见 alias 层静默
# 消失，无人知晓该重新验证）。置位后由 /auth-status 暴露给前端横幅；
# verify-admin 成功（新会话到手）时清零。
_console_session_expired = False
# （F2：实盘反馈「每次升级后 basic 登录状态也没了」——真根因=
# Console 会话 cookie 有服务端 TTL，过期后**只被动判死、无任何自动重登**，
# 每次插件重载/会话过期用户必须手动重验证一次）：用 config 里持久化的
# admin 账密自动重登一次（凭据一直在 config.json，600 权限，不丢）。
# 防风暴三闸：① 冷却窗 60s 内最多一次尝试（网络抖动/凭据错都不连打）
# ② asyncio.Lock 并发合并（同刻 N 个网关请求只触发 1 次登录）
# ③ 400/401/403=凭据错立即停（地址无关，不再逐地址空转）。
_CONSOLE_RELOGIN_COOLDOWN_SECONDS = 60.0
_console_relogin_lock = asyncio.Lock()
_console_last_relogin_attempt = 0.0  # time.monotonic()


def _console_relogin_allowed() -> bool:
    return (
        time.monotonic() - _console_last_relogin_attempt
    ) >= _CONSOLE_RELOGIN_COOLDOWN_SECONDS


async def console_try_relogin(cfg: Dict[str, Any]) -> Optional[str]:
    """：Console 会话自愈重登。

 凭据齐（admin_username/admin_password 已持久化）+ 网关地址可达时，
 用持久账密走 Console /session/login 换新会话（与 /config/verify 路径 A
 同一端点同一语义，抽到 router 层供 gateway 401 与入口自愈共用）：
 成功 → 落盘 console_session + 清 expired 旗 + 返回新会话；
 失败/无凭据/冷却窗内 → None（调用方按既有 no_console_session/401 逻辑
 降级，行为不回退旧版）。
 """
    global _console_last_relogin_attempt
    if not _console_relogin_allowed():
        return None
    async with _console_relogin_lock:
        if not _console_relogin_allowed():  # 锁后双检（并发合并后窗口可能已过）
            return None
        username = str(cfg.get("admin_username") or "").strip()
        password = str(cfg.get("admin_password") or "").strip()
        if not username or not password:
            return None
        gateways = _address_list(cfg, "gateway")
        if not gateways:
            return None
        last_err = "无可用网关地址"
        for base in gateways:
            try:
                async with GatedAsyncClient(timeout=8.0, verify=False) as client:
                    resp = await client.post(
                        f"{base}/session/login",
                        json={"username": username, "password": password},
                    )
            except Exception as exc:  # noqa: BLE001 - 传输错误换下一地址
                last_err = f"{base} {selfcheck._classify_error(exc)}"
                continue
            if resp.status_code in (400, 401, 403):
                # 地址通但凭据错=地址无关——停（不再逐地址空转、不覆盖
                # 已存凭据，等用户手动重新验证）。
                logger.warning(
                    "console auto-relogin: auth rejected (HTTP %s) — "
                    "credentials may have changed; awaiting manual re-verify",
                    resp.status_code,
                )
                _console_last_relogin_attempt = time.monotonic()
                return None
            if resp.status_code not in (200, 201, 204):
                last_err = f"{base} HTTP {resp.status_code}"
                continue
            set_cookie = resp.headers.get("set-cookie", "")
            session = set_cookie.split(";")[0].strip() if set_cookie else ""
            if not session:
                last_err = f"{base} no set-cookie"
                continue
            await asyncio.to_thread(
                config_mod.update_config,
                {"console_session": session},
                "console auto-relogin",
            )
            _console_session_expired = False
            _console_last_relogin_attempt = time.monotonic()
            logger.warning("console auto-relogin: session refreshed via %s", base)
            return session
        _console_last_relogin_attempt = time.monotonic()
        logger.warning("console auto-relogin: all addresses failed (last: %s)", last_err)
        return None
# approval/list 短 TTL 缓存——高频展开/切页时省一整轮容器扫
# 描（原串行全量实测 23s@WAN）；approval_set 成功后主动失效。key=agent 参数
# （""=全量）→ (expiry_monotonic, payload)。只存成功响应。
# 60s：级别变更是低频用户动作，写路径（/approval/set）成功后主动失效缓存，
# 读窗口拉长只省扫描（全量 = 逐容器 docker exec 读 agent.json）。
_APPROVAL_LIST_TTL_SECONDS = 60.0
_approval_list_cache: Dict[str, Any] = {}
# KB tree/graph 结果短 TTL 缓存——一次图谱构建 = 逐 md 文件
# 一次容器 archive 读（实测单容器 381 次），重复访问（切 tab/重渲染）直接命中。
_KB_TREE_TTL_SECONDS = 30.0
_KB_GRAPH_TTL_SECONDS = 60.0
_kb_tree_cache: Dict[str, Any] = {}   # agent -> (expiry_monotonic, payload)
_kb_graph_cache: Dict[str, Any] = {}
# /kb/agents 单键内存门（agent 无关；
# 与 tree/graph 同款 SWR 双层门；conftest 的 *_cache 通用清空覆盖本键）。
_KB_AGENTS_TTL_SECONDS = 60.0
_kb_agents_cache: Dict[str, Any] = {}  # "agents" -> (expiry_monotonic, payload)
# 聚合图谱 + 单文件 30s 内存门——
# merged 冷算 = 8 agent ×（tree+批量读）实测 40.7s，file 重复点开重拉
# 全文；与 tree/graph/agents 同款 SWR 双层门（conftest *_cache 通用清空
# 自动覆盖）。key：merged-<sorted(agents) 逗号连> / file-<agent>-<path>。
_KB_MERGED_TTL_SECONDS = 30.0
_KB_FILE_TTL_SECONDS = 30.0
_kb_merged_cache: Dict[str, Any] = {}  # csv -> (expiry_monotonic, payload)
_kb_file_cache: Dict[str, Any] = {}    # "file-<agent>-<path>" -> (expiry, payload)
# SWR 计算体注册表——build_router() 末尾（return
# router 前）填入 tree/graph/agents 计算体与 _spawn_kb_refresh；端点冷取、
# 后台刷新、启动预热、单测假注入统一在**调用时**读本表（T9 _ctl_get 同款
# 唯一注入点；预热路径不依赖 HTTP 自呼）。
_KB_PREWARM_HOOKS: Dict[str, Any] = {}

# 轻探针唯一注入点——build_router() 末尾填生产
# 探针闭包；单测换假探针（返回固定签名 / None）。探针是 build_router 闭包
# 不可直接 monkeypatch，注册表 + 调用时读取与 _KB_PREWARM_HOOKS 同款
# （T9 _ctl_get 模式）。
_KB_PROBE_HOOKS: Dict[str, Any] = {}


async def _kb_prewarm_agent(agent: str) -> None:
    """启动预热——后台静默补上次访问 agent 的
 tree+graph（注册表未填 = 插件未初始化 → 静默跳过）。"""
    refresh = _KB_PREWARM_HOOKS.get("refresh")
    if not refresh:
        return
    refresh("tree", agent)
    refresh("graph", agent)


def _kb_batch_decode(text: Optional[str]) -> Optional[str]:
    """K1 批量读 GZB1 信封解码——WAN 冷路径
 1.8MB 原文过链路 → gzip+base64 信封（体积 ~5× 收敛，帧语义不变）。
 首行恰为 ``===GZB1===``（新协议）→ 取 magic 行后、最后一个
 ``\\n===END`` 前的 b64（strip）→ b64decode(validate) →
 gzip.decompress → utf-8/replace；无 magic 前缀（旧协议/防御）→
 原样返回；text=None 或信封损坏（b64/gzip 失败、无 ===END 收尾）
 → None（调用方按通道挂处理，回退逐文件路径）。"""
    if text is None:
        return None
    if text.split("\n", 1)[0] != "===GZB1===":
        return text
    rest = text[len("===GZB1===") + 1:]
    end = rest.rfind("\n===END")
    if end == -1:
        return None
    blob = rest[:end].strip()
    try:
        raw = base64.b64decode(blob, validate=True)
        return gzip.decompress(raw).decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        return None


def kb_swr_ttl_for(address_mode: Any) -> float:
    """KB 磁盘 SWR stale 阈值随生效网路自适应。

 外网（address_mode=wan）RTT 高、后台刷新深扫 round-trip 成本高——
 180s 窗口内重复进知识库零后台拨号；内网/自动档 60s（14.11 基线，
 数据新鲜度优先）。非法值按 auto 对待（与 load_config 降级先例一致）。
 """
    return 180.0 if address_mode == "wan" else 60.0


def _kb_apply_runtime_fields(
    found: Dict[str, Dict[str, Any]], workers: List[Any],
) -> None:
    """：kb/agents 的 runtime 判定字段
补全——主（Docker）路径与 ctl 兜底路径共用此唯一实现。

透传 worker 对象的 runtime / runtimeDeprecated（CR 字段）：
- runtime 非空才写键（空串不写，前端按 undefined 降级放行）；
- runtimeDeprecated 真值才写（旧 controller 无该字段 = 键缺失）。

背景（E2E 实锤）：初版只在主路径内联透传，而本部署 Docker 通道对
插件 token 不可用 → /kb/agents 全量走兜底路径 → 兜底面 0 透传、
前端运行时提醒全灭。两路径各写一份=漂移温床，收口为单一函数。
"""
    for w in workers:
        if not isinstance(w, dict):
            continue
        wn = str(w.get("name") or "")
        if not wn or wn not in found:
            continue
        rt = str(w.get("runtime") or "")
        if rt:
            found[wn]["runtime"] = rt
        if w.get("runtimeDeprecated"):
            found[wn]["runtimeDeprecated"] = True


_PROBE_TIMEOUT = 6.0

# 代理超时结构化——旧版标量
# timeout=6.0 把「建连」也算进 6s：切网窗口 LAN IP 不可达时 SYN 被丢，
# 每个请求要卡满 6s×2 次重试才 failover 到公网地址（+12s 冷窗）。connect
# 单独压到 3s 快速识破死地址；read 保留 6s（真实响应慢≠地址死）。
_PROXY_TIMEOUT = httpx.Timeout(connect=3.0, read=6.0, write=10.0, pool=3.0)


def _address_list(cfg: Dict[str, Any], kind: str) -> List[str]:
    # 条目 str | {url, auth?}——统一归一化取 url
    #（dict 条目的 auth 由 _headers_for/auth_for_url 按 url 反查，不在此丢）。
    if kind == "matrix":
        raw = cfg.get("matrix_homeservers") or []
    elif kind == "sglang":
        # SGLang 双地址纳入 working cache 体系（自动重排/failover）。
        raw = (cfg.get("sglang") or {}).get("urls") or []
    elif kind == "gateway":
        # Higress Console 双地址（canonical=gateway_admin_urls，
        # 空则回退 legacy 单值）。
        raw = cfg.get("gateway_admin_urls") or (
            [cfg.get("gateway_admin_url")] if cfg.get("gateway_admin_url") else []
        )
    else:
        raw = cfg.get("controller_urls") or []
    return [config_mod.address_url(v) for v in raw if config_mod.address_url(v)]


def _raw_addresses(cfg: Dict[str, Any], kind: str) -> List[Any]:
    """该 kind 的原始地址条目（str | dict）——供凭据反查。"""
    if kind == "matrix":
        return cfg.get("matrix_homeservers") or []
    if kind == "gateway":
        # Higress Console 双地址（canonical 列表，空则回退
        # legacy 单值）——供凭据反查（同 _address_list 的 gateway 口径）。
        return cfg.get("gateway_admin_urls") or (
            [cfg.get("gateway_admin_url")] if cfg.get("gateway_admin_url") else []
        )
    if kind == "sglang":
        return (cfg.get("sglang") or {}).get("urls") or []
    return cfg.get("controller_urls") or []


def _headers_for(
    cfg: Dict[str, Any], kind: str, base: str, base_headers: Dict[str, str]
) -> Dict[str, str]:
    """单一拨号凭据解析——该地址配置了覆盖凭据则替换
 Authorization，否则原样（服务原生认证）。所有 controller/matrix/sglang
 拨号点统一走这里（新增拨号点照抄这一行，不各写各的）。"""
    auth = config_mod.auth_for_url(_raw_addresses(cfg, kind), base)
    return config_mod.headers_with_auth(auth, base_headers)


def _ordered_addresses(cfg: Dict[str, Any], kind: str) -> List[str]:
    """Cached working address first, then the rest in configured order.

 固定档（lan/wan）= 单元素链——请求层 failover 自然
 退化为「只用固定地址」，失败诚实报错。
 """
    urls = _address_list(cfg, kind)
    if not urls:
        return []
    pinned = _pinned_url(cfg, kind)
    if pinned:
        return [pinned]
    with _cache_lock:
        cached = _working_cache.get(kind)
    if cached and cached in urls:
        return [cached] + [u for u in urls if u != cached]
    return urls


def _mark_working(kind: str, url: str) -> None:
    with _cache_lock:
        _working_cache[kind] = url


# 固定内网/外网——请求只用固定
# 地址、失败诚实报错（_pinned_note 追加到 502 detail），不静默 failover；
# 探测循环照跑（连通性测试显示另一条路径状态）但不影响路由。列表顺序
# 约定=[内网, 外网]（设置页内网/外网两个显式输入框同源）。
_ADDRESS_MODES = ("auto", "lan", "wan")


def _address_mode(cfg: Dict[str, Any]) -> str:
    mode = str(cfg.get("address_mode") or "auto")
    return mode if mode in _ADDRESS_MODES else "auto"


def _pinned_url(cfg: Dict[str, Any], kind: str) -> str | None:
    """固定档下该 kind 唯一使用的地址；auto 档或无地址 → None。"""
    mode = _address_mode(cfg)
    if mode == "auto":
        return None
    urls = _address_list(cfg, kind)
    if not urls:
        return None
    idx = 0 if mode == "lan" else 1
    return urls[idx] if len(urls) > idx else urls[0]


def _pinned_map(cfg: Dict[str, Any]) -> Dict[str, Optional[str]]:
    """四类地址各自的固定值（None=未固定）——供 /config/test 回报显示。"""
    # 固定档映射补 gateway（语义经 _pinned_url 通用）。
    return {k: _pinned_url(cfg, k) for k in ("matrix", "controller", "sglang", "gateway")}


def _pinned_note(cfg: Dict[str, Any]) -> str:
    """固定档诚实报错后缀（追加到用户可见 502 detail）。"""
    mode = _address_mode(cfg)
    if mode == "auto":
        return ""
    label = "内网" if mode == "lan" else "外网"
    return f"｜地址模式=固定{label}：失败不自动切换——请检查该链路或切回自动"


async def _safe_refresh_effective(cfg: Dict[str, Any]) -> None:
    """后台地址探测任务的错误自保。

 保存请求已先行返回（PUT /config 快速路径），后台探测若抛异常没有
 请求上下文可兜底——只记日志（避免 "Task exception was never
 retrieved" 噪音，也不影响用户）。
 """
    try:
        await selfcheck.refresh_effective(cfg)
    except Exception:  # noqa: BLE001 - 后台任务自保
        logger.warning(
            "后台地址探测失败（不影响保存，effective 保持旧值）", exc_info=True
        )


def _ordered_ctl_urls(cfg: Dict[str, Any]) -> List[str]:
    """验证探测顺序——working-cache（最后已知可达）优先、
 其余原序。外网场景 LAN 死地址不再烧首槽（8s 时代「token 验证转圈」的
 主因之一：按配置序 [LAN, WAN] 先拨必死的 LAN）。
 地址归一化改走 _address_list（同全部拨号点）——
 controller_urls 条目支持 str | {url, auth}（WAN 条目常态=带 basic 凭据的
 dict），旧版直接 u.strip() 对 dict 条目抛 AttributeError（verify-admin
 500 真根因；14.20 单测只覆盖 str 形态漏网）。"""
    urls = [u.rstrip("/") for u in _address_list(cfg, "controller") if u]
    with _cache_lock:
        cached = _working_cache.get("controller")
    if cached and cached in urls:
        urls.remove(cached)
        urls.insert(0, cached)
    return urls


def _pick_address(cfg: Dict[str, Any], kind: str) -> str:
    """直拨单地址解析：固定档=固定地址；auto=working cache 优先、
 cache miss 回退列表首个（= 现有语义，零行为变化）。"""
    urls = _address_list(cfg, kind)
    if not urls:
        return ""
    pinned = _pinned_url(cfg, kind)
    if pinned:
        return pinned
    with _cache_lock:
        cached = _working_cache.get(kind)
    return cached if cached in urls else urls[0]


# ── Room aggregation cache (TTL) ───────────────────────────────────────
# One /sync snapshot is expensive-ish and rooms change rarely — cache the
# parsed aggregation for 60s so tab switches feel instant.
_rooms_cache_lock = threading.Lock()
_rooms_cache: Dict[str, Any] = {"data": None, "ts": 0.0}
_ROOMS_CACHE_TTL = 60.0
_workflow_cache: Dict[str, Any] = {"data": None, "ts": 0.0}
_artifacts_cache: Dict[str, Any] = {"data": None, "ts": 0.0}
# /room-mentions 全量扫描结果 10s 缓存（实时增量走 sync_watcher
# 事件缓冲，扫描只做历史 bootstrap——前端按 SSE mention 事件刷新非轮询）。
_room_mentions_cache: Dict[str, Any] = {"data": None, "ts": 0.0}
_room_mentions_lock = threading.Lock()
# /room-approvals 全量扫描结果缓存（同款 bootstrap：
# 实时增量走 sync_watcher 审批缓冲，扫描捞插件关闭期间的未决审批请求）。
# 10s→30s。10s TTL vs 15s 轮询=每轮
# 必 miss（全房扫描≈每 15s 一次）；30s=半数命中。新审批/新 @ 的实时性
# 由 sync_watcher 事件缓冲承担（零延迟，与 TTL 无关）——TTL 只影响
# 「插件关闭期间」历史捞回的刷新粒度，+20s 无产品感知。
_BOOTSTRAP_SCAN_TTL = 30.0
_room_approvals_cache: Dict[str, Any] = {"data": None, "ts": 0.0}

# 逐房扫描态 {rid: {"ts": 已见最新消息 ts,
# "entries": [...]}}。房间无推进（sync watcher 探针）→ 复用条目零重扫；
# 600s 兜底全扫一次（watcher 停摆时防结果静默陈旧）。
_room_scan_state: Dict[str, Any] = {
    "mentions": {}, "approvals": {}, "workflow": {}, "artifacts": {},
    "full_at": {"mentions": 0.0, "approvals": 0.0, "workflow": 0.0, "artifacts": 0.0},
}
_ROOM_SCAN_FULL_EVERY = 600.0

# 房间名模块级缓存——mentions 轮询遇未命名房
# 不再每请求逐行重解析（曾致单次响应 8.9s：每行 ≥2 次 HTTP 兜底）。
_room_name_cache: Dict[str, str] = {}
# 负缓存：解析为空的房间（DM 无 name 态）600s 内不再重试——此前每请求
# 逐行重放 basic+state 两次解析（实测 7 房 ×2 拨号 ×~400ms ≈ 6.6s/请求）。
_room_name_neg: Dict[str, float] = {}


def _scan_should_full(kind: str) -> bool:
    return (time.time() - _room_scan_state["full_at"].get(kind, 0.0)) > _ROOM_SCAN_FULL_EVERY


def _scan_mark_full(kind: str) -> None:
    _room_scan_state["full_at"][kind] = time.time()
_room_approvals_lock = threading.Lock()
# （13.11 「团队管理 tab 刷不出完整信息，手动刷新不
# 行，要等 30s 自动刷新」根因·后端半）：/teams/structure 60s TTL 缓存
# 此前把**首次失败/空树结果也缓存 60s（负缓存）**——token 未就绪时首拉
# 得空树（source=room-fallback 或 []），之后 60s 内手动刷新（force=true
# 可绕过，但旧前端不传 force）全部命中空缓存；30s tick 恰在 TTL 过期后
# miss 重拉才恢复 → 用户感知"只有自动刷新管用"。修法：失败/降级/空树
# 结果只负缓存 _STRUCT_NEGATIVE_TTL（5s），成功（controller-workers 且非
# 空）才享 60s。ttl 随条目存（不同结果不同 TTL），读路径按条目 ttl 判。
_STRUCTURE_NEGATIVE_TTL = 5.0
_structure_cache: Dict[str, Any] = {
    "data": None,
    "ts": 0.0,
    "ttl": _ROOMS_CACHE_TTL,
}


def invalidate_data_caches(reason: str = "") -> None:
    """账号切换 → 清空全部聚合数据缓存。

 rooms/workflow/artifacts/structure 四份缓存都是按登录账号返回的数据
 （同一端点不同账号内容不同），但 TTL key 是全局单例——切账号后手动刷新
 命中的仍是旧账号缓存（用户可见症状），自动刷新要等 TTL 恰好过期才刷新。
 /login 成功与 config.matrix 身份变更时调用（读路径均持 _rooms_cache_lock）。
 """
    with _rooms_cache_lock:
        for c in (
            _rooms_cache,
            _workflow_cache,
            _artifacts_cache,
            _structure_cache,
        ):
            c["data"] = None
            c["ts"] = 0.0
            if "ttl" in c:
                c["ttl"] = _ROOMS_CACHE_TTL
    logger.info("data caches invalidated (%s)", reason or "no reason")


async def _ctl_json(method: str, url: str, token: str,
                    json_body: Optional[Dict[str, Any]] = None) -> tuple:
    """薄包装 → ctl_client.ctl_json（去重）。"""
    from . import ctl_client  # noqa: PLC0415
    return await ctl_client.ctl_json(method, url, token, json_body)

# ── re-export 壳（拆分后原路径仍可达；域模块 `from ..router import X`
# 与本模块内调用时解析均命中同一对象）。须位于下方域导入之前
# （域模块反向导入本模块名，导入执行时本模块须已具备这些名）。──
from .router_models import (  # noqa: E402
    ConfigPatch,
    ConfigTestRequest,
    DmRequest,
    LoginRequest,
    NotifyRequest,
    SearchRequest,
    TokenValidationError,
    VerifyAdminRequest,
    _ADDRESS_ENTRY_LISTS,
    _CONFIG_KEY_TYPES,
    _SECRET_FIELDS_TOP,
    _count_gateway_aliases,
    _find_redacted_placeholders,
    _redacted_entry_errors,
    _resolve_controller_token,
    _sanitize_token,
    _token_or_none,
    _validate_config_shape,
)
from .router_parse import (  # noqa: E402
    CONTROLLER_ALLOWED_PREFIXES,
    MATRIX_ALLOWED_PREFIX,
    _SYNC_FILTER,
    _json_dumps,
    _parse_docker_stream,
    _parse_sync_rooms,
)
# 域子路由装配。此导入须位于上方全部模块级名之后（域模块反向导入本模块
# 共享名，循环导入解析时本模块须已具备这些名）。
from .routers import (  # noqa: E402
    approval_api,
    cluster_info_api,
    coding_cli_latest_api,
    config_api,
    gateway_api,
    kb_api,
    live_api,
    matrix_api,
    node_version_api,
    status_api,
    team_files_api,
    teams_api,
    upgrade_api,
    wechat_qr_api,
    worker_mcp_api,
    worker_plugins_api,
)
# attention 决策域（包根模块，函数内惰性导入 router——无模块级反向依赖，
# 位置不受 re-export 壳约束；固定路径 /attention* 在下方 catch-all 前注册）。
from . import attention_api  # noqa: E402
# 千锻模板导入域（同款包根模块；固定路径 /templates* 在 catch-all 前注册）。
from . import templates_api  # noqa: E402
# 千锻注入域（源配置/导入/编译/注入/prompt/parse；固定路径 /millforge*
# 在 catch-all 前注册）。
from . import millforge_api  # noqa: E402


def build_router() -> APIRouter:
    router = APIRouter()

    # KB 域可变状态由装配方创建、显式传入
    # build_kb_router（原为 build_router 函数局部声明，语义不变）。
    _kb_ws_cache: Dict[str, Dict[str, Any]] = {}  # agent → {ws, ts}（闭包共享）

    # Docker 通道可用性缓存（per 容器，短 TTL）：L2 token 恒 403 / Docker 挂
    # 恒 502——30s 内不重复探，避免 tree/file/ls 每次多打一发 /json。
    _kb_docker_ok_cache: Dict[str, tuple] = {}

    _kb_inflight: Dict[str, Any] = {}

    # ── Fixed endpoints (must be registered before the catch-all) ─────
    router.include_router(status_api.build_status_router())
    router.include_router(teams_api.build_teams_router())
    router.include_router(config_api.build_config_router())
    router.include_router(gateway_api.build_gateway_router())
    router.include_router(matrix_api.build_matrix_router())
    _kb_router, _kb_shared = kb_api.build_kb_router(
        _kb_ws_cache, _kb_docker_ok_cache, _kb_inflight
    )
    router.include_router(_kb_router)
    # #87 团队共享文件（列取/单文件读）——可变状态由装配方创建
    # 显式传入（build_router 每建一次全新，测试隔离随之成立）。
    _tf_state: Dict[str, Any] = {"probe": {}, "shared": {},
                                 "workers": {"data": None, "ts": 0.0}}
    router.include_router(
        team_files_api.build_team_files_router(_kb_shared, _tf_state)
    )
    router.include_router(live_api.build_live_router())
    # 集群信息域（AgentTeams/Higress 版本，L1 only；须在 catch-all 之前）。
    router.include_router(cluster_info_api.build_cluster_info_router())
    # 运行时升级域（同宿主回环代理 /api/upgrade/*；1.2.5+ worker 镜像
    # 内置 agentteams-upgrade 插件；无服务实例 404 → 前端降级空态）。
    # 须在 catch-all 之前（固定路径优先）。
    router.include_router(upgrade_api.build_upgrade_router())
    # 节点版本域（per-node AgentTeams 镜像 tag + docker exec 运行时版本探测；
    # L1 only；须在 catch-all 之前）。
    router.include_router(node_version_api.build_node_version_router())
    # coding CLI 检查更新域（宿主 server-side 查 npm registry latest；
    # L1 only + clis 白名单；须在 catch-all 之前）。
    router.include_router(coding_cli_latest_api.build_coding_cli_latest_router())
    # 15.27 Worker 运行时环境（PID 1 env 预填充正源，只读 L1）。
    from .routers import runtime_env_api
    router.include_router(runtime_env_api.build_runtime_env_router())
    # attention 决策域（读聚合 + 人类身份答回；固定路径，须在 catch-all 前）。
    router.include_router(attention_api.build_attention_router())
    # 千锻模板导入域（git clone templates → 本地 pack 浏览/预览/删除；
    # 固定路径，须在 catch-all 前）。
    router.include_router(templates_api.build_templates_router())
    # 千锻注入域（源配置/导入/编译预览/注入/prompt/parse；固定路径，
    # 须在 catch-all 前）。
    router.include_router(millforge_api.build_millforge_router())
    # 微信 QR 状态直连（iLink 长轮询 ~31s；Controller 频道代理 5s、通用代理
    # 6s 都会掐断）——固定路径 /wechat-qr/status 必须在 catch-all 之前注册。
    router.include_router(wechat_qr_api.build_wechat_qr_router())
    # Worker MCP（CRD 声明 + worker 自注册合并读，只读；Controller 端点
    # 404 → 诚实降级 available=false。须在 catch-all 之前，固定路径优先）。
    router.include_router(worker_mcp_api.build_worker_mcp_router())
    # Worker 插件（worker 已装插件列表只读代理，字段直传无脱敏；
    # Controller 端点 404 → 诚实降级 available=false。须在 catch-all
    # 之前，固定路径优先）。
    router.include_router(worker_plugins_api.build_worker_plugins_router())
    # catch-all 域装配最后（/{target}/{path:path} 位于该域尾部）。
    router.include_router(approval_api.build_approval_router(_kb_shared))
    return router
