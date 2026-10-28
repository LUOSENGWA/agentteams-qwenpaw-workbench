import {
  getCachedMessages,
  resolveAttentionRoom,
  type AttentionItem,
  type AdminData,
  type RoomMessage,
  type TeamRoom,
  type InviteRoom,
  type WorkbenchConfig,
  type WorkerTreeTeam,
  type WorkflowEvent,
  type AuthStatus,
} from "./api";
import RoomChat from "./components/RoomChat";
import { WbViewportProvider } from "./WbViewportContext";
import TeamOverview from "./components/TeamOverview";
import { logoUrl as LOGO_URL } from "./lib/logo";
import HomePage from "./components/HomePage";
import WorkflowBoard, { WfView } from "./components/WorkflowBoard";
import Artifacts from "./components/Artifacts";
import OpsPanel from "./components/OpsPanel";
import AuditLog from "./components/AuditLog";
import SettingsTab from "./components/SettingsTab";
import MessageSearch from "./components/MessageSearch";
import ProjectFiles from "./components/ProjectFiles";
import NotificationCenter from "./components/NotificationCenter";
import WorkerChats from "./components/WorkerChats";
import WorkerManage from "./components/WorkerManage";
import { AttentionDecisionModal } from "./components/AttentionDecisionModal";
import { TeamIcon, TopologyIcon, HomeIcon, MessageIcon, BellIcon, BoxIcon, NotesIcon, SearchIcon, WrenchIcon, BrainIcon, SettingsIcon, FolderIcon, HistoryIcon, TargetIcon } from "./components/icons";
import KnowledgeBase from "./components/KnowledgeBase";
import ModelsTab from "./ModelsTab";
import { WbTooltip } from "./components/WbTooltip";
import { PRIMARY, SelfCheckTab, WB_MAIN_CSS } from "./WorkbenchPageShared";
import { useWorkbenchTheme } from "./WorkbenchPageTheme";
import { useWorkbenchUi } from "./WorkbenchPageUi";
import { useWorkbenchMessages } from "./WorkbenchPageMessages";
import { useWorkbenchData } from "./WorkbenchPageData";
import { useWorkbenchEvents } from "./WorkbenchPageEvents";
import { useWorkbenchChatActions } from "./WorkbenchPageActions";
import { useWorkbenchChatLayout } from "./WorkbenchPageLayout";
import { useWorkbenchDerived } from "./WorkbenchPageDerived";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

