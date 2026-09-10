import type * as ReactNS from "react";

const host = window.QwenPaw.host;

/** 主题颜色（深色模式适配）。antd 组件自身由宿主 ConfigProvider 控制；
 *  这里只管插件内联样式的硬编码颜色。 */
export interface ThemeColors {
  mode: "light" | "dark";
  /** 页面/卡片背景。 */
  bg: string;
  cardBg: string;
  /** 主文字 / 次级文字。 */
  text: string;
  textSecondary: string;
  /** 边框与分隔线。 */
  border: string;
  /** 他人气泡底 / 自己的气泡底。 */
  bubbleOther: string;
  bubbleMine: string;
  /** hover 底色。 */
  hoverBg: string;
  /** 弹层/悬浮工具条背景。 */
  popoverBg: string;
  /** 工具消息底色。 */
  toolBg: string;
}

const LIGHT: ThemeColors = {
  mode: "light",
  bg: "#ffffff",
  cardBg: "#ffffff",
  text: "rgba(0,0,0,0.88)",
  textSecondary: "#888",
  border: "rgba(0,0,0,0.08)",
  bubbleOther: "rgba(0,0,0,0.04)",
  bubbleMine: "rgba(255,127,22,0.08)",
  hoverBg: "rgba(0,0,0,0.03)",
  popoverBg: "#ffffff",
  toolBg: "rgba(0,0,0,0.03)",
};

const DARK: ThemeColors = {
  mode: "dark",
  bg: "#141414",
  cardBg: "#1f1f1f",
  text: "rgba(255,255,255,0.88)",
  textSecondary: "#8c8c8c",
  border: "rgba(255,255,255,0.12)",
  bubbleOther: "rgba(255,255,255,0.08)",
  bubbleMine: "rgba(255,127,22,0.18)",
  hoverBg: "rgba(255,255,255,0.06)",
  popoverBg: "#2a2a2a",
  toolBg: "rgba(255,255,255,0.06)",
};

/** 读取宿主主题（host.useTheme，插件组件内调用）。 */
export function useThemeColors(): ThemeColors {
  let mode: string = "light";
  try {
    if (typeof host.useTheme === "function") {
      mode = host.useTheme() === "dark" ? "dark" : "light";
    }
  } catch {
    mode = "light";
  }
  return mode === "dark" ? DARK : LIGHT;
}

/** 非组件上下文（事件回调等）读主题（不响应式，按需调用）。 */
export function readThemeColors(): ThemeColors {
  let mode: string = "light";
  try {
    const h = (window as unknown as { QwenPaw?: { host?: { useTheme?: () => string } } })
      .QwenPaw?.host;
    if (h && typeof h.useTheme === "function") {
      mode = h.useTheme() === "dark" ? "dark" : "light";
    }
  } catch {
    mode = "light";
  }
  return mode === "dark" ? DARK : LIGHT;
}

export type { ReactNS };
