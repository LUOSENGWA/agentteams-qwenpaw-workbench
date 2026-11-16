// 正在输入指示（dashboard typing-indicator.tsx 口径移植：3 档文案 /
// role=status aria-live=polite aria-atomic / 3 点 1.2s 交错闪烁
// [0.3,1,0.3] 延迟 0/0.2/0.4——framer-motion 换 CSS keyframes rcTypingDot）。
import type { TeamRoom } from "../api";
import { senderShortName } from "./RoomChatShared";

const host = window.QwenPaw.host;
const React = host.React;

interface RoomChatTypingProps {
  typing: string[];
  room: TeamRoom | null;
  userId?: string;
  color: string;
  tr: (text: string, vars?: Record<string, string | number>) => string;
}

export function RoomChatTyping({ typing, room, userId, color, tr }: RoomChatTypingProps) {
  // 过滤自己；mxid → 显示名走 room.members 既有取名口径。
  const names = typing
    .filter((mxid) => mxid !== userId)
    .map((mxid) => senderShortName(mxid, room));
  if (names.length === 0) return null;
  // 3 档文案（1:1 typing-indicator；en 复数数走 {x}=N-1 双占位）。
  const text =
    names.length === 1
      ? tr("{n} 正在输入", { n: names[0] })
      : names.length === 2
        ? tr("{a} 和 {b} 正在输入", { a: names[0], b: names[1] })
        : tr("{a} 等 {n} 人正在输入", { a: names[0], n: names.length, x: names.length - 1 });
  const dot = (d: number) => ({
    width: 6, height: 6, borderRadius: "50%",
    background: `color-mix(in srgb, ${color} 50%, transparent)`,
    animation: `rcTypingDot 1.2s infinite ${d}s`,
  });
  return (
    <div
      role="status" aria-live="polite" aria-atomic="true" title={text}
      style={{ height: 24, flexShrink: 0, display: "flex", alignItems: "center", padding: "0 16px", fontSize: 12, color }}
    >
      <span style={{ display: "flex", gap: 2, flexShrink: 0, marginRight: 8 }} aria-hidden>
        <span style={dot(0)} />
        <span style={dot(0.2)} />
        <span style={dot(0.4)} />
      </span>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {text}
      </span>
    </div>
  );
}
