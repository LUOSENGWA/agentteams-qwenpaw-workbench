// 思考过程折叠（chat-think-fold）：m.notice 推理帧的启发式识别、前缀剥离、
// 过程条合并渲染（🧠 思考过程 · 🔧 N 次工具调用）、原始 notice 行不出现。
//
// 契约（任务书）：
// ① isThinkingNotice：mine / 非 m.notice / thinking 前缀 / worker+长文本 /
//    短 ACL notice / 未知 sender 六种判定；
// ② stripThinkingPrefix：去前缀 + 其后空行，trim；
// ③ ProcessCollapseBar：thoughts + calls → 折叠头两段；展开区先 2 段 pre
//    再工具行；只有 thoughts 也显示折叠条；只有 calls 文案不变；
// ④ RoomChatMessageRow：absorbedThinking → 只留 data-event-id 锚点。
import { beforeAll, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  isThinkingNotice,
  stripThinkingPrefix,
  type ThinkingNoticeLike,
  type ToolCall,
} from "../src/chat/ChatIR";

const WORKER = "@worker:hs";
const HUMAN = "@human:hs";
const WORKERS: Record<string, unknown> = { [WORKER]: "worker-a" };

/** thinking 前缀帧（流式推理结束）。 */
function notice(
  body: string,
  extra: Partial<ThinkingNoticeLike> = {},
): ThinkingNoticeLike {
  return { sender: WORKER, body, msgtype: "m.notice", ...extra };
}

/** 长度可控的推理原文（无前缀）。 */
const longText = (n: number) => "推".repeat(n);

// ── ① isThinkingNotice 判定矩阵 ─────────────────────────────────────
describe("isThinkingNotice", () => {
  it("自己的消息永不吸收（哪怕带 thinking 前缀）", () => {
    expect(
      isThinkingNotice(notice("Thinking:\n\n自述", { sender: HUMAN }), true, WORKERS),
    ).toBe(false);
  });

  it("非 m.notice（m.text）不吸收", () => {
    expect(
      isThinkingNotice(notice("Thinking:\n\nx", { msgtype: "m.text" }), false, WORKERS),
    ).toBe(false);
  });

  it("Thinking: 前缀 → 吸收（不看发送者/长度）", () => {
    expect(isThinkingNotice(notice("Thinking:\n\n短"), false, WORKERS)).toBe(true);
    expect(
      isThinkingNotice(notice("Thinking:\n\n短", { sender: HUMAN }), false, WORKERS),
    ).toBe(true);
  });

  it("[thinking] 前缀 → 吸收", () => {
    expect(isThinkingNotice(notice("[thinking] 老格式"), false, WORKERS)).toBe(true);
  });

  it("worker + 长文本（≥200）→ 吸收", () => {
    expect(isThinkingNotice(notice(longText(200)), false, WORKERS)).toBe(true);
    expect(isThinkingNotice(notice(longText(199)), false, WORKERS)).toBe(false);
  });

  it("短 ACL notice → 保持原样（不吸收）", () => {
    expect(isThinkingNotice(notice("拒绝：无权发言"), false, WORKERS)).toBe(false);
  });

  it("未知 sender 的长 notice → 不吸收", () => {
    expect(
      isThinkingNotice(notice(longText(400), { sender: "@stranger:hs" }), false, WORKERS),
    ).toBe(false);
  });

  it("ChatIR 消息（msgtype 存于 type）同样可判定", () => {
    expect(
      isThinkingNotice({ sender: WORKER, body: longText(300), type: "m.notice" }, false, WORKERS),
    ).toBe(true);
  });
});

// ── ② stripThinkingPrefix ──────────────────────────────────────────
describe("stripThinkingPrefix", () => {
  it("去掉 Thinking: 与其后空行", () => {
    expect(stripThinkingPrefix("Thinking:\n\n先看代码\n再改")).toBe("先看代码\n再改");
  });

  it("去掉 [thinking] 前缀并 trim", () => {
    expect(stripThinkingPrefix("[thinking]   想一下   ")).toBe("想一下");
  });

  it("无前缀 → 仅 trim", () => {
    expect(stripThinkingPrefix("  原文 \n")).toBe("原文");
  });

  it("只有前缀 → 空串（调用方据此跳过空段）", () => {
    expect(stripThinkingPrefix("Thinking:\n\n")).toBe("");
  });
});

// ── ③④ 渲染（宿主 shim：组件模块顶层读 window.QwenPaw.host）────────
const E = React.createElement;

(globalThis as Record<string, unknown>).window = {
  QwenPaw: {
    host: {
      React,
      antd: {
        Button: (p: Record<string, unknown>) => E("button", { type: "button" }, p.children),
        message: { success: () => undefined, error: () => undefined },
      },
      antdIcons: {},
      fetch: vi.fn(async () => ({ status: 404, ok: false, text: async () => "" })),
      useLocale: () => "zh",
      useTheme: () => "light",
    },
  },
};
(globalThis as Record<string, unknown>).document = { hidden: false };

