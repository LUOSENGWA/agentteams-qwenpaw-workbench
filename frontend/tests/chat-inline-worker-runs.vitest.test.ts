// 插件聊天 UI 重构（Dashboard 强项移植 + worker-run 内联折叠）纯逻辑验收：
// ① groupThreads：m.thread（threadRoot）分组 + 优先于 reply + ghost 降级；
// ② inlineWorkerRuns：纯 worker 线程 = 一次运行（内联 + 按修订键整块落位，
//    编辑根移到 editedAt 槽位），人类/混合线程原样保留（§4.2）；
// ③ isWorkerPlaceholder：worker「处理中...」占位行识别（§4.3）；
// ④ mapTurnRanges：turn → tops 下标映射，允许非连续 / 缺 id 跳过（§4.3）；
// ⑤ roomMessagesToIR：ts = editedAt ?? origin_server_ts（Dashboard
//    revision collapse：最终编辑根按修订时间排）。
import { describe, expect, it } from "vitest";
import { groupThreads, inlineWorkerRuns } from "../src/threadWindow";
import { buildTurns, mapTurnRanges } from "../src/chat/ChatIR";
import { roomMessagesToIR } from "../src/chat/roomAdapter";
import {
  AGENT_PLACEHOLDER_RE,
  isWorkerPlaceholder,
} from "../src/components/RoomChatShared";
import type { RoomMessage } from "../src/api";

const W1 = "@worker-a:hs";
const W2 = "@worker-b:hs";
const H1 = "@human:hs";
/** worker 判定表（四集合并的子集形态：Record）。 */
const WORKERS: Record<string, unknown> = { [W1]: "a", [W2]: "b" };
const isWorker = (mxid: string): boolean => mxid in WORKERS;

let seq = 0;
function msg(
  sender: string,
  ts: number,
  opts: {
    replyTo?: string;
    threadRoot?: string;
    editedAt?: number;
    body?: string;
    msgtype?: string;
  } = {},
): RoomMessage {
  seq += 1;
  return {
    event_id: `e${seq}`,
    sender,
    body: opts.body ?? `body${seq}`,
    msgtype: opts.msgtype ?? "m.text",
    origin_server_ts: ts,
    ...(opts.replyTo ? { reply: { event_id: opts.replyTo } } : {}),
    ...(opts.threadRoot
      ? { threadRoot: opts.threadRoot, isThreadReply: true }
      : {}),
    ...(opts.editedAt
      ? {
          edited: true,
          editedAt: opts.editedAt,
          latestEventId: `edit${seq}`,
        }
      : {}),
  };
}

// ── ① groupThreads：m.thread 分组 ─────────────────────────────────
describe("groupThreads threadRoot 分组", () => {
  it("m.thread 回复按 threadRoot 归线程", () => {
    const root = msg(W1, 100);
    const r1 = msg(W1, 150, { threadRoot: root.event_id });
    const r2 = msg(W1, 200, { threadRoot: root.event_id });
    const g = groupThreads([root, r1, r2]);
    expect(g.tops.map((m) => m.event_id)).toEqual([root.event_id]);
    expect(g.repliesOf.get(root.event_id)?.map((m) => m.event_id)).toEqual([
      r1.event_id,
      r2.event_id,
    ]);
  });

  it("threadRoot 与 reply 同现 → 按 threadRoot 分组（不混入引用）", () => {
    const root = msg(W1, 100);
    const ref = msg(H1, 120);
    const r = msg(H1, 150, { threadRoot: root.event_id, replyTo: ref.event_id });
    const g = groupThreads([root, ref, r]);
    expect(g.tops.map((m) => m.event_id)).toEqual([
      root.event_id,
      ref.event_id,
    ]);
    expect(g.repliesOf.get(root.event_id)?.map((m) => m.event_id)).toEqual([
      r.event_id,
    ]);
    expect(g.repliesOf.has(ref.event_id)).toBe(false);
  });

  it("threadRoot 指向未加载的根 → 降级顶层（ghost）", () => {
    const r = msg(W1, 150, { threadRoot: "ghost" });
    const g = groupThreads([r]);
    expect(g.tops.map((m) => m.event_id)).toEqual([r.event_id]);
    expect(g.repliesOf.size).toBe(0);
  });
});

