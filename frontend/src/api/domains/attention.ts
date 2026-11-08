// attention 决策域（/agentteams-proxy/attention*）：读聚合 + 人类身份答回。
// 数据契约 = controller GET /api/v1/projects/{id}/attention（并行任务
// attention-api）；404 = 端点未部署（旧 controller）→ 连接器返回
// deployed=false（HTTP 200），UI 诚实降级：不显示 badge/入口，不报错。
// 答 = 工作台以人类身份（Matrix 登录 token）发 DECISION 行回任务房间，
// 不写任务 meta、不改 worker。

import {
  requestJson,
  requestJsonFull,
  requestJsonConditional,
  getCachedRooms,
  httpErrorStatus,
} from "../shared";
import {
  cachedRequest,
  invalidateTags,
  NOT_MODIFIED,
  conditionalValue,
} from "../../requestCache";

/** attention 选项（NMH §8：options=结构化选项集；回答时严格回 option id）。 */
export interface AttentionOption {
  id: string;
  label: string;
  /** 选项说明（团队视角 #1503 行 options 字段；聚合视图无）。 */
  description?: string;
}

/** 通知结果日志单条（上游 taskflow.py 契约——#1394 字段定案）：
 * room/channel 是两条独立验收——`channel_accepted` 是 per-recipient 回执，
 * adapter 未上报时保持 null，**绝不从 room 送达推断**（上游注释原文）。 */
export interface NotificationLogEntry {
  attempt: number;
  ts: string;
  /** 房间发送是否被接受（m.room.message 发送成功）。 */
  room_accepted: boolean;
  /** 渠道（IM 推送等）回执；null = adapter 未上报（不可由 room 推断）。 */
  channel_accepted: boolean | null;
  /** 同 attempt 内的重试（复用同一 entry，旧物理结果降级进此列表）。 */
  retries?: Array<{
    ts: string;
    room_accepted: boolean;
    channel_accepted: boolean | null;
    error?: string;
  }>;
  /** 仅失败时出现（上游截断 ≤300 字符）。 */
  error?: string;
}

/** attention 单项（controller 契约字段集 + 连接器聚合补全字段）。 */
export interface AttentionItem {
  task_id: string;
  task_title?: string;
  task_status?: string;
  /** approval | decision | escalation | other */
  kind: string;
  question: string;
  attempt: number;
  requested_at: string;
  resolved: boolean;
  event_id?: string;
  options?: AttentionOption[];
  /** 推荐选项 id（NMH §8：suggested 仅提示，绝不自动选中/提交）。 */
  suggested?: string;
  expires_at?: string;
  /** 连接器补全：来源项目（聚合信封）。 */
  project_id?: string;
  /** controller payload 若带（worker 维度）。 */
  worker?: string;
  /** controller payload 若带（任务房间）；缺失时按房间名约定回退解析。 */
  room_id?: string;
  /** 连接器本地已答记录命中（UI 状态：标记已答、不计入 badge）。 */
  answered_locally?: boolean;
  // ── 解决溯源（#1394 字段：resolvedVia/resolvedBy/resolveEvidence/
  // resolvedAt + notification_log）。当前 Controller attention 端点是固定
  // 结构体不透传这些字段 → 前端不显示（诚实降级）；上游端点扩展后连接器
  // 聚合 it2=dict(it) 全透传自动生效。 ──
  /** 解决途径（tool/dashboard/im_reply/im_command/api）。 */
  resolvedVia?: string;
  /** 解决人（可选）。 */
  resolvedBy?: string;
  /** 解决证据（object；UI 折叠显示）。 */
  resolveEvidence?: Record<string, unknown>;
  /** 解决时间（UTC ISO）。 */
  resolvedAt?: string;
  /** 通知结果日志（room/channel 独立，不互推）。 */
  notification_log?: NotificationLogEntry[];
  // ── 团队视角（#1503 GET /teams/{name}/attention）扩展字段——仅
  // teamRowToAttentionItem 赋值，聚合视图缺席。overdue 服务端派生，
  // 前端只展示、绝不在本地计算。 ──
  /** 团队（行 teamId）。 */
  team_id?: string;
  /** 任务超时时刻（行 timeoutAt，UTC ISO）。 */
  timeout_at?: string;
  /** 逾期——服务端派生（pending 且 timeoutAt < now，严格小于）。 */
  overdue?: boolean;
  /** 解决结果（行 resolution：所选项 / 自由文本）。 */
  resolution?: string;
  /** 自由文本问句（行 freeform）。 */
  freeform?: string;
  /** 最新通知日志（行 notified）；null = 未发送——不得由 room 接受推断 sent。 */
  notified?: TeamAttentionNotified | null;
  /** Controller 任务详情 URL（行 url）。 */
  url?: string;
}

