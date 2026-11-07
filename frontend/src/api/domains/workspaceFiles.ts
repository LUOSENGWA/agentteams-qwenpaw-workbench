/**
 * workspaceFiles.ts — Worker 工作区文件（知识库）域。
 *
 * 端点（controller worker_workspace_files.go；QwenPaw ≥ 2.1 才有，老控制器 404）：
 *   GET  /workers/{n}/workspace-files/tree?path=&cursor=&limit=        limit ≤ 500
 *   GET  /workers/{n}/workspace-files/file-content?path=&offset=&limit= limit ≤ 1 MiB
 *   GET  /workers/{n}/workspace-files/file-metadata?path=
 *   GET  /workers/{n}/workspace-files/file-download?path=              二进制流
 *   PUT  /workers/{n}/workspace-files/file-content?path=               body {"content"}
 *
 * 允许列表（validateKbPath）：仅 MEMORY.md / memory/** / digest/** 可达；
 * 路径 ≤ 4 段；点路径 / 绝对路径 / ".." 一律拒绝（上游 400 透传）。
 *
 * 版本门 / 降级（与 codingcli / tools 同型）：
 *   404 = 老控制器无该路由 / W8 越权隐藏 / 文件不存在 —— 入口能力探测隐藏，
 *         文件操作层原样抛错由调用方区分（探测已门控）。
 *   503 = 新控制器 kube 模式（仅 embedded 支持）→ 能力探测一并隐藏。
 *   502 = worker 容器不可达（worker 未就绪）→ 面板层给可读提示。
 *
 * 写（PUT）契约：
 *   - body 字段 `content`（string，非空，≤ 1 MiB，UTF-8 由上游校验）。
 *   - 现有文件必须带 `If-Match`（读回的 ETag）；新建文件必须不带
 *     （controller 先探上游 file-metadata 判定，违例 400）。
 *   - 409 = ETag 冲突（读后文件被改）→ 调用方提示重读。
 *   - 403 = L2 无 workspaceFileAccess=readwrite / 团队 leader 只读。
 *
 * 缓存：无（显式交互驱动新鲜度，按钮语义 = 立即生效，同 fetchWorkerTools）。
 */
import { controllerRequest, httpErrorStatus, requestJson } from "../shared";

export interface WorkspaceFileEntry {
  kind: "file" | "directory";
  name: string;
  path: string;
  /** 上游 preview_kind：directory | image | pdf | csv | text | binary。 */
  preview_kind?: "directory" | "image" | "pdf" | "csv" | "text" | "binary";
  size?: number | null;
  modified_at?: string;
}

export interface WorkspaceTreePage {
  directory: string;
  entries: WorkspaceFileEntry[];
  has_more?: boolean;
  next_cursor?: string | null;
}

export interface WorkspaceFileContent {
  content: string;
  /** 写回（If-Match）用的 ETag。 */
  etag: string;
  offset: number;
  next_offset?: number;
  eof?: boolean;
  truncated?: boolean;
  limit?: number;
  path?: string;
  encoding?: string;
}

export interface WorkspaceFileWriteResult {
  etag: string;
  path: string;
  size: number;
}

function wbFilesBase(name: string): string {
  return `/workers/${encodeURIComponent(name)}/workspace-files`;
}

/** GET tree（目录分页列表；limit 上限 500，超限由 controller 400）。 */
export async function listWorkspaceFiles(
  name: string,
  path: string,
  opts?: { cursor?: string; limit?: number },
): Promise<WorkspaceTreePage> {
  const q = new URLSearchParams();
  q.set("path", path);
  if (opts?.cursor) q.set("cursor", opts.cursor);
  if (opts?.limit) q.set("limit", String(Math.min(opts.limit, 500)));
  return (await controllerRequest(
    "GET",
    `${wbFilesBase(name)}/tree?${q.toString()}`,
  )) as WorkspaceTreePage;
}

