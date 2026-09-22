import type * as ReactNS from "react";

import {
  type WorkflowEvent,
  type WorkflowNode,
  type WorkflowInterrupt,
  pauseProject,
  resumeProject,
  cancelTask,
  completeProject,
  replanProject,
  fetchProjectHistory,
  fetchProjectHistorySnapshot,
} from "../api";
import ArtifactLines from "./ArtifactLines";
import { useThemeColors, type ThemeColors } from "../theme";
import { useT } from "../i18n";
import {
  WorkflowDagSvg,
  buildWorkflowDag,
  type DagNodeColor,
} from "./WorkflowDag";
import { WorkflowEventsTimeline } from "./WorkflowEventsTimeline";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
const icons = (host.antdIcons || {}) as Record<string, ReactNS.ComponentType>;
const EmptyIcon = (() => null) as unknown as ReactNS.FC<Record<string, unknown>>;
const pick = (name: string): ReactNS.FC<Record<string, unknown>> =>
  (icons[name] as ReactNS.FC<Record<string, unknown>>) || EmptyIcon;
const ReloadIcon = pick("ReloadOutlined");

const PRIMARY = "#FF7F16";
const STATUS_COLOR: Record<string, string> = {
  running: "#1677ff",
  in_progress: "#1677ff",
  "in-progress": "#1677ff",
  completed: "#52c41a",
  done: "#52c41a",
  failed: "#ff4d4f",
  error: "#ff4d4f",
  blocked: "#fa8c16",
  pending: "#999",
  merging: "#722ed1",
  created: "#999",
};

function statusMeta(status: string): { label: string; color: string } {
  return { label: status || "?", color: STATUS_COLOR[status] || "#999" };
}

function fmtTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

/** DAG 节点配色（主题感知；stroke 与 STATUS_COLOR 同源——看板/DAG 一致）。 */
function dagNodeColors(t: ThemeColors): Record<string, DagNodeColor> {
  return {
    pending: { fill: "rgba(153,153,153,0.12)", stroke: "#999", text: t.text },
    assigned: { fill: "rgba(22,119,255,0.10)", stroke: "#1677ff", text: t.text },
    in_progress: { fill: "rgba(114,46,209,0.10)", stroke: "#722ed1", text: t.text },
    revision: { fill: "rgba(250,140,22,0.10)", stroke: "#fa8c16", text: t.text },
    completed: { fill: "rgba(82,196,26,0.12)", stroke: "#52c41a", text: t.text },
    failed: { fill: "rgba(255,77,79,0.12)", stroke: "#ff4d4f", text: t.text },
    blocked: { fill: "rgba(250,140,22,0.10)", stroke: "#fa8c16", text: t.text },
    unknown: { fill: "rgba(140,140,140,0.08)", stroke: "#8c8c8c", text: t.text },
  };
}

/** 左栏项目列表（卡片/拓扑视图共用选择；排序=顶部下拉，独立滚动——
 * 对齐 dashboard 任务看板「项目」区 master-detail 结构）。 */
