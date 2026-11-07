/**
 * pathMove.ts — 文件区重命名 / 移动的纯模型 + 复制-删除编排。
 *
 * 控制器没有 move 端点：移动 = readFileSync(old) → writeFileSync(new)
 * → deleteFile(old)（先写后删；任一步失败保留原文件；删除失败时回滚已写入
 * 的新文件）。本文件不含 React / window 依赖，可 vitest 直测（deps 注入）。
 */

export type PathIssue = "absolute" | "dotdot" | "badchar";

export interface ValidPath {
  ok: true;
  /** 归一化后的相对路径（去首尾斜杠、折叠空段；根目录 = ""）。 */
  path: string;
}

export interface InvalidPath {
  ok: false;
  issue: PathIssue;
}

/** 相对路径校验：允许空串（根目录），禁止以 "/" 开头、反斜杠、"."/".." 段。 */
export function validateRelPath(raw: string): ValidPath | InvalidPath {
  const s = String(raw ?? "").trim();
  if (s.startsWith("/")) return { ok: false, issue: "absolute" };
  if (s.includes("\\")) return { ok: false, issue: "badchar" };
  const segs = s.split("/").filter((x) => x !== "");
  if (segs.some((seg) => seg === "." || seg === "..")) {
    return { ok: false, issue: "dotdot" };
  }
  return { ok: true, path: segs.join("/") };
}

/** 单段名称校验（重命名输入框）：非空、不含 "/" "\\"、不是 "."/".."。 */
export function validateFileName(raw: string): ValidPath | InvalidPath {
  const s = String(raw ?? "").trim();
  if (!s || s === "." || s === "..") return { ok: false, issue: "dotdot" };
  if (s.includes("/") || s.includes("\\")) return { ok: false, issue: "badchar" };
  return { ok: true, path: s };
}

/** 目录 + 名称 → 相对路径（任一段为空自动折叠）。 */
export function joinRelPath(dir: string, name: string): string {
  const a = String(dir ?? "").replace(/^\/+|\/+$/g, "");
  const b = String(name ?? "").replace(/^\/+|\/+$/g, "");
  if (!a) return b;
  if (!b) return a;
  return `${a}/${b}`;
}

/** 父目录（根目录 → ""）。 */
export function parentDir(p: string): string {
  const s = String(p ?? "").replace(/^\/+|\/+$/g, "");
  const i = s.lastIndexOf("/");
  return i < 0 ? "" : s.slice(0, i);
}

/** 末段名称。 */
export function baseName(p: string): string {
  const s = String(p ?? "").replace(/^\/+|\/+$/g, "");
  const i = s.lastIndexOf("/");
  return i < 0 ? s : s.slice(i + 1);
}

/** child 是否等于 parent 或位于 parent 之下（根目录 = 任意路径都在其下）。 */
export function isSubPath(parent: string, child: string): boolean {
  const a = String(parent ?? "").replace(/^\/+|\/+$/g, "");
  const b = String(child ?? "").replace(/^\/+|\/+$/g, "");
  if (!a) return true;
  if (a === b) return true;
  return b.startsWith(`${a}/`);
}

export type MoveIssue =
  | "invalid_source"
  | "invalid_target"
  | "into_self"
  | "same_dir";

export interface MovePlan {
  from: string;
  to: string;
  name: string;
}

export type MovePlanResult =
  | { ok: true; plan: MovePlan }
  | { ok: false; issue: MoveIssue };

/** 移动计划：from 的末段名保持不变，放到 targetDir 下。
 *  isDir 时禁止移到自身或自身子目录（否则复制-删除会自噬）。 */
export function movePath(
  source: string,
  targetDir: string,
  opts?: { isDir?: boolean },
): MovePlanResult {
  const from = validateRelPath(source);
  if (!from.ok || !from.path) return { ok: false, issue: "invalid_source" };
  const target = validateRelPath(targetDir);
  if (!target.ok) return { ok: false, issue: "invalid_target" };
  const name = baseName(from.path);
  if (!name) return { ok: false, issue: "invalid_source" };
  const to = joinRelPath(target.path, name);
  if (to === from.path) return { ok: false, issue: "same_dir" };
  if (opts?.isDir && isSubPath(from.path, to)) {
    return { ok: false, issue: "into_self" };
  }
  if (to.startsWith(`${from.path}/`)) return { ok: false, issue: "into_self" };
  return { ok: true, plan: { from: from.path, to, name } };
}

export type RenameIssue = "invalid_source" | "invalid_name" | "same_name";

export type RenamePlanResult =
  | { ok: true; plan: MovePlan }
  | { ok: false; issue: RenameIssue };

/** 重命名计划：同目录换名（from 的父目录不变）。 */
export function renamePath(source: string, newName: string): RenamePlanResult {
  const from = validateRelPath(source);
  if (!from.ok || !from.path) return { ok: false, issue: "invalid_source" };
  const name = validateFileName(newName);
  if (!name.ok) return { ok: false, issue: "invalid_name" };
  const to = joinRelPath(parentDir(from.path), name.path);
  if (to === from.path) return { ok: false, issue: "same_name" };
  return { ok: true, plan: { from: from.path, to, name: name.path } };
}

