import type * as ReactNS from "react";

/**
 * useNarrow —— 窄视口（<576px，antd xs 断点下沿）检测。
 *
 * 竖屏手机（390/393px）低于 antd 一切栅格断点（xs=576 起），
 * 密集表格在窄屏挤压不可读 → 组件内 isNarrow 分支降级为卡片
 * 列表（数据层零改动，纯渲染分支）。
 *
 * 实现 = matchMedia + change 监听（媒体查询变化即时翻转，
 * 旋转屏幕/分屏都跟上）；无监听环境（SSR 兜底）恒 false。
 */
const NARROW_QUERY = "(max-width: 575px)";

export function useNarrow(): boolean {
  const host = window.QwenPaw.host;
  const React = host.React;
  const [narrow, setNarrow] = React.useState<boolean>(() =>
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia(NARROW_QUERY).matches
      : false,
  );
  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener?.("change", onChange);
    // 旧 WebKit（Safari <14）无 addEventListener——addListener 兜底
    if (!mq.addEventListener) mq.addListener?.(onChange);
    return () => {
      mq.removeEventListener?.("change", onChange);
      if (!mq.removeEventListener) mq.removeListener?.(onChange);
    };
  }, []);
  return narrow;
}
