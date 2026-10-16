/**
 * 工作流看板两档布局模式 —— 纯函数（node 可测，断点回归护栏）。
 *
 * 抽离背景：15.15 横屏回归修复。整个「横屏被搞烂」的根因就是布局断点
 * 误判——横屏手机 667px 曾因「<800 恒窄」落进竖屏堆叠布局。断点逻辑此前
 * 内联在 BoardColumnsView 组件里（useState 初值 + RO 回调两处），无法单测。
 * 收敛到本纯模块，组件两处统一调用，断点变更有 node 冒烟兜底。
 *
 * 15.19 起 jira 档（≥950，8 列固定 250px + 横滚）退役：整板 8×250=2000px
 * 只有很宽的窗口才放得下，窗口稍窄右侧列被裁出可视区；且 250px 列宽内
 * 卡片文字换行 3 行以上、被列高裁切。宽屏改回 grid2（两列三行）：列=
 * 容器半宽，越宽列越宽，永不压缩、整板不横滑；每列 3 卡限高 + 列内纵滚
 * 机制不变。
 *
 * 断点（按**实测容器宽**，非 WbViewport 快照——手机旋转 376↔667 不触发
 * narrow 翻转，快照会过期，实测宽是唯一正源）：
 *   W<500   → stacked（竖屏手机 376：状态列纵向堆叠全宽 + 列内 165px 卡行横滚）
 *   W≥500   → grid2 （横屏手机 667 / 平板 / 中间宽度 / 桌面宽屏：两列定宽网格
 *                minmax(0,1fr)，列=容器半宽永不压缩、整板不横滑；
 *                每列卡区限高 min(40vh,320px)≈3 卡，超出列内纵向滚）
 */
export type BoardMode = "stacked" | "grid2";

export const BOARD_STACKED_MAX_W = 500; // <500 竖屏堆叠

export function boardModeForWidth(w: number): BoardMode {
  return w < BOARD_STACKED_MAX_W ? "stacked" : "grid2";
}
