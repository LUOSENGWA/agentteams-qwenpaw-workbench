// Worker 管理面（/workers/*、/workers-status、/skills）：技能目录/通道/工具/会话/loops/状态 + 团队技能包上传。

import { controllerRequest, requestJson } from "../shared";

// ── 技能中心 ──────────────────────────────────────────────
/** GET /api/v1/skills 契约（skill-catalog-api.md，已合 main）：技能目录条目。
 * source = builtin | shared | plugin（team 层=团队技能，team-skills.md）。
 * L1（admin）：builtin + shared（deployment 全局）。
 * L2：必须带 ?team=<本团队>（上游 W8 反探测——cross-team/unknown → 404）
 * → builtin + teams/<t>/skills/（team-skills.md 契约）。
 * 上游合并前 Controller 404 → 目录节显示占位（抛错由 UI 捕获）。 */
export interface SkillCatalogItem {
  name: string;
  description?: string;
  source: string;
  agents?: string[];
  runtimes?: string[];
  version?: string;
}
export async function fetchSkillCatalog(
  team?: string,
): Promise<SkillCatalogItem[]> {
  const q = team ? `?team=${encodeURIComponent(team)}` : "";
  const raw = (await controllerRequest("GET", `/skills${q}`)) as Record<
    string,
    unknown
  >;
  const arr = Array.isArray(raw?.skills) ? raw.skills : [];
  return arr as SkillCatalogItem[];
}

// ── 频道接入（上游契约 draft 未合——404=版本门）──
/** 单频道配置（QwenPaw channels_config 条目：enabled/bot_prefix +
 * 频道特有字段，自由键值）。 */
export type WorkerChannelConfig = Record<string, unknown> & {
  enabled?: boolean;
  bot_prefix?: string;
  isBuiltin?: boolean;
};
/** 插件频道表单 schema（QwenPaw /channels/schemas：config_fields 元数据）。
 * 内置频道无 schema 条目 → 通用键值编辑器兜底。 */
