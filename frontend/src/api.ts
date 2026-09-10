/** Same-origin fetch helper: prefers host.fetch, falls back to getApiUrl. */
export async function requestJson(
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const host = window.QwenPaw.host;
  const response = host.fetch
    ? await host.fetch(path, init)
    : await fetch(host.getApiUrl(path), {
        ...init,
        headers: {
          ...(init?.headers || {}),
          ...(host.getApiToken()
            ? { Authorization: `Bearer ${host.getApiToken()}` }
            : {}),
        },
      });
  const content = await response.text();
  let payload: unknown = null;
  try {
    payload = content ? JSON.parse(content) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    // 错误体兼容三种来源：插件后端 FastAPI（{detail}）、Controller 透传
    // （{message}，httputil.ErrorResponse）、Matrix（{errcode}/{error}）。
    let detail: unknown;
    if (payload && typeof payload === "object") {
      const p = payload as Record<string, unknown>;
      if (typeof p.detail === "string") detail = p.detail;
      else if (typeof p.message === "string") detail = p.message;
      else if (typeof p.error === "string") detail = p.error;
      else if (typeof p.errcode === "string")
        detail = `${p.errcode}: ${String(p.error ?? "")}`.trim();
    }
    throw new Error(
      typeof detail === "string" && detail
        ? `HTTP ${response.status}: ${detail}`
        : `HTTP ${response.status}`,
    );
  }
  return payload;
}

/** re17: 从 requestJson 错误消息提取 HTTP 状态码（failReason 分类单一真相源）。 */
export function httpErrorStatus(e: unknown): number | null {
  const m = e instanceof Error ? /^HTTP (\d{3})/.exec(e.message) : null;
  return m ? Number(m[1]) : null;
}

/** re17: 从 requestJson 错误消息提取 detail 段（剥 "HTTP xxx: " 前缀）。 */
export function httpErrorDetail(e: unknown): string {
  if (!(e instanceof Error)) return "";
  const m = /^HTTP \d{3}: (.*)$/s.exec(e.message);
  return m ? m[1] : e.message;
}

export interface SelfCheckItem {
  name: string;
  ok: boolean;
  detail?: string;
  hint?: string | null;
}

export interface SelfCheckResult {
  level?: string;
  ok: boolean;
  checks?: SelfCheckItem[];
  levels?: SelfCheckResult[];
  summary?: Record<string, string>;
  rooms?: L3RoomResult[];
}

export interface L3RoomResult {
  room_id: string;
  members?: number | null;
  members_error?: string;
  ping_ok: boolean;
  ping_event_id?: string;
  ping_error?: string;
  reply: { ok: boolean; sender?: string; body?: string; detail?: string };
  artifact?: { ok: boolean; detail: string } | null;
}

/** SGLang 集群负载（可选模块，L1 专属——/v1/loads 每 DP rank 核心字段）。 */
export interface SglangRank {
  dp_rank: number;
  num_running_reqs: number;
  num_waiting_reqs: number;
  num_used_tokens: number;
  /** 在途请求（running+waiting）token 总量——非 KV 池容量，勿当分母显示 */
  num_total_tokens: number;
  /** KV 池容量（SGLang max_total_num_tokens；旧版 /v1/loads 无此字段时为 0） */
  pool_total_tokens: number;
  /** 并发上限 max_running_requests（0=旧版无字段，前端隐藏 "/cap"） */
  max_running_requests: number;
  token_usage: number;
  utilization: number;
  cache_hit_rate: number;
  gen_throughput: number;
  /** 显存分段（GB；全 0=旧版无 memory 段，前端整行隐藏） */
  mem_weight_gb: number;
  mem_kv_gb: number;
  mem_graph_gb: number;
  mem_token_capacity: number;
}

export interface SglangLoads {
  ok: boolean;
  timestamp: string;
  accelerator: string;
  /** 每 DP rank 的加速器数（顶层；0=旧版无字段） */
  num_accelerators: number;
  /** SGLang 版本（顶层） */
  version: string;
  ranks: SglangRank[];
}

export async function fetchSglangLoads(): Promise<SglangLoads> {
  return (await requestJson("/agentteams-proxy/sglang/loads")) as SglangLoads;
}

/** 在服模型列表（SGLang /v1/models 代理；创建 Worker 模型下拉用）。
 * SGLang 模块未启用 → 404 → 返回空列表（前端降级自由输入）。 */
export async function fetchSglangModels(): Promise<string[]> {
  try {
    const d = (await requestJson(
      "/agentteams-proxy/sglang/models",
    )) as { models?: string[] };
    return d.models || [];
  } catch {
    return [];
  }
}

export interface WorkbenchConfig {
  matrix_homeservers: string[];
  controller_urls: string[];
  controller_token: string;
  matrix: {
    user_id: string;
    access_token: string;
    device_id: string;
  };
  effective?: {
    matrix: string;
    controller: string;
  };
  // v0.4.97: SGLang 双地址（内网/外网）；旧单地址 url 由后端自动迁移。
  sglang?: {
    enabled?: boolean;
    url?: string;
    urls?: string[];
  };
  // v0.5.0-beta.12: L1 管理员验证二选一（admin 账号密码 / controller_token）。
  // admin_password / console_session 服务端 redact 为 "***"（键存在=已配置）。
  admin_username?: string;
  admin_password?: string;
  gateway_admin_url?: string;
  console_session?: string;
  // v0.5.0-beta.12: token 文件路径（首选获取方式——连接器每次请求实时读，
  // 永不陈旧、轮换自动适应、不依赖 docker/终端）。非机密（路径非 token 值）。
  // v0.5.0-beta.12.4: token 解析来源（"file"=token 文件实时读 /
  // "config"=本地配置 / "env"=宿主环境变量 / "file_unreadable"|"invalid"=配置
  // 了但坏了 / ""=无）——file/env 时 controller_token 为空但 L1 数据面可用，
  // 前端门控以此为准。token 值本身永不离开连接器进程。
  controllerTokenSource?: string;
}

/** v0.5.0-beta.12: 网关面（Higress Console）列表响应——
 *  available=false = 无 Console 会话/不可达（前端优雅降级，非错误）。 */
export interface GatewayListResponse {
  available: boolean;
  data: Record<string, unknown> | unknown[] | null;
  reason?: string;
}

/** 网关 AI 路由列表（模型选择 alias 层：alias→route→provider 映射）。 */
export async function fetchGatewayAiRoutes(): Promise<GatewayListResponse> {
  return (await requestJson(
    "/agentteams-proxy/gateway/ai-routes",
  )) as GatewayListResponse;
}

/** 网关 LLM Provider 列表（alias 可解析性判定用）。 */
export async function fetchGatewayAiProviders(): Promise<GatewayListResponse> {
  return (await requestJson(
    "/agentteams-proxy/gateway/ai-providers",
  )) as GatewayListResponse;
}

/** v0.5.0-beta.12: L1 管理员验证结果。 */
export interface VerifyAdminResult {
  ok: boolean;
  mode?: "password" | "token";
  error?: string;
  note?: string;
  console?: string;
  has_console_session?: boolean;
  /** v0.5.0-beta.12：验证成功时的 alias 层自检（Console 会话立即拉
   *  /v1/ai/routes + /v1/ai/providers 计数；自检失败降级为 0/[]）。 */
  gateway_routes?: number;
  gateway_aliases?: string[];
  // v0.5.0-beta.12: token 模式来源（input/config/env）+ 来源说明消息。
  tokenSource?: string;
  message?: string;
}

/** L1 管理员验证二选一（验证通过才持久化凭据——与 dashboard「先验证再用」同款）。
 *  密码=*** 用已存值；gateway_admin_url 必填（beta.12：Console 宿主端口部署时
 *  自选、人人不同，固定端口探测已移除——留空=后端报可操作错误，不再盲探）。 */
export async function verifyAdmin(body: {
  admin_username?: string;
  admin_password?: string;
  controller_token?: string;
  gateway_admin_url?: string;
}): Promise<VerifyAdminResult> {
  return (await requestJson("/agentteams-proxy/config/verify-admin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })) as VerifyAdminResult;
}

/** v0.4.95: 连通性测试结构化诊断（点击展开详情）——
    8/24 外网 DPI 问题定位锚点：TLS 栈指纹（Python/OpenSSL 版本）+ 分步耗时 + 全栈 traceback。 */
export interface ProbeDiagStep {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}
export interface ProbeDiagError {
  message: string;
  traceback: string;
}
export interface ProbeDiagEnv {
  python: string;
  openssl: string;
  httpx: string;
  platform: string;
  proxies: Record<string, string>;
}
export interface ProbeDiag {
  target: string;
  steps: ProbeDiagStep[];
  error: ProbeDiagError | null;
  env: ProbeDiagEnv;
  ts: string;
}

/** v0.4.92: 连通性测试结果——单地址。ms=null 表示不可达。
    v0.4.93: ok=网络层连通（收到 HTTP 响应即连通，401/403 也算）；
    http_ok=状态码 <400（未鉴权/异常状态时 false，不参与生效地址竞选）。
    v0.4.95: diag=点击展开的结构化诊断（仅手动测试路径带）。 */
export interface AddressTestResult {
  url: string;
  ok: boolean;
  http_ok?: boolean;
  ms: number | null;
  detail: string;
  diag?: ProbeDiag;
}

/** v0.4.92: 连通性测试响应。applied=true 表示生效地址已按延迟重排；
    switched 标记本次测试后哪些类型的生效地址变了（测完自动切换可见）。 */
export interface ConfigTestResponse {
  ok: boolean;
  matrix: AddressTestResult[];
  controller: AddressTestResult[];
  // v0.4.97: SGLang 双地址——逐地址行（与 matrix/controller 同构）。
  sglang: AddressTestResult[] | null;
  effective: { matrix: string; controller: string };
  applied: boolean;
  switched?: { matrix: boolean; controller: boolean };
}

/** v0.4.92: 连通性测试（可传未保存的表单值；不传则测已配置地址）。 */
export async function testAddresses(
  matrix?: string[],
  controller?: string[],
  // v0.4.97: SGLang 双地址（内网/外网）列表。
  sglangUrls?: string[],
): Promise<ConfigTestResponse> {
  return (await requestJson("/agentteams-proxy/config/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      matrix: matrix?.length ? matrix : undefined,
      controller: controller?.length ? controller : undefined,
      sglang: sglangUrls?.length ? sglangUrls : undefined,
    }),
  })) as ConfigTestResponse;
}

// ── Team data (page shells render these; adapters fill them) ───────────

export interface TeamMember {
  display_name?: string;
  avatar_url?: string;
}

export interface TeamRoom {
  room_id: string;
  name: string;
  name_fallback?: boolean;
  member_count: number;
  members: Record<string, TeamMember>;
  /** 未读消息数（Matrix sync unread_notifications）。 */
  unread?: number;
  /** @高亮未读数（被点名）。 */
  unread_highlight?: number;
  /** 正在输入的用户（m.typing 事件，60s 快照新鲜度）。 */
  typing?: string[];
  /** 最后一条消息时间戳（v0.4.81：/sync timeline limit=1，聊天列表排序用）。 */
  last_ts?: number;
  /** 最后一条消息正文摘要（m.room.message 才有，≤120 字）。 */
  last_body?: string;
}

/** 邀请房间（/sync rooms.invite 段，v0.4.98 再版 8——此前插件完全不可见）。 */
export interface InviteRoom {
  room_id: string;
  name: string;
  name_fallback?: boolean;
  /** 邀请人 MXID（invite_state 的 m.room.member membership=invite 事件 sender）。 */
  inviter?: string;
  /** 邀请时间（ms epoch，排序用）。 */
  inviter_ts?: number;
}

export interface TeamsRoomsResponse {
  ok: boolean;
  rooms: TeamRoom[];
  /** v0.4.98 再版 8：待接受邀请（Element 同款邀请区数据源）。 */
  invites?: InviteRoom[];
  /** v0.4.98 再版 9：已静音房间（account_data m.muted_room 聚合）。 */
  muted_rooms?: string[];
  user_id: string;
  worker_groups?: WorkerSpawnGroup[];
  worker_tree?: WorkerTreeTeam[];
}

/** 接受邀请 = POST /_matrix/client/v3/rooms/{roomId}/join。
 * 9/3 实锤：生产 homeserver（Tuwunel/Conduit 系，部分实现）不识别
 * /invite/{userId}/accept 路由（真房/假房/r0/v3 全 M_UNRECOGNIZED 404），
 * 但 /join 可用——按 CS-API spec，受邀者对 invite 状态房间 join = 接受邀请
 * （Element joinRoom 对 invite 房间走的也是 join 端点）。
 * 成功后房间进 join 段，下次 sync 可见。 */
export async function acceptInvite(roomId: string): Promise<void> {
  await requestJson(
    `/agentteams-proxy/matrix/rooms/${encodeURIComponent(roomId)}/join`,
    { method: "POST", body: "{}" },
  );
}

/** 拒绝邀请（CS-API v3：invite 状态下的 leave=decline，Element 同款）。 */
export async function rejectInvite(roomId: string): Promise<void> {
  await requestJson(
    `/agentteams-proxy/matrix/rooms/${encodeURIComponent(roomId)}/leave`,
    { method: "POST", body: "{}" },
  );
}

