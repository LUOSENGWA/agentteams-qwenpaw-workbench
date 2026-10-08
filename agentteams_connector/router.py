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
# v0.5.0-beta.14.10：KB 端点 SWR 磁盘缓存。
from . import kb_cache
# v0.5.0-beta.14.6：全局拨号闸门 + failover 判定 + 计数。
# v0.5.0-beta.14.12：+ 后台扫描共用通道（bg_slot）。
from .dial_gate import GatedAsyncClient, bg_slot, should_failover_status

logger = logging.getLogger("qwenpaw.plugins.agentteams_qwenpaw_workbench")


def _json_dumps(obj: Any) -> str:
    return _json_mod.dumps(obj, ensure_ascii=False, separators=(",", ":"))

# Matrix paths the proxy will forward (everything else → 400).
MATRIX_ALLOWED_PREFIX = "/_matrix/client/"
# Controller paths the proxy will forward.
CONTROLLER_ALLOWED_PREFIXES = ("/api/", "/healthz")

# Per-process cache of the currently working address, keyed by target kind.
_cache_lock = threading.Lock()
_working_cache: Dict[str, str] = {}  # {"matrix": url, "controller": url}
# v0.5.0-beta.14.19: Higress Console 管理会话（console_session）过期被动检测
# ——网关面请求带 Cookie 收到 401 = 会话已死（此前前端只见 alias 层静默
# 消失，无人知晓该重新验证）。置位后由 /auth-status 暴露给前端横幅；
# verify-admin 成功（新会话到手）时清零。
_console_session_expired = False
# v0.5.0-beta.14.26（F2：实盘反馈「每次升级后 basic 登录状态也没了」——真根因=
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
    """v0.5.0-beta.14.26（F2）：Console 会话自愈重登。

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
                config_mod.update_config, {"console_session": session}
            )
            _console_session_expired = False
            _console_last_relogin_attempt = time.monotonic()
            logger.warning("console auto-relogin: session refreshed via %s", base)
            return session
        _console_last_relogin_attempt = time.monotonic()
        logger.warning("console auto-relogin: all addresses failed (last: %s)", last_err)
        return None
# v0.5.0-beta.14.5: approval/list 短 TTL 缓存——高频展开/切页时省一整轮容器扫
# 描（原串行全量实测 23s@WAN）；approval_set 成功后主动失效。key=agent 参数
# （""=全量）→ (expiry_monotonic, payload)。只存成功响应。
# 60s：级别变更是低频用户动作，写路径（/approval/set）成功后主动失效缓存，
# 读窗口拉长只省扫描（全量 = 逐容器 docker exec 读 agent.json）。
_APPROVAL_LIST_TTL_SECONDS = 60.0
_approval_list_cache: Dict[str, Any] = {}
# v0.5.0-beta.14.7：KB tree/graph 结果短 TTL 缓存——一次图谱构建 = 逐 md 文件
# 一次容器 archive 读（实测单容器 381 次），重复访问（切 tab/重渲染）直接命中。
_KB_TREE_TTL_SECONDS = 30.0
_KB_GRAPH_TTL_SECONDS = 60.0
_kb_tree_cache: Dict[str, Any] = {}   # agent -> (expiry_monotonic, payload)
_kb_graph_cache: Dict[str, Any] = {}
# v0.5.0-beta.14.10：/kb/agents 单键内存门（agent 无关；
# 与 tree/graph 同款 SWR 双层门；conftest 的 *_cache 通用清空覆盖本键）。
_KB_AGENTS_TTL_SECONDS = 60.0
_kb_agents_cache: Dict[str, Any] = {}  # "agents" -> (expiry_monotonic, payload)
# v0.5.0-beta.14.17（KBBATCH-K3/K5）：聚合图谱 + 单文件 30s 内存门——
# merged 冷算 = 8 agent ×（tree+批量读）实测 40.7s，file 重复点开重拉
# 全文；与 tree/graph/agents 同款 SWR 双层门（conftest *_cache 通用清空
# 自动覆盖）。key：merged-<sorted(agents) 逗号连> / file-<agent>-<path>。
_KB_MERGED_TTL_SECONDS = 30.0
_KB_FILE_TTL_SECONDS = 30.0
_kb_merged_cache: Dict[str, Any] = {}  # csv -> (expiry_monotonic, payload)
_kb_file_cache: Dict[str, Any] = {}    # "file-<agent>-<path>" -> (expiry, payload)
# v0.5.0-beta.14.10：SWR 计算体注册表——build_router() 末尾（return
# router 前）填入 tree/graph/agents 计算体与 _spawn_kb_refresh；端点冷取、
# 后台刷新、启动预热、单测假注入统一在**调用时**读本表（T9 _ctl_get 同款
# 唯一注入点；预热路径不依赖 HTTP 自呼）。
_KB_PREWARM_HOOKS: Dict[str, Any] = {}

# v0.5.0-beta.14.11：轻探针唯一注入点——build_router() 末尾填生产
# 探针闭包；单测换假探针（返回固定签名 / None）。探针是 build_router 闭包
# 不可直接 monkeypatch，注册表 + 调用时读取与 _KB_PREWARM_HOOKS 同款
# （T9 _ctl_get 模式）。
_KB_PROBE_HOOKS: Dict[str, Any] = {}


async def _kb_prewarm_agent(agent: str) -> None:
    """v0.5.0-beta.14.10：启动预热——后台静默补上次访问 agent 的
 tree+graph（注册表未填 = 插件未初始化 → 静默跳过）。"""
    refresh = _KB_PREWARM_HOOKS.get("refresh")
    if not refresh:
        return
    refresh("tree", agent)
    refresh("graph", agent)


def _kb_batch_decode(text: Optional[str]) -> Optional[str]:
    """v0.5.0-beta.14.23：K1 批量读 GZB1 信封解码——WAN 冷路径
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
    """v0.5.0-beta.14.22：KB 磁盘 SWR stale 阈值随生效网路自适应。

 外网（address_mode=wan）RTT 高、后台刷新深扫 round-trip 成本高——
 180s 窗口内重复进知识库零后台拨号；内网/自动档 60s（14.11 基线，
 数据新鲜度优先）。非法值按 auto 对待（与 load_config 降级先例一致）。
 """
    return 180.0 if address_mode == "wan" else 60.0


