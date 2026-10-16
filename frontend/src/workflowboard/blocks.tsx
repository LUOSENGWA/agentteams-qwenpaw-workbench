// WorkflowBoard 巨石拆分 · 事件级干预（InterventionActions）/ 中断横幅
// （InterruptsBlock）/ 循环计划块（LoopBlock）。
// 逐字自 components/WorkflowBoard.tsx 搬移；仅加 `export`。

import type * as ReactNS from "react";
import {
  type WorkflowEvent,
  type WorkflowInterrupt,
  type TaskDetail,
  pauseProject,
  resumeProject,
  completeProject,
  replanProject,
} from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import {
  PauseIcon,
  PlayIcon,
  CheckIcon,
  TodoIcon,
  WarnIcon,
  RefreshIcon,
} from "../components/icons";
import { statusMeta, replanSeedJson } from "./helpers";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

/** 事件级干预（上游已合并）：Pause / Resume / 完成 / 重规划 + interrupts 渲染。
 * 成功后回调 onDone 刷新工作流。门控语义对齐 Controller（v1.2.3 源码）：
 * active/planning 可 pause；paused interrupt（action_request.resume +
 * allow_accept）可 resume；active/planning 可 complete（上游要求全任务终态，
 * 否则 409 带原因透传）；active + dag + 无 in-progress 节点可 replan。 */
export function InterventionActions({
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
          <PauseIcon size={12} style={{ verticalAlign: "-1px", marginRight: 3 }} /> {tr("暂停")}
        </antd.Button>
      ) : null}
      {resumeInterrupt ? (
        <antd.Button
          size="small"
          type="primary"
          loading={busy === "resume"}
          onClick={() => void handleResume()}
        >
          <PlayIcon size={12} style={{ verticalAlign: "-1px", marginRight: 3 }} /> {tr("恢复")}
        </antd.Button>
      ) : null}
      {canComplete ? (
        <antd.Button
          size="small"
          loading={busy === "complete"}
          onClick={() => setCompleteOpen(true)}
          style={{ color: "#52c41a" }}
        >
          <CheckIcon size={12} style={{ verticalAlign: "-1px", marginRight: 3 }} /> {tr("完成")}
        </antd.Button>
      ) : null}
      {canReplan ? (
        <antd.Button
          size="small"
          loading={busy === "replan"}
          onClick={openReplan}
          style={{ color: "#1677ff" }}
        >
          <TodoIcon size={12} style={{ verticalAlign: "-1px", marginRight: 3 }} /> {tr("重规划")}
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

/** 中断横幅：展示 interrupts 与暂停原因（paused interrupt）。
 * （13.12 「顶上三个 ⚠ blocked 只显示 '⚠ blocked'
 * 有点突兀」）：interrupt.id 即 task_id（实盘某项目 3 条 blocked
 * interrupt id=...-03/-04/-07 与 tasks_detail task_id 一一对应）→
 * 横幅带任务短编号 + 当前状态 + 分配 Worker，可定位到具体任务。
 * 无 task 匹配（interrupt 非任务维度）→ 保持原样。 */
export function InterruptsBlock({
  interrupts,
  pauseReason,
  tasks,
}: {
  interrupts: WorkflowInterrupt[];
  pauseReason?: string;
  tasks?: TaskDetail[];
}) {
  const tr = useT();
  const t = useThemeColors(); 
  if (interrupts.length === 0) return null;
  const taskById = new Map<string, TaskDetail>();
  (tasks || []).forEach((tk) => {
    if (tk.task_id) taskById.set(tk.task_id, tk);
  });
  const shortId = (id: string) => {
    const parts = id.split("-");
    return parts.length > 1 ? parts[parts.length - 1] : id;
  };
  return (
    <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
      {interrupts.map((it) => {
        const task = taskById.get(it.id);
        const detail: string[] = [];
        if (task) {
          detail.push(tr("任务 {n}", { n: shortId(it.id) }));
          if (task.status) detail.push(task.status);
          if (task.assigned_to) detail.push(task.assigned_to);
        }
        return (
          <div
            key={it.id || it.value}
            style={{
              fontSize: 12,
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid #fa8c16",
              // 深色档：6% 橙底太淡 / 深橙字不可读 → 加浓 + 亮向
              background: t.mode === "dark" ? "rgba(250,140,22,0.14)" : "rgba(250, 140, 22, 0.06)",
              color: t.mode === "dark" ? "#faad14" : "#d46b08",
            }}
          >
            {it.value === "paused" ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <PauseIcon size={12} /> {tr("项目已暂停")}
              </span>
            ) : (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <WarnIcon size={12} /> {it.value === "blocked" ? tr("阻塞") : it.value}
              </span>
            )}
            {detail.length > 0 ? (
              <span style={{ opacity: 0.85 }}>
                {"："}
                {detail.join(" · ")}
              </span>
            ) : null}
            {it.description ? (
              <span style={{ opacity: 0.8 }}> — {it.description}</span>
            ) : null}
            {pauseReason && it.value !== "paused" ? (
              <span style={{ opacity: 0.8 }}>：{pauseReason}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Loop 计划块（plan_type=loop 项目的迭代进度/停止条件/任务图）。 */
export function LoopBlock({
  loop,
}: {
  loop: NonNullable<WorkflowEvent["loop"]>;
}) {
  const tr = useT();
  const t = useThemeColors(); 
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
        border: `1px solid ${t.border}`,
        background: t.hoverBg,
        fontSize: 12,
      }}
    >
      <div style={{ fontWeight: 700 }}>
        <RefreshIcon size={12} style={{ verticalAlign: "-1px", marginRight: 3 }} /> {tr("循环任务")}
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
            background: t.hoverBg, // 进度槽
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
