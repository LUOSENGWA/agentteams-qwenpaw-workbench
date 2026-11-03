/**
 * 任务事件内联卡片（批次 3）：任务生命周期事件作为聊天流内联卡片。
 *
 * 数据源：现有 workflow API 事件流 fetchProjectTransitionEvents
 * （GET /controller/api/v1/projects/{id}/events）→ ProjectTransitionEvent。
 * 状态映射（task-transitions.json 契约词汇）：
 * - to=assigned  → 🚀 spawn（已派遣）
 * - to=completed → ✅ complete（完成，耗时=该任务首事件→本事件）
 * - to=cancelled → ❌ fail（失败，摘要取 note）
 * - to=blocked   → ⏱ timeout（受阻/超时，摘要取 note）
 * 未知状态不产卡（新状态上线不误报）。
 *
 * 事件在渲染序列里按 ts 与 turn 交错「插入」（不替换任何消息）。
 * 紧凑单行；点击展开详情（task_id / from→to / actor / note 全文）。
 */
import type { ProjectTransitionEvent, TaskDetail } from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";

const host = window.QwenPaw.host;
const React = host.React;

export type TaskEventKind = "spawn" | "complete" | "fail" | "timeout";

export interface TaskEvent {
  id: string;
  /** 事件时刻（毫秒）。 */
  ts: number;
  kind: TaskEventKind;
  worker: string;
  taskId: string;
  summary?: string;
  durationSec?: number;
  error?: string;
  from: string;
  to: string;
  actor?: string;
  note?: string;
}

function shortName(mxidOrName: string): string {
  return (mxidOrName || "").split(":")[0].replace(/^@/, "");
}

/** 单事件 → 卡片（未映射状态 = null，不产卡）。 */
export function transitionToTaskEvent(
  ev: ProjectTransitionEvent,
  detail?: TaskDetail,
): TaskEvent | null {
  const ts = new Date(ev.ts).getTime();
  const worker = shortName(detail?.assigned_to || ev.actor || ev.task_id || "");
  const base: Omit<TaskEvent, "kind" | "durationSec"> = {
    id: `${ev.seq != null ? `s${ev.seq}` : `t${ts}`}-${ev.task_id}-${ev.to}`,
    ts: Number.isNaN(ts) ? 0 : ts,
    worker,
    taskId: ev.task_id,
    summary: detail?.summary,
    error: ev.note,
    from: ev.from,
    to: ev.to,
    actor: ev.actor,
    note: ev.note,
  };
  if (ev.to === "assigned") return { ...base, kind: "spawn" };
  if (ev.to === "completed") return { ...base, kind: "complete" };
  if (ev.to === "cancelled") return { ...base, kind: "fail" };
  if (ev.to === "blocked") return { ...base, kind: "timeout" };
  return null;
}

/** 事件序列 → 卡片序列（时间升序；complete 卡补耗时=任务首事件→本事件）。 */
export function normalizeTaskEvents(
  events: ProjectTransitionEvent[],
  detailsByTask: Record<string, TaskDetail> = {},
): TaskEvent[] {
  const firstTs: Record<string, number> = {};
  const out: TaskEvent[] = [];
  for (const ev of events) {
    const t0 = new Date(ev.ts).getTime();
    if (ev.task_id && !(ev.task_id in firstTs) && !Number.isNaN(t0)) {
      firstTs[ev.task_id] = t0;
    }
    const card = transitionToTaskEvent(ev, detailsByTask[ev.task_id]);
    if (!card) continue;
    if (card.kind === "complete" && card.taskId in firstTs) {
      card.durationSec = Math.max(0, (card.ts - firstTs[card.taskId]) / 1000);
    }
    out.push(card);
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

const KIND_ICON: Record<TaskEventKind, string> = {
  spawn: "🚀",
  complete: "✅",
  fail: "❌",
  timeout: "⏱",
};

export function TaskEventCard({ ev }: { ev: TaskEvent }) {
  const t = useThemeColors();
  const tr = useT();
  const [open, setOpen] = React.useState(false);

  let label: string;
  if (ev.kind === "spawn") {
    label = tr("{w} 已派遣", { w: ev.worker }) +
      (ev.summary ? ` · ${ev.summary.slice(0, 60)}` : ev.taskId ? ` · ${ev.taskId}` : "");
  } else if (ev.kind === "complete") {
    label = tr("{w} 完成", { w: ev.worker }) +
      (ev.durationSec != null ? ` · ${tr("{x}s", { x: ev.durationSec.toFixed(0) })}` : "");
  } else if (ev.kind === "fail") {
    label = tr("{w} 失败", { w: ev.worker }) +
      (ev.error ? ` · ${ev.error.slice(0, 60)}` : "");
  } else {
    label = tr("{w} 超时", { w: ev.worker });
  }

  return (
    <div style={{ display: "flex", justifyContent: "flex-start", padding: "2px 6px" }}>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          cursor: "pointer",
          padding: "5px 10px",
          borderRadius: 8,
          background: t.cardBg,
          border: `1px solid ${t.border}`,
          fontSize: 12.5,
          maxWidth: 560,
          color: t.text,
          userSelect: "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 12, flexShrink: 0 }}>{KIND_ICON[ev.kind]}</span>
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {label}
          </span>
          <span style={{ color: "#bbb", fontSize: 10, flexShrink: 0, marginLeft: "auto" }}>
            {open ? "▲" : "▼"}
          </span>
        </div>
        {open ? (
          <div style={{ marginTop: 4, fontSize: 11.5, color: t.textSecondary, lineHeight: 1.7 }}>
            <div>
              {tr("任务")} <span style={{ fontFamily: "monospace" }}>{ev.taskId || "—"}</span>
              <span style={{ margin: "0 6px", color: "#bbb" }}>|</span>
              <span style={{ fontFamily: "monospace" }}>{ev.from}</span>
              <span style={{ margin: "0 3px", color: "#bbb" }}>→</span>
              <span style={{ fontFamily: "monospace" }}>{ev.to}</span>
              {ev.actor ? (
                <span style={{ marginLeft: 6 }}>by {shortName(ev.actor)}</span>
              ) : null}
              {ev.ts ? (
                <span style={{ marginLeft: 6, color: "#bbb" }}>
                  {new Date(ev.ts).toLocaleString()}
                </span>
              ) : null}
            </div>
            {ev.note ? (
              <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{ev.note}</div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
