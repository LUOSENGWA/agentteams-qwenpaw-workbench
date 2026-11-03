/**
 * 会话导航刻度轨（批次 3；16.46 窗口化）：聊天区顶部 sticky 28px 刻度条。
 *
 * - 每个 turn 一个刻度（sender 首字 + HH:mm）；
 * - 滚动时高亮当前可见 turn（scroll spy，rAF 节流）；
 * - 点击刻度 → 列表平滑滚动到该 turn（[data-turn-id] 锚点）；
 * - turns.length <= 8 不渲染（短会话不需要导航）；
 * - 16.46：只渲染可视 turn 窗 ±5（刻度 DOM 与消息总量无关）；
 *   turns.length > 500 退化为顶部一行文字「共 N 回合 · 点击回底部」；
 * - 宽度随聊天区（block 级 100%），高 28px，在滚动容器之外、
 *   输入框上方——不遮输入框。
 */
import type * as ReactNS from "react";
import { formatTime, senderShortName } from "../components/RoomChatShared";
import type { TeamRoom } from "../api";

const host = window.QwenPaw.host;
const React = host.React;

export interface TurnTick {
  id: string;
  sender: string;
  startTime: number;
}

const HIGHLIGHT = "color-mix(in srgb, var(--app-accent, #FF7F16) 16%, transparent)";
const HIGHLIGHT_BORDER = "var(--app-accent, #FF7F16)";
/** 刻度可视窗前后余量（覆盖 ±5 个刻度，跳变不露边）。 */
const TICK_PAD = 5;
/** > 该 turn 数退化为文字条（深跳大房间刻度条既无用又重）。 */
const DEGRADE_AT = 500;

export function TurnTimeline(props: {
  turns: TurnTick[];
  listRef: ReactNS.RefObject<HTMLElement | null>;
  /** 成员表（sender 首字优先取 display_name 首字）。 */
  room?: TeamRoom | null;
  /** 翻译函数（退化文字条 i18n）。 */
  tr: (text: string, vars?: Record<string, string | number>) => string;
  /** 退化文字条「点击回底部」→ 父组件窗口化置底。 */
  onJumpToBottom?: () => void;
}) {
  const n = props.turns.length;
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const activeRef = React.useRef<string | null>(null);
  // 可视刻度窗（全局索引；初值前 16，首帧 scroll spy 校正）。
  const [win, setWin] = React.useState<{ start: number; end: number }>({
    start: 0,
    end: Math.min(n, 16),
  });
  const winRef = React.useRef(win);
  winRef.current = win;

  // 刻度 id → 全局索引（DOM 内刻度 → 窗计算用）。
  const idxById = React.useMemo(() => {
    const m = new Map<string, number>();
    props.turns.forEach((t, i) => m.set(t.id, i));
    return m;
  }, [props.turns]);

  // scroll spy：rAF 节流——当前高亮 = 最后一个「turn 顶已滚过视口顶 +40px」
  // 的 turn；同时算可视 turn 范围 [first, last] → 刻度窗 = [first-5, last+5]。
  React.useEffect(() => {
    const list = props.listRef.current;
    if (!list) return;
    let raf = 0;
    const compute = () => {
      raf = 0;
      const top = list.getBoundingClientRect().top;
      const bottom = top + list.clientHeight;
      let cur: string | null = null;
      let first = -1;
      let last = -1;
      const els = list.querySelectorAll<HTMLElement>("[data-turn-id]");
      for (const el of Array.from(els)) {
        const eTop = el.getBoundingClientRect().top;
        if (eTop - top <= 40) cur = el.dataset.turnId ?? null;
        if (eTop < bottom && eTop + el.offsetHeight > top) {
          const gi = idxById.get(el.dataset.turnId ?? "");
          if (gi != null) {
            if (first < 0) first = gi;
            last = gi;
          }
        }
      }
      if (cur !== activeRef.current) {
        activeRef.current = cur;
        setActiveId(cur);
      }
      if (first < 0) return; // 视口内无 turn（防御：保持现窗）
      const ns = Math.max(0, first - TICK_PAD);
      const ne = Math.min(props.turns.length, last + TICK_PAD + 1);
      const w = winRef.current;
      if (ns !== w.start || ne !== w.end) {
        winRef.current = { start: ns, end: ne };
        setWin({ start: ns, end: ne });
      }
    };
    const onScroll = () => {
      if (!raf) raf = window.requestAnimationFrame(compute);
    };
    compute();
    list.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      list.removeEventListener("scroll", onScroll);
    };
  }, [props.listRef, props.turns, idxById]);

  if (n <= 8) return null;

  // >500 turn：刻度条退化为文字行（DOM 恒定 1 行，点击 = 窗口化置底）。
  if (n > DEGRADE_AT) {
    return (
      <div
        role="button"
        title={props.tr("回到最新消息")}
        onClick={() => {
          if (props.onJumpToBottom) {
            props.onJumpToBottom();
          } else {
            const list = props.listRef.current;
            if (list) list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
          }
        }}
        style={{
          width: "100%",
          height: 28,
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          fontSize: 11,
          color: HIGHLIGHT_BORDER,
          background: "inherit",
        }}
      >
        {props.tr("共 {n} 回合 · 点击回底部", { n })}
      </div>
    );
  }

  const jump = (id: string) => {
    const list = props.listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(id)}"]`);
    if (!el) return;
    const top =
      el.getBoundingClientRect().top -
      list.getBoundingClientRect().top +
      list.scrollTop -
      12;
    list.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    activeRef.current = id;
    setActiveId(id);
  };

  return (
    <div
      style={{
        position: "sticky",
        top: 0,
        zIndex: 10,
        background: "inherit",
        width: "100%",
        height: 28,
        boxSizing: "border-box",
        display: "flex",
        alignItems: "stretch",
        gap: 2,
        padding: "3px 4px",
        overflow: "hidden",
      }}
    >
      {props.turns.slice(win.start, win.end).map((t) => {
        const firstChar =
          senderShortName(t.sender, props.room ?? null).slice(0, 1).toUpperCase();
        const active = activeId === t.id;
        return (
          <div
            key={t.id}
            data-tick
            role="button"
            title={`${senderShortName(t.sender, props.room ?? null)} ${formatTime(t.startTime)}`}
            onClick={() => jump(t.id)}
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 0,
              cursor: "pointer",
              borderRadius: 4,
              overflow: "hidden",
              background: active ? HIGHLIGHT : "transparent",
              border: `1px solid ${active ? HIGHLIGHT_BORDER : "transparent"}`,
              opacity: active ? 1 : 0.55,
            }}
          >
            <span
              style={{
                fontSize: 10,
                lineHeight: "12px",
                fontWeight: 600,
                color: "var(--app-accent, #FF7F16)",
                overflow: "hidden",
                whiteSpace: "nowrap",
              }}
            >
              {firstChar}
            </span>
            <span
              style={{
                fontSize: 9,
                lineHeight: "11px",
                color: "#999",
                fontVariantNumeric: "tabular-nums",
                overflow: "hidden",
                whiteSpace: "nowrap",
              }}
            >
              {formatTime(t.startTime) || "·"}
            </span>
          </div>
        );
      })}
    </div>
  );
}