export interface RoomMessage {
  event_id: string;
  sender: string;
  body: string;
  msgtype: string;
  origin_server_ts: number;
  url?: string;
  info?: unknown;
  mimetype?: string;
  filename?: string;
  /** v0.4.98 再版 10：m.file/m.image 字节数（content.info.size）——文件卡
   *  尺寸显示 + FilePreview 大小守卫（此前映射漏带 info，尺寸恒空）。 */
  size?: number;
  /** 乐观回显标记：本地插入尚未被服务器确认。 */
  pending?: boolean;
  /** 发送失败标记：pending 消息发送失败后置位，可重试。 */
  failed?: boolean;
  /** v0.4.98 再版 9：被 m.replace 编辑过（Element 同款「已编辑」标记）。 */
  edited?: boolean;
  /** v0.4.98 再版 9：被撤回（redaction，unsigned.redacted_because）。 */
  redacted?: boolean;
  /** 引用回复（m.in_reply_to）：被回复消息的 event_id 与 fallback 摘要。 */
  reply?: {
    event_id: string;
    /** "> <@sender> 原文" fallback 格式，解析后的发送者+摘要。 */
    sender?: string;
    body?: string;
  };
  /** 表情反应聚合（m.reaction m.annotation）：emoji → 计数。 */
  reactions?: Record<string, number>;
  /** 聊天内 workflow 卡片载荷（content.agentteams.workflow 自定义字段，
   *  8/18 批次 2；结构与 sync_watcher _track_workflow 消费同一事件）。 */
  workflow?: WorkflowCardPayload | null;
}

// ── 聊天内 workflow 卡片（批次 2）──────────────────────────────
// 事件解析与 dashboard 联合交叉验证基准：SC/agentteams-dashboard
// src/lib/a2ui/normalize.ts 规则 1（content['agentteams.workflow'] 键
// 命中 → workflow block，isWorkflowPayload = 非空对象）+ src/lib/
// a2ui/workflow.ts WorkflowPayload。字段名与 sync_watcher.py
// _track_workflow 一致（runId/run_id、title/name、status、steps[]）。

export interface WorkflowCardItem {
  id?: string;
  name?: string;
  title?: string;
  status?: string;
  [key: string]: unknown;
}

export interface WorkflowCardPayload {
  title?: string;
  name?: string;
  status?: string;
  runId?: string;
  run_id?: string;
  subagents?: WorkflowCardItem[];
  steps?: WorkflowCardItem[];
  [key: string]: unknown;
}

/** dashboard isWorkflowPayload 同款校验（规则 1 判定标准）。 */
export function isWorkflowPayload(value: unknown): value is WorkflowCardPayload {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

/** mxc://server/mediaId → 后端媒体代理 URL（auth-free 下载）。 */
export function mxcToMediaUrl(mxc: string): string {
  const match = /^mxc:\/\/([^/]+)\/(.+)$/.exec(mxc || "");
  if (!match) return "";
  return `/agentteams-proxy/media/${match[1]}/${encodeURIComponent(match[2])}`;
}

/**
 * 文件事件 url 统一解析（v0.4.84——「md 预览出 QwenPaw Console HTML」根治）：
 * mxc:// → 后端媒体代理；http(s):// → 直链原样（Worker 可能发非 mxc 链接）；
 * 其他 → ""。⚠️ 调用方必须处理 ""：fetch("") = 取当前页面自身（SPA 壳），
 * 此前的事故正是 mxcToMediaUrl 对非 mxc url 回 "" → fetch("") → 控制台 HTML。
 */
export function resolveFileUrl(raw: string | null | undefined): string {
  return resolveFileTarget(raw).url;
}

/**
 * v0.4.85: 裸插件 API 路径 → 真实可请求 URL（宿主 getApiUrl 解析）。
 * 宿主把插件路由挂在 /api + prefix 下（plugin.py register_http_router）；
 * 浏览器直接请求裸 /agentteams-proxy/... 会落进 SPA 兜底返回 index.html
 *（1073B HTML，8/22 真机实测：星闪SLE报告 md 预览「内容是网页」）。
 * 所有「浏览器直连」文件地址（fetch / img src / a href）必须经本函数
 * 或 host.fetch（见 fetchFile / downloadViaHost）。
 */
export function resolvePluginUrl(path: string): string {
  try {
    const host = window.QwenPaw?.host;
    if (host && typeof host.getApiUrl === "function") {
      return host.getApiUrl(path);
    }
  } catch {
    /* 无宿主环境（dev）→ 保持裸路径 */
  }
  return path;
}

/**
 * v0.4.85: 带鉴权的文件 fetch。插件路径（apiPath）走 host.fetch
 *（自动注入 Authorization / X-Agent-Id）；http 直链或无宿主时裸 fetch。
 * 返回 Response，语义与 fetch 一致。
 */
export async function fetchFile(
  apiPath: string | null | undefined,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  try {
    if (apiPath) {
      const host = window.QwenPaw?.host;
      if (host && typeof host.fetch === "function") {
        return await host.fetch(apiPath, init);
      }
    }
  } catch {
    /* fall through to bare fetch */
  }
  return fetch(url, init);
}

/**
 * v0.4.85: 文件地址统一解析——mxc → 插件媒体代理（apiPath + 解析后 URL）、
 * http(s) → 原样直链、其他 → ""。调用方必须处理 url=""（v0.4.84 空地址守卫）。
 * apiPath = 裸插件路径，与 fetchFile / downloadViaHost 配套使用。
 */
export function resolveFileTarget(
  raw: string | null | undefined,
): { url: string; apiPath?: string; rawUrl?: string } {
  const s = String(raw || "");
  if (!s) return { url: "" };
  if (/^https?:\/\//i.test(s)) {
    // v0.4.98 再版 10：直链常跨域（Worker 发内网 http 地址，浏览器 fetch
    // 被 CORS 拦、a[download] 跨域变导航）→ 附服务端代抓路径
    // （/media/proxy?url=，后端与文件服务器同网段可达）；url 保留给
    // 「新窗口打开原链接」兜底（顶层导航不受 CORS 限制）。
    return {
      url: s,
      apiPath: `/media/proxy?url=${encodeURIComponent(s)}`,
      rawUrl: s,
    };
  }
  const path = mxcToMediaUrl(s);
  if (!path) {
    // file:// / 裸路径 / 畸形地址——不可 fetch；rawUrl 透传供预览错误态
    // 展示原值（v0.4.84「没有可用的文件地址」只有提示没有证据的补强）。
    return { url: "", rawUrl: s };
  }
  return { url: resolvePluginUrl(path), apiPath: path, rawUrl: s };
}

/**
 * v0.4.85: 插件路径文件 blob 下载（host.fetch → a[download]）。
 * 裸链接 href 导航无法带鉴权头，直接开 /api/... 会 401。
 * 返回是否成功；用户提示由调用方负责。
 */
export async function downloadViaHost(
  apiPath: string,
  filename: string,
): Promise<boolean> {
  try {
    const resp = await fetchFile(apiPath, resolvePluginUrl(apiPath));
    if (!resp.ok) return false;
    const blob = await resp.blob();
    const obj = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = obj;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(obj), 5000);
    return true;
  } catch {
    return false;
  }
}

/** 产物条目（跨房间 m.file/m.image 聚合，产物页数据源）。 */
export interface Artifact {
  event_id: string;
  room_id: string;
  room_name: string;
  sender: string;
  ts: number;
  msgtype: "m.file" | "m.image";
  url: string;
  filename: string;
  body: string;
  mimetype: string;
  size: number | null;
}

export async function fetchArtifacts(force = false): Promise<Artifact[]> {
  const data = (await requestJson(
    `/agentteams-proxy/artifacts${force ? "?force=true" : ""}`,
  )) as { items?: Artifact[] };
  return data.items || [];
}

export interface RoomMessagesPage {
  messages: RoomMessage[];
  end: string; // Matrix /messages end token（dir=b 向上翻页用）
  start: string; // dir=f 向下翻页用
  error?: string; // "not_found" = 房间已不存在（升级清理后僵尸房间）
}

/** 消息搜索结果（B1）：后端已映射房间名 + 截断正文。 */
export interface SearchResultItem {
  room_id: string;
  room_name: string;
  event_id: string;
  sender: string;
  body: string;
  origin_server_ts: number;
}

export interface SearchPage {
  ok: boolean;
  count: number;
  next_batch: string;
  results: SearchResultItem[];
}

