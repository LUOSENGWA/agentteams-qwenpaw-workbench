// jumpContextWindow 纯逻辑冒烟（node 直跑，跑法照 threadWindow.smoke.mjs——
// esbuild buildSync 到临时目录 + import）。覆盖：默认切片=目标 ±2（两端
// clamp 不越界）、目标缺失 → 前 2*pad+1 有界、展开态=全量（原引用）、
// 短列表（≤2*pad+1）不折叠、hiddenCount 与可见数恒自洽、custom pad。
// 用法：node scripts/jumpContextWindow.smoke.mjs
import { buildSync } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert";

const tmp = mkdtempSync(path.join(tmpdir(), "jcw-smoke-"));
buildSync({
  entryPoints: ["src/jumpContextWindow.ts"],
  bundle: true,
  format: "esm",
  outfile: path.join(tmp, "jumpContextWindow.mjs"),
  platform: "node",
});
const { applyContextWindow } = await import(
  path.join(tmp, "jumpContextWindow.mjs")
);

const M = (id) => ({ event_id: id });
const ids = (w) => w.events.map((m) => m.event_id);

// 1. 默认切片 = 目标 ±2（共 5 条），hiddenCount = 总数 - 可见数。
{
  const ev = [M("a"), M("b"), M("c"), M("d"), M("e"), M("f"), M("g"), M("h")];
  const w = applyContextWindow(ev, "e", false);
  assert.deepStrictEqual(ids(w), ["c", "d", "e", "f", "g"], "T1 目标 ±2");
  assert.strictEqual(w.hiddenCount, 3, "T1 hiddenCount=8-5");
}

// 2. 边界 clamp：目标在头/尾时窗不越界、不缺位。
{
  const ev = [M("a"), M("b"), M("c"), M("d"), M("e"), M("f"), M("g")];
  const w = applyContextWindow(ev, "a", false);
  assert.deepStrictEqual(ids(w), ["a", "b", "c"], "T2 头部 clamp");
  assert.strictEqual(w.hiddenCount, 4, "T2 头部 hidden=7-3");
  const w2 = applyContextWindow(ev, "g", false);
  assert.deepStrictEqual(ids(w2), ["e", "f", "g"], "T2 尾部 clamp");
  assert.strictEqual(w2.hiddenCount, 4, "T2 尾部 hidden=4");
}

// 3. 展开态 = 全量（原引用直透，hiddenCount=0）。
{
  const ev = [M("a"), M("b"), M("c"), M("d"), M("e"), M("f")];
  const w = applyContextWindow(ev, "b", true);
  assert.strictEqual(w.events, ev, "T3 展开态原引用");
  assert.strictEqual(w.hiddenCount, 0, "T3 展开态无藏起");
}

// 4. 短列表（≤2*pad+1）不折叠（原引用直透，无展开按钮依据）。
{
  const ev = [M("a"), M("b"), M("c"), M("d"), M("e")];
  const w = applyContextWindow(ev, "a", false);
  assert.strictEqual(w.events, ev, "T4 恰 5 条不折叠");
  assert.strictEqual(w.hiddenCount, 0, "T4 无藏起");
  const w2 = applyContextWindow([M("a"), M("b")], "a", false);
  assert.deepStrictEqual(ids(w2), ["a", "b"], "T4 2 条全显");
}

// 5. 目标缺失（/context 未带回目标 event）→ 前 2*pad+1，窗口恒有界。
{
  const ev = [M("a"), M("b"), M("c"), M("d"), M("e"), M("f"), M("g"), M("h"), M("i")];
  const w = applyContextWindow(ev, "ghost", false);
  assert.deepStrictEqual(ids(w), ["a", "b", "c", "d", "e"], "T5 目标缺失 → 前 5");
  assert.strictEqual(w.hiddenCount, 4, "T5 hidden=9-5");
}

// 6. custom pad：±4 窗 9 条。
{
  const ev = [M("a"), M("b"), M("c"), M("d"), M("e"), M("f"), M("g"), M("h"), M("i"), M("j")];
  const w = applyContextWindow(ev, "e", false, 4);
  assert.deepStrictEqual(
    ids(w),
    ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
    "T6 pad=4 → ±4",
  );
  assert.strictEqual(w.hiddenCount, 1, "T6 hidden=10-9");
}

console.log("jumpContextWindow smoke: 6 断言组全过");
