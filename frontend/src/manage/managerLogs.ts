// managerLogs.ts — Manager 容器日志（旧拓扑 WorkerManageTables.ManagerDetail
// 迁入）的纯函数：路径拼装 / 响应解析 / 错误分类。无 React / 无 window
// 依赖，node 环境直测。
//
// 端点 = GET /agentteams-proxy/docker-logs/{managerName}?tail=300（Controller
// Docker API 代理，运维页 OpsPanel 同源；需管理员 token）。

import { httpErrorStatus } from "../api/shared";

export interface DockerLogLine {
  timestamp?: string;
  level?: string;
  message?: string;
}

/** 日志端点路径（容器名 = Manager 名；尾行数固定 300）。 */
export function managerLogPath(name: string, tail = 300): string {
  const n = Math.max(1, Math.floor(tail));
  return `/agentteams-proxy/docker-logs/${encodeURIComponent(name)}?tail=${n}`;
}

/** 响应 → 展示行（`ts [❌ ]message`）。非对象/缺 lines/坏行一律跳过（不臆造）。 */
export function parseDockerLogLines(data: unknown): string[] {
  const raw =
    data && typeof data === "object"
      ? (data as { lines?: unknown }).lines
      : undefined;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const line = item as Record<string, unknown>;
    const ts = typeof line.timestamp === "string" ? line.timestamp : "";
    const level = typeof line.level === "string" ? line.level : "";
    const message = typeof line.message === "string" ? line.message : "";
    const text = `${ts} ${level === "error" ? "❌ " : ""}${message}`.trim();
    if (text) out.push(text);
  }
  return out;
}

export type ManagerLogErrorKind = "missing" | "forbidden" | "error";

/** 拉日志失败 → 可读状态：404 = 端点缺失（老控制器），403 = 无权，其余可重试。 */
export function classifyManagerLogError(e: unknown): ManagerLogErrorKind {
  const status = httpErrorStatus(e);
  if (status === 404) return "missing";
  if (status === 403) return "forbidden";
  return "error";
}
