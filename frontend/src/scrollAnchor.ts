// 前插视口锚定——纯决策（R2：移除手工 scrollHeight 差值补偿后的确定性兜底层；
// 浏览器原生 overflow-anchor 是第一道防线，本层处理「内容未溢出（无原生锚点）/
// 锚定元素丢失」等原生未覆盖的边界）。node 可测（scripts/paginationR2.smoke.mjs）。
//
// 锚点 = 前插前列表里已渲染的第一行（真实元素）。其「相对容器视口的偏移」在
// scroll 事件 / 提交后 / ResizeObserver 三条路径持续刷新（无陈旧窗口）——这是
// 与 13.10 时代差值补偿的本质区别：那时锚定值在 layout effect 里一次性快照，
// 用户在两次提交之间滚走了，回写就把视图打回顶部（「加载原消息跑到顶部」根因）。

/**
 * 前插锚定恢复决策。
 * @param oSaved 前插「前」锚定元素相对容器视口的偏移（持续刷新值）
 * @param oNow   前插「后」同一元素相对容器视口的偏移
 * @param clientH 容器视口高
 * @returns 应写入的 scrollTop 增量：
 *   - 锚定前不在视口内（用户停在列表中段/底部）→ 前插不移动视口（scrollTop 是
 *     绝对量）→ 0（无需操作）；
 *   - 锚定前在视口内 → 恢复其前插前的视口位置。浏览器原生锚定已处理时
 *     oNow≈oSaved → delta≈0 自然 no-op；原生未处理（无溢出等）→ 精确补偿。
 */
export function anchorRestoreDelta(
  oSaved: number,
  oNow: number,
  clientH: number,
  tolerance = 1,
): number {
  if (oSaved < -tolerance || oSaved > clientH + tolerance) return 0;
  return oNow - oSaved;
}
