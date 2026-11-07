// 单条消息行（任务 D 拆分自 RoomChat turn 循环体，JSX 逐句搬迁）。
// React.memo 默认浅比较——全部 props 须引用稳定（调用方派生布尔/
// 常量 EMPTY_REPLIES fallback；回调/表/主题色均经 useCallback/useMemo
// 稳定，见 RoomChatMessages 行内展开）。
import type * as ReactNS from "react";
import {
  type RoomMessage,
  type TeamRoom,
  type WorkflowEvent,
} from "../api";
import WorkerSessionDot from "./WorkerSessionDot";
import { type WorkerSessionState } from "../workerSessionState";
import { WbTooltip } from "./WbTooltip";
import {
  PRIMARY,
  TOUCH_ONLY,
  senderShortName,
  formatTime,
  dateLabel,
} from "./RoomChatShared";
import {
  ReplyBannerMemo,
  ReactionChips,
  SenderAvatarMemo,
  BubbleBoundary,
  MessageBodyMemo,
} from "./RoomChatBubbles";
import RoomChatMessageToolbar from "./RoomChatMessageToolbar";
import { ThreadIcon } from "./RoomChatThread";
import { MediaViewer } from "./MediaViewer";
import { collectGallery, type GalleryItem } from "../lib/mediaGallery";
import type { ThemeColors } from "../theme";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
// 宿主 antdIcons 可能非全量（部署版 vs SC main 差异）——缺图标降级为空组件，
// 避免 React #130（undefined 组件）拖垮聊天室（同 RoomChatBubbles/Composer 模式）。
const icons = (host.antdIcons || {}) as Record<string, ReactNS.ComponentType>;
const EmptyIcon = (() => null) as unknown as ReactNS.FC<Record<string, unknown>>;
const icon = (name: string): ReactNS.FC<Record<string, unknown>> =>
  (icons[name] as ReactNS.FC<Record<string, unknown>>) || EmptyIcon;
const LoadingOutlined = icon("LoadingOutlined");

export interface RoomChatMessageRowProps {
  msg: RoomMessage;
  /** 行在 tops 内的绝对索引（派生值全部由调用方算好传入）。 */
  idx: number;
  /** tops 总长（最近 5 条淡入判定）。 */
  topsLen: number;
  sep: boolean;
  sameSender: boolean;
  unreadLine: boolean;
  absorbedTool: boolean;
  /** 思考过程 notice（isThinkingNotice）：正文已并入过程折叠条，行只留锚点。 */
  absorbedThinking?: boolean;
  mine: boolean;
  /** hoveredId === msg.event_id（调用方算好——memo 浅比较对 boolean 友好）。 */
  hovered: boolean;
  showTime: boolean;
  replies: RoomMessage[];
  activeThread: string | null;
  room: TeamRoom;
  myUserId: string;
  t: ThemeColors;
  tr: (text: string, vars?: Record<string, string | number>) => string;
  workerSessionByMxid?: Record<string, WorkerSessionState>;
  memberWorkerNames?: Record<string, string>;
  workerRuntimeByMxid?: Record<string, string>;
  visibleMessages: RoomMessage[];
  liveByRunId: Map<string, WorkflowEvent>;
  teamName: string | null;
  resolvedApprovals: Record<string, "approve" | "deny">;
  onReact?: (eventId: string, emoji: string) => Promise<void> | void;
  onDm?: (mxid: string, roomId?: string) => void;
  onOpenWorkerChats?: (worker: string) => void;
  onOpenProject?: (runId: string) => void;
  onWorkflowIntervened?: () => void;
  onRedact?: (eventId: string) => Promise<void> | void;
  onLoadOriginal?: (eventId: string) => Promise<"found" | "exhausted" | "cancelled">;
  setHoveredId: ReactNS.Dispatch<ReactNS.SetStateAction<string | null>>;
  hoverTimerRef: ReactNS.MutableRefObject<number | null>;
  insertMention: (mxid: string) => void;
  openDetailMxid: (m: string) => void;
  jumpWithEnsure: (eventId: string) => Promise<void>;
  handleApprovalAction: (msg: RoomMessage, action: "approve" | "deny") => void;
  handleDeliverable: (msg: RoomMessage, action: "accept" | "revise", text?: string) => void;
  setReplyTo: ReactNS.Dispatch<
    ReactNS.SetStateAction<{ event_id: string; sender: string; body: string } | null>
  >;
  setEditing: ReactNS.Dispatch<
    ReactNS.SetStateAction<{ event_id: string; sender: string; body: string } | null>
  >;
  setDraft: ReactNS.Dispatch<ReactNS.SetStateAction<string>>;
  composerRef: ReactNS.MutableRefObject<HTMLTextAreaElement | null>;
  setActiveThread: (id: string | null) => void;
}