interface ChannelSchemaField {
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
 * （上游未合/Controller 未升级）。 */
export function fetchWorkerChannels(
  name: string,
): Promise<Record<string, WorkerChannelConfig>> {
  return controllerRequest("GET", channelBase(name)) as Promise<
    Record<string, WorkerChannelConfig>
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
 * 不支持的频道 404 → UI 隐藏二维码按钮）。 */
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
 * 自动回填表单）。 */
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

/** 微信二维码状态直连（插件后端 → iLink，绕过 Controller 5s 长轮询超时）。
 *
 * iLink 的 get_qrcode_status 是长轮询（服务端挂 ~31s）；Controller 频道代理
 * 固定 5s、插件后端通用代理 6s，都会在返回前掐断 → 扫码后永远读不到
 * confirmed。此端点由插件后端直连 iLink（45s），仅微信通道使用。
 * 返回形状与 Controller 路由一致：{status, credentials}。 */
export function fetchWechatQrStatusDirect(
  token: string,
): Promise<{ status: string; credentials: Record<string, unknown> | null }> {
  return requestJson(
    `/agentteams-proxy/wechat-qr/status?token=${encodeURIComponent(token)}`,
  ) as Promise<{
    status: string;
    credentials: Record<string, unknown> | null;
  }>;
}

// ── Worker 内置工具设置（#1255 已合 main；404 = Controller 版本门）────
export interface WorkerToolInfo {
  name: string;
  enabled: boolean;
  description?: string;
  asyncExecution?: boolean;
  icon?: string;
  requiresConfig?: boolean;
}
/** 工具列表（只含状态，配置值在 Controller 代理边界已剔除）。 */
export function fetchWorkerTools(
  name: string,
): Promise<{ tools: WorkerToolInfo[]; total: number }> {
  return controllerRequest(
    "GET",
    `/workers/${encodeURIComponent(name)}/tools`,
  ) as Promise<{ tools: WorkerToolInfo[]; total: number }>;
}
/** 声明式单/双字段更新（{enabled} 和/或 {asyncExecution}；幂等可重试）。
 * 403 = Leader 只读 / L2 跨团队写；404 = 未知 worker/工具（W8 防探测）。 */
export function patchWorkerTool(
  name: string,
  tool: string,
  patch: { enabled?: boolean; asyncExecution?: boolean },
): Promise<WorkerToolInfo> {
  return controllerRequest(
    "PATCH",
    `/workers/${encodeURIComponent(name)}/tools/${encodeURIComponent(tool)}`,
    patch,
  ) as Promise<WorkerToolInfo>;
}

// ── Worker 运行时技能（物化层；GET /workers/{name}/skills 代理 worker
// qwenpaw app /api/skills，controller worker_skills.go）──────────────
// // 分配层 = WorkerResponse.skills（spec.skills，CRD 显式分配，PUT /workers
// {skills} 写入）——「管理员声明给了什么」。
// 物化层 = 本端点（worker 容器内实际装载，runtime 自报）——「实际能调用
// 什么」。二者可背离：团队层技能 materialize-at-assign（#1238）/ builtin
// 恢复 / 镜像·插件自带技能都不写 spec.skills → 分配层空但物化层非空
// = 13.14 矩阵全显未分配但可正常调用的真相。
// 404 = Controller 未含端点（版本门）/ L2 跨团队 W8 防探测；403 = 只读身份。
// 物化层字段补全——上游 SkillSpec（qwenpaw skills.py）
// 实回 {name, description, version_text, source, emoji, enabled, channels,
// preload, tags, last_updated}；此前只取 3 字段，「每 worker 技能」在 UI
// 上只剩光杆名字，看不出来源（builtin/custom/团队物化）与用途。
export interface WorkerRuntimeSkill {
  name: string;
  enabled?: boolean;
  preload?: boolean;
  description?: string;
  version_text?: string;
  source?: string;
  emoji?: string;
  tags?: string[];
  /** 物化层技能来源——worker 实际装载渠道（builtin/custom 等）。 */
  channels?: string[];
  last_updated?: string;
}
export function fetchWorkerSkills(name: string): Promise<WorkerRuntimeSkill[]> {
  return controllerRequest(
    "GET",
    `/workers/${encodeURIComponent(name)}/skills`,
  ) as Promise<WorkerRuntimeSkill[]>;
}

// ── Worker 技能预加载策略（PUT /workers/{name}/skills/{skill}/preload）──
// per-worker 技能的可写面。preload=true = 技能全文注入
// 该 worker 每个 session 的 system prompt（常驻能力，有 per-session token
// 成本）——qwenpaw 侧验证并持久化（skill.json）+ agent 热加载，无需重启。
// 写权限（上游 worker_skills.go）：L1 任意 worker；L2 human 限自己团队；
// team leader 只读（403）。404 = worker 无此技能 / 其 qwenpaw < 2.2.1
// 无 preload 路由（版本门）/ L2 跨团队防探测；502 = worker 不可达。
export function setWorkerSkillPreload(
  name: string,
  skillName: string,
  preload: boolean,
): Promise<{ updated: boolean; preload: boolean }> {
  return controllerRequest(
    "PUT",
    `/workers/${encodeURIComponent(name)}/skills/${encodeURIComponent(skillName)}/preload`,
    { preload },
  ) as Promise<{ updated: boolean; preload: boolean }>;
}

// ── Worker 会话只读（#1295 等合并；给无头 QwenPaw Worker「补头」）──────
// 404 = 未知 worker / L2 房间边界外 / Controller 未含该端点（W8 统一不可探测）。
// detail = agent 上下文（可能含压缩历史/未发送工具输出，UI 必须标注）。
export interface WorkerChatSpec {
  id: string;
  name?: string;
  session_id?: string;
  user_id?: string;
  channel?: string;
  created_at?: string;
  updated_at?: string;
  pinned?: boolean;
  archived?: boolean;
  source?: string;
  /** qwenpaw ChatSpec.status（app/chats/models.py:136）："idle" | "running"
 * ——qwenpaw app 自维护的 per-session 会话状态（13.8 状态灯正源）。 */
  status?: string;
}
export interface WorkerChatMessage {
  id?: string;
  type?: string;
  role?: string;
  content: unknown;
  status?: string;
}
interface WorkerChatDetail {
  messages?: WorkerChatMessage[];
  status?: string;
}
export function fetchWorkerChats(name: string): Promise<WorkerChatSpec[]> {
  return controllerRequest(
    "GET",
    `/workers/${encodeURIComponent(name)}/chats`,
  ) as Promise<WorkerChatSpec[]>;
}
export function fetchWorkerChat(
  name: string,
  chatId: string,
): Promise<WorkerChatDetail> {
  return controllerRequest(
    "GET",
    `/workers/${encodeURIComponent(name)}/chats/${encodeURIComponent(chatId)}`,
  ) as Promise<WorkerChatDetail>;
}
/** /status 仅 QwenPaw ≥2.2.1——旧 runtime 404 = 隐藏状态灯（版本无关门）。
 * 恒 200 时 {status:"idle"|"running"}（chat 不存在也 idle）。 */
export function fetchWorkerChatStatus(
  name: string,
  chatId: string,
): Promise<{ status: string }> {
  return controllerRequest(
    "GET",
    `/workers/${encodeURIComponent(name)}/chats/${encodeURIComponent(chatId)}/status`,
  ) as Promise<{ status: string }>;
}
/** Worker 状态聚合响应——后端 30s 后台单点
 * 扫描 + 聚合缓存（多窗口共享）；scanAt=最近成功扫描时刻（epoch 秒），
 * scanning=后台补扫进行中（本次响应为上轮快照）。 */
interface WorkersStatusResponse {
  workers: Record<string, { running: boolean; lastUpdated: number }>;
  scanAt: number;
  scanning: boolean;
}
/** Worker 状态聚合（单端点；旧逐 worker
 * /chats 扇出退役）。 */
export function fetchWorkersStatus(): Promise<WorkersStatusResponse> {
  return requestJson(
    "/agentteams-proxy/workers-status",
  ) as Promise<WorkersStatusResponse>;
}

// ── Worker loop 模式（上游 #1231 端点族，pinned qwenpaw loops router 契约）──
// catalog = builtin/custom/plugin 三源；custom CRUD 为整块替换语义（PUT 全量）；
// status 按会话（chat_id/session_id 二参白名单，Controller 透传）。
export interface WorkerLoopModeInfo {
  id: string;
  name: string;
  slash_command: string;
  description?: string;
  source?: string; // builtin | custom | plugin
}
/** GET /workers/{name}/loops——可用 loop 模式目录。 */
export function fetchWorkerLoops(name: string): Promise<WorkerLoopModeInfo[]> {
  return controllerRequest(
    "GET",
    `/workers/${encodeURIComponent(name)}/loops`,
  ) as Promise<WorkerLoopModeInfo[]>;
}
export interface WorkerLoopStatus {
  state: string; // idle | running | awaiting_user
  mode?: WorkerLoopModeInfo | null;
}
/** GET /workers/{name}/loops/status?session_id=——仅按 session 查激活 loop。
 * 聊天页 composer 消费点（QwenPaw 前端 LoopModeSelector
 * 同位）——1:1 Worker 房间 session_id = `matrix:{room_id}`（qwenpaw matrix
 * channel resolve_session_id 实锤：DM/群房间均为 matrix:{room_id}）。 */
export function fetchWorkerLoopStatusBySession(
  name: string,
  sessionId: string,
): Promise<WorkerLoopStatus> {
  const q = new URLSearchParams({ session_id: sessionId });
  return controllerRequest(
    "GET",
    `/workers/${encodeURIComponent(name)}/loops/status?${q.toString()}`,
  ) as Promise<WorkerLoopStatus>;
}
interface WorkerLoopGateConfig {
  id: string;
  type: string;
  enabled?: boolean;
  params?: Record<string, unknown>;
}
export interface WorkerLoopCustomMode {
  id: string;
  name: string;
  description?: string;
  slash_command: string;
  enabled?: boolean;
  gates?: WorkerLoopGateConfig[];
}
/** GET /workers/{name}/loops/custom——已存自定义 loop 模式。 */
export function fetchWorkerLoopCustoms(
  name: string,
): Promise<WorkerLoopCustomMode[]> {
  return controllerRequest(
    "GET",
    `/workers/${encodeURIComponent(name)}/loops/custom`,
  ) as Promise<WorkerLoopCustomMode[]>;
}
/** POST /workers/{name}/loops/custom——新建（整对象；409 重名/422 管道校验失败）。 */
export function createWorkerLoopCustom(
  name: string,
  mode: WorkerLoopCustomMode,
): Promise<WorkerLoopCustomMode> {
  return controllerRequest(
    "POST",
    `/workers/${encodeURIComponent(name)}/loops/custom`,
    mode as unknown as Record<string, unknown>,
  ) as Promise<WorkerLoopCustomMode>;
}
/** PUT /workers/{name}/loops/custom/{id}——整块替换（body.id 必须等于路径 id，
 * 否则 422；循环变更由服务端通知团队 Leader）。 */
export function updateWorkerLoopCustom(
  name: string,
  modeId: string,
  mode: WorkerLoopCustomMode,
): Promise<WorkerLoopCustomMode> {
  return controllerRequest(
    "PUT",
    `/workers/${encodeURIComponent(name)}/loops/custom/${encodeURIComponent(modeId)}`,
    mode as unknown as Record<string, unknown>,
  ) as Promise<WorkerLoopCustomMode>;
}
/** DELETE /workers/{name}/loops/custom/{id}——204 无 body。 */
export function deleteWorkerLoopCustom(
  name: string,
  modeId: string,
): Promise<void> {
  return controllerRequest(
    "DELETE",
    `/workers/${encodeURIComponent(name)}/loops/custom/${encodeURIComponent(modeId)}`,
  ) as Promise<void>;
}

// ── 技能管理 ──


/** ：**团队技能包上传**——
 * POST /api/v1/skills（multipart：scope=team + team + file=技能 zip）。
 * 经插件代理 → 连接器（multipart 原样透传，v13.19 起）→ Controller；
 * 上游 v1.2.4 起带 skillscan（422=内容拦截并回 findings，响应带
 * scan.status/skipped）。返回体：{name, scope, team, files, scan}。 */
export async function uploadTeamSkill(opts: {
  team: string;
  file: File | Blob;
  filename: string;
}): Promise<{
  ok: boolean;
  status: number;
  detail?: string;
  name?: string;
  files?: number;
  scan?: { status?: string; findings?: string[] };
}> {
  const host = window.QwenPaw?.host;
  if (!host || typeof host.fetch !== "function") {
    throw new Error("宿主环境不可用（无 host.fetch）");
  }
  const fd = new FormData();
  fd.append("scope", "team");
  fd.append("team", opts.team);
  fd.append("file", opts.file, opts.filename);
  const resp = await host.fetch("/agentteams-proxy/controller/api/v1/skills", {
    method: "POST",
    body: fd,
  });
  const text = await resp.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON（错误页等）→ 按状态码报错 */
  }
  const o = (data || {}) as Record<string, unknown>;
  const detail =
    typeof o.detail === "string"
      ? o.detail
      : typeof o.message === "string"
        ? o.message
        : undefined;
  const scanRaw = o.scan as Record<string, unknown> | undefined;
  return {
    ok: resp.ok,
    status: resp.status,
    detail,
    name: typeof o.name === "string" ? o.name : undefined,
    files: typeof o.files === "number" ? o.files : undefined,
    scan: scanRaw
      ? {
          status: typeof scanRaw.status === "string" ? scanRaw.status : undefined,
          findings: Array.isArray(scanRaw.findings)
            ? (scanRaw.findings as string[])
            : undefined,
        }
      : undefined,
  };
}

// ── Worker MCP 合并读（CRD 声明 + worker 自注册；Controller 新端点代理）──

/** 自注册 MCP 条目（后端已归一化/脱敏：env/headers 值=***；command/args
 * 用户名段→~；URL 剥 userinfo）。字段随 Controller 形态防御性归一化。 */
export interface WorkerMcpEntry {
  /** 稳定标识（QwenPaw MCPClientInfo.key；与 CRD 声明按此合并）。 */
  name: string;
  /** 显示名（MCPClientInfo.name，可与 key 不同）。 */
  displayName?: string;
  enabled?: boolean | null;
  transport?: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface WorkerMcpResult {
  available: boolean;
  worker?: string;
  /** available=false 时的原因：controller_too_old / no_token / fetch_failed。 */
  reason?: string;
  mcpServers?: WorkerMcpEntry[];
}

/** GET /workers/{worker}/mcp：Controller 端点 404 时后端返回
 * {available:false, reason:"controller_too_old"}（HTTP 200，不抛错）。 */
export function fetchWorkerMcp(worker: string): Promise<WorkerMcpResult> {
  return requestJson(
    `/agentteams-proxy/workers/${encodeURIComponent(worker)}/mcp`,
  ) as Promise<WorkerMcpResult>;
}

// ── Worker 插件只读（Controller 新端点 GET /api/v1/workers/{name}/plugins 代理）──

/** 已装插件条目（字段直传，无凭据无需脱敏）。字段名随 Controller 契约：
 * id / name / version / enabled / loaded / plugin_type。 */
export interface WorkerPluginEntry {
  id?: string;
  name?: string;
  version?: string;
  enabled?: boolean | null;
  loaded?: boolean | null;
  plugin_type?: string;
}

export interface WorkerPluginsResult {
  available: boolean;
  worker?: string;
  /** available=false 时的原因：controller_too_old / no_token。 */
  reason?: string;
  plugins?: WorkerPluginEntry[];
}

/** GET /workers/{worker}/plugins：Controller 端点 404 时后端返回
 * {available:false, reason:"controller_too_old"}（HTTP 200，不抛错）。 */
export function fetchWorkerPlugins(
  worker: string,
): Promise<WorkerPluginsResult> {
  return requestJson(
    `/agentteams-proxy/workers/${encodeURIComponent(worker)}/plugins`,
  ) as Promise<WorkerPluginsResult>;
}
