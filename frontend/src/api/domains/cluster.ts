// 集群元信息域（Controller /api/v1/status + /api/v1/version）。
//
// 两个端点都是 Controller 只读快照，慢变事实（计数随 Worker/Team 增删、
// 版本随镜像升级）→ 60s 内存缓存（requestCache：TTL + 在飞去重 + LRU）。
// 集群页挂载时并行拉一次，不新增轮询（与 /cluster-info 10min 缓存同思路）。
//
// /status 是 live metrics（上游 StatusHandler 注释：不受保护）；/version
// 带 ETag。两者都可能被老控制器路由缺失或网关拦 → 401/403 由调用方判定
// 隐藏卡片（本域照常抛错，不吞失败；静默降级是 UI 层职责）。
import { requestJson } from "../shared";
import { cachedRequest } from "../../requestCache";

const STATUS_PATH = "/agentteams-proxy/controller/api/v1/status";
const VERSION_PATH = "/agentteams-proxy/controller/api/v1/version";

/** 60s：慢变事实；与集群页手动重进/多卡挂载同节奏，不打无谓请求。 */
export const CLUSTER_META_TTL_MS = 60_000;

export interface ClusterStatus {
  kubeMode: string;
  totalWorkers: number;
  totalTeams: number;
  totalHumans: number;
}

export interface ControllerVersion {
  controller: string;
  kubeMode: string;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asCount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** 映射 /status（纯函数，可测）：缺字段/类型异常一律降级为空串/0——
 * 卡片显 "—" 而不是把 undefined 渲染出来。 */
export function mapClusterStatus(raw: unknown): ClusterStatus {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    kubeMode: asString(o.kubeMode),
    totalWorkers: asCount(o.totalWorkers),
    totalTeams: asCount(o.totalTeams),
    totalHumans: asCount(o.totalHumans),
  };
}

/** 映射 /version（纯函数，可测）：controller 老控制器硬编码 "dev"。 */
export function mapControllerVersion(raw: unknown): ControllerVersion {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    controller: asString(o.controller),
    kubeMode: asString(o.kubeMode),
  };
}

/** GET /status → 计数 + kubeMode（60s 缓存；失败原样抛）。 */
export function fetchClusterStatus(force = false): Promise<ClusterStatus> {
  return cachedRequest<unknown>(
    "cluster:status",
    CLUSTER_META_TTL_MS,
    () => requestJson(STATUS_PATH, undefined, 30000),
    { force, tags: ["cluster"] },
  ).then(mapClusterStatus);
}

/** GET /version → controller 版本 + kubeMode（60s 缓存；失败原样抛）。 */
export function fetchControllerVersion(
  force = false,
): Promise<ControllerVersion> {
  return cachedRequest<unknown>(
    "cluster:version",
    CLUSTER_META_TTL_MS,
    () => requestJson(VERSION_PATH, undefined, 30000),
    { force, tags: ["cluster"] },
  ).then(mapControllerVersion);
}
