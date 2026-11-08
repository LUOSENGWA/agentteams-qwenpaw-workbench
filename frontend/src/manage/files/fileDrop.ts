/**
 * fileDrop.ts — 拖拽上传的文件收集（纯逻辑，无 React / 宿主依赖，可 vitest 直测）。
 *
 * 浏览器约束：DataTransferItem.webkitGetAsEntry() 只在 drop/dragover 事件
 * 同步阶段有效——事件返回后条目失效。故分两步：
 *   ① snapshotDrop(dataTransfer)  同步拍快照（条目句柄 + 扁平文件兜底）；
 *   ② collectDrop(snapshot, 限额) 异步递归（目录 → 子文件；限 200 文件 /
 *      200 MB，超出截断并标记 truncated）。
 * 目录递归得到的 relPath = 相对当前目录路径（"docs/sub/a.txt"），供上传队列
 * 按相对路径建子目录后上传。
 */

/** 拖拽上传限额（任务书：200 文件 / 200 MB）。 */
export const DROP_MAX_FILES = 200;
export const DROP_MAX_BYTES = 200 * 1024 * 1024;

/** 文件最小结构（浏览器 File 满足；单测可用假对象）。 */
export interface DropFileLike {
  name: string;
  size: number;
}

/** webkitGetAsEntry 条目（FileSystemEntry 子集，便于单测 mock）。 */
export interface DropEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (f: DropFileLike) => void, fail?: (e: unknown) => void) => void;
  createReader?: () => {
    readEntries: (
      ok: (entries: DropEntryLike[]) => void,
      fail?: (e: unknown) => void,
    ) => void;
  };
}

/** DataTransfer 子集（只取拖拽上传需要的字段）。 */
export interface DataTransferLike {
  items?: ArrayLike<{ webkitGetAsEntry?: () => DropEntryLike | null }>;
  files?: ArrayLike<DropFileLike>;
  types?: ArrayLike<string>;
}

export interface DropSnapshot {
  entries: DropEntryLike[];
  files: DropFileLike[];
}

export interface DroppedFile {
  file: DropFileLike;
  /** 相对当前目录路径（目录拖入 = 含子目录前缀）。 */
  relPath: string;
}

export interface DropCollectResult {
  files: DroppedFile[];
  /** 命中 200 文件 / 200 MB 上限被丢弃过文件。 */
  truncated: boolean;
}

export interface DropLimits {
  maxFiles: number;
  maxBytes: number;
}

export const DROP_LIMITS: DropLimits = {
  maxFiles: DROP_MAX_FILES,
  maxBytes: DROP_MAX_BYTES,
};

/** 拖拽是否可能携带文件（决定是否激活遮罩/阻止默认）。 */
export function dragHasFiles(dt: DataTransferLike | null | undefined): boolean {
  if (!dt) return false;
  const types = dt.types;
  if (types && typeof types.length === "number") {
    for (let i = 0; i < types.length; i += 1) if (types[i] === "Files") return true;
  }
  if (dt.items && typeof dt.items.length === "number" && dt.items.length > 0) {
    for (let i = 0; i < dt.items.length; i += 1) {
      if (typeof dt.items[i]?.webkitGetAsEntry === "function") return true;
    }
  }
  return !!dt.files && typeof dt.files.length === "number" && dt.files.length > 0;
}

/** 同步拍快照（必须在 drop 事件同步阶段调用——webkitGetAsEntry 后续失效）。 */
export function snapshotDrop(
  dt: DataTransferLike | null | undefined,
): DropSnapshot {
  const entries: DropEntryLike[] = [];
  const files: DropFileLike[] = [];
  if (!dt) return { entries, files };
  const items = dt.items;
  if (items && typeof items.length === "number") {
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      // 必须作为 item 的方法调用（浏览器实现校验 this，解构后调用会抛
      // Illegal invocation）。
      if (!it || typeof it.webkitGetAsEntry !== "function") continue;
      const e = it.webkitGetAsEntry();
      if (e) entries.push(e);
    }
  }
  const flat = dt.files;
  if (flat && typeof flat.length === "number") {
    for (let i = 0; i < flat.length; i += 1) files.push(flat[i]);
  }
  return { entries, files };
}

