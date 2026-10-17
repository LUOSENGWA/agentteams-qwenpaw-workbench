# -*- coding: utf-8 -*-
"""节点版本域：per-node AgentTeams 版本（镜像 tag）+ 运行时版本（docker exec 探测）。

10/17 需求反馈：「v1.2.5 是 AgentTeams 版本，不是运行时版本，当前
QwenPaw 版本是 2.2.1，还要覆盖其他运行时的版本显示。」

数据面（全实锤，2026-10-17 本机集群实测）：
- **AgentTeams 版本** = Worker/Manager CRD 列表 ``image`` 的 tag
  （``…agentteams-qwenpaw-worker:v1.2.5`` → ``1.2.5``）——Controller
  ``/api/v1/workers`` / ``/managers`` 已含字段，30s 缓存。
- **运行时版本** = 容器内运行时软件的实际版本。Worker 列表**无**此字段，
  Controller 也未代理 QwenPaw ``/api/version``；插件宿主与 Worker 容器
  不同 docker 网络（DNS 解析失败，直拨死）。唯一可达路径 = Controller
  ``/docker/`` 代理（GET 全放行 + POST exec create/start 放行，L1
  鉴权=RequireAuthz(ActionGateway)；controller 自身对 coding CLI 也用
  同款容器内 exec 探测 ``--version``，模式同构）：
  * qwenpaw 族（qwenpaw/copaw/openclaw-profile/hermes/deepseek-harness
    底层均为 QwenPaw 引擎——manager「openclaw」实为 qwenpaw app +
    openclaw.json profile，ps 实锤）：
    ``/opt/venv/qwenpaw/bin/python3``（回退 copaw venv / 系统 python3）
    ``importlib.metadata.version("qwenpaw")``——实测 worker/manager
    均得 2.2.1（宿主 2.2.2 ≠ worker 2.2.1 → 必须 per-node 探测，
    不可拿宿主版本冒充）。
  * openclaw 原生容器（无 qwenpaw 包）：``openclaw --version`` 首行。
- exec start ``Detach:false`` 直读 stdout 经 controller 代理**可靠**
  （httpx 3/3 实测；approval_api 的「stdout 被代理吞」注与其
  ``Detach:True`` fire-and-forget 模式相关，非代理能力限制）。

安全：
- L1 only（管理面，同 approval 域）——无 token 403。
- 命令=固定常量，零用户输入（name 仅用于 CRD 查询与容器名匹配，
  不进 shell；容器名正则校验后才进 docker API 路径）。
- 10min 结果缓存 + in-flight 去重（版本是慢变事实；探测 ~2s/次
  含容器 exec 启动开销）。
"""
from __future__ import annotations

import asyncio
import re
import time
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException

from .. import config as config_mod
from ..dial_gate import GatedAsyncClient
from ..router import (
    _headers_for,
    _ordered_addresses,
    _token_or_none,
    logger,
)

# 容器名匹配（docker API 路径段，防注入）。
_CONTAINER_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.\-]{0,127}$")
# 版本号形态：数字开头 + 常规版本字符（拒绝 exec 吐出的杂散行）。
_VERSION_RE = re.compile(r"^[0-9][0-9A-Za-z.+\-]{0,63}$")
# 节点名（CRD 名域）。
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9\-]{0,62}$")

# 固定探测命令（零用户输入）。qwenpaw 族优先（本平台运行时底层均为
# QwenPaw 引擎或 openclaw profile），openclaw 原生兜底。
_PROBE_CMD = (
    'v=""; '
    'for p in /opt/venv/qwenpaw/bin/python3 /opt/venv/copaw/bin/python3 python3; do '
    '  v=$("$p" -c \'import importlib.metadata as m; print(m.version("qwenpaw"))\' 2>/dev/null) && break; '
    "done; "
    'if [ -n "$v" ]; then printf "%s" "$v"; exit 0; fi; '
    'if command -v openclaw >/dev/null 2>&1; then openclaw --version 2>/dev/null | head -n1; exit 0; fi; '
    "printf ''"
)

_RESULT_TTL = 600.0      # 版本缓存 10min（慢变事实）
_LIST_TTL = 30.0         # workers/managers 列表缓存
_DOCKER_LIST_TTL = 60.0  # 容器名清单缓存


