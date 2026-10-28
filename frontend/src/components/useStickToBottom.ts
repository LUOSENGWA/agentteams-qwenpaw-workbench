// 贴底跟随 hook（自研，无新依赖）——聊天流式滚动业界方案：
// 参考 stackblabs/use-stick-to-bottom 语义 + 流式聊天实践：
// ① isAtBottom（带容差，默认 48px，可配）；
// ② 显式 following 状态：初始 true；滚动时 following = isAtBottom；
//    显式点「回到最新」→ following = true（动画期间滚动事件不降级——
//    平滑动画途中 isAtBottom 恒 false，直接降级会复现 13.11「点了按钮
//    又弹」；用户动画中主动上滚 = 打断，方向哨兵检测）；
// ③ 新消息追加：following → rAF 批量写 scrollTop = scrollHeight
//    （instant，同帧 N 条消息 + M 个子节点增高收敛为每帧一次写入）；
//    否则 unread += 1（排除本人消息）；
// ④ ResizeObserver 监听容器 + 内容（直接子节点）：following 时重新
//    贴底（覆盖图片/附件/流式输出增高）；
// ⑤ 前插视口锚定（R2 锚定元素法）：锚点 = 前插前已渲染的第一行（真实元素，
//    data-event-id 定位），其相对容器视口的偏移经 scroll/提交/RO 三路径持续
//    刷新（无陈旧快照窗口）；前插提交后按 anchorRestoreDelta 精确恢复视口。
//    替代旧的手工 scrollHeight 差值补偿（差值在用户两次提交间滚动后陈旧，
//    回写把视图打回顶部 = 13.10 时代「加载原消息跑到顶部」根因）。浏览器
//    原生 overflow-anchor 是第一道防线（已处理时 delta≈0 自然 no-op），
//    本层兜底「内容未溢出/锚定元素丢失」等原生未覆盖边界（useLayoutEffect，
//    paint 前，闪顶不可见）；
// ⑥ 容器保持原生滚动锚开启（不要设 overflow-anchor: none——全量关闭会
//    让浏览器找不到锚点）；列表顶部三个可控动态块（加载按钮/错误条/最早
//    标记）须设 overflow-anchor: none 排除出锚定候选，浏览器才会选消息行
//    做锚点（调用方负责）；
// ⑦ 悬浮「回到最新 N」= !following && unread > 0；点击平滑置底并
//    清零未读；回到底部（滚动）自动清零。
import type * as ReactNS from "react";
import { anchorRestoreDelta } from "../scrollAnchor";

const host = window.QwenPaw.host;
const React = host.React;

export interface StickToBottomOptions {
  /** isAtBottom 容差（px），默认 48。 */
  tolerance?: number;
  /** 房间键：变化时重置 following/unread 并立即贴底（开房=最新消息处）。 */
  roomKey: string;
  /** 渲染窗首条顶层消息 id（前插检测信号；空串=无消息）。 */
  firstId: string;
  /** 内容变化信号（如 messages 引用）：RO 重新观察子节点 + 锚点刷新。 */
  contentSignal?: unknown;
  /** 每次滚动回调（isAtBottom 现算）——调用方挂顶部预加载等逻辑。 */
  onScroll?: (el: HTMLElement, isAtBottom: boolean) => void;
  /** 前插落地后回调（调用方解锁加载接力等）。 */
  onPrepend?: () => void;
}

export interface StickToBottom {
  /** 滚动容器 ref（挂到消息列表 div；容器保持原生滚动锚，顶部动态块设 none）。 */
  listRef: ReactNS.MutableRefObject<HTMLDivElement | null>;
  /** 是否在底部（带容差，最近一次滚动/测量值）。 */
  isAtBottom: boolean;
  /** 跟随模式（见文件头 ②）。「回到最新」悬浮钮显隐 = !following。 */
  following: boolean;
  /** 未跟随期间到达的非本人新消息数（「回到最新 N」徽章）。 */
  unread: number;
  /** 容器 onScroll 处理函数。 */
  handleScroll: () => void;
  /** 新消息追加信号：following → 贴底；否则（非本人）unread + 1。 */
  onNewMessages: (isSelf: boolean) => void;
  /** 显式「回到最新」：following = true + 平滑置底（落地/超时/打断 resolve）。 */
  scrollToBottom: () => Promise<void>;
  /** 发送等显式动作后：立即贴底（instant）+ 清零未读。 */
  pinToBottom: () => void;
}

