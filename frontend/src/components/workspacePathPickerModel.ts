/**
 * workspacePathPickerModel.ts — 工作区访问「浏览…」目录树的纯逻辑（无 React /
 * window 依赖，可单测；组件 WorkspacePathPicker.tsx 只做渲染与状态接线）。
 *
 * 口径（16.137，#1502 续）：
 * - 树根 = 工作区 `files/`，目录 rel 一律**不带** files/ 前缀（"" = 根）；
 *   列目录用 listFiles(humanName, rel)（老形态一层列表，非递归）；
 * - 生成规则路径必须是 validateAccessPath 认可的形态：
 *     含子目录 → `files/<rel>/**`；仅本目录 → `files/<rel>`；
 *     根目录 → `files/**`（注意：裸 `files` 不带 "/" 不通过
 *     validateAccessPath（not_files），故不生成）；
 * - 顶层保留名 .trash/.sync/.control 不展示、不可选（非顶层的同名段合法，
 *   与 validateAccessPath 一致）；
 * - 每规则 ≤16 条（与 api/domains/workspaceAccess 的 MAX_PATHS_PER_RULE
 *   对齐）；去重由 mergeRulePaths 负责；
 * - 403/404 或其它拉取失败 = 该目录不可浏览（降级手动输入，不报错）。
 */
import type { HumanFileEntry } from "../api/domains/humanFiles";
import { flattenLazyTree, type LazyTreeRow } from "../manage/files/treeModel";

/** 每规则路径上限（与 api/domains/workspaceAccess 同口径）。 */
export const PICKER_MAX_PATHS = 16;

/** 顶层保留名（不可浏览 / 不可选；非顶层同名段合法）。 */
export const RESERVED_TOP_DIRS: readonly string[] = [".trash", ".sync", ".control"];

/** 目录 rel 归一：去首尾斜杠（不 trim 段内字符——段编码原样）。 */
function normRel(rel: string): string {
  return rel.replace(/^\/+|\/+$/g, "");
}

/** rel 的首段是否为顶层保留名。 */
export function isReservedTopDir(rel: string): boolean {
  const first = normRel(rel).split("/")[0];
  return RESERVED_TOP_DIRS.includes(first);
}

