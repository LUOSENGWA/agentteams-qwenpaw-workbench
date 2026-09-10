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
import { useThemeColors } from "../theme";
import { useT } from "../i18n";

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

/** DAG → 树：按 dependsOn 建子边，无父者为根。 */
function buildNodeTree(nodes: WorkflowNode[]): {
  roots: WorkflowNode[];
  childrenOf: Map<string, WorkflowNode[]>;
} {
  const childrenOf = new Map<string, WorkflowNode[]>();
  const hasParent = new Set<string>();
  for (const n of nodes) {
    for (const dep of n.dependsOn || []) {
      if (!childrenOf.has(dep)) childrenOf.set(dep, []);
      childrenOf.get(dep)!.push(n);
      if (typeof n.id === "string") hasParent.add(n.id);
    }
  }
  const roots = nodes.filter((n) => !(typeof n.id === "string" && hasParent.has(n.id)));
  return { roots, childrenOf };
}

// ── 看板视图（第四视图，8/18 批次 1）──────────────────────────────
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

/** 看板任务卡：任务名 + 项目 + 负责人 + 依赖 badge + 非终态任务取消按钮。
 *  依赖不画跨列连线（与 dashboard 一致：看板列内 badge，依赖树走拓扑视图）。
 *  取消=任务级（#1172 /tasks/{id}/cancel，reason 必填；终态任务 409 幂等收敛）。
 *  终态判定用上游归一化状态（completed/revision/blocked——blocked 含 cancelled）。 */
const TERMINAL_NODE_STATUSES = ["completed", "revision", "blocked"];

function BoardCard(props: {
  task: BoardTask;
  t: ReturnType<typeof useThemeColors>;
  onTaskDone?: () => void;
}) {
  const { task, t, onTaskDone } = props;
  const tr = useT();
  const { node } = task;
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [cancelReason, setCancelReason] = React.useState("");
  const [cancelling, setCancelling] = React.useState(false);
  const assignee =
    (typeof node.subagent === "string" && node.subagent.trim()) ||
    (typeof node.assignee === "string" && (node.assignee as string).trim()) ||
    "";
  const deps = (node.dependsOn || []).filter(Boolean);
  const taskId = typeof node.id === "string" ? node.id.trim() : "";
  const canCancel =
    taskId !== "" &&
    !TERMINAL_NODE_STATUSES.includes(String(node.status || ""));

  const handleCancel = async () => {
    const reason = cancelReason.trim();
    if (!reason) return;
    setCancelling(true);
    try {
      await cancelTask(task.runId, taskId, reason);
      antd.message.success(tr("任务已取消"));
      setCancelOpen(false);
      setCancelReason("");
      onTaskDone?.();
    } catch (e) {
      antd.message.error(
        `${tr("取消任务失败")}${e instanceof Error ? `：${e.message}` : ""}`,
      );
    } finally {
      setCancelling(false);
    }
  };

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
        }}
        title={nodeLabel(node)}
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
      <antd.Modal
        open={cancelOpen}
        title={`${tr("取消任务")} — ${nodeLabel(node)}`}
        okText={tr("确认取消")}
        cancelText={tr("返回")}
        okButtonProps={{ disabled: !cancelReason.trim() }}
        confirmLoading={cancelling}
        onOk={() => void handleCancel()}
        onCancel={() => setCancelOpen(false)}
        width={440}
      >
        <div style={{ fontSize: 12, color: "#999", marginBottom: 8, lineHeight: 1.6 }}>
          {tr("取消将写入项目任务图并通知项目群；依赖此任务的任务将保持阻塞。")}
        </div>
        <antd.Input.TextArea
          value={cancelReason}
          onChange={(e: ReactNS.ChangeEvent<HTMLTextAreaElement>) =>
            setCancelReason(e.target.value)
          }
          placeholder={tr("取消原因（必填，将通知团队）")}
          rows={3}
          maxLength={200}
        />
      </antd.Modal>
    </div>
  );
}

