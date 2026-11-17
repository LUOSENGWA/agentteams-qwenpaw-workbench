// 聊天页 per-room 状态隔离（0.5.0-beta.17.6）——隔离机制回归测试，宿主可跑形式。
//
// 环境边界（如实声明）：容器 vitest-shim 通道是 node runner（无 jsdom），
// 本文件容器内跑不了——`node scripts/vitest-gate.mjs tests/chat-room-isolation.vitest.test.ts`
// 容器内 FAIL = 环境局限、非回归；宿主 vitest（@vitest-environment jsdom）全跑。
// 失败形态（17.6 补刀后）：本文件现动态 import ../src/WorkbenchPage，
// 其图含 3 个 svg 资产（openclaw.svg / agentteams-logo.svg?inline /
// millforge-logo.svg?inline）——esbuild shim 通道无 .svg loader，
// 打包即 FAIL（「No loader is configured for .svg」）；补刀前是跑起来后
// document.createElement/localStorage 不可用一类报错（无 jsdom）。
// 宿主 vite 管线原生处理 svg（?inline 强制内联），不受影响。
//
// 覆盖 17.6 per-room 隔离机制（父侧 key={room_id} remount + 换房消息 paint 前落地）：
// ① useStickToBottom 换房首观察保护（skipPrependOnce）：
//    roomKey A→B 后首条 firstId 观察不判前插（即便与旧房 firstId 不同）；
//    同 room 内后续 firstId 变化（真实前插）正常触发 onPrepend——
//    「开群跳到中间」= 旧房 firstId 残留误判前插 + 窗口棘轮扩窗把用户打离底部。
// ② 线程状态 room-scoped（THREAD_STATE_KEY 加 room_id 维度）：
//    存储 room_id = 当前房 → thread 恢复；≠ 当前房 → thread 不恢复（防跨房残留）；
//    旧格式（无 room_id）→ thread 不恢复；
//    width 是面板偏好、跨房共享 → 各场景照旧恢复。
//    ② 同时覆盖 17.6 卸载清报（onThreadPanelLayout unmount cleanup）：
//    换房（remount）旧房卸载时向父侧报 (false, 0)——
//    无清理则父侧 threadPanelRef 停在旧房带面板的值，分栏宽算错。
// ③ minWindowTops 按房打标（scopedMinWindowTops，17.6 补刀）：
//    messagesRoomId ≠ 当前房 → 传 0（remount 首渲染不消费旧房值——
//    子侧单向棘轮会把它永久抬高新房 windowLimit）；
//    = 当前房 → 传原值（房内正常棘轮值不受影响）；无房/未打标 → 0。
//
// 测试环境陷阱（chatTabActive1514）：「离开聊天 tab → 关话题」effect 依赖
// useTabActive("chat")；测试环境 currentTab="" → false → mount 后会清掉已恢复的
// thread → beforeAll 先 setActiveTab("chat")（src/tabActivity 单源）。
// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import React from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomMessage, TeamRoom } from "../src/api";
import type { RoomChatProps } from "../src/components/RoomChat";
import type { RoomChatCoreState } from "../src/components/RoomChatCore";
import type {
  StickToBottom,
  StickToBottomOptions,
} from "../src/components/useStickToBottom";

// ── 宿主桥 shim（process-bar-ux 同款组织：src 模块求值前必须就位）。
// antd 面 = useRoomChatCore hook 体内 createElement 用到的成员（probe 只返回
// 裸 div，不渲染 antd 视图，但元素创建要求类型存在）。
const host = {
  React,
  antd: {
    Card: (p: { children?: React.ReactNode }) =>
      React.createElement("div", null, p.children),
    Empty: () => React.createElement("div"),
    Button: (p: { children?: React.ReactNode }) =>
      React.createElement("button", { type: "button" }, p.children),
    Tag: (p: { children?: React.ReactNode }) =>
      React.createElement("span", null, p.children),
    Dropdown: (p: { children?: React.ReactNode }) =>
      React.createElement("div", null, p.children),
    Typography: {
      Title: (p: { children?: React.ReactNode }) =>
        React.createElement("h3", null, p.children),
    },
    message: {
      success: () => undefined,
      error: () => undefined,
      warning: () => undefined,
    },
  },
  antdIcons: {},
  fetch: vi.fn(async () => ({ status: 404, ok: false, text: async () => "" })),
  useLocale: () => "zh",
  useTheme: () => "light",
};
(globalThis as Record<string, unknown>).window = window;
(window as unknown as Record<string, unknown>).QwenPaw = { host };
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom 不一定提供 rAF（stick hook 的贴底写入走 rAF）→ 兜底 polyfill
// （宿主 vitest jsdom 已有时不覆盖）。
if (typeof window.requestAnimationFrame !== "function") {
  const raf = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 16) as unknown as number;
  const caf = (id: number) => clearTimeout(id);
  (window as unknown as Record<string, unknown>).requestAnimationFrame = raf;
  (window as unknown as Record<string, unknown>).cancelAnimationFrame = caf;
  (globalThis as Record<string, unknown>).requestAnimationFrame = raf;
  (globalThis as Record<string, unknown>).cancelAnimationFrame = caf;
}

