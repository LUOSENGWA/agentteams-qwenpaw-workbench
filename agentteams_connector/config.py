# -*- coding: utf-8 -*-
"""User-level plugin configuration.

Config is stored on the user's machine under
``SECRET_DIR/agentteams-qwenpaw-workbench/config.json`` (SECRET_DIR comes from
``qwenpaw.constant``).

Address model (auto-failover): the Matrix homeserver and Controller are the
SAME backend reached through different network paths (e.g. LAN IP at home,
reverse-proxy domain outside). Both paths share one Matrix token, so the
backend simply probes the list in order and caches whichever answers.
No manual profile switching.
"""

from __future__ import annotations

import base64
import json
import logging
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

# v0.5.0-beta.14.3（WAN 通用认证）：地址条目 = 字符串（服务原生认证，
# 内网默认形态）或 {url, auth?}（显式覆盖凭据）。auth 类型：
# {"type": "basic", "username": ..., "password": ...} —— 网关 Basic 门
# {"type": "bearer", "token": ...} —— API key / 专用
# 无 auth = 用服务自身认证（controller token / matrix token / SGLang 无）。
# 单一出处：所有拨号点经 address_url()/auth_for_url()/headers_with_auth()
# 解析，不各写各的（逐个修补防护——新增拨号点只调 helper）。
AddressEntry = Union[str, Dict[str, Any]]

try:  # pragma: no cover - exercised inside QwenPaw at runtime
    from qwenpaw.constant import SECRET_DIR as _SECRET_DIR
except Exception:  # noqa: BLE001 - allow import in isolation for linting
    _SECRET_DIR = Path.home() / ".qwenpaw" / "secret"

_CONFIG_DIR = Path(_SECRET_DIR) / "agentteams-qwenpaw-workbench"
_CONFIG_PATH = _CONFIG_DIR / "config.json"

_lock = threading.Lock()

logger = logging.getLogger("qwenpaw.plugins.agentteams_qwenpaw_workbench")

# ── v0.5.0-beta.14.3: 地址条目（str | {url, auth?}）解析与凭据 helper ──

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

_DEFAULTS: Dict[str, Any] = {
    # Ordered address lists — first reachable wins (auto-failover).
    "matrix_homeservers": [],  # e.g. ["http://10.0.0.10:6867", "https://agentteams.example.com:6867"]
    "controller_urls": [],  # e.g. ["http://10.0.0.10:8090"]
    # Optional admin token for L1 full view (same token on both paths).
    "controller_token": "",
    # v0.5.0-beta.12: L1 管理员验证二选一（同 dashboard 语义，仅 L1）——
    # ① admin 账号+密码：POST {gateway_admin_url}/session/login 验证，
    # 成功后持有 Console 管理员会话（console_session），供网关面
    # （AI routes/providers = 模型选择 alias 层数据源）消费。
    # ② controller_token（上）：Controller 管理 API 全量（现状）。
    "admin_username": "",
    "admin_password": "",
    # Higress Console（管理面）地址。**必填**（v0.5.0-beta.12 设计）：
    # 留空 = 验证时报可操作错误——不从 Controller 地址推导、不盲探端口
    # （宿主端口是安装时自选的，AGENTTEAMS_PORT_CONSOLE 默认 18001）。
    # v0.5.0-beta.14.7: Higress Console 双地址（canonical；legacy 单值键保留为
    # urls[0] 镜像，老读者兼容）。条目不限 2 个，按序降级。
    "gateway_admin_urls": [],
    "gateway_admin_url": "",
    # v0.5.0-beta.14.8：控制台特效安抚——停用上游 RunningGlow
    # 旋转光环/呼吸层的动画（保留光效视觉）。默认开（省 GPU）；可关。
    # v0.5.0-beta.14.12：保留为兼容键（新键 console_effects
    # 三档取代其功能；load 迁移时以其值推导 console_effects 初值，
    # 之后不再读写，老配置/老读者兼容）。
    "console_calm": True,
    # v0.5.0-beta.14.12：控制台特效三档——
    # "light"（默认：动画保留、模糊半径封顶 6px）/ "off"（动画与模糊全停，
    # 等价旧 console_calm 开启）/ "full"（上游原样，零覆盖）。
    "console_effects": "light",
    # Console 管理员会话 cookie（session/login 成功后的 Set-Cookie 值，
    # 服务端自持，redact 脱敏，永不进前端可见明文）。
    "console_session": "",
    # 可选模块：集群负载监控（L1 专属——不是每个部署都有本地 SGLang）。
    # enabled=false 时前端不渲染卡片、后端不注册语义（404），零痕迹。
    # v0.5.0-beta.12: 双地址（内网/外网）——有序数组，首个可达 + failover，
    # 与 matrix_homeservers/controller_urls 同构；旧版单地址 "url" 自动迁移。
    "sglang": {
        "enabled": False,
        "urls": [],  # e.g. ["http://192.168.x.x:30000", "https://你的域名:30000"]
    },
    # v0.5.0-beta.14.1: 地址手动固定档（"auto"=自动切换[默认] /
    # "lan"=固定内网[列表索引 0] / "wan"=固定外网[索引 1]）——固定档失败
    # 诚实报错不 failover，探测循环照跑只供显示。
    "address_mode": "auto",
    "matrix": {
        "user_id": "",
        "access_token": "",
        "device_id": "",
    },
}


