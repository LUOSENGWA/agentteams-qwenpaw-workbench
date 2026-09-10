# -*- coding: utf-8 -*-
"""HTTP router for the AgentTeams QwenPaw Workbench backend plugin.

Mounted by the plugin host under ``/api`` + prefix ``/agentteams-proxy``.
Frontend plugin fetches these same-origin endpoints (no CORS):

- ``GET/PUT /agentteams-proxy/config``      user config (secrets redacted)
- ``POST    /agentteams-proxy/login``       Matrix m.login.password
- ``POST    /agentteams-proxy/selfcheck/{level}``  L0/L1/L2/all
- ``GET     /agentteams-proxy/health``      backend liveness + version
- ``{METHOD}/{agentteams-proxy}/{matrix|controller}/{path}``  forwarded

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
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import __version__, config as config_mod
from . import matrix_client, selfcheck

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

_PROBE_TIMEOUT = 6.0


def _address_list(cfg: Dict[str, Any], kind: str) -> List[str]:
    if kind == "matrix":
        return [v for v in (cfg.get("matrix_homeservers") or []) if v]
    if kind == "sglang":
        # v0.4.97: SGLang 双地址纳入 working cache 体系（自动重排/failover）。
        return [v for v in ((cfg.get("sglang") or {}).get("urls") or []) if v]
    return [v for v in (cfg.get("controller_urls") or []) if v]


def _ordered_addresses(cfg: Dict[str, Any], kind: str) -> List[str]:
    """Cached working address first, then the rest in configured order."""
    urls = _address_list(cfg, kind)
    if not urls:
        return []
    with _cache_lock:
        cached = _working_cache.get(kind)
    if cached and cached in urls:
        return [cached] + [u for u in urls if u != cached]
    return urls


def _mark_working(kind: str, url: str) -> None:
    with _cache_lock:
        _working_cache[kind] = url


def _count_gateway_aliases(
    routes_body: object, providers_body: object
) -> tuple[int, list[str]]:
    """v0.5.0-beta.12：验证回报——网关 alias 层自检计数。

    解包语义与前端 unwrapHigress 严格一致（Console {code,data} 信封 →
    裸数组 / data.routes / data.providers），谓词只认 EXACT/EQUAL 精确匹配
    且 upstream provider 存在（=可解析下界；modelMapping 派生别名另路，
    此处不重复计）。9/10 装验实报「还是看不见」= 静默平铺无诊断锚点，
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
    """v0.4.92: 连通性测试请求——传表单当前值（可未保存），空则测已配置。"""

    matrix: Optional[List[str]] = None
    controller: Optional[List[str]] = None
    sglang: Optional[List[str]] = None  # v0.4.97: SGLang 双地址列表


class VerifyAdminRequest(BaseModel):
    """v0.5.0-beta.12: L1 管理员验证二选一（同 dashboard 语义，仅 L1 使用）。

    两条路径（互斥，优先密码）：
    - admin_username + admin_password → POST {gateway}/session/login
      （Console 单操作员登录；成功 → 持有 Console 管理员会话，
      供网关面 AI routes/providers 消费 = 模型选择 alias 层数据源）。
    - controller_token → GET {controller}/api/v1/teams Bearer（beta.12：
      去尾斜杠——Controller 的 Gin 对 /api/v1/teams/ 返回 404，与 8/14
      dashboard f1f2 同款坑；无斜杠才进鉴权门，401=token 无效）
      （现状 L1 全量 Controller 管理 API 凭据，语义不变）。
    """

    admin_username: Optional[str] = None
    admin_password: Optional[str] = None  # "***" = 用已存值（脱敏占位符语义）
    controller_token: Optional[str] = None  # "***" = 用已存值
    # 留空 = 回退 config 已存值；config 也空 → 可操作错误（beta.12：
    # Console 宿主端口部署时自选、人人不同，不做端口探测）
    gateway_admin_url: Optional[str] = None


class TokenValidationError(ValueError):
    """token 内容不合法（含非 ASCII 等）——无法进入 HTTP header。

    9/10 装验实报「填了 admin token 也提示无效（UnicodeEncodeError）」：终端复制的
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
    """Controller admin token 解析（v0.5.0-beta.12 定案，9/10 装验反馈：「controller
    token 的文件路径可以删掉了，留个命令就行」——token 文件路径路删除，获取
    方式=UI 留获取命令（docker exec agentteams-controller cat
    /var/run/agentteams/cli-token）+ 粘贴；非 docker 部署=部署期注入 env）。

    解析优先级：
    1. ``controller_token``（手动粘贴）——快照值，轮换后需重贴；
    2. env ``AGENTTEAMS_CONTROLLER_TOKEN``（非 docker / 部署期注入）。

    安全定案不变：token 值永不离开连接器进程（前端只见来源标记）；不引入任何
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

    v0.5.0-beta.12 修复（9/10 装验实报：团队管理页 HTTP 500）：此函数此前
    被 3 个端点调用（/teams/structure、/docker-logs/{component}、/approval/set）
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
    """插件 → 宿主收件箱通知（用户 8/15：插件通知接到 QwenPaw 收件箱）。

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
# 0.4.99 B5：/room-mentions 全量扫描结果 10s 缓存（实时增量走 sync_watcher
# 事件缓冲，扫描只做历史 bootstrap——前端按 SSE mention 事件刷新非轮询）。
_room_mentions_cache: Dict[str, Any] = {"data": None, "ts": 0.0}
_room_mentions_lock = threading.Lock()
# v0.5.0-beta.10：/room-approvals 全量扫描结果 10s 缓存（同款 bootstrap：
# 实时增量走 sync_watcher 审批缓冲，扫描捞插件关闭期间的未决审批请求）。
_room_approvals_cache: Dict[str, Any] = {"data": None, "ts": 0.0}
_room_approvals_lock = threading.Lock()
_structure_cache: Dict[str, Any] = {"data": None, "ts": 0.0}


def invalidate_data_caches(reason: str = "") -> None:
    """v0.4.97: 账号切换 → 清空全部聚合数据缓存。

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
    logger.info("data caches invalidated (%s)", reason or "no reason")

