// 「加载原消息」= 显式分页跳转（R2，替换旧的「滚到顶自动续拉」接力）——纯决策层。
// 点按钮 → 串行翻页直到目标进入窗口（限页上限）→ 定位+高亮；目标在上限内
// 找不到 → 沿用 /context 兜底（jumpContext 定位区）。
// 取页一律走 loadMore/RoomHistory（I1–I6 不变量全部在那一层，此处只做决策），
// 故本模块纯函数、node 可测（scripts/paginationR2.smoke.mjs）。

import { groupThreads } from "./threadWindow";

/** 「加载原消息」翻页上限（页）：120 页 ≈ 6000 条，覆盖验收的
 * 「100+ 页深度定位目标」，同时把请求量上界钉死（旧 3000 条 excess 上限
 * ≈60 页，深目标会被误判为「不存在」）。 */
export const ORIGINAL_PAGE_CAP = 120;

export type BackfillAction = "fetch" | "done-found" | "done-exhausted";

/**
 * 显式跳转循环的单步决策（终止条件的唯一来源）：
 * 目标已在窗口 → done-found；游标为空（到头）或已达翻页上限 → done-exhausted；
 * 否则 fetch 下一页。
 */
export function nextBackfillAction(
  windowHasTarget: boolean,
  cursor: string,
  pagesFetched: number,
): BackfillAction {
  if (windowHasTarget) return "done-found";
  if (!cursor) return "done-exhausted";
  if (pagesFetched >= ORIGINAL_PAGE_CAP) return "done-exhausted";
  return "fetch";
}

/** 与 threadWindow.ThreadMsg 同构的最小形状（结构子集）。 */
export interface JumpableMsg {
  event_id: string;
  reply?: { event_id?: string } | null;
}

/**
 * 定位时的渲染窗口下界（R2 显式跳转专用）：「加载原消息」命中后，
 * pendingOriginal 旁路会在 onJumpHandled 时释放，渲染窗口（最近 N 条顶层）
 * 恢复裁切——若目标在更早的深层历史，会被裁出 DOM → 已定位的视图被拽走。
 * 返回「目标渲染锚点」到最新消息的顶层条数（含目标）：顶层消息计自身，
 * 回复计其根（渲染位置锚在根上）；找不到返回 0（不抬升）。
 * 注意按「原始消息序」计（未过 hideTools 过滤）：过滤只删行不换位，
 * 原始序下界 ≥ 过滤序下界，安全过估。
 */
export function computeWindowFloorForJump<T extends JumpableMsg>(
  messages: readonly T[],
  targetId: string,
): number {
  const tops = groupThreads<T>([...messages]).tops;
  let idx = tops.findIndex((t) => t.event_id === targetId);
  if (idx < 0) {
    // 目标是回复：先看其根是否在窗口内（渲染锚在根）；根不在 → 它已被
    // groupThreads 降级为顶层（orphan 分支），同样按自身计。
    const rootId = messages.find((m) => m.event_id === targetId)?.reply?.event_id;
    if (rootId) idx = tops.findIndex((t) => t.event_id === rootId);
  }
  return idx < 0 ? 0 : tops.length - idx;
}