/** 目录条目（老形态 {name,type} / #1518 形态 {path}）→ rel。 */
function entryRel(entry: HumanFileEntry, dirRel: string): string {
  if (typeof entry.path === "string" && entry.path) {
    return normRel(entry.path.replace(/^files\//, ""));
  }
  const name = entry.name ?? "";
  if (!name) return "";
  return dirRel ? `${dirRel}/${name}` : name;
}

/**
 * 一层目录条目 → 直接子目录 rel 列表（只目录；排序稳定；顶层保留名过滤）。
 * #1518 形态按 path 前缀严格取一层，防御深层条目混入。
 */
export function childDirRels(entries: HumanFileEntry[], dirRel: string): string[] {
  const base = normRel(dirRel);
  const prefix = base ? `${base}/` : "";
  const out: string[] = [];
  for (const entry of entries ?? []) {
    const isDir =
      entry.type === "directory" ||
      (typeof entry.path === "string" && entry.path.endsWith("/"));
    if (!isDir) continue;
    const rel = entryRel(entry, base);
    if (!rel || rel === base) continue;
    if (prefix && !rel.startsWith(prefix)) continue;
    const tail = prefix ? rel.slice(prefix.length) : rel;
    if (!tail || tail.includes("/")) continue;
    if (tail === "." || tail === "..") continue;
    if (!base && isReservedTopDir(tail)) continue;
    out.push(rel);
  }
  return [...new Set(out)].sort((a, b) => a.localeCompare(b));
}

/**
 * 目录 rel + 「包含子目录」→ 规则路径。
 * 根目录恒为 `files/**`（裸 `files` 不是合法规则路径）；无尾斜杠；段原样。
 */
export function rulePathFor(rel: string, includeSubdirs: boolean): string {
  const base = normRel(rel);
  if (!base) return "files/**";
  return includeSubdirs ? `files/${base}/**` : `files/${base}`;
}

/** 多选目录 → 规则路径候选（保序；不去重——交给 mergeRulePaths）。 */
export function selectionToRulePaths(
  selected: string[],
  includeSubdirs: boolean,
): string[] {
  return selected.map((rel) => rulePathFor(rel, includeSubdirs));
}

/** 勾选开关（多选）。 */
export function toggleSelected(selected: string[], rel: string): string[] {
  return selected.includes(rel)
    ? selected.filter((x) => x !== rel)
    : [...selected, rel];
}

/** 合并候选到现有 chips：去重、保序、上限（max 默认 16）。 */
export function mergeRulePaths(
  existing: string[],
  candidates: string[],
  max: number = PICKER_MAX_PATHS,
): { paths: string[]; added: string[]; capped: boolean } {
  const paths = [...existing];
  const added: string[] = [];
  let capped = false;
  for (const cand of candidates) {
    if (!cand || paths.includes(cand)) continue;
    if (paths.length >= max) {
      capped = true;
      break;
    }
    paths.push(cand);
    added.push(cand);
  }
  return { paths, added, capped };
}

/** 剩余可新增条数（≥0）。 */
export function remainingSlots(
  existingCount: number,
  max: number = PICKER_MAX_PATHS,
): number {
  return Math.max(0, max - existingCount);
}

/** 目录加载状态（懒加载：展开才拉；失败 = 不可浏览，降级手动输入）。 */
export type DirLoadState =
  | { status: "loading" }
  | { status: "loaded"; dirs: string[] }
  | { status: "unavailable"; blocked: boolean };

/** rel → 状态（组件 state；纯对象便于单测模拟懒加载序列）。 */
export type DirLoadMap = Record<string, DirLoadState>;

/** 标记开始加载。 */
export function beginDirLoad(map: DirLoadMap, rel: string): DirLoadMap {
  return { ...map, [rel]: { status: "loading" } };
}

/** 标记加载完成（dirs = 该目录直接子目录 rel）。 */
export function applyDirLoaded(
  map: DirLoadMap,
  rel: string,
  dirs: string[],
): DirLoadMap {
  return { ...map, [rel]: { status: "loaded", dirs } };
}

/** 标记不可浏览（blocked = 403/404 权限/不存在，供 UI 区分文案）。 */
export function applyDirUnavailable(
  map: DirLoadMap,
  rel: string,
  blocked: boolean,
): DirLoadMap {
  return { ...map, [rel]: { status: "unavailable", blocked } };
}

/** 403/404 = 权限/不存在（选择器整体降级手动输入）。 */
export function isPickerUnavailable(e: unknown): boolean {
  if (e === null || typeof e !== "object") return false;
  const status = (e as { status?: unknown }).status;
  return status === 403 || status === 404;
}

/**
 * 拉一个目录并给出状态转移（组件与单测共用同一语义）：
 * loader 返回该目录条目；抛错 → unavailable（403/404 → blocked）。
 */
export async function loadDirState(
  rel: string,
  loader: (rel: string) => Promise<HumanFileEntry[]>,
): Promise<DirLoadState> {
  try {
    const entries = await loader(rel);
    return { status: "loaded", dirs: childDirRels(entries, rel) };
  } catch (e) {
    return { status: "unavailable", blocked: isPickerUnavailable(e) };
  }
}

/**
 * 目录树可见行（懒加载 + 已展开态）：直接复用 treeModel.flattenLazyTree——
 * 缩进（treeIndent）、键盘导航（treeKeyNav）、行骨架（TreeRowShell）与文件
 * 管理树同一套，不另写一份。根 ""（files/）恒为首行；子项只取已加载目录
 * （未展开 / 未加载 / 不可访问都不产生子行）。
 */
export function pickerTreeRows(
  dirs: DirLoadMap,
  expanded: readonly string[],
): LazyTreeRow<string>[] {
  const children = new Map<string, string[]>();
  for (const [rel, state] of Object.entries(dirs)) {
    if (state.status === "loaded") children.set(rel, state.dirs);
  }
  return flattenLazyTree<string>({
    roots: [""],
    keyOf: (rel) => rel,
    isDir: () => true,
    children,
    expanded: new Set(expanded),
  });
}
