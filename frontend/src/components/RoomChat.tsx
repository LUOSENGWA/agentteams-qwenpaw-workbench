import type * as ReactNS from "react";

import {
  downloadViaHost,
  fetchEventContext,
  resolveFileTarget,
  type RoomMessage,
  type TeamMember,
  type TeamRoom,
  fetchRoomPowerInfo,
  type RoomPowerInfo,} from "../api";
import { useMediaObjectUrl } from "../useMediaObjectUrl";
import { MxcAvatar } from "../MxcAvatar";
import MdText from "./MdText";
import { FilePreview, type PreviewFile } from "./FilePreview";
import MessageSearch from "./MessageSearch";
import MemberDetail from "./MemberDetail";
import WorkflowCard from "./WorkflowCard";
import { useThemeColors, readThemeColors } from "../theme";
import { useT } from "../i18n";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
// 宿主 antdIcons 可能非全量（部署版 vs SC main 差异）——缺图标降级为空组件，
// 避免 React #130（undefined 组件）拖垮聊天室。
const icons = (host.antdIcons || {}) as Record<string, ReactNS.ComponentType>;
const EmptyIcon = (() => null) as unknown as ReactNS.FC<Record<string, unknown>>;
const icon = (name: string): ReactNS.FC<Record<string, unknown>> =>
  (icons[name] as ReactNS.FC<Record<string, unknown>>) || EmptyIcon;
const DownloadOutlined = icon("DownloadOutlined");
const EyeOutlined = icon("EyeOutlined");
const FileOutlined = icon("FileOutlined");
const ReplyOutlined = icon("ReplyOutlined");
const PaperClipOutlined = icon("PaperClipOutlined");

// ── UI 常量（与 WorkbenchPage 视觉一致）──────────────────────────────
const PRIMARY = "#FF7F16"; // 品牌主色
// 自己的消息气泡浅橙背景：改用主题（useThemeColors().bubbleMine）
const CARD_RADIUS = 10;

/** Agent 工具消息（QwenPaw renderer 格式）：
 *  - 工具调用：`🔧 **name**` + args 代码块
 *  - 工具输出：`✅ **name**:` + 结果内容（read_file 的文件内容贴这里）
 *  - 失败：`❌ **name**:`（保险）
 * 折叠识别只认前缀 emoji + 工具名模式，避免误伤普通消息。 */
const TOOL_MSG_RE =
  /^\s*(?:[^\n:]{1,80}:\s*)?(?:🔧|✅|❌)\s*(?:\*\*)?[A-Za-z0-9_.-]+/;

function isToolMessage(body: string): boolean {
  return TOOL_MSG_RE.test(body || "");
}

/** 从工具消息里提取工具名（🔧 **name** / ✅ **name**:）。 */
function toolNameOf(body: string): string {
  const m = /(?:🔧|✅|❌)\s*(?:\*\*)?([A-Za-z0-9_.-]+)/.exec(body || "");
  return m ? m[1] : "";
}

/** 引用回复折叠条（Element 同款：左竖色条 + 16px 小头像 + 着色名字 + 单行预览；
 *  点击滚动定位原消息并高亮闪烁，不再内联展开副本）。 */
function ReplyBanner({
  msg,
  room,
  messages,
  onJump,
}: {
  msg: RoomMessage;
  room: TeamRoom | null;
  messages: RoomMessage[];
  onJump: (eventId: string) => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  const reply = msg.reply;
  if (!reply) return null;
  // 原消息在已加载历史里 → 渲染原消息内容缩略（Element ReplyTile 同款：
  // 文本截断 / 图片缩略 / 文件图标名 / 工具消息名）；否则用 fallback 摘要。
  const original = messages.find((m) => m.event_id === reply.event_id);
  const senderName = reply.sender
    ? senderShortName(reply.sender, room)
    : original
      ? senderShortName(original.sender, room)
      : tr("消息");
  let summary = "";
  let summaryIcon = "";
  if (original) {
    if (original.msgtype === "m.image") {
      summaryIcon = "🖼️ ";
      summary = "图片";
    } else if (original.msgtype === "m.file") {
      summaryIcon = "📎 ";
      summary = original.filename || original.body || "文件";
    } else if (isToolMessage(original.body || "")) {
      summaryIcon = "🔧 ";
      summary = toolNameOf(original.body || "") || original.body;
    } else {
      summary = (original.body || "").replace(/\n+/g, " ").slice(0, 120);
    }
  } else {
    summary = (reply.body || "").replace(/\n+/g, " ").slice(0, 120);
  }
  return (
    <div
      onClick={() => {
        // 8/18 批次 1 跳转修复（用户真机报「消息点击不跳转」根因）：
        // 此前误传 reply.event_id（=被点击消息自身）→ 滚动回原地看似无反应。
        // 应为 original.event_id（被引用的原消息）。
        if (original) onJump(original.event_id);
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 3,
        maxWidth: 560,
        cursor: original ? "pointer" : "default",
        borderLeft: `4px solid ${PRIMARY}`,
        borderRadius: "0 8px 8px 0",
        background: t.toolBg,
        padding: "4px 10px",
        fontSize: 12.5,
        color: t.textSecondary,
      }}
      title={original ? tr("点击定位原消息") : tr("原消息不在当前加载范围内")}
    >
      <antd.Avatar size={16} style={{ backgroundColor: PRIMARY, fontSize: 10, flexShrink: 0 }}>
        {(senderName || "?").slice(0, 1).toUpperCase()}
      </antd.Avatar>
      <span style={{ color: t.textSecondary, flexShrink: 0 }}>回复</span>
      <span style={{ color: PRIMARY, fontWeight: 600, flexShrink: 0 }}>
        {senderName}
      </span>
      <span style={{ color: "#bbb", flexShrink: 0 }}>：</span>
      <span
        style={{
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {summaryIcon}
        {summary || "…"}
      </span>
      {original ? (
        <span style={{ fontSize: 11, color: "#aaa", flexShrink: 0 }}>↗</span>
      ) : (
        <span style={{ fontSize: 11, color: "#ccc", flexShrink: 0 }}>{tr("已滚出历史")}</span>
      )}
    </div>
  );
}

/** 常用快捷表情（Element 同款交互：hover 消息 → 快捷反应）。 */
const QUICK_REACTIONS = ["👍", "❤️", "😄", "🎉", "👀", "✅"];

/** 输入框 emoji 面板常用集（Element emoji picker 交互，独立实现精简版）。 */
const EMOJI_PANEL = [
  "😀", "😄", "😂", "🤣", "😊", "🙂", "😉", "😍", "🤔", "😅",
  "👍", "👎", "❤️", "💯", "🔥", "✨", "🎉", "🎊", "🙏", "💪",
  "✅", "❌", "⚠️", "❓", "❗", "💡", "🚀", "📌", "👀", "🛡️",
  "🔧", "📋", "📄", "📊", "🐛", "🤝", "👏", "☕", "🌙", "😴",
];

/** 表情反应 chips（emoji + 计数，点击追加同款反应）。 */
function ReactionChips({
  reactions,
  onReact,
}: {
  reactions?: Record<string, number>;
  onReact?: (emoji: string) => void;
}) {
  if (!reactions || Object.keys(reactions).length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 3 }}>
      {Object.entries(reactions).map(([emoji, count]) => (
        <span
          key={emoji}
          onClick={onReact ? () => onReact(emoji) : undefined}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            padding: "1px 8px",
            borderRadius: 10,
            background: "rgba(255,127,22,0.1)",
            border: "1px solid rgba(255,127,22,0.35)",
            fontSize: 12,
            cursor: onReact ? "pointer" : "default",
          }}
        >
          {emoji} {count > 1 ? count : ""}
        </span>
      ))}
    </div>
  );
}

/** 线程面板内容（Element ThreadView 同款）：root 消息 + 回复列表 + 输入框。
 *  宽屏放右侧固定面板，窄屏放 antd.Drawer——同一组件两种容器。 */