def _kb_apply_runtime_fields(
    found: Dict[str, Dict[str, Any]], workers: List[Any],
) -> None:
    """v0.5.0-beta.14.22（D4 #5/#8）：kb/agents 的 runtime 判定字段
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

# v0.5.0-beta.13.24（首刷 race·根因）：代理超时结构化——旧版标量
# timeout=6.0 把「建连」也算进 6s：切网窗口 LAN IP 不可达时 SYN 被丢，
# 每个请求要卡满 6s×2 次重试才 failover 到公网地址（+12s 冷窗）。connect
# 单独压到 3s 快速识破死地址；read 保留 6s（真实响应慢≠地址死）。
_PROXY_TIMEOUT = httpx.Timeout(connect=3.0, read=6.0, write=10.0, pool=3.0)


def _address_list(cfg: Dict[str, Any], kind: str) -> List[str]:
    # v0.5.0-beta.14.3: 条目 str | {url, auth?}——统一归一化取 url
    #（dict 条目的 auth 由 _headers_for/auth_for_url 按 url 反查，不在此丢）。
    if kind == "matrix":
        raw = cfg.get("matrix_homeservers") or []
    elif kind == "sglang":
        # v0.5.0-beta.12: SGLang 双地址纳入 working cache 体系（自动重排/failover）。
        raw = (cfg.get("sglang") or {}).get("urls") or []
    elif kind == "gateway":
        # v0.5.0-beta.14.7: Higress Console 双地址（canonical=gateway_admin_urls，
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
        # v0.5.0-beta.14.7: Higress Console 双地址（canonical 列表，空则回退
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
    """v0.5.0-beta.14.3: 单一拨号凭据解析——该地址配置了覆盖凭据则替换
 Authorization，否则原样（服务原生认证）。所有 controller/matrix/sglang
 拨号点统一走这里（新增拨号点照抄这一行，不各写各的）。"""
    auth = config_mod.auth_for_url(_raw_addresses(cfg, kind), base)
    return config_mod.headers_with_auth(auth, base_headers)


def _ordered_addresses(cfg: Dict[str, Any], kind: str) -> List[str]:
    """Cached working address first, then the rest in configured order.

 v0.5.0-beta.14.1: 固定档（lan/wan）= 单元素链——请求层 failover 自然
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


# v0.5.0-beta.14.1（address_mode 手动档）：固定内网/外网——请求只用固定
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
    # v0.5.0-beta.14.7：固定档映射补 gateway（语义经 _pinned_url 通用）。
    return {k: _pinned_url(cfg, k) for k in ("matrix", "controller", "sglang", "gateway")}