// src 模块顶层读 window.QwenPaw.host → 动态 import（esbuild 惰性 __esm，
// 本文件顶层 shim 先于模块求值落地）。
let useStickToBottom: (opts: StickToBottomOptions) => StickToBottom;
let useRoomChatCore: (props: RoomChatProps) => RoomChatCoreState;
let PendingProvider: (props: { children: React.ReactNode }) => React.ReactElement;
let setActiveTab: (tab: string) => void;
let scopedMinWindowTops: (
  messagesRoomId: string,
  roomId: string | undefined,
  value: number,
) => number;

beforeAll(async () => {
  const [stick, core, pending, tab, wb] = await Promise.all([
    import("../src/components/useStickToBottom"),
    import("../src/components/RoomChatCore"),
    import("../src/pending/store"),
    import("../src/tabActivity"),
    import("../src/WorkbenchPage"),
  ]);
  useStickToBottom = stick.useStickToBottom;
  useRoomChatCore = core.useRoomChatCore;
  PendingProvider = pending.PendingProvider;
  setActiveTab = tab.setActiveTab;
  scopedMinWindowTops = wb.scopedMinWindowTops;
  setActiveTab("chat"); // chatTabActive1514 门：见文件头陷阱说明
});

const THREAD_STATE_KEY = "agentteams-qwenpaw-workbench:thread-state";
const ROOM_A: TeamRoom = {
  room_id: "!a",
  name: "Room A",
  member_count: 2,
  members: {},
};
const ROOM_B: TeamRoom = {
  room_id: "!b",
  name: "Room B",
  member_count: 2,
  members: {},
};
const MSG_T1: RoomMessage = {
  event_id: "t1",
  sender: "@worker:example.org",
  body: "话题根消息",
  msgtype: "m.text",
  origin_server_ts: 1700000000000,
};

// ── ① useStickToBottom 换房首观察保护 ─────────────────────────────
// probe 只挂 listRef（锚点查询/贴底写入需要真元素），不渲染消息行。
function StickProbe(props: {
  roomKey: string;
  firstId: string;
  onPrepend: () => void;
}) {
  const stick = useStickToBottom({
    roomKey: props.roomKey,
    firstId: props.firstId,
    onPrepend: props.onPrepend,
  });
  return React.createElement("div", { ref: stick.listRef });
}

describe("useStickToBottom — 换房首观察保护（skipPrependOnce，17.6）", () => {
  it("roomKey A→B 后首条 firstId 观察不触发 onPrepend；同 room 内真实前插正常触发", () => {
    const onPrepend = vi.fn();
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    const render = (roomKey: string, firstId: string) =>
      flushSync(() => {
        root.render(
          React.createElement(StickProbe, {
            roomKey,
            firstId,
            onPrepend,
          }),
        );
      });
    // mount：首观察（prevFirstId 为空）→ 不判前插。
    render("A", "a1");
    expect(onPrepend).not.toHaveBeenCalled();
    // 房 A 内真实前插（firstId a1→a0，加载更早页）→ 正常触发（机制基线）。
    render("A", "a0");
    expect(onPrepend).toHaveBeenCalledTimes(1);
    // 换房 A→B：新房首条 firstId 观察（b1 ≠ 旧房 a0）→ 不得误判前插。
    render("B", "b1");
    expect(onPrepend).toHaveBeenCalledTimes(1);
    // 房 B 内真实前插 → 正常触发（保护只吞一次，不误伤后续）。
    render("B", "b0");
    expect(onPrepend).toHaveBeenCalledTimes(2);
    flushSync(() => root.unmount());
    el.remove();
  });
});

// ── ② 线程状态 room-scoped（THREAD_STATE_KEY 的 room_id 维度）─────
// probe 调 useRoomChatCore 并回读 activeThread/panelWidth（data-* 载体）。
// usePendingStore 无 PendingProvider 即抛 → probe 必须包在 Provider 内。
// 每个场景一次全新 mount（useState 初始化器只在首渲染执行 =
// 「mount 只恢复一次」语义）；场景间 unmount + beforeEach 清 localStorage。
function ThreadProbe(props: {
  room: TeamRoom;
  messages: RoomMessage[];
  onThreadPanelLayout?: (open: boolean, width: number) => void;
}) {
  const c = useRoomChatCore({
    room: props.room,
    messages: props.messages,
    onThreadPanelLayout: props.onThreadPanelLayout,
  });
  return React.createElement("div", {
    "data-thread": c.activeThread ?? "",
    "data-panelwidth": String(c.panelWidth),
  });
}

