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
// ── 新增（#1518/#1519/#1501/#1499 合并，main 9322b04f9；契约逐字）──────
//   GET    /api/v1/humans/{name}/files?path=<dir>&recursive=1&limit=<n>
//            &cursor=<上一页 nextKey>
//          列表扩展（#1518）：entries {path(files/ 前缀，与 manifest 同拼写),
//          size, etag, updatedAt} + nextKey（存储 key 游标；短页 = null = 到底）。
//          limit 默认 1000 上限 10000（服务端 clamp，不报 400）；recursive 硬跳过
//          .trash/ .sync/ .control/ 零字节墓碑 .keep 目录标记。
//          老控制器无 recursive/cursor 参数：带参数时老实现忽略 → 301 回普通
//          一层目录列表（无 nextKey 字段）——parseListPayload 双形态容忍，不报错。
//   POST   /api/v1/humans/{name}/files/{path}?presign=1   （#1519 预签名上传票）
//          200 {method:"PUT"|"POST", url, fields, expiresAt, maxBytes}
//          404 非成员 · 413 quota exhausted · 500 presign_unsupported（→ 回落直传）
//   POST   /api/v1/humans/{name}/files/{path}/commit      （#1519 记账）
//          200 {path, size, etag}
//          404 object_missing · 413 size_exceeded · 409 checksum_mismatch
//          （对象已被服务端删 → UI 文案「需重新上传」）
//   GET    /api/v1/humans/{name}/files/{path}?presign=1   （#1501 预签名下载）
//          200 {url, etag, size, expiresAt}；500/501（部署未开）→ 回落现有直下
//   GET    /api/v1/humans/{name}/sync/status              （#1499 同步状态）
//          200 {entries, tombstones, generation, updatedAt, updatedBy}
//          200 {}（尚无清单） · 403（未授予 file_sync） · 404（老控制器 → 隐藏入口）
//   GET    /api/v1/humans/{name}/sync/manifest            （#1499 清单原文，ETag 头）
//
// #1499 产品语义（不要越界）：服务端只存清单、永不合并；清单条目是客户端
// 语义（map[string]json.RawMessage）服务端原样存 → 浏览器端**不逐条渲染/
// 解析条目**、不替用户写清单。UI 只做：计数字段展示 + 计数级漂移提示 +
// 导出清单原文 + 403 提示。
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

/** 单个目录条目——双形态：
 * 老控制器（一层列表）：{name, type, size?, updatedAt?}（Go FileEntry，
 *   size 仅 file 有；updatedAt omitempty）；
 * #1518 新控制器（query 端点，含递归）：{path("files/a/b.txt"，files/ 前缀
 *   = manifest 同拼写), size, etag, updatedAt}（type 可能缺省 →
 *   entryRelPath/entryDisplayName 按形态推断，不硬取）。 */
export interface HumanFileEntry {
  /** 老形态 = 目录内条目名；新形态可能缺省（用 path 末段）。 */
  name?: string;
  /** 老形态恒有；新形态可能缺省（path 以 "/" 结尾 = 目录，否则文件）。 */
  type?: "file" | "directory";
  /** 新形态 = 相对存储根全路径（files/ 前缀）；老形态缺省。 */
  path?: string;
  /** 仅 file 类型有；directory 无。 */
  size?: number;
  /** omitempty；#1518 起 file 条目恒有。 */
  updatedAt?: string;
  /** #1518 file 条目（老形态无）。 */
  etag?: string;
}

/** 列目录响应——双形态（parseListPayload 归一化后回填 paginated）。 */
export interface HumanFileListResponse {
  path: string;
  entries: HumanFileEntry[];
  /** #1518 游标：string = 满页还有下一页；null = 短页到底；
   * undefined = 老控制器（无 nextKey 字段，不启用分页）。 */
  nextKey?: string | null;
  /** parseListPayload 回填：响应是否携带 #1518 形态字段（含 nextKey 键
   * 或 entries 带 path——301 回落的老形态 = false）。 */
  paginated: boolean;
}

