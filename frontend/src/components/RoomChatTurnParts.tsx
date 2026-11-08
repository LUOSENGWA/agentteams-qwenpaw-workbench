// turn 级渲染零件（聊天渲染第二批）：TurnHeader 头像+名字+时间/状态、
// 日期分隔胶囊、未读线。
//
// 单一实现：RoomChatMessageRow（组首行）与 RoomChatMessages（turn 级
// header，过程条之上）共用同一个 TurnHeader——不复制两份头像逻辑。
import type * as ReactNS from "react";
import type { RoomMessage, RunBlockConfirmation, RunBlockError, TeamRoom } from "../api";
import { type WorkerSessionState } from "../workerSessionState";
import { WbTooltip } from "./WbTooltip";
import { PRIMARY, senderShortName, formatTime, dateLabel } from "./RoomChatShared";
import { SenderAvatarMemo } from "./RoomChatBubbles";
import { ShieldIcon, WarnIcon } from "./icons";
import type { ThemeColors } from "../theme";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
// 宿主 antdIcons 可能非全量（部署版 vs SC main 差异）——缺图标降级为空组件，
// 避免 React #130（undefined 组件）拖垮聊天室（同 RoomChatMessageRow 模式）。
const icons = (host.antdIcons || {}) as Record<string, ReactNS.ComponentType>;
const EmptyIcon = (() => null) as unknown as ReactNS.FC<Record<string, unknown>>;
const icon = (name: string): ReactNS.FC<Record<string, unknown>> =>
  (icons[name] as ReactNS.FC<Record<string, unknown>>) || EmptyIcon;
const LoadingOutlined = icon("LoadingOutlined");

export interface TurnHeaderProps {
  /** 组首消息（sender/ts/pending/failed 来源）。 */
  msg: RoomMessage;
  room: TeamRoom;
  myUserId: string;
  t: ThemeColors;
  tr: (text: string, vars?: Record<string, string | number>) => string;
  /** 时间可见性（hover ∥ 末行 ∥ 触屏组头）。 */
  showTime: boolean;
  workerSessionByMxid?: Record<string, WorkerSessionState>;
  memberWorkerNames?: Record<string, string>;
  workerRuntimeByMxid?: Record<string, string>;
  insertMention: (mxid: string) => void;
  openDetailMxid: (m: string) => void;
  onDm?: (mxid: string, roomId?: string) => void;
  onOpenWorkerChats?: (worker: string) => void;
}

