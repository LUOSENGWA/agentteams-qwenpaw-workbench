// 聊天视图层状态 hook（任务 D 拆分自 RoomChat 组件体，L330-620 纯逻辑逐句
// 搬迁，无 JSX）：ChatIR 回合组装 + 任务事件交错 + 视口窗口化。
// RoomChat 组件只剩布局与渲染；扩窗/交错/滚动协同全部收敛在此。
import type * as ReactNS from "react";
import {
  type RoomMessage,
  type ProjectTransitionEvent,
  type TaskDetail,
  fetchProjectTransitionEvents,
} from "../api";
import { buildTurns, type Turn } from "../chat/ChatIR";
import {
  VWIN_INITIAL,
  VWIN_MIN,
  ensureItemVisible,
  expandRange,
  nextViewRange,
  type ViewRange,
} from "../chat/renderWindow";
import { roomMessagesToIR } from "../chat/roomAdapter";
import {
  normalizeTaskEvents,
  type TaskEvent,
} from "../chat/TaskEventCard";
import { usePoller } from "../usePoller";
import type { RoomChatProps } from "./RoomChat";
import type { RoomChatCoreState } from "./RoomChatCore";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

/** 渲染序列项：turn 块 ∥ 任务事件卡（按 ts 交错）。 */
export type RoomChatRenderItem =
  | {
      kind: "turn";
      key: string;
      ts: number;
      range: { turn: Turn; start: number; end: number };
    }
  | { kind: "event"; key: string; ts: number; ev: TaskEvent };

/** 视图层状态（RoomChatMessages / RoomChatSidebar 消费）。 */
export interface RoomChatViewState {
  tops: RoomMessage[];
  renderItems: RoomChatRenderItem[];
  turnTicks: { id: string; sender: string; startTime: number }[];
  vwin: ViewRange;
  topSentinelRef: ReactNS.MutableRefObject<HTMLDivElement | null>;
  bottomSentinelRef: ReactNS.MutableRefObject<HTMLDivElement | null>;
  jumpWithEnsure: (eventId: string) => Promise<void>;
  jumpToBottomWindowed: () => Promise<void>;
  renderedLastTopIdx: number;
}

