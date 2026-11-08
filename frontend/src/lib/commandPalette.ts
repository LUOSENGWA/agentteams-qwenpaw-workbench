/**
 * commandPalette.ts — 全局命令面板（⌘K）纯函数层。
 *
 * 分工（避免屎山）：
 * - 本文件：匹配打分 / 条目装配 / 分组 / 键盘目标解析——无副作用，不碰
 *   window、React、DOM，单测直接 import 跑；
 * - components/CommandPalette.tsx：取数（首次打开懒加载 + 60s 缓存 + 失败
 *   静默）、渲染、键盘/鼠标事件、导航分发。
 *
 * 条目 key 语义（导航侧唯一契约）：
 * - quick：顶层 tab key（files / workflow / chat / settings）
 * - people：Human CR 名
 * - team：Team CR 名（不是 teamName 显示名——nav.openTeam 按 CR 名寻址）
 * - worker：Worker CR 名（manager 也在本组，role 标注）
 * - project：project_id（= 工作流 runId）
 * - file：相对文件根路径（管理页文件域根目录条目）
 */

export type PaletteGroup =
  | "quick"
  | "people"
  | "team"
  | "worker"
  | "project"
  | "file";

/** 分组展示顺序 = 键盘 ↑↓ 遍历顺序（展平数组与视觉顺序一致）。 */
export const GROUP_ORDER: PaletteGroup[] = [
  "quick",
  "people",
  "team",
  "worker",
  "project",
  "file",
];

/** 每组最多展示条数（避免面板被单组刷满）。 */
export const LIMIT_PER_GROUP = 5;

export interface PaletteItem {
  /** 全局唯一 id（group + key）：React key / 去重键。 */
  id: string;
  group: PaletteGroup;
  /** 展示主标题（数据字段或已翻译文案——本层不翻译）。 */
  title: string;
  /** 展示副标题（图标旁的第二行小字）。 */
  subtitle: string;
  /** 导航键（见文件头注释）。 */
  key: string;
  /** 附加可搜索词（只参与打分，不展示）。 */
  keywords?: string;
  /** 匹配分（buildItems 填充；快捷入口恒 0）。 */
  score?: number;
}

export interface PaletteHuman {
  name: string;
  displayName?: string;
  matrixUserID?: string;
}

export interface PaletteTeam {
  name: string;
  teamName?: string;
  leaderName?: string;
  readyWorkers?: number;
  totalWorkers?: number;
}

export interface PaletteWorker {
  name: string;
  workerName?: string;
  team?: string;
  runtime?: string;
  model?: string;
  role?: string;
}

export interface PaletteProject {
  projectId: string;
  title?: string;
  team?: string;
  status?: string;
}

export interface PaletteFile {
  /** 相对文件根路径（根目录条目 = 文件名）。 */
  path: string;
}

/** 五类数据源（各取现有 API 列表，已在组件层截断/归一）。 */
export interface PaletteSource {
  humans: PaletteHuman[];
  teams: PaletteTeam[];
  workers: PaletteWorker[];
  projects: PaletteProject[];
  files: PaletteFile[];
}

export const EMPTY_SOURCE: PaletteSource = {
  humans: [],
  teams: [],
  workers: [],
  projects: [],
  files: [],
};

/**
 * 单字段模糊打分（0 = 不匹配）。分级（分越高越靠前）：
 * - 1000 完全相等
 * - 800  前缀命中
 * - 600 - 命中位置（≥300）子串命中（越靠前越高）
 * - 300  有序子序列命中（"tld" → "team-lead"）
 * 不做拼音匹配（同 MessageSearch：需内置字典，收益低）。
 */
export function scoreMatch(text: string, query: string): number {
  const t = (text || "").toLowerCase().trim();
  const q = (query || "").toLowerCase().trim();
  if (!q || !t) return 0;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800;
  const pos = t.indexOf(q);
  if (pos > 0) return 600 - Math.min(pos, 100);
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  if (qi === q.length) return 300;
  return 0;
}

/** 字段权重：标题 > 副标题 > 附加词（副标题命中不压过标题子串命中）。 */
const FIELD_WEIGHT = { title: 1, subtitle: 0.5, keywords: 0.4 } as const;

function scoreItem(item: PaletteItem, q: string): number {
  const title = scoreMatch(item.title, q) * FIELD_WEIGHT.title;
  const subtitle = scoreMatch(item.subtitle, q) * FIELD_WEIGHT.subtitle;
  const keywords = scoreMatch(item.keywords || "", q) * FIELD_WEIGHT.keywords;
  return Math.round(Math.max(title, subtitle, keywords));
}

