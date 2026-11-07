// 聊天渲染第二批（对齐 dashboard 房间消息结构）：
// ① buildTurns：同 sender >10 分钟断 turn / 跨天断 turn / ≤10 分钟合并 /
//    工具与思考帧不拆；
// ② shouldContinueGroup：5 分钟边界 + 同日 + msgtype 族（dashboard
//    MainGrouper 口径）；
// ③ splitTurn：思考 / 工具 / 回答三段分类（审批卡留在 answers）；
// ④ 渲染：process turn = 1 个头像/名字 + 过程条在回答之前 + 流式默认展开；
//    无过程的 turn 仍按 5 分钟续行分组。
import { beforeAll, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  buildTurns,
  shouldContinueGroup,
  messageFamily,
  splitTurn,
  TURN_MAX_GAP_MS,
  CONTINUATION_MAX_INTERVAL_MS,
  type ChatMessage,
  type ToolCall,
  type Turn,
} from "../src/chat/ChatIR";
import { roomMessagesToIR } from "../src/chat/roomAdapter";

const WORKER = "@worker:hs";
const HUMAN = "@human:hs";
/** 过程条归属的 worker 判定表（长文本 notice → 思考）。 */
const WORKERS: Record<string, unknown> = { [WORKER]: "worker-a" };

const MIN = 60 * 1000;
/** 固定日期基准（本地时区）：2026-11-07 10:00。 */
const T0 = new Date(2026, 10, 7, 10, 0, 0).getTime();

function cm(id: string, sender: string, ts: number, body: string, type = "m.text"): ChatMessage {
  return { id, sender, ts, body, type };
}

function toolFrame(id: string, ts: number, name = "read_file"): ChatMessage {
  const call: ToolCall = { id, name, status: "ok", ts, argsSummary: "ChatIR.ts" };
  return {
    id,
    sender: WORKER,
    ts,
    body: `✅ **${name}**:\nChatIR.ts`,
    type: "m.text",
    toolCalls: [call],
  };
}

// ── ① buildTurns ───────────────────────────────────────────────────
describe("buildTurns 断 turn 规则", () => {
  it("同 sender 间隔 11 分钟 → 两个 turn", () => {
    const turns = buildTurns([
      cm("a1", WORKER, T0, "一"),
      cm("a2", WORKER, T0 + 11 * MIN, "二"),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0].messages.map((m) => m.id)).toEqual(["a1"]);
    expect(turns[1].messages.map((m) => m.id)).toEqual(["a2"]);
  });

  it("同 sender 间隔正好 10 分钟 → 同一 turn（边界不算超）", () => {
    const turns = buildTurns([
      cm("b1", WORKER, T0, "一"),
      cm("b2", WORKER, T0 + TURN_MAX_GAP_MS, "二"),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].messages).toHaveLength(2);
  });

  it("跨本地日（间隔仅 2 分钟）→ 两个 turn", () => {
    const late = new Date(2026, 10, 7, 23, 59, 0).getTime();
    const turns = buildTurns([
      cm("c1", WORKER, late, "睡前"),
      cm("c2", WORKER, late + 2 * MIN, "跨天"),
    ]);
    expect(turns).toHaveLength(2);
  });

  it("工具帧/思考帧不拆 turn（且工具调用吸入 turn.toolCalls）", () => {
    const turns = buildTurns([
      cm("d1", WORKER, T0, "先看情况"),
      cm("d2", WORKER, T0 + 5 * 1000, "Thinking:\n\n推理一"),
      toolFrame("d3", T0 + 10 * 1000),
      cm("d4", WORKER, T0 + 15 * 1000, "答案"),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].messages).toHaveLength(4);
    expect(turns[0].toolCalls).toHaveLength(1);
    expect(turns[0].status).toBe("done");
  });
});

