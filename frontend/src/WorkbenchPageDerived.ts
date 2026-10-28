// WorkbenchPage 拆分模块——派生值与面板回调。
// 自 WorkbenchPage 单体原样搬移（技术债批次 D3b）；逻辑零改动，
// 壳持有的 React state 经 ctx 传入，标识符保持原名。

import {
  roomMatchesProject,
  type AdminData,
  type TeamRoom,
  type WorkbenchConfig,
  type WorkflowEvent,
} from "./api";
import { WfView } from "./components/WorkflowBoard";
import { usePoller } from "./usePoller";
import { CHAT_SPLIT_MIN_CONTAINER_W } from "./WorkbenchPageShared";

const host = window.QwenPaw.host;
const React = host.React;

export interface WorkbenchPageDerivedCtx {
  config: WorkbenchConfig | null;
  rooms: TeamRoom[];
  workflowEvents: WorkflowEvent[];
  workflowSource: "controller" | "rooms";
  adminData: AdminData | null;
  tab: string;
  setTab: (tab: string) => void;
  setActiveRoom: React.Dispatch<React.SetStateAction<TeamRoom | null>>;
  openRoom: (roomId: string) => boolean;
  /** 打开/创建 DM；name = 房间显示名（发起任务入口带上下文透传）。 */
  handleDm: (mxid: string, roomId?: string, name?: string) => Promise<void>;
  setGlobalSearchOpen: (v: boolean) => void;
  setJumpToEventId: (v: string | null) => void;
  refreshWorkflow: (silent?: boolean) => Promise<void>;
  setWfMem: (patch: { view?: string; topoRun?: string }) => void;
  refreshRooms: (silent?: boolean, force?: boolean) => Promise<void>;
  refreshConfig: () => Promise<void>;
  configLoadState: "loading" | "ready" | "failed";
  setConfigLoadState: (v: "loading" | "ready" | "failed") => void;
  closeChatRoom: () => void;
  chatWide: boolean;
  chatForceWide: boolean;
  setChatListHiddenPersist: (hidden: boolean) => void;
}

