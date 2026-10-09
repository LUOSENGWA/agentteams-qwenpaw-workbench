from __future__ import annotations

from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, HTTPException

from .. import config as config_mod, matrix_client, selfcheck
from ..dial_gate import GatedAsyncClient, should_failover_status
from ..router import (
    _ROOMS_CACHE_TTL,
    _STRUCTURE_NEGATIVE_TTL,
    _SYNC_FILTER,
    _artifacts_cache,
    _headers_for,
    _mark_working,
    _ordered_addresses,
    _parse_sync_rooms,
    _pick_address,
    _pinned_note,
    _room_scan_state,
    _rooms_cache,
    _rooms_cache_lock,
    _scan_mark_full,
    _scan_should_full,
    _structure_cache,
    _token_or_none,
    _workflow_cache,
    logger,
)


def build_teams_router() -> APIRouter:
    """teams/sync 域子路由（build_router 原段逐字搬移）。"""
    router = APIRouter()
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
        homeserver = _pick_address(cfg, "matrix")
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
                status_code=502,
                detail=f"{selfcheck._classify_error(exc)}{_pinned_note(cfg)}",
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
            # 邀请房间（rooms.invite 段，前端邀请区渲染）。
            "invites": parsed["invites"],
            # 静音房间（m.muted_room account data 聚合）。
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
        homeserver = _pick_address(cfg, "matrix")
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
                    status_code=502,
                    detail=f"{selfcheck._classify_error(exc)}{_pinned_note(cfg)}",
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
        st_all = _room_scan_state["workflow"]
        full = _scan_should_full("workflow")
        from .. import sync_watcher  # noqa: PLC0415 — T6 增量探针

        async def _scan(room_entry: Dict[str, Any]) -> List[Dict[str, Any]]:
            async with sem:
                rid_w = str(room_entry.get("room_id") or "")
                sts = st_all.get(rid_w)
                if (
                    not full
                    and sts is not None
                    and sync_watcher.room_last_ts(rid_w) <= sts.get("ts", 0)
                ):
                    # T6：无推进 → 复用上次事件（零 /messages 拨号）。
                    return sts.get("entries") or []
                encoded = _urlparse_mod.quote(room_entry["room_id"], safe="/._-~")
                url = (
                    f"{homeserver.rstrip('/')}/_matrix/client/v3/rooms/{encoded}/messages"
                    "?dir=b&limit=30&filter="
                    + _urlparse_mod.quote('{"types":["m.room.message"]}', safe="")
                )
                try:
                    async with GatedAsyncClient(timeout=10.0, verify=False) as client:
                        resp = await client.get(
                            url, headers=_headers_for(cfg, "matrix", homeserver,
                                {"Authorization": f"Bearer {token}"})
                        )
                    if resp.status_code != 200:
                        return []
                    chunk = resp.json().get("chunk") or []
                except Exception as exc:  # noqa: BLE001
                    logger.debug("workflow/events: scan failed %s: %s", room_entry["room_id"], exc)
                    return []

            newest = 0
            for ev in chunk:
                _ev_ts = int(ev.get("origin_server_ts") or 0)
                if _ev_ts > newest:
                    newest = _ev_ts
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
            st_all[rid_w] = {
                "ts": max(newest, sync_watcher.room_last_ts(rid_w)),
                "entries": events,
            }
            return events

        scanned = await asyncio.gather(*(_scan(r) for r in rooms_sorted))
        if full:
            _scan_mark_full("workflow")
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
        homeserver = _pick_address(cfg, "matrix")
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
                    status_code=502,
                    detail=f"{selfcheck._classify_error(exc)}{_pinned_note(cfg)}",
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
        st_all = _room_scan_state["artifacts"]
        full = _scan_should_full("artifacts")
        from .. import sync_watcher  # noqa: PLC0415 — T6 增量探针

        async def _scan(room_entry: Dict[str, Any]) -> List[Dict[str, Any]]:
            async with sem:
                rid_a = str(room_entry.get("room_id") or "")
                sts = st_all.get(rid_a)
                if (
                    not full
                    and sts is not None
                    and sync_watcher.room_last_ts(rid_a) <= sts.get("ts", 0)
                ):
                    # T6 增量：无推进 → 复用上次产物条目（零拨号）。
                    return sts.get("entries") or []
                encoded = _urlparse_mod.quote(room_entry["room_id"], safe="/._-~")
                # 产物是稀疏事件（文档埋在大量对话里）：分页深扫最多 5 页 ×100 条。
                # dir=b + end token 向更早翻页（聊天室分页同款，Tuwunel 已验证支持）。
                collected: List[Dict[str, Any]] = []
                page_token = ""
                try:
                    async with GatedAsyncClient(timeout=15.0, verify=False) as client:
                        for _page in range(5):
                            url = (
                                f"{homeserver.rstrip('/')}/_matrix/client/v3/rooms/{encoded}/messages"
                                f"?dir=b&limit=100&filter="
                                + _urlparse_mod.quote('{"types":["m.room.message"]}', safe="")
                            )
                            if page_token:
                                url += f"&from={_urlparse_mod.quote(page_token, safe='')}"
                            resp = await client.get(
                                url, headers=_headers_for(cfg, "matrix", homeserver,
                                    {"Authorization": f"Bearer {token}"})
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
            # T6 增量：落逐房扫描态（无产物房 ts 兜 0，探针 0 ≤ 0 恒复用）。
            _newest = max((int(it.get("ts") or 0) for it in items), default=0)
            st_all[rid_a] = {
                "ts": max(_newest, sync_watcher.room_last_ts(rid_a)),
                "entries": items,
            }
            return items

        scanned = await asyncio.gather(*(_scan(r) for r in rooms_sorted))
        if full:
            _scan_mark_full("artifacts")
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
            # 按条目 ttl 判（负缓存 5s / 成功 60s），
            # 不再统一 60s——失败结果不应挡住后续手动刷新 60s。
            if (
                not force
                and struct_entry["data"] is not None
                and now - struct_entry["ts"] < struct_entry["ttl"]
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
            # 旧版只拨单地址
            # （working cache 或 urls[0]=LAN IP 优先）10s 超时、无 per-request
            # failover——切网窗口 / 进程重启后 working cache 未标记（探针 15s
            # 冷启动）内每个请求卡满超时再落 matrix 全量回退（无上限），团队
            # 管理「一开始刷不出、手动也不行、要等一会」。改与 catch-all 代理
            # 同语义：ordered 地址（working 优先）× token 链 failover；连接
            # 超时 3s 快速识破死地址；成功即标记 working。
            ctl_urls = _ordered_addresses(cfg, "controller")
            dial_timeout = httpx.Timeout(
                connect=3.0, read=10.0, write=10.0, pool=3.0
            )

            async def _dial_workers(
                token: str,
            ) -> Optional["httpx.Response"]:
                """按 ordered 地址 failover 拨 /api/v1/workers。

 传输层错误 / 5xx → 下一地址；4xx（鉴权/端点语义）→ 返回该
 响应（调用方换 token）；200/其他 → 返回并标记 working。
 全部失败 → None。
 """
                last_5xx: Optional["httpx.Response"] = None
                first_4xx: Optional["httpx.Response"] = None
                for url in ctl_urls:
                    try:
                        async with GatedAsyncClient(
                            timeout=dial_timeout, verify=False
                        ) as client:
                            r = await client.get(
                                f"{url.rstrip('/')}/api/v1/workers",
                                headers=_headers_for(
                                    cfg, "controller", url,
                                    {"Authorization": f"Bearer {token}"},
                                ),
                            )
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "teams/structure: workers API via %s failed: %s",
                            url,
                            selfcheck._classify_error(exc),
                        )
                        continue
                    if 400 <= r.status_code < 500:
                        # 仅地址相关 4xx（401/403/408/
                        # 429）换下一地址（网关会话门）；确定性 4xx（404/409/
                        # 400…）地址无关 → 立即返回（外层 token 链语义不变）。
                        if not should_failover_status(r.status_code):
                            return r
                        if first_4xx is None:
                            first_4xx = r
                        continue
                    if r.status_code >= 500:
                        last_5xx = r
                        continue
                    _mark_working("controller", url)
                    return r
                if first_4xx is not None:
                    return first_4xx
                return last_5xx

            for attempt_token in tokens:
                try:
                    resp = await _dial_workers(attempt_token)
                    if resp is None or resp.status_code != 200:
                        if resp is not None:
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
                                # roomID=Worker 个人房间
                                # （私聊直跳，Worker 容器不能接受邀请，
                                # 新建 DM 是死路）；runtime=CR 字段（runtime 徽章，
                                # 实锤：早期版本映射漏取，前端恒空）。
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
                    # working 标记已在 _dial_workers 成功路径完成
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
            # homeserver 也走 ordered failover（旧版
            # 单地址 homeservers2[0]=LAN IP 优先，切网窗口 100% 失败→空树+
            # 5s 负缓存，与 controller 侧同病灶）。30s 上限防长轮询挂死。
            matrix_cfg2 = cfg.get("matrix") or {}
            token2 = (matrix_cfg2.get("access_token") or "").strip()
            hs_urls = _ordered_addresses(cfg, "matrix")
            if hs_urls and token2:
                for homeserver2 in hs_urls:
                    try:
                        sync_resp = await asyncio.wait_for(
                            asyncio.to_thread(
                                matrix_client.sync,
                                homeserver2,
                                token2,
                                timeout_ms=0,
                                sync_filter=_SYNC_FILTER,
                            ),
                            timeout=30.0,
                        )
                        _mark_working("matrix", homeserver2)
                        parsed = _parse_sync_rooms(sync_resp, user_id)
                        tree = parsed["worker_tree"]
                        source = "room-fallback"
                        break
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "teams/structure fallback sync via %s failed: %s",
                            homeserver2,
                            exc,
                        )
            else:
                tree = []

        payload = {"ok": True, "tree": tree, "source": source}
        # 成功（controller-workers 源且非空树）享 60s
        # 正缓存；降级（room-fallback）或空树只负缓存 5s——token 未就绪 /
        # Controller 瞬时不可用时，5s 后手动刷新即重试（不锁死 60s）。
        struct_ttl = (
            _ROOMS_CACHE_TTL
            if source == "controller-workers" and tree
            else _STRUCTURE_NEGATIVE_TTL
        )
        with _rooms_cache_lock:
            _structure_cache["data"] = payload
            _structure_cache["ts"] = now
            _structure_cache["ttl"] = struct_ttl
        logger.info(
            "teams/structure: %d teams via %s (cache ttl=%.0fs)",
            len(tree),
            source,
            struct_ttl,
        )
        return payload

    return router
