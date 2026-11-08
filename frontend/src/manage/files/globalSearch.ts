/**
 * globalSearch.ts — 文件管理「全局搜索」（跨目录名称 / 路径）纯逻辑。
 *
 * 无 React / window / 请求：输入归一、匹配排序、路径展示、分页状态都可在
 * node 直测（tests/files-global-search.vitest.test.ts）。
 *
 * 数据口径（组件侧）：
 * - 首次搜索 = listFiles(human, "", { recursive: true, limit: 1000 }) 的根目录
 *   递归平铺；后续经 nextKey 分页（searchPageState 判定「加载更多」）。
 * - 搜索在客户端过滤：匹配 entryDisplayName 或完整相对路径（大小写不敏感）。
 * - 排序：名称前缀命中 > 名称包含 > 路径包含；同组目录优先、名称升序。
 * - 结果最多展示 200 条（超出提示继续输入缩小范围）。
 */
import {
  entryDisplayName,
  entryRelPath,
  isEntryDir,
  type HumanFileEntry,
} from "../../api/domains/humanFiles";

/** 触发搜索的最小字符数（1 个字符只提示，不发请求）。 */
export const SEARCH_MIN_CHARS = 2;
/** 结果展示上限（超出提示「继续输入缩小范围」）。 */
export const SEARCH_RESULT_CAP = 200;
/** 首屏拉取上限（根目录递归平铺；不自动无限拉取）。 */
export const SEARCH_FETCH_LIMIT = 1000;
/** 输入去抖（ms）。 */
export const SEARCH_DEBOUNCE_MS = 250;

/** 归一后的查询（组件与纯函数共用同一形态）。 */
export interface SearchQuery {
  /** 原始输入（未 trim——输入框回显用）。 */
  raw: string;
  /** trim 后的原文（提示 / 展示用）。 */
  display: string;
  /** 小写归一的匹配串（匹配统一用值）。 */
  term: string;
  /** 有输入但不足最小长度（显示「输入至少 2 个字符」）。 */
  tooShort: boolean;
  /** 达到最小长度 → 可触发搜索。 */
  active: boolean;
}

/** 输入归一：trim + 大小写归一 + 最小长度判定。 */
export function parseSearchQuery(raw: unknown): SearchQuery {
  const source = typeof raw === "string" ? raw : "";
  const display = source.trim();
  const term = display.toLowerCase();
  return {
    raw: source,
    display,
    term,
    tooShort: display.length > 0 && display.length < SEARCH_MIN_CHARS,
    active: term.length >= SEARCH_MIN_CHARS,
  };
}

/** 命中层级：0 = 名称前缀 / 1 = 名称包含 / 2 = 路径包含。 */
export type SearchRank = 0 | 1 | 2;

export interface RankedSearch {
  /** 按层级排序后的结果（最多 SEARCH_RESULT_CAP 条）。 */
  results: HumanFileEntry[];
  /** 匹配总数（含超出展示上限的部分）。 */
  matched: number;
  /** 匹配数超过展示上限（UI：「仅显示前 200 条…」）。 */
  capped: boolean;
}

function nameOf(e: HumanFileEntry): string {
  // 目录新形态 path 可能带尾斜杠（"files/docs/"）——entryDisplayName 会回落
  // 整串路径；这里按非空段取末段（与行操作 opNameOf 同口径）。
  if (e.path && e.path.endsWith("/")) {
    const segs = e.path.split("/").filter(Boolean);
    if (segs.length > 0) return segs[segs.length - 1];
  }
  return entryDisplayName(e);
}

function relPathOf(e: HumanFileEntry): string {
  return entryRelPath(e);
}

/** 单条命中层级；null = 不匹配。 */
function rankOf(e: HumanFileEntry, term: string): SearchRank | null {
  const name = nameOf(e).toLowerCase();
  if (name.startsWith(term)) return 0;
  if (name.includes(term)) return 1;
  if (relPathOf(e).toLowerCase().includes(term)) return 2;
  return null;
}

/** 结果排序：层级升序 → 目录优先 → 名称升序（numeric + 中文拼音）。 */
function compareRanked(
  a: { entry: HumanFileEntry; rank: SearchRank },
  b: { entry: HumanFileEntry; rank: SearchRank },
): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  const da = isEntryDir(a.entry);
  const db = isEntryDir(b.entry);
  if (da !== db) return da ? -1 : 1;
  return nameOf(a.entry).localeCompare(nameOf(b.entry), "zh-Hans-CN", {
    numeric: true,
    sensitivity: "base",
  });
}

/**
 * 过滤 + 排序 + 截断。
 * query 可传字符串（内部 parseSearchQuery）或已归一对象。
 * 未达最小长度 / 空查询 → 空结果（matched 0）。
 */
export function rankSearchResults(
  entries: readonly HumanFileEntry[],
  query: string | SearchQuery,
): RankedSearch {
  const q = typeof query === "string" ? parseSearchQuery(query) : query;
  if (!q.active) return { results: [], matched: 0, capped: false };
  const hits: { entry: HumanFileEntry; rank: SearchRank }[] = [];
  for (const entry of entries) {
    const rank = rankOf(entry, q.term);
    if (rank !== null) hits.push({ entry, rank });
  }
  hits.sort(compareRanked);
  const results = hits.slice(0, SEARCH_RESULT_CAP).map((h) => h.entry);
  return {
    results,
    matched: hits.length,
    capped: hits.length > results.length,
  };
}

/**
 * 结果行的「相对路径」= 父目录（根层返回 ""）。
 * 文件 docs/a.txt → "docs"；目录 docs/a/ → "docs"；根层条目 → ""。
 */
export function formatResultPath(entry: HumanFileEntry, dirPath = ""): string {
  const rel = entry.path ? relPathOf(entry) : dirPath ? `${dirPath}/${nameOf(entry)}` : nameOf(entry);
  const trimmed = rel.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i < 0 ? "" : trimmed.slice(0, i);
}

/** 结果行完整相对路径（点击 / 详情 / 操作键）。 */
export function resultRelPath(entry: HumanFileEntry, dirPath = ""): string {
  return entry.path ? relPathOf(entry) : dirPath ? `${dirPath}/${nameOf(entry)}` : nameOf(entry);
}

export interface SearchPageState {
  /** 已拉取条目数（首屏上限内）。 */
  loaded: number;
  /** 本次拉取上限（首屏 SEARCH_FETCH_LIMIT）。 */
  limit: number;
  /** 还有下一页（nextKey 非空——UI 显示「加载更多」）。 */
  hasMore: boolean;
  /** 已拉满首屏上限（UI：「结果基于前 N 项」）。 */
  atLimit: boolean;
}

/** 分页状态（首屏最多 SEARCH_FETCH_LIMIT 条；不自动无限拉取）。 */
export function searchPageState(inp: {
  entries: readonly HumanFileEntry[];
  nextKey: string | null | undefined;
  limit?: number;
}): SearchPageState {
  const limit =
    typeof inp.limit === "number" && inp.limit > 0 ? inp.limit : SEARCH_FETCH_LIMIT;
  const loaded = inp.entries.length;
  return {
    loaded,
    limit,
    hasMore: typeof inp.nextKey === "string" && inp.nextKey !== "",
    atLimit: loaded >= limit,
  };
}
