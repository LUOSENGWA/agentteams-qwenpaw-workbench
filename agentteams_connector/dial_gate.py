# -*- coding: utf-8 -*-
"""全局拨号闸门与计数（v0.5.0-beta.14.6，R3/R7）。

背景：插件所有出站 HTTP（异步 httpx.AsyncClient / matrix_client 同步
httpx.Client / selfcheck 探针）此前无全局并发上限——「点开全部 tab」时
各端点并发相加，叠加 WAN 时延造成负载尖峰。本模块提供：

- ``GatedAsyncClient``：httpx.AsyncClient 子类，send() 过全局信号量；
  连接器内所有异步拨号必须使用本类（tests/test_dial_gate_14_6.py 有静态
  护栏：connector 源码不允许残留裸 ``httpx.AsyncClient(``）。
- ``sync_dial_slot()``：同步拨号闸门（threading.BoundedSemaphore）——
  matrix_client / selfcheck 的同步 httpx.Client 包一层即可。
- ``should_failover_status()``：地址级 failover 判定（R4）——仅地址相关
  或瞬时错误换下一地址；确定性 4xx（400/404/405/409/410/422…）不换。
- ``dial_stats()``：R7 计数快照（总次数/在飞与峰值/按路径 Top-N），经
  ``GET /debug/dial-stats`` 暴露，供修复验收与排障对账。

上限可经环境变量调整（部署/测试）：AGENTTEAMS_DIAL_CAP（异步，默认
24）、AGENTTEAMS_DIAL_CAP_SYNC（同步，默认 8）。
"""
from __future__ import annotations

import asyncio
import contextlib
import os
import threading
from collections import Counter
from typing import Any, Dict, Iterator, List, Optional

import httpx

_DEFAULT_ASYNC_CAP = 24
_DEFAULT_SYNC_CAP = 8
# 地址相关/瞬时 4xx：这类错误换下一地址有意义（网关门/限流/超时重试）。
_ADDRESS_LEVEL_4XX = frozenset({401, 403, 408, 429})


def _async_cap() -> int:
    try:
        v = int(os.environ.get("AGENTTEAMS_DIAL_CAP", "") or _DEFAULT_ASYNC_CAP)
    except ValueError:
        v = _DEFAULT_ASYNC_CAP
    return max(1, v)


def _sync_cap() -> int:
    try:
        v = int(
            os.environ.get("AGENTTEAMS_DIAL_CAP_SYNC", "") or _DEFAULT_SYNC_CAP
        )
    except ValueError:
        v = _DEFAULT_SYNC_CAP
    return max(1, v)


_lock = threading.Lock()
_async_sem: Optional[asyncio.Semaphore] = None
_async_sem_loop: Optional[asyncio.AbstractEventLoop] = None
_sync_sem: Optional[threading.BoundedSemaphore] = None
_stats: Dict[str, Any] = {
    "async_total": 0,
    "async_inflight": 0,
    "async_peak": 0,
    "async_paths": Counter(),
    # v0.5.0-beta.14.7：bytes 计量——计数之外再记响应字节（带宽验收对账）。
    "async_bytes": 0,
    "async_path_bytes": Counter(),
    "sync_total": 0,
}


def _get_async_sem() -> asyncio.Semaphore:
    """按事件循环惰性建信号量（测试逐 loop 重建；生产单 loop 稳定）。"""
    global _async_sem, _async_sem_loop
    loop = asyncio.get_running_loop()
    if _async_sem is None or _async_sem_loop is not loop:
        _async_sem = asyncio.Semaphore(_async_cap())
        _async_sem_loop = loop
    return _async_sem


def _get_sync_sem() -> threading.BoundedSemaphore:
    global _sync_sem
    with _lock:
        if _sync_sem is None:
            _sync_sem = threading.BoundedSemaphore(_sync_cap())
        return _sync_sem


def _enter(kind: str, path: str) -> None:
    with _lock:
        if kind == "async":
            _stats["async_total"] += 1
            _stats["async_inflight"] += 1
            if _stats["async_inflight"] > _stats["async_peak"]:
                _stats["async_peak"] = _stats["async_inflight"]
            if path:
                _stats["async_paths"][path] += 1
        else:
            _stats["sync_total"] += 1


def _exit(kind: str) -> None:
    with _lock:
        if kind == "async":
            _stats["async_inflight"] -= 1


def _record_bytes(path: str, n: int) -> None:
    """v0.5.0-beta.14.7：响应字节累计（总计数 + 按路径，供 top_paths 对账）。"""
    if not path or n <= 0:
        return
    with _lock:
        _stats["async_bytes"] += n
        _stats["async_path_bytes"][path] += n


class GatedAsyncClient(httpx.AsyncClient):
    """httpx.AsyncClient + 全局拨号闸门 + 计数（R3/R7）。

    ``send()`` 覆盖「非流式」请求的完整生命周期；流式读取（若将来出现）
    在 headers 阶段放行——当前无此类用法（房间 SSE 是服务端出向流）。
    """

    async def send(self, request: httpx.Request, **kwargs: Any) -> httpx.Response:
        sem = _get_async_sem()
        async with sem:
            _enter("async", str(request.url.path))
            try:
                resp = await super().send(request, **kwargs)
                # v0.5.0-beta.14.7：响应字节计量（失败/流式不记，不致命）。
                try:
                    _record_bytes(str(request.url.path), len(resp.content))
                except Exception:
                    pass
                return resp
            finally:
                _exit("async")


@contextlib.contextmanager
def sync_dial_slot() -> Iterator[None]:
    """同步拨号闸门：``with sync_dial_slot(), httpx.Client(...) as c:``。"""
    sem = _get_sync_sem()
    sem.acquire()
    _enter("sync", "")
    try:
        yield
    finally:
        _exit("sync")
        sem.release()


def should_failover_status(status: int) -> bool:
    """地址级 failover 判定（R4）：仅地址相关/瞬时错误可换下一地址，
    确定性 4xx（400/404/405/409/410/422…）地址无关 → 不换。"""
    if status in _ADDRESS_LEVEL_4XX:
        return True
    return status >= 500


def dial_stats() -> Dict[str, Any]:
    """计数快照（R7）：供 GET /debug/dial-stats 与测试对账。"""
    with _lock:
        # v0.5.0-beta.14.7：top 20→100（带宽排障要看全路径分布）+ 每项 bytes。
        top: List[Any] = _stats["async_paths"].most_common(100)
        return {
            "async": {
                "cap": _async_cap(),
                "total": _stats["async_total"],
                "inflight": _stats["async_inflight"],
                "peak": _stats["async_peak"],
                "bytes_total": _stats["async_bytes"],
                "top_paths": [
                    {"path": p, "count": c, "bytes": _stats["async_path_bytes"].get(p, 0)}
                    for p, c in top
                ],
            },
            "sync": {"cap": _sync_cap(), "total": _stats["sync_total"]},
        }


def _reset_for_tests() -> None:
    """仅测试用：清空信号量与计数（每个测试独立起步）。"""
    global _async_sem, _async_sem_loop, _sync_sem
    with _lock:
        _async_sem = None
        _async_sem_loop = None
        _sync_sem = None
        _stats.update(
            {
                "async_total": 0,
                "async_inflight": 0,
                "async_peak": 0,
                "async_paths": Counter(),
                "async_bytes": 0,
                "async_path_bytes": Counter(),
                "sync_total": 0,
            }
        )
