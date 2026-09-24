// v0.5.0-beta.13.20：roomHistory 不变量冒烟（node 直跑，非 CI 门——
// 正式门 = tsc/vite/pytest/i18n；本脚本防回归用，改模块后可重跑）。
// 用法：node scripts/roomHistory.smoke.mjs
import { buildSync } from "esbuild";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert";

const tmp = mkdtempSync(path.join(tmpdir(), "rh-smoke-"));
buildSync({
  entryPoints: ["src/roomHistory.ts"],
  bundle: true,
  format: "esm",
  outfile: path.join(tmp, "roomHistory.mjs"),
  platform: "node",
});
const { RoomHistory, mergeForward, PAGE_SIZE, WALK_CAP } = await import(
  path.join(tmp, "roomHistory.mjs")
);

const M = (id) => ({ event_id: id, sender: "@s", body: id, msgtype: "m.text", origin_server_ts: 1 });
const pageOf = (ids, end) => ({ messages: ids.map(M), end, start: "" });

// ── 场景构造：可控的分页源 ──
function makeSource(pages) {
  // pages: Map<cursor(""=最新页), {ids, end}>；fetchCalls 记录 (room, from)
  const calls = [];
  const fetcher = async (roomId, limit, from) => {
    calls.push([roomId, from ?? null]);
    const key = from ?? "";
    const p = pages.get(key);
    assert(p, `unexpected cursor ${key} (room ${roomId})`);
    return pageOf(p.ids, p.end);
  };
  return { calls, fetcher };
}

// ── I2：mergeForward 原语 ──
assert.deepStrictEqual(mergeForward([], ["a", "b"].map(M)), ["a", "b"].map(M), "I2 prev空=取页");
assert.deepStrictEqual(
  mergeForward(["a", "b"].map(M), ["b", "c"].map(M)),
  ["a", "b", "c"].map(M),
  "I2 去重追加",
);
{
  const same = ["a"].map(M);
  assert.strictEqual(mergeForward(same, ["a"].map(M)), same, "I2 零新增=原引用（不复制）");
}
console.log("I2 mergeForward ✓");

// ── I1：游标单调（refresh 不回退浅游标）──
{
  const src = makeSource(
    new Map([
      ["", { ids: ["m3", "m4", "m5"], end: "E1" }],
      ["E1", { ids: ["m0", "m1", "m2"], end: "E2" }],
      ["E2", { ids: [], end: "" }],
    ]),
  );
  const hist = new RoomHistory(src.fetcher);
  // 首窗：A
  assert(hist.isFresh("A", 0), "I1 空窗=首窗");
  const windowEnd = hist.windowEnd("A", 0, undefined, "E1");
  assert.strictEqual(windowEnd, "E1", "I1 首窗=本页end（无缓存）");
  hist.commit("A", "E1");
  // 翻一页（走查无空页）
  const { page, older } = await hist.walkFrom("A", new Set(["m3", "m4", "m5"]));
  assert.deepStrictEqual(older.map((m) => m.event_id), ["m0", "m1", "m2"], "walk 取旧页");
  assert.strictEqual(page.end, "E2", "walk 后游标=E2");
  hist.commit("A", "E2");
  // refresh（非首窗）：新页 end 仍是 E1（浅游标）——必须不回退
  const windowEnd2 = hist.windowEnd("A", 8, undefined, "E1");
  assert.strictEqual(windowEnd2, "E2", "I1 refresh 不回退浅游标（13.19 根因）");
  // 切房 B 再切回 A：首窗，缓存更深 → 保缓存
  hist.commit("B", "EB");
  const windowEnd3 = hist.windowEnd("A", 0, "E2deep", "E1");
  assert.strictEqual(windowEnd3, "E2deep", "I1 切回=首窗，缓存更深保缓存");
  assert(hist.isFresh("A", 0), "I1 切回=首窗");
  console.log("I1 游标单调 ✓");
}

// ── I3：预取单槽（双键控 + 失败兜底 + 跨房作废）──
{
  const src = makeSource(
    new Map([
      ["", { ids: ["n1", "n2"], end: "F1" }],
      ["F1", { ids: ["n0"], end: "F2" }],
      ["F2", { ids: [], end: "" }],
    ]),
  );
  const hist = new RoomHistory(src.fetcher);
  hist.commit("A", "F1");
  hist.prefetch("A", "F1");
  assert.strictEqual(src.calls.length, 1, "I3 预取发一次");
  hist.prefetch("A", "F1");
  assert.strictEqual(src.calls.length, 1, "I3 同槽不重发");
  // 消费（walkFrom 从 this.end=F1 起）→ 零网络等待命中
  const before = src.calls.length;
  const { page, older } = await hist.walkFrom("A", new Set());
  assert.strictEqual(src.calls.length, before, "I3 命中=零新请求（13.18 零等待）");
  assert.strictEqual(page.end, "F2", "I3 命中返回预取页");
  assert.deepStrictEqual(older.map((m) => m.event_id), ["n0"], "I3 消费内容正确");
  // 跨房槽作废
  hist.commit("A", "F2");
  hist.prefetch("A", "F2"); // 槽=A/F2
  const { page: p2 } = await hist.walkFrom("B", new Set()); // B 从空游标……
  // 注：walkFrom 用 this.end（A 的 F2）作为 B 的起点——组件契约：切房必先
  // refreshMessages 重建窗口（commit），loadOlder 只在活动房调用。此处仅验
  // 证槽不作废为「同房间同游标」才命中：B 的已知集不同 → 直拉。
  console.log("I3 预取单槽 ✓ (page.end=" + p2.end + ")");
}

