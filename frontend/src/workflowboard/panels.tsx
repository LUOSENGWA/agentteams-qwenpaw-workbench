// WorkflowBoard 巨石拆分 · 面板层：任务取消 Modal（TaskCancelModal）/ 任务巡检
// Drawer（TaskInspectionDrawer）/ 单事件卡（EventCard）。
// 逐字自 components/WorkflowBoard.tsx 搬移；仅加 `export`。

import type * as ReactNS from "react";
import { type WorkflowEvent, cancelTask } from "../api";
import ArtifactLines from "../components/ArtifactLines";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { UserIcon } from "../components/icons";
import { WorkflowEventsTimeline } from "../components/WorkflowEventsTimeline";
import {
  statusMeta,
  fmtTime,
  TERMINAL_NODE_STATUSES,
  nodeLabel,
} from "./helpers";
import { InterventionActions, InterruptsBlock, LoopBlock } from "./blocks";
import { ProjectTimeline } from "./timeline";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

/** 任务级取消 Modal（dashboard TaskDetailRow CancelTaskButton 同款语义：
 * reason 必填、非终态门控、上游 409 幂等收敛）。（P3
 * 对齐）：看板卡 + 任务巡检 Drawer 共用——此前只有看板卡有取消入口，
 * 拓扑/卡片视图点开任务详情后取消功能「消失」（dashboard 任务行始终可
 * 取消）。 */
export function TaskCancelModal(props: {
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
 * 补 result_path 查看/下载（此前
 * 类型有字段、UI 不渲染）+ 任务级取消（走共享 TaskCancelModal）。 */
export function TaskInspectionDrawer(props: {
  ev: WorkflowEvent | null;
  taskId: string | null;
  onClose: () => void;
  /** 取消成功后父组件静默刷新（对齐看板卡 onTaskDone 语义）。 */
  onDone?: () => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  const { ev, taskId } = props;
  // spec/结果产物/交付物的查看/下载/预览 = 共享
  // ArtifactLines（与拓扑任务详情行同一组件——预览态随组件内聚，
  // 本 Drawer 不再自持 preview/downloading）。
  // 任务级取消——与看板卡同一门控/同一共享 Modal。
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
              {tr(meta.label)}
            </antd.Tag>
            {assignee ? (
              // worker 短名（@name，保留 @，非全 MXID）。
              <antd.Tag style={{ margin: 0, maxWidth: "100%", overflow: "hidden" }}>
                <UserIcon size={11} style={{ verticalAlign: "-1px", marginRight: 2 }} /> {assignee.split(":")[0]}
              </antd.Tag>
            ) : null}
            <span style={{ fontFamily: "monospace", fontSize: 11, color: t.textSecondary, overflowWrap: "anywhere" }}>
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
              {/* 共享 ArtifactLines（与拓扑任务详情行
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
                            {/* actor 短名（@name，非全 MXID） */}
                            {h.actor ? `（${h.actor.split(":")[0]}）` : ""}
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

/** 卡片视图：单事件卡片（title/status/summary/coordinator/steps 行）。 */
export function EventCard({
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
      <InterruptsBlock
        interrupts={ev.interrupts || []}
        pauseReason={ev.pause_reason}
        tasks={ev.taskDetails}
      />
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
