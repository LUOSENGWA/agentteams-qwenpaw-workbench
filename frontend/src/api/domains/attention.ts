// attention 决策域（/agentteams-proxy/attention*）：读聚合 + 人类身份答回。
// 数据契约 = controller GET /api/v1/projects/{id}/attention（并行任务
// attention-api）；404 = 端点未部署（旧 controller）→ 连接器返回
// deployed=false（HTTP 200），UI 诚实降级：不显示 badge/入口，不报错。
// 答 = 工作台以人类身份（Matrix 登录 token）发 DECISION 行回任务房间，
// 不写任务 meta、不改 worker。

import { requestJson, getCachedRooms } from "../shared";

/** attention 选项（NMH §8：options=结构化选项集；回答时严格回 option id）。 */
export interface AttentionOption {
  id: string;
  label: string;
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
}

/** 本地已答记录（去重 + 已回答历史）。 */
export interface AttentionAnsweredRecord {
  key: string;
  task_id: string;
  kind: string;
  attempt: number;
  answer: string;
  basis?: string;
  room_id?: string;
  answered_at: string;
  event_id?: string;
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
  /** 可选补充（答案消息第二行）。 */
  text?: string;
  /** 可选依据（写入答案消息 `basis: ...` 行）。 */
  basis?: string;
}

/** 拉取 attention 聚合（30s 服务端缓存；refresh=true 绕过）。

 失败（4xx/5xx/超时）抛错——调用方保留旧值/隐藏入口（诚实降级）。
 */
export async function fetchAttention(refresh = false): Promise<AttentionPayload> {
  const q = refresh ? "?refresh=1" : "";
  return (await requestJson(
    `/agentteams-proxy/attention${q}`,
    undefined,
    30000,
  )) as AttentionPayload;
}

/** 人类身份答回（Matrix 房间 DECISION 行；后端去重 → 重复 409）。 */
export async function answerAttention(
  body: AttentionAnswerBody,
): Promise<{ ok: boolean; key?: string; event_id?: string; answered_at?: string }> {
  return (await requestJson(`/agentteams-proxy/attention/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })) as { ok: boolean; key?: string; event_id?: string; answered_at?: string };
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
