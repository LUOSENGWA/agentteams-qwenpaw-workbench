// QC-164 阶段 1：KB 2D 布局纯函数回归冒烟（node 直跑）。
//
// 背景：3162 行 god file 拆分后，2D v4 布局纯函数（clusterGridLayout 等）
// 独立进 src/kb/layout2d.ts——此前零测试覆盖，拆分须补断言锁行为。
// 覆盖：clusterGridLayout 空集/单点/多簇/virtual 根/agentOrder 聚合/
// 行换行（yAcc 累计）/确定性；clampZoomView 双边界回缩锚点；
// chipWidth/textWidthUnits CJK 加权与钳制；focusView 空集 null。
//
// layout2d.ts 零 React/window 依赖，esbuild 编译后 import 即可。
// 用法：node scripts/kbLayout2d.smoke.mjs
import { buildSync } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert";

const tmp = mkdtempSync(path.join(tmpdir(), "kbLayout2d-smoke-"));
buildSync({
  entryPoints: ["src/kb/layout2d.ts"],
  bundle: true,
  format: "esm",
  outfile: path.join(tmp, "layout2d.mjs"),
  platform: "node",
});
const m = await import(path.join(tmp, "layout2d.mjs"));
const {
  KB2D,
  EMPTY_POS_MAP,
  EMPTY_SIZE_MAP,
  focusView,
  clampZoomView,
  textWidthUnits,
  chipWidth,
  clusterGridLayout,
} = m;

let n = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  n += 1;
}
function eq(a, b, msg) {
  assert.strictEqual(a, b, `${msg}（期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}）`);
  n += 1;
}
function close(a, b, msg) {
  assert.ok(
    Number.isFinite(a) && Math.abs(a - b) < 1e-9,
    `${msg}（期望 ${b}，实得 ${a}）`,
  );
  n += 1;
}

// ── 几何常量（与 dashboard 镜像逐字对齐，勿单端调参）──────────
eq(KB2D.CHIP_H, 26, "CHIP_H");
eq(KB2D.HUB_H, 34, "HUB_H");
eq(KB2D.CHIP_PAD_X, 12, "CHIP_PAD_X");
eq(KB2D.FONT_W, 6.2, "FONT_W");
eq(KB2D.FONT_W_CJK, 11, "FONT_W_CJK");
eq(KB2D.MIN_W, 44, "MIN_W");
eq(KB2D.MAX_W, 180, "MAX_W");
eq(KB2D.GAP_X, 16, "GAP_X");
eq(KB2D.GAP_Y, 14, "GAP_Y");
eq(KB2D.HUB_GAP_Y, 12, "HUB_GAP_Y");
eq(KB2D.BLOCK_GAP_X, 88, "BLOCK_GAP_X");
eq(KB2D.BLOCK_GAP_Y, 72, "BLOCK_GAP_Y");
eq(KB2D.ROW_MAX_W, 1560, "ROW_MAX_W");
eq(KB2D.PAD, 64, "PAD");
// 空图谱哨兵（GraphCard 无布局时的兜底，必须为空 Map）。
eq(EMPTY_POS_MAP.size, 0, "EMPTY_POS_MAP 空");
eq(EMPTY_SIZE_MAP.size, 0, "EMPTY_SIZE_MAP 空");
console.log(`几何常量 + 空哨兵 ${n} 断言 ✓`);

// ── textWidthUnits / chipWidth（CJK 加权 + 钳制）──────────────
eq(textWidthUnits(""), 0, "空串 0 宽");
close(textWidthUnits("abc"), 18.6, "拉丁 3 字 = 3×6.2");
close(textWidthUnits("文件"), 22, "CJK 2 字 = 2×11");
close(textWidthUnits("a文"), 17.2, "混合 a+文");
close(textWidthUnits("Ａ"), 11, "全角 A（U+FF21）= CJK 宽");
eq(chipWidth(""), 44, "空标签 → MIN_W 44");
eq(chipWidth("abc"), 44, "18.6+24=42.6→43 → 钳 MIN_W 44");
eq(chipWidth("文件"), 46, "22+24=46");
eq(chipWidth("a".repeat(20)), 148, "20 拉丁 124+24=148");
eq(chipWidth("a".repeat(40)), 180, "长标签 → MAX_W 180");
eq(chipWidth("文".repeat(20)), 180, "长 CJK → MAX_W 180");
console.log(`chipWidth/textWidthUnits ${n} 断言累计 ✓`);