function RoomChatMessageRow(props: RoomChatMessageRowProps) {
  const {
    msg,
    idx,
    topsLen,
    sep,
    sameSender,
    unreadLine,
    absorbedTool,
    absorbedThinking,
    mine,
    hovered,
    showTime,
    replies,
    activeThread,
    room,
    myUserId,
    t,
    tr,
    workerSessionByMxid,
    memberWorkerNames,
    workerRuntimeByMxid,
    visibleMessages,
    liveByRunId,
    teamName,
    resolvedApprovals,
    onReact,
    onDm,
    onOpenWorkerChats,
    onOpenProject,
    onWorkflowIntervened,
    onRedact,
    onLoadOriginal,
    setHoveredId,
    hoverTimerRef,
    insertMention,
    openDetailMxid,
    jumpWithEnsure,
    handleApprovalAction,
    handleDeliverable,
    setReplyTo,
    setEditing,
    setDraft,
    composerRef,
    setActiveThread,
  } = props;
  // live workflow 事件（controller 正源，按 runId 匹配）——气泡 live overlay。
  const live = msg.workflow?.runId
    ? (liveByRunId.get(msg.workflow.runId) ?? null)
    : null;
  // 图片灯箱：点开时按 current visibleMessages 现场算「同发送者连续图片」
  // 画廊（快照保存）——之后轮询追加消息不会把已打开的画廊序列改掉。
  const [viewer, setViewer] = React.useState<{
    items: GalleryItem[];
    index: number;
  } | null>(null);
  const openMedia = React.useCallback(
    (eventId: string) => {
      const gallery = collectGallery(visibleMessages, eventId);
      if (gallery) setViewer(gallery);
    },
    [visibleMessages],
  );
  const closeViewer = React.useCallback(() => setViewer(null), []);
  const changeViewerIndex = React.useCallback((index: number) => {
    setViewer((prev) => (prev ? { ...prev, index } : prev));
  }, []);

  return (
    <div>
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
      {/* 日期分隔 Element 同款居中胶囊
（旧 antd.Divider 通栏线太散，与扁平消息行不搭）。 */}
      {sep ? (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            margin: "14px 0 10px",
          }}
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
            {dateLabel(msg.origin_server_ts, tr)}
          </span>
        </div>
      ) : null}
      {absorbedTool || absorbedThinking ? (
        <div data-event-id={msg.event_id} />
      ) : (
        // 触屏 tap 切换操作条挂在行上（原内层气泡容器 onClick 上移——
        // 内外双触发互抵修复）；hover 计时器仍留内层（工具条 DOM 后代
        // 不触发 onMouseLeave，消除"闪一下"）。
        <div
          data-event-id={msg.event_id}
          className="wb-msg-row"
          onClick={() => {
            if (TOUCH_ONLY)
              setHoveredId((prev) =>
                prev === msg.event_id ? null : msg.event_id,
              );
          }}
          style={{
            display: "flex",
            justifyContent: mine ? "flex-end" : "flex-start",
            // hover 行整体浅底圆角——扁平消息行的唯一框感来源。
            padding: "3px 6px",
            borderRadius: 8,
            background: hovered ? t.bubbleOther : "transparent",
            position: "relative",
            // 最近 5 条淡入（新消息视觉反馈；历史消息不重放）。
            animation:
              idx >= topsLen - 5
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
              // 组内延续消息——28px 占位对齐头像列（gutter），hover 显时间
              // （Element 同款 gutter time；气泡行 onMouseEnter 触发）。
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
                <span
                  style={{
                    opacity: showTime ? 1 : 0,
                    transition: "opacity 0.15s",
                  }}
                >
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
                    <span
                      style={{
                        color: "#f5222d",
                        fontSize: 12,
                        fontWeight: 700,
                      }}
                    >
                      !
                    </span>
                  </WbTooltip>
                ) : null}
              </div>
            )}
            {msg.reply?.event_id ? (
              <ReplyBannerMemo
                msg={msg}
                room={room}
                messages={visibleMessages}
                // jumpWithEnsure（而非裸 handleSearchJump）：目标不在
                // 当前渲染窗时先扩窗覆盖再定位；原消息不在已加载
                // 窗口时仍自动拉 /context 定位区（链内兜底不变）。
                onJump={jumpWithEnsure}
                onLoadOriginal={onLoadOriginal}
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
                <MessageBodyMemo
                  msg={msg}
                  mine={mine}
                  onApprovalAction={handleApprovalAction}
                  approvalResolved={resolvedApprovals[msg.event_id] || null}
                  onDeliverable={handleDeliverable}
                  onOpenProject={onOpenProject}
                  onWorkflowIntervened={onWorkflowIntervened}
                  live={live}
                  fileRefTeam={teamName}
                  room={room ?? null}
                  onOpenMedia={openMedia}
                />
              </BubbleBoundary>
              <ReactionChips
                reactions={msg.reactions}
                eventId={msg.event_id}
                onReact={onReact}
              />
              {/* hover 操作条（独立子组件 RoomChatMessageToolbar：快捷表情 +
回复/复制/编辑/撤回；absolute 相对行 div；DOM 后代关系保住 hover 不闪；
44px 触控档见 index.tsx .wb-touch 块）。 */}
              {hovered && !msg.pending && !msg.failed ? (
                <RoomChatMessageToolbar
                  msg={msg}
                  mine={mine}
                  room={room}
                  t={t}
                  tr={tr}
                  onReact={onReact}
                  onRedact={onRedact}
                  setReplyTo={setReplyTo}
                  setEditing={setEditing}
                  setDraft={setDraft}
                  composerRef={composerRef}
                />
              ) : null}
            </div>
          </div>
        </div>
      )}
      {/* 线程摘要（Element ThreadSummary 同款：N 条回复 + 最后回复头像/名字/内容预览，
常显缩进；点击在右侧面板/抽屉打开线程） */}
      {replies.length > 0 ? (
        <div style={{ marginLeft: mine ? 0 : 44, marginTop: 3 }}>
          <div
            className="wb-thread-summary"
            onClick={() => setActiveThread(msg.event_id)}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background =
                "color-mix(in srgb, var(--app-accent, #FF7F16) 10%, transparent)";
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
            <span
              style={{
                color: PRIMARY,
                fontWeight: 600,
                flexShrink: 0,
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <ThreadIcon size={13} /> {replies.length}
              {tr("条回复")}
            </span>
            {(() => {
              const last = replies[replies.length - 1];
              const name = senderShortName(last.sender, room);
              const preview = (last.body || "").replace(/\n+/g, " ").slice(0, 60);
              return (
                <>
                  {/* 线程摘要最后回复人头像角落灯。 */}
                  <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
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
                    {workerSessionByMxid?.[last.sender] ? (
                      <WorkerSessionDot state={workerSessionByMxid[last.sender]} size={6} corner />
                    ) : null}
                  </span>
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
            <span style={{ color: t.textSecondary, fontSize: 11, flexShrink: 0 }}>
              {activeThread === msg.event_id ? tr("查看中") + " ▸" : tr("查看") + " ▸"}
            </span>
          </div>
        </div>
      ) : null}
      {/* 应用内灯箱（portal 到 body）：行卸载即关闭，不影响消息流。 */}
      {viewer ? (
        <MediaViewer
          items={viewer.items}
          index={viewer.index}
          onClose={closeViewer}
          onIndexChange={changeViewerIndex}
        />
      ) : null}
    </div>
  );
}

// 行级 memo（任务 D §2.1）：默认浅比较——调用方保证 props 引用稳定
// （t 经 useThemeColors useMemo；回调 useCallback；表 useMemo；
// replies 空值走 EMPTY_REPLIES 常量；派生量全 boolean/number）。
export default React.memo(RoomChatMessageRow);
