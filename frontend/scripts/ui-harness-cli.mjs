#!/usr/bin/env node
/**
 * ui-harness-cli.mjs — Worker Coding CLI 面板 UI 实证
 *（playwright-core + chromium + 本地 http.server + esbuild 现场打包
 * harness/entry-cli.tsx；mock 数据面在 harness/page-cli.html）。
 *
 * 覆盖 1.2.5 #1360 消费端（字段对齐 dashboard worker-coding-cli-panel）：
 * S1 full：折叠头 → 展开 → 三 CLI 行（installed/version/auth 徽标）
 * S2 full：opencode 安装 → 202 task → 1.5s 轮询 → done → 消息 + 重拉列表
 * S3 full：qwen-code 卸载二次确认 modal → POST uninstall → done
 * S4 full：settings 编辑（模型名改 + redacted 密钥留空=*** 哨兵）
 * S5 full：JSON 补丁（非法=报错 / 合法=合并入 diff）
 * S7 l2：PUT 403 → 只读横幅 + 错误消息
 * S8 404：GET 404 → 「暂不可用」横幅
 * S9 routes：15.31 modelProviders 路由卡片 ×2 + 添加按钮 + model 对象
 *    name 子键跳过提示 + 专行读 name + 改路由 baseUrl → patch 含
 *    modelProviders（model 未动不进 patch + redacted 哨兵 ***）
 * S10 seed：15.31 空态 seed 预填（theme/approvalMode/阈值/envKey/路由卡）
 *    + 填模型名保存 → patch 零脏字段（空串/空数组/空对象全剥离）
 *
 * 15.31 修陈旧门：① mock GET 响应改真实 API 形状（原裸 settings 对象被
 * getCliSettings 防御解包成空树 → S4 起全盲）② S6 preset 断言删除
 *（场景模板 15.28 已退役，按钮不存在=点击必超时）。
 * 全程 pageerror 零容忍。
 *
 * 运行：cd frontend && node scripts/ui-harness-cli.mjs
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import esbuild from "esbuild";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, "..");
const bundleFile = path.join(FRONTEND_DIR, "harness", "bundle-cli.js");

await esbuild.build({
  entryPoints: [path.join(FRONTEND_DIR, "harness", "entry-cli.tsx")],
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
const port = 4188;
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
const bodyText = () => page.locator("body").innerText();

// ── S1：full 折叠 → 展开 → 行渲染 ──────────────────────────────
await page.goto(`http://127.0.0.1:${port}/harness/page-cli.html?scen=full`);
await sleep(500);

assert(
  "S1a 折叠头标题",
  (await bodyText()).includes("Coding CLI（安装/升级/settings）"),
  await bodyText(),
);
assert(
  "S1b 折叠态无行（0.25.0 不可见）",
  !(await bodyText()).includes("0.25.0"),
);

await page.getByText("Coding CLI（安装/升级/settings）", { exact: true }).first().click();
await sleep(600);
const t1 = await bodyText();
assert("S1c Qwen Code 行 + 版本 0.25.0", t1.includes("Qwen Code") && t1.includes("0.25.0"), t1);
assert("S1d 鉴权已配置徽标", t1.includes("鉴权已配置"), t1);
assert("S1e OpenCode / Qoder 未安装", t1.includes("OpenCode") && t1.includes("Qoder") && t1.includes("未安装"), t1);
assert("S1f 安装版本输入（空=latest）", (await page.getByPlaceholder("如 0.25.0；空=latest").count()) === 1);

// ── S2：opencode 安装（202 task → 轮询 → done → 重拉）──────────
const listBefore = await page.evaluate(() => window.__LIST_CALLS__);
await page.getByRole("button", { name: /安\s*装/ }).first().click();
await sleep(300);
const installsAfter = await page.evaluate(() => window.__INSTALLS__);
assert(
  "S2a POST install {action:'install'}",
  installsAfter.length === 1 && installsAfter[0].cli === "opencode" && installsAfter[0].action === "install",
  JSON.stringify(installsAfter),
);
// 第一个 tick（~0ms）已 running；把任务翻成 done，等第二个 tick（≤1.5s）。
await page.evaluate(() => { window.__TASK_STATE__ = "done"; });
await sleep(2200);
const t2 = await bodyText();
assert("S2b 任务完成消息（{cli} 任务完成）", t2.includes("任务完成"), t2);
const listAfter = await page.evaluate(() => window.__LIST_CALLS__);
assert("S2c done 后重拉列表", listAfter > listBefore, `before=${listBefore} after=${listAfter}`);

// ── S3：qwen-code 卸载二次确认 ─────────────────────────────────
await page.getByRole("button", { name: /卸\s*载/ }).first().click();
await sleep(300);
const modalVisible = await page.getByText("确认卸载").first().isVisible().catch(() => false);
assert("S3a 卸载二次确认 modal", modalVisible);
await page.getByRole("button", { name: /确认卸载/ }).last().click();
await sleep(300);
const installs3 = await page.evaluate(() => window.__INSTALLS__);
assert(
  "S3b POST uninstall 记录",
  installs3.length === 2 && installs3[1].cli === "qwen-code" && installs3[1].action === "uninstall",
  JSON.stringify(installs3),
);
await page.evaluate(() => { window.__TASK_STATE__ = "done"; });
await sleep(2200);
assert("S3c 卸载任务完成", (await bodyText()).includes("任务完成"));

// ── S4：settings 编辑（模型名 + redacted 哨兵）─────────────────
await page.getByRole("button", { name: /编辑配置/ }).first().click();
await page
  .waitForFunction(
    () => document.body.innerText.includes("settings（结构化表单 · 只保存改动）"),
    { timeout: 4000 },
  )
  .catch(() => {});
const t4 = await bodyText();
assert(
  "S4a settings 编辑器打开（结构化表单标题）",
  t4.includes("settings（结构化表单 · 只保存改动）"),
  t4,
);
// React 受控 input 标准改值（native setter + input 事件）
const setModelName = (v) =>
  page.evaluate((val) => {
    const inputs = [...document.querySelectorAll("input")];
    const el = inputs.find((i) => i.value === "m1" || i.value === "m2" || i.value === "m9");
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;
    setter.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, v);
const m1Count = await page.evaluate(() =>
  [...document.querySelectorAll("input")].filter((i) => i.value === "m1").length,
);
assert("S4b 模型名输入框 m1", m1Count === 1, String(m1Count));
assert("S4b2 改模型名 m1->m2", (await setModelName("m2")) === true);
await page.getByRole("button", { name: /保存改动/ }).click();
await sleep(400);
const puts = await page.evaluate(() => window.__SETTINGS_PUTS__);
assert(
  "S4c PUT diff = 模型名 + *** 哨兵（密钥留空保留）",
  puts.length >= 1 &&
    puts[0].patch.model?.name === "m2" &&
    JSON.stringify(puts[0].patch.security?.auth?.apiKey) === '"***"',
  JSON.stringify(puts),
);
assert("S4d 已保存消息", (await bodyText()).includes("已保存"));

// ── S5：JSON 补丁（非法 / 合法）────────────────────────────────
await page.getByRole("button", { name: /编辑配置/ }).first().click();
await sleep(300);
// 15.31：排除 antd AutoComplete/Select 的隐藏 textarea（name=hiddenTextarea，
// aria-hidden）——模型行/路由卡新增后 .last() 会命中它导致 fill 超时。
const patchArea = page.locator("textarea:not([name=hiddenTextarea])").last();
await patchArea.fill("[1,2]");
await page.getByRole("button", { name: /保存改动/ }).click();
await sleep(300);
// 15.31：数组补丁的报错文案（原断言字符串「补丁须为 JSON 对象」早已陈旧）。
assert("S5a 补丁须为对象（数组被拒）", (await bodyText()).includes("JSON 补丁须为对象"));
await patchArea.fill('{"mcp":{"enabled":true}}');
await page.getByRole("button", { name: /保存改动/ }).click();
await sleep(400);
const puts2 = await page.evaluate(() => window.__SETTINGS_PUTS__);
const last = puts2[puts2.length - 1];
assert(
  "S5b 合法补丁合并入 diff",
  last && JSON.stringify(last.patch.mcp) === JSON.stringify({ enabled: true }),
  JSON.stringify(puts2),
);

// ── S9：routes 场景（15.31：modelProviders 路由卡片 + model 对象 name 跳过）──
await page.goto(`http://127.0.0.1:${port}/harness/page-cli.html?scen=routes`);
await sleep(500);
await page.getByText("Coding CLI（安装/升级/settings）", { exact: true }).first().click();
await sleep(500);
await page.getByRole("button", { name: /编辑配置/ }).first().click();
await page
  .waitForFunction(
    () => document.body.innerText.includes("openai · 1 号路由"),
    { timeout: 4000 },
  )
  .catch(() => {});
const t9 = await bodyText();
assert(
  "S9a modelProviders 路由卡片 ×2（openai · #1/#2）",
  t9.includes("openai · 1 号路由") && t9.includes("openai · 2 号路由"),
  t9,
);
assert("S9b 添加模型路由按钮", (await page.getByRole("button", { name: /添加模型路由/ }).count()) >= 1);
assert("S9c model 对象 name 子键由专行管理提示", t9.includes("← 由上方「模型」行管理"), t9);
const m1c9 = await page.evaluate(() =>
  [...document.querySelectorAll("input")].filter((i) => i.value === "m1").length,
);
assert("S9d 模型专行读对象 name=m1", m1c9 === 1, String(m1c9));
// 改路由 #1 的 baseUrl → 保存 → patch 含 modelProviders 变更（model 未动=不进 patch）
await page.evaluate(() => {
  const inputs = [...document.querySelectorAll("input")];
  const el = inputs.find((i) => i.value === "http://a:1/v1");
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(el, "http://a:1/v2");
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
});
await page.getByRole("button", { name: /保存改动/ }).click();
await sleep(500);
const puts9 = await page.evaluate(() => window.__SETTINGS_PUTS__);
const last9 = puts9[puts9.length - 1];
assert(
  "S9e patch 含 modelProviders 变更（http://a:1/v2）",
  last9 && JSON.stringify(last9.patch.modelProviders).includes("http://a:1/v2"),
  JSON.stringify(puts9),
);
assert(
  "S9f model 未动不进 patch + redacted 哨兵 ***",
  last9 && !("model" in last9.patch) && last9.patch.security?.auth?.apiKey === "***",
  JSON.stringify(last9),
);

// ── S10：seed 场景（15.31：空态 seed 预填 + 零脏字段保存）──────
await page.goto(`http://127.0.0.1:${port}/harness/page-cli.html?scen=seed`);
await sleep(500);
await page.getByText("Coding CLI（安装/升级/settings）", { exact: true }).first().click();
await sleep(500);
await page.getByRole("button", { name: /编辑配置/ }).first().click();
await page
  .waitForFunction(
    () => document.body.innerText.includes("Qwen Dark"),
    { timeout: 4000 },
  )
  .catch(() => {});
const t10 = await bodyText();
// 15.31：seed 预填值在 input 的 value 里（不在 innerText）→ 查 input 值集合。
const seedVals = await page.evaluate(() =>
  [...document.querySelectorAll("input")].map((i) => i.value).filter(Boolean),
);
assert(
  "S10a seed 预填可见（theme/approvalMode/阈值/envKey 在 input 值）",
  seedVals.includes("Qwen Dark") &&
    seedVals.includes("auto") &&
    seedVals.includes("0.85") &&
    seedVals.includes("OPENAI_API_KEY"),
  JSON.stringify(seedVals) + " | body: " + t10.slice(0, 200),
);
assert("S10b seed 路由卡片 #1", t10.includes("openai · 1 号路由"), t10);
assert("S10c 空态提示不出现（seed 有内容）", !t10.includes("尚无配置文件"), t10);
// 15.31：模型专行 = antd AutoComplete，搜索 input 的 class 稳定为
// ant-select-selection-search-input（占位不落 input 属性，不能按 placeholder 找）。
// Playwright fill 对 React 受控组件可靠（自动派发正确事件）。
const modelInput = page.locator("input.ant-select-selection-search-input").first();
assert("S10d-pre 模型专行输入框可定位", (await modelInput.count()) === 1, "count=" + (await modelInput.count()));
await modelInput.fill("m-new");
await page.getByRole("button", { name: /保存改动/ }).click();
await sleep(500);
const puts10 = await page.evaluate(() => window.__SETTINGS_PUTS__);
const last10 = puts10[puts10.length - 1];
assert("S10d model 对象合并（name + 子字段）",
  last10 && last10.patch.model?.name === "m-new" && last10.patch.model?.maxToolCalls === -1,
  JSON.stringify(last10));
assert(
  "S10e 零脏字段（无 fastModel/language/空 id/permissions/mcpServers）",
  last10 &&
    !("fastModel" in last10.patch) &&
    !("permissions" in last10.patch) &&
    !("mcpServers" in last10.patch) &&
    last10.patch.model && !("reasoningEffort" in last10.patch.model) &&
    (last10.patch.modelProviders?.openai?.[0]?.envKey === "OPENAI_API_KEY" &&
      !("id" in (last10.patch.modelProviders?.openai?.[0] || {}))),
  JSON.stringify(last10),
);
assert("S10f general 只剩 enableAutoUpdate",
  last10 && JSON.stringify(last10.patch.general) === JSON.stringify({ enableAutoUpdate: false }),
  JSON.stringify(last10));

// ── S7：l2 只读 ────────────────────────────────────────────────
await page.goto(`http://127.0.0.1:${port}/harness/page-cli.html?scen=l2`);
await sleep(500);
await page.getByText("Coding CLI（安装/升级/settings）", { exact: true }).first().click();
await sleep(500);
await page.getByRole("button", { name: /编辑配置/ }).first().click();
await sleep(400);
await page.evaluate(() => {
  const inputs = [...document.querySelectorAll("input")];
  const el = inputs.find((i) => i.value === "m1");
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  ).set;
  setter.call(el, "m9");
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.getByRole("button", { name: /保存改动/ }).click();
await sleep(400);
const t7 = await bodyText();
assert("S7a 403 错误消息", t7.includes("当前角色仅可查看，不能修改编码 CLI"), t7);
assert("S7b 只读横幅", t7.includes("当前角色仅可查看，不能修改编码 CLI。"), t7);

// ── S8：404 旧 Controller ──────────────────────────────────────
await page.goto(`http://127.0.0.1:${port}/harness/page-cli.html?scen=404`);
await sleep(500);
await page.getByText("Coding CLI（安装/升级/settings）", { exact: true }).first().click();
await sleep(500);
const t8 = await bodyText();
assert(
  "S8 404 暂不可用横幅",
  t8.includes("该 Worker 的编码 CLI 管理暂不可用，升级 AgentTeams 后自动生效。"),
  t8,
);

// ── 收尾：pageerror 零容忍 ─────────────────────────────────────
assert("P0 全程无 pageerror", pageErrors.length === 0, pageErrors.join(" | "));

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
await browser.close();
server.close();
process.exit(failed.length ? 1 : 0);