def _pinned_note(cfg: Dict[str, Any]) -> str:
    """固定档诚实报错后缀（追加到用户可见 502 detail）。"""
    mode = _address_mode(cfg)
    if mode == "auto":
        return ""
    label = "内网" if mode == "lan" else "外网"
    return f"｜地址模式=固定{label}：失败不自动切换——请检查该链路或切回自动"


async def _safe_refresh_effective(cfg: Dict[str, Any]) -> None:
    """v0.5.0-beta.14.12：后台地址探测任务的错误自保。

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
    """v0.5.0-beta.14.20：验证探测顺序——working-cache（最后已知可达）优先、
 其余原序。外网场景 LAN 死地址不再烧首槽（8s 时代「token 验证转圈」的
 主因之一：按配置序 [LAN, WAN] 先拨必死的 LAN）。
 v0.5.0-beta.14.21：地址归一化改走 _address_list（同全部拨号点）——
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


def _count_gateway_aliases(
    routes_body: object, providers_body: object
) -> tuple[int, list[str]]:
    """v0.5.0-beta.12：验证回报——网关 alias 层自检计数。

 解包语义与前端 unwrapHigress 严格一致（Console {code,data} 信封 →
 裸数组 / data.routes / data.providers），谓词只认 EXACT/EQUAL 精确匹配
 且 upstream provider 存在（=可解析下界；modelMapping 派生别名另路，
 此处不重复计）。历史缺陷「还是看不见」= 静默平铺无诊断锚点，
 验证响应直接带回数字与 alias 名，秒定位断点。
 """
    def _list(body: object, key: str) -> list:
        d = body.get("data") if isinstance(body, dict) and "data" in body else body
        if isinstance(d, list):
            return d
        if isinstance(d, dict):
            v = d.get(key)
            if isinstance(v, list):
                return v
        return []

    routes = [r for r in _list(routes_body, "routes") if isinstance(r, dict)]
    provider_names = {
        str(p.get("name"))
        for p in _list(providers_body, "providers")
        if isinstance(p, dict) and p.get("name")
    }
    aliases: set[str] = set()
    for rt in routes:
        ups = [
            str(u.get("provider"))
            for u in (rt.get("upstreams") or [])
            if isinstance(u, dict)
        ]
        for pred in rt.get("modelPredicates") or []:
            if not isinstance(pred, dict):
                continue
            if str(pred.get("matchType", "")).upper() not in ("EXACT", "EQUAL"):
                continue
            v = str(pred.get("matchValue") or "").strip()
            if not v or "*" in v or v.startswith("~"):
                continue
            if any(p in provider_names for p in ups):
                aliases.add(v)
    return len(routes), sorted(aliases)




class LoginRequest(BaseModel):
    user: str = Field(min_length=1)
    password: str = Field(min_length=1)


class DmRequest(BaseModel):
    """DM open request — only the target MXID/localpart is needed."""

    user: str = Field(min_length=1)


class SearchRequest(BaseModel):
    """Matrix 消息全文搜索请求：房间内（roomId）或跨房间（不传）。"""

    term: str = Field(min_length=1, max_length=200)
    roomId: Optional[str] = None
    nextBatch: Optional[str] = None
    limit: int = Field(default=20, ge=1, le=50)


class ConfigPatch(BaseModel):
    config: Dict[str, Any]


class ConfigTestRequest(BaseModel):
    """v0.5.0-beta.12: 连通性测试请求——传表单当前值（可未保存），空则测已配置。

 v0.5.0-beta.14.3: 条目 = str | {url, auth?}（草稿凭据随测——未保存的
 公网凭据也能当场验证；旧字符串条目完全兼容）。
 """

    matrix: Optional[List[Any]] = None
    controller: Optional[List[Any]] = None
    sglang: Optional[List[Any]] = None  # v0.5.0-beta.12: SGLang 双地址列表
    gateway: Optional[List[Any]] = None  # v0.5.0-beta.14.17: Higress 双地址列表


