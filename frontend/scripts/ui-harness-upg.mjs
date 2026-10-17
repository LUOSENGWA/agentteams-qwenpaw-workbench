/**
 * ui-harness-upg.mjs — 运行时升级面板 UI 实证
 * （playwright-core + 系统 chromium + 本地 http.server + esbuild 现场打包）。
 *
 * 覆盖 1.2.5 #1364/#1343 消费端三态：
 * U1 预检列表（候选 + C1-C4 门控 + 推荐/不可升级/预发布 + 告警条）
 * U2 404 降级（无升级服务 → 空态，不报错）
 * U3 触发流（确认 modal → run 202 → job 跟踪卡 + 状态轮询 + log_tail）
 * 全程 pageerror 零容忍。
 *
 * 运行：cd frontend && node scripts/ui-harness-upg.mjs
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import esbuild from "esbuild";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, "..");
const bundleFile = path.join(FRONTEND_DIR, "harness", "bundle-upg.js");

await esbuild.build({
  entryPoints: [path.join(FRONTEND_DIR, "harness", "entry-upg.tsx")],
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

const port = 4187;
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
  // ── U1：预检列表 ─────────────────────────────────────────────
  await page.goto(base + "harness/page-upg.html?scen=list", {
    waitUntil: "networkidle",
  });
  const panel = page.locator("#upg");
  await panel.waitFor({ timeout: 8000 });
  await page.waitForSelector("#upg .ant-tag", { timeout: 8000 });
  await page.waitForTimeout(300);

  let text = await panel.innerText();
  assert("U1 段标题「运行时升级」", text.includes("运行时升级"));
  assert("U1 当前版本 1.2.4", text.includes("1.2.4"));
  assert("U1 推荐候选 1.2.5 + 推荐徽标", text.includes("1.2.5") && text.includes("推荐"));
  assert("U1 预发布候选 1.3.0 + 预发布徽标", text.includes("1.3.0") && text.includes("预发布"));
  assert("U1 C1-C4 门控标签", text.includes("C1") && text.includes("C2") && text.includes("C3") && text.includes("C4"));
  assert("U1 门控状态 PASS/FAIL/NOT_RUN/SKIP", /PASS/.test(text) && /FAIL/.test(text) && /NOT_RUN/.test(text) && /SKIP/.test(text));
  assert("U1 告警条（errors[]）", text.includes("预检存在告警") && text.includes("mirror latency high"));
  assert("U1 不可升级候选按钮禁用", !(await panel.locator(".ant-btn").filter({ hasText: "升级到此版本" }).last().isEnabled()));

  // ── U3：触发流（点推荐候选的升级按钮）─────────────────────────
  await panel
    .locator(".ant-btn")
    .filter({ hasText: "升级到此版本" })
    .first()
    .click();
  const confirmModal = page.locator(".ant-modal-confirm, .ant-modal").last();
  await confirmModal.waitFor({ timeout: 5000 });
  await page.waitForTimeout(200);
  let modalText = await confirmModal.innerText();
  assert("U3 确认 modal 标题", modalText.includes("确认触发运行时升级"));
  assert("U3 确认 modal 目标版本", modalText.includes("1.2.5"));
  assert("U3 确认 modal 危险警示", modalText.includes("自动回滚"));

  await confirmModal.getByRole("button", { name: "确认升级" }).click();
  await page.waitForTimeout(400);
  // job 跟踪卡出现（job_id 稳定不变量；state/phase 是瞬时态——job 出现即
  // 触发 usePoller 首跑 poke，状态立即推进，故不断言精确 running/pre-restart）
  const jobCard = panel.locator("text=job-abc-123").first();
  await jobCard.waitFor({ timeout: 5000 });
  text = await panel.innerText();
  assert("U3 job 跟踪卡出现（job_id）", text.includes("job-abc-123"));
  assert("U3 job 处于进行中态", /running|boot-check-passed|recovering/.test(text), text.slice(0, 200));
  assert("U3 job 版本迁移 1.2.4 → 1.2.5", text.includes("1.2.4") && text.includes("1.2.5"));

  // 轮询推进后 status 返回 boot-check-passed + log_tail
  await page.waitForTimeout(5500);
  text = await panel.innerText();
  assert("U3 轮询后状态推进 boot-check-passed", text.includes("boot-check-passed"), text.slice(0, 300));
  assert("U3 log_tail 渲染", text.includes("pre-restart done") && text.includes("qwenpaw ready"));

  // ── U2：404 降级 ─────────────────────────────────────────────
  await page.goto(base + "harness/page-upg.html?scen=404", {
    waitUntil: "networkidle",
  });
  await page.waitForTimeout(500);
  const ndText = await page.locator("#upg").innerText();
  assert("U2 404 优雅降级（不报错）", ndText.includes("未提供运行时升级服务"), ndText.slice(0, 120));

  // ── 全程 pageerror 零容忍 ────────────────────────────────────
  assert("全程无 pageerror", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 200));
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} 通过${failed.length ? `（${failed.length} 失败）` : ""}`,
);
process.exit(failed.length ? 1 : 0);
