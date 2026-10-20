# -*- coding: utf-8 -*-
"""Address-entry parsing, credential helpers, defaults, redaction.

Pure helpers extracted from config.py - no module state of their own.
config.py keeps the on-disk state and the load/save/update core, and
re-exports everything defined here so existing import paths are
unchanged.
"""
from __future__ import annotations

import base64
import hashlib
import json
from typing import Any, Dict, List, Optional, Union

# 地址条目 = 字符串（服务原生认证，
# 内网默认形态）或 {url, auth?}（显式覆盖凭据）。auth 类型：
# {"type": "basic", "username": ..., "password": ...} —— 网关 Basic 门
# {"type": "bearer", "token": ...} —— API key / 专用
# 无 auth = 用服务自身认证（controller token / matrix token / SGLang 无）。
# 单一出处：所有拨号点经 address_url()/auth_for_url()/headers_with_auth()
# 解析，不各写各的（逐个修补防护——新增拨号点只调 helper）。
AddressEntry = Union[str, Dict[str, Any]]


# ── 地址条目（str | {url, auth?}）解析与凭据 helper ──

_AUTH_TYPES = ("basic", "bearer")


def address_url(entry: Any) -> str:
    """地址条目 → URL 字符串（str 原样；dict 取 .url；其他 → ""）。"""
    if isinstance(entry, str):
        return entry.strip()
    if isinstance(entry, dict):
        return str(entry.get("url") or "").strip()
    return ""


def _normalize_auth(raw: Any) -> Optional[Dict[str, str]]:
    """校验并归一化 auth 块；无效/缺凭据 → None（= 用服务原生认证）。

 basic 需 username+password；bearer 需 token。空串凭据视为未填。
 """
    if not isinstance(raw, dict):
        return None
    atype = str(raw.get("type") or "").strip().lower()
    if atype == "basic":
        u = str(raw.get("username") or "").strip()
        p = str(raw.get("password") or "").strip()
        if not (u and p and p != "***"):
            return None
        return {"type": "basic", "username": u, "password": p}
    if atype == "bearer":
        t = str(raw.get("token") or "").strip()
        if not t or t == "***":
            return None
        return {"type": "bearer", "token": t}
    return None


def auth_for_url(entries: Any, url: str) -> Optional[Dict[str, str]]:
    """该 URL 对应的覆盖凭据（无/无效 → None）。

 url 匹配口径 = rstrip("/") 后精确相等（配置里的 url 可能带尾斜杠，
 拨号点也统一 rstrip 后再查——两侧同口径防不命中）。
 """
    target = url.rstrip("/")
    for entry in entries or []:
        if address_url(entry) and address_url(entry).rstrip("/") == target:
            return _normalize_auth((entry or {}).get("auth") if isinstance(entry, dict) else None)
    return None


def build_auth_map(entries: Any) -> Dict[str, Dict[str, str]]:
    """地址条目列表 → {url(rstrip 归一): 有效 auth}（无效/无凭据的条目不进表）。"""
    out: Dict[str, Dict[str, str]] = {}
    for entry in entries or []:
        u = address_url(entry)
        if not u or not isinstance(entry, dict):
            continue
        auth = _normalize_auth(entry.get("auth"))
        if auth:
            out[u.rstrip("/")] = auth
    return out


def headers_with_auth(auth: Optional[Dict[str, str]], headers: Dict[str, str]) -> Dict[str, str]:
    """应用覆盖凭据（无 auth/无效 → 原样返回 base headers）。

 只动 Authorization 一个头：basic → `Basic base64(u:p)` 整体替换；
 bearer → `Bearer <token>` 整体替换。不改写其他头。
 """
    if not auth:
        return headers
    out = dict(headers)
    if auth.get("type") == "basic":
        raw = f"{auth.get('username', '')}:{auth.get('password', '')}".encode("utf-8")
        out["Authorization"] = "Basic " + base64.b64encode(raw).decode("ascii")
    elif auth.get("type") == "bearer":
        out["Authorization"] = f"Bearer {auth.get('token', '')}"
    return out