class VerifyAdminRequest(BaseModel):
    """v0.5.0-beta.12: L1 管理员验证二选一（同 dashboard 语义，仅 L1 使用）。

 两条路径（互斥，优先密码）：
 - admin_username + admin_password → POST {gateway}/session/login
 （Console 单操作员登录；成功 → 持有 Console 管理员会话，
 供网关面 AI routes/providers 消费 = 模型选择 alias 层数据源）。
 - controller_token → GET {controller}/api/v1/teams Bearer（v0.5.0-beta.12：
 去尾斜杠——Controller 的 Gin 对 /api/v1/teams/ 返回 404，与
 dashboard f1f2 同款坑；无斜杠才进鉴权门，401=token 无效）
 （现状 L1 全量 Controller 管理 API 凭据，语义不变）。
 """

    admin_username: Optional[str] = None
    admin_password: Optional[str] = None  # "***" = 用已存值（脱敏占位符语义）
    controller_token: Optional[str] = None  # "***" = 用已存值
    # 留空 = 回退 config 已存值；config 也空 → 可操作错误（v0.5.0-beta.12：
    # Console 宿主端口部署时自选、人人不同，不做端口探测）
    gateway_admin_url: Optional[str] = None
    # v0.5.0-beta.14.7: Higress 双地址（列表优先；单项亦可）。
    gateway_admin_urls: Optional[List[str]] = None


# ── v0.5.0-beta.14.14：/config/import schema 级校验 ──────────

# 已知顶层键 → 期望类型（None 值与 load_config 同语义=缺省，跳过；
# 未知键放行——老导出在新版导入的前向兼容）。
_CONFIG_KEY_TYPES: Dict[str, type] = {
    "matrix_homeservers": list,
    "controller_urls": list,
    "gateway_admin_urls": list,
    "controller_token": str,
    "admin_username": str,
    "admin_password": str,
    "gateway_admin_url": str,
    "console_session": str,
    "address_mode": str,
    "console_effects": str,
    "console_calm": bool,
    "sglang": dict,
    "matrix": dict,
}

# 顶层明文凭据字段（值为 "***" = 误贴了脱敏导出——直接拒，防占位符覆盖真实
# 凭据；地址条目级 auth 的占位符由下方 _redacted_entry_errors 覆盖）。
_SECRET_FIELDS_TOP = ("controller_token", "admin_password", "console_session")

_ADDRESS_ENTRY_LISTS = ("matrix_homeservers", "controller_urls", "gateway_admin_urls")


def _redacted_entry_errors(entries: Any, where: str) -> List[str]:
    """地址条目列表内的 auth.password/auth.token = "***" → 错误位置列表。"""
    bad: List[str] = []
    if not isinstance(entries, list):
        return bad
    for i, entry in enumerate(entries):
        if not isinstance(entry, dict):
            continue
        auth = entry.get("auth")
        if not isinstance(auth, dict):
            continue
        for f in ("password", "token"):
            if auth.get(f) == "***":
                bad.append(f"{where}[{i}].auth.{f}")
    return bad


def _find_redacted_placeholders(data: Dict[str, Any]) -> List[str]:
    """检测 "***" 脱敏占位符（误贴脱敏导出？）。

 导入是全量覆盖（无 PUT 的「***=保持旧值」合并语义）——占位符落盘会把
 真实凭据顶成 "***"，故直接拒绝并提示用「导出配置（含凭据）」。
 """
    bad: List[str] = []
    for key in _SECRET_FIELDS_TOP:
        if isinstance(data.get(key), str) and data[key] == "***":
            bad.append(key)
    matrix = data.get("matrix")
    if isinstance(matrix, dict) and matrix.get("access_token") == "***":
        bad.append("matrix.access_token")
    for key in _ADDRESS_ENTRY_LISTS:
        bad.extend(_redacted_entry_errors(data.get(key), key))
    sg = data.get("sglang")
    if isinstance(sg, dict):
        bad.extend(_redacted_entry_errors(sg.get("urls"), "sglang.urls"))
    return bad


def _validate_config_shape(data: Dict[str, Any]) -> List[str]:
    """schema 级校验（顶层 dict + 关键键类型 + 至少一个已知键 + 无脱敏占位符）。

 返回错误列表（空 = 通过）；端点拼成可读 400 detail。
 """
    errors: List[str] = []
    for key, expected in _CONFIG_KEY_TYPES.items():
        if key not in data:
            continue
        val = data[key]
        if val is None:
            continue
        if not isinstance(val, expected):
            errors.append(f"{key} 应为 {expected.__name__}，实际 {type(val).__name__}")
    if not any(key in data for key in _CONFIG_KEY_TYPES):
        errors.append(
            "未识别任何配置键（顶层应是配置对象本身——即「导出配置（含凭据）」的原文，不是包裹结构）"
        )
    red = _find_redacted_placeholders(data)
    if red:
        errors.append(
            "检测到脱敏占位符 \"***\"（" + ", ".join(red[:5]) + "）——误贴了脱敏导出？请改用「导出配置（含凭据）」"
        )
    return errors


