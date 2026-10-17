"""集群信息域：GET /cluster-info（AgentTeams 版本 + Higress 版本）。

版本正源（15.25，用户反馈「AgentTeams 版本应该放在集群状态，还有 Higress 版本」）：

- AgentTeams 版本 = ``agentteams-controller`` 容器镜像 tag（发布版本）。
  不取 Controller ``/api/v1/version``——其 ``controller`` 字段硬编码
  ``"dev"``（v1.2.5 源码实读，StatusHandler.Version），不可用。
- Higress 版本 = 三级源（Higress Console 无版本 REST 端点，/v1/system/*
  404 实测；console jar manifest 为自定义构建占位 0.0.1-SNAPSHOT）：
  ① controller 容器 ``/etc/higress_version`` 文件（部署时一次性写入）；
  ② controller 容器 ``HIGRESS_VERSION`` env（上游 embedded Dockerfile
  建议 ``ENV HIGRESS_VERSION=<tag>``，未落前此级恒空）；
  ③ 均无 → ``null``（前端显 "—"，不猜）。

两个版本都是慢变事实 → 10min 缓存；探测失败降级 ``null`` + 原因
（HTTP 恒 200，集群状态卡不因版本探测失败而报错）。

无 L1 admin token → 403（docker 代理需 admin 鉴权，与 node-version 域同）。
"""
from __future__ import annotations

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

_CACHE_TTL = 600.0  # 版本缓存 10min（慢变事实）

# Higress 版本探测命令（零用户输入）：首行=来源标记，次行=值。
_HIGRESS_PROBE_CMD = (
    "if [ -f /etc/higress_version ]; then printf 'file\\n'; "
    "cat /etc/higress_version; "
    "else v=${HIGRESS_VERSION:-}; "
    "[ -n \"$v\" ] && printf 'env\\n%s\\n' \"$v\"; fi"
)

_VERSION_RE = None  # 延迟编译避免模块导入依赖（保持与 node_version 同风格）


def _parse_exec_stream(raw: bytes) -> str:
    """docker exec 非 TTY 流：N 个 8 字节帧头+载荷；<8 字节=裸文本。

    恰好 8 字节=空载荷（> 8 会把纯头当输出——node-version N6 单测实锤）。
    """
    if len(raw) < 8:
        return raw.decode("utf-8", "replace")
    out: list[bytes] = []
    i = 0
    while i + 8 <= len(raw):
        ln = int.from_bytes(raw[i + 4:i + 8], "big")
        i += 8
        if ln == 0:
            continue
        out.append(raw[i:i + ln])
        i += ln
    if i < len(raw):
        out.append(raw[i:])
    return b"".join(out).decode("utf-8", "replace")


def build_cluster_info_router() -> APIRouter:
    router = APIRouter()

    _cache: Dict[str, Any] = {"ts": 0.0, "data": None}

    async def _ctl_call(token: str, method: str, path: str,
                        json_body: Optional[dict] = None):
        """controller 地址 failover → (status, response|None, err)。"""
        urls = [u.rstrip("/") for u in _ordered_addresses(
            config_mod.load_config(), "controller")]
        if not urls:
            return 0, None, "未配置 Controller 地址"
        last_err = ""
        for b in urls:
            try:
                headers = _headers_for(
                    config_mod.load_config(), "controller", b,
                    {"Authorization": f"Bearer {token}"})
                async with GatedAsyncClient(timeout=25.0, verify=False) as client:
                    if method == "POST":
                        r = await client.post(
                            f"{b}{path}", json=json_body, headers=headers)
                    else:
                        r = await client.get(f"{b}{path}", headers=headers)
            except Exception as exc:  # noqa: BLE001 - try next address
                last_err = f"请求失败：{exc}"
                continue
            if r.status_code < 500:
                return r.status_code, r, ""
            last_err = f"Controller {r.status_code}"
        return 0, None, last_err or "请求失败"

    async def _controller_image_tag(token: str) -> Optional[str]:
        """agentteams-controller 容器 → 镜像 tag（去 registry 前缀/去 v）。"""
        st, r, _ = await _ctl_call(
            token, "GET", "/docker/v1.41/containers/json?all=true")
        if st != 200 or r is None:
            return None
        try:
            for c in r.json() or []:
                if not isinstance(c, dict):
                    continue
                names = [n.lstrip("/") for n in (c.get("Names") or [])]
                if "agentteams-controller" not in names:
                    continue
                img = str(c.get("Image") or "")
                if ":" not in img.rsplit("/", 1)[-1]:
                    return None
                tag = img.rsplit(":", 1)[-1]
                return tag.lstrip("v")
        except Exception as exc:  # noqa: BLE001
            logger.warning("cluster-info: 容器清单解析失败：%s", exc)
        return None

    async def _higress_version(token: str) -> tuple:
        """controller 容器 exec 探测 → (version|None, source|None, err)。"""
        urls = [u.rstrip("/") for u in _ordered_addresses(
            config_mod.load_config(), "controller")]
        last_err = ""
        for b in urls:
            try:
                headers = _headers_for(
                    config_mod.load_config(), "controller", b,
                    {"Authorization": f"Bearer {token}"})
                async with GatedAsyncClient(timeout=25.0, verify=False) as client:
                    r1 = await client.post(
                        f"{b}/docker/v1.41/containers/agentteams-controller/exec",
                        json={"Cmd": ["sh", "-c", _HIGRESS_PROBE_CMD],
                              "AttachStdout": True, "AttachStderr": True},
                        headers={**headers, "Content-Type": "application/json"},
                    )
                    if r1.status_code in (403, 404):
                        return None, None, f"Docker API {r1.status_code}"
                    if r1.status_code not in (200, 201):
                        last_err = f"Docker API {r1.status_code}"
                        continue
                    eid = (r1.json() or {}).get("Id") or ""
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
                    text = _parse_exec_stream(s2.content or b"")
                    lines = [ln.strip() for ln in text.splitlines()
                             if ln.strip()]
                    if not lines:
                        return None, None, ""
                    source = lines[0]
                    version = lines[1] if len(lines) > 1 else ""
                    if source not in ("file", "env") or not version:
                        return None, None, ""
                    return version, source, ""
            except Exception as exc:  # noqa: BLE001 - try next address
                last_err = f"探测失败：{exc}"
        return None, None, last_err or "探测失败"

    @router.get("/cluster-info")
    async def cluster_info() -> Dict[str, Any]:
        """集群版本信息（AgentTeams/Higress，10min 缓存）。

        403=无 L1 token。探测失败字段 null + *_error（HTTP 恒 200）。
        """
        token = _token_or_none(config_mod.load_config())
        if not token:
            raise HTTPException(
                status_code=403,
                detail="需要 Controller 管理员 token（L1）才能读取集群版本")
        now = time.time()
        if _cache["data"] is not None and now - _cache["ts"] < _CACHE_TTL:
            return dict(_cache["data"])
        at = await _controller_image_tag(token)
        hg, hg_src, hg_err = await _higress_version(token)
        payload = {
            "agentteams_version": at,
            "higress_version": hg,
            "higress_version_source": hg_src,
            "higress_version_error": hg_err if not hg else "",
            "probed_at": now,
        }
        _cache["ts"] = now
        _cache["data"] = payload
        return dict(payload)

    return router
