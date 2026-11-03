// renderWindow 纯逻辑冒烟（node 直跑，跑法照 threadWindow.smoke.mjs——
// esbuild buildSync 到临时目录 + import）。覆盖 16.46 窗口化全部纯逻辑：
// 初始尾锚 / 头前插平移（loadMore）/ 头裁剪（R2 旁路释放）/ 尾追加
// （贴底跟随 vs 中部保持）/ 哨兵扩窗 / 跳转保证 / 小房间不窗口化。
// 用法：node scripts/renderWindow.smoke.mjs
import { buildSync } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert";

const tmp = mkdtempSync(path.join(tmpdir(), "rw-smoke-"));
buildSync({
  entryPoints: ["src/chat/renderWindow.ts"],
  bundle: true,
  format: "esm",
  outfile: path.join(tmp, "renderWindow.mjs"),
  platform: "node",
});
const {
  VWIN_BUFFER,
  VWIN_INITIAL,
  VWIN_MIN,
  bottomWindow,
  nextViewRange,
  ensureItemVisible,
  expandRange,
} = await import(path.join(tmp, "renderWindow.mjs"));

const K = (n, off = 0) =>
  Array.from({ length: n }, (_, i) => `k${i + off}`);

// 1. 初始尾锚：空 prev / 无锚 → 尾 VWIN_INITIAL 窗。
{
  const keys = K(500);
  const r = nextViewRange(
    { start: 0, end: 0 },
    0,
    null,
    keys,
    true,
    false,
  );
  assert.deepStrictEqual(r, { start: 500 - VWIN_INITIAL, end: 500 }, "W1 初始尾锚");
  assert.deepStrictEqual(bottomWindow(0), { start: 0, end: 0 }, "W1 空安全");
  assert.deepStrictEqual(bottomWindow(10), { start: 0, end: 10 }, "W1 短列表全量");
}

// 2. 小房间（≤ VWIN_MIN）恒全量。
{
  const keys = K(50);
  const r = nextViewRange(
    { start: 0, end: 0 },
    0,
    null,
    keys,
    false,
    false,
  );
  assert.deepStrictEqual(r, { start: 0, end: 50 }, "W2 小房间全量");
  const big = nextViewRange(
    { start: 460, end: 500 },
    500,
    "k499",
    K(50), // 收缩到 ≤60
    false,
    false,
  );
  assert.deepStrictEqual(big, { start: 0, end: 50 }, "W2 收缩后全量");
}

// 3. 头前插（loadMore）：尾锚 +delta 平移，窗内行集不变。
{
  const oldKeys = K(200);
  const newKeys = [...K(50), ...oldKeys]; // 前插 50
  const prev = { start: 100, end: 160 };
  const r = nextViewRange(prev, 200, oldKeys[159], newKeys, false, false);
  assert.deepStrictEqual(r, { start: 150, end: 210 }, "W3 前插整窗平移");
  // 行集不变：prev 窗 key 集 == 新窗 key 集
  const oldSet = new Set(oldKeys.slice(100, 160));
  const newSet = new Set(newKeys.slice(r.start, r.end));
  assert.strictEqual(oldSet.size, newSet.size, "W3 行数不变");
  for (const k of oldSet) assert.ok(newSet.has(k), `W3 行 ${k} 保留`);
}

// 4. R2 旁路释放（头裁剪 1000→801，深跳目标留窗）：
{
  // 前插后窗口 = 尾 40（用户在底部看回填过程）
  const oldKeys = K(1000);
  const prev = { start: 960, end: 1000 };
  const newKeys = oldKeys.slice(199); // 裁掉最早 199
  const r = nextViewRange(prev, 1000, oldKeys[999], newKeys, false, false);
  assert.deepStrictEqual(r, { start: 761, end: 801 }, "W4 头裁剪平移");
  // 深跳目标（新索引 1）在 jump-ensure 扩窗后须留窗：
  const ensured = ensureItemVisible(r, newKeys.length, 1);
  assert.ok(1 >= ensured.start && 1 < ensured.end, "W4 深跳目标留窗");
}

// 5. 尾追加：贴底/窗贴尾 → 跟随；中部 → 保持（未读徽章由 stickToBottom）。
{
  const keys = K(200);
  const atBottom = nextViewRange(
    { start: 160, end: 200 },
    200,
    "k199",
    K(205),
    true,
    false,
  );
  assert.deepStrictEqual(atBottom, { start: 160, end: 205 }, "W5 贴尾跟随");
  const mid = nextViewRange(
    { start: 100, end: 160 },
    200,
    "k159",
    K(205),
    false,
    false,
  );
  assert.deepStrictEqual(mid, { start: 100, end: 160 }, "W5 中部保持");
}

// 6. 哨兵扩窗：边缘收敛（已到边 = no-op，引用不变）。
{
  const len = 500;
  const r1 = expandRange({ start: 460, end: 500 }, len, "bottom");
  assert.strictEqual(r1.start, 460, "W6 底边 no-op");
  const r2 = expandRange({ start: 440, end: 480 }, len, "bottom");
  assert.deepStrictEqual(r2, { start: 440, end: 500 }, "W6 底扩收敛到边");
  const r3 = expandRange({ start: 0, end: 40 }, len, "top");
  assert.strictEqual(r3.start, 0, "W6 顶边 no-op");
  const r4 = expandRange({ start: 20, end: 60 }, len, "top");
  assert.deepStrictEqual(r4, { start: 0, end: 60 }, "W6 顶扩收敛到边");
  const r5 = expandRange({ start: 0, end: 10 }, 10, "top");
  assert.deepStrictEqual(r5, { start: 0, end: 10 }, "W6 小房间 no-op");
}

// 7. 跳转保证：窗外目标 → 前 VWIN_BUFFER 后 VWIN_INITIAL 窗；
//    窗外尾端 → 尾锚窗；窗外目标未加载（-1）→ 原样。
{
  const len = 500;
  const prev = { start: 460, end: 500 };
  const r = ensureItemVisible(prev, len, 100);
  assert.deepStrictEqual(
    r,
    { start: 100 - VWIN_BUFFER, end: 100 + VWIN_INITIAL },
    "W7 中部目标",
  );
  const r2 = ensureItemVisible(prev, len, 0);
  assert.strictEqual(r2.start, 0, "W7 首端目标 start 钳 0");
  const r3 = ensureItemVisible({ start: 0, end: 40 }, len, 499);
  assert.strictEqual(r3.end, len, "W7 尾端目标 end 钳边");
  assert.deepStrictEqual(
    ensureItemVisible(prev, len, -1),
    prev,
    "W7 未加载 no-op",
  );
  const r4 = ensureItemVisible(prev, len, 480);
  assert.deepStrictEqual(r4, prev, "W7 已在窗内 no-op");
}

// 8. 房间切换：直接尾锚重置（不沿用旧锚）。
{
  const r = nextViewRange(
    { start: 100, end: 160 },
    200,
    "k159",
    K(300),
    false,
    true,
  );
  assert.deepStrictEqual(r, { start: 300 - VWIN_INITIAL, end: 300 }, "W8 切房重置");
}

console.log(`renderWindow smoke: 8 断言组全过（BUFFER=${VWIN_BUFFER} INITIAL=${VWIN_INITIAL} MIN=${VWIN_MIN}）`);
