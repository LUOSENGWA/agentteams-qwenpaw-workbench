import type * as ReactNS from "react";

import {
  isWorkflowPayload,
  pauseProject,
  resumeProject,
  type WorkflowCardItem,
  type WorkflowCardPayload,
} from "../api";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

/** 状态分集（dashboard workflow-card.tsx 同款集合，交叉验证基准）。 */
const COMPLETE = new Set(["completed", "success", "done"]);
const ERROR = new Set(["failed", "error", "cancelled", "canceled"]);

function itemLabel(item: WorkflowCardItem, fallback: string): string {
  return item.title || item.name || item.id || fallback;
}

function statusLabel(
  status?: string,
  tr?: (k: string, p?: Record<string, string | number>) => string,
): string {
  if (!tr) return status || "等待中";
  if (!status) return tr("等待中");
  if (COMPLETE.has(status)) return tr("已完成");
  if (ERROR.has(status)) return tr("失败");
  if (status === "in_progress" || status === "running") return tr("进行中");
  if (status === "paused") return tr("已暂停");
  return status;
}

/** 状态色（卡片色标 + 步骤图标共用）。 */
function statusColor(status?: string): string {
  if (COMPLETE.has(status || "")) return "#52c41a";
  if (ERROR.has(status || "")) return "#ff4d4f";
  if (!status) return "#8c8c8c";
  return "#722ed1";
}

