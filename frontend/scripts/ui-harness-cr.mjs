/**
 * ui-harness-cr.mjs — Coding Runs 面板 UI 实证
 * （playwright + 本地 http.server + esbuild 现场打包 harness 入口）。
 *
 * 覆盖 1.2.5 #1365/#1381 coding-runs 只读端点消费端四态：
 * S1 列表 v2 字段（cli/worker/status/exit_code/team/时间双源/排序）
 * S2 空态（[] → 暂无编码执行记录，不报错）
 * S3 未部署（404 → 版本未提供空态，不报错）
 * S4 详情 modal（meta 网格 + prompt 可用 + transcript）
 * 全程 pageerror 零容忍。
 *
 * 运行：cd frontend && node scripts/ui-harness-cr.mjs
 */
import http from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import esbuild from "esbuild";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, "..");
const bundleFile = path.join(FRONTEND_DIR, "harness", "bundle-cr.js");

// ── 现场打包 harness 入口（不进 dist；React 走 window 全局，无 external）──
await esbuild.build({
  entryPoints: [path.join(FRONTEND_DIR, "harness", "entry-cr.tsx")],
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

const port = 4186;
await new Promise((r) => server.listen(port, "127.0.0.1", r));

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium" });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
});
const page = await ctx.newPage();

const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

const results = [];
function assert(name, cond, detail = "") {
  results.push({ name, ok: !!cond });
  console.log(
    `${!!cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  — " + String(detail).slice(0, 200)}`,
  );
}

const base = `http://127.0.0.1:${port}/`;

try {
  // ── S1：列表（v2 字段）────────────────────────────────────────
  await page.goto(base + "harness/page-cr.html?scen=list", {
    waitUntil: "networkidle",
  });
  const list = page.locator("#cr");
  await list.waitFor({ timeout: 8000 });
  await page.waitForSelector("#cr .ant-tag", { timeout: 8000 });

  const listText = await list.innerText();
  assert("S1 段标题「编码执行记录」", listText.includes("编码执行记录"));
  assert("S1 计数「3 条」", listText.includes("3 条"), listText.slice(0, 120));
  assert("S1 cli 徽标 claude/codex", listText.includes("claude") && listText.includes("codex"));
  assert("S1 worker 徽标 w1/w2", listText.includes("w1") && listText.includes("w2"));
  assert("S1 status ok/error/timeout", listText.includes("ok") && listText.includes("error") && listText.includes("timeout"));
  assert("S1 退出码 0/1 显示", listText.includes("退出 0") && listText.includes("退出 1"));
  assert("S1 团队 t1 显示", listText.includes("t1"));
  // 时间双源：started_at(ISO→本地) 与 文件名回退
  assert("S1 时间源=started_at", listText.includes("2026-10-16 12:00:00"));
  assert("S1 时间源=文件名回退", listText.includes("2026-10-15 09:00:00"));
  assert("S1 新时间在前（排序）", listText.indexOf("2026-10-16") < listText.indexOf("2026-10-15 09"));

  // ── S4：详情 modal（点首行「查看」）────────────────────────────
  await list.getByRole("button", { name: "查看" }).first().click();
  const modal = page.locator(".ant-modal");
  await modal.waitFor({ timeout: 8000 });
  await page.waitForTimeout(300);
  const modalText = await modal.innerText();
  assert("S4 modal 标题=run 文件名", modalText.includes("run-20261016-120000.log"));
  assert("S4 meta 含 CLI/Worker/Runner", modalText.includes("claude") && modalText.includes("w1") && modalText.includes("docker"));
  assert("S4 meta 退出码 0 + 状态 ok", modalText.includes("ok") && /退出码/.test(modalText));
  assert("S4 meta 时间（本地化 UTC）", modalText.includes("2026-10-16 12:00:00") && modalText.includes("2026-10-16 12:03:00"));
  assert("S4 日志大小 2.0 KB", modalText.includes("2.0 KB"));
  assert("S4 输入 prompt 可读", modalText.includes("please do the thing") && modalText.includes("second line"));
  assert("S4 输出 transcript 渲染", modalText.includes("line one") && modalText.includes("line two") && modalText.includes("DONE"));
  // 关闭 modal
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // ── S2：空态 ──────────────────────────────────────────────────
  await page.goto(base + "harness/page-cr.html?scen=empty", {
    waitUntil: "networkidle",
  });
  await page.waitForTimeout(500);
  const emptyText = await page.locator("#cr").innerText();
  assert("S2 空态「暂无编码执行记录」", emptyText.includes("暂无编码执行记录"), emptyText.slice(0, 120));

  // ── S3：未部署（404）──────────────────────────────────────────
  await page.goto(base + "harness/page-cr.html?scen=404", {
    waitUntil: "networkidle",
  });
  await page.waitForTimeout(500);
  const ndText = await page.locator("#cr").innerText();
  assert("S3 404 优雅空态（不报错）", ndText.includes("未提供编码执行记录"), ndText.slice(0, 120));
  assert("S3 404 无红色错误样式", !(await page.locator("#cr").evaluate((el) => [...el.querySelectorAll("div")].some((d) => d.style.color === "rgb(229, 72, 77)"))));

  // ── 全程 pageerror 零容忍 ─────────────────────────────────────
  assert("全程无 pageerror", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 200));
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过${failed.length ? `（${failed.length} 失败）` : ""}`);
process.exit(failed.length ? 1 : 0);
