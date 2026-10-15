/**
 * 聊天引用工作区文件（#87）——composer 以结构化引用把团队共享文件挂到
 * 出站 Matrix 消息的自定义 content key `com.agentteams.file_refs`
 * （与 `long_message` 回退同款模式）；收信侧归一为 file_refs 列表，
 * 收发双方渲染同一份引用 chip。纯 TS（无宿主依赖，node 可直测）。
 * 移植自 dashboard v1.3.0 src/lib/file-refs.ts（语义逐字对齐）。
 */

export const FILE_REFS_CONTENT_KEY = "com.agentteams.file_refs";

export interface FileRef {
  /** 引用文件显示名（basename）。 */
  name: string;
  /** 共享根相对键（teams/{team}/shared 之下）。 */
  key: string;
  /** 已知时的字节大小。 */
  size?: number;
}

/** 事件 content 上的信封。 */
export interface FileRefsPayload {
  refs: FileRef[];
}

const MAX_REFS = 20;
const MAX_NAME_LENGTH = 256;

function parseSingleRef(value: unknown): FileRef | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.key !== "string" || !candidate.key) return null;
  const name =
    typeof candidate.name === "string" && candidate.name
      ? candidate.name.slice(0, MAX_NAME_LENGTH)
      : candidate.key.split("/").pop() ||
        candidate.key.slice(0, MAX_NAME_LENGTH);
  const size =
    typeof candidate.size === "number" && Number.isFinite(candidate.size)
      ? candidate.size
      : undefined;
  return { name, key: candidate.key, size };
}

/**
 * 解析 `com.agentteams.file_refs` content 值。兼容信封
 * `{ refs: [...] }` 与裸数组（前向兼容），丢弃畸形条目，
 * 截断数量（恶意事件不可撑爆渲染）。
 */
export function parseFileRefs(value: unknown): FileRef[] {
  let raw: unknown = value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const envelope = value as Record<string, unknown>;
    raw = Array.isArray(envelope.refs) ? envelope.refs : [];
  }
  if (!Array.isArray(raw)) return [];
  const refs: FileRef[] = [];
  for (const entry of raw) {
    const ref = parseSingleRef(entry);
    if (ref) refs.push(ref);
    if (refs.length >= MAX_REFS) break;
  }
  return refs;
}

/** 出站构造：refs 非空 → { [FILE_REFS_CONTENT_KEY]: { refs } }；空 → {}。 */
export function buildFileRefsContent(refs?: FileRef[]): Record<string, unknown> {
  if (!refs || refs.length === 0) return {};
  const clean: FileRef[] = refs.slice(0, MAX_REFS).map((r) => {
    const out: FileRef = { name: r.name, key: r.key };
    if (typeof r.size === "number" && Number.isFinite(r.size)) out.size = r.size;
    return out;
  });
  if (clean.length === 0) return {};
  return { [FILE_REFS_CONTENT_KEY]: { refs: clean } };
}
