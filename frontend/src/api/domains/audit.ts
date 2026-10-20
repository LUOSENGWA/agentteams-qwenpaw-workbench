// 审计事件域（controller /api/v1/audit）。

import { requestJson } from "../shared";

// ── 审计事件（A7；上游 #1270 GET /api/v1/audit，Controller 持久审计存储
// 读侧，MinIO JSONL 追加式，覆盖全部入口：dashboard / CLI / API）──────
// 作用域（与 worker/team 读 API 一致）：
//   L1（admin/manager，无 ?team=）= 全部事件（含无团队的全局事件）；
//   L2（team leader / L2 human）= ?team= 必填（400），跨团队读=404 反探测；
//   worker 身份 = 403 默认拒绝（插件以 human 身份运行，不会命中）。
export interface AuditEvent {
  ts: string;
  kind: string; // capability | approval_level | channel | source | <action>
  actor: string;
  target: string;
  targetTeam?: string;
  action: string;
  capability?: string;
  before?: string[];
  after?: string[];
  detail?: string;
}

interface AuditPage {
  events: AuditEvent[];
  /** 仅当页满（可能还有后续）时存在。keyset 分页（timestamp,seq）。 */
  cursor?: string;
}

interface AuditQuery {
  team?: string;
  kind?: string;
  from?: string; // RFC3339
  to?: string; // RFC3339
  cursor?: string;
  limit?: number; // 默认 50，上限 200
}

export async function fetchAuditEvents(
  params: AuditQuery = {},
): Promise<AuditPage> {
  const q = new URLSearchParams();
  if (params.team) q.set("team", params.team);
  if (params.kind) q.set("kind", params.kind);
  if (params.from) q.set("from", params.from);
  if (params.to) q.set("to", params.to);
  if (params.cursor) q.set("cursor", params.cursor);
  q.set("limit", String(params.limit ?? 50));
  return (await requestJson(
    `/agentteams-proxy/controller/api/v1/audit?${q.toString()}`,
    undefined,
    30000,
  )) as AuditPage;
}