export function useStickToBottom(opts: StickToBottomOptions): StickToBottom {
  const listRef = React.useRef<HTMLDivElement | null>(null);
  // 回调/容差经 ref 桥接——handleScroll 等回调引用稳定（不随调用方
  // 重渲重建），同帧多次触发靠 rAF 门收敛。
  const optsRef = React.useRef(opts);
  optsRef.current = opts;
  const tolRef = React.useRef(opts.tolerance ?? 48);
  tolRef.current = opts.tolerance ?? 48;

  const [isAtBottom, setIsAtBottom] = React.useState(true);
  const [following, setFollowingState] = React.useState(true);
  const followingRef = React.useRef(true);
  const setFollowing = React.useCallback((v: boolean) => {
    if (followingRef.current === v) return;
    followingRef.current = v;
    setFollowingState(v);
  }, []);
  const [unread, setUnread] = React.useState(0);

  // ⑤ 锚定元素（前插前已渲染的第一行）及其相对容器视口的偏移——经
  // scroll/提交/RO 持续刷新，无「提交间快照陈旧」窗口（旧差值补偿失效模式）。
  const anchorElRef = React.useRef<HTMLElement | null>(null);
  const anchorOffsetRef = React.useRef<number | null>(null);
  const measureAnchorOffset = React.useCallback(() => {
    const el = listRef.current;
    const a = anchorElRef.current;
    if (!el || !a || !a.isConnected) {
      anchorOffsetRef.current = null;
      return;
    }
    anchorOffsetRef.current =
      a.getBoundingClientRect().top - el.getBoundingClientRect().top;
  }, []);

  // 贴底写入（instant）——rAF 批量门：流式期间同一帧内新消息 effect +
  // ResizeObserver 可各触发多次，收敛为每帧至多一次 scrollTop 写入
  // （旧版每次同步写 = 每次强制同步 reflow，流式期主线程卡顿主源）。
  const rafRef = React.useRef(0);
  const stickInstant = React.useCallback(() => {
    rafRef.current = 0;
    const el = listRef.current;
    if (!el || !followingRef.current) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 2) return; // 已贴底
    el.scrollTop = el.scrollHeight;
  }, []);
  const scheduleStick = React.useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(stickInstant);
  }, [stickInstant]);
  React.useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  // 显式置底动画状态机——token 区分新旧调用（重入即替换），
  // rAF 轮询落地判定 + 1.6s 超时兜底（用户滚动打断动画时不再空等）。
  const animTokenRef = React.useRef(0);
  const animRafRef = React.useRef(0);
  const animTimerRef = React.useRef(0);
  const animLastTopRef = React.useRef(0);
  const animResolveRef = React.useRef<(() => void) | null>(null);
  const stopAnim = React.useCallback(() => {
    animTokenRef.current = 0;
    if (animTimerRef.current) {
      window.clearTimeout(animTimerRef.current);
      animTimerRef.current = 0;
    }
    if (animRafRef.current) {
      cancelAnimationFrame(animRafRef.current);
      animRafRef.current = 0;
    }
    const r = animResolveRef.current;
    animResolveRef.current = null;
    if (r) r();
  }, []);
  // 卸载兜底：动画中的 Promise resolve，不悬空。
  React.useEffect(() => stopAnim, [stopAnim]);

  // 显式「回到最新」：following = true（先于动画置位——动画期间新消息
  // 走贴底跟随，不重弹按钮）+ 平滑置底。
  const scrollToBottom = React.useCallback((): Promise<void> => {
    stopAnim();
    setFollowing(true);
    setUnread(0);
    const el = listRef.current;
    if (!el) return Promise.resolve();
    return new Promise((resolve) => {
      const token = ++animTokenRef.current;
      animResolveRef.current = resolve;
      animLastTopRef.current = el.scrollTop;
      const check = () => {
        if (animTokenRef.current !== token) return;
        const e = listRef.current;
        if (!e) {
          stopAnim();
          return;
        }
        // +2px 落地余量（亚像素取整误差）。
        if (e.scrollHeight - e.scrollTop - e.clientHeight <= tolRef.current + 2) {
          stopAnim();
          return;
        }
        animRafRef.current = requestAnimationFrame(check);
      };
      animTimerRef.current = window.setTimeout(stopAnim, 1600);
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      animRafRef.current = requestAnimationFrame(check);
    });
  }, [setFollowing, stopAnim]);

  // 滚动事件——following = isAtBottom；回到底部清零未读（⑦）。
  // 动画期间例外：仅「用户上滚打断」（scrollTop 较上次显著上行）才降级，
  // 否则平滑动画的中间帧会把 following 打回 false（13.11 根因同款）。
  const handleScroll = React.useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const at =
      el.scrollHeight - el.scrollTop - el.clientHeight <= tolRef.current;
    setIsAtBottom(at);
    if (animTokenRef.current !== 0) {
      if (el.scrollTop < animLastTopRef.current - 4) {
        stopAnim(); // 用户接管：取消动画，此后按纯滚动驱动
        setFollowing(at);
      } else {
        animLastTopRef.current = el.scrollTop;
      }
    } else {
      animLastTopRef.current = el.scrollTop;
      setFollowing(at);
    }
    if (at) setUnread(0);
    measureAnchorOffset(); // ⑤ 用户滚动 → 锚定偏移即时刷新（防陈旧值被下次提交使用）
    optsRef.current.onScroll?.(el, at);
  }, [setFollowing, stopAnim, measureAnchorOffset]);

  // 新消息追加（③）：following → rAF 批量贴底；否则非本人消息累计未读。
  const onNewMessages = React.useCallback(
    (isSelf: boolean) => {
      if (followingRef.current) {
        scheduleStick();
        setUnread(0);
      } else if (!isSelf) {
        setUnread((c) => c + 1);
      }
    },
    [scheduleStick],
  );

  // 发送等显式动作（③ 同路 instant 贴底）。
  const pinToBottom = React.useCallback(() => {
    setFollowing(true);
    setUnread(0);
    scheduleStick();
  }, [scheduleStick, setFollowing]);

  // 换房间：重置跟随态 + 贴底（开房即在最新消息处；新消息落地后
  // onNewMessages 再补一次贴底——此时消息异步加载，此刻可能还是空列表）。
  React.useEffect(() => {
    setFollowing(true);
    setIsAtBottom(true);
    setUnread(0);
    requestAnimationFrame(() => {
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [opts.roomKey, setFollowing]);

  // ResizeObserver（④）——观察滚动内容（直接子节点：新行出现/行高变化
  // 都触发；滚动容器自身尺寸由 flex 定死，单观察容器不够）+ 容器本身
  // （窗口 resize / 分栏宽度变化 → 容器高度变化，following 时重新贴底）。
  // contentSignal（messages 引用）变化时重新挂载，覆盖新子节点。
  React.useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (followingRef.current) scheduleStick();
      else measureAnchorOffset(); // ⑤ 子节点尺寸变化推移锚定偏移 → 重测
    });
    ro.observe(el);
    for (const c of Array.from(el.children) as HTMLElement[]) ro.observe(c);
    return () => ro.disconnect();
  }, [opts.contentSignal, scheduleStick, measureAnchorOffset]);

  // 前插视口锚定（⑤，R2 锚定元素法）——首条消息 id 变化 = 前插（加载更早
  // 页/窗口揭示）。锚定元素 = 前插前已渲染的第一行；提交后恢复其前插前的
  // 视口位置（anchorRestoreDelta 决策）：锚定前在视口内 → 恢复；不在（用户
  // 停中段/底部）→ 前插本就不移视口，0。浏览器原生 overflow-anchor 已处理
  // 时 oNow≈oSaved → delta≈0 自然 no-op；未处理（内容未溢出等）→ 精确补偿。
  // 换房间时清锚（新房首条 id 变化不是前插，防误恢复）。
  const prevFirstIdRef = React.useRef("");
  const roomKeyRef = React.useRef("");
  React.useLayoutEffect(() => {
    const rk = opts.roomKey;
    if (roomKeyRef.current !== rk) {
      roomKeyRef.current = rk;
      prevFirstIdRef.current = "";
      anchorElRef.current = null;
      anchorOffsetRef.current = null;
    }
    const firstId = opts.firstId;
    const prepended =
      prevFirstIdRef.current !== "" &&
      firstId !== "" &&
      firstId !== prevFirstIdRef.current;
    const el = listRef.current;
    if (prepended && el) {
      const oSaved = anchorOffsetRef.current;
      const a =
        anchorElRef.current && anchorElRef.current.isConnected
          ? anchorElRef.current
          : null;
      if (oSaved != null && a) {
        const oNow =
          a.getBoundingClientRect().top - el.getBoundingClientRect().top;
        const delta = anchorRestoreDelta(oSaved, oNow, el.clientHeight);
        if (delta !== 0) el.scrollTop += delta;
      }
      anchorOffsetRef.current = null; // 已消费；下面按新锚定元素重测
      optsRef.current.onPrepend?.();
    }
    if (el) {
      // 重绑锚定元素 = 本提交后已渲染的第一行（下一次前插的锚点）。
      anchorElRef.current = firstId
        ? (el.querySelector<HTMLElement>(`[data-event-id="${firstId}"]`) ??
           el.querySelector<HTMLElement>("[data-event-id]"))
        : null;
      measureAnchorOffset();
    }
    prevFirstIdRef.current = firstId;
  }, [opts.roomKey, opts.firstId, opts.contentSignal, measureAnchorOffset]);

  return {
    listRef,
    isAtBottom,
    following,
    unread,
    handleScroll,
    onNewMessages,
    scrollToBottom,
    pinToBottom,
  };
}