// ── ② shouldContinueGroup ──────────────────────────────────────────
describe("shouldContinueGroup（5 分钟 + 同日 + 同族）", () => {
  const base = { sender: HUMAN, ts: T0, msgtype: "m.text", body: "x" };

  it("5 分钟边界：≤ 300000ms 续行，300001ms 断组", () => {
    expect(
      shouldContinueGroup(base, { ...base, ts: T0 + CONTINUATION_MAX_INTERVAL_MS }),
    ).toBe(true);
    expect(
      shouldContinueGroup(base, { ...base, ts: T0 + CONTINUATION_MAX_INTERVAL_MS + 1 }),
    ).toBe(false);
  });

  it("跨本地日（2 分钟）→ 断组", () => {
    const late = new Date(2026, 10, 7, 23, 59, 0).getTime();
    expect(
      shouldContinueGroup({ ...base, ts: late }, { ...base, ts: late + 2 * MIN }),
    ).toBe(false);
  });

  it("不同发送者 → 断组", () => {
    expect(shouldContinueGroup(base, { ...base, sender: WORKER, ts: T0 + MIN })).toBe(false);
  });

  it("m.text / m.notice 同族 → 续行", () => {
    expect(messageFamily(base)).toBe("text");
    expect(messageFamily({ ...base, msgtype: "m.notice" })).toBe("text");
    expect(
      shouldContinueGroup(base, { ...base, msgtype: "m.notice", ts: T0 + MIN }),
    ).toBe(true);
  });

  it("媒体 / 文件 / 工具各自独立", () => {
    const image = { ...base, msgtype: "m.image", body: "" };
    const video = { ...base, msgtype: "m.video", body: "" };
    const file = { ...base, msgtype: "m.file", body: "a.txt" };
    const tool = { ...base, msgtype: "m.text", body: "🔧 **read_file**\na.ts" };
    expect(messageFamily(image)).toBe("media");
    expect(messageFamily(video)).toBe("media");
    expect(messageFamily(file)).toBe("file");
    expect(messageFamily(tool)).toBe("tool");
    expect(shouldContinueGroup(base, { ...image, ts: T0 + MIN })).toBe(false);
    expect(shouldContinueGroup(base, { ...file, ts: T0 + MIN })).toBe(false);
    expect(shouldContinueGroup(base, { ...tool, ts: T0 + MIN })).toBe(false);
    expect(shouldContinueGroup(image, { ...video, ts: T0 + MIN })).toBe(true);
  });

  it("无上一条 → 组首（不续行）", () => {
    expect(shouldContinueGroup(null, base)).toBe(false);
  });
});

// ── ③ splitTurn ────────────────────────────────────────────────────
function turnOf(messages: ChatMessage[]): Turn {
  return {
    id: messages[0].id,
    sender: messages[0].sender,
    startTime: messages[0].ts,
    messages,
    toolCalls: messages.flatMap((m) => m.toolCalls ?? []),
    status: "done",
  };
}

describe("splitTurn 三段拆分", () => {
  const turn = turnOf([
    cm("e1", WORKER, T0, "Thinking:\n\n先读代码", "m.notice"),
    toolFrame("e2", T0 + 1000),
    cm("e3", WORKER, T0 + 2000, "最终回答"),
  ]);

  it("思考 / 工具 / 回答各归其位（原序）", () => {
    const split = splitTurn(turn);
    expect(split.thoughts.map((m) => m.id)).toEqual(["e1"]);
    expect(split.calls).toHaveLength(1);
    expect(split.calls[0].name).toBe("read_file");
    expect(split.answers.map((m) => m.id)).toEqual(["e3"]);
  });

  it("worker 长 notice（无前缀）在给定 worker 表时算思考", () => {
    const t = turnOf([
      cm("f1", WORKER, T0, "推".repeat(300), "m.notice"),
      cm("f2", WORKER, T0 + 1000, "回答"),
    ]);
    const withTable = splitTurn(t, { workerMxids: WORKERS });
    expect(withTable.thoughts.map((m) => m.id)).toEqual(["f1"]);
    // 缺省（无表）时保守：只认前缀，长 notice 留在 answers。
    const withoutTable = splitTurn(t);
    expect(withoutTable.answers.map((m) => m.id)).toEqual(["f1", "f2"]);
  });

  it("自己的消息永不吸收为思考", () => {
    const t = turnOf([
      cm("g1", HUMAN, T0, "Thinking:\n\n我自己的想法", "m.notice"),
      cm("g2", HUMAN, T0 + 1000, "正文"),
    ]);
    const split = splitTurn(t, { isMine: (m) => m.sender === HUMAN });
    expect(split.thoughts).toHaveLength(0);
    expect(split.answers.map((m) => m.id)).toEqual(["g1", "g2"]);
  });

  it("审批卡不被吸收（留在 answers）", () => {
    const approval = cm(
      "h1",
      WORKER,
      T0 + 3000,
      "🛡️ **Approval Required**\n\nCommand: rm -rf build",
    );
    const t = turnOf([cm("h0", WORKER, T0, "Thinking:\n\n要删目录", "m.notice"), approval]);
    const split = splitTurn(t);
    expect(split.thoughts.map((m) => m.id)).toEqual(["h0"]);
    expect(split.answers.map((m) => m.id)).toEqual(["h1"]);
  });
});

// ── ④ 渲染（宿主 shim：组件模块顶层读 window.QwenPaw.host）──────────
const E = React.createElement;

