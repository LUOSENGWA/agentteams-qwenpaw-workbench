// 上传队列纯模型（无 React / host / window 依赖，可 vitest 直测）。
//
// 背景：文件页上传由「一次一个、串行」改为「多选入队、并发 ≤2」。
// 队列项状态：waiting 等待 / uploading 上传中 / success 成功 / failed 失败；
// 失败项可由调用方回到 waiting 重试（retryUpload），成功/失败均可汇总进度。
// 实际上传编排（每项一次 uploadFile 调用）在 FilesSection 的 useUploadQueue，
// 本文件只负责状态机与并发仲裁，便于单测覆盖并发上限 / 失败重试。

export type UploadItemStatus = "waiting" | "uploading" | "success" | "failed";

/** 并发上限（任务书：≤2）。 */
export const UPLOAD_CONCURRENCY = 2;

export interface UploadItem {
  /** 队列内唯一 id（同一批多选 + 重试期间不变）。 */
  id: string;
  name: string;
  size: number;
  /** 上传目标（相对存储根；enqueue 时按当时的目录拍平）。 */
  path: string;
  status: UploadItemStatus;
  /** 失败原因（仅 failed；重试 / 转为其它态时清空）。 */
  error?: string;
}

export interface UploadProgress {
  total: number;
  /** 已处理 = success + failed（进度分母口径）。 */
  finished: number;
  success: number;
  failed: number;
  uploading: number;
  waiting: number;
  /** 0–100（finished / total；空队列 = 0）。 */
  percent: number;
}

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** 多选文件 → 队列项（全部 waiting）。idPrefix 用于同一页面多批入队去重。
 *  relPath = 相对 dir 的路径（拖入目录时含子目录前缀，如 "docs/a.txt"）；
 *  缺省 = 文件名（普通多选）。 */
export function makeUploadItems(
  files: readonly { name: string; size: number; relPath?: string }[],
  dir: string,
  idPrefix = "",
): UploadItem[] {
  return files.map((f, i) => {
    const rel = f.relPath || f.name;
    const item: UploadItem = {
      id: `${idPrefix}${i}-${rel}`,
      // 列表展示名 = 末段文件名（子目录路径放在 title / path）。
      name: rel.split("/").pop() || f.name,
      size: f.size,
      path: joinPath(dir, rel),
      status: "waiting",
    };
    return item;
  });
}

/** 当前可启动的 waiting 项 id（并发仲裁：limit − 在途 uploading）。
 *  返回顺序 = 队列顺序；为空 = 已满或无可启动项。 */
export function startableIds(
  items: readonly UploadItem[],
  limit: number = UPLOAD_CONCURRENCY,
): string[] {
  let running = 0;
  for (const it of items) if (it.status === "uploading") running += 1;
  const free = limit - running;
  if (free <= 0) return [];
  const out: string[] = [];
  for (const it of items) {
    if (out.length >= free) break;
    if (it.status === "waiting") out.push(it.id);
  }
  return out;
}

/** 单项状态迁移（返回新数组；无变化时原样返回，避免容器层重渲染）。
 *  error 仅 failed 态保留，其余状态一律清空。 */
export function markUploadStatus(
  items: readonly UploadItem[],
  id: string,
  status: UploadItemStatus,
  error?: string,
): UploadItem[] {
  let changed = false;
  const next = items.map((it) => {
    if (it.id !== id) return it;
    const err = status === "failed" ? error : undefined;
    if (it.status === status && it.error === err) return it;
    changed = true;
    return { ...it, status, error: err };
  });
  return changed ? next : (items as UploadItem[]);
}

/** 失败重试：failed → waiting 并清错误；其余状态原样（无变化返回原数组）。 */
export function retryUpload(items: readonly UploadItem[], id: string): UploadItem[] {
  let changed = false;
  const next = items.map((it) => {
    if (it.id !== id || it.status !== "failed") return it;
    changed = true;
    const waiting: UploadItem = { ...it, status: "waiting", error: undefined };
    return waiting;
  });
  return changed ? next : (items as UploadItem[]);
}

/** 汇总进度（总进度条 + 计数文案的唯一来源）。 */
export function uploadProgress(items: readonly UploadItem[]): UploadProgress {
  let success = 0;
  let failed = 0;
  let uploading = 0;
  let waiting = 0;
  for (const it of items) {
    if (it.status === "success") success += 1;
    else if (it.status === "failed") failed += 1;
    else if (it.status === "uploading") uploading += 1;
    else waiting += 1;
  }
  const total = items.length;
  const finished = success + failed;
  return {
    total,
    finished,
    success,
    failed,
    uploading,
    waiting,
    percent: total === 0 ? 0 : Math.round((finished / total) * 100),
  };
}
