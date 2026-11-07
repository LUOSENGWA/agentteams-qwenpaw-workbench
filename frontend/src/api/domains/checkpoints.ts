// 检查点域（controller /projects/*/history、/workers/*/checkpoints/*）：项目干预时间线 + Worker 检查点。

import { httpErrorStatus, requestJson } from "../shared";
import { cachedRequest } from "../../requestCache";

// ── 项目干预时间线 + Worker 检查点（端点，合并部署后生效）──────────

interface ProjectHistorySnapshot {
  /** unixNano 文件名；字符串——19 位纳秒超出 JS 安全整数。 */
  timestamp: string;
}

interface ProjectHistoryResponse {
  project_id: string;
  snapshots: ProjectHistorySnapshot[];
}

interface CheckpointNode {
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

/** 控制器无 checkpoints/{graph,status} 路由（请求 404/405——旧版控制器，
 * 早于 #1186 检查点只读代理合并）——能力缺口而非错误；调用方隐藏入口并
 * 显示「该控制器不支持检查点图」。 */
export class CheckpointNotSupportedError extends Error {}

/** 能力探测（纯函数）：请求错误携带 HTTP 404/405 = 控制器无对应路由
 * （Go ServeMux 的 404 "404 page not found" / 405 Method Not Allowed）。
 * 502（QwenPaw<2.1）、网络错误等不算路由缺失。 */
export function checkpointRouteMissing(e: unknown): boolean {
  const status = httpErrorStatus(e);
  return status === 404 || status === 405;
}

/** 30s 缓存（列表类；key 含 projectId+teamId）。 */
export function fetchProjectHistory(
  projectId: string,
  teamId?: string,
): Promise<ProjectHistoryResponse> {
  // teamId 可选：跨团队重名项目不带 = 409 ambiguous（同 /workflow 契约）。
  const teamQ = teamId ? `?team=${encodeURIComponent(teamId)}` : "";
  return cachedRequest(
    `project-history:${projectId}:${teamId ?? ""}`,
    30_000,
    async () => {
      const raw = (await requestJson(
        `/agentteams-proxy/controller/api/v1/projects/${encodeURIComponent(projectId)}/history${teamQ}`,
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
    },
    { tags: ["checkpoints"] },
  );
}

/** 不缓存：一次性打开的单快照详情（大载荷 + 无轮询消费方）。 */
export async function fetchProjectHistorySnapshot(
  projectId: string,
  timestamp: string,
  teamId?: string,
): Promise<Record<string, unknown>> {
  const teamQ = teamId ? `?team=${encodeURIComponent(teamId)}` : "";
  return (await requestJson(
    `/agentteams-proxy/controller/api/v1/projects/${encodeURIComponent(projectId)}/history/${timestamp}${teamQ}`,
  )) as Record<string, unknown>;
}

/** 30s 缓存（key=worker+limit；错误路径（含 CheckpointUnavailableError /
 * CheckpointNotSupportedError）不写缓存，与原语义一致）。 */
export function fetchWorkerCheckpointGraph(
  workerName: string,
  limit = 100,
): Promise<CheckpointGraphResponse> {
  return cachedRequest(
    `worker-checkpoints:${workerName}:${limit}`,
    30_000,
    async () => {
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
        // 404/405 = 控制器无对应路由（旧版）→ 能力缺口，不是错误。
        if (checkpointRouteMissing(e)) {
          throw new CheckpointNotSupportedError("checkpoint route missing");
        }
        if (e instanceof Error && e.message.includes("requires QwenPaw 2.1")) {
          throw new CheckpointUnavailableError(e.message);
        }
        throw e;
      }
    },
    { tags: ["checkpoints"] },
  );
}

/** 30s 缓存（key=worker；错误路径（含 CheckpointNotSupportedError）不写
 * 缓存，与原语义一致）。 */
export function fetchWorkerCheckpointStatus(
  workerName: string,
): Promise<CheckpointStatusResponse> {
  return cachedRequest(
    `worker-checkpoint-status:${workerName}`,
    30_000,
    async () => {
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
        // 404/405 = 控制器无对应路由（旧版）→ 能力缺口，不是错误。
        if (checkpointRouteMissing(e)) {
          throw new CheckpointNotSupportedError("checkpoint route missing");
        }
        if (e instanceof Error && e.message.includes("requires QwenPaw 2.1")) {
          throw new CheckpointUnavailableError(e.message);
        }
        throw e;
      }
    },
    { tags: ["checkpoints"] },
  );
}
