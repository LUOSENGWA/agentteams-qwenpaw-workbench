# -*- coding: utf-8 -*-
"""后台 tick 聚合器通用骨架（worker_status / projects_workflow 共用）。

背景：两个聚合器（14.9 分列）的生命周期骨架逐字克隆——ensure_fresh
（TTL/单飞/fire-and-forget）+ _sweep（bg_slot 共用通道让权 + 单飞
set/clear + 异常不杀后台循环）+ _run tick 循环 + start/stop。骨架漂移
= 两侧行为分叉（14.12 已发现过一次共用通道注释互引不同步）。本模块收
敛骨架；各聚合器模块保留：数据状态（形状各自不同）与扫描体 _do_sweep
（含取数注入点 _ctl_get，测试 monkeypatch 面不变）。

设计约束（与旧克隆体行为逐字对齐）：
- 状态容器由调用方传入（模块级 dict 的引用）——测试经模块私有名
  （ws._agg / pw._snap）读 scanning/scan_at 的既有断言面保持有效；
- ensure_fresh 承诺非阻塞、不抛（无事件循环上下文静默跳过）；
- _sweep 持 bg_slot：前台忙让权/90s 超时放弃本轮（保旧值，下 tick
  重试），扫描体在锁内执行；任何单轮异常只告警，不杀循环；
- start 幂等（进程内单实例）；stop 优雅取消。
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Awaitable, Callable, Dict, Optional

from .dial_gate import bg_slot

__all__ = ["BgTicker"]


class BgTicker:
    """一个后台聚合器的生命周期骨架。

    参数：
    - name：日志前缀（聚合器名）。
    - state：调用方的状态容器引用，须含 "scan_at"（float）/
      "scanning"（bool）键；其余数据键（workers/projects…）同容器
      共存，骨架只碰这两个键。
    - do_sweep：扫描体 async callable（无参）。
    - tick / ttl / startup_delay：秒。
    """

    def __init__(
        self,
        name: str,
        state: Dict[str, Any],
        do_sweep: Callable[[], Awaitable[None]],
        tick: float = 30.0,
        ttl: float = 30.0,
        startup_delay: float = 3.0,
    ) -> None:
        self.name = name
        self.state = state
        self._do_sweep = do_sweep
        self.tick = tick
        self.ttl = ttl
        self.startup_delay = startup_delay
        self.log = logging.getLogger(
            f"qwenpaw.plugins.agentteams_qwenpaw_workbench.{name}"
        )
        self._task: Optional[asyncio.Task] = None
        self._stop_event = asyncio.Event()

    # ── 前台入口：fire-and-forget 触发 ──────────────────────────────

    def ensure_fresh(self, force: bool = False) -> None:
        """过期（或 force 无视 TTL）且未扫描中 → 起后台扫描。

        承诺非阻塞、不抛：当前上下文无运行事件循环 → 静默跳过（下轮
        tick / 端点重试）；先查循环再建协程，避免悬挂 coroutine 警告。
        """
        if self.state["scanning"]:
            return
        if not force and time.time() - self.state["scan_at"] < self.ttl:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            self.log.debug("%s ensure_fresh: no running event loop, skip",
                           self.name)
            return
        loop.create_task(self._sweep())

    # ── 后台侧：单飞 + 共用通道 + 扫描体 ───────────────────────────

    async def _sweep(self) -> None:
        """单飞门 + 后台共用通道：前台忙（拨号 inflight>12）让权、
        等共用锁超 90s 放弃本轮；扫描体持共用锁（与其他聚合器/KB
        刷新共享，防齐发打满闸门抢前台）。"""
        if self.state["scanning"]:
            return  # 单飞：扫描中不重入
        self.state["scanning"] = True
        try:
            async with bg_slot() as _bg:
                if not _bg:
                    return  # 让权/放弃 → 本轮不动（保旧值，下 tick 重试）
                await self._do_sweep()
        except Exception:  # noqa: BLE001 - 后台循环不得因单轮异常死掉
            self.log.warning("%s sweep failed", self.name, exc_info=True)
        finally:
            self.state["scanning"] = False

    # ── tick 循环与生命周期 ────────────────────────────────────────

    async def _run(self) -> None:
        # 启动让行（address_probe 同款 startup_delay），随后每 tick 一次
        # ensure_fresh（TTL 未过期自动跳过）。
        await self._stop_event.wait(self.startup_delay)
        while not self._stop_event.is_set():
            self.ensure_fresh()
            await self._stop_event.wait(self.tick)

    def start(self) -> None:
        """启动 tick 循环（幂等，进程内单实例）。"""
        if self._task and not self._task.done():
            return
        self._stop_event.clear()
        self._task = asyncio.create_task(self._run())
        self.log.info(
            "%s aggregator started (tick=%.0fs, ttl=%.0fs)",
            self.name, self.tick, self.ttl,
        )

    async def stop(self) -> None:
        """停止 tick 循环。"""
        self._stop_event.set()
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:  # pragma: no cover
                pass
        self.log.info("%s aggregator stopped", self.name)