/** Matrix /search 全文检索：房间内传 roomId，跨房间不传。 */
export async function searchMessages(
  term: string,
  opts: { roomId?: string; nextBatch?: string; limit?: number } = {},
): Promise<SearchPage> {
  const body: Record<string, unknown> = { term: term.trim() };
  if (opts.roomId) body.roomId = opts.roomId;
  if (opts.nextBatch) body.nextBatch = opts.nextBatch;
  if (opts.limit) body.limit = opts.limit;
  return (await requestJson("/agentteams-proxy/matrix/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })) as SearchPage;
}

/** 单事件上下文（/context）：前后各 limit 条 + 目标事件。 */
export interface EventContextPage {
  events_before: RoomMessage[];
  event: RoomMessage | null;
  events_after: RoomMessage[];
}

/** 轻量事件映射（搜索上下文预览用，不聚合 reply/reaction）。 */
function mapContextEvent(ev: unknown): RoomMessage | null {
  if (typeof ev !== "object" || ev === null) return null;
  const e = ev as Record<string, unknown>;
  if (e.type !== "m.room.message") return null;
  const content = (e.content as Record<string, unknown>) || {};
  return {
    event_id: String(e.event_id || ""),
    sender: String(e.sender || ""),
    body: String(content.body || ""),
    msgtype: String(content.msgtype || "m.text"),
    origin_server_ts: Number(e.origin_server_ts || 0),
  };
}

/** 拉取消息上下文：点搜索结果后预览前后文 + 定位跳转。 */
export async function fetchEventContext(
  roomId: string,
  eventId: string,
  limit = 5,
): Promise<EventContextPage> {
  const params = new URLSearchParams({ limit: String(limit) });
  const payload = (await requestJson(
    `/agentteams-proxy/matrix/rooms/${encodeURIComponent(roomId)}/context/${encodeURIComponent(eventId)}?${params.toString()}`,
  )) as { events_before?: unknown[]; event?: unknown; events_after?: unknown[] };
  return {
    events_before: (payload.events_before || [])
      .map(mapContextEvent)
      .filter((m): m is RoomMessage => m !== null),
    event: mapContextEvent(payload.event),
    events_after: (payload.events_after || [])
      .map(mapContextEvent)
      .filter((m): m is RoomMessage => m !== null),
  };
}

export interface MarkReadResult {
  ok: boolean;
  marked: number;
  skipped: number;
  errors: string[];
}

/** 单房间已读（m.read + m.fully_read 双写，经插件后端发 Matrix receipt）。
 *  eventId 缺省时后端取房间最新消息。失败不抛（best-effort 已读）。 */
export async function markRoomRead(
  roomId: string,
  eventId?: string,
): Promise<MarkReadResult | null> {
  try {
    return (await requestJson("/agentteams-proxy/matrix/mark-read", {
      method: "POST",
      body: JSON.stringify({ room_id: roomId, event_id: eventId || "" }),
    })) as MarkReadResult;
  } catch {
    return null;
  }
}

/** 一键全部已读：逐房间双写（后端逐房间取最新消息）。 */
export async function markAllRoomsRead(
  roomIds: string[],
): Promise<MarkReadResult | null> {
  try {
    return (await requestJson("/agentteams-proxy/matrix/mark-read", {
      method: "POST",
      body: JSON.stringify({ room_ids: roomIds }),
    })) as MarkReadResult;
  } catch {
    return null;
  }
}

/** 工作流 DAG 节点（树状拓扑数据源，workerflow nodes 字段）。 */
export interface WorkflowNode {
  id?: string;
  subagent?: string;
  task?: string;
  dependsOn?: string[];
  name?: string;
  status?: string;
  [k: string]: unknown;
}

/** Controller workflowInterrupt（#1172）：paused 项目带
 * action_request {action:'resume'} + config.allow_accept → 渲染恢复按钮。 */
export interface WorkflowInterrupt {
  id: string;
  value: string;
  action_request?: { action: string; args?: Record<string, unknown> };
  config?: {
    allow_ignore?: boolean;
    allow_respond?: boolean;
    allow_edit?: boolean;
    allow_accept?: boolean;
  };
  description?: string;
}

export interface WorkflowEvent {
  runId: string;
  title: string;
  status: string;
  summary?: string;
  coordinator?: string;
  subagents?: unknown[];
  steps?: unknown[];
  /** 树状拓扑：DAG nodes（id/subagent/task/dependsOn）。 */
  nodes?: WorkflowNode[];
  /** 计划类型（workflowResponse.plan_type：dag/loop/""；replan 仅 dag）。
   *  v0.4.98 再版 7 声明（此前运行时已透传、类型未写——replan 门控需要）。 */
  plan_type?: string;
  /** #1172 人工干预中断（paused 项目在此暴露 resume 动作）。 */
  interrupts?: WorkflowInterrupt[];
  /** #1172 审计字段。 */
  pause_reason?: string;
  /** loop 计划（plan_type=loop 项目的迭代进度/停止条件/任务图）。 */
  loop?: {
    goal?: string;
    stop_condition?: string;
    iteration_template?: string;
    current_iteration?: number;
    max_iterations?: number;
    status?: string;
    tasks?: Array<{
      task_id?: string;
      title?: string;
      assigned_to?: string;
      depends_on?: string[];
      status?: string;
    }>;
    history?: unknown[];
  };
  room_id: string;
  room_name: string;
  sender: string;
  ts: number;
}

export async function fetchWorkflowEvents(
  force = false,
): Promise<{ ok: boolean; events: WorkflowEvent[]; elapsed?: number }> {
  return (await requestJson(
    `/agentteams-proxy/workflow/events${force ? "?force=true" : ""}`,
  )) as { ok: boolean; events: WorkflowEvent[]; elapsed?: number };
}

/** 正源项目列表（Controller /api/v1/projects，#1169）。
 *  响应是**信封** `{projects: [...], total}`（Controller project_handler.go
 *  ListProjects L593 源码实锤），兼容裸数组。
 *  v0.4.86 统一入口：此前 Artifacts.tsx 内联请求且**只认裸数组**→信封对象
 *  被误判空列表（项目产物树恒空、且 o19Fail=null 连降级横幅都没有）；本文件
 *  fetchWorkflowProjects/fetchWorkerSpawns 两份内联解包虽对，但三处副本
 *  迟早漂移——从此所有消费者走此函数，信封解包单一真相源。 */
export async function fetchProjectSummaries(
  force = false,
): Promise<Record<string, unknown>[]> {
  const raw = (await requestJson(
    `/agentteams-proxy/controller/api/v1/projects${force ? "?force=true" : ""}`,
  )) as unknown;
  const list = (Array.isArray(raw)
    ? raw
    : ((raw as { projects?: unknown[] })?.projects || [])) as Record<
    string,
    unknown
  >[];
  // v0.4.89: 按 project_id 去重——Controller ListProjects 按 (team, id) 去重
  // （project_handler.go：「two teams may hold the same id... both appear」），
  // 同一 id 在团队目录与全局 shared/projects/ 各有一份 meta.json 时两条都返回
  // （8/22 实测 39 条=29 个唯一 id，10 组重复全为 [team, ""] 配对）。而
  // workflow/artifact 端点只能裸 id 寻址 → 重复 id 裸调 = 409 ambiguous，
  // 两行指向同一可寻址对象。前端每 id 留一条：优先带 team_id 的记录
  // （它是 ?team= 寻址的有效键）。根因在数据侧重复注册（环境清理 + 上游
  // 候选 PR，见 memory 2026-08-22 笔记）。
  const byId = new Map<string, Record<string, unknown>>();
  for (const p of list) {
    const pid = String(p.project_id || "");
    if (!pid) continue;
    const cur = byId.get(pid);
    if (!cur) {
      byId.set(pid, p);
      continue;
    }
    if (!String(cur.team_id || "") && String(p.team_id || "")) {
      byId.set(pid, p);
    }
  }
  return Array.from(byId.values());
}

/** 项目 workflow 正源（#1169 Controller API，双轨 adapter 的正源侧）。
 *
 * GET /api/v1/projects → 每项目 GET /{id}/workflow?includeTasks=true →
 * 映射为 WorkflowEvent[]（UI 接口不变）。Controller 未升级（404/网络失败）
 * 时返回 apiOk=false，调用方降级到 Matrix 事件聚合。
 * v0.4.82: 附带 failReason（auth=token 未配置/无效，not_deployed=404，
 * error=其他）——降级横幅按原因给出可操作提示（此前静默降级，用户
 * 「只有 Manager 的」= 正源 401 静默回退、只剩自己已加入房间的扫描）。
 * re17: 附带 failDetail（error 分支的真实上游错误，如 Controller 500 的
 * mc 报错）——此前真实原因被通用横幅「Controller 不可用」掩盖。
 */
export async function fetchWorkflowProjects(): Promise<{
  events: WorkflowEvent[];
  apiOk: boolean;
  failReason?: "auth" | "not_deployed" | "error";
  failDetail?: string;
}> {
  try {
    const list = await fetchProjectSummaries();
    if (list.length === 0) return { events: [], apiOk: true };
    const mapped = await Promise.all(
      list.slice(0, 20).map(async (proj) => {
        const pid = String(proj.project_id || "");
        if (!pid) return null;
        try {
          // v0.4.83: 带上 ?team= 限定——同一 project_id 可能跨团队重名，
          // 不带 team 时 Controller 回 409（ambiguous across teams），
          // 此前 catch 静默吞掉 → 重名项目从列表整体消失。
          // 列表条目自带 team_id（独立项目 team_id 为空 → 不带参数）。
          const teamQ =
            typeof proj.team_id === "string" && proj.team_id
              ? `&team=${encodeURIComponent(proj.team_id)}`
              : "";
          const wf = (await requestJson(
            `/agentteams-proxy/controller/api/v1/projects/${encodeURIComponent(pid)}/workflow?includeTasks=true${teamQ}`,
          )) as Record<string, unknown>;
          return mapProjectWorkflow(proj, wf);
        } catch {
          return null; // 单项目失败不拖垮全列表
        }
      }),
    );
    return {
      events: mapped.filter((e): e is WorkflowEvent => e !== null),
      apiOk: true,
    };
  } catch (e) {
    // re17: 按真实状态码分类（此前字符串匹配 msg.includes("401")——
    // "HTTP 500: list projects: mc ls ..." 这类上游错误不含 401/403/404
    // 字样，一律落 error 分支，真实原因被通用横幅掩盖）。
    const status = httpErrorStatus(e);
    const detail = httpErrorDetail(e);
    if (status === 401 || status === 403)
      return { events: [], apiOk: false, failReason: "auth" };
    if (status === 404)
      return { events: [], apiOk: false, failReason: "not_deployed" };
    return {
      events: [],
      apiOk: false,
      failReason: "error",
      failDetail: detail || undefined, // 端点未部署/网络失败/5xx → 调用方降级 + 横幅暴露原因
    };
  }
}

/** RFC3339（controller updated_at）→ epoch ms；缺省/非法 → 0（fmtTime(0) 渲染空）。 */
function isoToMs(v: unknown): number {
  if (typeof v !== "string" || !v) return 0;
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}

/** project + workflow → WorkflowEvent（UI 契约映射）。edges 反推 dependsOn。 */function mapProjectWorkflow(
  proj: Record<string, unknown>,
  wf: Record<string, unknown>,
): WorkflowEvent {
  const rawNodes = (Array.isArray(wf.nodes) ? wf.nodes : []) as Record<
    string,
    unknown
  >[];
  const depOf = new Map<string, string[]>();
  for (const e of Array.isArray(wf.edges) ? wf.edges : []) {
    const edge = e as Record<string, unknown>;
    const target = String(edge.target || "");
    const source = String(edge.source || "");
    if (!target || !source) continue;
    if (!depOf.has(target)) depOf.set(target, []);
    depOf.get(target)!.push(source);
  }
  const nodes: WorkflowNode[] = rawNodes.map((n) => ({
    id: String(n.id || ""),
    name: String(n.name || ""),
    status: String(n.status || ""),
    subagent: n.assignee ? String(n.assignee) : undefined,
    dependsOn: depOf.get(String(n.id || "")) || [],
  }));
  const rawInterrupts = (Array.isArray(wf.interrupts) ? wf.interrupts : []) as Record<
    string,
    unknown
  >[];
  const interrupts: WorkflowInterrupt[] = rawInterrupts.map((it) => {
    const ar = (it.action_request ?? {}) as Record<string, unknown>;
    const cfg = (it.config ?? {}) as Record<string, unknown>;
    return {
      id: String(it.id || ""),
      value: String(it.value || ""),
      ...(ar && typeof ar === "object" && ar.action
        ? {
            action_request: {
              action: String(ar.action),
              ...(ar.args && typeof ar.args === "object"
                ? { args: ar.args as Record<string, unknown> }
                : {}),
            },
          }
        : {}),
      ...(cfg && typeof cfg === "object"
        ? {
            config: {
              ...(typeof cfg.allow_ignore === "boolean" ? { allow_ignore: cfg.allow_ignore } : {}),
              ...(typeof cfg.allow_respond === "boolean" ? { allow_respond: cfg.allow_respond } : {}),
              ...(typeof cfg.allow_edit === "boolean" ? { allow_edit: cfg.allow_edit } : {}),
              ...(typeof cfg.allow_accept === "boolean" ? { allow_accept: cfg.allow_accept } : {}),
            },
          }
        : {}),
      ...(typeof it.description === "string"
        ? { description: it.description }
        : {}),
    };
  });
  const wfTitle = typeof wf.title === "string" ? wf.title : "";
  const rawLoop = (wf.loop ?? {}) as Record<string, unknown>;
  return {
    runId: String(proj.project_id || ""),
    title: wfTitle || String(proj.title || "未命名任务"),
    status: String(wf.status || proj.status || "unknown"),
    summary: typeof wf.summary === "string" ? wf.summary : "",
    steps: (Array.isArray(wf.tasks_detail) ? wf.tasks_detail : []) as unknown[],
    nodes,
    interrupts,
    pause_reason: typeof wf.pause_reason === "string" ? wf.pause_reason : undefined,
    ...(rawLoop && Object.keys(rawLoop).length > 0
      ? {
          loop: {
            ...(typeof rawLoop.goal === "string" ? { goal: rawLoop.goal } : {}),
            ...(typeof rawLoop.stop_condition === "string"
              ? { stop_condition: rawLoop.stop_condition }
              : {}),
            ...(typeof rawLoop.iteration_template === "string"
              ? { iteration_template: rawLoop.iteration_template }
              : {}),
            ...(typeof rawLoop.current_iteration === "number"
              ? { current_iteration: rawLoop.current_iteration }
              : {}),
            ...(typeof rawLoop.max_iterations === "number"
              ? { max_iterations: rawLoop.max_iterations }
              : {}),
            ...(typeof rawLoop.status === "string"
              ? { status: rawLoop.status }
              : {}),
            ...(Array.isArray(rawLoop.tasks)
              ? {
                  tasks: (rawLoop.tasks as Record<string, unknown>[]).map(
                    (t) => ({
                      ...(typeof t.task_id === "string"
                        ? { task_id: t.task_id }
                        : {}),
                      ...(typeof t.title === "string" ? { title: t.title } : {}),
                      ...(typeof t.assigned_to === "string"
                        ? { assigned_to: t.assigned_to }
                        : {}),
                      ...(Array.isArray(t.depends_on)
                        ? { depends_on: t.depends_on as string[] }
                        : {}),
                      ...(typeof t.status === "string"
                        ? { status: t.status }
                        : {}),
                    }),
                  ),
                }
              : {}),
            ...(Array.isArray(rawLoop.history)
              ? { history: rawLoop.history as unknown[] }
              : {}),
          },
        }
      : {}),
    room_id: typeof wf.source_room_id === "string" ? wf.source_room_id : "",
    room_name: "",
    sender: "",
    // #1169 正源映射补全（v0.4.78）：此前 coordinator/ts 从未映射，
    // 协调者/时间列恒空（即使 CreateProject API 建的项目 meta 里有值）。
    // 老项目 meta 无 requester/updated_at（v1.2.2 脚本模板不写）→ 仍为空，
    // 属数据缺字段，非映射 bug。
    coordinator: typeof wf.requester === "string" && wf.requester ? wf.requester : undefined,
    ts: isoToMs(wf.updated_at),
  };
}

/** v0.4.98 再版 9：项目活动时间多源（用户「显示不了时间」根因修）。
 * 上游 projectSummary（列表端点）6 字段无时间戳（v1.2.3 最新 223ddc2b 实锤，
 * meta.json 有 created_at 但 projectMeta 结构体不暴露——上游 PR「列表补
 * updated_at」合并前插件拿不到真值），时间多源兜底：
 * ① realTs=真实字段（workflow meta.updated_at，omitempty 仅生命周期写 API
 *   写过才有；上游补字段后自动生效）
 * ② 项目房间最后消息（roomsCache 零额外请求——项目群=项目专用房，
 *   最后一条消息≈项目最后活动，覆盖面最广）
 * ③ project_id 内嵌 YYYYMMDD 近似（创建日期；create-project.sh --id 是
 *   Manager 自由文本，带日期的 id 才命中）
 * ④ 0（UI 显空，排序垫底） */
export function projectActivityTs(
  realTs: number,
  roomId: string,
  projectId: string,
): number {
  let best = realTs > 0 ? realTs : 0;
  const room = roomId
    ? getCachedRooms()?.rooms?.find((r) => r.room_id === roomId)
    : undefined;
  if (room?.last_ts && room.last_ts > best) best = room.last_ts;
  const m = String(projectId || "").match(/(20\d{6})/);
  if (m) {
    const approx = new Date(
      Number(m[1].slice(0, 4)),
      Number(m[1].slice(4, 6)) - 1,
      Number(m[1].slice(6, 8)),
    ).getTime();
    if (approx > best) best = approx;
  }
  return best;
}

/** 来源房间名富化：用已同步的房间缓存把 room_id → room_name（零额外请求）。
 * 缓存未命中（用户未加入该房间）保持空，UI 回退显示 room_id。
 * v0.4.98 再版 9：顺带富化 ts（projectActivityTs 多源——此前
 * ts=isoToMs(wf.updated_at) 恒 0，用户「工作流/产物显示不了时间」）。 */
export function enrichWorkflowRoomNames(events: WorkflowEvent[]): WorkflowEvent[] {
  const cache = getCachedRooms();
  const nameById = new Map<string, string>();
  if (cache?.rooms?.length) {
    for (const r of cache.rooms) if (r.room_id && r.name) nameById.set(r.room_id, r.name);
  }
  return events.map((ev) => {
    const cachedName = ev.room_id ? nameById.get(ev.room_id) : undefined;
    const nextName = ev.room_name || cachedName || "";
    const nextTs = projectActivityTs(ev.ts || 0, ev.room_id || "", ev.runId);
    if (nextName === ev.room_name && nextTs === (ev.ts || 0)) return ev;
    return { ...ev, room_name: nextName, ts: nextTs };
  });
}

/** 项目写操作（#1172：pause/resume/replan/complete + 任务级 cancel，
 *  走后端 controller 代理）。成功后 Controller 返回刷新后的 workflow JSON。 */
export async function pauseProject(
  projectId: string,
  reason?: string,
): Promise<Record<string, unknown>> {
  return (await requestJson(
    `/agentteams-proxy/controller/api/v1/projects/${encodeURIComponent(projectId)}/pause`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: reason ?? "" }),
    },
  )) as Record<string, unknown>;
}