/** 最小 antd 替身：只渲染 children（静态 markup 断言足够）。 */
const Stub =
  (tag: string) =>
  (props: { children?: React.ReactNode }) =>
    E(tag, null, props?.children);

const antd = {
  Avatar: Stub("span"),
  Button: Stub("button"),
  Dropdown: Stub("div"),
  Popover: Stub("div"),
  Tooltip: Stub("div"),
  Tag: Stub("span"),
  Input: Stub("input"),
  Popconfirm: Stub("div"),
  Drawer: Stub("div"),
  Empty: Stub("div"),
  Typography: { Text: Stub("span") },
  message: { success: () => undefined, error: () => undefined },
};

(globalThis as Record<string, unknown>).window = {
  QwenPaw: {
    host: {
      React,
      antd,
      antdIcons: {},
      fetch: vi.fn(async () => ({
        status: 404,
        ok: false,
        json: async () => ({}),
        text: async () => "",
      })),
      useLocale: () => "zh",
      useTheme: () => "light",
    },
  },
  matchMedia: () => ({ matches: false }),
};
(globalThis as Record<string, unknown>).document = { hidden: false };

const tr = (s: string, v?: Record<string, string | number>): string => {
  let out = s;
  for (const [k, val] of Object.entries(v ?? {})) {
    out = out.split(`{${k}}`).join(String(val));
  }
  return out;
};

const T_COLORS = {
  mode: "light",
  bg: "#fff",
  cardBg: "#fff",
  text: "#111",
  textSecondary: "#888",
  border: "rgba(0,0,0,0.08)",
  bubbleOther: "rgba(0,0,0,0.04)",
  bubbleMine: "rgba(255,127,22,0.08)",
  hoverBg: "rgba(0,0,0,0.03)",
  popoverBg: "#fff",
  toolBg: "rgba(0,0,0,0.03)",
  accentBg: "rgba(255,127,22,0.1)",
};

interface RoomMsgLike {
  event_id: string;
  sender: string;
  origin_server_ts: number;
  body: string;
  msgtype: string;
  pending?: boolean;
}

function roomMsg(
  id: string,
  sender: string,
  ts: number,
  body: string,
  extra: Partial<RoomMsgLike> = {},
): RoomMsgLike {
  return { event_id: id, sender, origin_server_ts: ts, body, msgtype: "m.text", ...extra };
}

type MessagesMod = {
  default: (props: Record<string, unknown>) => React.ReactElement;
};
let RoomChatMessages: MessagesMod["default"];
let PendingProvider: (props: { children: React.ReactNode }) => React.ReactElement;

beforeAll(async () => {
  const mod = (await import("../src/components/RoomChatMessages")) as unknown as MessagesMod;
  RoomChatMessages = mod.default;
  const pending = (await import("../src/pending/store")) as unknown as {
    PendingProvider: typeof PendingProvider;
  };
  PendingProvider = pending.PendingProvider;
});

const ROOM = {
  room_id: "!r:hs",
  name: "团队房",
  members: {
    [WORKER]: { user_id: WORKER, display_name: "工人甲" },
    [HUMAN]: { user_id: HUMAN, display_name: "小明" },
  },
};