/** 本地已答记录（去重 + 已回答历史）。 */
export interface AttentionAnsweredRecord {
  key: string;
  task_id: string;
  kind: string;
  attempt: number;
  answer: string;
  /** 点选的结构化选项 id（自由文本回答不带；#1449）。 */
  optionId?: string;
  /** 所选选项 label（展示便利，与 optionId 配套落盘）。 */
  optionLabel?: string;
  basis?: string;
  room_id?: string;
  answered_at: string;
  event_id?: string;
  // ── 溯源（后端 join 富化自 include_resolved=1 聚合，字段同
  // AttentionItem；上游端点不透传时缺席 → UI 不显示）。 ──
  resolvedVia?: string;
  resolvedBy?: string;
  resolveEvidence?: Record<string, unknown>;
  resolvedAt?: string;
  notification_log?: NotificationLogEntry[];
}

// ── 团队视角（#1503 GET /api/v1/teams/{name}/attention）────────────────
// 行字段逐字（camelCase = controller 字段名；teamRowToAttentionItem 映射
// 到聚合视图的 snake_case AttentionItem 形状）。

/** 团队视角选项（行 options：id/label/description）。 */
export interface TeamAttentionOption {
  id: string;
  label: string;
  description?: string | null;
}

/** 团队视角行 notified 字段 = 最新通知日志单条；null = 未发送。
 * room/channel 是两条独立验收——**绝不从 room 接受推断 sent**
 * （上游契约明确；channelAccepted null = adapter 未上报）。 */
export interface TeamAttentionNotified {
  sent: boolean;
  roomAccepted: boolean;
  /** null = 渠道 adapter 未上报（不可由 room 推断）。 */
  channelAccepted: boolean | null;
  recipients?: string[] | null;
  gaps?: string[] | null;
  at?: string | null;
}

/** 团队视角行（#1503 契约行字段逐字）。 */
export interface TeamAttentionRow {
  taskId: string;
  teamId: string;
  projectId: string;
  kind: string;
  question: string;
  options?: TeamAttentionOption[] | null;
  requestedAt: string;
  timeoutAt?: string | null;
  /** 逾期——服务端派生（pending 且 timeoutAt < now，严格小于）；前端只展示。 */
  overdue: boolean;
  resolved: boolean;
  resolvedVia?: string | null;
  resolvedBy?: string | null;
  resolvedAt?: string | null;
  /** 解决结果（所选项 / 自由文本）。 */
  resolution?: string | null;
  /** 自由文本问句。 */
  freeform?: string | null;
  /** 最新通知日志；null = 未发送（不得由 room 接受推断）。 */
  notified?: TeamAttentionNotified | null;
  roomId?: string | null;
  /** Controller 任务详情 URL。 */
  url?: string | null;
}

/** fetchTeamAttention 结果（unsupported = 端点 404 未部署，非错误）。 */
export interface TeamAttentionResult {
  rows: TeamAttentionRow[];
  /** 读取失败被跳过的坏项目数（响应头 X-Attention-Skipped；缺失=0）。 */
  skipped: number;
  /** 404（controller 未部署 #1503）→ true；UI 降级回聚合视图。 */
  unsupported: boolean;
}

/** GET /attention 响应（连接器聚合层）。 */
export interface AttentionPayload {
  deployed: boolean;
  items: AttentionItem[];
  count: number;
  errors?: string[];
  cached?: boolean;
  answered_history?: AttentionAnsweredRecord[];
}

/** POST /attention/answer 请求体（字段 = NMH §8 对齐的答案面）。 */
export interface AttentionAnswerBody {
  room_id: string;
  task_id: string;
  kind: string;
  attempt: number;
  /** 有 options = option id 之一；无 = 自由文本 ≤500。 */
  answer: string;
  /** 点选的结构化选项 id（#1449；带 options 时 = 所选 option.id，
   * 自由文本不带。与 answer 并列——answer 保持 NMH §8 语义）。 */
  optionId?: string;
  /** 可选补充（答案消息第二行）。 */
  text?: string;
  /** 可选依据（写入答案消息 `basis: ...` 行）。 */
  basis?: string;
}

/** 拉取 attention 聚合（服务端自带 30s 缓存）。
 * 前端 30s 缓存（与 WorkbenchPageData 30s 轮询同节奏）；
 * refresh=true → force 回源（保留 ?refresh=1 服务端绕过，双保险）；
 * answerAttention 成功后 invalidateTags(["attention"])。
 * 失败（4xx/5xx/超时）抛错——调用方保留旧值/隐藏入口（诚实降级）。
 * 批次 4：过期再验证走条件请求（If-None-Match → 304 保旧值 / 200 带
 * 新 ETag 回写）；force（refresh=true）不发 etag。
 */
