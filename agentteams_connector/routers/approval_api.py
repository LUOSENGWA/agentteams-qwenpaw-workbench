from __future__ import annotations

import asyncio
import time

from typing import Any, Dict, Optional

import httpx
from fastapi import APIRouter, HTTPException, Request, Response

from .. import config as config_mod, selfcheck
from ..dial_gate import GatedAsyncClient, should_failover_status
from ..router import (
    CONTROLLER_ALLOWED_PREFIXES,
    _APPROVAL_LIST_TTL_SECONDS,
    _PROXY_TIMEOUT,
    _approval_list_cache,
    _ctl_json,
    _headers_for,
    _mark_working,
    _ordered_addresses,
    _pinned_note,
    _token_or_none,
    logger,
)


def build_approval_router(kb_shared: Dict[str, Any]) -> APIRouter:
    """approval + catch-all proxy 域子路由（build_router 原段逐字搬移；catch-all /{target}/{path:path} 必须装配最后）。"""
    router = APIRouter()

    # 跨域共享（kb builder 内定义，装配方显式传入）：
    _KB_AGENT_RE = kb_shared["agent_re"]
    _kb_require_token = kb_shared["require_token"]
    _kb_docker = kb_shared["docker"]
    _kb_docker_available = kb_shared["docker_available"]


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
        # 与全族一致走 _headers_for（controller 地址覆盖
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
        """拨号计数快照（，）——修复验收/排障对账用。"""
        from .. import dial_gate as _dg  # noqa: PLC0415

        return _dg.dial_stats()

    @router.get("/approval/list")
    async def approval_list(agent: str = "") -> Dict[str, Any]:
        """各 Worker/Manager 当前 approval_level（只读：archive 直读
 agent.json——与 KB 同通道，零新端点依赖）。
 ?agent=xxx 过滤单个（Worker 管理展开行懒加载用，避免全量扫）。"""
        token, base = _kb_require_token()
        # 20s TTL 缓存命中即返（成功响应才写；异常路径不缓存）。
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
        # 串行 → 并发（原 for ... await _one() 串行 ≈23s@WAN）。
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
        # 写路径先失效缓存（防写窗口内列表缓存旧值）。
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
                # 兜底写成功后同样失效缓存。
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
            # 写成功后再次失效（清掉写窗口内缓存的旧值）。
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
        methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
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

        # multipart/form-data
        # 原样透传——读原始字节 + 连同 boundary 的 Content-Type 一起转发；
        # 旧版一律 request.json() → multipart 解析失败 body=None → 上游收
        # 空体（技能 zip 上传必 400）。
        body = None
        raw_body: Optional[bytes] = None
        req_ct = request.headers.get("content-type", "")
        # PATCH 与 POST/PUT 同语义读 body（Controller
        # tools 端点 = PATCH /workers/{name}/tools/{tool}，beta.12.3 起
        # catch-all 漏了 PATCH → 405 Method Not Allowed，打地鼠前的
        # 方法表对账：Go mux 注册的方法集合=GET/PUT/POST/PATCH/DELETE）。
        if request.method in ("POST", "PUT", "PATCH"):
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
        # /messages 默认只取 message 事件（实测
        # 5.2KB→1KB/页，5Mbps 链路显著）；调用方显式传 filter= 时尊重其选择。
        if (
            target == "matrix"
            and full_path.endswith("/messages")
            and "/_matrix/client/v3/rooms/" in full_path
            and "filter=" not in (request.url.query or "")
        ):
            _flt = _urlparse_mod.quote('{"types":["m.room.message"]}', safe="")
            query_string += ("&" if query_string else "?") + f"filter={_flt}"
        # ①4xx 不再标记 working
        # （旧版任何 HTTP 响应都 _mark_working——一次 401 即污染 working
        # cache，切回内网后死地址仍居首恒 401）；②GET/HEAD 遇 4xx/5xx 继续
        # 下一地址（首个 401 地址可能是网关代理的会话门、直连控制器健康
        # → 换地址即通）；变更类方法（POST/PUT/DELETE）遇 4xx 原样返回不
        # 试下一地址（副作用安全：不在另一地址重放写请求）。全部失败 →
        # 首个非 2xx 响应原样返回（上游 401 body 自带诊断），否则 502。
        first_bad: Optional[tuple] = None
        for base in base_urls:
            url = f"{base.rstrip('/')}{encoded_path}{query_string}"
            # 该地址的覆盖凭据（basic/bearer）——无则原生认证。
            addr_headers = _headers_for(cfg, target, base, headers)
            try:
                # 连接类错误同址重试一次（300ms 退避）——
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
                # GET/HEAD 仅在地址相关/瞬时错误时换下
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
                # 写路径（POST/PUT/PATCH/DELETE）非 2xx
                # 即终态（副作用安全不跨址重放）——warning 留痕（方法+路径
                # +上游状态+body 前 200B），405 这类「上游方法表不符」问题
                # 从此一眼可辨（此前静默透传，只能靠前端文案反推）。
                if request.method not in ("GET", "HEAD") and resp.status_code >= 400:
                    logger.warning(
                        "proxy write %s %s via %s -> %d（body 头：%s）",
                        request.method, full_path, base, resp.status_code,
                        resp.content[:200],
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
    return router