function readFileEntry(entry: DropEntryLike): Promise<DropFileLike | null> {
  return new Promise((resolve) => {
    if (typeof entry.file !== "function") {
      resolve(null);
      return;
    }
    try {
      entry.file(
        (f) => resolve(f),
        () => resolve(null),
      );
    } catch {
      resolve(null);
    }
  });
}

/** 读完目录条目（readEntries 分批返回，空批 = 结束；批次上限防失控）。 */
function readAllEntries(entry: DropEntryLike): Promise<DropEntryLike[]> {
  return new Promise((resolve) => {
    let reader: ReturnType<NonNullable<DropEntryLike["createReader"]>>;
    try {
      const made = entry.createReader?.();
      if (!made) {
        resolve([]);
        return;
      }
      reader = made;
    } catch {
      resolve([]);
      return;
    }
    const all: DropEntryLike[] = [];
    let batches = 0;
    const step = (): void => {
      batches += 1;
      if (batches > 10000) {
        resolve(all);
        return;
      }
      try {
        reader.readEntries(
          (batch) => {
            if (!batch || batch.length === 0) {
              resolve(all);
              return;
            }
            all.push(...batch);
            step();
          },
          () => resolve(all),
        );
      } catch {
        resolve(all);
      }
    };
    step();
  });
}

interface CollectCtx {
  out: DroppedFile[];
  bytes: number;
  truncated: boolean;
  limits: DropLimits;
}

/** 单条压入（超限 → 标记截断并丢弃；不抛错）。 */
function pushFile(ctx: CollectCtx, file: DropFileLike, relPath: string): void {
  const size = typeof file.size === "number" && file.size > 0 ? file.size : 0;
  if (ctx.out.length >= ctx.limits.maxFiles || ctx.bytes + size > ctx.limits.maxBytes) {
    ctx.truncated = true;
    return;
  }
  ctx.bytes += size;
  ctx.out.push({ file, relPath });
}

async function walkEntry(
  entry: DropEntryLike,
  prefix: string,
  ctx: CollectCtx,
): Promise<void> {
  if (ctx.out.length >= ctx.limits.maxFiles || ctx.bytes >= ctx.limits.maxBytes) {
    ctx.truncated = true;
    return;
  }
  if (entry.isFile) {
    const f = await readFileEntry(entry);
    if (f) pushFile(ctx, f, `${prefix}${f.name || entry.name}`);
    return;
  }
  if (!entry.isDirectory) return;
  const kids = await readAllEntries(entry);
  const childPrefix = `${prefix}${entry.name}/`;
  for (const k of kids) {
    if (ctx.out.length >= ctx.limits.maxFiles || ctx.bytes >= ctx.limits.maxBytes) {
      ctx.truncated = true;
      return;
    }
    await walkEntry(k, childPrefix, ctx);
  }
}

/** 异步收集（目录递归 + 限额截断）。条目不展开（老宿主/单测扁平文件）时
 *  回落 dataTransfer.files（relPath = 文件名）。 */
export async function collectDrop(
  snap: DropSnapshot,
  limits: DropLimits = DROP_LIMITS,
): Promise<DropCollectResult> {
  const ctx: CollectCtx = { out: [], bytes: 0, truncated: false, limits };
  if (snap.entries.length > 0) {
    for (const e of snap.entries) {
      if (ctx.out.length >= limits.maxFiles || ctx.bytes >= limits.maxBytes) {
        ctx.truncated = true;
        break;
      }
      await walkEntry(e, "", ctx);
    }
    // 条目与扁平文件并存（部分宿主两路都给）：条目已覆盖，避免重复。
    return { files: ctx.out, truncated: ctx.truncated };
  }
  for (const f of snap.files) pushFile(ctx, f, f.name);
  return { files: ctx.out, truncated: ctx.truncated };
}

/** 需要预建的子目录（浅层在前；"a/b/c.txt" → ["a", "a/b"]）。 */
export function uniqueParentDirs(relPaths: readonly string[]): string[] {
  const set = new Set<string>();
  for (const p of relPaths) {
    const parts = p.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i += 1) {
      set.add(parts.slice(0, i).join("/"));
    }
  }
  return [...set].sort((a, b) => {
    const da = a.split("/").length;
    const db = b.split("/").length;
    if (da !== db) return da - db;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
