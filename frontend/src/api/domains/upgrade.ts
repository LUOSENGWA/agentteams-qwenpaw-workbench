// 升级域（/upgrade/*、/node-version/*、/workers/*/runtime-env、controller /api/v1/coding-runs）：集群升级 + coding runs + 节点版本。

import { requestJson } from "../shared";

// ── 编码执行记录（Coding Runs；上游 1.2.5 #1365/#1381 只读端点）──────
// 数据面 = Controller GET /api/v1/coding-runs（controller token 鉴权，
// L1 全量 / L2 本团队前缀，过滤在服务端）。一次委托编码任务跑完 CLI 后
// 把原始日志 tee 到对象存储，这里供人工回看「委托的编码任务做了什么」。
// 与聊天区的 QwenPaw 会话上下文不是同一数据面（那是 Agent 会话，这是
// coding CLI 执行记录）。404 / 空数组 = 旧 Controller 或无可读记录 →
// 调用方空态，不报错。
//
// list 为 v2 契约：runs.jsonl 补元数据（cli/worker/status/exit_code/
// started_at/ended_at/log_bytes），未记录的 run 退回基础字段。exit_code 用
// 指针语义（0 是合法值须显示，未知省略）。时间未知则不伪造——started_at
// 来自记录（UTC），缺失时仅能从 run-YYYYMMDD-HHMMSS.log 文件名取容器钟。
export interface CodingRun {
  task_id: string;
  run: string;
  team?: string;
  cli?: string;
  worker?: string;
  status?: string;
  exit_code?: number | null;
  started_at?: string;
  ended_at?: string;
  log_bytes?: number | null;
  // T5 试点字段（main 的 #1365/#1381 只含前 7 项；下列字段待上游 T5 schema
  // 扩展后出现——旧 Controller 缺省时 UI 显示「—」，不伪造）。
  tokens?: number | null;
  receipt?: string;
  worktree?: string;
  branch?: string;
}

export interface CodingRunDetail {
  task_id: string;
  run: string;
  team?: string;
  meta: {
    cli?: string;
    worker?: string;
    runner?: string;
    status?: string;
    reason?: string;
    exit_code?: number | null;
    timeout_secs?: number | null;
    started_at?: string;
    ended_at?: string;
    log_bytes?: number | null;
    tokens?: number | null;
    receipt?: string;
    worktree?: string;
    branch?: string;
    prompt_file?: string;
    prompt_sha256?: string;
  };
  input: {
    prompt_summary?: string;
    prompt_sha256?: string;
    prompt?: string;
    prompt_available: boolean;
  };
  output: {
    transcript: string;
    status?: string;
    exit_code?: number | null;
  };
}

export async function listCodingRuns(): Promise<CodingRun[]> {
  const res = (await requestJson(
    "/agentteams-proxy/controller/api/v1/coding-runs",
    undefined,
    30000,
  )) as CodingRun[] | { runs?: CodingRun[] } | null;
  if (!res) return [];
  if (Array.isArray(res)) return res;
  return res.runs ?? [];
}

// ── 运行时升级（1.2.5 #1364/#1343：两阶段编排器 + 预检门控）─────────
/** 镜像引用解析版本 tag：先切最后一个 '/' 再取最后 ':' 之后的段
 * （registry:5000/foo/bar:1.0 不取成端口）；无 tag（localhost 无标签等）
 * 原样返回仓库名。 */
export function imageTag(image?: string): string {
  if (!image) return "";
  const rest = image.slice(image.lastIndexOf("/") + 1);
  const i = rest.lastIndexOf(":");
  return i > 0 ? rest.slice(i + 1) : rest;
}