export function useWorkbenchDerived(ctx: WorkbenchPageDerivedCtx) {
  const { config, rooms, workflowEvents, workflowSource, adminData, tab, setTab, setActiveRoom, openRoom, handleDm, setGlobalSearchOpen, setJumpToEventId, refreshWorkflow, setWfMem, refreshRooms, refreshConfig, configLoadState, setConfigLoadState, closeChatRoom, chatWide, chatForceWide, setChatListHiddenPersist } = ctx;

  // 自己的显示名：从房间成员里找 display_name，fallback MXID localpart。
  const selfDisplayName = React.useMemo(() => {
    const me = config?.matrix?.user_id;
    if (!me) return "";
    for (const room of rooms) {
      const member = room.members?.[me];
      if (member?.display_name) return member.display_name;
    }
    return "";
  }, [config?.matrix?.user_id, rooms]);

  // 房间 → 匹配项目事件
  // （与 roomProjectNames 同匹配源 roomMatchesProject，取首个命中；
  // 活动轨只需一个项目，多项目房间以列表首个为准，工作流 tab 仍可全看）。
  const roomProjectByRoom = React.useMemo(() => {
    const m: Record<string, WorkflowEvent> = {};
    for (const room of rooms) {
      for (const ev of workflowEvents) {
        if (roomMatchesProject(room.room_id, room.name, undefined, ev)) {
          m[room.room_id] = ev;
          break;
        }
      }
    }
    return m;
  }, [rooms, workflowEvents]);

 // Tabs items / 聊天双元素的回调 prop 稳定化
  // ——修复前全是内联箭头（每次渲染新引用 → 面板 memo 全部击穿，memo 白包）。
  // 数据类 props（rooms/messages/config/refreshTick 等）保持原样不动。
  const handleHomeOpenRoom = React.useCallback(
    (roomId: string) => {
      setTab("chat");
      void openRoom(roomId);
    },
    [setTab, openRoom],
  );
  const handleGotoTab = React.useCallback(
    (tabKey: string) => setTab(tabKey),
    [setTab],
  );
  // 不再 void 吞掉 Promise——「发起任务」弹窗确认钮要等 /dm 落地
  // 才关窗（loading 期间禁用，失败 toast 可见）；其余入口不 await，
  // 多返回的 Promise 对 void 型 prop 无影响（handleDm 内部全捕获，
  // 不 reject）。
  const handleDmStable = React.useCallback(
    (mxid: string, roomId?: string, name?: string) =>
      handleDm(mxid, roomId, name),
    [handleDm],
  );
  const openGlobalSearch = React.useCallback(() => setGlobalSearchOpen(true), []);
 // MessageSearch props 稳定化（内联箭头
  // 每次渲染新引用 → memo 击穿，每次点击/数据波都重渲组件体）。
  const handleGlobalSearchClose = React.useCallback(
    () => setGlobalSearchOpen(false),
    [],
  );
  const handleGlobalSearchOpenRoomOnly = React.useCallback(
    (roomId: string) => {
      setTab("chat");
      openRoom(roomId);
    },
    [setTab, openRoom],
  );
  const gotoApprovals = React.useCallback(() => setTab("home"), [setTab]);
  const gotoInvites = React.useCallback(() => {
    setActiveRoom(null);
    setTab("chat");
  }, [setTab]);
  const gotoSettings = React.useCallback(() => setTab("settings"), [setTab]);
  const handleWfRefresh = React.useCallback(
    () => void refreshWorkflow(),
    [refreshWorkflow],
  );
  const handleWfViewChange = React.useCallback(
    (v: WfView) => setWfMem({ view: v }),
    [setWfMem],
  );
  const handleWfTopoRunChange = React.useCallback(
    (runId: string) => setWfMem({ topoRun: runId }),
    [setWfMem],
  );
  const handleWfIntervened = React.useCallback(
    () => void refreshWorkflow(true),
    [refreshWorkflow],
  );
  const handleRoomsRefresh = React.useCallback(
    () => void refreshRooms(),
    [refreshRooms],
  );
  const handleInviteSettled = React.useCallback(
    () => void refreshRooms(true, true),
    [refreshRooms],
  );
  const handleConfigChange = React.useCallback(
    () => void refreshConfig(),
    [refreshConfig],
  );
 // 设置页「重试」按钮——置回 loading 再走
  // refreshConfig（内部含 3 次退避重试）。
  const handleConfigRetry = React.useCallback(() => {
    setConfigLoadState("loading");
    void refreshConfig();
  }, [refreshConfig]);
 // 周期兜底——settings tab 激活且 config 未就绪时
  // 每 5s 重取（refreshConfig 自带退避重试，此处只是「第二次机会」的定时器；
  // 就绪即停，零空转）。覆盖「首 GET 撞上插件重载窗口 + 用户不切 tab 不操作」
 // 的静默失败路径（「没有记忆」事故链）。
  usePoller({
    fn: () => void refreshConfig(),
    intervalMs: 5000,
    active: tab === "settings" && configLoadState !== "ready",
  });
  const handleChatBack = React.useCallback(
    () => {
      closeChatRoom();
      if (!chatWide) setChatListHiddenPersist(false);
    },
    [closeChatRoom, chatWide, setChatListHiddenPersist],
  );
  const handleJumpHandled = React.useCallback(() => setJumpToEventId(null), []);
  const noopStable = React.useCallback(() => void 0, []);
  // 内联字面量也是每次渲染新引用（[] / ?? []）→ useMemo 钉住。
  const liveWorkflows = React.useMemo(
    () => (workflowSource === "controller" ? workflowEvents : []),
    [workflowSource, workflowEvents],
  );
  const adminWorkers = React.useMemo(() => adminData?.workers ?? [], [adminData]);
  const selfCheckLayout = React.useMemo(
    () => ({
      wide: chatWide,
      forced: chatForceWide,
      threshold: CHAT_SPLIT_MIN_CONTAINER_W,
    }),
    [chatWide, chatForceWide],
  );

 // 房间卡项目名——与 ProjectFiles 面板
  // 同一正源数据。匹配改 roomMatchesProject
  // 双源（source_room_id 严格匹配 ∪ 标准项目群命名 `Project: <项目名>`）
  // ——旧版只按 ev.room_id 建索引，标准项目群（source_room_id 指向发起
 // 房间）卡片恒无项目名（13.14）。
  const roomProjectNames = React.useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const room of rooms) {
      for (const ev of workflowEvents) {
        if (roomMatchesProject(room.room_id, room.name, undefined, ev)) {
          const list = m[room.room_id] || (m[room.room_id] = []);
          const title = ev.title || ev.runId;
          if (!list.includes(title)) list.push(title);
        }
      }
    }
    return m;
  }, [rooms, workflowEvents]);

  // MXID → 角色标签（Leader/
  // Worker/Manager）。WorkerInfo 自带 role（team_leader→Leader，余→
  // Worker）；Manager 单独归 Manager 类。无 L1 管理数据 → undefined →
  // TeamOverview 自动退回扁平列表。
  const workerRoleByMxid = React.useMemo(() => {
    if (!adminData) return undefined;
    const m: Record<string, string> = {};
    for (const w of adminData.workers || []) {
      if (w.matrixUserID) m[w.matrixUserID] = w.role === "team_leader" ? "Leader" : "Worker";
    }
    for (const mg of adminData.managers || []) {
      if (mg.matrixUserID) m[mg.matrixUserID] = "Manager";
    }
    return Object.keys(m).length ? m : undefined;
  }, [adminData]);
  return {
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
  };
}
