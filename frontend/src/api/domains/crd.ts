// CRD/L1-L2 管理面（controller /api/v1/workers|teams|humans|managers）：CRD CRUD + admin 聚合取数。

import {
  controllerRequest,
  fetchControllerJson,
  httpErrorStatus,
  recordConsistencyRead,
  requestJsonConditional,
} from "../shared";
import {
  cachedFetch,
  cachedRequest,
  invalidateTags,
  NOT_MODIFIED,
  conditionalValue,
} from "../../requestCache";
import { lruReadThrough, lruInvalidate } from "../../cache/memoryLru";
import {
  mergeWorkerRows,
  missingSpecNames,
  shouldFallbackCombined,
} from "../../lib/workerListMerge";

/** Worker 列表投影字段（#1477 消费侧，docs/design/worker-list-fields-api.md）：
 * spec（稳定配置）+ status（易变状态）——不含 skills/mcpServers/env/soul/agents
 * （写编辑器一律先读 detail GET /workers/{name}，禁列表行兜底）。
 * 旧 Controller 忽略 fields → 返回全量，消费方优雅降级。导出供测试断言。 */
export const WORKER_LIST_FIELDS = "spec,status";

// ── L1 全量视图（Controller API，需管理员 token）────────────────────

/** Controller WorkerResponse.mcpServers（api/v1beta1.MCPServer，v1.2.3 实锤）。 */
export interface McpServerInfo {
  name: string;
  url: string;
  transport?: string;
}

