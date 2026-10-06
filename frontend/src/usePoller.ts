// v0.5.0-beta.14.6（R2）：轮询调度器——单链 setTimeout（非 setInterval）
// 替代散落的 15 处 window.setInterval，统一提供：
//   - 活跃门控（isActive：tab 激活 && 页面可见等，每轮判定）；
//   - 防堆积（await fn 完成再排下轮）；
//   - 失败退避（下轮间隔 = min(interval * factor^失败数, backoffMax)）；
//   - 可见性暂停 + 恢复补跑（隐藏清定时器；可见且闲置 > catchUpMs 立即补一次）；
//   - 抖动（每轮间隔 ±jitterRatio，防多 poller 同刻同步打点）。
//
// 结构：createPoller 为纯核心（不依赖 React，node 可直测——见
// scripts/poller.smoke.mjs）；usePoller 为 React 包装（effect 建/卸载 stop，
// active 假→真时 poke 补跑，fn 用 ref 持有防闭包过期）。
//
// 宿主桥模式（本项目不可 import React from "react"，照抄 theme.ts 头部）：
import type * as ReactNS from "react";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

export interface PollerOptions {
  fn: () => void | Promise<void>;
  intervalMs: number;
  /** 综合条件（tab 激活 && !document.hidden 等），每轮与恢复时判定 */
  isActive: () => boolean;
  /** 默认 intervalMs*2；恢复活跃且闲置超过它 → 立即补跑一次 */
  catchUpMs?: number;
  /** 默认 2；fn 抛错则下轮间隔 *= factor */
  backoffFactor?: number;
  /** 默认 120000；退避封顶 */
  backoffMaxMs?: number;
  /** 默认 0.1；每轮间隔 ±jitter 抖动防同步 */
  jitterRatio?: number;
  /**
   * v0.5.0-beta.14.14（UIPERF-T25）：poke 节流——距上次真实执行 fn 不足
   * 该间隔时跳过 poke（数据还新鲜，切回 tab 不重复拉）。默认 intervalMs/2
   * （由 usePoller 包装传入；数据新鲜度保证 ≤ 一个轮询周期，语义不变）。
   * 0/undefined = 旧行为（每次假→真必 poke）。
   */
  minPokeMs?: number;
}

export interface Poller {
  start(): void;
  stop(): void;
  poke(): void;
}

