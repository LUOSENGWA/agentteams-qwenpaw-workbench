// WorkflowBoard 巨石拆分 · 纯叶子 helpers：状态配色 / 时间 / 节点短名 /
// 看板列映射 / replan 种子——纯函数与常量，零 React 运行时依赖。
// 函数体逐字自 components/WorkflowBoard.tsx 搬移。

import type * as ReactNS from "react";
import type { WorkflowEvent, WorkflowNode } from "../api";
import type { ThemeColors } from "../theme";
import type { DagNodeColor } from "../components/WorkflowDag";

export const PRIMARY = "var(--app-accent, #FF7F16)";

export const STATUS_COLOR: Record<string, string> = {
  running: "#1677ff",
  in_progress: "#1677ff",
  "in-progress": "#1677ff",
  completed: "#52c41a",
  done: "#52c41a",
  failed: "#ff4d4f",
  error: "#ff4d4f",
  blocked: "#fa8c16",
 // （报告顺带缺陷：cancelled 显示成
  // blocked）：cancelled 独立态——深红 #cf1322（与 failed #ff4d4f 区分：
  // 失败=执行出错，取消=人为终止，语义不同不同色）。
  cancelled: "#cf1322",
  canceled: "#cf1322",
  pending: "#999",
  merging: "#722ed1",
  created: "#999",
};

// 状态中文标签（cancelled→已取消；其余原样）。
export const STATUS_LABEL: Record<string, string> = {
  cancelled: "已取消",
  canceled: "已取消",
};

export function statusMeta(status: string): { label: string; color: string } {
  const s = status || "";
  return {
    label: STATUS_LABEL[s] || s || "?",
    color: STATUS_COLOR[s] || "#999",
  };
}

export function fmtTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

/** DAG 节点配色（主题感知；stroke 与 STATUS_COLOR 同源——看板/DAG 一致）。 */
export function dagNodeColors(t: ThemeColors): Record<string, DagNodeColor> {
  return {
    pending: { fill: "rgba(153,153,153,0.12)", stroke: "#999", text: t.text },
    assigned: { fill: "rgba(22,119,255,0.10)", stroke: "#1677ff", text: t.text },
    in_progress: { fill: "rgba(114,46,209,0.10)", stroke: "#722ed1", text: t.text },
    revision: { fill: "rgba(250,140,22,0.10)", stroke: "#fa8c16", text: t.text },
    completed: { fill: "rgba(82,196,26,0.12)", stroke: "#52c41a", text: t.text },
    failed: { fill: "rgba(255,77,79,0.12)", stroke: "#ff4d4f", text: t.text },
    blocked: { fill: "rgba(250,140,22,0.10)", stroke: "#fa8c16", text: t.text },
    // cancelled 独立节点色（深红，与 failed 区分）。
    cancelled: { fill: "rgba(207,19,34,0.10)", stroke: "#cf1322", text: t.text },
    unknown: { fill: "rgba(140,140,140,0.08)", stroke: "#8c8c8c", text: t.text },
  };
}

/** P2：详情区 section 标题样式（三区统一）。 */
export function secTitleStyle(t: ThemeColors): ReactNS.CSSProperties {
  return {
    margin: "0 0 6px",
    fontSize: 11,
    fontWeight: 600,
    color: t.textSecondary,
  };
}

/** 节点显示名：task 优先，否则 subagent/name/id。 */
/** MXID → 显示短名（命名约定：UI 正文用名字，完整 MXID 走 title 悬停）。
 `@tech-writer:example.org` → `tech-writer`。
 只认 @开头且含 : 的串（真 MXID 形态）——普通任务名不误伤。 */
export function mxidShort(s: string): string {
  const t = s.trim();
  if (!t.startsWith("@")) return t;
  const at = t.indexOf(":", 1);
  return at > 0 ? t.slice(1, at) : t.slice(1);
}

export function nodeLabel(n: WorkflowNode): string {
  const task = typeof n.task === "string" ? n.task.trim() : "";
  if (task) return task;
  const sub = typeof n.subagent === "string" ? n.subagent.trim() : "";
  if (sub) return sub;
  const name = typeof n.name === "string" ? n.name.trim() : "";
  if (name) return name;
  // 空串 id 兜底（15.14 真盘：节点 id 为空时旧逻辑返回 ""→ 卡标题行
  // 塌 0 高的诱因之一）——恒返回非空显示值。
  return typeof n.id === "string" && n.id.trim() ? n.id : "节点";
}

/** 显示用短名：nodeLabel 的值若为 MXID → 短名（title 悬停仍走原名）。 */
export function nodeLabelUi(n: WorkflowNode): string {
  return mxidShort(nodeLabel(n));
}

