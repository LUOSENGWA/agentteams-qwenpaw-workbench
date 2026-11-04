// Human Files (#1426) — Controller 人类文件存储 API（nested 路由，按 Controller
// 源码核对，非假设）。权威源：agentteams-controller/internal/server/http.go
// L126-133 路由注册：
//   GET    /api/v1/humans/{name}/files/{path...}     列目录（path 空 / 以 / 结尾 /
//                                                    ?list=1）或读文件（原始字节流
//                                                    + ETag / Content-Type，非 JSON）
//   PUT    /api/v1/humans/{name}/files/{path...}     写文件（原始字节 body，
//                                                    application/octet-stream；
//                                                    If-Match = 乐观并发，不匹配 412）
//   DELETE /api/v1/humans/{name}/files/{path...}     删除文件（→ 回收站，{trashId}）
//   GET    /api/v1/humans/{name}/trash               列回收站
//   POST   /api/v1/humans/{name}/trash/{id}/restore  恢复（200；?overwrite=1 仅 admin；
//                                                    409 = 目标路径已存在）
//   DELETE /api/v1/humans/{name}/trash/{id}          彻底删（200 {purged}；admin only → 403）
//   GET    /api/v1/humans/{name}/quota               配额（{usedBytes, quotaBytes|null}）
//   PUT    /api/v1/humans/{name}/quota               设配额（200 {quotaBytes}；admin only；
//                                                    {quotaBytes|null}，null = 清除）
//
// {name} = Human CR 的 name 字段（如 "luo"），不是文件名；
// {path...} = 文件相对路径（逐段 percent-encode，保留 "/"），空 = 列根目录。
//
// 权限矩阵（Controller 裁决；前端门控仅 best-effort）：
//   读 / 写 / 列 / 删除(→回收站) / 回收站列 / 恢复 / 配额读 = self/manager/admin 均可；
//   回收站彻底删 / 配额设 = admin only（403）。
//
// 错误统一抛 HumanFilesError{status, code?, message}，UI 按 status/code 显示文案：
//   400 路径非法（..、控制字符、Windows 保留名、.trash/.sync）
//   404 human 不存在 / 无权限 / 文件不存在
//   403 admin-only 操作（purge / putQuota）非 admin 调用
//   409 restore 目标路径已存在（未 overwrite）
//   412 etag 不匹配（乐观并发冲突）
//   413 size_exceeded（64MiB 单文件）/ quota_exceeded（配额已满）
//   错误 body：{"message": "..."} 或 {"code": "size_exceeded"} 等。

import { controllerRequest, httpErrorStatus } from "../shared";
import { fetchFile, resolvePluginUrl } from "./chat";

const V1 = "/agentteams-proxy/controller/api/v1";

/** 完整插件路径（fetch+blob / 下载链接用；{name} = Human CR name）。 */
const BASE = (name: string, sub: string): string =>
  `${V1}/humans/${encodeURIComponent(name)}/${sub}`;

/** controllerRequest 相对路径（该 helper 自带 V1 前缀）。 */
const API = (name: string, sub: string): string =>
  `/humans/${encodeURIComponent(name)}/${sub}`;

/** 相对文件路径 → URL 路径（逐段 percent-encode、保留 "/"、去首尾斜杠）。 */
function encPath(p: string): string {
  const clean = p.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!clean) return "";
  return clean
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

/** Human Files 统一错误（UI 按 status/code 分支显示 i18n 文案）。 */
export class HumanFilesError extends Error {
  /** HTTP 状态码（0 = 非 HTTP 错误）。 */
  status: number;
  /** 响应体错误码（413: size_exceeded / quota_exceeded；可缺省）。 */
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "HumanFilesError";
    this.status = status;
    this.code = code;
  }
}

