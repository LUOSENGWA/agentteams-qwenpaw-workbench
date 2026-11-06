// 「手动刷新/重试必穿透读缓存」统一修法（R3 刷新审计单一实现）。
//
// 背景：域 API 层用 cachedRequest（TTL + tag）包缓存，错误不缓存——
// 失败后重试天然 fresh，但手动「刷新」若不显式失效，TTL/SWR 窗内
// 返回旧值（审计表 ❌① 的反模式）。此前各组件各自 invalidate+load
// 或干脆不穿透——同一反模式多份实现。本 hook 是仓库唯一实现：
// reload() = invalidateTags(tags) 后 load()，带 busy 防重入，
// 暴露 loading/err（err 仅在 load 自身不吞错、向上抛时非空；
// 组件既有行内错误态优先用本 hook 的 loading）。
//
// 用法：const { reload, loading } = useForceReload(load, ["worker-mcp"]);
// 按钮 loading={loading}（或与组件自有 loading 合并）onClick={() => void reload()}。
//
// 宿主桥模式（本项目不可 import React from "react"，照抄 theme.ts 头部）：
import type * as ReactNS from "react";
import { invalidateTags } from "../requestCache";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

export interface ForceReload {
  /** invalidateTags(tags) → load()；运行中重入直接丢弃。 */
  reload: () => Promise<void>;
  /** reload 运行中（按钮 loading）。 */
  loading: boolean;
  /** load 向上抛错时的信息（多数组件自行 catch 行内显示，此时恒空）。 */
  err: string;
}

export function useForceReload(
  load: () => void | Promise<void>,
  tags: readonly string[],
): ForceReload {
  // ref 透传：load/tags 每次渲染可新，hook 不重订阅（reload 身份恒定，
  // 不污染消费方 effect deps）。
  const loadRef = React.useRef(load);
  loadRef.current = load;
  const tagsRef = React.useRef(tags);
  tagsRef.current = tags;
  const busyRef = React.useRef(false);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState("");

  const reload = React.useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setErr("");
    setLoading(true);
    try {
      // 先显式失效再取数——手动刷新必穿透 TTL/SWR 窗（cachedRequest
      // 命中判定在 fetcher 启动时同步读 map，先删后取即 fresh）。
      invalidateTags([...tagsRef.current]);
      await Promise.resolve(loadRef.current());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  }, []);

  return { reload, loading, err };
}