class TokenValidationError(ValueError):
    """token 内容不合法（含非 ASCII 等）——无法进入 HTTP header。

 历史缺陷「填了 admin token 也提示无效（UnicodeEncodeError）」：终端复制的
 token 混入 BOM/不可见字符时，httpx 在 header 编码层裸抛 UnicodeEncodeError
 对用户不透明。解析时先校验清洗，失败报明确错误（问题字符定位），不裸抛。
 """


def _sanitize_token(raw: str) -> str:
    """token 内容归一：去 BOM/全部空白（含行尾 \\n、复制混入），校验 latin-1
 可编码（HTTP header 约束）。空内容返回 ""；非法内容抛 TokenValidationError。"""
    t = str(raw or "").strip().lstrip("\ufeff")
    t = re.sub(r"\s+", "", t)
    if not t:
        return ""
    try:
        t.encode("latin-1")
    except UnicodeEncodeError as e:
        bad = t[e.start]
        raise TokenValidationError(
            f"token 含非 ASCII 字符 {bad!r}（U+{ord(bad):04X}）——复制时混入了"
            "不可见字符或全角字符（检查是否经中文输入法/聊天记录复制）；"
            "正确的 cli-token 是纯 ASCII"
        ) from None
    return t


def _resolve_controller_token(cfg: Dict[str, Any]) -> tuple:
    """Controller admin token 解析（v0.5.0-beta.12 设计，「controller
 token 的文件路径可以删掉了，留个命令就行」——token 文件路径删除，获取
 方式=UI 留获取命令（docker exec agentteams-controller cat
 /var/run/agentteams/cli-token）+ 粘贴；非 docker 部署=部署期注入 env）。

 解析优先级：
 1. ``controller_token``（手动粘贴）——快照值，轮换后需重贴；
 2. env ``AGENTTEAMS_CONTROLLER_TOKEN``（非 docker / 部署期注入）。

 安全设计不变：token 值永不离开连接器进程（前端只见来源标记）；不引入任何
 凭据兑换（controller 无 token 签发端点，上游安全设计保持）。
 返回 (token, source)；source ∈ {"", "config", "env"}。
 token 内容非法 → 抛 TokenValidationError（调用方报明确错误，不裸抛）。
 """
    t = _sanitize_token(str(cfg.get("controller_token") or ""))
    if t and t != "***":
        return t, "config"
    e = _sanitize_token(os.environ.get("AGENTTEAMS_CONTROLLER_TOKEN", ""))
    if e:
        return e, "env"
    return "", ""


def _token_or_none(cfg: Dict[str, Any]) -> Optional[str]:
    """Controller admin token（或 None）——Controller 管理 API 端点内部用。

 v0.5.0-beta.12 修复（历史缺陷：团队管理页 HTTP 500）：此函数此前
 被 3 个端点调用（teams/structure、/docker-logs/{component}、/approval/set）
 但**从未定义**（旧版重构遗留的悬挂引用）→ 每次请求 NameError →
 500。现实现为 _resolve_controller_token 的薄封装：解析失败/无 token →
 None（端点优雅降级到 matrix/fallback 路径），token 内容非法 → None
 （校验错误由 /config 的 tokenPath 字段向用户显式报告，管理 API 不裸抛）。
 """
    try:
        tok, _src = _resolve_controller_token(cfg)
    except TokenValidationError:
        return None
    return tok or None


class NotifyRequest(BaseModel):
    """插件 → 宿主收件箱通知（插件通知接到 QwenPaw 收件箱）。

 插件后端跑在宿主进程内，直接 import qwenpaw.app.inbox_store.append_event
 （无对外 HTTP 写入端点，内部函数通道）。os_notify=true 时映射宿主
 OS 通知白名单 source_type（PUSH_MESSAGE_SOURCES: cron/heartbeat/memory/
 skill_autoupdate）→ 桌面 toast + 铃铛计数；false 用自定义 source_type
 只进收件箱（插件通知 tab + 宿主 NotificationCenter 可见，不打扰）。
 """

    title: str = Field(min_length=1, max_length=120)
    body: str = Field(default="", max_length=2000)
    severity: str = Field(default="info")
    source_type: str = Field(default="agentteams-qwenpaw-workbench", max_length=40)
    os_notify: bool = False