def merge_address_entries(
    old_entries: Any, new_entries: Any
) -> List[AddressEntry]:
    """PUT /config 的地址列表合并（按位置配对，保留旧秘密）。

 规则（与 controller_token 的 "***" 占位符语义同源）：
 - 新条目=字符串 → 原样（显式降级：旧凭据丢弃）。
 - 新条目=dict：
 - auth 缺省/type=none → 字符串条目（显式清除凭据）。
 - 凭据字段空串或 "***" → 继承旧条目同名字段（脱敏回传=保持不变）。
 - url 为空 → 丢弃该条目（与旧 filter(v=>v.trim()) 行为一致）。
 - 旧列表更长的尾部条目 → 丢弃（前端始终提交完整两行）。
 """
    merged: List[AddressEntry] = []
    old_list = list(old_entries or [])
    for i, entry in enumerate(new_entries or []):
        if isinstance(entry, str):
            u = entry.strip()
            if u:
                merged.append(u)
            continue
        if not isinstance(entry, dict):
            continue
        u = str(entry.get("url") or "").strip()
        if not u:
            continue
        old_entry = old_list[i] if i < len(old_list) else None
        old_auth = (
            _normalize_auth((old_entry or {}).get("auth"))
            if isinstance(old_entry, dict)
            else None
        ) or {}
        auth_in = entry.get("auth")
        if not isinstance(auth_in, dict) or str(auth_in.get("type") or "").strip().lower() in ("", "none"):
            merged.append(u)
            continue
        atype = str(auth_in.get("type") or "").strip().lower()
        if atype == "basic":
            username = str(auth_in.get("username") or "").strip() or str(old_auth.get("username") or "")
            password = str(auth_in.get("password") or "").strip()
            if not password or password == "***":
                password = str(old_auth.get("password") or "")
            if username and password and password != "***":
                merged.append({"url": u, "auth": {"type": "basic", "username": username, "password": password}})
            else:
                merged.append(u)
        elif atype == "bearer":
            token = str(auth_in.get("token") or "").strip()
            if not token or token == "***":
                token = str(old_auth.get("token") or "")
            if token and token != "***":
                merged.append({"url": u, "auth": {"type": "bearer", "token": token}})
            else:
                merged.append(u)
        else:
            merged.append(u)
    return merged

def credential_gaps(
    old_entries: Any, new_entries: Any
) -> List[Dict[str, Any]]:
    """保存前凭据意图检查（）。

 找出「用户明确选择覆盖凭据（basic/bearer）但凭据字段为空、且旧条目
 在同位置没有可继承的凭据」的条目——按 merge_address_entries 的继承
 规则，这种条目会**静默降级为无凭据字符串条目**（网关门 → 401），
 而保存响应仍报成功。现由调用方在保存前拦截/保存后显形，杜绝
 「显示已保存、实际没凭据」的糊涂态。

 返回缺失清单：[{"index": i, "type": "basic"|"bearer", "username": ...}]
 （username 仅 basic 且已填时给出，供错误文案定位）。
 与 merge_address_entries 的配对口径完全一致（按位置配对；旧列表更短
 的尾部位置=无旧凭据）。
 """
    gaps: List[Dict[str, Any]] = []
    old_list = list(old_entries or [])
    for i, entry in enumerate(new_entries or []):
        if not isinstance(entry, dict):
            continue
        auth_in = entry.get("auth")
        if not isinstance(auth_in, dict):
            continue
        atype = str(auth_in.get("type") or "").strip().lower()
        if atype not in ("basic", "bearer"):
            continue  # none/缺省=显式清除，无继承语义
        old_entry = old_list[i] if i < len(old_list) else None
        old_auth = (
            _normalize_auth((old_entry or {}).get("auth"))
            if isinstance(old_entry, dict)
            else None
        )
        # 继承只认**同类型**旧凭据（merge_address_entries 的字段口径：
        # basic 继承 username/password，bearer 继承 token；类型不同=
        # 无字段可继承 → 静默降级 str 条目，同缺口）。
        if old_auth and old_auth.get("type") != atype:
            old_auth = None
        if atype == "basic":
            username = str(auth_in.get("username") or "").strip()
            password = str(auth_in.get("password") or "").strip()
            # 空/"***" = 走继承；旧凭据也在 = 继承成功（无缺口）。
            if (not password or password == "***") and not old_auth:
                gaps.append({"index": i, "type": "basic",
                             "username": username})
        else:
            token = str(auth_in.get("token") or "").strip()
            if (not token or token == "***") and not old_auth:
                gaps.append({"index": i, "type": "bearer"})
    return gaps


def persisted_credential_kinds(entries: Any) -> List[str]:
    """地址列表 → 逐位置凭据形态（回读校验用）：
 "str"=无凭据 / "basic" / "bearer"。口径=redact 后前端可见的结构
 （凭据值已脱敏，但条目形态与 auth 类型保留）。"""
    out: List[str] = []
    for entry in entries or []:
        if isinstance(entry, dict):
            auth = _normalize_auth(entry.get("auth"))
            out.append(auth.get("type") if auth else "str")
        else:
            out.append("str")
    return out


