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


def build_router() -> APIRouter:
    router = APIRouter()

    # ── Fixed endpoints (must be registered before the catch-all) ─────

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
        from . import worker_status  # noqa: PLC0415

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
        from . import projects_workflow  # noqa: PLC0415

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

    @router.get("/teams/sync")
    async def teams_sync(force: bool = False) -> Dict[str, Any]:
        """One-shot /sync aggregation (dashboard 同款做法): rooms + members
 + Worker groups in a single Matrix request, cached 60s."""
        import asyncio
        import time as time_mod

        now = time_mod.time()
        with _rooms_cache_lock:
            cached_entry = _rooms_cache
            if (
                not force
                and cached_entry["data"] is not None
                and now - cached_entry["ts"] < _ROOMS_CACHE_TTL
            ):
                return {
                    **cached_entry["data"],
                    "cached": True,
                    "elapsed": 0.0,
                }

        cfg = config_mod.load_config()
        matrix_cfg = cfg.get("matrix") or {}
        token = (matrix_cfg.get("access_token") or "").strip()
        user_id = (matrix_cfg.get("user_id") or "").strip()
        homeserver = _pick_address(cfg, "matrix")
        if not homeserver:
            raise HTTPException(status_code=502, detail="未配置 Matrix 地址")
        if not token:
            raise HTTPException(status_code=401, detail="未登录，请先在配置页登录")

        started = time_mod.time()
        try:
            # timeout=0 → server returns the snapshot immediately.
            sync_resp = await asyncio.to_thread(
                matrix_client.sync,
                homeserver,
                token,
                timeout_ms=0,
                sync_filter=_SYNC_FILTER,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("teams/sync failed: %s", exc)
            raise HTTPException(
                status_code=502,
                detail=f"{selfcheck._classify_error(exc)}{_pinned_note(cfg)}",
            ) from exc

        # DM 命名源：m.direct（一次小请求，随 60s 缓存摊薄）。
        dm_peers = await asyncio.to_thread(
            matrix_client.direct_rooms, homeserver, token, user_id
        )
        parsed = _parse_sync_rooms(sync_resp, user_id, dm_peers)
        elapsed = round(time_mod.time() - started, 1)
        payload: Dict[str, Any] = {
            "ok": True,
            "rooms": parsed["rooms"],
            # v0.5.0-beta.12 ：邀请房间（rooms.invite 段，前端邀请区渲染）。
            "invites": parsed["invites"],
            # v0.5.0-beta.12 ：静音房间（m.muted_room account data 聚合）。
            "muted_rooms": parsed["muted_rooms"],
            "user_id": user_id,
            "worker_tree": parsed["worker_tree"],
            "elapsed": elapsed,
        }
        with _rooms_cache_lock:
            _rooms_cache["data"] = payload
            _rooms_cache["ts"] = now
        logger.info(
            "teams/sync: %d rooms / %d teams in tree in %.1fs",
            len(parsed["rooms"]),
            len(parsed["worker_tree"]),
            elapsed,
        )
        return payload

    @router.get("/workflow/events")
    async def workflow_events(force: bool = False) -> Dict[str, Any]:
        """Aggregate structured workflow events from recent room messages.

 AgentTeams workers publish ``agentteams.workflow`` payloads on
 m.room.message events (✅ upstream workerflow/mcp/server.py L753:
 runId/status/title/summary/coordinator/subagents/steps; revisions via
 m.replace + m.new_content). This is the zero-PR data source for the
 WorkflowBoard (dashboard parses the same events).
 """
        import asyncio
        import time as time_mod

        now = time_mod.time()
        if not force and _workflow_cache["data"] is not None:
            if now - _workflow_cache["ts"] < _ROOMS_CACHE_TTL:
                return {**_workflow_cache["data"], "cached": True}

        cfg = config_mod.load_config()
        matrix_cfg = cfg.get("matrix") or {}
        token = (matrix_cfg.get("access_token") or "").strip()
        homeserver = _pick_address(cfg, "matrix")
        if not homeserver:
            raise HTTPException(status_code=502, detail="未配置 Matrix 地址")
        if not token:
            raise HTTPException(status_code=401, detail="未登录，请先在配置页登录")

        # Room list: reuse the sync cache when fresh, else run a sync.
        with _rooms_cache_lock:
            rooms_payload = _rooms_cache["data"]
            rooms_fresh = rooms_payload is not None and now - _rooms_cache["ts"] < _ROOMS_CACHE_TTL
        if rooms_fresh and rooms_payload:
            rooms_data = rooms_payload
        else:
            try:
                sync_resp = await asyncio.to_thread(
                    matrix_client.sync,
                    homeserver,
                    token,
                    timeout_ms=0,
                    sync_filter=_SYNC_FILTER,
                )
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(
                    status_code=502,
                    detail=f"{selfcheck._classify_error(exc)}{_pinned_note(cfg)}",
                ) from exc
            cfg_for_parse = config_mod.load_config()
            user_for_parse = (cfg_for_parse.get("matrix") or {}).get("user_id", "")
            parsed = _parse_sync_rooms(sync_resp, user_for_parse)
            rooms_data = {
                "ok": True,
                "rooms": parsed["rooms"],
                "user_id": user_for_parse,
                "worker_tree": parsed["worker_tree"],
            }
            with _rooms_cache_lock:
                _rooms_cache["data"] = rooms_data
                _rooms_cache["ts"] = now

        import urllib.parse as _urlparse_mod

        # Group rooms have the task traffic — scan the 20 largest first.
        rooms_sorted = sorted(
            rooms_data["rooms"],
            key=lambda r: r["member_count"],
            reverse=True,
        )  # 全量扫描：DM/小房间也有产物（长报告经 DM 交付），不再取前 20

        sem = asyncio.Semaphore(6)
        st_all = _room_scan_state["workflow"]
        full = _scan_should_full("workflow")
        from . import sync_watcher  # noqa: PLC0415 — T6 增量探针

        async def _scan(room_entry: Dict[str, Any]) -> List[Dict[str, Any]]:
            async with sem:
                rid_w = str(room_entry.get("room_id") or "")
                sts = st_all.get(rid_w)
                if (
                    not full
                    and sts is not None
                    and sync_watcher.room_last_ts(rid_w) <= sts.get("ts", 0)
                ):
                    # T6：无推进 → 复用上次事件（零 /messages 拨号）。
                    return sts.get("entries") or []
                encoded = _urlparse_mod.quote(room_entry["room_id"], safe="/._-~")
                url = (
                    f"{homeserver.rstrip('/')}/_matrix/client/v3/rooms/{encoded}/messages"
                    "?dir=b&limit=30&filter="
                    + _urlparse_mod.quote('{"types":["m.room.message"]}', safe="")
                )
                try:
                    async with GatedAsyncClient(timeout=10.0, verify=False) as client:
                        resp = await client.get(
                            url, headers=_headers_for(cfg, "matrix", homeserver,
                                {"Authorization": f"Bearer {token}"})
                        )
                    if resp.status_code != 200:
                        return []
                    chunk = resp.json().get("chunk") or []
                except Exception as exc:  # noqa: BLE001
                    logger.debug("workflow/events: scan failed %s: %s", room_entry["room_id"], exc)
                    return []

            newest = 0
            for ev in chunk:
                _ev_ts = int(ev.get("origin_server_ts") or 0)
                if _ev_ts > newest:
                    newest = _ev_ts
            events: List[Dict[str, Any]] = []
            for ev in chunk:
                if ev.get("type") != "m.room.message":
                    continue
                content = ev.get("content") or {}
                wf = content.get("agentteams.workflow")
                # m.replace revisions carry the fresh payload in m.new_content.
                new_content = content.get("m.new_content")
                if isinstance(new_content, dict) and new_content.get("agentteams.workflow"):
                    wf = new_content.get("agentteams.workflow")
                if not isinstance(wf, dict):
                    continue
                events.append(
                    {
                        "runId": str(wf.get("runId") or wf.get("run_id") or ev.get("event_id") or ""),
                        "title": str(wf.get("title") or wf.get("name") or "未命名任务"),
                        "status": str(wf.get("status") or "unknown"),
                        "summary": str(wf.get("summary") or ""),
                        "coordinator": str(wf.get("coordinator") or ""),
                        "subagents": wf.get("subagents") or [],
                        "steps": wf.get("steps") or [],
                        # 树状拓扑：DAG nodes（id/subagent/task/dependsOn）。
                        "nodes": wf.get("nodes") or [],
                        "room_id": room_entry["room_id"],
                        "room_name": room_entry["name"],
                        "sender": str(ev.get("sender") or ""),
                        "ts": int(ev.get("origin_server_ts") or 0),
                    }
                )
            st_all[rid_w] = {
                "ts": max(newest, sync_watcher.room_last_ts(rid_w)),
                "entries": events,
            }
            return events

        scanned = await asyncio.gather(*(_scan(r) for r in rooms_sorted))
        if full:
            _scan_mark_full("workflow")
        flat = [ev for group in scanned for ev in group]
        # Upsert by runId: latest timestamp wins (m.replace revisions).
        by_run: Dict[str, Dict[str, Any]] = {}
        for ev in flat:
            existing = by_run.get(ev["runId"])
            if existing is None or ev["ts"] >= existing["ts"]:
                by_run[ev["runId"]] = ev
        merged = sorted(by_run.values(), key=lambda e: e["ts"], reverse=True)
        elapsed = round(time_mod.time() - now, 1)
        payload = {"ok": True, "events": merged[:100], "elapsed": elapsed}
        _workflow_cache["data"] = payload
        _workflow_cache["ts"] = now
        logger.info(
            "workflow/events: %d events from %d rooms in %.1fs",
            len(merged),
            len(rooms_sorted),
            elapsed,
        )
        return payload

    @router.get("/artifacts")
    async def artifacts(force: bool = False) -> Dict[str, Any]:
        """跨房间产物聚合：m.file/m.image 事件（产物页数据源，务实版）。

 与 workflow/events 同构：sync 缓存复用 → 20 大房间 → /messages 拉
 最近 30 条 → 过滤文件/图片消息 → 按时间倒序，60s 缓存。
 """
        import asyncio
        import time as time_mod

        now = time_mod.time()
        if not force and _artifacts_cache["data"] is not None:
            if now - _artifacts_cache["ts"] < _ROOMS_CACHE_TTL:
                return {**_artifacts_cache["data"], "cached": True}

        cfg = config_mod.load_config()
        matrix_cfg = cfg.get("matrix") or {}
        token = (matrix_cfg.get("access_token") or "").strip()
        homeserver = _pick_address(cfg, "matrix")
        if not homeserver:
            raise HTTPException(status_code=502, detail="未配置 Matrix 地址")
        if not token:
            raise HTTPException(status_code=401, detail="未登录，请先在配置页登录")

        # Room list: reuse the sync cache when fresh, else run a sync.
        with _rooms_cache_lock:
            rooms_payload = _rooms_cache["data"]
            rooms_fresh = rooms_payload is not None and now - _rooms_cache["ts"] < _ROOMS_CACHE_TTL
        if rooms_fresh and rooms_payload:
            rooms_data = rooms_payload
        else:
            try:
                sync_resp = await asyncio.to_thread(
                    matrix_client.sync,
                    homeserver,
                    token,
                    timeout_ms=0,
                    sync_filter=_SYNC_FILTER,
                )
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(
                    status_code=502,
                    detail=f"{selfcheck._classify_error(exc)}{_pinned_note(cfg)}",
                ) from exc
            cfg_for_parse = config_mod.load_config()
            user_for_parse = (cfg_for_parse.get("matrix") or {}).get("user_id", "")
            parsed = _parse_sync_rooms(sync_resp, user_for_parse)
            rooms_data = {
                "ok": True,
                "rooms": parsed["rooms"],
                "user_id": user_for_parse,
                "worker_tree": parsed["worker_tree"],
            }
            with _rooms_cache_lock:
                _rooms_cache["data"] = rooms_data
                _rooms_cache["ts"] = now

        import urllib.parse as _urlparse_mod

        rooms_sorted = sorted(
            rooms_data["rooms"],
            key=lambda r: r["member_count"],
            reverse=True,
        )  # 全量扫描：DM/小房间也有产物（长报告经 DM 交付），不再取前 20

        sem = asyncio.Semaphore(6)
        st_all = _room_scan_state["artifacts"]
        full = _scan_should_full("artifacts")
        from . import sync_watcher  # noqa: PLC0415 — T6 增量探针

        async def _scan(room_entry: Dict[str, Any]) -> List[Dict[str, Any]]:
            async with sem:
                rid_a = str(room_entry.get("room_id") or "")
                sts = st_all.get(rid_a)
                if (
                    not full
                    and sts is not None
                    and sync_watcher.room_last_ts(rid_a) <= sts.get("ts", 0)
                ):
                    # T6 增量：无推进 → 复用上次产物条目（零拨号）。
                    return sts.get("entries") or []
                encoded = _urlparse_mod.quote(room_entry["room_id"], safe="/._-~")
                # 产物是稀疏事件（文档埋在大量对话里）：分页深扫最多 5 页 ×100 条。
                # dir=b + end token 向更早翻页（聊天室分页同款，Tuwunel 已验证支持）。
                collected: List[Dict[str, Any]] = []
                page_token = ""
                try:
                    async with GatedAsyncClient(timeout=15.0, verify=False) as client:
                        for _page in range(5):
                            url = (
                                f"{homeserver.rstrip('/')}/_matrix/client/v3/rooms/{encoded}/messages"
                                f"?dir=b&limit=100&filter="
                                + _urlparse_mod.quote('{"types":["m.room.message"]}', safe="")
                            )
                            if page_token:
                                url += f"&from={_urlparse_mod.quote(page_token, safe='')}"
                            resp = await client.get(
                                url, headers=_headers_for(cfg, "matrix", homeserver,
                                    {"Authorization": f"Bearer {token}"})
                            )
                            if resp.status_code != 200:
                                break
                            data = resp.json()
                            chunk = data.get("chunk") or []
                            collected.extend(chunk)
                            page_token = data.get("end") or ""
                            if not chunk or not page_token:
                                break
                except Exception as exc:  # noqa: BLE001
                    logger.debug("artifacts: scan failed %s: %s", room_entry["room_id"], exc)
                    return []

            items: List[Dict[str, Any]] = []
            for ev in collected:
                if ev.get("type") != "m.room.message":
                    continue
                content = ev.get("content") or {}
                msgtype = content.get("msgtype")
                # 长报告兼容：m.text + com.agentteams.long_message 元数据
                # （AgentTeams matrix channel 对超长回复上传附件后在 content
                # 里挂 {version,url,filename,mimetype}，msgtype 仍是 m.text）。
                long_meta = content.get("com.agentteams.long_message")
                if msgtype == "m.text" and isinstance(long_meta, dict) and long_meta.get("url"):
                    url = long_meta.get("url")
                    info = {}
                    items.append(
                        {
                            "event_id": str(ev.get("event_id") or ""),
                            "room_id": room_entry["room_id"],
                            "room_name": room_entry["name"],
                            "sender": str(ev.get("sender") or ""),
                            "ts": int(ev.get("origin_server_ts") or 0),
                            "msgtype": "m.file",
                            "url": str(url),
                            "filename": str(long_meta.get("filename") or content.get("body") or "长报告"),
                            "body": str(content.get("body") or ""),
                            "mimetype": str(long_meta.get("mimetype") or ""),
                            "size": info.get("size") if isinstance(info.get("size"), (int, float)) else None,
                        }
                    )
                    continue
                if msgtype not in ("m.file", "m.image"):
                    continue
                url = content.get("url")
                if not url:
                    continue
                info = content.get("info") or {}
                items.append(
                    {
                        "event_id": str(ev.get("event_id") or ""),
                        "room_id": room_entry["room_id"],
                        "room_name": room_entry["name"],
                        "sender": str(ev.get("sender") or ""),
                        "ts": int(ev.get("origin_server_ts") or 0),
                        "msgtype": msgtype,
                        "url": url,
                        "filename": str(content.get("filename") or content.get("body") or "附件"),
                        "body": str(content.get("body") or ""),
                        "mimetype": str(content.get("mimetype") or info.get("mimetype") or ""),
                        "size": info.get("size") if isinstance(info.get("size"), (int, float)) else None,
                    }
                )
            # T6 增量：落逐房扫描态（无产物房 ts 兜 0，探针 0 ≤ 0 恒复用）。
            _newest = max((int(it.get("ts") or 0) for it in items), default=0)
            st_all[rid_a] = {
                "ts": max(_newest, sync_watcher.room_last_ts(rid_a)),
                "entries": items,
            }
            return items

        scanned = await asyncio.gather(*(_scan(r) for r in rooms_sorted))
        if full:
            _scan_mark_full("artifacts")
        flat = [it for group in scanned for it in group]
        flat.sort(key=lambda e: e["ts"], reverse=True)
        elapsed = round(time_mod.time() - now, 1)
        payload = {"ok": True, "items": flat[:150], "elapsed": elapsed}
        _artifacts_cache["data"] = payload
        _artifacts_cache["ts"] = now
        logger.info(
            "artifacts: %d items from %d rooms in %.1fs",
            len(flat),
            len(rooms_sorted),
            elapsed,
        )
        return payload

    @router.get("/teams/structure")
    async def teams_structure(force: bool = False) -> Dict[str, Any]:
        """真实团队结构（按 Team/Worker CRD 列树，非房间聚合）。

 Data source: Controller GET /api/v1/workers (needs controller_token)
 → group by team field → role from worker CRD (team_leader/worker,
 critic inferred from name). Without a token / on failure, falls back
 to the room-aggregated tree.
 """
        import asyncio
        import time as time_mod

        now = time_mod.time()
        with _rooms_cache_lock:
            struct_entry = _structure_cache
            # v0.5.0-beta.13.12：按条目 ttl 判（负缓存 5s / 成功 60s），
            # 不再统一 60s——失败结果不应挡住后续手动刷新 60s。
            if (
                not force
                and struct_entry["data"] is not None
                and now - struct_entry["ts"] < struct_entry["ttl"]
            ):
                return {**struct_entry["data"], "cached": True}

        cfg = config_mod.load_config()
        matrix_cfg = cfg.get("matrix") or {}
        user_id = (matrix_cfg.get("user_id") or "").strip()
        controller_urls = cfg.get("controller_urls") or []
        ctl_token = _token_or_none(cfg)

        tree: List[Dict[str, Any]] = []
        source = "room-fallback"

        if controller_urls:
            # 认证链：admin token 优先 → Matrix token（L2，按 accessibleTeams
            # 过滤，上游已实现）→ 都失败则房间聚合兜底。
            matrix_token = (matrix_cfg.get("access_token") or "").strip()
            tokens: List[str] = []
            if ctl_token:
                tokens.append(ctl_token)
            if matrix_token and matrix_token not in tokens:
                tokens.append(matrix_token)
            # v0.5.0-beta.13.24（首刷 race 三次复发·根因）：旧版只拨单地址
            # （working cache 或 urls[0]=LAN IP 优先）10s 超时、无 per-request
            # failover——切网窗口 / 进程重启后 working cache 未标记（探针 15s
            # 冷启动）内每个请求卡满超时再落 matrix 全量回退（无上限），团队
            # 管理「一开始刷不出、手动也不行、要等一会」。改与 catch-all 代理
            # 同语义：ordered 地址（working 优先）× token 链 failover；连接
            # 超时 3s 快速识破死地址；成功即标记 working。
            ctl_urls = _ordered_addresses(cfg, "controller")
            dial_timeout = httpx.Timeout(
                connect=3.0, read=10.0, write=10.0, pool=3.0
            )

            async def _dial_workers(
                token: str,
            ) -> Optional["httpx.Response"]:
                """按 ordered 地址 failover 拨 /api/v1/workers。

 传输层错误 / 5xx → 下一地址；4xx（鉴权/端点语义）→ 返回该
 响应（调用方换 token）；200/其他 → 返回并标记 working。
 全部失败 → None。
 """
                last_5xx: Optional["httpx.Response"] = None
                first_4xx: Optional["httpx.Response"] = None
                for url in ctl_urls:
                    try:
                        async with GatedAsyncClient(
                            timeout=dial_timeout, verify=False
                        ) as client:
                            r = await client.get(
                                f"{url.rstrip('/')}/api/v1/workers",
                                headers=_headers_for(
                                    cfg, "controller", url,
                                    {"Authorization": f"Bearer {token}"},
                                ),
                            )
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "teams/structure: workers API via %s failed: %s",
                            url,
                            selfcheck._classify_error(exc),
                        )
                        continue
                    if 400 <= r.status_code < 500:
                        # v0.5.0-beta.14.6：仅地址相关 4xx（401/403/408/
                        # 429）换下一地址（网关会话门）；确定性 4xx（404/409/
                        # 400…）地址无关 → 立即返回（外层 token 链语义不变）。
                        if not should_failover_status(r.status_code):
                            return r
                        if first_4xx is None:
                            first_4xx = r
                        continue
                    if r.status_code >= 500:
                        last_5xx = r
                        continue
                    _mark_working("controller", url)
                    return r
                if first_4xx is not None:
                    return first_4xx
                return last_5xx

            for attempt_token in tokens:
                try:
                    resp = await _dial_workers(attempt_token)
                    if resp is None or resp.status_code != 200:
                        if resp is not None:
                            logger.info(
                                "teams/structure: workers API %d (auth chain next)",
                                resp.status_code,
                            )
                        continue
                    payload = resp.json()
                    workers = (
                        payload
                        if isinstance(payload, list)
                        else payload.get("workers", [])
                    )
                    # Group by team; role mapping: team_leader→leader,
                    # worker→worker, name contains critic→critic.
                    by_team: Dict[str, List[Dict[str, Any]]] = {}
                    for w in workers:
                        team_name = str(w.get("team") or "未分组")
                        worker_name = str(w.get("name") or "")
                        role_raw = str(w.get("role") or "worker")
                        if role_raw == "team_leader":
                            role = "leader"
                        elif "critic" in worker_name.lower():
                            role = "critic"
                        else:
                            role = "worker"
                        by_team.setdefault(team_name, []).append(
                            {
                                "worker_name": worker_name,
                                "mxid": str(w.get("matrixUserID") or ""),
                                "role": role,
                                "is_self": str(w.get("matrixUserID") or "") == user_id,
                                "phase": str(w.get("phase") or ""),
                                # v0.5.0-beta.12：roomID=Worker 个人房间
                                # （私聊直跳，Worker 容器不能接受邀请，
                                # 新建 DM 是死路）；runtime=CR 字段（runtime 徽章，
                                # 实锤：早期版本映射漏取，前端恒空）。
                                "room_id": str(w.get("roomID") or ""),
                                "runtime": str(w.get("runtime") or ""),
                                "spawns": [],
                            }
                        )
                    role_order = {"leader": 0, "worker": 1, "critic": 2}
                    for team_name, ws in by_team.items():
                        ws.sort(key=lambda x: (role_order.get(x["role"], 3), x["worker_name"].lower()))
                    tree = [
                        {"team_name": name, "workers": ws}
                        for name, ws in sorted(by_team.items())
                    ]
                    source = "controller-workers"
                    # working 标记已在 _dial_workers 成功路径完成
                    break
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "teams/structure: workers API attempt failed: %s", exc
                    )
                    continue

        if not tree:
            # Fallback (no token / workers API failed): run our own sync and
            # build the room-aggregated tree — NOT from the cache, which may
            # be empty due to the mount-time race with teams/sync.
            # v0.5.0-beta.13.24：homeserver 也走 ordered failover（旧版
            # 单地址 homeservers2[0]=LAN IP 优先，切网窗口 100% 失败→空树+
            # 5s 负缓存，与 controller 侧同病灶）。30s 上限防长轮询挂死。
            matrix_cfg2 = cfg.get("matrix") or {}
            token2 = (matrix_cfg2.get("access_token") or "").strip()
            hs_urls = _ordered_addresses(cfg, "matrix")
            if hs_urls and token2:
                for homeserver2 in hs_urls:
                    try:
                        sync_resp = await asyncio.wait_for(
                            asyncio.to_thread(
                                matrix_client.sync,
                                homeserver2,
                                token2,
                                timeout_ms=0,
                                sync_filter=_SYNC_FILTER,
                            ),
                            timeout=30.0,
                        )
                        _mark_working("matrix", homeserver2)
                        parsed = _parse_sync_rooms(sync_resp, user_id)
                        tree = parsed["worker_tree"]
                        source = "room-fallback"
                        break
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "teams/structure fallback sync via %s failed: %s",
                            homeserver2,
                            exc,
                        )
            else:
                tree = []

        payload = {"ok": True, "tree": tree, "source": source}
        # v0.5.0-beta.13.12：成功（controller-workers 源且非空树）享 60s
        # 正缓存；降级（room-fallback）或空树只负缓存 5s——token 未就绪 /
        # Controller 瞬时不可用时，5s 后手动刷新即重试（不锁死 60s）。
        struct_ttl = (
            _ROOMS_CACHE_TTL
            if source == "controller-workers" and tree
            else _STRUCTURE_NEGATIVE_TTL
        )
        with _rooms_cache_lock:
            _structure_cache["data"] = payload
            _structure_cache["ts"] = now
            _structure_cache["ttl"] = struct_ttl
        logger.info(
            "teams/structure: %d teams via %s (cache ttl=%.0fs)",
            len(tree),
            source,
            struct_ttl,
        )
        return payload

    @router.get("/config")
    async def get_config() -> Dict[str, Any]:
        """Config with secrets redacted + current effective addresses."""
        cfg = config_mod.load_config()
        out = config_mod.redact(cfg)
        # v0.5.0-beta.12：token 可来自粘贴或 env 时 config.controller_token
        # 为空——前端门控（hasToken/l1TokenMode）需要知道 L1 管理 API 可用。
        # 只暴露来源标记，token 值永不离开连接器进程。
        # 取值："config"|"env"=可用；"invalid"=配置了但坏了。（v0.5.0-beta.12：
        # token 文件路径删除——file/file_unreadable 取值不复存在。）
        try:
            _t, _src = _resolve_controller_token(cfg)
            if _t:
                out["controllerTokenSource"] = _src
            else:
                out["controllerTokenSource"] = ""
        except TokenValidationError:
            out["controllerTokenSource"] = "invalid"
        # v0.5.0-beta.14.1: effective 走 _pick_address（固定档=固定值；auto
        # = cache 优先、miss 回退首个——比原来「cache 空=空串」更诚实）。
        out["effective"] = {
            "matrix": _pick_address(cfg, "matrix"),
            "controller": _pick_address(cfg, "controller"),
            # v0.5.0-beta.14.7：effective 补 gateway（固定档同源）。
            "gateway": _pick_address(cfg, "gateway"),
        }
        # v0.5.0-beta.14.12：持久化诊断——路径/挂载可见性/
        # 上次写盘时间（帮助定位"设置不落盘"的环境问题）。
        out["configPath"] = str(config_mod._CONFIG_PATH)
        try:
            _st = config_mod._CONFIG_PATH.stat()
            out["configSavedAt"] = int(_st.st_mtime)
            out["configWritable"] = os.access(str(config_mod._CONFIG_DIR), os.W_OK)
        except Exception:  # noqa: BLE001
            out["configSavedAt"] = 0
            out["configWritable"] = False
        return out

    @router.put("/config")
    async def put_config(patch: ConfigPatch) -> Dict[str, Any]:
        """Persist config fields. Never accept a redacted token back."""
        incoming = patch.config or {}
        matrix_in = incoming.get("matrix") or {}
        if matrix_in.get("access_token") == "***":
            matrix_in.pop("access_token", None)
        if incoming.get("controller_token") == "***":
            incoming.pop("controller_token", None)
        prev = config_mod.load_config()
        # v0.5.0-beta.14.12：保存失败显性化——落盘失败（磁盘
        # 满/权限）此前裸抛 = 500 无详情；现明确报原因（前端可显示）。
        # v0.5.0-beta.14.12：config 写盘校验失败（写+回读
        # 不一致/磁盘异常）统一为 IOError——分类报「配置保存失败（磁盘写入
        # 问题）」；其余异常仍走 通用兜底。
        try:
            merged = config_mod.update_config(incoming)
        except IOError as exc:
            raise HTTPException(
                status_code=500,
                detail=f"配置保存失败（磁盘写入问题）：{exc}",
            ) from exc
        except Exception as exc:  # noqa: BLE001 - 落盘失败显性化（兜底）
            raise HTTPException(
                status_code=500, detail=f"配置写入失败：{exc}"
            )
        # v0.5.0-beta.12: 登录身份变更（同 /login 语义）→ 清聚合缓存 + 重启 sync 游标。
        # 只按 user_id 判定——普通保存配置（未换账号）不触发重启。
        if (prev.get("matrix") or {}).get("user_id") != (
            merged.get("matrix") or {}
        ).get("user_id"):
            invalidate_data_caches("config.matrix")
            from . import sync_watcher as _sw  # noqa: PLC0415

            await _sw.restart("config.matrix")
        # v0.5.0-beta.14.12：地址探测转后台——保存即时返回
        # （<1s），effective 状态随后自动刷新（前端下次 GET /config 可见）。
        # 旧行为=同步 await 全地址探测（本机实测 ~4.8s，WAN 高延迟下保存
        # 几乎保存不了）；后台任务经 _safe_refresh_effective 错误自保。
        asyncio.create_task(_safe_refresh_effective(merged))
        return config_mod.redact(merged)

    # ── v0.5.0-beta.14.14：完整配置备份/恢复 ─────────────────
    # 安全边界：同源本地、面向用户自己的备份用途（换环境/装包后一键还原）。
    # GET /config 保持脱敏不动（前端展示面）；export/import 是独立通道——
    # 导出返回含明文凭据的完整配置，导入校验 → 备份当前态 → 覆盖。

    @router.get("/config/export")
    async def config_export() -> Dict[str, Any]:
        """v0.5.0-beta.14.14：完整配置导出（含明文凭据）。

 同源本地、面向用户自己的备份用途——输出即落盘同形的完整配置对象，
 原样复制保存；换环境/装包/配置丢失后贴回 /config/import 即还原。
 """
        return config_mod.load_config()

    @router.post("/config/import")
    async def config_import(request: Request) -> Dict[str, Any]:
        """v0.5.0-beta.14.14：完整配置导入（覆盖式恢复）。

 同源本地、面向用户自己的备份用途（与 GET /config/export 一对）。
 流程：① schema 级校验（顶层 dict + 关键键类型 + 无脱敏占位符，
 失败 400 可读错误、零落盘）→ ② 先自动备份当前配置（config.bak.json，
 备份失败即中止不覆盖）→ ③ 原子覆盖（save_config 内置写后回读验证，
 备份保持为覆盖前恢复点）→ ④ 身份变更自动重启同步（同 PUT /config）。

 返回 restart: "none"=已 live 生效（同步自动重启）/ "page"=建议刷新
 workbench 页面确认生效。
 """
        try:
            data = await request.json()
        except Exception:  # noqa: BLE001
            raise HTTPException(status_code=400, detail="导入失败：请求体不是合法 JSON")
        # 容错：接受 {"config": {...}} 包裹（与 PUT /config 同形；正常配置无
        # 顶层 "config" 键，仅在包裹结构独占 body 时拆包，不误伤裸配置）。
        if (
            isinstance(data, dict)
            and set(data.keys()) == {"config"}
            and isinstance(data.get("config"), dict)
        ):
            data = data["config"]
        if not isinstance(data, dict):
            raise HTTPException(status_code=400, detail="导入失败：配置顶层必须是 JSON 对象")
        errors = _validate_config_shape(data)
        if errors:
            raise HTTPException(
                status_code=400,
                detail="导入失败：" + "；".join(errors),
            )
        prev = config_mod.load_config()
        try:
            config_mod.write_backup(prev)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=500,
                detail=f"导入中止：当前配置备份失败（未覆盖任何内容）：{exc}",
            ) from exc
        try:
            # refresh_backup=False：备份保持覆盖前状态（用户回滚点）。
            config_mod.save_config(data, refresh_backup=False)
        except IOError as exc:
            raise HTTPException(
                status_code=500,
                detail=f"配置导入失败（磁盘写入问题）：{exc}",
            ) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"配置导入失败：{exc}") from exc
        # 身份变更 → 同 PUT /config 语义（清缓存 + 自动重启同步游标）。
        restart = "page"
        if (prev.get("matrix") or {}).get("user_id") != (
            (data.get("matrix") or {}).get("user_id")
        ):
            invalidate_data_caches("config.import")
            from . import sync_watcher as _sw  # noqa: PLC0415

            await _sw.restart("config.import")
            restart = "none"
        # 生效地址探测转后台（同 PUT /config——effective 随后自动刷新）。
        asyncio.create_task(_safe_refresh_effective(config_mod.load_config()))
        return {
            "ok": True,
            "restart": restart,
            "config": config_mod.redact(config_mod.load_config()),
        }

    @router.post("/config/test")
    async def config_test(patch: ConfigTestRequest) -> Dict[str, Any]:
        """v0.5.0-beta.12: 连通性测试——逐地址测延迟，返回 {url, ok, ms, detail}。

 可传未保存的表单值（测试草稿地址）；不传则测已配置列表。
 仅当传入列表与已配置一致时才更新 working cache（applied=true）——
 草稿测试不动生效地址。
 """
        cfg = config_mod.load_config()
        # v0.5.0-beta.14.3: 条目 str | {url, auth?}——统一取 url 再测。
        def _urls(entries: Any) -> List[str]:
            return [config_mod.address_url(u) for u in (entries or []) if config_mod.address_url(u)]

        cfg_matrix = _urls(cfg.get("matrix_homeservers"))
        cfg_ctl = _urls(cfg.get("controller_urls"))
        matrix_list = _urls(patch.matrix or cfg_matrix)
        ctl_list = _urls(patch.controller or cfg_ctl)
        # v0.5.0-beta.12: SGLang 双地址（传草稿列表则测草稿，否则测已配置；兼容旧 "url"）。
        cfg_sg = cfg.get("sglang") or {}
        cfg_sg_urls = _urls(
            cfg_sg.get("urls")
            or ([cfg_sg.get("url")] if cfg_sg.get("url") else [])
        )
        sglang_list = _urls(patch.sglang or cfg_sg_urls)
        # v0.5.0-beta.14.17: Higress 双地址（传草稿列表则测草稿，否则测已配置）。
        cfg_gw_urls = _urls(cfg.get("gateway_admin_urls"))
        gateway_list = _urls(patch.gateway or cfg_gw_urls)
        # v0.5.0-beta.14.3: 草稿凭据随测——条目级 auth 图（未保存也能验）。
        auth_maps = {
            "matrix": config_mod.build_auth_map(patch.matrix if patch.matrix is not None else cfg.get("matrix_homeservers")),
            "controller": config_mod.build_auth_map(patch.controller if patch.controller is not None else cfg.get("controller_urls")),
            "sglang": config_mod.build_auth_map(
                (patch.sglang if patch.sglang is not None else cfg_sg.get("urls"))
            ),
            # v0.5.0-beta.14.17: Higress 覆盖凭据（同口径）。
            "gateway": config_mod.build_auth_map(
                (patch.gateway if patch.gateway is not None else cfg.get("gateway_admin_urls"))
            ),
        }
        token = (cfg.get("controller_token") or "").strip()

        prev = {
            "matrix": _pick_address(cfg, "matrix"),
            "controller": _pick_address(cfg, "controller"),
        }
        results = await selfcheck.test_addresses(
            matrix_list, ctl_list, sglang_list, token, with_diag=True,
            auth_maps=auth_maps,
            gateway_urls=gateway_list,
            # v0.5.0-beta.14.17: 会话三态——已配置且持有会话才探会话有效性。
            gateway_session_cookie=str(
                cfg.get("console_session") or ""
            ).strip(),
        )
        applied = False
        same_lists = (matrix_list == cfg_matrix) and (ctl_list == cfg_ctl)
        if same_lists and (matrix_list or ctl_list):
            await selfcheck.refresh_effective(cfg)
            applied = True
        effective = {
            "matrix": _pick_address(cfg, "matrix"),
            "controller": _pick_address(cfg, "controller"),
        }
        # v0.5.0-beta.12：测完自动切换要可见——switched 标记哪些类型换了生效地址。
        switched = {
            kind: bool(effective.get(kind) and effective[kind] != prev[kind])
            for kind in ("matrix", "controller")
        }
        return {
            "ok": True,
            "matrix": results["matrix"],
            "controller": results["controller"],
            "sglang": results["sglang"],
            # v0.5.0-beta.14.17: Higress 探测行（诊断面；未配置=空列表）。
            "gateway": results.get("gateway", []),
            "effective": effective,
            # v0.5.0-beta.14.1: 固定档回报——三类地址各自的固定值（None=未固定）。
            "pinned": _pinned_map(cfg),
            "applied": applied,
            "switched": switched,
        }

    @router.post("/config/verify-admin")
    async def verify_admin(body: VerifyAdminRequest) -> Dict[str, Any]:
        """v0.5.0-beta.12: L1 管理员验证（admin 账号密码 或 Controller token 二选一）。

 密码路径换不来 Controller 管理 API 凭据（controller 无 token 签发端点，
 不收 level-1 matrix token）——成功只授予 Console 会话（网关面）；
 Controller 管理 API 仍需 controller_token（UI 明示，与 dashboard
 「密码→env SA」的差异源于插件零凭据终端无服务端 SA）。
 """
        from . import config as cfgmod

        cfg = await asyncio.to_thread(cfgmod.load_config)

        username = (body.admin_username or "").strip()
        password = (body.admin_password or "").strip()
        token = (body.controller_token or "").strip()
        token_source = ""
        if password == "***":
            password = str(cfg.get("admin_password") or "")
        if token == "***" or not token:
            try:
                token, token_source = _resolve_controller_token(cfg)
            except TokenValidationError as e:
                return {"ok": False, "error": str(e), "tokenPath": False}
        else:
            try:
                token = _sanitize_token(token)
            except TokenValidationError as e:
                return {"ok": False, "error": str(e), "tokenPath": False}
            token_source = "input"
        # v0.5.0-beta.14.7: 双地址——body 列表/单值优先，配置次之；按序尝试，
        # 传输错误换下一地址，凭据错误立即报（地址无关）。
        console_urls: List[str] = []
        for u in list(body.gateway_admin_urls or []):
            su = str(u or "").strip().rstrip("/")
            if su and su not in console_urls:
                console_urls.append(su)
        if body.gateway_admin_url and str(body.gateway_admin_url).strip():
            su = str(body.gateway_admin_url).strip().rstrip("/")
            if su and su not in console_urls:
                console_urls.insert(0, su)
        if not console_urls:
            console_urls = [u.rstrip("/") for u in _address_list(cfg, "gateway") if u]
        console_url = console_urls[0] if console_urls else ""

        # --- 路径 A：admin 账号密码 → Console /session/login ---
        if username and password:
            # Higress 地址（v0.5.0-beta.12 设计，「同主机 8001/6868
            # 顺序探测行不通，每个人映射的端口都不一样」）：Higress Console 与
            # Controller 同容器不同端口（源码实锤：install 脚本
            # `docker exec agentteams-controller curl 127.0.0.1:8001`），但宿主
            # 端口是安装时用户自选（AGENTTEAMS_PORT_CONSOLE，默认 18001，
            # 某部署=6868）→ 固定端口探测必然漏，**改为必填**：留空=可操作错误
            # （不再盲探）。
            if not console_url:
                return {
                    "ok": False,
                    "error": (
                        "Higress 地址未配置：Higress Console 与 Controller "
                        "同机（同容器）不同端口，但宿主端口是部署时自选的（安装"
                        "脚本 AGENTTEAMS_PORT_CONSOLE，默认 18001）——请在设置里"
                        "填写「Higress 地址」后重试"
                    ),
                }
            # v0.5.0-beta.14.7: 逐地址尝试（传输错误换下一地址；凭据错误=地址
            # 无关，立即报；会话 cookie 由 Console 后端校验、跨入口通用）。
            rr = None
            last_exc: Optional[Exception] = None
            for cu in console_urls:
                try:
                    async with GatedAsyncClient(timeout=8.0, verify=False) as client:
                        rr = await client.post(
                            f"{cu}/session/login",
                            json={"username": username, "password": password},
                        )
                    console_url = cu
                    break
                except Exception as exc:  # noqa: BLE001 - 逐地址降级
                    last_exc = exc
                    continue
            if rr is None:
                return {
                    "ok": False,
                    "error": (
                        f"Higress 地址不可达（已试 {len(console_urls)} 个："
                        f"{last_exc.__class__.__name__ if last_exc else '未知'}）。"
                        "请检查端口——Console 宿主端口是部署时自选的（默认 "
                        "18001），与 Controller 端口不同"
                    ),
                }
            if rr.status_code in (400, 401, 403):
                # 地址通但凭据错 = 直接报（不再换端口试）。
                return {"ok": False, "error": "管理员账号验证失败（账号或密码不正确）"}
            if rr.status_code not in (200, 201, 204):
                return {
                    "ok": False,
                    "error": f"Higress 地址异常：HTTP {rr.status_code}（{console_url}）",
                }
            r = rr
            # 会话 cookie：整个 Set-Cookie 首段（cookie 名随 Higress 版本不定，
            # 存整值、回放时原样带 Cookie 头，最稳）。
            set_cookie = r.headers.get("set-cookie", "")
            session_cookie = set_cookie.split(";")[0].strip() if set_cookie else ""
            await asyncio.to_thread(
                cfgmod.update_config,
                {
                    "admin_username": username,
                    "admin_password": password,
                    "gateway_admin_url": console_url,
                    "gateway_admin_urls": console_urls,
                    "console_session": session_cookie,
                },
            )
            # v0.5.0-beta.12：会话到手立即自检 alias 层（有会话≠有 alias——
            # 解包/形状断点要在验证时就暴露，而不是等模型下拉静默平铺）。
            gw_routes, gw_aliases = 0, []
            if session_cookie:
                try:
                    async with GatedAsyncClient(timeout=8.0, verify=False) as client:
                        gr = await client.get(
                            f"{console_url}/v1/ai/routes",
                            headers={"Cookie": session_cookie},
                        )
                        gp = await client.get(
                            f"{console_url}/v1/ai/providers",
                            headers={"Cookie": session_cookie},
                        )
                    if gr.status_code == 200 and gp.status_code == 200:
                        gw_routes, gw_aliases = _count_gateway_aliases(
                            gr.json(), gp.json()
                        )
                except Exception:  # noqa: BLE001 — 自检失败不挡验证主流程
                    pass
            return {
                "ok": True,
                "mode": "password",
                "console": console_url,
                "has_console_session": bool(session_cookie),
                "gateway_routes": gw_routes,
                "gateway_aliases": gw_aliases,
                "note": "管理员身份验证通过，Higress Console 会话已持有（Higress 面可用）；Controller 管理 API（CRD）仍需配置 Controller 管理员 token。",
            }

        # --- 路径 B：Controller 管理员 token ---
        if token:
            cfg_ctl = [
                u.strip().rstrip("/")
                for u in (cfg.get("controller_urls") or [])
                if u and u.strip()
            ]
            if not cfg_ctl:
                return {"ok": False, "error": "请先配置 Controller 地址"}
            ok = False
            last_err = ""
            for base in cfg_ctl:
                try:
                    async with GatedAsyncClient(timeout=8.0, verify=False) as client:
                        rr = await client.get(
                            f"{base}/api/v1/teams",
                            headers=_headers_for(
                                cfg, "controller", base,
                                {"Authorization": f"Bearer {token}"},
                            ),
                        )
                    if rr.status_code == 200:
                        ok = True
                        break
                    last_err = f"HTTP {rr.status_code}"
                except Exception as exc:
                    last_err = exc.__class__.__name__
            if not ok:
                return {"ok": False, "error": f"Controller 管理员 token 无效（{last_err}）"}
            # env 来源不落盘：保持 config 为空让 env 保持唯一事实源
            # （token 轮换=更新 QwenPaw env，不会被旧 config 值遮蔽）。
            if token_source in ("input", "config"):
                await asyncio.to_thread(
                    cfgmod.update_config, {"controller_token": token}
                )
            return {
                "ok": True,
                "mode": "token",
                "tokenSource": token_source,
                "message": (
                    "Controller 管理员 token 验证通过（来源=环境变量 AGENTTEAMS_CONTROLLER_TOKEN，未写入本地配置——token 轮换时更新 QwenPaw 宿主 env 即可）。"
                    if token_source == "env"
                    else "Controller 管理员 token 验证通过：已保存。"
                ),
            }

        return {
            "ok": False,
            "error": "请填写管理员账号与密码，或 Controller 管理员 token（二选一；token 获取命令见设置页提示，或部署期注入 env AGENTTEAMS_CONTROLLER_TOKEN）",
        }
    async def _gateway_passthrough(
        path: str,
        method: str = "GET",
        json_body: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """v0.5.0-beta.12: 网关面透传（Higress Console，8001）。

 v0.5.0-beta.12.13：加写面（POST，「添加提供商/添加路由」P7b）；
 v0.5.0-beta.14.4：加编辑/删除面（PUT/DELETE，与 dashboard higress
 BFF `/api/higress/ai-{routes,providers}` 同款 Console 端点）；
 写失败时透出 Console 的 message/detail 供 UI 显示。

 消费密码模式持有的 Console 管理员会话（console_session）；
 无会话/不可达 → available=false（前端优雅降级：模型选择器
 alias 层隐藏，SGLang 列表+Worker 现值+自由输入不受影响）。
 原始 JSON 直出，形状由前端解析（与 dashboard higress-api 同义）。
 """
        from . import config as cfgmod

        cfg = await asyncio.to_thread(cfgmod.load_config)
        session = str(cfg.get("console_session") or "")
        # v0.5.0-beta.14.7: Higress 双地址（canonical=gateway_admin_urls，空则
        # 回退 legacy 单值）——按序降级。
        gateways = _address_list(cfg, "gateway")
        if not session or not gateways:
            return {"available": False, "data": None, "reason": "no_console_session"}
        # v0.5.0-beta.14.7: 逐地址降级——传输错误换下一地址；拿到响应=地址可达，
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
            if r.status_code not in (200, 201, 204):
                out: Dict[str, Any] = {
                    "available": False,
                    "data": None,
                    "reason": f"http_{r.status_code}",
                }
                detail = ""
                try:
                    j = r.json()
                    msg = j.get("message") or j.get("error") or j.get("detail")
                    if msg:
                        detail = str(msg)
                except Exception:
                    detail = ""
                if not detail:
                    text = getattr(r, "text", "") or ""
                    if isinstance(text, str):
                        detail = text[:300]
                if detail:
                    out["detail"] = detail
                return out
            return {"available": True, "data": r.json()}
        except Exception as exc:
            return {"available": False, "data": None, "reason": exc.__class__.__name__}

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

    # ---- v0.5.0-beta.14.4：模型配置编辑/删除（Console 写面透传，与 dashboard
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

    @router.get("/teams/rooms")
    # 【历史替代，勿删】实时聚合版；现役用 /teams/sync（缓存+force）。排查缓存问题时的对照端点。
    async def teams_rooms() -> Dict[str, Any]:
        """Aggregated room list: joined_rooms + name + members per room.

 Concurrent with a semaphore (58 rooms serial ≈ minutes → concurrent
 ≈ seconds). Falls back to a DM-style name when a room has no
 m.room.name. Uses the cached working homeserver.
 """
        import asyncio
        import time as time_mod

        started = time_mod.time()
        cfg = config_mod.load_config()
        matrix_cfg = cfg.get("matrix") or {}
        token = (matrix_cfg.get("access_token") or "").strip()
        user_id = (matrix_cfg.get("user_id") or "").strip()
        homeserver = _pick_address(cfg, "matrix")
        if not homeserver:
            raise HTTPException(status_code=502, detail="未配置 Matrix 地址")
        if not token:
            raise HTTPException(status_code=401, detail="未登录，请先在配置页登录")

        try:
            # v0.5.0-beta.14.5: 同步 matrix_client 调用 to_thread 化——避免冻结
            # 宿主事件循环（原实现直调同步 httpx，最长 20s）。
            rooms = (
                await asyncio.to_thread(
                    matrix_client.joined_rooms, homeserver, token
                )
            ).get("joined_rooms", [])
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=502,
                detail=f"{selfcheck._classify_error(exc)}{_pinned_note(cfg)}",
            ) from exc

        logger.info(
            "teams/rooms: %d rooms on %s",
            len(rooms),
            homeserver,
        )

        sem = asyncio.Semaphore(10)

        async def _room_info(room_id: str) -> Dict[str, Any]:
            entry: Dict[str, Any] = {
                "room_id": room_id,
                "name": "",
                "members": {},
                "member_count": 0,
                "name_fallback": False,
            }
            # v0.5.0-beta.14.5: 单房两往返（成员 + 房名）并发——原串行 2×RTT/房，
            # 75 房叠加 WAN 实测 11.3s。best-effort 容错与日志语义不变。
            async def _members() -> None:
                try:
                    members = await asyncio.to_thread(
                        matrix_client.joined_members, homeserver, token, room_id
                    )
                    joined = members.get("joined") or {}
                    entry["members"] = joined
                    entry["member_count"] = len(joined)
                except Exception as exc:  # noqa: BLE001 - best-effort
                    logger.warning(
                        "teams/rooms: joined_members failed for %s: %s",
                        room_id,
                        exc,
                    )

            async def _name() -> None:
                try:
                    async with GatedAsyncClient(timeout=4.0, verify=False) as client:
                        resp = await client.get(
                            f"{homeserver.rstrip('/')}/_matrix/client/v3/rooms/{room_id}/state/m.room.name",
                            headers=_headers_for(cfg, "matrix", homeserver,
                                {"Authorization": f"Bearer {token}"}),
                        )
                    if resp.status_code == 200:
                        entry["name"] = (resp.json().get("name") or "").strip() or ""
                except Exception as exc:  # noqa: BLE001 - best-effort
                    logger.debug(
                        "teams/rooms: name lookup failed for %s: %s",
                        room_id,
                        exc,
                    )

            async with sem:
                await asyncio.gather(_members(), _name())
            if not entry["name"]:
                others = [
                    (m.get("display_name") or uid)
                    for uid, m in entry["members"].items()
                    if uid != user_id
                ]
                entry["name"] = "、".join(others[:3]) or "（空房间）"
                entry["name_fallback"] = True
            return entry

        entries = await asyncio.gather(*(_room_info(r) for r in rooms))
        result = list(entries)

        all_members: Dict[str, Dict[str, Any]] = {}
        for entry in result:
            # Only group rooms (>2 members) contribute to the Worker tree —
            # DM contacts are not team Workers.
            if entry["member_count"] > 2:
                for mxid, profile in entry["members"].items():
                    if mxid not in all_members:
                        all_members[mxid] = profile if isinstance(profile, dict) else {}

        result.sort(key=lambda r: (r["name_fallback"], r["name"]))
        # Worker-dimension groups for the SpawnTree view (design):
        # Leader and Workers are all Workers; spawn lists stay empty until
        # the spawn endpoint merges (adapter swaps the data source).
        from . import spawn_tree as spawn_tree_mod

        worker_groups = spawn_tree_mod.build_worker_groups(all_members, user_id)
        elapsed = time_mod.time() - started
        logger.info(
            "teams/rooms: done %d rooms / %d workers in %.1fs",
            len(result),
            len(worker_groups),
            elapsed,
        )
        return {
            "ok": True,
            "rooms": result,
            "user_id": user_id,
            "worker_groups": worker_groups,
            "elapsed": round(elapsed, 1),
        }

    @router.post("/matrix/upload")
    async def matrix_upload(request: Request) -> Dict[str, Any]:
        """文件上传：multipart form → Matrix media upload → 返回 content_uri。

 用户向房间发文件/图片的反向交付通道（先上传拿 mxc，再发 m.file/m.image）。
 """
        import httpx as _httpx
        import urllib.parse as _up

        cfg = config_mod.load_config()
        matrix_cfg = cfg.get("matrix") or {}
        token = (matrix_cfg.get("access_token") or "").strip()
        homeserver = _pick_address(cfg, "matrix")
        if not homeserver:
            raise HTTPException(status_code=502, detail="未配置 Matrix 地址")
        if not token:
            raise HTTPException(status_code=401, detail="未登录，请先在配置页登录")

        try:
            form = await request.form()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=400, detail="需要 multipart 表单（file 字段）"
            ) from exc
        file_obj = form.get("file")
        if file_obj is None:
            raise HTTPException(status_code=400, detail="缺少 file 字段")
        data = await file_obj.read()
        if not data:
            raise HTTPException(status_code=400, detail="文件为空")
        filename = (file_obj.filename or "file").strip() or "file"
        content_type = file_obj.content_type or "application/octet-stream"

        url = (
            f"{homeserver.rstrip('/')}/_matrix/media/v3/upload"
            f"?filename={_up.quote(filename, safe='')}"
        )
        try:
            async with GatedAsyncClient(timeout=60.0, verify=False) as client:
                resp = await client.post(
                    url,
                    content=data,
                    headers=_headers_for(
                        cfg, "matrix", homeserver,
                        {
                            "Authorization": f"Bearer {token}",
                            "Content-Type": content_type,
                        },
                    ),
                )
            if resp.status_code != 200:
                raise HTTPException(
                    status_code=502,
                    detail=f"Matrix 上传失败 HTTP {resp.status_code}",
                )
            payload = resp.json()
            content_uri = payload.get("content_uri") or ""
            if not content_uri:
                raise HTTPException(status_code=502, detail="Matrix 未返回 content_uri")
            return {"ok": True, "content_uri": content_uri, "filename": filename}
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=502,
                detail=f"{selfcheck._classify_error(exc)}{_pinned_note(cfg)}",
            ) from exc

    @router.get("/docker-logs/{component}")
    async def docker_logs(component: str, tail: int = 300) -> Dict[str, Any]:
        """组件日志：经 Controller Docker API 反向代理拉容器日志并解析。

 上游：Controller /docker/v1.41/containers/{name}/logs（http.go L145
 Docker API 代理）。docker 流 = 8 字节头（type+size）+ payload，
 在此解析成行列表（dashboard 同款 parseDockerLogs 逻辑）。
 """
        import httpx as _httpx

        cfg = config_mod.load_config()
        ctl_token = _token_or_none(cfg)
        matrix_cfg = cfg.get("matrix") or {}
        headers: Dict[str, str] = {}
        if ctl_token:
            headers["Authorization"] = f"Bearer {ctl_token}"
        elif (matrix_cfg.get("access_token") or "").strip():
            headers["Authorization"] = f"Bearer {matrix_cfg.get('access_token')}"
        # 组件名 → 容器名（dashboard resolveContainerName 同款映射）。
        container = {
            "controller": "agentteams-controller",
            "manager": "agentteams-manager",
            "matrix": "agentteams-controller",
            "minio": "agentteams-controller",
            "higress": "agentteams-controller",
        }.get(component, component)
        # 容器名白名单：仅字母数字._-（防注入）。
        import re as _re
        if not _re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]*$", container):
            raise HTTPException(status_code=400, detail="非法组件名")

        # path 与 query 分离：quote 只编码 path（safe 不含 ? & =），
        # query string 原样拼接——否则 ?stdout=1 会被编码成 %3F... 塞进 path。
        raw_path = f"/docker/v1.41/containers/{container}/logs"
        query_string = (
            f"?stdout=1&stderr=1&timestamps=1&tail={max(1, min(int(tail), 2000))}"
        )
        encoded = __import__("urllib.parse", fromlist=["quote"]).quote(
            raw_path, safe="/._-~"
        )
        base_urls = _ordered_addresses(cfg, "controller")
        if not base_urls:
            raise HTTPException(status_code=502, detail="未配置 Controller 地址")
        last_error = "无可用地址"
        for base in base_urls:
            target = f"{base.rstrip('/')}{encoded}{query_string}"
            try:
                # v0.5.0-beta.14.18（14.17 「运行日志 HTTP 502: Docker API
                # 401」根因）：该端点漏在 14.3 的 _headers_for 覆盖凭据修复面
                # 外——外网固定档（address_mode=wan）经公网网关时只发 Bearer，
                # 网关 Basic 门拒收 → 401 → 本端点转 502。其余 15+ 拨号点早已
                # 逐地址走 _headers_for（该地址配了覆盖凭据则替换 Authorization，
                # 未配则原样 Bearer）；此处补上，全族一致。
                async with GatedAsyncClient(timeout=30.0, verify=False) as client:
                    resp = await client.get(
                        target, headers=_headers_for(cfg, "controller", base, headers)
                    )
                if resp.status_code == 401 and not ctl_token:
                    raise HTTPException(
                        status_code=401,
                        detail="查看日志需要 Controller 管理员 token（配置页填写）",
                    )
                if resp.status_code != 200:
                    # 透传上游响应体前 200 字（诊断 500/403 根因用）。
                    body_preview = ""
                    try:
                        body_preview = (resp.text or "")[:200]
                    except Exception:  # noqa: BLE001
                        body_preview = ""
                    raise HTTPException(
                        status_code=502,
                        detail=(
                            f"Docker API {resp.status_code}"
                            + (f"：{body_preview}" if body_preview else "")
                        ),
                    )
                _mark_working("controller", base)
                lines = _parse_docker_stream(resp.content, component)
                return {
                    "ok": True,
                    "component": component,
                    "container": container,
                    "lines": lines,
                }
            except HTTPException:
                raise
            except Exception as exc:  # noqa: BLE001
                last_error = selfcheck._classify_error(exc)
        raise HTTPException(
            status_code=502, detail=f"日志拉取失败：{last_error}{_pinned_note(cfg)}"
        )

    @router.post("/dm")
    async def open_dm(req: DmRequest) -> Dict[str, Any]:
        """Open (create-or-reuse) a DM room with a team member.

 Body: {user: target MXID or bare localpart}.
 """
        cfg = config_mod.load_config()
        matrix_cfg = cfg.get("matrix") or {}
        token = (matrix_cfg.get("access_token") or "").strip()
        homeserver = _pick_address(cfg, "matrix")
        if not homeserver:
            raise HTTPException(status_code=502, detail="未配置 Matrix 地址")
        if not token:
            raise HTTPException(status_code=401, detail="未登录，请先在配置页登录")

        target = req.user.strip()
        if not target.startswith("@"):
            # Bare localpart → construct MXID with the server part of the
            # configured user (same homeserver).
            me = (matrix_cfg.get("user_id") or "").strip()
            server = me.split(":", 1)[1] if ":" in me else ""
            if not server:
                raise HTTPException(
                    status_code=400, detail="无法确定 homeserver 域名，请填完整 MXID"
                )
            target = f"@{target}:{server}"
        try:
            # v0.5.0-beta.14.5: to_thread（同步 httpx，最长 20s）。
            result = await asyncio.to_thread(
                matrix_client.create_dm, homeserver, token, target
            )
        except matrix_client.MatrixError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=502,
                detail=f"{selfcheck._classify_error(exc)}{_pinned_note(cfg)}",
            ) from exc
        return {"ok": True, "target": target, **result}

    @router.get("/matrix/member/messages")
    async def member_messages(
        roomId: str,
        sender: str,
        limit: int = 5,
        maxPages: int = 6,
    ) -> Dict[str, Any]:
        """成员最近消息（成员详情卡）：/messages 翻页按 sender 过滤。

 Matrix /search 的 filter.senders 虽有效（实测 Tuwunel），但
 search_term 必须命中正文（AND 语义）——无法表达"该成员全部最近
 消息"。改用 /messages dir=b 逐页扫（每页 50，最多 maxPages 页），
 收集该 sender 的 m.room.message 直到 limit 条。语义准确且复用
 已验证的 messages 端点。
 """
        cfg = config_mod.load_config()
        matrix_cfg = cfg.get("matrix") or {}
        token = (matrix_cfg.get("access_token") or "").strip()
        homeservers = _ordered_addresses(cfg, "matrix")
        if not homeservers:
            raise HTTPException(status_code=502, detail="未配置 Matrix 地址")
        if not token:
            raise HTTPException(status_code=401, detail="未登录，请先在配置页登录")

        limit = max(1, min(int(limit), 20))
        # v0.5.0-beta.14.17：上限 10→5 页。limit≤20 条
        # 散在 500+ 条之外=该成员在此房近乎沉默，抽屉价值低；5 页
        # （250 条）覆盖正常场景，省最坏 5×~250KB 上游拨号。
        max_pages = max(1, min(int(maxPages), 5))
        import urllib.parse as _urlparse_mod

        found: List[Dict[str, Any]] = []
        from_token = ""
        last_error = "无可用地址"
        for page in range(max_pages):
            params = {
                "dir": "b",
                "limit": "50",
                # v0.5.0-beta.14.7（带宽）：只要 message 事件。
                "filter": '{"types":["m.room.message"]}',
            }
            if from_token:
                params["from"] = from_token
            qs = _urlparse_mod.urlencode(params)
            raw_path = (
                f"/_matrix/client/v3/rooms/{_urlparse_mod.quote(roomId, safe='')}"
                f"/messages?{qs}"
            )
            payload: Optional[Dict[str, Any]] = None
            for hs in homeservers:
                try:
                    async with GatedAsyncClient(
                        timeout=12.0, verify=False
                    ) as client:
                        resp = await client.get(
                            f"{hs.rstrip('/')}{raw_path}",
                            headers=_headers_for(cfg, "matrix", hs,
                                {"Authorization": f"Bearer {token}"}),
                        )
                    if resp.status_code >= 400:
                        raise matrix_client.MatrixError(
                            f"Matrix GET /messages -> {resp.status_code}: "
                            f"{resp.text[:200]}"
                        )
                    payload = resp.json()
                    _mark_working("matrix", hs)
                    break
                except matrix_client.MatrixError as exc:
                    raise HTTPException(
                        status_code=502, detail=f"Matrix messages 失败：{exc}"
                    ) from exc
                except Exception as exc:  # noqa: BLE001
                    last_error = selfcheck._classify_error(exc)
            if payload is None:
                raise HTTPException(
                    status_code=502, detail=f"messages 请求失败：{last_error}{_pinned_note(cfg)}"
                )
            chunk = payload.get("chunk") or []
            for ev in chunk:
                if not isinstance(ev, dict):
                    continue
                if ev.get("type") != "m.room.message":
                    continue
                if str(ev.get("sender") or "") != sender:
                    continue
                content = ev.get("content") or {}
                body = str(content.get("body") or "")
                if not body:
                    continue
                found.append(
                    {
                        "event_id": str(ev.get("event_id") or ""),
                        "sender": sender,
                        "body": body[:600],
                        "origin_server_ts": int(ev.get("origin_server_ts") or 0),
                    }
                )
                if len(found) >= limit:
                    break
            if len(found) >= limit:
                break
            end = str(payload.get("end") or "")
            if not end or end == from_token:
                break
            from_token = end
        return {"ok": True, "messages": found}

    @router.get("/events")
    async def events_stream() -> Any:
        """SSE 事件流（IM 式触发）：sync watcher 检测到 @提到我 时推送。

 前端 EventSource 订阅（无 Authorization header——宿主 auth 启用
 时需 allow_no_auth_hosts 或回退轮询）。心跳 comment 每 15s 保活。
 """
        import asyncio as _asyncio

        from . import sync_watcher

        queue = sync_watcher.subscribe()

        async def gen():
            try:
                while True:
                    try:
                        event = await _asyncio.wait_for(queue.get(), timeout=15.0)
                        data = _json_dumps(event)
                        yield f"data: {data}\n\n"
                    except _asyncio.TimeoutError:
                        yield ": keepalive\n\n"
            finally:
                sync_watcher.unsubscribe(queue)

        return StreamingResponse(
            gen(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )

    @router.post("/notify")
    # 【预埋，勿删】UI 主动推送通知通用入口（产物完成通知等未来触发点；@mention 已由 sync_watcher 直写 inbox_store 覆盖）。
    async def notify(req: NotifyRequest) -> Dict[str, Any]:
        """写入宿主收件箱（inbox_store.append_event 内部通道）。

 宿主 OS 通知轮询器只认白名单 source_type（console/src/utils/
 inboxEvents.ts PUSH_MESSAGE_SOURCES）；非 QwenPaw 宿主环境（无
 inbox_store）→ 501，前端静默降级。
 """
        try:
            from qwenpaw.app.inbox_store import append_event
        except ImportError:
            raise HTTPException(
                status_code=501, detail="宿主收件箱不可用"
            ) from None
        # OS 通知白名单映射：os_notify 时用 "cron"（白名单内），否则用
        # 自定义 source_type（只进收件箱不打扰）。
        source = "cron" if req.os_notify else req.source_type
        severity = str(req.severity or "info").lower()
        if severity not in ("info", "warning", "critical"):
            severity = "info"
        try:
            event = await append_event(
                agent_id=None,
                source_type=source,
                source_id="agentteams-qwenpaw-workbench",
                event_type="plugin",
                status="info",
                title=req.title.strip(),
                body=req.body.strip(),
                severity=severity,
            )
        except Exception as exc:  # noqa: BLE001 - 收件箱满/IO 失败不阻塞插件
            logger.warning("inbox append failed: %s", exc)
            raise HTTPException(
                status_code=502, detail=f"收件箱写入失败：{exc}"
            ) from exc
        return {"ok": True, "event_id": str(event.get("id") or "")}

    class MarkReadRequest(BaseModel):
        room_id: str = ""
        event_id: str = ""
        room_ids: List[str] = []

    @router.post("/matrix/mark-read")
    async def matrix_mark_read(req: MarkReadRequest) -> Dict[str, Any]:
        """已读回执双写（m.read + m.fully_read）。

 协议与 dashboard 对齐（交叉验证基准）：
 - m.read: POST /receipt/m.read/{eventId}（event 级）
 - m.fully_read: PUT /user/{uid}/rooms/{rid}/account_data/m.fully_read
 body {"event_id"}（房间级读线，清 Element 未读）

 两种模式：
 - 单房间：room_id（+ 可选 event_id，缺省取房间最新消息）。
 - 批量：room_ids（一键全部已读）——逐房间取最新消息后双写，
 空房间/无历史跳过。best-effort：单房间失败不拖垮其余。
 """
        from . import matrix_client as _mc

        cfg = config_mod.load_config()
        matrix_cfg = cfg.get("matrix") or {}
        token = (matrix_cfg.get("access_token") or "").strip()
        user_id = (matrix_cfg.get("user_id") or "").strip()
        homeservers = _ordered_addresses(cfg, "matrix")
        if not homeservers:
            raise HTTPException(status_code=502, detail="未配置 Matrix 地址")
        if not token:
            raise HTTPException(status_code=401, detail="未登录，请先在配置页登录")
        hs = homeservers[0]

        if req.room_ids:
            targets = [
                (rid, "")
                for rid in dict.fromkeys(r for r in req.room_ids if r)
            ]
        elif req.room_id:
            targets = [(req.room_id, req.event_id)]
        else:
            raise HTTPException(status_code=400, detail="room_id 或 room_ids 必填")

        import asyncio as _asyncio

        marked = 0
        skipped = 0
        errors: List[str] = []
        for rid, eid in targets:
            try:
                # 同步 httpx 走线程池——不阻塞 event loop（matrix/search
                # 同类问题，搜索慢主因）。
                event_id = eid or await _asyncio.to_thread(
                    _mc.latest_event_id, hs, token, rid
                )
                if not event_id:
                    skipped += 1
                    continue
                await _asyncio.to_thread(
                    _mc.send_read_receipt, hs, token, rid, event_id
                )
                if user_id:
                    await _asyncio.to_thread(
                        _mc.set_fully_read, hs, token, user_id, rid, event_id
                    )
                marked += 1
            except Exception as exc:  # noqa: BLE001 - best-effort 逐房间
                errors.append(f"{rid}: {str(exc)[:120]}")
        return {"ok": True, "marked": marked, "skipped": skipped, "errors": errors}

    @router.post("/matrix/search")
    async def matrix_search(req: SearchRequest) -> Dict[str, Any]:
        """Matrix /search 全文检索（消息搜索）。

 Tuwunel 已验证支持（实测：filter 必填、中文/分页/group_by
 全可用）。房间内搜索传 roomId 过滤；跨房间不传。房间名从 /sync
 聚合缓存映射；缓存未就绪时 fallback 房间 ID 截断名。结果按时间
 倒序，nextBatch 透传分页。
 """
        cfg = config_mod.load_config()
        matrix_cfg = cfg.get("matrix") or {}
        token = (matrix_cfg.get("access_token") or "").strip()
        homeservers = _ordered_addresses(cfg, "matrix")
        if not homeservers:
            raise HTTPException(status_code=502, detail="未配置 Matrix 地址")
        if not token:
            raise HTTPException(status_code=401, detail="未登录，请先在配置页登录")

        last_error = "无可用地址"
        payload: Optional[Dict[str, Any]] = None
        # 异步直连：同步 httpx 会阻塞 FastAPI event loop（搜索慢的主因，
        # "搜索再快一点"），改用 AsyncClient + 手组 body。
        search_body: Dict[str, Any] = {
            "search_term": req.term.strip(),
            "filter": {"rooms": [req.roomId]} if req.roomId else {},
            "order_by": "recent",
            "groupings": {"group_by": [{"key": "room_id"}]},
            "include_profile": True,
            "limit": req.limit,
        }
        if req.nextBatch:
            search_body["next_batch"] = req.nextBatch
        matrix_body = {"search_categories": {"room_events": search_body}}
        for hs in homeservers:
            try:
                async with GatedAsyncClient(
                    timeout=12.0, verify=False
                ) as client:
                    resp = await client.post(
                        f"{hs.rstrip('/')}/_matrix/client/v3/search",
                        json=matrix_body,
                        headers=_headers_for(cfg, "matrix", hs,
                                {"Authorization": f"Bearer {token}"}),
                    )
                if resp.status_code >= 400:
                    raise matrix_client.MatrixError(
                        f"Matrix POST /search -> {resp.status_code}: "
                        f"{resp.text[:200]}"
                    )
                payload = resp.json()
                _mark_working("matrix", hs)
                break
            except matrix_client.MatrixError as exc:
                # 404/405 = homeserver 不支持搜索端点——直接透传，不换路。
                raise HTTPException(
                    status_code=502,
                    detail=f"Matrix 搜索失败：{exc}",
                ) from exc
            except Exception as exc:  # noqa: BLE001 - network-level, try next
                last_error = selfcheck._classify_error(exc)
        if payload is None:
            raise HTTPException(
                status_code=502, detail=f"搜索请求失败：{last_error}{_pinned_note(cfg)}"
            )

        room_events = (
            (payload.get("search_categories") or {}).get("room_events") or {}
        )
        count = int(room_events.get("count") or 0)
        next_batch = str(room_events.get("next_batch") or "")

        # 房间名映射：/sync 聚合缓存（60s TTL）里有完整房间列表。
        room_names: Dict[str, str] = {}
        with _rooms_cache_lock:
            cached_entry = _rooms_cache["data"]
        if cached_entry:
            for r in (cached_entry or {}).get("rooms") or []:
                if isinstance(r, dict) and r.get("room_id"):
                    room_names[str(r["room_id"])] = str(r.get("name") or "")

        def _fallback_room_name(rid: str) -> str:
            short = rid.split(":", 1)[0]
            return short[:16] + ("…" if len(short) > 16 else "")

        results: List[Dict[str, Any]] = []
        for item in room_events.get("results") or []:
            ev = (item or {}).get("result") or {}
            if not isinstance(ev, dict):
                continue
            content = ev.get("content") or {}
            body = str(content.get("body") or "")
            rid = str(ev.get("room_id") or "")
            if not rid or not body:
                continue
            results.append(
                {
                    "room_id": rid,
                    "room_name": room_names.get(rid) or _fallback_room_name(rid),
                    "event_id": str(ev.get("event_id") or ""),
                    "sender": str(ev.get("sender") or ""),
                    "body": body[:400],
                    "origin_server_ts": int(ev.get("origin_server_ts") or 0),
                }
            )
        return {
            "ok": True,
            "count": count,
            "next_batch": next_batch,
            "results": results,
        }

    @router.post("/login")
    async def login(req: LoginRequest) -> Dict[str, Any]:
        """Matrix password login with failover across homeserver paths."""
        cfg = config_mod.load_config()
        homeservers = _ordered_addresses(cfg, "matrix")
        if not homeservers:
            raise HTTPException(
                status_code=400, detail="未配置 Matrix 地址，先保存配置"
            )
        last_error = "无可用地址"
        for hs in homeservers:
            try:
                # v0.5.0-beta.14.5: to_thread（同步 httpx，最长 20s）。
                data = await asyncio.to_thread(
                    matrix_client.login, hs, req.user, req.password
                )
                _mark_working("matrix", hs)
                merged = config_mod.update_config(
                    {
                        "matrix": {
                            "user_id": data.get("user_id", ""),
                            "access_token": data.get("access_token", ""),
                            "device_id": data.get("device_id", ""),
                        }
                    }
                )
                logger.info(
                    "login ok: %s via %s (device %s)",
                    data.get("user_id"),
                    hs,
                    data.get("device_id", "?"),
                )
                # v0.5.0-beta.12: 切账号 = 数据源切换——清 60s 聚合缓存（手动刷新不再
                # 命中旧账号数据）+ 重置 sync 游标（since 跨账号无效，旧游标
                # 会让 /sync 一直 401、@通知链全断）。
                invalidate_data_caches("login")
                from . import sync_watcher as _sw  # noqa: PLC0415

                await _sw.restart("login")
                return config_mod.redact(merged)
            except matrix_client.MatrixError as exc:
                last_error = str(exc)
                logger.warning(
                    "login failed (auth) for %s via %s: %s",
                    req.user,
                    hs,
                    last_error,
                )
                # Auth errors are definitive — do not try the other path.
                raise HTTPException(status_code=401, detail=last_error) from exc
            except Exception as exc:  # noqa: BLE001 - network-level, try next
                last_error = selfcheck._classify_error(exc)
                logger.warning("login failed (network) via %s: %s", hs, last_error)
        raise HTTPException(
            status_code=502, detail=f"所有地址登录失败：{last_error}{_pinned_note(cfg)}"
        )

    @router.post("/selfcheck/{level}")
    async def run_selfcheck(level: str) -> Dict[str, Any]:
        """Run L0/L1/L2/all self-check against the current config."""
        cfg = config_mod.load_config()
        if level == "l0":
            return selfcheck.run_l0()
        if level == "l1":
            return await selfcheck.run_l1(cfg)
        if level == "l2":
            # v0.5.0-beta.14.5: run_l2 全同步（httpx 10s+15s）——to_thread 化。
            return await asyncio.to_thread(selfcheck.run_l2, cfg)
        if level == "l3":
            return await selfcheck.run_l3(cfg)
        if level == "l4":
            return await selfcheck.run_l4(cfg)
        if level == "all":
            return await selfcheck.run_all(cfg)
        raise HTTPException(status_code=400, detail="unknown level (l0-l4/all)")

    @router.get("/media/proxy")
    async def proxy_direct_url(url: str) -> Response:
        """Server-side fetch of a direct http(s) file URL (v0.5.0-beta.12 ).

 Worker m.file 事件的 url 除 mxc:// 外也可能是直链（内网 MinIO/
 本地 http 服务等）。浏览器 fetch 跨域会被 CORS 拦、<img>/a[download]
 跨域下载变导航——后端与服务器同网段可达，代抓后经宿主鉴权链
 （host.fetch）回流前端，预览/下载/图片缩略图统一走此路径。
 仅放行 http/https（file:// 等本地协议不进代理）。
 """
        if not url.startswith(("http://", "https://")):
            raise HTTPException(
                status_code=400, detail="仅支持 http(s) 直链代抓"
            )
        try:
            async with GatedAsyncClient(
                timeout=60.0, verify=False, follow_redirects=True
            ) as client:
                resp = await client.get(url)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=502,
                detail=f"直链代抓失败：{selfcheck._classify_error(exc)}",
            ) from exc
        return Response(
            content=resp.content,
            status_code=resp.status_code,
            media_type=resp.headers.get("content-type"),
            headers={
                "Content-Disposition": resp.headers.get(
                    "content-disposition", "inline"
                )
            },
        )

    @router.get("/media/{server}/{media_id:path}")
    async def download_media(server: str, media_id: str) -> Response:
        """Download Matrix media (mxc://server/mediaId) via the homeserver.

 RoomChat files/images use this endpoint — browser auth-free download
 of m.file/m.image attachments with the stored Matrix token.
 """
        cfg = config_mod.load_config()
        matrix_cfg = cfg.get("matrix") or {}
        token = (matrix_cfg.get("access_token") or "").strip()
        homeserver = _pick_address(cfg, "matrix")
        if not homeserver:
            raise HTTPException(status_code=502, detail="未配置 Matrix 地址")
        if not token:
            raise HTTPException(status_code=401, detail="未登录")
        import urllib.parse as _urlparse_mod

        encoded_media = _urlparse_mod.quote(media_id, safe="/._-~")
        # 双路径回退——Tuwunel 媒体路由在不同构建间有漂移：
        # 旧版 /_matrix/media/v3/* 与新版 /_matrix/client/v1/media/*
        # 内网实锤（真实 mxc 带 token）两条都 200；外网构建无法
        # 从开发容器验证（DPI 拦截 TLS）。先旧版后新版，4xx 回退另一条；
        # 两条都 4xx → 透传 errcode 诊断（M_NOT_FOUND=媒体缺失/联邦源
        # 不可达，M_UNRECOGNIZED=该构建无此路由）。
        base = homeserver.rstrip("/")
        media_paths = (
            f"{base}/_matrix/media/v3/download/{server}/{encoded_media}",
            f"{base}/_matrix/client/v1/media/download/{server}/{encoded_media}",
        )
        attempts: List[str] = []
        resp = None
        try:
            async with GatedAsyncClient(timeout=60.0, verify=False) as client:
                for url in media_paths:
                    r = await client.get(
                        url, headers=_headers_for(cfg, "matrix", base,
                            {"Authorization": f"Bearer {token}"})
                    )
                    if r.status_code < 400:
                        resp = r
                        break
                    errcode = ""
                    try:
                        errcode = r.json().get("errcode", "")
                    except Exception:  # noqa: BLE001
                        pass
                    attempts.append(
                        f"{url.replace(base, '')}→{r.status_code}"
                        + (f" {errcode}" if errcode else "")
                    )
                    resp = r  # 兜底：末次响应（全失败时透传）
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=502,
                detail=f"媒体下载失败：{selfcheck._classify_error(exc)}{_pinned_note(cfg)}",
            ) from exc
        if resp is None or resp.status_code >= 400:
            detail = (
                f"媒体下载失败（mxc://{server}/{media_id[:24]}…）："
                + "；".join(attempts)
                + "——M_NOT_FOUND=媒体不存在或联邦源不可达，"
                + "M_UNRECOGNIZED=该服务器无此路由"
            )
            raise HTTPException(status_code=resp.status_code, detail=detail)
        return Response(
            content=resp.content,
            status_code=resp.status_code,
            media_type=resp.headers.get("content-type"),
            headers={
                "Content-Disposition": resp.headers.get(
                    "content-disposition", "inline"
                )
            },
        )

    # ── 远端团队知识库（用户定位：知识库=自己团队的
    # Leader/Worker 知识库，不是宿主本地）────────────────────────────
    # 数据通道：Controller Docker API 反向代理（docker/v1.41/...，
    # 上游 internal/proxy/proxy.go——GET/HEAD 只读恒放行）→
    # GET /containers/{name}/archive?path=...（tar）读 Worker 容器内文件。
    # 零服务器侧改动、零新端点、零新凭据（复用 Controller admin token，L1）。
    # 容器名/布局（AgentTeams 源码实锤）：agentteams-worker-{name} /
    # agentteams-manager；qwenpaw-worker-entrypoint.sh L19-59：
    # HOME==/root/agentteams-fs/agents/<name>（==MinIO 镜像根）,
    # QWENPAW_WORKING_DIR=$HOME/.qwenpaw,
    # AGENT_WORKSPACE=$HOME/.qwenpaw/workspaces/default（MEMORY.md+memory/
    # +SOUL.md 所在）；copaw 旧布局 memory/ 在 HOME 顶层。

    _KB_AGENT_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
    _KB_MAX_TAR = 20 * 1024 * 1024  # 单次 archive 拉取上限 20MB
    _KB_MAX_FILE = 512 * 1024  # 单文件返回上限 512KB

    # 敏感文件过滤（对齐 dashboard FilesBrowserPanel SENSITIVE_PATTERNS：
    # ChatRoom 文件面板同款清单）。dashboard 过滤的是 MinIO 全量 key；插件
    # KB 走容器 archive/exec，隐藏文件（.ssh/ .hermes/）各列取点已 skip，
    # 此处补齐 dashboard 清单中非隐藏部分 + 兜底。
    # 直读 /file 命中时返 404（不泄露存在性，W8 反探测同款）。
    def _kb_is_sensitive(name: str, rel: str) -> bool:
        if rel == "credentials" or rel.startswith("credentials/"):
            return True
        # B1（维护者 1.2.4 联调验收报告，dashboard 侧同修）：
        # credentials.yaml 独立凭证文件（不在 credentials/ 目录下）
        # 原先漏护——KB 视图与文件视图统一补规则。
        if name.lower().endswith("credentials.yaml") or \
                name.lower().endswith("credentials.yml"):
            return True
        if rel == "openclaw.json" or rel == ".hermes/config.yaml":
            return True
        if name.lower().endswith(".lock"):
            return True
        return False
    _KB_MAX_GRAPH_FILES = 150  # 图谱解析文件数上限
    _KB_GRAPH_FILE_CAP = 200 * 1024  # 图谱单文件 200KB
    _kb_ws_cache: Dict[str, Dict[str, Any]] = {}  # agent → {ws, ts}（闭包共享）

    def _kb_require_token() -> tuple:
        cfg = config_mod.load_config()
        token = (cfg.get("controller_token") or "").strip()
        if not token:
            raise HTTPException(
                status_code=401,
                detail="远端团队知识库需要 Controller 管理员 token（配置页填写后刷新）",
            )
        base = _pick_address(cfg, "controller")
        if not base:
            raise HTTPException(status_code=502, detail="未配置 Controller 地址")
        return token, base.rstrip("/")

    async def _kb_docker(
        token: str, base: str, path: str, head: bool = False,
        timeout: float = 40.0,
    ) -> tuple:
        """Controller Docker API（GET/HEAD 恒放行）。返回 (status, bytes)。

 v0.5.0-beta.14.2（外网 401 根因③）：单地址直拨改 ordered 地址
 failover——旧版只拨 _pick_address 单地址：切网窗口 working cache 未
 换 / 401 地址居首时全族端点（KB/审批/日志）恒 401 或卡满 40s 超时。
 200 即止；4xx/5xx/传输错 → 下一地址；全败 → 返回最后一个
 (status, bytes)（调用方按 st 走 fallback）；全超时 → 原 502 detail
 （Docker daemon 挂诊断，实测：manager 容器 running 但 API 全超时）。
 """
        import httpx as _h
        cfg = config_mod.load_config()
        urls = [u.rstrip("/") for u in _ordered_addresses(cfg, "controller")]
        if not urls:
            urls = [base.rstrip("/")]
        last: Optional[tuple] = None
        all_timeout = True
        for b in urls:
            url = f"{b}/docker/v1.41{path}"
            # v0.5.0-beta.14.3: 该地址覆盖凭据（无则原生 Bearer）。
            headers = _headers_for(
                cfg, "controller", b, {"Authorization": f"Bearer {token}"}
            )
            try:
                async with GatedAsyncClient(timeout=timeout, verify=False) as client:
                    if head:
                        resp = await client.head(url, headers=headers)
                    else:
                        resp = await client.get(url, headers=headers)
                if resp.status_code == 200:
                    if head:
                        return 200, b""
                    return 200, resp.content
                last = (resp.status_code, resp.content if not head else b"")
                all_timeout = False
            except _h.TimeoutException:
                last = (502, b"timeout")
                # all_timeout 保持 True（除非后面有非超时的失败/成功）
            except Exception:  # noqa: BLE001 - try the next address
                last = (502, b"error")
                all_timeout = False
        if all_timeout and last is not None:
            # 实测：服务器 Docker daemon 对个别容器（agentteams-manager，
            # 状态 running 但 inspect/archive 全超时）会挂——容器活着 ≠ API 可用。
            # 明确报错而非裸 500，指向服务器侧处置。
            raise HTTPException(
                status_code=502,
                detail=(
                    "容器 API 响应超时——服务器 Docker daemon 对该容器无响应"
                    "（容器可能 running 但内部挂起）。"
                    "处置：需管理员在服务器执行 docker restart <容器名>"
                ),
            )
        if last is None:
            return 502, b""
        return last

    async def _kb_exec_full(
        token: str, base: str, container: str, cmd: List[str],
        timeout: float = 40.0,
    ) -> Optional[str]:
        """ Controller 代理 docker exec（只读 find/ls 用途）。
 manager live 大工作区超 20MB tar 上限时的轻量列取。
 实测：POST /exec → 201，POST /exec/{id}/start → 多路复用帧
 （8 字节头：stream+3×0+4B big-endian len + payload）。
 输出上限 2MB（find -maxdepth 1 行式清单足够）。
 传输失败（超时/非 200/缺 Id）→ None——调用方需区分「通道挂」
 与「命令成功但输出为空」（后者含 find 目标不存在：find 报错走
 stderr、stdout 为空，exec 仍 200）。"""
        import httpx as _h
        # v0.5.0-beta.14.3: 该地址覆盖凭据（无则原生 Bearer）。
        _cfg = config_mod.load_config()
        headers = _headers_for(
            _cfg, "controller", base, {"Authorization": f"Bearer {token}"}
        )
        try:
            async with GatedAsyncClient(timeout=timeout, verify=False) as client:
                r1 = await client.post(
                    f"{base}/docker/v1.41/containers/{container}/exec",
                    json={
                        "AttachStdout": True,
                        "AttachStderr": True,
                        "Cmd": cmd,
                    },
                    headers=headers,
                )
                if r1.status_code not in (200, 201):
                    return None
                eid = (r1.json() or {}).get("Id", "")
                if not eid:
                    return None
                r2 = await client.post(
                    f"{base}/docker/v1.41/exec/{eid}/start",
                    json={"Detach": False, "Tty": False},
                    headers=headers,
                )
        except _h.TimeoutException:
            return None
        if r2.status_code != 200:
            return None
        raw = r2.content
        out: List[str] = []
        i = 0
        while i + 8 <= len(raw) and sum(len(x) for x in out) < 2 * 1024 * 1024:
            stream = raw[i]
            ln = int.from_bytes(raw[i + 4:i + 8], "big")
            i += 8
            if i + ln > len(raw):
                break
            if stream == 1:
                out.append(raw[i:i + ln].decode("utf-8", "replace"))
            i += ln
        return "".join(out)

    async def _kb_exec(
        token: str, base: str, container: str, cmd: List[str],
        timeout: float = 40.0,
    ) -> str:
        """兼容包装：传输失败返空串（不区分失败的调用方用）。"""
        return (await _kb_exec_full(token, base, container, cmd, timeout)) or ""

    def _kb_tar_entries(data: bytes) -> List[Dict[str, Any]]:
        """Docker archive tar → 相对条目列表。目录请求时顶层条目名=
 所请求目录/文件自身，剥离后得相对路径。"""
        import io as _io
        import tarfile as _tf
        raw: List[Dict[str, Any]] = []
        try:
            with _tf.open(fileobj=_io.BytesIO(data), mode="r:*") as tf:
                for m in tf.getmembers():
                    nm = m.name.replace("\\", "/")
                    parts = [p for p in nm.split("/") if p and p != "."]
                    if not parts:
                        continue
                    raw.append(
                        {
                            "top": parts[0],
                            "rel": "/".join(parts[1:]),
                            "size": m.size,
                            "mtime": m.mtime,
                            "isdir": m.isdir(),
                        }
                    )
        except Exception:  # noqa: BLE001 — tar 损坏按空处理
            return []
        if not raw:
            return []
        # 顶层段一致 = 目录请求（顶层=所请求目录自身，剥前缀）；
        # 不一致 = 条目已归一（如 ./ 前缀被 tarfile 剥掉）→ 按相对处理。
        tops = {e["top"] for e in raw}
        uniform = len(tops) == 1
        top = raw[0]["top"]
        out = []
        for e in raw:
            if uniform:
                if e["top"] != top:
                    continue
            if not e["rel"]:
                if e["isdir"]:
                    continue  # 顶层目录条目自身——跳过
                if uniform:
                    # 单文件请求（tar 仅一条目=文件自身）。
                    out.append(
                        {"path": "", "name": top, "size": e["size"],
                         "mtime": e["mtime"], "isdir": False}
                    )
                else:
                    # 非统一前缀：单段条目=顶层文件。
                    out.append(
                        {"path": e["top"], "name": e["top"], "size": e["size"],
                         "mtime": e["mtime"], "isdir": False}
                    )
            elif not e["isdir"]:
                if uniform:
                    rel = e["rel"]
                else:
                    # 非统一前缀：完整路径 = top[/rel]。
                    rel = e["top"] if not e["rel"] else f"{e['top']}/{e['rel']}"
                out.append(
                    {"path": rel, "name": rel.rsplit("/", 1)[-1],
                     "size": e["size"], "mtime": e["mtime"], "isdir": False}
                )
        return out

    # ── KB 目录列取双通道（v0.5.0-beta.13.9 根因修）────────────────
 # 真机反馈：worker 工作区总体积 >20MB（实测 180MB）→ 旧版
    # kb_tree 顶层（worker 支）/ memory / digest 子树全走「先整目录递归
    # tar 下载完、下载完才查大小」→ 413「工作区顶层超过 20MB，无法列取」
    # （manager 顶层早前已单独切 exec find，worker 支漏改=同类没扫全）。
    # 根因 = 列取路径不再依赖整树下载：
    # 主通道 _kb_find_list —— exec find（零下载，manager live 大工作区
    # 生产已验证的链路；实测 125 条目 ~100ms）；
    # 兜底 _kb_tar_list —— Docker archive tar（小工作区保留旧精确解析
    # + 413 守卫，仅主通道失败时可达）。
    # 失败语义：find 返 None=传输失败（切 tar）；tar 返 None=路径不存在
    # （404）；tar 超限→413（仅兜底路径可触达）。

    def _kb_parse_find_lines(out: str) -> List[Dict[str, Any]]:
        """find -printf '%y %s %T@ %P' 行解析（_kb_find_list 主通道与
 v0.5.0-beta.14.17 KBBATCH-K2 合并探测共用——同一解析=同一语义：
 rel 空/绝对路径行跳过，size/mtime 解析失败归 0）。"""
        entries: List[Dict[str, Any]] = []
        for ln in out.splitlines():
            parts = ln.split(" ", 3)
            if len(parts) != 4:
                continue
            typ, size_s, mtime_s, rel = parts
            rel = rel.replace("\\", "/")
            if not rel or rel.startswith("/"):
                continue
            try:
                size = int(float(size_s))
            except ValueError:
                size = 0
            try:
                mtime = int(float(mtime_s))
            except ValueError:
                mtime = 0
            entries.append({"type": typ, "size": size,
                            "mtime": mtime, "rel": rel})
        return entries

    async def _kb_find_list(
        token: str, base: str, container: str, target: str,
        maxdepth: Optional[int] = None,
    ) -> Optional[List[Dict[str, Any]]]:
        """主通道：exec find 列目录（零下载）。
 返回 [{type,size,mtime,rel}]（rel 相对 target，顶层条目=裸名）；
 通道失败 → None（调用方切 tar 兜底）；目标不存在/空目录 → 空列表
 （find 报错走 stderr、stdout 空——调用方必要时以 HEAD 探针区分
 空目录与不存在）。
 v0.5.0-beta.13.10：-H 跟随**命令行参数**层的符号链接（worker
 工作区 shared → teams/.../shared 团队目录符号链接——kb_ls 展开
 符号链接目录需要；条目内深层符号链接仍不跟随，防环）。"""
        cmd = ["find", "-H", target]
        if maxdepth is not None:
            cmd += ["-maxdepth", str(maxdepth)]
        cmd += ["-printf", "%y %s %T@ %P\n"]
        out = await _kb_exec_full(token, base, container, cmd, timeout=90.0)
        if out is None:
            return None
        return _kb_parse_find_lines(out)

    async def _kb_tar_list(
        token: str, base: str, container: str, target: str,
        maxdepth: Optional[int] = None,
        include_dirs: bool = False,
    ) -> Optional[List[Dict[str, Any]]]:
        """兜底通道：Docker archive tar 列目录（递归 tar，只解析到指定层）。
 返回 [{type,size,mtime,rel}]；路径不存在 → None；tar 超
 _KB_MAX_TAR → 413；其余非 200/304 → 502。
 maxdepth=1 + include_dirs=True → 一级文件+目录（tree 顶层/kb_ls）；
 maxdepth=None → 全层文件（tree memory/digest 子树，旧
 _kb_tar_entries 语义）。"""
        import io as _io
        import tarfile as _tf
        import urllib.parse as _up
        st, data = await _kb_docker(
            token, base,
            f"/containers/{container}/archive?path={_up.quote(target)}",
            timeout=60.0,
        )
        if st in (400, 404):
            return None
        if st not in (200, 304):
            raise HTTPException(
                status_code=502, detail=f"目录列取失败（Docker API {st}）")
        if not data:
            return []
        if len(data) > _KB_MAX_TAR:
            raise HTTPException(
                status_code=413,
                detail="目录过大（tar 超过 20MB），无法列取")
        try:
            tf = _tf.open(fileobj=_io.BytesIO(data), mode="r:*")
        except Exception:  # noqa: BLE001
            raise HTTPException(status_code=502, detail="tar 解析失败")
        members = []
        with tf:
            for m in tf.getmembers():
                nm = m.name.replace("\\", "/")
                parts = [q for q in nm.split("/") if q and q != "."]
                if parts:
                    members.append((m, parts))
        if not members:
            return []
        # 统一顶层=所请求目录自身（剥前缀）；不一致=条目已归一（按相对）。
        tops = {p[0] for _, p in members}
        strip = len(tops) == 1
        entries: List[Dict[str, Any]] = []
        for m, parts in members:
            rel_parts = parts[1:] if strip else parts
            if not rel_parts:
                continue  # 所请求目录自身
            depth = len(rel_parts)
            if maxdepth is not None and depth > maxdepth:
                continue
            if m.isdir():
                if not include_dirs:
                    continue
                entries.append({"type": "d", "size": 0,
                                "mtime": int(m.mtime),
                                "rel": "/".join(rel_parts)})
            elif m.isfile():
                entries.append({"type": "f", "size": m.size,
                                "mtime": int(m.mtime),
                                "rel": "/".join(rel_parts)})
        return entries

    # ── v0.5.0-beta.14.17（KBBATCH-K2）：tree 合并探测 ─────────────────
    # 冷时 tree = ws 探测 + 可用性探测 + 顶层 find + memory find + digest
    # find + 六档案逐个 archive 兜底（4-10 次 HTTP 往返）。合并探测把
    # 三个 find 与六档案 stat 收进**一次** exec（sh -c 分段脚本，
    # ###SECTION: 标记切分——find -printf 行首恒为 f/d/l 等单字符，
    # # 开头行不可能来自 find 输出，切分确定性安全）。成功判据=输出含
    # 收尾标记 ###SECTION:end（sh 缺失→exec 非 200→None；find 缺失/
    # 中途挂→无 end 标记→按失败处理）；失败（None/无 end）→ 调用方走
    # 原双通道逻辑整段（回退语义保留，见 _kb_tree_compute）。
    _KB_PROFILE_FILES = (
        "MEMORY.md", "SOUL.md", "AGENTS.md", "PROFILE.md",
        "HEARTBEAT.md", "BOOTSTRAP.md",
    )
    _KB_TREE_MERGED_SCRIPT = (
        "echo '###SECTION:top';"
        "find -H {ws} -maxdepth 1 -printf '%y %s %T@ %P\\n' 2>/dev/null;"
        "echo '###SECTION:memory';"
        "find -H {ws}/memory -printf '%y %s %T@ %P\\n' 2>/dev/null;"
        "echo '###SECTION:digest';"
        "find -H {ws}/digest -printf '%y %s %T@ %P\\n' 2>/dev/null;"
        "echo '###SECTION:profile';"
        "for f in MEMORY.md SOUL.md AGENTS.md PROFILE.md HEARTBEAT.md"
        " BOOTSTRAP.md; do"
        " [ -e {ws}/$f ] && stat -c '%n %s %Y' {ws}/$f;"
        "done 2>/dev/null;"
        "echo '###SECTION:end'"
    )

    def _kb_split_sections(out: str) -> Dict[str, str]:
        """###SECTION:<name> 标记切分 → {name: 段内容(\\n 连行)}。
 标记行本身不入段；未知标记（未来扩展）同样收集。"""
        sections: Dict[str, str] = {}
        cur: Optional[str] = None
        for ln in out.splitlines():
            if ln.startswith("###SECTION:"):
                cur = ln[len("###SECTION:"):].strip()
                sections.setdefault(cur, "")
                continue
            if cur is None:
                continue
            sections[cur] = f"{sections[cur]}\n{ln}" if sections[cur] else ln
        return sections

    def _kb_parse_profile_lines(out: str) -> List[Dict[str, Any]]:
        """六档案 stat 段行解析：`<完整路径> <size> <mtime>`（stat -c
 '%n %s %Y'；%n=固定六文件名、无空格，rsplit 安全）。返回
 [{path(裸名),name,size,mtime}]——与旧 ④ archive 兜底的
 _add_entries 输出字段一致（category/openable 由调用点补齐）。"""
        entries: List[Dict[str, Any]] = []
        for ln in out.splitlines():
            parts = ln.rsplit(" ", 2)
            if len(parts) != 3:
                continue
            full, size_s, mtime_s = parts
            name = full.rsplit("/", 1)[-1]
            if name not in _KB_PROFILE_FILES:
                continue
            try:
                size = int(float(size_s))
            except ValueError:
                size = 0
            try:
                mtime = int(float(mtime_s))
            except ValueError:
                mtime = 0
            entries.append({"path": name, "name": name,
                            "size": size, "mtime": mtime})
        return entries

    async def _kb_tree_merged_probe(
        token: str, base: str, container: str, ws: str,
    ) -> Optional[Dict[str, str]]:
        """K2 合并探测（1 exec）：成功 → {top,memory,digest,profile}
 四段原文；通道挂（None）/ 无收尾标记（脚本中途挂）→ None
 （调用方走原双通道 fallback 整段）。timeout=90 与原 find 主通道
 一致（三段 find 串行最坏 ≤3×90 的旧上界，合并后单窗口）。"""
        script = _KB_TREE_MERGED_SCRIPT.format(ws=ws)
        out = await _kb_exec_full(
            token, base, container, ["sh", "-c", script], timeout=90.0,
        )
        if out is None or "###SECTION:end" not in out:
            return None
        return _kb_split_sections(out)

    # ── v0.5.0-beta.14.17（KBBATCH-K1）：批量读（单次 exec 分帧）────────
    # graph 冷取 = N 次逐文件 kb_file 往返（N=md 数，数十~上百）。批量读
    # 把 N 次往返收进**单次** exec：容器内 python3 逐文件读，输出确定性
    # 分帧 `===FRAME:<size>:<path>` + **恰好 size 字节**内容（帧边界由
    # size 决定，内容含 ===FRAME: 字样也不串帧），总内容 ≤1.8MB（2MB
    # 传输上限内留帧头余量），超限 `===TRUNC`。通道挂（None）→ 调用方
    # 区分并回退旧逐文件路径。
    #
    # 声明偏离（任务书 §二 K1 字面为 sh -c stat+cat 两段）：传输层
    # _kb_exec_full 以 utf-8/replace 解码帧——二进制帧直穿会因多字节
    # 截断/替换符使 size 与实际字节失配、必然串帧。改为容器内
    # decode(errors="ignore") 保证有效 UTF-8、size=重编码后字节长度，
    # 帧边界字节精确（语义等价 stat+cat，仍单次 exec）。
    _KB_BATCH_BUDGET = 1887436  # 1.8MB 内容预算（2MB 传输上限内）
    _KB_BATCH_MAX_PATHS = 200
    _KB_BATCH_READ_SCRIPT = r'''import os, sys
ws = sys.argv[1]
paths = sys.argv[2:]
budget = 1887436
out = []
for p in paths:
 if not p or "\n" in p or "\r" in p:
 continue
 full = os.path.normpath(os.path.join(ws, p))
 if full == ws or not full.startswith(ws + os.sep):
 out.append("===MISSING:" + p)
 continue
 try:
 st = os.stat(full)
 except OSError:
 out.append("===MISSING:" + p)
 continue
 if st.st_size > budget:
 out.append("===TRUNC")
 break
 budget -= st.st_size
 try:
 with open(full, "rb") as f:
 data = f.read()
 except OSError:
 out.append("===MISSING:" + p)
 continue
 text = data.decode("utf-8", "ignore")
 enc = text.encode("utf-8")
 if enc:
 out.append("===FRAME:%d:%s" % (len(enc), p))
 out.append(text)
 else:
 out.append("===FRAME:0:" + p)
out.append("===END")
sys.stdout.buffer.write(("\n".join(out) + "\n").encode("utf-8"))
'''

    def _kb_take_bytes(s: str, pos: int, nbytes: int):
        """从 s[pos:] 恰好消费 nbytes 字节（UTF-8 宽度感知：per-char
 <0x80→1 / <0x800→2 / <0x110000→3 / 其余→4），返回 (消费串,
 新 pos)。内容恒为有效 UTF-8（容器内 decode ignore）→ 恰在字符
 边界停。"""
        chars: List[str] = []
        i = pos
        n = len(s)
        used = 0
        while i < n and used < nbytes:
            cp = ord(s[i])
            if cp < 0x80:
                w = 1
            elif cp < 0x800:
                w = 2
            elif cp < 0x110000:
                w = 3
            else:
                w = 4
            chars.append(s[i])
            used += w
            i += 1
        return "".join(chars), i

    _kb_batch_marker_re = re.compile(
        r"\n(?====FRAME:|===MISSING:|===TRUNC|===END)"
    )

    def _kb_parse_batch(text: Optional[str]) -> Optional[Dict[str, Any]]:
        """批量读分帧输出 → {files, missing, truncated}；text=None
 （通道挂）→ None（调用方区分并回退）。帧边界由 size 决定
 （恰好消费 size 字节）→ 内容内嵌 ===FRAME: 不当帧头（不串帧）；
 异常失步 → 正则重同步到下一标记行。"""
        if text is None:
            return None
        files: Dict[str, str] = {}
        missing: List[str] = []
        truncated = False
        i = 0
        n = len(text)
        while i < n:
            line_end = text.find("\n", i)
            if line_end == -1:
                line_end = n
            line = text[i:line_end]
            i = line_end + 1
            if line.startswith("===FRAME:"):
                rest = line[len("===FRAME:"):]
                m = rest.find(":")
                if m == -1:
                    continue
                try:
                    size = int(rest[:m])
                except ValueError:
                    continue
                pth = rest[m + 1:]
                if size == 0:
                    files.setdefault(pth, "")
                    continue
                taken, i = _kb_take_bytes(text, i, size)
                files[pth] = taken
                if i < n and text[i] == "\n":
                    i += 1
                else:
                    # 失步（正常不可达）：重同步到下一标记行
                    mm = _kb_batch_marker_re.search(text, i)
                    if mm is None:
                        break
                    i = mm.start() + 1
            elif line.startswith("===MISSING:"):
                missing.append(line[len("===MISSING:"):])
            elif line == "===TRUNC":
                truncated = True
                break
            elif line == "===END":
                break
        return {"files": files, "missing": missing,
                "truncated": truncated}

    async def _kb_files_batch_read(
        token: str, base: str, container: str, ws: str,
        paths: List[str],
    ) -> Optional[Dict[str, Any]]:
        """单次 exec 批量读（K1）。paths 已校验（相对路径、非敏感、
 ≤200）。通道挂 → None（调用方区分并回退旧逐文件路径）。"""
        paths = paths[:_KB_BATCH_MAX_PATHS]
        if not paths:
            return {"files": {}, "missing": [], "truncated": False}
        out = await _kb_exec_full(
            token, base, container,
            ["python3", "-c", _KB_BATCH_READ_SCRIPT, ws, *paths],
            timeout=60.0,
        )
        if out is None:
            return None
        return _kb_parse_batch(out)

    async def _kb_workspace(token: str, base: str, agent: str) -> str:
        """探测 Agent 工作区路径（5min 缓存）。无则 404。"""
        now = time.time()
        hit = _kb_ws_cache.get(agent)
        # TTL 5min→30min。工作区路径由容器挂载决定、实际不变；
        # 5min 一到期就重付「inspect + 3×HEAD 探测 + archive」4 次串行 Docker
        # API 往返（经 Controller 代理）， 图谱「点好多次才打开」的
        # 后端侧贡献项之一。
        if hit and now - hit["ts"] < 1800:
            return hit["ws"]
        container = (
            "agentteams-manager" if agent == "manager"
            else f"agentteams-worker-{agent}"
        )
        # v0.5.0-beta.12 修：Controller Docker 代理不转 HEAD /containers/{name}/json
        # （实测 HEAD=404 / GET=200 / HEAD archive=200）——改用 GET
        # 探存在性，候选路径探测仍走 HEAD archive（可用）。
        st, _ = await _kb_docker(
            token, base, f"/containers/{container}/json", head=False
        )
        if st == 404:
            raise HTTPException(status_code=404, detail=f"容器 {container} 不存在")
        home = f"/root/agentteams-fs/agents/{agent}"
        candidates = (
            f"{home}/.qwenpaw/workspaces/default",  # qwenpaw runtime
            f"{home}/.copaw/workspaces/default",  # copaw runtime
            home,  # copaw openclaw（memory/ 在顶层）
        )
        # （用户真机：子目录文件看不见 + 图谱节点缺失）：manager
        # 是特例——live 工作区在 /root/manager-workspace（HOME 挂载），而
        # MinIO 镜像目录只有 agent.json stub（最小）。实测：
        # stub=最小 tar（仅 agent.json）；live=完整工作区（记忆/摘要/协议文档等子目录）。
        # manager 优先探
        # live，探不到再回退 MinIO 候选。
        if agent == "manager":
            candidates = (
                "/root/manager-workspace/.qwenpaw/workspaces/default",
            ) + candidates
        import urllib.parse as _up
        # 候选路径探测并行（原串行——4 个候选最坏 4×40s 超时；
        # 并行后最坏 1×40s）。结果按候选优先级取第一个命中。
        import asyncio as _aio
        async def _probe(cand: str) -> int:
            st, _ = await _kb_docker(
                token, base,
                f"/containers/{container}/archive?path={_up.quote(cand)}",
                head=True,
            )
            return st
        results = await _aio.gather(
            *[_probe(c) for c in candidates], return_exceptions=True
        )
        for cand, st in zip(candidates, results):
            if isinstance(st, int) and st in (200, 304):
                _kb_ws_cache[agent] = {"ws": cand, "ts": now}
                return cand
        _kb_ws_cache.pop(agent, None)
        raise HTTPException(
            status_code=404, detail="未找到工作区目录（容器可能仍在启动中）"
        )

    # ── #1208 workspace-files 兜底数据面（L2 team-scoped / Docker 不可用）──
    # 上游 #1208：GET /api/v1/workers/{name}/workspace-files/{sub}，
    # sub∈{tree,file-metadata,file-content,file-download}，allowlist=
    # MEMORY.md+memory/+digest/（controller 固定 root=workspace）。仅 Worker
    # （无 manager 端点）。L2 可读本团队 Worker；跨团队→404（W8）；旧
    # Controller（未合 #1208）→404（路由未注册）。tree limit≤500/默认 200；
    # file-content limit≤1MB/默认 256KB；path≤4 段。
    _KB_WSF_MAX_DEPTH = 2  # memory/ 或 digest/ 下最多再下探 2 层（path≤4 段）
    _KB_WSF_MAX_FILES = 300  # 单分类文件数上限（防大工作区拖死）
    _KB_WSF_MAX_READ = 512 * 1024  # 单文件返回上限（与 Docker 通道 _KB_MAX_FILE 一致）

    async def _wsf_get(token: str, base: str, agent: str, sub: str,
                       params: Optional[Dict[str, str]]) -> tuple:
        """GET /api/v1/workers/{agent}/workspace-files/{sub}?params。
 返回 (status_code, 解析后 JSON dict|bytes)。"""
        import httpx as _h
        import urllib.parse as _up
        url = (
            f"{base}/api/v1/workers/{agent}"
            f"/workspace-files/{sub}"
        )
        if params:
            url += "?" + _up.urlencode(params)
        async with GatedAsyncClient(timeout=30.0, verify=False) as client:
            r = await client.get(url, headers=_headers_for(config_mod.load_config(),
                                    "controller", base, {"Authorization": f"Bearer {token}"}))
        try:
            return r.status_code, r.json()
        except Exception:  # noqa: BLE001
            return r.status_code, r.content

    def _wsf_mtime(iso: Optional[str]) -> int:
        """ISO modified_at → epoch 秒（解析失败→0，与 Docker 通道 mtime 同量级）。"""
        import datetime as _dt
        if not iso:
            return 0
        try:
            return int(_dt.datetime.fromisoformat(
                iso.replace("Z", "+00:00")).timestamp())
        except Exception:  # noqa: BLE001
            return 0

    async def _wsf_tree_files(token: str, base: str, agent: str,
                              root_dir: str) -> List[Dict[str, Any]]:
        """#1208 tree：递归列 root_dir（memory/digest）下文件，带界。
 返回 [{path(工作区相对),name,size,mtime}]。path 形如 memory/2026-08-29.md。"""
        out: List[Dict[str, Any]] = []

        async def _walk(dir_path: str, depth: int) -> None:
            if depth > _KB_WSF_MAX_DEPTH or len(out) >= _KB_WSF_MAX_FILES:
                return
            cursor: Optional[str] = None
            while True:
                params: Dict[str, str] = {"path": dir_path, "limit": "200"}
                if cursor:
                    params["cursor"] = cursor
                st, data = await _wsf_get(token, base, agent, "tree", params)
                if st != 200 or not isinstance(data, dict):
                    return
                for e in (data.get("entries") or []):
                    if len(out) >= _KB_WSF_MAX_FILES:
                        return
                    kind = e.get("kind")
                    p = str(e.get("path") or "")
                    name = str(e.get("name") or (p.rsplit("/", 1)[-1] if p else ""))
                    if not p or _kb_is_sensitive(name, p):
                        continue
                    if kind == "directory":
                        if depth < _KB_WSF_MAX_DEPTH:
                            await _walk(p, depth + 1)
                    else:
                        out.append({
                            "path": p, "name": name,
                            "size": int(e.get("size") or 0),
                            "mtime": _wsf_mtime(e.get("modified_at")),
                        })
                if data.get("has_more") and data.get("next_cursor"):
                    cursor = str(data["next_cursor"])
                else:
                    break

        await _walk(root_dir, 1)
        return out

    async def _wsf_read_file(token: str, base: str, agent: str,
                             path: str) -> Optional[tuple]:
        """#1208 file-content：分块读到 eof（≤_KB_WSF_MAX_READ）。
 成功→(size, text)；不存在/非文本/超限→None。"""
        offset = 0
        chunks: List[str] = []
        total = 0
        while total < _KB_WSF_MAX_READ:
            st, data = await _wsf_get(token, base, agent, "file-content", {
                "path": path, "offset": str(offset), "limit": "262144",
            })
            if st != 200 or not isinstance(data, dict):
                return None
            chunk = data.get("content") or ""
            chunks.append(chunk)
            total += len(chunk)
            if data.get("eof"):
                break
            offset = int(data.get("next_offset") or offset)
        text = "".join(chunks)
        return (total, text)

    async def _kb_tree_wsf_fallback(token: str, base: str, agent: str) -> Dict[str, Any]:
        """#1208 兜底树（L2 / Docker 不可用，worker only）：三分类=
 memory/**（日记）+ digest/**（知识库）+ MEMORY.md（档案）。
 非 MEMORY.md 的档案文件 + 文件分类不在 #1208 allowlist → 不渲染
 （L1-only 数据，前端按 dirs=[] 优雅降级）。"""
        files: List[Dict[str, Any]] = []
        for e in await _wsf_tree_files(token, base, agent, "memory"):
            files.append({**e, "category": "daily"})
        for e in await _wsf_tree_files(token, base, agent, "digest"):
            files.append({**e, "category": "digest"})
        st, meta = await _wsf_get(token, base, agent, "file-metadata",
                                  {"path": "MEMORY.md"})
        if st == 200 and isinstance(meta, dict):
            files.append({
                "path": "MEMORY.md", "name": "MEMORY.md",
                "size": int(meta.get("size") or 0),
                "mtime": _wsf_mtime(meta.get("modified_at")),
                "category": "profile",
            })
        keep = [
            f for f in files
            if f["path"].lower().endswith(
                (".md", ".txt", ".yaml", ".yml", ".json"))
        ][:300]
        cat_order = {"profile": 0, "daily": 1, "digest": 2, "file": 3}
        keep.sort(key=lambda f: (cat_order.get(f.get("category", "file"), 3),
                                 f["path"]))
        return {
            "agent": agent,
            "workspace": "(controller #1208)",
            "source": "controller",
            "files": keep, "dirs": [], "count": len(keep),
        }

    # Docker 通道可用性缓存（per 容器，短 TTL）：L2 token 恒 403 / Docker 挂
    # 恒 502——30s 内不重复探，避免 tree/file/ls 每次多打一发 /json。
    _kb_docker_ok_cache: Dict[str, tuple] = {}
    _KB_DOCKER_OK_TTL = 30.0

    async def _kb_docker_available(token: str, base: str, container: str) -> bool:
        import time as _time
        now = _time.time()
        cached = _kb_docker_ok_cache.get(container)
        if cached and (now - cached[1]) < _KB_DOCKER_OK_TTL:
            return cached[0]
        try:
            st, _ = await _kb_docker(
                token, base, f"/containers/{container}/json", timeout=15.0,
            )
            ok = st not in (401, 403)
        except HTTPException:
            ok = False
        _kb_docker_ok_cache[container] = (ok, now)
        return ok

    def _wsf_in_allowlist(path: str) -> bool:
        """#1208 allowlist：MEMORY.md 单文件 + memory/** + digest/**。"""
        if path == "MEMORY.md":
            return True
        return path.startswith("memory/") or path.startswith("digest/")

    async def _kb_ls_wsf_fallback(token: str, base: str, agent: str,
                                  dir: str) -> Dict[str, Any]:
        """#1208 兜底懒加载（L2/docker 不可用，worker only）。
 dir=""→顶层（memory/ + digest/ + MEMORY.md）；dir 在 memory/**|digest/**
 内→该层 tree；其它目录（协议文档等）→404（不在 #1208 allowlist）。"""
        text_ok = (".md", ".txt", ".yaml", ".yml", ".json")
        if dir == "":
            dirs_out: List[Dict[str, Any]] = []
            files_out: List[Dict[str, Any]] = []
            for root in ("memory", "digest"):
                st, data = await _wsf_get(
                    token, base, agent, "tree", {"path": root, "limit": "1"})
                if st == 200 and isinstance(data, dict):
                    dirs_out.append(
                        {"path": root, "name": root, "isdir": True})
            st, meta = await _wsf_get(
                token, base, agent, "file-metadata", {"path": "MEMORY.md"})
            if st == 200 and isinstance(meta, dict):
                files_out.append({
                    "path": "MEMORY.md", "name": "MEMORY.md",
                    "size": int(meta.get("size") or 0),
                    "mtime": _wsf_mtime(meta.get("modified_at")),
                    "category": "profile",
                })
            return {"agent": agent, "dir": dir,
                    "files": files_out, "dirs": dirs_out}
        if not (dir == "memory" or dir == "digest"
                or dir.startswith("memory/") or dir.startswith("digest/")):
            raise HTTPException(status_code=404, detail=f"目录不存在：{dir}")
        if len(dir.split("/")) > 3:
            raise HTTPException(status_code=404, detail=f"目录不存在：{dir}")
        st, data = await _wsf_get(
            token, base, agent, "tree", {"path": dir, "limit": "200"})
        if st != 200 or not isinstance(data, dict):
            raise HTTPException(status_code=404, detail=f"目录不存在：{dir}")
        files_out = []
        dirs_out = []
        for e in (data.get("entries") or []):
            name = str(e.get("name") or "")
            p = str(e.get("path") or "")
            if not p or _kb_is_sensitive(name, p):
                continue
            if e.get("kind") == "directory":
                dirs_out.append({"path": p, "name": name, "isdir": True})
            elif name.lower().endswith(text_ok):
                files_out.append({
                    "path": p, "name": name,
                    "size": int(e.get("size") or 0),
                    "mtime": _wsf_mtime(e.get("modified_at")),
                    "category": "file",
                })
        files_out.sort(key=lambda f: f["path"])
        dirs_out.sort(key=lambda d: d["path"])
        return {"agent": agent, "dir": dir,
                "files": files_out[:300], "dirs": dirs_out[:120]}

    async def _kb_agents_ctl_fallback(token: str, base: str) -> Dict[str, Any]:
        """KB 形状兜底（Docker 通道不可用）：agent 清单=Controller workers API。

 v0.5.0-beta.14.2（-KB-500）：/kb/agents 的 Docker 降级路径此前误调
 _approval_list_wsf(token, base, agent)——agent 在 kb_agents 作用域
 不存在 → NameError → 500（Docker 通道 401/403/502 即触发：切外网后
 WAN 链路 401 首现）。形状必须 KB {agents, count}（旧调用即便不
 NameError 也返回 approval 形状，前端解析全废）。
 """
        st, data, _ = await _ctl_json("GET", f"{base}/api/v1/workers", token)
        if st != 200:
            raise HTTPException(
                status_code=502, detail=f"Worker 列表获取失败（Controller {st}）"
            )
        workers = (data.get("workers") or []) if isinstance(data, dict) else []
        found: Dict[str, Dict[str, Any]] = {}
        for w in workers:
            if not isinstance(w, dict):
                continue
            wn = str(w.get("name") or "")
            if not wn:
                continue
            role_raw = str(w.get("role") or "worker")
            found[wn] = {
                "name": wn,
                "container": f"agentteams-worker-{wn}",
                "state": str(w.get("state") or w.get("phase") or ""),
                "kind": "worker",
                "team": str(w.get("team") or ""),
                "role": (
                    "leader" if role_raw == "team_leader"
                    else "critic" if "critic" in wn.lower()
                    else "worker"
                ),
            }
        found["manager"] = {
            "name": "manager",
            "container": "agentteams-manager",
            "state": "",
            "kind": "manager",
            "team": "",
            "role": "leader",
        }
        agents = sorted(
            found.values(),
            key=lambda a: (
                0 if a.get("role") == "leader" else 1,
                str(a.get("team") or ""),
                a["name"],
            ),
        )
        return {"agents": agents, "count": len(agents)}

    # ── v0.5.0-beta.14.10：SWR 刷新/存储助手（tree/graph/agents 共用）──
    # 单飞：同 key 刷新任务在飞不重复起；刷新失败保旧值（磁盘缓存不覆写）。
    # _KB_SWR_TTL = 磁盘 stale 阈值（超过 → 触发后台刷新；未超旧值也先回，
    # SWR 语义）；内存缓存 TTL 以现有常量为准对齐（tree 30s / graph 60s /
    # agents 60s）。
    _kb_inflight: Dict[str, Any] = {}
    _KB_SWR_TTL = 60.0

    # ── v0.5.0-beta.14.11：轻探针（变更检测——变才刷）──────────
    # 刷新门前先跑轻探针：只列条目元数据（name/mtime/size，绝不读文件
    # 内容）。签名一致 → 只重置 60s 时钟（零深扫）；不一致/失败 → 深扫
    # （安全）。目录集 = tree 同款数据源（ws 顶层 + memory/ + digest/）。
    # 列取复用 tree 计算体同款双通道（find 主=零下载 + tar 兜底，参考其
    # 状态码/降级处理）——纯 archive 在大工作区（实测 180MB）必 413，
    # 探针将恒 None、优化失效，故以 tree 实际通道为准。
    async def _kb_probe_signature(agent: str) -> Optional[str]:
        """v0.5.0-beta.14.11：KB 轻探针——只列工作区顶层 +
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
        if not await _kb_docker_available(token, base, container):
            return None
        try:
            ws = await _kb_workspace(token, base, agent)
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

 v0.5.0-beta.14.7 语义保留：#1208 WSF 兜底 payload（标记
 source:"controller"，见 _kb_tree_wsf_fallback）不写任何缓存——
 单点收口在此，后台刷新同样不会用降级值污染磁盘缓存。

 v0.5.0-beta.14.11：probe = 本次深扫时的轻探针签名；
 非 None 时一并落盘（下轮刷新门「变才刷」的比对基准）。端点冷取
 路径不跑探针（传 None）→ 不记，由下轮后台刷新的深扫补记。
 """
        if kind == "tree" and payload.get("source") == "controller":
            return
        # v0.5.0-beta.14.17（KBBATCH-K5）：file 的 WSF 兜底 payload 同样
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
        elif kind == "merged":  # v0.5.0-beta.14.17（KBBATCH-K3）：键=csv
            _kb_merged_cache[agent] = (
                time.monotonic() + _KB_MERGED_TTL_SECONDS, payload
            )
            kb_cache.save(f"merged-{agent}", payload)
            return  # 不记 last-agent / 探针（csv 非 agent 名）
        elif kind == "file":  # v0.5.0-beta.14.17（KBBATCH-K5）：键=agent/path
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
        # v0.5.0-beta.14.11：记本次深扫的轻探针签名（端点
        # 冷取不跑探针 → probe=None 不记，下轮后台刷新补记）。agents 支
        # 已早退且 agent="" 探针恒 None → 天然不记。
        if probe is not None:
            kb_cache.save_probe(f"{kind}-{agent}", probe)

    def _spawn_kb_refresh(kind: str, agent: str) -> None:
        """SWR 后台单飞刷新（fire-and-forget；调用路径零等待）。

 计算体调用时从模块级注册表 _KB_PREWARM_HOOKS 解析（单测可换假
 计算体；T9 _ctl_get 同款唯一注入点）。
 """
        key = f"{kind}-{agent}" if agent else kind
        t = _kb_inflight.get(key)
        if t is not None and not t.done():
            return
        compute = _KB_PREWARM_HOOKS.get(kind)
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
                # v0.5.0-beta.14.12：后台共用通道——执行期
                # 持锁（与两路 sweep 共享，同一时刻至多一路后台扫描）；
                # 前台忙让权/等锁超时 → 本轮放弃（单飞槽位由 finally
                # 释放，下轮重试）。
                async with bg_slot() as _bg:
                    if not _bg:
                        return
                    # v0.5.0-beta.14.11：变才刷——轻探针与上次
                    # 签名一致 → 只重置 60s 时钟，零深扫；不一致/探针失败 →
                    # 深扫（安全）。探针经注册表调用时解析（单测假注入）。
                    probe_fn = _KB_PROBE_HOOKS.get("probe") or _kb_probe_signature
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
                _kb_inflight.pop(key, None)
        _kb_inflight[key] = loop.create_task(_run())

    @router.get("/kb/agents")
    async def kb_agents() -> Dict[str, Any]:
        """远端 Agent 清单：Docker 容器列表（agentteams-worker-* +
 agentteams-manager）+ Controller workers API 补 role/team。"""
        # v0.5.0-beta.14.10：SWR——60s 内存门 + 磁盘门（旧值
        # 秒回、cached/age 提示），冷取 = 原全量清单（抽为 _kb_agents_compute）。
        _c = _kb_agents_cache.get("agents")
        if _c and _c[0] > time.monotonic():
            return _c[1]
        _disk = kb_cache.load("agents")
        if _disk is not None:
            _ts, _payload = _disk
            _age = time.time() - _ts
            if _age > _KB_SWR_TTL:
                _spawn_kb_refresh("agents", "")
            return {**_payload, "cached": True, "age": int(_age)}
        # 冷取经注册表取计算体（生产 = 本闭包；测试可假注入，与预热/
        # 刷新同一注入点）。
        _payload = await (_KB_PREWARM_HOOKS.get("agents")
                          or _kb_agents_compute)()
        _store_kb("", _payload, "agents")
        return _payload

    async def _kb_agents_compute() -> Dict[str, Any]:
        # v0.5.0-beta.14.10：kb_agents 冷取计算体——原端点体逐字搬移
        # （原体无缓存写，抽取零 diff；缓存写收口在调用点 _store_kb）。
        token, base = _kb_require_token()
        # L2（403）/ Docker 挂（502）→ KB 形状兜底（worker 走 Controller；
        # manager L1-only 占位）。v0.5.0-beta.14.2（-KB-500）：旧代码误调
        # _approval_list_wsf(token, base, agent)——本函数无 agent 变量 →
        # NameError → 500（仅 Docker 通道降级 401/403/502 时暴露，切外网后
        # WAN 链路 401 首现），且 approval 列表形状 ≠ KB {agents,count}。
        try:
            st, data = await _kb_docker(token, base, "/containers/json")
        except HTTPException:
            return await _kb_agents_ctl_fallback(token, base)
        if st in (401, 403, 502):
            return await _kb_agents_ctl_fallback(token, base)
        if st != 200:
            raise HTTPException(
                status_code=502, detail=f"容器列表获取失败（Docker API {st}）"
            )
        import json as _json
        try:
            containers = _json.loads(data or b"[]")
        except Exception:  # noqa: BLE001
            containers = []
        found: Dict[str, Dict[str, Any]] = {}
        for c in containers:
            name = (c.get("Names") or [""])[0].lstrip("/")
            if name == "agentteams-manager":
                found["manager"] = {
                    "name": "manager", "container": name,
                    "state": c.get("State") or "", "kind": "manager",
                }
            elif name.startswith("agentteams-worker-"):
                wn = name[len("agentteams-worker-"):]
                if wn:
                    found[wn] = {
                        "name": wn, "container": name,
                        "state": c.get("State") or "", "kind": "worker",
                    }
        # Controller workers API 补 role/team（失败降级=只有 name）。
        try:
            import httpx as _h
            async with GatedAsyncClient(timeout=8.0, verify=False) as client:
                resp = await client.get(
                    f"{base}/api/v1/workers",
                    headers=_headers_for(config_mod.load_config(), "controller", base,
                                {"Authorization": f"Bearer {token}"}),
                )
            if resp.status_code == 200:
                payload = resp.json()
                workers = payload if isinstance(payload, list) else payload.get("workers", [])
                for w in workers:
                    wn = str(w.get("name") or "")
                    if wn in found:
                        found[wn]["team"] = str(w.get("team") or "")
                        role_raw = str(w.get("role") or "worker")
                        found[wn]["role"] = (
                            "leader" if role_raw == "team_leader"
                            else "critic" if "critic" in wn.lower()
                            else "worker"
                        )
        except Exception:  # noqa: BLE001 — role/team 补全失败不致命
            pass
        agents = sorted(
            found.values(),
            key=lambda a: (0 if a.get("role") == "leader" else 1,
                           str(a.get("team") or ""), a["name"]),
        )
        return {"agents": agents, "count": len(agents)}

    @router.get("/kb/{agent}/tree")
    async def kb_tree(agent: str) -> Dict[str, Any]:
        """知识库文件清单：工作区顶层知识文件 + memory/ 全子树（文本过滤）。"""
        if not _KB_AGENT_RE.match(agent):
            raise HTTPException(status_code=400, detail="非法 agent 名")
        # v0.5.0-beta.14.7：tree 结果短 TTL 命中（重复访问零容器读）。
        _c = _kb_tree_cache.get(agent)
        if _c and _c[0] > time.monotonic():
            return _c[1]
        # v0.5.0-beta.14.10：SWR 磁盘缓存——有旧数据先秒回
        # （cached/age 提示），超 TTL 触发后台单飞刷新；无则同步冷取。
        _disk = kb_cache.load(f"tree-{agent}")
        if _disk is not None:
            _ts, _payload = _disk
            _age = time.time() - _ts
            if _age > _KB_SWR_TTL:
                _spawn_kb_refresh("tree", agent)
            kb_cache.save("last-agent", {"agent": agent})
            return {**_payload, "cached": True, "age": int(_age)}
        # 冷取经注册表取计算体（生产 = 本闭包；测试可假注入，与预热/
        # 刷新同一注入点）。
        _payload = await (_KB_PREWARM_HOOKS.get("tree")
                          or _kb_tree_compute)(agent)
        _store_kb(agent, _payload, "tree")
        return _payload

    async def _kb_tree_compute(agent: str) -> Dict[str, Any]:
        # v0.5.0-beta.14.10：tree 冷取计算体——原端点「缓存门之后」
        # 逐字搬移（原尾内存缓存写移至调用点 _store_kb，14.7「WSF 兜底早退
        # 不缓存」语义在 _store_kb 入口单点保留）。
        token, base = _kb_require_token()
        container = (
            "agentteams-manager" if agent == "manager"
            else f"agentteams-worker-{agent}"
        )
        # 预探（worker only）：Docker 通道可用性。L2 token → 403（ActionGateway）/
        # Docker 挂 → 502 → 切 #1208 兜底（三分类，本团队 scope）；Manager 无
        # #1208 端点 → 走原错误路径（L1 only）。
        if agent != "manager":
            if not await _kb_docker_available(token, base, container):
                return await _kb_tree_wsf_fallback(token, base, agent)
        ws = await _kb_workspace(token, base, agent)
        import urllib.parse as _up
        # （用户要求对齐 QwenPaw 最新版文件管理）：四分类——
        # 档案 = 6 个默认 workspace markdown（QwenPaw console
        # defaultWorkspaceMarkdown 同款清单，_KB_PROFILE_FILES——
        # v0.5.0-beta.14.17 K2 合并探测 stat 段共用）；日记 = memory/**
        # （daily section）；知识库 = digest/**（digest section）；
        # 文件 = 其余顶层文件 + 顶层目录（只列不展开，文本可点开）。
        files: List[Dict[str, Any]] = []
        dirs: List[Dict[str, Any]] = []
        seen: set = set()

        async def _add_entries(
            data: bytes, prefix: str, category: str,
        ) -> None:
            # 路径修：tar 目录请求返回相对路径（memory/ 下文件=
            # "2026-08-29.md"），而 /kb/{a}/file 按 {ws}/{path} 直读——
            # 早期版本起 tree 返回相对路径导致日记/digest 文件点开必 404
            # （此前被「容器不存在」404 掩盖，用户未走到点开那步）。
            # 此处统一拼回工作区相对全路径。
            for e in _kb_tar_entries(data):
                rel = e["path"]
                p = f"{prefix}/{rel}" if rel else prefix
                if _kb_is_sensitive(e["name"] or p.rsplit("/", 1)[-1], p):
                    continue  # 敏感文件过滤（dashboard SENSITIVE_PATTERNS 对齐）
                if p in seen:
                    continue
                seen.add(p)
                files.append(
                    {"path": p, "name": e["name"] or p.rsplit("/", 1)[-1],
                     "size": e["size"], "mtime": e["mtime"],
                     "category": category, "openable": True}
                )

        # ① 顶层：档案（6 默认 md）+ 文件（其余文件 + 目录条目）。
        # v0.5.0-beta.13.9 双通道：exec find 主（零下载，manager/worker 统一）
        # + tar 兜底（小工作区精确解析）。旧 worker 支整树 tar 在大工作区
        # （实测 180MB）必 413；旧 manager 支 exec-only 无兜底——同批处理。
        # v0.5.0-beta.14.17（KBBATCH-K2）：先试合并探测（1 exec = 顶层 +
        # memory + digest 三个 find + 六档案 stat 段）；通道挂（None）/
        # 无收尾标记 → 下方原双通道逻辑整段照跑（原代码保留为 fallback
        # 路径，输出逐字段一致——共用同一下方构建代码与 _kb_parse_find_lines）。
        _mem_entries = _dig_entries = None
        _profile_entries: Optional[List[Dict[str, Any]]] = None
        entries: Optional[List[Dict[str, Any]]] = None
        _merged = await _kb_tree_merged_probe(token, base, container, ws)
        if _merged is not None:
            entries = _kb_parse_find_lines(_merged.get("top", ""))
            _mem_entries = _kb_parse_find_lines(_merged.get("memory", ""))
            _dig_entries = _kb_parse_find_lines(_merged.get("digest", ""))
            _profile_entries = _kb_parse_profile_lines(
                _merged.get("profile", ""))
        if entries is None:
            entries = await _kb_find_list(token, base, container, ws,
                                          maxdepth=1)
            if entries is None:
                entries = await _kb_tar_list(
                    token, base, container, ws,
                    maxdepth=1, include_dirs=True,
                )
            _mem_entries = await _kb_find_list(
                token, base, container, f"{ws}/memory")
            if _mem_entries is None:
                _mem_entries = await _kb_tar_list(
                    token, base, container, f"{ws}/memory")
            _dig_entries = await _kb_find_list(
                token, base, container, f"{ws}/digest")
            if _dig_entries is None:
                _dig_entries = await _kb_tar_list(
                    token, base, container, f"{ws}/digest")
        _text_ok = (".md", ".txt", ".yaml", ".yml", ".json")
        _symlink_names: List[str] = []
        for e in (entries or []):
            name = e["rel"]
            if name.startswith(".") or name in (
                "memory", "digest",
            ) or _kb_is_sensitive(name, name):
                continue  # 隐藏项 + ②③ 专属分类 + 敏感文件
            if name in seen:
                continue
            seen.add(name)
            et = e["type"]
            if et == "d":
                dirs.append(
                    {"path": name, "name": name, "isdir": True,
                     "category": "file"}
                )
            elif et == "l":
                # v0.5.0-beta.13.10（13.9 知识库目录不全根因①）：
                # 符号链接此前被整条跳过（worker 工作区 shared →
                # teams/{team}/shared 团队共享目录不可见）。批量解析目标
                # 类型（python3 argv 传路径，不经过 shell 解析——manager
                # 工作区存在含空格/逗号/引号的目录名，shell 拼串必碎）。
                # 目标=目录 → 目录条目（kb_ls -H 可展开）；目标=文件/
                # 断链 → 非文本文件条目（列出不可点开）。
                _symlink_names.append(name)
                files.append(
                    {"path": name, "name": name,
                     "size": e["size"], "mtime": e["mtime"],
                     "category": "file", "openable": False,
                     "symlink": True, "_pending_resolve": True}
                )
            else:
                # 根因②：非文本文件（.jsonl/.py/.bak/.db 等）此前被
                # 文本过滤器整条吞掉 → 列表与实盘目录对不上（「不全」
                # 感观）。改为全量列出 + openable 标记（前端不可点开）。
                files.append(
                    {"path": name, "name": name,
                     "size": e["size"], "mtime": e["mtime"],
                     "category": "profile" if name in _KB_PROFILE_FILES
                    else "file",
                    "openable": name.lower().endswith(_text_ok)}
                )
        if _symlink_names:
            try:
                _targets = [f"{ws}/{n}" for n in _symlink_names]
                _out = await _kb_exec_full(
                    token, base, container,
                    ["python3", "-c",
                     "import os,sys;print('\\n'.join("
                     "'D' if os.path.isdir(p) else 'F' "
                     "for p in sys.argv[1:]))",
                     *_targets],
                    timeout=30.0,
                )
                _resolved = (
                    dict(zip(_symlink_names, _out.splitlines()))
                    if _out else {}
                )
                for _f in files:
                    if _f.pop("_pending_resolve", False):
                        _t = _resolved.get(_f["name"], "")
                        if _t == "D":
                            dirs.append(
                                {"path": _f["path"], "name": _f["name"],
                                 "isdir": True, "category": "file",
                                 "symlink": True}
                            )
                            files.remove(_f)
            except Exception:  # noqa: BLE001 — 解析失败保持文件条目
                for _f in files:
                    _f.pop("_pending_resolve", None)

        # ②③ 日记（memory/**）+ 知识库（digest/**）：构建体与 ① 共用——
        # 条目源 = K2 合并探测段（_mem_entries/_dig_entries）或 fallback
        # 分支上方的原双通道取数（v0.5.0-beta.13.9 根因修保留）。
        for _sub, _cat, _src in (
            ("memory", "daily", _mem_entries),
            ("digest", "digest", _dig_entries),
        ):
            for e in (_src or []):
                if e["type"] not in ("f", "l"):
                    continue  # ②③ 子树只列文件（目录不单独成条目）
                rel = f"{_sub}/{e['rel']}"
                nm = e["rel"].rsplit("/", 1)[-1]
                if (
                    _kb_is_sensitive(nm, rel)
                    or any(q.startswith(".") for q in e["rel"].split("/"))
                ):
                    continue  # 敏感文件 + 隐藏项（dashboard 对齐）
                if rel in seen:
                    continue
                seen.add(rel)
                # v0.5.0-beta.13.10：非文本文件同样列出（openable=False）——
                # 与 ① 顶层同口径，列表=实盘目录的诚实镜像。
                files.append(
                    {"path": rel, "name": nm, "size": e["size"],
                     "mtime": e["mtime"], "category": _cat,
                     "openable": e["type"] == "f"
                     and nm.lower().endswith(_text_ok)}
                )

        # ④ 兼容旧逻辑：单独抓 6 档案文件中未随顶层 tar 出现者（布局差异兜底）。
        # K2 合并探测路径：stat 段已提供 存在+size/mtime（与 ④ tar 语义等价，
        # 任务书 §二 K2）→ 直接落 stat 条目，免 6 次逐文件 archive。
        if _profile_entries is None:
            for sub in ("MEMORY.md", "SOUL.md", "AGENTS.md", "PROFILE.md",
                        "HEARTBEAT.md", "BOOTSTRAP.md"):
                if sub in seen:
                    continue
                st, data = await _kb_docker(
                    token, base,
                    f"/containers/{container}/archive?path={_up.quote(ws + '/' + sub)}",
                    timeout=60.0,
                )
                if st not in (200, 304) or not data:
                    continue
                await _add_entries(data, sub, "profile")
        else:
            for e in _profile_entries:
                if e["path"] in seen:
                    continue
                seen.add(e["path"])
                files.append(
                    {"path": e["path"], "name": e["name"], "size": e["size"],
                     "mtime": e["mtime"], "category": "profile",
                     "openable": True}
                )

        # v0.5.0-beta.13.10：不再按文本扩展名整体过滤——每条自带 openable
        # 标记（前端据此决定可否点开），列表=实盘目录诚实镜像（非文本
        # 灰显不可点）。排序：分类优先 → 可打开优先 → 路径。
        cat_order = {"profile": 0, "daily": 1, "digest": 2, "file": 3}
        files.sort(
            key=lambda f: (
                cat_order.get(f.get("category", "file"), 3),
                0 if f.get("openable", False) else 1,
                f["path"],
            )
        )
        keep = files[:300]
        keep_dirs = dirs[:60]
        _payload: Dict[str, Any] = {
            "agent": agent, "workspace": ws,
            "files": keep, "dirs": keep_dirs, "count": len(keep),
        }
        return _payload

    async def _kb_file_compute(agent: str, path: str) -> Dict[str, Any]:
        # v0.5.0-beta.14.17（KBBATCH-K5）：kb_file 冷取计算体——原端点体
        # （校验之后）逐字搬移；缓存写收口在调用点 _store_kb。只缓存
        # 文本类返回（{"path","size","content"}）；415 二进制 / 413 超限
        # 均以 HTTPException 终止、不达 _store_kb，天然不缓存。
        token, base = _kb_require_token()
        container = (
            "agentteams-manager" if agent == "manager"
            else f"agentteams-worker-{agent}"
        )
        # 兜底（worker only）：Docker 不可用（L2 403 / 挂 502）且 path 在 #1208
        # allowlist（MEMORY.md|memory/**|digest/**）→ #1208 file-content 分块读。
        if agent != "manager" and _wsf_in_allowlist(path):
            if not await _kb_docker_available(token, base, container):
                res = await _wsf_read_file(token, base, agent, path)
                if res is None:
                    raise HTTPException(
                        status_code=404, detail=f"文件不存在：{path}")
                size, text = res
                return {"path": path, "size": size, "content": text,
                        "source": "controller"}
        ws = await _kb_workspace(token, base, agent)
        import urllib.parse as _up
        st, data = await _kb_docker(
            token, base,
            f"/containers/{container}/archive?path={_up.quote(ws + '/' + path)}",
            timeout=60.0,
        )
        if st not in (200, 304) or not data:
            raise HTTPException(status_code=404, detail=f"文件不存在：{path}")
        if len(data) > _KB_MAX_TAR:
            raise HTTPException(status_code=413, detail="文件 tar 超过 20MB")
        import io as _io
        import tarfile as _tf
        content = b""
        size = 0
        try:
            with _tf.open(fileobj=_io.BytesIO(data), mode="r:*") as tf:
                for m in tf.getmembers():
                    if m.isfile():
                        fobj = tf.extractfile(m)
                        if fobj:
                            content = fobj.read()
                            size = m.size
                        break
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"tar 解包失败：{exc}")
        if size > _KB_MAX_FILE:
            raise HTTPException(
                status_code=413, detail="文件超过 512KB，暂不支持在线预览"
            )
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            raise HTTPException(status_code=415, detail="二进制文件，无法在线预览")
        return {"path": path, "size": size, "content": text}

    async def _kb_file_compute_wrapped(key: str) -> Dict[str, Any]:
        # K5 单飞注册表统一签名（key="agent/path"，_spawn_kb_refresh 单飞
        # 槽位同名）。
        a, _, p = key.partition("/")
        return await _kb_file_compute(a, p)

    @router.get("/kb/{agent}/file")
    async def kb_file(agent: str, path: str = "") -> Dict[str, Any]:
        """读单个知识库文件（tar 解包 → UTF-8 文本；二进制/超限拒）。"""
        if not _KB_AGENT_RE.match(agent):
            raise HTTPException(status_code=400, detail="非法 agent 名")
        if not path or path.startswith("/") or ".." in path.split("/"):
            raise HTTPException(status_code=400, detail="非法文件路径")
        if _kb_is_sensitive(path.rsplit("/", 1)[-1], path):
            # 404 而非 403：不泄露敏感文件存在性（dashboard 同款过滤）
            raise HTTPException(status_code=404, detail=f"文件不存在：{path}")
        # v0.5.0-beta.14.17（KBBATCH-K5）：SWR 30s 内存+磁盘门（与
        # tree/graph 同款），键 file-<agent>-<path>。只缓存文本类返回
        # （{"path","size","content"} 形态）；415 二进制/413 超限以
        # HTTPException 终止不达 _store_kb；WSF 兜底（source:"controller"）
        # 在 _store_kb 单点收口不缓存（14.7 不变式）。
        _fkey = f"file-{agent}-{path}"
        _c = _kb_file_cache.get(_fkey)
        if _c and _c[0] > time.monotonic():
            return _c[1]
        _disk = kb_cache.load(_fkey)
        if _disk is not None:
            _ts, _payload = _disk
            _age = time.time() - _ts
            if _age > _KB_SWR_TTL:
                _spawn_kb_refresh("file", f"{agent}/{path}")
            return {**_payload, "cached": True, "age": int(_age)}
        _payload = await (_KB_PREWARM_HOOKS.get("file")
                          or _kb_file_compute_wrapped)(f"{agent}/{path}")
        _store_kb(f"{agent}/{path}", _payload, "file")
        return _payload

    @router.get("/kb/{agent}/files-batch")
    async def kb_files_batch(agent: str, paths: str = "") -> Dict[str, Any]:
        """批量读（K1）：paths=逗号分隔相对路径（≤200），单次 exec
 分帧批读。返回 {agent, files, missing, truncated, cached:false}。
 敏感路径 → missing（不读不报错，与 tree 过滤口径一致）；非法
 路径（绝对/.. /控制字符）静默跳过；通道挂 → 502（调用方 graph
 compute 区分并回退逐文件）。本端点结果不缓存（K1 定位=冷时
 graph compute 的内部批读通道，前端不直调）。"""
        if not _KB_AGENT_RE.match(agent):
            raise HTTPException(status_code=400, detail="非法 agent 名")
        input_missing: List[str] = []
        want: List[str] = []
        seen_p: set = set()
        for seg in paths.split(","):
            p = seg.strip()
            if not p:
                continue
            # 绝对路径 / .. / 控制字符（含 \n \r \t \x00——行协议安全）
            # → 静默跳过（不入 files 也不入 missing）
            if (p.startswith("/") or ".." in p.split("/")
                    or any(c in p for c in ("\n", "\r", "\t", "\x00"))):
                continue
            while p.startswith("./"):
                p = p[2:]
            if not p or p in seen_p:
                continue
            seen_p.add(p)
            if _kb_is_sensitive(p.rsplit("/", 1)[-1], p):
                input_missing.append(p)  # 敏感 → missing（不读）
                continue
            want.append(p)
        want = want[:_KB_BATCH_MAX_PATHS]
        if not want:
            # 空请求 / 全部敏感或非法 → 直接返回（不发 exec）
            return {"agent": agent, "files": {},
                    "missing": input_missing,
                    "truncated": False, "cached": False}
        token, base = _kb_require_token()
        container = (
            "agentteams-manager" if agent == "manager"
            else f"agentteams-worker-{agent}"
        )
        if not await _kb_docker_available(token, base, container):
            raise HTTPException(status_code=409, detail="Docker 通道不可用")
        ws = await _kb_workspace(token, base, agent)
        result = await _kb_files_batch_read(token, base, container, ws, want)
        if result is None:
            raise HTTPException(
                status_code=502, detail="批量读通道失败，请重试")
        return {
            "agent": agent,
            "files": result["files"],
            "missing": input_missing + result["missing"],
            "truncated": result["truncated"],
            "cached": False,
        }

    @router.get("/kb/{agent}/ls")
    async def kb_ls(agent: str, dir: str = "") -> Dict[str, Any]:
        """ （用户真机：知识库「只能看见工作区目录，不能点开看；
 子目录文件也看不见」）：一级目录懒加载——前端目录树展开时按层
 取内容。dir 空=工作区顶层；协议文档目录=该目录一级内容。
 返回 files（文本可点开，路径=工作区相对全路径，直接喂 /file）+
 dirs（可继续展开）。列取走双通道（exec find 主/tar 兜底，
 v0.5.0-beta.13.9），只返回一级子条目，深层跳过。"""
        if not _KB_AGENT_RE.match(agent):
            raise HTTPException(status_code=400, detail="非法 agent 名")
        if dir:
            segs = [p for p in dir.split("/") if p and p != "."]
            if not segs or any(
                p in (".", "..") or p.startswith(".") for p in segs
            ):
                raise HTTPException(status_code=400, detail="非法目录路径")
            dir = "/".join(segs)
        token, base = _kb_require_token()
        container = (
            "agentteams-manager" if agent == "manager"
            else f"agentteams-worker-{agent}"
        )
        # 兜底（worker only）：Docker 不可用 → #1208 懒加载（memory/**|digest/**|MEMORY.md）。
        if agent != "manager":
            if not await _kb_docker_available(token, base, container):
                return await _kb_ls_wsf_fallback(token, base, agent, dir)
        ws = await _kb_workspace(token, base, agent)
        target = f"{ws}/{dir}" if dir else ws
        # v0.5.0-beta.13.9 双通道（旧版 exec-only：通道挂时把传输失败误报
        # 「目录不存在」404）：exec find 主 + tar 兜底；「通道正常但输出空」
        # 以 HEAD 探针（零下载）区分空目录（200/304）与不存在（404）。
        entries = await _kb_find_list(token, base, container, target, maxdepth=1)
        if entries is None:
            entries = await _kb_tar_list(
                token, base, container, target,
                maxdepth=1, include_dirs=True,
            )
            if entries is None:
                raise HTTPException(
                    status_code=404,
                    detail=f"目录不存在：{dir or '（工作区顶层）'}",
                )
        elif not entries:
            import urllib.parse as _up
            st_head, _ = await _kb_docker(
                token, base,
                f"/containers/{container}/archive?path={_up.quote(target)}",
                head=True, timeout=20.0,
            )
            if st_head not in (200, 304):
                raise HTTPException(
                    status_code=404,
                    detail=f"目录不存在：{dir or '（工作区顶层）'}",
                )

        own = target.rstrip("/").rsplit("/", 1)[-1]
        files: List[Dict[str, Any]] = []
        dirs: Dict[str, Dict[str, Any]] = {}
        text_ok = (".md", ".txt", ".yaml", ".yml", ".json")
        symlink_names: List[str] = []
        for e in entries:
            name = e["rel"]
            if not name or name.startswith(".") \
                    or _kb_is_sensitive(name, f"{dir}/{name}" if dir else name):
                continue
            if e["type"] == "d" and name == own:
                continue  # 所请求目录自身（防御：exec 通道 %P 首行为空已滤）
            rel = f"{dir}/{name}" if dir else name
            if e["type"] == "d":
                dirs.setdefault(name, {
                    "path": rel, "name": name, "isdir": True,
                })
            elif e["type"] == "l":
                # v0.5.0-beta.13.10：符号链接列全（目标=目录→可展开，
                # find -H 展开已支持；目标=文件/断链→非文本条目）。
                symlink_names.append(name)
                files.append({
                    "path": rel, "name": name,
                    "size": e["size"], "mtime": e["mtime"],
                    "category": "file", "openable": False,
                    "symlink": True, "_pending_resolve": True,
                })
            elif e["type"] == "f":
                # 非文本文件列出 + openable 标记（13.9「不全」根因②，
                # 与 kb_tree 同口径）。
                files.append({
                    "path": rel, "name": name,
                    "size": e["size"], "mtime": e["mtime"],
                    "category": "file",
                    "openable": name.lower().endswith(text_ok),
                })
        if symlink_names:
            try:
                _targets = [f"{target.rstrip('/')}/{n}" for n in symlink_names]
                _out = await _kb_exec_full(
                    token, base, container,
                    ["python3", "-c",
                     "import os,sys;print('\\n'.join("
                     "'D' if os.path.isdir(p) else 'F' "
                     "for p in sys.argv[1:]))",
                     *_targets],
                    timeout=30.0,
                )
                _resolved = (
                    dict(zip(symlink_names, _out.splitlines()))
                    if _out else {}
                )
                for _f in files:
                    if _f.pop("_pending_resolve", False):
                        if _resolved.get(_f["name"]) == "D":
                            dirs.setdefault(_f["name"], {
                                "path": _f["path"], "name": _f["name"],
                                "isdir": True, "symlink": True,
                            })
                            files.remove(_f)
            except Exception:  # noqa: BLE001 — 解析失败保持文件条目
                for _f in files:
                    _f.pop("_pending_resolve", None)
        files.sort(
            key=lambda f: (0 if f.get("openable", False) else 1, f["path"])
        )
        dir_list = sorted(dirs.values(), key=lambda d: d["path"])
        return {
            "agent": agent, "dir": dir,
            "files": files[:300], "dirs": dir_list[:120],
        }

    @router.get("/kb/{agent}/graph")
    async def kb_graph(agent: str) -> Dict[str, Any]:
        """知识图谱（对齐 QwenPaw 最新版 ReMe 图谱模型）：
 digest 三虚拟分类根 + digest/** + memory/** + 顶层 md 全量节点；
 边 = 分类根→分桶文件（结构边）+ [[wikilink]]/inlinks-outlinks
 路径块（语义边）；无 digest 分桶的旧布局由 MEMORY.md 挂 depth-1
 memory 文件兜底。"""
        if not _KB_AGENT_RE.match(agent):
            raise HTTPException(status_code=400, detail="非法 agent 名")
        # v0.5.0-beta.14.7：graph 结果短 TTL 命中（内部 kb_tree 亦命中树缓存）。
        _c = _kb_graph_cache.get(agent)
        if _c and _c[0] > time.monotonic():
            return _c[1]
        # v0.5.0-beta.14.10：SWR 磁盘缓存（与 tree 同款门；
        # key=graph-{agent}）。
        _disk = kb_cache.load(f"graph-{agent}")
        if _disk is not None:
            _ts, _payload = _disk
            _age = time.time() - _ts
            if _age > _KB_SWR_TTL:
                _spawn_kb_refresh("graph", agent)
            kb_cache.save("last-agent", {"agent": agent})
            return {**_payload, "cached": True, "age": int(_age)}
        # 冷取经注册表取计算体（生产 = 本闭包；测试可假注入，与预热/
        # 刷新同一注入点）。
        _payload = await (_KB_PREWARM_HOOKS.get("graph")
                          or _kb_graph_compute)(agent)
        _store_kb(agent, _payload, "graph")
        return _payload

    async def _kb_graph_compute(agent: str) -> Dict[str, Any]:
        # v0.5.0-beta.14.10：graph 冷取计算体——原端点「缓存门之后」
        # 逐字搬移（原尾内存缓存写移至调用点 _store_kb；内部 kb_tree 调用
        # 走 tree 端点 = 先命中树缓存/SWR 门）。
        tree = await kb_tree(agent)
        # （对齐 QwenPaw 最新版图谱模型，ReMe
        # graph_snapshot_step 同款结构）：节点 = digest 三虚拟分类根
        # （wiki/personal/procedure）+ digest/** 全量 md + memory/**
        # 全量 md + 顶层 md（档案）。旧版只取 memory/** + 3 个顶层文件、
        # 漏掉 digest/ → 用户真机「图谱只有几个点」（实测：
        # 某 daily Worker digest=6 文件全落选；manager 落错工作区=0 节点）。
        md_files = [
            f["path"] for f in tree["files"]
            if f["path"].lower().endswith(".md")
            and (
                f["path"].startswith("memory/")
                or f["path"].startswith("digest/")
                or "/" not in f["path"]
            )
        ][: _KB_MAX_GRAPH_FILES]

        def _cat(p: str) -> str:
            if p.startswith("digest/wiki/"):
                return "digest/wiki"
            if p.startswith("digest/personal/"):
                return "digest/personal"
            if p.startswith("digest/procedure/"):
                return "digest/procedure"
            if p.startswith("digest/"):
                return "digest/other"
            if p.startswith("memory/"):
                return "memory"
            if p in ("MEMORY.md", "SOUL.md", "AGENTS.md", "TEAMS.md",
                     "PROFILE.md", "HEARTBEAT.md", "BOOTSTRAP.md"):
                return "profile"
            return "other"

        existing = {p: _cat(p) for p in md_files}
        # 归一：target（可能缺 .md / 带 .md / 带 query）→ 现有文件路径。
        norm_map: Dict[str, str] = {}
        for p in existing:
            norm_map[p] = p
            if p.lower().endswith(".md"):
                norm_map[p[:-3]] = p
            tail = p.rsplit("/", 1)[-1]
            norm_map.setdefault(tail, p)
            if tail.lower().endswith(".md"):
                norm_map.setdefault(tail[:-3], p)

        nodes: Dict[str, Dict[str, Any]] = {}
        for p, c in existing.items():
            nodes[p] = {"id": p, "name": p.rsplit("/", 1)[-1],
                        "category": c, "virtual": False, "resolved": True,
                        "path": p}
        edges: List[Dict[str, str]] = []
        seen_edges: set = set()

        def _add_edge(s: str, t: str, anchor: str = "") -> None:
            key = (s, t, anchor)
            if key in seen_edges:
                return
            seen_edges.add(key)
            e: Dict[str, str] = {"source": s, "target": t}
            if anchor:
                e["target_anchor"] = anchor
            edges.append(e)

        # 虚拟分类根（ReMe graph_snapshot_step 同款：
        # virtual:{bucket} → digest/{bucket}/ 文件结构边），非空才生成——
        # 避免空根节点污染前端。无 digest 分桶（旧布局 worker）时
        # MEMORY.md 当 hub 挂 depth-1 memory 文件，保证图不空。
        _buckets = ("wiki", "personal", "procedure")
        for b in _buckets:
            if any(p.startswith(f"digest/{b}/") for p in existing):
                nodes[f"virtual:{b}"] = {
                    "id": f"virtual:{b}", "name": b,
                    "category": f"digest/{b}", "virtual": True,
                }
        for p in existing:
            if p.startswith("digest/") and p.count("/") >= 2:
                first = p.split("/", 2)[1]
                if first in _buckets:
                    _add_edge(f"virtual:{first}", p)
        has_digest_bucket = any(
            p.startswith(f"digest/{b}/")
            for b in _buckets for p in existing
        )
        if not has_digest_bucket and "MEMORY.md" in existing:
            for p in existing:
                if p.startswith("memory/") and p.count("/") == 1:
                    _add_edge("MEMORY.md", p)
        # v0.5.0-beta.14.17（KBBATCH-K1 接线）：N 个 md 冷拉——先试 K1
        # 批量读（N 次往返 → 单次 exec 分帧读；仅 docker 正常 tree 可用，
        # WSF 兜底 tree 无真实工作区路径）；通道挂（None）/ 截断 / 任何
        # 异常 → 下方旧并发 8 逐文件路径（原代码逐字保留为 fallback）。
        # 截断也回退：1.8MB 预算盖不住总量时部分内容会降级图谱
        # （漏边/漏摘要），不完整宁慢勿错（与现行为逐字段一致）。
        fetched: Optional[List[str]] = None
        if md_files and tree.get("source") != "controller":
            try:
                _btok, _bbase = _kb_require_token()
                _bcontainer = (
                    "agentteams-manager" if agent == "manager"
                    else f"agentteams-worker-{agent}"
                )
                _bws = str(tree.get("workspace") or "")
                if _bws and _bws != "(controller #1208)":
                    _batch = await _kb_files_batch_read(
                        _btok, _bbase, _bcontainer, _bws, md_files)
                    if _batch is not None and not _batch["truncated"]:
                        _bf = _batch["files"]
                        fetched = [_bf.get(p, "") for p in md_files]
            except Exception:  # noqa: BLE001 - 批量失败一律回退逐文件
                fetched = None
        if fetched is None:
            # 并发 8 拉文件（150 文件串行 ~7s → 并发 ~1s）。
            sem = asyncio.Semaphore(8)

            async def _fetch_text(p: str) -> str:
                async with sem:
                    try:
                        fdata = await kb_file(agent, p)
                    except Exception:  # noqa: BLE001
                        return ""
                    return fdata["content"]

            fetched = await asyncio.gather(*(_fetch_text(p) for p in md_files))
        for p, text in zip(md_files, fetched):
            if not text:
                continue
            if len(text) > _KB_GRAPH_FILE_CAP:
                text = text[:_KB_GRAPH_FILE_CAP]
            # v0.5.0-beta.12：节点 description（首个非标题/标记行 = 文件
            # 摘要，≤120 字；供详情面板展示）。
            for line in text.splitlines():
                s0 = line.strip()
                if (
                    not s0
                    or s0.startswith(("#", "---", "```", "<", "!", "|"))
                ):
                    continue
                nodes[p]["description"] = s0[:120]
                break
            # v0.5.0-beta.12：[[wiki#anchor]] 锚点捕获（移植 QwenPaw
            # MemoryGraphView 详情面板出链/入链展示，开源见
            # THIRD-PARTY-NOTICES）。
            targets: list = []
            for m in re.finditer(
                r"\[\[([^\]|#\n]+?)(?:#([^\]|]+?))?\]", text
            ):
                targets.append(
                    (m.group(1).strip(), (m.group(2) or "").strip())
                )
            for m in re.finditer(
                r"^[ \t]*(?:→|←)\s+(\S+?)(?:[ \t]+name=|[ \t]*$)", text, re.M
            ):
                targets.append((m.group(1).strip(), ""))
            for t, anc in targets:
                t = t.strip().strip("`'\"")
                if not t or t.startswith(("http", "/")):
                    continue
                target = norm_map.get(t) or norm_map.get(t.rstrip("/") or "")
                if not target:
                    tmd = t + ".md" if not t.endswith(".md") else t
                    target = norm_map.get(tmd)
                if target == p:
                    continue
                if target:
                    node_id = target
                else:
                    node_id = t
                    if node_id not in nodes:
                        # 未解析引用≠虚拟根（前端按 virtual:*
                        # 前缀识别根）——普通灰点、不可点开（文件不存在）。
                        nodes[node_id] = {
                            "id": node_id,
                            "name": node_id.rsplit("/", 1)[-1],
                            "category": "other",
                            "virtual": False,
                            "resolved": False,
                        }
                _add_edge(p, node_id, anc)
        _payload: Dict[str, Any] = {
            "agent": agent,
            "nodes": list(nodes.values()),
            "edges": edges,
            "file_count": len(md_files),
        }
        return _payload

    # ── v0.5.0-beta.12 ：团队知识库深化（跨 Worker 搜索 + 聚合图谱）──────────

    async def _kb_all_agents(token: str, base: str) -> List[str]:
        """全部 Agent 名（worker 容器 + manager），供搜索/聚合默认范围。"""
        st, data = await _kb_docker(token, base, "/containers/json")
        if st != 200:
            raise HTTPException(status_code=502, detail="Docker API 不可达")
        import json as _json
        names: List[str] = []
        for c in (_json.loads(data) or []):
            nm = ((c.get("Names") or [""])[0] or "").lstrip("/")
            if nm == "agentteams-manager":
                names.append("manager")
            elif nm.startswith("agentteams-worker-"):
                names.append(nm[len("agentteams-worker-"):])
        return names

    @router.get("/kb/search")
    async def kb_search(q: str = "", agents: str = "") -> Dict[str, Any]:
        """v0.5.0-beta.12 ：团队知识全量搜索（跨 Worker）——扫各 Agent 的
 MEMORY.md + memory/**/*.md，返回命中行+上下文。
 agents=逗号分隔（缺省=全部，上限 12）；每 Agent ≤60 个 md 文件、
 单文件 ≤100KB；结果上限 100 条（150 熔断）。"""
        query = (q or "").strip()
        if not query:
            raise HTTPException(status_code=400, detail="缺少搜索词 q")
        token, base = _kb_require_token()
        if agents.strip():
            agent_list = [
                a.strip() for a in agents.split(",") if a.strip()
            ][:12]
            agent_list = [a for a in agent_list if _KB_AGENT_RE.match(a)]
        else:
            agent_list = (await _kb_all_agents(token, base))[:12]
        if not agent_list:
            return {"query": query, "matches": [], "count": 0,
                    "agents": []}
        ql = query.lower()
        matches: List[Dict[str, Any]] = []
        done_agents: List[str] = []
        sem = asyncio.Semaphore(6)

        async def search_agent(a: str) -> None:
            async with sem:
                try:
                    tree = await kb_tree(a)
                except HTTPException:
                    return
                done_agents.append(a)
                md = [
                    f["path"] for f in tree["files"]
                    if f["path"].lower().endswith(".md") and f["size"] <= 100 * 1024
                ][:60]
                inner = asyncio.Semaphore(4)

                async def _one(pth: str) -> None:
                    if len(matches) > 150:
                        return  # 熔断
                    async with inner:
                        try:
                            fdata = await kb_file(a, pth)
                        except HTTPException:
                            return
                        lines = fdata["content"].splitlines()
                        for i, ln in enumerate(lines):
                            if ql in ln.lower():
                                matches.append(
                                    {
                                        "agent": a,
                                        "path": pth,
                                        "line": i + 1,
                                        "snippet": ln.strip()[:200],
                                    }
                                )
                                if len(matches) > 150:
                                    return

                await asyncio.gather(*(_one(pth) for pth in md))

        await asyncio.gather(*(search_agent(a) for a in agent_list))
        matches.sort(key=lambda m: (m["agent"], m["path"], m["line"]))
        return {
            "query": query,
            "matches": matches[:100],
            "count": len(matches),
            "agents": sorted(done_agents),
        }

    async def kb_graph_merged_compute(agent_list: List[str]) -> Dict[str, Any]:
        # v0.5.0-beta.14.17（KBBATCH-K3）：kb_graph_merged 冷取计算体——
        # 原端点体（agent 解析之后）逐字搬移；供单飞刷新复用
        # （_spawn_kb_refresh "merged"）。逐 agent 走 kb_graph 端点（自带
        # 其 tree/graph 缓存门）→ 合并本身不重复付单 agent 冷取成本。
        sem = asyncio.Semaphore(4)

        async def one(a: str) -> Optional[Dict[str, Any]]:
            async with sem:
                try:
                    return await kb_graph(a)
                except HTTPException:
                    return None

        graphs = await asyncio.gather(*(one(a) for a in agent_list))
        nodes: List[Dict[str, Any]] = []
        edges: List[Dict[str, str]] = []
        ok_agents: List[str] = []
        for g in graphs:
            if not g:
                continue
            a = str(g.get("agent") or "")
            ok_agents.append(a)
            for n in g.get("nodes") or []:
                nid = str(n.get("id") or "")
                nodes.append(
                    {
                        **n,
                        "id": f"{a}::{nid}",
                        "agent": a,
                        "name": n.get("name") or nid.rsplit("/", 1)[-1],
                    }
                )
            for e in g.get("edges") or []:
                edges.append(
                    {
                        "source": f"{a}::{e.get('source')}",
                        "target": f"{a}::{e.get('target')}",
                    }
                )
        return {
            "nodes": nodes[:400],
            "edges": edges[:800],
            "agents": ok_agents,
        }

    async def _kb_merged_compute_wrapped(csv: str) -> Dict[str, Any]:
        # K3 单飞注册表统一签名（key = sorted(agents) 逗号连 csv，
        # _spawn_kb_refresh 单飞槽位同名）。
        return await kb_graph_merged_compute(
            [a for a in csv.split(",") if a])

    @router.get("/kb/graph/merged")
    async def kb_graph_merged(agents: str = "") -> Dict[str, Any]:
        """v0.5.0-beta.12 ：团队聚合图谱——多 Agent 图谱合并（节点 id=
 agent::path，前端按 agent 着色；边保留在原 Agent 内）。
 agents=逗号分隔（缺省=全部，上限 8）；节点 400 / 边 800 上限。
 v0.5.0-beta.14.17（KBBATCH-K3）：SWR 30s 内存+磁盘门（与
 tree/graph 同款），键 merged-<sorted(agents) 逗号连>；冷算 = 多
 Agent 图谱合并（抽 kb_graph_merged_compute，供单飞复用）。"""
        token, base = _kb_require_token()
        if agents.strip():
            agent_list = [
                a.strip() for a in agents.split(",") if a.strip()
            ][:8]
            agent_list = [a for a in agent_list if _KB_AGENT_RE.match(a)]
        else:
            agent_list = (await _kb_all_agents(token, base))[:8]
        if not agent_list:
            return {"nodes": [], "edges": [], "agents": []}
        csv = ",".join(sorted(agent_list))
        # v0.5.0-beta.14.17（KBBATCH-K3）：SWR 门（与 tree/graph 同款）。
        _c = _kb_merged_cache.get(csv)
        if _c and _c[0] > time.monotonic():
            return _c[1]
        _disk = kb_cache.load(f"merged-{csv}")
        if _disk is not None:
            _ts, _payload = _disk
            _age = time.time() - _ts
            if _age > _KB_SWR_TTL:
                _spawn_kb_refresh("merged", csv)
            return {**_payload, "cached": True, "age": int(_age)}
        _payload = await (_KB_PREWARM_HOOKS.get("merged")
                          or _kb_merged_compute_wrapped)(csv)
        _store_kb(csv, _payload, "merged")
        return _payload

    # ── 房间通知（通知中心点击跳转=团队房间的 @提到我，
    # 宿主 inbox 事件无 room_id 是「点了不跳」的根因）──────────────

    @router.get("/room-mentions")
    async def room_mentions(limit: int = 30) -> Dict[str, Any]:
        """各房间最近 @提到当前用户 的消息（Element 通知同款语义）：
 v0.5.0-beta.12 = 实时缓冲（sync_watcher /sync 长轮询事件流即时写入，
 零扫描）+ 全量扫描历史（10s 缓存 bootstrap），event_id 去重合并，
 按时间倒序。前端在 SSE mention 事件触发刷新（非轮询）。
 点击 → 跳房间+定位事件。"""
        cfg = config_mod.load_config()
        matrix_cfg = cfg.get("matrix") or {}
        token = (matrix_cfg.get("access_token") or "").strip()
        user_id = (matrix_cfg.get("user_id") or "").strip()
        if not token:
            raise HTTPException(status_code=401, detail="未登录")
        localpart = user_id.lstrip("@").split(":")[0].lower()
        base = _ordered_addresses(cfg, "matrix")
        if not base:
            raise HTTPException(status_code=502, detail="未配置 Matrix 地址")
        from . import sync_watcher  # noqa: PLC0415 — 实时 @我 缓冲
        homeserver = base[0]
        limit = max(1, min(int(limit), 100))
        # ① 实时缓冲（sync 事件流，房间名从 60s 房间缓存补全）
        with _rooms_cache_lock:
            _rd = (_rooms_cache.get("data") or {}).get("rooms") or []
        room_names: Dict[str, str] = {
            (r.get("room_id") or ""): (r.get("name") or "") for r in _rd
        }
        # 房间名兜底——同步缓冲的 mention 依赖 _rooms_cache（首次
        # /teams/sync 后才填充）；冷启动时按房间懒加载 m.room.name（永久缓存）。
        names: Dict[str, str] = dict(room_names)

        async def _ensure_room_name(room_id: str) -> str:
            nonlocal names
            if names.get(room_id):
                return names[room_id]
            _cached = _room_name_cache.get(room_id)
            if _cached:
                names[room_id] = _cached
                return _cached
            if _room_name_neg.get(room_id, 0.0) > time.time():
                return ""
            hs_base = homeserver.rstrip("/")
            try:
                async with GatedAsyncClient(timeout=8.0, verify=False) as c2:
                    # ① basic info（Tuwunel 实测部分房间 name=None）
                    nm = ""
                    try:
                        nresp = await c2.get(
                            f"{hs_base}/_matrix/client/v3/rooms/{room_id}",
                            headers=_headers_for(cfg, "matrix", hs_base,
                                {"Authorization": f"Bearer {token}"}),
                        )
                        if nresp.status_code == 200:
                            nm = str((nresp.json() or {}).get("name") or "")
                    except Exception:  # noqa: BLE001
                        pass
                    # ② state m.room.name（basic 无 name 时）
                    if not nm:
                        try:
                            sresp = await c2.get(
                                f"{hs_base}/_matrix/client/v3/rooms/{room_id}"
                                "/state/m.room.name",
                                headers=_headers_for(cfg, "matrix", hs_base,
                                {"Authorization": f"Bearer {token}"}),
                            )
                            if sresp.status_code == 200:
                                nm = str(
                                    ((sresp.json() or {}).get("content") or {})
                                    .get("name") or ""
                                )
                        except Exception:  # noqa: BLE001
                            pass
                    if nm:
                        names[room_id] = nm
                        if nm:
                            _room_name_cache[room_id] = nm
            except Exception:  # noqa: BLE001 — 取名失败不阻断
                pass
            if not names.get(room_id):
                _room_name_neg[room_id] = time.time() + 600.0
            return names.get(room_id, "")

        results: List[Dict[str, Any]] = []
        seen_eids: set = set()
        for m in sync_watcher.get_mention_buffer(limit):
            rid_m = str(m.get("room_id") or "")
            nm = names.get(rid_m) or ""
            if not nm:
                nm = await _ensure_room_name(rid_m)
            results.append({**m, "room_name": nm})
            if m.get("event_id"):
                seen_eids.add(m["event_id"])
        # ② 全量扫描历史（10s 缓存；缓存命中时零 HTTP）
        with _room_mentions_lock:
            scan_fresh = (time.time() - _room_mentions_cache["ts"]) < _BOOTSTRAP_SCAN_TTL
            scan_results = _room_mentions_cache["data"] if scan_fresh else None
        if scan_results is None:
            scan_results = []
            try:
                # self. 误写修复（build_router 内非类嵌套，无 self）——
                # FastAPI 把 self 当必传 query 参数 → 前端恒 422（真机反馈根因）。
                await _scan_room_mentions(
                    homeserver, token, user_id, localpart, scan_results,
                )
            except Exception as exc:  # noqa: BLE001
                # 扫描失败不阻断——实时缓冲仍是有效数据源
                logger.debug("room-mentions scan failed: %s", exc)
            with _room_mentions_lock:
                _room_mentions_cache.update(
                    {"data": scan_results, "ts": time.time()}
                )
        for r in scan_results:
            eid = r.get("event_id") or ""
            if eid and eid in seen_eids:
                continue
            if eid:
                seen_eids.add(eid)
            if not r.get("room_name"):
                r = {**r, "room_name": await _ensure_room_name(
                    str(r.get("room_id") or ""))}
            results.append(r)
        results.sort(key=lambda r: -(r.get("ts") or 0))
        return {"mentions": results[:limit], "count": len(results)}

    # ── 待工具审批请求（v0.5.0-beta.12：通知中心「待审批请求」数据源）────
    # Worker Tool Guard 审批请求不带 @人类 → /room-mentions 捞不到（用户
    # 真机缺陷「需要审批没有提示，只能在聊天群看见」根因）。数据源：
    # 实时缓冲（sync_watcher /sync 事件流）+ 全量扫描历史（10s 缓存
    # bootstrap，捞插件关闭期间的未决请求）。状态机：审批请求消息入列，
    # 其后同房间 /approval 命令消息弹最早一条；只留未决。

    @router.get("/room-approvals")
    async def room_approvals(limit: int = 30) -> Dict[str, Any]:
        cfg = config_mod.load_config()
        matrix_cfg = cfg.get("matrix") or {}
        token = (matrix_cfg.get("access_token") or "").strip()
        if not token:
            raise HTTPException(status_code=401, detail="未登录")
        base = _ordered_addresses(cfg, "matrix")
        if not base:
            raise HTTPException(status_code=502, detail="未配置 Matrix 地址")
        from . import sync_watcher  # noqa: PLC0415 — 实时审批缓冲
        homeserver = base[0]
        limit = max(1, min(int(limit), 100))
        # ① 实时缓冲（房间名从 60s 房间缓存补全，冷启动懒加载兜底）。
        with _rooms_cache_lock:
            _rd = (_rooms_cache.get("data") or {}).get("rooms") or []
        names: Dict[str, str] = {
            (r.get("room_id") or ""): (r.get("name") or "") for r in _rd
        }
        buffer = sync_watcher.get_approval_buffer(limit)
        await _resolve_missing_room_names(
            homeserver, token, names,
            [str(a.get("room_id") or "") for a in buffer],
        )
        results: List[Dict[str, Any]] = []
        seen_eids: set = set()
        for a in buffer:
            rid_a = str(a.get("room_id") or "")
            results.append({**a, "room_name": names.get(rid_a, "")})
            if a.get("event_id"):
                seen_eids.add(a["event_id"])
        # ② 全量扫描历史（10s 缓存；缓存命中时零 HTTP）。
        with _room_approvals_lock:
            scan_fresh = (time.time() - _room_approvals_cache["ts"]) < _BOOTSTRAP_SCAN_TTL
            scan_results = (
                _room_approvals_cache["data"] if scan_fresh else None
            )
        if scan_results is None:
            scan_results = []
            try:
                await _scan_room_approvals(homeserver, token, scan_results)
            except Exception as exc:  # noqa: BLE001 — 扫描失败不阻断
                logger.debug("room-approvals scan failed: %s", exc)
            with _room_approvals_lock:
                _room_approvals_cache.update(
                    {"data": scan_results, "ts": time.time()}
                )
        for r in scan_results:
            eid = r.get("event_id") or ""
            if eid and eid in seen_eids:
                continue
            if eid:
                seen_eids.add(eid)
            rid = str(r.get("room_id") or "")
            if rid and not r.get("room_name") and not names.get(rid):
                await _resolve_missing_room_names(homeserver, token, names, [rid])
            results.append({**r, "room_name": names.get(rid, "")})
        results.sort(key=lambda r: -(r.get("ts") or 0))
        return {"approvals": results[:limit], "count": len(results)}

    # ── v0.5.0-beta.12 宿主收件箱审批桥状态（调试/selfcheck 用）──
    @router.get("/host-bridge/status")
    async def host_bridge_status() -> Dict[str, Any]:
        """宿主审批桥可用性 + 在途/累计计数。available=false → 宿主
 无 create_pending_summary（<2.1），抖动/审批条目不可用，页面内
 审批卡不受影响。"""
        from agentteams_connector import host_bridge

        return host_bridge.bridge.status()

    async def _resolve_missing_room_names(
        homeserver: str,
        token: str,
        names: Dict[str, str],
        room_ids: List[str],
    ) -> Dict[str, str]:
        """房间名懒加载兜底（basic info + m.room.name state，/room-mentions
 内部同款两路取值；取不到保持空串，前端回退显示 room_id）。"""
        for rid in room_ids:
            if not rid or names.get(rid):
                continue
            _cached = _room_name_cache.get(rid)
            if _cached:
                names[rid] = _cached
                continue
            if _room_name_neg.get(rid, 0.0) > time.time():
                continue
            hs_base = homeserver.rstrip("/")
            nm = ""
            try:
                async with GatedAsyncClient(timeout=8.0, verify=False) as c2:
                    try:
                        nresp = await c2.get(
                            f"{hs_base}/_matrix/client/v3/rooms/{rid}",
                            headers=_headers_for(cfg, "matrix", hs_base,
                                {"Authorization": f"Bearer {token}"}),
                        )
                        if nresp.status_code == 200:
                            nm = str((nresp.json() or {}).get("name") or "")
                    except Exception:  # noqa: BLE001
                        pass
                    if not nm:
                        try:
                            sresp = await c2.get(
                                f"{hs_base}/_matrix/client/v3/rooms/{rid}"
                                "/state/m.room.name",
                                headers=_headers_for(cfg, "matrix", hs_base,
                                {"Authorization": f"Bearer {token}"}),
                            )
                            if sresp.status_code == 200:
                                nm = str(
                                    ((sresp.json() or {}).get("content") or {})
                                    .get("name") or ""
                                )
                        except Exception:  # noqa: BLE001
                            pass
            except Exception:  # noqa: BLE001 — 取名失败不阻断
                pass
            if nm:
                names[rid] = nm
                _room_name_cache[rid] = nm
            else:
                _room_name_neg[rid] = time.time() + 600.0
        return names

    async def _scan_room_approvals(
        homeserver: str,
        token: str,
        scan_results: List[Dict[str, Any]],
    ) -> None:
        """审批状态机扫描（v0.5.0-beta.12 全量加入；v0.5.0-beta.14.7 T6：
 增量——只重扫 sync 事件流显示有推进的房间，空闲零拨号；600s 兜底
 全扫一次）。时间升序执行（dir=b 返回新→旧，先 reverse）。"""
        import urllib.parse as _up
        from . import sync_watcher  # noqa: PLC0415
        try:
            async with GatedAsyncClient(timeout=20.0, verify=False) as client:
                # v0.5.0-beta.14.18：与全族一致走 _headers_for（该 matrix 地址
                # 若配了覆盖凭据则替换，未配则原样 Bearer）——防公网 matrix
                # 网关 Basic 门场景 401（与 docker_logs 同族缺口）。
                headers = _headers_for(
                    config_mod.load_config(), "matrix", homeserver,
                    {"Authorization": f"Bearer {token}"},
                )
                jresp = await client.get(
                    f"{homeserver.rstrip('/')}/_matrix/client/v3/joined_rooms",
                    headers=headers,
                )
                if jresp.status_code != 200:
                    raise HTTPException(
                        status_code=502,
                        detail=f"房间列表获取失败（{jresp.status_code}）",
                    )
                room_ids: List[str] = (
                    (jresp.json() or {}).get("joined_rooms", [])
                )
                # 最多扫 40 房 × 40 条近期消息（并发 8，局域网 <2s）。
                sem = asyncio.Semaphore(8)
                st_all = _room_scan_state["approvals"]
                full = _scan_should_full("approvals")

                async def scan(room_id: str) -> None:
                    async with sem:
                        st = st_all.get(room_id)
                        if (
                            not full
                            and st is not None
                            and sync_watcher.room_last_ts(room_id)
                            <= st.get("ts", 0)
                        ):
                            # T6：无推进 → 复用上次条目（零 /messages 拨号）。
                            scan_results.extend(st.get("entries") or [])
                            return
                        pending: List[Dict[str, Any]] = []
                        try:
                            mresp = await client.get(
                                f"{homeserver.rstrip('/')}"
                                f"/_matrix/client/v3/rooms/"
                                f"{_up.quote(room_id, safe='')}/messages?"
                                + _up.urlencode({"dir": "b", "limit": 40}),
                                headers=headers,
                            )
                            if mresp.status_code != 200:
                                return
                            events = ((mresp.json() or {}).get("chunk") or [])
                            evs = [
                                e for e in reversed(list(events))
                                if isinstance(e, dict)
                            ]
                            newest = 0
                            for e in evs:
                                _ev_ts = int(e.get("origin_server_ts") or 0)
                                if _ev_ts > newest:
                                    newest = _ev_ts
                                if e.get("type") != "m.room.message":
                                    continue
                                content = e.get("content") or {}
                                if (
                                    not isinstance(content, dict)
                                    or content.get("m.new_content")
                                ):
                                    continue
                                body = str(content.get("body") or "")
                                ap = sync_watcher.parse_approval_request(body)
                                if ap:
                                    pending.append(
                                        {
                                            "room_id": room_id,
                                            "event_id": str(
                                                e.get("event_id") or ""
                                            ),
                                            "sender": str(
                                                e.get("sender") or ""
                                            ),
                                            "body": body[:200],
                                            "ts": int(
                                                e.get("origin_server_ts")
                                                or 0
                                            ),
                                            "kind": ap[0],
                                            "approve_cmd": ap[1],
                                            "deny_cmd": ap[2],
                                        }
                                    )
                                elif sync_watcher._is_approval_command(body):
                                    if pending:
                                        pending.pop(0)
                            st_all[room_id] = {
                                "ts": max(
                                    newest,
                                    sync_watcher.room_last_ts(room_id),
                                ),
                                "entries": pending,
                            }
                            scan_results.extend(pending)
                        except Exception:  # noqa: BLE001 — 单房失败不阻断
                            pass

                await asyncio.gather(*(scan(r) for r in room_ids[:40]))
        except Exception:
            raise
        if full:
            _scan_mark_full("approvals")

    async def _scan_room_mentions(
        homeserver: str,
        token: str,
        user_id: str,
        localpart: str,
        scan_results: List[Dict[str, Any]],
    ) -> None:
        """房间 @我 扫描（v0.5.0-beta.12 全量加入；v0.5.0-beta.14.7 T6：
 增量——只重扫 sync 事件流显示有推进的房间，空闲零拨号；600s 兜底
 全扫一次）。"""
        import urllib.parse as _up
        from . import sync_watcher  # noqa: PLC0415 — T6 增量探针
        try:
            async with GatedAsyncClient(
                timeout=20.0, verify=False
            ) as client:
                headers = _headers_for(
                    config_mod.load_config(), "matrix", homeserver,
                    {"Authorization": f"Bearer {token}"},
                )
                jresp = await client.get(
                    f"{homeserver.rstrip('/')}/_matrix/client/v3/joined_rooms",
                    headers=headers,
                )
                if jresp.status_code != 200:
                    raise HTTPException(
                        status_code=502,
                        detail=f"房间列表获取失败（{jresp.status_code}）",
                    )
                room_ids: List[str] = (jresp.json() or {}).get("joined_rooms", [])
                # 最多扫 40 房 × 12 条近期消息（并发 8，局域网 <2s）。
                sem = asyncio.Semaphore(8)
                st_all = _room_scan_state["mentions"]
                full = _scan_should_full("mentions")

                async def scan(room_id: str) -> None:
                    async with sem:
                        st = st_all.get(room_id)
                        if (
                            not full
                            and st is not None
                            and sync_watcher.room_last_ts(room_id)
                            <= st.get("ts", 0)
                        ):
                            # T6：无推进 → 复用上次条目（零 /messages 拨号）。
                            scan_results.extend(st.get("entries") or [])
                            return
                        entries: List[Dict[str, Any]] = []
                        try:
                            mresp = await client.get(
                                f"{homeserver.rstrip('/')}/_matrix/client/v3/rooms/"
                                f"{_up.quote(room_id, safe='')}/messages",
                                params={"dir": "b", "limit": 12},
                                headers=headers,
                            )
                            if mresp.status_code != 200:
                                return
                            data = mresp.json() or {}
                            room_name = ""
                            for ev in data.get("state", []) or []:
                                if ev.get("type") == "m.room.name":
                                    room_name = str(
                                        (ev.get("content") or {}).get("name") or ""
                                    )
                                    break
                            newest = 0
                            for ev in data.get("chunk", []) or []:
                                _ev_ts = int(ev.get("origin_server_ts") or 0)
                                if _ev_ts > newest:
                                    newest = _ev_ts
                                et = ev.get("type")
                                content = ev.get("content") or {}
                                sender = ev.get("sender") or ""
                                if et != "m.room.message":
                                    continue
                                if sender == user_id:
                                    continue
                                mentioned = False
                                m_users = (content.get("m.mentions") or {}).get(
                                    "user_ids", []
                                ) or []
                                if user_id in m_users:
                                    mentioned = True
                                body = str(content.get("body") or "")
                                if not mentioned and localpart:
                                    low = body[:300].lower()
                                    if f"@{localpart}" in low:
                                        mentioned = True
                                if not mentioned:
                                    continue
                                entries.append(
                                    {
                                        "room_id": room_id,
                                        "room_name": room_name,
                                        "event_id": ev.get("event_id") or "",
                                        "sender": sender,
                                        "body": body[:200],
                                        "ts": int(content.get("origin_server_ts")
                                                    or ev.get("origin_server_ts")
                                                    or 0),
                                    }
                                )
                            st_all[room_id] = {
                                "ts": max(
                                    newest,
                                    sync_watcher.room_last_ts(room_id),
                                ),
                                "entries": entries,
                            }
                            scan_results.extend(entries)
                        except Exception:  # noqa: BLE001 — 单房失败不阻断
                            pass

                await asyncio.gather(
                    *(scan(rid) for rid in room_ids[:40])
                )
        except HTTPException:
            raise
        except Exception:  # noqa: BLE001
            raise  # 调用方 catch 后仅记日志（实时缓冲不受影响）
        if full:
            _scan_mark_full("mentions")



    # ── Worker 工具执行安全（QwenPaw 原生四模式
    # approval_level 对接，L1 only）──────────────────────────────
    # 链路实测：Worker 容器内 qwenpaw app 监听 8088（entrypoint
    # AGENTTEAMS_CONSOLE_PORT 默认 8088），API 前缀 /api；
    # PUT /api/workspace/running-config 收完整 AgentsRunningConfig（pydantic
    # 整对象）→ 只改 approval_level 单字段必须 GET→改→整 PUT（部分 body
    # 会把其余字段洗成默认值）；live 生效（schedule_agent_reload，无需
    # 重启）；agent.json 落盘后 push_loop（5s）推 MinIO → 重启不丢。
    # Manager 容器 app 端口 18799（start-qwenpaw-manager.sh L347）。
    # 写通道：Controller Docker 代理放行 POST /containers/{n}/exec +
    # POST /exec/{id}/start（GET/HEAD 恒放行）；exec stdout 被代理吞
    # （实测）→ 结果写容器 /tmp 文件 + archive 回读验证。

    _APPROVAL_LEVELS = ("OFF", "AUTO", "SMART", "STRICT")

    def _approval_container_of(agent: str) -> str:
        return (
            "agentteams-manager" if agent == "manager"
            else f"agentteams-worker-{agent}"
        )

    async def _approval_read_tmp(
        container: str, token: str, base: str, path: str,
    ) -> Optional[str]:
        import io as _io
        import tarfile as _tf
        import urllib.parse as _up
        st, data = await _kb_docker(
            token, base,
            f"/containers/{container}/archive?path={_up.quote(path)}",
            timeout=30.0,
        )
        if st not in (200, 304) or not data:
            return None
        try:
            with _tf.open(fileobj=_io.BytesIO(data), mode="r:*") as tf:
                for m in tf.getmembers():
                    if m.isfile():
                        fobj = tf.extractfile(m)
                        if fobj:
                            return fobj.read().decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            return None
        return None

    async def _approval_exec(
        container: str, token: str, base: str,
        py_code: str, tmp_path: str,
    ) -> str:
        """exec base64 python → 结果写容器 /tmp → archive 回读。"""
        import asyncio as _aio
        import base64 as _b64

        import httpx as _h
        cmd = (
            f"echo {_b64.b64encode(py_code.encode()).decode()} | "
            f"base64 -d | /opt/venv/qwenpaw/bin/python > {tmp_path} 2>&1; "
            f"echo rc=$? >> {tmp_path}"
        )
        # v0.5.0-beta.14.18：与全族一致走 _headers_for（controller 地址覆盖
        # 凭据替换，未配则原样 Bearer）——外网审批 exec 同族 401 缺口。
        headers = _headers_for(
            config_mod.load_config(), "controller", base,
            {"Authorization": f"Bearer {token}"},
        )
        async with GatedAsyncClient(timeout=60.0, verify=False) as client:
            r = await client.post(
                f"{base}/docker/v1.41/containers/{container}/exec",
                json={
                    "Cmd": ["sh", "-c", cmd],
                    "Detach": True,
                    "Tty": False,
                },
                headers={**headers, "Content-Type": "application/json"},
            )
            if r.status_code not in (200, 201):
                raise HTTPException(
                    status_code=502,
                    detail=f"exec 创建失败（Docker API {r.status_code}）：{r.text[:120]}",
                )
            eid = (r.json() or {}).get("Id") or ""
            s2 = await client.post(
                f"{base}/docker/v1.41/exec/{eid}/start",
                json={"Detach": True, "Tty": False},
                headers=headers,
            )
            if s2.status_code not in (200, 204):
                raise HTTPException(
                    status_code=502,
                    detail=f"exec 启动失败（Docker API {s2.status_code}）",
                )
            # 轮询结果文件（exec 退出后文件就位；15s 上限）。
            for _ in range(15):
                await _aio.sleep(1)
                out = await _approval_read_tmp(container, token, base, tmp_path)
                if out and "rc=" in out:
                    break
            else:
                raise HTTPException(
                    status_code=502, detail="容器内命令 15s 未完成（结果文件未出现）"
                )
            # 清理临时文件（失败无害——/tmp 重启即清）。
            try:
                rc = await client.post(
                    f"{base}/docker/v1.41/containers/{container}/exec",
                    json={
                        "Cmd": ["sh", "-c", f"rm -f {tmp_path}"],
                        "Detach": True,
                        "Tty": False,
                    },
                    headers={**headers, "Content-Type": "application/json"},
                )
                if rc.status_code in (200, 201):
                    cid = (rc.json() or {}).get("Id") or ""
                    if cid:
                        await client.post(
                            f"{base}/docker/v1.41/exec/{cid}/start",
                            json={"Detach": True, "Tty": False},
                            headers=headers,
                        )
            except Exception:  # noqa: BLE001
                pass
        return out  # type: ignore[name-defined]

    # ── #1216 approval 兜底数据面（L2 team-scoped / Docker 不可用）────────
    # 上游 #1216：GET/PUT /api/v1/workers/{name}/approval（worker only，无
    # manager 端点）。L2 可读写本团队 Worker（OFF 除外→403）；team leader
    # 只读；跨团队→404（W8）；旧 Controller（未合 #1216）→404（版本门控）。
    async def _ctl_json(method: str, url: str, token: str,
                        json_body: Optional[Dict[str, Any]] = None) -> tuple:
        """薄包装 → ctl_client.ctl_json（v0.5.0-beta.14.13 去重）。"""
        from . import ctl_client  # noqa: PLC0415
        return await ctl_client.ctl_json(method, url, token, json_body)

    async def _approval_list_wsf(token: str, base: str, agent: str) -> Dict[str, Any]:
        """#1216 兜底列表（L2/docker 不可用）：worker 走 GET /api/v1/workers
 + 逐个 GET approval；Manager 无 #1216 端点 → 错误标记（L1-only）。"""
        items: List[Dict[str, Any]] = []
        st, data, _ = await _ctl_json("GET", f"{base}/api/v1/workers", token)
        if st != 200:
            raise HTTPException(status_code=502,
                                detail=f"Worker 列表获取失败（Controller {st}）")
        workers = (data.get("workers") or []) if isinstance(data, dict) else []
        for w in workers:
            if not isinstance(w, dict):
                continue
            wn = str(w.get("name") or "")
            if not wn:
                continue
            if agent and agent not in ("manager", wn):
                continue
            item: Dict[str, Any] = {
                "agent": wn, "container": f"agentteams-worker-{wn}",
                "kind": "worker",
                "state": str(w.get("state") or w.get("phase") or ""),
                "approval_level": None, "error": "",
            }
            st2, data2, _ = await _ctl_json(
                "GET", f"{base}/api/v1/workers/{wn}/approval", token)
            if st2 == 200 and isinstance(data2, dict):
                item["approval_level"] = str(
                    data2.get("approval_level") or "AUTO").upper()
            elif st2 == 404:
                item["error"] = "审批端点不可用（Controller < #1216 版本或该 Worker 不在团队 scope）"
            else:
                item["error"] = f"审批查询失败（{st2}）"
            items.append(item)
        if (not agent) or agent == "manager":
            items.append({
                "agent": "manager", "container": "agentteams-manager",
                "kind": "manager", "state": "", "approval_level": None,
                "error": "Manager 审批仅 L1 可查（无 #1216 端点）",
            })
        items.sort(key=lambda x: (x["kind"] != "worker", x["agent"]))
        return {"items": items, "levels": list(_APPROVAL_LEVELS),
                "source": "controller"}

    async def _approval_set_wsf(token: str, base: str, agent: str,
                                level: str) -> Dict[str, Any]:
        """#1216 PUT 兜底（L2/docker 不可用，worker only）。
 L2 仅可设 STRICT/SMART/AUTO（OFF→403 透传）；team leader 只读→403；
 404=Controller < #1216 版本或跨团队；409=并发冲突。"""
        url = f"{base}/api/v1/workers/{agent}/approval"
        st, data, text = await _ctl_json(
            "PUT", url, token, json_body={"approval_level": level})
        if st == 200:
            verified = None
            st2, data2, _ = await _ctl_json("GET", url, token)
            if st2 == 200 and isinstance(data2, dict):
                verified = str(data2.get("approval_level") or "").upper()
            return {
                "ok": True, "agent": agent, "level": level,
                "verified": verified, "source": "controller",
                "note": (
                    "已 live 生效（#1216 Controller 审批端点，无需重启）。"
                    if verified == level
                    else "设置命令成功但未回读到新值——请刷新列表确认。"
                ),
            }
        detail = ""
        if isinstance(data, dict):
            detail = str(data.get("detail") or data.get("message") or "")
        if not detail:
            detail = (text or "")[:200]
        if st == 404:
            raise HTTPException(
                status_code=404,
                detail="审批端点不可用（Controller < #1216 版本，或 Worker 不在团队 scope）")
        if st == 409:
            raise HTTPException(
                status_code=409, detail=f"Worker 更新中（并发冲突），请稍后重试：{detail}")
        if st == 403:
            raise HTTPException(
                status_code=403,
                detail=detail or "无权限设置该级别（L2 不能设 OFF；team leader 只读）")
        raise HTTPException(status_code=st or 502,
                            detail=detail or f"设置失败（{st}）")

    @router.get("/debug/dial-stats")
    async def debug_dial_stats() -> Dict[str, Any]:
        """拨号计数快照（，v0.5.0-beta.14.6）——修复验收/排障对账用。"""
        from . import dial_gate as _dg  # noqa: PLC0415

        return _dg.dial_stats()

    @router.get("/approval/list")
    async def approval_list(agent: str = "") -> Dict[str, Any]:
        """各 Worker/Manager 当前 approval_level（只读：archive 直读
 agent.json——与 KB 同通道，零新端点依赖）。
 ?agent=xxx 过滤单个（Worker 管理展开行懒加载用，避免全量扫）。"""
        token, base = _kb_require_token()
        # v0.5.0-beta.14.5: 20s TTL 缓存命中即返（成功响应才写；异常路径不缓存）。
        _cached = _approval_list_cache.get(agent)
        if _cached and _cached[0] > time.monotonic():
            return _cached[1]
        # L2（403）/ Docker 挂（502）→ #1216 兜底（worker 走 Controller；
        # manager L1-only）。
        try:
            st, data = await _kb_docker(token, base, "/containers/json")
        except HTTPException:
            return await _approval_list_wsf(token, base, agent)
        if st in (401, 403, 502):
            return await _approval_list_wsf(token, base, agent)
        if st != 200:
            raise HTTPException(
                status_code=502, detail=f"容器列表获取失败（Docker API {st}）"
            )
        import json as _json
        try:
            containers = _json.loads(data or b"[]")
        except Exception:  # noqa: BLE001
            containers = []
        if agent:
            if not _KB_AGENT_RE.match(agent):
                raise HTTPException(status_code=400, detail="非法 agent 名")
            # 修：此前过滤元组恒含 agentteams-manager →
            # 指定 worker 过滤时 manager 混入结果（单 worker 查询变全量 manager）。
            wanted = (
                {"agentteams-manager"}
                if agent == "manager"
                else {f"agentteams-worker-{agent}"}
            )
            containers = [
                c for c in containers
                if (c.get("Names") or [""])[0].lstrip("/") in wanted
            ]

        async def _one(agent: str, cname: str, kind: str, state: str):
            item: Dict[str, Any] = {
                "agent": agent, "container": cname, "kind": kind,
                "state": state, "approval_level": None, "error": "",
            }
            try:
                home = "/root/agentteams-fs/agents" + (
                    "/manager" if kind == "manager" else f"/{agent}"
                )
                # qwenpaw 布局优先，copaw 布局兜底（与 _kb_workspace 候选一致）。
                text = None
                for cand in (
                    f"{home}/.qwenpaw/workspaces/default/agent.json",
                    f"{home}/.copaw/workspaces/default/agent.json",
                ):
                    text = await _approval_read_tmp(cname, token, base, cand)
                    if text:
                        break
                if text:
                    try:
                        item["approval_level"] = str(
                            (_json.loads(text) or {}).get("approval_level") or "AUTO"
                        ).upper()
                    except Exception:  # noqa: BLE001
                        item["error"] = "agent.json 解析失败"
                else:
                    item["error"] = "agent.json 读取失败（容器布局差异或 API 超时）"
            except HTTPException as exc:
                item["error"] = str(exc.detail)
            return item

        seen = set()
        if agent and not containers:
            # 指定 agent 但容器列表无匹配——明确报错而非空列表
            return {
                "items": [{
                    "agent": agent, "container": _approval_container_of(agent),
                    "kind": "manager" if agent == "manager" else "worker",
                    "state": "", "approval_level": None,
                    "error": "容器未找到（Worker 不存在或已删除，或容器已停止）",
                }],
                "levels": list(_APPROVAL_LEVELS),
            }
        # v0.5.0-beta.14.5: 串行 → 并发（原 for ... await _one() 串行 ≈23s@WAN）。
        # 先收集目标（manager/worker 去重与 agent 过滤语义与旧版一致），再
        # asyncio.gather 并发执行；并发上限 12（对 Controller Docker API 礼貌）。
        targets: List[tuple] = []
        for c in containers:
            name = (c.get("Names") or [""])[0].lstrip("/")
            state = c.get("State") or ""
            if name == "agentteams-manager" and "manager" not in seen:
                seen.add("manager")
                targets.append(("manager", name, "manager", state))
            elif name.startswith("agentteams-worker-"):
                wn = name[len("agentteams-worker-"):]
                if wn and wn not in seen:
                    seen.add(wn)
                    targets.append((wn, name, "worker", state))
        _al_sem = asyncio.Semaphore(12)

        async def _one_limited(a: str, cname: str, kind: str, state: str):
            async with _al_sem:
                return await _one(a, cname, kind, state)

        items: List[Dict[str, Any]] = list(
            await asyncio.gather(*(_one_limited(*t) for t in targets))
        )
        items.sort(key=lambda x: (x["kind"] != "worker", x["agent"]))
        payload = {"items": items, "levels": list(_APPROVAL_LEVELS)}
        _approval_list_cache[agent] = (
            time.monotonic() + _APPROVAL_LIST_TTL_SECONDS,
            payload,
        )
        return payload

    @router.post("/approval/set")
    async def approval_set(request: Request) -> Dict[str, Any]:
        """设 Worker/Manager 工具执行安全级别（L1 only；live 生效）。"""
        import json as _json
        token, base = _kb_require_token()
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            raise HTTPException(status_code=400, detail="请求体需为 JSON")
        agent = str(body.get("agent") or "").strip()
        level = str(body.get("level") or "").strip().upper()
        if not _KB_AGENT_RE.match(agent):
            raise HTTPException(status_code=400, detail="非法 agent 名")
        # v0.5.0-beta.14.5: 写路径先失效缓存（防写窗口内列表缓存旧值）。
        _approval_list_cache.pop("", None)
        _approval_list_cache.pop(agent, None)
        if level not in _APPROVAL_LEVELS:
            raise HTTPException(
                status_code=400,
                detail=f"level 必须是 {_APPROVAL_LEVELS} 之一",
            )
        container = _approval_container_of(agent)
        # 兜底（worker only）：Docker 不可用（L2 403 / 挂 502）→ #1216 PUT。
        # Manager 无 #1216 端点 → 保持 docker exec 路径（L1 only）。
        if agent != "manager":
            if not await _kb_docker_available(token, base, container):
                _res = await _approval_set_wsf(token, base, agent, level)
                # v0.5.0-beta.14.5: 兜底写成功后同样失效缓存。
                _approval_list_cache.pop("", None)
                _approval_list_cache.pop(agent, None)
                return _res
        port = 18799 if agent == "manager" else 8088
        ts = str(int(time.time()))
        tmp = f"/tmp/.at-appr-{ts}"
        py_code = (
            "import urllib.request, json\n"
            f"LEVEL = {level!r}\n"
            f"BASE = 'http://127.0.0.1:{port}'\n"
            "def req(method, path, data=None):\n"
            "    r = urllib.request.Request(BASE + path, data=data,\n"
            "        headers={'Content-Type': 'application/json'}, method=method)\n"
            "    return urllib.request.urlopen(r, timeout=20)\n"
            "try:\n"
            "    cfg = json.loads(req('GET', '/api/workspace/running-config').read().decode())\n"
            "    cfg['approval_level'] = LEVEL\n"
            "    r = req('PUT', '/api/workspace/running-config', json.dumps(cfg).encode())\n"
            "    print('OK', LEVEL, r.status, r.read().decode()[:160])\n"
            "except Exception as e:\n"
            "    print('ERR', repr(e))\n"
        )
        try:
            out = await _approval_exec(container, token, base, py_code, tmp)
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"容器内执行失败：{exc}")
        # 验证 agent.json 落地（archive 直读）。
        import urllib.parse as _up
        import io as _io
        import tarfile as _tf
        home = "/root/agentteams-fs/agents" + (
            "/manager" if agent == "manager" else f"/{agent}"
        )
        verified = None
        for cand in (
            f"{home}/.qwenpaw/workspaces/default/agent.json",
            f"{home}/.copaw/workspaces/default/agent.json",
        ):
            st2, data2 = await _kb_docker(
                token, base,
                f"/containers/{container}/archive?path={_up.quote(cand)}",
                timeout=30.0,
            )
            if st2 in (200, 304) and data2:
                try:
                    with _tf.open(fileobj=_io.BytesIO(data2), mode="r:*") as tf:
                        for m in tf.getmembers():
                            if m.isfile():
                                fobj = tf.extractfile(m)
                                if fobj:
                                    j = _json.loads(fobj.read().decode("utf-8"))
                                    verified = str(
                                        j.get("approval_level") or ""
                                    ).upper()
                                    break
                except Exception:  # noqa: BLE001
                    pass
                break
        if out.startswith("OK"):
            # v0.5.0-beta.14.5: 写成功后再次失效（清掉写窗口内缓存的旧值）。
            _approval_list_cache.pop("", None)
            _approval_list_cache.pop(agent, None)
            return {
                "ok": True,
                "agent": agent,
                "level": level,
                "verified": verified,
                "note": (
                    "已 live 生效（容器内 app 已热加载，无需重启）；"
                    "agent.json 由 push_loop 在数秒内同步 MinIO，重启不丢。"
                    if verified == level
                    else "命令执行成功但 agent.json 未回读到新值——请刷新列表确认。"
                ),
            }
        raise HTTPException(
            status_code=502,
            detail=f"容器内执行未成功：{out.strip()[:300]}",
        )

    # ── Catch-all proxy ────────────────────────────────────────────────

    @router.api_route(
        "/{target}/{path:path}",
        methods=["GET", "POST", "PUT", "DELETE"],
    )
    async def proxy(
        request: Request,
        target: str,
        path: str,
    ) -> Response:
        if target not in ("matrix", "controller"):
            raise HTTPException(
                status_code=400, detail="unknown proxy target (matrix/controller)"
            )
        cfg = config_mod.load_config()
        matrix_cfg = cfg.get("matrix") or {}

        if target == "matrix":
            base_urls = _ordered_addresses(cfg, "matrix")
            token = (matrix_cfg.get("access_token") or "").strip()
            raw_path = path.lstrip("/")
            # 前端可能省略前缀：传完整 /_matrix/client/v3/... 则原样；
            # 否则自动补 /_matrix/client/v3/（v3 是 CS API 版本段，缺它 → 404）。
            if raw_path.startswith("_matrix/client/"):
                full_path = f"/{raw_path}"
            else:
                full_path = f"/_matrix/client/v3/{raw_path}"
            headers: Dict[str, str] = {}
            if token:
                headers["Authorization"] = f"Bearer {token}"
        else:  # controller
            base_urls = _ordered_addresses(cfg, "controller")
            # 双斜杠兜底：上游调用方若传 /api/v1//workers，uvicorn 会先 301——
            # 后端侧再压一遍保证链路干净（前端已根治，此处防其他来源）。
            full_path = "/" + "/".join(
                seg for seg in path.split("/") if seg != ""
            )
            if not full_path.startswith(CONTROLLER_ALLOWED_PREFIXES):
                raise HTTPException(
                    status_code=400,
                    detail="Controller 代理仅允许 /api/ 与 /healthz 路径",
                )
            headers = {}
            ctl_token = _token_or_none(cfg)
            if ctl_token:
                headers["Authorization"] = f"Bearer {ctl_token}"
            elif matrix_cfg.get("access_token"):
                # L2 auth: Matrix token once W-PR-1 composite auth lands.
                headers["Authorization"] = f"Bearer {matrix_cfg.get('access_token')}"

        if not base_urls:
            raise HTTPException(
                status_code=502,
                detail="未配置任何地址" if target == "controller" else "未配置 Matrix 地址",
            )

        # v0.5.0-beta.13.19（技能中心「上传/自定义技能」）：multipart/form-data
        # 原样透传——读原始字节 + 连同 boundary 的 Content-Type 一起转发；
        # 旧版一律 request.json() → multipart 解析失败 body=None → 上游收
        # 空体（技能 zip 上传必 400）。
        body = None
        raw_body: Optional[bytes] = None
        req_ct = request.headers.get("content-type", "")
        if request.method in ("POST", "PUT"):
            if req_ct.lower().startswith("multipart/form-data"):
                raw_body = await request.body()
            else:
                try:
                    body = await request.json()
                except Exception:  # noqa: BLE001
                    body = None

        last_error = "无可用地址"
        query_string = ""
        if request.url.query:
            query_string = f"?{request.url.query}"
        # Matrix room ids contain '!' and ':' — percent-encode the path when
        # building the upstream URL (Element 同款做法，Tuwunel 要求编码)。
        import urllib.parse as _urlparse_mod

        encoded_path = _urlparse_mod.quote(full_path, safe="/._-~")
        # v0.5.0-beta.14.7（带宽）：/messages 默认只取 message 事件（实测
        # 5.2KB→1KB/页，5Mbps 链路显著）；调用方显式传 filter= 时尊重其选择。
        if (
            target == "matrix"
            and full_path.endswith("/messages")
            and "/_matrix/client/v3/rooms/" in full_path
            and "filter=" not in (request.url.query or "")
        ):
            _flt = _urlparse_mod.quote('{"types":["m.room.message"]}', safe="")
            query_string += ("&" if query_string else "?") + f"filter={_flt}"
        # v0.5.0-beta.14.2（外网 401 根因①②）：①4xx 不再标记 working
        # （旧版任何 HTTP 响应都 _mark_working——一次 401 即污染 working
        # cache，切回内网后死地址仍居首恒 401）；②GET/HEAD 遇 4xx/5xx 继续
        # 下一地址（首个 401 地址可能是网关代理的会话门、直连控制器健康
        # → 换地址即通）；变更类方法（POST/PUT/DELETE）遇 4xx 原样返回不
        # 试下一地址（副作用安全：不在另一地址重放写请求）。全部失败 →
        # 首个非 2xx 响应原样返回（上游 401 body 自带诊断），否则 502。
        first_bad: Optional[tuple] = None
        for base in base_urls:
            url = f"{base.rstrip('/')}{encoded_path}{query_string}"
            # v0.5.0-beta.14.3: 该地址的覆盖凭据（basic/bearer）——无则原生认证。
            addr_headers = _headers_for(cfg, target, base, headers)
            try:
                # v0.5.0-beta.12：连接类错误同址重试一次（300ms 退避）——
                # 切网瞬间/偶发抖动不应直接放弃该地址（用户「连通失败重试」）。
                # 只重试传输层错误；已拿到 HTTP 响应（含 5xx）的不重试。
                resp = None
                for attempt in (1, 2):
                    try:
                        req_started = time.time()
                        async with GatedAsyncClient(
                            timeout=_PROXY_TIMEOUT, verify=False
                        ) as client:
                            if raw_body is not None:
                                send_headers = dict(addr_headers)
                                send_headers["Content-Type"] = req_ct
                                resp = await client.request(
                                    request.method,
                                    url,
                                    content=raw_body,
                                    headers=send_headers,
                                )
                            else:
                                resp = await client.request(
                                    request.method, url, json=body, headers=addr_headers
                                )
                        break
                    except (
                        httpx.ConnectError,
                        httpx.ConnectTimeout,
                        httpx.ReadTimeout,
                        httpx.ReadError,
                        httpx.RemoteProtocolError,
                    ) as t_exc:
                        if attempt == 2:
                            raise
                        logger.info(
                            "proxy %s %s via %s 传输层错误，同址重试: %s",
                            target, full_path, base,
                            selfcheck._classify_error(t_exc),
                        )
                        await asyncio.sleep(0.3)
                if resp.status_code < 400:
                    _mark_working(target, base)
                    elapsed_ms = int((time.time() - req_started) * 1000)
                    logger.debug(
                        "proxy %s %s -> %d (%dms)",
                        target,
                        full_path,
                        resp.status_code,
                        elapsed_ms,
                    )
                    return Response(
                        content=resp.content,
                        status_code=resp.status_code,
                        media_type=resp.headers.get("content-type"),
                    )
                # 4xx/5xx：不标记 working，首个非 2xx 留作最终返回。
                if first_bad is None:
                    first_bad = (
                        resp.status_code, resp.content,
                        resp.headers.get("content-type"),
                    )
                # v0.5.0-beta.14.6：GET/HEAD 仅在地址相关/瞬时错误时换下
                # 一地址（401/403 网关门、408/429、5xx）；确定性 4xx（400/404/
                # 409…）地址无关 → 原样立即返回（不再跨址重试）。
                if request.method in ("GET", "HEAD") and should_failover_status(
                    resp.status_code
                ):
                    logger.info(
                        "proxy %s %s via %s -> %d（换下一地址）",
                        target, full_path, base, resp.status_code,
                    )
                    continue
                return Response(
                    content=resp.content,
                    status_code=resp.status_code,
                    media_type=resp.headers.get("content-type"),
                )
            except Exception as exc:  # noqa: BLE001 - try the next address
                last_error = selfcheck._classify_error(exc)
                logger.warning(
                    "proxy %s %s failed via %s: %s",
                    target, full_path, base,
                    last_error,
                )
        if first_bad is not None:
            return Response(
                content=first_bad[1],
                status_code=first_bad[0],
                media_type=first_bad[2],
            )
        raise HTTPException(
            status_code=502, detail=f"所有地址请求失败：{last_error}{_pinned_note(cfg)}"
        )

    # v0.5.0-beta.14.10：SWR 计算体 + 刷新入口注册入模块级表（端点
    # 调用时解析 / 单测假注入 / 启动预热 _kb_prewarm_agent 均读本表）。
    _KB_PREWARM_HOOKS.update({
        "refresh": _spawn_kb_refresh,
        "tree": _kb_tree_compute,
        "graph": _kb_graph_compute,
        "agents": _kb_agents_compute,
        # v0.5.0-beta.14.17（KBBATCH-K3/K5）：merged/file 冷取计算体注册
        # （单飞刷新与端点冷取同一注入点；签名=key 字符串）。
        "merged": _kb_merged_compute_wrapped,
        "file": _kb_file_compute_wrapped,
    })
    # v0.5.0-beta.14.11：轻探针注册（SWR 刷新门变更检测用）。
    _KB_PROBE_HOOKS.update({"probe": _kb_probe_signature})

    return router