/** 列表条目 → 相对路径（老形态 = 目录内名称；新形态 = path 剥 files/ 前缀）。 */
export function entryPathInDir(
  e: { path?: string; name?: string },
  dirPath: string,
): string {
  if (e.path) return e.path.replace(/^files\//, "").replace(/\/+$/, "");
  const name = e.name ?? "";
  return dirPath ? joinRelPath(dirPath, name) : name;
}

/** 目标是否已在当前已加载列表里（同名冲突提示；不探测未加载目录）。 */
export function findExistingEntry(
  entries: readonly { path?: string; name?: string }[],
  dirPath: string,
  target: string,
): { path?: string; name?: string } | undefined {
  const t = target.replace(/\/+$/, "");
  return entries.find((e) => entryPathInDir(e, dirPath) === t);
}

// ── 复制-删除编排（deps 注入；FilesSection 用真实 API，测试用 mock）────

export interface MoveDeps {
  read(path: string): Promise<Blob>;
  write(path: string, blob: Blob): Promise<{ etag?: string }>;
  remove(path: string): Promise<void>;
}

export type MoveStep = "copying" | "deleting" | "done";

export interface MoveFailure {
  ok: false;
  step: "read" | "write" | "delete" | "rollback";
  error: unknown;
  /** delete 失败后回滚删新文件是否成功（write 前失败恒 false）。 */
  rolledBack: boolean;
  /** 回滚失败时的原始删除错误（step = "rollback"）。 */
  deleteError?: unknown;
}

export type MoveResult = { ok: true; etag?: string } | MoveFailure;

/** 执行移动：read → write（不带 If-Match，覆盖语义由调用方确认）→ remove。
 *  读/写失败：原文件未动，直接返回失败；
 *  删旧失败：删除刚写入的新文件回滚（保留原文件），返回 step="delete"；
 *  回滚也失败：step="rollback"（新文件残留 + 原文件仍在）。 */
export async function runMove(
  deps: MoveDeps,
  plan: { from: string; to: string },
  opts?: { onStep?: (s: MoveStep) => void },
): Promise<MoveResult> {
  opts?.onStep?.("copying");
  let blob: Blob;
  try {
    blob = await deps.read(plan.from);
  } catch (error) {
    return { ok: false, step: "read", error, rolledBack: false };
  }
  let etag: string | undefined;
  try {
    const w = await deps.write(plan.to, blob);
    etag = w?.etag;
  } catch (error) {
    return { ok: false, step: "write", error, rolledBack: false };
  }
  opts?.onStep?.("deleting");
  try {
    await deps.remove(plan.from);
  } catch (deleteError) {
    try {
      await deps.remove(plan.to);
      return { ok: false, step: "delete", error: deleteError, rolledBack: true };
    } catch (rollbackError) {
      return {
        ok: false,
        step: "rollback",
        error: rollbackError,
        rolledBack: false,
        deleteError,
      };
    }
  }
  opts?.onStep?.("done");
  return { ok: true, etag };
}

// ── 目录移动：递归枚举文件（空目录 → 无可移动文件，直接跳过）──────────

export interface MoveListEntry {
  path?: string;
  name?: string;
  type?: string;
  size?: number;
  etag?: string;
}

export interface MoveListPage {
  entries: MoveListEntry[];
  nextKey?: string | null;
  paginated?: boolean;
}

export type MoveListFn = (
  dir: string,
  opts?: { recursive?: boolean; cursor?: string; limit?: number },
) => Promise<MoveListPage>;

function listEntryIsDir(e: MoveListEntry): boolean {
  if (e.type) return e.type === "directory";
  const p = e.path ?? "";
  return p.endsWith("/") || (p !== "" && e.size === undefined && e.etag === undefined);
}

function listEntryPath(e: MoveListEntry, dir: string): string {
  if (e.path) return e.path.replace(/^files\//, "").replace(/\/+$/, "");
  return dir ? joinRelPath(dir, e.name ?? "") : (e.name ?? "");
}

/** 老控制器（递归参数被 301 回一层列表）→ 逐层 BFS 兜底。 */
async function collectBfs(list: MoveListFn, root: string): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [root];
  let guard = 0;
  while (queue.length > 0 && guard < 1000) {
    guard += 1;
    const dir = queue.shift() as string;
    const page = await list(dir);
    for (const e of page.entries) {
      const p = listEntryPath(e, dir);
      if (!p) continue;
      if (listEntryIsDir(e)) queue.push(p);
      else out.push(p);
    }
  }
  return out;
}

/** 枚举 root 下全部文件（不含目录本身；空目录 → []）。
 *  新控制器走 recursive + nextKey 游标；老控制器回落 BFS。 */
export async function collectFilesUnder(
  list: MoveListFn,
  root: string,
): Promise<string[]> {
  const out: string[] = [];
  const from = validateRelPath(root);
  if (!from.ok || !from.path) return out;
  let cursor: string | undefined;
  for (let guard = 0; guard < 200; guard += 1) {
    const page = await list(from.path, { recursive: true, limit: 10000, cursor });
    if (!page.paginated) return collectBfs(list, from.path);
    for (const e of page.entries) {
      if (listEntryIsDir(e)) continue;
      const p = listEntryPath(e, from.path);
      if (p) out.push(p);
    }
    if (typeof page.nextKey !== "string") return out;
    cursor = page.nextKey;
  }
  return out;
}

/** 目录移动时单个文件的源→目标映射（targetDir 下保留相对子树）。 */
export function dirChildrenPlan(
  root: string,
  targetDir: string,
  filePaths: readonly string[],
): { from: string; to: string }[] {
  const base = String(root ?? "").replace(/^\/+|\/+$/g, "");
  const target = String(targetDir ?? "").replace(/^\/+|\/+$/g, "");
  const out: { from: string; to: string }[] = [];
  for (const p of filePaths) {
    const rel = p === base ? "" : p.slice(base.length).replace(/^\/+/, "");
    if (!rel) continue;
    out.push({ from: p, to: joinRelPath(target, rel) });
  }
  return out;
}