function ThreadPanelView({
  root,
  replies,
  room,
  myUserId,
  onSendThread,
  onClose,
  onReact,
  onJump,
}: {
  root: RoomMessage;
  replies: RoomMessage[];
  room: TeamRoom | null;
  myUserId: string;
  onSendThread: (text: string) => Promise<void> | void;
  onClose: () => void;
  onReact?: (eventId: string, emoji: string) => Promise<void> | void;
  /** workflow 卡片点击 → 工作流 tab 选中该项目（8/18 批次 2）。 */
  onOpenProject?: (runId: string) => void;
  /** workflow 卡片干预成功 → 刷新工作流。 */
  onWorkflowIntervened?: () => void;
  /** 项目文件面板（8/18 批次 2，O19 版）：顶部 📁 按钮 → 抽屉。 */
  onOpenProjectFiles?: (room: TeamRoom) => void;
  onJump?: (eventId: string) => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  const [draft, setDraft] = React.useState("");
  const [sending, setSending] = React.useState(false);

  // v0.4.83: 打开话题自动滚到最新回复；开着时新回复到达且已在底部 → 跟随。
  // 与主消息列表同款 nearBottom 跟随逻辑（此前话题面板永远停在顶部，
  // 长话题要手动翻到底，用户「话题页面从旧到新」体验的一部分）。
  const threadScrollRef = React.useRef<HTMLDivElement | null>(null);
  const threadOpenKeyRef = React.useRef<string>("");
  React.useEffect(() => {
    const el = threadScrollRef.current;
    if (!el) return;
    const key = root.event_id;
    if (threadOpenKeyRef.current !== key) {
      threadOpenKeyRef.current = key;
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
      el.scrollTop = el.scrollHeight;
    }
  }, [root.event_id, replies.length]);

  const handleSend = async () => {
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    try {
      await onSendThread(text);
      setDraft("");
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        // 面板容器是 flex（row），本根是 flex item——没有 width/minWidth 约束时
        // flex item 按 max-content（= 滚动区内容全宽，代码块单行可上千 px）撑宽
        // 整条链，pre 宽=内容宽 → 无溢出无滚动条 → 截断（浏览器实测复现）。
        // 显式 100% + minWidth:0 切断 max-content 传播，滚动条恢复。
        width: "100%",
        minWidth: 0,
        maxWidth: "100%",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          paddingBottom: 10,
          borderBottom: `1px solid ${t.border}`,
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 700 }}>🧵 {tr("话题")}</span>
        <span style={{ fontSize: 12, color: t.textSecondary }}>
          {replies.length}
          {tr("条回复")}
        </span>
        <div style={{ flex: 1 }} />
        <antd.Button type="text" size="small" onClick={onClose} title={tr("关闭话题")}>
          ✕
        </antd.Button>
      </div>
      <div
        ref={threadScrollRef}
        style={{
          flex: 1,
          overflowY: "auto",
          overflowX: "hidden",
          padding: "10px 0",
          minHeight: 0,
          minWidth: 0,
          maxWidth: "100%",
        }}
      >
        {/* root 消息 */}
        <div
          style={{
            padding: "8px 10px",
            borderRadius: 10,
            background: t.hoverBg,
            marginBottom: 10,
            cursor: onJump ? "pointer" : "default",
          }}
          onClick={() => onJump && onJump(root.event_id)}
          title={onJump ? tr("跳转到原消息") : undefined}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <MxcAvatar
              url={room?.members?.[root.sender]?.avatar_url}
              size={20}
              style={{ backgroundColor: PRIMARY, fontSize: 10, flexShrink: 0 }}
            >
              {senderShortName(root.sender, room).slice(0, 1).toUpperCase()}
            </MxcAvatar>
            <span style={{ fontSize: 12, fontWeight: 600 }}>
              {senderShortName(root.sender, room)}
            </span>
            <span style={{ fontSize: 11, color: t.textSecondary }}>
              {formatTime(root.origin_server_ts)}
            </span>
          </div>
          <div
            style={{
              fontSize: 13,
              wordBreak: "break-word",
              minWidth: 0,
              maxWidth: "100%",
              overflowWrap: "anywhere",
            }}
          >
            <MdText text={root.body || ""} />
          </div>
          {onReact ? (
            <ReactionChips
              reactions={root.reactions}
              onReact={(emoji) => void onReact(root.event_id, emoji)}
            />
          ) : null}
        </div>
        {/* 回复列表 */}
        {replies.length === 0 ? (
          <antd.Empty
            description={tr("暂无回复")}
            image={antd.Empty.PRESENTED_IMAGE_SIMPLE}
          />
        ) : (
          <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
            {replies.map((r) => {
              const rMine = myUserId !== "" && r.sender === myUserId;
              return (
                <div
                  key={r.event_id}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: rMine ? "flex-end" : "flex-start",
                    minWidth: 0,
                    maxWidth: "100%",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                    {!rMine ? (
                      <MxcAvatar
                        url={room?.members?.[r.sender]?.avatar_url}
                        size={20}
                        style={{ backgroundColor: PRIMARY, fontSize: 10, flexShrink: 0 }}
                      >
                        {senderShortName(r.sender, room).slice(0, 1).toUpperCase()}
                      </MxcAvatar>
                    ) : null}
                    <span style={{ fontSize: 12, fontWeight: 600 }}>
                      {senderShortName(r.sender, room)}
                    </span>
                    <span style={{ fontSize: 11, color: t.textSecondary }}>
                      {formatTime(r.origin_server_ts)}
                    </span>
                  </div>
                  <div
                    style={{
                      maxWidth: "92%",
                      minWidth: 0,
                      background: rMine ? t.bubbleMine : t.bubbleOther,
                      borderRadius: 12,
                      padding: "8px 12px",
                      fontSize: 13,
                      wordBreak: "break-word",
                    }}
                  >
                    <BubbleBoundary fallback={r.body || ""}>
                      <MdText text={r.body || ""} />
                    </BubbleBoundary>
                  </div>
                  {onReact ? (
                    <ReactionChips
                      reactions={r.reactions}
                      onReact={(emoji) => void onReact(r.event_id, emoji)}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div style={{ flexShrink: 0, paddingTop: 10, borderTop: `1px solid ${t.border}` }}>
        <antd.Input.TextArea
          value={draft}
          rows={2}
          placeholder={tr("回复此话题…（Enter 发送，Shift+Enter 换行）")}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(e.target.value)}
          onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
          <antd.Button
            loading={sending}
            disabled={!draft.trim()}
            onClick={() => void handleSend()}
            style={{ backgroundColor: PRIMARY, borderColor: PRIMARY, color: "#fff" }}
          >
            {tr("发送")}
          </antd.Button>
        </div>
      </div>
    </div>
  );
}

/** 发送者头像（5.0.0-beta.4：左键点击弹层=@提及/Worker 配置/私聊；
 *  右键菜单保留：@提及 / 私聊 / 复制 MXID，Element 头像交互同款）。 */
function SenderAvatar({
  mxid,
  room,
  myUserId,
  onMention,
  onDm,
  workerName,
  onDetail,
}: {
  mxid: string;
  room: TeamRoom | null;
  myUserId: string;
  onMention: (mxid: string) => void;
  onDm?: (mxid: string, roomId?: string) => void;
  /** Worker 容器名（有值=Worker 成员，弹层出「Worker 配置」）。 */
  workerName?: string;
  /** 打开成员详情卡（含审批卡）。 */
  onDetail?: (mxid: string) => void;
}) {
  const tr = useT();
  const [popOpen, setPopOpen] = React.useState(false);
  const name = senderShortName(mxid, room);
  const member = room?.members?.[mxid];
  const isMe = mxid === myUserId;
  // 左键点击弹层（需求：「点击头像可以@和改 worker 配置」）
  const quick: Array<{ label: string; act: () => void }> = [];
  if (!isMe) {
    quick.push({
      label: `@ ${tr("提及")} ${name}`,
      act: () => onMention(mxid),
    });
  }
  if (workerName && onDetail) {
    quick.push({
      label: `🛡️ ${tr("Worker 配置（审批模式）")}`,
      act: () => onDetail(mxid),
    });
  }
  if (!isMe && onDm) {
    quick.push({
      label: `💬 ${tr("私聊")} ${name}`,
      act: () => onDm(mxid),
    });
  }
  const items = [
    ...(!isMe
      ? [
          {
            key: "mention",
            label: `@ ${tr("提及")} ${name}`,
            onClick: () => onMention(mxid),
          },
        ]
      : []),
    ...(!isMe && onDm
      ? [
          {
            key: "dm",
            label: `💬 ${tr("私聊")} ${name}`,
            onClick: () => onDm(mxid),
          },
        ]
      : []),
    {
      key: "copy",
      label: tr("复制 MXID"),
      onClick: () => {
        void navigator.clipboard.writeText(mxid).catch(() => undefined);
      },
    },
  ];
  return (
    <antd.Dropdown menu={{ items }} trigger={["contextMenu"]}>
      <antd.Popover
        open={quick.length > 0 ? popOpen : false}
        onOpenChange={(o: boolean) => setPopOpen(o)}
        trigger={["click"]}
        content={
          quick.length > 0 ? (
            <div style={{ display: "grid", gap: 2, minWidth: 170 }}>
              {quick.map((q) => (
                <antd.Button
                  key={q.label}
                  type="text"
                  size="small"
                  style={{
                    width: "100%",
                    justifyContent: "flex-start",
                    padding: "2px 8px",
                    whiteSpace: "nowrap",
                  }}
                  onClick={() => {
                    setPopOpen(false);
                    q.act();
                  }}
                >
                  {q.label}
                </antd.Button>
              ))}
            </div>
          ) : undefined
        }
      >
        <MxcAvatar
          url={member?.avatar_url}
          size={28}
          style={{
            backgroundColor: PRIMARY,
            fontSize: 13,
            flexShrink: 0,
            cursor: quick.length > 0 ? "pointer" : "default",
          }}
        >
          {name.slice(0, 1).toUpperCase()}
        </MxcAvatar>
      </antd.Popover>
    </antd.Dropdown>
  );
}

/** 工具消息：默认折叠一行（工具名 + 预览），点击展开全文（QwenPaw 聊天页同款）。 */
function ToolBubble({ msg, mine }: { msg: RoomMessage; mine: boolean }) {
  const t = useThemeColors();
  const tr = useT();
  const [open, setOpen] = React.useState(false);
  const body = msg.body || "";
  const firstLine = body.split("\n")[0] || tr("工具调用");
  const name = toolNameOf(body);
  // 预览：第一行后的内容前 80 字符（输出消息的实质内容）。
  const rest = body
    .split("\n")
    .slice(1)
    .join(" ")
    .replace(/```/g, "")
    .trim()
    .slice(0, 80);
  return (
    <div
      onClick={() => setOpen((v) => !v)}
      style={{
        cursor: "pointer",
        padding: "4px 10px",
        borderRadius: CARD_RADIUS,
        background: mine ? t.bubbleMine : t.toolBg,
        fontSize: 12.5,
        maxWidth: 560,
        color: t.textSecondary,
      }}
      title={open ? tr("收起") : tr("点击展开工具调用详情")}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            fontFamily: "monospace",
            fontSize: 12,
            fontWeight: 600,
            color: t.textSecondary,
            flexShrink: 0,
          }}
        >
          {name || firstLine.slice(0, 40)}
        </span>
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: t.textSecondary,
          }}
        >
          {rest}
        </span>
        <span style={{ color: "#bbb", fontSize: 11, flexShrink: 0 }}>
          {open ? "▲" : "▼"}
        </span>
      </div>
      {open ? (
        <pre
          style={{
            margin: "6px 0 0",
            padding: "8px 10px",
            background: t.toolBg,
            borderRadius: 6,
            fontSize: 12,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            maxHeight: 420,
            overflow: "auto",
          }}
        >
          {body}
        </pre>
      ) : null}
    </div>
  );
}

/** 消息渲染防线：子组件崩溃时降级为纯文本，不拖垮整个聊天室。 */
class BubbleBoundary extends React.Component<
  { fallback: string; children?: ReactNS.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div
          style={{
            fontSize: 12,
            color: readThemeColors().textSecondary,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxWidth: 520,
          }}
        >
          {this.props.fallback}
        </div>
      );
    }
    return this.props.children ?? null;
  }
}

/** 发送者短名：优先成员 display_name，否则取 MXID 的 localpart。 */
function senderShortName(mxid: string, room: TeamRoom | null): string {
  const member: TeamMember | undefined = room?.members?.[mxid];
  if (member?.display_name && member.display_name.trim()) {
    return member.display_name;
  }
  const localpart = (mxid.split(":")[0] || mxid).replace(/^@/, "");
  return localpart || mxid;
}

/** origin_server_ts（毫秒）→ 本地时区 HH:mm。 */
function formatTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** 文件大小 humanize。 */
function formatSize(bytes?: unknown): string {
  const n = Number(bytes || 0);
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 文件名截断：>19 字符裁成「前 15 字符…扩展名」，保留扩展名可见。 */
function truncateFilename(name: string): string {
  if (name.length <= 19) return name;
  const dot = name.lastIndexOf(".");
  if (dot > 0 && dot >= name.length - 8) {
    const base = name.slice(0, Math.max(15, dot - (name.length - 19) - 3));
    return `${base.slice(0, 15)}…${name.slice(dot)}`;
  }
  return `${name.slice(0, 15)}…${name.slice(-4)}`;
}

/** 日期分隔符标签：今天/昨天/近 6 天周几/具体日期（Element 同款四级）。 */
function dateLabel(ts: number, tr: (s: string, vars?: Record<string, string | number>) => string): string {
  const d = new Date(ts);
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round(
    (startOfDay(new Date()) - startOfDay(d)) / 86400000,
  );
  if (diff === 0) return tr("今天");
  if (diff === 1) return tr("昨天");
  if (diff > 1 && diff < 6) {
    return tr(["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()]);
  }
  return tr("{y}年{m}月{d}日", {
    y: d.getFullYear(),
    m: d.getMonth() + 1,
    d: d.getDate(),
  });
}

/** 时间分组规则（Element：>24h 或跨本地午夜插分隔符；组首强制插）。 */
function wantsDateSeparator(prev: RoomMessage | null, cur: RoomMessage): boolean {
  if (!prev) return true;
  const dp = new Date(prev.origin_server_ts);
  const dc = new Date(cur.origin_server_ts);
  if (Math.abs(dc.getTime() - dp.getTime()) > 24 * 3600 * 1000) return true;
  return dp.getDay() !== dc.getDay();
}

/** 审批通知识别：QwenPaw 2.x「🛡️ Approval Required」/ 旧版「⏳ Waiting for approval」。 */
function parseApproval(
  body: string,
): { approveCmd: string; denyCmd: string } | null {
  if (body.includes("🛡️") && body.includes("Approval Required")) {
    return { approveCmd: "/approval approve", denyCmd: "/approval deny" };
  }
  if (body.includes("⏳") && body.includes("Waiting for approval")) {
    // 旧版语义：/approve 批准，任意其他消息=拒绝（发「拒绝」最明确）。
    return { approveCmd: "/approve", denyCmd: "拒绝" };
  }
  return null;
}

/** 消息气泡主体：文本 / 图片 / 文件 / 审批卡片 / 其他。 */
function MessageBody({
  msg,
  mine,
  onApprovalAction,
  approvalResolved,
  onDeliverable,
  onOpenProject,
  onWorkflowIntervened,
}: {
  msg: RoomMessage;
  mine: boolean;
  onApprovalAction?: (
    msg: RoomMessage,
    action: "approve" | "deny",
  ) => void;
  approvalResolved?: "approve" | "deny" | null;
  /** 产物验收：accept=接受交付；revise=提出修改意见（text 非空）。 */
  onDeliverable?: (
    msg: RoomMessage,
    action: "accept" | "revise",
    text?: string,
  ) => void;
  /** workflow 卡片点击 → 工作流 tab 选中该项目（8/18 批次 2）。 */
  onOpenProject?: (runId: string) => void;
  /** workflow 卡片干预成功 → 刷新工作流。 */
  onWorkflowIntervened?: () => void;
  /** 项目文件面板（8/18 批次 2，O19 版）：顶部 📁 按钮 → 抽屉。 */
  onOpenProjectFiles?: (room: TeamRoom) => void;
}) {
  const tr = useT();
  const t = useThemeColors();
  // v0.4.85: 文件地址统一解析（m.image/m.file 共用）——mxc → 媒体代理
  // apiPath（fetch 必须走 host.fetch 带鉴权；裸插件路径落 SPA 兜底返回
  // index.html 壳 = 8/22「内容是网页」真根因）。fileSrc 供 img src /
  // a href（裸导航带不了鉴权头，只能 objectURL）。
  const fileTarget = React.useMemo(
    () => (msg.url ? resolveFileTarget(msg.url) : { url: "" }),
    [msg.url],
  );
  const fileSrc = useMediaObjectUrl(fileTarget.apiPath, fileTarget.url);
  // v0.4.98 再版 10：m.file 分支的 state 上提组件顶部——hooks 禁止在分支内
  // 条件调用：撤回（redaction，再版 9）让同一事件改走 redacted 早退分支，
  // 分支 hook 数量变化 → React #310（Rendered fewer hooks than expected）
  // 崩掉整个消息列表。上提后所有 msgtype 分支 hook 数量恒定。
  const [previewFile, setPreviewFile] = React.useState<PreviewFile | null>(null);
  const [revising, setRevising] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [accepted, setAccepted] = React.useState(false);
  // v0.4.98 再版 9：撤回消息（redaction）——固定提示替代原内容（Element
  // 同款「This message was redacted」；优先级最高，workflow/审批/文件全不渲染）。
  if (msg.redacted) {
    return (
      <span style={{ color: t.textSecondary, fontStyle: "italic", fontSize: 13 }}>
        {tr("这条消息已被撤回")}
      </span>
    );
  }
  // workflow 卡片（8/18 批次 2，dashboard normalize 规则 1 同款优先级=最高）：
  // content.agentteams.workflow 载荷 → 交互卡片（项目名/状态/步骤进度/干预按钮）。
  if (msg.workflow) {
    return (
      <WorkflowCard
        payload={msg.workflow}
        body={msg.body || undefined}
        onOpenProject={onOpenProject}
        onIntervened={onWorkflowIntervened}
      />
    );
  }
  // 审批通知（非自己发的文本消息）：渲染审批卡片替代裸文本。
  const approval =
    !mine && msg.msgtype === "m.text" && !msg.pending
      ? parseApproval(msg.body || "")
      : null;
  if (approval) {
    const body = msg.body || "";
    const sevMatch = /Severity\s*[:：]\s*(?:🔴|🟡|🟢|🟠)?\s*([A-Za-z]+)/i.exec(
      body,
    );
    const toolMatch = /Tool\s*[:：]\s*`?([^`\n*]+?)`?[\s*]*(?:$|\n)/i.exec(body);
    const severity = sevMatch?.[1]?.toUpperCase() || "MEDIUM";
    const sevColor =
      severity === "CRITICAL" || severity === "HIGH"
        ? "#f5222d"
        : severity === "MEDIUM"
          ? "#fa8c16"
          : "#52c41a";
    const resolved = approvalResolved || null;
    return (
      <div
        style={{
          border: `1px solid ${resolved ? "#d9d9d9" : sevColor}`,
          borderRadius: CARD_RADIUS,
          padding: "10px 14px",
          maxWidth: 420,
          background: resolved ? "rgba(0,0,0,0.03)" : "rgba(255,255,255,0.6)",
          opacity: resolved ? 0.7 : 1,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 6,
          }}
        >
          <span style={{ fontSize: 16 }}>🛡️</span>
          <span style={{ fontWeight: 600, fontSize: 14 }}>
            {toolMatch?.[1]?.trim() || tr("工具调用审批")}
          </span>
          <antd.Tag
            color={resolved ? undefined : sevColor}
            style={{ margin: 0, fontSize: 12 }}
          >
            {severity}
          </antd.Tag>
          {resolved ? (
            <span style={{ fontSize: 12, color: "#888" }}>
              {resolved === "approve" ? tr("已批准") : tr("已拒绝")}
            </span>
          ) : null}
        </div>
        <div
          style={{
            fontSize: 12,
            color: t.textSecondary,
            maxHeight: 96,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            marginBottom: 8,
          }}
        >
          {body.slice(0, 600)}
        </div>
        {resolved ? null : (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <antd.Button
              size="small"
              style={{
                backgroundColor: "#52c41a",
                borderColor: "#52c41a",
                color: "#fff",
              }}
              onClick={() => onApprovalAction?.(msg, "approve")}
            >
              ✅ {tr("批准")}
            </antd.Button>
            <antd.Button
              size="small"
              danger
              onClick={() => onApprovalAction?.(msg, "deny")}
            >
              ❌ {tr("拒绝")}
            </antd.Button>
            <span style={{ fontSize: 11, color: "#bbb", alignSelf: "center" }}>
              {tr("将发送 @{name} {cmd}", {
                name: (msg.sender.split(":")[0] || "").replace(/^@/, ""),
                cmd: approval.approveCmd,
              })}
            </span>
          </div>
        )}
      </div>
    );
  }
  if (msg.msgtype === "m.image" && msg.url) {
    // v0.4.85: mxc 走 host.fetch blob → objectURL（img src 裸导航带不了
    // 鉴权头，会落 SPA 兜底/401）；http 直链原样。
    const thumb = fileSrc;
    return (
      <div style={{ display: "grid", gap: 6 }}>
        <img
          src={thumb}
          alt={msg.body || tr("图片")}
          loading="lazy"
          style={{
            maxWidth: 320,
            maxHeight: 240,
            borderRadius: 8,
            objectFit: "cover",
            cursor: "pointer",
            border: mine ? "1px solid rgba(255,127,22,0.25)" : "1px solid rgba(0,0,0,0.06)",
          }}
          onClick={() => thumb && window.open(thumb, "_blank")}
        />
        <div style={{ fontSize: 12, color: "#999" }}>
          {msg.body || tr("图片")} · {tr("点击预览")} /{" "}
          <a href={thumb} download={msg.body || "image"} style={{ color: PRIMARY }}>
            下载
          </a>
        </div>
      </div>
    );
  }
  if (msg.msgtype === "m.file" && msg.url) {
    // v0.4.85: fileTarget（mxc→媒体代理 apiPath+解析 URL，http 直链→原样）；
    // 预览/下载走 host 鉴权链，不再裸路径。
    // v0.4.98 再版 10: 直链也带 apiPath（/media/proxy 服务端代抓绕 CORS）
    // → 下载统一走 host.fetch blob（跨域 a[download] 会变导航）。
    const url = fileTarget.url;
    // v0.4.98 再版 10: 尺寸取自 msg.size（映射补的 content.info.size——
    // 此前 formatSize(msg.info) 传对象恒 ""，文件卡尺寸从未显示过）。
    const sizeLine = [formatSize(msg.size), msg.mimetype].filter(Boolean).join(" · ");
    return (
      <div
        style={{
          display: "grid",
          gap: 8,
          padding: "10px 12px",
          borderRadius: 10,
          background: t.cardBg,
          border: `1px solid ${t.border}`,
          minWidth: 220,
          maxWidth: 360,
        }}
      >
        {/* v0.4.98 再版 10: Element 风格文件卡——彩色图标块 + 名称 +
            尺寸·类型 + 右侧操作（此前是平铺 icon，观感弱于 Element）。 */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              background: "rgba(255,127,22,0.10)",
              display: "grid",
              placeItems: "center",
              flexShrink: 0,
            }}
          >
            <FileOutlined style={{ fontSize: 20, color: PRIMARY }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <antd.Tooltip
              title={(msg.filename || msg.body || tr("附件")).length > 19 ? msg.filename || msg.body : undefined}
            >
              <div
                style={{
                  fontWeight: 600,
                  fontSize: 13,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {truncateFilename(msg.filename || msg.body || tr("附件"))}
              </div>
            </antd.Tooltip>
            {sizeLine ? (
              <div style={{ fontSize: 12, color: t.textSecondary }}>{sizeLine}</div>
            ) : null}
          </div>
          {/* v0.4.85: 插件路径走 host.fetch blob 下载（带鉴权）；
              v0.4.98 再版 10: 直链经代抓同样有 apiPath → 全类型统一
              host 链（跨域 a[download] 会变导航）。url 为空时不渲染
              href（href="" 点击会重载当前页面）。 */}
          <antd.Button
            type="text"
            size="small"
            icon={<DownloadOutlined />}
            href={fileTarget.apiPath ? undefined : url || undefined}
            disabled={!url && !fileTarget.apiPath}
            download={msg.filename || msg.body || "file"}
            title={tr("下载")}
            onClick={
              fileTarget.apiPath
                ? (e: { preventDefault: () => void }) => {
                    e.preventDefault();
                    void (async () => {
                      const ok = await downloadViaHost(
                        fileTarget.apiPath as string,
                        msg.filename || msg.body || "file",
                      );
                      if (!ok) antd.message.error("下载失败，请稍后重试");
                    })();
                  }
                : undefined
            }
          />
          <antd.Button
            type="text"
            size="small"
            icon={<EyeOutlined />}
            onClick={() =>
              setPreviewFile({
                name: msg.filename || msg.body || "file",
                url,
                apiPath: fileTarget.apiPath,
                mimeType: msg.mimetype,
                // v0.4.98 再版 10: size 激活预览大小守卫；rawUrl 进预览
                // 错误态（失败时可见原值+状态码，截图即可定位）。
                rawUrl: fileTarget.rawUrl,
                ...(typeof msg.size === "number" ? { size: msg.size } : {}),
              })
            }
            title={tr("预览")}
          />
        </div>
        {/* 产物验收（Phase 4 交付闭环）：Agent 交付的 m.file 消息
            带验收按钮——接受发确认，修改意见弹输入。 */}
        {!mine && onDeliverable ? (
          accepted ? (
            <div style={{ fontSize: 12, color: "#52c41a" }}>
              ✅ {tr("已接受")}
            </div>
          ) : revising ? (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <antd.Input
                size="small"
                value={note}
                autoFocus
                placeholder={tr("修改意见…")}
                onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                  setNote(e.target.value)
                }
                onKeyDown={(e: ReactNS.KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === "Enter") {
                    onDeliverable(msg, "revise", note.trim() || undefined);
                    setRevising(false);
                    setNote("");
                  }
                  if (e.key === "Escape") setRevising(false);
                }}
                style={{ flex: 1, fontSize: 12 }}
              />
              <antd.Button
                size="small"
                type="primary"
                style={{ backgroundColor: PRIMARY, borderColor: PRIMARY }}
                onClick={() => {
                  onDeliverable(msg, "revise", note.trim() || undefined);
                  setRevising(false);
                  setNote("");
                }}
              >
                {tr("发送")}
              </antd.Button>
              <antd.Button size="small" onClick={() => setRevising(false)}>
                {tr("取消")}
              </antd.Button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 6 }}>
              <antd.Button
                size="small"
                style={{
                  backgroundColor: "#52c41a",
                  borderColor: "#52c41a",
                  color: "#fff",
                }}
                onClick={() => {
                  onDeliverable(msg, "accept");
                  setAccepted(true);
                }}
              >
                ✅ {tr("接受")}
              </antd.Button>
              <antd.Button size="small" onClick={() => setRevising(true)}>
                📝 {tr("修改意见")}
              </antd.Button>
            </div>
          )
        ) : null}
        <FilePreview file={previewFile} onClose={() => setPreviewFile(null)} />
      </div>
    );
  }
  if (msg.msgtype !== "m.text") {
    return (
      <div style={{ color: t.textSecondary, fontSize: 13 }}>
        [{msg.msgtype.replace(/^m\./, "")}] {msg.body || ""}
      </div>
    );
  }
  // Agent 工具调用显示（TeamHarness 格式：🔧 tool_name）→ 折叠一行，
  // 点击展开全文（Element 里这些消息会把群刷乱）。
  if (isToolMessage(msg.body || "")) {
    return <ToolBubble msg={msg} mine={mine} />;
  }
  return (
    <div
      style={{
        padding: "8px 12px",
        borderRadius: CARD_RADIUS,
        background: mine ? t.bubbleMine : t.bubbleOther,
        fontSize: 14,
        maxWidth: 520,
      }}
    >
      <MdText text={msg.body || ""} />
      {/* v0.4.98 再版 9：「已编辑」标记（Element 同款；m.replace 聚合在
          fetchRoomMessages——替换事件不独立显示，正文写回原消息）。 */}
      {msg.edited ? (
        <span
          style={{
            fontSize: 11,
            color: t.textSecondary,
            marginLeft: 6,
            whiteSpace: "nowrap",
          }}
        >
          {tr("已编辑")}
        </span>
      ) : null}
    </div>
  );
}

export interface RoomChatProps {
  room: TeamRoom | null;
  messages: RoomMessage[];
  loading?: boolean;
  sending?: boolean;
  /** 是否还有更早的消息（分页）。 */
  hasMore?: boolean;
  /** 当前登录用户 MXID（自己的消息右对齐）。 */
  user_id?: string;
  /** 是否允许发消息；false 时整个输入区替换为居中提示条（Element 同款语义）。 */
  canSend?: boolean;
  /** 发送文本消息；replyTo 非空时作为引用回复发送；threadRoot 非空时
   *  作为线程回复（m.thread）发送到该线程。 */
  onSend?: (
    text: string,
    replyTo?: { event_id: string; sender: string; body: string },
    threadRoot?: string,
  ) => Promise<void> | void;
  /** 发送文件/图片（上传 → m.file/m.image 消息）。 */
  onSendFiles?: (files: File[]) => Promise<void> | void;
  /** v0.5.0-beta.10 再版 2：审批命令带 @Worker（sendApprovalCommand）。
   *  群房间无 mention 的命令 Worker 收不到（QwenPaw _require_mention），
   *  审批卡按钮改走此路径而非裸 onSend 文本。 */
  onSendApproval?: (
    targetMxid: string,
    cmd: string,
    replyTo?: { event_id: string; sender: string; body: string },
  ) => Promise<void> | void;
  /** v0.4.98 再版 9：编辑自己的消息（m.replace 标注替换，Element 同款）。 */
  onSendEdit?: (originalEventId: string, body: string) => Promise<void> | void;
  /** v0.4.98 再版 9：撤回自己的消息（redaction）。 */
  onRedact?: (eventId: string) => Promise<void> | void;
  /** v0.4.98 再版 9：退出房间（顶部 ⋯ 菜单）。 */
  onLeaveRoom?: () => Promise<void> | void;
  /** 8/29 re16：房间重命名（顶部 ⋯ 菜单；Element 同款能力，
   *  权限不足时展示诊断——团队房间权限表普遍 null 为平台侧已知问题）。 */
  onRenameRoom?: (name: string) => void;
  /** v0.4.98 再版 9：房间静音状态 + 切换（m.muted_room account data）。 */
  muted?: boolean;
  onToggleMute?: () => Promise<void> | void;
  /** 发送表情反应（m.reaction）。 */
  onReact?: (eventId: string, emoji: string) => Promise<void> | void;
  /** workflow 卡片点击 → 工作流 tab 选中该项目（8/18 批次 2）。 */
  onOpenProject?: (runId: string) => void;
  /** workflow 卡片干预成功 → 刷新工作流。 */
  onWorkflowIntervened?: () => void;
  /** 项目文件面板（8/18 批次 2，O19 版）：顶部 📁 按钮 → 抽屉。 */
  onOpenProjectFiles?: (room: TeamRoom) => void;
  /** 打开/创建与成员的私聊（头像右键菜单）。 */
  onDm?: (mxid: string, roomId?: string) => void;
  onBack?: () => void;
  /** DM 房间显示"发起任务"按钮（Phase 2 任务向导入口，§6.6〇）。 */
  onNewTask?: () => void;
  /** 向上翻页（父组件 fetch 更早消息并前插）。 */
  onLoadMore?: () => void;
  /** 长轮询收新消息（父组件实现增量拉取）。 */
  onPoll?: () => void;
  /** 房间异常提示（如 404 僵尸房间），非空显示警示条。 */
  errorNote?: string;
  /** 跨房间搜索跳转：变化时尝试定位该事件（已加载则滚动+高亮）。
   *  定位完成后父组件应清除（onJumpHandled），避免重复触发。 */
  jumpToEventId?: string | null;
  onJumpHandled?: () => void;
  /** 成员角色表（B4 成员详情卡）：MXID → 领/工/审/unknown。 */
  memberRoles?: Record<string, string>;
  /** MXID → Worker 容器名（5.0.0-beta.3：成员卡显示审批卡用）。 */
  memberWorkerNames?: Record<string, string>;
  /** v0.5.0-beta.12（A8b）：当前房间对应 Worker 的 phase/runtime 徽章
   *  （1:1 个人房间才有；数据=Worker CR 字段，零新请求）。 */
  workerBadge?: { phase?: string; runtime?: string };
}

export default function RoomChat(props: RoomChatProps) {
  const {
    room,
    messages,
    loading,
    sending,
    hasMore,
    user_id,
    canSend = true,
    onSend,
    onSendFiles,
    onSendApproval,
    onSendEdit,
    onRedact,
    onLeaveRoom,
    onRenameRoom,
    muted = false,
    onToggleMute,
    onReact,
    onDm,
    onBack,
    onNewTask,
    onLoadMore,
    onPoll,
    errorNote,
    jumpToEventId,
    onJumpHandled,
    memberRoles,
    memberWorkerNames,
    workerBadge,
    onOpenProject,
    onWorkflowIntervened,
    onOpenProjectFiles,
  } = props;
  const [draft, setDraft] = React.useState("");
  // v0.4.98 再版 9：编辑模式（Element 同款——banner「正在编辑此消息」+
  // 输入框预填原文；发送=m.replace 替换，Esc/✕ 取消）。
  const [editing, setEditing] = React.useState<{
    event_id: string;
    sender: string;
    body: string;
  } | null>(null);
  // 8/29 re16：重命名（Element 同款）+ 权限诊断。
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [renameValue, setRenameValue] = React.useState("");
  const [powerInfo, setPowerInfo] = React.useState<RoomPowerInfo | null>(null);
  const [powerLoading, setPowerLoading] = React.useState(false);
  const openRename = React.useCallback(() => {
    if (!room) return;
    setRenameValue(room.name);
    setPowerInfo(null);
    setRenameOpen(true);
    if (user_id) {
      setPowerLoading(true);
      fetchRoomPowerInfo(room.room_id, user_id)
        .then(setPowerInfo)
        .catch(() => setPowerInfo(null))
        .finally(() => setPowerLoading(false));
    }
  }, [room, user_id]);
  const composerRef = React.useRef<HTMLTextAreaElement | null>(null);
  // v0.4.98 再版 9：拖拽文件悬停标记（drop zone 高亮，Element 同款）。
  const [dragOver, setDragOver] = React.useState(false);
  // v0.4.81: 输入框高度可上下拖拽调整（用户：「输入框应该可以上下拖动调整高度」）。
  // px 高度持久化 localStorage；范围 48–320，默认 76（≈rows 3）。
  const [composerH, setComposerH] = React.useState<number>(() => {
    try {
      const v = Number(window.localStorage.getItem("agentteams-qwenpaw-workbench:composer-h"));
      return v >= 48 && v <= 320 ? v : 76;
    } catch {
      return 76;
    }
  });
  // v0.4.82: 拖拽中直接改 DOM 高度（不 setState——每帧 setState 会让整个
  // 消息列表重渲染，用户真机反馈「拖拽有延迟」）；松手才提交 state+持久化。
  const composerBoxRef = React.useRef<HTMLDivElement>(null);
  const onComposerResizeStart = React.useCallback(
    (e: ReactNS.MouseEvent) => {
      e.preventDefault();
      const box = composerBoxRef.current;
      if (!box) return;
      const startY = e.clientY;
      const startH = box.offsetHeight;
      const move = (ev: MouseEvent) => {
        const h = Math.min(320, Math.max(48, startH + (startY - ev.clientY)));
        box.style.height = `${h}px`;
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        const h = box.offsetHeight;
        setComposerH(h);
        try {
          window.localStorage.setItem(
            "agentteams-qwenpaw-workbench:composer-h",
            String(h),
          );
        } catch {
          /* storage 不可用：跳过持久化（本次会话仍生效） */
        }
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [],
  );
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);
  // 审批已处理记录：event_id → approve/deny（本地标记，防重复点击）。
  const [resolvedApprovals, setResolvedApprovals] = React.useState<
    Record<string, "approve" | "deny">
  >({});
  // @mention 弹层：null=关闭；否则为当前 @ 后的查询词。
  const [mentionQuery, setMentionQuery] = React.useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = React.useState(0);
  // 未读线：打开房间时最新消息 ts，此后的新消息显示在线下方。
  const [readTs, setReadTs] = React.useState(0);
  // 消息搜索面板（B1，§6.6）。
  const [searchOpen, setSearchOpen] = React.useState(false);
  // 成员详情卡（B4）：选中成员的 MXID，null=关闭。
  const [detailMxid, setDetailMxid] = React.useState<string | null>(null);
  // 工具消息过滤开关（🔧 read_file 之类；默认折叠显示一行，可完全隐藏）。
  const [hideTools, setHideTools] = React.useState(false);
  // 打开的线程：activeThread = 线程面板/抽屉中展示的 root event_id
  // （Element ThreadView 同款：宽屏右侧固定面板，窄屏 antd.Drawer 弹出）。
  // 状态记忆：thread + 面板宽度持久化，重开插件恢复上次展开的话题。
  const THREAD_STATE_KEY = "agentteams-qwenpaw-workbench:thread-state";
  const readThreadState = (): { thread?: string; width?: number } => {
    try {
      const raw = window.localStorage.getItem(THREAD_STATE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as { thread?: string; width?: number };
      return typeof parsed === "object" && parsed ? parsed : {};
    } catch {
      return {};
    }
  };
  const initialThreadState = React.useRef<{
    thread?: string;
    width?: number;
  } | null>(null);
  if (initialThreadState.current === null) {
    initialThreadState.current = readThreadState();
  }
  // 话题面板宽度（拖拽调宽）：默认 340，范围 280-560；状态记忆恢复上次宽度。
  const [panelWidth, setPanelWidthState] = React.useState(
    () =>
      Math.min(
        560,
        Math.max(280, initialThreadState.current?.width || 340),
      ),
  );
  const [activeThread, setActiveThreadState] = React.useState<string | null>(
    initialThreadState.current.thread || null,
  );
  const setActiveThread = React.useCallback(
    (next: string | null) => {
      setActiveThreadState(next);
      try {
        window.localStorage.setItem(
          THREAD_STATE_KEY,
          JSON.stringify({
            thread: next || "",
            width: panelWidth,
          }),
        );
      } catch {
        /* storage 不可用则跳过 */
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [panelWidth],
  );
  // 宽屏判定（≥900px 右侧面板；否则钉钉式 Drawer 弹出）。
  const [isWide, setIsWide] = React.useState(() =>
    typeof window !== "undefined" ? window.innerWidth >= 900 : true,
  );
  React.useEffect(() => {
    const onResize = () => setIsWide(window.innerWidth >= 900);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const setPanelWidth = React.useCallback(
    (next: number | ((prev: number) => number)) => {
      setPanelWidthState((prev) => {
        const value = typeof next === "function" ? next(prev) : next;
        try {
          const cur = readThreadState();
          window.localStorage.setItem(
            THREAD_STATE_KEY,
            JSON.stringify({ ...cur, width: value }),
          );
        } catch {
          /* ignore */
        }
        return value;
      });
    },
    [],
  );
  const [dragging, setDragging] = React.useState(false);
  const dragStartXRef = React.useRef(0);
  const dragStartWRef = React.useRef(340);

  // 拖拽手柄：pointerdown 记录起点 → pointermove 调宽 → pointerup 结束。
  const onPanelHandleDown = React.useCallback(
    (e: ReactNS.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragStartXRef.current = e.clientX;
      dragStartWRef.current = panelWidth;
      setDragging(true);
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      const onMove = (ev: PointerEvent) => {
        const delta = dragStartXRef.current - ev.clientX; // 左拖 = 加宽
        const next = Math.min(
          560,
          Math.max(280, Math.round(dragStartWRef.current + delta)),
        );
        setPanelWidth(next);
      };
      const onUp = () => {
        setDragging(false);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    },
    [panelWidth],
  );
  // 成员面板（Element MemberList 交互：点击成员数打开）。
  const [memberPanelOpen, setMemberPanelOpen] = React.useState(false);
  // 引用回复目标（ReplyPreview 输入框上方回复条）。
  const [replyTo, setReplyTo] = React.useState<{
    event_id: string;
    sender: string;
    body: string;
  } | null>(null);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const hoverTimerRef = React.useRef<number | null>(null);
  const t = useThemeColors();
  const tr = useT();

  // 引用跳转：滚动定位原消息 + 高亮闪烁（Element 同款 permalink 行为）。
  const jumpToMessage = React.useCallback((eventId: string) => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-event-id="${eventId}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.style.transition = "background 0.4s";
    el.style.background = "rgba(255,127,22,0.18)";
    window.setTimeout(() => {
      el.style.background = "transparent";
    }, 1800);
  }, []);

  // 搜索跳转定位区（B1 修复）：目标事件不在已加载窗口（搜索结果多为旧消息）
  // 时，拉 /context 前后文渲染成"定位片段"插在消息流末尾，滚动 + 高亮目标。
  const [jumpContext, setJumpContext] = React.useState<{
    events: RoomMessage[];
    highlightId: string;
  } | null>(null);
  const jumpContextRef = React.useRef<HTMLDivElement | null>(null);
  const clearJumpContext = React.useCallback(() => setJumpContext(null), []);

  const handleSearchJump = React.useCallback(
    async (eventId: string) => {
      // 1. 已在消息流中 → 直接滚动定位 + 高亮。
      const el = listRef.current?.querySelector<HTMLElement>(
        `[data-event-id="${eventId}"]`,
      );
      if (el) {
        jumpToMessage(eventId);
        setJumpContext(null);
        return;
      }
      // 2. 未加载 → 拉上下文 → 定位区 → 滚动。
      if (!room) return;
      try {
        const ctx = await fetchEventContext(room.room_id, eventId, 6);
        const events = [
          ...ctx.events_before,
          ...(ctx.event ? [ctx.event] : []),
          ...ctx.events_after,
        ];
        if (events.length === 0) {
          antd.message.warning(tr("未找到该消息的上下文——可手动加载更早消息后重试"));
          return;
        }
        setJumpContext({ events, highlightId: eventId });
        requestAnimationFrame(() => {
          jumpContextRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
        });
      } catch {
        // 8/18 批次 1：不再静默——定位失败的静默是「点了没反应」的直接来源。
        antd.message.warning(tr("定位失败——原消息上下文拉取出错，可手动加载更早消息后重试"));
      }
    },
    [room, jumpToMessage, tr],
  );

  // 跨房间搜索跳转（B1）：jumpToEventId 变化后轮询定位——切房时消息列表
  // 异步加载，目标事件可能要等几轮才进 DOM；约 2.4s 仍无则走定位区
  // （未加载上下文片段），避免"点了没反应"。
  React.useEffect(() => {
    if (!jumpToEventId) return;
    let cancelled = false;
    let attempts = 0;
    const tryJump = () => {
      if (cancelled) return;
      const el = listRef.current?.querySelector<HTMLElement>(
        `[data-event-id="${jumpToEventId}"]`,
      );
      if (el) {
        jumpToMessage(jumpToEventId);
        onJumpHandled?.();
        return;
      }
      attempts += 1;
      if (attempts >= 8) {
        void handleSearchJump(jumpToEventId);
        onJumpHandled?.();
        return;
      }
      window.setTimeout(tryJump, 300);
    };
    tryJump();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpToEventId, messages, onJumpHandled]);

  const draftKey = room ? `agentteams-qwenpaw-workbench:room-draft:${room.room_id}` : "";

  // 草稿持久化：切换房间时恢复 localStorage 草稿。
  React.useEffect(() => {
    if (!draftKey) {
      setDraft("");
      return;
    }
    try {
      const saved = window.localStorage.getItem(draftKey);
      setDraft(saved || "");
    } catch {
      setDraft("");
    }
  }, [draftKey]);

  // 草稿写入（输入变化即存，发送成功清除）。
  React.useEffect(() => {
    if (!draftKey) return;
    try {
      if (draft) window.localStorage.setItem(draftKey, draft);
      else window.localStorage.removeItem(draftKey);
    } catch {
      /* storage 不可用则跳过 */
    }
  }, [draft, draftKey]);

  const handleSend = React.useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    // v0.4.98 再版 9：编辑模式优先（发送=m.replace 替换，不走新消息链）。
    if (editing) {
      if (!onSendEdit) return;
      const target = editing;
      try {
        await onSendEdit(target.event_id, text);
        setDraft("");
        setEditing(null);
      } catch {
        /* 编辑失败保留草稿和编辑态 */
      }
      return;
    }
    if (!onSend) return;
    const replying = replyTo;
    try {
      await onSend(text, replying || undefined);
      setDraft("");
      setReplyTo(null);
      // 自己发的消息不算"新消息"——未读线随发送下移。
      setReadTs(Date.now());
      // 滚动到底部
      requestAnimationFrame(() => {
        if (listRef.current) {
          listRef.current.scrollTop = listRef.current.scrollHeight;
        }
      });
    } catch {
      /* {tr("发送失败")}保留草稿 */
    }
  }, [draft, onSend, onSendEdit, replyTo, editing]);

  // 审批动作：发带 @Worker 的审批命令 + 本地标记已处理。
  // v0.5.0-beta.10 再版 2：此前裸发 /approval approve（无 @）——群房间
  // _require_mention=True 时 Worker 不消费（真机验证「点允许只是发送」）。
  const handleApprovalAction = React.useCallback(
    async (msg: RoomMessage, action: "approve" | "deny") => {
      if (!onSendApproval) return;
      const appr = parseApproval(msg.body || "");
      if (!appr) return;
      try {
        await onSendApproval(
          msg.sender,
          action === "approve" ? appr.approveCmd : appr.denyCmd,
          {
            event_id: msg.event_id,
            sender: msg.sender,
            body: (msg.body || "").slice(0, 200),
          },
        );
        setResolvedApprovals((prev) => ({ ...prev, [msg.event_id]: action }));
      } catch {
        /* 命令发送失败不标记，用户可重试 */
      }
    },
    [onSendApproval],
  );

  // 产物验收（Phase 4）：接受 → 发确认消息；修改意见 → 发意见消息。
  // Agent 侧 SOUL「交付 → 等验收」流程识别这些回复。
  const handleDeliverable = React.useCallback(
    (msg: RoomMessage, action: "accept" | "revise", text?: string) => {
      if (!onSend) return;
      const name = msg.filename || msg.body || tr("附件");
      const line =
        action === "accept"
          ? `✅ 已验收「${name}」，交付通过，可以收尾。`
          : `📝 「${name}」修改意见：${text || "请重新交付"}`;
      void onSend(line);
    },
    [onSend, tr],
  );

  // 长轮询：每 12s 拉一次新消息（仅在有房间时）。
  React.useEffect(() => {
    if (!room || !onPoll) return;
    const timer = window.setInterval(() => {
      void onPoll();
    }, 12000);
    return () => window.clearInterval(timer);
  }, [room, onPoll]);

  // 桌面通知：新审批消息到达 → 浏览器 Notification（宿主 2.1 无 paw.notify；
  // 集群审批接宿主通知中心需上游插件审批源 PR，本版用浏览器通知兜底）。
  const seenApprovalsRef = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    if (typeof window.Notification === "undefined") return;
    if (window.Notification.permission === "default") {
      // 静默请求一次；拒绝后不再打扰（权限面板可手动改）。
      void window.Notification.requestPermission().catch(() => undefined);
    }
    if (window.Notification.permission !== "granted") return;
    for (const msg of messages) {
      if (msg.msgtype !== "m.text" || !msg.body) continue;
      if (!parseApproval(msg.body)) continue;
      if (seenApprovalsRef.current.has(msg.event_id)) continue;
      seenApprovalsRef.current.add(msg.event_id);
      try {
        new window.Notification(`🛡️ ${tr("工具调用需要审批")}`, {
          body: (msg.body || "").replace(/\*\*/g, "").slice(0, 160),
        });
      } catch {
        /* WebView 不支持时静默 */
      }
    }
  }, [messages]);

  // 新消息到达自动滚到底部（仅当用户本来就在底部附近）。
  React.useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  if (!room) {
    return (
      <antd.Card style={{ borderRadius: CARD_RADIUS }}>
        <antd.Empty description={tr("尚未选择房间")} />
      </antd.Card>
    );
  }

  const myUserId = user_id || "";
  const mentionTargets = Object.entries(room.members || {}).filter(
    ([mxid]) => mxid !== myUserId,
  );
  // 过滤空消息体且无附件的行（Tuwunel 历史里偶有无 body 的 m.text 事件）。
  const visibleMessages = messages.filter((m) => {
    if (!(m.body || m.url) && m.msgtype === "m.text") return false;
    if (hideTools && m.msgtype === "m.text" && isToolMessage(m.body || "")) {
      return false;
    }
    return true;
  });

  // 线程分组（Element/Discord 式）：回复消息归入被回复消息的线程，
  // 不再顶层重复显示——"谁的哪条消息回复谁的"一目了然。
  const threadGroups = React.useMemo(() => {
    const tops: RoomMessage[] = [];
    const repliesOf = new Map<string, RoomMessage[]>();
    for (const m of visibleMessages) {
      const targetId = m.reply?.event_id || "";
      if (
        targetId &&
        visibleMessages.some((x) => x.event_id === targetId)
      ) {
        if (!repliesOf.has(targetId)) repliesOf.set(targetId, []);
        repliesOf.get(targetId)!.push(m);
      } else {
        tops.push(m);
      }
    }
    return { tops, repliesOf };
  }, [visibleMessages]);

  // 线程面板打开的 root 消息 + 回复列表。
  const activeThreadMsg = React.useMemo(() => {
    if (!activeThread) return null;
    return visibleMessages.find((m) => m.event_id === activeThread) || null;
  }, [activeThread, visibleMessages]);
  const activeThreadReplies = React.useMemo(() => {
    if (!activeThread) return [];
    return threadGroups.repliesOf.get(activeThread) || [];
  }, [activeThread, threadGroups]);

  const insertMention = (mxid: string) => {
    const member = room.members?.[mxid];
    const name =
      member?.display_name?.trim() ||
      (mxid.split(":")[0] || mxid).replace(/^@/, "");
    setDraft((d) => (d ? `${d}@${name} ` : `@${name} `));
    setMentionQuery(null);
  };

  // ── @mention 输入弹层（Element 同款交互：@ 触发 / 子串匹配 / ↑↓ Enter Esc）──
  const mentionCandidates = React.useMemo(() => {
    if (mentionQuery === null) return [];
    // 单个 @（空查询）→ 显示全部成员（Element 是输入字符才搜；空查询列全员更友好）。
    const q = mentionQuery.toLowerCase();
    if (q === "") {
      return mentionTargets
        .map(([mxid, member]) => ({ mxid, member, pos: 0, field: "disp" as const }))
        .slice(0, 20);
    }
    return mentionTargets
      .map(([mxid, member]) => {
        const disp = (member?.display_name || "").trim().toLowerCase();
        const local = (mxid.split(":")[0] || mxid).replace(/^@/, "").toLowerCase();
        let pos = disp.indexOf(q);
        let field: "disp" | "local" | null = pos >= 0 ? "disp" : null;
        if (field === null) {
          pos = local.indexOf(q);
          field = pos >= 0 ? "local" : null;
        }
        return { mxid, member, pos, field };
      })
      .filter((c) => c.field !== null)
      .sort(
        (a, b) =>
          (a.pos ?? 0) - (b.pos ?? 0) ||
          (a.field === "disp" ? -1 : 1),
      )
      .slice(0, 20);
  }, [mentionQuery, mentionTargets]);

  const confirmMention = React.useCallback(
    (c: { mxid: string; member?: TeamMember }) => {
      const name =
        c.member?.display_name?.trim() ||
        (c.mxid.split(":")[0] || c.mxid).replace(/^@/, "");
      // 替换输入框末尾的 @query 为 @名字（空格结束）。
      setDraft((d) => d.replace(/@[^@\s]*$/, `@${name} `));
      setMentionQuery(null);
      setMentionIndex(0);
    },
    [],
  );

  const handleDraftChange = React.useCallback(
    (e: ReactNS.ChangeEvent<HTMLTextAreaElement>) => {
      const v = e.target.value;
      setDraft(v);
      const m = /@([^@\s]*)$/.exec(v);
      setMentionQuery(m ? m[1] : null);
      setMentionIndex(0);
    },
    [],
  );

  const handleKeyDown = React.useCallback(
    (e: ReactNS.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.nativeEvent.isComposing) return;
      // @mention 弹层开启时：键盘优先给弹层（↑↓ 循环 / Enter·Tab 确认 / Esc 关闭）。
      if (mentionQuery !== null && mentionCandidates.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMentionIndex((i) => (i + 1) % mentionCandidates.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMentionIndex(
            (i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length,
          );
          return;
        }
        if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
          e.preventDefault();
          confirmMention(mentionCandidates[mentionIndex]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setMentionQuery(null);
          return;
        }
      }
      if (e.key === "Escape" && replyTo) {
        e.preventDefault();
        setReplyTo(null);
        return;
      }
      // v0.4.98 再版 9：Esc 取消编辑（同 Element 语义）。
      if (e.key === "Escape" && editing) {
        e.preventDefault();
        setEditing(null);
        setDraft("");
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [
      handleSend,
      mentionQuery,
      mentionCandidates,
      mentionIndex,
      confirmMention,
      replyTo,
      editing,
    ],
  );

  // 未读线：进入房间时记录当前最新消息 ts。
  React.useEffect(() => {
    const last = messages[messages.length - 1];
    setReadTs(last ? last.origin_server_ts : Date.now());
    setMentionQuery(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.room_id]);

  // 线程面板内容：宽屏右侧固定面板，窄屏 antd.Drawer。
  const threadPanelBody = React.useMemo(() => {
    if (!activeThreadMsg) return null;
    return (
      <ThreadPanelView
        root={activeThreadMsg}
        replies={activeThreadReplies}
        room={room}
        myUserId={myUserId}
        onSendThread={async (text) => {
          if (onSend) await onSend(text, undefined, activeThreadMsg.event_id);
        }}
        onClose={() => setActiveThread(null)}
        onReact={onReact}
        // 主题根/引用原消息可能不在已加载窗口 → handleSearchJump 兜底 /context。
        onJump={(eventId) => void handleSearchJump(eventId)}
      />
    );
  }, [
    activeThreadMsg,
    activeThreadReplies,
    room,
    handleSearchJump,
    myUserId,
    onSend,
    onReact,
    jumpToMessage,
  ]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        // 视口减固定预留（宿主导航 64 + 页头 ~63 + tab 栏 ~38 + 边距）：
        // 聊天室撑满视口，输入区贴屏幕底（v0.4.41 同款经验值）。
        height: "calc(100vh - 230px)",
        minHeight: 420,
      }}
    >
      {/* 顶部栏：返回 + 房间名 + 成员数 + 发起任务 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          paddingBottom: 12,
          borderBottom: "1px solid rgba(0,0,0,0.08)",
          flexWrap: "wrap",
        }}
      >
        {onBack ? (
          <antd.Button size="small" onClick={onBack}>
            ← 返回
          </antd.Button>
        ) : null}
        <antd.Typography.Title level={5} style={{ margin: 0 }}>
          {room.name}
        </antd.Typography.Title>
        {/* v0.5.0-beta.12（A8b）：1:1 Worker 房间头部双徽章（phase + runtime，
            数据=Worker CR 字段，WorkbenchPage 按 room_id 匹配注入）。 */}
        {workerBadge?.phase ? (
          <antd.Tag
            color={
              workerBadge.phase === "Running"
                ? "green"
                : workerBadge.phase === "Sleeping" || workerBadge.phase === "Stopped"
                  ? "orange"
                  : "default"
            }
            style={{ margin: 0 }}
            title={tr("Worker 状态（Controller CR phase）")}
          >
            {workerBadge.phase}
          </antd.Tag>
        ) : null}
        {workerBadge?.runtime ? (
          <antd.Tag
            style={{ margin: 0 }}
            title={tr("Worker 运行时（Controller CR runtime）")}
          >
            {workerBadge.runtime}
          </antd.Tag>
        ) : null}
        <antd.Tag
          color={PRIMARY}
          style={{ margin: 0, cursor: "pointer" }}
          onClick={() => setMemberPanelOpen(true)}
          title={tr("查看成员")}
        >
          {room.member_count} 人
        </antd.Tag>
        {onOpenProjectFiles ? (
          <antd.Button
            size="small"
            onClick={() => onOpenProjectFiles(room)}
            title={tr("项目文件（任务结果/任务书/交付物，O19 产物端点）")}
          >
            📁 {tr("项目文件")}
          </antd.Button>
        ) : null}
        <button
          onClick={() => setSearchOpen(true)}
          title={tr("搜索当前房间历史消息")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            border: `1px solid ${t.border}`,
            background: t.cardBg,
            color: t.textSecondary,
            borderRadius: 16,
            padding: "3px 12px",
            fontSize: 12.5,
            cursor: "pointer",
            transition: "all 0.18s ease",
            lineHeight: "20px",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.borderColor = PRIMARY;
            (e.currentTarget as HTMLElement).style.color = PRIMARY;
            (e.currentTarget as HTMLElement).style.background =
              "rgba(255,127,22,0.08)";
            (e.currentTarget as HTMLElement).style.transform =
              "translateY(-1px)";
          }}
          onMouseLeave={(e) => {
            const el = e.currentTarget as HTMLElement;
            el.style.borderColor = t.border;
            el.style.color = t.textSecondary;
            el.style.background = t.cardBg;
            el.style.transform = "none";
          }}
        >
          <span style={{ fontSize: 14, lineHeight: 1 }}>🔍</span>
          {tr("搜索")}
        </button>
        {/* v0.4.98 再版 9：房间操作（Element 同款能力：静音 + 退出房间）。
            静音=m.muted_room account data（跨客户端状态源；插件通知引擎
            sync_watcher 同数据源消费，静音房间不再触发 @/任务通知）。
            退出=POST /rooms/{id}/leave——scope 房间会被 Controller 调和器
            重新邀请（确认文案提示）。 */}
        {onToggleMute || onLeaveRoom ? (
          <antd.Dropdown
            trigger={["click"]}
            menu={{
              items: [
                ...(onRenameRoom
                  ? [
                      {
                        key: "rename",
                        label: `✏️ ${tr("重命名房间")}`,
                      },
                    ]
                  : []),
                ...(onRenameRoom && (onToggleMute || onLeaveRoom)
                  ? [{ type: "divider" as const }]
                  : []),
                ...(onToggleMute
                  ? [
                      {
                        key: "mute",
                        label: muted
                          ? `🔔 ${tr("取消静音")}`
                          : `🔇 ${tr("静音此房间")}`,
                      },
                    ]
                  : []),
                ...(onLeaveRoom
                  ? [
                      { type: "divider" as const },
                      {
                        key: "leave",
                        danger: true,
                        label: `🚪 ${tr("退出房间")}`,
                      },
                    ]
                  : []),
              ],
              onClick: ({ key }: { key: string }) => {
                if (key === "rename") {
                  openRename();
                } else if (key === "mute") {
                  void onToggleMute?.();
                } else if (key === "leave") {
                  antd.Modal.confirm({
                    title: tr("退出房间「{name}」？", { name: room.name }),
                    content: tr("退出后不再接收该房间消息。系统团队房间可能被 Controller 调和器自动重新邀请；非系统房间需再次被邀请才能进入。"),
                    okText: tr("退出"),
                    okButtonProps: { danger: true },
                    cancelText: tr("返回"),
                    onOk: () => onLeaveRoom?.(),
                  });
                }
              },
            }}
          >
            <antd.Button size="small" type="text">
              ⋯
            </antd.Button>
          </antd.Dropdown>
        ) : null}
        <antd.Switch
          size="small"
          checked={hideTools}
          onChange={setHideTools}
          checkedChildren={`🔧 ${tr("隐藏工具")}`}
          unCheckedChildren={`🔧 ${tr("显示工具")}`}
          title={tr("隐藏/显示 Agent 工具调用消息（read_file 等）")}
        />
        <div style={{ flex: 1 }} />
        {onNewTask && room.member_count <= 2 ? (
          <antd.Button
            size="small"
            type="primary"
            style={{ backgroundColor: PRIMARY, borderColor: PRIMARY }}
            onClick={() => {
              const target =
                Object.keys(room.members || {}).find((m) => m !== myUserId) ||
                "";
              const targetName = target
                ? target.split(":")[0].replace(/^@/, "")
                : room.name;
              setDraft(
                `@${targetName} 你好，我想发起一个新任务：\n\n【任务目标】\n（在这里描述你要做什么，例如：调研竞品 X 的定价策略并输出报告）\n\n【期望产出】\n（例如：一份 Markdown 报告，周五前）\n\n请先确认需求，有不清楚的直接问我。`,
              );
              onNewTask();
            }}
          >
            📋 发起任务
          </antd.Button>
        ) : null}
      </div>

      {/* 主区：左消息流 + 右线程面板（宽屏）；窄屏线程走 Drawer */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            minWidth: 0,
          }}
        >
          {/* 消息流 */}
          <div
        ref={listRef}
        style={{
          flex: 1,
          overflowY: "auto",
          overflowX: "hidden",
          padding: "16px 4px",
          minHeight: 300,
          minWidth: 0,
          // v0.4.98 再版 9：拖拽文件高亮（Element 同款 drop zone）。
          outline: dragOver && onSendFiles ? "2px dashed rgba(255,127,22,0.6)" : "none",
          outlineOffset: -4,
        }}
        onDragOver={
          onSendFiles
            ? (e) => {
                if (e.dataTransfer?.types?.includes("Files")) {
                  e.preventDefault();
                  setDragOver(true);
                }
              }
            : undefined
        }
        onDragLeave={
          onSendFiles
            ? (e) => {
                // 自审：dragleave 在移到子元素时也会触发（高亮闪烁）——
                // 只有真正离开容器才清标记。
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setDragOver(false);
                }
              }
            : undefined
        }
        onDrop={
          onSendFiles
            ? (e) => {
                e.preventDefault();
                setDragOver(false);
                const files = Array.from(e.dataTransfer?.files || []);
                if (files.length > 0) void onSendFiles(files);
              }
            : undefined
        }
      >
        {errorNote ? (
          <div
            style={{
              marginBottom: 12,
              padding: "8px 12px",
              borderRadius: 8,
              background: "rgba(250,140,22,0.08)",
              color: "#fa8c16",
              fontSize: 13,
            }}
          >
            ⚠️ {errorNote}
          </div>
        ) : null}
        {hasMore ? (
          <div style={{ textAlign: "center", paddingBottom: 12 }}>
            <antd.Button size="small" type="link" onClick={onLoadMore}>
              {tr("加载更早的消息 ↑")}
            </antd.Button>
          </div>
        ) : null}
        {visibleMessages.length === 0 ? (
          loading ? (
            <antd.Typography.Text
              type="secondary"
              style={{ display: "block", textAlign: "center", padding: 24 }}
            >
              正在加载消息…
            </antd.Typography.Text>
          ) : (
            <antd.Empty description={tr("还没有消息，发一条打个招呼吧")} />
          )
        ) : (
          <div>
            {threadGroups.tops.map((msg, idx) => {
              const prev = idx > 0 ? threadGroups.tops[idx - 1] : null;
              const sep = wantsDateSeparator(prev, msg);
              const mine = myUserId !== "" && msg.sender === myUserId;
              const isLast = idx === threadGroups.tops.length - 1;
              const showTime = hoveredId === msg.event_id || isLast;
              // v0.4.98 再版 10: Element 同款分组——同一发送者连续消息不
              // 重复头像+名字（Element 最具辨识度的视觉特征）；日期分隔
              // 强制断组（跨天的同发送者也算新组）。
              const sameSender =
                !sep && prev !== null && prev.sender === msg.sender;
              // 未读线：打开房间后新到的消息（ts > readTs）第一条前插线。
              const unreadLine =
                readTs > 0 &&
                msg.origin_server_ts > readTs &&
                (!prev || prev.origin_server_ts <= readTs);
              const replies = threadGroups.repliesOf.get(msg.event_id) || [];
              return (
                <div key={msg.event_id || `${msg.sender}-${msg.origin_server_ts}`}>
                  {unreadLine ? (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        margin: "10px 0",
                      }}
                    >
                      <div
                        style={{
                          flex: 1,
                          borderTop: `1px solid ${PRIMARY}`,
                          opacity: 0.5,
                        }}
                      />
                      <span style={{ fontSize: 12, color: PRIMARY }}>
                        {tr("以下为新消息")}
                      </span>
                      <div
                        style={{
                          flex: 1,
                          borderTop: `1px solid ${PRIMARY}`,
                          opacity: 0.5,
                        }}
                      />
                    </div>
                  ) : null}
                  {sep ? (
                    <antd.Divider
                      plain
                      style={{
                        fontSize: 12,
                        color: t.textSecondary,
                        margin: "16px 0 12px",
                      }}
                    >
                      {dateLabel(msg.origin_server_ts, tr)}
                    </antd.Divider>
                  ) : null}
                  <div
                    data-event-id={msg.event_id}
                    style={{
                      display: "flex",
                      justifyContent: mine ? "flex-end" : "flex-start",
                      padding: "3px 0",
                      position: "relative",
                      // 最近 5 条淡入（新消息视觉反馈；历史消息不重放）。
                      animation:
                        idx >= threadGroups.tops.length - 5
                          ? "wbMsgIn 0.2s ease-out"
                          : undefined,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: mine ? "flex-end" : "flex-start",
                        maxWidth: "82%",
                        minWidth: 0,
                      }}
                    >
                      {sameSender ? (
                        // v0.4.98 再版 10: 组内延续消息——28px 占位对齐
                        // 头像列（gutter），hover 显时间（Element 同款
                        // gutter time；气泡行 onMouseEnter 触发）。
                        <div
                          style={{
                            height: 28,
                            marginBottom: 2,
                            display: "flex",
                            alignItems: "center",
                          }}
                        >
                          <span
                            style={{
                              width: 28,
                              textAlign: "center",
                              fontSize: 11,
                              color: t.textSecondary,
                              opacity: showTime ? 1 : 0,
                              transition: "opacity 0.15s",
                            }}
                          >
                            {formatTime(msg.origin_server_ts)}
                          </span>
                        </div>
                      ) : (
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
                          <SenderAvatar
                            mxid={msg.sender}
                            room={room}
                            myUserId={myUserId}
                            onMention={insertMention}
                            onDm={onDm}
                            workerName={memberWorkerNames?.[msg.sender]}
                            onDetail={(m) => setDetailMxid(m)}
                          />
                          {senderShortName(msg.sender, room)}
                          <span
                            style={{
                              opacity: showTime ? 1 : 0,
                              transition: "opacity 0.15s",
                            }}
                          >
                            {formatTime(msg.origin_server_ts)}
                          </span>
                          {msg.pending ? (
                            <antd.Tooltip title={tr("发送中…")}>
                              <span style={{ color: "#bbb", fontSize: 12 }}>⏳</span>
                            </antd.Tooltip>
                          ) : null}
                          {msg.failed ? (
                            <antd.Tooltip title={tr("发送失败")}>
                              <span
                                style={{
                                  color: "#f5222d",
                                  fontSize: 12,
                                  fontWeight: 700,
                                }}
                              >
                                !
                              </span>
                            </antd.Tooltip>
                          ) : null}
                        </div>
                      )}
                      {msg.reply?.event_id ? (
                        <ReplyBanner
                          msg={msg}
                          room={room}
                          messages={visibleMessages}
                          // handleSearchJump（而非 jumpToMessage）：原消息不在
                          // 已加载窗口时自动拉 /context 定位区，不再静默无反应。
                          onJump={(eventId) => void handleSearchJump(eventId)}
                        />
                      ) : null}
                      <div
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 4,
                          flexDirection: mine ? "row-reverse" : "row",
                        }}
                        onMouseEnter={() => {
                          if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current);
                          hoverTimerRef.current = window.setTimeout(
                            () => setHoveredId(msg.event_id),
                            250,
                          );
                        }}
                        onMouseLeave={() => {
                          if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current);
                          setHoveredId(null);
                        }}
                      >
                        <BubbleBoundary fallback={msg.body || ""}>
                          <MessageBody
                            msg={msg}
                            mine={mine}
                            onApprovalAction={handleApprovalAction}
                            approvalResolved={resolvedApprovals[msg.event_id] || null}
                            onDeliverable={handleDeliverable}
                            onOpenProject={onOpenProject}
                            onWorkflowIntervened={onWorkflowIntervened}
                          />
                        </BubbleBoundary>
                        <ReactionChips
                          reactions={msg.reactions}
                          onReact={
                            onReact ? (emoji) => void onReact(msg.event_id, emoji) : undefined
                          }
                        />
                        {/* hover 操作条：只在消息内容行 hover 显示（头像/名字行不触发）。
                            工具条放在本 div 内（DOM 后代）：鼠标移到工具条上不触发
                            onMouseLeave，消除"闪一下"；absolute 相对行 div 定位。 */}
                        {hoveredId === msg.event_id && !msg.pending && !msg.failed ? (
                        <div
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
                            <div style={{ display: "flex", gap: 2 }}>
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
                              {tr("复制") && "📋 " + tr("复制")}
                            </antd.Button>
                            {/* v0.4.98 再版 9：编辑/撤回自己的消息（Element 同款；
                                Matrix 事件不可变——编辑=m.replace 标注替换，
                                撤回=redaction 红条，他人仅见「已撤回」）。 */}
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
                                  {"✏️ " + tr("编辑")}
                                </antd.Button>
                                <antd.Popconfirm
                                  title={tr("撤回这条消息？其他成员将看到「已撤回」")}
                                  okText={tr("撤回")}
                                  cancelText={tr("返回")}
                                  onConfirm={() =>
                                    void onRedact?.(msg.event_id)
                                  }
                                >
                                  <antd.Button
                                    type="text"
                                    size="small"
                                    danger
                                    style={{ borderRadius: 0, fontSize: 12, fontWeight: 500 }}
                                  >
                                    {"🗑️ " + tr("撤回")}
                                  </antd.Button>
                                </antd.Popconfirm>
                              </>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                      </div>
                    </div>
                  </div>
                  {/* 线程摘要（Element ThreadSummary 同款：N 条回复 + 最后回复头像/名字/内容预览，
                      常显缩进；点击在右侧面板/抽屉打开线程） */}
                  {replies.length > 0 ? (
                    <div style={{ marginLeft: mine ? 0 : 44, marginTop: 3 }}>
                      <div
                        onClick={() => setActiveThread(msg.event_id)}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLElement).style.background =
                            "rgba(255,127,22,0.10)";
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLElement).style.background =
                            t.hoverBg;
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          cursor: "pointer",
                          padding: "3px 8px",
                          borderRadius: 6,
                          background: t.hoverBg,
                          fontSize: 12,
                          maxWidth: 480,
                          transition: "background 0.15s",
                        }}
                      >
                        <span style={{ color: PRIMARY, fontWeight: 600, flexShrink: 0 }}>
                          🧵 {replies.length}
                          {tr("条回复")}
                        </span>
                        {(() => {
                          const last = replies[replies.length - 1];
                          const name = senderShortName(last.sender, room);
                          const preview = (last.body || "").replace(/\n+/g, " ").slice(0, 60);
                          return (
                            <>
                              <antd.Avatar
                                size={18}
                                style={{
                                  backgroundColor: PRIMARY,
                                  fontSize: 10,
                                  flexShrink: 0,
                                }}
                              >
                                {name.slice(0, 1).toUpperCase()}
                              </antd.Avatar>
                              <span style={{ color: t.text, fontWeight: 600, flexShrink: 0 }}>
                                {name}
                              </span>
                              <span
                                style={{
                                  flex: 1,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                  color: t.textSecondary,
                                }}
                              >
                                {preview || "…"}
                              </span>
                            </>
                          );
                        })()}
                        <span style={{ color: "#bbb", fontSize: 11, flexShrink: 0 }}>
                          {activeThread === msg.event_id ? tr("查看中") + " ▸" : tr("查看") + " ▸"}
                        </span>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 搜索跳转定位区（B1 修复）：目标事件不在已加载窗口时，展示
          /context 前后文片段 + 高亮目标 + 关闭；点击结果后滚动至此。 */}
      {jumpContext ? (
        <div
          ref={jumpContextRef}
          style={{
            border: `1px solid ${PRIMARY}`,
            borderRadius: 10,
            padding: "8px 10px",
            background: "rgba(255,127,22,0.05)",
            marginBottom: 8,
            animation: "wbJumpIn 0.3s ease-out",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 6,
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 700, color: PRIMARY }}>
              📌 {tr("搜索定位")}
            </span>
            <span style={{ fontSize: 11.5, color: t.textSecondary, flex: 1 }}>
              {tr("目标消息不在已加载范围，显示前后文片段")}
            </span>
            <antd.Button
              size="small"
              type="text"
              onClick={clearJumpContext}
              style={{ fontSize: 12 }}
            >
              ✕
            </antd.Button>
          </div>
          {jumpContext.events.map((m) => {
            const isTarget = m.event_id === jumpContext.highlightId;
            return (
              <div
                key={m.event_id}
                style={{
                  padding: "6px 10px",
                  borderRadius: 8,
                  marginBottom: 4,
                  fontSize: 12.5,
                  background: isTarget ? "rgba(255,127,22,0.12)" : t.bubbleOther,
                  border: isTarget
                    ? `1px solid ${PRIMARY}`
                    : "1px solid transparent",
                  wordBreak: "break-word",
                  whiteSpace: "pre-wrap",
                }}
              >
                <div
                  style={{
                    color: t.textSecondary,
                    fontSize: 11.5,
                    marginBottom: 2,
                    display: "flex",
                    gap: 6,
                  }}
                >
                  <span style={{ fontWeight: 600, color: t.text }}>
                    {senderShortName(m.sender, room)}
                  </span>
                  {isTarget ? (
                    <span style={{ color: PRIMARY, fontWeight: 700 }}>●</span>
                  ) : null}
                </div>
                <div style={{ color: t.text }}>
                  {m.body.slice(0, 600)}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {/* typing 指示（Element WhoIsTypingTile 同款交互：房间内正在输入提示） */}
      {(room.typing || []).length > 0 ? (
        <div
          style={{
            fontSize: 12,
            color: t.textSecondary,
            fontStyle: "italic",
            padding: "2px 4px",
          }}
        >
          {(room.typing || [])
            .map((mxid) => senderShortName(mxid, room))
            .join("、")}{" "}
          {tr("正在输入…")}
        </div>
      ) : null}

      {/* 底部输入区 */}
      <div
        style={{
          display: "grid",
          gap: 8,
          paddingTop: 12,
          borderTop: `1px solid ${t.border}`,
        }}
      >
        {replyTo ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: t.bubbleMine,
              borderRadius: 8,
              padding: "6px 10px",
              fontSize: 13,
            }}
          >
            <ReplyOutlined style={{ color: PRIMARY, flexShrink: 0 }} />
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#666" }}>
              回复 <b>{replyTo.sender}</b>
              {replyTo.body ? <>：{replyTo.body.slice(0, 80)}</> : null}
            </span>
            <antd.Button
              type="text"
              size="small"
              style={{ fontSize: 12 }}
              title={tr("取消回复")}
              onClick={() => setReplyTo(null)}
            >
              ✕
            </antd.Button>
          </div>
        ) : null}
        {/* v0.4.98 再版 9：编辑 banner（Element 同款「正在编辑此消息」）。 */}
        {editing ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "rgba(255,127,22,0.08)",
              border: "1px solid rgba(255,127,22,0.4)",
              borderRadius: 8,
              padding: "6px 10px",
              fontSize: 13,
            }}
          >
            <span style={{ color: PRIMARY, flexShrink: 0 }}>✏️</span>
            <span
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: "#666",
              }}
            >
              {tr("正在编辑这条消息")}
              {editing.body ? <>：{editing.body.slice(0, 80)}</> : null}
            </span>
            <antd.Button
              type="text"
              size="small"
              style={{ fontSize: 12 }}
              title={tr("取消编辑")}
              onClick={() => {
                setEditing(null);
                setDraft("");
              }}
            >
              ✕
            </antd.Button>
          </div>
        ) : null}
        {mentionTargets.length > 0 ? (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {mentionTargets.map(([mxid, member]) => (
              <antd.Tag
                key={mxid}
                style={{ margin: 0, cursor: "pointer" }}
                onClick={() => insertMention(mxid)}
              >
                @
                {member?.display_name?.trim() ||
                  (mxid.split(":")[0] || mxid).replace(/^@/, "")}
              </antd.Tag>
            ))}
            <span style={{ fontSize: 12, color: "#bbb", alignSelf: "center" }}>
              {tr("点击成员插入 @点名")}
            </span>
          </div>
        ) : null}
        {canSend ? (
          <div style={{ position: "relative" }}>
            {/* @mention 弹层：输入框正上方，Element 同款（圆角只圆上两角）。 */}
            {mentionQuery !== null && mentionCandidates.length > 0 ? (
              <div
                style={{
                  position: "absolute",
                  bottom: "100%",
                  left: 0,
                  right: 0,
                  zIndex: 10,
                  background: t.popoverBg,
                  border: `1px solid ${t.border}`,
                  borderRadius: "8px 8px 0 0",
                  boxShadow: "0 -4px 12px rgba(0,0,0,0.1)",
                  maxHeight: 260,
                  overflowY: "auto",
                  padding: 4,
                }}
                role="listbox"
              >
                {mentionCandidates.map((c, i) => {
                  const name =
                    c.member?.display_name?.trim() ||
                    (c.mxid.split(":")[0] || c.mxid).replace(/^@/, "");
                  return (
                    <div
                      key={c.mxid}
                      role="option"
                      aria-selected={i === mentionIndex}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        confirmMention(c);
                      }}
                      onMouseEnter={() => setMentionIndex(i)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 10px",
                        borderRadius: 6,
                        cursor: "pointer",
                        background:
                          i === mentionIndex ? "rgba(255,127,22,0.1)" : "transparent",
                      }}
                    >
                      <antd.Avatar
                        size={24}
                        style={{ backgroundColor: PRIMARY, fontSize: 12 }}
                      >
                        {name.slice(0, 1).toUpperCase()}
                      </antd.Avatar>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{name}</span>
                      <span style={{ fontSize: 12, color: t.textSecondary, overflow: "hidden", textOverflow: "ellipsis" }}>
                        {c.mxid}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : null}
            {/* v0.4.81: 输入框高度拖拽手柄（上拖加高，下拖收矮）。 */}
            <div
              onMouseDown={onComposerResizeStart}
              title={tr("拖动调整输入框高度")}
              style={{
                height: 10,
                cursor: "row-resize",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 3,
                  borderRadius: 2,
                  background: t.border,
                }}
              />
            </div>
            <div
              ref={composerBoxRef}
              style={{ height: composerH, flexShrink: 0 }}
            >
            <antd.Input.TextArea
              ref={composerRef}
              value={draft}
              rows={3}
              style={{ height: "100%", resize: "none", overflowY: "auto" }}
              placeholder={
                editing
                  ? tr("编辑消息…（Enter 保存，Shift+Enter 换行，Esc 取消编辑）")
                  : replyTo
                    ? tr("发送回复…（Enter 发送，Shift+Enter 换行，Esc 取消回复）")
                    : tr("输入消息，@名字 可以点名成员（Enter 发送，Shift+Enter 换行）")
              }
              onChange={handleDraftChange}
              onKeyDown={handleKeyDown}
            />
            </div>
          </div>
        ) : (
          <div
            style={{
              textAlign: "center",
              fontStyle: "italic",
              color: t.textSecondary,
              padding: "18px 0",
              fontSize: 13,
            }}
          >
            {tr("你没有在此房间发送消息的权限")}
          </div>
        )}
        {canSend ? (
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 4 }}>
            <antd.Popover
              trigger="click"
              placement="topRight"
              content={
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(10, 28px)",
                    gap: 2,
                    width: 300,
                  }}
                >
                  {EMOJI_PANEL.map((emoji) => (
                    <span
                      key={emoji}
                      onClick={() => {
                        setDraft((d) => d + emoji);
                      }}
                      style={{
                        fontSize: 18,
                        cursor: "pointer",
                        textAlign: "center",
                        padding: 2,
                        borderRadius: 4,
                      }}
                      title={emoji}
                    >
                      {emoji}
                    </span>
                  ))}
                </div>
              }
            >
              <antd.Button type="text" size="small" title={tr("表情")}>
                😀
              </antd.Button>
            </antd.Popover>
            {onSendFiles ? (
              <>
                <antd.Tooltip title={tr("发送文件/图片")}>
                  <antd.Button
                    type="text"
                    size="small"
                    icon={<PaperClipOutlined />}
                    loading={sending}
                    onClick={() => fileInputRef.current?.click()}
                  />
                </antd.Tooltip>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const files = Array.from(e.target.files || []);
                    e.target.value = ""; // 重置——同一文件可再次选择
                    if (files.length) void onSendFiles(files);
                  }}
                />
              </>
            ) : null}
            {draft.trim() ? (
              <antd.Button
                loading={sending}
                onClick={() => void handleSend()}
                style={{
                  backgroundColor: PRIMARY,
                  borderColor: PRIMARY,
                  color: "#fff",
                }}
              >
                发送
              </antd.Button>
            ) : null}
          </div>
        ) : null}
      </div>

        </div>
        {isWide && threadPanelBody ? (
          <div
            style={{
              width: panelWidth,
              minWidth: 280,
              maxWidth: 560,
              flexShrink: 0,
              overflow: "hidden",
              display: "flex",
              position: "relative",
              animation: "wbPanelIn 0.18s ease-out",
            }}
          >
            {/* 拖拽手柄：左缘 6px 竖条，横滑调宽（280-560） */}
            <div
              onPointerDown={onPanelHandleDown}
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                width: 6,
                cursor: "col-resize",
                zIndex: 6,
                background: dragging
                  ? "rgba(255,127,22,0.35)"
                  : "transparent",
                transition: "background 0.15s",
                borderLeft: `1px solid ${t.border}`,
              }}
              title={tr("拖动调整宽度")}
            />
            <div
              style={{
                display: "flex",
                flex: 1,
                minWidth: 0,
                minHeight: 0,
                padding: "10px 12px 10px 14px",
              }}
            >
              {threadPanelBody}
            </div>
          </div>
        ) : null}
      </div>

      {/* 窄屏线程：钉钉式 Drawer 弹出 */}
      <antd.Drawer
        open={!isWide && threadPanelBody !== null}
        onClose={() => setActiveThread(null)}
        title={`🧵 ${tr("话题")}`}
        width={Math.min(460, typeof window !== "undefined" ? window.innerWidth * 0.92 : 460)}
        styles={{ body: { padding: 12 } }}
      >
        {threadPanelBody}
      </antd.Drawer>

      {/* 房间内消息搜索（B1）：Drawer 面板，房间过滤 + 上下文预览 + 定位 */}
      {room ? (
        <MessageSearch
          open={searchOpen}
          onClose={() => setSearchOpen(false)}
          roomId={room.room_id}
          onJump={(eventId) => void handleSearchJump(eventId)}
        />
      ) : null}

      {/* 成员面板（Element MemberList 同款交互：成员列表 + @ 提及） */}
      <antd.Drawer
        open={memberPanelOpen}
        onClose={() => setMemberPanelOpen(false)}
        title={`${room.name}（${room.member_count}${tr("人")}）`}
        width={320}
      >
        <div style={{ display: "grid", gap: 6 }}>
          {Object.entries(room.members || {}).map(([mxid, member]) => {
            const name = senderShortName(mxid, room);
            const isMe = mxid === myUserId;
            return (
              <div
                key={mxid}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "6px 8px",
                  borderRadius: 8,
                  background: t.hoverBg,
                }}
              >
                <MxcAvatar
                  url={member?.avatar_url}
                  size={30}
                  style={{ backgroundColor: PRIMARY, flexShrink: 0 }}
                >
                  {name.slice(0, 1).toUpperCase()}
                </MxcAvatar>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: 13,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {name}
                    {isMe ? (
                      <span style={{ color: t.textSecondary, fontSize: 12 }}>（我）</span>
                    ) : null}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: t.textSecondary,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {mxid}
                  </div>
                </div>
                {!isMe ? (
                  <antd.Button
                    size="small"
                    type="text"
                    onClick={() => {
                      insertMention(mxid);
                      setMemberPanelOpen(false);
                    }}
                  >
                    {tr("@ 提及")}
                  </antd.Button>
                ) : null}
                <antd.Button
                  size="small"
                  type="text"
                  title={tr("成员详情")}
                  onClick={() => {
                    setDetailMxid(mxid);
                    setMemberPanelOpen(false);
                  }}
                >
                  ⓘ
                </antd.Button>
              </div>
            );
          })}
        </div>
      </antd.Drawer>

      {/* 8/29 re16：重命名房间（Element 同款）+ 权限诊断 */}
      <antd.Modal
        title={tr("重命名房间")}
        open={renameOpen}
        onCancel={() => setRenameOpen(false)}
        onOk={() => {
          if (!renameValue.trim()) return;
          setRenameOpen(false);
          onRenameRoom?.(renameValue.trim());
        }}
        okText={tr("保存")}
        cancelText={tr("取消")}
        okButtonProps={{
          disabled:
            !renameValue.trim() ||
            (powerInfo !== null && !powerLoading && !powerInfo.canRename),
        }}
      >
        <div style={{ display: "grid", gap: 8 }}>
          <antd.Input
            value={renameValue}
            onChange={(e: { target: { value: string } }) =>
              setRenameValue(e.target.value)
            }
            placeholder={tr("新房间名")}
            maxLength={100}
            autoFocus
          />
          {powerLoading ? (
            <div style={{ fontSize: 12, color: t.textSecondary }}>
              {tr("正在读取房间权限…")}
            </div>
          ) : powerInfo && !powerInfo.canRename ? (
            <antd.Alert
              type="warning"
              showIcon
              style={{ fontSize: 12 }}
              message={
                powerInfo.content
                  ? tr(
                      "权限不足：你 {a}/{b}（改名需 ≥ {b}）。需房间管理员（Manager）提权。",
                      {
                        a: String(powerInfo.myLevel),
                        b: String(powerInfo.nameRequired),
                      },
                    )
                  : tr(
                      "该房间没有有效的权限设置，按默认严格权限执行，无法改名（所有成员均被拒）。Element 的灰色输入框是同一根因，不是 Element 的问题。请管理员修复房间的权限设置后重试。",
                    )
              }
            />
          ) : null}
        </div>
      </antd.Modal>

      {/* 成员详情卡（B4）：身份/角色 + 房间内最近消息 + DM */}
      {detailMxid && room ? (
        <MemberDetail
          mxid={detailMxid}
          displayName={senderShortName(detailMxid, room)}
          avatarUrl={room.members?.[detailMxid]?.avatar_url}
          role={memberRoles?.[detailMxid]}
          workerName={memberWorkerNames?.[detailMxid]}
          onMention={insertMention}
          roomId={room.room_id}
          roomName={room.name}
          onDm={onDm}
          onClose={() => setDetailMxid(null)}
        />
      ) : null}
    </div>
  );
}