/** 组内排序 + 去零 + 截断（分数降序，同分按标题稳定排序）。 */
function rank(items: PaletteItem[], q: string): PaletteItem[] {
  return items
    .map((it) => ({ ...it, score: scoreItem(it, q) }))
    .filter((it) => (it.score ?? 0) > 0)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.title.localeCompare(b.title))
    .slice(0, LIMIT_PER_GROUP);
}

function peopleItems(source: PaletteSource): PaletteItem[] {
  return source.humans.map((h) => ({
    id: `people:${h.name}`,
    group: "people" as const,
    title: h.displayName || h.name,
    subtitle: h.matrixUserID || h.name,
    key: h.name,
    keywords: h.matrixUserID,
  }));
}

function teamItems(source: PaletteSource): PaletteItem[] {
  return source.teams.map((team) => ({
    id: `team:${team.name}`,
    group: "team" as const,
    title: team.teamName || team.name,
    subtitle:
      `${team.readyWorkers ?? 0}/${team.totalWorkers ?? 0} · ${team.leaderName || team.name}`,
    key: team.name,
    keywords: `${team.name} ${team.leaderName || ""}`,
  }));
}

function workerItems(source: PaletteSource): PaletteItem[] {
  return source.workers.map((w) => ({
    id: `worker:${w.name}`,
    group: "worker" as const,
    title: w.workerName || w.name,
    subtitle: [w.role, w.runtime, w.model, w.team].filter(Boolean).join(" · ") || w.name,
    key: w.name,
    keywords: `${w.name} ${w.team || ""} ${w.runtime || ""}`,
  }));
}

function projectItems(source: PaletteSource): PaletteItem[] {
  return source.projects.map((p) => ({
    id: `project:${p.projectId}`,
    group: "project" as const,
    title: p.title || p.projectId,
    subtitle: [p.status, p.team].filter(Boolean).join(" · ") || p.projectId,
    key: p.projectId,
    keywords: p.projectId,
  }));
}

function fileItems(source: PaletteSource): PaletteItem[] {
  return source.files.map((f) => ({
    id: `file:${f.path}`,
    group: "file" as const,
    title: f.path.split("/").pop() || f.path,
    subtitle: f.path,
    key: f.path,
    keywords: f.path,
  }));
}

/**
 * 装配面板条目（键盘遍历用的展平数组，视觉分组顺序与之一致）：
 * - 查询为空（含纯空白）→ 原样返回快捷入口 `quick`（不请求/不过滤）；
 * - 查询非空 → 五组各自打分排序后按 GROUP_ORDER 拼接；
 * - 全部不命中 → 返回 []（组件据此渲染空态，并保底展示快捷入口）。
 */
export function buildItems(
  source: PaletteSource,
  query: string,
  quick: PaletteItem[] = [],
): PaletteItem[] {
  const q = (query || "").trim().toLowerCase();
  if (!q) return quick;
  return [
    ...rank(peopleItems(source), q),
    ...rank(teamItems(source), q),
    ...rank(workerItems(source), q),
    ...rank(projectItems(source), q),
    ...rank(fileItems(source), q),
  ];
}

/** 分组（顺序固定 = GROUP_ORDER，空组丢弃；不做二次排序）。 */
export function groupItems(
  items: PaletteItem[],
): { group: PaletteGroup; items: PaletteItem[] }[] {
  return GROUP_ORDER.map((group) => ({
    group,
    items: items.filter((it) => it.group === group),
  })).filter((g) => g.items.length > 0);
}

/** ↑↓ 循环移动（-1 从 0 跳到末尾，+1 从末尾跳到 0；空列表恒 0）。 */
export function moveIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  const base = ((current % length) + length) % length;
  return (base + delta + length) % length;
}

/** Enter 目标解析：越界索引夹到合法区间，空列表 = null（不误触发导航）。 */
export function resolveEnterTarget(
  items: PaletteItem[],
  index: number,
): PaletteItem | null {
  if (items.length === 0) return null;
  const i = Math.min(Math.max(Math.trunc(index) || 0, 0), items.length - 1);
  return items[i] ?? null;
}

/** 当前登录 MXID → Human CR 名（文件组寻址用）。
 * 命中 humans 用 CR 名；未命中回落 MXID localpart（同 FilesSection 口径）。 */
export function resolveSelfHumanName(
  humans: PaletteHuman[],
  myUserId: string,
): string {
  const uid = (myUserId || "").trim();
  if (!uid) return "";
  const hit =
    humans.find((h) => h.matrixUserID === uid) ||
    humans.find(
      (h) => (h.matrixUserID || "").toLowerCase() === uid.toLowerCase(),
    );
  if (hit && hit.name) return hit.name;
  return uid.split(":")[0].replace(/^@/, "");
}
