from __future__ import annotations

import asyncio
import time

from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException

from .. import config as config_mod
from ..dial_gate import GatedAsyncClient
from ..router import (
    _BOOTSTRAP_SCAN_TTL,
    _headers_for,
    _ordered_addresses,
    _room_approvals_cache,
    _room_approvals_lock,
    _room_mentions_cache,
    _room_mentions_lock,
    _room_name_cache,
    _room_name_neg,
    _room_scan_state,
    _rooms_cache,
    _rooms_cache_lock,
    _scan_mark_full,
    _scan_should_full,
    logger,
)


def build_live_router() -> APIRouter:
    """实时缓冲域子路由（build_router 原段逐字搬移，任务 190）。"""
    router = APIRouter()
    # ── 房间通知（通知中心点击跳转=团队房间的 @提到我，
    # 宿主 inbox 事件无 room_id 是「点了不跳」的根因）──────────────

    @router.get("/room-mentions")
    async def room_mentions(limit: int = 30) -> Dict[str, Any]:
        """各房间最近 @提到当前用户 的消息（Element 通知同款语义）：
 v0.5.0-beta.12 = 实时缓冲（sync_watcher /sync 长轮询事件流即时写入，
 零扫描）+ 全量扫描历史（10s 缓存 bootstrap），event_id 去重合并，
 按时间倒序。前端在 SSE mention 事件触发刷新（非轮询）。
 点击 → 跳房间+定位事件。"""
        cfg = config_mod.load_config()
        matrix_cfg = cfg.get("matrix") or {}
        token = (matrix_cfg.get("access_token") or "").strip()
        user_id = (matrix_cfg.get("user_id") or "").strip()
        if not token:
            raise HTTPException(status_code=401, detail="未登录")
        localpart = user_id.lstrip("@").split(":")[0].lower()
        base = _ordered_addresses(cfg, "matrix")
        if not base:
            raise HTTPException(status_code=502, detail="未配置 Matrix 地址")
        from .. import sync_watcher  # noqa: PLC0415 — 实时 @我 缓冲
        homeserver = base[0]
        limit = max(1, min(int(limit), 100))
        # ① 实时缓冲（sync 事件流，房间名从 60s 房间缓存补全）
        with _rooms_cache_lock:
            _rd = (_rooms_cache.get("data") or {}).get("rooms") or []
        room_names: Dict[str, str] = {
            (r.get("room_id") or ""): (r.get("name") or "") for r in _rd
        }
        # 房间名兜底——同步缓冲的 mention 依赖 _rooms_cache（首次
        # /teams/sync 后才填充）；冷启动时按房间懒加载 m.room.name（永久缓存）。
        names: Dict[str, str] = dict(room_names)

        async def _ensure_room_name(room_id: str) -> str:
            nonlocal names
            if names.get(room_id):
                return names[room_id]
            _cached = _room_name_cache.get(room_id)
            if _cached:
                names[room_id] = _cached
                return _cached
            if _room_name_neg.get(room_id, 0.0) > time.time():
                return ""
            hs_base = homeserver.rstrip("/")
            try:
                async with GatedAsyncClient(timeout=8.0, verify=False) as c2:
                    # ① basic info（Tuwunel 实测部分房间 name=None）
                    nm = ""
                    try:
                        nresp = await c2.get(
                            f"{hs_base}/_matrix/client/v3/rooms/{room_id}",
                            headers=_headers_for(cfg, "matrix", hs_base,
                                {"Authorization": f"Bearer {token}"}),
                        )
                        if nresp.status_code == 200:
                            nm = str((nresp.json() or {}).get("name") or "")
                    except Exception:  # noqa: BLE001
                        pass
                    # ② state m.room.name（basic 无 name 时）
                    if not nm:
                        try:
                            sresp = await c2.get(
                                f"{hs_base}/_matrix/client/v3/rooms/{room_id}"
                                "/state/m.room.name",
                                headers=_headers_for(cfg, "matrix", hs_base,
                                {"Authorization": f"Bearer {token}"}),
                            )
                            if sresp.status_code == 200:
                                nm = str(
                                    ((sresp.json() or {}).get("content") or {})
                                    .get("name") or ""
                                )
                        except Exception:  # noqa: BLE001
                            pass
                    if nm:
                        names[room_id] = nm
                        if nm:
                            _room_name_cache[room_id] = nm
            except Exception:  # noqa: BLE001 — 取名失败不阻断
                pass
            if not names.get(room_id):
                _room_name_neg[room_id] = time.time() + 600.0
            return names.get(room_id, "")

        results: List[Dict[str, Any]] = []
        seen_eids: set = set()
        for m in sync_watcher.get_mention_buffer(limit):
            rid_m = str(m.get("room_id") or "")
            nm = names.get(rid_m) or ""
            if not nm:
                nm = await _ensure_room_name(rid_m)
            results.append({**m, "room_name": nm})
            if m.get("event_id"):
                seen_eids.add(m["event_id"])
        # ② 全量扫描历史（10s 缓存；缓存命中时零 HTTP）
        with _room_mentions_lock:
            scan_fresh = (time.time() - _room_mentions_cache["ts"]) < _BOOTSTRAP_SCAN_TTL
            scan_results = _room_mentions_cache["data"] if scan_fresh else None
        if scan_results is None:
            scan_results = []
            try:
                # self. 误写修复（build_router 内非类嵌套，无 self）——
                # FastAPI 把 self 当必传 query 参数 → 前端恒 422（真机反馈根因）。
                await _scan_room_mentions(
                    homeserver, token, user_id, localpart, scan_results,
                )
            except Exception as exc:  # noqa: BLE001
                # 扫描失败不阻断——实时缓冲仍是有效数据源
                logger.debug("room-mentions scan failed: %s", exc)
            with _room_mentions_lock:
                _room_mentions_cache.update(
                    {"data": scan_results, "ts": time.time()}
                )
        for r in scan_results:
            eid = r.get("event_id") or ""
            if eid and eid in seen_eids:
                continue
            if eid:
                seen_eids.add(eid)
            if not r.get("room_name"):
                r = {**r, "room_name": await _ensure_room_name(
                    str(r.get("room_id") or ""))}
            results.append(r)
        results.sort(key=lambda r: -(r.get("ts") or 0))
        return {"mentions": results[:limit], "count": len(results)}

    # ── 待工具审批请求（v0.5.0-beta.12：通知中心「待审批请求」数据源）────
    # Worker Tool Guard 审批请求不带 @人类 → /room-mentions 捞不到（用户
    # 真机缺陷「需要审批没有提示，只能在聊天群看见」根因）。数据源：
    # 实时缓冲（sync_watcher /sync 事件流）+ 全量扫描历史（10s 缓存
    # bootstrap，捞插件关闭期间的未决请求）。状态机：审批请求消息入列，
    # 其后同房间 /approval 命令消息弹最早一条；只留未决。

    @router.get("/room-approvals")
    async def room_approvals(limit: int = 30) -> Dict[str, Any]:
        cfg = config_mod.load_config()
        matrix_cfg = cfg.get("matrix") or {}
        token = (matrix_cfg.get("access_token") or "").strip()
        if not token:
            raise HTTPException(status_code=401, detail="未登录")
        base = _ordered_addresses(cfg, "matrix")
        if not base:
            raise HTTPException(status_code=502, detail="未配置 Matrix 地址")
        from .. import sync_watcher  # noqa: PLC0415 — 实时审批缓冲
        homeserver = base[0]
        limit = max(1, min(int(limit), 100))
        # ① 实时缓冲（房间名从 60s 房间缓存补全，冷启动懒加载兜底）。
        with _rooms_cache_lock:
            _rd = (_rooms_cache.get("data") or {}).get("rooms") or []
        names: Dict[str, str] = {
            (r.get("room_id") or ""): (r.get("name") or "") for r in _rd
        }
        buffer = sync_watcher.get_approval_buffer(limit)
        await _resolve_missing_room_names(
            homeserver, token, names,
            [str(a.get("room_id") or "") for a in buffer],
        )
        results: List[Dict[str, Any]] = []
        seen_eids: set = set()
        for a in buffer:
            rid_a = str(a.get("room_id") or "")
            results.append({**a, "room_name": names.get(rid_a, "")})
            if a.get("event_id"):
                seen_eids.add(a["event_id"])
        # ② 全量扫描历史（10s 缓存；缓存命中时零 HTTP）。
        with _room_approvals_lock:
            scan_fresh = (time.time() - _room_approvals_cache["ts"]) < _BOOTSTRAP_SCAN_TTL
            scan_results = (
                _room_approvals_cache["data"] if scan_fresh else None
            )
        if scan_results is None:
            scan_results = []
            try:
                await _scan_room_approvals(homeserver, token, scan_results)
            except Exception as exc:  # noqa: BLE001 — 扫描失败不阻断
                logger.debug("room-approvals scan failed: %s", exc)
            with _room_approvals_lock:
                _room_approvals_cache.update(
                    {"data": scan_results, "ts": time.time()}
                )
        for r in scan_results:
            eid = r.get("event_id") or ""
            if eid and eid in seen_eids:
                continue
            if eid:
                seen_eids.add(eid)
            rid = str(r.get("room_id") or "")
            if rid and not r.get("room_name") and not names.get(rid):
                await _resolve_missing_room_names(homeserver, token, names, [rid])
            results.append({**r, "room_name": names.get(rid, "")})
        results.sort(key=lambda r: -(r.get("ts") or 0))
        return {"approvals": results[:limit], "count": len(results)}

    # ── v0.5.0-beta.12 宿主收件箱审批桥状态（调试/selfcheck 用）──
    @router.get("/host-bridge/status")
    async def host_bridge_status() -> Dict[str, Any]:
        """宿主审批桥可用性 + 在途/累计计数。available=false → 宿主
 无 create_pending_summary（<2.1），抖动/审批条目不可用，页面内
 审批卡不受影响。"""
        from agentteams_connector import host_bridge

        return host_bridge.bridge.status()

    async def _resolve_missing_room_names(
        homeserver: str,
        token: str,
        names: Dict[str, str],
        room_ids: List[str],
    ) -> Dict[str, str]:
        """房间名懒加载兜底（basic info + m.room.name state，/room-mentions
 内部同款两路取值；取不到保持空串，前端回退显示 room_id）。"""
        for rid in room_ids:
            if not rid or names.get(rid):
                continue
            _cached = _room_name_cache.get(rid)
            if _cached:
                names[rid] = _cached
                continue
            if _room_name_neg.get(rid, 0.0) > time.time():
                continue
            hs_base = homeserver.rstrip("/")
            nm = ""
            try:
                async with GatedAsyncClient(timeout=8.0, verify=False) as c2:
                    try:
                        nresp = await c2.get(
                            f"{hs_base}/_matrix/client/v3/rooms/{rid}",
                            headers=_headers_for(cfg, "matrix", hs_base,
                                {"Authorization": f"Bearer {token}"}),
                        )
                        if nresp.status_code == 200:
                            nm = str((nresp.json() or {}).get("name") or "")
                    except Exception:  # noqa: BLE001
                        pass
                    if not nm:
                        try:
                            sresp = await c2.get(
                                f"{hs_base}/_matrix/client/v3/rooms/{rid}"
                                "/state/m.room.name",
                                headers=_headers_for(cfg, "matrix", hs_base,
                                {"Authorization": f"Bearer {token}"}),
                            )
                            if sresp.status_code == 200:
                                nm = str(
                                    ((sresp.json() or {}).get("content") or {})
                                    .get("name") or ""
                                )
                        except Exception:  # noqa: BLE001
                            pass
            except Exception:  # noqa: BLE001 — 取名失败不阻断
                pass
            if nm:
                names[rid] = nm
                _room_name_cache[rid] = nm
            else:
                _room_name_neg[rid] = time.time() + 600.0
        return names

    async def _scan_room_approvals(
        homeserver: str,
        token: str,
        scan_results: List[Dict[str, Any]],
    ) -> None:
        """审批状态机扫描（v0.5.0-beta.12 全量加入；v0.5.0-beta.14.7 T6：
 增量——只重扫 sync 事件流显示有推进的房间，空闲零拨号；600s 兜底
 全扫一次）。时间升序执行（dir=b 返回新→旧，先 reverse）。"""
        import urllib.parse as _up
        from .. import sync_watcher  # noqa: PLC0415
        try:
            async with GatedAsyncClient(timeout=20.0, verify=False) as client:
                # v0.5.0-beta.14.18：与全族一致走 _headers_for（该 matrix 地址
                # 若配了覆盖凭据则替换，未配则原样 Bearer）——防公网 matrix
                # 网关 Basic 门场景 401（与 docker_logs 同族缺口）。
                headers = _headers_for(
                    config_mod.load_config(), "matrix", homeserver,
                    {"Authorization": f"Bearer {token}"},
                )
                jresp = await client.get(
                    f"{homeserver.rstrip('/')}/_matrix/client/v3/joined_rooms",
                    headers=headers,
                )
                if jresp.status_code != 200:
                    raise HTTPException(
                        status_code=502,
                        detail=f"房间列表获取失败（{jresp.status_code}）",
                    )
                room_ids: List[str] = (
                    (jresp.json() or {}).get("joined_rooms", [])
                )
                # 最多扫 40 房 × 40 条近期消息（并发 8，局域网 <2s）。
                sem = asyncio.Semaphore(8)
                st_all = _room_scan_state["approvals"]
                full = _scan_should_full("approvals")

                async def scan(room_id: str) -> None:
                    async with sem:
                        st = st_all.get(room_id)
                        if (
                            not full
                            and st is not None
                            and sync_watcher.room_last_ts(room_id)
                            <= st.get("ts", 0)
                        ):
                            # T6：无推进 → 复用上次条目（零 /messages 拨号）。
                            scan_results.extend(st.get("entries") or [])
                            return
                        pending: List[Dict[str, Any]] = []
                        try:
                            mresp = await client.get(
                                f"{homeserver.rstrip('/')}"
                                f"/_matrix/client/v3/rooms/"
                                f"{_up.quote(room_id, safe='')}/messages?"
                                + _up.urlencode({"dir": "b", "limit": 40}),
                                headers=headers,
                            )
                            if mresp.status_code != 200:
                                return
                            events = ((mresp.json() or {}).get("chunk") or [])
                            evs = [
                                e for e in reversed(list(events))
                                if isinstance(e, dict)
                            ]
                            newest = 0
                            for e in evs:
                                _ev_ts = int(e.get("origin_server_ts") or 0)
                                if _ev_ts > newest:
                                    newest = _ev_ts
                                if e.get("type") != "m.room.message":
                                    continue
                                content = e.get("content") or {}
                                if (
                                    not isinstance(content, dict)
                                    or content.get("m.new_content")
                                ):
                                    continue
                                body = str(content.get("body") or "")
                                ap = sync_watcher.parse_approval_request(body)
                                if ap:
                                    pending.append(
                                        {
                                            "room_id": room_id,
                                            "event_id": str(
                                                e.get("event_id") or ""
                                            ),
                                            "sender": str(
                                                e.get("sender") or ""
                                            ),
                                            "body": body[:200],
                                            "ts": int(
                                                e.get("origin_server_ts")
                                                or 0
                                            ),
                                            "kind": ap[0],
                                            "approve_cmd": ap[1],
                                            "deny_cmd": ap[2],
                                        }
                                    )
                                elif sync_watcher._is_approval_command(body):
                                    if pending:
                                        pending.pop(0)
                            st_all[room_id] = {
                                "ts": max(
                                    newest,
                                    sync_watcher.room_last_ts(room_id),
                                ),
                                "entries": pending,
                            }
                            scan_results.extend(pending)
                        except Exception:  # noqa: BLE001 — 单房失败不阻断
                            pass

                await asyncio.gather(*(scan(r) for r in room_ids[:40]))
        except Exception:
            raise
        if full:
            _scan_mark_full("approvals")

    async def _scan_room_mentions(
        homeserver: str,
        token: str,
        user_id: str,
        localpart: str,
        scan_results: List[Dict[str, Any]],
    ) -> None:
        """房间 @我 扫描（v0.5.0-beta.12 全量加入；v0.5.0-beta.14.7 T6：
 增量——只重扫 sync 事件流显示有推进的房间，空闲零拨号；600s 兜底
 全扫一次）。"""
        import urllib.parse as _up
        from .. import sync_watcher  # noqa: PLC0415 — T6 增量探针
        try:
            async with GatedAsyncClient(
                timeout=20.0, verify=False
            ) as client:
                headers = _headers_for(
                    config_mod.load_config(), "matrix", homeserver,
                    {"Authorization": f"Bearer {token}"},
                )
                jresp = await client.get(
                    f"{homeserver.rstrip('/')}/_matrix/client/v3/joined_rooms",
                    headers=headers,
                )
                if jresp.status_code != 200:
                    raise HTTPException(
                        status_code=502,
                        detail=f"房间列表获取失败（{jresp.status_code}）",
                    )
                room_ids: List[str] = (jresp.json() or {}).get("joined_rooms", [])
                # 最多扫 40 房 × 12 条近期消息（并发 8，局域网 <2s）。
                sem = asyncio.Semaphore(8)
                st_all = _room_scan_state["mentions"]
                full = _scan_should_full("mentions")

                async def scan(room_id: str) -> None:
                    async with sem:
                        st = st_all.get(room_id)
                        if (
                            not full
                            and st is not None
                            and sync_watcher.room_last_ts(room_id)
                            <= st.get("ts", 0)
                        ):
                            # T6：无推进 → 复用上次条目（零 /messages 拨号）。
                            scan_results.extend(st.get("entries") or [])
                            return
                        entries: List[Dict[str, Any]] = []
                        try:
                            mresp = await client.get(
                                f"{homeserver.rstrip('/')}/_matrix/client/v3/rooms/"
                                f"{_up.quote(room_id, safe='')}/messages",
                                params={"dir": "b", "limit": 12},
                                headers=headers,
                            )
                            if mresp.status_code != 200:
                                return
                            data = mresp.json() or {}
                            room_name = ""
                            for ev in data.get("state", []) or []:
                                if ev.get("type") == "m.room.name":
                                    room_name = str(
                                        (ev.get("content") or {}).get("name") or ""
                                    )
                                    break
                            newest = 0
                            for ev in data.get("chunk", []) or []:
                                _ev_ts = int(ev.get("origin_server_ts") or 0)
                                if _ev_ts > newest:
                                    newest = _ev_ts
                                et = ev.get("type")
                                content = ev.get("content") or {}
                                sender = ev.get("sender") or ""
                                if et != "m.room.message":
                                    continue
                                if sender == user_id:
                                    continue
                                mentioned = False
                                m_users = (content.get("m.mentions") or {}).get(
                                    "user_ids", []
                                ) or []
                                if user_id in m_users:
                                    mentioned = True
                                body = str(content.get("body") or "")
                                if not mentioned and localpart:
                                    low = body[:300].lower()
                                    if f"@{localpart}" in low:
                                        mentioned = True
                                if not mentioned:
                                    continue
                                entries.append(
                                    {
                                        "room_id": room_id,
                                        "room_name": room_name,
                                        "event_id": ev.get("event_id") or "",
                                        "sender": sender,
                                        "body": body[:200],
                                        "ts": int(content.get("origin_server_ts")
                                                    or ev.get("origin_server_ts")
                                                    or 0),
                                    }
                                )
                            st_all[room_id] = {
                                "ts": max(
                                    newest,
                                    sync_watcher.room_last_ts(room_id),
                                ),
                                "entries": entries,
                            }
                            scan_results.extend(entries)
                        except Exception:  # noqa: BLE001 — 单房失败不阻断
                            pass

                await asyncio.gather(
                    *(scan(rid) for rid in room_ids[:40])
                )
        except HTTPException:
            raise
        except Exception:  # noqa: BLE001
            raise  # 调用方 catch 后仅记日志（实时缓冲不受影响）
        if full:
            _scan_mark_full("mentions")

    return router