export async function resumeProject(
  projectId: string,
): Promise<Record<string, unknown>> {
  return (await requestJson(
    `/agentteams-proxy/controller/api/v1/projects/${encodeURIComponent(projectId)}/resume`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  )) as Record<string, unknown>;
}

/** 任务级取消（#1172，v0.4.98 再版 7 接按钮）：reason 必填（400），
 * 终态任务 409（completed/revision/blocked/cancelled；重复 cancel 幂等收敛）。
 * 成功后 Controller 返回刷新后的 workflow JSON。 */
export async function cancelTask(
  projectId: string,
  taskId: string,
  reason: string,
): Promise<Record<string, unknown>> {
  return (await requestJson(
    `/agentteams-proxy/controller/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/cancel`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    },
  )) as Record<string, unknown>;
}

/** 项目级完成（#1172，v0.4.98 再版 7 接按钮）：空 body；
 * 已 completed 或有非终态任务（planned/assigned/in_progress/submitted）→ 409。
 * 完成后 Controller 通知团队「✅ 项目 X 已完成」。 */
export async function completeProject(
  projectId: string,
): Promise<Record<string, unknown>> {
  return (await requestJson(
    `/agentteams-proxy/controller/api/v1/projects/${encodeURIComponent(projectId)}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  )) as Record<string, unknown>;
}


/** Replan（#1172，v0.4.98 再版 7 接按钮——此前预埋勿删，现已落地）：
 *  body {tasks:[{taskId, title?, assignedTo?, dependsOn?, status?}]}——
 *  已存在的 taskId 省略字段继承旧值（status 省略=保留旧状态）；
 *  仅 active 项目 + dag 计划 + 无 in_progress/submitted 任务（否则 409）。 */
export async function replanProject(
  projectId: string,
  tasks: unknown[],
): Promise<Record<string, unknown>> {
  return (await requestJson(
    `/agentteams-proxy/controller/api/v1/projects/${encodeURIComponent(projectId)}/replan`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tasks }),
    },
  )) as Record<string, unknown>;
}

// ── L1 全量视图（Controller API，需管理员 token）────────────────────

/** Controller WorkerResponse.mcpServers（api/v1beta1.MCPServer，v1.2.3 实锤）。 */
export interface McpServerInfo {
  name: string;
  url: string;
  transport?: string;
}

export interface WorkerInfo {
  name: string;
  phase: string;
  state: string;
  model: string;
  runtime: string;
  containerState: string;
  matrixUserID: string;
  roomID: string;
  team: string;
  role: string;
  message: string;
  version?: string;
  /**
   * v0.4.98（M33 G2 读路径）：Worker 已装载的 skill 名列表
   * （WorkerResponse.skills = spec.skills，nacos:// 远端条目含源前缀）。
   * 通用代理透传 Controller 完整响应，字段运行时已存在，此前未声明。
   */
  skills?: string[];
  /** v0.4.98：Worker 挂载的 MCP server（name/url/transport）。 */
  mcpServers?: McpServerInfo[];
}

export interface TeamInfo {
  name: string;
  teamName: string;
  phase: string;
  description: string;
  leaderName: string;
  teamRoomID: string;
  leaderReady: boolean;
  readyWorkers: number;
  totalWorkers: number;
  workerNames: string[];
  message: string;
  /** v0.4.96: CRD 管理「配置团队」预填用（TeamResponse 透传）。 */
  workerMembers?: { name: string; role: string }[];
  heartbeatEvery?: string;
  peerMentions?: boolean;
}

export interface HumanInfo {
  name: string;
  phase: string;
  displayName: string;
  matrixUserID: string;
  permissionLevel?: number;
  accessibleTeams?: string[];
  accessibleWorkers?: string[];
  note?: string;
  message: string;
}

/** v0.4.96: 员工入职响应——initialPassword 只在创建时返回一次。 */
export interface CreateHumanResponse extends HumanInfo {
  email?: string;
  initialPassword?: string;
  rooms?: string[];
}

export interface ManagerInfo {
  name: string;
  phase: string;
  state: string;
  model: string;
  /* v0.5.0-beta.12：ManagerResponse 已有 runtime/image 字段（omitempty），前端补声明。 */
  runtime?: string;
  image?: string;
  matrixUserID: string;
  roomID: string;
  version: string;
  message: string;
}

export interface AdminData {
  workers: WorkerInfo[];
  teams: TeamInfo[];
  humans: HumanInfo[];
  managers: ManagerInfo[];
}

async function fetchControllerJson<T>(path: string): Promise<T> {
  // 调用方传 "/workers" 时模板拼接会产生 /api/v1//workers 双斜杠，
  // uvicorn 对双斜杠 301——strip 前导斜杠根治。
  const clean = path.replace(/^\/+/, "");
  return (await requestJson(`/agentteams-proxy/controller/api/v1/${clean}`)) as T;
}

/** Controller POST（wake/sleep 等生命周期操作）。 */
export async function postController(
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const clean = path.replace(/^\/+/, "");
  return requestJson(`/agentteams-proxy/controller/api/v1/${clean}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ── v0.4.96: CRD 管理（L1）——走现有通用 Controller 代理（PUT/DELETE 已支持）──

async function controllerRequest(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const clean = path.replace(/^\/+/, "");
  return requestJson(`/agentteams-proxy/controller/api/v1/${clean}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** 员工入职（Human CR 创建）。上游无 UpdateHuman——改权限级别需删除重建。 */
export const createHuman = (body: Record<string, unknown>) =>
  controllerRequest("POST", "/humans", body) as Promise<CreateHumanResponse>;

/** 创建 Worker（POST /api/v1/workers，5.0.0-beta.5）：CR 创建后由
 * Controller 调和器拉镜像起容器（数分钟就绪）。body: name 必填；
 * model/modelProvider/identity/soul/agents/skills/mcpServers/expose/
 * containerManaged(默认 true)/state 可选（CreateWorkerRequest）。 */
export const createWorker = (body: Record<string, unknown>) =>
  controllerRequest("POST", "/workers", body);
export const deleteHuman = (name: string) =>
  controllerRequest("DELETE", `/humans/${encodeURIComponent(name)}`);
/** 创建团队——workerMembers 必须引用已存在的 Worker CR，且 ≥1。 */
export const createTeam = (body: Record<string, unknown>) =>
  controllerRequest("POST", "/teams", body);
/** 配置团队（PUT 部分更新：空字段不覆盖）。humanMembers 上游 PUT 不支持。 */
export const updateTeam = (name: string, body: Record<string, unknown>) =>
  controllerRequest("PUT", `/teams/${encodeURIComponent(name)}`, body);
/** 更新现有 Worker 的模型（9/3：PUT /workers/{name} 合并语义——只应用非空字段，
 *  其余 spec 不动；不发 modelProvider = provider 保持原值/默认）。 */
export const updateWorkerModel = (name: string, model: string) =>
  controllerRequest("PUT", `/workers/${encodeURIComponent(name)}`, { model });
/** v0.5.0-beta.10（事故报告 G1/G4）：通用 Worker spec 合并更新——
 *  只发非空字段（PUT 合并语义同上）；model/soul 任意组合。 */
export const updateWorker = (name: string, body: Record<string, unknown>) =>
  controllerRequest("PUT", `/workers/${encodeURIComponent(name)}`, body);
/** A11（9/10）：更新 Manager 模型。PUT /managers/{name} 同为合并语义
 *  （Controller UpdateManager：if req.Model != "" 才写 spec，其余 spec 不动；
 *  resource_handler.go 源码实锤）——只发 {model}，provider 保持原值/默认。 */
export const updateManagerModel = (name: string, model: string) =>
  controllerRequest("PUT", `/managers/${encodeURIComponent(name)}`, { model });

// ── v0.5.0-beta.11：技能中心 ──────────────────────────────────────────────
/** #1211（draft）GET /api/v1/skills 契约：技能目录条目。
 *  source = builtin | nacos | builtin+nacos；#1211 合并前 Controller
 *  404 → 目录节显示占位（fetchSkillCatalog 抛错由 UI 捕获）。 */
export interface SkillCatalogItem {
  name: string;
  description?: string;
  source: string;
  agents?: string[];
}
export async function fetchSkillCatalog(): Promise<SkillCatalogItem[]> {
  const raw = (await controllerRequest("GET", "/skills")) as Record<
    string,
    unknown
  >;
  const arr = Array.isArray(raw?.skills) ? raw.skills : [];
  return arr as SkillCatalogItem[];
}

// ── v0.5.0-beta.11：频道接入（#1219 契约，draft 未合——404=版本门）──
/** 单频道配置（QwenPaw channels_config 条目：enabled/bot_prefix +
 *  频道特有字段，自由键值）。 */
export type WorkerChannelConfig = Record<string, unknown> & {
  enabled?: boolean;
  bot_prefix?: string;
  isBuiltin?: boolean;
};
/** 插件频道表单 schema（QwenPaw /channels/schemas：config_fields 元数据）。
 *  内置频道无 schema 条目 → 通用键值编辑器兜底。 */
export interface ChannelSchemaField {
  key?: string;
  name?: string;
  label?: string;
  description?: string;
  type?: string;
  default?: unknown;
  secret?: boolean;
  placeholder?: string;
}
export interface ChannelSchema {
  label?: string;
  description?: string;
  plugin_id?: string;
  icon?: string;
  doc_url?: string;
  config_fields?: ChannelSchemaField[];
}
function channelBase(name: string): string {
  return `/workers/${encodeURIComponent(name)}/channels`;
}
/** 全部频道配置（{[channel]: config}）——404 = Controller 版本门
 *  （#1219 未合/未升级）。 */
export function fetchWorkerChannels(
  name: string,
): Promise<Record<string, WorkerChannelConfig>> {
  return controllerRequest("GET", channelBase(name)) as Promise<
    Record<string, WorkerChannelConfig>
  >;
}
/** 频道类型名列表（env 过滤后）。 */
export function fetchWorkerChannelTypes(name: string): Promise<string[]> {
  return controllerRequest("GET", `${channelBase(name)}/types`) as Promise<
    string[]
  >;
}
/** 插件频道表单 schema（内置频道无条目）。 */
export function fetchWorkerChannelSchemas(
  name: string,
): Promise<Record<string, ChannelSchema>> {
  return controllerRequest("GET", `${channelBase(name)}/schemas`) as Promise<
    Record<string, ChannelSchema>
  >;
}
/** 单频道配置读回（写后校验用）。 */
export function fetchWorkerChannel(
  name: string,
  channel: string,
): Promise<WorkerChannelConfig> {
  return controllerRequest(
    "GET",
    `${channelBase(name)}/${encodeURIComponent(channel)}`,
  ) as Promise<WorkerChannelConfig>;
}
/** 单频道更新（body = 全量频道配置；PUT 热加载，无需 restart 才生效）。 */
export function putWorkerChannel(
  name: string,
  channel: string,
  config: WorkerChannelConfig,
): Promise<WorkerChannelConfig> {
  return controllerRequest(
    "PUT",
    `${channelBase(name)}/${encodeURIComponent(channel)}`,
    config,
  ) as Promise<WorkerChannelConfig>;
}
/** 频道健康检查。 */
export function fetchWorkerChannelHealth(
  name: string,
  channel: string,
): Promise<Record<string, unknown>> {
  return controllerRequest(
    "GET",
    `${channelBase(name)}/${encodeURIComponent(channel)}/health`,
  ) as Promise<Record<string, unknown>>;
}
/** 频道重启（stop/start channel manager）。 */
export function restartWorkerChannel(
  name: string,
  channel: string,
): Promise<Record<string, unknown>> {
  return controllerRequest(
    "POST",
    `${channelBase(name)}/${encodeURIComponent(channel)}/restart`,
  ) as Promise<Record<string, unknown>>;
}
/** 冲突检查（保存前：配置与现有运行状态冲突检测）。 */
export function conflictCheckWorkerChannel(
  name: string,
  channel: string,
  config: WorkerChannelConfig,
): Promise<Record<string, unknown>> {
  return controllerRequest(
    "POST",
    `${channelBase(name)}/${encodeURIComponent(channel)}/conflict-check`,
    config,
  ) as Promise<Record<string, unknown>>;
}
/** 二维码授权（QwenPaw：{qrcode_img: base64 PNG, poll_token}；
 *  不支持的频道 404 → UI 隐藏二维码按钮）。 */
export function fetchWorkerChannelQrcode(
  name: string,
  channel: string,
): Promise<{ qrcode_img: string; poll_token: string }> {
  return controllerRequest(
    "GET",
    `${channelBase(name)}/${encodeURIComponent(channel)}/qrcode`,
  ) as Promise<{ qrcode_img: string; poll_token: string }>;
}
/** 二维码状态轮询（{status, credentials}；credentials 非空=授权成功，
 *  自动回填表单）。 */
export function fetchWorkerChannelQrcodeStatus(
  name: string,
  channel: string,
  token: string,
): Promise<{ status: string; credentials: Record<string, unknown> | null }> {
  return controllerRequest(
    "GET",
    `${channelBase(name)}/${encodeURIComponent(channel)}/qrcode/status?token=${encodeURIComponent(token)}`,
  ) as Promise<{
    status: string;
    credentials: Record<string, unknown> | null;
  }>;
}
export const deleteTeam = (name: string) =>
  controllerRequest("DELETE", `/teams/${encodeURIComponent(name)}`);

export async function fetchAdminData(): Promise<AdminData> {
  const [workers, teams, humans, managers] = await Promise.all([
    fetchControllerJson<unknown>("/workers").then(normalizeList),
    fetchControllerJson<unknown>("/teams").then(normalizeList),
    fetchControllerJson<unknown>("/humans").then(normalizeList),
    fetchControllerJson<unknown>("/managers").then(normalizeList),
  ]);
  return {
    workers: workers as WorkerInfo[],
    teams: teams as TeamInfo[],
    humans: humans as HumanInfo[],
    managers: managers as ManagerInfo[],
  };
}

function normalizeList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const key of ["workers", "teams", "humans", "managers", "items"]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}

export interface SpawnNode {
  session_id: string;
  name: string;
  status: "idle" | "running" | "done";
  last_activity?: string;
  created_at: number;
  children?: SpawnNode[];
  /** O20 正源：父 spawn 的 session_id（root_session_id），用于建树后不展示。 */
  rootSessionId?: string;
}

export interface WorkerSpawnGroup {
  worker_name: string;
  mxid: string;
  role: "leader" | "worker" | "critic" | "unknown";
  is_self?: boolean;
  spawns: SpawnNode[];
  phase?: string;
  /* v0.5.0-beta.12（批次 0）：Worker 个人房间（Controller roomID，A8a-fix
     私聊直跳）+ runtime（CR 字段，A8b 徽章）。room-fallback 源无此二字段。 */
  room_id?: string;
  runtime?: string;
}

export interface WorkerTreeTeam {
  team_name: string;
  room_id?: string;
  workers: WorkerSpawnGroup[];
}

export async function fetchTeamsStructure(
  force = false,
): Promise<{ ok: boolean; tree: WorkerTreeTeam[]; source: string }> {
  return (await requestJson(
    `/agentteams-proxy/teams/structure${force ? "?force=true" : ""}`,
  )) as { ok: boolean; tree: WorkerTreeTeam[]; source: string };
}

/** spawn 正源（O20，#1169 已合并）：projects list + 每项目 /spawns 聚合 →
 *  按 worker 名建 spawn 树（root_session_id 链 = 父子）。返回 apiOk=false
 *  时调用方降级为空 spawns（现状）。 */
export async function fetchWorkerSpawns(): Promise<{
  byWorker: Record<string, SpawnNode[]>;
  apiOk: boolean;
}> {
  try {
    const projects = await fetchProjectSummaries();
    const byWorker: Record<string, SpawnNode[]> = {};
    if (projects.length === 0) return { byWorker, apiOk: true };
    await Promise.all(
      projects.slice(0, 20).map(async (proj) => {
        const pid = String(proj.project_id || "");
        if (!pid) return;
        try {
          const resp = (await requestJson(
            `/agentteams-proxy/controller/api/v1/projects/${encodeURIComponent(pid)}/spawns`,
          )) as { workers?: { worker?: string; spawns?: Record<string, unknown>[] }[] };
          for (const w of resp.workers || []) {
            const name = String(w.worker || "");
            if (!name) continue;
            const nodes = (w.spawns || []).map(mapSpawnInfo);
            if (!byWorker[name]) byWorker[name] = [];
            byWorker[name].push(...nodes);
          }
        } catch {
          /* 单项目失败跳过 */
        }
      }),
    );
    // root_session_id 链 → 树：root 指向另一个 spawn session 的挂为子节点；
    // 指向房间（matrix:）或空的为顶层。
    for (const name of Object.keys(byWorker)) {
      const all = byWorker[name];
      const bySession = new Map(all.map((n) => [n.session_id, n]));
      const roots: SpawnNode[] = [];
      for (const n of all) {
        const rootKey = (n as unknown as { rootSessionId?: string }).rootSessionId;
        if (rootKey && bySession.has(rootKey)) {
          const parent = bySession.get(rootKey)!;
          if (!parent.children) parent.children = [];
          parent.children.push(n);
        } else {
          roots.push(n);
        }
      }
      byWorker[name] = roots;
    }
    return { byWorker, apiOk: true };
  } catch {
    return { byWorker: {}, apiOk: false };
  }
}

/** O20 spawnInfo → SpawnNode（UI 契约映射）。 */
function mapSpawnInfo(s: Record<string, unknown>): SpawnNode {
  const createdIso = typeof s.created_at === "string" ? s.created_at : "";
  return {
    session_id: String(s.session_id || ""),
    name: typeof s.name === "string" ? s.name : "",
    status: (["idle", "running", "done"].includes(String(s.status))
      ? String(s.status)
      : "idle") as SpawnNode["status"],
    last_activity:
      typeof s.updated_at === "string" ? s.updated_at : undefined,
    created_at: createdIso ? Date.parse(createdIso) || 0 : 0,
    ...((s as { root_session_id?: unknown }).root_session_id
      ? {
          rootSessionId: String(
            (s as { root_session_id?: unknown }).root_session_id,
          ),
        }
      : {}),
  } as SpawnNode;
}

export async function openDm(
  mxidOrName: string,
): Promise<{ ok: boolean; target: string; room_id: string; created: boolean }> {
  return (await requestJson("/agentteams-proxy/dm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: mxidOrName }),
  })) as { ok: boolean; target: string; room_id: string; created: boolean };
}

/** 【历史替代，勿删】/teams/rooms 实时聚合版——现役链路用 /teams/sync（缓存+force 超集）；
 *  保留作实时无缓存替代（排查缓存问题时用）。 */
export async function fetchTeamsRooms(): Promise<TeamsRoomsResponse> {
  return (await requestJson("/agentteams-proxy/teams/rooms")) as TeamsRoomsResponse;
}

export async function fetchTeamsSync(
  force = false,
): Promise<TeamsRoomsResponse & { elapsed?: number }> {
  return (await requestJson(
    `/agentteams-proxy/teams/sync${force ? "?force=true" : ""}`,
  )) as TeamsRoomsResponse & { elapsed?: number };
}

// ── 模块级缓存（页面重开立即显示，后台刷新）──────────────────────────
// 离开 tab 组件卸载后数据仍在；重新打开先用缓存渲染再后台拉新。
let roomsCache: TeamsRoomsResponse | null = null;
const messagesCache = new Map<string, RoomMessagesPage>();

export function getCachedRooms(): TeamsRoomsResponse | null {
  return roomsCache;
}

export function setCachedRooms(data: TeamsRoomsResponse): void {
  roomsCache = data;
}

export function getCachedMessages(roomId: string): RoomMessagesPage | null {
  return messagesCache.get(roomId) ?? null;
}

export function setCachedMessages(
  roomId: string,
  page: RoomMessagesPage,
): void {
  messagesCache.set(roomId, page);
  // 上限 20 个房间，防内存膨胀
  if (messagesCache.size > 20) {
    const first = messagesCache.keys().next().value;
    if (first) messagesCache.delete(first);
  }
}

export async function fetchRoomMessages(
  roomId: string,
  limit = 50,
  from?: string,
): Promise<RoomMessagesPage> {
  const params = new URLSearchParams({ dir: "b", limit: String(limit) });
  if (from) params.set("from", from);
  let payload: { chunk?: unknown[]; end?: string; start?: string };
  try {
    payload = (await requestJson(
      `/agentteams-proxy/matrix/rooms/${encodeURIComponent(roomId)}/messages?${params.toString()}`,
    )) as { chunk?: unknown[]; end?: string; start?: string };
  } catch (e) {
    // 404 = 房间数据已被清理（升级后僵尸房间）——返回空页 + 标记，不报错阻塞。
    if (e instanceof Error && e.message.includes("HTTP 404")) {
      return { messages: [], end: "", start: "", error: "not_found" };
    }
    throw e;
  }
  // v0.4.98 再版 9：m.replace 编辑事件聚合（Element 同款——替换事件不独立
  // 显示，m.new_content 写回原消息 + edited 标记）。预扫一轮建映射。
  const replaceMap = new Map<
    string,
    { body: string; msgtype: string }
  >();
  const isReplaceEvent = (ev: Record<string, unknown>): boolean => {
    const c = (ev.content as Record<string, unknown>) || {};
    const rel = c["m.relates_to"] as
      | Record<string, unknown>
      | undefined;
    return !!(rel && rel.rel_type === "m.replace" && rel.event_id);
  };
  for (const raw of payload.chunk || []) {
    if (typeof raw !== "object" || raw === null) continue;
    const ev = raw as Record<string, unknown>;
    if (ev.type !== "m.room.message" || !isReplaceEvent(ev)) continue;
    const c = (ev.content as Record<string, unknown>) || {};
    const rel = (c["m.relates_to"] as Record<string, unknown>) || {};
    const nc = (c["m.new_content"] as Record<string, unknown>) || {};
    // 非标注客户端 fallback body 带 "[edit] " 前缀——聚合时剥掉。
    replaceMap.set(String(rel.event_id), {
      body: String(nc.body ?? "").replace(/^\[edit\]\s*/, ""),
      msgtype: String(nc.msgtype || "m.text"),
    });
  }
  const messages: RoomMessage[] = (payload.chunk || [])
    .filter(
      (ev): ev is Record<string, unknown> =>
        typeof ev === "object" && ev !== null,
    )
    .filter((ev) => ev.type === "m.room.message" && !isReplaceEvent(ev))
    .map((ev) => {
      const content = (ev.content as Record<string, unknown>) || {};
      const info = (content.info as Record<string, unknown>) || {};
      const eventId0 = String(ev.event_id || "");
      // 撤回（redaction）：unsigned.redacted_because 存在 = 事件被红条。
      const unsigned = (ev.unsigned as Record<string, unknown>) || {};
      const redacted = Boolean(unsigned.redacted_because);
      const editedBy = redacted ? undefined : replaceMap.get(eventId0);
      // 引用/线程回复解析：m.in_reply_to（用户引用回复）+ m.thread（Agent 线程协议，
      // agentteams-matrix-channel L3618 实锤：rel_type "m.thread" + event_id=thread root）。
      let reply: RoomMessage["reply"];
      const relates = content["m.relates_to"] as
        | Record<string, unknown>
        | undefined;
      if (
        relates &&
        (relates.rel_type === "m.in_reply_to" ||
          relates.rel_type === "m.thread")
      ) {
        const replyEventId = String(
          (relates as Record<string, unknown>).event_id ||
            ev.event_id ||
            "",
        );
        // Matrix fallback 格式：" > <@sender> 原文摘要"（m.in_reply_to 才有；
        // m.thread 无 fallback，线程摘要靠历史里的原消息渲染）。
        const fallback = String(relates["m.in_reply_to"] || "");
        const senderMatch = />\s*<(@[^>]+)>/.exec(fallback);
        let body = "";
        if (fallback) {
          body = fallback
            .split("\n")
            .filter((l) => l.startsWith(">"))
            .map((l) => l.replace(/^>\s*/, ""))
            .join("\n");
          body = body.replace(/^<@[^>]+>\s*/, "").trim();
        }
        reply = {
          event_id: replyEventId,
          sender: senderMatch ? senderMatch[1] : undefined,
          body: body || undefined,
        };
      }
      // workflow 卡片载荷透传（规则 1：content 键存在且为对象）。
      const rawWorkflow = content["agentteams.workflow"];
      return {
        event_id: eventId0,
        sender: String(ev.sender || ""),
        // 撤回消息正文置空（UI 渲染固定提示）；编辑消息用 m.new_content 正文。
        body: redacted ? "" : editedBy ? editedBy.body : String(content.body || ""),
        msgtype: redacted ? "m.text" : editedBy ? editedBy.msgtype : String(content.msgtype || "m.text"),
        origin_server_ts: Number(ev.origin_server_ts || 0),
        url: redacted ? undefined : (content.url as string | undefined),
        mimetype: redacted ? undefined : (info.mimetype as string | undefined),
        filename: redacted ? "" : String(content.filename || info.filename || ""),
        // v0.4.98 再版 10：info.size（字节）——文件卡尺寸显示 + 预览大小
        // 守卫（此前映射漏带，聊天文件卡尺寸恒空）。
        size:
          redacted || typeof info.size !== "number" ? undefined : info.size,
        reply: redacted ? undefined : reply,
        workflow: redacted ? null : (isWorkflowPayload(rawWorkflow) ? rawWorkflow : null),
        ...(editedBy ? { edited: true } : {}),
        ...(redacted ? { redacted: true } : {}),
      };
    });
  // m.reaction 聚合（Element 同款交互，独立实现）：m.annotation rel_type
  // 的独立事件，按 event_id 聚合 emoji → 计数附加到对应消息。
  const reactionsMap = new Map<string, Record<string, number>>();
  for (const ev of payload.chunk || []) {
    if (typeof ev !== "object" || ev === null) continue;
    const e = ev as Record<string, unknown>;
    if (e.type !== "m.reaction") continue;
    const content = (e.content as Record<string, unknown>) || {};
    const relates = content["m.relates_to"] as
      | Record<string, unknown>
      | undefined;
    if (!relates || relates.rel_type !== "m.annotation") continue;
    const targetId = String(relates.event_id || "");
    const key = String(relates.key || "");
    if (!targetId || !key) continue;
    if (!reactionsMap.has(targetId)) reactionsMap.set(targetId, {});
    const counts = reactionsMap.get(targetId)!;
    counts[key] = (counts[key] || 0) + 1;
  }
  for (const m of messages) {
    const r = reactionsMap.get(m.event_id);
    if (r && Object.keys(r).length > 0) m.reactions = r;
  }
  // v0.4.83: 显式按时间升序——此前顺序完全依赖 Matrix /messages chunk 的
  // 原始返回序，话题面板（replies 是 visibleMessages 子集）出现"从上到下
  // 不是从旧到新"（用户 8/20 反馈）。JS sort 稳定：同 ts 保持 chunk 相对序。
  messages.sort((a, b) => a.origin_server_ts - b.origin_server_ts);
  return {
    messages,
    end: String(payload.end || ""),
    start: String(payload.start || ""),
  };
}

/** 上传文件到 Matrix media → 返回 mxc:// content_uri。 */
export async function uploadMedia(file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  // v0.4.85: 裸路径 POST 会落 SPA 兜底（200 + index.html 壳）→ resp.json()
  // 抛错 = 反向交付（文件发送）静默失败。必须 getApiUrl + token
  //（与 WorkbenchPage SSE /events 同款正确模式）。
  const host = window.QwenPaw?.host;
  const url = host && typeof host.getApiUrl === "function"
    ? host.getApiUrl("/agentteams-proxy/matrix/upload")
    : "/agentteams-proxy/matrix/upload";
  const headers: Record<string, string> = {};
  const token = host && typeof host.getApiToken === "function"
    ? host.getApiToken()
    : "";
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: form,
  });
  const data = (await resp.json()) as { content_uri?: string; detail?: string };
  if (!resp.ok || !data.content_uri) {
    throw new Error(data.detail || `上传失败 HTTP ${resp.status}`);
  }
  return data.content_uri;
}

/** 发送表情反应（m.reaction，m.annotation rel_type，Element 同款协议）。 */
export async function sendReaction(
  roomId: string,
  eventId: string,
  emoji: string,
): Promise<{ event_id: string }> {
  const txn = `wb-r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return (await requestJson(
    `/agentteams-proxy/matrix/rooms/${encodeURIComponent(roomId)}/send/m.reaction/${txn}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        "m.relates_to": {
          rel_type: "m.annotation",
          event_id: eventId,
          key: emoji,
        },
      }),
    },
  )) as { event_id: string };
}

/** 发送文件/图片消息（m.file / m.image）。 */
export async function sendRoomFile(
  roomId: string,
  opts: {
    mxcUri: string;
    filename: string;
    msgtype: "m.file" | "m.image";
    mimetype?: string;
    size?: number;
  },
): Promise<{ event_id: string }> {
  const txn = `wb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const content: Record<string, unknown> = {
    msgtype: opts.msgtype,
    body: opts.filename,
    url: opts.mxcUri,
    filename: opts.filename,
    info: {
      mimetype: opts.mimetype || "application/octet-stream",
      size: opts.size || 0,
    },
  };
  return (await requestJson(
    `/agentteams-proxy/matrix/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(content),
    },
  )) as { event_id: string };
}

export async function sendRoomMessage(
  roomId: string,
  body: string,
  replyTo?: { event_id: string; sender: string; body: string },
  threadRoot?: string,
): Promise<{ event_id: string }> {
  const txn = `wb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const content: Record<string, unknown> = { msgtype: "m.text", body };
  if (threadRoot) {
    // 线程回复：m.thread rel_type（Agent 线程协议，agentteams-matrix-channel
    // L3618 同款——比 m.in_reply_to 更适合 Agent 场景，Element 也支持）。
    content["m.relates_to"] = {
      rel_type: "m.thread",
      event_id: threadRoot,
    };
  } else if (replyTo?.event_id) {
    const fallback =
      replyTo.body || replyTo.sender
        ? `> <${replyTo.sender || "@unknown"}> ${(replyTo.body || "").slice(0, 200)}`
        : "";
    content["m.relates_to"] = {
      "m.in_reply_to": {
        event_id: replyTo.event_id,
        ...(fallback ? { fallback } : {}),
      },
    };
  }
  return (await requestJson(
    `/agentteams-proxy/matrix/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(content),
    },
  )) as { event_id: string };
}

/** v0.5.0-beta.10 再版 2：审批命令带 @Worker（用户反馈 9/5 真机反馈：无 @ 的
 * `/approval approve` 群内没反应）。QwenPaw Matrix 通道群房间
 * _require_mention 默认 True——无 mention 消息只进历史缓冲不进消费队列，
 * Worker 根本看不到裸命令。按 Element 三重惯例发：m.mentions（结构化，
 * _was_mentioned 检查 1）+ formatted_body matrix.to 链接（检查 2）+ body
 * 纯文本 @localpart（可读性）；Worker 侧 _strip_mention_prefix 剥前导 @
 * 暴露斜杠命令。 */
export async function sendApprovalCommand(
  roomId: string,
  targetMxid: string,
  cmd: string,
  replyTo?: { event_id: string; sender: string; body: string },
): Promise<{ event_id: string }> {
  const txn = `wb-apr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const local = (targetMxid.split(":")[0] || targetMxid).replace(/^@/, "");
  const content: Record<string, unknown> = {
    msgtype: "m.text",
    body: `@${local} ${cmd}`,
    format: "org.matrix.custom.html",
    formatted_body: `<a href="https://matrix.to/#/${targetMxid}">@${local}</a> ${cmd}`,
    "m.mentions": { user_ids: [targetMxid] },
  };
  if (replyTo?.event_id) {
    const fallback =
      replyTo.body || replyTo.sender
        ? `> <${replyTo.sender || "@unknown"}> ${(replyTo.body || "").slice(0, 200)}`
        : "";
    content["m.relates_to"] = {
      "m.in_reply_to": {
        event_id: replyTo.event_id,
        ...(fallback ? { fallback } : {}),
      },
    };
  }
  return (await requestJson(
    `/agentteams-proxy/matrix/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(content),
    },
  )) as { event_id: string };
}

/** v0.4.98 再版 9：编辑自己的消息（Element 同款标注编辑，CS-API m.replace）：
 * 新事件 content 带 m.new_content + m.relates_to{rel_type:"m.replace",
 * event_id:原事件}；非标注客户端看到 body 的 "[edit] " fallback 前缀。
 * 原事件保留（Matrix 事件不可变），fetchRoomMessages 聚合时替换显示。 */
export async function sendRoomMessageEdit(
  roomId: string,
  originalEventId: string,
  body: string,
): Promise<{ event_id: string }> {
  const txn = `wb-edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const content: Record<string, unknown> = {
    msgtype: "m.text",
    body: `[edit] ${body}`,
    "m.new_content": { msgtype: "m.text", body },
    "m.relates_to": { rel_type: "m.replace", event_id: originalEventId },
  };
  return (await requestJson(
    `/agentteams-proxy/matrix/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(content),
    },
  )) as { event_id: string };
}

/** v0.4.98 再版 9：撤回自己的消息（redaction，CS-API 标准端点）：
 * DELETE /rooms/{roomId}/send/{eventId}——仅本人事件可撤回（他人 403）。
 * 撤回后原事件带 unsigned.redacted_because，聚合层渲染「已撤回」。 */
export async function redactRoomMessage(
  roomId: string,
  eventId: string,
  reason?: string,
): Promise<void> {
  await requestJson(
    `/agentteams-proxy/matrix/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(eventId)}`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: reason || "" }),
    },
  );
}

/** 5.0.0 release：忘记房间（CS-API：leave 之后清除本地状态；
 *  joined 状态直接 forget 会被 403，所以「退出并删除」= 先 leave 再 forget）。 */
export async function forgetRoom(roomId: string): Promise<void> {
  await requestJson(
    `/agentteams-proxy/matrix/rooms/${encodeURIComponent(roomId)}/forget`,
    { method: "POST" },
  );
}

/** v0.4.98 再版 9：退出房间（CS-API：leave=joined 状态退出；invite 状态
 * 的 leave=拒绝邀请，两个语义同一端点）。注意：L2 scope 房间退出后
 * Controller human 调和器下轮会重新邀请（确认文案已提示）。 */
export async function leaveRoom(roomId: string): Promise<void> {
  await requestJson(
    `/agentteams-proxy/matrix/rooms/${encodeURIComponent(roomId)}/leave`,
    { method: "POST", body: "{}" },
  );
}

/** 8/29 re16：房间重命名（m.room.name state 事件；需房间权限表授权
 * 当前用户写 m.room.name——团队房间普遍权限异常（null 权限表），
 * 403 时配合 fetchRoomPowerInfo 展示诊断）。 */
export async function renameRoom(
  roomId: string,
  name: string,
): Promise<void> {
  await requestJson(
    `/agentteams-proxy/matrix/rooms/${encodeURIComponent(
      roomId,
    )}/state/m.room.name/`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    },
  );
}

/** 8/29 re16：房间权限诊断（改名 403 根因展示）。
 * 实测（8/29）：Controller/Manager 创建的房间 m.room.power_levels 状态
 * 内容为 null（上游 power_level_content_override 在 Tuwunel 落库异常）→
 * Tuwunel 按默认严格表（m.room.name 需 50）→ L2/普通成员恒 403，
 * Element 同名输入框也是灰色（非 Element 问题）。 */
export interface RoomPowerInfo {
  /** null = 权限表内容缺失（平台侧已知问题） */
  content: Record<string, unknown> | null;
  myLevel: number;
  nameRequired: number;
  canRename: boolean;
}

// ── 8/29 re16：Worker 工具执行安全（QwenPaw 原生 approval_level 四模式）────
export interface ApprovalItem {
  agent: string;
  container: string;
  kind: string;
  state: string;
  approval_level: string | null;
  error: string;
}

export interface ApprovalListResponse {
  items: ApprovalItem[];
  levels: string[];
}

export async function fetchApprovalList(
  agent?: string,
): Promise<ApprovalListResponse> {
  const q = agent ? `?agent=${encodeURIComponent(agent)}` : "";
  return (await requestJson(
    `/agentteams-proxy/approval/list${q}`,
  )) as ApprovalListResponse;
}

export interface ApprovalSetResult {
  ok: boolean;
  agent: string;
  level: string;
  verified: string | null;
  note: string;
}

export async function setApprovalLevel(
  agent: string,
  level: string,
): Promise<ApprovalSetResult> {
  return (await requestJson(`/agentteams-proxy/approval/set`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent, level }),
  })) as ApprovalSetResult;
}

export async function fetchRoomPowerInfo(
  roomId: string,
  userId: string,
): Promise<RoomPowerInfo> {
  const raw = (await requestJson(
    `/agentteams-proxy/matrix/rooms/${encodeURIComponent(
      roomId,
    )}/state/m.room.power_levels`,
  )) as Record<string, unknown>;
  const c = (raw.content ?? null) as Record<string, unknown> | null;
  if (!c) {
    return { content: null, myLevel: 0, nameRequired: 50, canRename: false };
  }
  const users = (c.users as Record<string, number> | undefined) ?? {};
  const events = (c.events as Record<string, number> | undefined) ?? {};
  const myLevel = users[userId] ?? Number(c.users_default ?? 0);
  const nameRequired =
    events["m.room.name"] ?? Number(c.events_default ?? 0);
  return {
    content: c,
    myLevel,
    nameRequired,
    canRename: myLevel >= nameRequired,
  };
}

/** v0.4.98 再版 9：房间静音（Element 同款 m.muted_room account data——
 * 跨客户端状态源；插件侧通知引擎 sync_watcher 同端点消费，静音房间
 * 不再触发 @通知/任务状态通知。服务端 push rule 由 Element 侧管理，
 * 插件不重复写）。 */
export async function setRoomMuted(
  roomId: string,
  userId: string,
  muted: boolean,
): Promise<void> {
  await requestJson(
    `/agentteams-proxy/matrix/user/${encodeURIComponent(userId)}/account_data/m.muted_room`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room_id: roomId, muted }),
    },
  );
}

// 静音房间集合：随 /teams/sync 载荷的 muted_rooms 字段下发（后端解析
// /sync account_data m.muted_room，零额外请求），前端 getCachedRooms()
// 读取——见 TeamsRoomsResponse.muted_rooms。


// v0.5.0-beta.10 再版 2：原「宿主审批队列」段（PendingApproval /
// fetchPendingApprovals / sendApprovalAction，GET /console/push-messages）
// 已删除——集群 Worker 的 Tool Guard 审批发生在 Worker 所在进程，本机宿主队列
// 恒 0（8/14 查证 + 用户反馈 9/5 真机「首页没有」实锤）。房间审批源 =
// GET /room-approvals（下方 RoomApproval/fetchRoomApprovals）+ 批准/拒绝
// 走 sendApprovalCommand（带 @Worker 的房间命令）。

// ── 宿主通知收件箱（B2 通知中心，§6.6）：/console/inbox 事件流 ─────
// 与 OS 通知/MenuBar 铃铛同一事件源（useOsNotifyPoller 同款端点）。

export interface InboxEvent {
  id: string;
  agent_id: string;
  source_type: string;
  source_id: string;
  event_type: string;
  status: string;
  severity: string;
  title: string;
  body: string;
  payload?: Record<string, unknown>;
  read: boolean;
  created_at: number;
}

export interface InboxPage {
  events: InboxEvent[];
  total?: number;
  unread_count?: number;
}

export async function fetchInboxEvents(params: {
  limit?: number;
  offset?: number;
  unread_only?: boolean;
} = {}): Promise<InboxPage> {
  const query = new URLSearchParams();
  if (params.limit) query.set("limit", String(params.limit));
  if (params.offset) query.set("offset", String(params.offset));
  if (params.unread_only) query.set("unread_only", "true");
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return (await requestJson(`/console/inbox/events${suffix}`)) as InboxPage;
}

export async function markInboxRead(payload: {
  event_ids?: string[];
  all?: boolean;
}): Promise<{ updated: number }> {
  return (await requestJson("/console/inbox/read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })) as { updated: number };
}

export async function deleteInboxEvent(eventId: string): Promise<unknown> {
  return requestJson(`/console/inbox/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
  });
}

/** 【预埋，勿删】插件通知 → 宿主收件箱（后端 inbox_store.append_event 内部通道）。
 *  v0.4.44 曾为 @提到我活链路；v0.4.45 起 sync_watcher 接管 @mention 事件流后本函数待命——
 *  保留为 UI 主动推送通知的通用入口（产物完成通知等未来触发点，见方案 v5.29「产物通知待评估」）。
 *  os_notify=true 映射 OS 通知白名单 source_type → 桌面 toast + 铃铛。 */
export async function sendInboxNotify(opts: {
  title: string;
  body?: string;
  severity?: string;
  source_type?: string;
  os_notify?: boolean;
}): Promise<{ ok: boolean; event_id: string }> {
  try {
    return (await requestJson("/agentteams-proxy/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    })) as { ok: boolean; event_id: string };
  } catch {
    // 宿主收件箱不可用（非 QwenPaw 宿主/旧版）→ 静默降级，不影响功能。
    return { ok: false, event_id: "" };
  }
}

// ── 成员详情（B4）：某成员在房间内的最近消息（/messages 翻页过滤）───

export interface MemberMessage {
  event_id: string;
  sender: string;
  body: string;
  origin_server_ts: number;
}

export async function fetchMemberMessages(
  roomId: string,
  sender: string,
  limit = 5,
): Promise<{ ok: boolean; messages: MemberMessage[] }> {
  const params = new URLSearchParams({
    roomId,
    sender,
    limit: String(limit),
  });
  return (await requestJson(
    `/agentteams-proxy/matrix/member/messages?${params.toString()}`,
  )) as { ok: boolean; messages: MemberMessage[] };
}

// ── 项目干预时间线 + Worker 检查点（PR #1186 端点，合并部署后生效）──────────

export interface ProjectHistorySnapshot {
  /** unixNano 文件名；字符串——19 位纳秒超出 JS 安全整数。 */
  timestamp: string;
}

export interface ProjectHistoryResponse {
  project_id: string;
  snapshots: ProjectHistorySnapshot[];
}

export interface CheckpointNode {
  ref: string;
  kind: string; // auto | snap | pre-restore | sha
  session_key: string;
  name: string;
  commit: string;
  sha: string;
  timestamp_ms: number;
  subject: string;
  query: string | null;
  channel: string;
  is_head: boolean;
  user_id: string;
  session_title?: string;
}

export interface CheckpointGraphResponse {
  nodes: CheckpointNode[];
  sessions: unknown[];
  summary: {
    total: number;
    auto: number;
    snapshots: number;
    safety: number;
    heads: number;
  };
  truncated: boolean;
}

export interface CheckpointStatusResponse {
  auto_enabled: boolean;
  has_checkpoints: boolean;
  workspace_dir: string;
}

/** Worker 运行 QwenPaw < 2.1（Controller 502 降级）——调用方渲染占位而非错误。 */
export class CheckpointUnavailableError extends Error {}

export async function fetchProjectHistory(
  projectId: string,
): Promise<ProjectHistoryResponse> {
  const raw = (await requestJson(
    `/agentteams-proxy/controller/api/v1/projects/${encodeURIComponent(projectId)}/history`,
  )) as unknown;
  const obj = (raw ?? {}) as Record<string, unknown>;
  const list = Array.isArray(obj.snapshots) ? obj.snapshots : [];
  return {
    project_id: typeof obj.project_id === "string" ? obj.project_id : projectId,
    snapshots: list
      .map((s) => {
        const o = (s ?? {}) as Record<string, unknown>;
        return typeof o.timestamp === "string" ? { timestamp: o.timestamp } : null;
      })
      .filter((s): s is ProjectHistorySnapshot => s !== null),
  };
}

export async function fetchProjectHistorySnapshot(
  projectId: string,
  timestamp: string,
): Promise<Record<string, unknown>> {
  return (await requestJson(
    `/agentteams-proxy/controller/api/v1/projects/${encodeURIComponent(projectId)}/history/${timestamp}`,
  )) as Record<string, unknown>;
}

export async function fetchWorkerCheckpointGraph(
  workerName: string,
  limit = 100,
): Promise<CheckpointGraphResponse> {
  try {
    const raw = (await requestJson(
      `/agentteams-proxy/controller/api/v1/workers/${encodeURIComponent(workerName)}/checkpoints/graph?limit=${limit}`,
    )) as unknown;
    const obj = (raw ?? {}) as Record<string, unknown>;
    const nodes = (Array.isArray(obj.nodes) ? obj.nodes : []) as Record<
      string,
      unknown
    >[];
    const summary = (obj.summary ?? {}) as Record<string, unknown>;
    return {
      nodes: nodes.map((n) => ({
        ref: String(n.ref || ""),
        kind: String(n.kind || ""),
        session_key: String(n.session_key || ""),
        name: String(n.name || ""),
        commit: String(n.commit || ""),
        sha: String(n.sha || ""),
        timestamp_ms: typeof n.timestamp_ms === "number" ? n.timestamp_ms : 0,
        subject: String(n.subject || ""),
        query: typeof n.query === "string" ? n.query : null,
        channel: String(n.channel || ""),
        is_head: Boolean(n.is_head),
        user_id: String(n.user_id || ""),
        ...(typeof n.session_title === "string"
          ? { session_title: n.session_title }
          : {}),
      })),
      sessions: Array.isArray(obj.sessions) ? obj.sessions : [],
      summary: {
        total: typeof summary.total === "number" ? summary.total : 0,
        auto: typeof summary.auto === "number" ? summary.auto : 0,
        snapshots:
          typeof summary.snapshots === "number" ? summary.snapshots : 0,
        safety: typeof summary.safety === "number" ? summary.safety : 0,
        heads: typeof summary.heads === "number" ? summary.heads : 0,
      },
      truncated: Boolean(obj.truncated),
    };
  } catch (e) {
    if (e instanceof Error && e.message.includes("requires QwenPaw 2.1")) {
      throw new CheckpointUnavailableError(e.message);
    }
    throw e;
  }
}

export async function fetchWorkerCheckpointStatus(
  workerName: string,
): Promise<CheckpointStatusResponse> {
  try {
    const raw = (await requestJson(
      `/agentteams-proxy/controller/api/v1/workers/${encodeURIComponent(workerName)}/checkpoints/status`,
    )) as unknown;
    const obj = (raw ?? {}) as Record<string, unknown>;
    return {
      auto_enabled: Boolean(obj.auto_enabled),
      has_checkpoints: Boolean(obj.has_checkpoints),
      workspace_dir: String(obj.workspace_dir || ""),
    };
  } catch (e) {
    if (e instanceof Error && e.message.includes("requires QwenPaw 2.1")) {
      throw new CheckpointUnavailableError(e.message);
    }
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// v0.4.98 再版 11：W3 知识库①——宿主 ReMe 记忆（零新后端）。
//
// 「知识库」= ReMe 长期记忆（memory/ 每日卡 + digest/ personal·procedure·wiki
// + wikilink 图谱），「知识图谱」= 记忆卡 wikilink 引用网络（非实体-关系 KG）。
// 全部走 host.fetch（自动注入 Authorization + X-Agent-Id），不新增插件路由：
//   GET  /agents/{id}/memory/graph          图谱快照（2.1.0+ API）
//   GET  /agents/{id}/memory/status         运行时状态（2.1.0+）
//   POST /agents/{id}/memory/reindex        重建索引（2.1.0+，可耗时数分钟）
//   GET  /workspace/memory?section=         文件列表（copaw 时代既有）
//   GET  /workspace/memory/{path}?section=  文件内容
// 宿主 <2.1 时 graph/status/reindex 404 → 组件降级（文件浏览仍可用）。
// ─────────────────────────────────────────────────────────────────────────────

export interface MemoryGraphNode {
  id: string;
  path: string;
  name: string;
  description: string;
  indexed: boolean;
  virtual?: boolean;
  section?: "daily" | "digest" | null;
  relative_path?: string | null;
}

export interface MemoryGraphEdge {
  source: string;
  target: string;
  target_anchor?: string | null;
}

export interface MemoryGraphSnapshot {
  version: number;
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
}

export interface MemoryRuntimeStatus {
  worker: {
    status: "idle" | "busy" | "stopping" | "error";
    queue_pending: number;
    tasks_running: number;
  };
  auto_memory: { enabled: boolean; interval: number };
  tasks?: unknown[];
  recent?: { last_error?: string | null };
  reindexing?: boolean;
}

export interface MemoryStatusResponse {
  components: Record<string, Record<string, unknown>>;
  components_total: string;
  process_rss: string;
  runtime: MemoryRuntimeStatus;
}

export interface MemoryFileItem {
  filename: string;
  path?: string;
  size: number;
  created_time?: string;
  modified_time?: string;
}

export type MemorySection = "daily" | "digest";

/** host API 统一 JSON 取数（鉴权由 host.fetch 注入）。 */
async function hostJson(path: string, init?: RequestInit): Promise<unknown> {
  const host = window.QwenPaw?.host;
  if (!host || typeof host.fetch !== "function") {
    throw new Error("宿主环境不可用（无 host.fetch）");
  }
  const resp = await host.fetch(path, init);
  const text = await resp.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON（404 HTML 壳等）→ 用状态码报错 */
  }
  if (!resp.ok) {
    const detail = (data as Record<string, unknown> | null)?.detail;
    throw new Error(typeof detail === "string" ? detail : `HTTP ${resp.status}`);
  }
  return data;
}

/** 宿主 agent 列表（getSelectedAgentId 运行时缺失时的 agentId 兜底源）。 */
export async function fetchAgentIdList(): Promise<string[]> {
  const raw = (await hostJson("/agents")) as Record<string, unknown>;
  const agents = Array.isArray(raw.agents) ? raw.agents : [];
  return agents.map((a) => {
    const o = a as Record<string, unknown>;
    return String(o.id ?? "");
  }).filter(Boolean);
}

export async function fetchMemoryGraph(
  agentId: string,
): Promise<MemoryGraphSnapshot> {
  const raw = (await hostJson(
    `/agents/${encodeURIComponent(agentId)}/memory/graph`,
  )) as Record<string, unknown>;
  return {
    version: typeof raw.version === "number" ? raw.version : 1,
    nodes: Array.isArray(raw.nodes)
      ? (raw.nodes as MemoryGraphNode[])
      : [],
    edges: Array.isArray(raw.edges) ? (raw.edges as MemoryGraphEdge[]) : [],
  };
}

export async function fetchMemoryStatus(
  agentId: string,
): Promise<MemoryStatusResponse> {
  const raw = (await hostJson(
    `/agents/${encodeURIComponent(agentId)}/memory/status`,
  )) as Record<string, unknown>;
  const runtime = (raw.runtime ?? {}) as MemoryRuntimeStatus;
  return {
    components:
      (raw.components as Record<string, Record<string, unknown>>) ?? {},
    components_total: String(raw.components_total ?? ""),
    process_rss: String(raw.process_rss ?? ""),
    runtime: {
      worker: runtime.worker ?? {
        status: "idle",
        queue_pending: 0,
        tasks_running: 0,
      },
      auto_memory: runtime.auto_memory ?? { enabled: false, interval: 0 },
      tasks: runtime.tasks,
      recent: runtime.recent,
      reindexing: Boolean(runtime.reindexing),
    },
  };
}

/** 触发重建索引（可能耗时数分钟，fire-and-forget；进度轮询 status.reindexing）。 */
export async function reindexMemory(agentId: string): Promise<void> {
  await hostJson(
    `/agents/${encodeURIComponent(agentId)}/memory/reindex`,
    { method: "POST" },
  );
}

export async function listMemoryFiles(
  section: MemorySection,
): Promise<MemoryFileItem[]> {
  const raw = await hostJson(`/workspace/memory?section=${section}`);
  if (!Array.isArray(raw)) return [];
  return raw.map((f) => {
    const o = f as Record<string, unknown>;
    return {
      filename: String(o.filename ?? o.path ?? ""),
      path: o.path != null ? String(o.path) : undefined,
      size: typeof o.size === "number" ? o.size : 0,
      created_time: o.created_time != null ? String(o.created_time) : undefined,
      modified_time: o.modified_time != null
        ? String(o.modified_time)
        : undefined,
    };
  });
}

export async function loadMemoryFile(
  memoryPath: string,
  section: MemorySection,
): Promise<string> {
  const raw = (await hostJson(
    `/workspace/memory/${memoryPath.split("/").map(encodeURIComponent).join("/")}?section=${section}`,
  )) as Record<string, unknown>;
  return String(raw.content ?? "");
}

// ── 8/30 re18：技能管理（QwenPaw 宿主 Agent，host.fetch 零新后端）──
// 复刻宿主 SkillPool 核心面（参考 QwenPaw Settings/SkillPool），契约源
// src/qwenpaw/app/routers/skills.py（2.1.0+）：
//   GET  /skills                  SkillSpec[]（X-Agent-Id 由 host.fetch 注入）
//   POST /skills/refresh          强制 reconcile 后返回 SkillSpec[]
//   GET  /skills/{name}           SkillDetail（+content/config/installed_from）
//   POST /skills/{name}/enable    {enabled: true}
//   POST /skills/{name}/disable   {disabled: true}
//   DELETE /skills/{name}         {deleted: true}（仅已禁用，409=先禁用）
//   POST /skills                  {name, content, config?, enable?} 新建
//   POST /skills/upload           multipart zip（enable/target_name 参数）
// 范围=当前宿主 Agent（本机助手），非远端 Worker——远端 Worker 技能
// 只读展示在 Worker 管理 tab（M33 D4），团队侧上传/应用=M33 D6（待 PR）。
export interface SkillSpec {
  name: string;
  description: string;
  source: string;
  emoji: string;
  enabled: boolean;
  channels: string[];
  tags: string[];
  last_updated: string;
}

export interface SkillDetail extends SkillSpec {
  content: string;
  config: Record<string, unknown>;
  installed_from: string;
}

export interface SkillUploadResult {
  imported: string[];
  count: number;
  enabled: boolean;
  conflicts?: { reason: string; skill_name: string; suggested_name: string }[];
}

/** 当前宿主 Agent 技能清单。 */
export async function fetchSkills(): Promise<SkillSpec[]> {
  const raw = await hostJson("/skills");
  return Array.isArray(raw) ? (raw as SkillSpec[]) : [];
}

/** 强制 reconcile（目录有变动但清单未跟上时用）。 */
export async function refreshSkills(): Promise<SkillSpec[]> {
  const raw = await hostJson("/skills/refresh", { method: "POST" });
  return Array.isArray(raw) ? (raw as SkillSpec[]) : [];
}

export async function getSkillDetail(
  name: string,
): Promise<SkillDetail> {
  return (await hostJson(
    `/skills/${encodeURIComponent(name)}`,
  )) as SkillDetail;
}

export async function setSkillEnabled(
  name: string,
  enable: boolean,
): Promise<void> {
  await hostJson(
    `/skills/${encodeURIComponent(name)}/${enable ? "enable" : "disable"}`,
    { method: "POST" },
  );
}

/** 仅已禁用技能可删；409 detail="Only disabled workspace skills can be deleted"。 */
export async function deleteSkill(name: string): Promise<void> {
  await hostJson(`/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export async function createSkill(
  name: string,
  content: string,
  enable: boolean,
): Promise<{ created: boolean; name: string }> {
  return (await hostJson("/skills", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, content, enable }),
  })) as { created: boolean; name: string };
}

/** zip 上传（multipart；Content-Type 由 fetch 自填 boundary，勿手设）。 */
export async function uploadSkillZip(
  file: File,
  enable: boolean,
): Promise<SkillUploadResult> {
  const host = window.QwenPaw?.host;
  if (!host || typeof host.fetch !== "function") {
    throw new Error("宿主环境不可用（无 host.fetch）");
  }
  const fd = new FormData();
  fd.append("file", file);
  const resp = await host.fetch(
    `/skills/upload?enable=${enable ? "true" : "false"}`,
    { method: "POST", body: fd },
  );
  const text = await resp.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON（错误页等）→ 按状态码报错 */
  }
  if (!resp.ok) {
    const detail = (data as Record<string, unknown> | null)?.detail;
    throw new Error(typeof detail === "string" ? detail : `HTTP ${resp.status}`);
  }
  const o = (data || {}) as Record<string, unknown>;
  return {
    imported: Array.isArray(o.imported) ? (o.imported as string[]) : [],
    count: typeof o.count === "number" ? o.count : 0,
    enabled: Boolean(o.enabled),
    conflicts: Array.isArray(o.conflicts)
      ? (o.conflicts as SkillUploadResult["conflicts"])
      : undefined,
  };
}

// ── 远端团队知识库（再版 13，用户 8/29 定位）────────────────────────
// 数据通道：插件后端 → Controller Docker API 代理（/docker/v1.41/
// containers/{worker}/archive?path=...，GET 只读恒放行）→ 读 Worker
// 容器内 .qwenpaw/workspaces/default（MEMORY.md + memory/ + SOUL.md）。
// 需要 Controller admin token（L1）；无 token → 401 → 组件降级本地。
// ────────────────────────────────────────────────────────────────────

export interface KbAgent {
  name: string;
  container: string;
  state: string;
  kind: "worker" | "manager";
  team?: string;
  role?: "leader" | "worker" | "critic";
}

export interface KbFileItem {
  path: string;
  name: string;
  size: number;
  mtime: number;
  /** 8/29 re16 四分类（对齐 QwenPaw 文件管理）：
   *  profile=档案 / daily=日记 / digest=知识库 / file=文件 */
  category?: string;
}

/** 8/29 re16：远端 workspace 顶层目录（只列不展开）。 */
export interface KbDirItem {
  path: string;
  name: string;
  isdir: boolean;
  category?: string;
}

export interface KbTree {
  agent: string;
  workspace: string;
  files: KbFileItem[];
  /** 8/29 re16：workspace 顶层目录（文件分类展示用）。 */
  dirs: KbDirItem[];
  count: number;
}

export interface KbDirList {
  agent: string;
  dir: string;
  files: KbFileItem[];
  dirs: KbDirItem[];
}

export interface KbFileContent {
  path: string;
  size: number;
  content: string;
}

export interface KbGraphData {
  agent: string;
  nodes: { id: string; name: string; category: string; virtual: boolean }[];
  edges: { source: string; target: string }[];
  file_count: number;
}

/** 远端 Agent 清单（需 Controller token；401 = 未配置 → 调用方降级）。 */
export async function fetchKbAgents(): Promise<KbAgent[]> {
  const raw = (await requestJson(
    "/agentteams-proxy/kb/agents",
  )) as Record<string, unknown>;
  const agents = Array.isArray(raw.agents) ? raw.agents : [];
  return agents as KbAgent[];
}

export async function fetchKbTree(agent: string): Promise<KbTree> {
  const raw = (await requestJson(
    `/agentteams-proxy/kb/${encodeURIComponent(agent)}/tree`,
  )) as Record<string, unknown>;
  return {
    agent: String(raw.agent ?? agent),
    workspace: String(raw.workspace ?? ""),
    files: (Array.isArray(raw.files) ? raw.files : []) as KbFileItem[],
    dirs: (Array.isArray(raw.dirs) ? raw.dirs : []) as KbDirItem[],
    count: typeof raw.count === "number" ? raw.count : 0,
  };
}

/** 8/30 re18：目录懒加载（知识库目录树展开，NMH/NMA 等子目录文件可见可开）。 */
export async function fetchKbDir(
  agent: string,
  dir: string,
): Promise<KbDirList> {
  const raw = (await requestJson(
    `/agentteams-proxy/kb/${encodeURIComponent(agent)}/ls?dir=${encodeURIComponent(dir)}`,
  )) as Record<string, unknown>;
  return {
    agent: String(raw.agent ?? agent),
    dir: String(raw.dir ?? dir),
    files: (Array.isArray(raw.files) ? raw.files : []) as KbFileItem[],
    dirs: (Array.isArray(raw.dirs) ? raw.dirs : []) as KbDirItem[],
  };
}

export async function fetchKbFile(
  agent: string,
  path: string,
): Promise<KbFileContent> {
  const raw = (await requestJson(
    `/agentteams-proxy/kb/${encodeURIComponent(agent)}/file?path=${encodeURIComponent(path)}`,
  )) as Record<string, unknown>;
  return {
    path: String(raw.path ?? path),
    size: typeof raw.size === "number" ? raw.size : 0,
    content: String(raw.content ?? ""),
  };
}

export async function fetchKbGraph(agent: string): Promise<KbGraphData> {
  const raw = (await requestJson(
    `/agentteams-proxy/kb/${encodeURIComponent(agent)}/graph`,
  )) as Record<string, unknown>;
  return {
    agent: String(raw.agent ?? agent),
    nodes: (Array.isArray(raw.nodes) ? raw.nodes : []) as KbGraphData["nodes"],
    edges: (Array.isArray(raw.edges) ? raw.edges : []) as KbGraphData["edges"],
    file_count: typeof raw.file_count === "number" ? raw.file_count : 0,
  };
}

// ── 0.4.99 B1：团队知识库深化（跨 Worker 搜索 + 聚合图谱）────────────

export interface KbSearchMatch {
  agent: string;
  path: string;
  line: number;
  snippet: string;
}

export async function fetchKbSearch(
  q: string,
  agents?: string,
): Promise<{ query: string; matches: KbSearchMatch[]; count: number; agents: string[] }> {
  const params = new URLSearchParams({ q });
  if (agents) params.set("agents", agents);
  return (await requestJson(
    `/agentteams-proxy/kb/search?${params.toString()}`,
  )) as { query: string; matches: KbSearchMatch[]; count: number; agents: string[] };
}

export async function fetchKbGraphMerged(
  agents?: string,
): Promise<{ nodes: KbGraphData["nodes"]; edges: KbGraphData["edges"]; agents: string[] }> {
  const params = agents ? `?agents=${encodeURIComponent(agents)}` : "";
  const raw = (await requestJson(
    `/agentteams-proxy/kb/graph/merged${params}`,
  )) as Record<string, unknown>;
  return {
    nodes: (Array.isArray(raw.nodes) ? raw.nodes : []) as KbGraphData["nodes"],
    edges: (Array.isArray(raw.edges) ? raw.edges : []) as KbGraphData["edges"],
    agents: (Array.isArray(raw.agents) ? raw.agents : []) as string[],
  };
}

// ── 房间通知（再版 13：通知中心 → 跳房间+定位消息）────────────────

export interface RoomMention {
  room_id: string;
  room_name: string;
  event_id: string;
  sender: string;
  body: string;
  ts: number;
}

/** 各房间最近 @提到我 的消息（后端扫 joined rooms 近期 timeline）。 */
export async function fetchRoomMentions(limit = 30): Promise<RoomMention[]> {
  const raw = (await requestJson(
    `/agentteams-proxy/room-mentions?limit=${limit}`,
  )) as Record<string, unknown>;
  return (Array.isArray(raw.mentions) ? raw.mentions : []) as RoomMention[];
}

// ── 待工具审批请求（v0.5.0-beta.10：Worker Tool Guard HITL 主动通知）────
// 数据源 = sync_watcher /sync 事件流实时缓冲 + 全量扫描 bootstrap（10s
// 缓存）。approve/deny 走 sendRoomMessage 发房间命令（RoomChat 审批卡
// 同款语义），非宿主原生审批队列。

export interface RoomApproval {
  room_id: string;
  room_name: string;
  event_id: string;
  sender: string;
  body: string;
  ts: number;
  /** approval=🛡️ Approval Required（新版）；legacy=⏳ Waiting for approval。 */
  kind: string;
  approve_cmd: string;
  deny_cmd: string;
}

export async function fetchRoomApprovals(limit = 30): Promise<RoomApproval[]> {
  const raw = (await requestJson(
    `/agentteams-proxy/room-approvals?limit=${limit}`,
  )) as Record<string, unknown>;
  return (Array.isArray(raw.approvals)
    ? raw.approvals
    : []) as RoomApproval[];
}
