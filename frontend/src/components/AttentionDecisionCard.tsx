// P0 人工介入闭环 — 聊天流内联决策卡。
// 气泡正文命中 ATTENTION_* 请求 → 消息体下渲染决策卡（question +
// options + 截止 + sender）；点选项 / 填回复 → 向该消息发
// `【干预答复】` 标准回复（m.in_reply_to 指向请求本体——Worker 侧
// 与本地自解决都认这条关联）+ 本地 resolve（含同 taskId 跨源同伴）
// + 卡回「已回答」只读态。
// 两处复用：RoomChatBubbles（full）/ RoomChatThread（compact——
// 线程内正文已带全文，卡只留操作行）。
// 项查找：room_message 项 `${roomId}:${event_id}` 正查；无则按
// taskId 回退 attention 正源项（跨源去重时请求由 feed 承载，
// 气泡卡照样要能答）。

import type * as ReactNS from "react";
import {
  type RoomMessage,
  type TeamRoom,
  sendRoomMessage,
} from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { parseAttentionMessage, parseOptions } from "../pending/parse";
import { selectCompanionIds } from "../pending/tally";
import { usePendingStore } from "../pending/store";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

const pad2 = (n: number) => String(n).padStart(2, "0");
const fmtClock = (ts: number): string => {
  try {
    const d = new Date(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  } catch {
    return "";
  }
};
const shortName = (mxidOrName: string): string =>
  (mxidOrName.split(":")[0] || mxidOrName).replace(/^@/, "").split("@")[0] ||
  mxidOrName;

export function AttentionDecisionCard({
  msg,
  room,
  compact = false,
  onAnswered,
}: {
  msg: RoomMessage;
  room: TeamRoom | null;
  /** true=线程内紧凑版（不重复 question 正文，只留操作行）。 */
  compact?: boolean;
  onAnswered?: () => void;
}) {
  const tr = useT();
  const t = useThemeColors();
  const pending = usePendingStore();
  const [answer, setAnswer] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const ap = parseAttentionMessage(msg.body || "");
  const roomId = room?.room_id || "";
  const itemId = `${roomId}:${msg.event_id}`;
  const roomItem = pending.items.find((x) => x.id === itemId);
  // 跨源回退：attention feed 承载同 taskId 请求时（room 侧去重未建项），
  // 气泡卡仍要能答正源项。
  const attentionItem = roomItem
    ? undefined
    : pending.items.find(
        (x) =>
          x.source === "attention" &&
          !!ap &&
          x.taskId === ap.taskId,
      );
  const item = roomItem || attentionItem;
  const resolvedId = item?.id ?? itemId;
  const resolution = pending.resolutions.find((r) => r.id === resolvedId);

  if (!ap) return null;

  const options =
    item?.options && item.options.length > 0
      ? item.options
      : parseOptions(ap.question);
  const isApproval = !ap.question;

  const submit = async (text: string) => {
    const body = text.trim();
    if (!body || busy || !roomId) return;
    setBusy(true);
    try {
      await sendRoomMessage(roomId, `【干预答复】${body}`, {
        event_id: msg.event_id,
        sender: msg.sender,
        body: (msg.body || "").slice(0, 200),
      });
      const target = pending.items.find((x) => x.id === resolvedId);
      pending.resolve(resolvedId, {
        status: "answered",
        answer: body.slice(0, 200),
      });
      if (target) {
        for (const cid of selectCompanionIds(pending.items, target)) {
          pending.resolve(cid, {
            status: "answered",
            answer: body.slice(0, 200),
          });
        }
      }
      setAnswer("");
      onAnswered?.();
    } catch (e) {
      antd.message.error(
        e instanceof Error ? e.message : tr("发送失败，请重试"),
      );
    } finally {
      setBusy(false);
    }
  };

  const boxStyle: ReactNS.CSSProperties = {
    margin: "6px 0 2px",
    padding: compact ? "6px 10px" : "8px 12px",
    borderRadius: 10,
    border: `1px solid ${resolution ? t.border : "#fa8c16"}`,
    background: resolution
      ? "transparent"
      : t.mode === "dark"
        ? "rgba(250,140,22,0.10)"
        : "rgba(250,140,22,0.06)",
    display: "grid",
    gap: 6,
  };

  return (
    <div style={boxStyle}>
      {!compact ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700, color: t.text }}>
            {isApproval ? tr("待你审批") : tr("需要你介入")}
          </span>
          {msg.sender ? (
            <span style={{ color: t.textSecondary, fontSize: 11 }}>
              {tr("来自 {s}", { s: shortName(msg.sender) })}
            </span>
          ) : null}
          {item?.expiresAt ? (
            <span style={{ color: t.textSecondary, fontSize: 11 }}>
              {tr("截止 {t}", { t: fmtClock(item.expiresAt) })}
            </span>
          ) : null}
        </div>
      ) : null}
      {resolution ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: t.textSecondary }}>
          <span>{tr("已由 我 于 {t} 回答", { t: fmtClock(resolution.at) })}</span>
          {resolution.answer ? (
            <span style={{ color: t.text }}>{`：${resolution.answer}`}</span>
          ) : null}
        </div>
      ) : roomId ? (
        options && options.length > 0 ? (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {options.map((o) => (
              <antd.Button
                key={o.id}
                size="small"
                type={o.recommended ? "primary" : "default"}
                loading={busy}
                onClick={() => void submit(o.label)}
              >
                {o.label}
              </antd.Button>
            ))}
          </div>
        ) : (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <antd.Input
              size="small"
              value={answer}
              onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                setAnswer(e.target.value)
              }
              onPressEnter={() => void submit(answer)}
              placeholder={tr("填写你的答复…")}
              style={{ width: 220, maxWidth: "100%" }}
            />
            <antd.Button
              size="small"
              type="primary"
              loading={busy}
              onClick={() => void submit(answer)}
            >
              {tr("回答")}
            </antd.Button>
          </div>
        )
      ) : null}
    </div>
  );
}