// ── 看板视图（第四视图）──────────────────────────────
// 状态映射与 dashboard #85 workflowStatusToTaskStatus 逐条对齐
//（联合交叉验证基准：SC/agentteams-dashboard src/hooks/use-projects.ts）。

export type BoardCol =
  | "pending"
  | "assigned"
  | "in_progress"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "unknown";

export function workflowStatusToTaskStatus(status?: string): BoardCol {
  switch (status) {
    case "pending":
    case "planned":
    case "":
      return "pending";
    case "delegated":
    case "assigned":
      return "assigned";
    case "in-progress":
    case "in_progress":
    case "submitted":
      return "in_progress";
    case "completed":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "blocked":
    case "revision":
      return "blocked";
    // cancelled 独立列（不再折入 blocked——状态映射
 // 不一致缺陷，报告）。
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return "unknown";
  }
}

/** 列配置（顺序/语义同 dashboard TASK_STATUS_COLUMNS + 已取消列）。 */
export const BOARD_COLUMNS: Array<{ key: BoardCol; zh: string; color: string }> = [
  { key: "pending", zh: "待办", color: "#64748b" },
  { key: "assigned", zh: "已派发", color: "#1677ff" },
  { key: "in_progress", zh: "进行中", color: "#722ed1" },
  { key: "completed", zh: "已完成", color: "#52c41a" },
  { key: "failed", zh: "失败", color: "#ff4d4f" },
  { key: "blocked", zh: "阻塞", color: "#fa8c16" },
  { key: "cancelled", zh: "已取消", color: "#cf1322" },
  { key: "unknown", zh: "未知", color: "#8c8c8c" },
];

export interface BoardTask {
  runId: string;
  projectTitle: string;
  projectStatus: string;
  node: WorkflowNode;
  col: BoardCol;
  /** 原节点序（列内时间排序的同项目保序键）。 */
  __seq?: number;
}

/** 事件流 nodes → 看板任务（按状态分列）。 */
export function boardTasksFromEvents(events: WorkflowEvent[]): BoardTask[] {
  const out: BoardTask[] = [];
  for (const ev of events) {
    for (const node of ev.nodes || []) {
      out.push({
        runId: ev.runId,
        projectTitle: ev.title || ev.runId,
        projectStatus: ev.status || "",
        node,
        col: workflowStatusToTaskStatus(
          typeof node.status === "string" ? node.status : undefined,
        ),
      });
    }
  }
  return out;
}

/** 终态任务判定（上游归一化状态：completed/revision/blocked/cancelled）。
 * 上移——任务巡检 Drawer 的门控也要用。
 * cancelled 升为独立终态（不再藏进 blocked）。 */
export const TERMINAL_NODE_STATUSES = ["completed", "revision", "blocked", "cancelled"];

/** 看板容器（B7，13.14 「项目看板改成两行四列，
 * 每个看板显示三个卡片，再多滚动 col，时间排序要做好」）：
 * - W≥500（横屏/平板/桌面宽屏，15.19 起含宽屏——jira 250px 横滚档退役）：
 *   两列定宽网格 minmax(0,1fr)（列=容器半宽永不压缩、整板不横滑）+
 *   每列卡区限高 min(40vh,320px)≈3 卡、超出列内纵向滚动；
 * - W<500（竖屏手机）：单列全宽纵向堆叠 + 卡行横向滑动（移动端看板交互）；
 * - 列内显式时间排序：项目活动 ts 新→旧（看板恒时间序——项目级 sortBy
 *   是列表/轨道视图语义，不应扰动看板列内顺序；旧版列内顺序=events
 *   传入序，受 sortBy 影响，「时间排序」不成立）。 */

/** replan 种子：当前 DAG 节点 → 任务数组（taskId/title/assignedTo/dependsOn，
 * 省略 status——上游 normalizeReplanTasks 对已存在 taskId 继承旧状态）。
 * 仅带非空键，保持 JSON 紧凑。 */
export function replanSeedJson(ev: WorkflowEvent): string {
  const tasks = (ev.nodes || []).map((n) => {
    const t: Record<string, unknown> = {};
    const id = typeof n.id === "string" ? n.id.trim() : "";
    if (!id) return null;
    t.taskId = id;
    if (typeof n.name === "string" && n.name.trim()) t.title = n.name;
    const who =
      (typeof n.assignee === "string" && n.assignee) ||
      (typeof n.subagent === "string" && n.subagent) ||
      "";
    if (who) t.assignedTo = who;
    if (Array.isArray(n.dependsOn) && n.dependsOn.length > 0) {
      t.dependsOn = n.dependsOn;
    }
    return t;
  }).filter(Boolean) as Record<string, unknown>[];
  return JSON.stringify(tasks, null, 2);
}
