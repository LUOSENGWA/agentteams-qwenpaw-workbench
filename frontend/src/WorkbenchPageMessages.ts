// WorkbenchPage 拆分模块——消息窗口/轮询/跳转。
// 自 WorkbenchPage 单体原样搬移（技术债批次 D3b）；逻辑零改动，
// 壳持有的 React state 经 ctx 传入，标识符保持原名。

import {
  fetchRoomMessages,
  fetchTeamsSync,
  getCachedMessages,
  markAllRoomsRead,
  markRoomRead,
  setCachedMessages,
  type AdminData,
  type RoomMessage,
  type TeamRoom,
  type WorkerTreeTeam,
} from "./api";
import { RoomHistory, mergeForward } from "./roomHistory";
import {
  nextBackfillAction,
  computeWindowFloorForJump,
} from "./originalJump";
import { useT } from "./i18n";
import { useWorkerSessionStates } from "./workerSessionState";
import { useWorkerChatStatuses } from "./workerChatStatus";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
const { message } = antd;

export interface WorkbenchPageMessagesCtx {
  activeRoom: TeamRoom | null;
  setActiveRoom: React.Dispatch<React.SetStateAction<TeamRoom | null>>;
  setTab: (tab: string) => void;
  writeUiState: (tab: string, roomId: string | null) => void;
  rooms: TeamRoom[];
  setRooms: React.Dispatch<React.SetStateAction<TeamRoom[]>>;
  workerTree: WorkerTreeTeam[];
  adminData: AdminData | null;
  tr: ReturnType<typeof useT>;
  messages: RoomMessage[];
  setMessages: React.Dispatch<React.SetStateAction<RoomMessage[]>>;
  messagesRef: React.MutableRefObject<RoomMessage[]>;
  messagesEnd: string;
  setMessagesEnd: (v: string) => void;
  setMessagesLoading: (v: boolean) => void;
  setHasMore: (v: boolean) => void;
  hasMore: boolean;
  setRoomError: (v: string) => void;
  setLoadingMore: (v: boolean) => void;
  setMarkingAllRead: (v: boolean) => void;
  pendingOriginalId: string | null;
  setPendingOriginalId: (v: string | null) => void;
  /** （R2 显式跳转）渲染窗口下界 setter（命中原消息时抬升，见 originalJump）。 */
  setMinWindowTops: (v: number) => void;
  setJumpToEventId: (v: string | null) => void;
}

