// v0.5.0-beta.16.24：pagination R2 纯决策层冒烟（node 直跑，非 CI 门——
// 正式门 = tsc/vite/pytest/i18n；本脚本防回归用，改模块后可重跑）。
// 覆盖任务书验收：
//   ① 100+ 页深度定位目标（限页上限内必须找到）；
//   ② 翻页上限钉死请求量（恰好 120 页停 → exhausted → /context 兜底）；
//   ③ 渲染窗口下界（顶层/回复/孤儿回复/未找到）；
//   ④ 锚定恢复决策 + 「连续加载 10 页锚定不跳」算术级验证。
// 用法：node scripts/paginationR2.smoke.mjs
import { buildSync } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert";

const tmp = mkdtempSync(path.join(tmpdir(), "pagr2-smoke-"));
const bundle = (entry, out) =>
  buildSync({
    entryPoints: [`src/${entry}`],
    bundle: true,
    format: "esm",
    outfile: path.join(tmp, out),
    platform: "node",
  });
bundle("originalJump.ts", "originalJump.mjs");
bundle("scrollAnchor.ts", "scrollAnchor.mjs");
const { nextBackfillAction, computeWindowFloorForJump, ORIGINAL_PAGE_CAP } =
  await import(path.join(tmp, "originalJump.mjs"));
const { anchorRestoreDelta } = await import(path.join(tmp, "scrollAnchor.mjs"));

const M = (id, reply) => ({
  event_id: id,
  ...(reply ? { reply: { event_id: reply } } : {}),
});

// ── nextBackfillAction：显式循环的单步决策 ──
assert.strictEqual(nextBackfillAction(true, "c", 999), "done-found", "found 优先于上限");
assert.strictEqual(nextBackfillAction(false, "", 0), "done-exhausted", "游标空=到最早");
assert.strictEqual(nextBackfillAction(false, "c", ORIGINAL_PAGE_CAP), "done-exhausted", "到页上限=exhausted");
assert.strictEqual(nextBackfillAction(false, "c", ORIGINAL_PAGE_CAP - 1), "fetch", "上限前一步=仍可取");
assert.strictEqual(nextBackfillAction(false, "c", 0), "fetch", "常态=取下一页");
console.log("nextBackfillAction ✓");

// ── 模拟回填循环（loadOriginal 循环的镜像：决策走 nextBackfillAction，
//    取页用测试替身；窗口/游标推进语义与组件一致）──
function simulateBackfill({ totalPages, targetPage, pageSize = 50 }) {
  const targetId = `m${targetPage}_0`;
  // 窗口=最新页（升序：旧→新）；cursor 每取一页前移，末页取完=空（到最早）。
  const window = [];
  for (let i = 0; i < pageSize; i++) window.push(M(`m0_${i}`));
  let cursor = "C0";
  let pages = 0;
  for (;;) {
    const known = new Set(window.map((m) => m.event_id));
    const action = nextBackfillAction(known.has(targetId), cursor, pages);
    if (action !== "fetch") break;
    const k = pages + 1;
    assert.strictEqual(cursor, `C${pages}`, "游标序列单调");
    assert(k <= totalPages - 1, "服务端页数越界（测试构造错误）");
    for (let i = 0; i < pageSize; i++) window.unshift(M(`m${k}_${i}`));
    cursor = k === totalPages - 1 ? "" : `C${k}`;
    pages += 1;
    if (pages > 10000) throw new Error("循环不收敛");
  }
  const found = window.some((m) => m.event_id === targetId);
  return { pages, found, action: nextBackfillAction(found, cursor, pages) };
}

// ① 100+ 页深度定位：110 页房间，目标在第 104 页（0 基）→ 需翻 104 页
//    < 上限 120 → 必须 found（验收：100+ 页深度定位目标）。
{
  const r = simulateBackfill({ totalPages: 110, targetPage: 104 });
  assert.strictEqual(r.found, true, "100+ 页深目标找到");
  assert.strictEqual(r.pages, 104, "翻页数=目标深度");
  assert.strictEqual(r.action, "done-found");
  console.log(`100+ 页深度定位 ✓（翻 ${r.pages} 页命中）`);
}
// ② 页上限上界：目标在第 150 页（> 上限）→ 恰好 120 页停，exhausted
//    （banner 落 /context 兜底；请求量上界可控）。
{
  const r = simulateBackfill({ totalPages: 200, targetPage: 150 });
  assert.strictEqual(r.pages, ORIGINAL_PAGE_CAP, "恰好页上限停");
  assert.strictEqual(r.found, false, "上限外目标未找到");
  assert.strictEqual(r.action, "done-exhausted", "→ /context 兜底");
  console.log(`页上限上界 ✓（恰好翻 ${r.pages} 页 → exhausted）`);
}
// ③ 目标已在窗口（点击瞬间命中）→ 0 次取页。
{
  const r = simulateBackfill({ totalPages: 5, targetPage: 0 });
  assert.strictEqual(r.pages, 0, "初窗即含目标=零取页");
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.action, "done-found");
  console.log("零取页即时命中 ✓");
}
// ④ 游标空（到最早）：全历史无目标 → 翻完全部页（初窗外 totalPages-1 页）、
//    cursor="" → exhausted。
{
  const r = simulateBackfill({ totalPages: 3, targetPage: 99 });
  assert.strictEqual(r.pages, 2, "翻完全部页（初窗外 2 页）");
  assert.strictEqual(r.found, false);
  assert.strictEqual(r.action, "done-exhausted", "到最早=exhausted（/context 兜底）");
  console.log("到最早（游标空）✓");
}