/** listFiles 扩展参数（#1518）：recursive / limit / cursor。
 * 不带（或三项全缺）= 老形态尾斜杠路径端点（零行为变化）。 */
export interface ListFilesOptions {
  /** 递归全树（硬跳过 .trash/.sync/.control/墓碑/.keep/目录标记）。 */
  recursive?: boolean;
  /** 每页条数（服务端默认 1000，上限 10000 clamp，不报 400）。 */
  limit?: number;
  /** 上一页返回的 nextKey（string；null/undefined = 首页）。 */
  cursor?: string;
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

/** 错误体字段解析（{message}/{detail}/{error}/{code}——413 靠 code 区分
 * size vs quota）。纯文本 body 回落（#1519 commit/presign 错误码可裸词
 * 返回，如 "checksum_mismatch" 无 JSON 壳）= 裸 snake_case 词 → 当 code。 */
async function errFields(resp: Response): Promise<{ message: string; code?: string }> {
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
      /* 非 JSON body——裸词 code 回落 */
      if (/^[A-Za-z][A-Za-z0-9_]{1,63}$/.test(text.trim())) code = text.trim();
    }
  } catch {
    /* body 读失败 */
  }
  return { message, code };
}

/** fetch 路径错误（errFields 薄包装；413 靠 code 区分 size vs quota）。 */
async function readHttpError(resp: Response): Promise<HumanFilesError> {
  const { message, code } = await errFields(resp);
  return new HumanFilesError(resp.status, message || `HTTP ${resp.status}`, code);
}

/** 文件内容地址（下载复用 chat 域 downloadViaHost：host.fetch blob → a[download]）。 */
export function humanFileApiPath(humanName: string, path: string): string {
  const e = encPath(path);
  if (!e) throw new HumanFilesError(0, "空文件路径");
  return `${BASE(humanName, "files")}/${e}`;
}

// ── 3xx 单跳跟随兜底（文件区 301 收尾）────────────────────────────
// shared.requestJsonFull 对 3xx 直接 throw「HTTP xxx」且丢 Location 头，
// 无法跟随。Controller 目录路由（列目录尾斜杠语义）301 的 Location 可能是
// /api/agentteams-proxy/... 根相对插件路径——host.fetch 的相对路径通道才能
// 正确解析。故本文件自带 raw fetch：仅 301/308 且带非空 Location 时跟随
// 一次（method-preserving——写不允许降级成 GET），二跳原样返回，
// 仍非 2xx 由调用方按原逻辑报错。

/** raw JSON fetch（镜像 requestJsonFull 的 host.fetch/Bearer 注入，
 * 但 3xx 不转错——返回原始 Response 供 followRedirectOnce 判定）。 */
async function rawJsonFetch(path: string, init?: RequestInit): Promise<Response> {
  const host = window.QwenPaw.host;
  if (typeof host.fetch === "function") return host.fetch(path, init);
  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string> | undefined) || {}),
  };
  const token =
    typeof host.getApiToken === "function" ? host.getApiToken() : "";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const url = typeof host.getApiUrl === "function" ? host.getApiUrl(path) : path;
  return fetch(url, { ...init, headers });
}

/** 取重定向目标：绝对 URL → 裸 fetch（补 Bearer）；根相对 → host.fetch
 *（自带鉴权注入）优先，否则 host.getApiUrl 解析后裸 fetch（补 Bearer）。
 * 与 rawJsonFetch 同型：host.fetch 通道不手工补 token（宿主自注入），
 * 裸 fetch 通道镜像 requestJsonFull 的 Bearer 注入。 */
