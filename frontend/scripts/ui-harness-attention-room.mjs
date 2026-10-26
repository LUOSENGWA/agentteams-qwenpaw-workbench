#!/usr/bin/env node
/**
 * ui-harness-attention-room.mjs — attention 房间卡徽章(L2)/房间页 pill(L3) smoke
 *（playwright-core + chromium + 本地 http.server + esbuild 现场打包
 * harness/entry-attention-room.tsx；host mock 在 harness/page-attention-room.html）。
 *
 * 场景（数据=mock；room_id 走 payload 自带分支）：
 * S1 L2：任务群卡（attentionPendingByRoom=2）显琥珀 ⏳ 待决策 2；DM 卡无
 * S2 降级：不传 attentionPendingByRoom（deployed=false 同口径）→ 零徽章、零报错
 * S3 L3：RoomChat 宽屏标题栏出 pill ⏳ 待决策 2（本房间 2 条）
 * S4 L3 点击：pill onClick → onOpenRoomAttention(本房间)（父侧定位第一条→全局弹窗）
 * S5 全程 pageerror 零容忍
 *
 * 运行：cd frontend && node scripts/ui-harness-attention-room.mjs
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import esbuild from "esbuild";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, "..");
const bundleFile = path.join(FRONTEND_DIR, "harness", "bundle-attention-room.js");

await esbuild.build({
  entryPoints: [path.join(FRONTEND_DIR, "harness", "entry-attention-room.tsx")],
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

const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

const results = [];
function assert(name, cond, detail = "") {
  results.push({ name, ok: !!cond });
  console.log(
    `${!!cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  — " + String(detail).slice(0, 300)}`,
  );
}
const sleep = (ms) => page.waitForTimeout(ms);

await page.goto(`http://127.0.0.1:${port}/harness/page-attention-room.html`);
await sleep(700);

// ── S1：L2 房间卡徽章 ──────────────────────────────────────────
const badgeInCards = page.locator("#sec-cards").getByText("⏳ 待决策 2");
assert("S1a 任务群卡显 ⏳ 待决策 2", (await badgeInCards.count()) === 1,
  await page.locator("#sec-cards").innerText().catch((e) => String(e)));
// 徽章=琥珀 antd Tag（color="orange" → ant-tag-orange）
assert("S1b 徽章为 ant-tag-orange",
  (await page.locator("#sec-cards .ant-tag-orange").count()) === 1);
// DM 卡（!dm1 不在映射）无徽章：全 section 仅 1 枚橙色 tag
assert("S1c DM 卡无徽章（section 内仅 1 枚橙色 tag）",
  (await page.locator("#sec-cards .ant-tag-orange").count()) === 1);

// ── S2：降级空态（不传映射=deployed=false 同口径）──────────────
assert("S2a 降级 section 零徽章",
  (await page.locator("#sec-cards-degraded .ant-tag-orange").count()) === 0);
assert("S2b 降级 section 无徽章文案",
  !(await page.locator("#sec-cards-degraded").innerText()).includes("⏳ 待决策"));

// ── S3：L3 房间页 pill ─────────────────────────────────────────
const pill = page.locator("#sec-room").getByText("⏳ 待决策 2");
assert("S3a 标题栏 pill 显 ⏳ 待决策 2", (await pill.count()) === 1,
  await page.locator("#sec-room").innerText().catch((e) => String(e)));
assert("S3b pill 可点（cursor:pointer + 橙色 tag）",
  (await page.locator("#sec-room .ant-tag-orange[style*='cursor']").count()) === 1);

// ── S4：pill 点击 → onOpenRoomAttention(本房间) ───────────────
await pill.click();
await sleep(200);
const opened = await page.evaluate(() => window.__ATTN_OPENED__);
assert("S4a 点击回调收到本房间 room_id", opened === "!task1:hs", String(opened));

// ── S5：pageerror 零容忍 ───────────────────────────────────────
assert("S5 全程 pageerror 零", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
