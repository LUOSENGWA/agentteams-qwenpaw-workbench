/**
 * meta.ts — 项目/任务 meta（meta.json）读写域（#1540 控制器读端点已合，前端补齐）。
 *
 * 端点契约（逐字，上游 main project_handler.go / task_meta_commit.go）：
 *   GET  /projects/{id}/meta  200 = meta.json 原文（不重排）+ ETag 响应头；
 *                             404 = 项目不存在/无权（W4 不泄露）
 *   PUT  /projects/{id}/meta  必须带 If-Match（缺失 → 428）；不匹配 → 409
 *                             {"code":"conflict"}（body 可能带 etag/current）；
 *                             200 → 新内容的 ETag 响应头
 *   GET/PUT /tasks/{id}/meta  同项目契约；同 id 存在于多团队 →
 *                             409 {"code":"ambiguous_task"}，需带 ?team=<team> 重试
 *   老控制器（路由未部署）：两个 GET 都 405 → 前端静默隐藏入口（不报错）
 *
 * 传输走裸 fetch（不用 requestJsonFull），两个契约级原因：
 *   ① 200 body 是 meta.json 原文（不重排）——编辑器逐字显示、原样写回；
 *     requestJsonFull 对 body 做 JSON.parse 会消费流并丢失原始格式；
 *   ② 409 body 的 code（conflict / ambiguous_task）是前端区分冲突/歧义
 *     的唯一依据——requestJsonFull 错误路径只提取 detail/message/error，
 *     code 字段丢失。
 * ETag/If-Match 语义与 requestJsonFull 一致：读 ETag 响应头、PUT 带 If-Match。
 * 错误消息保持 `HTTP {status}: {detail}` 形态（httpErrorStatus 兼容）。
 */
import { httpErrorStatus } from "../shared";

/** meta 请求错误：显式携带 status + 409 body 的 code（供 classifyMetaError）。 */
export class MetaApiError extends Error {
  status: number;
  /** 409 body 的 code："conflict" | "ambiguous_task"。 */
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "MetaApiError";
    this.status = status;
    this.code = code;
  }
}

export type MetaErrorKind =
  | "unsupported" // 405（老控制器路由未部署）
  | "conflict" // 409（If-Match 不匹配）
  | "ambiguous" // 409 ambiguous_task（同 id 跨多团队，需 ?team=）
  | "not_found" // 404
  | "forbidden" // 401/403
  | "other"; // 428/5xx/网络等其余

/** 错误分类（纯函数，可测）：优先显式 status/code，回退消息里的 "HTTP xxx"。 */
export function classifyMetaError(e: unknown): MetaErrorKind {
  const st =
    e !== null &&
    typeof e === "object" &&
    typeof (e as { status?: unknown }).status === "number"
      ? (e as { status: number }).status
      : httpErrorStatus(e);
  const code =
    e !== null &&
    typeof e === "object" &&
    typeof (e as { code?: unknown }).code === "string"
      ? (e as { code: string }).code
      : undefined;
  if (st === 405) return "unsupported";
  if (st === 404) return "not_found";
  if (st === 409) return code === "ambiguous_task" ? "ambiguous" : "conflict";
  if (st === 401 || st === 403) return "forbidden";
  return "other";
}

/** meta 编辑器校验（纯函数，可测）：meta.json 必须是 JSON 对象。
 * 空对象 {} 合法（明确语义 = 清空 meta）；空串/非法 JSON/数组/标量一律
 * 拒绝（调用方据此禁止保存 + 行内红字）。 */
export type MetaValidationError = "empty" | "invalid_json" | "not_object";
export function validateMetaJson(
  text: string,
): { ok: true } | { ok: false; error: MetaValidationError } {
  const s = text.trim();
  if (s === "") return { ok: false, error: "empty" };
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  if (v === null || typeof v !== "object" || Array.isArray(v))
    return { ok: false, error: "not_object" };
  return { ok: true };
}

