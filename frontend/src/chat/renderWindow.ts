/**
 * 视口窗口化（16.46）：纯逻辑模块——渲染序列（renderItems）变化后的
 * 窗口重算 / 扩窗 / 跳转保证。
 *
 * 背景：R2「加载原消息」深跳路径会让最多 1000 条消息进入消息域；
 * 此前全量 map 进 DOM → 主线程 CPU 卡死。窗口化后任一时刻只挂载
 * 「可视窗口 ± VWIN_BUFFER」，DOM 节点数与消息总量无关。
 *
 * 窗口单位 = item（turn）：turn 单位重构后 data-turn-id 是滚动锚点 /
 * 刻度轨 / 过程折叠条的单位，渲染半个 turn 会破坏 turn 包装与
 * 过程条语义。
 *
 * 尾锚法：anchor = 上次窗口 end-1 处的 item。
 * - 头前插（loadMore 翻页）：anchor 索引 +delta → 整窗平移 delta，
 *   DOM 行集不变 → 视口天然稳定（第一道防线仍是浏览器原生
 *   overflow-anchor，useStickToBottom 锚定元素层兜底）；
 * - 头裁剪（R2 旁路释放、数据窗口收窄）：anchor 索引负 delta →
 *   同法平移 + 钳制，深跳目标留在窗内；
 * - 尾追加（SSE / 新消息）：窗口原贴尾或用户贴底 → 跟随尾；
 *   否则保持不动（「N 条新消息」徽章由 stickToBottom 负责）。
 *
 * 无 React 依赖（node 可跑，gate selftest 直测）。
 */
export const VWIN_BUFFER = 20; // 哨兵扩窗步长 / 跳转保证的前缓冲
export const VWIN_INITIAL = 40; // 初始（尾锚）窗口大小
export const VWIN_MIN = 60; // len ≤ 该值 → 全量渲染不窗口化（小房间零开销）

export interface ViewRange {
  start: number;
  end: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 尾锚窗口（初始 / 切房 / 锚丢失兜底）。 */
export function bottomWindow(len: number): ViewRange {
  if (len <= 0) return { start: 0, end: 0 };
  if (len <= VWIN_INITIAL) return { start: 0, end: len };
  return { start: len - VWIN_INITIAL, end: len };
}

/**
 * items 变化后的窗口重算。
 * @param prev          上一窗口（state）
 * @param prevLen       上次提交时 items 长度
 * @param prevAnchorKey 上次提交时 prev.end-1 处 item 的 key（null=无锚）
 * @param keys          当前 items 的 key 序列
 * @param atBottom      用户当前是否贴底（stickToBottom.isAtBottom）
 * @param roomChanged   是否换了房间（直接重置尾锚）
 */
export function nextViewRange(
  prev: ViewRange,
  prevLen: number,
  prevAnchorKey: string | null,
  keys: string[],
  atBottom: boolean,
  roomChanged: boolean,
): ViewRange {
  const len = keys.length;
  if (roomChanged || len <= 0) return bottomWindow(len);
  if (len <= VWIN_MIN) return { start: 0, end: len };
  if (prevAnchorKey == null) return bottomWindow(len);
  const anchorIdx = keys.indexOf(prevAnchorKey);
  if (anchorIdx < 0) return bottomWindow(len); // 防御：尾锚不会被裁剪
  const delta = anchorIdx - (prev.end - 1);
  let start = prev.start + delta;
  let end = prev.end + delta;
  // 尾追加：窗口原贴尾或用户贴底 → 跟随尾；否则保持（未读徽章提示）。
  if (len > prevLen && (prev.end === prevLen || atBottom)) end = len;
  start = clamp(start, 0, len);
  end = clamp(end, start + 1, len);
  return { start, end };
}

/**
 * 跳转保证：把目标 item 纳入窗口（目标前 VWIN_BUFFER、后 VWIN_INITIAL）。
 * targetIdx < 0（目标不在当前 items，未加载）→ 原样返回，调用方走
 * 既有 /context 定位区兜底。
 */
export function ensureItemVisible(
  prev: ViewRange,
  len: number,
  targetIdx: number,
): ViewRange {
  if (targetIdx < 0 || len <= VWIN_MIN) return prev;
  if (targetIdx >= prev.start && targetIdx < prev.end) return prev;
  let start = targetIdx - VWIN_BUFFER;
  let end = targetIdx + VWIN_INITIAL;
  if (end > len) {
    end = len;
    start = Math.max(0, len - (VWIN_INITIAL + VWIN_BUFFER));
  }
  if (start < 0) start = 0;
  return { start, end };
}

/** 哨兵边缘扩窗（IntersectionObserver 触发；已在边缘 = no-op）。 */
export function expandRange(
  prev: ViewRange,
  len: number,
  edge: "top" | "bottom",
): ViewRange {
  if (len <= VWIN_MIN) return prev;
  if (edge === "top") {
    if (prev.start <= 0) return prev;
    return { start: Math.max(0, prev.start - VWIN_BUFFER), end: prev.end };
  }
  if (prev.end >= len) return prev;
  return { start: prev.start, end: Math.min(len, prev.end + VWIN_BUFFER) };
}