const tr = (s: string, v?: Record<string, string | number>): string => {
  let out = s;
  for (const [k, val] of Object.entries(v ?? {})) {
    out = out.split(`{${k}}`).join(String(val));
  }
  return out;
};

type BarMod = {
  ProcessCollapseBar: (props: {
    calls: ToolCall[];
    thoughts?: string[];
  }) => React.ReactElement;
};
type RowMod = {
  default: (props: Record<string, unknown>) => React.ReactElement;
};

let Bar: BarMod["ProcessCollapseBar"];
let MessageRow: RowMod["default"];

beforeAll(async () => {
  const barMod = (await import("../src/chat/ProcessCollapseBar")) as unknown as BarMod;
  const rowMod = (await import("../src/components/RoomChatMessageRow")) as unknown as RowMod;
  Bar = barMod.ProcessCollapseBar;
  MessageRow = rowMod.default;
});

const CALL: ToolCall = {
  id: "$call1",
  name: "read_file",
  argsSummary: "ChatIR.ts",
  status: "ok",
  ts: 1000,
};

const THOUGHTS = ["先看后端怎么发 reasoning", "再决定前端折叠口径"];

/** 折叠条正文里的 pre 段数（思考段各一个；工具行折叠时不渲染 pre）。 */
function preCount(html: string): number {
  return (html.match(/<pre/g) ?? []).length;
}

describe("ProcessCollapseBar 思考过程合并", () => {
  it("思考 + 工具：折叠头两段齐全，展开区 2 段 pre + 1 行工具", () => {
    const html = renderToStaticMarkup(E(Bar, { calls: [CALL], thoughts: THOUGHTS }));
    expect(html).toContain("思考过程");
    expect(html).toContain("1 次工具调用");
    expect(html).toContain("·");
    expect(preCount(html)).toBe(2);
    expect(html).toContain("read_file");
    // 先思考段、再工具行（顺序契约）。
    expect(html.indexOf(THOUGHTS[0])).toBeLessThan(html.indexOf("read_file"));
    expect(html.indexOf(THOUGHTS[1])).toBeLessThan(html.indexOf("read_file"));
    // 中性样式：非斜体、限高可滚。
    expect(html).toContain("font-style:normal");
    expect(html).toContain("max-height:240px");
    expect(html).toContain("white-space:pre-wrap");
  });

  it("只有思考：仍显示折叠条，且不出现工具文案", () => {
    const html = renderToStaticMarkup(E(Bar, { calls: [], thoughts: THOUGHTS }));
    expect(html).toContain("🧠");
    expect(html).toContain("思考过程");
    expect(html).not.toContain("次工具调用");
    expect(preCount(html)).toBe(2);
  });

  it("只有工具：文案沿用旧口径，不出现思考段", () => {
    const html = renderToStaticMarkup(E(Bar, { calls: [CALL] }));
    expect(html).not.toContain("思考过程");
    expect(html).toContain("1 次工具调用");
    expect(preCount(html)).toBe(0);
  });
});

describe("RoomChatMessageRow 吸收思考 notice", () => {
  const baseProps = {
    msg: {
      event_id: "$notice1",
      sender: WORKER,
      msgtype: "m.notice",
      body: longText(300),
      origin_server_ts: 1000,
    },
    idx: 0,
    topsLen: 1,
    sep: false,
    sameSender: false,
    unreadLine: false,
    absorbedTool: false,
    absorbedThinking: true,
    mine: false,
    hovered: false,
    showTime: false,
    replies: [],
    activeThread: null,
    room: {},
    myUserId: HUMAN,
    t: { textSecondary: "#666", border: "#ddd", bubbleOther: "#f5f5f5", cardBg: "#fff" },
    tr,
    visibleMessages: [],
    liveByRunId: new Map(),
    teamName: null,
    resolvedApprovals: {},
    setHoveredId: () => undefined,
    hoverTimerRef: { current: null },
    insertMention: () => undefined,
    openDetailMxid: () => undefined,
    jumpWithEnsure: async () => undefined,
    handleApprovalAction: () => undefined,
    handleDeliverable: () => undefined,
    setReplyTo: () => undefined,
    setEditing: () => undefined,
    setDraft: () => undefined,
    composerRef: { current: null },
    setActiveThread: () => undefined,
  };

  it("命中 → 只留事件锚点，原始 notice 正文不出现", () => {
    const html = renderToStaticMarkup(E(MessageRow, baseProps));
    expect(html).toContain('data-event-id="$notice1"');
    expect(html).not.toContain(longText(300));
    expect(html).not.toContain("italic");
  });
});