_DEFAULTS: Dict[str, Any] = {
    # Ordered address lists — first reachable wins (auto-failover).
    "matrix_homeservers": [],  # e.g. ["http://10.0.0.10:6867", "https://agentteams.example.com:6867"]
    "controller_urls": [],  # e.g. ["http://10.0.0.10:8090"]
    # Optional admin token for L1 full view (same token on both paths).
    "controller_token": "",
    # L1 管理员验证二选一（同 dashboard 语义，仅 L1）——
    # ① admin 账号+密码：POST {gateway_admin_url}/session/login 验证，
    # 成功后持有 Console 管理员会话（console_session），供网关面
    # （AI routes/providers = 模型选择 alias 层数据源）消费。
    # ② controller_token（上）：Controller 管理 API 全量（现状）。
    "admin_username": "",
    "admin_password": "",
    # Higress Console（管理面）地址。**必填**（设计）：
    # 留空 = 验证时报可操作错误——不从 Controller 地址推导、不盲探端口
    # （宿主端口是安装时自选的，AGENTTEAMS_PORT_CONSOLE 默认 18001）。
    # Higress Console 双地址（canonical；legacy 单值键保留为
    # urls[0] 镜像，老读者兼容）。条目不限 2 个，按序降级。
    "gateway_admin_urls": [],
    "gateway_admin_url": "",
    # 控制台特效安抚——停用上游 RunningGlow
    # 旋转光环/呼吸层的动画（保留光效视觉）。默认开（省 GPU）；可关。
    # 保留为兼容键（新键 console_effects
    # 三档取代其功能；load 迁移时以其值推导 console_effects 初值，
    # 之后不再读写，老配置/老读者兼容）。
    "console_calm": True,
    # 控制台特效三档——
    # "light"（默认：动画保留、模糊半径封顶 6px）/ "off"（动画与模糊全停，
    # 等价旧 console_calm 开启）/ "full"（上游原样，零覆盖）。
    "console_effects": "light",
    # Console 管理员会话 cookie（session/login 成功后的 Set-Cookie 值，
    # 服务端自持，redact 脱敏，永不进前端可见明文）。
    "console_session": "",
    # 可选模块：集群负载监控（L1 专属——不是每个部署都有本地 SGLang）。
    # enabled=false 时前端不渲染卡片、后端不注册语义（404），零痕迹。
    # 双地址（内网/外网）——有序数组，首个可达 + failover，
    # 与 matrix_homeservers/controller_urls 同构；旧版单地址 "url" 自动迁移。
    "sglang": {
        "enabled": False,
        "urls": [],  # e.g. ["http://192.168.x.x:30000", "https://你的域名:30000"]
    },
    # 地址手动固定档（"auto"=自动切换[默认] /
    # "lan"=固定内网[列表索引 0] / "wan"=固定外网[索引 1]）——固定档失败
    # 诚实报错不 failover，探测循环照跑只供显示。
    "address_mode": "auto",
    "matrix": {
        "user_id": "",
        "access_token": "",
        "device_id": "",
    },
}


def _hash_export_password(password: str, salt: str) -> str:
    """salted SHA-256（salt:password）——本地门控强度足够（单用户、非
 高并发撞库场景），不落明文。"""
    return hashlib.sha256(
        (salt + ":" + password).encode("utf-8"),
    ).hexdigest()


def _redact_entry_list(entries: Any) -> None:
    """地址条目内的 auth 秘密脱敏（username 保留——非机密，前端回显）。"""
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        auth = entry.get("auth")
        if not isinstance(auth, dict):
            continue
        if auth.get("password"):
            auth["password"] = "***"
        if auth.get("token"):
            auth["token"] = "***"


def credential_state(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """逐条凭据存在态（UI 自证显形用，取值只看有无不看值）。

    saved=完整凭据在 / username-only=只存了用户名（密码缺失——
    显示必须与 saved 区分开，「看起来有其实没存」是 basic 密码
    「要重新填」类投诉的观感根源）/ none=裸 URL 或无 auth。
    在 redact 之前对原始内存态计算（脱敏副本上算不出有无）。
    """
    def _entry_state(e: Any) -> str:
        if not isinstance(e, dict):
            return "none"
        a = e.get("auth")
        if not isinstance(a, dict):
            return "none"
        t = str(a.get("type") or "").strip().lower()
        if t == "basic":
            user = str(a.get("username") or "").strip()
            pw = str(a.get("password") or "").strip()
            if user and pw:
                return "saved"
            return "username-only" if user else "none"
        if t == "bearer":
            return "saved" if str(a.get("token") or "").strip() else "none"
        return "none"

    out: Dict[str, Any] = {
        key: [_entry_state(e) for e in cfg.get(key) or []]
        for key in ("matrix_homeservers", "controller_urls",
                    "gateway_admin_urls")
    }
    sg = cfg.get("sglang")
    out["sglang_urls"] = [
        _entry_state(e) for e in ((sg or {}).get("urls") or [])
    ]
    out["admin_password"] = (
        "saved" if str(cfg.get("admin_password") or "").strip() else "none"
    )
    return out


def redact(config: Dict[str, Any]) -> Dict[str, Any]:
    """Config safe to send back to the frontend (no secrets)."""
    out = json.loads(json.dumps(config))
    if out.get("controller_token"):
        out["controller_token"] = "***"
    # 地址条目内凭据（basic password / bearer token）。
    # gateway 双地址条目同语义（防 GET /config 泄露）。
    for key in ("matrix_homeservers", "controller_urls", "gateway_admin_urls"):
        _redact_entry_list(out.get(key))
    sg = out.get("sglang")
    if isinstance(sg, dict):
        _redact_entry_list(sg.get("urls"))
    # L1 管理员凭据：密码与 Console 会话脱敏；用户名保留（非机密，前端回显）。
    if out.get("admin_password"):
        out["admin_password"] = "***"
    if out.get("console_session"):
        out["console_session"] = "***"
    matrix = out.get("matrix") or {}
    if matrix.get("access_token"):
        matrix["access_token"] = "***"
    return out