export function useRoomChatView(
  props: RoomChatProps,
  core: RoomChatCoreState,
): RoomChatViewState {
  const { room, stickToBottom, listRef, handleSearchJump } = core;

  // ── 批次 3：ChatIR 回合组装（渲染层 = turn 序列）──────────────────
  // 回合从当前渲染窗口（threadGroups.tops）派生：窗口揭示/历史前插时
  // 刻度轨与过程条随窗口同步；流式新消息 append 进末 turn（SSE 行为不变）。
  const tops = core.threadGroups.tops;
  const irMessages = React.useMemo(() => roomMessagesToIR(tops), [tops]);
  const turns = React.useMemo(() => buildTurns(irMessages), [irMessages]);
  // turn → tops 切片：turn.id = 首条消息 event_id（buildTurns 保证）。
  const turnRanges = React.useMemo(() => {
    const idxById = new Map<string, number>();
    tops.forEach((m, i) => {
      if (!idxById.has(m.event_id)) idxById.set(m.event_id, i);
    });
    return turns.map((turn) => {
      const start = idxById.get(turn.id) ?? 0;
      return { turn, start, end: start + turn.messages.length };
    });
  }, [turns, tops]);

  // 任务事件内联时间线：数据源 = 当前房间匹配项目的事件端点
  // （现有 workflow API，签名不动）；项目切换即取 + 15s 轮询；
  // 404（端点未部署）→ 空，卡片自然不出现（诚实降级，不当错误）。
  const projRunId = props.activityProject?.runId ?? null;
  const projTeamId = props.activityProject?.team_id;
  const [taskEvents, setTaskEvents] = React.useState<ProjectTransitionEvent[]>([]);
  const loadTaskEvents = React.useCallback(async () => {
    if (!projRunId) return;
    try {
      const resp = await fetchProjectTransitionEvents(projRunId, projTeamId, {
        limit: 200,
      });
      setTaskEvents(resp ? resp.events : []);
    } catch {
      setTaskEvents([]);
    }
  }, [projRunId, projTeamId]);
  React.useEffect(() => {
    if (!projRunId) {
      setTaskEvents([]);
      return;
    }
    void loadTaskEvents();
  }, [projRunId, loadTaskEvents]);
  usePoller({
    fn: () => void loadTaskEvents(),
    intervalMs: 15000,
    active: !!projRunId,
  });
  const taskCards = React.useMemo(() => {
    const details: Record<string, TaskDetail> = {};
    for (const d of props.activityProject?.taskDetails || []) {
      if (d.task_id) details[d.task_id] = d;
    }
    return normalizeTaskEvents(taskEvents, details);
  }, [taskEvents, props.activityProject]);

  // 渲染序列 = turn 与任务事件按 ts 交错（事件「插入」不替换）。
  const renderItems = React.useMemo<RoomChatRenderItem[]>(() => {
    const items: RoomChatRenderItem[] = [];
    for (const r of turnRanges) {
      items.push({
        kind: "turn",
        key: `turn-${r.turn.id}`,
        ts: tops[r.start]?.origin_server_ts ?? 0,
        range: r,
      });
    }
    for (const ev of taskCards) {
      items.push({ kind: "event", key: `ev-${ev.id}`, ts: ev.ts, ev });
    }
    items.sort((a, b) => a.ts - b.ts);
    return items;
  }, [turnRanges, taskCards, tops]);

  const turnTicks = React.useMemo(
    () =>
      turnRanges.map((r) => ({
        id: r.turn.id,
        sender: r.turn.sender,
        startTime: r.turn.startTime,
      })),
    [turnRanges],
  );

  // ── 视口窗口化（16.46）：只渲染可视窗口 ± 缓冲（各 VWIN_BUFFER 条）──
  // R2 深跳路径最多 1000 条消息进消息域，全量 map 进 DOM 是 CPU 卡死
  // 根因；窗口化后 DOM 节点数与消息总量无关（纯逻辑 = renderWindow.ts）。
  const roomKey = room.room_id;
  const [vwin, setVwin] = React.useState<ViewRange>({ start: 0, end: 0 });
  const vwinMetaRef = React.useRef<{
    len: number;
    anchorKey: string | null;
    roomKey: string;
  }>({ len: 0, anchorKey: null, roomKey: "" });
  const vwinRef = React.useRef(vwin);
  vwinRef.current = vwin;
  const itemsLenRef = React.useRef(renderItems.length);
  itemsLenRef.current = renderItems.length;
  const isAtBottomRef = React.useRef(true);
  isAtBottomRef.current = stickToBottom.isAtBottom;

  // 数据提交（renderItems / 房间变化）→ 尾锚重算窗口。
  // deps 严格 [renderItems, roomKey]：哨兵扩窗（仅 vwin 变）不得重跑——
  // meta.anchorKey 是上次提交 end-1 处的锚，拿它重算会把窗口错移。
  React.useLayoutEffect(() => {
    const keys: string[] = new Array(renderItems.length);
    for (let i = 0; i < renderItems.length; i++) keys[i] = renderItems[i].key;
    const next = nextViewRange(
      vwin,
      vwinMetaRef.current.len,
      vwinMetaRef.current.anchorKey,
      keys,
      isAtBottomRef.current,
      vwinMetaRef.current.roomKey !== roomKey,
    );
    vwinMetaRef.current = {
      len: keys.length,
      anchorKey: keys[next.end - 1] ?? null,
      roomKey,
    };
    if (next.start !== vwin.start || next.end !== vwin.end) setVwin(next);
    // 换房间 + 在底部 → 双 rAF 贴底（第一个等 React re-render 的 DOM
    // 提交完成，第二个等 paint 后 scrollHeight 稳定 → instant 贴底）。
    // 比 RO 触发提前一帧（RO 在下帧才触发 → 用户看到 1 帧顶部）。
    const isRoomChange = vwinMetaRef.current.roomKey !== roomKey;
    if (isRoomChange && isAtBottomRef.current) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
        });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderItems, roomKey]);

  // tops 索引 → renderItems 索引（turn range 覆盖切片；事件卡不占 tops）。
  const topItemOf = React.useMemo(() => {
    const arr: number[] = new Array(tops.length).fill(-1);
    for (let i = 0; i < renderItems.length; i++) {
      const it = renderItems[i];
      if (it.kind !== "turn") continue;
      for (let k = it.range.start; k < it.range.end; k++) arr[k] = i;
    }
    return arr;
  }, [renderItems, tops]);

  // 跳转保证（layout effect：先于 core 的 passive 轮询 effect 执行，
  // 首个轮询 tick 时目标已在 DOM）——R2 深跳 / 房间内搜索目标不在当前
  // 窗口时先扩窗覆盖目标，再走既有 scroll+高亮链；目标未加载
  // （tIdx<0）保持既有 /context 定位区兜底，不改变。
  React.useLayoutEffect(() => {
    const targetId = props.jumpToEventId;
    if (!targetId) return;
    let tIdx = -1;
    for (let i = 0; i < tops.length; i++) {
      if (tops[i].event_id === targetId) {
        tIdx = i;
        break;
      }
    }
    if (tIdx < 0) return;
    const itemIdx = topItemOf[tIdx];
    if (itemIdx < 0) return;
    const next = ensureItemVisible(vwinRef.current, renderItems.length, itemIdx);
    if (next !== vwinRef.current) setVwin(next);
  }, [props.jumpToEventId, renderItems, tops, topItemOf]);

  // 跳转锁：jumpToEventId 挂起期间（父组件 onJumpHandled 后清除）顶哨兵
  // 停扩——深跳时视口正飞向目标，若用户恰停顶、顶哨兵连环上扩，目标行
  // 被持续顶出视口，定位/高亮失效。
  const jumpLockRef = React.useRef(false);
  jumpLockRef.current = props.jumpToEventId != null;
  // 上扩视口补偿（锚定元素法，与 useStickToBottom ⑤ 同口径）：哨兵上扩在
  // 渲染窗顶（视口上方）插行；容器 headless 环境原生 overflow-anchor 实测
  // 不可靠（scrollTop=0 顶插不补偿）→ 提交后显式 scrollTop += 插入高，
  // 视口钉在原行；顶哨兵随之离开视口 → 扩窗自然收敛（不连环扩）。
  const topExpandAnchorRef = React.useRef<{ el: Element; offset: number } | null>(null);
  React.useLayoutEffect(() => {
    const anchor = topExpandAnchorRef.current;
    if (!anchor) return;
    topExpandAnchorRef.current = null;
    const el = listRef.current;
    if (!el || !anchor.el.isConnected) return;
    const now =
      anchor.el.getBoundingClientRect().top -
      el.getBoundingClientRect().top +
      el.scrollTop;
    const delta = now - anchor.offset;
    if (delta > 0) el.scrollTop += delta;
  }, [vwin, listRef]);
  // 哨兵边缘扩窗：顶/底哨兵进入视口 → 窗口扩 VWIN_BUFFER（vwin 变化后
  // 重挂 observe；仍相交则再扩，边缘收敛）。
  const topSentinelRef = React.useRef<HTMLDivElement | null>(null);
  const bottomSentinelRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const list = listRef.current;
    if (!list || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          const cur = vwinRef.current;
          if (en.target === topSentinelRef.current) {
            if (jumpLockRef.current) continue; // 跳转挂起：顶边不动
            // 记当前首行及其内容偏移（扩窗提交后的补偿锚点）。
            const firstRow = list.querySelector<HTMLElement>("[data-event-id]");
            if (firstRow) {
              topExpandAnchorRef.current = {
                el: firstRow,
                offset:
                  firstRow.getBoundingClientRect().top -
                  list.getBoundingClientRect().top +
                  list.scrollTop,
              };
            }
            const next = expandRange(cur, itemsLenRef.current, "top");
            if (next !== cur) setVwin(next);
            else topExpandAnchorRef.current = null;
            continue;
          }
          const next = expandRange(cur, itemsLenRef.current, "bottom");
          if (next !== cur) setVwin(next);
        }
      },
      { root: list },
    );
    const t = topSentinelRef.current;
    const b = bottomSentinelRef.current;
    if (t) io.observe(t);
    if (b) io.observe(b);
    return () => io.disconnect();
  }, [vwin, renderItems, listRef]);

  // 房间内跳转（搜索 / 引用条）：目标在当前窗口外 → 先扩窗覆盖目标
  // （下一帧落地），再走既有 scroll+高亮 / /context 兜底链。
  const jumpWithEnsure = React.useCallback(
    async (eventId: string) => {
      let tIdx = -1;
      for (let i = 0; i < tops.length; i++) {
        if (tops[i].event_id === eventId) {
          tIdx = i;
          break;
        }
      }
      if (tIdx >= 0) {
        const itemIdx = topItemOf[tIdx];
        if (itemIdx >= 0) {
          const next = ensureItemVisible(vwinRef.current, itemsLenRef.current, itemIdx);
          if (next !== vwinRef.current) {
            setVwin(next);
            await new Promise<void>((res) => requestAnimationFrame(() => res()));
          }
        }
      }
      void handleSearchJump(eventId);
    },
    [tops, topItemOf, handleSearchJump],
  );

  // 置底（窗口化版）：滚动容器视口底 = 渲染窗底，直接 scrollToBottom
  // 只到窗口底缘——先尾锚窗口（渲染末 VWIN_INITIAL 项，覆盖可视区），
  // 下一帧再平滑置底（following / 未读清零语义与原版一致）。
  const jumpToBottomWindowed = React.useCallback(async () => {
    const len = itemsLenRef.current;
    setVwin((r) =>
      len <= VWIN_MIN || (r.end === len && r.start >= len - VWIN_INITIAL)
        ? r
        : { start: Math.max(0, len - VWIN_INITIAL), end: len },
    );
    await new Promise<void>((res) => requestAnimationFrame(() => res()));
    void stickToBottom.scrollToBottom();
  }, [stickToBottom.scrollToBottom]);

  // 当前渲染窗内最大 tops 索引——「末行显时间」以窗尾为准（窗口化后
  // 看不到全列表尾，取窗内最后一条）。
  // 渲染必须容忍一帧陈旧 vwin（数据收窄后重算在 layout effect 才落地——
  // 如换房重置 windowLimit 晚于棘轮抬升的挂载序列）：索引循环同样钳制，
  // 与 slice（天然越界安全）同口径。
  let renderedLastTopIdx = -1;
  for (let i = vwin.start; i < Math.min(vwin.end, renderItems.length); i++) {
    const it = renderItems[i];
    if (it.kind === "turn" && it.range.end - 1 > renderedLastTopIdx) {
      renderedLastTopIdx = it.range.end - 1;
    }
  }

  return {
    tops,
    renderItems,
    turnTicks,
    vwin,
    topSentinelRef,
    bottomSentinelRef,
    jumpWithEnsure,
    jumpToBottomWindowed,
    renderedLastTopIdx,
  };
}