// ── 运行时升级（per-worker，15.25 docker exec 重接）────────────────
// 10/17 实锤：worker 容器运行时未加载 agentteams-upgrade 插件（v1.2.5
// 打包缺口 _prepare_default_plugins 漏接线）→ 旧 127.0.0.1 回环代理
// 恒 404。重接 = 插件后端 docker exec 镜像内置 CLI（checker/upgrade
// 脚本，正源同上游插件消费路径）。
// 数据面 = 插件后端 /upgrade/{check,run,status}（L1 only；worker 必填）。
// check：version 缺省=轻探（当前版本+脚本可用性）；带 version=完整 gate
//   检查（checker --json）。run=202 job handle（破坏性，UI 二次确认；
//   容器将重启、在跑任务中断、失败自动回滚）。status=state-file
//   on-disk 真相源（跨容器重启可读）。
// QwenPaw only：runtime != qwenpaw → 400（后端门控，UI 同步提示）。

/** 批量检查更新（15.27）：一次调用=全部 worker 当前版+latest 本地匹配。
 * 当前版=服务端批量轻探（10min 缓存）——「检查更新」二次点击零 exec。 */
interface UpgradeCheckAllWorker {
  name: string;
  image?: string;
  runtime?: string;
  skipped?: boolean;
  current?: string | null;
  checker?: string;
  upgrader?: string;
  supported?: boolean;
  cached?: boolean;
  error?: string;
}

export interface UpgradeCheckAll {
  workers: UpgradeCheckAllWorker[];
  latest: string | null;
  source?: string;
  cached?: boolean;
  stale?: boolean;
  fetched_at?: number | null;
  error?: string;
}

/** qwenpaw release 列表（版本表格数据源；PyPI releases 倒序 ≤30）。 */
export interface UpgradeVersionRow {
  version: string;
  upload_time: string;
  size: number;
  prerelease: boolean;
  yanked: boolean;
  is_latest: boolean;
}

interface UpgradeVersions {
  versions: UpgradeVersionRow[];
  latest: string;
  source?: string;
  cached?: boolean;
  stale?: boolean;
  fetched_at?: number | null;
  error?: string;
}

/** Worker 运行时环境变量（容器 PID 1 实际生效 env，只读；15.27 预填充正源）。 */
interface WorkerRuntimeEnvEntry {
  key: string;
  value: string;
  masked: boolean;
  sensitive: boolean;
  group: "qwenpaw" | "platform" | "other";
}

export interface WorkerRuntimeEnv {
  worker: string;
  count: number;
  reveal: boolean;
  fetched_at: number;
  /** 15.30：true=stale 回退（fresh 读失败但用历史缓存值，非本次实读）。
   * 预填充链仍可用（真值，只是 ≤120s 旧），不再退化为 registry 默认。 */
  stale?: boolean;
  env: WorkerRuntimeEnvEntry[];
}

/** job 状态机（runner.py）：终态集合（其余视为进行中继续轮询）。 */
export const UPGRADE_TERMINAL_STATES: readonly string[] = [
  "success",
  "rolled_back",
  "rollback_failed",
  "precheck_failed",
  "failed",
];

export interface UpgradeRunHandle {
  job_id: string;
  worker: string;
  container: string;
  version: string;
  state: string;
  detail?: string;
}

/** status：state-file（任意 JSON，runner 写入）+ pending.json。 */
export interface UpgradeStatusResult {
  worker: string;
  container: string;
  job_id?: string | null;
  state?: Record<string, unknown> | null;
  pending?: Record<string, unknown> | null;
}

/** 批量检查更新（一次调用全量 worker 当前版+latest；服务端 10min 缓存）。
 * 「检查更新」主路径 + tab 激活后台预取（二次点击毫秒级）。 */
export async function fetchUpgradeCheckAll(): Promise<UpgradeCheckAll> {
  return (await requestJson(
    "/agentteams-proxy/upgrade/check-all",
    undefined,
    60000,
  )) as UpgradeCheckAll;
}

/** qwenpaw release 列表（版本表格；后端随 latest 同一 PyPI 缓存）。 */
export async function fetchUpgradeVersions(): Promise<UpgradeVersions> {
  return (await requestJson(
    "/agentteams-proxy/upgrade/versions",
    undefined,
    30000,
  )) as UpgradeVersions;
}