/** 按 RoomChatView 的口径从 tops 造 renderItems（turn 切片）。 */
function render(tops: RoomMsgLike[]): string {
  const ir = roomMessagesToIR(tops as never);
  const turns = buildTurns(ir);
  const idxById = new Map<string, number>();
  tops.forEach((m, i) => {
    if (!idxById.has(m.event_id)) idxById.set(m.event_id, i);
  });
  const renderItems = turns.map((turn) => {
    const start = idxById.get(turn.id) ?? 0;
    return {
      kind: "turn",
      key: `turn-${turn.id}`,
      ts: tops[start]?.origin_server_ts ?? 0,
      range: { turn, start, end: start + turn.messages.length },
    };
  });
  const core = {
    room: ROOM,
    loading: false,
    hasMore: false,
    loadingMore: false,
    errorNote: null,
    threadGroups: { hiddenCount: 0, repliesOf: new Map() },
    stickToBottom: { isAtBottom: true, unread: 0, handleScroll: () => undefined },
    listRef: { current: null },
    dragOver: false,
    setDragOver: () => undefined,
    hoveredId: null,
    setHoveredId: () => undefined,
    hoverTimerRef: { current: null },
    myUserId: HUMAN,
    readTs: 0,
    visibleMessages: tops,
    liveByRunId: new Map(),
    teamName: null,
    resolvedApprovals: {},
    activeThread: null,
    workerSessionByMxid: {},
    memberWorkerNames: {},
    workerRuntimeByMxid: {},
    onOpenProject: () => undefined,
    onDm: () => undefined,
    onOpenWorkerChats: () => undefined,
    onReact: () => undefined,
    onRedact: () => undefined,
    onLoadOriginal: async () => "found",
    insertMention: () => undefined,
    openDetailMxid: () => undefined,
    handleApprovalAction: () => undefined,
    handleDeliverable: () => undefined,
    setReplyTo: () => undefined,
    setEditing: () => undefined,
    setDraft: () => undefined,
    composerRef: { current: null },
    setActiveThread: () => undefined,
    revealWindow: () => undefined,
    kickLoadMore: () => undefined,
    t: T_COLORS,
    tr,
  };
  const view = {
    tops,
    renderItems,
    vwin: { start: 0, end: renderItems.length },
    renderedLastTopIdx: tops.length - 1,
    turnTicks: [],
    topSentinelRef: { current: null },
    bottomSentinelRef: { current: null },
    jumpWithEnsure: async () => undefined,
    jumpToBottomWindowed: async () => undefined,
  };
  const p = {
    room: ROOM,
    messages: tops,
    onSend: () => undefined,
    canSend: true,
    onWorkflowIntervened: () => undefined,
    activityProject: null,
  };
  return renderToStaticMarkup(
    E(PendingProvider, null, E(RoomChatMessages, { p, c: core, v: view })),
  );
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe("turn 级渲染", () => {
  const tops = [
    roomMsg("t1", WORKER, T0, "Thinking:\n\n先读后端", { msgtype: "m.notice" }),
    roomMsg("t2", WORKER, T0 + 2000, "✅ **read_file**:\nChatIR.ts"),
    roomMsg("t3", WORKER, T0 + 4000, "最终回答：已经改好"),
  ];

  it("一个 turn 只渲染 1 个头像/名字（header 仅一次）", () => {
    const html = render(tops);
    expect(count(html, 'data-turn-id="t1"')).toBe(1);
    expect(count(html, "工人甲")).toBe(1);
  });

  it("过程条在最终回答之前（header → process → answers）", () => {
    const html = render(tops);
    const header = html.indexOf("工人甲");
    const process = html.indexOf("思考过程");
    const answer = html.indexOf("最终回答：已经改好");
    expect(header).toBeGreaterThanOrEqual(0);
    expect(process).toBeGreaterThan(header);
    expect(answer).toBeGreaterThan(process);
  });

  it("只有过程没有回答 → header + process，无回答气泡", () => {
    const html = render([
      roomMsg("u1", WORKER, T0, "Thinking:\n\n只想不做", { msgtype: "m.notice" }),
      roomMsg("u2", WORKER, T0 + 1000, "🔧 **read_file**\nChatIR.ts"),
    ]);
    expect(count(html, "工人甲")).toBe(1);
    expect(html).toContain("思考过程");
    expect(html).toContain("1 次工具调用");
    expect(html).not.toContain("最终回答");
  });

  it("流式进行中：过程条默认展开 + 转圈 + 「进行中」", () => {
    const html = render([
      roomMsg("v1", WORKER, T0, "Thinking:\n\n正在想", { msgtype: "m.notice" }),
      roomMsg("v2", WORKER, T0 + 1000, "🔧 **read_file**\nChatIR.ts"),
    ]);
    expect(html).toContain("进行中");
    expect(html).toContain('class="wb-process-spin"');
    expect(html).toContain("grid-template-rows:1fr");
  });

  it("turn 结束（done）：过程条默认折叠，不显示「进行中」", () => {
    const html = render(tops);
    expect(html).not.toContain("进行中");
    expect(html).toContain("grid-template-rows:0fr");
  });

  it("历史 turn 的未闭合工具帧不算「进行中」（只有尾部 turn 能活跃）", () => {
    const html = render([
      roomMsg("y1", WORKER, T0, "Thinking:\n\n先看看", { msgtype: "m.notice" }),
      roomMsg("y2", WORKER, T0 + 1000, "🔧 **read_file**\nChatIR.ts"),
      roomMsg("y3", HUMAN, T0 + 2000, "好了"),
    ]);
    expect(html).not.toContain("进行中");
  });

  it("无过程的 turn 仍按 5 分钟续行：4 分钟同组、6 分钟断组", () => {
    const same = render([
      roomMsg("w1", HUMAN, T0, "第一句"),
      roomMsg("w2", HUMAN, T0 + 4 * MIN, "第二句"),
    ]);
    expect(count(same, "小明")).toBe(1);
    const split = render([
      roomMsg("x1", HUMAN, T0, "第一句"),
      roomMsg("x2", HUMAN, T0 + 6 * MIN, "第二句"),
    ]);
    expect(count(split, "小明")).toBe(2);
  });
});
