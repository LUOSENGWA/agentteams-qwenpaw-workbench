// v0.5.0-beta.14.6（R2）：全局「当前活跃 tab」单源——WorkbenchPage 在 tab
// 变化时 setActiveTab()；各处轮询用 isTabActive("xxx") 决定是否该跑
// （rc-tabs 保活：切走组件不卸载，必须显式门控）。
// 另：新增 setActiveTab 之外的注册表供 usePoller 的 React 包装订阅。

import type * as ReactNS from "react";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

let currentTab = "";
const listeners = new Set<() => void>();

export function setActiveTab(tab: string): void {
  if (tab === currentTab) return;
  currentTab = tab;
  listeners.forEach((fn) => fn());
}

export function getActiveTab(): string {
  return currentTab;
}

export function isTabActive(tab: string): boolean {
  return currentTab === tab;
}

/** React 订阅（useSyncExternalStore）；无该钩子时回退 useState+订阅。 */
export function useActiveTab(): string {
  const sub = React.useCallback(
    (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    [],
  );
  return React.useSyncExternalStore(sub, getActiveTab, getActiveTab);
}

/**
 * v0.5.0-beta.14.14（UIPERF-T25）：布尔快照订阅——仅当「指定 tab 是否激活」
 * 翻转（边界穿越）时该组件才重渲。useActiveTab 返回字符串快照，每次切 tab
 * 所有订阅组件都重渲（rc-tabs 保活下 ≥4 面板每次点击全量重渲——连点 Tab
 * CPU 高企的固定成本之一）；布尔快照只在进入/离开本 tab 时变化。
 * 用法：`active: useTabActive("ops")`（等价旧 `useActiveTab()==="ops"`，
 * 但非本 tab 的切换不再触发重渲）。
 */
export function useTabActive(tab: string): boolean {
  const sub = React.useCallback(
    (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    [],
  );
  const getSnap = React.useCallback(() => currentTab === tab, [tab]);
  return React.useSyncExternalStore(sub, getSnap, getSnap);
}
