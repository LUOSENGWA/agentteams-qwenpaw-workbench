/**
 * textEdit.ts — 文本在线编辑的纯判定 + 保存结果映射。
 *
 * 只有文本类（text/* 语义的扩展集）且 ≤1 MiB 才允许在线编辑；保存带
 * If-Match = 打开时读到的 ETag（乐观并发，412 = 冲突）。
 * 无 React / window 依赖，可 vitest 直测。
 */
/** 在线编辑单文件上限（任务书：1 MiB）。 */
export const TEXT_EDIT_MAX_BYTES = 1024 * 1024;

/** 可编辑文本扩展集（与 FilePreview 文本预览集同源，收窄为可安全回写的
 * 纯文本/配置类；xlsx/图片不在内）。 */
const EDITABLE_EXT = new Set([
  "md",
  "markdown",
  "txt",
  "json",
  "yaml",
  "yml",
  "csv",
  "log",
  "tsv",
  "xml",
  "sql",
  "ini",
  "conf",
  "toml",
]);

function extOf(name: string): string {
  const s = String(name ?? "").trim().toLowerCase();
  const i = s.lastIndexOf(".");
  return i >= 0 ? s.slice(i + 1) : "";
}

/** 是否可在线编辑：文本类扩展 +（大小未知或 ≤1 MiB）。 */
export function isEditableText(name: string, size?: number): boolean {
  if (typeof size === "number" && Number.isFinite(size) && size > TEXT_EDIT_MAX_BYTES) {
    return false;
  }
  const ext = extOf(name);
  return ext !== "" && EDITABLE_EXT.has(ext);
}

export type SaveTextOutcome =
  | { kind: "saved"; etag?: string }
  | { kind: "conflict" }
  | { kind: "too_large" }
  | { kind: "error"; status: number; message: string };

export interface SaveTextDeps {
  write(
    path: string,
    content: string,
    ifMatch?: string,
  ): Promise<{ etag?: string }>;
}

/** 从错误对象读 HTTP status（HumanFilesError 结构性判定；无依赖）。 */
function statusOf(e: unknown): number {
  if (e && typeof e === "object" && "status" in e) {
    const s = (e as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  return 0;
}

/** 保存文本：412 → conflict（由 UI 弹「重新加载 / 覆盖保存」）；
 *  413 → too_large；其余错误原样带 status/message。 */
export async function saveText(
  deps: SaveTextDeps,
  path: string,
  content: string,
  ifMatch?: string,
): Promise<SaveTextOutcome> {
  try {
    const r = await deps.write(path, content, ifMatch);
    return { kind: "saved", etag: r?.etag };
  } catch (e) {
    const status = statusOf(e);
    if (status === 412) return { kind: "conflict" };
    if (status === 413) return { kind: "too_large" };
    return {
      kind: "error",
      status,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/** 编辑器关闭守卫（纯函数）：内容与打开时基线不同 → 需要二次确认。 */
export function needsUnsavedConfirm(content: string, baseline: string): boolean {
  return content !== baseline;
}