def _ensure_dir() -> None:
    """v0.5.0-beta.14.7（安全）：目录 700（内含明文凭据的 config）。"""
    import os as _os

    _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    try:
        _os.chmod(_CONFIG_DIR, 0o700)
    except Exception:  # noqa: BLE001
        pass


def _config_bak_path() -> Path:
    """v0.5.0-beta.14.14：备份文件路径——从 _CONFIG_PATH 派生
 （config.json 旁的 config.bak.json；测试 monkeypatch 主文件路径时自动
 跟随，零额外注入点）。"""
    return _CONFIG_PATH.with_name("config.bak.json")


def _atomic_write_config(path: Path, data: Dict[str, Any]) -> None:
    """原子落盘（tmp + os.replace + chmod 600）——保存与备份恢复共用。

 失败抛 IOError（调用方定语义：save → 报错给端点；恢复 → 放弃回退默认）。
 """
    import os as _os

    _ensure_dir()
    tmp = path.with_name(path.name + ".tmp")
    try:
        tmp.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        tmp.replace(path)
        # v0.5.0-beta.14.7（安全）：文件含明文凭据（Basic 密码等）——收紧到
        # 600（best-effort，失败不影响功能）。
        try:
            _os.chmod(path, 0o600)
        except Exception:  # noqa: BLE001
            pass
    except Exception as exc:  # noqa: BLE001
        raise IOError(f"配置写入失败：{exc}") from exc


def write_backup(snapshot: Dict[str, Any]) -> None:
    """v0.5.0-beta.14.14：原子写 config.bak.json 快照。

 失败抛 IOError——调用方决定：save 路径仅告警（主文件已验证落盘，不
 拖累保存）；导入路径 = 中止不覆盖（「先备份再覆盖」安全契约）。
 """
    _atomic_write_config(_config_bak_path(), snapshot)


def _restore_from_backup() -> Optional[Dict[str, Any]]:
    """v0.5.0-beta.14.14：自愈——主配置缺失/损坏 → 从
 config.bak.json 恢复（原子写回主文件 + 日志明示）。

 无备份/备份损坏/写回失败 → None（调用方回默认值，不崩）。
 """
    bak = _config_bak_path()
    try:
        data = json.loads(bak.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError) as exc:
        logger.warning(
            "config self-heal: backup %s unavailable (%s: %s) — falling back to defaults",
            bak,
            type(exc).__name__,
            exc,
        )
        return None
    if not isinstance(data, dict):
        logger.warning(
            "config self-heal: backup %s is not a JSON object — falling back to defaults",
            bak,
        )
        return None
    try:
        _atomic_write_config(_CONFIG_PATH, data)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "config self-heal: restore write failed: %s — falling back to defaults",
            exc,
        )
        return None
    logger.warning(
        "config self-heal: main config missing or corrupt — restored from %s",
        bak,
    )
    return data


