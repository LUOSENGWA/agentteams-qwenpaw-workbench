import type * as ReactNS from "react";
import {
  fetchEventContext,
  fetchRoomApprovals,
  type RoomMessage,
  type TeamMember,
  fetchRoomPowerInfo,
  type RoomPowerInfo,
  fetchWorkerLoopStatusBySession,
  type WorkerLoopStatus,
} from "../api";
import { type FileRef } from "../lib/file-refs";
import { type WorkflowEvent } from "../api";
import {
  groupThreads,
  applyWindow,
} from "../threadWindow";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { useTabActive } from "../tabActivity";
import { useWbViewport } from "../WbViewportContext";
import { usePoller } from "../usePoller";
import {
  WrenchIcon,
  FolderIcon,
  SearchIcon,
  EditIcon,
  BellIcon,
  DoorIcon,
  TodoIcon,
} from "./icons";
import {
  MSG_WINDOW_LIMIT,
  CARD_RADIUS,
  isToolMessage,
  parseApproval,
  sameLoopStatus,
} from "./RoomChatShared";
import {ThreadPanelView } from "./RoomChatThread";
import type {RoomChatProps } from "./RoomChat";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
export function useRoomChatCore(props: RoomChatProps) {
  const {
    room,
    messages,
    loading,
    sending,
    hasMore,
    loadingMore = false,
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
    headerPrefix,
    onOpenWorkerChats,
    onNewTask,
    onLoadMore,
    onPoll,
    errorNote,
    jumpToEventId,
    onJumpHandled,
    liveWorkflows,
    activityProject,
    onThreadPanelLayout,
    memberRoles,
    memberWorkerNames,
    workerRuntimeByMxid,
    workerBadge,
    sessionState,
    workerMxids,
    workerSessionByMxid,
    onOpenProject,
    onWorkflowIntervened,
    onOpenProjectFiles,
    onLoadOriginal,
    pendingOriginal,
  } = props;
 // 头像点击 → Worker 会话抽屉（只读，
  // #1295 端点；404 版本门占位）。团队管理不再挂会话 tab。

  // runId → live 工作流事件（controller 正源
  // 双轨，WorkbenchPage 15s 轮询；聊天 tab 含 workflow 卡片时保持活跃）。
  const liveByRunId = React.useMemo(() => {
    const m = new Map<string, WorkflowEvent>();
    (liveWorkflows ?? []).forEach((ev) => m.set(ev.runId, ev));
    return m;
  }, [liveWorkflows]);
  const [draft, setDraft] = React.useState("");
  // #87 团队共享文件引用——team 名从房间名推导（Controller 建团队房间
  // 命名 "Team: <name>"，provisioner 实锤）；推不出=非团队房间→
  // 引用按钮隐藏、chip 不渲染。
  const teamName = React.useMemo(() => {
    const m = /^Team:\s*(.+)$/.exec(room?.name || "");
    const n = m ? m[1].trim() : "";
    return n || null;
  }, [room?.name]);
  const [fileRefs, setFileRefs] = React.useState<FileRef[]>([]);
  const [refPickerOpen, setRefPickerOpen] = React.useState(false);
  // 编辑模式（Element 同款——banner「正在编辑此消息」+
  // 输入框预填原文；发送=m.replace 替换，Esc/✕ 取消）。
  const [editing, setEditing] = React.useState<{
    event_id: string;
    sender: string;
    body: string;
  } | null>(null);
  // 重命名（Element 同款）+ 权限诊断。
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
  // 拖拽文件悬停标记（drop zone 高亮，Element 同款）。
  const [dragOver, setDragOver] = React.useState(false);
  // 输入框容器 ref（autoSize TextArea 所在）。高度拖拽手柄已删——
  // 改 autoSize 随内容自动增高（1~5 行封顶），无需手动拖/持久化。
  const composerBoxRef = React.useRef<HTMLDivElement>(null);
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
  // 消息搜索面板。
  const [searchOpen, setSearchOpen] = React.useState(false);
  // 成员详情卡：选中成员的 MXID，null=关闭。
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
  // 15.14：窄屏话题=antd.Drawer（portal 覆盖层）。isWide 随窗口收窄
  // true→false 时，宽屏内联面板的话题会「自动转成 Drawer 弹出」——叠加
  // localStorage 持久化（切 tab 不卸载 + 重开恢复）→ 切 tab / 拖窄 / 重开
  // 即出现「话题窗鬼影弹出」（真机反馈）。
  // 修法：记住「该话题是用户在窄屏下显式打开的」——只有此种情况才允许
  // Drawer 自动开；宽屏打开/持久化恢复的话题，收窄窗口时不弹 Drawer
  // （状态保留，点消息上的话题图标可重新打开）。
  const threadOpenedInNarrowRef = React.useRef(false);
  const setActiveThread = React.useCallback(
    (next: string | null) => {
      setActiveThreadState(next);
      // 用户显式打开话题（next 非空，唯一来源=消息话题图标点击）→
      // 记录此刻是否窄屏；关闭（null）→ 复位。持久化恢复不走此函数，
      // ref 保持初始 false（恢复的话题不自动弹 Drawer）。
      threadOpenedInNarrowRef.current =
        next != null &&
        (typeof window === "undefined" ? false : window.innerWidth < 900);
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
  // 15.14：离开聊天 tab → 关话题（含 Drawer）。窄屏 Drawer 是 portal
  // 覆盖层，不关会「浮在别的 tab 之上」；宽屏内联面板隐藏于非激活 tab
  // 无副作用，但统一关闭更干净（重开 chat tab 点消息可再开，thread 仍在
  // localStorage，重开插件宽屏侧栏可恢复）。
  const chatTabActive1514 = useTabActive("chat");
  React.useEffect(() => {
    if (chatTabActive1514) return;
    if (activeThread) setActiveThread(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatTabActive1514, activeThread, setActiveThread]);
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

  // ── ──
  // 上翻回看历史时，右下角悬浮「↓」圆钮 + 「N 条新消息」徽章；点击平滑
  // 滚回底部并清零。near-bottom 阈值 120px 与自动跟随共用（below = 近底）。
  const [showJumpBottom, setShowJumpBottom] = React.useState(false);
  const [newMsgCount, setNewMsgCount] = React.useState(0);
  const prevMsgLenRef = React.useRef(0);
 // （13.11 置底按钮点了不置底，像滚动位置记忆问题
 // 根因）：旧模型 nearBottom 在**每次 effect 运行时现算**——点 ↓ 触发
  // smooth 滚动（数百 ms）期间，新消息到达的 effect 跑在滚动中途
  // （nearBottom=false）→ 按钮重新出现 + 计数清零前又被加 1 → 用户感知
  // 「点了没用」。QwenPaw/Element 正源模型 = **显式 isAtBottom 状态 +
  // 点击锁定（pinned）**：点击置底 = 立即（instant，不用 smooth——smooth
  // 目标随新消息 scrollHeight 增长漂移）+ 锁定窗口内持续贴底、新消息
  // 不重弹按钮；用户主动上翻（dist≥120）即解锁。
  const atBottomRef = React.useRef(true);
  const pinnedUntilRef = React.useRef(0);
 // 置底跟随 rAF 门——流式期间同一帧内
  // 新消息 effect + ResizeObserver 可各触发多次（N 条新消息 + M 个子节点
  // 高度变化），旧版每次同步 `el.scrollTop = el.scrollHeight`（读
  // scrollHeight 时布局脏 → 强制同步 reflow，每帧最多 N+M 次）。现收敛为
  // 每帧至多一次写入；已贴底（delta<2px）直接跳过写入。
  const followRafRef = React.useRef(0);
  const scheduleFollow = React.useCallback(() => {
    if (followRafRef.current) return;
    followRafRef.current = requestAnimationFrame(() => {
      followRafRef.current = 0;
      const el = listRef.current;
      if (!el || !atBottomRef.current) return;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 2) return;
      el.scrollTop = el.scrollHeight;
    });
  }, []);
 // // 顶部预加载余量——旧版 40px 只在贴顶瞬间触发（贴顶才拉、拉完要滚回顶
  // 再触发一次），体感「没有预加载」。现 = 视口比例余量：接近顶部即开始拉，
  // 锚恢复后继续上翻自然接力（连续分段预载）。
 // // 余量 0.25→**0.6 视口（下限 400px）**——配合父侧预取管线（下一页后台
  // 常驻预取）：触发点提前 + 落地零等待，加载跟着窗口走而非被触发才追。
  const nearTop = React.useCallback((el: HTMLElement) => {
    return el.scrollTop < Math.max(400, el.clientHeight * 0.6);
  }, []);
  // 消息窗口封顶（见 threadGroups 注释）：初始渲染窗 + 揭示步长同值。
  const [windowLimit, setWindowLimit] = React.useState(MSG_WINDOW_LIMIT);
  const revealWindow = React.useCallback(() => {
    setWindowLimit((w) => w + MSG_WINDOW_LIMIT);
  }, []);
  // 被窗口藏起的顶层消息数（每渲染同步；kickLoadMore 声明早于
  // threadGroups，经 ref 桥接避免声明顺序依赖）。
  const hiddenCountRef = React.useRef(0);
  // 触碰式拉取统一入口：同步防重（autoLoadRef）+ 6s 兜底复位（成功路径
  // 由锚 effect 的「前插检测」更快复位）。滚动/按钮/驻顶接力共用。
  // 窗口化：有被藏起消息时优先本地揭示（无网络往返、不占防重锁）；
  // 揭示干净后才真正拉更早页。
  const kickLoadMore = React.useCallback(() => {
    if (hiddenCountRef.current > 0) {
      revealWindow();
      return;
    }
    if (autoLoadRef.current) return;
    autoLoadRef.current = true;
    window.setTimeout(() => {
      autoLoadRef.current = false;
    }, 6000);
    void onLoadMore?.();
  }, [revealWindow, onLoadMore]);
  const handleListScroll = React.useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (dist < 120) {
      atBottomRef.current = true;
      setShowJumpBottom(false);
      setNewMsgCount(0);
    } else {
      atBottomRef.current = false;
      // 用户主动上翻 → 解除点击锁定（锁定只保护「正在追底」的瞬间）。
      pinnedUntilRef.current = 0;
      setShowJumpBottom(true);
    }
    // 接近顶部 → 预加载更早历史（Element 式无限滚动；保留顶部按钮作显式入口）。
    if (hasMore && nearTop(el)) kickLoadMore();
  }, [hasMore, nearTop, kickLoadMore]);
  const jumpToBottom = React.useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    // 立即置底（instant）：smooth 的目标 scrollHeight 会随落地期间的新
    // 消息增长而漂移，用户看着「没到底」。锁定 800ms：窗口内新消息持续
    // 贴底跟随且不重弹按钮（下方新消息 effect 消费 pinnedUntilRef）。
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    pinnedUntilRef.current = Date.now() + 800;
    setNewMsgCount(0);
    setShowJumpBottom(false);
  }, []);
 // DOM 高度变化跟随——
  // messages 变化的 effect 只覆盖「消息数变」；图片加载/卡片/产物渲染
  // 后撑高时不触发 → 贴底用户看着内容把视口顶离底部。Element 正源=
  // ResizeObserver 观察**滚动内容**（滚动容器自身尺寸由 flex 定死，
  // 观察容器不触发——必须观察其直接子节点：新行出现/行高变化都触发）。
  React.useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      // 贴底（含点击锁定窗口：pinned 路径恒置 atBottomRef=true）→ 跟随。
 // rAF 门——同帧多个子节点高度变化
      // 合并为每帧一次 scrollTop 写入（旧版每回调一次同步写 = 每回调一次
      // 强制 reflow；流式 DOM 持续增高时是主线程卡顿主要来源）。
      if (!atBottomRef.current) return;
      scheduleFollow();
    });
    for (const c of Array.from(el.children) as HTMLElement[]) {
      ro.observe(c);
    }
    return () => ro.disconnect();
  }, [room, messages, scheduleFollow]);
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
 el.style.background = "color-mix(in srgb, var(--app-accent, #FF7F16) 18%, transparent)";
    window.setTimeout(() => {
      el.style.background = "transparent";
    }, 1800);
  }, []);

  // 搜索跳转定位区（修复）：目标事件不在已加载窗口（搜索结果多为旧消息）
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
        // 不再静默——定位失败的静默是「点了没反应」的直接来源。
        antd.message.warning(tr("定位失败——原消息上下文拉取出错，可手动加载更早消息后重试"));
      }
    },
    [room, jumpToMessage, tr],
  );

  // 跨房间搜索跳转：jumpToEventId 变化后轮询定位——切房时消息列表
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

  // #87：切房间即清已选引用与选择器——引用键是 team 作用域，
  // 跨房间（跨 team）带着走会挂到错误的 team-file 端点上。
  React.useEffect(() => {
    setFileRefs([]);
    setRefPickerOpen(false);
  }, [room?.room_id]);

  const handleSend = React.useCallback(async () => {
    const text = draft.trim();
    // #87：纯引用消息（无文本）也可发——空文本 + 无引用才拦截。
    if (!text && fileRefs.length === 0) return;
    // 编辑模式优先（发送=m.replace 替换，不走新消息链）。
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
    const refs = fileRefs.length ? fileRefs : undefined;
    try {
      await onSend(text, replying || undefined, undefined, refs);
      setDraft("");
      setReplyTo(null);
      setFileRefs([]);
      // 自己发的消息不算"新消息"——未读线随发送下移。
      setReadTs(Date.now());
      // 滚动到底部
      requestAnimationFrame(() => {
        if (listRef.current) {
          listRef.current.scrollTop = listRef.current.scrollHeight;
        }
      });
    } catch {
      /* {tr("发送失败")}保留草稿与已选引用 */
    }
  }, [draft, fileRefs, onSend, onSendEdit, replyTo, editing]);

  // 审批动作：发带 @Worker 的审批命令 + 本地标记已处理。
  // 此前裸发 /approval approve（无 @）——群房间
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

  // 兜底轮询：每 12s 拉一次新消息（仅在有房间时）。
 // P6：主路已切 /sync 事件驱动（后端 sync watcher → SSE
  // room_message → WorkbenchPage 立即拉取）——本定时器降为 SSE 断连/
  // 事件丢失的保险（与后端 60s 兜底轮询同层语义）。
 // 旧定时器 → usePoller（12s；chat tab 激活 &&
  // 有房间 && onPoll 在场；!document.hidden 内置）。
  usePoller({
    fn: () => void onPoll?.(),
    intervalMs: 12000,
 // 布尔快照（非 chat 互切不重渲）。
    active: useTabActive("chat") && !!room && !!onPoll,
  });

  // 桌面通知：新审批消息到达 → 浏览器 Notification（宿主 2.1 无 paw.notify；
  // 集群审批接宿主通知中心需上游插件审批源 PR，本版用浏览器通知兜底）。
 // 双保险——
  // ① 挂载首批（历史消息）只登记不通知：重开插件打开聊天页不再对历史
  // 审批（多半已批完/超时）弹浏览器通知；
  // ② 真正新到达的审批消息，弹前查 /room-approvals pending 集（event_id
  // 在列才弹）——已审批/已超时的即使刚进消息流也不弹；查询失败=抑制
  // （宁可漏弹不弹陈旧；页内审批卡 + 通知中心不受影响）。
  const seenApprovalsRef = React.useRef<Set<string>>(new Set());
  const approvalsSeededRef = React.useRef(false);
  const pendingCacheRef = React.useRef<{ ts: number; ids: Set<string> } | null>(null);
 // approval 解析缓存（event_id→boolean）——
  // 每次 messages 变化旧代码对**全部**消息重跑 parseApproval 正则（消息体
  // 可达数百行），流式期 O(n) 次白扫。Matrix 消息不可变（编辑走 m.replace
  // 新事件，不改旧 event_id 的 body），event_id 键安全；换房间时随
  // seenApprovalsRef 一起清。
  const approvalParseCacheRef = React.useRef(new Map<string, boolean>());
  React.useEffect(() => {
    // event_id 级缓存：只对新落地的消息跑正则（）。
    const parseCache = approvalParseCacheRef.current;
    const apprs = messages.filter((m) => {
      if (m.msgtype !== "m.text" || !m.body) return false;
      let hit = parseCache.get(m.event_id);
      if (hit === undefined) {
        hit = !!parseApproval(m.body);
        parseCache.set(m.event_id, hit);
      }
      return hit;
    });
    if (apprs.length === 0) return;
    if (!approvalsSeededRef.current) {
      // 首批 = 打开房间时已加载的历史（含旧审批）：只登记，不弹。
      for (const m of apprs) seenApprovalsRef.current.add(m.event_id);
      approvalsSeededRef.current = true;
      return;
    }
    const fresh = apprs.filter(
      (m) => !seenApprovalsRef.current.has(m.event_id),
    );
    if (fresh.length === 0) return;
    for (const m of fresh) seenApprovalsRef.current.add(m.event_id);
    if (typeof window.Notification === "undefined") return;
    if (window.Notification.permission === "default") {
      // 静默请求一次；拒绝后不再打扰（权限面板可手动改）。
      void window.Notification.requestPermission().catch(() => undefined);
    }
    if (window.Notification.permission !== "granted") return;
    void (async () => {
      let pendingIds: Set<string> | null = null;
      const cache = pendingCacheRef.current;
      if (cache && Date.now() - cache.ts < 5000) {
        pendingIds = cache.ids;
      } else {
        try {
          const list = await fetchRoomApprovals(50);
          pendingIds = new Set(
            list.map((a) => String(a.event_id || "")).filter(Boolean),
          );
          pendingCacheRef.current = { ts: Date.now(), ids: pendingIds };
        } catch {
          pendingIds = null; // 查询失败 → 抑制（宁漏弹不弹陈旧）
        }
      }
      if (!pendingIds) return;
      for (const m of fresh) {
        if (!pendingIds.has(m.event_id)) continue;
        try {
          new window.Notification(`🛡️ ${tr("工具调用需要审批")}`, {
            body: (m.body || "").replace(/\*\*/g, "").slice(0, 160),
          });
        } catch {
          /* WebView 不支持时静默 */
        }
      }
    })();
  }, [messages]);

  // 新消息到达自动滚到底部（仅当用户本来就在底部附近）；不在附近且
  // 消息真的增长（排除自己发的——发送路径已主动置底，防竞态误计）→
  // 计「N 条新消息」+ 显示置底钮（）。
  // grew 判定改「末条 id 变化」——旧版用 length 增长，
  // loadMore 前插 50 条也触发 grew → 上翻加载历史被误计「1 条新消息」。
  const lastMsgIdRef = React.useRef("");
  React.useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const lastId = messages[messages.length - 1]?.event_id || "";
    const grew = lastId !== "" && lastId !== lastMsgIdRef.current;
    lastMsgIdRef.current = lastId;
    // 显式 atBottom 状态 + 点击锁定窗口（见
    // handleListScroll 注释）——落地期新消息持续贴底，不重弹按钮。
    // 跟随用 instant（scrollTop=scrollHeight）：smooth 在消息流式增长下
    // 目标漂移，用户感知「自动置底不灵」。
    const pinned = Date.now() < pinnedUntilRef.current;
    if (atBottomRef.current || pinned) {
      atBottomRef.current = true;
 // rAF 门（与 RO 同门）——同帧多条
      // 新消息只写一次 scrollTop，不再每条一次强制 reflow。
      scheduleFollow();
      setNewMsgCount(0);
      setShowJumpBottom(false);
      return;
    }
    const last = messages[messages.length - 1];
    if (grew && (!last || last.sender !== user_id)) {
      setNewMsgCount((c) => c + 1);
      setShowJumpBottom(true);
    }
  }, [messages, user_id, scheduleFollow]);

 // // loadMore 前插更早消息时保持滚动锚——旧版前插 50 条后视口被顶到
  // 最顶部，用户看到「历史滚不动/跳走」。检测=首条消息 id 变化（前插
  // 特征），锚=前插前记录的 (scrollTop, scrollHeight)；恢复式：
  // newScrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight)。
  // useLayoutEffect（paint 前）——闪顶不可见。
  const prevFirstIdRef = React.useRef("");
  const scrollAnchorRef = React.useRef<{ top: number; height: number } | null>(null);
  const roomKeyRef = React.useRef("");
  const autoLoadRef = React.useRef(false);
  // 锚 effect 在 threadGroups 声明之后（首条顶层消息 id 为判定信号）。

  // 数据推进即解锁——messages 引用变化（前插/轮询追加）
  // 说明上一轮加载已落地 → 立刻允许下一次触碰（旧版只在「前插检测」时解锁，
  // 空页/边界重叠会把接力锁死 6s）；6s 定时器保留为失败路径兜底。
  React.useLayoutEffect(() => {
    autoLoadRef.current = false;
  }, [messages]);

 // 驻顶接力——
  // 每次渲染后（每页落地 / 加载态变化 / 滚动 state 变化）重查顶部位置：
  // 仍在预载余量内且还有历史 → 续拉下一页；滚离即停（节奏=用户滚动节奏，
  // 滚动事件路径由 handleListScroll 覆盖，本 effect 覆盖「驻顶等历史」路径）。
 // 普通聊天与「加载原消息」模式共用；后者的终止仍由父侧（进窗口→
  // 定位 / 触底 / 切房作废）。声明在锚 effect 之后：读到的是锚恢复后的
  // scrollTop（前插后位置被推离顶部 → 自然暂停，用户再上翻时接力）。
  React.useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || !hasMore || !onLoadMore) return;
 // **点引用条后
    // 自动后翻**（Element 同款）——旧版只在用户滚近顶部时才续拉，点了「加载
 // 原消息」但停在原处 → 只前进一页就没了。终止由父侧：进窗口→定位 /
    // 触底 / 超量上限 / 切房作废 / 30s 停滞看门狗。
    if (pendingOriginal) {
      kickLoadMore();
      return;
    }
    if (nearTop(el)) kickLoadMore();
 // deps 化——续拉的判据只依赖
    // 「页落地（messages）/ 待回填目标 / 可载性」，hover 等非数据渲染
    // 不再重复读布局；滚动路径仍由 handleListScroll 覆盖（kickLoadMore
    // 内有 autoLoadRef 防重）。
  }, [messages, pendingOriginal, hasMore, onLoadMore, nearTop, kickLoadMore]);

  // 换房间：重置置底状态 + 贴底（Element 开房间即在最新消息处）。
  // 一并重置 atBottom/pinned（换房贴底后视为在底部）。
  React.useEffect(() => {
    prevMsgLenRef.current = 0;
    atBottomRef.current = true;
    pinnedUntilRef.current = 0;
 // 换房重置审批通知状态（新房间首批=只登记）。
    approvalsSeededRef.current = false;
    seenApprovalsRef.current.clear();
 // 审批解析缓存随房间清（防跨房残留）。
    approvalParseCacheRef.current.clear();
    pendingCacheRef.current = null;
    setNewMsgCount(0);
    setShowJumpBottom(false);
    // 消息窗口回初始（换房=新渲染起点，揭示进度不跨房保留）。
    setWindowLimit(MSG_WINDOW_LIMIT);
    requestAnimationFrame(() => {
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [room?.room_id]);

 // ── ─────────────
 // 「会话级 loop 状态你需要查清楚应该在哪里显示」——
  // 正源=QwenPaw console 前端（LoopModeSelector，chat composer 内
  // 输入工具条）：idle 显所选模式；非 idle 换激活模式指示（图标+模式名
  // +状态词+Tooltip）。插件侧同位落地：1:1 Worker 房间输入区行左侧
  // chip，10s 轮询 /loops/status?session_id=matrix:{room_id}（matrix
  // channel resolve_session_id 实锤：房间会话 session_id=matrix:{room_id}）。
  // 404 = 旧 runtime 无路由 → 恒不显（版本无关门，同 门）。
  const roomWorkerName = React.useMemo(() => {
    if (!workerMxids || workerMxids.size !== 1) return undefined;
    const [mxid] = workerMxids;
    return memberWorkerNames?.[mxid];
  }, [workerMxids, memberWorkerNames]);
  const [roomLoop, setRoomLoop] = React.useState<WorkerLoopStatus | null>(null);
 // 旧定时器 → usePoller（15s——任务书 E 表规范值；
  // 原码实况 10000，按任务书实施并已在报告列明）。换房时清陈旧 chip +
  // 立即拉；roomSeqRef 防旧房迟到响应（原码 dead flag 语义）。
  const roomId = room?.room_id;
  const roomSeqRef = React.useRef(0);
  const roomTick = React.useCallback(() => {
    if (!roomWorkerName || !roomId) return;
    const seq = roomSeqRef.current;
    const sid = `matrix:${roomId}`;
    void fetchWorkerLoopStatusBySession(roomWorkerName, sid)
      .then((r) => {
        if (roomSeqRef.current !== seq) return; // 旧房迟到响应丢弃
        // 非 idle 且有模式才显（QwenPaw：state != idle && activeMode）。
        const next = r && r.state !== "idle" && r.mode ? r : null;
 // 值未变 → 复用旧引用——
        // 15s 轮询每次拿**新对象**，直接 setRoomLoop 每 15s 击穿一次
        // RoomChat memo；state+mode 语义相等则保留 prev。
        setRoomLoop((prev) => (sameLoopStatus(prev, next) ? prev : next));
      })
      .catch(() => {
        if (roomSeqRef.current === seq) setRoomLoop(null);
      });
  }, [roomWorkerName, roomId]);
  // 换房 → 清陈旧 chip + 立即拉（原码 effect 重跑时的 tick()）。
  React.useEffect(() => {
    roomSeqRef.current += 1;
    setRoomLoop(null);
    void roomTick();
  }, [roomWorkerName, roomId, roomTick]);
  usePoller({
    fn: roomTick,
    intervalMs: 15000,
 // 布尔快照（非 chat 互切不重渲）。
    active:
      useTabActive("chat") && !!roomWorkerName && !!roomId,
  });

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
 // memo——此前每次渲染（含 hover /
  // chatsTick 等非数据渲染）都重建数组 → threadGroups useMemo 缓存恒被
  // 击穿（O(n²) 每渲染重跑）。messages 未变则复用引用。
  const visibleMessages = React.useMemo(
    () =>
      messages.filter((m) => {
        if (!(m.body || m.url) && m.msgtype === "m.text") return false;
        if (hideTools && m.msgtype === "m.text" && isToolMessage(m.body || "")) {
          return false;
        }
        return true;
      }),
    [messages, hideTools],
  );

  // 线程分组（Element/Discord 式）：回复消息归入被回复消息的线程，
  // 不再顶层重复显示——"谁的哪条消息回复谁的"一目了然。
  //
  // 窗口封顶（DOM 上限）：只渲染最近 MSG_WINDOW_LIMIT 条顶层消息，更早的
  // 由顶部「显示更早」入口（手动）/ 驻顶接力（滚近顶部自动揭示）逐步放出——
  // 长房间/长滚动会话的重渲成本不再随房间年龄无上界增长。
  // pendingOriginal 激活期旁路（「加载原消息」定位要求目标消息必在 DOM）。
  // 目标消息被窗口藏起的回复降级为顶层、置于渲染窗首（消息序连续，
  // 与「target 不在已载窗口」的既有行为一致）。
  const threadGroups = React.useMemo(() => {
    const g = groupThreads(visibleMessages);
    return applyWindow(g.tops, g.repliesOf, windowLimit, pendingOriginal);
  }, [visibleMessages, windowLimit, pendingOriginal]);
  hiddenCountRef.current = threadGroups.hiddenCount;

  // 前插滚动锚（声明位置在 threadGroups 之后：判定信号=渲染窗首条顶层
  // 消息 id）。loadMore 前插更早消息时保持滚动锚——旧版前插 50 条后视口
  // 被顶到最顶部，用户看到「历史滚不动/跳走」。检测=首条消息 id 变化
  // （前插/揭示特征），锚=前插前记录的 (scrollTop, scrollHeight)；恢复式：
  // newScrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight)。
  // useLayoutEffect（paint 前）——闪顶不可见。
  // 窗口化后覆盖两种「首条变更早消息」：更早的页加载（前插）与窗口揭示
  // （首条变为更早消息）——同一锚恢复式通用：揭示时新高度在顶部生长，
  // 视口贴底不受扰；滚在顶部时位置被推离 → 驻顶接力 effect 按滚动节奏
  // 继续揭示。
  React.useLayoutEffect(() => {
    const el = listRef.current;
    // 换房间：清锚（新房间首条 id 变化不是前插，防误恢复）。
    const rk = room?.room_id || "";
    if (roomKeyRef.current !== rk) {
      roomKeyRef.current = rk;
      prevFirstIdRef.current = "";
      scrollAnchorRef.current = null;
      lastMsgIdRef.current = "";
      autoLoadRef.current = false;
    }
    const firstId = threadGroups.tops[0]?.event_id || "";
    const prepended =
      prevFirstIdRef.current !== "" &&
      firstId !== "" &&
      firstId !== prevFirstIdRef.current;
    if (prepended) {
      autoLoadRef.current = false; // 自动加载完成（新数据已到位）
      const a = scrollAnchorRef.current;
      if (el && a) el.scrollTop = a.top + (el.scrollHeight - a.height);
    }
    if (el) scrollAnchorRef.current = { top: el.scrollTop, height: el.scrollHeight };
    prevFirstIdRef.current = firstId;
  }, [messages, room?.room_id, threadGroups]);

  // 线程面板打开的 root 消息 + 回复列表。
  const activeThreadMsg = React.useMemo(() => {
    if (!activeThread) return null;
    return visibleMessages.find((m) => m.event_id === activeThread) || null;
  }, [activeThread, visibleMessages]);
  const activeThreadReplies = React.useMemo(() => {
    if (!activeThread) return [];
    // 主题根被渲染窗藏起时（孤儿回复降级置顶），从渲染窗内按 reply 目标
    // 反查该主题的回复——线程面板不因窗口化丢失数据（主题消息本体要
    // 看仍需先「显示更早」）。
    const direct = threadGroups.repliesOf.get(activeThread);
    if (direct) return direct;
    return threadGroups.tops.filter(
      (m) => m.reply?.event_id === activeThread,
    );
  }, [activeThread, threadGroups]);

 // useCallback——行内 SenderAvatar
  // memo 依赖其引用稳定（普通函数每渲染新引用 → memo 全击穿）。
  const insertMention = React.useCallback(
    (mxid: string) => {
      const member = room.members?.[mxid];
      const name =
        member?.display_name?.trim() ||
        (mxid.split(":")[0] || mxid).replace(/^@/, "");
      setDraft((d) => (d ? `${d}@${name} ` : `@${name} `));
      setMentionQuery(null);
    },
    [room],
  );
 // 头像行两个内联闭包 → 稳定引用
  // （SenderAvatar memo 的另一半）。
  const openDetailMxid = React.useCallback(
    (m: string) => setDetailMxid(m),
    [],
  );
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
      // Esc 取消编辑（同 Element 语义）。
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
        workerSessionByMxid={workerSessionByMxid}
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

 // 话题面板占宽上报（打开/关闭/调宽/宽窄态变化
  // 均触发）→ 父组件重测分栏。inline 面板（isWide）才吃宽；drawer 模式
  // 是覆盖层不占布局宽，不上报。
  React.useEffect(() => {
    if (!onThreadPanelLayout) return;
    const open = isWide && threadPanelBody !== null;
    onThreadPanelLayout(open, open ? panelWidth : 0);
  }, [isWide, threadPanelBody, panelWidth, onThreadPanelLayout]);

  // 竖屏紧凑头（narrow=容器<800，单一判定与聊天单栏同源同步）：宽屏头部的
  // 6+ 内联控件（成员/项目文件/搜索/⋯菜单/工具开关/成员条/发起任务）全部收进
  // ⋯ 菜单，头部压成 1 行「[返回]|房间名(ellipsis)|阶段|⋯」，把换行吃掉的
  // 垂直空间还给消息区。宽屏（桌面）走原完整头部，零改动。
  const { narrow } = useWbViewport();
  const compactMenuItems = [
    {
      key: "members",
      label: tr("查看成员") + "（" + room.member_count + " " + tr("人") + "）",
    },
    ...(onOpenProjectFiles
      ? [
          {
            key: "project",
            label:
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><FolderIcon size={13} /> {tr("项目文件")}</span>,
          },
        ]
      : []),
    {
      key: "search",
      label:
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><SearchIcon size={13} /> {tr("搜索")}</span>,
    },
    {
      key: "tools",
      label:
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><WrenchIcon size={13} /> {hideTools ? tr("显示工具") : tr("隐藏工具")}</span>,
    },
    ...(onNewTask && room.member_count <= 2
      ? [
          {
            key: "newtask",
            label:
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><TodoIcon size={13} /> {tr("发起任务")}</span>,
          },
        ]
      : []),
    ...(onRenameRoom || onToggleMute || onLeaveRoom
      ? [{ type: "divider" as const }]
      : []),
    ...(onRenameRoom
      ? [
          {
            key: "rename",
            label:
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><EditIcon size={13} /> {tr("重命名房间")}</span>,
          },
        ]
      : []),
    ...(onToggleMute
      ? [
          {
            key: "mute",
            label:
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><BellIcon size={13} /> {muted ? tr("取消静音") : tr("静音此房间")}</span>,
          },
        ]
      : []),
    ...(onLeaveRoom
      ? [
          { type: "divider" as const },
          {
            key: "leave",
            danger: true,
            label:
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><DoorIcon size={13} /> {tr("退出房间")}</span>,
          },
        ]
      : []),
  ];
  const compactMenuClick = ({ key }: { key: string }) => {
    if (key === "members") setMemberPanelOpen(true);
    else if (key === "project") onOpenProjectFiles?.(room);
    else if (key === "search") setSearchOpen(true);
    else if (key === "tools") setHideTools(!hideTools);
    else if (key === "newtask") onNewTask?.();
    else if (key === "rename") openRename();
    else if (key === "mute") void onToggleMute?.();
    else if (key === "leave") {
      antd.Modal.confirm({
        title: tr("退出房间「{name}」？", { name: room.name }),
        content:
          tr("退出后不再接收该房间消息。系统团队房间可能被 Controller 调和器自动重新邀请；非系统房间需再次被邀请才能进入。"),
        okText: tr("退出"),
        okButtonProps: { danger: true },
        cancelText: tr("返回"),
        onOk: () => onLeaveRoom?.(),
      });
    }
  };
  const compactHeader = (
    <div
      style={{
        display: "flex",
        // 内容纵向居中（返回钮 vs 多行群名，对最高者垂直居中）。
        alignItems: "center",
        gap: 6,
        // 竖屏紧凑头收窄：padding 4/10→2/8（左右更贴、上下留白更少），高度由返回钮触区决定。
        padding: "2px 8px",
        borderBottom: "1px solid rgba(0,0,0,0.08)",
        flexWrap: "nowrap",
      }}
    >
      {headerPrefix}
      {onBack ? (
        // 返回钮放大适配触屏（size large≈40px 触区，替代 small 24px 难点）。
        <antd.Button size="large" onClick={onBack} aria-label={tr("返回")} style={{ flexShrink: 0 }}>
          ← 返回
        </antd.Button>
      ) : null}
      <div style={{ flex: 1, minWidth: 0, overflow: "hidden", display: "flex", alignItems: "center" }}>
        <antd.Typography.Title
          level={5}
          style={{
            margin: 0,
            fontSize: 14,
            lineHeight: 1.2,
            // 群名自动换行（竖屏不截断——长群名完整显示多行，短群名单行）。
            whiteSpace: "normal",
            wordBreak: "break-word",
          }}
        >
          {room.name}
        </antd.Typography.Title>
      </div>
      {workerBadge?.phase ? (
        <antd.Tag
          color={
            workerBadge.phase === "Running"
              ? "green"
              : workerBadge.phase === "Sleeping" ||
                  workerBadge.phase === "Stopped"
                ? "orange"
                : "default"
          }
          style={{ margin: 0, flexShrink: 0 }}
        >
          {workerBadge.phase}
        </antd.Tag>
      ) : null}
      <antd.Dropdown
        trigger={["click"]}
        menu={{ items: compactMenuItems, onClick: compactMenuClick }}
      >
        <antd.Button size="small" type="text" aria-label={tr("更多")}>
          ⋯
        </antd.Button>
      </antd.Dropdown>
    </div>
  );

  // 竖屏 composer：发送/附件/表情按钮提取为 const——窄屏与输入框同 row（发送贴输入框旁，
  // size small 高度别太高），宽屏原操作行复用同款按钮（行为不变）。
  return {
    room,
    messages,
    loading,
    sending,
    hasMore,
    loadingMore,
    user_id,
    canSend,
    onSend,
    onSendFiles,
    onSendApproval,
    onSendEdit,
    onRedact,
    onLeaveRoom,
    onRenameRoom,
    muted,
    onToggleMute,
    onReact,
    onDm,
    onBack,
    headerPrefix,
    onOpenWorkerChats,
    onNewTask,
    onLoadMore,
    onPoll,
    errorNote,
    jumpToEventId,
    onJumpHandled,
    liveWorkflows,
    activityProject,
    onThreadPanelLayout,
    memberRoles,
    memberWorkerNames,
    workerRuntimeByMxid,
    workerBadge,
    sessionState,
    workerMxids,
    workerSessionByMxid,
    onOpenProject,
    onWorkflowIntervened,
    onOpenProjectFiles,
    onLoadOriginal,
    pendingOriginal,
    draft,
    setDraft,
    fileRefs,
    setFileRefs,
    refPickerOpen,
    setRefPickerOpen,
    editing,
    setEditing,
    renameOpen,
    setRenameOpen,
    renameValue,
    setRenameValue,
    powerInfo,
    setPowerInfo,
    powerLoading,
    setPowerLoading,
    dragOver,
    setDragOver,
    hoveredId,
    setHoveredId,
    resolvedApprovals,
    setResolvedApprovals,
    mentionQuery,
    setMentionQuery,
    mentionIndex,
    setMentionIndex,
    readTs,
    setReadTs,
    searchOpen,
    setSearchOpen,
    detailMxid,
    setDetailMxid,
    hideTools,
    setHideTools,
    panelWidth,
    setPanelWidthState,
    activeThread,
    setActiveThreadState,
    isWide,
    setIsWide,
    dragging,
    setDragging,
    memberPanelOpen,
    setMemberPanelOpen,
    replyTo,
    setReplyTo,
    showJumpBottom,
    setShowJumpBottom,
    newMsgCount,
    setNewMsgCount,
    windowLimit,
    setWindowLimit,
    jumpContext,
    setJumpContext,
    roomLoop,
    setRoomLoop,
    liveByRunId,
    teamName,
    openRename,
    composerRef,
    composerBoxRef,
    THREAD_STATE_KEY,
    readThreadState,
    initialThreadState,
    threadOpenedInNarrowRef,
    setActiveThread,
    chatTabActive1514,
    setPanelWidth,
    dragStartXRef,
    dragStartWRef,
    onPanelHandleDown,
    listRef,
    fileInputRef,
    hoverTimerRef,
    prevMsgLenRef,
    atBottomRef,
    pinnedUntilRef,
    followRafRef,
    scheduleFollow,
    nearTop,
    revealWindow,
    hiddenCountRef,
    kickLoadMore,
    handleListScroll,
    jumpToBottom,
    t,
    tr,
    jumpToMessage,
    jumpContextRef,
    clearJumpContext,
    handleSearchJump,
    draftKey,
    handleSend,
    handleApprovalAction,
    handleDeliverable,
    seenApprovalsRef,
    approvalsSeededRef,
    pendingCacheRef,
    approvalParseCacheRef,
    lastMsgIdRef,
    prevFirstIdRef,
    scrollAnchorRef,
    roomKeyRef,
    autoLoadRef,
    roomWorkerName,
    roomId,
    roomSeqRef,
    roomTick,
    myUserId,
    mentionTargets,
    visibleMessages,
    threadGroups,
    activeThreadMsg,
    activeThreadReplies,
    insertMention,
    openDetailMxid,
    mentionCandidates,
    confirmMention,
    handleDraftChange,
    handleKeyDown,
    threadPanelBody,
    compactMenuItems,
    compactMenuClick,
    compactHeader,
    narrow,
  };
}

export type RoomChatCoreState = Exclude<
  ReturnType<typeof useRoomChatCore>,
  ReactNS.ReactElement
>;