export function createPoller(opts: PollerOptions): Poller {
  const intervalMs = opts.intervalMs;
  const catchUpMs = opts.catchUpMs ?? intervalMs * 2;
  const backoffFactor = opts.backoffFactor ?? 2;
  const backoffMaxMs = opts.backoffMaxMs ?? 120000;
  const jitterRatio = opts.jitterRatio ?? 0.1;

  let timer: number | null = null;
  let stopped = true;
  let inFlight = false;
  let failures = 0;
  // 最近一次真实执行 fn 的完成时刻（catch-up「闲置」判定基准；0=从未跑过）。
  let lastTickAt = 0;

  /** 抖动间隔：delay = interval * (1 + (Math.random()*2-1) * jitterRatio)。 */
  const jittered = (): number =>
    intervalMs * (1 + (Math.random() * 2 - 1) * jitterRatio);

  /** 失败退避间隔：min(interval * factor^失败数, backoffMax)。 */
  const backoffMs = (): number =>
    Math.min(intervalMs * Math.pow(backoffFactor, failures), backoffMaxMs);

  /** 下一轮间隔：有失败走退避，否则基础抖动间隔。 */
  const nextDelay = (): number =>
    failures > 0 ? backoffMs() : jittered();

  const clearTimer = (): void => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (delay: number): void => {
    clearTimer();
    if (stopped) return;
    timer = window.setTimeout(() => {
      void tick();
    }, delay);
  };

  /** 执行 fn 并 await 其完成（防堆积）；成功清零失败计数，失败 +1。 */
  const runFn = async (): Promise<void> => {
    inFlight = true;
    try {
      await opts.fn();
      failures = 0;
    } catch {
      failures += 1;
    } finally {
      inFlight = false;
      lastTickAt = Date.now();
    }
  };

  /** 每轮判定：不活跃 → 跳过 fn 按 interval（带抖动）排下轮；活跃 → 执行。 */
  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (!opts.isActive()) {
      schedule(jittered());
      return;
    }
    if (inFlight) {
      // 单链下不应发生（上一轮未完成才会重入），防御性重排。
      schedule(jittered());
      return;
    }
    await runFn();
    schedule(nextDelay());
  };

  /** 可见性变化：隐藏 → 清定时器暂停调度；可见 → 闲置超 catchUpMs 立即补跑。 */
  const onVisibility = (): void => {
    if (stopped) return;
    if (document.hidden) {
      clearTimer();
      return;
    }
    // 可见：之前已跑过且闲置超过 catchUpMs → 立即补跑一次（catch-up）。
    if (lastTickAt > 0 && Date.now() - lastTickAt > catchUpMs) {
      if (inFlight) {
        schedule(jittered());
      } else {
        void runFn().then(() => {
          if (!stopped) schedule(nextDelay());
        });
      }
      return;
    }
    if (timer === null && !inFlight) {
      schedule(jittered());
    }
  };

  const poller: Poller = {
    start(): void {
      if (!stopped) return; // 幂等
      stopped = false;
      document.addEventListener("visibilitychange", onVisibility);
      if (document.hidden) return; // 隐藏时启动：不排首 tick，等可见恢复
      schedule(jittered());
    },
    stop(): void {
      if (stopped) return; // 幂等
      stopped = true;
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibility);
    },
    /** 立即执行并重置节拍（供「切回 tab 立即刷新」用）；不满足条件则不动。 */
    poke(): void {
      if (stopped || inFlight || !opts.isActive()) return;
      // UIPERF-T25：数据还新鲜（半个周期内跑过）→ 跳过，避免连点重复重拉。
      const minPokeMs = opts.minPokeMs;
      if (minPokeMs && lastTickAt > 0 && Date.now() - lastTickAt < minPokeMs) return;
      void runFn().then(() => {
        if (!stopped) schedule(nextDelay());
      });
    },
  };

  return poller;
}

/**
 * React 包装：effect 内建 createPoller、卸载 stop；active 默认 true（内部
 * 再 && !document.hidden）；active 假→真时 poke()（catch-up）；fn 用 ref
 * 持有（避免闭包过期）。intervalMs/catchUpMs/backoffMaxMs 变化时重建。
 */
export function usePoller(pollerOpts: {
  fn: () => void | Promise<void>;
  intervalMs: number;
  active?: boolean;
  catchUpMs?: number;
  backoffMaxMs?: number;
  /** UIPERF-T25：默认 intervalMs/2（数据新鲜则跳过 poke）。 */
  minPokeMs?: number;
}): void {
  const { intervalMs, catchUpMs, backoffMaxMs } = pollerOpts;
  const minPokeMs = pollerOpts.minPokeMs ?? intervalMs / 2;
  const activeRequested = pollerOpts.active !== false; // 默认 true

  // fn 用 ref 持有（每次渲染刷新），poller 闭包永远调最新版。
  const fnRef = React.useRef(pollerOpts.fn);
  fnRef.current = pollerOpts.fn;

  // 渲染期同步 active 快照；每轮判定还会实时读 document.hidden。
  const activeRef = React.useRef(false);
  activeRef.current = activeRequested && !document.hidden;

  const pollerRef = React.useRef<Poller | null>(null);

  React.useEffect(() => {
    const p = createPoller({
      fn: () => fnRef.current(),
      intervalMs,
      isActive: () => activeRef.current && !document.hidden,
      catchUpMs,
      backoffMaxMs,
      minPokeMs,
    });
    pollerRef.current = p;
    p.start();
    return () => {
      p.stop();
      pollerRef.current = null;
    };
  }, [intervalMs, catchUpMs, backoffMaxMs, minPokeMs]);

  // active 假→真 → poke()（立即补跑一次，替代「切回 tab 再等一个间隔」）。
  const prevActiveRef = React.useRef(activeRef.current);
  React.useEffect(() => {
    const now = activeRef.current;
    if (now && !prevActiveRef.current) {
      pollerRef.current?.poke();
    }
    prevActiveRef.current = now;
  });
}