def load_config() -> Dict[str, Any]:
    """Load the config, merging with defaults for missing keys."""
    with _lock:
        try:
            raw = json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                raise ValueError("top-level JSON must be an object")
        except (FileNotFoundError, json.JSONDecodeError, ValueError, OSError):
            # v0.5.0-beta.14.14：自愈——主文件缺失/损坏
            # （含顶层非对象）→ 自动从备份恢复（日志明示）；无可用备份
            # → 默认值（不崩）。
            restored = _restore_from_backup()
            if restored is not None:
                raw = restored
            else:
                return json.loads(json.dumps(_DEFAULTS))

        # v0.5.0-beta.14.7（安全）：存量 644 → 600 兜底（一次性收敛）。
        try:
            import os as _os

            _os.chmod(_CONFIG_PATH, 0o600)
        except Exception:  # noqa: BLE001
            pass

        merged = json.loads(json.dumps(_DEFAULTS))
        # New schema keys
        for key in (
            "matrix_homeservers",
            "controller_urls",
            "controller_token",
            "admin_username",
            "admin_password",
            # v0.5.0-beta.14.7: 双地址 canonical 列表（不加则落盘值重载时被丢）。
            "gateway_admin_urls",
            "gateway_admin_url",
            # v0.5.0-beta.14.8：控制台特效安抚（bool，落盘值须重载保留）。
            "console_calm",
            # v0.5.0-beta.14.12：控制台特效三档（落盘值须重载保留）。
            "console_effects",
            "console_session",
            "sglang",
            "matrix",
            "address_mode",
        ):
            if key in raw and raw[key] is not None:
                merged[key] = raw[key]
        # v0.5.0-beta.14.1: 旧配置垃圾值降级 auto（不 400 不崩）。
        if merged.get("address_mode") not in ("auto", "lan", "wan"):
            merged["address_mode"] = "auto"
        # v0.5.0-beta.14.12：console_effects 迁移——
        # 落盘缺省（老配置无此键）或非法值 → 按 console_calm 推导：
        # console_calm is False（用户曾选"完整特效"语义）→ "full"，否则
        # "light"（不 400 不崩，与 address_mode 降级先例一致）。
        _raw_fx = raw.get("console_effects")
        if _raw_fx is None or _raw_fx not in ("light", "off", "full"):
            merged["console_effects"] = (
                "full" if raw.get("console_calm") is False else "light"
            )
        # v0.5.0-beta.14.7: gateway 双地址——legacy 单值 → 列表（空列表时）；
        # 列表非空时 legacy 键镜像 urls[0]（老读者兼容）。
        if not merged.get("gateway_admin_urls"):
            legacy_gw = str(merged.get("gateway_admin_url") or "").strip()
            if legacy_gw:
                merged["gateway_admin_urls"] = [legacy_gw]
        elif merged.get("gateway_admin_urls"):
            merged["gateway_admin_url"] = (
                address_url(merged["gateway_admin_urls"][0]) or ""
            )
        # Legacy schema migration (v0.1.0 profiles) → auto-failover lists.
        if not merged["matrix_homeservers"] and isinstance(raw.get("profiles"), dict):
            homeservers: List[str] = []
            controller_urls: List[str] = []
            token = ""
            for name in ("home", "remote"):
                profile = raw["profiles"].get(name) or {}
                hs = (profile.get("matrix_homeserver") or "").strip()
                cu = (profile.get("controller_url") or "").strip()
                if hs and hs not in homeservers:
                    homeservers.append(hs)
                if cu and cu not in controller_urls:
                    controller_urls.append(cu)
                if not token and (profile.get("controller_token") or "").strip():
                    token = profile["controller_token"].strip()
            merged["matrix_homeservers"] = homeservers
            merged["controller_urls"] = controller_urls
            if token:
                merged["controller_token"] = token
        # v0.5.0-beta.12: sglang 旧版单地址 "url" → 双地址 "urls"（存量配置自动迁移）。
        # 迁移后 pop 旧键——否则旧 url 会作为第三个 failover 候选混入请求链。
        sg = merged.get("sglang")
        if isinstance(sg, dict) and not sg.get("urls"):
            legacy = str(sg.get("url") or "").strip()
            if legacy:
                sg["urls"] = [legacy]
            sg.pop("url", None)
        return merged


def save_config(config: Dict[str, Any], refresh_backup: bool = True) -> None:
    """Persist the full config (caller is responsible for shape).

 v0.5.0-beta.14.14：成功保存后自动原子刷新 config.bak.json
 ——下次加载主文件丢失/损坏时从中自愈（见 load_config/_restore_from_backup）。
 备份失败仅告警（主文件已验证落盘，不拖累保存）；refresh_backup=False 供
 导入路径（导入前先手工备份覆盖前状态，覆盖后备份保持为恢复点，不被新值
 顶掉）。
 """
    with _lock:
        try:
            _atomic_write_config(_CONFIG_PATH, config)
            # v0.5.0-beta.14.12：写后回读验证（小文件，成本可忽略）
            # ——「保存成功」必须以磁盘实况为准，读回不一致直接抛错（由端点
            # 转 500 详情）。
            _back = json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
            if _back != config:
                raise IOError("配置写盘校验不一致（磁盘内容与内存态不同）")
        except Exception as exc:  # noqa: BLE001
            raise IOError(f"配置写入失败：{exc}") from exc
        if refresh_backup:
            try:
                write_backup(config)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "config backup refresh failed (main config saved OK): %s",
                    exc,
                )