# Sync filter: only room name + membership state, 1 timeline event, no
# presence/ephemeral — keeps the first sync payload small (dashboard 同款做法).
_SYNC_FILTER: Dict[str, Any] = {
    "presence": {"types": []},
    # v0.4.98 再版 9：m.muted_room（房间静音，Element 同款 account data——
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

    Worker tree shape (设计定案 §6.5): team room → its Workers (领/工/审)
    → each Worker's spawn tree (spawns stay empty until O20 merges).
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
        # 最后一条消息（v0.4.81：聊天 tab「最后消息时间 + 新到旧排序」数据源）。
        # /sync 无 since（每次全量快照）→ timeline(limit=1) 恒为该房间最新事件。
        last_ts = 0
        last_body = ""
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
        }
        if not entry["name"]:
            # 无名房间命名优先级（v0.4.81）：
            # ① m.direct 对方（新 DM 对方未 accept 邀请时 members 只有自己，
            #    此前直接落「（空房间）」——用户真机反馈"空房间，说过话才有名字"）
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

    # v0.4.98 再版 8：解析 /sync rooms.invite 段（此前只读 join——邀请房间
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

    # v0.4.98 再版 9：静音房间集合（account_data m.muted_room 聚合，
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

    @router.get("/sglang/loads")
    async def sglang_loads() -> Dict[str, Any]:
        """可选模块：集群负载（L1 专属，§5.8b 增强版）。

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
        # v0.4.97: 双地址（内网/外网）failover——working cache 优先（自动重排
        # 选出的最快可达），其余按配置顺序；兼容旧配置单地址 "url"。
        bases = [
            u.strip().rstrip("/")
            for u in (sglang.get("urls") or [])
            if str(u).strip()
        ]
        legacy = str(sglang.get("url") or "").strip().rstrip("/")
        if legacy and legacy not in bases:
            bases.append(legacy)
        ordered = _ordered_addresses({"sglang": {"urls": bases}}, "sglang") or bases
        if not ordered:
            raise HTTPException(
                status_code=502, detail="未配置 SGLang 地址"
            )
        payload = None
        last_err = "无可用地址"
        for base in ordered:
            try:
                async with _httpx.AsyncClient(timeout=8.0, verify=False) as client:
                    resp = await client.get(f"{base}/v1/loads")
                if resp.status_code != 200:
                    last_err = f"{base} HTTP {resp.status_code}"
                    continue
                payload = resp.json()
                _mark_working("sglang", base)
                break
            except Exception as exc:  # noqa: BLE001 - 网络错误换下一地址
                last_err = f"{base} {selfcheck._classify_error(exc)}"
        if payload is None:
            raise HTTPException(status_code=502, detail=f"SGLang 全部地址失败：{last_err}")

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

        9/3：插件创建 Worker 无模型候选（model 自由文本，留空=controller
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
        bases = [
            u.strip().rstrip("/")
            for u in (sglang.get("urls") or [])
            if str(u).strip()
        ]
        legacy = str(sglang.get("url") or "").strip().rstrip("/")
        if legacy and legacy not in bases:
            bases.append(legacy)
        ordered = _ordered_addresses({"sglang": {"urls": bases}}, "sglang") or bases
        if not ordered:
            raise HTTPException(status_code=502, detail="未配置 SGLang 地址")
        last_err = "无可用地址"
        for base in ordered:
            try:
                async with _httpx.AsyncClient(timeout=8.0, verify=False) as client:
                    resp = await client.get(f"{base}/v1/models")
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
            status_code=502, detail=f"SGLang 全部地址失败：{last_err}"
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
        homeservers = cfg.get("matrix_homeservers") or []
        with _cache_lock:
            cached_hs = _working_cache.get("matrix")
        homeserver = cached_hs if cached_hs in homeservers else (homeservers[0] if homeservers else "")
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
                status_code=502, detail=selfcheck._classify_error(exc)
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
            # v0.4.98 再版 8：邀请房间（rooms.invite 段，前端邀请区渲染）。
            "invites": parsed["invites"],
            # v0.4.98 再版 9：静音房间（m.muted_room account data 聚合）。
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
        homeservers = cfg.get("matrix_homeservers") or []
        with _cache_lock:
            cached_hs = _working_cache.get("matrix")
        homeserver = cached_hs if cached_hs in homeservers else (homeservers[0] if homeservers else "")
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
                    status_code=502, detail=selfcheck._classify_error(exc)
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

        async def _scan(room_entry: Dict[str, Any]) -> List[Dict[str, Any]]:
            async with sem:
                encoded = _urlparse_mod.quote(room_entry["room_id"], safe="/._-~")
                url = (
                    f"{homeserver.rstrip('/')}/_matrix/client/v3/rooms/{encoded}/messages"
                    "?dir=b&limit=30"
                )
                try:
                    async with httpx.AsyncClient(timeout=10.0, verify=False) as client:
                        resp = await client.get(
                            url, headers={"Authorization": f"Bearer {token}"}
                        )
                    if resp.status_code != 200:
                        return []
                    chunk = resp.json().get("chunk") or []
                except Exception as exc:  # noqa: BLE001
                    logger.debug("workflow/events: scan failed %s: %s", room_entry["room_id"], exc)
                    return []

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
            return events

        scanned = await asyncio.gather(*(_scan(r) for r in rooms_sorted))
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
        homeservers = cfg.get("matrix_homeservers") or []
        with _cache_lock:
            cached_hs = _working_cache.get("matrix")
        homeserver = cached_hs if cached_hs in homeservers else (homeservers[0] if homeservers else "")
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
                    status_code=502, detail=selfcheck._classify_error(exc)
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

        async def _scan(room_entry: Dict[str, Any]) -> List[Dict[str, Any]]:
            async with sem:
                encoded = _urlparse_mod.quote(room_entry["room_id"], safe="/._-~")
                # 产物是稀疏事件（文档埋在大量对话里）：分页深扫最多 5 页 ×100 条。
                # dir=b + end token 向更早翻页（聊天室分页同款，Tuwunel 已验证支持）。
                collected: List[Dict[str, Any]] = []
                page_token = ""
                try:
                    async with httpx.AsyncClient(timeout=15.0, verify=False) as client:
                        for _page in range(5):
                            url = (
                                f"{homeserver.rstrip('/')}/_matrix/client/v3/rooms/{encoded}/messages"
                                f"?dir=b&limit=100"
                            )
                            if page_token:
                                url += f"&from={_urlparse_mod.quote(page_token, safe='')}"
                            resp = await client.get(
                                url, headers={"Authorization": f"Bearer {token}"}
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
            return items

        scanned = await asyncio.gather(*(_scan(r) for r in rooms_sorted))
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
            if (
                not force
                and struct_entry["data"] is not None
                and now - struct_entry["ts"] < _ROOMS_CACHE_TTL
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
            with _cache_lock:
                cached_ctl = _working_cache.get("controller")
            controller = (
                cached_ctl
                if cached_ctl in controller_urls
                else controller_urls[0]
            )
            for attempt_token in tokens:
                try:
                    async with httpx.AsyncClient(timeout=10.0, verify=False) as client:
                        resp = await client.get(
                            f"{controller.rstrip('/')}/api/v1/workers",
                            headers={"Authorization": f"Bearer {attempt_token}"},
                        )
                    if resp.status_code != 200:
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
                                # v0.5.0-beta.12（批次 0）：roomID=Worker 个人房间
                                # （A8a-fix 私聊直跳，Worker 容器不能接受邀请，
                                # 新建 DM 是死路）；runtime=CR 字段（A8b 徽章，
                                # 9/7 轮 3 实锤：此前映射漏取，前端恒空）。
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
                    _mark_working("controller", controller)
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
            matrix_cfg2 = cfg.get("matrix") or {}
            token2 = (matrix_cfg2.get("access_token") or "").strip()
            homeservers2 = cfg.get("matrix_homeservers") or []
            with _cache_lock:
                cached_hs2 = _working_cache.get("matrix")
            homeserver2 = (
                cached_hs2
                if cached_hs2 in homeservers2
                else (homeservers2[0] if homeservers2 else "")
            )
            if homeserver2 and token2:
                try:
                    sync_resp = await asyncio.to_thread(
                        matrix_client.sync,
                        homeserver2,
                        token2,
                        timeout_ms=0,
                        sync_filter=_SYNC_FILTER,
                    )
                    parsed = _parse_sync_rooms(sync_resp, user_id)
                    tree = parsed["worker_tree"]
                    source = "room-fallback"
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "teams/structure fallback sync failed: %s", exc
                    )
            else:
                tree = []

        payload = {"ok": True, "tree": tree, "source": source}
        with _rooms_cache_lock:
            _structure_cache["data"] = payload
            _structure_cache["ts"] = now
        logger.info(
            "teams/structure: %d teams via %s",
            len(tree),
            source,
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
        # 取值："config"|"env"=可用；"invalid"=配置了但坏了。（beta.12：
        # token 文件路径路删除——file/file_unreadable 取值不复存在。）
        try:
            _t, _src = _resolve_controller_token(cfg)
            if _t:
                out["controllerTokenSource"] = _src
            else:
                out["controllerTokenSource"] = ""
        except TokenValidationError:
            out["controllerTokenSource"] = "invalid"
        with _cache_lock:
            out["effective"] = {
                "matrix": _working_cache.get("matrix", ""),
                "controller": _working_cache.get("controller", ""),
            }
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
        merged = config_mod.update_config(incoming)
        # v0.4.97: 登录身份变更（同 /login 语义）→ 清聚合缓存 + 重启 sync 游标。
        # 只按 user_id 判定——普通保存配置（未换账号）不触发重启。
        if (prev.get("matrix") or {}).get("user_id") != (
            merged.get("matrix") or {}
        ).get("user_id"):
            invalidate_data_caches("config.matrix")
            from . import sync_watcher as _sw  # noqa: PLC0415

            await _sw.restart("config.matrix")
        # Addresses changed → re-probe so the effective status is honest.
        await selfcheck.refresh_effective(merged)
        return config_mod.redact(merged)

    @router.post("/config/test")
    async def config_test(patch: ConfigTestRequest) -> Dict[str, Any]:
        """v0.4.92: 连通性测试——逐地址测延迟，返回 {url, ok, ms, detail}。

        可传未保存的表单值（测试草稿地址）；不传则测已配置列表。
        仅当传入列表与已配置一致时才更新 working cache（applied=true）——
        草稿测试不动生效地址。
        """
        cfg = config_mod.load_config()
        cfg_matrix = [u.strip() for u in (cfg.get("matrix_homeservers") or []) if u and u.strip()]
        cfg_ctl = [u.strip() for u in (cfg.get("controller_urls") or []) if u and u.strip()]
        matrix_list = [u.strip() for u in (patch.matrix or cfg_matrix) if u and u.strip()]
        ctl_list = [u.strip() for u in (patch.controller or cfg_ctl) if u and u.strip()]
        # v0.4.97: SGLang 双地址（传草稿列表则测草稿，否则测已配置；兼容旧 "url"）。
        cfg_sg = cfg.get("sglang") or {}
        cfg_sg_urls = [
            str(u).strip()
            for u in (
                cfg_sg.get("urls")
                or ([cfg_sg.get("url")] if cfg_sg.get("url") else [])
            )
            if str(u).strip()
        ]
        sglang_list = [
            str(u).strip() for u in (patch.sglang or cfg_sg_urls) if str(u).strip()
        ]
        token = (cfg.get("controller_token") or "").strip()

        with _cache_lock:
            prev = {
                "matrix": _working_cache.get("matrix", ""),
                "controller": _working_cache.get("controller", ""),
            }
        results = await selfcheck.test_addresses(
            matrix_list, ctl_list, sglang_list, token, with_diag=True
        )
        applied = False
        same_lists = (matrix_list == cfg_matrix) and (ctl_list == cfg_ctl)
        if same_lists and (matrix_list or ctl_list):
            await selfcheck.refresh_effective(cfg)
            applied = True
        with _cache_lock:
            effective = {
                "matrix": _working_cache.get("matrix", ""),
                "controller": _working_cache.get("controller", ""),
            }
        # v0.4.92（再版）：测完自动切换要可见——switched 标记哪些类型换了生效地址。
        switched = {
            kind: bool(effective.get(kind) and effective[kind] != prev[kind])
            for kind in ("matrix", "controller")
        }
        return {
            "ok": True,
            "matrix": results["matrix"],
            "controller": results["controller"],
            "sglang": results["sglang"],
            "effective": effective,
            "applied": applied,
            "switched": switched,
        }

    @router.post("/config/verify-admin")
    async def verify_admin(body: VerifyAdminRequest) -> Dict[str, Any]:
        """v0.5.0-beta.12: L1 管理员验证（admin 账号密码 或 Controller token 二选一）。

        密码路径换不来 Controller 管理 API 凭据（controller 无 token 签发端点，
        A2 不收 level-1 matrix token）——成功只授予 Console 会话（网关面）；
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
        console_url = (
            (body.gateway_admin_url or cfg.get("gateway_admin_url") or "").strip()
        ).rstrip("/")

        # --- 路径 A：admin 账号密码 → Console /session/login ---
        if username and password:
            # Higress 地址（v0.5.0-beta.12 定案，9/10 装验：「同主机 8001/6868
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
            try:
                async with httpx.AsyncClient(timeout=8.0, verify=False) as client:
                    rr = await client.post(
                        f"{console_url}/session/login",
                        json={"username": username, "password": password},
                    )
            except Exception as exc:
                return {
                    "ok": False,
                    "error": (
                        f"Higress 地址不可达（{console_url}："
                        f"{exc.__class__.__name__}）。请检查端口——Console 宿主"
                        "端口是部署时自选的（默认 18001），与 Controller 端口不同"
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
                    "console_session": session_cookie,
                },
            )
            # v0.5.0-beta.12：会话到手立即自检 alias 层（有会话≠有 alias——
            # 解包/形状断点要在验证时就暴露，而不是等模型下拉静默平铺）。
            gw_routes, gw_aliases = 0, []
            if session_cookie:
                try:
                    async with httpx.AsyncClient(timeout=8.0, verify=False) as client:
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
                    async with httpx.AsyncClient(timeout=8.0, verify=False) as client:
                        rr = await client.get(
                            f"{base}/api/v1/teams",
                            headers={"Authorization": f"Bearer {token}"},
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
    async def _gateway_passthrough(path: str) -> Dict[str, Any]:
        """v0.5.0-beta.12: 网关面透传（Higress Console，8001）。

        消费密码模式持有的 Console 管理员会话（console_session）；
        无会话/不可达 → available=false（前端优雅降级：模型选择器
        alias 层隐藏，SGLang 列表+Worker 现值+自由输入不受影响）。
        原始 JSON 直出，形状由前端解析（与 dashboard higress-api 同义）。
        """
        from . import config as cfgmod

        cfg = await asyncio.to_thread(cfgmod.load_config)
        session = str(cfg.get("console_session") or "")
        console_url = str(cfg.get("gateway_admin_url") or "").strip().rstrip("/")
        if not session or not console_url:
            return {"available": False, "data": None, "reason": "no_console_session"}
        try:
            async with httpx.AsyncClient(timeout=8.0, verify=False) as client:
                r = await client.get(
                    f"{console_url}{path}", headers={"Cookie": session}
                )
            if r.status_code != 200:
                return {"available": False, "data": None, "reason": f"http_{r.status_code}"}
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
        homeservers = cfg.get("matrix_homeservers") or []
        with _cache_lock:
            cached = _working_cache.get("matrix")
        homeserver = cached if cached in homeservers else (homeservers[0] if homeservers else "")
        if not homeserver:
            raise HTTPException(status_code=502, detail="未配置 Matrix 地址")
        if not token:
            raise HTTPException(status_code=401, detail="未登录，请先在配置页登录")

        try:
            rooms = matrix_client.joined_rooms(homeserver, token).get("joined_rooms", [])
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=selfcheck._classify_error(exc)) from exc

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
            async with sem:
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
                try:
                    async with httpx.AsyncClient(timeout=4.0, verify=False) as client:
                        resp = await client.get(
                            f"{homeserver.rstrip('/')}/_matrix/client/v3/rooms/{room_id}/state/m.room.name",
                            headers={"Authorization": f"Bearer {token}"},
                        )
                    if resp.status_code == 200:
                        entry["name"] = (resp.json().get("name") or "").strip() or ""
                except Exception as exc:  # noqa: BLE001 - best-effort
                    logger.debug(
                        "teams/rooms: name lookup failed for %s: %s",
                        room_id,
                        exc,
                    )
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
        # Worker-dimension groups for the SpawnTree view (设计定案 §6.5):
        # Leader and Workers are all Workers; spawn lists stay empty until
        # the O20 endpoint merges (adapter swaps the data source).
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
        homeservers = cfg.get("matrix_homeservers") or []
        with _cache_lock:
            cached_hs = _working_cache.get("matrix")
        homeserver = cached_hs if cached_hs in homeservers else (homeservers[0] if homeservers else "")
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
            async with _httpx.AsyncClient(timeout=60.0, verify=False) as client:
                resp = await client.post(
                    url,
                    content=data,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": content_type,
                    },
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
                status_code=502, detail=selfcheck._classify_error(exc)
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
                async with _httpx.AsyncClient(timeout=30.0, verify=False) as client:
                    resp = await client.get(target, headers=headers)
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
        raise HTTPException(status_code=502, detail=f"日志拉取失败：{last_error}")

    @router.post("/dm")
    async def open_dm(req: DmRequest) -> Dict[str, Any]:
        """Open (create-or-reuse) a DM room with a team member.

        Body: {user: target MXID or bare localpart}.
        """
        cfg = config_mod.load_config()
        matrix_cfg = cfg.get("matrix") or {}
        token = (matrix_cfg.get("access_token") or "").strip()
        homeservers = cfg.get("matrix_homeservers") or []
        with _cache_lock:
            cached = _working_cache.get("matrix")
        homeserver = cached if cached in homeservers else (homeservers[0] if homeservers else "")
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
            result = matrix_client.create_dm(homeserver, token, target)
        except matrix_client.MatrixError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=selfcheck._classify_error(exc)) from exc
        return {"ok": True, "target": target, **result}

    @router.get("/matrix/member/messages")
    async def member_messages(
        roomId: str,
        sender: str,
        limit: int = 5,
        maxPages: int = 6,
    ) -> Dict[str, Any]:
        """成员最近消息（B4 成员详情卡）：/messages 翻页按 sender 过滤。

        Matrix /search 的 filter.senders 虽有效（8/15 实测 Tuwunel），但
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
        max_pages = max(1, min(int(maxPages), 10))
        import urllib.parse as _urlparse_mod

        found: List[Dict[str, Any]] = []
        from_token = ""
        last_error = "无可用地址"
        for page in range(max_pages):
            params = {"dir": "b", "limit": "50"}
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
                    async with httpx.AsyncClient(
                        timeout=12.0, verify=False
                    ) as client:
                        resp = await client.get(
                            f"{hs.rstrip('/')}{raw_path}",
                            headers={"Authorization": f"Bearer {token}"},
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
                    status_code=502, detail=f"messages 请求失败：{last_error}"
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
        """已读回执双写（m.read + m.fully_read，8/18 批次 1）。

        协议与 dashboard 对齐（交叉验证基准）：
        - m.read:      POST /receipt/m.read/{eventId}（event 级）
        - m.fully_read: PUT  /user/{uid}/rooms/{rid}/account_data/m.fully_read
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
                # 同步 httpx 走线程池——不阻塞 event loop（/matrix/search
                # 同款教训，8/15 搜索慢主因）。
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
        """Matrix /search 全文检索（B1 消息搜索，§6.6 消息搜索）。

        Tuwunel 已验证支持（8/14 实测：filter 必填、中文/分页/group_by
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
        # 8/15 用户反馈"搜索再快一点"），改用 AsyncClient + 手组 body。
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
                async with httpx.AsyncClient(
                    timeout=12.0, verify=False
                ) as client:
                    resp = await client.post(
                        f"{hs.rstrip('/')}/_matrix/client/v3/search",
                        json=matrix_body,
                        headers={"Authorization": f"Bearer {token}"},
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
            raise HTTPException(status_code=502, detail=f"搜索请求失败：{last_error}")

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
                data = matrix_client.login(hs, req.user, req.password)
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
                # v0.4.97: 切账号 = 数据源切换——清 60s 聚合缓存（手动刷新不再
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
        raise HTTPException(status_code=502, detail=f"所有地址登录失败：{last_error}")

    @router.post("/selfcheck/{level}")
    async def run_selfcheck(level: str) -> Dict[str, Any]:
        """Run L0/L1/L2/all self-check against the current config."""
        cfg = config_mod.load_config()
        if level == "l0":
            return selfcheck.run_l0()
        if level == "l1":
            return await selfcheck.run_l1(cfg)
        if level == "l2":
            return selfcheck.run_l2(cfg)
        if level == "l3":
            return await selfcheck.run_l3(cfg)
        if level == "l4":
            return await selfcheck.run_l4(cfg)
        if level == "all":
            return await selfcheck.run_all(cfg)
        raise HTTPException(status_code=400, detail="unknown level (l0-l4/all)")

    @router.get("/media/proxy")
    async def proxy_direct_url(url: str) -> Response:
        """Server-side fetch of a direct http(s) file URL (v0.4.98 再版 10).

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
            async with httpx.AsyncClient(
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
        homeservers = cfg.get("matrix_homeservers") or []
        with _cache_lock:
            cached = _working_cache.get("matrix")
        homeserver = cached if cached in homeservers else (homeservers[0] if homeservers else "")
        if not homeserver:
            raise HTTPException(status_code=502, detail="未配置 Matrix 地址")
        if not token:
            raise HTTPException(status_code=401, detail="未登录")
        import urllib.parse as _urlparse_mod

        encoded_media = _urlparse_mod.quote(media_id, safe="/._-~")
        # 再版 14：双路径回退——Tuwunel 媒体路由在不同构建间有漂移：
        # 旧版 /_matrix/media/v3/* 与新版 /_matrix/client/v1/media/*
        # 8/29 内网实锤（真实 mxc 带 token）两条都 200；外网构建无法
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
            async with httpx.AsyncClient(timeout=60.0, verify=False) as client:
                for url in media_paths:
                    r = await client.get(
                        url, headers={"Authorization": f"Bearer {token}"}
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
                status_code=502, detail=f"媒体下载失败：{selfcheck._classify_error(exc)}"
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

    # ── 远端团队知识库（再版 13，用户 8/29 定位：知识库=自己团队的
    #    Leader/Worker 知识库，不是宿主本地）────────────────────────────
    # 数据通道：Controller Docker API 反向代理（/docker/v1.41/...，
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
        with _cache_lock:
            base = _working_cache.get("controller") or ""
        if not base or base not in [u for u in (cfg.get("controller_urls") or []) if u]:
            base = [u for u in (cfg.get("controller_urls") or []) if u]
            base = base[0] if base else ""
        if not base:
            raise HTTPException(status_code=502, detail="未配置 Controller 地址")
        return token, base.rstrip("/")

    async def _kb_docker(
        token: str, base: str, path: str, head: bool = False,
        timeout: float = 40.0,
    ) -> tuple:
        """Controller Docker API（GET/HEAD 恒放行）。返回 (status, bytes)。"""
        import httpx as _h
        url = f"{base}/docker/v1.41{path}"
        headers = {"Authorization": f"Bearer {token}"}
        try:
            async with _h.AsyncClient(timeout=timeout, verify=False) as client:
                if head:
                    resp = await client.head(url, headers=headers)
                    return resp.status_code, b""
                resp = await client.get(url, headers=headers)
                return resp.status_code, resp.content
        except _h.TimeoutException:
            # 8/29 re16 实测：服务器 Docker daemon 对个别容器（agentteams-manager，
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

    async def _kb_exec(
        token: str, base: str, container: str, cmd: List[str],
        timeout: float = 40.0,
    ) -> str:
        """8/30 re18：Controller 代理 docker exec（只读 find/ls 用途）。
        大工作区（manager live ws ≈152MB）超 20MB tar 上限时的轻量列取。
        实测（8/30）：POST /exec → 201，POST /exec/{id}/start → 多路复用帧
        （8 字节头：stream+3×0+4B big-endian len + payload）。
        输出上限 2MB（find -maxdepth 1 行式清单足够）。"""
        import httpx as _h
        headers = {"Authorization": f"Bearer {token}"}
        try:
            async with _h.AsyncClient(timeout=timeout, verify=False) as client:
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
                    return ""
                eid = (r1.json() or {}).get("Id", "")
                if not eid:
                    return ""
                r2 = await client.post(
                    f"{base}/docker/v1.41/exec/{eid}/start",
                    json={"Detach": False, "Tty": False},
                    headers=headers,
                )
        except _h.TimeoutException:
            return ""
        if r2.status_code != 200:
            return ""
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

    async def _kb_workspace(token: str, base: str, agent: str) -> str:
        """探测 Agent 工作区路径（5min 缓存）。无则 404。"""
        now = time.time()
        hit = _kb_ws_cache.get(agent)
        # 再版 3：TTL 5min→30min。工作区路径由容器挂载决定、实际不变；
        # 5min 一到期就重付「inspect + 3×HEAD 探测 + archive」4 次串行 Docker
        # API 往返（经 Controller 代理），用户反馈 9/5 图谱「点好多次才打开」的
        # 后端侧贡献项之一。
        if hit and now - hit["ts"] < 1800:
            return hit["ws"]
        container = (
            "agentteams-manager" if agent == "manager"
            else f"agentteams-worker-{agent}"
        )
        # 0.4.99 修：Controller Docker 代理不转 HEAD /containers/{name}/json
        # （8/29 实测 HEAD=404 / GET=200 / HEAD archive=200）——改用 GET
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
        # 8/30 re18（用户真机：NMH/NMA 看不见 + 图谱只有几个点）：manager
        # 是特例——live 工作区在 /root/manager-workspace（HOME 挂载），而
        # MinIO 镜像目录只有 agent.json stub（26KB）。实测（8/30）：
        # stub=26KB tar 仅 agent.json；live=152MB，MEMORY.md 19KB +
        # memory/57 + digest/ + nm-protocol/{NMH,NMA}.md。manager 优先探
        # live，探不到再回退 MinIO 候选。
        if agent == "manager":
            candidates = (
                "/root/manager-workspace/.qwenpaw/workspaces/default",
            ) + candidates
        import urllib.parse as _up
        # 再版 3：候选路径探测并行（原串行——4 个候选最坏 4×40s 超时；
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

    @router.get("/kb/agents")
    async def kb_agents() -> Dict[str, Any]:
        """远端 Agent 清单：Docker 容器列表（agentteams-worker-* +
        agentteams-manager）+ Controller workers API 补 role/team。"""
        token, base = _kb_require_token()
        st, data = await _kb_docker(token, base, "/containers/json")
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
            async with _h.AsyncClient(timeout=8.0, verify=False) as client:
                resp = await client.get(
                    f"{base}/api/v1/workers",
                    headers={"Authorization": f"Bearer {token}"},
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
        token, base = _kb_require_token()
        ws = await _kb_workspace(token, base, agent)
        container = (
            "agentteams-manager" if agent == "manager"
            else f"agentteams-worker-{agent}"
        )
        import urllib.parse as _up
        # 8/29 re16（用户要求对齐 QwenPaw 最新版文件管理）：四分类——
        #   档案 = 6 个默认 workspace markdown（QwenPaw console
        #   defaultWorkspaceMarkdown 同款清单）；日记 = memory/**（daily
        #   section）；知识库 = digest/**（digest section）；
        #   文件 = 其余顶层文件 + 顶层目录（只列不展开，文本可点开）。
        _PROFILE_FILES = {
            "AGENTS.md", "SOUL.md", "PROFILE.md", "MEMORY.md",
            "HEARTBEAT.md", "BOOTSTRAP.md",
        }
        files: List[Dict[str, Any]] = []
        dirs: List[Dict[str, Any]] = []
        seen: set = set()

        async def _add_entries(
            data: bytes, prefix: str, category: str,
        ) -> None:
            # 8/29 re16 路径修：tar 目录请求返回相对路径（memory/ 下文件=
            # "2026-08-29.md"），而 /kb/{a}/file 按 {ws}/{path} 直读——
            # re13 起 tree 返回相对路径导致日记/digest 文件点开必 404
            # （此前被「容器不存在」404 掩盖，用户未走到点开那步）。
            # 此处统一拼回工作区相对全路径。
            for e in _kb_tar_entries(data):
                rel = e["path"]
                p = f"{prefix}/{rel}" if rel else prefix
                if p in seen:
                    continue
                seen.add(p)
                files.append(
                    {"path": p, "name": e["name"] or p.rsplit("/", 1)[-1],
                     "size": e["size"], "mtime": e["mtime"],
                     "category": category}
                )

        # ① 顶层：档案（6 默认 md）+ 文件（其余文件 + 目录条目）
        if agent == "manager":
            # 8/30 re18：manager live ws ≈152MB（8/30 实测，含 history.db
            # 23MB + 垃圾目录），全量 tar 会吃 20MB 上限且下载重——直接走
            # exec find 轻量列取（只读，输出行式 type/size/name）。
            out = await _kb_exec(
                token, base, container,
                ["find", ws, "-maxdepth", "1",
                 "-printf", "%y %s %f\n"],
                timeout=90.0,
            )
            for ln in out.splitlines():
                parts = ln.split(" ", 2)
                if len(parts) != 3:
                    continue
                typ, size_s, name = parts
                if not name or name.startswith("."):
                    continue
                if name in ("memory", "digest"):
                    continue  # ②③ 专属分类
                if name in seen:
                    continue
                seen.add(name)
                if typ == "d":
                    dirs.append(
                        {"path": name, "name": name, "isdir": True,
                         "category": "file"}
                    )
                else:
                    files.append(
                        {"path": name, "name": name,
                         "size": int(size_s or 0), "mtime": 0,
                         "category": "profile" if name in _PROFILE_FILES
                         else "file"}
                    )
        else:
            st_top, data_top = await _kb_docker(
                token, base,
                f"/containers/{container}/archive?path={_up.quote(ws)}",
                timeout=60.0,
            )
            if st_top in (200, 304) and data_top:
                if len(data_top) > _KB_MAX_TAR:
                    raise HTTPException(
                        status_code=413,
                        detail="工作区顶层超过 20MB，无法列取")
                # _kb_tar_entries 丢目录条目——顶层目录清单需原生 tarfile 解析
                # （Docker archive 目录请求：顶层段=所请求目录自身，parts[1]=
                # 真实顶层条目名；仅 parts 长 2 = 直接顶层条目）。
                import io as _io
                import tarfile as _tf
                with _tf.open(
                    fileobj=_io.BytesIO(data_top), mode="r:*",
                ) as tf:
                    for m in tf.getmembers():
                        nm = m.name.replace("\\", "/")
                        parts = [q for q in nm.split("/")
                                 if q and q != "."]
                        if len(parts) != 2:
                            continue
                        top = parts[1]
                        if top.startswith(".") or top in (
                            "memory", "digest",
                        ):
                            continue  # 隐藏项 + ②③ 专属分类
                        if top in seen:
                            continue
                        seen.add(top)
                        if m.isdir():
                            dirs.append(
                                {"path": top, "name": top,
                                 "isdir": True, "category": "file"})
                        else:
                            files.append(
                                {"path": top, "name": top,
                                 "size": m.size, "mtime": m.mtime,
                                 "category": "profile"
                                 if top in _PROFILE_FILES else "file"}
                            )
        # ② 日记（daily = memory/**，原全子树逻辑保留）
        st_mem, data_mem = await _kb_docker(
            token, base,
            f"/containers/{container}/archive?path={_up.quote(ws + '/memory')}",
            timeout=60.0,
        )
        if st_mem in (200, 304) and data_mem:
            if len(data_mem) > _KB_MAX_TAR:
                raise HTTPException(
                    status_code=413, detail="memory/ 超过 20MB，无法列取")
            await _add_entries(data_mem, "memory", "daily")
        # ③ 知识库（digest = digest/**，QwenPaw digest section 同款路径）
        st_dig, data_dig = await _kb_docker(
            token, base,
            f"/containers/{container}/archive?path={_up.quote(ws + '/digest')}",
            timeout=60.0,
        )
        if st_dig in (200, 304) and data_dig:
            if len(data_dig) > _KB_MAX_TAR:
                raise HTTPException(
                    status_code=413, detail="digest/ 超过 20MB，无法列取")
            await _add_entries(data_dig, "digest", "digest")
        # ④ 兼容旧逻辑：单独抓 6 档案文件中未随顶层 tar 出现者（布局差异兜底）
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

        # 文本过滤 + 排序（档案优先，其余按路径）。
        keep = [
            f for f in files
            if f["path"].lower().endswith((".md", ".txt", ".yaml", ".yml", ".json"))
        ][:300]
        cat_order = {"profile": 0, "daily": 1, "digest": 2, "file": 3}
        keep.sort(
            key=lambda f: (cat_order.get(f.get("category", "file"), 3), f["path"])
        )
        keep_dirs = dirs[:60]
        return {
            "agent": agent, "workspace": ws,
            "files": keep, "dirs": keep_dirs, "count": len(keep),
        }

    @router.get("/kb/{agent}/file")
    async def kb_file(agent: str, path: str = "") -> Dict[str, Any]:
        """读单个知识库文件（tar 解包 → UTF-8 文本；二进制/超限拒）。"""
        if not _KB_AGENT_RE.match(agent):
            raise HTTPException(status_code=400, detail="非法 agent 名")
        if not path or path.startswith("/") or ".." in path.split("/"):
            raise HTTPException(status_code=400, detail="非法文件路径")
        token, base = _kb_require_token()
        ws = await _kb_workspace(token, base, agent)
        container = (
            "agentteams-manager" if agent == "manager"
            else f"agentteams-worker-{agent}"
        )
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

    @router.get("/kb/{agent}/ls")
    async def kb_ls(agent: str, dir: str = "") -> Dict[str, Any]:
        """8/30 re18（用户真机：知识库「只能看见工作区目录，不能点开看；
        NMH 和 NMA 也看不见」）：一级目录懒加载——前端目录树展开时按层
        取内容。dir 空=工作区顶层；nm-protocol=该目录一级内容。
        返回 files（文本可点开，路径=工作区相对全路径，直接喂 /file）+
        dirs（可继续展开）。tar 只解析一层（parts 长 2=直接子条目），
        深层条目跳过不返回。"""
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
        ws = await _kb_workspace(token, base, agent)
        container = (
            "agentteams-manager" if agent == "manager"
            else f"agentteams-worker-{agent}"
        )
        target = f"{ws}/{dir}" if dir else ws
        # exec find 列一层（不拉全量 tar——manager live ws 152MB 场景安全）。
        out = await _kb_exec(
            token, base, container,
            ["find", target, "-maxdepth", "1",
             "-printf", "%y %s %f\n"],
            timeout=60.0,
        )
        if not out:
            raise HTTPException(
                status_code=404,
                detail=f"目录不存在：{dir or '（工作区顶层）'}",
            )
        own = target.rstrip("/").rsplit("/", 1)[-1]
        files: List[Dict[str, Any]] = []
        dirs: Dict[str, Dict[str, Any]] = {}
        text_ok = (".md", ".txt", ".yaml", ".yml", ".json")
        for ln in out.splitlines():
            parts = ln.split(" ", 2)
            if len(parts) != 3:
                continue
            typ, size_s, name = parts
            if not name or name.startswith("."):
                continue
            if typ == "d" and name == own:
                continue  # find 首行=所请求目录自身
            rel = f"{dir}/{name}" if dir else name
            if typ == "d":
                dirs.setdefault(name, {
                    "path": rel, "name": name, "isdir": True,
                })
            elif typ == "f" and name.lower().endswith(text_ok):
                files.append({
                    "path": rel, "name": name,
                    "size": int(size_s or 0), "mtime": 0,
                    "category": "file",
                })
        files.sort(key=lambda f: f["path"])
        dir_list = sorted(dirs.values(), key=lambda d: d["path"])
        return {
            "agent": agent, "dir": dir,
            "files": files[:300], "dirs": dir_list[:120],
        }

    @router.get("/kb/{agent}/graph")
    async def kb_graph(agent: str) -> Dict[str, Any]:
        """知识图谱（8/30 re18 对齐 QwenPaw 最新版 ReMe 图谱模型）：
        digest 三虚拟分类根 + digest/** + memory/** + 顶层 md 全量节点；
        边 = 分类根→分桶文件（结构边）+ [[wikilink]]/inlinks-outlinks
        路径块（语义边）；无 digest 分桶的旧布局由 MEMORY.md 挂 depth-1
        memory 文件兜底。"""
        if not _KB_AGENT_RE.match(agent):
            raise HTTPException(status_code=400, detail="非法 agent 名")
        tree = await kb_tree(agent)
        # 8/30 re18（对齐 QwenPaw 最新版图谱模型，ReMe
        # graph_snapshot_step 同款结构）：节点 = digest 三虚拟分类根
        # （wiki/personal/procedure）+ digest/** 全量 md + memory/**
        # 全量 md + 顶层 md（档案）。旧版只取 memory/** + 3 个顶层文件、
        # 漏掉 digest/ → 用户真机「图谱只有几个点」（8/30 实测：
        # daily-sun digest=6 文件全落选；manager 落错工作区=0 节点）。
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

        # 8/30 re18：虚拟分类根（ReMe graph_snapshot_step 同款：
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
            # 5.0.0-beta.2：节点 description（首个非标题/标记行 = 文件
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
            # 5.0.0-beta.2：[[wiki#anchor]] 锚点捕获（移植 QwenPaw
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
                        # 8/30 re18：未解析引用≠虚拟根（前端按 virtual:*
                        # 前缀识别根）——普通灰点、不可点开（文件不存在）。
                        nodes[node_id] = {
                            "id": node_id,
                            "name": node_id.rsplit("/", 1)[-1],
                            "category": "other",
                            "virtual": False,
                            "resolved": False,
                        }
                _add_edge(p, node_id, anc)
        return {
            "agent": agent,
            "nodes": list(nodes.values()),
            "edges": edges,
            "file_count": len(md_files),
        }

    # ── 0.4.99 B1：团队知识库深化（跨 Worker 搜索 + 聚合图谱）──────────

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
        """0.4.99 B1：团队知识全量搜索（跨 Worker）——扫各 Agent 的
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

    @router.get("/kb/graph/merged")
    async def kb_graph_merged(agents: str = "") -> Dict[str, Any]:
        """0.4.99 B1：团队聚合图谱——多 Agent 图谱合并（节点 id=
        agent::path，前端按 agent 着色；边保留在原 Agent 内）。
        agents=逗号分隔（缺省=全部，上限 8）；节点 400 / 边 800 上限。"""
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

    # ── 房间通知（再版 13：通知中心点击跳转=团队房间的 @提到我，
    #    宿主 inbox 事件无 room_id 是「点了不跳」的根因）──────────────

    @router.get("/room-mentions")
    async def room_mentions(limit: int = 30) -> Dict[str, Any]:
        """各房间最近 @提到当前用户 的消息（Element 通知同款语义）：
        0.4.99 B5 = 实时缓冲（sync_watcher /sync 长轮询事件流即时写入，
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
        # ① 实时缓冲（/sync 事件流，房间名从 60s 房间缓存补全）
        with _rooms_cache_lock:
            _rd = (_rooms_cache.get("data") or {}).get("rooms") or []
        room_names: Dict[str, str] = {
            (r.get("room_id") or ""): (r.get("name") or "") for r in _rd
        }
        # 8/29 re16：房间名兜底——同步缓冲的 mention 依赖 _rooms_cache（首次
        # /teams/sync 后才填充）；冷启动时按房间懒加载 m.room.name（永久缓存）。
        names: Dict[str, str] = dict(room_names)

        async def _ensure_room_name(room_id: str) -> str:
            nonlocal names
            if names.get(room_id):
                return names[room_id]
            hs_base = homeserver.rstrip("/")
            try:
                async with httpx.AsyncClient(timeout=8.0, verify=False) as c2:
                    # ① basic info（Tuwunel 实测部分房间 name=None）
                    nm = ""
                    try:
                        nresp = await c2.get(
                            f"{hs_base}/_matrix/client/v3/rooms/{room_id}",
                            headers={"Authorization": f"Bearer {token}"},
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
                                headers={"Authorization": f"Bearer {token}"},
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
            except Exception:  # noqa: BLE001 — 取名失败不阻断
                pass
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
            scan_fresh = (time.time() - _room_mentions_cache["ts"]) < 10.0
            scan_results = _room_mentions_cache["data"] if scan_fresh else None
        if scan_results is None:
            scan_results = []
            try:
                # 8/29 re16：self. 误写修复（build_router 内非类嵌套，无 self）——
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

    # ── 待工具审批请求（v0.5.0-beta.10：通知中心「待审批请求」数据源）────
    # Worker Tool Guard 审批请求不带 @人类 → /room-mentions 捞不到（用户
    # 9/4 真机「需要审批没有提示，只能在聊天群看见」根因）。数据源：
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
            scan_fresh = (time.time() - _room_approvals_cache["ts"]) < 10.0
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

    # ── v0.5.0-beta.11 re7：宿主收件箱审批桥状态（调试/selfcheck 用）──
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
            hs_base = homeserver.rstrip("/")
            nm = ""
            try:
                async with httpx.AsyncClient(timeout=8.0, verify=False) as c2:
                    try:
                        nresp = await c2.get(
                            f"{hs_base}/_matrix/client/v3/rooms/{rid}",
                            headers={"Authorization": f"Bearer {token}"},
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
                                headers={"Authorization": f"Bearer {token}"},
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
        return names

    async def _scan_room_approvals(
        homeserver: str,
        token: str,
        scan_results: List[Dict[str, Any]],
    ) -> None:
        """全量扫描：joined 房间近期消息跑审批状态机（请求入列/命令弹最早
        一条），只留未决。时间升序执行（dir=b 返回新→旧，先 reverse）。"""
        import urllib.parse as _up
        from . import sync_watcher  # noqa: PLC0415

        try:
            async with httpx.AsyncClient(timeout=20.0, verify=False) as client:
                headers = {"Authorization": f"Bearer {token}"}
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

                async def scan(room_id: str) -> None:
                    async with sem:
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
                            pending: List[Dict[str, Any]] = []
                            for e in evs:
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
                            scan_results.extend(pending)
                        except Exception:  # noqa: BLE001 — 单房失败不阻断
                            pass

                await asyncio.gather(*(scan(r) for r in room_ids[:40]))
        except Exception:
            raise

    async def _scan_room_mentions(
        homeserver: str,
        token: str,
        user_id: str,
        localpart: str,
        scan_results: List[Dict[str, Any]],
    ) -> None:
        """0.4.99 B5：房间 @我 全量扫描（从端点拆出，10s 缓存复用）。"""
        import urllib.parse as _up
        try:
            async with httpx.AsyncClient(
                timeout=20.0, verify=False
            ) as client:
                headers = {"Authorization": f"Bearer {token}"}
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

                async def scan(room_id: str) -> None:
                    async with sem:
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
                            for ev in data.get("chunk", []) or []:
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
                                scan_results.append(
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
                        except Exception:  # noqa: BLE001 — 单房失败不阻断
                            pass

                await asyncio.gather(
                    *(scan(rid) for rid in room_ids[:40])
                )
        except HTTPException:
            raise
        except Exception:  # noqa: BLE001
            raise  # 调用方 catch 后仅记日志（实时缓冲不受影响）

    # ── Worker 工具执行安全（8/29 re16：QwenPaw 原生四模式
    #    approval_level 对接，L1 only）──────────────────────────────
    # 链路实测（8/29）：Worker 容器内 qwenpaw app 监听 8088（entrypoint
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
        headers = {"Authorization": f"Bearer {token}"}
        async with _h.AsyncClient(timeout=60.0, verify=False) as client:
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

    @router.get("/approval/list")
    async def approval_list(agent: str = "") -> Dict[str, Any]:
        """各 Worker/Manager 当前 approval_level（只读：archive 直读
        agent.json——与 KB 同通道，零新端点依赖）。
        ?agent=xxx 过滤单个（Worker 管理展开行懒加载用，避免全量扫）。"""
        token, base = _kb_require_token()
        st, data = await _kb_docker(token, base, "/containers/json")
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
            # 8/29 re16 修：此前过滤元组恒含 agentteams-manager →
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

        items: List[Dict[str, Any]] = []
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
        for c in containers:
            name = (c.get("Names") or [""])[0].lstrip("/")
            state = c.get("State") or ""
            if name == "agentteams-manager" and "manager" not in seen:
                seen.add("manager")
                items.append(await _one("manager", name, "manager", state))
            elif name.startswith("agentteams-worker-"):
                wn = name[len("agentteams-worker-"):]
                if wn and wn not in seen:
                    seen.add(wn)
                    items.append(await _one(wn, name, "worker", state))
        items.sort(key=lambda x: (x["kind"] != "worker", x["agent"]))
        return {"items": items, "levels": list(_APPROVAL_LEVELS)}

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
        if level not in _APPROVAL_LEVELS:
            raise HTTPException(
                status_code=400,
                detail=f"level 必须是 {_APPROVAL_LEVELS} 之一",
            )
        container = _approval_container_of(agent)
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

        body = None
        if request.method in ("POST", "PUT"):
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
        for base in base_urls:
            url = f"{base.rstrip('/')}{encoded_path}{query_string}"
            try:
                # v0.4.92（再版）：连接类错误同址重试一次（300ms 退避）——
                # 切网瞬间/偶发抖动不应直接放弃该地址（用户「连通失败重试」）。
                # 只重试传输层错误；已拿到 HTTP 响应（含 5xx）的不重试。
                resp = None
                for attempt in (1, 2):
                    try:
                        req_started = time.time()
                        async with httpx.AsyncClient(
                            timeout=_PROBE_TIMEOUT, verify=False
                        ) as client:
                            resp = await client.request(
                                request.method, url, json=body, headers=headers
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
            except Exception as exc:  # noqa: BLE001 - try the next address
                last_error = selfcheck._classify_error(exc)
                logger.warning(
                    "proxy %s %s failed via %s: %s",
                    target,
                    full_path,
                    base,
                    last_error,
                )
        raise HTTPException(
            status_code=502, detail=f"所有地址请求失败：{last_error}"
        )

    return router