/** 看板四列…七列容器：状态分列 + 任务卡（列布局同 dashboard 任务看板）。 */
function BoardColumnsView(props: {
  events: WorkflowEvent[];
  t: ReturnType<typeof useThemeColors>;
  onTaskDone?: () => void;
}) {
  const { events, t, onTaskDone } = props;
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
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** 递归渲染拓扑树（竖线缩进，SpawnTree 同款连线风格）。 */
function TopoNode({
  node,
  childrenOf,
  depth,
  t,
}: {
  node: WorkflowNode;
  childrenOf: Map<string, WorkflowNode[]>;
  depth: number;
  t: ReturnType<typeof useThemeColors>;
}) {
  const kids = (typeof node.id === "string" && childrenOf.get(node.id)) || [];
  const st = statusMeta(String(node.status || ""));
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginLeft: depth * 22,
          padding: "4px 8px",
          borderRadius: 8,
          border: `1px solid ${t.border}`,
          background: t.cardBg,
          marginBottom: 6,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600 }}>{nodeLabel(node)}</span>
        {typeof node.subagent === "string" && node.subagent ? (
          <span style={{ fontSize: 11, color: t.textSecondary, fontFamily: "monospace" }}>
            @{node.subagent.split(":")[0].replace(/^@/, "")}
          </span>
        ) : null}
        <antd.Tag color={st.color} style={{ margin: 0, fontSize: 11 }}>
          {st.label}
        </antd.Tag>
        {(node.dependsOn || []).length > 0 ? (
          <span style={{ fontSize: 10, color: "#999" }}>
            ← {(node.dependsOn || []).join(", ")}
          </span>
        ) : null}
      </div>
      {kids.map((k) => (
        <TopoNode key={String(k.id || nodeLabel(k))} node={k} childrenOf={childrenOf} depth={depth + 1} t={t} />
      ))}
    </div>
  );
}

/** replan 种子：当前 DAG 节点 → 任务数组（taskId/title/assignedTo/dependsOn，
 *  省略 status——上游 normalizeReplanTasks 对已存在 taskId 继承旧状态）。
 *  仅带非空键，保持 JSON 紧凑。 */
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

/** 事件级干预（#1172）：Pause / Resume / 完成 / 重规划 + interrupts 渲染。
 *  成功后回调 onDone 刷新工作流。门控语义对齐 Controller（v1.2.3 源码）：
 *  active/planning 可 pause；paused interrupt（action_request.resume +
 *  allow_accept）可 resume；active/planning 可 complete（上游要求全任务终态，
 *  否则 409 带原因透传）；active + dag + 无 in-progress 节点可 replan。 */
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

/** 中断横幅：展示 interrupts 与暂停原因（#1172 paused interrupt）。 */
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

/** 项目干预时间线（PR #1186 history 端点；懒加载：展开时才请求）。 */
function ProjectTimeline({ projectId }: { projectId: string }) {
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
    fetchProjectHistory(projectId)
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
    fetchProjectHistorySnapshot(projectId, ts)
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
      {ev.runId ? <ProjectTimeline projectId={ev.runId} /> : null}
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
  /** 聊天 workflow 卡片点击跳转：高亮/滚动到该项目（8/18 批次 2）。 */
  highlightRunId?: string;
  /** v0.4.82: 正源状态——rooms=已降级到「只扫已加入房间」。 */
  source?: "controller" | "rooms";
  failReason?: "auth" | "not_deployed" | "error";
  /** re17: error 分支的真实上游错误（如 Controller 500 的 mc 报错）。 */
  failDetail?: string;
  /** beta.10 再版 1：视图 tab 受控（父组件记忆到大 tab 同款 ui-state）。 */
  view?: WfView;
  onViewChange?: (v: WfView) => void;
  /** beta.10 再版 1：拓扑视图选中的 runId 受控（父组件记忆）。 */
  topoRun?: string;
  onTopoRunChange?: (runId: string) => void;
}