async function fetchRedirectTarget(
  location: string,
  init: RequestInit | undefined,
): Promise<Response> {
  const host = window.QwenPaw.host;
  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string> | undefined) || {}),
  };
  const token = typeof host.getApiToken === "function" ? host.getApiToken() : "";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (/^https?:/i.test(location)) {
    return fetch(location, { ...init, headers });
  }
  if (typeof host.fetch === "function") return host.fetch(location, init);
  return fetch(
    typeof host.getApiUrl === "function" ? host.getApiUrl(location) : location,
    { ...init, headers },
  );
}

/** 3xx 单跳跟随：仅 301/308 且带非空 Location 时跟随一次。
 * init 原样透传（method-preserving——PUT 写不得降级成 GET）；
 * 二跳返回原样，由调用方按 !ok 报错。 */
async function followRedirectOnce(
  resp: Response,
  init?: RequestInit,
): Promise<Response> {
  if (resp.status !== 301 && resp.status !== 308) return resp;
  const location = resp.headers.get("Location");
  if (!location) return resp;
  return fetchRedirectTarget(location, init);
}

/** #1518 形态判别（纯函数）：响应是否携带 query 端点字段——
 * nextKey 键存在（即使 null）或任一 entry 带 path 字符串。
 * 老控制器（含 301 回落的一层列表）= false。 */
export function isPaginatedShape(payload: Record<string, unknown> | null): boolean {
  if (!payload || typeof payload !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(payload, "nextKey")) return true;
  const entries = payload.entries;
  if (Array.isArray(entries)) {
    for (const e of entries) {
      if (e && typeof e === "object" && typeof (e as { path?: unknown }).path === "string") {
        return true;
      }
    }
  }
  return false;
}

/** 列表响应归一化（双形态 → HumanFileListResponse）。
 * nextKey 语义：string = 满页还有下一页；null = 短页到底；
 * 无 nextKey 键（老形态）= undefined（不启用分页）。 */
export function parseListPayload(
  payload: Record<string, unknown> | null,
  requestedPath: string,
): HumanFileListResponse {
  const entries = Array.isArray(payload?.entries)
    ? (payload?.entries as HumanFileEntry[])
    : [];
  return {
    path:
      typeof payload?.path === "string" && payload.path ? payload.path : requestedPath,
    entries,
    nextKey: isPaginatedShape(payload)
      ? (typeof payload?.nextKey === "string" ? payload.nextKey : null)
      : undefined,
    paginated: isPaginatedShape(payload),
  };
}

// ── 文件区目录导航守卫（#1666c：进子目录后列表不刷新/显示根内容）─────────
// 组件 load() 契约（请求打目录标签 + 错误清列表）：
//   const askedDir = <当前目录>;      // 请求时记录
//   const tag = guard.begin(askedDir);
//   const r = await listFiles(humanName, askedDir, opts);
//   const applied = guard.applyResult(tag, r)  // 失败走 applyError(tag, status, msg)
//   if (applied) { 写入 React state }          // 不一致（目录已切换）→ 丢弃
// begin() 更新「当前请求目录」标签；响应回来只有标签仍是最新才应用——
// 即使本响应比另一目录的在途请求晚到（乱序），也不会覆盖新目录的列表。
// 纯逻辑（不依赖 React / i18n），node 可直测（见 tests/h1-files-nav.test.ts）。
export interface DirListApplied {
  entries: HumanFileEntry[];
  nextKey: string | null | undefined;
  paginated: boolean;
  status: "" | "404" | "err";
  error: string;
}

export class DirListGuard {
  /** 当前请求目录（begin() 更新；undefined = 尚无请求）。 */
  private tag: string | undefined = undefined;

  /** 该响应标签是否仍为最新（组件可作 apply* 之外的独立判定）。 */
  isCurrent(tag: string): boolean {
    return this.tag === tag;
  }

  /** 为新请求打标签（记录请求时刻的目录）。 */
  begin(dir: string): string {
    this.tag = dir;
    return dir;
  }