// ── focusView（包围盒 + 留白；空集 → null）───────────────────
eq(focusView([]), null, "空集 → null");
{
  const v = focusView([{ x: 10, y: 20 }]);
  eq(v.minX, -60, "单点 minX=10-70");
  eq(v.minY, -50, "单点 minY=20-70");
  eq(v.width, 140, "单点 width=140");
  eq(v.height, 140, "单点 height=140");
}
{
  const v = focusView([{ x: 0, y: 0 }, { x: 100, y: 50 }], 0);
  eq(v.minX, 0, "pad=0 minX");
  eq(v.minY, 0, "pad=0 minY");
  eq(v.width, 100, "pad=0 width");
  eq(v.height, 50, "pad=0 height");
}
console.log(`focusView ${n} 断言累计 ✓`);

// ── clampZoomView（zoom 双边界回缩，以视野中心为锚）──────────
const FIT = { minX: 0, minY: 0, width: 1000, height: 500 };
{
  const vb = { minX: 0, minY: 0, width: 1000, height: 500 };
  eq(clampZoomView(vb, FIT), vb, "zoom=1 在界内 → 原引用返回");
}
{
  // zoom = 1000/4000 = 0.25 → 恰在下界（>= minZoom）→ 原样。
  const vb = { minX: 0, minY: 0, width: 4000, height: 2000 };
  eq(clampZoomView(vb, FIT), vb, "zoom=0.25 恰在下界 → 原样");
  // zoom = 0.2 < 0.25 → 回缩到 minZoom，宽度=fit/minZoom=4000，中心锚定。
  const vb2 = { minX: 0, minY: 0, width: 5000, height: 2500 };
  const r = clampZoomView(vb2, FIT);
  close(r.width, 4000, "过宽 → 宽度=fit/0.25=4000");
  close(r.minX + r.width / 2, 2500, "过宽 → 中心 x 锚定 vb 中心");
  close(r.minY + r.height / 2, 1250, "过宽 → 中心 y 锚定 vb 中心");
  close(r.height, 2500 * (4000 / 5000), "过宽 → 高等比缩放");
}
{
  // zoom = 1000/100 = 10 > 8 → 放大到 maxZoom，宽度=fit/8=125。
  const vb = { minX: 0, minY: 0, width: 100, height: 50 };
  const r = clampZoomView(vb, FIT);
  close(r.width, 125, "过窄 → 宽度=fit/8=125");
  close(r.minX + r.width / 2, 50, "过窄 → 中心 x 锚定");
  close(r.height, 50 * (125 / 100), "过窄 → 高等比放大");
}
{
  // 自定义边界。
  const vb = { minX: 0, minY: 0, width: 100000, height: 100 };
  const r = clampZoomView(vb, FIT, 0.1, 2);
  close(r.width, 1000 / 0.1, "自定义 minZoom=0.1");
  const vb2 = { minX: 0, minY: 0, width: 100, height: 100 };
  const r2 = clampZoomView(vb2, FIT, 0.1, 2);
  close(r2.width, 1000 / 2, "自定义 maxZoom=2");
}
console.log(`clampZoomView ${n} 断言累计 ✓`);

