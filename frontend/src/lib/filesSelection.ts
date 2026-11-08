// filesSelection — 文件管理页「多选」纯函数模型（可脱离 host 直测）。
//
// 背景：批量操作（批量删除 / 批量下载）需要一个跨行/跨卡片的选择集合，
// 列表 / 树 / 网格三个视图共用。选择键 = rowPath(e, dirPath) 的值：
// 新形态条目 = entryRelPath（相对存储根，**目录以 "/" 结尾**）；
// 老形态条目 = dirPath/name（无尾斜杠）。
//
// 约定（B2 选择模型，参考 Drive / Dropbox / Element）：
// - **行焦点与批量选择分离**：focusedPath 由调用方持有（详情槽用），
//   selected 只表达批量选择；文件与目录均可选（目录也可批量删除/跳过下载）；
// - 复选框 = 单点/区间 toggleSelection，只改批量选择、不动焦点；
// - 行点击 = clickSelection：无修饰只选本行；Ctrl/Cmd 切换；Shift 区间；
// - 选择态在容器层，视图切换（列表/网格/树）只换渲染，天然保留；
// - 刷新 / 切目录后，已消失的路径由 pruneSelection 剔除（幂等，
//   无变化时原样返回，避免容器层重渲染）；
// - 全部函数纯函数、恒不修改入参 set（返回原集或新 Set）。

export type SelectionSet = ReadonlySet<string>;

export interface SelectionToggleOptions {
  /** shift 点击 → 从 anchor 到本点的区间选择。 */
  shiftKey?: boolean;
  /** 锚点（上一次非 shift 的行点击；区间端点之一）。 */
  anchor?: string | null;
  /** 当前视图可见行的顺序（区间定位用；rowPath 序列，含目录）。 */
  paths?: readonly string[];
}

/**
 * 复选框切换（只改批量选择，不改焦点）。
 * - shiftKey 且 anchor 与 path 均能在 paths 中定位 → 以 paths 顺序的
 *   闭区间 [anchor, path]（含两端，文件 + 目录）**并入**现有选择
 *   （additive：区间外已选项保留）；
 * - 其余情况（含 anchor 缺失 / 未命中回落）→ 单点 toggle。
 * 恒返回可用集合（原 set 或新 Set），不修改入参。
 */
export function toggleSelection(
  set: SelectionSet,
  path: string,
  opts: SelectionToggleOptions = {},
): SelectionSet {
  const anchor = opts.shiftKey === true ? opts.anchor ?? null : null;
  const ai = anchor != null && opts.paths ? opts.paths.indexOf(anchor) : -1;
  const bi = opts.paths ? opts.paths.indexOf(path) : -1;
  if (opts.shiftKey === true && anchor != null && opts.paths != null && ai >= 0 && bi >= 0) {
    const [lo, hi] = ai <= bi ? [ai, bi] : [bi, ai];
    const next = new Set(set);
    for (let i = lo; i <= hi; i++) next.add(opts.paths[i]);
    return next;
  }
  const next = new Set(set);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

export interface RowClickOptions extends SelectionToggleOptions {
  /** Ctrl / Cmd 点击 → 切换该行选择（focused 同步）。 */
  toggleKey?: boolean;
}

export interface RowClickResult {
  selected: SelectionSet;
  /** 新锚点（下一次 shift 区间的起点）。 */
  anchor: string;
}

/**
 * 行点击（焦点与批量选择分离模型）：
 * - Shift + 点击 → 从 anchor 到本行的可见行区间（文件 + 目录，additive）；
 *   anchor 保持；锚点不可定位 → 回落单点；
 * - Ctrl/Cmd + 点击 → 切换本行选择（focused 由调用方同步）；
 * - 无修饰 → selectedPaths 只含本行。
 * 焦点 / 目标由调用方在返回后设置（本函数不碰 focusedPath）。
 */
export function clickSelection(
  set: SelectionSet,
  path: string,
  opts: RowClickOptions = {},
): RowClickResult {
  if (opts.shiftKey === true && opts.anchor != null && opts.paths != null) {
    const ai = opts.paths.indexOf(opts.anchor);
    const bi = opts.paths.indexOf(path);
    if (ai >= 0 && bi >= 0) {
      return {
        selected: toggleSelection(set, path, {
          shiftKey: true,
          anchor: opts.anchor,
          paths: opts.paths,
        }),
        anchor: opts.anchor,
      };
    }
  }
  if (opts.toggleKey === true) {
    return { selected: toggleSelection(set, path), anchor: path };
  }
  return { selected: new Set([path]), anchor: path };
}

/** 全选（文件 + 目录，按当前可见行）。 */
export function selectAll(paths: readonly string[]): SelectionSet {
  return new Set(paths);
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

/** 「全选」控件三态（按当前视图可见行判定；文件 + 目录都计入；无行 → none）。 */
export function selectAllState(set: SelectionSet, paths: readonly string[]): SelectAllState {
  const selectable = paths.length;
  let sel = 0;
  for (const p of paths) {
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