// ── ② inlineWorkerRuns：worker-run 内联折叠 ───────────────────────
describe("inlineWorkerRuns 内联规则", () => {
  it("纯 worker 线程 = 一次运行：root+回复内联、块内按修订键排序、repliesOf 删键", () => {
    const root = msg(W1, 100);
    const r1 = msg(W2, 300, { threadRoot: root.event_id });
    const r2 = msg(W1, 200, { threadRoot: root.event_id });
    const h = msg(H1, 250);
    const g = groupThreads([root, h, r1, r2]);
    // 注：groupThreads 的 tops 保持输入序（root, h）——真实管线 tops 已
    // 按 ts 有序；此处按管线口径预排 tops 后再内联。
    const tops = [root, h].sort(
      (a, b) => a.origin_server_ts - b.origin_server_ts,
    );
    const w = inlineWorkerRuns(tops, g.repliesOf, isWorker);
    // 块=原子单元：锚定键=root 发送时间 100，块内按修订键排
    // （root 100 → r2 200 → r1 300）；整块落在 100 槽位，h(250) 其后。
    expect(w.tops.map((m) => m.event_id)).toEqual([
      root.event_id,
      r2.event_id, // 200
      r1.event_id, // 300
      h.event_id, // 250——「一次运行」整块连续呈现，不与块外消息交错
    ]);
    expect(w.repliesOf.has(root.event_id)).toBe(false);
  });

  it("人类线程原样保留（root 顶层 + 回复在 repliesOf）", () => {
    const root = msg(H1, 100);
    const r = msg(H1, 200, { threadRoot: root.event_id });
    const g = groupThreads([root, r]);
    const w = inlineWorkerRuns(g.tops, g.repliesOf, isWorker);
    expect(w.tops.map((m) => m.event_id)).toEqual([root.event_id]);
    expect(w.repliesOf.get(root.event_id)?.map((m) => m.event_id)).toEqual([
      r.event_id,
    ]);
  });

  it("混合线程（worker 根 + 人类回复）→ 整条按人类话题，不内联", () => {
    const root = msg(W1, 100);
    const rw = msg(W1, 150, { threadRoot: root.event_id });
    const rh = msg(H1, 200, { threadRoot: root.event_id });
    const g = groupThreads([root, rw, rh]);
    const w = inlineWorkerRuns(g.tops, g.repliesOf, isWorker);
    expect(w.tops.map((m) => m.event_id)).toEqual([root.event_id]);
    expect(w.repliesOf.get(root.event_id)).toHaveLength(2);
  });

  it("人类根 + worker 回复 → 不内联（根不是 worker）", () => {
    const root = msg(H1, 100);
    const rw = msg(W1, 150, { threadRoot: root.event_id });
    const g = groupThreads([root, rw]);
    const w = inlineWorkerRuns(g.tops, g.repliesOf, isWorker);
    expect(w.tops.map((m) => m.event_id)).toEqual([root.event_id]);
    expect(w.repliesOf.get(root.event_id)).toHaveLength(1);
  });

  it("编辑过的纯 worker run 整块移到 editedAt 槽位（非编辑 tops 原位不动）", () => {
    const root = msg(W1, 100, { editedAt: 500 });
    const r = msg(W1, 150, { threadRoot: root.event_id });
    const h1 = msg(H1, 200);
    const h2 = msg(H1, 400);
    const h3 = msg(H1, 600);
    const g = groupThreads([root, r, h1, h2, h3]);
    const w = inlineWorkerRuns(g.tops, g.repliesOf, isWorker);
    // 块键 = 500（root 修订时间）→ 落 h2(400) 与 h3(600) 之间；
    // 块内按修订键排：r(150) 先于 root(500)。
    expect(w.tops.map((m) => m.event_id)).toEqual([
      h1.event_id,
      h2.event_id,
      r.event_id,
      root.event_id,
      h3.event_id,
    ]);
    expect(w.repliesOf.has(root.event_id)).toBe(false);
  });

  it("未编辑的 run 块原位不动（键=发送时间，稳定排序不挪位）", () => {
    const a = msg(H1, 50);
    const root = msg(W1, 100);
    const r = msg(W1, 120, { threadRoot: root.event_id });
    const b = msg(H1, 200);
    const g = groupThreads([a, root, b, r]);
    const w = inlineWorkerRuns(g.tops, g.repliesOf, isWorker);
    expect(w.tops.map((m) => m.event_id)).toEqual([
      a.event_id,
      root.event_id,
      r.event_id,
      b.event_id,
    ]);
  });

  it("无回复的 worker 根不内联（不是「一次运行」，保持顶层行）", () => {
    const root = msg(W1, 100);
    const h = msg(H1, 200);
    const g = groupThreads([root, h]);
    const w = inlineWorkerRuns(g.tops, g.repliesOf, isWorker);
    expect(w.tops.map((m) => m.event_id)).toEqual([
      root.event_id,
      h.event_id,
    ]);
  });

  it("纯函数：入参 tops/repliesOf 不被修改", () => {
    const root = msg(W1, 100);
    const r = msg(W1, 150, { threadRoot: root.event_id });
    const g = groupThreads([root, r]);
    const topsSnap = [...g.tops];
    const repliesSnap = [...(g.repliesOf.get(root.event_id) || [])];
    inlineWorkerRuns(g.tops, g.repliesOf, isWorker);
    expect(g.tops).toEqual(topsSnap);
    expect(g.repliesOf.get(root.event_id)).toEqual(repliesSnap);
  });
});