def update_config(patch: Dict[str, Any]) -> Dict[str, Any]:
    """Apply a shallow patch and persist. Returns the merged config."""
    merged = load_config()
    # v0.5.0-beta.14.3: 地址条目 str | {url, auth?}——按位置合并（保留旧秘密）。
    for key in ("matrix_homeservers", "controller_urls"):
        if key in patch and isinstance(patch[key], list):
            merged[key] = merge_address_entries(merged.get(key), patch[key])
    if "controller_token" in patch and isinstance(patch["controller_token"], str):
        tok = patch["controller_token"].strip()
        # "***" 是脱敏占位符（导出再导入场景）——不覆盖真实 token。
        if tok and tok != "***":
            merged["controller_token"] = tok
    # v0.5.0-beta.12: L1 管理员验证字段（同 token 的脱敏占位符语义）。
    for key in ("admin_username", "admin_password", "gateway_admin_url", "console_session"):
        if key in patch and isinstance(patch[key], str):
            val = patch[key].strip()
            if val and val != "***":
                merged[key] = val
    # v0.5.0-beta.14.7: gateway 双地址（同 matrix/controller 的位置合并语义）；
    # legacy 单值仍可写（同步为单元素列表）。
    if "gateway_admin_urls" in patch and isinstance(patch["gateway_admin_urls"], list):
        merged["gateway_admin_urls"] = merge_address_entries(
            merged.get("gateway_admin_urls"), patch["gateway_admin_urls"]
        )
    if (
        "gateway_admin_url" in patch
        and isinstance(patch["gateway_admin_url"], str)
        and patch["gateway_admin_url"].strip()
        and patch["gateway_admin_url"].strip() != "***"
        and not patch.get("gateway_admin_urls")
    ):
        merged["gateway_admin_urls"] = [patch["gateway_admin_url"].strip()]
    # v0.5.0-beta.14.8：console_calm 直存（bool，非法忽略）。
    if isinstance(patch.get("console_calm"), bool):
        merged["console_calm"] = patch["console_calm"]
    # v0.5.0-beta.14.12：console_effects 三档直存
    # （非 {light, off, full} 的字符串/类型一律忽略，不 400）。
    if (
        isinstance(patch.get("console_effects"), str)
        and patch["console_effects"] in ("light", "off", "full")
    ):
        merged["console_effects"] = patch["console_effects"]
    # v0.5.0-beta.14.1: 地址模式（无效值归 auto；空串不动）。
    if "address_mode" in patch and isinstance(patch["address_mode"], str):
        val = patch["address_mode"].strip()
        if val:
            merged["address_mode"] = val if val in ("auto", "lan", "wan") else "auto"
    if "sglang" in patch and isinstance(patch["sglang"], dict):
        existing = merged.get("sglang") or {}
        incoming = dict(patch["sglang"])
        # v0.5.0-beta.12: 双地址列表；兼容旧前端/旧配置的单地址 "url"。
        # v0.5.0-beta.14.3: 条目 str | {url, auth?}（同 matrix/controller 合并语义）。
        if "urls" in incoming and isinstance(incoming["urls"], list):
            incoming["urls"] = merge_address_entries(
                (existing.get("urls") if isinstance(existing.get("urls"), list) else []),
                incoming["urls"],
            )
        if "url" in incoming:
            legacy_url = str(incoming.pop("url") or "").strip()
            if legacy_url:
                if not incoming.get("urls"):
                    incoming["urls"] = [legacy_url]
            elif "urls" not in incoming:
                # 旧前端传空 url = 清空地址（不清会残留旧值）。
                incoming["urls"] = []
        existing.update(incoming)
        merged["sglang"] = existing
    if "matrix" in patch and isinstance(patch["matrix"], dict):
        existing = merged.get("matrix") or {}
        incoming = dict(patch["matrix"])
        if incoming.get("access_token") == "***":
            incoming.pop("access_token", None)
        existing.update(incoming)
        merged["matrix"] = existing
    save_config(merged)
    return merged


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


def redact(config: Dict[str, Any]) -> Dict[str, Any]:
    """Config safe to send back to the frontend (no secrets)."""
    out = json.loads(json.dumps(config))
    if out.get("controller_token"):
        out["controller_token"] = "***"
    # v0.5.0-beta.14.3: 地址条目内凭据（basic password / bearer token）。
    # v0.5.0-beta.14.7: gateway 双地址条目同语义（防 GET /config 泄露）。
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
