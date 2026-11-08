// files-focus-fix（16.138）：文件管理树视图的高亮 / 焦点纯逻辑。
//
// 为什么抽出来：TreeArea 的 focusIndex / selectedDir 是组件本地 state，但
// 「无焦点哨兵」「清空三态」「空白点击判定」本身是纯逻辑——与
// files/treeModel、files/sortModel 同层，不依赖 React / antd / window，
// 可被 tests/files-focus-fix.vitest.test.ts 直接 import 断言（无需渲染）。

/** 空白点击判定（files-ux-r2 C 规则）：点击目标不在行 / 可交互控件内 →
 * 视为「点空白」，清焦点（多选模式同时清选择并退出多选）。 */
const BLANK_CLICK_SELECTOR =
  '[data-hf-row],button,a,input,select,textarea,[role="checkbox"],[role="menuitem"]';

export function isBlankClickTarget(target: EventTarget | null): boolean {
  const el = target as (Element & { closest?: (s: string) => Element | null }) | null;
  if (!el || typeof el.closest !== "function") return false;
  return el.closest(BLANK_CLICK_SELECTOR) === null;
}

/** 页面根容器的空白点击判定：空白 + 不在详情栏（aside）内——点详情内容
 * 不是「点别处」，不清列表 / 树高亮。 */
export function isPageBlankClickTarget(target: EventTarget | null): boolean {
  if (!isBlankClickTarget(target)) return false;
  const el = target as (Element & { closest?: (s: string) => Element | null }) | null;
  if (!el || typeof el.closest !== "function") return false;
  return el.closest("aside") === null;
}

/** 树视图「无焦点」哨兵：初值 / 切目录 / 点空白后 focusIndex = -1 → 无行高亮。 */
export const TREE_FOCUS_NONE = -1;

/** TreeArea 焦点行初值：无焦点（首帧 / 进入树视图不点亮任何行）。 */
export function initialTreeFocusIndex(): number {
  return TREE_FOCUS_NONE;
}

/** 清树本地高亮后的三态（选中目录 / 焦点行 / 上传目标）：点空白、Esc、
 * clearNonce effect 共用同一形状。 */
export function treeClearState(): {
  selectedDir: string;
  focusIndex: number;
  uploadDir: string;
} {
  return { selectedDir: "", focusIndex: TREE_FOCUS_NONE, uploadDir: "" };
}

/** 焦点行下标：无焦点（-1）/ 空列表 → -1（没有任何行高亮）；否则夹到
 * 可见行区间（折叠 / 刷新后行数变少不越界）。 */
export function treeFocusRow(focusIndex: number, rowCount: number): number {
  if (rowCount <= 0 || focusIndex < 0) return TREE_FOCUS_NONE;
  return Math.min(focusIndex, rowCount - 1);
}
