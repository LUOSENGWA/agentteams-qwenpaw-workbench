/** HomePage 子模块——自 HomePage.tsx 纯搬移拆出
 * （行为零变化）。 */
import type { TeamRoom, WorkflowEvent, WorkerTreeTeam } from "../api";

export const PRIMARY = "var(--app-accent, #FF7F16)";
export const CARD_RADIUS = 10;

/** 发起任务候选：各团队 Leader（入口 B）+ Manager（入口 A，跨团队）。 */
export interface NewTaskTarget {
  key: string;
  label: string;
  team: string;
  mxid: string;
  /** Manager 行标「跨团队」；Leader 行空。 */
  crossTeam?: boolean;
}

/** 成员显示名：display_name 优先，否则 MXID localpart。 */
export function memberName(room: TeamRoom, mxid: string): string {
  const m = room.members?.[mxid];
  if (m?.display_name) return m.display_name;
  const lp = mxid.startsWith("@") ? mxid.slice(1).split(":")[0] : mxid;
  return lp || mxid;
}

/** 状态分组统计（与 WorkflowBoard STATUS_COLOR 口径一致）。 */
export function workflowStats(events: WorkflowEvent[]): {
  running: number;
  blocked: number;
  done: number;
} {
  let running = 0;
  let blocked = 0;
  let done = 0;
  for (const ev of events) {
    const s = String(ev.status || "").toLowerCase();
    if (s === "running" || s === "in_progress" || s === "in-progress") {
      running += 1;
    } else if (s === "blocked") {
      blocked += 1;
    } else if (s === "completed" || s === "done") {
      done += 1;
    }
  }
  return { running, blocked, done };
}

/** Worker 角色计数（领/工/审）。 */
export function workerStats(tree: WorkerTreeTeam[]): {
  leaders: number;
  workers: number;
  critics: number;
} {
  let leaders = 0;
  let workers = 0;
  let critics = 0;
  for (const team of tree) {
    for (const w of team.workers) {
      if (w.role === "leader") leaders += 1;
      else if (w.role === "critic") critics += 1;
      else if (w.role === "worker") workers += 1;
    }
  }
  return { leaders, workers, critics };
}