  /** 成功响应：标签仍最新 → 返回列表状态（调用方写入 React state）；
   * 已切目录（新请求在途）→ null（丢弃，由新请求接管状态）。 */
  applyResult(tag: string, resp: HumanFileListResponse): DirListApplied | null {
    if (!this.isCurrent(tag)) return null;
    return {
      entries: resp.entries,
      nextKey: resp.nextKey,
      paginated: resp.paginated,
      status: "",
      error: "",
    };
  }

  /** 失败响应：标签不匹配 → null（丢弃）；404 → status=404（UI 占位卡，
   * 列表无关）；非 404 → 清空列表 + status=err + 错误文案——失败不再保留
   * 上一目录的旧数据（「看起来没反应」的直接来源）。 */
  applyError(tag: string, status: number, error: string): DirListApplied | null {
    if (!this.isCurrent(tag)) return null;
    if (status === 404) {
      return { entries: [], nextKey: undefined, paginated: false, status: "404", error: "" };
    }
    return { entries: [], nextKey: undefined, paginated: false, status: "err", error };
  }
}

/** 条目相对文件根路径（供 API 调用 / 行键用）。
 * 新形态 path 带 "files/" 前缀（manifest 同拼写）→ 剥前缀；
 * 老形态 = 目录内条目名（name）。 */
