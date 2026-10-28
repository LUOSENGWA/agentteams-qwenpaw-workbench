import type * as ReactNS from "react";
import {
  type AttentionItem,
  type RoomMessage,
  type TeamRoom,
} from "../api";
import { MxcAvatar } from "../MxcAvatar";
import { FileRefPicker } from "./FileRefPicker";
import { type FileRef } from "../lib/file-refs";
import MessageSearch from "./MessageSearch";
import MemberDetail from "./MemberDetail";
import RoomInfoDrawer from "./RoomInfoDrawer";
import {
  type WorkerInfo,
  type WorkflowEvent,
} from "../api";
import {
  CloseIcon,
  EditIcon,
  TodoIcon,
  TrashIcon,
  WarnIcon,
  PinIcon,
} from "./icons";
import WorkerSessionDot from "./WorkerSessionDot";
import { type WorkerSessionState } from "../workerSessionState";
import { WbTooltip } from "./WbTooltip";
import {
  PRIMARY,
  TOUCH_ONLY,
  QUICK_REACTIONS,
  senderShortName,
  formatTime,
  dateLabel,
  wantsDateSeparator,
} from "./RoomChatShared";
import {
  ReplyBannerMemo,
  ReactionChips,
  SenderAvatarMemo,
  BubbleBoundary,
  MessageBodyMemo,
} from "./RoomChatBubbles";
import {ThreadIcon } from "./RoomChatThread";
import {useRoomChatCore } from "./RoomChatCore";
import type {RoomChatCoreState } from "./RoomChatCore";
import { applyContextWindow } from "../jumpContextWindow";
import {RoomChatHeader } from "./RoomChatHeader";
import {RoomChatComposer } from "./RoomChatComposer";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