// ── clusterGridLayout ────────────────────────────────────────
// A) 空集 → 兜底视野 900×420 @(-450,-210)，零簇零点。
{
  const l = clusterGridLayout([], []);
  eq(l.hubs.length, 0, "A 空集 hubs 空");
  eq(l.blocks.length, 0, "A 空集 blocks 空");
  eq(l.pos.size, 0, "A 空集 pos 空");
  eq(l.size.size, 0, "A 空集 size 空");
  eq(l.view.minX, -450, "A 兜底视野 minX");
  eq(l.view.minY, -210, "A 兜底视野 minY");
  eq(l.view.width, 900, "A 兜底视野 width");
  eq(l.view.height, 420, "A 兜底视野 height");
}
// B) 单点无边 → 1 簇 1 块，hub 居中，块包围盒 = hub chip ±8。
{
  const l = clusterGridLayout([{ id: "a", name: "A" }], []);
  eq(l.hubs.length, 1, "B 单簇");
  eq(l.hubs[0], "a", "B hub=a");
  eq(l.blocks.length, 1, "B 单块");
  const p = l.pos.get("a");
  eq(p.x, 0, "B 单块行内居中 x=0");
  eq(p.y, KB2D.HUB_H / 2, "B hub y=HUB_H/2");
  eq(l.size.get("a").h, KB2D.HUB_H, "B hub 高=HUB_H");
  const b = l.blocks[0];
  eq(b.hubId, "a", "B 块 hubId");
  const hubW = chipWidth("A");
  eq(b.w, Math.max(hubW, 0) + 16, "B 块宽=hubW+16 外扩");
  eq(b.h, KB2D.HUB_H + KB2D.HUB_GAP_Y + 16, "B 无成员 h=HUB_H+HUB_GAP_Y+16");
  eq(b.minX, -Math.max(hubW, 0) / 2, "B 块 minX=hub 中心-外扩前半宽（-22）");
  eq(b.minY, -8, "B 块 minY=-8（hub 顶再外扩 8）");
  // 视野 = 块包围盒 ± PAD。
  close(l.view.minX, b.minX - KB2D.PAD, "B 视野 minX");
  close(l.view.width, b.w + KB2D.PAD * 2, "B 视野 width");
}
// C) 双簇（virtual 根优先 + 无 virtual 取最高度/名序）+ 逐点坐标复现。
{
  const nodes = [
    { id: "r", name: "Root", virtual: true },
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "c", name: "C" },
    { id: "d", name: "D" },
  ];
  const edges = [
    ["r", "a"],
    ["r", "b"],
    ["c", "d"],
  ];
  const l = clusterGridLayout(nodes, edges);
  eq(l.hubs.length, 2, "C 双簇");
  eq(l.hubs[0], "r", "C 簇 1 hub=virtual 根");
  eq(l.hubs[1], "c", "C 簇 2 hub=名序首位（同度取名）");
  // 行布局：块 1 w=104（2 成员 cellW44），块 2 w=44，同行使（236≤1560）。
  eq(l.blocks[0].w, 104 + 16, "C 块 1 宽=gridW104+16");
  eq(l.blocks[1].w, 44 + 16, "C 块 2 宽=44+16");
  // 行宽 236 → x0=-118；块 1 中心 -66，块 2 中心 96。
  close(l.pos.get("r").x, -66, "C 簇 1 hub x=-66");
  close(l.pos.get("c").x, 96, "C 簇 2 hub x=96");
  eq(l.pos.get("r").y, KB2D.HUB_H / 2, "C 首行 hub y");
  // 成员：块 1 gridX0=-118，a/b 两列中心 -96/-36，y=HUB_H+HUB_GAP_Y+CHIP_H/2=59。
  close(l.pos.get("a").x, -96, "C a.x");
  close(l.pos.get("b").x, -36, "C b.x");
  close(l.pos.get("a").y, 59, "C 成员 y=34+12+13=59");
  close(l.pos.get("d").x, 96, "C d.x（单列居中于块 2）");
  close(l.pos.get("d").y, 59, "C d.y");
  // 成员尺寸/归属。
  eq(l.size.get("a").w, 44, "C 成员宽=chipWidth");
  eq(l.size.get("a").h, KB2D.CHIP_H, "C 成员高=CHIP_H");
  eq(l.sectorOf.get("a"), "r", "C a 属簇 r");
  eq(l.sectorOf.get("b"), "r", "C b 属簇 r");
  eq(l.sectorOf.get("r"), "r", "C hub 属自身");
  eq(l.sectorOf.get("d"), "c", "C d 属簇 c");
  // 视野 = 块并集 ± PAD：x ∈ [-118, 134]，y ∈ [-8, 80]。
  close(l.view.minX, -118 - KB2D.PAD, "C 视野 minX");
  close(l.view.minY, -8 - KB2D.PAD, "C 视野 minY");
  close(l.view.width, 134 + 118 + KB2D.PAD * 2, "C 视野 width");
  close(l.view.height, 80 + 8 + KB2D.PAD * 2, "C 视野 height");
  // 确定性：同输入两次 → 逐点同值。
  const l2 = clusterGridLayout(nodes, edges);
  eq(
    JSON.stringify([...l.pos.entries()]),
    JSON.stringify([...l2.pos.entries()]),
    "C 确定性 pos",
  );
  eq(JSON.stringify(l.blocks), JSON.stringify(l2.blocks), "C 确定性 blocks");
}
// D) agentOrder 聚合模式：按 agent 分块 + 未归属点挂末簇不丢点。
{
  const nodes = [
    { id: "a1::x", name: "X", agent: "A" },
    { id: "a2::y", name: "Y", agent: "A" },
    { id: "b1::z", name: "Z", agent: "B" },
    { id: "s", name: "S", agent: "C" }, // agent 不在 order 列表 → 挂末簇
  ];
  const edges = [
    ["a1::x", "a2::y"],
  ];
  const l = clusterGridLayout(nodes, edges, ["A", "B"]);
  eq(l.hubs.length, 2, "D 按 agent 两簇");
  eq(l.hubs[0], "a1::x", "D A 簇 hub（同度取名序 X）");
  eq(l.hubs[1], "b1::z", "D B 簇 hub");
  eq(l.sectorOf.get("a2::y"), "a1::x", "D A 成员归属");
  eq(l.sectorOf.get("s"), "b1::z", "D 未归属点挂末簇（不丢点）");
  eq(l.pos.size, 4, "D 4 点全有坐标");
  eq(l.blocks.length, 2, "D 两块");
  // A 块含成员 Y（1 列 44），B 块含 S。
  eq(l.blocks[0].hubId, "a1::x", "D 块 0 hub");
  eq(l.blocks[1].hubId, "b1::z", "D 块 1 hub");
}
// E) 行换行（>ROW_MAX_W）+ yAcc 累计行高（行行相扣不重叠）。
{
  const mk = (prefix, k) =>
    Array.from({ length: k }, (_, i) => ({
      id: `${prefix}${i}`,
      name: "N".repeat(28) + String(i).padStart(2, "0"), // 30 拉丁 → chip 180
    }));
  const nodes = [
    { id: "h1", name: "H1", virtual: true },
    ...mk("w1-", 24), // 簇 1：24 成员 → 5 列 → gridW=5×180+4×16=964
    { id: "h2", name: "H2", virtual: true },
    ...mk("w2-", 24), // 簇 2：964
    { id: "h3", name: "H3", virtual: true },
    { id: "n3", name: "n" }, // 簇 3：窄块 w=44
  ];
  const edges = [];
  nodes.slice(1, 25).forEach((nd) => edges.push(["h1", nd.id]));
  nodes.slice(26, 50).forEach((nd) => edges.push(["h2", nd.id]));
  edges.push(["h3", "n3"]);
  const l = clusterGridLayout(nodes, edges);
  eq(l.blocks.length, 3, "E 三块");
  eq(l.blocks[0].w, 964 + 16, "E 宽块 1 宽=964+16");
  // 行 1=[宽1]，宽2+宽1>1560 换行；行 2=[宽2, 窄]（964+88+44=1096≤1560）。
  close(l.pos.get("h1").y, KB2D.HUB_H / 2, "E 行 1 hub y");
  // 行 1 高=34+12+5×26+4×14=232 → 行 2 顶 yTop=232+72=304。
  const row1h = KB2D.HUB_H + KB2D.HUB_GAP_Y + 5 * KB2D.CHIP_H + 4 * KB2D.GAP_Y;
  eq(row1h, 232, "E 行 1 高=232");
  close(l.pos.get("h2").y, row1h + KB2D.BLOCK_GAP_Y + KB2D.HUB_H / 2, "E 行 2 hub y=yAcc 累计");
  close(l.pos.get("h3").y, l.pos.get("h2").y, "E 行 2 顶对齐（hub 一条线）");
  // 行 2 行宽 1096 → x0=-548：宽2 中心 -66，窄块中心 526（在宽2 右侧）。
  close(l.pos.get("h2").x, -66, "E 行 2 块 1 中心");
  close(l.pos.get("h3").x, 526, "E 行 2 块 2 中心（居中整体）");
  // 行间无重叠：行 2 块顶(=h2.y-17-8) > 行 1 块底(=行1顶232+外扩8 内的 yAcc 界)。
  ok(l.pos.get("h2").y - KB2D.HUB_H / 2 - 8 >= row1h, "E 行 2 块顶不压行 1 块底");
  // 成员 y 均 ≥ 各自 hub 的 gridY0（不压 hub 横幅）。
  for (const id of l.pos.keys()) {
    if (id === "h1" || id === "h2" || id === "h3") continue;
    const hubId = l.sectorOf.get(id);
    ok(
      l.pos.get(id).y >= l.pos.get(hubId).y + KB2D.HUB_H / 2,
      `E 成员 ${id} 不压 hub ${hubId} 横幅下缘`,
    );
  }
}
console.log(`clusterGridLayout ${n} 断言累计 ✓`);

rmSync(tmp, { recursive: true, force: true });
console.log(`\nkbLayout2d 冒烟全绿（${n} 断言）`);
