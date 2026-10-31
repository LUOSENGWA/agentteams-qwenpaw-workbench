import {
  type RoomMessage,
  type TeamRoom,
} from "../api";
import { MxcAvatar } from "../MxcAvatar";
import MdText from "./MdText";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { CloseIcon } from "./icons";
import WorkerSessionDot from "./WorkerSessionDot";
import { type WorkerSessionState } from "../workerSessionState";
import {
  PRIMARY,
  formatTime,
  senderShortName,
} from "./RoomChatShared";
import {
  BubbleBoundary,
  ReactionChips,
} from "./RoomChatBubbles";
import { parseAttentionMessage } from "../pending/parse";
import { AttentionDecisionCard } from "./AttentionDecisionCard";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
/** ：话题图标
 * = 消息气泡 + 小旗（currentColor 跟随文字色，替换全 🧵 emoji）。 */
export function ThreadIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      style={{ verticalAlign: "-1px", flexShrink: 0 }}
      aria-hidden="true"
    >
      <path
        d="M2 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H8l-3 2.6V11H4a2 2 0 0 1-2-2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M6.3 4.4v4.4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      <path d="M6.3 4.4h3l-0.9 1 0.9 1h-3z" fill="currentColor" />
    </svg>
  );
}

/** 线程面板内容（Element ThreadView 同款）：root 消息 + 回复列表 + 输入框。
 * 宽屏放右侧固定面板，窄屏放 antd.Drawer——同一组件两种容器。 */
