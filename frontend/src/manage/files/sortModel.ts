/**
 * sortModel.ts — 文件列表排序（纯逻辑，无 React / window，可 node 直测）。
 *
 * 业界口径（Finder / Explorer / Google Drive）：
 * - 表头点击切换升/降序，当前列有方向指示；
 * - **目录始终在前**（与方向无关），文件之间再按列比较；
 * - 名称用本地化比较（numeric: true，中文拼音序，`file2` < `file10`）；
 * - 大小按字节数值；时间按时间戳；缺失值排最后；
 * - 平局回落到名称升序（稳定、可预期）。
 *
 * 列：name / size / type / modified(updatedAt) / created(createdAt)。
 */
import {
  entryDisplayName,
  isEntryDir,
  type HumanFileEntry,
} from "../../api/domains/humanFiles";

export type FileSortKey = "name" | "size" | "type" | "updatedAt" | "createdAt";
export type SortDir = "asc" | "desc";
export interface FileSort {
  key: FileSortKey;
  dir: SortDir;
}

export const DEFAULT_FILE_SORT: FileSort = { key: "name", dir: "asc" };
export const FILE_SORT_STORAGE_KEY = "manage.filesSort";

const KEYS: readonly FileSortKey[] = ["name", "size", "type", "updatedAt", "createdAt"];

/** 解析持久化值（非法/缺失 → 默认名称升序）。 */
export function parseFileSort(raw: unknown): FileSort {
  if (typeof raw !== "string" || raw === "") return DEFAULT_FILE_SORT;
  try {
    const v = JSON.parse(raw) as { key?: unknown; dir?: unknown };
    const key = KEYS.includes(v.key as FileSortKey)
      ? (v.key as FileSortKey)
      : DEFAULT_FILE_SORT.key;
    const dir = v.dir === "desc" ? "desc" : "asc";
    return { key, dir };
  } catch {
    return DEFAULT_FILE_SORT;
  }
}

export function serializeFileSort(s: FileSort): string {
  return JSON.stringify({ key: s.key, dir: s.dir });
}

/** 表头点击：同列切换方向；换列 → 该列升序（名称/类型/大小/时间同口径）。 */
export function nextFileSort(cur: FileSort, key: FileSortKey): FileSort {
  if (cur.key !== key) return { key, dir: "asc" };
  return { key, dir: cur.dir === "asc" ? "desc" : "asc" };
}

function nameOf(e: HumanFileEntry): string {
  return entryDisplayName(e);
}

function compareName(a: HumanFileEntry, b: HumanFileEntry): number {
  return nameOf(a).localeCompare(nameOf(b), "zh-Hans-CN", {
    numeric: true,
    sensitivity: "base",
  });
}

/** 时间列统一的解析（无效/缺失 → null，排序时恒排最后）。 */
function parseTime(raw: unknown): number | null {
  if (typeof raw !== "string" || raw === "") return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

function valueOf(e: HumanFileEntry, key: FileSortKey): number | string | null {
  switch (key) {
    case "size":
      return typeof e.size === "number" && Number.isFinite(e.size) ? e.size : null;
    case "type": {
      if (isEntryDir(e)) return "文件夹";
      const p = nameOf(e);
      const i = p.lastIndexOf(".");
      return i > 0 && i < p.length - 1 ? p.slice(i + 1).toUpperCase() : "文件";
    }
    case "updatedAt":
      return parseTime(e.updatedAt);
    case "createdAt":
      return parseTime((e as { createdAt?: string }).createdAt);
    case "name":
    default:
      return nameOf(e);
  }
}

/** 比较两文件（不含「目录在前」，由 sortFileEntries 统一处理）。 */
export function compareFileEntries(
  a: HumanFileEntry,
  b: HumanFileEntry,
  sort: FileSort,
): number {
  const sign = sort.dir === "asc" ? 1 : -1;
  const va = valueOf(a, sort.key);
  const vb = valueOf(b, sort.key);
  // 缺失值恒排最后（不随方向翻转）。
  if (va === null && vb !== null) return 1;
  if (vb === null && va !== null) return -1;
  let cmp = 0;
  if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
  else if (typeof va === "string" && typeof vb === "string") {
    cmp =
      sort.key === "name"
        ? compareName(a, b)
        : va.localeCompare(vb, "zh-Hans-CN", { sensitivity: "base" });
  }
  if (cmp === 0) cmp = compareName(a, b); // 平局回落名称升序
  return cmp * sign;
}

/** 树视图逐层排序：根层与每个已加载目录的子项都按同一 sort 排序，
 * 返回新的 children Map（不改入参；tree 结构/展开状态不受影响）。 */
export function sortTreeLevels(
  roots: HumanFileEntry[],
  children: Map<string, HumanFileEntry[]>,
  sort: FileSort,
): { roots: HumanFileEntry[]; children: Map<string, HumanFileEntry[]> } {
  const out = new Map<string, HumanFileEntry[]>();
  for (const [k, v] of children) out.set(k, sortFileEntries(v, sort));
  return { roots: sortFileEntries(roots, sort), children: out };
}

/** 排序副本（目录恒在前；不改原数组）。 */
export function sortFileEntries(
  entries: HumanFileEntry[],
  sort: FileSort,
): HumanFileEntry[] {
  return [...entries].sort((a, b) => {
    const da = isEntryDir(a);
    const db = isEntryDir(b);
    if (da !== db) return da ? -1 : 1;
    return compareFileEntries(a, b, sort);
  });
}
