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
const { groupThreads, applyWindow } = await import(
  path.join(tmp, "threadWindow.mjs")
);

const M = (id, replyTo) => ({
  event_id: id,
  reply: replyTo ? { event_id: replyTo } : undefined,
});

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

console.log("threadWindow smoke: 9 断言组全过");