function mountThread(
  room: TeamRoom,
  messages: RoomMessage[],
  onThreadPanelLayout?: (open: boolean, width: number) => void,
) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  flushSync(() => {
    root.render(
      React.createElement(
        PendingProvider,
        null,
        React.createElement(ThreadProbe, {
          room,
          messages,
          onThreadPanelLayout,
        }),
      ),
    );
  });
  const node = el.firstElementChild as HTMLElement;
  return {
    activeThread: () => node.getAttribute("data-thread") || null,
    panelWidth: () => Number(node.getAttribute("data-panelwidth")),
    cleanup: () => {
      flushSync(() => root.unmount());
      el.remove();
    },
  };
}

describe("线程状态 room-scoped（THREAD_STATE_KEY 加 room_id 维度，17.6）", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("存储 room_id ≠ 当前房 → thread 不恢复（防跨房残留）；width 照旧恢复", () => {
    window.localStorage.setItem(
      THREAD_STATE_KEY,
      JSON.stringify({ room_id: "!b", thread: "t1", width: 400 }),
    );
    const a = mountThread(ROOM_A, []);
    expect(a.activeThread()).toBe(null);
    expect(a.panelWidth()).toBe(400);
    a.cleanup();
  });

  it("存储 room_id = 当前房 → thread 恢复；卸载时向父侧清报 (false, 0)", () => {
    window.localStorage.setItem(
      THREAD_STATE_KEY,
      JSON.stringify({ room_id: "!b", thread: "t1", width: 400 }),
    );
    const panelLayout = vi.fn();
    const b = mountThread(ROOM_B, [MSG_T1], panelLayout);
    expect(b.activeThread()).toBe("t1");
    expect(b.panelWidth()).toBe(400);
    // 宽屏（jsdom innerWidth=1024 ≥ 900）inline 面板占宽 → 上报 (true, 400)。
    expect(panelLayout).toHaveBeenCalledWith(true, 400);
    // 换房即 remount：旧房卸载的 cleanup 报 (false, 0)（17.6）——
    // 无清理则父侧 threadPanelRef 停在旧房带面板的值，分栏宽算错。
    b.cleanup();
    const calls = panelLayout.mock.calls;
    expect(calls[calls.length - 1]).toEqual([false, 0]);
  });

  it("旧格式（无 room_id）→ thread 不恢复；width 照旧恢复", () => {
    window.localStorage.setItem(
      THREAD_STATE_KEY,
      JSON.stringify({ thread: "t1", width: 400 }),
    );
    const c = mountThread(ROOM_B, [MSG_T1]);
    expect(c.activeThread()).toBe(null);
    expect(c.panelWidth()).toBe(400);
    c.cleanup();
  });
});

// ── ③ minWindowTops 按房打标（scopedMinWindowTops，17.6 补刀）────────
// remount 首渲染（C1）父侧 minWindowTops 还是旧房值（reset 在 C1 父 layout
// 才落地），RoomChatCore 棘轮单向（只升不降）→ 旧值放行会永久抬高新房
// windowLimit。判定抽成 WorkbenchPage.tsx 导出纯函数（调用点同步改用
// scopedMinWindowTops），本处单测判定语义——WorkbenchPage 整体 mount
// 成本过高（全量 hook 树 + 宿主桥），不 mount。
describe("minWindowTops 按房打标（scopedMinWindowTops，17.6 补刀）", () => {
  it("messagesRoomId ≠ 当前房 → 0；= 当前房 → 原值；无房/未打标 → 0", () => {
    // remount 首渲染：父侧 state 还是旧房（!a）的棘轮值，当前房已切 !b → 不放行。
    expect(scopedMinWindowTops("!a", "!b", 30)).toBe(0);
    // 房内正常：所属房标 = 当前房 → 原值放行（「加载原消息」抬升的棘轮生效）。
    expect(scopedMinWindowTops("!a", "!a", 30)).toBe(30);
    // 首挂载（打标 effect 尚未落地，messagesRoomId=""）→ 不放行。
    expect(scopedMinWindowTops("", "!a", 30)).toBe(0);
    // 无活跃房（activeRoom=null）→ 不放行。
    expect(scopedMinWindowTops("!a", undefined, 30)).toBe(0);
    // 初值零值幂等（两种判定路径同结果）。
    expect(scopedMinWindowTops("!a", "!a", 0)).toBe(0);
    expect(scopedMinWindowTops("!a", "!b", 0)).toBe(0);
  });
});
