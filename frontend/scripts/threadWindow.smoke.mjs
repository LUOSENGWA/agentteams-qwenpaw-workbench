// threadWindow 纯逻辑冒烟（node 直跑，跑法照 requestCache.smoke.mjs——
// esbuild buildSync 到临时目录 + import）。覆盖：
// 分组正确性（回复归线程 / target 缺失降级顶层）+ 窗口封顶三态
// （不超限 / 超限藏起+孤儿回复置顶 / pendingOriginal 旁路）
// + 揭示步进（reveal 后隐藏数递减、消息序连续）。
// 用法：node scripts/threadWindow.smoke.mjs
import { buildSync } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert";

const tmp = mkdtempSync(path.join(tmpdir(), "tw-smoke-"));
buildSync({
  entryPoints: ["src/threadWindow.ts"],
  bundle: true,
  format: "esm",
  outfile: path.join(tmp, "threadWindow.mjs"),
  platform: "node",
});
const { groupThreads, applyWindow, inlineWorkerRuns } = await import(
  path.join(tmp, "threadWindow.mjs")
);

const M = (id, replyTo) => ({
  event_id: id,
  reply: replyTo ? { event_id: replyTo } : undefined,
});

// 线程消息（m.thread 口径：threadRoot 指向根）+ worker-run 内联断言用。
const T = (id, sender, ts, extra = {}) => ({
  event_id: id,
  sender,
  origin_server_ts: ts,
  ...extra,
});
const W = "@w:hs";
const W2 = "@w2:hs";
const H = "@h:hs";
const isWorker = (mxid) => mxid === W || mxid === W2;

// 1. 分组：reply 归线程，target 缺失降级顶层。
{
  const g = groupThreads([M("a"), M("r1", "a"), M("r2", "a"), M("b")]);
  assert.deepStrictEqual(
    g.tops.map((m) => m.event_id),
    ["a", "b"],
    "T1 顶层=目标存在的消息",
  );
  assert.strictEqual(g.repliesOf.get("a").length, 2, "T1 回复归入 a");
}
{
  const g = groupThreads([M("x"), M("r", "ghost")]);
  assert.deepStrictEqual(
    g.tops.map((m) => m.event_id),
    ["x", "r"],
    "T2 target 缺失 → 降级顶层",
  );
}

// 2. 窗口不超限：原样返回（hiddenCount=0，tops 引用不变）。
{
  const g = groupThreads([M("a"), M("b"), M("c")]);
  const w = applyWindow(g.tops, g.repliesOf, 5, null);
  assert.strictEqual(w.hiddenCount, 0, "T3 不超限无藏起");
  assert.strictEqual(w.tops, g.tops, "T3 不超限 tops 原引用");
}

// 3. 超限：藏起数=总数-窗口；渲染窗=最近 windowLimit 条；
//    被藏起顶层的回复降级置顶且 repliesOf 对应键删除。
{
  // tops: a,b,c,d（c 有 2 条回复 r1/r2）；窗口 2 → 藏 a,b，渲染 c,d
  const msgs = [M("a"), M("b"), M("c"), M("r1", "c"), M("r2", "c"), M("d")];
  const g = groupThreads(msgs);
  assert.strictEqual(g.tops.length, 4, "T4 分组前提 tops=4");
  const w = applyWindow(g.tops, g.repliesOf, 2, null);
  assert.strictEqual(w.hiddenCount, 2, "T4 藏起 2 条");
  // 孤儿 r1/r2（target c 仍在窗内→不该孤儿！c 在渲染窗里）
  // 重排：让被藏起者带回复。改窗口=3 → 藏 a（无回复），渲染 b,c,d
  const g2 = groupThreads(msgs);
  const w2 = applyWindow(g2.tops, g2.repliesOf, 3, null);
  assert.strictEqual(w2.hiddenCount, 1, "T5 窗口3 藏 1");
  assert.deepStrictEqual(
    w2.tops.map((m) => m.event_id),
    ["b", "c", "d"],
    "T5 渲染窗=最近 3",
  );
  assert.strictEqual(w2.repliesOf.get("c").length, 2, "T5 窗内回复保留");

  // 被藏起顶层带回复的场景：tops=a(有回复 ra),b,c,d 窗口 2 → 藏 a,b
  const msgs2 = [M("a"), M("ra", "a"), M("b"), M("c"), M("d")];
  const g3 = groupThreads(msgs2);
  const w3 = applyWindow(g3.tops, g3.repliesOf, 2, null);
  assert.strictEqual(w3.hiddenCount, 2, "T6 藏 2");
  assert.deepStrictEqual(
    w3.tops.map((m) => m.event_id),
    ["ra", "c", "d"],
    "T6 孤儿 ra 置顶 + 渲染窗",
  );
  assert.strictEqual(w3.repliesOf.has("a"), false, "T6 被藏 a 的线程键删除");
  assert.strictEqual(w3.repliesOf.has("ra"), false, "T6 ra 自身无线程");
}

// 4. pendingOriginal 旁路：不封顶（定位需目标必在 DOM）。
{
  const msgs = [M("a"), M("b"), M("c"), M("d")];
  const g = groupThreads(msgs);
  const w = applyWindow(g.tops, g.repliesOf, 2, "a");
  assert.strictEqual(w.hiddenCount, 0, "T7 pendingOriginal 旁路");
  assert.strictEqual(w.tops.length, 4, "T7 全量在 DOM");
}