/** Worker 运行时环境变量（PID 1 env 预填充正源，只读；reveal=明文）。 */
export async function fetchWorkerRuntimeEnv(
  worker: string,
  reveal?: boolean,
  /** 15.30：true=绕过 120s 缓存实读（保存后确认 hot-applied 真值）。
   * 服务端 exec cap 8s（挂起快速失败）+ stale 回退，正常 ≤8s 返回。 */
  fresh?: boolean,
): Promise<WorkerRuntimeEnv> {
  const qs: string[] = [];
  if (reveal) qs.push("reveal=1");
  if (fresh) qs.push("fresh=1");
  const q = qs.length ? `?${qs.join("&")}` : "";
  return (await requestJson(
    `/agentteams-proxy/workers/${encodeURIComponent(worker)}/runtime-env${q}`,
    undefined,
    15000, // 服务端 exec cap 8s + 缓冲，挂起不再拖 30s
  )) as WorkerRuntimeEnv;
}

/** 触发升级（破坏性：两阶段编排，容器重启、失败自动回滚）。
 * 400=校验拒绝（含「仅支持 qwenpaw 运行时」）/ 502=容器不可达。 */
export async function runUpgrade(
  worker: string,
  version: string,
): Promise<UpgradeRunHandle> {
  return (await requestJson(
    "/agentteams-proxy/upgrade/run",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worker, version }),
    },
    65000,
  )) as UpgradeRunHandle;
}

export async function fetchUpgradeStatus(
  worker: string,
  jobId?: string,
): Promise<UpgradeStatusResult> {
  const q = new URLSearchParams();
  q.set("worker", worker);
  if (jobId) q.set("job_id", jobId);
  return (await requestJson(
    `/agentteams-proxy/upgrade/status?${q.toString()}`,
    undefined,
    20000,
  )) as UpgradeStatusResult;
}

/** 单条 run 详情，固定 ?format=json（transcript 在 output.transcript；
 * 字节透传的 text/plain 默认形态 requestJson 无法解析，故取 json 封装）。 */
export async function fetchCodingRunDetail(
  taskID: string,
  run: string,
  team?: string,
): Promise<CodingRunDetail> {
  const q = new URLSearchParams();
  q.set("format", "json");
  if (team) q.set("team", team);
  return (await requestJson(
    `/agentteams-proxy/controller/api/v1/coding-runs/${encodeURIComponent(
      taskID,
    )}/runs/${encodeURIComponent(run)}?${q.toString()}`,
    undefined,
    30000,
  )) as CodingRunDetail;
}

// ── 节点版本（per-node AgentTeams 镜像 tag + 运行时版本 exec 探测）────
// 10/17 需求：「v1.2.5 是 AgentTeams 版本，不是运行时版本，当前 QwenPaw
// 版本是 2.2.1，还要覆盖其他运行时的版本显示。」
// 数据面 = 插件后端 GET /node-version/{name}（L1 only；后端经 Controller
// /docker/ 代理容器内 exec 探测 qwenpaw/openclaw 版本，10min 缓存；
// 宿主 QwenPaw 版本 ≠ worker 内版本，必须 per-node 探测）。
export interface NodeVersion {
  kind: "worker" | "manager";
  name: string;
  runtime?: string;
  /** AgentTeams 发布版本（Worker/Manager 镜像 tag，去 v 前缀）。 */
  agentteams_version?: string;
  image?: string;
  /** 容器内运行时实际版本（qwenpaw/openclaw；探测失败 null）。 */
  runtime_version?: string | null;
  runtime_version_error?: string;
  probed_at?: number;
}

export async function fetchNodeVersion(
  name: string,
  refresh = false,
): Promise<NodeVersion> {
  const q = refresh ? "?refresh=1" : "";
  return (await requestJson(
    `/agentteams-proxy/node-version/${encodeURIComponent(name)}${q}`,
    undefined,
    30000,
  )) as NodeVersion;
}