/** 单个目录条目（Go FileEntry——size 仅 file 有；updatedAt omitempty）。 */
export interface HumanFileEntry {
  name: string;
  type: "file" | "directory";
  /** 仅 file 类型有；directory 无。 */
  size?: number;
  /** omitempty。 */
  updatedAt?: string;
}

/** 列目录响应（GET files/{path}，path 空 / 以 / 结尾 / ?list=1）。 */
export interface HumanFileListResponse {
  path: string;
  entries: HumanFileEntry[];
}

/** 回收站条目（Go TrashEntry）。 */
export interface HumanTrashEntry {
  id: string;
  path: string;
  size: number;
  deletedAt: string;
  caller: string;
  role: string;
}

/** 列回收站响应。 */
export interface HumanTrashResponse {
  entries: HumanTrashEntry[];
}

/** 配额（quotaBytes null = 无限制）。 */
export interface QuotaResponse {
  usedBytes: number;
  quotaBytes: number | null;
}

/** requestJson 的 "HTTP xxx: detail" 错误 → HumanFilesError（status 提取同源）。 */
function fromSharedError(e: unknown): HumanFilesError {
  const status = httpErrorStatus(e) ?? 0;
  return new HumanFilesError(status, e instanceof Error ? e.message : String(e));
}

/** fetch 路径错误体解析（{message}/{code}——413 靠 code 区分 size vs quota）。 */
async function readHttpError(resp: Response): Promise<HumanFilesError> {
  let message = "";
  let code: string | undefined;
  try {
    const text = await resp.text();
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      if (typeof j.message === "string" && j.message) message = j.message;
      else if (typeof j.detail === "string" && j.detail) message = j.detail;
      else if (typeof j.error === "string" && j.error) message = j.error;
      if (typeof j.code === "string" && j.code) code = j.code;
    } catch {
      /* 非 JSON body */
    }
  } catch {
    /* body 读失败 */
  }
  return new HumanFilesError(resp.status, message || `HTTP ${resp.status}`, code);
}

/** 文件内容地址（下载复用 chat 域 downloadViaHost：host.fetch blob → a[download]）。 */
export function humanFileApiPath(humanName: string, path: string): string {
  const e = encPath(path);
  if (!e) throw new HumanFilesError(0, "空文件路径");
  return `${BASE(humanName, "files")}/${e}`;
}

/**
 * 列目录（GET /humans/{name}/files/{path}）。
 * path 空 → 列根目录；path 指向目录 → 列该目录（URL 尾缀 "/" = 目录列表语义）。
 * JSON 读走 controllerRequest（复用现有模式）。
 */
export async function listFiles(
  humanName: string,
  path = "",
): Promise<HumanFileListResponse> {
  const dir = encPath(path);
  try {
    const payload = (await controllerRequest(
      "GET",
      dir ? `${API(humanName, "files")}/${dir}/` : API(humanName, "files"),
    )) as Partial<HumanFileListResponse> | null;
    return {
      path: typeof payload?.path === "string" ? payload.path : path,
      entries: Array.isArray(payload?.entries) ? payload.entries : [],
    };
  } catch (e) {
    throw fromSharedError(e);
  }
}

/** 读文件内容（GET /humans/{name}/files/{path}，具体文件 → 原始字节流 + ETag）。
 * fetch + blob（不走 controllerRequest）。 */
export async function readFileSync(humanName: string, path: string): Promise<Blob> {
  const url = humanFileApiPath(humanName, path);
  const resp = await fetchFile(url, resolvePluginUrl(url));
  if (!resp.ok) throw await readHttpError(resp);
  return resp.blob();
}

/** 写文件（PUT /humans/{name}/files/{path}；body = 原始字节，
 * Content-Type: application/octet-stream）。ifMatch = If-Match（乐观并发；
 * 不匹配 → 412）；不带 ifMatch 的同名写 = 覆盖。 */