export function ThreadPanelView({
  root,
  replies,
  room,
  myUserId,
  onSendThread,
  onClose,
  onReact,
  onJump,
  workerSessionByMxid,
}: {
  root: RoomMessage;
  replies: RoomMessage[];
  room: TeamRoom | null;
  myUserId: string;
  onSendThread: (text: string) => Promise<void> | void;
  onClose: () => void;
  onReact?: (eventId: string, emoji: string) => Promise<void> | void;
  /** 话题内 Worker 头像角落状态灯（与主列表消息头像同源）。 */
  workerSessionByMxid?: Record<string, WorkerSessionState>;
  /** workflow 卡片点击 → 工作流 tab 选中该项目。 */
  onOpenProject?: (runId: string) => void;
  /** workflow 卡片干预成功 → 刷新工作流。 */
  onWorkflowIntervened?: () => void;
  /** 项目文件面板（）：顶部 📁 按钮 → 抽屉。 */
  onOpenProjectFiles?: (room: TeamRoom) => void;
  onJump?: (eventId: string) => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  const [draft, setDraft] = React.useState("");
  const [sending, setSending] = React.useState(false);

  // 打开话题自动滚到最新回复；开着时新回复到达且已在底部 → 跟随。
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
      setThreadShowJump(false);
      return;
    }
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
      el.scrollTop = el.scrollHeight;
    }
  }, [root.event_id, replies.length]);

  // 话题内 DOM 增高跟随（主列表同款：观察子节点）。
  React.useEffect(() => {
    const el = threadScrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
        el.scrollTop = el.scrollHeight;
      }
    });
    for (const c of Array.from(el.children) as HTMLElement[]) {
      ro.observe(c);
    }
    return () => ro.disconnect();
  }, [root, replies]);

  // 话题内一键置底（与主列表同款，窄面板故无徽章）。
  const [threadShowJump, setThreadShowJump] = React.useState(false);
  const handleThreadScroll = React.useCallback(() => {
    const el = threadScrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    setThreadShowJump(dist >= 120);
  }, []);
  const threadJumpToBottom = React.useCallback(() => {
    const el = threadScrollRef.current;
    if (!el) return;
    // 与主列表同款修——instant 置底（smooth 目标漂移）。
    el.scrollTop = el.scrollHeight;
    setThreadShowJump(false);
  }, []);

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
        <span
          style={{
            fontSize: 14,
            fontWeight: 700,
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
          }}
        >
          <ThreadIcon size={15} /> {tr("话题")}
        </span>
        <span style={{ fontSize: 12, color: t.textSecondary }}>
          {replies.length}
          {tr("条回复")}
        </span>
        <div style={{ flex: 1 }} />
        <antd.Button type="text" size="small" onClick={onClose} title={tr("关闭话题")}>
          <CloseIcon size={12} />
        </antd.Button>
      </div>
      {/* relative wrapper = 话题内一键置底按钮锚点。 */}
      <div
        style={{
          position: "relative",
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          minWidth: 0,
          maxWidth: "100%",
        }}
      >
      <div
        ref={threadScrollRef}
        onScroll={handleThreadScroll}
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
            {/* 话题根消息头像角落状态灯（Worker 才有）。 */}
            <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
              <MxcAvatar
                url={room?.members?.[root.sender]?.avatar_url}
                size={20}
                style={{ backgroundColor: PRIMARY, fontSize: 10, flexShrink: 0 }}
              >
                {senderShortName(root.sender, room).slice(0, 1).toUpperCase()}
              </MxcAvatar>
              {workerSessionByMxid?.[root.sender] ? (
                <WorkerSessionDot state={workerSessionByMxid[root.sender]} size={6} corner />
              ) : null}
            </span>
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
          {/* P0 人工介入闭环：话题根是 ATTENTION_* 请求（非本人发的）→
          紧凑决策卡（正文已在上，卡只留操作行）。stopPropagation——
          话题根整块可点跳原消息，卡内作答不触发跳转。 */}
          {root.sender !== myUserId &&
          parseAttentionMessage(root.body || "") ? (
            <div onClick={(e) => e.stopPropagation()}>
              <AttentionDecisionCard msg={root} room={room} compact />
            </div>
          ) : null}
          {onReact ? (
            <ReactionChips
              reactions={root.reactions}
              eventId={root.event_id}
              onReact={(id, emoji) => void onReact(id, emoji)}
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
                      /* 话题回复头像角落状态灯。 */
                      <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
                        <MxcAvatar
                          url={room?.members?.[r.sender]?.avatar_url}
                          size={20}
                          style={{ backgroundColor: PRIMARY, fontSize: 10, flexShrink: 0 }}
                        >
                          {senderShortName(r.sender, room).slice(0, 1).toUpperCase()}
                        </MxcAvatar>
                        {workerSessionByMxid?.[r.sender] ? (
                          <WorkerSessionDot state={workerSessionByMxid[r.sender]} size={6} corner />
                        ) : null}
                      </span>
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
                  {/* P0 人工介入闭环：话题回复也是 ATTENTION_* 请求（非本人发的）→
                  紧凑决策卡。回复块无整块 onClick，无需 stopPropagation。 */}
                  {!rMine && parseAttentionMessage(r.body || "") ? (
                    <AttentionDecisionCard msg={r} room={room} compact />
                  ) : null}
                  {onReact ? (
                    <ReactionChips
                      reactions={r.reactions}
                      eventId={r.event_id}
                      onReact={(id, emoji) => void onReact(id, emoji)}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {/* 纯 div 圆（弃 antd Button——CSS 对抗 inline 尺寸致纵向拉长），32×32 恒圆。 */}
      {threadShowJump ? (
        <div
          role="button"
          aria-label={tr("回到最新消息")}
          title={tr("回到最新消息")}
          onClick={threadJumpToBottom}
          style={{
            position: "absolute",
            right: 10,
            // safe-area：notch/手势条设备上抬高到安全区之上
            bottom: "max(8px, env(safe-area-inset-bottom))",
            zIndex: 5,
            width: 32,
            height: 32,
            boxSizing: "border-box",
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: PRIMARY,
            color: "#fff",
            border: `1px solid ${PRIMARY}`,
            boxShadow: "0 2px 8px rgba(0,0,0,0.20)",
            fontSize: 14,
            lineHeight: 1,
            cursor: "pointer",
          }}
        >
          ↓
        </div>
      ) : null}
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
            className="wb-touch-lg"
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