// ── computeWindowFloorForJump：渲染窗口下界 ──
{
  // 12 条升序：10 顶层 + r1/r2 在窗线程回复 + r3 孤儿回复（根 t99 未加载）。
  const msgs = [
    M("t1"), M("t2"), M("t3"), M("r1", "t3"), M("t4"),
    M("t5"), M("r2", "t7"), M("t6"), M("t7"), M("t8"),
    M("r3", "t99"), M("t9"), M("t10"),
  ];
  // tops = [t1,t2,t3,t4,t5,t6,t7,t8,r3(降级),t9,t10]（r1/r2 归线程）
  assert.strictEqual(computeWindowFloorForJump(msgs, "t5"), 7, "顶层目标=自身到最新（含）");
  assert.strictEqual(computeWindowFloorForJump(msgs, "r2"), 5, "回复目标=其根到最新（含）");
  assert.strictEqual(computeWindowFloorForJump(msgs, "r3"), 3, "孤儿回复=降级顶层自身到最新（含）");
  assert.strictEqual(computeWindowFloorForJump(msgs, "ghost"), 0, "未找到=不抬升");
  console.log("computeWindowFloorForJump ✓");
}

// ── anchorRestoreDelta：锚定恢复决策 ──
assert.strictEqual(anchorRestoreDelta(0, 320, 600), 320, "锚在顶部（原生未处理）→ 全量补偿");
assert.strictEqual(anchorRestoreDelta(100, 420, 600), 320, "锚在视口中段 → 差值补偿");
assert.strictEqual(anchorRestoreDelta(-500, -180, 600), 0, "锚在视口上外（用户深停列表）→ no-op");
assert.strictEqual(anchorRestoreDelta(650, 970, 600), 0, "锚在视口下外 → no-op");
assert.strictEqual(anchorRestoreDelta(120, 120, 600), 0, "原生已处理（oNow≈oSaved）→ 自然 no-op");
console.log("anchorRestoreDelta ✓");

// ── 连续加载 10 页锚定不跳（算术级验证，DOM 级走手工/浏览器验收）──
// 模型：D=锚定元素距内容顶的偏移；S=scrollTop；视口偏移 o=D−S。
// 前插 = D 增加（S 不动 → o 被推离原位）；每页提交后按
// anchorRestoreDelta 写 S。用户停在顶部不动 → oSaved 恒定，
// 每页恢复后 o 必须回到 oSaved（视口纹丝不动）。
{
  const PAGE_H = 320, CLIENT_H = 600;
  let D = 100, S = 0;
  const oSaved = D - S;
  for (let page = 0; page < 10; page++) {
    D += PAGE_H; // 前插一页
    const oNow = D - S;
    const delta = anchorRestoreDelta(oSaved, oNow, CLIENT_H);
    S += delta;
    assert.strictEqual(D - S, oSaved, `第 ${page + 1} 页恢复后锚视口偏移不变`);
  }
  assert.strictEqual(S, 10 * PAGE_H, "scrollTop 恰好推进前插总高");
  console.log("连续加载 10 页锚定不跳 ✓（锚视口偏移全程恒定）");
}
// 变体：用户深停列表（锚在视口上外）→ 前插不碰视口（S 恒 0）。
{
  const PAGE_H = 320, CLIENT_H = 600;
  let D = 0, S = 500; // o = -500（锚在视口上方 500px）
  const oSaved = D - S;
  for (let page = 0; page < 10; page++) {
    D += PAGE_H;
    const oNow = D - S;
    const delta = anchorRestoreDelta(oSaved, oNow, CLIENT_H);
    S += delta;
  }
  assert.strictEqual(S, 500, "用户深停列表：前插零扰动");
  console.log("深停列表零扰动 ✓");
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\npaginationR2 冒烟全绿（ORIGINAL_PAGE_CAP=${ORIGINAL_PAGE_CAP}）`);