function ProjectRail(props: {
  events: WorkflowEvent[];
  selected: string;
  onSelect: (runId: string) => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  const { events, selected, onSelect } = props;
  if (events.length === 0) return null;
  return (
    <div
      style={{
        border: `1px solid ${t.border}`,
        borderRadius: 8,
        background: t.cardBg,
        maxHeight: "calc(100vh - 320px)",
        overflowY: "auto",
      }}
    >
      {events.map((ev) => {
        const active = ev.runId === selected;
        const meta = statusMeta(ev.status);
        const n = (ev.nodes ?? []).length;
        return (
          <div
            key={ev.runId}
            onClick={() => onSelect(ev.runId)}
            style={{
              cursor: "pointer",
              padding: "8px 12px",
              borderBottom: `1px solid ${t.border}`,
              borderLeft: active ? `3px solid ${meta.color}` : "3px solid transparent",
              background: active ? `${meta.color}14` : undefined,
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: t.text,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {ev.title}
            </div>
            <div
              style={{
                marginTop: 3,
                display: "flex",
                gap: 6,
                alignItems: "center",
                fontSize: 11,
                color: t.textSecondary,
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: meta.color,
                  display: "inline-block",
                  flexShrink: 0,
                }}
              />
              <span>{tr(meta.label)}</span>
              <span>·</span>
              <span>
                {n} {tr("任务")}
              </span>
              {ev.ts ? (
                <span style={{ marginLeft: "auto", flexShrink: 0 }}>
                  {fmtTime(ev.ts)}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 拓扑主体：分层 DAG（buildWorkflowDag → WorkflowDagSvg，dashboard
 * 同源算法）+ 外部依赖注记 + ready 图例。 */
function DagTopo(props: { ev: WorkflowEvent; t: ThemeColors }) {
  const { ev, t } = props;
  const tr = useT();
  const dag = React.useMemo(() => buildWorkflowDag(ev.nodes ?? []), [ev]);
  const colors = dagNodeColors(t);
  // P2：任务分布 = 节点按 status 计数（dashboard NODE_STATUS 分布同语义）。
  const statuses = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const n of ev.nodes ?? []) {
      const st = n.status || "unknown";
      m.set(st, (m.get(st) ?? 0) + 1);
    }
    return [...m.entries()];
  }, [ev]);
  return (
    <div>
      <div
        style={{
          overflow: "auto",
          border: `1px solid ${t.border}`,
          borderRadius: 8,
          padding: 10,
        }}
      >
        <WorkflowDagSvg
          dag={dag}
          nodeColors={colors}
          title={`${ev.title} — ${tr("项目任务依赖图")}`}
        />
      </div>
      {dag.externalDeps.length > 0 ? (
        <div style={{ marginTop: 8, fontSize: 11, color: t.textSecondary }}>
          {tr("外部依赖（非本项目）：{list}", {
            list: dag.externalDeps.join(", "),
          })}
        </div>
      ) : null}
      <div style={{ marginTop: 8, fontSize: 11, color: t.textSecondary }}>
        <span style={{ color: "#13c2c2" }}>◌</span>{" " + tr("依赖已满足（就绪，待开始）")}
      </div>
      {/* 装验反馈 9/19（P2）：拓扑详情区补 dashboard 任务详情页三区
          （任务分布 / 任务详情(N) / 节点(N)——projects-section
          WorkflowDetail 同语义；对齐要求：抄该
          实现，插件 antd 风格）。数据=ev.nodes / ev.taskDetails 既有
          通道，零新请求。 */}
      {statuses.length > 0 ? (
        <div style={{ marginTop: 10 }}>
          <p style={secTitleStyle(t)}>{tr("任务分布")}</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {statuses.map(([st, count]) => {
              const info = statusMeta(st);
              return (
                <antd.Tag
                  key={st}
                  style={{
                    margin: 0,
                    fontSize: 11,
                    borderColor: info.color,
                    color: info.color,
                    background: "transparent",
                  }}
                >
                  {info.label}: {count}
                </antd.Tag>
              );
            })}
          </div>
        </div>
      ) : null}
      {ev.taskDetails && ev.taskDetails.length > 0 ? (
        <div style={{ marginTop: 10 }}>
          <p style={secTitleStyle(t)}>
            {tr("任务详情（{n}）", { n: ev.taskDetails.length })}
          </p>
          <div style={{ display: "grid", gap: 6 }}>
            {ev.taskDetails.map((td) => (
              <TopoTaskDetailRow key={td.task_id} td={td} t={t} ev={ev} />
            ))}
          </div>
        </div>
      ) : null}
      <div style={{ marginTop: 10 }}>
        <p style={secTitleStyle(t)}>
          {tr("节点（{n}）", { n: (ev.nodes ?? []).length })}
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          {(ev.nodes ?? []).map((n) => {
            const st = n.status || "";
            const info = statusMeta(st);
            return (
              <div
                key={n.id || nodeLabel(n)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  border: `1px solid ${t.border}`,
                  borderRadius: 6,
                  padding: "6px 8px",
                  background: t.bg,
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <p
                    style={{
                      margin: 0,
                      fontSize: 12,
                      fontWeight: 500,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={nodeLabel(n)}
                  >
                    {nodeLabel(n)}
                  </p>
                  <p
                    style={{
                      margin: 0,
                      fontSize: 10,
                      fontFamily: "monospace",
                      color: t.textSecondary,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {typeof n.id === "string" ? n.id : ""}
                  </p>
                </div>
                <antd.Tag
                  style={{
                    margin: 0,
                    fontSize: 10,
                    lineHeight: "16px",
                    borderColor: info.color,
                    color: info.color,
                    background: "transparent",
                    flexShrink: 0,
                  }}
                >
                  {info.label}
                </antd.Tag>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** P2：详情区 section 标题样式（三区统一）。 */
function secTitleStyle(t: ThemeColors): ReactNS.CSSProperties {
  return {
    margin: "0 0 6px",
    fontSize: 11,
    fontWeight: 600,
    color: t.textSecondary,
  };
}

/** P2：任务详情行（dashboard TaskDetailRow 语义精简版：任务名+状态+
 *  负责人，展开显 spec/摘要/产物数/转换审计条数——完整明细走既有
 *  任务巡检 Drawer，不重复造轮子）。 */
function TopoTaskDetailRow(props: {
  td: import("../api").TaskDetail;
  t: ThemeColors;
  /** v0.5.0-beta.13.4：传 ev 供 ArtifactLines 构造产物 URL（此前缺
      runId 上下文 → 本行只有路径文本无查看/下载，装验「结果产物没解决」）。 */
  ev: WorkflowEvent;
}) {
  const { td, t, ev } = props;
  const tr = useT();
  const [open, setOpen] = React.useState(false);
  const info = statusMeta(td.status || "");
  const deliverablesList = (
    Array.isArray(td.deliverables) ? td.deliverables : []
  ).filter((d): d is string => typeof d === "string");
  const deliverables = deliverablesList.length;
  const histCount = Array.isArray(td.history) ? td.history.length : 0;
  return (
    <div
      style={{
        border: `1px solid ${t.border}`,
        borderRadius: 6,
        background: t.bg,
        cursor: "pointer",
      }}
      onClick={() => setOpen(!open)}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
        }}
      >
        <span style={{ fontSize: 10, color: t.textSecondary }}>{open ? "▾" : "▸"}</span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            fontWeight: 500,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={td.task_id}
        >
          {td.task_id}
        </span>
        {td.assigned_to ? (
          <span style={{ fontSize: 10, color: t.textSecondary, flexShrink: 0 }}>
            {td.assigned_to}
          </span>
        ) : null}
        <antd.Tag
          style={{
            margin: 0,
            fontSize: 10,
            lineHeight: "16px",
            borderColor: info.color,
            color: info.color,
            background: "transparent",
            flexShrink: 0,
          }}
        >
          {info.label}
        </antd.Tag>
      </div>
      {open ? (
        <div style={{ padding: "0 10px 8px 28px", fontSize: 11, color: t.textSecondary, lineHeight: 1.7 }}>
          {/* v0.5.0-beta.13.4：spec/结果产物/交付物 = 共享 ArtifactLines
              （monospace 路径 + 查看内联预览 + 下载），与任务巡检 Drawer
              同一组件同一行为。 */}
          <ArtifactLines
            runId={ev.runId}
            taskId={td.task_id}
            compact
            lines={[
              ...(td.spec_path ? [{ label: tr("spec"), path: td.spec_path }] : []),
              ...(td.result_path ? [{ label: tr("结果产物"), path: td.result_path }] : []),
              ...deliverablesList.map((d) => ({ label: tr("交付物"), path: d })),
            ]}
          />
          {td.summary ? (
            <div
              style={{
                overflow: "hidden",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
              }}
              title={td.summary}
            >
              {td.summary}
            </div>
          ) : null}
          <div>
            {tr("产物 {a} · 状态转换 {b}", { a: deliverables, b: histCount })}
            {td.result_status ? ` · ${tr("验收")}: ${td.result_status}` : ""}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 节点显示名：task 优先，否则 subagent/name/id。 */
function nodeLabel(n: WorkflowNode): string {
  const task = typeof n.task === "string" ? n.task.trim() : "";
  if (task) return task;
  const sub = typeof n.subagent === "string" ? n.subagent.trim() : "";
  if (sub) return sub;
  const name = typeof n.name === "string" ? n.name.trim() : "";
  if (name) return name;
  return typeof n.id === "string" ? n.id : "节点";
}



// ── 看板视图（第四视图）──────────────────────────────
// 状态映射与 dashboard #85 workflowStatusToTaskStatus 逐条对齐
//（联合交叉验证基准：SC/agentteams-dashboard src/hooks/use-projects.ts）。

type BoardCol =
  | "pending"
  | "assigned"
  | "in_progress"
  | "completed"
  | "failed"
  | "blocked"
  | "unknown";

function workflowStatusToTaskStatus(status?: string): BoardCol {
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
    case "cancelled":
    case "revision":
      return "blocked";
    default:
      return "unknown";
  }
}

/** 列配置（顺序/语义同 dashboard TASK_STATUS_COLUMNS）。 */
const BOARD_COLUMNS: Array<{ key: BoardCol; zh: string; color: string }> = [
  { key: "pending", zh: "待办", color: "#64748b" },
  { key: "assigned", zh: "已派发", color: "#1677ff" },
  { key: "in_progress", zh: "进行中", color: "#722ed1" },
  { key: "completed", zh: "已完成", color: "#52c41a" },
  { key: "failed", zh: "失败", color: "#ff4d4f" },
  { key: "blocked", zh: "阻塞", color: "#fa8c16" },
  { key: "unknown", zh: "未知", color: "#8c8c8c" },
];

interface BoardTask {
  runId: string;
  projectTitle: string;
  projectStatus: string;
  node: WorkflowNode;
  col: BoardCol;
}

/** 事件流 nodes → 看板任务（按状态分列）。 */
function boardTasksFromEvents(events: WorkflowEvent[]): BoardTask[] {
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

/** 终态任务判定（上游归一化状态：completed/revision/blocked——blocked 含
 *  cancelled）。v0.5.0-beta.13.3：上移——任务巡检 Drawer 的门控也要用。 */
const TERMINAL_NODE_STATUSES = ["completed", "revision", "blocked"];

/** 任务级取消 Modal（dashboard TaskDetailRow CancelTaskButton 同款语义：
 *  reason 必填、非终态门控、上游 409 幂等收敛）。v0.5.0-beta.13.3（P3
 *  对齐）：看板卡 + 任务巡检 Drawer 共用——此前只有看板卡有取消入口，
 *  拓扑/卡片视图点开任务详情后取消功能「消失」（dashboard 任务行始终可
 *  取消）。 */
function TaskCancelModal(props: {
  open: boolean;
  title: string;
  runId: string;
  taskId: string;
  onClose: () => void;
  onDone?: () => void;
}) {
  const tr = useT();
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const ok = async () => {
    const r = reason.trim();
    if (!r) return;
    setBusy(true);
    try {
      await cancelTask(props.runId, props.taskId, r);
      antd.message.success(tr("任务已取消"));
      setReason("");
      props.onClose();
      props.onDone?.();
    } catch (e) {
      antd.message.error(
        `${tr("取消任务失败")}${e instanceof Error ? `：${e.message}` : ""}`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <antd.Modal
      open={props.open}
      title={`${tr("取消任务")} — ${props.title}`}
      okText={tr("确认取消")}
      cancelText={tr("返回")}
      okButtonProps={{ disabled: !reason.trim() }}
      confirmLoading={busy}
      onOk={() => void ok()}
      onCancel={() => {
        setReason("");
        props.onClose();
      }}
      width={440}
    >
      <div style={{ fontSize: 12, color: "#999", marginBottom: 8, lineHeight: 1.6 }}>
        {tr("取消将写入项目任务图并通知项目群；依赖此任务的任务将保持阻塞。")}
      </div>
      <antd.Input.TextArea
        value={reason}
        onChange={(e: ReactNS.ChangeEvent<HTMLTextAreaElement>) =>
          setReason(e.target.value)
        }
        placeholder={tr("取消原因（必填，将通知团队）")}
        rows={3}
        maxLength={200}
      />
    </antd.Modal>
  );
}

/** #1230 任务巡检 Drawer：任务级明细（正源 tasks_detail 强类型 taskDetails）
 * + 依赖（nodes 反推 dependsOn）+ tracing 过滤提示。
 * 入口 = 看板/卡片视图任务卡点击。数据边界：Matrix 降级轨事件无 taskDetails
 * → 显式提示，不编造。tracing 提示语义=过滤提示（值匹配 worker entry span
 * 的 agentteams.project.id / agentteams.task.id 属性，不构造 URL）。
 * v0.5.0-beta.13.3（P3 对齐 dashboard）：补 result_path 查看/下载（此前
 * 类型有字段、UI 不渲染）+ 任务级取消（走共享 TaskCancelModal）。 */
function TaskInspectionDrawer(props: {
  ev: WorkflowEvent | null;
  taskId: string | null;
  onClose: () => void;
  /** 取消成功后父组件静默刷新（对齐看板卡 onTaskDone 语义）。 */
  onDone?: () => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  const { ev, taskId } = props;
  // v0.5.0-beta.13.4：spec/结果产物/交付物的查看/下载/预览 = 共享
  // ArtifactLines（与拓扑任务详情行同一组件——预览态随组件内聚，
  // 本 Drawer 不再自持 preview/downloading）。
  // v0.5.0-beta.13.3（P3 对齐）：任务级取消——与看板卡同一门控/同一共享 Modal。
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const open = ev !== null && taskId !== null;
  const detail =
    ev && taskId
      ? (ev.taskDetails || []).find((d) => d.task_id === taskId)
      : undefined;
  const node =
    ev && taskId ? (ev.nodes || []).find((n) => n.id === taskId) : undefined;
  const deps = (node?.dependsOn || []).filter(Boolean);
  const history = Array.isArray(detail?.history) ? detail.history : [];
  const deliverables = (
    Array.isArray(detail?.deliverables) ? detail.deliverables : []
  ).filter((d): d is string => typeof d === "string");
  const assignee =
    (typeof node?.subagent === "string" && node.subagent.trim()) ||
    detail?.assigned_to ||
    "";
  const status = String(node?.status || detail?.status || "");
  const meta = statusMeta(status);
  const canCancel =
    !!taskId && status !== "" && !TERMINAL_NODE_STATUSES.includes(status);
  return (
    <antd.Drawer
      open={open}
      onClose={props.onClose}
      width={460}
      title={node ? nodeLabel(node) : taskId || tr("任务巡检")}
    >
      {!ev || !taskId ? null : (
        <div style={{ display: "grid", gap: 12, fontSize: 12.5 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <antd.Tag color={meta.color} style={{ margin: 0 }}>
              {meta.label}
            </antd.Tag>
            {assignee ? (
              <antd.Tag style={{ margin: 0 }}>
                👤 {assignee.split(":")[0].replace(/^@/, "")}
              </antd.Tag>
            ) : null}
            <span style={{ fontFamily: "monospace", fontSize: 11, color: t.textSecondary }}>
              {taskId}
            </span>
            {canCancel ? (
              <antd.Button
                size="small"
                danger
                style={{ marginLeft: "auto" }}
                onClick={() => setCancelOpen(true)}
              >
                {tr("取消任务")}
              </antd.Button>
            ) : null}
          </div>
          {!detail ? (
            <div style={{ color: t.textSecondary, fontSize: 12 }}>
              {tr("无任务级明细——正源任务图有该任务，但 TaskMeta 未落盘（或 Matrix 降级轨无 tasks_detail）")}
            </div>
          ) : (
            <>
              {detail.summary ? (
                <div>
                  <div style={{ color: t.textSecondary, fontSize: 11, marginBottom: 3 }}>{tr("摘要")}</div>
                  <div style={{ lineHeight: 1.6 }}>{detail.summary}</div>
                </div>
              ) : null}
              {detail.result_status ? (
                <div>
                  <div style={{ color: t.textSecondary, fontSize: 11, marginBottom: 3 }}>{tr("验收结果")}</div>
                  <div>{detail.result_status}</div>
                </div>
              ) : null}
              {detail.cancel_reason ? (
                <div>
                  <div style={{ color: t.textSecondary, fontSize: 11, marginBottom: 3 }}>{tr("取消原因")}</div>
                  <div>{detail.cancel_reason}</div>
                </div>
              ) : null}
              {/* v0.5.0-beta.13.4：共享 ArtifactLines（与拓扑任务详情行
                  同一组件——monospace 路径 + 查看内联预览 + 下载）。 */}
              <ArtifactLines
                runId={ev.runId}
                taskId={taskId}
                lines={[
                  ...(detail.spec_path
                    ? [{ label: tr("任务规格"), path: detail.spec_path }]
                    : []),
                  ...(detail.result_path
                    ? [{ label: tr("结果产物"), path: detail.result_path }]
                    : []),
                  ...deliverables.map((d) => ({
                    label: tr("交付物"),
                    path: d,
                  })),
                ]}
              />
              {deps.length > 0 ? (
                <div>
                  <div style={{ color: t.textSecondary, fontSize: 11, marginBottom: 3 }}>{tr("依赖任务")}</div>
                  {deps.map((d) => (
                    <antd.Tag key={d} color="geekblue" style={{ fontFamily: "monospace", fontSize: 10.5 }}>
                      {d}
                    </antd.Tag>
                  ))}
                </div>
              ) : null}
              {history.length > 0 ? (
                <div>
                  <div style={{ color: t.textSecondary, fontSize: 11, marginBottom: 6 }}>
                    {tr("状态转换（{n}，新→旧）", { n: history.length })}
                  </div>
                  <antd.Timeline
                    items={[...history].reverse().map((h, i) => ({
                      key: h.seq ?? i,
                      children: (
                        <div style={{ fontSize: 11.5, fontFamily: "monospace", paddingBottom: 2 }}>
                          <b>{h.from || "∅"} → {h.to}</b>
                          <span style={{ color: t.textSecondary }}>
                            {" "}{h.action}
                            {h.actor ? `（${h.actor}）` : ""}
                          </span>
                          <div style={{ color: t.textSecondary, fontSize: 10.5, fontFamily: "inherit" }}>
                            {h.ts}
                            {h.note ? ` · ${h.note}` : ""}
                          </div>
                        </div>
                      ),
                    }))}
                  />
                </div>
              ) : null}
            </>
          )}
          <div>
            <div style={{ color: t.textSecondary, fontSize: 11, marginBottom: 3 }}>{tr("tracing 过滤提示")}</div>
            <antd.Typography.Text
              copyable={{ text: `agentteams.project.id=${ev.runId} · agentteams.task.id=${taskId}` }}
              style={{ fontFamily: "monospace", fontSize: 11 }}
            >
              agentteams.project.id={ev.runId} · agentteams.task.id={taskId}
            </antd.Typography.Text>
            <div style={{ color: t.textSecondary, fontSize: 10.5, marginTop: 2 }}>
              {tr("值用于匹配 worker entry span 属性（tracing 后端为部署特定，不构造 URL）")}
            </div>
          </div>
        </div>
      )}
      {ev && taskId ? (
        <TaskCancelModal
          open={cancelOpen}
          title={node ? nodeLabel(node) : taskId}
          runId={ev.runId}
          taskId={taskId}
          onClose={() => setCancelOpen(false)}
          onDone={props.onDone}
        />
      ) : null}
    </antd.Drawer>
  );
}

/** 看板任务卡：任务名 + 项目 + 负责人 + 依赖 badge + 非终态任务取消按钮。
 * 依赖不画跨列连线（与 dashboard 一致：看板列内 badge，依赖树走拓扑视图）。
 * 取消=任务级（/tasks/{id}/cancel，reason 必填；终态任务 409 幂等收敛）。
 * 终态判定用上游归一化状态（completed/revision/blocked——blocked 含 cancelled）。 */
function BoardCard(props: {
  task: BoardTask;
  t: ReturnType<typeof useThemeColors>;
  onTaskDone?: () => void;
  /** #1230：卡标题点击 → 任务巡检 Drawer（runId 显式传——看板列跨项目混排）。 */
  onOpenDetail?: (taskId: string, runId: string) => void;
}) {
  const { task, t, onTaskDone, onOpenDetail } = props;
  const tr = useT();
  const { node } = task;
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const assignee =
    (typeof node.subagent === "string" && node.subagent.trim()) ||
    (typeof node.assignee === "string" && (node.assignee as string).trim()) ||
    "";
  const deps = (node.dependsOn || []).filter(Boolean);
  const taskId = typeof node.id === "string" ? node.id.trim() : "";
  const canCancel =
    taskId !== "" &&
    !TERMINAL_NODE_STATUSES.includes(String(node.status || ""));

  return (
    <div
      style={{
        border: `1px solid ${t.border}`,
        borderRadius: 8,
        padding: "8px 10px",
        background: t.cardBg,
        display: "grid",
        gap: 4,
      }}
    >
      <div
        style={{
          fontWeight: 600,
          fontSize: 12.5,
          color: t.text,
          wordBreak: "break-word",
          cursor: taskId && onOpenDetail ? "pointer" : "default",
        }}
        title={
          taskId && onOpenDetail
            ? `${nodeLabel(node)}（点击巡检：明细/依赖/状态转换/tracing）`
            : nodeLabel(node)
        }
        onClick={
          taskId && onOpenDetail ? () => onOpenDetail(taskId, task.runId) : undefined
        }
      >
        {nodeLabel(node)}
      </div>
      <div
        style={{
          fontSize: 11.5,
          color: t.textSecondary,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={task.projectTitle}
      >
        {task.projectTitle}
      </div>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {assignee ? (
          <antd.Tag style={{ margin: 0, fontSize: 10.5 }}>
            👤 {assignee.split(":")[0].replace(/^@/, "")}
          </antd.Tag>
        ) : null}
        {deps.length > 0 ? (
          <antd.Tag
            color="geekblue"
            style={{ margin: 0, fontSize: 10.5 }}
            title={deps.join(", ")}
          >
            {tr("依赖 {n} 项", { n: deps.length })}
          </antd.Tag>
        ) : null}
        {canCancel ? (
          <antd.Tooltip title={tr("取消此任务（须填原因，不可恢复）")}>
            <antd.Button
              size="small"
              type="text"
              danger
              style={{ marginLeft: "auto", padding: "0 4px", height: 20 }}
              onClick={() => setCancelOpen(true)}
            >
              ✕
            </antd.Button>
          </antd.Tooltip>
        ) : null}
      </div>
      <TaskCancelModal
        open={cancelOpen}
        title={nodeLabel(node)}
        runId={task.runId}
        taskId={taskId}
        onClose={() => setCancelOpen(false)}
        onDone={onTaskDone}
      />
    </div>
  );
}

/** 看板四列…七列容器：状态分列 + 任务卡（列布局同 dashboard 任务看板）。 */
function BoardColumnsView(props: {
  events: WorkflowEvent[];
  t: ReturnType<typeof useThemeColors>;
  onTaskDone?: () => void;
  onOpenDetail?: (taskId: string, runId: string) => void;
}) {
  const { events, t, onTaskDone, onOpenDetail } = props;
  const tr = useT();
  const tasks = React.useMemo(() => boardTasksFromEvents(events), [events]);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(7, minmax(150px, 1fr))",
        gap: 10,
        overflowX: "auto",
        alignItems: "start",
      }}
    >
      {BOARD_COLUMNS.map((col) => {
        const colTasks = tasks.filter((tk) => tk.col === col.key);
        return (
          <div
            key={col.key}
            style={{
              border: `1px solid ${t.border}`,
              borderRadius: 10,
              background: t.cardBg,
              padding: 8,
              minWidth: 150,
              display: "grid",
              gap: 8,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontWeight: 700,
                fontSize: 12.5,
                color: col.color,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: col.color,
                  flexShrink: 0,
                }}
              />
              {tr(col.zh)}（{colTasks.length}）
            </div>
            {colTasks.map((task) => (
              <BoardCard
                key={`${task.runId}-${String(task.node.id || nodeLabel(task.node))}`}
                task={task}
                t={t}
                onTaskDone={onTaskDone}
                onOpenDetail={
                  onOpenDetail
                    ? (tid) => onOpenDetail(tid, task.runId)
                    : undefined
                }
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** replan 种子：当前 DAG 节点 → 任务数组（taskId/title/assignedTo/dependsOn，
 * 省略 status——上游 normalizeReplanTasks 对已存在 taskId 继承旧状态）。
 * 仅带非空键，保持 JSON 紧凑。 */
function replanSeedJson(ev: WorkflowEvent): string {
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

/** 事件级干预（上游已合并）：Pause / Resume / 完成 / 重规划 + interrupts 渲染。
 * 成功后回调 onDone 刷新工作流。门控语义对齐 Controller（v1.2.3 源码）：
 * active/planning 可 pause；paused interrupt（action_request.resume +
 * allow_accept）可 resume；active/planning 可 complete（上游要求全任务终态，
 * 否则 409 带原因透传）；active + dag + 无 in-progress 节点可 replan。 */
function InterventionActions({
  ev,
  onDone,
}: {
  ev: WorkflowEvent;
  onDone?: () => void;
}) {
  const tr = useT();
  const [pauseOpen, setPauseOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [completeOpen, setCompleteOpen] = React.useState(false);
  const [replanOpen, setReplanOpen] = React.useState(false);
  const [replanText, setReplanText] = React.useState("");
  const [busy, setBusy] = React.useState<
    "pause" | "resume" | "complete" | "replan" | null
  >(null);

  const resumeInterrupt = (ev.interrupts || []).find(
    (it) => it.action_request?.action === "resume" && it.config?.allow_accept,
  );
  const canPause = ev.status === "active" || ev.status === "planning";
  const canComplete = ev.status === "active" || ev.status === "planning";
  const canReplan =
    ev.status === "active" &&
    (!ev.plan_type || ev.plan_type === "dag") &&
    !((ev.nodes || []).some((n) => n.status === "in-progress"));

  const handlePause = async () => {
    setBusy("pause");
    try {
      await pauseProject(ev.runId, reason.trim() || undefined);
      antd.message.success(tr("项目已暂停"));
      setPauseOpen(false);
      setReason("");
      onDone?.();
    } catch (e) {
      antd.message.error(e instanceof Error ? e.message : tr("暂停失败"));
    } finally {
      setBusy(null);
    }
  };

  const handleResume = async () => {
    setBusy("resume");
    try {
      await resumeProject(ev.runId);
      antd.message.success(tr("项目已恢复"));
      onDone?.();
    } catch (e) {
      antd.message.error(e instanceof Error ? e.message : tr("恢复失败"));
    } finally {
      setBusy(null);
    }
  };

  const handleComplete = async () => {
    setBusy("complete");
    try {
      await completeProject(ev.runId);
      antd.message.success(tr("项目已标记完成"));
      setCompleteOpen(false);
      onDone?.();
    } catch (e) {
      antd.message.error(
        `${tr("完成失败")}${e instanceof Error ? `：${e.message}` : ""}`,
      );
    } finally {
      setBusy(null);
    }
  };

  const openReplan = () => {
    setReplanText(replanSeedJson(ev));
    setReplanOpen(true);
  };

  const handleReplan = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(replanText);
    } catch {
      antd.message.error(tr("任务 JSON 解析失败，请检查格式"));
      return;
    }
    if (!Array.isArray(parsed)) {
      antd.message.error(tr("任务必须是 JSON 数组（[{taskId, ...}]）"));
      return;
    }
    for (const [i, t] of (parsed as unknown[]).entries()) {
      const tid =
        t && typeof t === "object"
          ? (t as Record<string, unknown>).taskId
          : undefined;
      if (typeof tid !== "string" || !tid.trim()) {
        antd.message.error(tr("第 {n} 项缺少 taskId", { n: i + 1 }));
        return;
      }
    }
    setBusy("replan");
    try {
      await replanProject(ev.runId, parsed);
      antd.message.success(tr("项目已重规划"));
      setReplanOpen(false);
      onDone?.();
    } catch (e) {
      antd.message.error(
        `${tr("重规划失败")}${e instanceof Error ? `：${e.message}` : ""}`,
      );
    } finally {
      setBusy(null);
    }
  };

  if (
    !canPause &&
    !canComplete &&
    !canReplan &&
    !resumeInterrupt &&
    !(ev.interrupts || []).length
  ) {
    return null;
  }

  return (
    <>
      {canPause ? (
        <antd.Button
          size="small"
          loading={busy === "pause"}
          onClick={() => setPauseOpen(true)}
          style={{ color: "#fa8c16" }}
        >
          ⏸ {tr("暂停")}
        </antd.Button>
      ) : null}
      {resumeInterrupt ? (
        <antd.Button
          size="small"
          type="primary"
          loading={busy === "resume"}
          onClick={() => void handleResume()}
        >
          ▶ {tr("恢复")}
        </antd.Button>
      ) : null}
      {canComplete ? (
        <antd.Button
          size="small"
          loading={busy === "complete"}
          onClick={() => setCompleteOpen(true)}
          style={{ color: "#52c41a" }}
        >
          ✅ {tr("完成")}
        </antd.Button>
      ) : null}
      {canReplan ? (
        <antd.Button
          size="small"
          loading={busy === "replan"}
          onClick={openReplan}
          style={{ color: "#1677ff" }}
        >
          📋 {tr("重规划")}
        </antd.Button>
      ) : null}
      <antd.Modal
        open={pauseOpen}
        title={`${tr("暂停项目")} — ${ev.title || ev.runId}`}
        okText={tr("确认暂停")}
        cancelText={tr("取消")}
        confirmLoading={busy === "pause"}
        onOk={() => void handlePause()}
        onCancel={() => setPauseOpen(false)}
        width={440}
      >
        <antd.Input.TextArea
          value={reason}
          onChange={(e: ReactNS.ChangeEvent<HTMLTextAreaElement>) =>
            setReason(e.target.value)
          }
          placeholder={tr("暂停原因（可选，将通知团队）")}
          rows={3}
          maxLength={200}
        />
      </antd.Modal>
      <antd.Modal
        open={completeOpen}
        title={`${tr("完成项目")} — ${ev.title || ev.runId}`}
        okText={tr("确认完成")}
        cancelText={tr("取消")}
        confirmLoading={busy === "complete"}
        onOk={() => void handleComplete()}
        onCancel={() => setCompleteOpen(false)}
        width={440}
      >
        <div style={{ fontSize: 13, lineHeight: 1.7 }}>
          {tr(
            "确认将项目标记为已完成？所有任务须已终止（完成/失败/阻塞/取消），否则上游会拒绝。完成后会通知项目群。",
          )}
        </div>
      </antd.Modal>
      <antd.Modal
        open={replanOpen}
        title={`${tr("重规划项目（编辑任务 DAG）")} — ${ev.title || ev.runId}`}
        okText={tr("提交重规划")}
        cancelText={tr("取消")}
        confirmLoading={busy === "replan"}
        onOk={() => void handleReplan()}
        onCancel={() => setReplanOpen(false)}
        width={560}
      >
        <div style={{ fontSize: 12, color: "#999", marginBottom: 8, lineHeight: 1.6 }}>
          {tr(
            "已按当前任务预填（不含 status）：保留的 taskId 省略字段将继承旧值，新增任务只需 taskId（可选 title/assignedTo/dependsOn）。重规划后项目通知群内。",
          )}
        </div>
        <antd.Input.TextArea
          value={replanText}
          onChange={(e: ReactNS.ChangeEvent<HTMLTextAreaElement>) =>
            setReplanText(e.target.value)
          }
          rows={12}
          style={{ fontFamily: "monospace", fontSize: 12 }}
        />
      </antd.Modal>
    </>
  );
}

/** 中断横幅：展示 interrupts 与暂停原因（paused interrupt）。 */
function InterruptsBlock({
  interrupts,
  pauseReason,
}: {
  interrupts: WorkflowInterrupt[];
  pauseReason?: string;
}) {
  const tr = useT();
  if (interrupts.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
      {interrupts.map((it) => (
        <div
          key={it.id || it.value}
          style={{
            fontSize: 12,
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid #fa8c16",
            background: "rgba(250, 140, 22, 0.06)",
            color: "#d46b08",
          }}
        >
          {it.value === "paused" ? `⏸ ${tr("项目已暂停")}` : `⚠ ${it.value}`}
          {it.description ? (
            <span style={{ opacity: 0.8 }}> — {it.description}</span>
          ) : null}
          {pauseReason && it.value !== "paused" ? (
            <span style={{ opacity: 0.8 }}>：{pauseReason}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** Loop 计划块（plan_type=loop 项目的迭代进度/停止条件/任务图）。 */
function LoopBlock({
  loop,
}: {
  loop: NonNullable<WorkflowEvent["loop"]>;
}) {
  const tr = useT();
  const cur = typeof loop.current_iteration === "number" ? loop.current_iteration : 0;
  const max = typeof loop.max_iterations === "number" ? loop.max_iterations : 0;
  const pct = max > 0 ? Math.min(100, Math.round((cur / max) * 100)) : 0;
  return (
    <div
      style={{
        display: "grid",
        gap: 6,
        marginTop: 8,
        padding: "8px 10px",
        borderRadius: 8,
        border: "1px solid #d9d9d9",
        background: "rgba(0,0,0,0.02)",
        fontSize: 12,
      }}
    >
      <div style={{ fontWeight: 700 }}>
        🔁 {tr("循环任务")}
        {loop.status ? (
          <span style={{ marginLeft: 8, fontWeight: 400, opacity: 0.7 }}>
            {loop.status}
          </span>
        ) : null}
        {max > 0 ? (
          <span style={{ float: "right", fontWeight: 400, opacity: 0.7 }}>
            {cur}/{max}
          </span>
        ) : null}
      </div>
      {max > 0 ? (
        <div
          style={{
            height: 6,
            borderRadius: 3,
            background: "rgba(0,0,0,0.06)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${pct}%`,
              background: "#722ed1",
              borderRadius: 3,
            }}
          />
        </div>
      ) : null}
      {loop.goal ? (
        <div style={{ opacity: 0.8 }}>目标：{loop.goal}</div>
      ) : null}
      {loop.stop_condition ? (
        <div style={{ opacity: 0.7 }}>停止条件：{loop.stop_condition}</div>
      ) : null}
      {(loop.tasks || []).length > 0 ? (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {(loop.tasks || []).map((t, i) => {
            const st = statusMeta(String(t.status || ""));
            return (
              <antd.Tag key={t.task_id || i} color={st.color} style={{ margin: 0, fontSize: 11 }}>
                {t.title || t.task_id || `步骤 ${i + 1}`}
              </antd.Tag>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** 项目干预时间线（history 端点；懒加载：展开时才请求）。
 * teamId 透传 ?team=——跨团队重名项目裸 id 409（同 /workflow 契约）。 */
function ProjectTimeline({ projectId, teamId }: { projectId: string; teamId?: string }) {
  const tr = useT();
  const [open, setOpen] = React.useState(false);
  const [state, setState] = React.useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ok"; snapshots: { timestamp: string }[] }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [detail, setDetail] = React.useState<Record<string, unknown> | null>(
    null,
  );

  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    setState({ kind: "loading" });
    fetchProjectHistory(projectId, teamId)
      .then((resp) => {
        if (alive) setState({ kind: "ok", snapshots: resp.snapshots });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const msg = e instanceof Error ? e.message : String(e);
        setState({ kind: "error", message: msg });
      });
    return () => {
      alive = false;
    };
  }, [open, projectId]);

  const openDetail = (ts: string) => {
    fetchProjectHistorySnapshot(projectId, ts, teamId)
      .then((raw) => setDetail(raw))
      .catch(() => setDetail(null));
  };

  return (
    <div style={{ marginTop: 8, fontSize: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          cursor: "pointer",
          fontWeight: 600,
        }}
        onClick={() => setOpen((v) => !v)}
      >
        <span style={{ fontSize: 11, color: "#888" }}>
          {open ? "▾" : "▸"}
        </span>
        <span>📜 {tr("时间线")}</span>
        {state.kind === "ok" && state.snapshots.length > 0 ? (
          <antd.Badge
            count={state.snapshots.length}
            size="small"
            style={{ backgroundColor: "#8c8c8c", marginLeft: 4 }}
          />
        ) : null}
      </div>
      {open ? (
        <div style={{ marginTop: 6, paddingLeft: 16, display: "grid", gap: 4 }}>
          {state.kind === "loading" ? (
            <span style={{ color: "#999" }}>{tr("加载中…")}</span>
          ) : null}
          {state.kind === "error" ? (
            <span style={{ color: "#999" }}>
              {state.message.includes("not found") ||
              /HTTP 404/.test(state.message)
                ? tr("Controller 升级后自动生效")
                : `${tr("时间线加载失败")}：${state.message}`}
            </span>
          ) : null}
          {state.kind === "ok" && state.snapshots.length === 0 ? (
            <span style={{ color: "#999" }}>{tr("暂无干预记录")}</span>
          ) : null}
          {state.kind === "ok"
            ? state.snapshots.map((s) => (
                <div
                  key={s.timestamp}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    cursor: "pointer",
                    color: "#666",
                  }}
                  onClick={() => openDetail(s.timestamp)}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: "#bbb",
                      flexShrink: 0,
                    }}
                  />
                  <span>
                    {fmtTime(Number(s.timestamp) / 1e6)}
                    <span style={{ color: "#aaa", marginLeft: 6 }}>
                      {s.timestamp.slice(0, 10)}…
                    </span>
                  </span>
                </div>
              ))
            : null}
        </div>
      ) : null}
      <antd.Drawer
        title={tr("干预前快照")}
        open={detail !== null}
        onClose={() => setDetail(null)}
        width={420}
      >
        {detail ? (
          <SnapshotDetail raw={detail} />
        ) : (
          <span style={{ color: "#999" }}>{tr("快照加载失败")}</span>
        )}
      </antd.Drawer>
    </div>
  );
}

/** 单份快照关键字段展示（raw meta JSON）。 */
function SnapshotDetail({ raw }: { raw: Record<string, unknown> }) {
  const tr = useT();
  const rows: [string, unknown][] = [
    [tr("状态"), raw.status],
    [tr("标题"), raw.title],
    [tr("操作人"), raw.updated_by],
    [tr("操作时间"), raw.updated_at],
    [tr("暂停原因"), raw.pause_reason],
  ];
  const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  return (
    <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
      {rows.map(([label, value]) =>
        value === undefined || value === null || value === "" ? null : (
          <div key={label}>
            <div style={{ color: "#999", fontSize: 12 }}>{label}</div>
            <div>{String(value)}</div>
          </div>
        ),
      )}
      <div>
        <div style={{ color: "#999", fontSize: 12 }}>
          {tr("任务数")}
        </div>
        <div>{tasks.length}</div>
      </div>
    </div>
  );
}

/** 卡片视图：单事件卡片（title/status/summary/coordinator/steps 行）。 */
function EventCard({
  ev,
  t,
  onIntervention,
}: {
  ev: WorkflowEvent;
  t: ReturnType<typeof useThemeColors>;
  onIntervention?: () => void;
}) {
  const tr = useT();
  const st = statusMeta(ev.status);
  const steps = (ev.steps || []).slice(0, 8);
  return (
    <antd.Card
      size="small"
      style={{ borderRadius: 10 }}
      title={
        <span>
          {ev.title || tr("未命名任务")}
          <antd.Tag color={st.color} style={{ marginLeft: 8 }}>
            {st.label}
          </antd.Tag>
        </span>
      }
      extra={
        <span style={{ fontSize: 12, color: t.textSecondary }}>
          {fmtTime(ev.ts)}
        </span>
      }
    >
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          marginBottom: 8,
        }}
      >
        <InterventionActions ev={ev} onDone={onIntervention} />
      </div>
      <InterruptsBlock interrupts={ev.interrupts || []} pauseReason={ev.pause_reason} />
      {ev.loop ? <LoopBlock loop={ev.loop} /> : null}
      {ev.runId ? <ProjectTimeline projectId={ev.runId} teamId={ev.team_id} /> : null}
      {/* 任务状态转换事件流（#1233 events 端点）——与干预时间线并列。 */}
      {ev.runId ? <WorkflowEventsTimeline projectId={ev.runId} teamId={ev.team_id} /> : null}
      {ev.summary ? (
        <div
          style={{
            fontSize: 13,
            color: t.textSecondary,
            marginBottom: 8,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={ev.summary}
        >
          {ev.summary}
        </div>
      ) : null}
      {ev.coordinator ? (
        <div style={{ fontSize: 12, color: t.textSecondary, marginBottom: 4 }}>
          协调者：{ev.coordinator.split(":")[0].replace(/^@/, "")}
        </div>
      ) : null}
      {steps.length > 0 ? (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {steps.map((s, i) => {
            const row = typeof s === "string" ? { name: s } : (s as Record<string, unknown>);
            const name = String(row.name || row.id || `步骤 ${i + 1}`);
            const stt = statusMeta(String(row.status || ""));
            return (
              <antd.Tag key={i} color={stt.color} style={{ margin: 0, fontSize: 11 }}>
                {name}
              </antd.Tag>
            );
          })}
        </div>
      ) : null}
    </antd.Card>
  );
}

export interface WorkflowBoardProps {
  events: WorkflowEvent[]; // 由父组件通过 api.ts fetchWorkflowEvents 获取
  loading?: boolean;
  onRefresh?: () => void;
  /** 聊天 workflow 卡片点击跳转：高亮/滚动到该项目。 */
  highlightRunId?: string;
  /** v0.5.0-beta.12: 正源状态——rooms=已降级到「只扫已加入房间」。 */
  source?: "controller" | "rooms";
  failReason?: "auth" | "not_deployed" | "error";
  /** error 分支的真实上游错误（如 Controller 500 的 mc 报错）。 */
  failDetail?: string;
  /** v0.5.0-beta.12 ：视图 tab 受控（父组件记忆到大 tab 同款 ui-state）。 */
  view?: WfView;
  onViewChange?: (v: WfView) => void;
  /** v0.5.0-beta.12 ：拓扑视图选中的 runId 受控（父组件记忆）。 */
  topoRun?: string;
  onTopoRunChange?: (runId: string) => void;
}

/** 工作流页四种视图 tab（v0.5.0-beta.12 ：导出给父组件做记忆校验）。 */
export type WfView = "list" | "card" | "board" | "topo";

export default function WorkflowBoard(props: WorkflowBoardProps) {
  const {
    events,
    loading,
    onRefresh,
    highlightRunId,
    source,
    failReason,
    failDetail,
    view: viewProp,
    onViewChange,
    topoRun: topoRunProp,
    onTopoRunChange,
  } = props;
  const t = useThemeColors();
  const tr = useT();
  // v0.5.0-beta.12 ：受控——父组件（WorkbenchPage）持有记忆并下发；
  // 未传时回退内部 "list"（组件单独使用不报错）。
  const view: WfView = viewProp ?? "list";
  const setView = (v: WfView) => onViewChange?.(v);
  /** v0.5.0-beta.12 ：排序（用户「工作流的排序要加上时间排序」）。
   * 默认时间新→旧（与聊天列表一致）；ts 数据源=api.ts projectActivityTs
   * 多源富化（此前恒 0——上游列表端点无时间戳字段）。 */
  const [sortBy, setSortBy] = React.useState<
    "time_desc" | "time_asc" | "status" | "name"
  >("time_desc");
  const sortedEvents = React.useMemo(() => {
    const arr = [...events];
    const rank: Record<string, number> = {
      failed: 0,
      paused: 1,
      active: 2,
      planning: 3,
      completed: 4,
      unknown: 5,
    };
    switch (sortBy) {
      case "time_asc":
        arr.sort((a, b) => (a.ts || 0) - (b.ts || 0));
        break;
      case "status":
        arr.sort(
          (a, b) =>
            (rank[a.status] ?? 9) - (rank[b.status] ?? 9) ||
            (b.ts || 0) - (a.ts || 0),
        );
        break;
      case "name":
        arr.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
        break;
      default:
        arr.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    }
    return arr;
  }, [events, sortBy]);
  // 拓扑视图：选一个有 nodes 的 runId。
  const withNodes = events.filter((e) => (e.nodes || []).length > 0);
  // v0.5.0-beta.12: 空态说真话——项目已列出但 nodes 全空（create-project.sh 建的项目
  // 是 planning 状态：meta.json 只有 workers 没有任务 DAG，任务在群聊 @mention
  // 协调）。此前空态一律说"等 DAG 模式"，用户「看板和拓扑都没有信息」无从下手。
  const emptyEventCount = events.length;
  // 看板任务数（Segmented label 用）。
  const boardTaskCount = React.useMemo(
    () => boardTasksFromEvents(events).length,
    [events],
  );
  // v0.5.0-beta.12 ：受控——拓扑选中的 runId 由父组件记忆下发；失效值由
  // 下方 topoEvent 的 withNodes[0] 兜底（Select value 跟随 topoEvent）。
  const topoRun = topoRunProp ?? "";
  const setTopoRun = (runId: string) => onTopoRunChange?.(runId);

  // 聊天 workflow 卡片跳转：切列表视图 + 同步 topo 选中 +
  // 滚动高亮行。
  React.useEffect(() => {
    if (!highlightRunId) return;
    setView("list");
    setTopoRun(highlightRunId);
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-run-id="${CSS.escape(highlightRunId)}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightRunId, onViewChange, onTopoRunChange]);

  const topoEvent = events.find((e) => e.runId === topoRun) || withNodes[0] || null;
  // 卡片视图：选中项目的任务卡（复用看板 BoardCard——状态/取消同一条路）。
  const cardTasks = React.useMemo(
    () => (topoEvent ? boardTasksFromEvents([topoEvent]) : []),
    [topoEvent],
  );
  // #1230 任务巡检：任务卡点击 → Drawer（runId+taskId 双键定位；
  // 事件被刷新剔除时 find 落 null → Drawer 自动空态关闭语义由 open 判空覆盖）。
  const [inspect, setInspect] = React.useState<{
    runId: string;
    taskId: string;
  } | null>(null);
  const inspectEv = inspect
    ? events.find((e) => e.runId === inspect.runId) || null
    : null;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {/* v0.5.0-beta.12: 正源降级横幅（不再静默）——用户「Leader 项目看不到，只有
          Manager 的」= 正源 401 静默回退、只剩自己已加入房间的 Matrix 扫描。 */}
      {source === "rooms" ? (
        <div
          style={{
            background: `${PRIMARY}14`,
            border: `1px solid ${PRIMARY}55`,
            borderRadius: 8,
            padding: "8px 12px",
            fontSize: 12,
            color: t.text,
          }}
        >
          ⚠️ {tr("当前只显示你已加入房间的项目")}
          {failReason === "auth"
            ? tr("——Controller 正源未接通（token 未配置或无效）。配置页填入 controller_token（L1）后可查看全部项目（含 Leader 创建、你不在其房间内的）")
            : failReason === "not_deployed"
              ? tr("——Controller 未升级到含 workflow API 的版本（404）")
              : (
                <>
                  {tr("——Controller 正源不可用")}
                  {failDetail ? (
                    <span style={{ color: t.textSecondary }}>
                      （{failDetail.slice(0, 160)}）
                    </span>
                  ) : null}
                </>
              )}
        </div>
      ) : null}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, fontSize: 15 }}>🔀 {tr("工作流")}</span>
        <span style={{ fontSize: 12.5, color: t.textSecondary }}>
          {tr("项目")}（{events.length}）
        </span>
        <antd.Tooltip
          title={tr("项目列表/项目卡片/看板/DAG 拓扑四种视图；项目卡片与拓扑为左侧项目列表+右侧详情（对齐 dashboard 任务看板「项目」区）；看板列映射与 dashboard 同源（workflow API）")}
        >
          <span style={{ color: t.textSecondary, cursor: "help", fontSize: 12 }}>ⓘ</span>
        </antd.Tooltip>
        <div style={{ flex: 1 }} />
        {/* v0.5.0-beta.12 ：排序（时间/状态/名称）——列表/看板跟随；
            卡片/拓扑的左栏项目列表跟随（DAG 内部结构不排序）。 */}
        <antd.Select
          size="small"
          value={sortBy}
          onChange={(v: "time_desc" | "time_asc" | "status" | "name") =>
            setSortBy(v)
          }
          style={{ width: 128 }}
          options={[
            { value: "time_desc", label: tr("时间 新→旧") },
            { value: "time_asc", label: tr("时间 旧→新") },
            { value: "status", label: tr("按状态") },
            { value: "name", label: tr("名称 A→Z") },
          ]}
        />
        <antd.Segmented
          size="small"
          value={view}
          onChange={(v: ReactNS.Key | number) =>
            setView(v as "list" | "card" | "board" | "topo")
          }
          // 装验反馈 9/19（P3）：看板/拓扑视图 tab 计数取消——
          // 页头「项目 (N)」已给总量，视图 tab 上的计数冗余。
          options={[
            { value: "list", label: `📋 ${tr("项目列表")}` },
            { value: "card", label: `🗂️ ${tr("项目卡片")}` },
            { value: "board", label: `📊 ${tr("看板")}` },
            { value: "topo", label: `🌳 ${tr("拓扑")}` },
          ]}
        />
        <antd.Tooltip title="刷新">
          <antd.Button
            type="text"
            size="small"
            icon={<ReloadIcon />}
            loading={loading}
            onClick={() => onRefresh?.()}
          />
        </antd.Tooltip>
      </div>

      {view === "list" ? (
        events.length === 0 ? (
          <antd.Empty description={tr("暂无工作流事件——Agent 执行任务时会在这里聚合")} />
        ) : (
          <antd.Table
            rowKey={(r: WorkflowEvent) => r.runId}
            size="small"
            pagination={false}
            dataSource={sortedEvents}
            rowClassName={(ev: WorkflowEvent) =>
              ev.runId === highlightRunId ? "atw-highlight-row" : ""
            }
            onRow={(ev: WorkflowEvent) => ({
              "data-run-id": ev.runId,
              style:
                ev.runId === highlightRunId
                  ? { outline: "2px solid #FF7F16", outlineOffset: -2, borderRadius: 6 }
                  : undefined,
            })}
            columns={[
              {
                title: tr("任务"),
                dataIndex: "title",
                render: (_: unknown, ev: WorkflowEvent) => <b>{ev.title || ev.runId}</b>,
              },
              {
                title: tr("状态"),
                dataIndex: "status",
                width: 110,
                render: (v: string) => (
                  <antd.Tag color={statusMeta(v).color} style={{ margin: 0 }}>
                    {statusMeta(v).label}
                  </antd.Tag>
                ),
              },
              {
                title: tr("协调者"),
                dataIndex: "coordinator",
                width: 130,
                render: (v: string) => (v || "").split(":")[0].replace(/^@/, ""),
              },
              {
                title: tr("步骤"),
                dataIndex: "steps",
                width: 90,
                render: (v: unknown[]) => (v || []).length,
              },
              {
                title: tr("来源房间"),
                dataIndex: "room_name",
                width: 150,
                ellipsis: true,
                // v0.5.0-beta.12：房间名未富化（用户未加入该房间）时回退显示 room_id，
                // 与 dashboard tasks 栏 shortId(roomId) 行为对齐。
                render: (v: string, ev: WorkflowEvent) => v || ev.room_id || "",
              },
              {
                title: tr("时间"),
                dataIndex: "ts",
                width: 120,
                render: (v: number) => fmtTime(v),
              },
              {
                title: tr("操作"),
                key: "actions",
                width: 150,
                render: (_: unknown, ev: WorkflowEvent) => (
                  <InterventionActions ev={ev} onDone={() => onRefresh?.()} />
                ),
              },
            ]}
          />
        )
      ) : view === "card" ? (
        events.length === 0 ? (
          <antd.Empty description={tr("暂无工作流事件")} />
        ) : (
          /* master-detail：左=项目列表（排序/独立滚动），右=选中项目详情
             （EventCard + 任务卡网格）——对齐 dashboard 任务看板「项目」区。 */
          <div style={{ display: "grid", gridTemplateColumns: "320px minmax(0, 1fr)", gap: 12, alignItems: "start" }}>
            <ProjectRail events={sortedEvents} selected={topoEvent?.runId ?? ""} onSelect={setTopoRun} />
            <div style={{ minWidth: 0 }}>
              {topoEvent ? (
                <div>
                  <EventCard ev={topoEvent} t={t} onIntervention={() => onRefresh?.()} />
                  {cardTasks.length > 0 ? (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 10, marginTop: 12 }}>
                      {cardTasks.map((task, i) => (
                        <BoardCard
                          key={`${task.node.id ?? i}`}
                          task={task}
                          t={t}
                          onTaskDone={() => onRefresh?.()}
                          onOpenDetail={(tid) =>
                            setInspect({ runId: topoEvent.runId, taskId: tid })
                          }
                        />
                      ))}
                    </div>
                  ) : (
                    <div style={{ marginTop: 12, fontSize: 12, color: t.textSecondary, padding: "14px 12px", border: `1px dashed ${t.border}`, borderRadius: 8 }}>
                      {tr("暂无任务——项目可能还在 planning（Coordinator 起草计划中），任务登记后会显示任务卡")}
                    </div>
                  )}
                </div>
              ) : (
                <antd.Empty description={tr("请选择左侧项目")} />
              )}
            </div>
          </div>
        )
      ) : view === "board" ? (
        boardTaskCount === 0 ? (
          <antd.Empty
            description={
              emptyEventCount > 0
                ? tr("已有 {n} 个项目，但任务图（nodes）全空——多为 planning 状态：项目刚建、任务在群聊 @mention 协调，未登记进 Controller 的任务 DAG", { n: emptyEventCount })
                : tr("暂无看板数据——Agent 以 DAG 模式（workflow_run nodes）执行任务后这里会显示任务看板")
            }
          />
        ) : (
          <BoardColumnsView
            events={sortedEvents}
            t={t}
            onTaskDone={() => onRefresh?.()}
            onOpenDetail={(tid, rid) => setInspect({ runId: rid, taskId: tid })}
          />
        )
      ) : (
        /* master-detail：左=项目列表（含 planning 项目，诚实空态），右=
           分层 DAG（WorkflowDagSvg，dashboard 同源算法）+ 干预/中断/loop。 */
        <div style={{ display: "grid", gridTemplateColumns: "320px minmax(0, 1fr)", gap: 12, alignItems: "start" }}>
          <ProjectRail events={sortedEvents} selected={topoEvent?.runId ?? ""} onSelect={setTopoRun} />
          <div
            style={{
              minWidth: 0,
              padding: 12,
              borderRadius: 10,
              border: `1px solid ${t.border}`,
              maxHeight: "calc(100vh - 300px)",
              overflow: "auto",
            }}
          >
            {topoEvent ? (
              <div>
                <div
                  style={{
                    fontWeight: 700,
                    marginBottom: 10,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  {topoEvent.title || topoEvent.runId}
                  <antd.Tag
                    color={statusMeta(topoEvent.status).color}
                    style={{ margin: 0 }}
                  >
                    {statusMeta(topoEvent.status).label}
                  </antd.Tag>
                  <InterventionActions ev={topoEvent} onDone={() => onRefresh?.()} />
                </div>
                <InterruptsBlock
                  interrupts={topoEvent.interrupts || []}
                  pauseReason={topoEvent.pause_reason}
                />
                {topoEvent.loop ? <LoopBlock loop={topoEvent.loop} /> : null}
                {(topoEvent.nodes || []).length > 0 ? (
                  <DagTopo ev={topoEvent} t={t} />
                ) : (
                  <div style={{ color: t.textSecondary, fontSize: 12 }}>
                    {tr("暂无拓扑数据——本项目可能还在 planning（Coordinator 起草计划中），计划生成后请重试")}
                  </div>
                )}
                {/* 任务状态转换事件流（#1233 events 端点）——拓扑详情补时间线维度
                    （装验反馈 P1「拓扑不够详细」：DAG 只讲结构，事件流讲过程）。 */}
                <WorkflowEventsTimeline projectId={topoEvent.runId} teamId={topoEvent.team_id} />
              </div>
            ) : (
              <antd.Empty description={tr("请选择左侧项目")} />
            )}
          </div>
        </div>
      )}
      {/* #1230 任务巡检 Drawer（看板/卡片任务卡点击） */}
      <TaskInspectionDrawer
        ev={inspectEv}
        taskId={inspect?.taskId ?? null}
        onClose={() => setInspect(null)}
        onDone={() => onRefresh?.()}
      />
    </div>
  );
}
