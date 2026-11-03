/**
 * harness/entry-loadmore-fix.tsx — 视口窗口化（16.46）smoke 入口
 *（不进 dist，esbuild 独立打包成 harness/bundle-loadmore-fix.js）。
 *
 * 数据：500 条 mock 消息（两发送者交替 → 500 turn，每 turn 一条；
 * 单消息无 reply → 全 tops）。RoomChat 传 minWindowTops=100000
 *（数据窗=全量，任意深目标可达，模拟 R2 回填后状态）。
 *
 * 控制面 window.__HM__：
 *   countRows()/countTicks()/rowOffset(id)/firstRowId()/scroll()
 *   prepend(n)/append(n)      （模拟 loadMore 前插 / SSE·R2 追加的整批提交）
 *   setJumpToEventId(id|null) / jumpHandled()
 *   t0()/t1()                 （performance.now 计时钩子，与提交同一时钟）
 */
import type * as ReactNS from "react";
const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

import RoomChat from "../src/components/RoomChat";
import { PendingProvider } from "../src/pending/store";
import type { RoomMessage } from "../src/api";

const A = "@alice:hs";
const B = "@bob:hs";
const BASE_TS = 1_761_000_000_000;

/** offset 起连续 count 条（event_id 全局唯一；交替发送者 → 每条约一 turn）。 */
function makeMsgs(count: number, offset: number): RoomMessage[] {
  const out: RoomMessage[] = [];
  for (let i = 0; i < count; i++) {
    const k = offset + i;
    out.push({
      event_id: `!m${k}:hs`,
      sender: k % 2 === 0 ? A : B,
      body: `message ${k} ${"payload ".repeat(5)}`,
      msgtype: "m.text",
      origin_server_ts: BASE_TS + k * 1000,
    });
  }
  return out;
}

const ROOM = {
  room_id: "!loadmore:hs",
  name: "视口窗口化验收",
  member_count: 3,
  members: {
    "@me:hs": { displayname: "me", avatar_url: null },
    [A]: { displayname: "alice", avatar_url: null },
    [B]: { displayname: "bob", avatar_url: null },
  },
  last_ts: BASE_TS + 700_000,
  last_body: "",
  is_dm: false,
} as never;

/** 消息滚动容器 = 首个 [data-event-id] 的最近 overflow-y:auto 祖先。 */
function listEl(): HTMLElement | null {
  const row = document.querySelector("[data-event-id]");
  if (!row) return null;
  let el = row.parentElement;
  while (el && el !== document.body) {
    const oy = getComputedStyle(el).overflowY;
    if (oy === "auto" || oy === "scroll") return el;
    el = el.parentElement;
  }
  return null;
}

interface HM {
  countRows(): number;
  countTicks(): number;
  rowOffset(id: string): number | null;
  firstRowId(): string | null;
  scroll(): { top: number; height: number; client: number };
  prepend(n: number): void;
  append(n: number): void;
  setJumpToEventId(id: string | null): void;
  jumpHandled(): number;
  rowStyleBg(id: string): string;
  /** 打点（返回 performance.now）。 */
  t0(): number;
  /** 读取 t0() 时间戳（只读，不重打点）。 */
  t0Value(): number;
  t1(): number;
  /** t0() 至今的耗时（同一时钟）。 */
  elapsed(): number;
  /** 布防：监听消息列表 DOM 变化，记第一次变更时刻（= 下一次提交落地）。 */
  armCommitMark(): void;
  /** 第一次 DOM 变更的 performance.now()（0 = 未发生）。 */
  commitMark(): number;
}

function HarnessApp() {
  // 初始 500 条（全局索引 500..999；留低位段给 prepend 用）。
  const [msgs, setMsgs] = React.useState<RoomMessage[]>(() => makeMsgs(500, 500));
  const [jumpTo, setJumpTo] = React.useState<string | null>(null);
  const jumpHandledRef = React.useRef(0);
  const offsetRef = React.useRef(500); // 首条消息的全局索引
  const lenRef = React.useRef(500);

  const onJumpHandled = React.useCallback(() => {
    jumpHandledRef.current += 1;
  }, []);
  const tMarkRef = React.useRef(0);
  const commitMarkRef = React.useRef(0);
  const moRef = React.useRef<MutationObserver | null>(null);

  React.useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    const hm: HM = {
      countRows: () => document.querySelectorAll("[data-event-id]").length,
      countTicks: () => document.querySelectorAll("[data-tick]").length,
      rowOffset: (id: string) => {
        const list = listEl();
        const row = document.querySelector(`[data-event-id="${id}"]`);
        if (!list || !row) return null;
        return (row as HTMLElement).getBoundingClientRect().top -
          list.getBoundingClientRect().top;
      },
      firstRowId: () => {
        const r = document.querySelector("[data-event-id]");
        return r ? ((r as HTMLElement).dataset.eventId ?? null) : null;
      },
      scroll: () => {
        const list = listEl();
        if (!list) return { top: -1, height: -1, client: -1 };
        return { top: list.scrollTop, height: list.scrollHeight, client: list.clientHeight };
      },
      prepend: (n: number) => {
        const off = offsetRef.current - n;
        offsetRef.current = off;
        lenRef.current += n;
        setMsgs((prev) => [...makeMsgs(n, off), ...prev]);
      },
      append: (n: number) => {
        const off = offsetRef.current + lenRef.current;
        lenRef.current += n;
        setMsgs((prev) => [...prev, ...makeMsgs(n, off)]);
      },
      setJumpToEventId: (id: string | null) => setJumpTo(id),
      jumpHandled: () => jumpHandledRef.current,
      rowStyleBg: (id: string) => {
        const row = document.querySelector(`[data-event-id="${id}"]`);
        return row ? (row as HTMLElement).style.background : "";
      },
      t0: () => {
        tMarkRef.current = performance.now();
        return tMarkRef.current;
      },
      t0Value: () => tMarkRef.current,
      t1: () => performance.now(),
      elapsed: () => performance.now() - tMarkRef.current,
      armCommitMark: () => {
        const list = listEl();
        commitMarkRef.current = 0;
        moRef.current?.disconnect();
        if (!list) return;
        const mo = new MutationObserver(() => {
          if (!commitMarkRef.current) commitMarkRef.current = performance.now();
          mo.disconnect();
        });
        mo.observe(list, { childList: true, subtree: true });
        moRef.current = mo;
      },
      commitMark: () => commitMarkRef.current,
    };
    w.__HM__ = hm;
    return () => {
      delete w.__HM__;
    };
  }, []);

  return (
    <div style={{ width: "100%", height: "100vh" }}>
      <RoomChat
        room={ROOM}
        messages={msgs}
        user_id="@me:hs"
        canSend={false}
        minWindowTops={100000}
        jumpToEventId={jumpTo}
        onJumpHandled={onJumpHandled}
      />
    </div>
  );
}

const ReactDOM = (window as unknown as {
  ReactDOM: { createRoot: (el: Element) => { render: (n: ReactNS.ReactNode) => void } };
}).ReactDOM;
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <PendingProvider>
    <HarnessApp />
  </PendingProvider>,
);
