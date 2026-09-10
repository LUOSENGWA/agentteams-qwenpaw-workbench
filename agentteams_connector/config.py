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

import json
import threading
from pathlib import Path
from typing import Any, Dict, List

try:  # pragma: no cover - exercised inside QwenPaw at runtime
    from qwenpaw.constant import SECRET_DIR as _SECRET_DIR
except Exception:  # noqa: BLE001 - allow import in isolation for linting
    _SECRET_DIR = Path.home() / ".qwenpaw" / "secret"

_CONFIG_DIR = Path(_SECRET_DIR) / "agentteams-qwenpaw-workbench"
_CONFIG_PATH = _CONFIG_DIR / "config.json"

_lock = threading.Lock()

_DEFAULTS: Dict[str, Any] = {
    # Ordered address lists — first reachable wins (auto-failover).
    "matrix_homeservers": [],  # e.g. ["http://10.0.0.10:6867", "https://agentteams.example.com:6867"]
    "controller_urls": [],  # e.g. ["http://10.0.0.10:8090"]
    # Optional admin token for L1 full view (same token on both paths).
    "controller_token": "",
    # v0.5.0-beta.12: L1 管理员验证二选一（同 dashboard 语义，仅 L1）——
    # ① admin 账号+密码：POST {gateway_admin_url}/session/login 验证，
    #    成功后持有 Console 管理员会话（console_session），供网关面
    #    （AI routes/providers = 模型选择 alias 层数据源）消费。
    # ② controller_token（上）：Controller 管理 API 全量（现状）。
    "admin_username": "",
    "admin_password": "",
    # Higress Console（管理面）地址。**必填**（v0.5.0-beta.12 定案）：
    # 留空 = 验证时报可操作错误——不从 Controller 地址推导、不盲探端口
    # （宿主端口是安装时自选的，AGENTTEAMS_PORT_CONSOLE 默认 18001）。
    "gateway_admin_url": "",
    # Console 管理员会话 cookie（/session/login 成功后的 Set-Cookie 值，
    # 服务端自持，redact 脱敏，永不进前端可见明文）。
    "console_session": "",
    # 可选模块：集群负载监控（L1 专属——不是每个部署都有本地 SGLang）。
    # enabled=false 时前端不渲染卡片、后端不注册语义（404），零痕迹。
    # v0.4.97: 双地址（内网/外网）——有序数组，首个可达 + failover，
    # 与 matrix_homeservers/controller_urls 同构；旧版单地址 "url" 自动迁移。
    "sglang": {
        "enabled": False,
        "urls": [],  # e.g. ["http://192.168.x.x:30000", "https://你的域名:30000"]
    },
    "matrix": {
        "user_id": "",
        "access_token": "",
        "device_id": "",
    },
}


def _ensure_dir() -> None:
    _CONFIG_DIR.mkdir(parents=True, exist_ok=True)


def load_config() -> Dict[str, Any]:
    """Load the config, merging with defaults for missing keys."""
    with _lock:
        try:
            raw = json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return json.loads(json.dumps(_DEFAULTS))

        merged = json.loads(json.dumps(_DEFAULTS))
        # New schema keys
        for key in (
            "matrix_homeservers",
            "controller_urls",
            "controller_token",
            "admin_username",
            "admin_password",
            "gateway_admin_url",
            "console_session",
            "sglang",
            "matrix",
        ):
            if key in raw and raw[key] is not None:
                merged[key] = raw[key]
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
        # v0.4.97: sglang 旧版单地址 "url" → 双地址 "urls"（存量配置自动迁移）。
        # 迁移后 pop 旧键——否则旧 url 会作为第三个 failover 候选混入请求链。
        sg = merged.get("sglang")
        if isinstance(sg, dict) and not sg.get("urls"):
            legacy = str(sg.get("url") or "").strip()
            if legacy:
                sg["urls"] = [legacy]
            sg.pop("url", None)
        return merged


def save_config(config: Dict[str, Any]) -> None:
    """Persist the full config (caller is responsible for shape)."""
    with _lock:
        _ensure_dir()
        tmp = _CONFIG_PATH.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps(config, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        tmp.replace(_CONFIG_PATH)


def update_config(patch: Dict[str, Any]) -> Dict[str, Any]:
    """Apply a shallow patch and persist. Returns the merged config."""
    merged = load_config()
    for key in ("matrix_homeservers", "controller_urls"):
        if key in patch and isinstance(patch[key], list):
            merged[key] = [v.strip() for v in patch[key] if isinstance(v, str) and v.strip()]
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
    if "sglang" in patch and isinstance(patch["sglang"], dict):
        existing = merged.get("sglang") or {}
        incoming = dict(patch["sglang"])
        # v0.4.97: 双地址列表；兼容旧前端/旧配置的单地址 "url"。
        if "urls" in incoming and isinstance(incoming["urls"], list):
            incoming["urls"] = [
                v.strip() for v in incoming["urls"] if isinstance(v, str) and v.strip()
            ]
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


def redact(config: Dict[str, Any]) -> Dict[str, Any]:
    """Config safe to send back to the frontend (no secrets)."""
    out = json.loads(json.dumps(config))
    if out.get("controller_token"):
        out["controller_token"] = "***"
    # L1 管理员凭据：密码与 Console 会话脱敏；用户名保留（非机密，前端回显）。
    if out.get("admin_password"):
        out["admin_password"] = "***"
    if out.get("console_session"):
        out["console_session"] = "***"
    matrix = out.get("matrix") or {}
    if matrix.get("access_token"):
        matrix["access_token"] = "***"
    return out