# ── Room aggregation cache (TTL) ───────────────────────────────────────
# One /sync snapshot is expensive-ish and rooms change rarely — cache the
# parsed aggregation for 60s so tab switches feel instant.
_rooms_cache_lock = threading.Lock()
_rooms_cache: Dict[str, Any] = {"data": None, "ts": 0.0}
_ROOMS_CACHE_TTL = 60.0
_workflow_cache: Dict[str, Any] = {"data": None, "ts": 0.0}
_artifacts_cache: Dict[str, Any] = {"data": None, "ts": 0.0}
# v0.5.0-beta.12 ：/room-mentions 全量扫描结果 10s 缓存（实时增量走 sync_watcher
# 事件缓冲，扫描只做历史 bootstrap——前端按 SSE mention 事件刷新非轮询）。
_room_mentions_cache: Dict[str, Any] = {"data": None, "ts": 0.0}
_room_mentions_lock = threading.Lock()
# v0.5.0-beta.12：/room-approvals 全量扫描结果缓存（同款 bootstrap：
# 实时增量走 sync_watcher 审批缓冲，扫描捞插件关闭期间的未决审批请求）。
# v0.5.0-beta.14.17（审计 C 面）：10s→30s。10s TTL vs 15s 轮询=每轮
# 必 miss（全房扫描≈每 15s 一次）；30s=半数命中。新审批/新 @ 的实时性
# 由 sync_watcher 事件缓冲承担（零延迟，与 TTL 无关）——TTL 只影响
# 「插件关闭期间」历史捞回的刷新粒度，+20s 无产品感知。
_BOOTSTRAP_SCAN_TTL = 30.0
_room_approvals_cache: Dict[str, Any] = {"data": None, "ts": 0.0}

# v0.5.0-beta.14.7（T6 增量扫描）：逐房扫描态 {rid: {"ts": 已见最新消息 ts,
# "entries": [...]}}。房间无推进（sync watcher 探针）→ 复用条目零重扫；
# 600s 兜底全扫一次（watcher 停摆时防结果静默陈旧）。
_room_scan_state: Dict[str, Any] = {
    "mentions": {}, "approvals": {}, "workflow": {}, "artifacts": {},
    "full_at": {"mentions": 0.0, "approvals": 0.0, "workflow": 0.0, "artifacts": 0.0},
}
_ROOM_SCAN_FULL_EVERY = 600.0

