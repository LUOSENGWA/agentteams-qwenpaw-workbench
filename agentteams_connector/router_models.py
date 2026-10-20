# -*- coding: utf-8 -*-
"""路由域 Pydantic 请求模型 + 配置导入校验 + token 解析（纯模块）。

自 router.py 逐字搬移（模块级 def/class，无缩进变化）：7 个请求模型
+ /config/import schema 级校验常量与函数 + controller token 解析族 +
网关 alias 计数。无模块级可变状态、不 import router（无循环依赖）；
router.py 以 re-export 壳保持原路径可达。
"""
from __future__ import annotations

import os
import re
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


def _count_gateway_aliases(
    routes_body: object, providers_body: object
) -> tuple[int, list[str]]:
    """验证回报——网关 alias 层自检计数。

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
    # 并发写保护：页面加载时的配置修订号（GET /config 的 config_rev）——
    # 保存时若磁盘配置已被外部改动（另一 tab/手工编辑/导入/自愈恢复），
    # PUT 返回 409 而非静默覆盖新值。旧前端不传=跳过校验（向后兼容）。
    config_rev: Optional[str] = None
    # 显式恢复通道：配置处于损坏态（defaults-fallback）时，普通保存被
    # 防呆守卫拦下（防全默认值盖掉损坏现场）；用户在健康横幅警示下
    # 确认用表单值重建文件 → 前端带 force_persist=True 放行。
    force_persist: bool = False


class ConfigTestRequest(BaseModel):
    """连通性测试请求——传表单当前值（可未保存），空则测已配置。

 条目 = str | {url, auth?}（草稿凭据随测——未保存的
 公网凭据也能当场验证；旧字符串条目完全兼容）。
 """

    matrix: Optional[List[Any]] = None
    controller: Optional[List[Any]] = None
    sglang: Optional[List[Any]] = None  # SGLang 双地址列表
    gateway: Optional[List[Any]] = None  # Higress 双地址列表


class VerifyAdminRequest(BaseModel):
    """L1 管理员验证二选一（同 dashboard 语义，仅 L1 使用）。

 两条路径（互斥，优先密码）：
 - admin_username + admin_password → POST {gateway}/session/login
 （Console 单操作员登录；成功 → 持有 Console 管理员会话，
 供网关面 AI routes/providers 消费 = 模型选择 alias 层数据源）。
 - controller_token → GET {controller}/api/v1/teams Bearer（
 去尾斜杠——Controller 的 Gin 对 /api/v1/teams/ 返回 404，与
 dashboard f1f2 同款坑；无斜杠才进鉴权门，401=token 无效）
 （现状 L1 全量 Controller 管理 API 凭据，语义不变）。
 """

    admin_username: Optional[str] = None
    admin_password: Optional[str] = None  # "***" = 用已存值（脱敏占位符语义）
    controller_token: Optional[str] = None  # "***" = 用已存值
    # 留空 = 回退 config 已存值；config 也空 → 可操作错误（
    # Console 宿主端口部署时自选、人人不同，不做端口探测）
    gateway_admin_url: Optional[str] = None
    # Higress 双地址（列表优先；单项亦可）。
    gateway_admin_urls: Optional[List[str]] = None


# ── /config/import schema 级校验 ──────────

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
    """Controller admin token 解析（设计，「controller
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

 修复（历史缺陷：团队管理页 HTTP 500）：此函数此前
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