// ── ③ isWorkerPlaceholder：占位行识别（§4.3）──────────────────────
describe("isWorkerPlaceholder 占位识别", () => {
  it.each(["处理中...", "处理中。", "处理中……", "  处理中  "])(
    "worker + %s → 占位行",
    (body) => {
      expect(isWorkerPlaceholder(msg(W1, 100, { body }), WORKERS)).toBe(true);
    },
  );

  it("正文含占位前后缀（处理中现在开工）→ 不是占位", () => {
    expect(isWorkerPlaceholder(msg(W1, 100, { body: "处理中现在开工" }), WORKERS)).toBe(
      false,
    );
    expect(AGENT_PLACEHOLDER_RE.test("开始处理中...任务")).toBe(false);
  });

  it("人类发送 / 非 worker 表内 → 不吸收", () => {
    expect(isWorkerPlaceholder(msg(H1, 100, { body: "处理中..." }), WORKERS)).toBe(
      false,
    );
    expect(isWorkerPlaceholder(msg("@nobody:hs", 100, { body: "处理中..." }), WORKERS)).toBe(
      false,
    );
  });

  it("空正文 → 不是占位", () => {
    expect(isWorkerPlaceholder(msg(W1, 100, { body: "" }), WORKERS)).toBe(false);
  });
});

// ── ④ mapTurnRanges：turn → tops 下标（允许非连续）────────────────
describe("mapTurnRanges 索引映射", () => {
  it("连续 turn → 连续下标", () => {
    const tops = [msg(W1, 100), msg(W1, 200), msg(W1, 300), msg(H1, 400)];
    const ir = roomMessagesToIR(tops);
    const ranges = mapTurnRanges(buildTurns(ir), tops);
    expect(ranges[0].indices).toEqual([0, 1, 2]);
    expect(ranges[1].indices).toEqual([3]);
  });

  it("非连续（turn 消息在 tops 中夹了其它消息）→ 按下标逐个映射", () => {
    // turn 消息 = m1/m2/m3；tops 在 m1 与 m2 之间插了 mX（内联/抑制留洞）。
    const m1 = msg(W1, 100);
    const m2 = msg(W1, 200);
    const m3 = msg(W1, 300);
    const mX = msg(H1, 150);
    const mY = msg(H1, 400);
    const tops = [m1, mX, m2, m3, mY];
    const turns = buildTurns(roomMessagesToIR([m1, m2, m3]));
    expect(turns).toHaveLength(1);
    const ranges = mapTurnRanges(turns, tops);
    expect(ranges[0].indices).toEqual([0, 2, 3]);
  });

  it("turn 消息 id 不在 tops（防御）→ 跳过，不产生 -1/undefined", () => {
    const m1 = msg(W1, 100);
    const m2 = msg(W1, 200);
    const tops = [m1];
    const turns = buildTurns(roomMessagesToIR([m1, m2]));
    const ranges = mapTurnRanges(turns, tops);
    expect(ranges[0].indices).toEqual([0]);
  });
});

// ── ⑤ roomMessagesToIR：ts = editedAt ?? origin_server_ts ─────────
describe("roomMessagesToIR 修订时间口径", () => {
  it("已编辑 → ts=editedAt；未编辑 → ts=origin_server_ts", () => {
    const edited = msg(W1, 100, { editedAt: 900 });
    const plain = msg(H1, 200);
    const ir = roomMessagesToIR([edited, plain]);
    expect(ir[0].ts).toBe(900);
    expect(ir[1].ts).toBe(200);
  });
});
