import type * as ReactNS from "react";

/**
 * WbViewportContext —— 插件「窄/宽」判定的单一事实源。
 *
 * 背景：聊天单栏/双栏的判定逻辑本身没问题，问题是别的
 * 页面（团队表卡片化 / 横滚表渐隐）各用各的、还用了不同基准（window.matchMedia
 * 575px），与聊天不一致 → 聊天判窄时团队表没跟着判窄。正解 = 抽成一套共享
 * 判定，所有页面共用；要调只改这一处。
 *
 * 判定基准 = **聊天同源**的容器可见宽（WorkbenchPage measure() 沿 main 父链
 * 到 body 取每层 clientWidth 的 min，再与 window.innerWidth 取 min）。阈值 =
 * CHAT_SPLIT_MIN_CONTAINER_W（800）：容器可见宽 < 800 = 窄 ⟺ 聊天单栏。
 * 这样「团队表卡片化 / 表右缘渐隐」与「聊天单栏」永远同步。
 *
 * h（容器可见高）一并下发并预留到 isNarrowLayout：将来要按长宽比 / 竖屏
 * （height > width 一律窄）加判据，只改 isNarrowLayout 一行即可。
 */
const host = window.QwenPaw.host;
const React = host.React;

/** 窄/宽分界 = 聊天单栏/双栏阈值（同源常量，别处勿再各自硬编码）。 */
export const NARROW_MAX_W = 800;

/**
 * 唯一判定。当前 = 容器可见宽 < NARROW_MAX_W（与聊天单栏同判据）。
 * 要按竖屏/长宽比增强：在此加 `|| h > w`（长宽比优先）。
 */
export function isNarrowLayout(w: number, h: number): boolean {
  return w < NARROW_MAX_W;
}

export type WbViewport = {
  /** 容器可见宽（父链 clientWidth min，与聊天同源）。 */
  width: number;
  /** 容器可见高（竖屏/长宽比判据预留）。 */
  height: number;
  /** 是否窄（= isNarrowLayout(width, height)）。 */
  narrow: boolean;
};

const Ctx = React.createContext<WbViewport>({
  width: typeof window !== "undefined" ? window.innerWidth : 0,
  height: typeof window !== "undefined" ? window.innerHeight : 0,
  narrow: false,
});

/** 消费：`const { narrow, width, height } = useWbViewport();` */
export function useWbViewport(): WbViewport {
  return React.useContext(Ctx);
}

export const WbViewportProvider = Ctx.Provider;
export type { ReactNS };
