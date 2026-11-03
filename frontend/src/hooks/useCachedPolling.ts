// 轮询 + 快照 diff 门控 hook（批次 4 任务 2：变化检测 + 零冗余重绘）。
//
// 语义：
// - fetcher(force?) → T | null | undefined；null/undefined = 取数失败 →
//   保留旧值（不闪、不报错——与既有静默降级语义一致）；
// - 取数成功后 shouldUpdate(prev, next)（默认 !sameSnapshot——JSON 快照
//   比较，与各既有 setter 值门逐字同语义）判定「变了」才 setData →
//   静集群一拍数据不变 = 不重渲；
// - onFetched(value, updated) 恒跑（不受 diff 门控——pending 同步等副作用
//   必须每拍都跑）；
// - inflight 门：并发取数重叠时跳轮（poller tick 与手动 refresh 同刻不双发）；
// - gateOnVisibility：document 不可见时跳轮（旧 workerChatStatus 的显式
//   visibilityState 门）；
// - useTransition：setState 走 React.startTransition（数据波可中断，
//   attention 面板同款语义）；
// - resetKey 变化 → reset（data 回 initialData）+ 重拉；
// - 首帧自带一次取数（usePoller 的 start() 首个 tick 在抖动间隔后才到，
//   不等它——首屏数据不能等 30s）；active 假→真由 usePoller 的 poke
//   覆盖（同 useWorkerChatStatuses 既有分工，inflight 门防双发）。
//
// 宿主桥模式（本项目不可 import React from "react"，照抄 theme.ts 头部）：
import type * as ReactNS from "react";
import { usePoller } from "../usePoller";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

/** JSON 快照比较（与各既有 setter 值门同款语义，无 try/catch——
 * 数据面为受控 JSON，非循环结构）。 */
export function sameSnapshot(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface CachedPollingOptions<T> {
  /** 取数（force = 手动刷新语义，透传调用方）；null/undefined = 失败保旧值。 */
  fetcher: (force?: boolean) => Promise<T | null | undefined>;
  intervalMs: number;
  /** 新快照判定「变了」→ setState（默认 !sameSnapshot）。 */
  shouldUpdate?: (prev: T, next: T) => boolean;
  /** 轮询活跃门（默认 true；usePoller active 假→真 poke 覆盖首次取数）。 */
  active?: boolean;
  /** poke 节流（透传 usePoller，默认 intervalMs/2）。 */
  minPokeMs?: number;
  /** 变化 → reset（data 回 initialData）+ 重拉（如 worker 名集合变化）。 */
  resetKey?: string;
  /** true → setState 走 React.startTransition。 */
  useTransition?: boolean;
  /** true → document.visibilityState !== "visible" 时跳轮。 */
  gateOnVisibility?: boolean;
  /** 取数成功后恒跑（value = 本拍取数值，updated = 是否触发了 setState）。 */
  onFetched?: (value: T, updated: boolean) => void;
  /** data 初值（reset 回到的值）。 */
  initialData?: T;
}

export interface CachedPollingResult<T> {
  data: T;
  /** 手动刷新（force 透传 fetcher）。 */
  refresh: (force?: boolean) => Promise<void>;
  /** data 回 initialData。 */
  reset: () => void;
}

export function useCachedPolling<T>(
  opts: CachedPollingOptions<T>,
): CachedPollingResult<T> {
  const initial = (opts.initialData ?? (null as unknown)) as T;
  const [data, setData] = React.useState<T>(initial);
  // 渲染期同步 ref（同 codebase pendingRef 模式——commit 内赋值不可行）。
  const dataRef = React.useRef<T>(initial);
  dataRef.current = data;
  const inflightRef = React.useRef(false);
  const optsRef = React.useRef(opts);
  optsRef.current = opts;
  const activeRef = React.useRef(opts.active !== false);
  activeRef.current = opts.active !== false;

  const applyData = React.useCallback((value: T) => {
    if (optsRef.current.useTransition) {
      React.startTransition(() => setData(value));
    } else {
      setData(value);
    }
  }, []);

  const run = React.useCallback(
    async (force?: boolean) => {
      if (inflightRef.current) return; // 重叠跳轮（不排队、不双发）
      if (
        optsRef.current.gateOnVisibility &&
        document.visibilityState !== "visible"
      ) {
        return;
      }
      inflightRef.current = true;
      try {
        const value = await optsRef.current.fetcher(force);
        if (value === null || value === undefined) return; // 失败保旧值
        const prev = dataRef.current;
        const su = optsRef.current.shouldUpdate;
        const updated = su ? su(prev, value) : !sameSnapshot(prev, value);
        if (updated) applyData(value);
        optsRef.current.onFetched?.(value, updated);
      } catch {
        /* 取数异常静默保旧值（数据面降级，不冒泡 UI 报错）。 */
      } finally {
        inflightRef.current = false;
      }
    },
    [applyData],
  );

  const reset = React.useCallback(() => {
    dataRef.current = (optsRef.current.initialData ?? (null as unknown)) as T;
    applyData(dataRef.current);
  }, [applyData]);

  // 首帧取数 / resetKey 变化先 reset 再取数。enabled 门走 activeRef
  // （刻意不进 deps——假→真切换由 usePoller 的 poke 覆盖，避免同刻双发）。
  const firstRunRef = React.useRef(true);
  React.useEffect(() => {
    if (firstRunRef.current) {
      firstRunRef.current = false;
    } else {
      reset();
    }
    if (activeRef.current) void run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, reset, opts.resetKey]);

  usePoller({
    fn: () => void run(false),
    intervalMs: opts.intervalMs,
    active: opts.active,
    minPokeMs: opts.minPokeMs,
  });

  return { data, refresh: run, reset };
}