// 5. 揭示步进：reveal 两步放完全部，全程消息序连续、无重复。
{
  const msgs = [];
  for (let i = 0; i < 10; i++) msgs.push(M(`m${i}`));
  const limit = 4;
  let shown = new Set();
  const order = [];
  for (const step of [limit, limit * 2, limit * 3]) {
    const g = groupThreads(msgs);
    const w = applyWindow(g.tops, g.repliesOf, step, null);
    const seenInStep = new Set();
    for (const m of w.tops) {
      assert.ok(!seenInStep.has(m.event_id), `T8 单步无重复 ${m.event_id}`);
      seenInStep.add(m.event_id);
    }
    for (const id of seenInStep) shown.add(id);
    order.push(w.hiddenCount);
  }
  assert.deepStrictEqual(order, [6, 2, 0], "T8 揭示递减到 0");
  assert.strictEqual(shown.size, 10, "T8 三步放完全部");
  // 序连续：最终 tops = 全量原序
  const gF = groupThreads(msgs);
  const wF = applyWindow(gF.tops, gF.repliesOf, limit * 3, null);
  assert.deepStrictEqual(
    wF.tops.map((m) => m.event_id),
    msgs.map((m) => m.event_id),
    "T8 终态=原序全量",
  );
}

// 6. 空窗边界：空列表 / 恰好等窗 / 回复全部在窗内无孤儿。
{
  const g = groupThreads([]);
  const w = applyWindow(g.tops, g.repliesOf, 5, null);
  assert.strictEqual(w.tops.length, 0, "T9 空列表安全");

  const g2 = groupThreads([M("a"), M("b")]);
  const w2 = applyWindow(g2.tops, g2.repliesOf, 2, null);
  assert.strictEqual(w2.hiddenCount, 0, "T9 恰好等窗不藏");
}

// 7. worker-run 内联（§4.2）：纯 worker 线程 = 一次运行——root+回复
// 逐条内联进 tops（每条按自身修订键落位，Dashboard 连续 turn 语义）、
// repliesOf 删键；人类/混合线程原样。
{
  const root = T("root", W, 100);
  const r1 = T("r1", W2, 300, { threadRoot: "root" });
  const r2 = T("r2", W, 200, { threadRoot: "root" });
  const h = T("h", H, 250);
  const g = groupThreads([root, h, r1, r2]);
  assert.deepStrictEqual(
    g.tops.map((m) => m.event_id),
    ["root", "h"],
    "T10 分组前提：threadRoot 归线程",
  );
  const w = inlineWorkerRuns(g.tops, g.repliesOf, isWorker);
  // 逐条落位：root(100) < r2(200) < h(250) < r1(300)——run 中途的
  // 人类消息原位保留（不再被整块锚定压在 run 之后）。
  assert.deepStrictEqual(
    w.tops.map((m) => m.event_id),
    ["root", "r2", "h", "r1"],
    "T10 纯 worker run 逐条内联（按各自修订键时间序）",
  );
  assert.strictEqual(w.repliesOf.has("root"), false, "T10 repliesOf 删键");

  // 混合线程（worker 根 + 人类回复）→ 不内联。
  const mroot = T("mroot", W, 100);
  const mrw = T("mrw", W, 150, { threadRoot: "mroot" });
  const mrh = T("mrh", H, 200, { threadRoot: "mroot" });
  const gm = groupThreads([mroot, mrw, mrh]);
  const wm = inlineWorkerRuns(gm.tops, gm.repliesOf, isWorker);
  assert.deepStrictEqual(
    wm.tops.map((m) => m.event_id),
    ["mroot"],
    "T11 混合线程不内联（root 顶层）",
  );
  assert.strictEqual(wm.repliesOf.get("mroot").length, 2, "T11 回复保留线程");

  // 人类根 + worker 回复 → 不内联（根不是 worker）。
  const hroot = T("hroot", H, 100);
  const hrw = T("hrw", W, 150, { threadRoot: "hroot" });
  const gh = groupThreads([hroot, hrw]);
  const wh = inlineWorkerRuns(gh.tops, gh.repliesOf, isWorker);
  assert.deepStrictEqual(
    wh.tops.map((m) => m.event_id),
    ["hroot"],
    "T11 人类根+worker 回复不内联",
  );
}

// 8. 编辑根移到 editedAt 槽位（§4.3/Dashboard revision collapse）：
// 过程消息按自身发送时间原位，最终编辑的根单独后移到修订时刻。
{
  const root = T("root", W, 100, { editedAt: 500 });
  const r = T("r", W, 150, { threadRoot: "root" });
  const h1 = T("h1", H, 200);
  const h2 = T("h2", H, 400);
  const h3 = T("h3", H, 600);
  const g = groupThreads([root, r, h1, h2, h3]);
  const w = inlineWorkerRuns(g.tops, g.repliesOf, isWorker);
  // 逐条键：r(150) < h1(200) < h2(400) < root(editedAt 500) < h3(600)。
  assert.deepStrictEqual(
    w.tops.map((m) => m.event_id),
    ["r", "h1", "h2", "root", "h3"],
    "T12 编辑根移到修订时刻（过程消息原位）",
  );
  assert.strictEqual(w.repliesOf.has("root"), false, "T12 repliesOf 删键");
}

// 9. 纯函数性：内联不修改入参。
{
  const root = T("root", W, 100);
  const r = T("r", W, 150, { threadRoot: "root" });
  const g = groupThreads([root, r]);
  const topsSnap = [...g.tops];
  const repliesSnap = [...(g.repliesOf.get("root") || [])];
  inlineWorkerRuns(g.tops, g.repliesOf, isWorker);
  assert.deepStrictEqual(g.tops, topsSnap, "T13 tops 入参未变");
  assert.deepStrictEqual(g.repliesOf.get("root"), repliesSnap, "T13 repliesOf 入参未变");
}

console.log("threadWindow smoke: 12 断言组全过");