/** 请求头（纯函数，可测）：PUT 必须带 If-Match（缺失服务端 428）。 */
export function buildMetaHeaders(
  method: "GET" | "PUT",
  ifMatch?: string,
): Record<string, string> {
  if (method !== "PUT") return {};
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (ifMatch) h["If-Match"] = ifMatch;
  return h;
}

export interface MetaReadResult {
  /** meta.json 原文（不重排，逐字）。 */
  text: string;
  /** ETag（PUT 的 If-Match 值）。 */
  etag: string;
}

const BASE = "/agentteams-proxy/controller/api/v1";

/** 裸 fetch 传输（理由见文件头）：读 ETag 响应头，非 2xx 抛 MetaApiError
 * （携带 status + body 的 code/detail）。 */
async function metaRequest(
  path: string,
  init: { method: "GET" | "PUT"; body?: string; ifMatch?: string },
): Promise<MetaReadResult> {
  const host = window.QwenPaw?.host;
  const headers = buildMetaHeaders(init.method, init.ifMatch);
  let resp: Response;
  if (host?.fetch) {
    resp = await host.fetch(path, {
      method: init.method,
      headers,
      body: init.body,
    });
  } else {
    let token = "";
    try {
      token = host?.getApiToken?.() || "";
    } catch {
      token = "";
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    resp = await fetch(host ? host.getApiUrl(path) : path, {
      method: init.method,
      headers,
      body: init.body,
    });
  }
  const text = await resp.text();
  const etag = resp.headers.get("ETag") || "";
  if (!resp.ok) {
    let code: string | undefined;
    let detail = "";
    try {
      const p: unknown = text ? JSON.parse(text) : null;
      if (p !== null && typeof p === "object") {
        const o = p as Record<string, unknown>;
        if (typeof o.code === "string") code = o.code;
        if (typeof o.message === "string") detail = o.message;
        else if (typeof o.detail === "string") detail = o.detail;
        else if (typeof o.error === "string") detail = o.error;
      }
    } catch {
      detail = text.slice(0, 160);
    }
    throw new MetaApiError(
      detail ? `HTTP ${resp.status}: ${detail}` : `HTTP ${resp.status}`,
      resp.status,
      code,
    );
  }
  return { text, etag };
}

/** GET 项目 meta（200 = meta.json 原文 + ETag；404/405 语义见文件头）。 */
export async function getProjectMeta(id: string): Promise<MetaReadResult> {
  return metaRequest(
    `${BASE}/projects/${encodeURIComponent(id)}/meta`,
    { method: "GET" },
  );
}

/** PUT 项目 meta（body = 新 meta.json 原文；If-Match = GET 读回的 ETag；
 * 200 → 新 ETag）。 */
export async function putProjectMeta(
  id: string,
  body: string,
  etag: string,
): Promise<MetaReadResult> {
  return metaRequest(`${BASE}/projects/${encodeURIComponent(id)}/meta`, {
    method: "PUT",
    body,
    ifMatch: etag,
  });
}

/** GET 任务 meta（同 id 跨多团队 → 409 ambiguous_task；带 team 消歧）。 */
export async function getTaskMeta(
  id: string,
  team?: string,
): Promise<MetaReadResult> {
  const q = team ? `?team=${encodeURIComponent(team)}` : "";
  return metaRequest(`${BASE}/tasks/${encodeURIComponent(id)}/meta${q}`, {
    method: "GET",
  });
}

/** PUT 任务 meta（同项目契约；team 消歧 ?team=）。 */
export async function putTaskMeta(
  id: string,
  body: string,
  etag: string,
  team?: string,
): Promise<MetaReadResult> {
  const q = team ? `?team=${encodeURIComponent(team)}` : "";
  return metaRequest(`${BASE}/tasks/${encodeURIComponent(id)}/meta${q}`, {
    method: "PUT",
    body,
    ifMatch: etag,
  });
}
