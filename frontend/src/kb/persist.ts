// KB 选择记忆（QC-164 阶段 1 纯搬移；KbState 类型在 ./types）。

import type { KbState } from "./types";

/** KB 团队/Worker 选择记忆（「知识库的团队和 worker
 * 选择那里也要加记忆」，同工作流 tab 记忆惯例——localStorage 持久
 * 选中态，刷新/重装不丢）。失效值（worker/团队已不存在）回退默认。 */
const KB_STATE_KEY = "kb-state-v1";
export function loadKbState(): KbState {
  try {
    const raw = window.localStorage.getItem(KB_STATE_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw) as Record<string, unknown>;
    return {
      agent:
        typeof o?.agent === "string" && o.agent ? o.agent : undefined,
      team:
        typeof o?.team === "string" && o.team ? o.team : undefined,
      graphMode:
        o?.graphMode === "merged"
          ? "merged"
          : o?.graphMode === "agent"
            ? "agent"
            : undefined,
    };
  } catch {
    return {};
  }
}
export function saveKbState(
  agent: string,
  team: string,
  graphMode: string,
): void {
  try {
    window.localStorage.setItem(
      KB_STATE_KEY,
      JSON.stringify({ agent, team, graphMode }),
    );
  } catch {
    /* noop */
  }
}
