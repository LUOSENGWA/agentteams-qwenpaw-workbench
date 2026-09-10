/**
 * AgentTeams 审批卡片（宿主 chat.approval.render 定制渲染）。
 *
 * 覆盖 QwenPaw 原生审批卡（sourceType="driver_policy" 工具审批主来源）：
 * 中文文案 + severity 颜色 + 批准/拒绝动作（POST /approval/approve|deny，
 * 同原生 handleApprove 链路）→ onResolved 关闭卡片。
 */
import type * as ReactNS from "react";

import { useThemeColors } from "../theme";
import { useT } from "../i18n";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export interface ApprovalPayload {
  requestId: string;
  sessionId: string;
  rootSessionId?: string;
  agentId: string;
  toolName: string;
  severity: string;
  findingsCount: number;
  findingsSummary: string;
  toolParams: Record<string, unknown>;
  createdAt: number;
  timeoutSeconds: number;
  sourceType: string;
  reasoning?: string;
}

/** v0.5.0-beta.11 re7：agentteams 源（Worker 工具审批桥接）的详情字段。
 * 后端 host_bridge 把 worker/room/request 放进 tool_call.input（=
 * 前端 toolParams）——宿主 payload 透传，不依赖 extra 穿透。 */
function agentteamsDetails(
  p: ApprovalPayload,
): { worker: string; room: string; request: string } | null {
  const tp = p.toolParams || {};
  const worker = String(tp.worker || (p.sourceType === "agentteams" ? p.toolName : "") || "");
  if (!worker) return null;
  return {
    worker,
    room: String(tp.room || ""),
    request: String(tp.request || p.reasoning || ""),
  };
}

const SEV_COLOR: Record<string, string> = {
  CRITICAL: "#f5222d",
  HIGH: "#f5222d",
  MEDIUM: "#fa8c16",
  LOW: "#52c41a",
};

export default function ApprovalCard({
  approval,
  onResolved,
}: {
  approval: ApprovalPayload;
  onResolved: () => void;
}) {
  const tr = useT();
  const t = useThemeColors();
  const [acting, setActing] = React.useState<"approve" | "deny" | null>(null);
  const [note, setNote] = React.useState("");

  const send = async (action: "approve" | "deny") => {
    setActing(action);
    try {
      // 原生链路同款：POST /approval/{action}（commandsApi.sendApprovalCommand）。
      await host.fetch(`/approval/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: approval.requestId,
          session_id: approval.rootSessionId || approval.sessionId,
          reason: action === "deny" && note.trim() ? note.trim() : undefined,
        }),
      });
      onResolved();
    } catch (e) {
      antd.message.error(
        e instanceof Error ? e.message : tr("操作失败"),
      );
    } finally {
      setActing(null);
    }
  };

  const sev = String(approval.severity || "MEDIUM").toUpperCase();
  const color = SEV_COLOR[sev] || "#fa8c16";
  const at = agentteamsDetails(approval);

  return (
    <div
      style={{
        border: `1px solid ${color}`,
        borderRadius: 12,
        padding: "12px 16px",
        background: t.popoverBg,
        boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
        display: "grid",
        gap: 8,
        minWidth: 320,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 18 }}>🛡️</span>
        <span style={{ fontWeight: 700, fontSize: 14 }}>
          {approval.toolName || tr("工具调用审批")}
        </span>
        <antd.Tag color={color} style={{ margin: 0, fontSize: 11 }}>
          {sev}
        </antd.Tag>
        {approval.findingsCount > 0 ? (
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {approval.findingsCount} 项发现
          </span>
        ) : null}
      </div>
      {approval.findingsSummary ? (
        <div
          style={{
            fontSize: 12,
            color: t.textSecondary,
            maxHeight: 80,
            overflow: "auto",
            whiteSpace: "pre-wrap",
          }}
        >
          {approval.findingsSummary}
        </div>
      ) : null}
      {/* v0.5.0-beta.11 re7：AgentTeams 源详情（Worker/房间/审批请求原文） */}
      {at ? (
        <div
          style={{
            display: "grid",
            gap: 3,
            fontSize: 12,
            color: t.textSecondary,
          }}
        >
          {at.room ? (
            <div style={{ wordBreak: "break-all" }}>
              {tr("团队房间")}：
              <span style={{ fontFamily: "monospace" }}>{at.room}</span>
            </div>
          ) : null}
          {at.request ? (
            <div
              style={{
                maxHeight: 96,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                paddingLeft: 8,
                borderLeft: `2px solid ${color}`,
              }}
            >
              {tr("审批请求")}：{at.request}
            </div>
          ) : null}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <antd.Button
          size="small"
          loading={acting === "approve"}
          style={{
            backgroundColor: "#52c41a",
            borderColor: "#52c41a",
            color: "#fff",
          }}
          onClick={() => void send("approve")}
        >
          ✅ {tr("批准")}
        </antd.Button>
        <antd.Button
          size="small"
          danger
          loading={acting === "deny"}
          onClick={() => void send("deny")}
        >
          ❌ {tr("拒绝")}
        </antd.Button>
        <antd.Input
          size="small"
          value={note}
          onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) => setNote(e.target.value)}
          placeholder={tr("拒绝原因（可选）")}
          style={{ flex: 1, fontSize: 12 }}
        />
      </div>
    </div>
  );
}
