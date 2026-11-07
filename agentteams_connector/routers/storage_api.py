# -*- coding: utf-8 -*-
"""插件存储域（聊天缓存磁盘化：读写 + 容量状态 + 整理）。

设计依据：方案与设计/AgentTeams/下版本1.2.6-1.2.7/10-客户端同步与缓存/
QwenPaw插件存储与缓存-设计-20261107.md §3/§4/§6。

- ``GET    /storage/chat/{room_id}?limit=500`` → ``{messages, end}``
  （无缓存 → ``{messages: [], end: null}``，200 不 404）；
- ``PUT    /storage/chat/{room_id}`` body ``{messages, end?}`` →
  ``{ok, count}``（服务端截断到 500 条，保留最新）；
- ``DELETE /storage/chat/{room_id}`` → ``{ok: true}``；
- ``GET    /storage/state`` → 三类缓存字节数 + 容量上限；
- ``POST   /storage/prune`` → chat 容量整理 ``{removedFiles, freedBytes}``。

落盘 = ``<workspace>/.qwenpaw/agentteams/cache/chat/<roomId>.json``
（SyncStore，原子写）。前端不直接读写磁盘，全部经本域（浏览器沙箱）。
"""
from __future__ import annotations

import asyncio

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


def _store() -> SyncStore:
    """当前工作区的同步根存储（惰性建目录；测试可整体替换本函数）。"""
    from ..file_sync_engine import resolve_workspace_root

    store = SyncStore(resolve_workspace_root())
    store.ensure_dirs()
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
        room_id: str, limit: int = MAX_CHAT_MESSAGES
    ) -> Dict[str, Any]:
        """读单房窗口（默认整窗 500 条；无缓存 → 空窗口 200）。"""
        rid = _room_id_or_400(room_id)
        lim = max(0, min(int(limit), MAX_CHAT_MESSAGES))
        store = _store()
        cached = await asyncio.to_thread(store.chat_get, rid)
        if not cached:
            return {"messages": [], "end": None}
        msgs = cached.get("messages") or []
        if lim < len(msgs):
            msgs = msgs[-lim:] if lim else []
        return {"messages": msgs, "end": cached.get("end")}

    @router.put("/storage/chat/{room_id}")
    async def storage_chat_put(
        room_id: str, body: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """整窗覆盖写（服务端截断到最新 500 条；写失败 → 503）。"""
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
        expected = min(len(messages), MAX_CHAT_MESSAGES)
        store = _store()
        try:
            count = await asyncio.to_thread(store.chat_put, rid, messages, end=end)
        except Exception:  # noqa: BLE001 - 磁盘不可写 → 503（前端静默降级）
            count = -1
        if count != expected:
            raise HTTPException(
                status_code=503, detail={"error": "storage_unavailable"}
            )
        return {"ok": True, "count": count}

    @router.delete("/storage/chat/{room_id}")
    async def storage_chat_delete(room_id: str) -> Dict[str, Any]:
        """删单房缓存（幂等：缺失也是 ok）。"""
        rid = _room_id_or_400(room_id)
        store = _store()
        await asyncio.to_thread(store.chat_drop, rid)
        return {"ok": True}

    @router.get("/storage/state")
    async def storage_state() -> Dict[str, Any]:
        """缓存现状（三类目录字节汇总）+ 容量上限（设计 §5）。"""
        store = _store()

        def _snapshot() -> Dict[str, int]:
            return {
                "chatBytes": _dir_bytes(store.chat_dir),
                "httpBytes": _dir_bytes(store.http_dir),
                "lruBytes": _dir_bytes(store.lru_dir),
            }

        cache = await asyncio.to_thread(_snapshot)
        return {
            "cache": cache,
            "limits": {
                "chatMessages": MAX_CHAT_MESSAGES,
                "chatBytes": MAX_CHAT_TOTAL_BYTES,
            },
        }

    @router.post("/storage/prune")
    async def storage_prune() -> Dict[str, Any]:
        """触发 chat 容量整理（房间数 / 总量 LRU 淘汰）。"""
        store = _store()
        try:
            return await asyncio.to_thread(store.chat_prune)
        except Exception:  # noqa: BLE001 - 整理失败不炸路由
            return {"removedFiles": 0, "freedBytes": 0}

    return router