/** 头像 + 短名 + 时间（+发送中/失败状态）。 */
export function TurnHeader({
  msg,
  room,
  myUserId,
  t,
  tr,
  showTime,
  workerSessionByMxid,
  memberWorkerNames,
  workerRuntimeByMxid,
  insertMention,
  openDetailMxid,
  onDm,
  onOpenWorkerChats,
}: TurnHeaderProps) {
  return (
    <div
      style={{
        fontSize: 12,
        color: t.textSecondary,
        marginBottom: 2,
        display: "flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <SenderAvatarMemo
        mxid={msg.sender}
        room={room}
        myUserId={myUserId}
        onMention={insertMention}
        onDm={onDm}
        workerName={memberWorkerNames?.[msg.sender]}
        workerRuntime={workerRuntimeByMxid?.[msg.sender]}
        onDetail={openDetailMxid}
        // （灯在头像角落，不再名字旁）：
        // Worker byMxid 派生（心跳优先），人类无映射 → 不显。
        sessionState={workerSessionByMxid?.[msg.sender]}
        onOpenChats={onOpenWorkerChats}
      />
      {senderShortName(msg.sender, room)}
      <span style={{ opacity: showTime ? 1 : 0, transition: "opacity 0.15s" }}>
        {formatTime(msg.origin_server_ts)}
      </span>
      {msg.pending ? (
        <WbTooltip title={tr("发送中…")}>
          <span
            style={{
              color: t.textSecondary,
              fontSize: 12,
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            <LoadingOutlined spin />
          </span>
        </WbTooltip>
      ) : null}
      {msg.failed ? (
        <WbTooltip title={tr("发送失败")}>
          <span style={{ color: "#f5222d", fontSize: 12, fontWeight: 700 }}>
            !
          </span>
        </WbTooltip>
      ) : null}
    </div>
  );
}

/** 日期分隔胶囊（Element 同款居中）。 */
export function ChatDatePill({
  ts,
  t,
  tr,
}: {
  ts: number;
  t: ThemeColors;
  tr: (text: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <div
      style={{ display: "flex", justifyContent: "center", margin: "14px 0 10px" }}
    >
      <span
        style={{
          fontSize: 12,
          color: t.textSecondary,
          background: t.cardBg,
          border: `1px solid ${t.border}`,
          borderRadius: 12,
          padding: "2px 12px",
          whiteSpace: "nowrap",
        }}
      >
        {dateLabel(ts, tr)}
      </span>
    </div>
  );
}

/** 未读线（打开房间后新到这里的第一条消息之前）。 */
export function ChatUnreadLine({
  tr,
}: {
  tr: (text: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 0" }}>
      <div style={{ flex: 1, borderTop: `1px solid ${PRIMARY}`, opacity: 0.5 }} />
      <span style={{ fontSize: 12, color: PRIMARY }}>{tr("以下为新消息")}</span>
      <div style={{ flex: 1, borderTop: `1px solid ${PRIMARY}`, opacity: 0.5 }} />
    </div>
  );
}

// ── 结构化运行时块（org.agentteams.run）：confirmation / error ──────
//
// 只读呈现：审批动作由 AgentTeams 审批链路（Matrix 回复）承载，这里不
// 新造 approve/deny 交互；error 是 run 结束哨兵，一行状态条。

/** 待审批确认卡（tool_call 的 tool-guard 请求，confirmation 块）。 */
export function RunConfirmationCard({
  block,
  t,
  tr,
}: {
  block: RunBlockConfirmation;
  t: ThemeColors;
  tr: (text: string, vars?: Record<string, string | number>) => string;
}) {
  const params = block.parameters ? String(block.parameters) : "";
  return (
    <div
      style={{
        border: "1px solid #fa8c16",
        borderRadius: 10,
        padding: "8px 12px",
        background: t.cardBg,
        maxWidth: 420,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <ShieldIcon size={14} />
        <span style={{ fontWeight: 600, fontSize: 13, wordBreak: "break-all" }}>
          {block.tool_name}
        </span>
        <span style={{ fontSize: 11, color: "#fa8c16" }}>{tr("待确认")}</span>
      </div>
      {params ? (
        <div
          style={{
            fontSize: 12,
            color: t.textSecondary,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 96,
            overflow: "auto",
          }}
        >
          {params}
        </div>
      ) : null}
      {block.external_files ? (
        <div style={{ fontSize: 12, color: t.textSecondary, wordBreak: "break-all" }}>
          {tr("外部文件")}：{block.external_files}
        </div>
      ) : null}
      <div style={{ marginTop: 6, fontSize: 11, color: t.textSecondary }}>
        {tr("需在 Matrix 回复审批")}
      </div>
    </div>
  );
}

const RUN_ERROR_LABEL: Record<RunBlockError["kind"], string> = {
  cancelled: "已取消",
  failed: "运行失败",
  quiet: "静默结束",
};

/** run 结束哨兵（error 块）：一行状态条，不折进思考过程。 */
export function RunErrorBar({
  block,
  t,
  tr,
}: {
  block: RunBlockError;
  t: ThemeColors;
  tr: (text: string, vars?: Record<string, string | number>) => string;
}) {
  const color = block.kind === "failed" ? "#e5484d" : t.textSecondary;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        color,
        padding: "2px 0",
      }}
    >
      <span style={{ display: "inline-flex", flexShrink: 0 }}>
        <WarnIcon size={13} />
      </span>
      <span style={{ fontWeight: 600, flexShrink: 0 }}>
        {tr(RUN_ERROR_LABEL[block.kind])}
      </span>
      <span style={{ color: t.textSecondary, wordBreak: "break-word" }}>
        {block.title}
      </span>
    </div>
  );
}
