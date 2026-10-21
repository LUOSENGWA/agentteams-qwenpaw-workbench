// WorkbenchPage 拆分模块——聊天分栏布局与拖拽。
// 自 WorkbenchPage 单体原样搬移（技术债批次 D3b）；逻辑零改动，
// 壳持有的 React state 经 ctx 传入，标识符保持原名。

import type * as ReactNS from "react";
import { type TeamRoom } from "./api";
import { isNarrowLayout } from "./WbViewportContext";
import { useThemeColors } from "./theme";
import { useT } from "./i18n";
import { MenuIcon } from "./components/icons";
import { CHAT_SPLIT_MIN_CONTAINER_W, isWideLayout } from "./WorkbenchPageShared";

const host = window.QwenPaw.host;
const React = host.React;

export interface WorkbenchPageLayoutCtx {
  t: ReturnType<typeof useThemeColors>;
  tr: ReturnType<typeof useT>;
  tab: string;
  readUiState: (key: string) => { tab?: string; roomId?: string; wfView?: string; wfTopo?: string; chatSplitW?: string; chatListHidden?: string; chatForceWide?: string };
  mergeUiState: (patch: Record<string, string>) => void;
  UI_STATE_KEY: string;
  setActiveRoom: React.Dispatch<React.SetStateAction<TeamRoom | null>>;
  setRoomError: (v: string) => void;
  writeUiState: (tab: string, roomId: string | null) => void;
}

