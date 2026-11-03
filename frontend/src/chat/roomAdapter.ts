/**
 * RoomMessage → ChatIR 适配（聊天群消息面 → 回合 IR）。
 *
 * 工具帧识别与 ToolBubble 同口径（isToolMessage/toolNameOf）：
 * 一条工具消息 = 一个 ToolCall（🔧=call / ✅=ok / ❌=fail），
 * argsSummary 取首行之后的前 80 字符（ToolBubble rest 同款算法）。
 *
 * 非工具消息 toolCalls 恒空；pending 透传（流式消息归属当前 turn）。
 */
import type { RoomMessage } from "../api";
import { isToolMessage, toolNameOf } from "../components/RoomChatShared";
import { type ChatMessage, type ToolCall } from "./ChatIR";

function toolCallOf(msg: RoomMessage): ToolCall | null {
  const body = msg.body || "";
  if (!isToolMessage(body)) return null;
  const head = body.split("\n")[0] || "";
  const status: ToolCall["status"] = head.trimStart().startsWith("✅")
    ? "ok"
    : head.trimStart().startsWith("❌")
      ? "fail"
      : "call";
  const rest = body
    .split("\n")
    .slice(1)
    .join(" ")
    .replace(/```/g, "")
    .trim()
    .slice(0, 80);
  const detail = body.split("\n").slice(1).join("\n").trim();
  return {
    id: msg.event_id,
    name: toolNameOf(body),
    argsSummary: rest || undefined,
    detail: detail || undefined,
    status,
    ts: msg.origin_server_ts,
  };
}

export function roomMessagesToIR(messages: RoomMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const call = toolCallOf(m);
    out.push({
      id: m.event_id,
      sender: m.sender,
      ts: m.origin_server_ts,
      body: m.body || "",
      type: m.msgtype,
      ...(call ? { toolCalls: [call] } : {}),
      ...(m.pending ? { pending: true } : {}),
    });
  }
  return out;
}