export function entryRelPath(e: HumanFileEntry): string {
  if (e.path) return e.path.replace(/^files\//, "");
  return e.name ?? "";
}

/** 条目显示名：新形态 = path 末段；老形态 = name。 */
export function entryDisplayName(e: HumanFileEntry): string {
  if (e.path) {
    const segs = e.path.split("/");
    return segs[segs.length - 1] || e.name || e.path;
  }
  return e.name ?? "";
}

/** 条目是否目录（双形态推断）：老形态 type 恒有；新形态 type 可能缺省 →
 * path 以 "/" 结尾 = 目录，否则按 size/etag 缺省判目录（零字节墓碑被
 * 服务端硬跳过，真实文件恒带 size）。 */
export function isEntryDir(e: HumanFileEntry): boolean {
  if (e.type) return e.type === "directory";
  if (!e.path) return false;
  return e.path.endsWith("/") || (e.size === undefined && e.etag === undefined);
}

/** 老形态目录列表 URL（尾斜杠端点）：空 dir = 根目录，恒带尾斜杠
 * （目录列表语义——此前空 dir 无尾斜杠 → Controller 目录路由 301，
 * 文件区 301 根因）。r3-files-refresh 对本行逐字断言，保持原样。 */
function legacyListFull(humanName: string, dir: string): string {
  const full = `${BASE(humanName, "files")}${dir ? `/${dir}` : ""}/`;
  return full;
}

/** #1518 query 端点 URL：path = 相对目录（不带 files/ 前缀）；limit 服务端
 * clamp（默认 1000 上限 10000，不报 400），正数才透传；cursor = 上一页 nextKey。 */
function queryListFull(humanName: string, dir: string, opts: ListFilesOptions): string {
  const q = new URLSearchParams();
  if (dir) q.set("path", dir);
  if (opts.recursive) q.set("recursive", "1");
  if (typeof opts.limit === "number" && opts.limit > 0) q.set("limit", String(opts.limit));
  if (opts.cursor) q.set("cursor", opts.cursor);
  return `${BASE(humanName, "files")}?${q.toString()}`;
}

/**
 * 列目录。
 * 无 opts（或 recursive/limit/cursor 全缺）→ 老形态尾斜杠路径端点
 * GET /humans/{name}/files/{dir}/（零行为变化）；
 * 带 recursive 或 cursor → #1518 query 端点
 * GET /files?path=<dir>&recursive=1&limit=<n>&cursor=<上一页 nextKey>
 *（entries {path,size,etag,updatedAt} + nextKey 游标）。
 * 老控制器容错：无 recursive/cursor 参数 → 老实现忽略 → 301 回普通
 * 一层目录列表（无 nextKey）——followRedirectOnce 单跳跟随，
 * parseListPayload 判老形态（paginated=false），不报错。
 * JSON 读走本文件 rawJsonFetch + 3xx 单跳跟随（shared 通道 3xx 丢
 * Location 头，无法跟随）。
 */
export async function listFiles(
  humanName: string,
  path = "",
  opts?: ListFilesOptions,
): Promise<HumanFileListResponse> {
  const dir = encPath(path);
  // recursive/cursor → #1518 query 端点；否则老形态尾斜杠端点（零行为变化）。
  const full =
    opts?.recursive || opts?.cursor ? queryListFull(humanName, dir, opts) : legacyListFull(humanName, dir);
  try {
    const resp = await followRedirectOnce(await rawJsonFetch(full));
    if (!resp.ok) throw await readHttpError(resp);
    const payload = (await resp.json()) as Record<string, unknown> | null;
    return parseListPayload(payload, path);
  } catch (e) {
    if (e instanceof HumanFilesError) throw e;
    throw fromSharedError(e);
  }
}

/** 读文件内容（GET /humans/{name}/files/{path}，具体文件 → 原始字节流 + ETag）。
 * fetch + blob（不走 controllerRequest）。 */
export async function readFileSync(humanName: string, path: string): Promise<Blob> {
  const url = humanFileApiPath(humanName, path);
  const resp0 = await fetchFile(url, resolvePluginUrl(url));
  const resp = await followRedirectOnce(resp0);
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
  const init: RequestInit = { method: "PUT", headers, body };
  const resp0 = await fetchFile(url, resolvePluginUrl(url), init);
  // 3xx 兜底：init 原样透传 = method-preserving（写不得降级成 GET）。
  const resp = await followRedirectOnce(resp0, init);
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

/** 配额 MB → 字节（四舍五入；非数 / ≤0 → 0）。UI MB 输入 → API 字节。 */
export function quotaMbToBytes(mb: number): number {
  if (!Number.isFinite(mb) || mb <= 0) return 0;
  return Math.round(mb * 1024 * 1024);
}

/** 配额字节 → MB（null / 非数 / ≤0 → null；否则 Math.max(1, Math.round(bytes/1048576))）。
 * API 字节 → UI MB 预填（1MB 下限 = InputNumber min=1 同源）。 */
export function quotaBytesToMb(bytes: number | null | undefined): number | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return null;
  return Math.max(1, Math.round(bytes / 1024 / 1024));
}

// ── #1519 预签名上传（票 → PUT/POST 对象存储 → commit 记账）────────
/** 预签名上传票（POST ?presign=1 的 200 响应体）。 */
export interface PresignUploadResponse {
  method: "PUT" | "POST";
  url: string;
  /** POST（Form）模式字段（file 字段之前 put）；PUT 模式空/缺省。 */
  fields?: Record<string, string>;
  /** ISO8601 过期时刻（TTL 默认 5min 上限 60——过期重签）。 */
  expiresAt?: string;
  /** 字节上限；file.size 超限 → 前端拦截不发送。 */
  maxBytes?: number;
}

/** presignUpload 类型化结果（不 throw）：
 * ok=false status 500/501 → 调用方回落直传（writeFileSync）；
 * 404 非成员 / 413 配额已满 → 直接上抛 UI 文案。 */
export type PresignUploadResult =
  | { ok: true; value: PresignUploadResponse }
  | { ok: false; status: number; code?: string; message: string };

/** 取预签名上传票（POST /humans/{name}/files/{path}?presign=1）。
 * 部署未开 → 500 presign_unsupported（调用方回落）。 */
export async function presignUpload(
  humanName: string,
  path: string,
): Promise<PresignUploadResult> {
  const e = encPath(path);
  if (!e) return { ok: false, status: 0, message: "空文件路径" };
  const url = `${BASE(humanName, "files")}/${e}?presign=1`;
  try {
    const resp = await rawJsonFetch(url, { method: "POST" });
    if (!resp.ok) {
      const f = await errFields(resp);
      return { ok: false, status: resp.status, code: f.code, message: f.message || `HTTP ${resp.status}` };
    }
    const j = (await resp.json()) as Record<string, unknown> | null;
    if (!j || typeof j.url !== "string" || !j.url) {
      return { ok: false, status: 500, code: "presign_unsupported", message: "presign 响应无 url" };
    }
    return {
      ok: true,
      value: {
        method: j.method === "POST" ? "POST" : "PUT",
        url: j.url,
        fields:
          j.fields && typeof j.fields === "object"
            ? (j.fields as Record<string, string>)
            : {},
        expiresAt: typeof j.expiresAt === "string" ? j.expiresAt : undefined,
        maxBytes: typeof j.maxBytes === "number" ? j.maxBytes : undefined,
      },
    };
  } catch (err) {
    const f = fromSharedError(err);
    return { ok: false, status: f.status, code: f.code, message: f.message };
  }
}

/** 票过期判定（纯函数）：expiresAt 缺省 / 解析失败 → false（乐观，
 * 服务端 commit 兜底）；≤ now → 已过期。 */
export function isTicketExpired(expiresAt: string | undefined, now: number = Date.now()): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return false;
  return t <= now;
}