export interface WorkerInfo {
  name: string;
  /** 显示名（WorkerResponse.workerName，omitempty=未设）。#1477 每个 view 都带
   * 稳定身份：name（CR 名，恒有）+ workerName（显示名，若有）——
   * 禁止按列表位置关联行。 */
  workerName?: string;
  phase: string;
  state: string;
  model: string;
  /** Worker 的 LLM provider（WorkerResponse.modelProvider = WorkerSpec.ModelProvider，
   * Higress APIG Model API 名；空=跟随默认）。多 provider 部署下只改 model
   * 不改 provider = 仍走旧 provider。 */
  modelProvider?: string;
  /** 子代理模型（QwenPaw >= 2.1.1；空/undefined = 未设/与主模型相同）。 */
  subagentModel?: string;
  runtime: string;
  /** 自定义 Docker 镜像（WorkerResponse.image；发布部署 = 带发布 tag 的
   * 运行时镜像，如 …agentteams-qwenpaw-worker:v1.2.5——运行时版本正源，
   * 取 tag 用 imageTag()；旧 Controller 无字段 = undefined）。 */
  image?: string;
  containerState: string;
  matrixUserID: string;
  roomID: string;
  team: string;
  role: string;
  message: string;
  version?: string;
  /**
 * Worker 已装载的 skill 名列表
 * （WorkerResponse.skills = spec.skills，nacos:// 远端条目含源前缀）。
 * 通用代理透传 Controller 完整响应，字段运行时已存在，此前未声明。
 */
  skills?: string[];
  /** Worker 挂载的 MCP server（name/url/transport）。 */
  mcpServers?: McpServerInfo[];
  /** ：Worker 心跳 agent 状态字段
 * （controller WorkerResponse 顶层平铺透传，worker-agent-status 契约——
 * 任务级真相，取代 typing 2min 硬上限假熄灭；旧版 controller 无 → 派生
 * 优雅降级 typing+last_ts，同 dashboard 3ad94e2 语义）。 */
  agentStatus?: string;
  runningTaskCount?: number;
  lastRunAt?: string;
  lastFinishAt?: string;
  /**
 * legacy 运行时角标判定——controller ≥#1327
 * 对 copaw 存量 worker 置 true（omitempty）；旧 controller 无此字段 =
 * undefined（降级为仅按 runtime 判定，可接受）。
 */
  runtimeDeprecated?: boolean;
  /** Worker 环境变量（spec.env 透传，AgentTeams 1.2.5+；
 * L2 账号被服务端遮蔽 → 不存在；旧 Controller 无字段 → undefined）。 */
  env?: Record<string, string>;
  /** env 是否可编辑（1.2.5+；L1/manager=true，L2=false，旧 Controller=
 * undefined；16.61 起列表投影 fields=spec/status 也丢此字段=undefined）。
 * 渲染门：仅明确 false（L2 遮蔽）隐藏 env 段；undefined 照常渲染、
 * 面板内 detail 加载态诚实降级。 */
  envEditable?: boolean;
  /** LLM 调优（AgentTeams 1.2.5+，顶层回显，omitempty=未设置不显；
   * 留空=继承团队默认/registry 默认。写=PUT /workers/{name} 字段级 diff，
   * L1-only。分组：startup（重建容器生效）/ stream（热更新）。 */
  llmMaxRetries?: string;
  llmBackoffBase?: string;
  llmBackoffCap?: string;
  llmMaxConcurrent?: string;
  llmMaxQpm?: string;
  llmRateLimitPause?: string;
  llmRateLimitJitter?: string;
  llmAcquireTimeout?: string;
  llmStreamFirstContentTimeout?: string;
  llmStreamIdleTimeout?: string;
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
  /** CRD 管理「配置团队」预填用（TeamResponse 透传）。 */
  workerMembers?: { name: string; role: string }[];
  heartbeatEvery?: string;
  peerMentions?: boolean;
  /** 团队级 spawn 子代理默认模型（TeamResponse.subagentModel 透传）。 */
  subagentModel?: string;
  /** 团队级 LLM 调优默认（AgentTeams 1.2.5+，TeamSpec llm* 顶层回显，
   * omitempty=未设不显；Worker 未设时继承此团队默认，再回退 registry。
   * 写=PUT /teams/{name} 指针语义（不发=不动/""=清除/值=覆盖）。 */
  llmMaxRetries?: string;
  llmBackoffBase?: string;
  llmBackoffCap?: string;
  llmMaxConcurrent?: string;
  llmMaxQpm?: string;
  llmRateLimitPause?: string;
  llmRateLimitJitter?: string;
  llmAcquireTimeout?: string;
  llmStreamFirstContentTimeout?: string;
  llmStreamIdleTimeout?: string;
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

/** 员工入职响应——initialPassword 只在创建时返回一次。 */
interface CreateHumanResponse extends HumanInfo {
  email?: string;
  initialPassword?: string;
  rooms?: string[];
}

export interface ManagerInfo {
  name: string;
  phase: string;
  state: string;
  model: string;
  /** Worker 的 LLM provider（WorkerResponse.modelProvider = WorkerSpec.ModelProvider，
   * Higress APIG Model API 名；空=跟随默认）。多 provider 部署下只改 model
   * 不改 provider = 仍走旧 provider。 */
  modelProvider?: string;
  /* ManagerResponse 已有 runtime/image 字段（omitempty），前端补声明。 */
  runtime?: string;
  image?: string;
  matrixUserID: string;
  roomID: string;
  version: string;
  message: string;
  /* ── ManagerSpec 字段（仅详情视图）────────────────────────────────────
   * Controller 列表视图 ManagerResponse 不带这些字段（resource_handler
   * managerToResponse 只映射标量列）——仅详情端点 GET /managers/{name}
   * 返回；fetchManagerFull 专供详情面板。旧 Controller 详情响应无这些
   * 字段 → undefined，前端诚实降级显"未配置"。 */
  soul?: string;
  agents?: string;
  skills?: string[];
  mcpServers?: McpServerInfo[];
  env?: Record<string, string>;
  config?: ManagerConfigInfo;
}

/** ManagerSpec.Config（controller types.ManagerConfig）——Manager 独有
 * 运行调参。controller 侧默认值：heartbeatInterval 15m /
 * workerIdleTimeout 720m / notifyChannel admin-dm。
 * PUT {config} 为整对象替换语义（UpdateManager：req.Config != nil 整体写）。 */
export interface ManagerConfigInfo {
  /** 心跳间隔（如 "15m"）。 */
  heartbeatInterval?: string;
  /** Worker 空闲回收超时（如 "720m"）。 */
  workerIdleTimeout?: string;
  /** 决策/通知投递频道（如 "admin-dm"）。 */
  notifyChannel?: string;
}

export interface AdminData {
  workers: WorkerInfo[];
  teams: TeamInfo[];
  humans: HumanInfo[];
  managers: ManagerInfo[];
}

// ── 写面失效策略（16.33 缓存补齐）：CRD 全部 CRUD 成功后
// invalidateTags(["teams","admin"])（admin 聚合视图四段同源）；
// createWorker 另失效 ["workers-status"]（容器状态列表同变）。
// probeWorkerGateway 为一次性诊断探测（无对应读缓存），不失效。

/** 员工入职（Human CR 创建）。上游无 UpdateHuman——改权限级别需删除重建。 */
export async function createHuman(
  body: Record<string, unknown>,
): Promise<CreateHumanResponse> {
  const r = (await controllerRequest("POST", "/humans", body)) as CreateHumanResponse;
  invalidateTags(["teams", "admin"]);
  lruInvalidate("crd:");
  return r;
}

/** 创建 Worker（POST /api/v1/workers，）：CR 创建后由
 * Controller 调和器拉镜像起容器（数分钟就绪）。body: name 必填；
 * model/modelProvider/identity/soul/agents/skills/mcpServers/expose/
 * containerManaged(默认 true)/state 可选（CreateWorkerRequest）。 */
export async function createWorker(
  body: Record<string, unknown>,
): Promise<unknown> {
  const r = await controllerRequest("POST", "/workers", body);
  invalidateTags(["teams", "admin", "workers-status"]);
  lruInvalidate("crd:");
  return r;
}
export async function deleteHuman(name: string): Promise<unknown> {
  const r = await controllerRequest("DELETE", `/humans/${encodeURIComponent(name)}`);
  invalidateTags(["teams", "admin"]);
  lruInvalidate("crd:");
  return r;
}

/** 更新 Human 的团队授权（PUT /api/v1/humans/{name}，merge 语义：
 * accessibleTeams 传数组 = 整表替换，省略 = 不变）。
 * 404/405 = Controller 未含该端点（旧版）→ 调用方回落「生成命令」。 */
export async function updateHumanAccessibleTeams(
  name: string,
  accessibleTeams: string[],
): Promise<unknown> {
  const r = await controllerRequest("PUT", `/humans/${encodeURIComponent(name)}`, {
    accessibleTeams,
  });
  invalidateTags(["teams", "admin"]);
  lruInvalidate("crd:");
  return r;
}

/** 一键保存人员访问与权限（15.35：同 updateHumanAccessibleTeams 的
 * PUT /humans/{name} 端点与 merge 语义，一次发全字段：permissionLevel +
 * accessibleTeams + accessibleWorkers）。
 * 404/405 = Controller 未含该端点（旧版）→ 调用方回落「生成命令」。 */
export async function updateHumanAccess(
  name: string,
  spec: {
    permissionLevel: number;
    accessibleTeams: string[];
    accessibleWorkers: string[];
  },
): Promise<unknown> {
  const r = await controllerRequest("PUT", `/humans/${encodeURIComponent(name)}`, spec);
  invalidateTags(["teams", "admin"]);
  lruInvalidate("crd:");
  return r;
}
/** 创建团队——workerMembers 必须引用已存在的 Worker CR，且 ≥1。 */
export async function createTeam(body: Record<string, unknown>): Promise<unknown> {
  const r = await controllerRequest("POST", "/teams", body);
  invalidateTags(["teams", "admin"]);
  lruInvalidate("crd:");
  return r;
}
/** 配置团队（PUT 部分更新：空字段不覆盖）。humanMembers 上游 PUT 不支持。 */
export async function updateTeam(
  name: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const r = await controllerRequest("PUT", `/teams/${encodeURIComponent(name)}`, body);
  invalidateTags(["teams", "admin"]);
  lruInvalidate("crd:");
  return r;
}
/** 更新现有 Worker 的模型（PUT /workers/{name} 合并语义——只应用非空字段，
 * 其余 spec 不动；modelProvider 传 undefined=不改，传值=覆盖）。。
 * 
 * 多 Higress provider 部署下 model 只是请求 alias，真正转发由 modelProvider
 * （APIG Model API 名）决定；选 alias 时应同时回填/下发 provider。 */
export async function updateWorkerModel(
  name: string,
  model: string,
  modelProvider?: string,
  subagentModel?: string | null,
): Promise<unknown> {
  const body: Record<string, unknown> = { model };
  // 空 provider 永不下发：列表投影（#1477 fields=spec/status）不含 modelProvider，
  // 弹窗基线可能取不到值；若把 "" 写下去，控制器 merge 语义会清空该 Worker 的
  // provider（现存 deepseek / qwen3.6-local 等会被改错路由）。清空不是有效用例。
  if (modelProvider !== undefined && modelProvider !== "") body.modelProvider = modelProvider;
  if (subagentModel !== undefined) body.subagentModel = subagentModel;
  const r = await controllerRequest("PUT", `/workers/${encodeURIComponent(name)}`, body);
  invalidateTags(["teams", "admin"]);
  lruInvalidate("crd:");
  return r;
}
/** ：通用 Worker spec 合并更新——
 * 只发非空字段（PUT 合并语义同上）；model/soul 任意组合。 */
export async function updateWorker(
  name: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const r = await controllerRequest("PUT", `/workers/${encodeURIComponent(name)}`, body);
  invalidateTags(["teams", "admin"]);
  lruInvalidate("crd:");
  return r;
}

/** Worker 网关身份探测（POST /api/v1/workers/{name}/gateway-probe，
 * AgentTeams 1.2.5+ #1306，L1/manager only）。
 * 服务端只用 CRD 已持久化的模型/MCP 端点 + worker 持久身份拨号网关
 * （不接受调用方 URL/token——无提权面）。正常恒 HTTP 200 + 结果对象；
 * 403 无权限 / 409 worker 未设模型或身份不可用 / 501 provider-specific
 * 探测不支持 / 503 gateway 未配置 = 显式错误码（httpErrorStatus 取）。 */
interface GatewayProbeResult {
  success: boolean;
  message: string;
  latencyMs: number;
  consumer: string;
  kind: "model" | "mcp";
}
export const probeWorkerGateway = (
  name: string,
  kind: "model" | "mcp",
  server?: string,
) =>
  controllerRequest(
    "POST",
    `/workers/${encodeURIComponent(name)}/gateway-probe`,
    kind === "mcp" && server ? { kind, server } : { kind },
  ) as Promise<GatewayProbeResult>;
/** 更新 Manager 模型。PUT /managers/{name} 同为合并语义
 * （Controller UpdateManager：if req.Model != "" 才写 spec，其余 spec 不动；
 * resource_handler.go 源码实锤）——只发 {model}，provider 保持原值/默认。 */
export async function updateManagerModel(
  name: string,
  model: string,
  modelProvider?: string,
  subagentModel?: string | null,
): Promise<unknown> {
  const body: Record<string, unknown> = { model };
  if (modelProvider) body.modelProvider = modelProvider;
  if (subagentModel !== undefined) body.subagentModel = subagentModel;
  const r = await controllerRequest("PUT", `/managers/${encodeURIComponent(name)}`, body);
  invalidateTags(["teams", "admin"]);
  lruInvalidate("crd:");
  return r;
}

/** 取 Manager 完整 spec（任务 A：ManagerDetailPane 全配置面板）。
 * 列表视图 ManagerResponse 不带 spec 字段——详情面板挂载时走本函数
 * （GET /managers/{name}）；旧 Controller 详情响应缺字段 → 对应字段
 * undefined，前端诚实降级显"未配置"。 */
export async function fetchManagerFull(name: string): Promise<ManagerInfo> {
  const r = (await controllerRequest(
    "GET",
    `managers/${encodeURIComponent(name)}`,
  )) as unknown as ManagerInfo | null;
  return r ?? ({} as ManagerInfo);
}

/** 通用 Manager 更新（任务 A 1.7）——PUT /managers/{name} 合并语义，
 * 只发 body 实际携带的字段（UpdateManagerRequest 各字段 omitempty）：
 * model/soul/agents 非空才应用（空串不 clear 既有值）；skills/mcpServers
 * 数组=整表替换（空数组=清空）；config 整对象替换；state 覆盖。
 * 注：当前 UpdateManagerRequest 无 env 字段——发 {env} 旧 controller 静默
 * 忽略（无害），controller 补齐后自动生效。 */
export async function updateManager(name: string, body: Record<string, unknown>): Promise<unknown> {
  const r = await controllerRequest("PUT", `/managers/${encodeURIComponent(name)}`, body);
  invalidateTags(["teams", "admin"]);
  lruInvalidate("crd:");
  return r;
}

/** 创建 Manager（POST /api/v1/managers，CreateManagerRequest）：
 * name 必填；model/modelProvider/runtime/image/soul/agents/skills 可选
 * （上游 types.go 实证）。CR 创建后由 Controller 调和器拉镜像起容器。 */
export async function createManager(body: Record<string, unknown>): Promise<unknown> {
  const r = await controllerRequest("POST", "/managers", body);
  invalidateTags(["teams", "admin"]);
  lruInvalidate("crd:");
  return r;
}

/** 删除 Manager（DELETE /api/v1/managers/{name}）——只影响该 Manager CR
 * （上游 resource_handler.go 无级联副作用）。 */
export async function deleteManager(name: string): Promise<unknown> {
  const r = await controllerRequest("DELETE", `/managers/${encodeURIComponent(name)}`);
  invalidateTags(["teams", "admin"]);
  lruInvalidate("crd:");
  return r;
}

export async function deleteTeam(name: string): Promise<unknown> {
  const r = await controllerRequest("DELETE", `/teams/${encodeURIComponent(name)}`);
  invalidateTags(["teams", "admin"]);
  lruInvalidate("crd:");
  return r;
}

/** 删除 Worker（DELETE /api/v1/workers/{name}）——成功 204；
 * 该 Worker 属于某团队时 409（body.message 透出，调用方用
 * httpErrorDetail 展示）。写面失效同 createWorker：容器列表同变。 */
export async function deleteWorker(name: string): Promise<unknown> {
  const r = await controllerRequest("DELETE", `/workers/${encodeURIComponent(name)}`);
  invalidateTags(["teams", "admin", "workers-status"]);
  lruInvalidate("crd:");
  return r;
}

// ── S：Worker 列表 slim parallel polling + 条件复验（回灌 dashboard #179，
// 条件复验统一收敛 requestCache，替换 R1 自写缓存的接线）─────────────────
// 权威语义（docs/worker-list-compatibility.md，dashboard #179 原文要点）：
// 1. 轮询并行取 fields=spec 与 fields=status：spec 走 requestCache 条件复验
//    （ETag/304 → 304 复用缓存字节不重解析，requestCache 内建），status 永远
//    重新读（fetchControllerJson 直读，不缓存——上游 #1480 明确不缓存）；
// 2. 按稳定 name 合并行（不看列表位置）；membership 由 status 决定（被删的
//    Worker 必须消失）；新出现的 name 在 spec 快照缺失 → 同 key force 重读
//    一次；仍缺 → 合并视图；
// 3. 任何路径不做每行 detail 请求（无 N+1）——写编辑器仍先读 detail
//    （P1 不变，fetchWorkerDetail 未动）；
// 4. 旧 Controller 忽略 fields → 接受完整响应（含旧数组形态，normalizeRows
//    兼容）；400（拒绝 fields）→ 回退不带 fields 的完整列表；鉴权/权限/
//    基础设施错误（401/403/5xx/超时）照抛；
// 5. 缓存仅内存（requestCache 统一 LRU 限容）；写后失效沿用既有约定
//    invalidateTags(["admin"])（写操作各腿已接线，无全局清缓存）；
// 6. status 视图永不条件缓存（status 契约恒 200，上游 #1480）。

/** 列表路径与缓存键（#1480：仅 fields=spec 带强 ETag → 走
 * requestJsonConditional 条件复验；fields=status / fields=spec,status /
 * 缺省上游明确不缓存 → fetchControllerJson 恒新鲜直读，相对路径自动拼
 * controller 前缀）。 */
const SPEC_KEY = "workers:list:spec";
const SPEC_TTL = 60_000;
const SPEC_PATH = "/agentteams-proxy/controller/api/v1/workers?fields=spec";
const STATUS_PATH = "/workers?fields=status";
const COMBINED_PATH = "/workers?fields=spec,status";

/** 响应归一（worker 列表）：数组形态（旧 Controller 忽略 fields 的全量
 * 响应）或 {workers: [...]} 形态。 */
function normalizeRows(payload: unknown): WorkerInfo[] {
  if (Array.isArray(payload)) return payload as WorkerInfo[];
  const obj = (payload ?? null) as Record<string, unknown> | null;
  const rows = obj?.workers;
  return (Array.isArray(rows) ? rows : []) as WorkerInfo[];
}

/** S 列表正源（条件复验收敛 requestCache，替换 R1 自写缓存接线）：spec 条件
 * 复验（ETag/304，304 → requestCache 返回缓存旧值不重解析）+ status 恒新鲜
 * （不缓存），按 name 合并行（status 权威：覆盖同名字段 + membership +
 * 顺序）；spec 缺名同 key force 重读一次 → 仍缺走合并视图
 * （fields=spec,status，单请求无 N+1）；400（旧 Controller 拒绝 fields）→
 * 回退不带 fields 的完整列表。strong（#1407 写后立即读）：spec force 绕过
 * TTL + consistency=strong，是否真强一致由 X-Consistency 判定记入 tracker。
 * 导出供复用（组件层走 fetchAdminData/fetchL2AdminData，零改动）。 */
export async function listWorkerSummaries(
  opts?: { strong?: boolean },
): Promise<WorkerInfo[]> {
  const strong = !!opts?.strong;
  const strongOpts = strong ? { strong: true } : undefined;
  const specPath = strong ? `${SPEC_PATH}&consistency=strong` : SPEC_PATH;
  // spec 条件复验 fetcher（requestJsonConditional 同源 requestJsonFull：
  // 30s 封顶 = fetchControllerJson 同源；返回原始响应供读 ETag）。
  const specFetcher = async (etag?: string) => {
    const { payload, response } = await requestJsonConditional(
      specPath,
      etag,
      30_000,
    );
    // consistency tracker 记录写后读结果（非 strong 为 no-op，P1 strong
    // 腿同源；304 同样记录——ETag 复核通过正是强一致证据）。
    recordConsistencyRead(strong, response);
    if (payload === NOT_MODIFIED) return NOT_MODIFIED;
    return conditionalValue(
      normalizeRows(payload),
      response?.headers.get("etag") ?? null,
    );
  };
  try {
    // ① spec 条件复验（304 → cachedRequest 返回缓存旧值，不重解析；
    // force 不发 If-None-Match → 写后立即读必新鲜）
    const specRows = await cachedRequest<WorkerInfo[]>(
      SPEC_KEY,
      SPEC_TTL,
      specFetcher,
      { force: strong, tags: ["admin"] },
    );
    // ② status 恒新鲜（不缓存）；契约恒 200——异常 304 显式失败（不产空列表）
    const statusPayload = await fetchControllerJson<unknown>(
      STATUS_PATH,
      strongOpts,
    );
    if (statusPayload === NOT_MODIFIED) {
      throw new Error("status 视图返回 304（契约恒 200）——请重新读取");
    }
    const statusRows = normalizeRows(statusPayload);
    // ③ 按 name 合并（status 覆盖同名字段 + membership + 顺序）
    let merged = mergeWorkerRows(specRows, statusRows);
    // 新出现的 name 在 spec 快照缺失 → 同 key force 重读一次（force 不带
    // If-None-Match → 必 200 全量）
    if (missingSpecNames(specRows, statusRows).length > 0) {
      const fresh = await cachedRequest<WorkerInfo[]>(
        SPEC_KEY,
        SPEC_TTL,
        specFetcher,
        { force: true, tags: ["admin"] },
      );
      merged = mergeWorkerRows(fresh, statusRows);
      // 重读后仍缺 → 合并视图（fields=spec,status，单请求，仍无 N+1）
      if (shouldFallbackCombined(fresh, statusRows)) {
        return normalizeRows(
          await fetchControllerJson<unknown>(COMBINED_PATH, strongOpts),
        );
      }
    }
    return merged;
  } catch (e) {
    // 400（旧 Controller 拒绝 fields）→ 回退不带 fields 的完整列表
    // （normalizeRows 兼容旧数组形态）；其它错误（401/403/5xx/超时）照抛。
    if (httpErrorStatus(e) === 400) {
      return normalizeRows(
        await fetchControllerJson<unknown>("/workers", strongOpts),
      );
    }
    throw e;
  }
}

/** cachedFetch 包裹（admin/data，TTL 30s + SWR 30s，tags
 * ["admin"]）——4 路并发取数，WorkerManage 30s 轮询与 CrdManage 失效后
 * 重取合并为一次回源。SWR：30-60s 段先回旧值（面板零等待）+ 后台再验证；
 * >60s 或标签失效（写操作后 invalidateTags(["admin"])）→ 等回源。
 *
 * `strong`（#1407 写后立即读）：4 腿带 `?consistency=strong` 且同 key
 * force 覆盖写（绕过 TTL/SWR 直取上游）；结果是否真强一致由响应头
 * X-Consistency 判定并记入 consistency tracker（上游端点不支持该参数
 * → 无头，诚实降级 eventual，不声称做不到的事）。
 *
 * `lru`（批次 4）：外层 LRU（crd:admin，120s）先读后台刷——CRD 管理
 * 面板打开即有数据；strong 读绕过 LRU（写后读必须新鲜）。4 腿
 * composite 不条件化（多上游聚合，ETag 无单一来源）——新鲜度由
 * 30s TTL/SWR 承担。 */
export async function fetchAdminData(
  opts?: { strong?: boolean; lru?: boolean },
): Promise<AdminData> {
  const strong = opts?.strong ? { strong: true } : undefined;
  const base = (): Promise<AdminData> =>
    cachedFetch(
      "admin/data",
      30000,
      async () => {
        const [workers, teams, humans, managers] = await Promise.all([
          // R1（回灌 dashboard #179）：slim parallel polling——spec 条件复验
          // （ETag/304，304 复用缓存字节）+ status 恒重新读，按 name 合并
          // （status 权威）；旧 Controller 忽略 fields → 全量响应直接接受，
          // 400（拒绝 fields）→ 回退不带 fields 的完整列表；strong（写后
          // 立即读）带 consistency=strong 且读后记 consistency tracker，
          // P1 同源。
          listWorkerSummaries(strong ? { strong: true } : undefined),
          fetchControllerJson<unknown>("/teams", strong).then(normalizeList),
          // humans/managers
          // 失败不再拖垮 workers/teams（fetchL2AdminData 同款语义）——旧版
          // Promise.all 里任一 404/超时（旧 Controller 无该端点/瞬时抖动）整体
          // reject → admin 面板整体空白；workers/teams 才是 CRD 管理面板核心数据。
          fetchListSafe("/humans", strong),
          fetchListSafe("/managers", strong),
        ]);
        return {
          workers: workers as WorkerInfo[],
          teams: teams as TeamInfo[],
          humans: humans as HumanInfo[],
          managers: managers as ManagerInfo[],
        };
      },
      { tags: ["admin"], swrMs: 30000, ...(strong ? { force: true } : {}) },
    );
  if (!opts?.lru || opts?.strong) return base();
  return lruReadThrough("crd:admin", 120_000, base) as Promise<AdminData>;
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

/** 安全腿：controller list 取数 + normalizeList 归一，失败置空
 * （不拖垮同组 workers/teams）——fetchAdminData/fetchL2AdminData 的
 * humans/managers 两路共用（整段复制 2 块收敛）。 */
function fetchListSafe(
  url: string,
  opts?: { strong?: boolean },
): Promise<unknown[]> {
  return fetchControllerJson<unknown>(url, opts)
    .then(normalizeList)
    .catch(() => [] as unknown[]);
}

/** （L2 双模式，调研 P0 + 上游 l2-worker-scoped-write.md
 * / team-skills.md 已合 main）：L2 身份（Matrix token，无 admin token）取数。
 * 与 fetchAdminData 的区别：humans/managers 是 L1 管理面（L2 无权限或无意义）
 * → 失败置空不炸；workers/teams 是 L2 技能中心正源（Controller 按
 * accessibleTeams 自动 scope——standalone worker 隐藏，防探测）。 */
/** cachedFetch 包裹（admin/l2，TTL 30s + SWR 30s，tags
 * ["admin"]）——L2 身份取数，与 admin/data 同标签（写失效一起清）。 */
export async function fetchL2AdminData(): Promise<AdminData> {
  return cachedFetch(
    "admin/l2",
    30000,
    async () => {
      const [workers, teams, humans, managers] = await Promise.all([
        // R1（回灌 dashboard #179，同 fetchAdminData）：slim parallel polling
        // （spec 条件复验 + status 恒重新读 + 按 name 合并）；L2 技能中心正源
        // 同样投影瘦身，400 回退完整列表。
        listWorkerSummaries(),
        fetchControllerJson<unknown>("/teams").then(normalizeList),
        fetchListSafe("/humans"),
        fetchListSafe("/managers"),
      ]);
      return {
        workers: workers as WorkerInfo[],
        teams: teams as TeamInfo[],
        humans: humans as HumanInfo[],
        managers: managers as ManagerInfo[],
      };
    },
    { tags: ["admin"], swrMs: 30000 },
  );
}

/** 写前读 detail（#1477 强制）：写编辑器（skills / env / MCP / 全配置）必须
 * 先 GET /workers/{name} 成功才可编辑；失败/加载中 → 只读 + 错误，禁止用
 * 列表行兜底（列表已投影为 spec,status，不含 skills/mcpServers/env）。
 * 只在用户打开/展开对应 worker 时取一次（不预取、不 N+1）；15s 缓存防
 * 连续展开/重试风暴，写操作后 invalidateTags(["admin"]) 一并失效。
 *
 * `strong`（写后立即读同款语义）：force 绕过 TTL 直取上游。 */
export async function fetchWorkerDetail(
  name: string,
  opts?: { strong?: boolean },
): Promise<WorkerInfo> {
  const strong = opts?.strong ? { strong: true } : undefined;
  return cachedFetch(
    `worker-detail:${name}`,
    15000,
    () => fetchControllerJson<WorkerInfo>(`/workers/${encodeURIComponent(name)}`, strong),
    { tags: ["admin"], ...(strong ? { force: true } : {}) },
  );
}