export async function writeFileSync(
  humanName: string,
  path: string,
  content: Blob | string,
  ifMatch?: string,
): Promise<{ path: string; size: number; etag: string }> {
  const url = humanFileApiPath(humanName, path);
  const body = typeof content === "string" ? new Blob([content]) : content;
  const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
  if (ifMatch) headers["If-Match"] = ifMatch;
  const resp = await fetchFile(url, resolvePluginUrl(url), {
    method: "PUT",
    headers,
    body,
  });
  if (!resp.ok) throw await readHttpError(resp);
  let data: { path?: unknown; size?: unknown; etag?: unknown } = {};
  try {
    data = (await resp.json()) as { path?: unknown; size?: unknown; etag?: unknown };
  } catch {
    /* 空 body（诚实回显入参） */
  }
  return {
    path: typeof data.path === "string" ? data.path : path,
    size: typeof data.size === "number" ? data.size : body.size,
    etag: typeof data.etag === "string" ? data.etag : "",
  };
}

/** 删除文件（DELETE /humans/{name}/files/{path} → 回收站，返回 trashId）。 */
export async function deleteFile(
  humanName: string,
  path: string,
): Promise<{ trashId: string }> {
  const e = encPath(path);
  if (!e) throw new HumanFilesError(0, "空文件路径");
  try {
    const payload = (await controllerRequest(
      "DELETE",
      `${API(humanName, "files")}/${e}`,
    )) as { trashId?: unknown } | null;
    return { trashId: typeof payload?.trashId === "string" ? payload.trashId : "" };
  } catch (e2) {
    throw fromSharedError(e2);
  }
}

/** 列回收站（GET /humans/{name}/trash）。 */
export async function listTrash(humanName: string): Promise<HumanTrashResponse> {
  try {
    const payload = (await controllerRequest(
      "GET",
      API(humanName, "trash"),
    )) as Partial<HumanTrashResponse> | null;
    return {
      entries: Array.isArray(payload?.entries) ? payload.entries : [],
    };
  } catch (e) {
    throw fromSharedError(e);
  }
}

/** 恢复回收站条目（POST /humans/{name}/trash/{id}/restore → 200，body 忽略）。
 * overwrite = ?overwrite=1（仅 admin；目标路径已存在未指定 → 409）。 */
export async function restoreTrash(
  humanName: string,
  id: string,
  overwrite = false,
): Promise<void> {
  const q = overwrite ? "?overwrite=1" : "";
  try {
    await controllerRequest(
      "POST",
      `${API(humanName, "trash")}/${encodeURIComponent(id)}/restore${q}`,
    );
  } catch (e) {
    throw fromSharedError(e);
  }
}

/** 彻底删除回收站条目（DELETE /humans/{name}/trash/{id} → 200；admin only → 403）。 */
export async function purgeTrash(humanName: string, id: string): Promise<void> {
  try {
    await controllerRequest(
      "DELETE",
      `${API(humanName, "trash")}/${encodeURIComponent(id)}`,
    );
  } catch (e) {
    throw fromSharedError(e);
  }
}

/** 读配额（GET /humans/{name}/quota；quotaBytes null = 无限制）。 */
export async function getQuota(humanName: string): Promise<QuotaResponse> {
  try {
    const p = (await controllerRequest(
      "GET",
      API(humanName, "quota"),
    )) as Partial<QuotaResponse> | null;
    return {
      usedBytes: typeof p?.usedBytes === "number" ? p.usedBytes : 0,
      quotaBytes: typeof p?.quotaBytes === "number" ? p.quotaBytes : null,
    };
  } catch (e) {
    throw fromSharedError(e);
  }
}

/** 设配额（PUT /humans/{name}/quota → 200；admin only → 403）。
 * quotaBytes = null → 清除配额（无限制）。 */
export async function setQuota(
  humanName: string,
  quotaBytes: number | null,
): Promise<void> {
  try {
    await controllerRequest("PUT", API(humanName, "quota"), { quotaBytes });
  } catch (e) {
    throw fromSharedError(e);
  }
}
