# -*- coding: utf-8 -*-
"""v0.4.92: 后台地址自动重排——外网/内网切换自动识别。

同一后端两条网络路径（内网 IP / 公网反代域名）。用户切网（家里↔外出、
WiFi↔有线）后两条路径的延迟/可达性都会变。本循环定期并行探测全部配置
地址（测延迟），按「最快可达 + 防抖滞回」更新 working cache——插件自动
切到当前最优路径，用户零操作。

**资源自适应（需求：单地址部署多为恒外网，不为无意义的切换消耗资源）**：
- 某类型只有 1 个地址（或 0 个）→ 该类型**永不探测**（没得可切，零开销）
  ——恒外网的单地址用户后台探测成本 = 0；
- 有 ≥2 地址的类型（内/外网双路径用户）：
  - 本轮发生切换或生效地址不可达 → 30s 后再测（切网进行中，快速收敛）；
  - 连续 2 轮稳定（无切换且生效地址可达）→ 300s 一轮（稳态低频）；
  - 其余（首轮/混合）→ 120s。
真实切换的即时性不靠轮询保证——请求层 failover（catch-all 逐地址尝试
+ 同址传输层错误重试一次）当场兜底；本循环只负责「慢但通」的路径优化。

启动/停止由 plugin.register_startup_hook / register_shutdown_hook 驱动
（sync_watcher 同款幂等模式）。单地址探测 4s 超时（失败重试一次），
并行执行，单轮上限 ~12s。
"""

from __future__ import annotations

import asyncio
import logging

from . import config as config_mod
from . import selfcheck

logger = logging.getLogger(
    "qwenpaw.plugins.agentteams_qwenpaw_workbench.address_probe"
)

_INTERVAL_FAST = 30.0  # 切换/失败后（切网进行中）
_INTERVAL_BASE = 120.0  # 常规
_INTERVAL_STABLE = 300.0  # 连续稳定后的低频稳态
_STABLE_ROUNDS = 2  # 连续 N 轮稳定才降频
_STARTUP_DELAY = 15.0  # 启动后先等——不抢宿主启动期网络

_task: asyncio.Task | None = None
_stop_event = asyncio.Event()
_running = False  # 防重入：上一轮没跑完不开新一轮
_stable_count = 0  # 连续稳定轮计数


async def _run() -> None:
    global _running, _stable_count
    _stop_event.clear()
    await _stop_event.wait(_STARTUP_DELAY)
    interval = _INTERVAL_BASE
    while not _stop_event.is_set():
        if not _running:
            _running = True
            try:
                cfg = config_mod.load_config()
                # 省资源核心：地址数 <2 的类型跳过（无切换意义，零探测）。
                kinds = []
                for k, urls in (
                    ("matrix", cfg.get("matrix_homeservers") or []),
                    ("controller", cfg.get("controller_urls") or []),
                    # v0.4.97: SGLang 双地址（内网/外网）纳入自动重排。
                    ("sglang", (cfg.get("sglang") or {}).get("urls") or []),
                ):
                    if len([u for u in urls if u]) >= 2:
                        kinds.append(k)
                if kinds:
                    results = await selfcheck.refresh_effective(cfg, tuple(kinds))
                    logger.info(
                        "address auto-rerank: matrix=%s controller=%s sglang=%s",
                        results.get("matrix", "-"),
                        results.get("controller", "-"),
                        results.get("sglang", "-"),
                    )
                    # 轮次质量判定：生效地址是否都在（可达且被选中）。
                    cache = selfcheck._working_cache()
                    stable = all(
                        cache.get(k) for k in kinds
                    ) and bool(results)
                    if stable:
                        _stable_count += 1
                    else:
                        _stable_count = 0
                    if not stable:
                        next_interval = _INTERVAL_FAST
                    elif _stable_count >= _STABLE_ROUNDS:
                        next_interval = _INTERVAL_STABLE
                    else:
                        next_interval = _INTERVAL_BASE
                    if next_interval != interval:
                        logger.info(
                            "address probe interval -> %.0fs (stable_rounds=%d)",
                            next_interval,
                            _stable_count,
                        )
                        interval = next_interval
            except Exception:  # noqa: BLE001 - 后台循环不得因单轮异常死掉
                logger.warning("address probe round failed", exc_info=True)
            finally:
                _running = False
        await _stop_event.wait(interval)


def start() -> None:
    """启动后台循环（幂等）。由 plugin.register_startup_hook 调用。"""
    global _task
    if _task and not _task.done():
        return
    _task = asyncio.create_task(_run())
    logger.info(
        "address auto-rerank started (adaptive: %.0f/%.0f/%.0fs, "
        "single-address kinds skipped)",
        _INTERVAL_FAST,
        _INTERVAL_BASE,
        _INTERVAL_STABLE,
    )


async def stop() -> None:
    """停止后台循环。由 plugin.register_shutdown_hook 调用。"""
    _stop_event.set()
    if _task and not _task.done():
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:  # pragma: no cover
            pass
    logger.info("address auto-rerank stopped")