/** 工作流页四种视图 tab（beta.10 再版 1：导出给父组件做记忆校验）。 */
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
  // beta.10 再版 1：受控——父组件（WorkbenchPage）持有记忆并下发；
  // 未传时回退内部 "list"（组件单独使用不报错）。
  const view: WfView = viewProp ?? "list";
  const setView = (v: WfView) => onViewChange?.(v);
  /** v0.4.98 再版 9：排序（用户「工作流的排序要加上时间排序」）。
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
  // v0.4.83: 空态说真话——项目已列出但 nodes 全空（create-project.sh 建的项目
  // 是 planning 状态：meta.json 只有 workers 没有任务 DAG，任务在群聊 @mention
  // 协调）。此前空态一律说"等 DAG 模式"，用户「看板和拓扑都没有信息」无从下手。
  const emptyEventCount = events.length;
  // 看板任务数（Segmented label 用）。
  const boardTaskCount = React.useMemo(
    () => boardTasksFromEvents(events).length,
    [events],
  );
  // beta.10 再版 1：受控——拓扑选中的 runId 由父组件记忆下发；失效值由
  // 下方 topoEvent 的 withNodes[0] 兜底（Select value 跟随 topoEvent）。
  const topoRun = topoRunProp ?? "";
  const setTopoRun = (runId: string) => onTopoRunChange?.(runId);

  // 聊天 workflow 卡片跳转（8/18 批次 2）：切列表视图 + 同步 topo 选中 +
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
  const topoTree = React.useMemo(
    () => (topoEvent ? buildNodeTree(topoEvent.nodes || []) : { roots: [], childrenOf: new Map() }),
    [topoEvent],
  );

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {/* v0.4.82: 正源降级横幅（不再静默）——用户「Leader 项目看不到，只有
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
        <antd.Tooltip
          title={tr("事件/卡片/看板/树状拓扑四种视图；看板列映射与 dashboard 任务看板同源（workflow API）")}
        >
          <span style={{ color: t.textSecondary, cursor: "help", fontSize: 12 }}>ⓘ</span>
        </antd.Tooltip>
        <div style={{ flex: 1 }} />
        {/* v0.4.98 再版 9：排序（时间/状态/名称）——列表/卡片/看板跟随，
            拓扑是 DAG 结构不排序。 */}
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
          options={[
            { value: "list", label: `📋 ${tr("事件")}（${events.length}）` },
            { value: "card", label: `🗂️ ${tr("卡片")}（${events.length}）` },
            { value: "board", label: `📊 ${tr("看板")}（${boardTaskCount}）` },
            { value: "topo", label: `🌳 ${tr("拓扑")}（${withNodes.length}）` },
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
                // v0.4.78：房间名未富化（用户未加入该房间）时回退显示 room_id，
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
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 12 }}>
            {sortedEvents.map((ev) => (
              <EventCard key={ev.runId} ev={ev} t={t} onIntervention={() => onRefresh?.()} />
            ))}
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
          />
        )
      ) : withNodes.length === 0 ? (
        <antd.Empty
          description={
            emptyEventCount > 0
              ? tr("已有 {n} 个项目，但任务图（nodes）全空——多为 planning 状态：项目刚建、任务在群聊 @mention 协调，未登记进 Controller 的任务 DAG", { n: emptyEventCount })
              : tr("暂无拓扑数据——Agent 以 DAG 模式（workflow_run nodes）执行任务后这里会显示依赖树")
          }
        />
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          <div>
            <antd.Select
              size="small"
              style={{ width: 320, maxWidth: "100%" }}
              value={topoEvent?.runId || ""}
              onChange={setTopoRun}
              options={withNodes.map((e) => ({
                value: e.runId,
                label: `${e.title || e.runId}（${e.nodes?.length || 0} 节点）`,
              }))}
            />
          </div>
          <div
            style={{
              padding: 12,
              borderRadius: 10,
              border: `1px solid ${t.border}`,
              overflowX: "auto",
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
                {topoTree.roots.length === 0 ? (
                  <div style={{ color: t.textSecondary, fontSize: 12 }}>
                    {tr("节点依赖成环或无根节点，无法渲染树形（请检查 nodes dependsOn）")}
                  </div>
                ) : (
                  topoTree.roots.map((n) => (
                    <TopoNode
                      key={String(n.id || nodeLabel(n))}
                      node={n}
                      childrenOf={topoTree.childrenOf}
                      depth={0}
                      t={t}
                    />
                  ))
                )}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