/** 项目级状态徽章（卡片头部）。 */
function ProjectStatusBadge(props: { status?: string; t: ReturnType<typeof useThemeColors> }) {
  const { status } = props;
  const tr = useT();
  const color = statusColor(status);
  return (
    <span
      style={{
        color,
        border: `1px solid ${color}55`,
        background: `${color}14`,
        borderRadius: 999,
        padding: "1px 8px",
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {statusLabel(status, tr)}
    </span>
  );
}

/** 聊天内 workflow 卡片（8/18 批次 2）。
 *
 * 事件判定 = dashboard normalize.ts 规则 1 同款（isWorkflowPayload）；
 * 干预按钮 = WorkflowBoard InterventionActions 同一函数链
 *（pauseProject(resumeProject) + 409 → 抛错 message.error，#1172 语义）；
 * 点卡片 → onOpenProject(runId)（工作流 tab 选中该项目）。
 * body 非空时卡片下方保留灰字摘要（信息不丢）。 */
export default function WorkflowCard(props: {
  payload: WorkflowCardPayload;
  body?: string;
  onOpenProject?: (runId: string) => void;
  /** 干预成功 → 刷新工作流（与 WorkflowBoard onDone 同语义）。 */
  onIntervened?: () => void;
}) {
  const { payload, body, onOpenProject, onIntervened } = props;
  const t = useThemeColors();
  const tr = useT();
  const title = payload.title || payload.name || tr("工作流");
  const runId = String(payload.runId || payload.run_id || "");
  const subagents = Array.isArray(payload.subagents) ? payload.subagents : [];
  const steps = Array.isArray(payload.steps) ? payload.steps : [];
  const completed = steps.filter((s) => COMPLETE.has(s.status || "")).length;
  // next 高亮：第一个未终态（非完成/非失败）步骤 = 当前推进位。
  const nextIndex = steps.findIndex((s) => !COMPLETE.has(s.status || "") && !ERROR.has(s.status || ""));
  const progress = steps.length ? (completed / steps.length) * 100 : 0;

  // 干预（与 WorkflowBoard InterventionActions 同链：#1172 pause body{reason}
  // /resume 空 body /409 = 状态已如此 → 后端抛错前端提示）。
  const [pauseOpen, setPauseOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState<"pause" | "resume" | null>(null);
  const canPause = runId && (payload.status === "active" || payload.status === "planning" || payload.status === "in_progress");
  const canResume = runId && payload.status === "paused";

  const handlePause = async () => {
    setBusy("pause");
    try {
      await pauseProject(runId, reason.trim() || undefined);
      antd.message.success(tr("项目已暂停"));
      setPauseOpen(false);
      setReason("");
      onIntervened?.();
    } catch (e) {
      antd.message.error(e instanceof Error ? e.message : tr("暂停失败"));
    } finally {
      setBusy(null);
    }
  };

  const handleResume = async () => {
    setBusy("resume");
    try {
      await resumeProject(runId);
      antd.message.success(tr("项目已恢复"));
      onIntervened?.();
    } catch (e) {
      antd.message.error(e instanceof Error ? e.message : tr("恢复失败"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      onClick={() => {
        if (runId) onOpenProject?.(runId);
      }}
      style={{
        border: `1px solid ${t.border}`,
        borderLeft: "4px solid #722ed1",
        borderRadius: 10,
        background: t.cardBg,
        padding: "10px 12px",
        marginTop: 4,
        cursor: runId && onOpenProject ? "pointer" : "default",
        maxWidth: 560,
        display: "grid",
        gap: 8,
      }}
      title={runId ? tr("点击查看工作流") : undefined}
    >
      {/* 头部：项目名 + 状态徽章 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 13, color: t.text, flex: 1, wordBreak: "break-word" }}>
          ⚙️ {title}
        </span>
        <ProjectStatusBadge status={payload.status} t={t} />
      </div>
      {runId ? (
        <div style={{ fontFamily: "monospace", fontSize: 10.5, color: t.textSecondary, wordBreak: "break-all" }}>
          {runId}
        </div>
      ) : null}

      {/* 参与 Worker */}
      {subagents.length > 0 ? (
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: t.textSecondary }}>
            {tr("参与 Worker")}
          </div>
          {subagents.map((a, i) => (
            <div
              key={a.id || a.name || String(i)}
              style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5 }}
            >
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: t.text }}
                title={itemLabel(a, `Worker ${i + 1}`)}>
                {itemLabel(a, `Worker ${i + 1}`)}
              </span>
              <span style={{ color: statusColor(a.status), fontSize: 10.5, whiteSpace: "nowrap" }}>
                {statusLabel(a.status, tr)}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* 执行步骤：进度条 + next 高亮 */}
      {steps.length > 0 ? (
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: t.textSecondary }}>
            <span>{tr("执行步骤")}</span>
            <span>
              {completed}/{steps.length}
            </span>
          </div>
          <div style={{ height: 6, borderRadius: 3, background: t.border, overflow: "hidden" }}>
            <div
              style={{
                width: `${progress}%`,
                height: "100%",
                background: COMPLETE.has(payload.status || "") ? "#52c41a" : ERROR.has(payload.status || "") ? "#ff4d4f" : "#722ed1",
                borderRadius: 3,
                transition: "width .3s",
              }}
            />
          </div>
          <div style={{ display: "grid", gap: 3 }}>
            {steps.map((s, i) => {
              const isNext = i === nextIndex;
              const color = statusColor(s.status);
              return (
                <div
                  key={s.id || s.name || String(i)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11.5,
                    borderRadius: 6,
                    padding: "2px 6px",
                    background: isNext ? `${PRIMARY_TINT(t)}` : "transparent",
                    border: isNext ? `1px dashed ${statusColor(s.status) || "#722ed1"}66` : "1px solid transparent",
                  }}
                  title={isNext ? tr("当前推进") : undefined}
                >
                  <span style={{ color, fontSize: 11, flexShrink: 0 }}>
                    {COMPLETE.has(s.status || "") ? "✅" : ERROR.has(s.status || "") ? "❌" : isNext ? "▶" : "○"}
                  </span>
                  <span
                    style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: t.text }}
                    title={itemLabel(s, tr("步骤 {n}", { n: i + 1 }))}
                  >
                    {itemLabel(s, tr("步骤 {n}", { n: i + 1 }))}
                  </span>
                  <span style={{ color, fontSize: 10.5, whiteSpace: "nowrap" }}>
                    {statusLabel(s.status, tr)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* 干预按钮（#1172 同链）+ body 摘要 */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {canPause ? (
          <antd.Button
            size="small"
            loading={busy === "pause"}
            onClick={(e: ReactNS.MouseEvent) => {
              e.stopPropagation();
              setPauseOpen(true);
            }}
            style={{ color: "#fa8c16" }}
          >
            ⏸ {tr("暂停")}
          </antd.Button>
        ) : null}
        {canResume ? (
          <antd.Button
            size="small"
            type="primary"
            loading={busy === "resume"}
            onClick={(e: ReactNS.MouseEvent) => {
              e.stopPropagation();
              void handleResume();
            }}
          >
            ▶ {tr("恢复")}
          </antd.Button>
        ) : null}
        {body ? (
          <span
            style={{
              flex: 1,
              minWidth: 120,
              fontSize: 11,
              color: t.textSecondary,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={body}
          >
            {body}
          </span>
        ) : null}
      </div>

      <antd.Modal
        open={pauseOpen}
        title={`${tr("暂停项目")} — ${title}`}
        okText={tr("确认暂停")}
        cancelText={tr("取消")}
        confirmLoading={busy === "pause"}
        onOk={() => void handlePause()}
        onCancel={() => setPauseOpen(false)}
        width={440}
      >
        <antd.Input.TextArea
          value={reason}
          onChange={(e: ReactNS.ChangeEvent<HTMLTextAreaElement>) => setReason(e.target.value)}
          placeholder={tr("暂停原因（可选，将通知团队）")}
          rows={3}
        />
      </antd.Modal>
    </div>
  );
}

// 主题相关的 next 高亮底色（浅 #722ed1 6%，深 #722ed1 16%）。
function PRIMARY_TINT(t: ReturnType<typeof useThemeColors>): string {
  return t.mode === "dark" ? "rgba(114,46,209,0.16)" : "rgba(114,46,209,0.06)";
}

// 供 RoomChat 判定：消息是否携带 workflow 卡片载荷。
export { isWorkflowPayload };