# v0.5.0-beta.14.7（T6b）：房间名模块级缓存——mentions 轮询遇未命名房
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
# v0.5.0-beta.13.12（13.11 「团队管理 tab 刷不出完整信息，手动刷新不
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
    """v0.5.0-beta.12: 账号切换 → 清空全部聚合数据缓存。

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

# Sync filter: only room name + membership state, 1 timeline event, no
# presence/ephemeral — keeps the first sync payload small (dashboard 同款做法).
_SYNC_FILTER: Dict[str, Any] = {
    "presence": {"types": []},
    # v0.5.0-beta.12 ：m.muted_room（房间静音，Element 同款 account data——
    # 插件通知引擎 sync_watcher 与前端静音状态同一数据源）。
    "account_data": {"types": ["m.muted_room"]},
    "room": {
        "state": {"types": ["m.room.name", "m.room.member"]},
        "timeline": {"limit": 1},
        # m.typing 事件（打字指示，Element 同款交互——60s 快照新鲜度够用）。
        "ephemeral": {"types": ["m.typing"]},
    },
}


def _parse_sync_rooms(
    sync_resp: Dict[str, Any],
    user_id: str,
    dm_peers: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Parse /sync rooms.join into room list + worker TREE (one shot).

 Worker tree shape (design): team room → its Workers (领/工/审)
 → each Worker's spawn tree (spawns stay empty until the spawn endpoint merges).
 DM rooms (<=2 members) are excluded from the tree.

 dm_peers: m.direct 倒排 {room_id: 对方 mxid}——新 DM 对方未接受邀请时
 成员列表只有自己，房间名靠它取对方名（Element 同款命名源）。
 """
    from . import spawn_tree as spawn_tree_mod

    join = (sync_resp.get("rooms") or {}).get("join") or {}
    rooms: List[Dict[str, Any]] = []
    worker_tree: List[Dict[str, Any]] = []
    for room_id, room_data in join.items():
        state_events = (room_data.get("state") or {}).get("events") or []
        members: Dict[str, Dict[str, Any]] = {}
        name = ""
        for ev in state_events:
            ev_type = ev.get("type")
            content = ev.get("content") or {}
            if ev_type == "m.room.name":
                name = (content.get("name") or "").strip()
            elif ev_type == "m.room.member":
                mxid = ev.get("state_key") or ""
                membership = content.get("membership")
                if mxid and membership == "join":
                    members[mxid] = {
                        "display_name": content.get("displayname") or "",
                        "avatar_url": content.get("avatar_url") or "",
                    }
        member_count = len(members)
        # typing 指示：ephemeral m.typing 事件的 user_ids。
        typing_users: List[str] = []
        for eph in (room_data.get("ephemeral") or {}).get("events") or []:
            if eph.get("type") == "m.typing":
                for uid in (eph.get("content") or {}).get("user_ids") or []:
                    if isinstance(uid, str) and uid != user_id and uid not in typing_users:
                        typing_users.append(uid)
        # 最后一条消息（v0.5.0-beta.12：聊天 tab「最后消息时间 + 新到旧排序」数据源）。
        # /sync 无 since（每次全量快照）→ timeline(limit=1) 恒为该房间最新事件。
        last_ts = 0
        last_body = ""
        last_sender = ""
        tl_events = (room_data.get("timeline") or {}).get("events") or []
        if tl_events:
            last_ev = tl_events[-1]
            try:
                last_ts = int(last_ev.get("origin_server_ts") or 0)
            except (TypeError, ValueError):
                last_ts = 0
            lc = last_ev.get("content") or {}
            if (
                last_ev.get("type") == "m.room.message"
                and lc.get("msgtype") in ("m.text", "m.notice", "m.file", "m.image")
            ):
                last_body = str(lc.get("body") or "")[:120]
                # v0.5.0-beta.13.2（灯源修正）：最后一条消息的发送者——
                # session 灯 done 回退只认 Worker 自己的消息（per-sender，
                # 与 dashboard 9a9cc8d 同源），用户消息不再点绿整个房间。
                last_sender = str(last_ev.get("sender") or "")
        # 未读计数（sync 的 unread_notifications：highlight+notification）。
        unread = 0
        unread_high = 0
        unread_notifications = (room_data.get("unread_notifications") or {}) if isinstance(room_data, dict) else {}
        if isinstance(unread_notifications, dict):
            try:
                unread_high = int(unread_notifications.get("highlight_count") or 0)
                unread = int(unread_notifications.get("notification_count") or 0)
            except (TypeError, ValueError):
                unread_high = 0
                unread = 0
        entry: Dict[str, Any] = {
            "room_id": room_id,
            "name": name,
            "members": members,
            "member_count": member_count,
            "name_fallback": False,
            "unread": unread,
            "unread_highlight": unread_high,
            "typing": typing_users,
            "last_ts": last_ts,
            "last_body": last_body,
            "last_sender": last_sender,
        }
        if not entry["name"]:
            # 无名房间命名优先级（v0.5.0-beta.12）：
            # ① m.direct 对方（新 DM 对方未 accept 邀请时 members 只有自己，
            # 此前直接落「（空房间）」——用户真机反馈"空房间，说过话才有名字"）
            # ② 其他已加入成员 ③（空房间）兜底
            peer = (dm_peers or {}).get(room_id, "")
            if peer and peer != user_id and member_count <= 2:
                peer_member = members.get(peer) or {}
                entry["name"] = (
                    peer_member.get("display_name")
                    or peer.lstrip("@").split(":")[0]
                    or peer
                )
            else:
                others = [
                    (m.get("display_name") or uid)
                    for uid, m in members.items()
                    if uid != user_id
                ]
                entry["name"] = "、".join(others[:3]) or "（空房间）"
            entry["name_fallback"] = True
        if member_count > 2:
            # Team room → tree node with its Workers.
            worker_tree.append(
                {
                    "team_name": entry["name"],
                    "room_id": room_id,
                    "workers": spawn_tree_mod.build_worker_groups(
                        members, user_id
                    ),
                }
            )
        rooms.append(entry)

    rooms.sort(key=lambda r: (r["name_fallback"], r["name"]))
    # Tree: named teams first, then fallback-named rooms.
    worker_tree.sort(
        key=lambda t: (
            t["team_name"] in ("（空房间）",) or not t["team_name"],
            t["team_name"].lower(),
        )
    )

    # v0.5.0-beta.12 ：解析 /sync rooms.invite 段（此前只读 join——邀请房间
    # 在插件里完全不可见，用户真机「没有 Element 的接受入群按钮和接口」根因）。
    # invite_state.events 带 m.room.name + 邀请人的 m.room.member（membership=invite）；
    # 接受=POST /rooms/{roomId}/invite/{userId}/accept，拒绝=POST /rooms/{roomId}/leave
    # （CS-API v3 标准端点，前端走通用代理，零新后端路由）。
    invites: List[Dict[str, Any]] = []
    for room_id, room_data in (
        ((sync_resp.get("rooms") or {}).get("invite") or {})
    ).items():
        name = ""
        inviter = ""
        inviter_ts = 0
        for ev in ((room_data.get("invite_state") or {}).get("events") or []):
            ev_type = ev.get("type")
            content = ev.get("content") or {}
            if ev_type == "m.room.name":
                name = (content.get("name") or "").strip()
            elif (
                ev_type == "m.room.member"
                and content.get("membership") == "invite"
            ):
                inviter = ev.get("sender") or ""
                inviter_ts = int(ev.get("origin_server_ts") or 0)
        name = name or room_id
        invites.append(
            {
                "room_id": room_id,
                "name": name,
                "name_fallback": not name or name == room_id,
                "inviter": inviter,
                "inviter_ts": inviter_ts,
            }
        )
    invites.sort(key=lambda r: -r["inviter_ts"])

    # v0.5.0-beta.12 ：静音房间集合（account_data m.muted_room 聚合，
    # Element 同款状态源；前端 RoomChat 静音按钮 + 通知引擎共读）。
    muted_rooms: List[str] = []
    for ev in ((sync_resp.get("account_data") or {}).get("events") or []):
        if ev.get("type") != "m.muted_room":
            continue
        content = ev.get("content") or {}
        room_id = content.get("room_id") or ""
        if room_id and content.get("muted") and room_id not in muted_rooms:
            muted_rooms.append(room_id)
    return {
        "rooms": rooms,
        "worker_tree": worker_tree,
        "invites": invites,
        "muted_rooms": muted_rooms,
    }


