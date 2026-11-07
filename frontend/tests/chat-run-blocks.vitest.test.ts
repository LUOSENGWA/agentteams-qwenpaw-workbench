// 运行时块协议（org.agentteams.run）前端消费层：
// ① parseRunBlocks：v1 严格归一化 / 无效块跳过 / legacy 宽松 / 未知
//    version 与畸形 envelope 回退 body；
// ② splitTurn：thinking/tool_call/text/confirmation/error 分类，有块时
//    不重复解析正文；
// ③ 渲染：confirmation 只读卡 + error 状态条独立出现，text 块替代 body，
//    无块时沿用既有 m.notice/🔧 启发式。
import { beforeAll, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { parseRunBlocks } from "../src/api/domains/chat";
import type { RunBlock } from "../src/api";
import {
  buildTurns,
  splitTurn,
  type ChatMessage,
  type Turn,
} from "../src/chat/ChatIR";
import { roomMessagesToIR } from "../src/chat/roomAdapter";

const WORKER = "@worker:hs";
const HUMAN = "@human:hs";
const T0 = new Date(2026, 10, 7, 10, 0, 0).getTime();

function envelope(blocks: unknown[], version?: unknown): Record<string, unknown> {
  return {
    "org.agentteams.run": {
      ...(version === undefined ? {} : { version }),
      blocks,
    },
  };
}

// ── ① parseRunBlocks ──────────────────────────────────────────────
describe("parseRunBlocks v1（严格归一化）", () => {
  it("五类块全部归一化（可选字段补默认）", () => {
    const blocks = parseRunBlocks(
      envelope([
        { type: "thinking", content: "想一下", isStreaming: true },
        {
          type: "tool_call",
          tool_name: "read_file",
          arguments: { path: "a.ts" },
          status: "succeeded",
          tool_call_id: "c1",
          started_at: 11,
          finished_at: 12,
          result: { ok: true },
        },
        { type: "text", text: "答案" },
        {
          type: "confirmation",
          tool_name: "shell",
          confirmation_id: "cf1",
          parameters: "rm -rf build",
          external_files: "out.log",
          expires_at: 99,
        },
        { type: "error", kind: "cancelled", title: "用户取消" },
      ], "1"),
    );
    expect(blocks).toHaveLength(5);
    expect(blocks?.[0]).toEqual({
      type: "thinking",
      content: "想一下",
      isStreaming: true,
    });
    expect(blocks?.[1]).toEqual({
      type: "tool_call",
      tool_name: "read_file",
      arguments: { path: "a.ts" },
      status: "succeeded",
      tool_call_id: "c1",
      started_at: 11,
      finished_at: 12,
      result: { ok: true },
    });
    expect(blocks?.[2]).toEqual({ type: "text", text: "答案" });
    expect(blocks?.[3]).toEqual({
      type: "confirmation",
      tool_name: "shell",
      confirmation_id: "cf1",
      parameters: "rm -rf build",
      external_files: "out.log",
      expires_at: 99,
    });
    expect(blocks?.[4]).toEqual({
      type: "error",
      kind: "cancelled",
      title: "用户取消",
    });
  });

  it("tool_call 缺省 status/arguments → running / {}", () => {
    const blocks = parseRunBlocks(
      envelope([{ type: "tool_call", tool_name: "grep" }], "1"),
    );
    expect(blocks).toEqual([
      {
        type: "tool_call",
        tool_name: "grep",
        arguments: {},
        status: "running",
      },
    ]);
  });

  it("必填字段缺失/非法的块跳过（不修复）", () => {
    const blocks = parseRunBlocks(
      envelope([
        { type: "thinking" },
        { type: "thinking", content: "   " },
        { type: "tool_call", tool_name: "" },
        { type: "confirmation", tool_name: "shell" }, // 缺 confirmation_id
        { type: "error", kind: "boom", title: "x" }, // 非法 kind
        { type: "error", kind: "failed" }, // 缺 title
        { type: "text", text: "" },
        { type: "unknown_block", content: "x" },
        { type: "text", text: "有效" },
      ], "1"),
    );
    expect(blocks).toEqual([{ type: "text", text: "有效" }]);
  });

  it("全部无效 → undefined（回退 body 启发式）", () => {
    expect(parseRunBlocks(envelope([{ type: "thinking" }], "1"))).toBeUndefined();
  });

  it("未知 version / blocks 非数组 / 非对象 / 缺信封 → undefined", () => {
    expect(parseRunBlocks(envelope([{ type: "text", text: "x" }], "2"))).toBeUndefined();
    expect(
      parseRunBlocks({ "org.agentteams.run": { version: "1", blocks: {} } }),
    ).toBeUndefined();
    expect(parseRunBlocks(null)).toBeUndefined();
    expect(parseRunBlocks("x")).toBeUndefined();
    expect(parseRunBlocks({})).toBeUndefined();
    expect(parseRunBlocks({ "org.agentteams.run": [] })).toBeUndefined();
  });

  it("blocks 为空 → undefined（无块不设 runBlocks）", () => {
    expect(parseRunBlocks(envelope([], "1"))).toBeUndefined();
    expect(parseRunBlocks(envelope([], "0"))).toBeUndefined();
    expect(parseRunBlocks(envelope([]))).toBeUndefined();
  });
});

describe("parseRunBlocks legacy（version 0 / 缺省，宽松）", () => {
  it("缺省 version 顶层字段宽松复制", () => {
    const blocks = parseRunBlocks(
      envelope([
        { type: "thinking", content: "旧思考" },
        { type: "text", text: "旧正文" },
      ]),
    );
    expect(blocks).toEqual([
      { type: "thinking", content: "旧思考" },
      { type: "text", text: "旧正文" },
    ]);
  });

  it("legacy payload 嵌套（dashboard 归一化输出形态）可解析", () => {
    const blocks = parseRunBlocks(
      envelope([
        {
          type: "tool_call",
          payload: {
            tool_name: "write_file",
            arguments: { path: "b.ts" },
            status: "failed",
          },
        },
      ], "0"),
    );
    expect(blocks).toEqual([
      {
        type: "tool_call",
        tool_name: "write_file",
        arguments: { path: "b.ts" },
        status: "failed",
      },
    ]);
  });
});

// ── ② splitTurn ───────────────────────────────────────────────────
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

const ALL_BLOCKS: RunBlock[] = [
  { type: "thinking", content: "先读代码" },
  {
    type: "tool_call",
    tool_name: "read_file",
    arguments: { path: "ChatIR.ts" },
    status: "succeeded",
    tool_call_id: "call-1",
    started_at: T0 + 500,
    result: { lines: 12 },
  },
  { type: "text", text: "块里的回答" },
  {
    type: "confirmation",
    tool_name: "shell",
    confirmation_id: "cf-1",
    parameters: "rm -rf build",
  },
  { type: "error", kind: "failed", title: "沙箱拒绝" },
];

describe("splitTurn 消费结构化块", () => {
  const msg: ChatMessage = {
    id: "m1",
    sender: WORKER,
    ts: T0,
    body: "审计用正文（不应重复渲染）",
    type: "m.text",
    runBlocks: ALL_BLOCKS,
    // body 启发式会被块优先级覆盖：这条工具帧不该进 calls
    toolCalls: [{ id: "heur", name: "heuristic_tool", status: "ok" }],
  };

  it("thinking / tool_call / text / confirmation / error 各归其位", () => {
    const split = splitTurn(turnOf([msg]));
    expect(split.thoughts.map((m) => m.body)).toEqual(["先读代码"]);
    expect(split.calls).toHaveLength(1);
    expect(split.calls[0].id).toBe("call-1");
    expect(split.calls[0].name).toBe("read_file");
    expect(split.calls[0].status).toBe("ok");
    expect(split.calls[0].argsSummary).toBe('{"path":"ChatIR.ts"}');
    expect(split.calls[0].detail).toContain("lines");
    expect(split.calls[0].ts).toBe(T0 + 500);
    expect(split.answers.map((m) => m.body)).toEqual(["块里的回答"]);
    expect(split.confirmations.map((c) => c.confirmation_id)).toEqual(["cf-1"]);
    expect(split.errors.map((e) => e.kind)).toEqual(["failed"]);
  });

  it("有 text 块时不再用原 body（不重复）", () => {
    const split = splitTurn(turnOf([msg]));
    expect(split.answers.every((m) => !m.body.includes("审计用正文"))).toBe(true);
  });

  it("tool_call 状态映射：pending/running → call，failed → fail", () => {
    const mk = (status: "pending" | "running" | "failed"): ChatMessage => ({
      id: `s-${status}`,
      sender: WORKER,
      ts: T0,
      body: "",
      runBlocks: [{ type: "tool_call", tool_name: "x", status }],
    });
    expect(splitTurn(turnOf([mk("pending")])).calls[0].status).toBe("call");
    expect(splitTurn(turnOf([mk("running")])).calls[0].status).toBe("call");
    expect(splitTurn(turnOf([mk("failed")])).calls[0].status).toBe("fail");
  });

  it("无 text 块 → answers 为空（正文不被回退渲染）", () => {
    const onlyTool: ChatMessage = {
      id: "m2",
      sender: WORKER,
      ts: T0,
      body: "🔧 **read_file**\nChatIR.ts",
      runBlocks: [{ type: "tool_call", tool_name: "read_file", status: "running" }],
    };
    const split = splitTurn(turnOf([onlyTool]));
    expect(split.answers).toHaveLength(0);
    expect(split.calls.map((c) => c.name)).toEqual(["read_file"]);
  });

  it("无 runBlocks 时沿用现有启发式（思考前缀 / 工具帧 / 回答）", () => {
    // 走真实适配链（roomAdapter 才把工具帧识别成 toolCalls）。
    const ir = roomMessagesToIR([
      roomMsg("h1", WORKER, T0, "Thinking:\n\n先想", { msgtype: "m.notice" }),
      roomMsg("h2", WORKER, T0 + 1000, "✅ **read_file**:\nChatIR.ts"),
      roomMsg("h3", WORKER, T0 + 2000, "最终回答"),
    ] as never);
    const split = splitTurn(turnOf(ir));
    expect(split.thoughts.map((m) => m.id)).toEqual(["h1"]);
    expect(split.calls.map((c) => c.name)).toEqual(["read_file"]);
    expect(split.answers.map((m) => m.id)).toEqual(["h3"]);
    expect(split.confirmations).toHaveLength(0);
    expect(split.errors).toHaveLength(0);
  });
});

// ── ③ 渲染（宿主 shim：组件模块顶层读 window.QwenPaw.host）──────────
const E = React.createElement;

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
  runBlocks?: RunBlock[];
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

describe("结构化块渲染", () => {
  it("text 块替代 body：块文本渲染、原正文不渲染", () => {
    const html = render([
      roomMsg("b1", WORKER, T0, "审计用正文", {
        runBlocks: [{ type: "text", text: "块里的回答" }],
      }),
    ]);
    expect(html).toContain("块里的回答");
    expect(html).not.toContain("审计用正文");
  });

  it("confirmation 独立成只读卡（tool_name + 参数 + Matrix 回复提示）", () => {
    const html = render([
      roomMsg("b2", WORKER, T0, "请审批", {
        runBlocks: [
          {
            type: "confirmation",
            tool_name: "shell",
            confirmation_id: "cf-9",
            parameters: "rm -rf build",
          },
        ],
      }),
    ]);
    expect(html).toContain("shell");
    expect(html).toContain("rm -rf build");
    expect(html).toContain("待确认");
    expect(html).toContain("需在 Matrix 回复审批");
    // 无 text 块 → 原正文不渲染（只留行锚点）
    expect(html).not.toContain("请审批");
    // 审批卡不折进过程条
    expect(html).not.toContain("思考过程");
  });

  it("error 独立成状态条（kind → 文案 + title）", () => {
    const html = render([
      roomMsg("b3", WORKER, T0, "答案", {
        runBlocks: [
          { type: "text", text: "答案" },
          { type: "error", kind: "failed", title: "沙箱拒绝" },
        ],
      }),
    ]);
    expect(html).toContain("运行失败");
    expect(html).toContain("沙箱拒绝");
    // error 排回答之后（run 结束哨兵）
    expect(html.indexOf("沙箱拒绝")).toBeGreaterThan(html.indexOf("答案"));
  });

  it("thinking/tool_call 块进过程条（1 次工具调用）", () => {
    const html = render([
      roomMsg("b4", WORKER, T0, "Thinking:\n\n原正文推理", {
        runBlocks: [
          { type: "thinking", content: "块里的推理" },
          { type: "tool_call", tool_name: "read_file", status: "succeeded" },
        ],
      }),
    ]);
    expect(html).toContain("思考过程");
    expect(html).toContain("块里的推理");
    expect(html).toContain("1 次工具调用");
    expect(html).not.toContain("原正文推理");
  });

  it("无块回退现有启发式（思考前缀 + 工具帧吸收）", () => {
    const html = render([
      roomMsg("c1", WORKER, T0, "Thinking:\n\n启发式推理", { msgtype: "m.notice" }),
      roomMsg("c2", WORKER, T0 + 1000, "✅ **read_file**:\nChatIR.ts"),
      roomMsg("c3", WORKER, T0 + 2000, "启发式回答"),
    ]);
    expect(html).toContain("思考过程");
    expect(html).toContain("启发式推理");
    expect(html).toContain("1 次工具调用");
    expect(html).toContain("启发式回答");
    expect(count(html, "工人甲")).toBe(1);
  });
});