export interface RoomChatProps {
  room: TeamRoom | null;
  messages: RoomMessage[];
  loading?: boolean;
  sending?: boolean;
  /** 是否还有更早的消息（分页）。 */
  hasMore?: boolean;
  /** 父侧「更早消息」加载中（顶部预载提示 + 防并发）。 */
  loadingMore?: boolean;
  /** 当前登录用户 MXID（自己的消息右对齐）。 */
  user_id?: string;
  /** 是否允许发消息；false 时整个输入区替换为居中提示条（Element 同款语义）。 */
  canSend?: boolean;
  /** 发送文本消息；replyTo 非空时作为引用回复发送；threadRoot 非空时
 * 作为线程回复（m.thread）发送到该线程；fileRefs 非空时把团队共享
 * 文件引用（#87）挂到出站 content（com.agentteams.file_refs 信封）。 */
  onSend?: (
    text: string,
    replyTo?: { event_id: string; sender: string; body: string },
    threadRoot?: string,
    fileRefs?: FileRef[],
  ) => Promise<void> | void;
  /** 发送文件/图片（上传 → m.file/m.image 消息）。 */
  onSendFiles?: (files: File[]) => Promise<void> | void;
  /** 审批命令带 @Worker（sendApprovalCommand）。
 * 群房间无 mention 的命令 Worker 收不到（QwenPaw _require_mention），
 * 审批卡按钮改走此路径而非裸 onSend 文本。 */
  onSendApproval?: (
    targetMxid: string,
    cmd: string,
    replyTo?: { event_id: string; sender: string; body: string },
  ) => Promise<void> | void;
  /** 编辑自己的消息（m.replace 标注替换，Element 同款）。 */
  onSendEdit?: (originalEventId: string, body: string) => Promise<void> | void;
  /** 撤回自己的消息（redaction）。 */
  onRedact?: (eventId: string) => Promise<void> | void;
  /** 退出房间（房间详情 Drawer；forget=true 退出并删除/忘记）。 */
  onLeaveRoom?: (forget?: boolean) => Promise<void> | void;
  /** 房间重命名（房间详情 Drawer；Element 同款能力，
 * 权限不足时展示诊断——团队房间权限表普遍 null 为平台侧已知问题）。 */
  onRenameRoom?: (name: string) => Promise<void> | void;
  /** 房间静音状态 + 切换（m.muted_room account data）。 */
  muted?: boolean;
  onToggleMute?: () => Promise<void> | void;
  /** 发送表情反应（m.reaction）。 */
  onReact?: (eventId: string, emoji: string) => Promise<void> | void;
  /** workflow 卡片点击 → 工作流 tab 选中该项目。 */
  onOpenProject?: (runId: string) => void;
  /** ：live 工作流事件（controller 正源，15s 轮询）——
 * 聊天内 workflow 卡片按 runId 匹配做 live overlay（状态/步骤/Worker 实时）。
 * WorkbenchPage 仅在正源轨（workflowSource=controller）时传入；降级轨传空
 * （events=原始卡重解析=快照恒等，overlay 无增量且会误导 LIVE 徽标）。 */
  liveWorkflows?: WorkflowEvent[];
  /** ：当前房间匹配的项目
 * （roomMatchesProject 同源，父组件算好传入）——composer 上方任务
 * 进度 + HITL 内联轨；无匹配/项目终态时组件自身不渲染。 */
  activityProject?: WorkflowEvent | null;
  /** ：向父组件上报话题面板
 * 占用（inline 面板吃宽；drawer 覆盖层不吃）。父组件将其计入
 * 单/双栏判定——此前未计入：开着话题把窗口拖窄时聊天区早已
 * 局促但判定不触发，要继续收窄才切单栏。open=false 时 width 忽略。 */
  onThreadPanelLayout?: (open: boolean, width: number) => void;
  /** workflow 卡片干预成功 → 刷新工作流。 */
  onWorkflowIntervened?: () => void;
  /** 项目文件面板（）：顶部 📁 按钮 → 抽屉。 */
  onOpenProjectFiles?: (room: TeamRoom) => void;
  /** 打开/创建与成员的私聊（头像右键菜单）。 */
  onDm?: (mxid: string, roomId?: string) => void;
  onBack?: () => void;
 /** ：顶栏最左
 * 前置节点（Element 汉堡位）——WorkbenchPage 宽屏收起列表时把
 * 「☰ 房间列表」按钮传进来，不再 absolute 浮在聊天区左上角压住返回键。 */
  headerPrefix?: ReactNS.ReactNode;
  /** 头像「查看会话」→ 父组件打开 WorkerChats 抽屉（会话窗与聊天区
 * 解耦为兄弟视图：SSE 消息 tick 只刷新抽屉，不触发聊天整树重渲）。 */
  onOpenWorkerChats?: (worker: string) => void;
  /** DM 房间显示"发起任务"按钮（Phase 2 任务向导入口，〇）。 */
  onNewTask?: () => void;
  /** 向上翻页（父组件 fetch 更早消息并前插）。 */
  onLoadMore?: () => void;
  /** 长轮询收新消息（父组件实现增量拉取）。 */
  onPoll?: () => void;
  /** 房间异常提示（如 404 僵尸房间），非空显示警示条。 */
  errorNote?: string;
  /** 跨房间搜索跳转：变化时尝试定位该事件（已加载则滚动+高亮）。
 * 定位完成后父组件应清除（onJumpHandled），避免重复触发。 */
  jumpToEventId?: string | null;
  onJumpHandled?: () => void;
  /** 成员角色表（成员详情卡）：MXID → 领/工/审/unknown。 */
  memberRoles?: Record<string, string>;
  /** MXID → Worker 容器名（5.0.0-beta.3：成员卡显示审批卡用）。 */
  memberWorkerNames?: Record<string, string>;
  /** ：MXID → runtime（头像「查看会话」入口门控）。 */
  workerRuntimeByMxid?: Record<string, string>;
  /** 当前房间对应 Worker 的 phase/runtime 徽章
 * （1:1 个人房间才有；数据=Worker CR 字段，零新请求）。 */
  workerBadge?: { phase?: string; runtime?: string };
  /** 当前房间对应 Worker 的 session 状态
 * （1:1 个人房间才有；typing/last_ts 派生，零新请求）。 */
  sessionState?: WorkerSessionState;
  /** 全部 Worker MXID——团队房间任一 Worker 正在输入则显蓝点。 */
  workerMxids?: Set<string>;
 /** （落点：聊天群内）：Worker MXID → 任务状态（头像角落灯；
 * 心跳优先派生，人类发送者无映射 → 不显）。 */
  workerSessionByMxid?: Record<string, WorkerSessionState>;
 /** ：Worker 列表——头像抽屉「查看会话」
 * （WorkerChats fixedWorker 模式）的数据源。 */
  workers?: WorkerInfo[];
  /** ：引用条「加载原消息」——
 * 链式向前分页把原消息拉进时间线；返回是否找到（找不到由 UI 落
 * /context 定位区兜底）。
 * 调用后只 kickstart 一页，其余页由
 * 滚动驱动（触顶 40px 触发 + 停顶自动续拉，见下方 useLayoutEffect）。 */
  onLoadOriginal?: (
    eventId: string,
  ) => Promise<"found" | "exhausted" | "cancelled">;
  /** 正在回填的原消息 event_id（引用条显示
 * 「正在加载原消息…」；非空时停在顶部会自动续拉分页）。 */
  pendingOriginal?: string | null;
  /** attention 待决策项（父组件已过滤已答/已解决；deployed=false 不传）——
 * 房间标题栏 pill（L3 入口）数据源，按 room_id 匹配当前房间。 */
  attentionPending?: AttentionItem[];
  /** 房间标题栏 attention pill 点击 → 父组件打开全局待决策弹窗并定位该房间第一条。 */
  onOpenRoomAttention?: (room: TeamRoom) => void;
}
function RoomChat(props: RoomChatProps) {
  const c = useRoomChatCore(props);
  if (!props.room) {
    return c as ReactNS.ReactElement;
  }
  const core = c as RoomChatCoreState;
  const {
    room,
    loading,
    hasMore,
    loadingMore,
    onSendFiles,
    onRedact,
    onReact,
    onDm,
    onOpenWorkerChats,
    errorNote,
    memberRoles,
    memberWorkerNames,
    workerRuntimeByMxid,
    workerSessionByMxid,
    onOpenProject,
    onWorkflowIntervened,
    onLoadOriginal,
    setDraft,
    setFileRefs,
    refPickerOpen,
    setRefPickerOpen,
    setEditing,
    renameOpen,
    setRenameOpen,
    renameValue,
    setRenameValue,
    powerInfo,
    powerLoading,
    dragOver,
    setDragOver,
    hoveredId,
    setHoveredId,
    resolvedApprovals,
    readTs,
    searchOpen,
    setSearchOpen,
    detailMxid,
    setDetailMxid,
    panelWidth,
    activeThread,
    isWide,
    dragging,
    memberPanelOpen,
    setMemberPanelOpen,
    roomInfoOpen,
    setRoomInfoOpen,
    setReplyTo,
    stickToBottom,
    jumpContext,
    liveByRunId,
    teamName,
    composerRef,
    threadOpenedInNarrowRef,
    setActiveThread,
    onPanelHandleDown,
    listRef,
    hoverTimerRef,
    revealWindow,
    kickLoadMore,
    openRename,
    t,
    tr,
    jumpContextRef,
    clearJumpContext,
    handleSearchJump,
    handleApprovalAction,
    handleDeliverable,
    myUserId,
    visibleMessages,
    threadGroups,
    insertMention,
    openDetailMxid,
    threadPanelBody,
    compactHeader,
    narrow,
  } = core;
  // 房间详情刷新信号：重命名完成后 bump → RoomInfoDrawer 重拉房间信息。
  const [roomInfoRefreshTick, setRoomInfoRefreshTick] = React.useState(0);
  // 定位区上下文片段折叠窗：默认只渲染目标 ±2（applyContextWindow）；
  // 新的定位上下文进来时恒复位折叠（新片段从 ±2 窗开始，不继承旧展开态）。
  const [jumpContextExpanded, setJumpContextExpanded] = React.useState(false);
  React.useEffect(() => {
    setJumpContextExpanded(false);
  }, [jumpContext]);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
 // 撑满容器（Element 模型）——
        // 父链已全程定高：wb-main(shellH 实测) → 内容区 flex:1 min-0 →
        // Tabs/content-holder/content → tabpane-active(height:100% min-0)
        // → 分栏行 height:100% → 右栏 flex:1 min-0（窄屏模式 RoomChat 直挂
        // tabpane，同款定高）。12.x 的 calc(100vh-230px)+minHeight:420 在
        // OS 窗口小于屏幕时撑破容器 → 整页滚 + 顶栏 flexWrap 时进一步溢出。
        height: "100%",
        minWidth: 0,
      }}
    >
      {/* 顶部栏：窄屏走紧凑头（1 行，次要控件进 ⋯ 菜单）；宽屏走完整头部 */}
      {narrow ? compactHeader : (
      <RoomChatHeader p={props} c={core} />
      )}

      {/* 主区：左消息流 + 右线程面板（宽屏）；窄屏线程走 Drawer */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* 15.14：左列补 minHeight:0——flex 高度链断点（教训 #615 同款）：
 缺它时列的自动最小高=内容最小高，列表 minHeight:300 会穿透撑破
 列 → RoomChat 根溢出 → tabpane（overflow auto）出现整页滚动 →
 「拖聊天页时输入框跟着动」（真机反馈）。补上后列恒=分配高，
 滚动只发生在列表内部，输入框钉在列底。 */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            minWidth: 0,
            minHeight: 0,
          }}
        >
          {/* 消息流（relative wrapper = 一键置底按钮锚点）。
 minHeight: 0 是 flex 高度链必配项（教训 #615：
 高度链沿链验证到容器属性）——overflow 可见的中间层 flex 子项
 自动最小高度 = 内容最小高度（子列表的 overflow:auto 钳制不会
 穿透传递），缺它 wrapper 被 300 条消息撑到 7500+px、列表失去
 独立滚动 → 滚轮冒泡成整页滚动 + 旧消息滚出视野（回归，
 浏览器 A/B 实测证实；话题面板 wrapper 本就带此值）。 */}
          <div
            style={{
              position: "relative",
              flex: 1,
              display: "flex",
              flexDirection: "column",
              minWidth: 0,
              minHeight: 0,
            }}
          >
          <div
        ref={listRef}
        onScroll={stickToBottom.handleScroll}
        style={{
          flex: 1,
          overflowY: "auto",
          overflowX: "hidden",
          // 贴底跟随重构：关浏览器原生滚动锚，前插的视口补偿全权交给
          // useStickToBottom 的手动锚（防两套锚定打架）。
          overflowAnchor: "none",
          padding: "16px 4px",
          // 15.14：minHeight:300 → 0。旧值在「可用高 < 300」时强制列表
          // 300px → 穿透撑破列 → tabpane 整页滚动 → 输入框随页动。
          // flex:1 + minHeight:0 = 列表恒=可用高，内部自滚（Element 同款）。
          minHeight: 0,
          minWidth: 0,
          // 拖拽文件高亮（Element 同款 drop zone）。
          outline: dragOver && onSendFiles ? "2px dashed color-mix(in srgb, var(--app-accent, #FF7F16) 60%, transparent)" : "none",
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
            <WarnIcon size={13} style={{ verticalAlign: "-2px" }} /> {errorNote}
          </div>
        ) : null}
        {hasMore || threadGroups.hiddenCount > 0 ? (
          <div style={{ textAlign: "center", paddingBottom: 12 }}>
            {/* 预载中显形（自动预载与手动共用同一状态）；窗口揭示
                无网络往返，按钮即时放出更早消息。 */}
            {loadingMore ? (
              <span style={{ fontSize: 12, color: t.textSecondary }}>
                {tr("正在加载更早的消息…")}
              </span>
            ) : (
              <antd.Button
                size="small"
                type="link"
                onClick={() => {
                  if (threadGroups.hiddenCount > 0) revealWindow();
                  else kickLoadMore();
                }}
              >
                {threadGroups.hiddenCount > 0
                  ? tr("显示更早的消息 ↑")
                  : tr("加载更早的消息 ↑")}
              </antd.Button>
            )}
          </div>
        ) : visibleMessages.length > 0 ? (
          // 翻到头标记（Element「no more events」同款）。
          <div
            style={{
              textAlign: "center",
              fontSize: 11,
              color: t.textSecondary,
              paddingBottom: 8,
              opacity: 0.7,
            }}
          >
            {tr("已到最早的消息")}
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
              // Element 同款分组——同一发送者连续消息不
              // 重复头像+名字（Element 最具辨识度的视觉特征）；日期分隔
              // 强制断组（跨天的同发送者也算新组）。
              const sameSender =
                !sep && prev !== null && prev.sender === msg.sender;
              // gutter 时间：hover ∥ 末行 ∥（触屏：组头行常显）——触屏无
              // hover，tap 虽经 hoveredId 也能显时间，但 tap 的语义是
              // 弹操作条（对消息动手）不是看时间；组头行（头像+名）常显
              // 时间是移动端聊天通行做法，gutter 高 28px 固定不 reflow，
              // 组内延续行照旧隐（tap 显）。
              const showTime =
                hoveredId === msg.event_id ||
                isLast ||
                (TOUCH_ONLY && !sameSender);
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
                  <div
                    data-event-id={msg.event_id}
                    style={{
                      display: "flex",
                      justifyContent: mine ? "flex-end" : "flex-start",
                      // hover
                      // 行整体浅底圆角——扁平消息行的唯一框感来源。
                      padding: "3px 6px",
                      borderRadius: 8,
                      background:
                        hoveredId === msg.event_id ? t.bubbleOther : "transparent",
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
                        // 组内延续消息——28px 占位对齐
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
                              <span style={{ color: "#bbb", fontSize: 12 }}>⏳</span>
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
                          // handleSearchJump（而非 jumpToMessage）：原消息不在
                          // 已加载窗口时自动拉 /context 定位区，不再静默无反应。
                          // 直接传稳定引用
                          // （useCallback），不再每渲染包一层内联箭头。
                          onJump={handleSearchJump}
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
                        // 触屏（hover:none）无 hover 概念——tap 消息行切换操作条
                        // （桌面鼠标路径零改动：onClick 仅在 touch-only 设备生效）
                        onClick={() => {
                          if (TOUCH_ONLY)
                            setHoveredId((prev) =>
                              prev === msg.event_id ? null : msg.event_id,
                            );
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
                            live={
                              msg.workflow?.runId
                                ? (liveByRunId.get(msg.workflow.runId) ?? null)
                                : null
                            }
                            fileRefTeam={teamName}
                          />
                        </BubbleBoundary>
                        <ReactionChips
                          reactions={msg.reactions}
                          eventId={msg.event_id}
                          onReact={onReact}
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
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><TodoIcon size={12} /> {tr("复制")}</span>
                            </antd.Button>
                            {/* 编辑/撤回自己的消息（Element 同款；
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
                                  <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><EditIcon size={12} /> {tr("编辑")}</span>
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
                                    <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><TrashIcon size={12} /> {tr("撤回")}</span>
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
        {!stickToBottom.following && stickToBottom.unread > 0 ? (
          /* 「回到最新 N」（Element 同款）：悬浮右下，上翻且有新消息时出现；
 点击平滑置底并清零未读；回到底部自动清零。 */
          <div
            style={{
              position: "absolute",
              right: 14,
              // safe-area：notch/手势条设备上抬高到安全区之上
              bottom: "max(10px, env(safe-area-inset-bottom))",
              zIndex: 5,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
            }}
          >
            {stickToBottom.unread > 0 ? (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: PRIMARY,
                  background: t.bubbleOther,
                  border: `1px solid ${t.border}`,
                  borderRadius: 10,
                  padding: "1px 8px",
                  whiteSpace: "nowrap",
                }}
              >
                {/* 封顶 99：长流式会话防徽章无限膨胀（>99 显「99 条新消息」）。 */}
                {Math.min(stickToBottom.unread, 99)} {tr("条新消息")}
              </span>
            ) : null}
            {/* 置底按钮：纯 div 圆（弃 antd Button——其 CSS 与 inline 尺寸对抗，
      竖屏被纵向拉长）。flex:none 防 column wrapper 拉伸。44px 触控目标规则：
      外层 44×44 命中盒 + 内层 38 视觉圆（恒圆）；hover/active 状态反馈走
      全局类 .wb-jumpbottom（index.tsx 样式块）。 */}
            <div
              className="wb-jumpbottom"
              role="button"
              aria-label={tr("回到最新消息")}
              title={tr("回到最新消息")}
              onClick={() => void stickToBottom.scrollToBottom()}
              style={{
                width: 44,
                height: 44,
                flex: "none",
                boxSizing: "border-box",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
              }}
            >
              <div
                style={{
                  width: 38,
                  height: 38,
                  boxSizing: "border-box",
                  borderRadius: "50%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: PRIMARY,
                  color: "#fff",
                  border: `1px solid ${PRIMARY}`,
                  boxShadow: "0 2px 8px rgba(0,0,0,0.20)",
                  fontSize: 16,
                  lineHeight: 1,
                }}
              >
                ↓
              </div>
            </div>
          </div>
        ) : null}
          </div>

      {/* 搜索跳转定位区（修复）：目标事件不在已加载窗口时，展示
 /context 前后文片段 + 高亮目标 + 关闭；点击结果后滚动至此。
 16.23 霸屏修复：片段容器限高 40vh + 内部自滚，默认只渲染目标 ±2 条
（applyContextWindow），其余收在「展开全部上下文」按钮后——全量
 /context 片段不再把正常消息列表挤出屏幕。 */}
      {jumpContext ? (
        <div
          ref={jumpContextRef}
          style={{
            border: `1px solid ${PRIMARY}`,
            borderRadius: 10,
            padding: "8px 10px",
            background: "color-mix(in srgb, var(--app-accent, #FF7F16) 5%, transparent)",
            marginBottom: 8,
            animation: "wbJumpIn 0.3s ease-out",
            // 霸屏修复：片段高度封顶 + 内部滚动；flexShrink:0 保证纵向
            // 空间紧张时由上方消息列表（flex:1 min-0）让位，而非压扁本区。
            maxHeight: "40vh",
            overflowY: "auto",
            flexShrink: 0,
          }}
        >
          {(() => {
            const jcWin = applyContextWindow(
              jumpContext.events,
              jumpContext.highlightId,
              jumpContextExpanded,
            );
            return (
              <>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 6,
                  }}
                >
                  <span style={{ fontSize: 12, fontWeight: 700, color: PRIMARY }}>
                    <PinIcon size={12} style={{ verticalAlign: "-1px" }} /> {tr("搜索定位")}
                  </span>
                  <span style={{ fontSize: 11.5, color: t.textSecondary, flex: 1 }}>
                    {tr("目标消息不在已加载范围，显示前后文片段")}
                  </span>
                  {jcWin.hiddenCount > 0 ? (
                    <antd.Button
                      size="small"
                      type="link"
                      onClick={() => setJumpContextExpanded(!jumpContextExpanded)}
                      style={{ fontSize: 12, flex: "none" }}
                    >
                      {jumpContextExpanded
                        ? tr("收起")
                        : tr("展开全部上下文")} (
                      {jumpContext.events.length} {tr("条")})
                    </antd.Button>
                  ) : null}
                  <antd.Button
                    size="small"
                    type="text"
                    onClick={clearJumpContext}
                    style={{ fontSize: 12 }}
                  >
                    <CloseIcon size={12} />
                  </antd.Button>
                </div>
                {jcWin.events.map((m) => {
                  const isTarget = m.event_id === jumpContext.highlightId;
                  return (
                    <div
                      key={m.event_id}
                      style={{
                        padding: "6px 10px",
                        borderRadius: 8,
                        marginBottom: 4,
                        fontSize: 12.5,
                        background: isTarget ? "color-mix(in srgb, var(--app-accent, #FF7F16) 12%, transparent)" : t.bubbleOther,
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
              </>
            );
          })()}
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

      {/* 底部输入区。15.14：flexShrink:0——窗口矮时输入区不被压缩
 （压缩会挤压 textarea/autoSize 计算高度 → 输入框视觉跳变），
 纵向空间全让给上方消息列表（flex:1 min-0）内部滚动。 */}
      <RoomChatComposer p={props} c={core} />

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
 ? "color-mix(in srgb, var(--app-accent, #FF7F16) 35%, transparent)"
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

      {/* 窄屏线程：钉钉式 Drawer 弹出。
 15.14：仅「用户在窄屏下显式打开」的话题才自动弹 Drawer（ref 门控）——
 宽屏打开/持久化恢复的话题在窗口收窄时不弹（防鬼影），点消息话题
 图标可重新打开。 */}
      <antd.Drawer
        open={!isWide && threadPanelBody !== null && threadOpenedInNarrowRef.current}
        onClose={() => setActiveThread(null)}
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <ThreadIcon size={15} /> {tr("话题")}
          </span>
        }
        width={Math.min(460, typeof window !== "undefined" ? window.innerWidth * 0.92 : 460)}
        styles={{ body: { padding: 12 } }}
      >
        {threadPanelBody}
      </antd.Drawer>

      {/* 房间内消息搜索：Drawer 面板，房间过滤 + 上下文预览 + 定位 */}
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
 {/* ：成员列表头像角落状态灯（与消息头像同款；Worker 才有映射）。 */}
                <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
                  <MxcAvatar
                    url={member?.avatar_url}
                    size={30}
                    style={{ backgroundColor: PRIMARY, flexShrink: 0 }}
                  >
                    {name.slice(0, 1).toUpperCase()}
                  </MxcAvatar>
                  {workerSessionByMxid?.[mxid] ? (
                    <WorkerSessionDot state={workerSessionByMxid[mxid]} size={8} corner />
                  ) : null}
                </span>
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

      {/* 房间详情 Drawer（Element 同款：房间 ID/主题/成员角色/设置）。
 退出房间走现有 leave 链路（onLeaveRoom → setActiveRoom(null) →
 本组件条件渲染卸载，Drawer 自动关闭）。 */}
      <RoomInfoDrawer
        open={roomInfoOpen}
        roomId={room.room_id}
        roomName={room.name}
        onClose={() => setRoomInfoOpen(false)}
        onLeaveRoom={props.onLeaveRoom}
        onRename={() => openRename()}
        muted={props.muted}
        onToggleMute={props.onToggleMute}
        refreshTick={roomInfoRefreshTick}
      />

      {/* 重命名房间（Element 同款）+ 权限诊断 */}
      <antd.Modal
        title={tr("重命名房间")}
        open={renameOpen}
        onCancel={() => setRenameOpen(false)}
        onOk={() => {
          if (!renameValue.trim()) return;
          const nm = renameValue.trim();
          setRenameOpen(false);
          // 重命名完成（成功/失败）后通知详情 Drawer 重拉房间信息。
          return (async () => {
            try {
              await props.onRenameRoom?.(nm);
            } finally {
              setRoomInfoRefreshTick((v) => v + 1);
            }
          })();
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

      {/* #87 团队共享文件引用选择器（仅 Team: 房间；确认合并进已选，去重 by key）。 */}
      {teamName ? (
        <FileRefPicker
          open={refPickerOpen}
          team={teamName}
          onClose={() => setRefPickerOpen(false)}
          onConfirm={(refs) =>
            setFileRefs((prev) => [
              ...prev,
              ...refs.filter((r) => !prev.some((p) => p.key === r.key)),
            ])
          }
        />
      ) : null}

      {/* 成员详情卡：身份/角色 + 房间内最近消息 + DM */}
      {detailMxid && room ? (
        <MemberDetail
          mxid={detailMxid}
          displayName={senderShortName(detailMxid, room)}
          avatarUrl={room.members?.[detailMxid]?.avatar_url}
          role={memberRoles?.[detailMxid]}
          workerName={memberWorkerNames?.[detailMxid]}
          onOpenChats={onOpenWorkerChats}
          workerRuntime={workerRuntimeByMxid?.[detailMxid]}
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
// 面板级 memo——父级（WorkbenchPage）重渲染
// 且 props 无变化时跳过（修复前全仓零 memo，切 tab 帧断 183-200ms）。
export default React.memo(RoomChat);