export function useWorkbenchChatLayout(ctx: WorkbenchPageLayoutCtx) {
  const { t, tr, tab, readUiState, mergeUiState, UI_STATE_KEY, setActiveRoom, setRoomError, writeUiState } = ctx;

 // ── P6 聊天 tab：宽屏 Element 式分栏 / 窄屏微信式单屏 ──
  // 宽屏：左房间/DM 列表（宽度可拖 220-560，持久化）+ 右聊天（未选房间显占位）。
  // 窄屏（<1024px，竖屏/手机）：保持微信移动版语义——列表页点击进全屏聊天，
  // 左上角 ← 返回退出（RoomChat onBack 既有按钮）。列表可隐藏（宽屏）。
  const [chatWideMeasured, setChatWideMeasured] = React.useState(
    // 初值按容器满宽假设（首帧），挂载后 measure 实测容器宽修正。
    () => isWideLayout(window.innerWidth, window.innerWidth),
  );
  // viewport 单一判定数据源——宽度=聊天同源（父链 clientWidth min），高度=容器
  // 可见高（预留竖屏/长宽比判据）。narrow = isNarrowLayout(w,h) 供全部页面共用
  // （团队表卡片化 / 表右缘渐隐与聊天单栏永远同步；要调只改 isNarrowLayout）。
  // N18 根因修（拖窗口卡顿）：像素级 w/h **不进 React state**——此前每 1px 变化都
  // setVp → WorkbenchPage body 每帧重跑 + 全量 JSX diff（业界正解：连续值走 ref/DOM，
  // 只有阈值判定进 state）。像素实时写 ref；narrow 布尔翻转才 setNarrow → 整树重渲一次。
  // 全部 13 个消费方只读 narrow（grep 实锤无 width/height 消费）。
  const vpRef = React.useRef({ w: window.innerWidth, h: window.innerHeight });
  // 窄屏（竖屏/窄容器）单一判定——供 header 压缩等共用（与聊天单栏同判据）。
  const [narrow, setNarrow] = React.useState(
    () => isNarrowLayout(window.innerWidth, window.innerHeight),
  );
  // provider 值 memo 化：identity 只在 narrow 翻转时变 → 拖窗全程 13 个消费组件零重渲。
  // width/height = 翻转时刻的像素快照（当前无消费方依赖实时像素；将来要实时宽度
  // 自行 ResizeObserver 测量，勿回退成 state）。
  const vpValue = React.useMemo(
    () => ({ width: vpRef.current.w, height: vpRef.current.h, narrow }),
    [narrow],
  );
  // 12.14：强制分栏开关（配置页）——忽略宽度判定，持久化 ui-state。
  const [chatForceWide, setChatForceWide] = React.useState<boolean>(
    () => readUiState(UI_STATE_KEY).chatForceWide === "true",
  );
  const setChatForceWidePersist = React.useCallback(
    (v: boolean) => {
      setChatForceWide(v);
      mergeUiState({ chatForceWide: v ? "true" : "false" });
    },
    [mergeUiState],
  );
  // 12.13→13.10：判定基准=**窗口宽**（13.9 ：容器测量被宿主
  // 左右留空压窄→横向全屏误判窄屏；宿主最小窗宽又使拖窄永远不触发
  // 单栏）。窗口 resize 跟随；强制开关优先。
  const mainRef = React.useRef<HTMLDivElement | null>(null);
  // // 13.11 的 cont = mainRef.clientWidth 只量插件自己的 <main>——它
  // width:100% 跟随**直接父级**，而宿主的真实约束层（Desktop OS 窗
  // 口 frame / 内嵌面板 / 侧栏容器）在更上层祖先：窗口拖窄时若约束
  // 层是 transform/scale 或非父链布局，main 的 clientWidth 可能不跟
  // 宿主走（疑似按聊天窗宽判断——实测基准确实离宿主约束
  // 层太远）。改 Element 式「实际可见宽」：从 main 沿父链到 body 取
  // 每层 clientWidth 的 min（任何一层变窄都会拉低），再与视口宽取
  // min；ResizeObserver 观察**整条父链**（任一层变化即重测）。宿主形
  // 态无关（OS 窗口/经典页/iframe 都取到真实可见宽）。
  // RoomChat 上报话题面板占宽
  // （inline 面板与聊天列同占空间）——打开话题时可用宽 = 实测可见宽 −
  // 面板宽。此前判定完全不含面板：开着话题拖窄窗口，聊天区早已局促
  // 却仍双栏，继续收窄才切（14.2）。
  const threadPanelRef = React.useRef<{ open: boolean; width: number }>({
    open: false,
    width: 0,
  });
  const measureRef = React.useRef<() => void>(() => {});
  const onThreadPanelLayout = React.useCallback(
    (open: boolean, width: number) => {
      threadPanelRef.current = { open, width };
      measureRef.current();
    },
    [],
  );
  React.useEffect(() => {
    // 「拖窗口布局反应慢」根子修：此前每 resize 事件 + RO(观察 main+~20 层祖先) 都
    // 无条件 setVp/setChatWideMeasured → 每像素拖动都换 provider 值 → 整棵 workbench
    // 树 re-render。正解=业界通用：rAF 合并(一帧最多算一次) + dedup(w/h/eff 都没实际
    // 变≥1px 就不 setState，子像素噪音吞掉)。
    let raf = 0;
    let qw = 0, qh = 0, qe = 0, qd = false;
    const apply = () => {
      raf = 0;
      if (!qd) return;
      // 像素写 ref（零重渲）；两个阈值判定进 state——同值 React 自动 bail out，
      // 只有跨越 narrow / 聊天分栏阈值那一帧才各重渲一次（拖窗全程 ≈0 重渲）。
      vpRef.current = { w: qw, h: qh };
      setChatWideMeasured(qe >= CHAT_SPLIT_MIN_CONTAINER_W);
      setNarrow(isNarrowLayout(qw, qh));
    };
    const measure = () => {
      const main = mainRef.current;
      if (!main || main.clientWidth === 0) return; // main 未 layout，等 RO 重测
      // 2412px 横屏误判窄屏真根因（宿主 CSS 实锤）：宿主 console 的插件挂载
      // 兼容层 .compatContent 是 display:contents——不产生 box，clientWidth 恒 0。
      // 父链 min 若把 0 层算进去 → visible 恒 0 → 判定被钉死（15.17 直接 setState
      // 成窄屏；初值再对也被覆盖）。0-box 不约束子元素布局 → 遍历跳过 clientWidth=0
      // 的层，visible = 父链非零层 ∪ 视口宽的最小值（窗口任意尺寸都得真值，随 resize
      // 跟随；不再依赖初值正确性）。
      let visible = window.innerWidth;
      let el: HTMLElement | null = main;
      while (el) {
        const cw = el.clientWidth;
        if (cw > 0 && cw < visible) visible = cw;
        el = el.parentElement;
      }
      if (visible === 0) return; // 防御：连 main 都无宽 = 未 layout
      const tp = threadPanelRef.current;
      qe = tp.open ? visible - tp.width : visible;
      qw = visible;
      qh = main.clientHeight || window.innerHeight;
      qd = true;
      if (!raf) raf = requestAnimationFrame(apply); // rAF 合并
    };
    measure();
    measureRef.current = measure;
    window.addEventListener("resize", measure);
    // 15.18：窗口焦点恢复 / 页面转可见时强制重测——防「OS 窗口 resize 不触发
    // resize 事件 → 判定卡 stale」（这两刻 DOM 已 layout，能取真可见宽）。
    const onWinFocus = () => measure();
    const onVis = () => {
      if (document.visibilityState === "visible") measure();
    };
    window.addEventListener("focus", onWinFocus);
    document.addEventListener("visibilitychange", onVis);
    let ro: ResizeObserver | null = null;
    if (mainRef.current && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(measure);
      // 观察 main + 全部祖先（到 body 为止，DOM 深度有限 ≤ ~20 层）。
      let el: HTMLElement | null = mainRef.current;
      while (el) {
        ro.observe(el);
        if (el.tagName === "BODY") break;
        el = el.parentElement;
      }
    }
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("focus", onWinFocus);
      document.removeEventListener("visibilitychange", onVis);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  // 15.18：切 tab 强制重测窄/宽——切换时 DOM 已 layout（clientWidth 真值）。
  // 三重保险防「Desktop OS 窗口 resize 不触发 → 判定卡 stale」（2412px 误判）。
  React.useEffect(() => {
    measureRef.current();
  }, [tab]);
 // shell 高度改为
  // 容器相对（Element 模型）——12.x 起用 calc(100vh-64px) 经验值，但宿主
  // 是 Desktop OS 窗口（OsAppHost .content：flex:1 + overflow:auto 定高
  // 容器，可拖拽任意大小，100vh=浏览器视口≠窗口内容高）：窗口小于屏幕时
  // shell 溢出 → .content 整页滚 →「聊天框带着整个页面滚」。
  // 实测优先，三级判定：
  // ① iframe 宿主（PawApps iframe 模式）→ iframe 视口=全部可用区；
  // ② 父容器定高且小于视口（OS 窗口 .content / 任何定高内嵌容器）→ 用父
  // 容器 clientHeight（窗口拖拽/宿主重排时 ResizeObserver 跟随）；
  // ③ 父容器不定高（经典页面挂载）→ 回退 calc(100vh - 64px) 旧经验值。
  const [shellH, setShellH] = React.useState<number | null>(null);
  React.useEffect(() => {
    const measure = () => {
      const el = mainRef.current;
      if (!el) return;
      try {
        if (window.self !== window.top) {
          setShellH(window.innerHeight);
          return;
        }
      } catch {
        /* 跨域 iframe 访问异常——按非 iframe 处理 */
      }
      const p = el.parentElement;
      if (
        p &&
        p.clientHeight > 0 &&
        p.clientHeight < window.innerHeight - 4
      ) {
        setShellH(p.clientHeight);
        return;
      }
      setShellH(null);
    };
    measure();
    const p = mainRef.current?.parentElement;
    if (p && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(measure);
      ro.observe(p);
      window.addEventListener("resize", measure);
      return () => {
        ro.disconnect();
        window.removeEventListener("resize", measure);
      };
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const chatWide = chatForceWide || chatWideMeasured;
  const [chatSplitW, setChatSplitW] = React.useState<number>(() => {
    const v = Number(readUiState(UI_STATE_KEY).chatSplitW);
    return Number.isFinite(v) && v >= 160 && v <= 480 ? v : 300;
  });
  const [chatListHidden, setChatListHidden] = React.useState<boolean>(
    () => readUiState(UI_STATE_KEY).chatListHidden === "true",
  );
  const setChatListHiddenPersist = React.useCallback(
    (hidden: boolean) => {
      setChatListHidden(hidden);
      mergeUiState({ chatListHidden: hidden ? "true" : "false" });
    },
    [mergeUiState],
  );
  const closeChatRoom = React.useCallback(() => {
    setActiveRoom(null);
    setRoomError("");
    writeUiState(tab, null);
  }, [tab, writeUiState]);
  const startChatSplitDrag = React.useCallback(
    (e: ReactNS.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = chatSplitW;
      const clamp = (w: number) => Math.min(480, Math.max(160, w));
      const onMove = (ev: globalThis.MouseEvent) => {
        setChatSplitW(clamp(startW + (ev.clientX - startX)));
      };
      const onUp = (ev: globalThis.MouseEvent) => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        // 落点一次写 localStorage（拖动中不写——高频写盘无谓）。
        mergeUiState({
          chatSplitW: String(clamp(startW + (ev.clientX - startX))),
        });
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [chatSplitW, mergeUiState],
  );

 // // 「☰ 房间列表」按钮不再 absolute 浮在聊天区左上角（与 RoomChat 顶栏
  // ← 返回 键重叠）——有房间时经 headerPrefix 进 RoomChat 顶栏最左
  // （Element 汉堡位）；无房间时（占位页）仍浮在左上角（无顶栏可挂）。
 // useMemo 钉住引用（headerPrefix 传给
  // RoomChat——普通 const 每次渲染新 JSX 元素引用会击穿 memo）。t 是每次
  // 渲染新对象 → deps 用原语色值。
  const chatListToggleBtn = React.useMemo(() => (chatListHidden ? (
    <button
      type="button"
      onClick={() => setChatListHiddenPersist(false)}
      title={tr("显示房间列表")}
      style={{
        border: `1px solid ${t.border}`,
        background: t.bg,
        color: t.text,
        borderRadius: 6,
        cursor: "pointer",
        padding: "3px 9px",
        fontSize: 13,
        lineHeight: "20px",
      }}
    >
      <MenuIcon size={14} style={{ verticalAlign: "-2px" }} /> {tr("房间列表")}
    </button>
  ) : null),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [chatListHidden, tr, t.border, t.bg, t.text, setChatListHiddenPersist]);
  return {
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
  };
}
