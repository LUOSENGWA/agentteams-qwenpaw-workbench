# -*- coding: utf-8 -*-
"""插件存储域（聊天消息 SQLite：读写 + 容量状态 + 整理）。

设计依据：方案与设计/AgentTeams/下版本1.2.6-1.2.7/10-客户端同步与缓存/
QwenPaw插件存储与缓存-设计-20261107.md §3/§4/§6。

- ``GET    /storage/chat/{room_id}?limit=500`` → ``{messages, end}``
  （最近 N 条，默认/最大 500；无房 → ``{messages: [], end: null}``，200 不 404）；
- ``GET    /storage/chat/{room_id}?event_id=..&before=25&after=25`` →
  目标消息前后各 N 条（升序，含目标）——「加载原消息」按需取窗口，
  免拉整窗；
- ``PUT    /storage/chat/{room_id}`` body ``{messages, end?}`` →
  ``{ok, count}``（按 ``event_id`` 增量 upsert，**不截断历史**）；
- ``DELETE /storage/chat/{room_id}`` → ``{ok: true}``；
- ``GET    /storage/state`` → 三类缓存字节数 + 容量上限；
- ``POST   /storage/prune`` → 全局 LRU 整理 ``{removedFiles, freedBytes}``。

落盘 = ``<workspace>/.qwenpaw/agentteams/cache/chat.db``（SQLite 单库，
永久保留；总量 >2GB 按房间 LRU 淘汰）。前端不直接读写磁盘，全部经本域
（浏览器沙箱）。
"""
from __future__ import annotations

import asyncio
import threading

from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException

from ..sync_store import (
    MAX_CHAT_MESSAGES,
    MAX_CHAT_TOTAL_BYTES,
    SyncStore,
)

# room_id 路径参数长度上限（防超长文件名/异常载荷；合法 Matrix room id
# 远小于此）。非法 → 400。
MAX_ROOM_ID_LEN = 256

# 每个同步根一个 SyncStore（进程级缓存）：聊天库是持久 SQLite 连接，
# 若每请求新建实例会同号连接/句柄无限增长（挂载上 fd 泄漏代价极高）。
_STORES: Dict[str, SyncStore] = {}
_STORES_LOCK = threading.Lock()


def _store() -> SyncStore:
    """当前工作区的同步根存储（进程内按根复用；测试可整体替换本函数）。"""
    from ..file_sync_engine import resolve_workspace_root

    root = Path(resolve_workspace_root())
    key = str(root)
    with _STORES_LOCK:
        store = _STORES.get(key)
        if store is None:
            store = SyncStore(root)
            store.ensure_dirs()
            _STORES[key] = store
        return store


def _dir_bytes(directory: Path) -> int:
    """目录内文件字节数汇总（缺失/读失败 → 0，状态面不抛）。"""
    total = 0
    try:
        for p in directory.glob("*"):
            try:
                if p.is_file():
                    total += p.stat().st_size
            except OSError:
                continue
    except Exception:  # noqa: BLE001
        return 0
    return total


def _room_id_or_400(room_id: str) -> str:
    """room_id 校验：非空且 ≤256（非法 → 400 invalid_room_id）。"""
    rid = (room_id or "").strip()
    if not rid or len(rid) > MAX_ROOM_ID_LEN:
        raise HTTPException(
            status_code=400,
            detail={"error": "invalid_room_id"},
        )
    return rid


def build_storage_router() -> APIRouter:
    router = APIRouter()

    @router.get("/storage/chat/{room_id}")
    async def storage_chat_get(
        room_id: str,
        limit: int = MAX_CHAT_MESSAGES,
        event_id: Optional[str] = None,
        before: int = 25,
        after: int = 25,
    ) -> Dict[str, Any]:
        """读房间消息：默认最近 ``limit`` 条；给 ``event_id`` 则取目标窗口。

        无房/无目标 → ``{messages: [], end: null}``（200，不 404）。
        """
        rid = _room_id_or_400(room_id)
        store = _store()
        target = (event_id or "").strip()
        if target:
            win = await asyncio.to_thread(
                store.chat_window,
                rid,
                target,
                max(0, min(int(before), MAX_CHAT_MESSAGES)),
                max(0, min(int(after), MAX_CHAT_MESSAGES)),
            )
            if not win:
                return {"messages": [], "end": None}
            return {"messages": win.get("messages") or [], "end": win.get("end")}
        lim = max(0, min(int(limit), MAX_CHAT_MESSAGES))
        cached = await asyncio.to_thread(store.chat_get, rid, lim)
        if not cached:
            return {"messages": [], "end": None}
        return {"messages": cached.get("messages") or [], "end": cached.get("end")}

    @router.put("/storage/chat/{room_id}")
    async def storage_chat_put(
        room_id: str, body: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """增量 upsert（按 event_id 去重，不截断历史）；写失败 → 503。"""
        rid = _room_id_or_400(room_id)
        body = body or {}
        messages = body.get("messages")
        if not isinstance(messages, list):
            raise HTTPException(
                status_code=400, detail={"error": "invalid_body", "key": "messages"}
            )
        end = body.get("end")
        if end is not None and not isinstance(end, str):
            raise HTTPException(
                status_code=400, detail={"error": "invalid_body", "key": "end"}
            )
        store = _store()
        try:
            count = await asyncio.to_thread(store.chat_put, rid, messages, end=end)
        except Exception:  # noqa: BLE001 - 磁盘不可写 → 503（前端静默降级）
            raise HTTPException(
                status_code=503, detail={"error": "storage_unavailable"}
            )
        return {"ok": True, "count": int(count)}

    @router.delete("/storage/chat/{room_id}")
    async def storage_chat_delete(room_id: str) -> Dict[str, Any]:
        """删单房消息（幂等：缺失也是 ok）。"""
        rid = _room_id_or_400(room_id)
        store = _store()
        await asyncio.to_thread(store.chat_drop, rid)
        return {"ok": True}

    @router.get("/storage/state")
    async def storage_state() -> Dict[str, Any]:
        """缓存现状（chat.db 字节 + http/lru 目录字节）+ 容量上限。"""
        store = _store()

        def _snapshot() -> Dict[str, int]:
            return {
                "chatBytes": store.chat_bytes(),
                "httpBytes": _dir_bytes(store.http_dir),
                "lruBytes": _dir_bytes(store.lru_dir),
            }

        cache = await asyncio.to_thread(_snapshot)
        return {
            "cache": cache,
            "limits": {
                # 单次 GET 窗口上限（历史永久保留，非每房截断）
                "chatMessages": MAX_CHAT_MESSAGES,
                "chatBytes": MAX_CHAT_TOTAL_BYTES,
            },
        }

    @router.post("/storage/prune")
    async def storage_prune() -> Dict[str, Any]:
        """触发全局容量整理（库 >2GB 时按 rooms.last_access LRU 整房淘汰）。"""
        store = _store()
        try:
            return await asyncio.to_thread(store.chat_prune)
        except Exception:  # noqa: BLE001 - 整理失败不炸路由
            return {"removedFiles": 0, "freedBytes": 0}

    return router
