#!/usr/bin/env node
/**
 * ui-harness-settings-auth.mjs — 设置页「Controller token 与 Higress
 * 认证分家」UI 实证（playwright-core + chromium + esbuild 现场打包
 * harness/entry-settings.tsx；mock 数据面在 page-settings.html，
 * verify-admin 恒失败且按来源返回不同 error 文本）。
 *
 * 覆盖 10/17 反馈件（两套独立认证系统不得互借）：
 * S1 L1 管理面（token）模式：Higress 独立段可见 + 新标题/文案
 * S2 切到 Matrix（L2）模式：Higress 段仍可见（不再被模式吞掉）
 * S3 Higress 验证失败 → 错误回报含 harness-fail-higress（锚定 Higress 来源）
 * S4 Controller token 验证失败 → 错误回报含 harness-fail-controller
 * S5 「两个不同系统的凭证——不可互相替代」文案可见
 * 全程 pageerror 零容忍。
 *
 * 运行：cd frontend && node scripts/ui-harness-settings-auth.mjs
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import esbuild from "esbuild";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, "..");
const bundleFile = path.join(FRONTEND_DIR, "harness", "bundle-settings.js");

await esbuild.build({
  entryPoints: [path.join(FRONTEND_DIR, "harness", "entry-settings.tsx")],
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
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1600 } });
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
const bodyText = () => page.locator("body").innerText();

await page.goto(`http://127.0.0.1:${port}/harness/page-settings.html`);
await sleep(800);

// ── S1：L1 管理面模式（controller_token 空 → 初始 matrix，先切换）──
await page.getByText("L1 管理面（Controller 管理员 token）", { exact: false }).first().click();
await sleep(400);
let t = await bodyText();
assert("S1a L1 模式下 Higress 独立段标题", t.includes("② Higress Console 认证"), t.slice(0, 400));
assert("S1b Higress 段独立说明（两个不同系统的凭证）", t.includes("不可互相替代"), t.slice(0, 400));

// ── S2：切到 Matrix（L2）——Higress 段仍可见 ───────────────────
await page.getByText("Matrix 登录（L2）", { exact: false }).first().click();
await sleep(400);
t = await bodyText();
assert("S2a L2 模式下 Higress 段仍可见（独立段不被模式吞掉）", t.includes("② Higress Console 认证"), t.slice(0, 400));

// ── S3：Higress 验证失败 → 错误锚定 Higress 来源 ──────────────
// 在 L2 模式下直接验证 Higress（独立段在 L2 也可见——分家的直接证明）。
await page.evaluate(() => {
  const inputs = [...document.querySelectorAll("input")];
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  const adminU = inputs.find((i) => i.placeholder === "admin" || (i.id || "").includes("admin"));
  // 按输入顺序定位 Higress 段（页面上第二组账密输入）
  const u = inputs.find((i) => i.type !== "password" && i.placeholder && i.placeholder.includes("admin 账号"));
  const p = inputs.find((i) => i.type === "password");
  if (u) { setter.call(u, "admin"); u.dispatchEvent(new Event("input", { bubbles: true })); }
  if (p) { setter.call(p, "secret123"); p.dispatchEvent(new Event("input", { bubbles: true })); }
});
await sleep(200);
const verifyBtn = page.getByRole("button", { name: /验\s*证/ });
if ((await verifyBtn.count()) > 0) {
  await verifyBtn.last().click();
  await sleep(400);
  t = await bodyText();
  assert("S3a Higress 验证失败回报（harness-fail-higress）", t.includes("harness-fail-higress"), t.slice(0, 500));
  const calls = await page.evaluate(() => window.__VERIFY_CALLS__);
  assert("S3b verify-admin 收到 admin 账密", calls.length >= 1 && calls[calls.length - 1].admin_username === "admin", JSON.stringify(calls));
} else {
  assert("S3 验证按钮存在", false, "未找到 验证 按钮");
}

// ── S4：Controller token 验证失败 → 错误锚定 Controller 来源 ──
await page.getByText("L1 管理面（Controller 管理员 token）", { exact: false }).first().click();
await sleep(400);
await page.evaluate(() => {
  const inputs = [...document.querySelectorAll("input")];
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  // token 输入框（placeholder 含 token）
  const tok = inputs.find((i) => (i.placeholder || "").includes("token") || (i.placeholder || "").includes("Token"));
  if (tok) { setter.call(tok, "harness-token-abc"); tok.dispatchEvent(new Event("input", { bubbles: true })); }
});
await sleep(200);
const verifyBtns = page.getByRole("button", { name: /验\s*证/ });
if ((await verifyBtns.count()) > 0) {
  await verifyBtns.first().click();
  await sleep(400);
  t = await bodyText();
  assert("S4a Controller 验证失败回报（harness-fail-controller）", t.includes("harness-fail-controller"), t.slice(0, 500));
  const calls = await page.evaluate(() => window.__VERIFY_CALLS__);
  const last = calls[calls.length - 1];
  assert("S4b verify-admin 收到 controller_token", last && last.controller_token === "harness-token-abc" && !last.admin_username, JSON.stringify(last));
} else {
  assert("S4 验证按钮存在", false, "未找到 验证 按钮");
}

// ── S5：分家文案 ──────────────────────────────────────────────
assert("S5 两套独立认证说明文案", (await bodyText()).includes("两套独立的 L1 认证"));

assert("P0 全程无 pageerror", pageErrors.length === 0, pageErrors.join(" | "));

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
await browser.close();
server.close();
process.exit(failed.length ? 1 : 0);
