// 设置域（/sglang/*、/auth-status、/config/*）：自检、SGLang 负载/模型、地址探测、管理员验证、配置导入导出。

import { requestJson } from "../shared";
import { cachedRequest } from "../../requestCache";

interface SelfCheckItem {
  name: string;
  ok: boolean;
  // 14.34：预期态（结构性 401 等）——非故障，前端显 ⚠️ 琥珀而非 ❌ 红。
  warn?: boolean;
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
  /** 本 rank 负载快照发布时刻（epoch 秒；SGLang load_snapshot publish 时刻）。
   *  与顶层 timestamp 区分：顶层=请求处理时刻（≈RTT），非快照新鲜度。0=旧版无字段 */
  snapshot_ts?: number;
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
 * SGLang 模块未启用 → 404 → 返回空列表（前端降级自由输入）。
 * cachedRequest 包裹（sglang/models，60s）——
 * 原高频轮询位点迁移 usePoller 后，同 key 调用经缓存合并为一次回源。 */
export async function fetchSglangModels(): Promise<string[]> {
  return cachedRequest("sglang/models", 60000, async () => {
    try {
      const d = (await requestJson(
        "/agentteams-proxy/sglang/models",
      )) as { models?: string[] };
      return d.models || [];
    } catch {
      return [];
    }
  });
}

// 地址条目 = 纯 URL（服务原生认证，内网默认形态）或
// {url, auth?}（显式覆盖凭据——公网网关 Basic 门 / API key 门）。
interface AddressAuth {
  type: "basic" | "bearer";
  username?: string;
  password?: string;
  token?: string;
}
interface AddressEntryObj {
  url: string;
  auth?: AddressAuth;
}
export type AddressEntry = string | AddressEntryObj;
/** 取条目的 url 字符串（统一入口，防各处手写 entry.url 漏判 string）。 */
export function entryUrl(e: AddressEntry | undefined | null): string {
  if (!e) return "";
  if (typeof e === "string") return e.trim();
  return (e.url || "").trim();
}

export interface WorkbenchConfig {
  matrix_homeservers: AddressEntry[];
  controller_urls: AddressEntry[];
  controller_token: string;
  matrix: {
    user_id: string;
    access_token: string;
    device_id: string;
  };
  effective?: {
    matrix: string;
    controller: string;
 // /config effective 补 gateway（地址模式固定档同源）。
    gateway?: string;
  };
  // SGLang 双地址（内网/外网）；旧单地址 url 由后端自动迁移。
  sglang?: {
    enabled?: boolean;
    url?: string;
    urls?: AddressEntry[];
  };
  // L1 管理员验证二选一（admin 账号密码 / controller_token）。
  // admin_password / console_session 服务端 redact 为 "***"（键存在=已配置）。
  admin_username?: string;
  admin_password?: string;
  gateway_admin_url?: string;
  // Higress 双地址（canonical；legacy 单值键=urls[0] 镜像）。
  gateway_admin_urls?: AddressEntry[];
  // 持久化诊断（后端 GET /config 自 14.12 已返回，
  // 前端此前未消费——「内外网固定没生效/账密没记忆」无法自证时，
  // 设置页直接显示落盘证据）。
  configPath?: string;
  configSavedAt?: number; // config 文件 mtime（epoch 秒）
  configWritable?: boolean; // 配置目录可写性
  // 配置修订号（页面加载时取走，保存时
  // 回传——磁盘在此期间被外部改动则 PUT 409，挡住旧表单静默覆盖）。
  config_rev?: string | null;
  // 最近一次后端加载结局——
  // ok=正常 / defaults-fallback=主文件缺失/损坏且无备份（在跑默认值！）/
  // restored-from-backup=已从备份自愈 / unknown=尚未加载。
  config_health?: {
    state: "ok" | "defaults-fallback" | "restored-from-backup" | "unknown" | string;
    path?: string;
    mtime?: number;
    size?: number;
    writable?: boolean;
  };
  // 逐条凭据存在态自证（redact 前对原始态算的有无标记，不泄露值）：
  // 地址条目三态 saved=完整凭据在 / username-only=只存了用户名（密码
  // 缺失，需补）/ none=裸 URL 或无 auth。设置页显形——「basic 密码要不要
  // 重新填」一眼可判（username-only=真缺要填；saved=留空即保持不变）。
  // admin_password 仅 saved|none（admin 用户名是独立字段恒在，无
  // username-only 态）。
  credential_state?: {
    matrix_homeservers?: string[];
    controller_urls?: string[];
    gateway_admin_urls?: string[];
    sglang_urls?: string[];
    admin_password?: "saved" | "none" | string;
  };
 // 控制台特效安抚（默认开；false=启用动画）。
 // 保留为兼容键（console_effects 三档取代；
  // 后端 load 迁移时以其值推导初值，前端只读不写）。
  console_calm?: boolean;
 // 控制台特效三档
  // （light=动画保留+模糊封顶[默认] / off=动画与模糊全停 / full=上游原样）。
  console_effects?: "light" | "off" | "full";
  console_session?: string;
  // token 文件路径（首选获取方式——连接器每次请求实时读，
  // 永不陈旧、轮换自动适应、不依赖 docker/终端）。非机密（路径非 token 值）。
  // token 解析来源（"file"=token 文件实时读 /
  // "config"=本地配置 / "env"=宿主环境变量 / "file_unreadable"|"invalid"=配置
  // 了但坏了 / ""=无）——file/env 时 controller_token 为空但 L1 数据面可用，
  // 前端门控以此为准。token 值本身永不离开连接器进程。
  controllerTokenSource?: string;
  // 地址手动固定档（auto=自动切换[默认] / lan=固定内网 / wan=固定外网）。
  address_mode?: "auto" | "lan" | "wan";
}

// 登录态/凭据健康（后端纯进程内状态，零外发请求）。
// 用途：token 失效后 @通知静默全断且此前前端零感知——30s 低频轮询驱动横幅。
export interface AuthStatus {
  // none=未登录 / valid=正常 / invalid=/sync 401+auth errcode 判死
  matrix_token: "none" | "valid" | "invalid";
  // none=未验证 / active=正常 / expired=网关面 401 被动判死
  console_session: "none" | "active" | "expired";
  // none / config / env / invalid
  controller_token: string;
}

export async function fetchAuthStatus(): Promise<AuthStatus | null> {
  try {
    return (await requestJson(
      "/agentteams-proxy/auth-status",
      undefined,
      4000,
    )) as AuthStatus;
  } catch {
    // 端点不可用（连接器重载窗口）→ null=横幅不渲染，下轮再试。
    return null;
  }
}

/** L1 管理员验证结果。 */
export interface VerifyAdminResult {
  ok: boolean;
  mode?: "password" | "token";
  error?: string;
  note?: string;
  console?: string;
  has_console_session?: boolean;
  /** 验证成功时的 alias 层自检（Console 会话立即拉
 * /v1/ai/routes + /v1/ai/providers 计数；自检失败降级为 0/[]）。 */
  gateway_routes?: number;
  gateway_aliases?: string[];
  // token 模式来源（input/config/env）+ 来源说明消息。
  tokenSource?: string;
  message?: string;
}

/** L1 管理员验证二选一（验证通过才持久化凭据——与 dashboard「先验证再用」同款）。
 * 密码=*** 用已存值；gateway_admin_url 必填（Console 宿主端口部署时
 * 自选、人人不同，固定端口探测已移除——留空=后端报可操作错误，不再盲探）。 */
export async function verifyAdmin(body: {
  admin_username?: string;
  admin_password?: string;
  controller_token?: string;
  gateway_admin_url?: string;
  // Higress 双地址（列表优先；空框已过滤）。
  gateway_admin_urls?: string[];
}): Promise<VerifyAdminResult> {
  return (await requestJson("/agentteams-proxy/config/verify-admin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })) as VerifyAdminResult;
}

/** 连通性测试结构化诊断（点击展开详情）——
 外网 DPI 问题定位锚点：TLS 栈指纹（Python/OpenSSL 版本）+ 分步耗时 + 全栈 traceback。 */
interface ProbeDiagStep {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}
interface ProbeDiagError {
  message: string;
  traceback: string;
}
interface ProbeDiagEnv {
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

/** 连通性测试结果——单地址。ms=null 表示不可达。
 ok=网络层连通（收到 HTTP 响应即连通，401/403 也算）；
 http_ok=状态码 <400（未鉴权/异常状态时 false，不参与生效地址竞选）。
 diag=点击展开的结构化诊断（仅手动测试路径带）。 */
export interface AddressTestResult {
  url: string;
  ok: boolean;
  http_ok?: boolean;
  ms: number | null;
  detail: string;
  diag?: ProbeDiag;
  // 该地址实际生效的凭据类型（none/basic/bearer）+
  // 401/403 质询分诊（basic=网关 Basic 门 / key=网关 API key 门 /
  // token=服务层 token 被拒 / forbidden=403 / ""=其他）。
  auth?: "none" | "basic" | "bearer";
  challenge?: string;
}

/** 连通性测试响应。applied=true 表示生效地址已按延迟重排；
 switched 标记本次测试后哪些类型的生效地址变了（测完自动切换可见）。 */
export interface ConfigTestResponse {
  ok: boolean;
  matrix: AddressTestResult[];
  controller: AddressTestResult[];
  // SGLang 双地址——逐地址行（与 matrix/controller 同构）。
  sglang: AddressTestResult[] | null;
  // Higress 探测行（诊断面；未配置=空数组）。
  gateway?: AddressTestResult[];
  effective: { matrix: string; controller: string };
  // 固定档回报——四类地址各自的固定值（null=未固定）。
  pinned?: {
    matrix?: string | null;
    controller?: string | null;
    sglang?: string | null;
    gateway?: string | null;
  };
  applied: boolean;
  switched?: { matrix: boolean; controller: boolean };
}

/** 连通性测试（可传未保存的表单值；不传则测已配置地址）。 */
export async function testAddresses(
  matrix?: AddressEntry[],
  controller?: AddressEntry[],
  // SGLang 双地址（内网/外网）列表。
  // 条目可带 auth（草稿凭据随测）。
  sglangUrls?: AddressEntry[],
  // Higress 双地址（内网/外网）列表（诊断面）。
  gatewayUrls?: AddressEntry[],
): Promise<ConfigTestResponse> {
  return (await requestJson("/agentteams-proxy/config/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      matrix: matrix?.length ? matrix : undefined,
      controller: controller?.length ? controller : undefined,
      sglang: sglangUrls?.length ? sglangUrls : undefined,
      gateway: gatewayUrls?.length ? gatewayUrls : undefined,
    }),
  })) as ConfigTestResponse;
}

/** 完整配置导出（含明文凭据）——用户自己的
 * 备份用途（换环境/装包后 10 秒还原）。返回落盘同形的完整配置对象，原文
 * JSON 化即可复制保存；与 GET /config 的脱敏输出（展示面）区分。
 * 注意：返回含凭据——只可保存到可信位置。
 * 需 exportPassword（门密码，X-Export-Password 头）——宿主鉴权可关 + 8088
 * 绑 0.0.0.0 时防匿名局域网 dump 整集群凭据（P0）。 */
export async function exportFullConfig(
  exportPassword?: string,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {};
  if (exportPassword) headers["X-Export-Password"] = exportPassword;
  return (await requestJson(
    "/agentteams-proxy/config/export",
    { headers },
  )) as Record<string, unknown>;
}

/** 完整配置导入（覆盖式恢复）。
 * 后端流程：schema 校验（失败 400 可读错误）→ 自动备份当前配置 → 原子覆盖。
 * restart: "none"=已 live 生效（Matrix 身份变更已自动重启同步）/
 * "page"=建议刷新 workbench 页面确认生效。 */
interface ConfigImportResult {
  ok: boolean;
  restart: "none" | "page";
  config: WorkbenchConfig;
}
export async function importFullConfig(
  config: unknown,
  exportPassword?: string,
): Promise<ConfigImportResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (exportPassword) headers["X-Export-Password"] = exportPassword;
  return (await requestJson("/agentteams-proxy/config/import", {
    method: "POST",
    headers,
    body: JSON.stringify(config),
  })) as ConfigImportResult;
}

/** 完整备份门密码状态（是否已设）。 */
interface ExportPasswordStatus {
  has_password: boolean;
}
export async function exportPasswordStatus(): Promise<ExportPasswordStatus> {
  return (await requestJson(
    "/agentteams-proxy/config/export-password-status",
  )) as ExportPasswordStatus;
}

/** 设置/修改完整备份门密码（≥8 位）。 */
export async function setExportPassword(
  password: string,
): Promise<{ ok: boolean; has_password: boolean }> {
  return (await requestJson("/agentteams-proxy/config/export-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  })) as { ok: boolean; has_password: boolean };
}

/** 清除完整备份门密码。 */
export async function clearExportPassword(): Promise<{
  ok: boolean;
  has_password: boolean;
}> {
  return (await requestJson(
    "/agentteams-proxy/config/export-password",
    { method: "DELETE" },
  )) as { ok: boolean; has_password: boolean };
}