/** 对象上传到预签名 URL：PUT → 裸 body（不带 Content-Type——S3 签名头
 * 不含它，带上会 403 SignatureDoesNotMatch）；POST → FormData（先 put
 * 票 fields 再 file 字段）。非 2xx → HumanFilesError(code=storage_http)；
 * 网络失败 → code=storage_network。 */
async function putPresigned(
  t: PresignUploadResponse,
  file: File | Blob,
  fileName: string,
): Promise<void> {
  try {
    let resp: Response;
    if (t.method === "PUT") {
      resp = await fetch(t.url, { method: "PUT", body: file });
    } else {
      const fd = new FormData();
      for (const [k, v] of Object.entries(t.fields ?? {})) fd.append(k, v);
      fd.append("file", file, fileName);
      resp = await fetch(t.url, { method: "POST", body: fd });
    }
    if (!resp.ok) {
      const f = await errFields(resp);
      throw new HumanFilesError(resp.status, f.message || `HTTP ${resp.status}`, f.code ?? "storage_http");
    }
  } catch (e) {
    if (e instanceof HumanFilesError) throw e;
    throw new HumanFilesError(0, e instanceof Error ? e.message : String(e), "storage_network");
  }
}

/** 上传记账（POST /humans/{name}/files/{path}/commit → 200 {path,size,etag}）。
 * 走 rawJsonFetch（shared 通道抛 "HTTP xxx" 丢 code，无法区分
 * object_missing / size_exceeded / checksum_mismatch）。
 * 成功 = 唯一记账点——仅 commit 成功后 UI 显示上传成功。 */
export async function commitUpload(
  humanName: string,
  path: string,
): Promise<{ path: string; size: number; etag: string }> {
  const e = encPath(path);
  if (!e) throw new HumanFilesError(0, "空文件路径");
  const url = `${BASE(humanName, "files")}/${e}/commit`;
  try {
    const resp = await rawJsonFetch(url, { method: "POST" });
    if (!resp.ok) throw await readHttpError(resp);
    let data: { path?: unknown; size?: unknown; etag?: unknown } = {};
    try {
      data = (await resp.json()) as { path?: unknown; size?: unknown; etag?: unknown };
    } catch {
      /* 空 body */
    }
    return {
      path: typeof data.path === "string" ? data.path : path,
      size: typeof data.size === "number" ? data.size : 0,
      etag: typeof data.etag === "string" ? data.etag : "",
    };
  } catch (err) {
    if (err instanceof HumanFilesError) throw err;
    throw fromSharedError(err);
  }
}

/** 上传结果（via 标记走的是哪条路——UI 文案/日志用）。 */
export interface UploadFileResult {
  path: string;
  size: number;
  etag: string;
  /** presign = 预签名成功（commit 已记账）；direct = presign 500/501 回落直传。 */
  via: "presign" | "direct";
}

