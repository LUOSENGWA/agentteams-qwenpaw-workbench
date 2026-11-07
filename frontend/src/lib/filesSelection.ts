// filesSelection — 文件管理页「多选」纯函数模型（可脱离 host 直测）。
//
// 背景：批量操作（批量删除 / 批量下载）需要一个跨行/跨卡片的选择集合，
// 列表与网格两个视图共用。选择键 = rowPath(e, dirPath) 的值：
// 新形态条目 = entryRelPath（相对存储根，**目录以 "/" 结尾**）；
// 老形态条目 = dirPath/name（无尾斜杠）。因此「尾斜杠 = 目录」守卫对
// 新形态天然成立，老形态目录由调用方以 isDir 显式标记。
//
// 约定：
// - 目录不可选（批量删除不支持目录，与单文件删除口径一致）；
// - 选择态在容器层，视图切换（列表/网格/树）只换渲染，天然保留；
// - 刷新 / 切目录后，已消失的路径由 pruneSelection 剔除（幂等，
//   无变化时原样返回，避免容器层重渲染）；
// - 全部函数纯函数、恒不修改入参 set（返回原集或新 Set）。

export type SelectionSet = ReadonlySet<string>;

export interface SelectionToggleOptions {
  /** 显式目录标记（老形态条目路径无尾斜杠，需调用方传入）。目录不可选。 */
  isDir?: boolean;
  /** shift 点击 → 从 anchor 到本点的区间选择。 */
  shiftKey?: boolean;
  /** 锚点（上一次非 shift 选择点；区间端点之一）。 */
  anchor?: string | null;
  /** 当前视图可选路径的顺序（区间定位用；应为 rowPath 序列，可含目录）。 */
  paths?: readonly string[];
}

/**
 * 单点 / 区间切换。
 * - 目录（isDir 或路径尾斜杠）→ 原样返回 set；
 * - shiftKey 且 anchor 与 path 均能在 paths 中定位 → 以 paths 顺序的
 *   闭区间 [anchor, path]（含两端）**并入**现有选择（additive：区间外
 *   已选项保留；区间内的目录行被跳过，目录不可选）；
 * - 其余情况（含 anchor 缺失 / 未命中回落）→ 单点 toggle。
 * 恒返回可用集合（原 set 或新 Set），不修改入参。
 */
export function toggleSelection(
  set: SelectionSet,
  path: string,
  opts: SelectionToggleOptions = {},
): SelectionSet {
  if (opts.isDir === true || path.endsWith("/")) return set;
  const anchor = opts.shiftKey === true ? opts.anchor ?? null : null;
  const ai = anchor != null && opts.paths ? opts.paths.indexOf(anchor) : -1;
  const bi = opts.paths ? opts.paths.indexOf(path) : -1;
  if (opts.shiftKey === true && anchor != null && opts.paths != null && ai >= 0 && bi >= 0) {
    const [lo, hi] = ai <= bi ? [ai, bi] : [bi, ai];
    const next = new Set(set);
    for (let i = lo; i <= hi; i++) {
      const p = opts.paths[i];
      if (!p.endsWith("/")) next.add(p); // 区间内的目录行跳过（目录不可选）
    }
    return next;
  }
  const next = new Set(set);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

/** 全选（过滤尾斜杠路径 = 目录）。 */
export function selectAll(paths: readonly string[]): SelectionSet {
  return new Set(paths.filter((p) => !p.endsWith("/")));
}

/** 空选择。 */
export function clearSelection(): SelectionSet {
  return new Set<string>();
}

/** 剔除已不存在的路径（刷新 / 切目录后调用）。无变化时原样返回。 */
export function pruneSelection(set: SelectionSet, currentPaths: readonly string[]): SelectionSet {
  const cur = new Set(currentPaths);
  let removed = false;
  const next = new Set<string>();
  for (const p of set) {
    if (cur.has(p)) next.add(p);
    else removed = true;
  }
  return removed ? next : set;
}

export interface SelectedSummary {
  count: number;
  bytes: number;
}

/** 选中项汇总（entries ∩ set；size 缺失按 0 计）。 */
export function selectedSummary(
  entries: readonly { path: string; size?: number }[],
  set: SelectionSet,
): SelectedSummary {
  let count = 0;
  let bytes = 0;
  for (const e of entries) {
    if (set.has(e.path)) {
      count += 1;
      bytes += e.size ?? 0;
    }
  }
  return { count, bytes };
}

export type SelectAllState = "all" | "some" | "none";

/** 「全选」控件三态（按当前视图可选路径判定；无可选文件 → none）。 */
export function selectAllState(set: SelectionSet, paths: readonly string[]): SelectAllState {
  let selectable = 0;
  let sel = 0;
  for (const p of paths) {
    if (p.endsWith("/")) continue;
    selectable += 1;
    if (set.has(p)) sel += 1;
  }
  if (sel === 0) return "none";
  return sel >= selectable ? "all" : "some";
}

/** 批量操作结果（串行执行、部分失败不中断；汇总「成功 N / 失败 M（首个错误原因）」。 */
export interface BatchOpResult {
  ok: number;
  failed: number;
  /** 首个失败原因（供汇总提示）。 */
  firstError?: string;
}