def build_node_version_router() -> APIRouter:
    router = APIRouter()

    # 装配方状态（build_router 每建一次全新，测试隔离随装配成立）。
    _nodes: Dict[str, Any] = {"worker": None, "manager": None, "ts": 0.0}
    _docker_names: Dict[str, Any] = {"data": None, "ts": 0.0}
    _ver_cache: Dict[str, tuple] = {}   # "kind:name" -> (ts, payload)
    _inflight: Dict[str, asyncio.Lock] = {}

    async def _ctl_get(token: str, path: str):
        """controller 地址 failover GET → (status, response|None, err)。"""
        urls = [u.rstrip("/") for u in _ordered_addresses(
            config_mod.load_config(), "controller")]
        if not urls:
            return 0, None, "未配置 Controller 地址"
        last_err = ""
        for b in urls:
            try:
                async with GatedAsyncClient(timeout=20.0, verify=False) as client:
                    r = await client.get(
                        f"{b}{path}",
                        headers=_headers_for(
                            config_mod.load_config(), "controller", b,
                            {"Authorization": f"Bearer {token}"}),
                    )
            except Exception as exc:  # noqa: BLE001 - try next address
                last_err = f"请求失败：{exc}"
                continue
            if r.status_code == 200:
                return 200, r, ""
            if r.status_code < 500:
                return r.status_code, r, ""  # 确定性 4xx 地址无关
            last_err = f"Controller {r.status_code}"
        return 0, None, last_err

    def _image_tag(image: str) -> str:
        """…/agentteams-qwenpaw-worker:v1.2.5 → 1.2.5。无 tag → ""。"""
        if not image or ":" not in image.rsplit("/", 1)[-1]:
            return ""
        tag = image.rsplit(":", 1)[-1]
        return tag.lstrip("v")

    async def _load_nodes(token: str) -> None:
        """workers + managers 列表（30s 缓存；失败留旧值/空）。"""
        now = time.time()
        if (_nodes["worker"] is not None
                and _nodes["manager"] is not None
                and now - _nodes["ts"] < _LIST_TTL):
            return
        # 本地 dict 键用复数（API 响应字段名），写回 _nodes 时归一为单数。
        raw: Dict[str, list] = {"workers": [], "managers": []}
        for path, key in (("/api/v1/workers", "workers"),
                          ("/api/v1/managers", "managers")):
            st, r, _ = await _ctl_get(token, path)
            if st == 200 and r is not None:
                try:
                    body = r.json()
                    lst = body.get(key) if isinstance(body, dict) else body
                    if isinstance(lst, list):
                        raw[key] = [x for x in lst if isinstance(x, dict)]
                except Exception:  # noqa: BLE001 - 解析失败留空
                    pass
        _nodes["worker"] = raw["workers"]
        _nodes["manager"] = raw["managers"]
        _nodes["ts"] = now

    async def _node_entry(name: str) -> Dict[str, Any]:
        """按名找节点（worker 优先，manager 兜底）→ 404 不存在。"""
        await _load_nodes(_token_or_none(config_mod.load_config()) or "")
        for kind in ("worker", "manager"):
            for e in _nodes[kind] or []:
                if e.get("name") == name:
                    return {"kind": kind, "name": name,
                            "runtime": str(e.get("runtime") or ""),
                            "image": str(e.get("image") or "")}
        raise HTTPException(status_code=404, detail=f"节点「{name}」不存在（Worker/Manager 均无）")

    async def _docker_container_name(kind: str, name: str, image: str) -> Optional[str]:
        """节点 → 容器名：候选直中 → 清单后缀/镜像 tag 兜底（60s 缓存）。"""
        token = _token_or_none(config_mod.load_config()) or ""
        candidates = []
        if kind == "manager":
            candidates.append("agentteams-manager")
            if name != "default":
                candidates.append(f"agentteams-manager-{name}")
        else:
            candidates.append(f"agentteams-worker-{name}")
        now = time.time()
        if _docker_names["data"] is None or now - _docker_names["ts"] > _DOCKER_LIST_TTL:
            try:
                st, r, _ = await _ctl_get(
                    token, "/docker/v1.41/containers/json?all=true")
                if st == 200 and r is not None:
                    body = r.json()
                    if isinstance(body, list):
                        _docker_names.update(
                            data=[(str((c.get("Names") or [""])[0]).lstrip("/"),
                                   str(c.get("Image") or ""))
                                  for c in body if isinstance(c, dict)],
                            ts=now)
            except Exception as exc:  # noqa: BLE001 - 清单不可用→仅候选
                logger.warning("node-version: 容器清单获取失败：%s", exc)
                _docker_names.update(data=[], ts=now)
        names = _docker_names["data"] or []
        have = {n for n, _ in names}
        for cand in candidates:
            if not names or cand in have:
                # 清单不可用（docker 代理挂）时仍信候选名（approval 域同款约定）。
                return cand
        tag = _image_tag(image)
        hits = [(n, img) for n, img in names if n == name or n.endswith(f"-{name}")]
        if len(hits) == 1:
            return hits[0][0]
        if len(hits) > 1 and tag:
            by_tag = [n for n, img in hits
                      if img.rsplit(":", 1)[-1] in (tag, f"v{tag}")]
            if len(by_tag) == 1:
                return by_tag[0]
        return None

    async def _probe_runtime_version(container: str) -> tuple:
        """exec 固定探测命令 → (version|None, error)。"""
        token = _token_or_none(config_mod.load_config()) or ""
        urls = [u.rstrip("/") for u in _ordered_addresses(
            config_mod.load_config(), "controller")]
        last_err = ""
        for b in urls:
            try:
                headers = _headers_for(
                    config_mod.load_config(), "controller", b,
                    {"Authorization": f"Bearer {token}"})
                async with GatedAsyncClient(timeout=25.0, verify=False) as client:
                    r = await client.post(
                        f"{b}/docker/v1.41/containers/{container}/exec",
                        json={"Cmd": ["sh", "-c", _PROBE_CMD],
                              "AttachStdout": True, "AttachStderr": True},
                        headers={**headers, "Content-Type": "application/json"},
                    )
                    if r.status_code in (403, 404):
                        return None, f"Docker API {r.status_code}"
                    if r.status_code not in (200, 201):
                        last_err = f"Docker API {r.status_code}"
                        continue
                    eid = (r.json() or {}).get("Id") or ""
                    if not eid:
                        last_err = "exec 无 Id"
                        continue
                    s2 = await client.post(
                        f"{b}/docker/v1.41/exec/{eid}/start",
                        json={"Detach": False, "Tty": False},
                        headers=headers,
                    )
                    if s2.status_code != 200:
                        last_err = f"exec start {s2.status_code}"
                        continue
                    raw = s2.content or b""
                    # docker 流帧=8 字节头+载荷；恰好 8 字节=空载荷
                    # （> 8 会把纯头当输出——单测 N6 实锤）。非流
                    # （< 8，代理裸文本错误）整段即输出。
                    out = raw[8:] if len(raw) >= 8 else raw
                    text = out.decode("utf-8", "replace")
                    line = next((ln.strip() for ln in text.splitlines()
                                 if ln.strip()), "")
                    # 逐字段取首个版本样 token（qwenpaw 直出 "2.2.1"；
                    # openclaw 首行可能带产品名 "OpenClaw 1.2.3"）。
                    tok = next(
                        (f for f in re.split(r"[\s,;:()]+", line)
                         if _VERSION_RE.match(f)),
                        None)
                    if tok:
                        return tok, ""
                    if not line:
                        return None, "容器内未找到 qwenpaw/openclaw 版本"
                    return None, "探测输出异常"
            except Exception as exc:  # noqa: BLE001 - try next address
                last_err = f"探测失败：{exc}"
        return None, last_err or "探测失败"

    @router.get("/node-version/{name}")
    async def node_version(name: str, refresh: int = 0) -> Dict[str, Any]:
        """per-node AgentTeams 版本（镜像 tag）+ 运行时版本（exec 探测）。

        name = Worker 名 或 Manager 名。refresh=1 绕过缓存重探。
        403=无 L1 token；404=节点不存在；探测失败降级
        runtime_version=null + runtime_version_error（HTTP 恒 200）。
        """
        if not _NAME_RE.match(name or ""):
            raise HTTPException(status_code=400, detail="非法节点名")
        token = _token_or_none(config_mod.load_config())
        if not token:
            raise HTTPException(
                status_code=403,
                detail="需要 Controller 管理员 token（L1）才能探测节点版本")
        entry = await _node_entry(name)
        key = f"{entry['kind']}:{name}"
        if not refresh:
            hit = _ver_cache.get(key)
            if hit and time.time() - hit[0] < _RESULT_TTL:
                return dict(hit[1])
        lock = _inflight.setdefault(key, asyncio.Lock())
        async with lock:
            hit = _ver_cache.get(key)
            if not refresh and hit and time.time() - hit[0] < _RESULT_TTL:
                return dict(hit[1])
            container = await _docker_container_name(
                entry["kind"], name, entry["image"])
            if not container:
                ver, verr = None, "容器未找到（可能已停止或命名规则变化）"
            elif not _CONTAINER_RE.match(container):
                ver, verr = None, "容器名非法"
            else:
                ver, verr = await _probe_runtime_version(container)
            payload: Dict[str, Any] = {
                "kind": entry["kind"],
                "name": name,
                "runtime": entry["runtime"],
                "agentteams_version": _image_tag(entry["image"]),
                "image": entry["image"],
                "runtime_version": ver,
                "runtime_version_error": verr or "",
                "probed_at": time.time(),
            }
            _ver_cache[key] = (time.time(), payload)
            return payload

    return router
