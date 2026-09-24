/**
 * A8d AgentActivityTrack（v0.5.0-beta.13.21，装验反馈「侧栏角色分组/活动轨/
 * mermaid/undo」批）：聊天 composer 上方的「当前房间项目任务进度 + HITL」
 * 内联轨。数据面=既有 workflow API（零后端）：父组件把当前房间匹配的
 * WorkflowEvent（roomMatchesProject 同源）传进来，本组件纯渲染。
 *
 * 显示语义（对齐方案 §5 A8d：~200-300 行前端零后端）：
 *  - 房间无关联项目 / 项目已终态（completed/cancelled）→ 不渲染（不占位）；
 *  - 活跃项目 → 一行头（项目名 + 状态 + 任务 done/total + 迭代 + HITL 中断
 *    琥珀 chip）+ 一行在办任务 chip（≤5，超出 +N；全完成显「N 已完成」）；
 *  - 点轨任意处 → onOpenProject(runId)（切工作流 tab 开该项目，与房间卡/
 *    工作流卡同一入口语义）。
 *
 * 状态色与 WorkflowBoard 同词汇（task-transitions.json：planned/prepared/
 * assigned/in_progress/submitted/completed/revision/blocked/cancelled；
 * 未知态回退灰，新态上线不炸 UI）。
 */
import { PulseIcon } from "./icons";
import type * as ReactNS from "react";

import { type WorkflowEvent } from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

/** 任务状态色（task-transitions 契约值）。 */
const TASK_COLOR: Record<string, string> = {
  planned: "#999",
  prepared: "#8c8c8c",
  assigned: "#1677ff",
  in_progress: "#1677ff",
  submitted: "#722ed1",
  completed: "#52c41a",
  done: "#52c41a",
  revision: "#fa8c16",
  blocked: "#fa541c",
  cancelled: "#cf1322",
  canceled: "#cf1322",
};
const OPEN_STATUSES = new Set([
  "planned",
  "prepared",
  "assigned",
  "in_progress",
  "submitted",
  "revision",
  "blocked",
]);

/** 项目（workflow run）状态 → chip 色。 */
const RUN_COLOR: Record<string, string> = {
  active: "#1677ff",
  running: "#1677ff",
  planning: "#999",
  paused: "#fa8c16",
  failed: "#ff4d4f",
  error: "#ff4d4f",
  completed: "#52c41a",
  cancelled: "#cf1322",
  canceled: "#cf1322",
};

const isTerminalRun = (s: string) =>
  ["completed", "done", "cancelled", "canceled"].includes(s);
const isDoneTask = (s: string, rs?: string) =>
  ["completed", "done"].includes(s) || ["completed", "done"].includes(rs || "");
const shortName = (mxidOrName: string): string =>
  (mxidOrName.split(":")[0] || mxidOrName).replace(/^@/, "").split("@")[0] ||
  mxidOrName;

export default function AgentActivityTrack({
  project,
  onOpenProject,
}: {
  project: WorkflowEvent | null;
  onOpenProject?: (runId: string) => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  if (!project) return null;
  const status = project.status || "";
  if (isTerminalRun(status)) return null;

  const tasks = project.taskDetails || [];
  const doneCount = tasks.filter((x) => isDoneTask(x.status || "", x.result_status)).length;
  const openTasks = tasks.filter((x) => OPEN_STATUSES.has(x.status || ""));
  const interrupts = project.interrupts || [];
  const loop = project.loop;
  const shown = openTasks.slice(0, 5);
  const extra = openTasks.length - shown.length;

  // 无任务且无中断 → 头行也显得单薄，但项目活跃本身有价值（planning 中）
  // → 恒渲染头行。
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpenProject?.(project.runId)}
      onKeyDown={(e: ReactNS.KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenProject?.(project.runId);
        }
      }}
      style={{
        display: "grid",
        gap: 4,
        padding: "6px 10px",
        border: `1px solid ${t.border}`,
        borderRadius: 8,
        background: t.popoverBg,
        cursor: "pointer",
      }}
      title={tr("点击打开项目工作流")}
    >
      {/* 头行：项目名 + 状态 + 任务进度 + 迭代 + HITL */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <PulseIcon size={13} style={{ color: RUN_COLOR[status] || "#999", flexShrink: 0 }} />
        <span style={{ fontWeight: 600, fontSize: 12, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {project.title || project.runId}
        </span>
        <antd.Tag color={RUN_COLOR[status] || "default"} style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: "18px" }}>
          {status || "?"}
        </antd.Tag>
        {tasks.length > 0 ? (
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("任务 {done}/{total}", { done: doneCount, total: tasks.length })}
          </span>
        ) : null}
        {loop && typeof loop.current_iteration === "number" ? (
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("迭代 {cur}/{max}", {
              cur: loop.current_iteration,
              max: loop.max_iterations ?? "?",
            })}
          </span>
        ) : null}
        {interrupts.length > 0 ? (
          <antd.Tag color="orange" style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: "18px" }}>
            {tr("等待人工介入（{n}）", { n: interrupts.length })}
          </antd.Tag>
        ) : null}
      </div>
      {/* 任务行：在办 chip（≤5）+ 溢出计数 / 全完成提示 */}
      {shown.length > 0 ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {shown.map((x) => (
            <span
              key={x.task_id}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11,
                padding: "1px 8px",
                border: `1px solid ${t.border}`,
                borderRadius: 10,
                maxWidth: 220,
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: TASK_COLOR[x.status || ""] || "#999",
                  flexShrink: 0,
                }}
              />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {x.summary || x.task_id}
              </span>
              {x.assigned_to ? (
                <span style={{ color: t.textSecondary, flexShrink: 0 }}>
                  {shortName(x.assigned_to)}
                </span>
              ) : null}
            </span>
          ))}
          {extra > 0 ? (
            <span style={{ fontSize: 11, color: t.textSecondary, alignSelf: "center" }}>
              {tr("+{n} 更多", { n: extra })}
            </span>
          ) : null}
        </div>
      ) : tasks.length > 0 ? (
        <div style={{ fontSize: 11, color: t.textSecondary }}>
          {tr("全部任务已完成（{n}）", { n: tasks.length })}
        </div>
      ) : null}
    </div>
  );
}
