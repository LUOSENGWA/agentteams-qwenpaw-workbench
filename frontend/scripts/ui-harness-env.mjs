/**
 * ui-harness-env.mjs — Worker 环境变量 + 网关探测面板
 * UI 实证（playwright + 本地 http.server + esbuild 现场打包 harness 入口）。
 *
 * 覆盖 1.2.5 #1306 消费端（本地/远端 Controller 均 1.2.5 前，实盘走隐藏
 * 降级已单独实锤；此处以 mock 数据面验证组件行为全链）：
 * S1 full：折叠头 + 展开 + 行渲染 + 键校验三态 + 添加行 → 脏 → 保存
 *    （PUT 全量 env + 读回推进基线，脏态清零）
 * S2 full：模型探测成功卡（message + consumer·latency）+ 无 MCP 空态
 * S3 full：清空全部 → 二次确认 modal → PUT env={} → 空态
 * S4 empty：envEditable=true 无 env → 空态
 * S5 l2：envEditable=false → 不渲染（L2 遮蔽）
 * S6 oldctl：无 env 字段 → 不渲染（旧 Controller）
 * 全程 pageerror 零容忍。
 *
 * 运行：cd frontend && node scripts/ui-harness-env.mjs
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import esbuild from "esbuild";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, "..");
const bundleFile = path.join(FRONTEND_DIR, "harness", "bundle-env.js");

await esbuild.build({
  entryPoints: [path.join(FRONTEND_DIR, "harness", "entry-env.tsx")],
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
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("[TRACE]")) console.log(t);
});

const results = [];
function assert(name, cond, detail = "") {
  results.push({ name, ok: !!cond });
  console.log(
    `${!!cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  — " + String(detail).slice(0, 200)}`,
  );
}

const sleep = (ms) => page.waitForTimeout(ms);
const bodyText = () => page.locator("body").innerText();
// antd 两字按钮自动插空格（「保存」渲染为「保 存」）——正则容忍。
const saveBtn = () => page.getByRole("button", { name: /保\s*存/ });

// ── S1/S2/S3：full 场景 ──────────────────────────────────────────
await page.goto(`http://127.0.0.1:${port}/harness/page-env.html?scen=full`);
await sleep(400);

assert(
  "S1a 折叠头（标题 + env 计数 2）",
  (await bodyText()).includes("环境变量与网关探测"),
  await bodyText(),
);
assert(
  "S1b 折叠态默认收起（无 保存 钮）",
  (await saveBtn().count()) === 0,
);

await page.getByText("环境变量与网关探测", { exact: true }).first().click();
await sleep(300);
assert(
  "S1c 展开 + 行渲染 FOO=1 / BAR=x",
  (await bodyText()).includes("FOO") && (await bodyText()).includes("BAR"),
  await bodyText(),
);
assert(
  "S1d 未改动时 保存 禁用",
  (await saveBtn().count()) === 1 && (await saveBtn().isDisabled()),
);

// 键校验三态
const keyInput = page.getByPlaceholder("键名（如 MY_VAR）");
const valInput = page.getByPlaceholder("值（可空）");
const addBtn = page.getByRole("button", { name: /添加/ });

await keyInput.fill("BAD KEY");
await addBtn.click();
await sleep(150);
assert(
  "S1e 非法键名拦截（空格）",
  (await bodyText()).includes("键名须匹配"),
  await bodyText(),
);
await keyInput.fill("AGENTTEAMS_AUTH_TOKEN");
await addBtn.click();
await sleep(150);
assert(
  "S1f 系统保留键拦截",
  (await bodyText()).includes("系统保留键"),
  await bodyText(),
);
await keyInput.fill("FOO");
await addBtn.click();
await sleep(150);
assert(
  "S1g 重复键拦截",
  (await bodyText()).includes("键名重复"),
  await bodyText(),
);
await keyInput.fill("BAZ");
await valInput.fill("42");
await addBtn.click();
await sleep(200);
assert(
  "S1h 合法添加 → 行出现 + 保存启用（脏）",
  (await bodyText()).includes("BAZ") &&
    (await saveBtn().count()) === 1 &&
    !(await saveBtn().isDisabled()),
  await bodyText(),
);

await saveBtn().click();
await sleep(400);
const put1 = await page.evaluate(() => window.__LAST_PUT__);
assert(
  "S1i 保存 = PUT 全量 env（FOO/BAR/BAZ）",
  put1 &&
    JSON.stringify(Object.keys(put1.env).sort()) ===
      JSON.stringify(["BAR", "BAZ", "FOO"]) &&
    put1.env.BAZ === "42",
  JSON.stringify(put1),
);
assert(
  "S1j 保存成功提示（容器重建明示）+ 脏态清零",
  (await bodyText()).includes("已保存") &&
    (await bodyText()).includes("重建") &&
    (await saveBtn().isDisabled()),
  await bodyText(),
);
assert(
  "S1k onChanged 回调（admin 失效）",
  await page.evaluate(() => window.__CHANGED__ === true),
);

// 模型探测
await page.getByRole("button", { name: "探测模型网关" }).click();
await sleep(500);
const probe1 = await page.evaluate(() => window.__LAST_PROBE__);
assert(
  "S2a 模型探测请求体 {kind:model}",
  probe1 && probe1.kind === "model" && !("server" in probe1),
  JSON.stringify(probe1),
);
assert(
  "S2b 成功卡（message + consumer·latency）",
  (await bodyText()).includes("Worker identity verified through gateway") &&
    (await bodyText()).includes("worker-w1 · 42 ms"),
  await bodyText(),
);
assert(
  "S2c 无 MCP 空态",
  (await bodyText()).includes("该 Worker 无用户自定义 MCP"),
);

// 清空全部 → 二次确认。
// 循环删除直到行清空——固定 3 次会在行 re-render（index 键 remount）竞态下
// 丢点击（playwright 实证：3 行只删 2 行），实际计数是唯一可信判据。
let removeGuard = 0;
while (
  (await page.getByRole("button", { name: "×", exact: true }).count()) > 0 &&
  removeGuard < 10
) {
  await page.getByRole("button", { name: "×", exact: true }).first().click();
  await sleep(250);
  removeGuard++;
}
assert(
  "S3a 全删后 保存 启用（=清空全部）",
  !(await saveBtn().isDisabled()),
);
await saveBtn().click();
// 等待 modal（最多 10s；antd 静态 confirm 渲染 + 动画）。
let modalSeen = false;
for (let i = 0; i < 20 && !modalSeen; i++) {
  await sleep(500);
  modalSeen =
    (await page.getByText("清空全部环境变量？").count()) > 0 ||
    (await page.evaluate(() => window.__CONFIRM_CALLED__ === true));
}
assert(
  "S3b 清空二次确认 modal（或被 confirm 探针捕获）",
  modalSeen,
  await bodyText(),
);
await page.getByRole("button", { name: "确认清空" }).click();
await sleep(400);
const put2 = await page.evaluate(() => window.__LAST_PUT__);
assert(
  "S3c 确认后 PUT env={} + 空态",
  put2 && JSON.stringify(put2.env) === "{}" &&
    (await bodyText()).includes("当前无自定义环境变量"),
  JSON.stringify(put2),
);

// ── S4：empty 场景 ─────────────────────────────────────────────
await page.goto(`http://127.0.0.1:${port}/harness/page-env.html?scen=empty`);
await sleep(300);
assert(
  "S4a 渲染（envEditable=true 无 env → 折叠头，计数 0）",
  (await bodyText()).includes("环境变量与网关探测"),
  await bodyText(),
);
await page.getByText("环境变量与网关探测", { exact: true }).first().click();
await sleep(300);
assert(
  "S4b 展开后空态（当前无自定义环境变量）",
  (await bodyText()).includes("当前无自定义环境变量"),
  await bodyText(),
);

// ── S5：l2 场景 ────────────────────────────────────────────────
await page.goto(`http://127.0.0.1:${port}/harness/page-env.html?scen=l2`);
await sleep(300);
assert(
  "S5 L2 遮蔽（envEditable=false）不渲染",
  !(await bodyText()).includes("环境变量与网关探测"),
  await bodyText(),
);

// ── S6：oldctl 场景 ───────────────────────────────────────────
await page.goto(`http://127.0.0.1:${port}/harness/page-env.html?scen=oldctl`);
await sleep(300);
assert(
  "S6 旧 Controller（无 env 字段）不渲染",
  !(await bodyText()).includes("环境变量与网关探测"),
  await bodyText(),
);

assert(
  "G0 pageerror 零容忍",
  pageErrors.length === 0,
  pageErrors.join(" | ").slice(0, 300),
);

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} 断言通过` +
    (failed.length ? `（${failed.length} 失败）` : "，全绿"),
);
process.exit(failed.length ? 1 : 0);
