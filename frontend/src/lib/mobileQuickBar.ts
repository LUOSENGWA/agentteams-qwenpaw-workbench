/**
 * mobileQuickBar.ts — 移动端底部快捷条纯函数层（R2）。
 *
 * 断点 ≤600px 显示（桌面不渲染）；四项固定为 文件/工作流/消息/设置，
 * key 必须与 WorkbenchPage 顶层 tab key 一致。
 */

export const QUICK_BAR_MAX_WIDTH = 600;

export interface QuickBarItem {
  /** WorkbenchPage tab key（导航唯一契约）。 */
  key: string;
  /** 中文标签（渲染侧 tr()）。 */
  label: string;
}

export const QUICK_BAR_ITEMS: QuickBarItem[] = [
  { key: "artifacts", label: "文件" },
  { key: "workflow", label: "工作流" },
  { key: "chat", label: "消息" },
  { key: "settings", label: "设置" },
];

/** ≤600px（且宽为有效正数）才显示底部快捷条。 */
export function shouldShowQuickBar(width: number): boolean {
  return Number.isFinite(width) && width > 0 && width <= QUICK_BAR_MAX_WIDTH;
}
