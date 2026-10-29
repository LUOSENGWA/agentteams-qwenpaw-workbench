# -*- coding: utf-8 -*-
"""Worker MCP 域：CRD 声明 + worker 自注册 MCP 的合并读（只读）。

背景：worker 把内置插件 MCP（teamharness/workerflow 等）自注册进
QwenPaw 客户端注册表（worker 侧 GET /api/mcp），Controller 另有一单
加 ``GET /api/v1/workers/{name}/mcp`` 只读代理（**可能尚未合并**）。
工作台此前只显示 CRD 的 ``spec.mcpServers``（Controller /workers
响应透传），看不到 worker 自注册条目——本端点补「自注册」读路径，
前端 WorkerMcpPanel 将两路合并展示。

诚实降级（任务书口径）：
- Controller 404（端点未合 / 路径不存在）→ HTTP 200
  ``{"available": false, "reason": "controller_too_old"}``
  ——不抛 500、不吞成空数组；前端显示「需升级 controller」一行提示。
- 无本地 controller token → HTTP 200
  ``{"available": false, "reason": "no_token"}``（不拨号、不 500）。
- 其他错误（401/403/5xx/传输全败）→ 透传/映射状态码 + 简短原因
  （前端行内 warning，无弹窗）。

防御性归一化（Controller 侧并行单未合、端点响应形态未定案）：
接受 ① 条目数组 ② 包装对象（mcpServers/servers/mcp/clients/mcp_servers）
③ name→config 映射（QwenPaw mcp.clients 形态）；条目以 **key 优先**
（QwenPaw MCPClientInfo 的 key = 唯一标识，name = 显示名，显示名另存
displayName），字段按 key/name/id/server 取名，未知形态跳过（不伪造）。

脱敏（值永不下发前端）：
- ``env`` / ``headers``：值一律 ``***``（只留键名）。
- ``command`` / ``args``：绝对路径中的用户名段（``/home/<u>``、
  ``/root``）替换为 ``~``；其余原样。
- ``url``：剥 ``user:pass@`` userinfo 段（内嵌凭据）。

安全：只读；worker 名正则门控后才进 controller 路径（零注入面）；
走 router 共享 ctl_json（ordered 地址 failover + 该地址覆盖凭据）。
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException

from .. import config as config_mod
from ..router import _ctl_json, _token_or_none

_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9\-]{0,62}$")
# 用户名段：/home/<user> 或 /root（整段或作为绝对路径前缀）。
_HOME_RE = re.compile(r"^/(?:home/[^/]+|root)(?=/|$)")
# URL userinfo：scheme://user:pass@host → 剥 user:pass@。
_URL_USERINFO_RE = re.compile(
    r"^([a-zA-Z][a-zA-Z0-9+.\-]*://)([^/@\s]+@)(.*)$")
# 包装对象里装列表/映射的候选键（按序取第一个命中的）。
_WRAPPER_KEYS = ("mcpServers", "servers", "mcp", "clients", "mcp_servers")


def _tilde_path(value: str) -> str:
    """绝对路径用户名段 → ~（/home/lsw/x → ~/x；/root → ~）。"""
    return _HOME_RE.sub("~", value)


def _strip_url_userinfo(url: str) -> str:
    """剥 URL 内嵌凭据 user:pass@（scheme://user:pass@host → scheme://host）。"""
    m = _URL_USERINFO_RE.match(url)
    if not m:
        return url
    return m.group(1) + m.group(3)


def _masked_map(value: Any) -> Optional[Dict[str, str]]:
    """env/headers 脱敏：只留键名，值一律 ***。非 dict → None（省略键）。"""
    if isinstance(value, dict):
        return {str(k): "***" for k in value}
    return None