/**
 * 上传统一入口（UI 唯一调用点）：
 * 1. presignUpload——500/501（部署未开）→ 回落 writeFileSync 直传（与旧
 *    行为零变化）；404/413 等 → 原样抛 HumanFilesError（UI 按 status/code 文案）。
 * 2. 票已过期（expiresAt ≤ now，极慢页面）→ 重签一次。
 * 3. file.size > maxBytes → 前端拦截不发送（code=max_bytes，message=上限
 *    字节数字符串，UI 用 fmtBytes(Number(message)) 格式化）。
 * 4. putPresigned 传对象 → commitUpload 记账；commit 409 checksum_mismatch /
 *    413 size_exceeded / 404 object_missing（对象已被服务端删）→ 抛错，
 *    UI 文案「需重新上传」。
 */
export async function uploadFile(
  humanName: string,
  path: string,
  file: File | Blob,
  fileName?: string,
): Promise<UploadFileResult> {
  let r = await presignUpload(humanName, path);
  if (!r.ok) {
    if (r.status === 500 || r.status === 501) {
      const d = await writeFileSync(humanName, path, file);
      return { ...d, via: "direct" };
    }
    throw new HumanFilesError(r.status, r.message, r.code);
  }
  if (isTicketExpired(r.value.expiresAt)) {
    // 票过期（罕见：页面挂起 >TTL）→ 重签一次，不循环。
    const r2 = await presignUpload(humanName, path);
    if (!r2.ok) throw new HumanFilesError(r2.status, r2.message, r2.code);
    r = r2;
  }
  const ticket = r.value;
  if (typeof ticket.maxBytes === "number" && ticket.maxBytes > 0 && file.size > ticket.maxBytes) {
    throw new HumanFilesError(0, String(ticket.maxBytes), "max_bytes");
  }
  await putPresigned(
    ticket,
    file,
    fileName ?? (((file as File).name || "") || path.split("/").pop() || "file"),
  );
  const c = await commitUpload(humanName, path);
  return { ...c, via: "presign" };
}

// ── #1501 预签名下载 ──────────────────────────────────────────────
/** 预签名下载票（GET ?presign=1 的 200 响应体）。 */
export interface PresignDownloadResponse {
  url: string;
  etag?: string;
  size?: number;
  /** ISO8601 过期时刻（UI 判定过期 → 重新取票）。 */
  expiresAt?: string;
}

/** presignDownload 类型化结果（不 throw）：500/501 → UI 回落现有直下。 */
export type PresignDownloadResult =
  | { ok: true; value: PresignDownloadResponse }
  | { ok: false; status: number; code?: string; message: string };

/** 取预签名下载票（GET /humans/{name}/files/{path}?presign=1）。 */
export async function presignDownload(
  humanName: string,
  path: string,
): Promise<PresignDownloadResult> {
  const e = encPath(path);
  if (!e) return { ok: false, status: 0, message: "空文件路径" };
  const url = `${BASE(humanName, "files")}/${e}?presign=1`;
  try {
    const resp = await followRedirectOnce(await rawJsonFetch(url));
    if (!resp.ok) {
      const f = await errFields(resp);
      return { ok: false, status: resp.status, code: f.code, message: f.message || `HTTP ${resp.status}` };
    }
    const j = (await resp.json()) as Record<string, unknown> | null;
    if (!j || typeof j.url !== "string" || !j.url) {
      return { ok: false, status: 500, code: "presign_unsupported", message: "presign 响应无 url" };
    }
    return {
      ok: true,
      value: {
        url: j.url,
        etag: typeof j.etag === "string" ? j.etag : undefined,
        size: typeof j.size === "number" ? j.size : undefined,
        expiresAt: typeof j.expiresAt === "string" ? j.expiresAt : undefined,
      },
    };
  } catch (err) {
    const f = fromSharedError(err);
    return { ok: false, status: f.status, code: f.code, message: f.message };
  }
}