def _parse_docker_stream(data: bytes, component: str) -> List[Dict[str, Any]]:
    """解析 docker logs 二进制流（8 字节头：type+padding+size BE + payload）。

 dashboard `parseDockerLogs` 同款逻辑；时间戳 RFC3339 前缀行。
 """
    import re as _re

    lines: List[Dict[str, Any]] = []
    offset = 0
    n = len(data)
    ts_re = _re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s(.*)$")
    while offset + 8 <= n:
        stream = data[offset]
        size = int.from_bytes(data[offset + 4 : offset + 8], "big")
        if size <= 0 or offset + 8 + size > n:
            break
        payload = data[offset + 8 : offset + 8 + size].decode("utf-8", "replace")
        for raw in payload.split("\n"):
            if not raw.strip():
                continue
            m = ts_re.match(raw)
            if m:
                lines.append(
                    {
                        "timestamp": m.group(1),
                        "level": "error" if stream == 2 else "info",
                        "component": component,
                        "message": m.group(2).rstrip(),
                    }
                )
            else:
                lines.append(
                    {
                        "timestamp": "",
                        "level": "error" if stream == 2 else "info",
                        "component": component,
                        "message": raw.rstrip(),
                    }
                )
        offset += 8 + size
    return lines


async def _ctl_json(method: str, url: str, token: str,
                    json_body: Optional[Dict[str, Any]] = None) -> tuple:
    """薄包装 → ctl_client.ctl_json（v0.5.0-beta.14.13 去重）。"""
    from . import ctl_client  # noqa: PLC0415
    return await ctl_client.ctl_json(method, url, token, json_body)


# 任务 190：域子路由装配。此导入须位于上方全部模块级名之后（域模块反向导入本模块
# 共享名，循环导入解析时本模块须已具备这些名）。
from .routers import (  # noqa: E402
    approval_api,
    config_api,
    gateway_api,
    kb_api,
    live_api,
    matrix_api,
    status_api,
    teams_api,
)


def build_router() -> APIRouter:
    router = APIRouter()

    # v0.5.0-beta.14.25（任务 190）：KB 域可变状态由装配方创建、显式传入
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
    router.include_router(live_api.build_live_router())
    # catch-all 域装配最后（/{target}/{path:path} 位于该域尾部）。
    router.include_router(approval_api.build_approval_router(_kb_shared))
    return router