def _normalize_entry(name: Any, cfg: Any) -> Optional[Dict[str, Any]]:
    """单条归一化。无有效名 / 非 dict 配置 → None（跳过，不伪造）。"""
    name = str(name or "").strip()
    if not name:
        return None
    if not isinstance(cfg, dict):
        cfg = {}
    # QwenPaw MCPClientInfo: key = unique client key (identity), name =
    # display name. Keep them separate so the merge against CRD
    # declarations (keyed by server name) does not split one server into
    # two rows when the display name differs from the key.
    display = cfg.get("displayName") or cfg.get("display_name") or cfg.get("name")
    display = str(display).strip() if isinstance(display, str) else ""
    enabled = cfg.get("enabled")
    if not isinstance(enabled, bool) and isinstance(cfg.get("disabled"), bool):
        enabled = not cfg["disabled"]
    if not isinstance(enabled, bool):
        enabled = None
    transport = cfg.get("transport")
    if not isinstance(transport, str):
        transport = str(cfg.get("type")) if isinstance(cfg.get("type"), str) else ""
    command = cfg.get("command")
    command = (_tilde_path(str(command).strip())
               if isinstance(command, str) and command.strip() else "")
    args_raw = cfg.get("args")
    args = ([_tilde_path(str(a)) for a in args_raw]
            if isinstance(args_raw, list) else [])
    url = cfg.get("url")
    if not isinstance(url, str):
        url = cfg.get("endpoint")
    url = (_strip_url_userinfo(str(url).strip())
           if isinstance(url, str) and url.strip() else "")
    entry: Dict[str, Any] = {
        "name": name,
        "enabled": enabled,
        "transport": transport,
        "command": command,
        "args": args,
        "url": url,
    }
    if display and display != name:
        entry["displayName"] = display
    env = _masked_map(cfg.get("env"))
    if env is not None:
        entry["env"] = env
    headers = _masked_map(cfg.get("headers"))
    if headers is not None:
        entry["headers"] = headers
    return entry


def _normalize_entries(data: Any) -> List[Dict[str, Any]]:
    """Controller 响应防御性归一化（形态未定案，多形态接受）。

    ① 条目数组 ② 包装对象（_WRAPPER_KEYS 命中）③ name→config 映射。
    非 dict 映射值跳过；无有效名条目跳过。
    """
    if isinstance(data, dict):
        for k in _WRAPPER_KEYS:
            v = data.get(k)
            if isinstance(v, (list, dict)):
                data = v
                break
    if isinstance(data, list):
        entries: List[Dict[str, Any]] = []
        for e in data:
            if not isinstance(e, dict):
                continue
            # key = unique identity (matches the CRD server name used by
            # declared entries); name = display name → kept as displayName.
            name = (e.get("key") or e.get("name")
                    or e.get("id") or e.get("server"))
            ent = _normalize_entry(name, e)
            if ent:
                entries.append(ent)
        return entries
    if isinstance(data, dict):
        entries = []
        for k, v in data.items():
            if not isinstance(v, dict):
                continue
            ent = _normalize_entry(k, v)
            if ent:
                entries.append(ent)
        return entries
    return []


def build_worker_mcp_router() -> APIRouter:
    router = APIRouter()

    @router.get("/workers/{worker}/mcp")
    async def worker_mcp(worker: str) -> Dict[str, Any]:
        """worker 自注册 MCP（Controller 只读代理）。

        404（Controller 端点未合/路径不存在）→ 200 available=false
        reason=controller_too_old（诚实降级）；401/403/5xx → 透传
        状态码 + 简短原因；无 token → 200 available=false no_token。
        """
        worker = (worker or "").strip()
        if not _NAME_RE.match(worker):
            raise HTTPException(status_code=400, detail="worker 名称非法")
        token = _token_or_none(config_mod.load_config())
        if not token:
            return {"available": False, "worker": worker,
                    "reason": "no_token"}
        st, data, _text = await _ctl_json(
            "GET", f"/api/v1/workers/{worker}/mcp", token)
        if st == 404:
            return {"available": False, "worker": worker,
                    "reason": "controller_too_old"}
        if st == 200:
            return {"available": True, "worker": worker,
                    "mcpServers": _normalize_entries(data)}
        if st == 0:
            raise HTTPException(
                status_code=502, detail="Controller 不可达（无可用地址或拨号失败）")
        if st >= 500:
            raise HTTPException(
                status_code=502, detail=f"Controller 内部错误（HTTP {st}）")
        # 401/403 及其他 4xx：透传状态码 + 简短原因。
        raise HTTPException(status_code=st, detail=f"Controller 返回 HTTP {st}")

    return router
