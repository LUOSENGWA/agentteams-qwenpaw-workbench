// P0 人工介入闭环 — 「待处理」统一口径（任务书 §3 Stage 1）。
// 任何展示待处理总数的地方（顶栏 banner / 通知中心角标 / 系统通知
// 去重）都用 selectPendingTally——分项相加即 total（C-1 口径，移植
// agentteams-dashboard hitl-inbox.selectPendingTally）。纯函数，零
// 依赖，node 可直测。

import type { PendingItem, PendingResolution } from "./types";

export interface PendingTally {
  /** 干预请求（有 question，要人判断内容）。 */
  interventions: number;
  /** 审批（无 question，二态裁决）。 */
  approvals: number;
  /** 工作流中断（项目 paused / blocked，等待人工介入）。 */
  interrupts: number;
  /** 有 @我 未读的房间数（mention 类按房间去重，不按消息条数）。 */
  mentionRooms: number;
  /** 分项相加。 */
  total: number;
}

/**
 * 输入 store 原始 items + resolutions + 调用方现算的 @我 房间数，
 * 输出分项与总数。mention 项本身不进 items 计数（房间级，不进列表），
 * 由调用方从 rooms 的 unread_highlight 算出 mentionRoomCount 传入。
 */
export function selectPendingTally(
  items: PendingItem[],
  resolutions: PendingResolution[],
  mentionRoomCount: number,
): PendingTally {
  const resolved = new Set<string>();
  for (const r of resolutions) resolved.add(r.id);

  let interventions = 0;
  let approvals = 0;
  let interrupts = 0;
  for (const it of items) {
    if (resolved.has(it.id)) continue;
    if (it.kind === "intervention") interventions += 1;
    else if (it.kind === "approval") approvals += 1;
    else if (it.kind === "interrupt") interrupts += 1;
  }
  const mentionRooms = Math.max(0, mentionRoomCount);
  return {
    interventions,
    approvals,
    interrupts,
    mentionRooms,
    total: interventions + approvals + interrupts + mentionRooms,
  };
}

/** 跨源同伴：同 taskId 的其它待办项（room_message ↔ attention 双轨
 * 承载同一任务请求）。答一条时同伴一并清——同一请求不残留双份。 */
export function selectCompanionIds(
  items: PendingItem[],
  item: Pick<PendingItem, "id" | "taskId">,
): string[] {
  if (!item.taskId) return [];
  return items
    .filter((it) => it.id !== item.id && it.taskId === item.taskId)
    .map((it) => it.id);
}
