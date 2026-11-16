// 话题面板（ThreadPanelView）UI parity（§4.4 审计修复 3）：
// 面板正文复用主列表 turn 管线（roomMessagesToIR → buildTurns →
// splitTurn），不再自造第二套解析/分组：
// ① 已完成的 worker run：字面「处理中...」不再出现；思考/工具调用
//    进 ProcessCollapseBar（思考过程 + N 次工具调用），最终编辑过的
//    根按 editedAt 落位并渲染最终正文；裸 `Thinking:` 前缀不出现
//    （stripThinkingPrefix 去前缀）；每 turn 只有一个 header/头像。
// ② 进行中的 run：worker 占位根（尚无最终编辑）渲染紧凑「运行过程」
//    状态行，不渲染字面「处理中...」。
// ③ 人类根 / 混合根：按普通消息渲染（正文 + 头像 + 时间），
//    无过程条；根行保留「跳转到原消息」可点语义。
// SSR（renderToStaticMarkup）+ 宿主 shim（组件模块顶层读
// window.QwenPaw.host）——与 chat-run-blocks 渲染用例同模式。
import { beforeAll, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { RoomMessage } from "../src/api";

const WORKER = "@worker:hs";
const HUMAN = "@human:hs";
const T0 = new Date(2026, 10, 7, 10, 0, 0).getTime();

// ── 宿主 shim（必须在动态 import 组件模块之前生效）────────────────
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
  // 面板 composer 用 antd.Input.TextArea——必须挂子组件。
  Input: Object.assign(Stub("input"), { TextArea: Stub("textarea") }),
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

type PanelMod = {
  ThreadPanelView: (props: Record<string, unknown>) => React.ReactElement;
};
type PendingMod = {
  PendingProvider: (props: { children: React.ReactNode }) => React.ReactElement;
};
let ThreadPanelView: PanelMod["ThreadPanelView"];
let PendingProvider: PendingMod["PendingProvider"];

beforeAll(async () => {
  const mod = (await import("../src/components/RoomChatThread")) as unknown as PanelMod;
  ThreadPanelView = mod.ThreadPanelView;
  const pending = (await import("../src/pending/store")) as unknown as PendingMod;
  PendingProvider = pending.PendingProvider;
});

// ── 夹具 ──────────────────────────────────────────────────────────
interface RoomMsgLike {
  event_id: string;
  sender: string;
  origin_server_ts: number;
  body: string;
  msgtype: string;
  edited?: boolean;
  editedAt?: number;
  threadRoot?: string;
  isThreadReply?: boolean;
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

const ROOM = {
  room_id: "!r:hs",
  name: "团队房",
  members: {
    [WORKER]: { user_id: WORKER, display_name: "工人甲" },
    [HUMAN]: { user_id: HUMAN, display_name: "小明" },
  },
};

/** SSR 渲染线程面板（root + replies，宽/窄屏共用同一组件）。 */
function renderPanel(root: RoomMsgLike, replies: RoomMsgLike[]): string {
  const el = E(
    ThreadPanelView,
    {
      root: root as RoomMessage,
      replies: replies as RoomMessage[],
      room: ROOM,
      myUserId: HUMAN,
      onSendThread: async () => undefined,
      onClose: () => undefined,
      onJump: () => undefined,
      workerMxids: { [WORKER]: "工人甲" },
      memberWorkerNames: { [WORKER]: "工人甲" },
      openDetailMxid: () => undefined,
    } as Record<string, unknown>,
  );
  return renderToStaticMarkup(E(PendingProvider, null, el));
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

// ── ① 已完成的 worker run ─────────────────────────────────────────
describe("已完成 worker run（编辑过的根 + 思考 + 工具调用）", () => {
  const root = roomMsg("root", WORKER, T0 + 1000, "最终回答：重构完成", {
    edited: true,
    editedAt: T0 + 5000,
  });
  const replies = [
    roomMsg("r1", WORKER, T0 + 2000, "Thinking:\n\n先看现有结构", {
      msgtype: "m.notice",
      threadRoot: "root",
      isThreadReply: true,
    }),
    roomMsg("r2", WORKER, T0 + 3000, "✅ **read_file**:\nchat.ts", {
      threadRoot: "root",
      isThreadReply: true,
    }),
  ];

  it("字面「处理中...」不出现；最终正文按 editedAt 落位渲染", () => {
    const html = renderPanel(root, replies);
    expect(html).not.toContain("处理中");
    expect(html).toContain("最终回答：重构完成");
    // 编辑时间（T0+5000）晚于过程帧 → 最终正文排在过程条之后。
    expect(html.indexOf("1 次工具调用")).toBeLessThan(
      html.indexOf("最终回答：重构完成"),
    );
  });

  it("思考/工具调用进过程折叠条（思考过程 + N 次工具调用），无裸 Thinking: 前缀", () => {
    const html = renderPanel(root, replies);
    expect(html).toContain("思考过程");
    expect(html).toContain("1 次工具调用");
    // 思考行（默认折叠子项）存在；思考原文在行内展开态才入 DOM。
    expect(html).toContain("思考</span>");
    expect(html).not.toContain("Thinking:");
  });

  it("每 turn 一个 header/头像（续行不重复）", () => {
    const html = renderPanel(root, replies);
    expect(count(html, "工人甲")).toBe(1);
  });

  it("根行保留「跳转到原消息」语义（onJump 已接）", () => {
    const html = renderPanel(root, replies);
    expect(html).toContain("跳转到原消息");
  });
});

// ── ② 进行中的 run（占位根尚无最终编辑）───────────────────────────
describe("进行中 run（worker 占位根 + 思考帧）", () => {
  const root = roomMsg("root", WORKER, T0, "处理中...", { msgtype: "m.notice" });
  const replies = [
    roomMsg("r1", WORKER, T0 + 1000, "Thinking:\n\n还在分析现有代码结构", {
      msgtype: "m.notice",
      threadRoot: "root",
      isThreadReply: true,
    }),
  ];

  it("不渲染字面「处理中...」，改紧凑「运行过程」状态行", () => {
    const html = renderPanel(root, replies);
    expect(html).not.toContain("处理中");
    expect(html).toContain("运行过程");
  });

  it("思考帧仍进过程条（思考过程），无裸 Thinking:", () => {
    const html = renderPanel(root, replies);
    expect(html).toContain("思考过程");
    expect(html).not.toContain("Thinking:");
  });
});

// ── ③ 人类根 / 混合根 ─────────────────────────────────────────────
describe("人类根 + 人类回复", () => {
  const root = roomMsg("root", HUMAN, T0, "这个任务在做什么？");
  const replies = [
    roomMsg("r1", HUMAN, T0 + 1000, "我看一下，稍等", {
      threadRoot: "root",
      isThreadReply: true,
    }),
  ];

  it("正文照渲 + 每 turn 一个 header，无过程条", () => {
    const html = renderPanel(root, replies);
    expect(html).toContain("这个任务在做什么？");
    expect(html).toContain("我看一下，稍等");
    expect(html).not.toContain("思考过程");
    expect(count(html, "小明")).toBe(1);
  });
});

describe("混合根（worker 根最终正文 + 人类回复）", () => {
  const root = roomMsg("root", WORKER, T0, "已完成，请查收", {
    edited: true,
    editedAt: T0 + 5000,
  });
  const replies = [
    roomMsg("r1", HUMAN, T0 + 2000, "收到", {
      threadRoot: "root",
      isThreadReply: true,
    }),
  ];

  it("两类消息都正常渲染，无「处理中...」", () => {
    const html = renderPanel(root, replies);
    expect(html).toContain("已完成，请查收");
    expect(html).toContain("收到");
    expect(html).not.toContain("处理中");
    expect(count(html, "工人甲")).toBe(1);
    expect(count(html, "小明")).toBe(1);
  });
});