/** blob → a[download] 触发浏览器保存（downloadPresignedUrl /
 * downloadTextFile 复用；document 不可用 → false）。 */
export function downloadBlob(blob: Blob, fileName: string): boolean {
  try {
    const a = document.createElement("a");
    const href = URL.createObjectURL(blob);
    a.href = href;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(href), 10000);
    return true;
  } catch {
    return false;
  }
}

/** 预签名 URL 下载（裸 fetch → blob → a[download]；预签名绝对 URL 不走
 * host.fetch——该通道只认插件路径）。失败（网络 / 非 2xx / 无 document）
 * 返回 false → 调用方回落直下。 */
export async function downloadPresignedUrl(url: string, fileName: string): Promise<boolean> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return false;
    return downloadBlob(await resp.blob(), fileName);
  } catch {
    return false;
  }
}

/** 文本存为文件（#1499 清单原文导出复用）。 */
export function downloadTextFile(text: string, fileName: string, mime = "application/json"): boolean {
  return downloadBlob(new Blob([text], { type: mime }), fileName);
}

// ── #1499 同步状态卡（只读展示 + 计数漂移 + 清单原文导出；不解析
// 条目、不写清单——产品语义见文件头）──────────────────────────────
/** 同步状态（类型化结果，永不 throw）。 */
export interface SyncStatus {
  /** ok = 有清单计数字段；empty = 200 {}（尚无清单）；
   * denied = 403（未授予 file_sync）；unsupported = 其余错误
   * （404 老控制器等）→ UI 隐藏入口。 */
  state: "ok" | "empty" | "denied" | "unsupported";
  entries?: number;
  tombstones?: number;
  generation?: number;
  updatedAt?: string;
  updatedBy?: string;
}

/** 同步状态（GET /humans/{name}/sync/status）。 */
export async function getSyncStatus(humanName: string): Promise<SyncStatus> {
  try {
    const resp = await followRedirectOnce(await rawJsonFetch(BASE(humanName, "sync/status")));
    if (resp.status === 403) return { state: "denied" };
    if (!resp.ok) return { state: "unsupported" };
    const j = (await resp.json()) as Record<string, unknown> | null;
    const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
    const str = (v: unknown): string | undefined =>
      typeof v === "string" && v ? v : undefined;
    if (
      !j ||
      (num(j.entries) === undefined &&
        num(j.tombstones) === undefined &&
        num(j.generation) === undefined &&
        !str(j.updatedAt) &&
        !str(j.updatedBy))
    ) {
      return { state: "empty" };
    }
    return {
      state: "ok",
      entries: num(j.entries),
      tombstones: num(j.tombstones),
      generation: num(j.generation),
      updatedAt: str(j.updatedAt),
      updatedBy: str(j.updatedBy),
    };
  } catch {
    return { state: "unsupported" };
  }
}

/** 清单原文（GET /humans/{name}/sync/manifest，ETag 头）。
 * 只导出原文（下载 / 复制）——**不逐条解析条目**（map[string]
 * json.RawMessage 客户端语义，产品语义禁止）。 */
export interface SyncManifestResult {
  ok: boolean;
  /** 清单原文 JSON 文本（ok only）。 */
  text?: string;
  /** 响应 ETag 头（核对用）。 */
  etag?: string;
  /** 非 ok 状态（404 = 无清单 / 老控制器；403 = 无权限）。 */
  status?: number;
}

/** 取清单原文（永不 throw）。 */
export async function getSyncManifest(humanName: string): Promise<SyncManifestResult> {
  try {
    const resp = await followRedirectOnce(await rawJsonFetch(BASE(humanName, "sync/manifest")));
    if (!resp.ok) return { ok: false, status: resp.status };
    const text = await resp.text();
    return { ok: true, text, etag: resp.headers.get("ETag") ?? undefined };
  } catch {
    return { ok: false, status: 0 };
  }
}