export function useWorkbenchMessages(ctx: WorkbenchPageMessagesCtx) {
  const { activeRoom, setActiveRoom, setTab, writeUiState, rooms, setRooms, workerTree, adminData, tr, setMessages, messagesRef, messagesEnd, setMessagesEnd, setMessagesLoading, setHasMore, setRoomError, setLoadingMore, setMarkingAllRead, pendingOriginalId, setPendingOriginalId, setMinWindowTops, setJumpToEventId } = ctx;

  // 消息历史窗口状态机——收敛原 windowRoomRef /
  // messagesEndRef / loadingMoreRef / prefetchRef 四个散落 ref（I1–I6
  // 不变量见 roomHistory.ts 模块头；组件只持有消息数组与 React 镜像）。
  const histRef = React.useRef<RoomHistory | null>(null);
  if (!histRef.current) histRef.current = new RoomHistory(fetchRoomMessages);
  const hist = histRef.current;

  // ── 已读回执（m.read + m.fully_read 双写）──────────
  // 打开房间/轮询到新消息 → 对最新消息发回执 → Element 侧不再显示未读。
  // 去重：同一 (room, event) 只发一次；本地未读 badge 同步清零。
  const lastReadRef = React.useRef<{ roomId: string; eventId: string } | null>(null);
  const markCurrentRead = React.useCallback(
    async (roomId: string, latestEventId?: string) => {
      const eventId = (latestEventId || "").trim();
      if (!roomId || !eventId) return;
      const last = lastReadRef.current;
      if (last && last.roomId === roomId && last.eventId === eventId) return;
      const res = await markRoomRead(roomId, eventId);
      if (res && res.ok) {
        lastReadRef.current = { roomId, eventId };
        setRooms((prev) =>
          prev.map((r) =>
            r.room_id === roomId
              ? { ...r, unread: 0, unread_highlight: 0 }
              : r,
          ),
        );
      }
    },
    [],
  );

  const handleMarkAllRead = React.useCallback(async () => {
    const unreadIds = rooms
      .filter((r) => (r.unread || 0) > 0 || (r.unread_highlight || 0) > 0)
      .map((r) => r.room_id);
    if (unreadIds.length === 0) return;
    setMarkingAllRead(true);
    const res = await markAllRoomsRead(unreadIds);
    if (res && res.ok) {
      setRooms((prev) =>
        prev.map((r) =>
          unreadIds.includes(r.room_id)
            ? { ...r, unread: 0, unread_highlight: 0 }
            : r,
        ),
      );
    }
    setMarkingAllRead(false);
  }, [rooms]);

  // ── 消息窗口同步（开房 / 状态恢复 / 静默刷新）────────────────────
  // 收敛：窗口游标（I1）/ 预取单槽（I3）/ 在飞闸（I5）
 // / 空页走查（I4）全部收敛进 RoomHistory 状态机（不变量与溯源见
  // roomHistory.ts 模块头）。本函数是**唯一的窗口建立路径**——13.19 的
  // 状态恢复内联块已退役（它曾是第 4 条分叉路径：无 I2 合并 / 无 I1 窗口
  // 游标 / 缓存被浅页覆盖 → 深历史蒸发 + 游标回退家族）。
  //
  // 保留的验收语义（13.10 / 13.16 / 13.18 / 13.19 逐条可溯源）：
  // · 缓存即时显示 + 后台拉新；
  // · I1 游标只在首窗建立（= 缓存 end ?? 本页 end），refresh 永不回退
  // 浅游标（13.19 假死根因）；
  // · I2 合并而非替换（mergeForward——13.10「消息滚出历史」根因）；
  // · I3 开房即预取下一页（13.18 管道起步 → 首次上翻零等待）；
  // · I6 缓存 = 全量窗口 + 窗口游标（13.10/13.19）。
  const refreshMessages = React.useCallback(async (room: TeamRoom, silent = false) => {
    if (!silent) setMessagesLoading(true);
    try {
      // 缓存即时显示，后台拉新。
      const cached = getCachedMessages(room.room_id);
      // I1 判定用**调用瞬间**的已加载条数（不是 set 之后的新值）。
      const curCount = messagesRef.current.length;
      const fresh = hist.isFresh(room.room_id, curCount);
      if (cached) {
        setMessages(cached.messages);
        if (fresh) {
          setMessagesEnd(cached.end);
          setHasMore(Boolean(cached.end));
        }
      }
      const page = await fetchRoomMessages(room.room_id, 50);
      // I2 合并基底 = 当前在屏全量 与 缓存窗口 的较长者：
      // · 切房时 room-reset effect 已把 messagesRef 归零，取缓存（否则
      // 旧逻辑用空基底合并 → 浅页覆盖缓存深历史，13.10 语义在开房
      // 路径上破洞——本轮修复的实存 bug）；
      // · 同房静默刷新时两者同长，取 ref（含 poll/send 的尾部增量）。
      const base =
        curCount >= (cached?.messages.length ?? 0)
          ? messagesRef.current
          : (cached?.messages ?? []);
      const merged = mergeForward(base, page.messages);
      setMessages(merged);
      // I1 窗口游标：首窗 = 缓存 end ?? 本页 end；非首窗 = 既有游标
      // （loadOlder 单调推进的那个；缓存被逐出时也不回退）。
      const windowEnd = hist.windowEnd(room.room_id, curCount, cached?.end, page.end);
      hist.commit(room.room_id, windowEnd);
      setMessagesEnd(windowEnd);
      setHasMore(Boolean(windowEnd));
      // I3：开房即预取下一页（管道起步 → 首次上翻即零等待）。
      hist.prefetch(room.room_id, windowEnd);
      setRoomError(page.error === "not_found" ? "not_found" : "");
      // I6：缓存存全量已加载历史（含 loadOlder 前插）+ 窗口游标（不回退）。
      setCachedMessages(room.room_id, { ...page, end: windowEnd }, merged);
      // 已读：messages 升序，末条 = 最新。
      void markCurrentRead(room.room_id, page.messages[page.messages.length - 1]?.event_id);
    } catch (e) {
      if (!silent) message.error(e instanceof Error ? e.message : tr("获取消息失败"));
    } finally {
      if (!silent) setMessagesLoading(false);
    }
  }, []);

  // 取页状态（R2 显式循环消费）：loaded=落地；busy=他人在飞（I5 单发闸，
  // 调用方稍后重试）；error=取页失败（toast 已给）；none=无房/无游标。
  const loadMore = React.useCallback(async (): Promise<
    "loaded" | "none" | "busy" | "error"
  > => {
    if (!activeRoom || !messagesEnd) return "none";
    if (hist.busy) return "busy"; // I5 在飞单发
    hist.setBusy(true);
    setLoadingMore(true);
    try {
      // I4 空页走查 + I3 预取命中：从当前窗口游标取页；整页去重零新增
      // → 立即续走下一页（≤WALK_CAP；游标不前进即停）——「空页 → 6s 锁
      // → 再触发」的假死一次走完（13.19 验收）；预取命中 = 零网络等待，
      // miss/预取失败 = 直拉兜底（13.18 验收）。
      const known = new Set(messagesRef.current.map((m) => m.event_id));
      const { page, older } = await hist.walkFrom(activeRoom.room_id, known);
      // I2 前插（零新增 = 不前插 = 无渲染变化 = 不闪跳）。
      const merged = older.length
        ? [...older, ...messagesRef.current]
        : messagesRef.current;
      setMessages(merged);
      // I1 游标沿更早方向推进 + I6 落盘全量窗口（游标不回退）。
      hist.commit(activeRoom.room_id, page.end);
      setMessagesEnd(page.end);
      setHasMore(Boolean(page.end));
      setCachedMessages(activeRoom.room_id, { ...page, messages: merged }, merged);
      // I3 管道常驻：落盘后立即预取再下一页（用户滚到边界时通常已零等待）。
      hist.prefetch(activeRoom.room_id, page.end);
      return "loaded";
    } catch (e) {
      message.error(e instanceof Error ? e.message : tr("加载更早消息失败"));
      return "error";
    } finally {
      hist.setBusy(false);
      setLoadingMore(false);
    }
  }, [activeRoom, messagesEnd]);

  // ── 「加载原消息」= 显式分页跳转（R2）────────────────────
  // 点按钮 → 本函数内串行翻页直到目标进窗口（限页上限 ORIGINAL_PAGE_CAP）
  // → 抬渲染窗口下界 + 走既有定位/高亮链；上限内找不到 → exhausted（banner
  // 落 /context 定位区兜底）。替换旧的「kickstart 一页 + 滚到顶自动续拉」
  // 接力——其游标/在飞闸/空页走查边界态是「有时加载不出来」「前插锚定补偿
  // 失败跑到顶部」的范式性根因。取页仍全走 loadMore/RoomHistory
  // （I1–I6 不变量一处收敛），此处只做循环决策（纯函数 originalJump）。
  const pendingOrigGenRef = React.useRef(0);
  const pendingOrigIdRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    pendingOrigIdRef.current = pendingOriginalId;
  }, [pendingOriginalId]);
  const settlePendingOriginal = React.useCallback(
    (_kind: "found" | "exhausted" | "cancelled") => {
      // 作废本轮：gen++（在飞循环下一次检查即自止）+ 清 pending（旁路释放）。
      pendingOrigGenRef.current += 1;
      setPendingOriginalId(null);
    },
    [setPendingOriginalId],
  );
  const finishPendingOriginalJump = React.useCallback(() => {
    // 定位完成（jumpToMessage 高亮 / /context 兜底）→ 释放 pending：
    // 渲染窗口旁路关闭；下界（minWindowTops）已抬升，深层目标不被裁掉。
    if (pendingOrigIdRef.current) {
      pendingOrigGenRef.current += 1;
      pendingOrigIdRef.current = null;
      setPendingOriginalId(null);
    }
  }, [setPendingOriginalId]);
  React.useEffect(() => {
    // 切房/关房 → 作废进行中的加载（cancelled：banner 回 idle，不标 notfound）。
    if (pendingOrigIdRef.current) settlePendingOriginal("cancelled");
  }, [activeRoom?.room_id, settlePendingOriginal]);
  const loadOriginal = React.useCallback(
    async (
      eventId: string,
    ): Promise<"found" | "exhausted" | "cancelled"> => {
      if (!activeRoom || !eventId) return "cancelled";
      if (pendingOrigIdRef.current === eventId) return "cancelled"; // 已在进行中
      // 换目标：作废旧循环（旧循环下一次 gen 检查自止，返回 cancelled）。
      if (pendingOrigIdRef.current) settlePendingOriginal("cancelled");
      const myGen = ++pendingOrigGenRef.current;
      pendingOrigIdRef.current = eventId;
      setPendingOriginalId(eventId);
      // 停滞看门狗：每页落地重置；30s 无新页（服务端分页异常）→ gen++
      // 作废本轮（循环自止返回 cancelled，banner 回 idle 可再点），不静默死挂。
      let stallTimer = 0;
      const armStall = () => {
        window.clearTimeout(stallTimer);
        stallTimer = window.setTimeout(() => {
          pendingOrigGenRef.current += 1;
        }, 30000);
      };
      armStall();
      try {
        let pages = 0;
        for (;;) {
          if (pendingOrigGenRef.current !== myGen) return "cancelled";
          // 单步决策（纯函数）：进窗口→found / 触底或到上限→exhausted / 否则取页。
          const known = new Set(messagesRef.current.map((m) => m.event_id));
          const action = nextBackfillAction(known.has(eventId), hist.cursor, pages);
          if (action !== "fetch") break;
          const r = await loadMore();
          if (r === "busy") continue; // 他人在飞（I5 单发）：等落地后重新决策
          if (r === "error") break; // 取页失败（toast 已给）：回 idle 可重试
          if (r === "none") break; // 无可载：交最终判定
          pages += 1;
          armStall();
        }
        if (messagesRef.current.some((m) => m.event_id === eventId)) {
          // 命中：先抬渲染窗口下界（旁路释放后目标不丢），再启动既有
          // 定位+高亮链；pendingOriginal 旁路保持到定位完成
          // （onJumpHandled → finishPendingOriginalJump）才释放。
          setMinWindowTops(computeWindowFloorForJump(messagesRef.current, eventId));
          setJumpToEventId(eventId);
          return "found";
        }
        settlePendingOriginal("exhausted");
        return "exhausted";
      } finally {
        window.clearTimeout(stallTimer);
      }
    },
    [
      activeRoom,
      hist,
      loadMore,
      messagesRef,
      setJumpToEventId,
      setMinWindowTops,
      settlePendingOriginal,
    ],
  );

  // 长轮询：增量拉新消息（dir=b 前 10 条），按 event_id 去重合并。
  const pollMessages = React.useCallback(async () => {
    if (!activeRoom) return;
    try {
      const page = await fetchRoomMessages(activeRoom.room_id, 10);
      const known = new Set(
        messagesRef.current.map((m) => m.event_id),
      );
      const fresh = page.messages.filter((m) => !known.has(m.event_id));
      if (fresh.length) {
        // I2：与窗口路径同一合并原语（去重追加；ref 二次防御并发前插）。
        setMessages((prev) => mergeForward(prev, fresh));
        // 已读：正在看的房间来了新消息 → 对最新一条发回执。
        void markCurrentRead(
          activeRoom.room_id,
          fresh[fresh.length - 1].event_id,
        );
      }
    } catch {
      /* 静默——轮询失败不打扰用户 */
    }
  }, [activeRoom, markCurrentRead]);

  const openRoom = React.useCallback(
    (roomId: string): boolean => {
      const room = rooms.find((r) => r.room_id === roomId);
      if (!room) return false;
      setActiveRoom(room);
      // 开房间必落 chat tab（首页最近动态点行不跳转——
      // 此前 writeUiState(tab=home) + 调用方漏 setTab → 房间开了但停在首页）。
      writeUiState("chat", room.room_id);
      void refreshMessages(room);
      return true;
    },
    [rooms, refreshMessages, writeUiState],
  );

  const handleGlobalSearchOpenRoom = React.useCallback(
    (roomId: string, eventId: string) => {
      openRoom(roomId);
      setJumpToEventId(eventId);
    },
    [openRoom],
  );

  // 通知中心「去房间」：@提到你 等通知带 room_id → 切聊天 tab + 打开房间
  //（跳转修复：此前通知条目只有展开/已读，没有任何跳转）。
  // eventId 可选 → 跳房间并定位到该条消息（房间通知 @你 跳转）。
  const handleGotoRoom = React.useCallback(
    (roomId: string, eventId?: string) => {
      setTab("chat");
      const ok = openRoom(roomId);
      if (eventId) setJumpToEventId(eventId);
      if (ok) return;
      // 房间不在缓存（新加入/缓存过期）→ 此前静默失败
      //（真机反馈「点击消息跳转还不行」的另一根因：openRoom 找不到
      // 直接 return）。强制刷新一次重试，仍无 → 明确提示。
      void (async () => {
        try {
          const payload = await fetchTeamsSync(true);
          const fresh = payload.rooms.find((r) => r.room_id === roomId);
          if (fresh) {
            setRooms(
              (prev) =>
                prev.some((r) => r.room_id === roomId)
                  ? prev.map((r) => (r.room_id === roomId ? fresh : r))
                  : [...prev, fresh],
            );
            setActiveRoom(fresh);
            writeUiState("chat", roomId);
            void refreshMessages(fresh);
          } else {
            message.warning(
              tr("未找到该房间（可能尚未加入）——可先在聊天 tab 列表手动打开"),
            );
          }
        } catch {
          /* 刷新失败——用户可手动打开 */
        }
      })();
    },
    [openRoom, refreshMessages, writeUiState, tr],
  );

  // 成员角色表（成员详情卡）：MXID → 领/工/审/unknown（Worker 树推断）。
  const memberRoles = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const team of workerTree || []) {
      for (const w of team.workers || []) {
        if (w.mxid && w.role) map[w.mxid] = w.role;
      }
    }
    return map;
  }, [workerTree]);

  // MXID → Worker 容器名（聊天房间成员卡的「工具执行安全」
  // 审批卡需要容器名寻址 agent.json；L2 房间降级树无容器名 → 不显示）。
  const memberWorkerNames = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const team of workerTree || []) {
      for (const w of team.workers || []) {
        if (w.mxid && w.worker_name) map[w.mxid] = w.worker_name;
      }
    }
    return map;
  }, [workerTree]);

  // room_id → Worker phase/runtime 徽章（聊天头注入）。
  // 数据 = Worker CR 字段：admin 数据优先（全量），tree 兜底（L2/未配 token）。
  // runtimeDeprecated 同批透传（legacy 角标 #8）。
  const workerBadgeMap = React.useMemo(() => {
    const map: Record<
      string,
      { phase?: string; runtime?: string; runtimeDeprecated?: boolean }
    > = {};
    for (const w of adminData?.workers || []) {
      if (w.roomID)
        map[w.roomID] = {
          phase: w.phase || undefined,
          runtime: w.runtime || undefined,
          runtimeDeprecated: w.runtimeDeprecated || undefined,
        };
    }
    for (const team of workerTree || []) {
      for (const w of team.workers || []) {
        if (w.room_id && !map[w.room_id])
          map[w.room_id] = {
            phase: w.phase || undefined,
            runtime: w.runtime || undefined,
            runtimeDeprecated: w.runtimeDeprecated || undefined,
          };
      }
    }
    return map;
  }, [adminData, workerTree]);

  // Worker session 运行指示——统一派生（四落点共用：
  // 房间卡列表 / Worker 行 / 1:1 聊天头 / 聊天主列表发送者行）。
  // 心跳优先（adminData.workers 的 agentStatus/runningTaskCount/
  // lastFinishAt，GET /workers 既有通道零新请求；旧版 controller 无 → 降级
  // typing+last_ts），60s 老化。
 // session 级正源轮询——
  // /chats per-session status（idle|running，qwenpaw app 自维护）。
  // v1.2.4 GET /workers 无心跳字段，消息级启发式在「任务执行中未发言」时
  // 恒灰；chat.running 优先于 typing，修掉该盲区。30s tick、仅可见时、
  // 失败静默保旧值（降级回消息级启发式）。
  const chatPollNames = React.useMemo(() => {
    const s = new Set<string>();
    for (const team of workerTree || [])
      for (const w of team.workers || []) if (w.worker_name) s.add(w.worker_name);
    for (const w of adminData?.workers || [])
      if (w.name) s.add(w.name);
    return Array.from(s).sort();
  }, [workerTree, adminData?.workers]);
  const chatStatuses = useWorkerChatStatuses(chatPollNames, true);
  const workerSessionStates = useWorkerSessionStates(
    rooms,
    workerTree,
    adminData?.workers,
    chatStatuses,
  );
  return {
    hist,
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
    chatPollNames,
    chatStatuses,
    workerSessionStates,
  };
}
