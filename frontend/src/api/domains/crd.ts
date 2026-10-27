// CRD/L1-L2 管理面（controller /api/v1/workers|teams|humans|managers）：CRD CRUD + admin 聚合取数。

import { controllerRequest, fetchControllerJson } from "../shared";
import { cachedFetch } from "../../requestCache";

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
  /** Worker 的 LLM provider（WorkerResponse.modelProvider = WorkerSpec.ModelProvider，
   * Higress APIG Model API 名；空=跟随默认）。多 provider 部署下只改 model
   * 不改 provider = 仍走旧 provider。 */
  modelProvider?: string;
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
  /** env 是否可编辑（1.2.5+；L1/manager=true，L2=false，旧 Controller=undefined
 * → 前端一律不渲染 env 段，优雅降级）。 */
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
}

export interface AdminData {
  workers: WorkerInfo[];
  teams: TeamInfo[];
  humans: HumanInfo[];
  managers: ManagerInfo[];
}

/** 员工入职（Human CR 创建）。上游无 UpdateHuman——改权限级别需删除重建。 */
export const createHuman = (body: Record<string, unknown>) =>
  controllerRequest("POST", "/humans", body) as Promise<CreateHumanResponse>;

/** 创建 Worker（POST /api/v1/workers，）：CR 创建后由
 * Controller 调和器拉镜像起容器（数分钟就绪）。body: name 必填；
 * model/modelProvider/identity/soul/agents/skills/mcpServers/expose/
 * containerManaged(默认 true)/state 可选（CreateWorkerRequest）。 */
export const createWorker = (body: Record<string, unknown>) =>
  controllerRequest("POST", "/workers", body);
export const deleteHuman = (name: string) =>
  controllerRequest("DELETE", `/humans/${encodeURIComponent(name)}`);

/** 更新 Human 的团队授权（PUT /api/v1/humans/{name}，merge 语义：
 * accessibleTeams 传数组 = 整表替换，省略 = 不变）。
 * 404/405 = Controller 未含该端点（旧版）→ 调用方回落「生成命令」。 */
export const updateHumanAccessibleTeams = (
  name: string,
  accessibleTeams: string[],
) =>
  controllerRequest("PUT", `/humans/${encodeURIComponent(name)}`, {
    accessibleTeams,
  });
/** 创建团队——workerMembers 必须引用已存在的 Worker CR，且 ≥1。 */
export const createTeam = (body: Record<string, unknown>) =>
  controllerRequest("POST", "/teams", body);
/** 配置团队（PUT 部分更新：空字段不覆盖）。humanMembers 上游 PUT 不支持。 */
export const updateTeam = (name: string, body: Record<string, unknown>) =>
  controllerRequest("PUT", `/teams/${encodeURIComponent(name)}`, body);
/** 更新现有 Worker 的模型（PUT /workers/{name} 合并语义——只应用非空字段，
 * 其余 spec 不动；modelProvider 传 undefined=不改，传值=覆盖）。。
 * 
 * 多 Higress provider 部署下 model 只是请求 alias，真正转发由 modelProvider
 * （APIG Model API 名）决定；选 alias 时应同时回填/下发 provider。 */
export const updateWorkerModel = (
  name: string,
  model: string,
  modelProvider?: string,
) =>
  controllerRequest("PUT", `/workers/${encodeURIComponent(name)}`, {
    model,
    ...(modelProvider !== undefined ? { modelProvider } : {}),
  });
/** ：通用 Worker spec 合并更新——
 * 只发非空字段（PUT 合并语义同上）；model/soul 任意组合。 */
export const updateWorker = (name: string, body: Record<string, unknown>) =>
  controllerRequest("PUT", `/workers/${encodeURIComponent(name)}`, body);

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
export const updateManagerModel = (name: string, model: string) =>
  controllerRequest("PUT", `/managers/${encodeURIComponent(name)}`, { model });

/** 重启 Manager 容器（POST /managers/{name}/restart；Controller 侧 stop+start，
 * 重建后配置/模型重新加载）。 */
export const restartManager = (name: string) =>
  controllerRequest("POST", `/managers/${encodeURIComponent(name)}/restart`);

export const deleteTeam = (name: string) =>
  controllerRequest("DELETE", `/teams/${encodeURIComponent(name)}`);

/** cachedFetch 包裹（admin/data，TTL 30s + SWR 30s，tags
 * ["admin"]）——4 路并发取数，WorkerManage 30s 轮询与 CrdManage 失效后
 * 重取合并为一次回源。SWR：30-60s 段先回旧值（面板零等待）+ 后台再验证；
 * >60s 或标签失效（写操作后 invalidateTags(["admin"])）→ 等回源。 */
export async function fetchAdminData(): Promise<AdminData> {
  return cachedFetch(
    "admin/data",
    30000,
    async () => {
      const [workers, teams, humans, managers] = await Promise.all([
        fetchControllerJson<unknown>("/workers").then(normalizeList),
        fetchControllerJson<unknown>("/teams").then(normalizeList),
        // humans/managers
        // 失败不再拖垮 workers/teams（fetchL2AdminData 同款语义）——旧版
        // Promise.all 里任一 404/超时（旧 Controller 无该端点/瞬时抖动）整体
        // reject → admin 面板整体空白；workers/teams 才是 CRD 管理面板核心数据。
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
function fetchListSafe(url: string): Promise<unknown[]> {
  return fetchControllerJson<unknown>(url)
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
        fetchControllerJson<unknown>("/workers").then(normalizeList),
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
