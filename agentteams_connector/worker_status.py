# -*- coding: utf-8 -*-
"""v0.5.0-beta.14.9：Worker session 状态聚合器。

背景：前端每 30s 对全部 worker 逐一打 /workers/{name}/chats（~25 路扇出，
尾延迟 6-9s，多窗口各打一份）。改为连接器侧单点后台扫描 + 聚合缓存，
前端经单端点 /workers-status 一次拿全量（多窗口共享同一份缓存）。

设计（照 address_probe 的任务生命周期模式：start/stop + stop_event +
asyncio task）：

- tick 30s；sweep: GET /api/v1/workers（列名，60s 缓存）→ 逐个
 /workers/{name}/chats → 归约 {running, lastUpdated}（判据与前端原实现
 一致：status==="running"；updated_at→epoch ms 取最大）。
- 失败保旧值；新 worker 下轮进、消失的下轮清（以本轮名单为准）。
- 扫描并发 4（Semaphore；拨号走 GatedAsyncClient 全局闸门）。
- 单飞：扫描中不重入；ensure_fresh fire-and-forget（端点路径零等待）；
 stop 优雅退出。
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

from . import config as config_mod
from . import router as router_mod
# v0.5.0-beta.14.13：GatedAsyncClient/should_failover_status 随
# _ctl_get 实现体迁入 ctl_client，本模块仅剩 bg_slot（后台共用通道）。
from .dial_gate import bg_slot

logger = logging.getLogger(
    "qwenpaw.plugins.agentteams_qwenpaw_workbench.worker_status"
)

_TICK = 30.0  # 后台 tick 周期（秒）
_TTL = 30.0  # 快照新鲜度阈值（ensure_fresh 判据）
_NAMES_TTL = 60.0  # worker 名单缓存（roster 变化慢，60s 够用）
_CONCURRENCY = 4  # 扫描并发（与旧前端扇出同档）
_STARTUP_DELAY = 3.0  # 启动让行（address_probe 同款，不抢宿主启动网络）

_agg: Dict[str, Any] = {"workers": {}, "scan_at": 0.0, "scanning": False}
_names_cache: Dict[str, Any] = {"names": [], "ts": 0.0}

_task: Optional[asyncio.Task] = None
_stop_event = asyncio.Event()


def snapshot() -> Dict[str, Any]:
    """当前聚合快照（端点直读；不触发扫描）。"""
    return {
        "ok": True,
        "workers": _agg["workers"],
        "scanAt": int(_agg["scan_at"]),
        "scanning": bool(_agg["scanning"]),
    }


def ensure_fresh(force: bool = False) -> None:
    """过期（或 force=True 无视 TTL，v0.5.0-beta.14.12 手动刷新用）且未
 扫描中 → 起后台扫描（fire-and-forget；端点路径零等待）。"""
    if _agg["scanning"]:
        return
    if not force and time.time() - _agg["scan_at"] < _TTL:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # 当前上下文无运行事件循环（异常调用路径）→ 忽略，下轮 tick/
        # 端点重试（本函数承诺非阻塞、不抛；先查循环再建协程，
        # 避免留下未 await 的悬挂 coroutine 警告）。
        logger.debug("ensure_fresh: no running event loop, skip")
        return
    loop.create_task(_sweep())


async def _ctl_get(url: str, token: str) -> tuple:
    """薄包装 → ctl_client.ctl_json("GET", …)（v0.5.0-beta.14.13 去重）。

 保持本名 = projects_workflow 与测试的既有取数注入点（测试 monkeypatch
 本函数，不碰真实网络；签名与语义不变）。
 """
    from . import ctl_client  # noqa: PLC0415
    return await ctl_client.ctl_json("GET", url, token)


def _ts_ms(value: Any) -> int:
    """updated_at → epoch ms（不可解析 → 0；与前端 Date.parse 判据一致）。"""
    if not value:
        return 0
    s = str(value).strip()
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.astimezone()
        return int(dt.timestamp() * 1000)
    except ValueError:
        return 0


async def _sweep() -> None:
    """单飞门 + 后台共用通道（v0.5.0-beta.14.12，）。

 前台忙（拨号 inflight > 12）让权、等共用锁超 90s 放弃本轮（下一
 tick 重试）；扫描体持共用锁——同一时刻至多一路后台扫描在跑
 （与 projects_workflow / KB 刷新共享，防齐发打满闸门抢前台）。
 """
    if _agg["scanning"]:
        return  # 单飞：扫描中不重入
    _agg["scanning"] = True
    try:
        async with bg_slot() as _bg:
            if not _bg:
                return  # 让权/放弃 → 本轮不动（保旧值，下一 tick 重试）
            await _do_sweep()
    except Exception:  # noqa: BLE001 - 后台循环不得因单轮异常死掉
        logger.warning("worker_status sweep failed", exc_info=True)
    finally:
        _agg["scanning"] = False


async def _do_sweep() -> None:
    """一轮全扫：名单（60s 缓存）→ 逐 worker /chats（并发 4）→ 归约。

 保旧语义：单 worker 失败 → 该 worker 保旧值（无旧值则本轮缺省）；
 名单级失败（token/网络/空名单）→ 整表不动。新 worker 成功即进，
 消失的 worker（不在本轮名单）随新表清掉。
 """
    cfg = config_mod.load_config()
    try:
        token, _src = router_mod._resolve_controller_token(cfg)
    except Exception:  # noqa: BLE001 - token 内容非法 → 本轮不拨
        logger.info("worker_status sweep: controller token 解析失败，跳过本轮")
        return
    if not token:
        return  # 无 token → 不拨号（保旧表）

    base_urls = router_mod._ordered_addresses(cfg, "controller")
    if not base_urls:
        return  # 未配置 controller → 保旧表
    base = base_urls[0].rstrip("/")

    # 1) 名单：60s 缓存未过期且非空 → 直接用。
    names: List[str]
    if time.time() - _names_cache["ts"] < _NAMES_TTL and _names_cache["names"]:
        names = list(_names_cache["names"])
    else:
        st, data, _text = await _ctl_get(f"{base}/api/v1/workers", token)
        if st != 200:
            logger.info(
                "worker_status sweep: 名单获取失败（%s），保留旧值", st
            )
            return
        payload = (
            data
            if isinstance(data, list)
            else (data.get("workers", []) if isinstance(data, dict) else [])
        )
        names = []
        for w in payload:
            if isinstance(w, dict):
                n = str(w.get("name") or "")
                if n:
                    names.append(n)
        if not names:
            # 空名单不轻信（端点异常可能返回空 → 会清掉全部灯）；保旧表。
            logger.info("worker_status sweep: 名单为空，保留旧值")
            return
        _names_cache["names"] = names
        _names_cache["ts"] = time.time()

    # 2) 逐 worker（并发 4）拉 /chats 归约。
    sem = asyncio.Semaphore(_CONCURRENCY)

    async def _one(name: str) -> Optional[Dict[str, Any]]:
        async with sem:
            try:
                st, data, _t = await _ctl_get(
                    f"{base}/api/v1/workers/{name}/chats", token
                )
            except Exception:  # noqa: BLE001 - 单 worker 失败不影响同轮其他
                return None
        if st != 200 or not isinstance(data, list):
            return None  # 该 worker 保旧值（不下发空）
        running = False
        last_updated = 0
        for c in data:
            if not isinstance(c, dict):
                continue
            if c.get("status") == "running":
                running = True
            ts = _ts_ms(c.get("updated_at"))
            if ts > last_updated:
                last_updated = ts
        return {"running": running, "lastUpdated": last_updated}

    aggs = await asyncio.gather(*[_one(n) for n in names])

    # 3) 组装新表：成功覆盖、失败保旧、消失清除。
    new_workers: Dict[str, Any] = {}
    for name, agg in zip(names, aggs):
        if agg is not None:
            new_workers[name] = agg
        else:
            old = _agg["workers"].get(name)
            if old is not None:
                new_workers[name] = old
    _agg["workers"] = new_workers
    _agg["scan_at"] = time.time()


async def _run() -> None:
    # 启动让行（address_probe 同款 _STARTUP_DELAY），随后每 30s 一次
    # ensure_fresh（TTL 未过期自动跳过）。
    await _stop_event.wait(_STARTUP_DELAY)
    while not _stop_event.is_set():
        ensure_fresh()
        await _stop_event.wait(_TICK)


def start() -> None:
    """启动 tick 循环（幂等，进程内单实例）。由 plugin.register_startup_hook 调用。"""
    global _task
    if _task and not _task.done():
        return
    _stop_event.clear()
    _task = asyncio.create_task(_run())
    logger.info(
        "worker status aggregator started (tick=%.0fs, ttl=%.0fs, names_ttl=%.0fs)",
        _TICK,
        _TTL,
        _NAMES_TTL,
    )


async def stop() -> None:
    """停止 tick 循环。由 plugin.register_shutdown_hook 调用。"""
    _stop_event.set()
    if _task and not _task.done():
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:  # pragma: no cover
            pass
    logger.info("worker status aggregator stopped")
