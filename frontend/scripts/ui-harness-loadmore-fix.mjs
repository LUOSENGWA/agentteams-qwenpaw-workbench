#!/usr/bin/env node
/**
 * ui-harness-loadmore-fix.mjs — 视口窗口化（16.46）浏览器 smoke
 *（playwright-core + chromium + 本地 http.server + esbuild 现场打包
 * harness/entry-loadmore-fix.tsx；host mock 在 harness/page-loadmore-fix.html）。
 *
 * 数据=500 条 mock（两发送者交替 → 500 turn），控制面 window.__HM__。
 * 场景：
 * S1 初始 500 条 → 只渲染 ~40 行（尾窗 VWIN_INITIAL），贴底
 * S2 刻度轨有界（8 ≤ ticks ≤ 45，与总量 500 无关）
 * S3 前插 50 条（模拟 loadMore 提交）→ 视口锚定（参考行偏移 ±10px）、行数不变
 * S4 滚到顶 → 顶哨兵上扩一次（+20 行、scrollTop 保持 0）+ 提交耗时 <200ms
 * S5 深跳 m600（R2 同链：jump-ensure 扩窗 → scroll+高亮）→ 入视口+高亮
 * S6 追加 100 → 600 turn > 500 退化文字条；点击 → 窗口化置底
 * S7 全程 pageerror 零
 *
 * 运行：cd frontend && node scripts/ui-harness-loadmore-fix.mjs
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import esbuild from "esbuild";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, "..");
const bundleFile = path.join(FRONTEND_DIR, "harness", "bundle-loadmore-fix.js");

await esbuild.build({
  entryPoints: [path.join(FRONTEND_DIR, "harness", "entry-loadmore-fix.tsx")],
  bundle: true,
  outfile: bundleFile,
  format: "iife",
  platform: "browser",
  jsx: "transform",
  target: "es2020",
  logLevel: "silent",
});

const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || "/").split("?")[0]);
  const filePath = path.join(FRONTEND_DIR, url);
  if (!filePath.startsWith(FRONTEND_DIR)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const data = readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type":
        ext === ".js" || ext === ".mjs"
          ? "text/javascript"
          : ext === ".css"
            ? "text/css"
            : "text/html",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found: " + url);
  }
});
const port = 4189;
await new Promise((r) => server.listen(port, "127.0.0.1", r));

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium" });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

const pageErrors = []; // Error 对象（保留 stack 供诊断）
const pageConsole = [];
page.on("pageerror", (e) => pageErrors.push(e));
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") {
    pageConsole.push(`[${m.type()}] ` + m.text().slice(0, 500));
  }
});

const results = [];
function assert(name, cond, detail = "") {
  results.push({ name, ok: !!cond });
  console.log(
    `${!!cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  — " + String(detail).slice(0, 300)}`,
  );
}
const sleep = (ms) => page.waitForTimeout(ms);

await page.goto(`http://127.0.0.1:${port}/harness/page-loadmore-fix.html`);
await sleep(900);
// 前置诊断：控制面未就绪时把页面错误打出来再断言（定位 bundle/渲染期故障）。
if (!(await page.evaluate(() => !!window.__HM__))) {
  console.log("\n[DIAG] __HM__ 未就绪——页面错误：");
  for (const e of pageErrors)
    console.log("  pageerror:", String(e.stack || e).slice(0, 1500));
  for (const c of pageConsole) console.log("  console:", c);
}

// ── S1：初始 500 条 → 只渲染尾窗 ~40 行 + 贴底 ─────────────────
const rows1 = await page.evaluate(() => window.__HM__.countRows());
assert("S1a 500 条只渲染 ~40 行（38-45，<60）", rows1 >= 38 && rows1 <= 45,
  `rows=${rows1}`);
const sc1 = await page.evaluate(() => window.__HM__.scroll());
assert("S1b 初始贴底", sc1.top + sc1.client >= sc1.height - 100,
  `top=${sc1.top} client=${sc1.client} height=${sc1.height}`);

// ── S2：刻度轨有界（与总量 500 无关）──────────────────────────
await sleep(300);
const ticks2 = await page.evaluate(() => window.__HM__.countTicks());
assert("S2 刻度数有界（8 ≤ ticks ≤ 45，远小于 500）",
  ticks2 >= 8 && ticks2 <= 45, `ticks=${ticks2}`);

// ── S3：前插 50 条 → 视口锚定、行数不变（尾锚平移，DOM 零重建）──
const refRow = await page.evaluate(() => {
  const list = document.querySelector("[data-event-id]")
    ? document.querySelector("[data-event-id]").parentElement
    : null;
  const rows = document.querySelectorAll("[data-event-id]");
  for (const r of Array.from(rows)) {
    const el = r;
    // 相对最近 overflow-y:auto 祖先的偏移
    let a = el.parentElement;
    while (a && a !== document.body) {
      if (["auto", "scroll"].includes(getComputedStyle(a).overflowY)) break;
      a = a.parentElement;
    }
    if (!a) continue;
    const off = el.getBoundingClientRect().top - a.getBoundingClientRect().top;
    if (off >= 80 && off <= 260) return { id: el.dataset.eventId, off };
  }
  return null;
});
assert("S3a 找到参考行", !!refRow, "无 offset 80-260 的行");
if (refRow) {
  await page.evaluate(() => window.__HM__.prepend(50));
  await sleep(400);
  const rows3 = await page.evaluate(() => window.__HM__.countRows());
  assert("S3b 前插后行数不变（±5，窗平移=同批行）",
    Math.abs(rows3 - rows1) <= 5, `before=${rows1} after=${rows3}`);
  const off3 = await page.evaluate(
    (id) => {
      const row = document.querySelector(`[data-event-id="${id}"]`);
      if (!row) return null;
      let a = row.parentElement;
      while (a && a !== document.body) {
        if (["auto", "scroll"].includes(getComputedStyle(a).overflowY)) break;
        a = a.parentElement;
      }
      return row.getBoundingClientRect().top - a.getBoundingClientRect().top;
    },
    refRow.id,
  );
  assert("S3c 前插后视口锚定（参考行偏移 ±10px）",
    off3 !== null && Math.abs(off3 - refRow.off) <= 10,
    `before=${refRow.off} after=${off3}`);
}

// ── S4：滚到顶 → 顶哨兵上扩一步 + 视口钉原行（补偿）+ 单次提交 <200ms ──
const rowsBefore4 = await page.evaluate(() => window.__HM__.countRows());
const pin4 = await page.evaluate(() => {
  const first = document.querySelector("[data-event-id]");
  let a = first.parentElement;
  while (a && a !== document.body) {
    if (["auto", "scroll"].includes(getComputedStyle(a).overflowY)) break;
    a = a.parentElement;
  }
  a.scrollTop = 0;
  const off = first.getBoundingClientRect().top - a.getBoundingClientRect().top;
  window.__HM__.armCommitMark();
  window.__HM__.t0();
  return { id: first.dataset.eventId, off };
});
// 等行数增长（扩窗提交落地）
await page.waitForFunction(
  (before) => window.__HM__.countRows() >= before + 15,
  rowsBefore4,
  { timeout: 5000 },
).catch(() => {});
const rows4 = await page.evaluate(() => window.__HM__.countRows());
assert("S4a 滚顶触发上扩（行数 +15 以上，20 行/次）",
  rows4 >= rowsBefore4 + 15, `before=${rowsBefore4} after=${rows4}`);
// 视口不跳：扩窗前首行（锚定行）扩窗后偏移不变（上扩补偿生效）。
const offPin4 = await page.evaluate(
  (id) => {
    const row = document.querySelector(`[data-event-id="${id}"]`);
    if (!row) return null;
    let a = row.parentElement;
    while (a && a !== document.body) {
      if (["auto", "scroll"].includes(getComputedStyle(a).overflowY)) break;
      a = a.parentElement;
    }
    return row.getBoundingClientRect().top - a.getBoundingClientRect().top;
  },
  pin4.id,
);
assert("S4b 上扩后视口不跳（原首行偏移不变 ±10px）",
  offPin4 !== null && Math.abs(offPin4 - pin4.off) <= 10,
  `before=${pin4.off} after=${offPin4}`);
const first4 = await page.evaluate(() => window.__HM__.firstRowId());
assert("S4c 更早数据进入渲染（首行变旧）",
  first4 === "!m940:hs", `firstRow=${first4}（前插 50 条后期望 m940）`);
const commit4 = await page.evaluate(
  () => window.__HM__.commitMark() - window.__HM__.t0Value(),
);
assert("S4d 上扩单次提交耗时 <200ms（含 IO 回调延迟）",
  commit4 > 0 && commit4 < 200, `commit=${commit4.toFixed(1)}ms`);

// ── S5：深跳 m600（R2 同链）→ 扩窗 + 入视口 + 高亮 ─────────────
await page.evaluate(() => {
  window.__HM__.armCommitMark();
  window.__HM__.t0();
  window.__HM__.setJumpToEventId("!m600:hs");
});
await page.waitForFunction(() => window.__HM__.rowOffset("!m600:hs") !== null,
  { timeout: 3000 }).catch(() => {});
const commit5 = await page.evaluate(
  () => window.__HM__.commitMark() - window.__HM__.t0Value(),
);
assert("S5a 深跳单次提交耗时 <200ms（扩窗+行重建+目标落地）",
  commit5 > 0 && commit5 < 200, `commit=${commit5.toFixed(1)}ms`);
await sleep(600); // 等 smooth scroll 落地
const off5 = await page.evaluate(() => window.__HM__.rowOffset("!m600:hs"));
const sc5 = await page.evaluate(() => window.__HM__.scroll());
const handled5 = await page.evaluate(() => window.__HM__.jumpHandled());
const bg5 = await page.evaluate(() => window.__HM__.rowStyleBg("!m600:hs"));
assert("S5b 目标 m600 在视口内（jump-ensure 扩窗后 scrollIntoView）",
  off5 !== null && off5 >= -60 && off5 <= sc5.client + 60,
  `off=${off5} client=${sc5.client}`);
assert("S5c 高亮生效（background 非空）",
  bg5 !== "" && bg5 !== "transparent", `bg="${bg5}"`);
assert("S5d 定位链完成（onJumpHandled 已回调）", handled5 >= 1, `handled=${handled5}`);

// ── S6：追加 100 → 650 turn（500+前插 50+追加 100）> 500 → 退化文字条 ──
await page.evaluate(() => window.__HM__.append(100));
await sleep(600);
const ticks6 = await page.evaluate(() => window.__HM__.countTicks());
assert("S6a >500 turn 退化（刻度 0）", ticks6 === 0, `ticks=${ticks6}`);
const bar = page.getByText(/共 650 回合/);
assert("S6b 退化文字条「共 650 回合 · 点击回底部」可见",
  (await bar.count()) === 1, await page.locator("body").innerText().catch((e) => String(e)));
await bar.click();
await sleep(1200); // smooth scroll 置底
const sc6 = await page.evaluate(() => window.__HM__.scroll());
assert("S6c 点击退化条 → 窗口化置底",
  sc6.top + sc6.client >= sc6.height - 120,
  `top=${sc6.top} client=${sc6.client} height=${sc6.height}`);

// ── S7：pageerror 零容忍 ───────────────────────────────────────
assert("S7 全程 pageerror 零", pageErrors.length === 0,
  pageErrors.map((e) => String(e)).join(" | ").slice(0, 500));

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