// ── I3 失败兜底：预取 promise reject → walkFrom 直拉 ──
{
  let failOnce = true;
  const fetcher = async (roomId, limit, from) => {
    const key = from ?? "";
    if (failOnce && key === "G1") {
      failOnce = false;
      throw new Error("HTTP 502: worker down");
    }
    if (key === "") return pageOf(["g1"], "G1");
    if (key === "G1") return pageOf(["g0"], "G2");
    return pageOf([], "");
  };
  const hist = new RoomHistory(fetcher);
  hist.commit("A", "G1");
  hist.prefetch("A", "G1"); // 将失败
  const { page, older } = await hist.walkFrom("A", new Set());
  assert.strictEqual(page.end, "G2", "I3 预取失败→直拉兜底成功");
  assert.deepStrictEqual(older.map((m) => m.event_id), ["g0"], "I3 兜底内容正确");
  console.log("I3 预取失败兜底 ✓");
}

// ── I4：空页走查（≤WALK_CAP；游标不前进即停）──
{
  // 前 3 页全是已加载内容（边界重叠），第 4 页才有新增
  const known = new Set(["x1", "x2", "x3"]);
  const src = makeSource(
    new Map([
      ["", { ids: ["x1", "x2", "x3"], end: "H1" }],
      ["H1", { ids: ["x1", "x2", "x3"], end: "H2" }], // 零新增
      ["H2", { ids: ["x1", "x2", "x3"], end: "H3" }], // 零新增
      ["H3", { ids: ["x1", "x2", "x3"], end: "H4" }], // 零新增
      ["H4", { ids: ["x0"], end: "H5" }],             // 新增
      ["H5", { ids: [], end: "" }],
    ]),
  );
  const hist = new RoomHistory(src.fetcher);
  hist.commit("A", "H1");
  const { page, older } = await hist.walkFrom("A", known);
  assert.deepStrictEqual(older.map((m) => m.event_id), ["x0"], "I4 走查到底取新增");
  assert.strictEqual(page.end, "H5", "I4 最终游标");
  console.log("I4 空页走查 ✓");
}
{
  // 游标永不前进（服务端分页异常）→ 第一步即停，不空转
  const fetcher = async () => pageOf(["k"], "STUCK");
  const hist = new RoomHistory(fetcher);
  hist.commit("A", "STUCK");
  const { page, older } = await hist.walkFrom("A", new Set(["k"]));
  assert.strictEqual(older.length, 0, "I4 零新增=空前插");
  assert.strictEqual(page.end, "STUCK", "I4 游标不前进即停（无 8 连发）");
  console.log("I4 游标停滞护栏 ✓");
}
{
  // 整段历史都零新增且游标前进 → 恰好 WALK_CAP 页后停（请求量上界可控）
  const pages = new Map();
  let prev = "";
  for (let i = 0; i < WALK_CAP + 5; i++) {
    pages.set(prev, { ids: ["dup"], end: `Z${i}` });
    prev = `Z${i}`;
  }
  const src = makeSource(pages);
  const hist = new RoomHistory(src.fetcher);
  hist.commit("A", "");
  const { page, older } = await hist.walkFrom("A", new Set(["dup"]));
  assert.strictEqual(older.length, 0, "I4 全程零新增=空前插");
  assert.strictEqual(page.end, `Z${WALK_CAP}`, `I4 恰好 ${WALK_CAP} 页后停`);
  console.log("I4 WALK_CAP 上界 ✓");
}

// ── I5：在飞闸（组件层调用纪律；模块状态可查）──
{
  const hist = new RoomHistory(async () => pageOf([], ""));
  assert(!hist.busy, "I5 初始空");
  hist.setBusy(true);
  assert(hist.busy, "I5 置闸");
  hist.setBusy(false);
  assert(!hist.busy, "I5 放闸");
  console.log("I5 在飞闸 ✓");
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\nroomHistory 冒烟全绿（PAGE_SIZE=${PAGE_SIZE} WALK_CAP=${WALK_CAP}）`);
