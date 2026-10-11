import type * as ReactNS from "react";
import { useNarrow } from "../useNarrow";

/**
 * WbTableFade —— 窄屏表格右缘渐隐（P3 横向滚动提示）。
 *
 * scroll.x 表格在 390px 竖屏必然横向可滚但 scrollbar 不显眼
 * → 右缘 16px 灰透明渐隐=「还有更多」视觉信号（业界
 * scroll-fade 的静态简化版：这些表格 scroll.x 恒超容器宽，
 * 窄屏下右缘恒可滚，无需跟踪 scrollLeft；宽屏内容装得下
 * 不挂渐隐，无假报）。
 *
 * 用法：<WbTableFade><antd.Table ... /></WbTableFade>
 * 宽屏（≥576）原样透传，零 DOM 变化。
 */
const host = window.QwenPaw.host;
const React = host.React;

export default function WbTableFade({
  children,
}: {
  children: ReactNS.ReactNode;
}) {
  const narrow = useNarrow();
  if (!narrow) return children;
  return <div className="wb-table-fade-r">{children}</div>;
}
