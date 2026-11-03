// 消息 hover 操作条（任务 D 拆分自 RoomChatMessageRow——快捷表情 +
// 回复/复制/编辑/撤回）。条件渲染（hovered 时挂载），absolute 相对行
// div 定位；DOM 后代关系保住「鼠标移到工具条不触发 onMouseLeave」。
import type * as ReactNS from "react";
import { type RoomMessage, type TeamRoom } from "../api";
import { EditIcon, TodoIcon, TrashIcon } from "./icons";
import { QUICK_REACTIONS, senderShortName } from "./RoomChatShared";
import type { ThemeColors } from "../theme";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

export interface RoomChatMessageToolbarProps {
  msg: RoomMessage;
  mine: boolean;
  room: TeamRoom;
  t: ThemeColors;
  tr: (text: string, vars?: Record<string, string | number>) => string;
  onReact?: (eventId: string, emoji: string) => Promise<void> | void;
  onRedact?: (eventId: string) => Promise<void> | void;
  setReplyTo: ReactNS.Dispatch<
    ReactNS.SetStateAction<{ event_id: string; sender: string; body: string } | null>
  >;
  setEditing: ReactNS.Dispatch<
    ReactNS.SetStateAction<{ event_id: string; sender: string; body: string } | null>
  >;
  setDraft: ReactNS.Dispatch<ReactNS.SetStateAction<string>>;
  composerRef: ReactNS.MutableRefObject<HTMLTextAreaElement | null>;
}

export default function RoomChatMessageToolbar(props: RoomChatMessageToolbarProps) {
  const {
    msg,
    mine,
    room,
    t,
    tr,
    onReact,
    onRedact,
    setReplyTo,
    setEditing,
    setDraft,
    composerRef,
  } = props;
  return (
    <div
      className="wb-msg-toolbar"
      style={{
        position: "absolute",
        top: -14,
        [mine ? "right" : "left"]: 6,
        zIndex: 5,
        display: "grid",
        gap: 2,
        background: t.popoverBg,
        border: `1px solid ${t.border}`,
        borderRadius: 8,
        boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
        padding: "3px 4px",
        animation: "wbToolbarIn 0.16s ease-out",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {onReact ? (
        <div className="wb-quick-react" style={{ display: "flex", gap: 2 }}>
          {QUICK_REACTIONS.map((emoji) => (
            <span
              key={emoji}
              onClick={() => void onReact(msg.event_id, emoji)}
              style={{
                fontSize: 15,
                cursor: "pointer",
                padding: "1px 3px",
                borderRadius: 4,
              }}
              title={emoji}
            >
              {emoji}
            </span>
          ))}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 0 }}>
        <antd.Button
          type="text"
          size="small"
          style={{ borderRadius: 0, fontSize: 12, color: t.text, fontWeight: 500 }}
          onClick={() =>
            setReplyTo({
              event_id: msg.event_id,
              sender: senderShortName(msg.sender, room),
              body: (msg.body || "").slice(0, 200),
            })
          }
        >
          {tr("回复") && "↩ " + tr("回复")}
        </antd.Button>
        <antd.Button
          type="text"
          size="small"
          style={{ borderRadius: 0, fontSize: 12, color: t.text, fontWeight: 500 }}
          onClick={() => {
            void navigator.clipboard
              .writeText(msg.body || "")
              .catch(() => undefined);
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><TodoIcon size={12} /> {tr("复制")}</span>
        </antd.Button>
        {/* 编辑/撤回自己的消息（Element 同款；Matrix 事件不可变——编辑=m.replace 标注替换，撤回=redaction 红条）。 */}
        {mine && !msg.redacted ? (
          <>
            <antd.Button
              type="text"
              size="small"
              style={{ borderRadius: 0, fontSize: 12, color: t.text, fontWeight: 500 }}
              onClick={() => {
                setEditing({
                  event_id: msg.event_id,
                  sender: msg.sender,
                  body: msg.body || "",
                });
                setDraft(msg.body || "");
                requestAnimationFrame(() =>
                  composerRef.current?.focus(),
                );
              }}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><EditIcon size={12} /> {tr("编辑")}</span>
            </antd.Button>
            <antd.Popconfirm
              title={tr("撤回这条消息？其他成员将看到「已撤回」")}
              okText={tr("撤回")}
              cancelText={tr("返回")}
              onConfirm={() => void onRedact?.(msg.event_id)}
            >
              <antd.Button
                type="text"
                size="small"
                danger
                style={{ borderRadius: 0, fontSize: 12, fontWeight: 500 }}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><TrashIcon size={12} /> {tr("撤回")}</span>
              </antd.Button>
            </antd.Popconfirm>
          </>
        ) : null}
      </div>
    </div>
  );
}