export function fetchAttention(refresh = false): Promise<AttentionPayload> {
  const q = refresh ? "?refresh=1" : "";
  return cachedRequest(
    "attention",
    30_000,
    async (etag?: string) => {
      const { payload, response } = await requestJsonConditional(
        `/agentteams-proxy/attention${q}`,
        etag,
        30000,
      );
      if (payload === NOT_MODIFIED) return NOT_MODIFIED;
      return conditionalValue(
        payload as AttentionPayload,
        response?.headers.get("etag") ?? null,
      );
    },
    { force: refresh, tags: ["attention"] },
  );
}

/** 人类身份答回（Matrix 房间 DECISION 行；后端去重 → 重复 409）。 */
export async function answerAttention(
  body: AttentionAnswerBody,
): Promise<{ ok: boolean; key?: string; event_id?: string; answered_at?: string }> {
  const r = (await requestJson(`/agentteams-proxy/attention/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })) as { ok: boolean; key?: string; event_id?: string; answered_at?: string };
  invalidateTags(["attention"]);
  return r;
}

/** 任务房间 room_id 解析：payload 自带优先；缺失时按房间名约定回退——
 * 任务房命名 `TASK：<projectId>`（teamharness create_task_room 契约，
 * 全/半角冒号容错；同 workflow.ts roomMatchesProject ③ 源）。
 * 解析不到返回 ""（UI 禁用提交并提示，不伪造房间）。 */
export function resolveAttentionRoom(item: AttentionItem): string {
  if (item.room_id) return item.room_id;
  const want = (item.project_id || "").trim();
  if (!want) return "";
  const rooms = getCachedRooms();
  if (!rooms) return "";
  const stripQ = (s: string) =>
    s.trim().replace(/^['"“”‘’\s]+|['"“”‘’\s]+$/g, "");
  for (const r of rooms.rooms || []) {
    const m = /^TASK[:：]\s*(.+)$/.exec((r.name || "").trim());
    if (m && stripQ(m[1]) === want) return r.room_id;
  }
  return "";
}

// ── 团队视角（#1503）──────────────────────────────────────────────────

/** 拉取团队级 attention 列表（#1503 契约）。
 * - 404（controller 未部署该端点）→ `{rows: [], skipped: 0, unsupported: true}`
 *   ——不抛错；调用方（NotificationCenter.PendingPanel）降级回聚合视图 + 黄条；
 * - 400（如 limit>1000）等其余错误原样抛出；
 * - 坏项目跳过数取自响应头 `X-Attention-Skipped`（缺失=0）；
 * - `overdue` 为服务端派生值，前端透传展示，绝不在本地计算。
 */
export async function fetchTeamAttention(
  team: string,
  status: "open" | "overdue" | "resolved" | "all",
  limit = 200,
): Promise<TeamAttentionResult> {
  const path =
    `/agentteams-proxy/controller/api/v1/teams/${encodeURIComponent(team)}/attention` +
    `?status=${encodeURIComponent(status)}&limit=${encodeURIComponent(String(limit))}`;
  try {
    const { payload, response } = await requestJsonFull(path, undefined, 30000);
    // 契约未固定信封：裸数组或 {rows:[...]} 都接受。
    const rows: TeamAttentionRow[] = Array.isArray(payload)
      ? (payload as TeamAttentionRow[])
      : ((payload as { rows?: TeamAttentionRow[] } | null)?.rows ?? []);
    const header = response?.headers.get("X-Attention-Skipped");
    const parsed = header ? Number.parseInt(header, 10) : 0;
    return {
      rows,
      skipped: Number.isFinite(parsed) ? parsed : 0,
      unsupported: false,
    };
  } catch (e) {
    if (httpErrorStatus(e) === 404) {
      return { rows: [], skipped: 0, unsupported: true };
    }
    throw e;
  }
}

/** 把 #1503 团队视角行映射到现有 AttentionItem 形状（snake_case，复用
 * 聚合视图的行渲染/去重约定）；团队视角专有字段进扩展字段。
 * `notified` 原样透传（null = 未发送）——**绝不从 roomAccepted 推断 sent**。 */
export function teamRowToAttentionItem(row: TeamAttentionRow): AttentionItem {
  return {
    task_id: row.taskId,
    team_id: row.teamId,
    project_id: row.projectId,
    kind: row.kind,
    question: row.question,
    // 行无 attempt 字段（聚合视图去重键约定 attempt ?? 1；0 = 无 attempt 概念）。
    attempt: 0,
    requested_at: row.requestedAt,
    resolved: row.resolved,
    options: row.options
      ? row.options.map((o) => ({
          id: o.id,
          label: o.label,
          description: o.description ?? undefined,
        }))
      : undefined,
    room_id: row.roomId ?? undefined,
    timeout_at: row.timeoutAt ?? undefined,
    overdue: row.overdue,
    resolvedVia: row.resolvedVia ?? undefined,
    resolvedBy: row.resolvedBy ?? undefined,
    resolvedAt: row.resolvedAt ?? undefined,
    resolution: row.resolution ?? undefined,
    freeform: row.freeform ?? undefined,
    notified: row.notified ?? null,
    url: row.url ?? undefined,
  };
}
