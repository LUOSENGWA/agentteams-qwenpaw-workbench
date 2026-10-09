from __future__ import annotations

import asyncio

from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import config as config_mod, matrix_client, selfcheck
from ..dial_gate import GatedAsyncClient
from ..router import (
    DmRequest,
    LoginRequest,
    NotifyRequest,
    SearchRequest,
    _headers_for,
    _json_dumps,
    _mark_working,
    _ordered_addresses,
    _parse_docker_stream,
    _pick_address,
    _pinned_note,
    _rooms_cache,
    _rooms_cache_lock,
    _token_or_none,
    invalidate_data_caches,
    logger,
)


def build_matrix_router() -> APIRouter:
    """matrix 域子路由（build_router 原段逐字搬移）。"""
    router = APIRouter()
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
            # 同步 matrix_client 调用 to_thread 化——避免冻结
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
            # 单房两往返（成员 + 房名）并发——原串行 2×RTT/房，
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
        from .. import spawn_tree as spawn_tree_mod

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
                # （14.17 「运行日志 HTTP 502: Docker API
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
            # to_thread（同步 httpx，最长 20s）。
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
        # 上限 10→5 页。limit≤20 条
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
                # 只要 message 事件。
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

        from .. import sync_watcher

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
        from .. import matrix_client as _mc

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
                # to_thread（同步 httpx，最长 20s）。
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
                    },
                    source="matrix login",
                )
                logger.info(
                    "login ok: %s via %s (device %s)",
                    data.get("user_id"),
                    hs,
                    data.get("device_id", "?"),
                )
                # 切账号 = 数据源切换——清 60s 聚合缓存（手动刷新不再
                # 命中旧账号数据）+ 重置 sync 游标（since 跨账号无效，旧游标
                # 会让 /sync 一直 401、@通知链全断）。
                invalidate_data_caches("login")
                from .. import sync_watcher as _sw  # noqa: PLC0415

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
            # run_l2 全同步（httpx 10s+15s）——to_thread 化。
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
        """Server-side fetch of a direct http(s) file URL ().

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

    return router