/** GET file-content（文本分页读；limit 上限 1 MiB，offset ≥ 0）。 */
export async function readWorkspaceFile(
  name: string,
  path: string,
  opts?: { offset?: number; limit?: number },
): Promise<WorkspaceFileContent> {
  const q = new URLSearchParams();
  q.set("path", path);
  if (opts?.offset != null) q.set("offset", String(opts.offset));
  if (opts?.limit != null) q.set("limit", String(Math.min(opts.limit, 1024 * 1024)));
  return (await controllerRequest(
    "GET",
    `${wbFilesBase(name)}/file-content?${q.toString()}`,
  )) as WorkspaceFileContent;
}

/**
 * PUT file-content（写文本）。
 * 走 requestJson 直连（controllerRequest 不支持自定义头）；If-Match 语义：
 * 现有文件必传读回的 etag，新建文件不传（controller 校验，违例 400）。
 */
export async function writeWorkspaceFile(
  name: string,
  path: string,
  content: string,
  ifMatch?: string,
): Promise<WorkspaceFileWriteResult> {
  const q = new URLSearchParams({ path });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ifMatch) headers["If-Match"] = ifMatch;
  const clean = `${wbFilesBase(name)}/file-content?${q.toString()}`.replace(/^\/+/, "");
  return (await requestJson(
    `/agentteams-proxy/controller/api/v1/${clean}`,
    { method: "PUT", headers, body: JSON.stringify({ content }) },
  )) as WorkspaceFileWriteResult;
}

/**
 * GET file-download（二进制/不可预览文件的下载）→ Blob。
 * 404（老控制器/越权/不存在）与 requestJsonFull 同形抛 `HTTP {status}: {detail}`。
 */
export async function fetchWorkspaceFileBlob(
  name: string,
  path: string,
): Promise<{ blob: Blob; filename: string }> {
  const host = window.QwenPaw?.host;
  const q = new URLSearchParams({ path });
  const clean = `${wbFilesBase(name)}/file-download?${q.toString()}`.replace(/^\/+/, "");
  const full = `/agentteams-proxy/controller/api/v1/${clean}`;
  let token = "";
  try {
    token = host.getApiToken?.() || "";
  } catch {
    token = "";
  }
  let resp: Response;
  if (host?.fetch) {
    resp = await host.fetch(full);
  } else {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    resp = await fetch(host.getApiUrl(full), { headers });
  }
  if (!resp.ok) {
    let detail = "";
    try {
      const text = await resp.text();
      try {
        const data = JSON.parse(text);
        detail = data.message || data.detail || "";
      } catch {
        detail = text;
      }
    } catch {
      detail = "";
    }
    detail = detail ? `: ${detail}` : "";
    throw new Error(`HTTP ${resp.status}${detail}`);
  }
  const blob = await resp.blob();
  const filename = path.split("/").pop() || "download";
  return { blob, filename };
}

/**
 * 能力探测（版本门）：Controller 是否具备 workspace-files 路由。
 * 探测路径用 5 段（上游允许列表最多 4 段）——校验在拨号 worker 前执行：
 *   - 新控制器（worker 存在 + qwenpaw + embedded）→ 400 "path is too deep"
 *     → 支持（400 = 路由存在且校验先于 dial）。
 *   - 老控制器（无路由）→ 404 → 不支持（隐藏入口）。
 *   - 新控制器 kube 模式 → 503 → 不支持（路由存在但模式不可用，一并隐藏）。
 *   - W8 越权（worker 不在调用者 scope）→ 404 → 隐藏（与详情页可见范围一致，
 *     不产生错误提示）。
 * 5 分钟 TTL 缓存（路由级能力，会话内不翻转；避免每次渲染探测）。
 */
const probeCache = new Map<string, { ok: boolean; at: number }>();
const PROBE_TTL_MS = 5 * 60 * 1000;

export async function probeWorkspaceFilesSupported(name: string): Promise<boolean> {
  const hit = probeCache.get(name);
  if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.ok;
  let ok = false;
  try {
    // file-metadata 子路由 + 5 段路径：新控制器必 400（段数超限），
    // 200 不可能（防御：真返回 200 视为支持）。
    await controllerRequest(
      "GET",
      `${wbFilesBase(name)}/file-metadata?path=memory%2Fa%2Fb%2Fc%2Fd`,
    );
    ok = true;
  } catch (e) {
    ok = httpErrorStatus(e) === 400;
  }
  probeCache.set(name, { ok, at: Date.now() });
  return ok;
}