export default function WorkbenchPage() {
  const { t, themeCfg, tr, pluginVersion, connectorVersion, buildVersion } = useWorkbenchTheme();

  const [config, setConfig] = React.useState<WorkbenchConfig | null>(null);
 // config 稳定镜像 ref——refreshConfig（deps=[]）
  // 读它判断首载/静默刷新，避免把 config 放进 useCallback deps（引用变化
  // 连锁重建下游全部回调）。
  const configRef = React.useRef<WorkbenchConfig | null>(null);
  configRef.current = config;
 // config 加载态——设置页「加载中/失败+重试」横幅
  // + 保存钮禁用（防默认态覆盖真数据）的数据源。
  const [configLoadState, setConfigLoadState] = React.useState<
    "loading" | "ready" | "failed"
  >("loading");
 // 登录态/凭据健康（30s 低频轮询；端点零外发请求，
  // 成本=一次进程内读——token 失效后 @通知静默全断，此前前端零感知）。
  const [authStatus, setAuthStatus] = React.useState<AuthStatus | null>(null);
 // 半连通（Controller 通 + Matrix 未登录）info 横幅的关闭态
 // ——持久化到 localStorage，避免每次重开插件都打扰（登录态轮询会重拉数据）。
 const [matrixNoneDismissed, setMatrixNoneDismissed] =
    React.useState<boolean>(() => {
      try {
        return (
          window.localStorage.getItem(
            "agentteams-qwenpaw-workbench:matrix-none-dismissed",
          ) === "1"
        );
      } catch {
        return false;
      }
    });

  const { activeRoom, setActiveRoom, tab, setTab, setTabState, readUiState, mergeUiState, writeUiState, initialUi, UI_STATE_KEY, wfMem, setWfMem, tabBarRef, tabFade, updateTabFade, scrollTabIntoView, paneRef, lastTeamForceAtRef } = useWorkbenchUi();

  // Team tab state
  const [rooms, setRooms] = React.useState<TeamRoom[]>([]);
  const [roomsLoading, setRoomsLoading] = React.useState(false);
  /** 待接受邀请（sync rooms.invite 段；接受/拒绝后 force 重同步）。 */
  const [invites, setInvites] = React.useState<InviteRoom[]>([]);
  /** 已静音房间（m.muted_room account data 聚合）。 */
  const [mutedRooms, setMutedRooms] = React.useState<string[]>([]);

  const [messages, setMessages] = React.useState<RoomMessage[]>([]);
  // messages 的 ref 镜像（pollMessages 去重用，避免闭包过期）。
  const messagesRef = React.useRef<RoomMessage[]>([]);

  React.useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  // R2 显式跳转：渲染窗口下界——「加载原消息」命中深层目标时抬升
  // （旁路释放后仍罩住目标行）；单向棘轮在 RoomChatCore，切房归零。
  const [minWindowTops, setMinWindowTops] = React.useState(0);
  // // 换房间时消息状态必须整体重置。此前 messagesRef/messagesEnd 残留**上
  // 一个房间**的数据 → refreshMessages 的 mergeMessagePages(旧房全量,
  // 新房最新页) 把两房消息混进同一窗口（「乱了」），setCachedMessages
  // 再把混合体写进新房缓存（切回再「没了」）。Element 口径：timeline
  // 状态是 per-room 的——room_id 变化即归零，再拉/再恢复该房自己的缓存。
  React.useEffect(() => {
    // 切房有缓存则先恢复缓存（即时显示，
    // 不闪空态/「正在加载消息…」——旧逻辑归零后 1 帧内屏上无数据即闪
    // loading 文案）；无缓存照旧归零。I1 首窗重建仍在 refreshMessages
    // （缓存 end ?? 本页 end），I2 合并基底取缓存/在屏较长者——语义不变
    // （并消除一个潜在边界：旧房在屏条数 ≥ 新房缓存长度时，旧逻辑用空
    // 基底合并丢深历史）。
    const roomId = activeRoom?.room_id;
    const cached = roomId ? getCachedMessages(roomId) : undefined;
    setMessages(cached ? cached.messages : []);
    setMessagesEnd(cached ? (cached.end || "") : "");
    setHasMore(Boolean(cached?.end));
    setRoomError("");
    setMinWindowTops(0); // R2：渲染窗口下界不跨房保留
    messagesRef.current = cached ? cached.messages : [];
  }, [activeRoom?.room_id]);

  const [messagesLoading, setMessagesLoading] = React.useState(false);
  const [messagesEnd, setMessagesEnd] = React.useState(""); // 分页 token（I1：hist.cursor 的 React 镜像）
  const [hasMore, setHasMore] = React.useState(false);
  const [roomError, setRoomError] = React.useState("");
  const [sending, setSending] = React.useState(false);
  // Workflow tab state
  const [workflowEvents, setWorkflowEvents] = React.useState<WorkflowEvent[]>([]);
  const [workflowLoading, setWorkflowLoading] = React.useState(false);
  // 正源状态——降级时工作流 tab 顶部横幅提示（不静默）。
  const [workflowSource, setWorkflowSource] = React.useState<
    "controller" | "rooms"
  >("controller");
  const [workflowFailReason, setWorkflowFailReason] = React.useState<
    "auth" | "not_deployed" | "error"
  >("error");
  // error 分支的真实上游错误（横幅展示，不再只显示「正源不可用」）。
  const [workflowFailDetail, setWorkflowFailDetail] = React.useState("");
  // workflow 卡片点击 → 工作流 tab 选中该项目。
  const [selectedRunId, setSelectedRunId] = React.useState("");

  // 项目文件面板（）：聊天室 📁 → 抽屉。
  const [projectFilesRoom, setProjectFilesRoom] = React.useState<TeamRoom | null>(null);
  const openProjectFiles = React.useCallback(
    (room: TeamRoom) => setProjectFilesRoom(room),
    [],
  );

  // Spawn tab state — Worker-dimension groups from teams/rooms (design).
  // spawn lists stay empty until the spawn endpoint merges; adapter swaps the data source.
  const [workerTree, setWorkerTree] = React.useState<WorkerTreeTeam[]>([]);
  // 团队结构来源（"controller-workers" 正源 / "room-fallback" 房间聚合）
  // ——room-fallback 时 WorkerManage 出警示横幅、首页发起任务弹窗只留 Manager 入口。
  const [treeSource, setTreeSource] = React.useState<string>("");
  const [spawnLoading, setSpawnLoading] = React.useState(false);
  // L1 admin view state.
  const [adminData, setAdminData] = React.useState<AdminData | null>(null);
  const [adminLoading, setAdminLoading] = React.useState(false);

  // 一键全部已读（聊天页工具条按钮）。
  const [markingAllRead, setMarkingAllRead] = React.useState(false);

  // ── 分页：加载更早的消息（dir=b，from=窗口游标），前插 ──────────────
  // 收敛：I3 命中/兜底 + I4 空页走查收敛进
  // hist.walkFrom；组件侧只剩 I2 前插 + I6 落盘 + I3 预取续接 + I5 闸
  // 的 UI 镜像（loadingMore → RoomChat 顶部预载提示）。
  // 13.16/13.17 验收语义不变：滚动预载与手动按钮同窗双触发时 I5 闸
  // 保证同游标不双拉（重复前插同一页的根因）。
  const [loadingMore, setLoadingMore] = React.useState(false);

 // （13.12 「很多信息『已滚出历史』但 Element 里
  // 信息都在，看看 Element 怎么做的」）：引用条原消息不在已加载窗口时 →
  // 点「加载原消息」→ backfill 到原消息进窗口（不标死『滚出历史』）。
 // （R2 显式跳转，替换 13.14 B2 滚动接力）：旧版 = kickstart 一页
  // + 滚到顶/前插后自动续拉（接力节奏），游标/在飞闸/空页走查边界态
  // 导致「有时加载不出来」。新版 = 显式分页跳转：
  // ① 点「加载原消息」→ loadOriginal 显式循环串行翻页直到目标进窗口
  // （限页上限 ORIGINAL_PAGE_CAP，见 WorkbenchPageMessages/originalJump）；
  // ② 命中 → 抬渲染窗口下界（minWindowTops，旁路释放后深层目标不丢）+
  // 复用 jumpToEventId 定位 + 高亮（搜索跳转链路）；pendingOriginal
  // 旁路保持到定位完成（onJumpHandled → finishPendingOriginalJump）；
  // ③ 终止：目标进窗口（found）/ 到页上限或最早（exhausted → banner 落
  // /context 定位区兜底）/ 换目标或切房（cancelled）/ 30s 停滞看门狗
  // （cancelled，可再点）。
  const [pendingOriginalId, setPendingOriginalId] =
    React.useState<string | null>(null);

  // 跨房间搜索：全局面板 + 跳转定位事件（传给 RoomChat）。
  const [globalSearchOpen, setGlobalSearchOpen] = React.useState(false);
  const [jumpToEventId, setJumpToEventId] = React.useState<string | null>(null);

  // 通知未读计数（通知 tab badge）。
  const [inboxUnread, setInboxUnread] = React.useState(0);

  // // admin 取数连续失败计数——静默失败不再无感空面板，累计后在面板显 Alert+重试。
  const [adminFailCount, setAdminFailCount] = React.useState(0);

  const {
    markCurrentRead,
    handleMarkAllRead,
    refreshMessages,
    loadMore,
    loadOriginal,
    finishPendingOriginalJump,
    pollMessages,
    openRoom,
    handleGlobalSearchOpenRoom,
    handleGotoRoom,
    memberRoles,
    memberWorkerNames,
    workerBadgeMap,
    workerSessionStates,
  } = useWorkbenchMessages({
    activeRoom,
    setActiveRoom,
    setTab,
    writeUiState,
    rooms,
    setRooms,
    workerTree,
    adminData,
    tr,
    messages,
    setMessages,
    messagesRef,
    messagesEnd,
    setMessagesEnd,
    setMessagesLoading,
    setHasMore,
    hasMore,
    setRoomError,
    setLoadingMore,
    setMarkingAllRead,
    pendingOriginalId,
    setPendingOriginalId,
    setMinWindowTops,
    setJumpToEventId,
  });

  const {
    dismissMatrixNone,
    handleOpenProject,
    refreshConfig,
    refreshRooms,
    refreshTree,
    refreshWorkflow,
    hasCtlToken,
    refreshAdmin,
    attention,
    refreshAttention,
    onLoginSuccess,
  } = useWorkbenchData({
    activeRoom,
    config,
    setConfig,
    configRef,
    configLoadState,
    setConfigLoadState,
    setAuthStatus,
    setMatrixNoneDismissed,
    setRooms,
    setRoomsLoading,
    setInvites,
    setMutedRooms,
    setActiveRoom,
    initialUi,
    refreshMessages,
    setWorkerTree,
    setTreeSource,
    setSpawnLoading,
    tab,
    messages,
    setWorkflowEvents,
    setWorkflowLoading,
    setWorkflowSource,
    setWorkflowFailReason,
    setWorkflowFailDetail,
    setAdminData,
    setAdminLoading,
    setAdminFailCount,
    setSelectedRunId,
    setTabState,
    writeUiState,
    tr,
  });

  // attention 决策面（NMH §8）——顶栏 badge / 全局弹窗 / 通知页「待决策」
  // 子页签（10/26 原顶层聚合页并入通知页）共用一份数据（30s 轮询在
  // WorkbenchPageData，hasCtlToken 门控）；本处只管弹窗开合 + 定位 +
  // 待答过滤 + 子页签状态。deployed=false（旧 controller）时不显示
  // badge/入口（诚实降级，不报错）。
  const [attentionOpen, setAttentionOpen] = React.useState(false);
  const [attentionIndex, setAttentionIndex] = React.useState(0);
  const attentionPending = React.useMemo(
    () =>
      (attention?.items || []).filter(
        (it) => !it.answered_locally && !it.resolved,
      ),
    [attention],
  );
  // 房间卡徽章（L2）：room_id → 待决策条数（resolveAttentionRoom 解析，
  // payload 自带 room_id 优先；解析不到的项不进任何卡片）。
  const attentionPendingByRoom = React.useMemo(() => {
    const m: Record<string, number> = {};
    for (const it of attentionPending) {
      const rid = resolveAttentionRoom(it);
      if (rid) m[rid] = (m[rid] || 0) + 1;
    }
    return m;
  }, [attentionPending]);
  const openAttention = React.useCallback((index: number) => {
    setAttentionIndex(index);
    setAttentionOpen(true);
  }, []);
  const openAttentionByItem = React.useCallback(
    (item: AttentionItem) => {
      const i = attentionPending.findIndex(
        (it) =>
          `${it.task_id}:${it.kind || "other"}:${it.attempt}` ===
          `${item.task_id}:${item.kind || "other"}:${item.attempt}`,
      );
      openAttention(i >= 0 ? i : 0);
    },
    [attentionPending, openAttention],
  );
  // 房间页 pill（L3）点击：定位该房间第一条待决策 → 复用全局待决策弹窗。
  const handleOpenRoomAttention = React.useCallback(
    (room: TeamRoom) => {
      const first = attentionPending.find(
        (it) => resolveAttentionRoom(it) === room.room_id,
      );
      if (first) openAttentionByItem(first);
    },
    [attentionPending, openAttentionByItem],
  );
  // 「待决策」子页签（通知页内）——状态提到本层：顶栏 badge 点击 =
  // setTab("inbox") + 定位待决策子页；选择持久化进 ui-state（inboxSubTab
  // 字段），刷新后保持（旧顶层「待决策」tab 的持久化值由 useWorkbenchUi
  // 迁移收编到此）。
  const [attentionSubTab, setAttentionSubTabState] = React.useState(
    initialUi.current?.inboxSubTab === "attention",
  );
  const setAttentionSubTab = React.useCallback(
    (next: boolean) => {
      setAttentionSubTabState(next);
      mergeUiState({ inboxSubTab: next ? "attention" : "events" });
    },
    [mergeUiState],
  );

  const {
    sseState,
    notifyTick,
    setNotifyTick,
    opsTick,
    setOpsTick,
    knowledgeTick,
    setKnowledgeTick,
    chatsTick,
    chatsWorker,
    setChatsWorker,
    handleOpenWorkerChats,
  } = useWorkbenchEvents({
    tab,
    activeRoom,
    pollMessages,
    markCurrentRead,
    refreshRooms,
    refreshWorkflow,
    setRooms,
    messagesRef,
    setMessages,
  });

  const {
    handleSend,
    handleSendApproval,
    handleReact,
    handleSendFiles,
    handleSendEdit,
    handleRedact,
    handleLeaveRoom,
    handleRenameRoom,
    handleToggleMute,
    handleDm,
  } = useWorkbenchChatActions({
    activeRoom,
    config,
    mutedRooms,
    setMessages,
    setSending,
    refreshMessages,
    setActiveRoom,
    refreshRooms,
    setRooms,
    setMutedRooms,
    setTabState,
    writeUiState,
    tr,
  });

  const {
    narrow,
    vpValue,
    chatForceWide,
    setChatForceWidePersist,
    mainRef,
    onThreadPanelLayout,
    shellH,
    chatWide,
    chatSplitW,
    chatListHidden,
    setChatListHiddenPersist,
    closeChatRoom,
    startChatSplitDrag,
    chatListToggleBtn,
  } = useWorkbenchChatLayout({
    t,
    tr,
    tab,
    readUiState,
    mergeUiState,
    UI_STATE_KEY,
    setActiveRoom,
    setRoomError,
    writeUiState,
  });

  const {
    selfDisplayName,
    roomProjectByRoom,
    handleHomeOpenRoom,
    handleGotoTab,
    handleDmStable,
    openGlobalSearch,
    handleGlobalSearchClose,
    handleGlobalSearchOpenRoomOnly,
    gotoApprovals,
    gotoInvites,
    gotoSettings,
    handleWfRefresh,
    handleWfViewChange,
    handleWfTopoRunChange,
    handleWfIntervened,
    handleRoomsRefresh,
    handleInviteSettled,
    handleConfigChange,
    handleConfigRetry,
    handleChatBack,
    handleJumpHandled,
    noopStable,
    liveWorkflows,
    adminWorkers,
    selfCheckLayout,
    roomProjectNames,
    workerRoleByMxid,
  } = useWorkbenchDerived({
    config,
    rooms,
    workflowEvents,
    workflowSource,
    adminData,
    tab,
    setTab,
    setActiveRoom,
    openRoom,
    handleDm,
    setGlobalSearchOpen,
    setJumpToEventId,
    refreshWorkflow,
    setWfMem,
    refreshRooms,
    refreshConfig,
    configLoadState,
    setConfigLoadState,
    closeChatRoom,
    chatWide,
    chatForceWide,
    setChatListHiddenPersist,
  });

  // R2 显式跳转：跳转完成（定位高亮 / /context 兜底）→ 先释放 pending
  // 原消息（渲染窗口旁路关闭；下界已抬升，目标行不丢），再清跳转事件。
  const handleJumpHandledWrapped = React.useCallback(() => {
    finishPendingOriginalJump();
    handleJumpHandled();
  }, [finishPendingOriginalJump, handleJumpHandled]);

  // 点 Tab 即刷新（用户要求，所有 top tab）：rc-tabs 内容挂载后保活不卸载，
  // 切回不会自动重取——这里按 tab 显式触发对应数据刷新。
  // 首次运行（prev===""，=挂载/恢复的初始 tab，
  // tab 是持久化的——上次停在「团队管理」则首开即 team）也触发该 tab 的数据刷新。
  // 旧版 prev==="" 早退 = 持久化首开 team tab 时 admin 取数零触发（首屏只显拓扑
  // 的根因之二；hasCtlToken 翻转 effect 兜底 token 就绪，本处兜底首访意图）。
  const prevTabRef = React.useRef("");
  // team tab 激活态稳定 ref——
  // WorkerManage 的 30s 轮询门控读此 ref（tick 时取当前值）。
  // boolean prop `active={tab === "team"}` 每次切 tab 翻转 → 整树
  // 重渲落进切换帧（实测无 fetch 的 →团队 切换帧 61ms）；ref 身份
  // 恒定 → React.memo(WorkerManage) 命中，切 tab 零重渲。
  const teamActiveRef = React.useRef(false);
  teamActiveRef.current = tab === "team";
  React.useEffect(() => {
    const prev = prevTabRef.current;
    prevTabRef.current = tab;
    if (prev === tab) return;
    switch (tab) {
      case "home":
        // 静默刷新（切 tab/自动刷新不闪页——rc-tabs 保活有旧数据在屏）
        void refreshRooms(true);
        void refreshConfig();
        void refreshWorkflow(true);
        void refreshTree(true);
        break;
      case "chat":
        void refreshRooms(true);
        if (activeRoom) void refreshMessages(activeRoom, true);
        break;
      case "inbox":
        setNotifyTick((n) => n + 1);
        break;
      case "workflow":
        void refreshWorkflow(true);
        break;
      case "artifacts":
        void refreshRooms(true);
        break;
      case "team": {
        // force 改 stale-first——30s 内免 force
        // （前端 15s TTL + 后端 60s 缓存已足够新），避免每次切 tab 全量
        // 回源；超过 30s 才强制取最新。
        const forceNow = Date.now() - lastTeamForceAtRef.current > 30000;
        if (forceNow) lastTeamForceAtRef.current = Date.now();
        void refreshTree(true, forceNow);
        void refreshAdmin(true);
        break;
      }
      case "knowledge":
        setKnowledgeTick((n) => n + 1);
        break;
      case "selfcheck":
        void refreshConfig();
        break;
      case "ops":
        setOpsTick((n) => n + 1);
        break;
      case "settings":
        void refreshConfig();
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // P6：聊天双元素提取（宽/窄屏两分支共用一份 JSX——props 长，禁止复制）。
  const chatRoomEl = activeRoom ? (
    <RoomChat
      room={activeRoom}
      messages={messages}
      liveWorkflows={liveWorkflows}
      loading={messagesLoading}
      sending={sending}
      hasMore={hasMore}
      onLoadOriginal={loadOriginal}
      pendingOriginal={pendingOriginalId}
      minWindowTops={minWindowTops}
      user_id={config?.matrix?.user_id}
      errorNote={
        roomError === "not_found"
          ? tr("该房间历史暂时无法加载——可能是房间已失效，也可能是权限或服务端问题。可返回聊天页换其他房间。")
          : ""
      }
 // 回调 prop 全部改用上方稳定化
      // useCallback 引用（内联箭头每次渲染新引用会击穿 RoomChat memo）。
      onSend={handleSend}
      onSendApproval={handleSendApproval}
      onSendFiles={handleSendFiles}
      onSendEdit={handleSendEdit}
      onRedact={handleRedact}
      onLeaveRoom={handleLeaveRoom}
      onRenameRoom={handleRenameRoom}
      muted={activeRoom ? mutedRooms.includes(activeRoom.room_id) : false}
      onToggleMute={handleToggleMute}
      onReact={handleReact}
      onThreadPanelLayout={onThreadPanelLayout}
      onDm={handleDmStable}
      headerPrefix={chatListToggleBtn}
      onBack={handleChatBack}
      onNewTask={noopStable}
      onOpenWorkerChats={handleOpenWorkerChats}
      onLoadMore={loadMore}
      loadingMore={loadingMore}
      onPoll={pollMessages}
      jumpToEventId={jumpToEventId}
      onJumpHandled={handleJumpHandledWrapped}
      memberRoles={memberRoles}
      memberWorkerNames={memberWorkerNames}
      workerBadge={
        activeRoom ? workerBadgeMap[activeRoom.room_id] : undefined
      }
      sessionState={
        activeRoom ? workerSessionStates.byRoom[activeRoom.room_id] : undefined
      }
      workerMxids={workerSessionStates.workerMxids}
      workerSessionByMxid={workerSessionStates.byMxid}
      workers={adminWorkers}
      activityProject={
        activeRoom ? roomProjectByRoom[activeRoom.room_id] ?? null : null
      }
      onOpenProject={handleOpenProject}
      onWorkflowIntervened={handleWfIntervened}
      onOpenProjectFiles={openProjectFiles}
      attentionPending={attention?.deployed ? attentionPending : undefined}
      onOpenRoomAttention={handleOpenRoomAttention}
    />
  ) : null;

  const chatListEl = (
    <TeamOverview
      rooms={rooms}
      invites={invites}
      loading={roomsLoading}
      user_id={config?.matrix?.user_id}
      workerSessionByRoom={workerSessionStates.byRoom}
      workerMxids={workerSessionStates.workerMxids}
      roomProjectNames={roomProjectNames}
      attentionPendingByRoom={
        attention?.deployed ? attentionPendingByRoom : undefined
      }
      workerRoleByMxid={workerRoleByMxid}
 // 回调 prop 稳定化（同 RoomChat）。
      onOpenRoom={openRoom}
      onRefresh={handleRoomsRefresh}
      onInviteSettled={handleInviteSettled}
      onDm={handleDmStable}
      onGlobalSearch={openGlobalSearch}
      onMarkAllRead={handleMarkAllRead}
      markingAllRead={markingAllRead}
    />
  );
  const chatTabChildren = chatWide ? (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      {!chatListHidden ? (
        <>
          <div
            style={{
              position: "relative",
              width: chatSplitW,
              flexShrink: 0,
              minWidth: 0,
 // （P8a）：房间列表独立滚动（原先 overflow:hidden
              // 直接裁掉底部房间，列表无法滚动）；overscroll-contain 防
              // 滚动链传播到页面。
              overflowY: "auto",
              overscrollBehavior: "contain",
              borderRight: `1px solid ${t.border}`,
            }}
          >
            {chatListEl}
            <button
              type="button"
              onClick={() => setChatListHiddenPersist(true)}
              title={tr("隐藏房间列表")}
              style={{
                position: "absolute",
                top: 8,
                right: 8,
                zIndex: 10,
                border: `1px solid ${t.border}`,
                background: t.bg,
                color: t.textSecondary,
                borderRadius: 6,
                cursor: "pointer",
                padding: "2px 7px",
                fontSize: 12,
                lineHeight: "18px",
              }}
            >
              ⟨
            </button>
          </div>
          <div
            onMouseDown={startChatSplitDrag}
            title={tr("拖动调整房间列表宽度")}
            style={{
              width: 5,
              flexShrink: 0,
              cursor: "col-resize",
              background: "transparent",
            }}
          />
        </>
      ) : null}
      <div style={{ flex: 1, minWidth: 0, position: "relative", minHeight: 0 }}>
        {chatListHidden && !chatRoomEl ? (
          // 无房间选中（占位页）：顶栏不存在，按钮仍浮左上角。
          <div style={{ position: "absolute", top: 10, left: 10, zIndex: 10 }}>
            {chatListToggleBtn}
          </div>
        ) : null}
        {chatRoomEl || (
          <div
            style={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              color: t.textSecondary,
            }}
          >
            <span style={{ display: "inline-flex" }}><MessageIcon size={34} /></span>
            <div style={{ fontSize: 13 }}>
              {chatListHidden
                ? tr("房间列表已隐藏——点左上角 ☰ 显示")
                : tr("选择左侧房间开始聊天")}
            </div>
          </div>
        )}
      </div>
    </div>
  ) : activeRoom ? (
    chatRoomEl
  ) : (
    chatListEl
  );

  return (
    <antd.ConfigProvider theme={themeCfg}>
    <WbViewportProvider value={vpValue}>
    <main
      ref={mainRef}
      className="wb-main"
      style={{
        // 容器相对高度（Element 模型）——shellH 实测：
        // ① iframe 宿主=iframe 视口 ② 定高父容器（OS 窗口 .content）=父
        // clientHeight ③ 不定高回退旧经验值 calc(100vh-64px)（经典页面：
        // 宿主 header 56px + 8px 边距，见宿主 layouts/index.module.less
        // .sider）。12.x 的纯 vh 经验值在 OS 窗口小于屏幕时溢出 → 整页滚。
        height: shellH != null ? `${shellH}px` : "calc(100vh - 64px)",
 // // 去掉 1160 硬上限——16:9 全屏两侧各 ~380px 留空。全宽自适应：
        // 内容随窗口伸缩（表格/网格自行 minmax(0,1fr) 收放）。
        width: "100%",
        padding: "12px 20px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
 {/* 竖屏窄视口优化（团队管理竖屏用有点宽）——inline style
 无媒体查询能力，scoped CSS 注入；700px 断点=竖屏手机/窄窗。 */}
      <style>{WB_MAIN_CSS}</style>
      <header
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: 12,
          // 竖屏 header 降高：去标题省一行 + paddingBottom 10→6。
          // header 不隐藏——全屏手机挖孔摄像头会遮挡下方 tab 按钮，header 是安全缓冲。
          paddingBottom: narrow ? 6 : 10,
          borderBottom: `1px solid ${t.border}`,
        }}
      >
        {/* AgentTeams logo（左端）——竖屏 28→24。右边是头像昵称（flex:1 推开）。
    main 容器 20px L/R padding=圆角屏安全边距，别删。 */}
        <img
          src={LOGO_URL}
          width={narrow ? 24 : 28}
          height={narrow ? 24 : 28}
          alt="AgentTeams"
          style={{ display: "block", flexShrink: 0 }}
        />
        <div style={{ minWidth: 0 }}>
          {/* 竖屏：标题缩到 16px 一行（level3=24px 在手机上过高）+ 隐藏描述行
    （「多团队工作台（聊天/工作流/…）」与下方 tab 栏重复，版本在配置页可见）
    ——整块从约 3 行压到 1 行，省下约 200px 竖向空间。宽屏保持原样。 */}
          {/* 竖屏隐藏「AgentTeams 团队工作台」标题——logo 已代表品牌，
    标题省一行竖向空间；宽屏保留。div 在竖屏变空（版本行本就 !narrow），无害。 */}
          {!narrow && (
            <antd.Typography.Title
              level={3}
              style={{
                margin: 0,
                whiteSpace: "nowrap",
              }}
            >
              AgentTeams 团队工作台
            </antd.Typography.Title>
          )}
          {!narrow && (
            <WbTooltip
              title={
                connectorVersion && connectorVersion !== buildVersion
                  ? tr("前端 {f} · 连接器 {b}", {
                      f: buildVersion,
                      b: connectorVersion,
                    })
                  : tr("插件版本 {v}", { v: pluginVersion })
              }
            >
              <antd.Typography.Text type="secondary" style={{ fontSize: 12 }}>
                v{pluginVersion} —— 多团队工作台（聊天/工作流/产物/运维/管理）
              </antd.Typography.Text>
            </WbTooltip>
          )}
        </div>
        <div style={{ flex: 1 }} />
        {/* attention 待决策 badge——deployed 且有未答项才显示（点击跳
    通知页「待决策」子页；答题走面板内「回答」开全局弹窗）；
    旧 controller（404 降级）不显示，诚实降级。 */}
        {attention?.deployed && attentionPending.length > 0 ? (
          <WbTooltip title={`${tr("待决策")} · ${tr("点击直达")}`}>
            <button
              type="button"
              onClick={() => {
                setAttentionSubTab(true);
                setTab("inbox");
                scrollTabIntoView("inbox");
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                border: "none",
                background:
                  "color-mix(in srgb, var(--app-accent, #FF7F16) 10%, transparent)",
                color: PRIMARY,
                cursor: "pointer",
                padding: "4px 10px",
                borderRadius: 20,
                fontSize: 12,
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              <TargetIcon size={14} />
              {tr("待决策")}
              <span
                style={{
                  background: PRIMARY,
                  color: "#fff",
                  borderRadius: 10,
                  fontSize: 10.5,
                  padding: "0 6px",
                  lineHeight: "16px",
                  fontWeight: 700,
                }}
              >
                {attentionPending.length}
              </span>
            </button>
          </WbTooltip>
        ) : null}
        {config?.matrix?.user_id ? (
          <WbTooltip title={tr("点击进入配置页")}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                cursor: "pointer",
                padding: "4px 10px",
                borderRadius: 20,
 background: "color-mix(in srgb, var(--app-accent, #FF7F16) 6%, transparent)",
              }}
              onClick={() => setTab("settings")}
            >
              <antd.Avatar
                size="small"
 style={{ backgroundColor: "var(--app-accent, #FF7F16)", fontSize: 13 }}
              >
                {(selfDisplayName || config.matrix.user_id.split(":")[0].replace(/^@/, "")).slice(0, 1).toUpperCase()}
              </antd.Avatar>
              <span style={{ fontSize: 12, color: t.textSecondary }}>
                {selfDisplayName ||
                  config.matrix.user_id.split(":")[0].replace(/^@/, "")}
              </span>
            </div>
          </WbTooltip>
        ) : (
          <antd.Button size="small" onClick={() => setTab("settings")}>
            {tr("登录")}
          </antd.Button>
        )}
      </header>

 {/* 登录态/凭据失效横幅——token 失效后 @通知静默
 全断、Higress 会话过期后 alias 层静默消失，此前前端零感知（产品
 盲点）。数据源=30s 轮询 /auth-status（零外发请求）。 */}
      {authStatus?.matrix_token === "invalid" && (
        <antd.Alert
          type="error"
          showIcon
          style={{ flex: "0 0 auto" }}
          message={tr("Matrix 登录已失效")}
          description={tr(
            "你的 Matrix 访问令牌已被服务器拒绝（通常是密码修改、设备被移除或管理员重置）。@提到我、通知与任务状态更新不可用——请重新登录后恢复。",
          )}
          action={
            <antd.Button size="small" danger onClick={() => setTab("settings")}>
              {tr("重新登录")}
            </antd.Button>
          }
        />
      )}
      {authStatus?.console_session === "expired" && (
        <antd.Alert
          type="warning"
          showIcon
          style={{ flex: "0 0 auto" }}
          message={tr("Higress 管理会话已过期")}
          description={tr(
            "模型 alias 层的 Console 管理会话已失效——设置页用管理员账号密码重新验证后恢复。",
          )}
          action={
            <antd.Button size="small" onClick={() => setTab("settings")}>
              {tr("重新验证")}
            </antd.Button>
          }
        />
      )}
      {/* 半连通 info 横幅——Controller 已连通（团队/工作流
      数据正常）但 Matrix 未登录（聊天/通知/@提醒/任务状态受限）。此前首页
      静默显示部分数据零提示（Pi 实测：1 team 正常 + 0 rooms 0 unread）。
      与上方两条不同：这是「可降级可用」而非「故障」，故 type=info + 可关闭，
      关闭态持久化避免每次重开打扰。 */}
      {authStatus?.matrix_token === "none" && !matrixNoneDismissed && (
        <antd.Alert
          type="info"
          showIcon
          closable
          onClose={() => dismissMatrixNone()}
          style={{ flex: "0 0 auto" }}
          message={tr("Matrix 未登录——部分功能受限")}
          description={tr(
            "团队 / 工作流等数据来自 Controller，显示正常；但聊天、通知、@提醒与任务状态同步需要 Matrix 账号。在「配置」页完成 Matrix 登录后功能即补齐。",
          )}
          action={
            <antd.Button size="small" onClick={() => setTab("settings")}>
              {tr("登录")}
            </antd.Button>
          }
        />
      )}

 {/* 自定义 tab 栏（布局自控——antd Tabs 内部 DOM 不可控，
 高度链断导致头部不固定。自写 tab bar + 内容容器 flex 布局） */}
      <div
        ref={tabBarRef}
        onScroll={updateTabFade}
        className={`wb-tabs-fade-${tabFade}`}
        style={{
          flex: "0 0 auto",
          display: "flex",
          gap: 2,
          // 底边线移到下方兄弟元素——渐隐 mask 作用于元素全部内容
          // （含边框），留在容器内会被 mask 一起淡掉
          overflowX: "auto",
          scrollbarWidth: "none",
        }}
      >
        {[
          { key: "home", label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><HomeIcon size={15} /> {tr("首页")}</span> },
          { key: "chat", label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><MessageIcon size={15} /> {tr("聊天")}</span> },
          { key: "inbox", label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><BellIcon size={15} /> {tr("通知")}</span> },
          { key: "workflow", label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><TopologyIcon size={15} /> {tr("工作流")}</span> },
          { key: "artifacts", label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><BoxIcon size={15} /> {tr("产物")}</span> },
          {
            key: "team",
            // 👷 工人 → 双人重叠图标（表团队/协作）。
            label: (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <TeamIcon size={15} /> {tr("团队管理")}
              </span>
            ),
          },
          { key: "knowledge", label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><NotesIcon size={15} /> {tr("知识库")}</span> },
          { key: "selfcheck", label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><SearchIcon size={15} /> {tr("自检")}</span> },
          { key: "ops", label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><WrenchIcon size={15} /> {tr("运维")}</span> },
          { key: "models", label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><BrainIcon size={15} /> {tr("模型")}</span> },

          { key: "settings", label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><SettingsIcon size={15} /> {tr("配置")}</span> },
        ]
          // // 无 Controller token（L1 不可用）时隐藏「模型」入口。
          .filter((item) => item.key !== "models" || hasCtlToken)
          .map((item) => {
          const active = tab === item.key;
          return (
            <button
              key={item.key}
              data-tabkey={item.key}
              onClick={() => {
                setTab(item.key);
                scrollTabIntoView(item.key);
              }}
              style={{
                border: "none",
                background: "transparent",
                cursor: "pointer",
                padding: narrow ? "5px 9px" : "9px 14px",
                fontSize: narrow ? 13 : 13.5,
                whiteSpace: "nowrap",
                color: active ? PRIMARY : t.textSecondary,
                fontWeight: active ? 700 : 400,
                borderBottom: `2px solid ${active ? PRIMARY : "transparent"}`,
                transition: "color 0.15s, border-color 0.15s",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
              onMouseEnter={(e) => {
                if (!active)
                  (e.currentTarget as HTMLElement).style.color = PRIMARY;
              }}
              onMouseLeave={(e) => {
                if (!active)
                  (e.currentTarget as HTMLElement).style.color =
                    t.textSecondary;
              }}
            >
              {item.label}
              {item.key === "inbox" && inboxUnread > 0 ? (
                <span
                  style={{
                    background: PRIMARY,
                    color: "#fff",
                    borderRadius: 10,
                    fontSize: 10.5,
                    padding: "0 6px",
                    lineHeight: "16px",
                    fontWeight: 700,
                  }}
                >
                  {inboxUnread > 99 ? "99+" : inboxUnread}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {/* tab 栏底边线（独立于渐隐容器，全宽不断边） */}
      <div style={{ flex: "0 0 auto", height: 1, background: t.border }} />

      {/* 内容区：flex 1 + 内部滚动——头部与 tab 栏固定，只有这里滚 */}
 {/* 切页轻过渡目标（paneRef）——
 内容区最外层容器 div（antd.Tabs 的直接包裹层，keep-alive
 面板不重挂，只对该层做一次 170ms 淡入上浮）。 */}
      <div
        ref={paneRef}
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          /* ：本容器必须 flex 化——
 否则 Tabs 的 flex:1 空转 → content-holder 的 flex:1 整链塌陷，
 分栏左右仍不能独立滚动（12.10 只锁了 CSS 链，漏了这里）。 */
          display: "flex",
          flexDirection: "column",
          /* ：overflowX 锁死——宽叶子不撑出横向滚动，容器恒=视口宽；
 配合 scoped CSS min-width:0 断 flex/grid 撑宽链。 */
          overflowY: "auto",
          overflowX: "hidden",
          maxWidth: "100%",
          paddingTop: 12,
        }}
      >
      <antd.Tabs
        renderTabBar={() => null}
        activeKey={tab}
        onChange={setTab}
        style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
        items={[
          {
            key: "home",
            label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><HomeIcon size={15} /> {tr("首页")}</span>,
            children: (
              <HomePage
                rooms={rooms}
                config={config}
                workflowEvents={workflowEvents}
                workerTree={workerTree}
                // 首页是 chat tab 之外：点房间必须 setTab("chat")+openRoom
                //（与通知中心 handleGotoRoom 同模式，跳转修复）。
                // 回调 prop 稳定化引用。
                onOpenRoom={handleHomeOpenRoom}
                onGotoTab={handleGotoTab}
                managers={adminData?.managers}
                onDm={handleDmStable}
                treeSource={treeSource}
                inboxUnread={inboxUnread}
                onGlobalSearch={openGlobalSearch}
              />
            ),
          },
          {
            key: "chat",
            label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><MessageIcon size={15} /> {tr("聊天")}</span>,
            children: chatTabChildren,
          },
          {
            key: "inbox",
            label: (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <BellIcon size={15} /> {tr("通知")}
                {inboxUnread > 0 ? (
                  <antd.Badge
                    count={inboxUnread}
                    overflowCount={99}
                    size="small"
                    style={{ marginLeft: 6, backgroundColor: "var(--app-accent, #FF7F16)" }}
                  />
                ) : null}
              </span>
            ),
            children: (
              <NotificationCenter
                onUnreadCount={setInboxUnread}
                // 回调 prop 稳定化引用。
                onGotoApprovals={gotoApprovals}
                onGotoRoom={handleGotoRoom}
                refreshTick={notifyTick}
                // 邀请区数据 + 跳团队概览（邀请接受/拒绝
                // UI 在那里；chat tab 需无激活房间才显示 TeamOverview）。
                invites={invites}
                onGotoInvites={gotoInvites}
                // 待决策子页签（10/26 原顶层 tab 并入）——数据/弹窗/
                // 刷新链路仍在本层（全局弹窗），子页签状态持久化刷新后保持。
                attention={attention}
                attentionSubTab={attentionSubTab}
                onAttentionSubTabChange={setAttentionSubTab}
                onOpenAttentionItem={openAttentionByItem}
                onRefreshAttention={() => void refreshAttention(true)}
              />
            ),
          },
          {
            key: "workflow",
            label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><TopologyIcon size={15} /> {tr("工作流")}</span>,
            children: (
              <WorkflowBoard
                events={workflowEvents}
                loading={workflowLoading}
                // 回调 prop 稳定化引用。
                onRefresh={handleWfRefresh}
                highlightRunId={selectedRunId}
                source={workflowSource}
                failReason={workflowFailReason}
                failDetail={workflowFailDetail}
                view={wfMem.view as WfView}
                onViewChange={handleWfViewChange}
                topoRun={wfMem.topoRun}
                onTopoRunChange={handleWfTopoRunChange}
              />
            ),
          },
          {
            key: "artifacts",
            label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><BoxIcon size={15} /> {tr("产物")}</span>,
            children: <Artifacts rooms={rooms} />,
          },
          {
            key: "team",
            // 👷 → 双人重叠图标（与横排 tab 同源）。
            label: (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <TeamIcon size={15} /> {tr("团队管理")}
              </span>
            ),
            children: (
              <WorkerManage
                teams={workerTree}
                admin={adminData}
                treeLoading={spawnLoading}
                adminLoading={adminLoading}
                adminFailCount={adminFailCount}
                /* 参数透传：` =>` 会吃掉 30s 自动刷新的 silent；
 直接透传稳定 useCallback 原引用
 （签名含 silent，等价于原内联箭头）。 */
                onRefreshTree={refreshTree}
                onRefreshAdmin={refreshAdmin}
                onDm={handleDmStable}
                /* L1 只读 Alert「去设置」跳配置页 */
                onOpenSettings={gotoSettings}
                hasToken={hasCtlToken}
                activeRef={teamActiveRef}
                treeSource={treeSource}
                workerSessionByName={workerSessionStates.byName}
                myUserId={config?.matrix?.user_id || ""}
                /* L1 走 controller token（config 或 env）且未配 admin 账号密码 = 无 Higress Console 会话 */
                l1TokenMode={hasCtlToken && !config?.admin_username}
              />
            ),
          },
          {
            key: "knowledge",
            label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><NotesIcon size={15} /> {tr("知识库")}</span>,
            children: <KnowledgeBase refreshTick={knowledgeTick} />,
          },
          {
            key: "selfcheck",
            label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><SearchIcon size={15} /> {tr("自检")}</span>,
            children: (
              <SelfCheckTab
                config={config}
                // 内联对象字面量 → useMemo 稳定引用。
                layout={selfCheckLayout}
              />
            ),
          },
          {
            key: "ops",
            label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><WrenchIcon size={15} /> {tr("运维")}</span>,
            children: (
              <OpsPanel refreshTick={opsTick} />
            ),
          },
          {
            key: "audit",
            label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><HistoryIcon size={15} /> {tr("审计")}</span>,
            children: <AuditLog hasToken={hasCtlToken} />,
          },
          {
            key: "models",
            label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><BrainIcon size={15} /> {tr("模型")}</span>,
            children: <ModelsTab />,
          },
          {
            key: "settings",
            label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><SettingsIcon size={15} /> {tr("配置")}</span>,
            children: (
              <SettingsTab
                onLoginSuccess={onLoginSuccess}
                config={config}
                configLoadState={configLoadState}
                onRetryConfig={handleConfigRetry}
                // 回调 prop 稳定化引用。
                onConfigChange={handleConfigChange}
                chatForceWide={chatForceWide}
                onChatForceWideChange={setChatForceWidePersist}
                sseState={sseState}
              />
            ),
          },
        ]
          // 与侧栏同门控——L2 无「模型」页。
          .filter((it) => it.key !== "models" || hasCtlToken)}
      />
      </div>
      {/* 跨房间消息搜索：点击结果 → 打开房间 + 定位事件；
 ：群名搜索（微信式）→ 点击直达房间 */}
      <MessageSearch
        open={globalSearchOpen}
        // props 全稳定引用（memo bail out）。
        onClose={handleGlobalSearchClose}
        onOpenRoom={handleGlobalSearchOpenRoom}
        rooms={rooms}
        onOpenRoomOnly={handleGlobalSearchOpenRoomOnly}
      />
      {/* 项目文件面板（产物端点 版：任务结果/任务书/交付物） */}
 {/* 项目文件 Drawer 标题带文件夹 SVG；
 面板内不再重复「项目文件」标题行。 */}
      <antd.Drawer
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <FolderIcon size={14} /> {tr("项目文件")}
          </span>
        }
        open={projectFilesRoom !== null}
        onClose={() => setProjectFilesRoom(null)}
        width={440}
        destroyOnClose
      >
        <ProjectFiles
          room={projectFilesRoom}
          workflowEvents={workflowEvents}
          onClose={() => setProjectFilesRoom(null)}
        />
      </antd.Drawer>
      {/* 头像 → Worker 会话抽屉（只读，#1295 端点 + 版本门；内容=会话列表
          → agent 上下文完整 session）。兄弟视图：SSE tick 只刷新此抽屉，
          不重渲聊天整树；切离 chat tab 即随门控消失（与挂载于聊天区时
          的卸载语义一致）。 */}
      {tab === "chat" && chatsWorker ? (
        // QwenPaw 会话口径五列表需要更宽（560→620）。
        <antd.Drawer
          open
          onClose={() => setChatsWorker(null)}
          width={620}
          title={`${chatsWorker} — ${tr("会话")}`}
          styles={{ body: { padding: 14, background: t.bg } }}
        >
          <WorkerChats
            workers={adminWorkers}
            fixedWorker={chatsWorker}
            refreshTick={chatsTick}
          />
        </antd.Drawer>
      ) : null}
      {/* attention 决策弹窗（全局：通知页「待决策」子页面板「回答」打开；
          一次一条、可上/下条；成功提交 → 静默刷新聚合 + 关闭） */}
      <AttentionDecisionModal
        open={attentionOpen}
        items={attentionPending}
        index={attentionIndex}
        onIndexChange={setAttentionIndex}
        onClose={() => setAttentionOpen(false)}
        onAnswered={() => void refreshAttention(false)}
      />
    </main>
    </WbViewportProvider>
    </antd.ConfigProvider>
  );
}
