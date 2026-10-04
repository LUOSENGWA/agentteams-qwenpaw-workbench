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
