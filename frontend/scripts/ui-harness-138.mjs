/**
 * ui-harness-138.mjs — v0.5.0-beta.13.8 UI 实证（playwright-core + chromium）
 *
 * 场景：真实 React + antd（node_modules UMD）挂载 WorkerRuntimeConfig 两实例
 * （#hrc = L2 只读 / #hrc1 = L1 可编辑）+ fetch mock（验证实盘结构 RC）。
 *
 * 断言（13.7 装验「六项都做进去了吗 + 模板抄 QwenPaw + 词元/令牌术语」）：
 * ① 七 tab 全在（ReAct 智能体/智能体 Loop 设置/LLM 自动重试/LLM 并发限流/
 *    上下文管理/长期记忆/系统只读）
 * ② L2：ReAct tab shell 组只读；并发限流 tab 出 L1-only 警示 + 控件 disabled
 * ③ L1：ReAct tab shell 超时 InputNumber=60 / 可执行文件=/bin/sh / 自动标题 on
 * ④ L1：并发限流 5 值 2/30/5/1/60；上下文管理 backend=light、divisor=4
 * ⑤ L1：长期记忆 backend=remelight、dream cron=0 23 * * *
 * ⑥ Loop tab：Loop 模板区（4 模板 tag）→ 质量优先 → 4 gate 勾选 →
 *    「按模板创建自定义模式」弹窗 → 管道预览 4 tag
 * ⑦ 术语：Goal 节「词元预算」+ Mission 节「每个 Story 最大重试次数」
 * ⑧ 无 pageerror
 *
 * 运行：python3 -m http.server 8791 &  node scripts/ui-harness-138.mjs
 */
import { chromium } from "playwright-core";

const results = [];
function report(name, ok, extra = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
}

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium" });
const page = await browser.newPage({ viewport: { width: 1280, height: 2000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("http://127.0.0.1:8791/harness/page.html", { waitUntil: "load" });
await page.waitForTimeout(500);

async function expand(sel) {
  await page.locator(sel).getByText("运行配置", { exact: false }).first().click();
  await page.waitForSelector(`${sel} .ant-tabs`, { timeout: 5000 });
  await page.waitForTimeout(400);
}
const clickTab = (sel, label) =>
  page.locator(`${sel} .ant-tabs-tab`).getByText(label, { exact: true }).click();

// ── ① 七 tab 全在（L2 实例）─────────────────────────────────────
await expand("#hrc");
const tabs = [
  "ReAct 智能体",
  "智能体 Loop 设置",
  "LLM 自动重试",
  "LLM 并发限流",
  "上下文管理",
  "长期记忆",
  "系统（只读）",
];
for (const t of tabs) {
  const c = await page
    .locator("#hrc .ant-tabs-tab")
    .getByText(t, { exact: true })
    .count();
  report(`① tab 在：${t}`, c === 1, `count=${c}`);
}

// ── ② L2：只读门控 ────────────────────────────────────────────
// ReAct tab（默认激活）：Shell 超时行 = 只读文本（无 InputNumber）
const shellRow = page.locator("#hrc .ant-tabs-tabpane-active").getByText("Shell 超时").first();
await shellRow.waitFor({ timeout: 3000 });
const shellRowText = await shellRow.locator("xpath=..").innerText();
report("② L2 Shell 超时只读=60 秒", shellRowText.includes("60"), shellRowText.replace(/\n/g, " ").slice(0, 40));
const shellInputs = await page
  .locator("#hrc .ant-tabs-tabpane-active")
  .getByText("Shell 超时")
  .locator("xpath=..")
  .locator(".ant-input-number")
  .count();
report("② L2 Shell 超时无 InputNumber", shellInputs === 0, `count=${shellInputs}`);

// 并发限流 tab：L1-only 警示 + 全部 disabled
await clickTab("#hrc", "LLM 并发限流");
await page.waitForTimeout(300);
const l1Alert = await page
  .locator("#hrc .ant-tabs-tabpane-active")
  .getByText("L1-only 字段", { exact: false })
  .count();
report("② L2 并发限流出 L1-only 警示", l1Alert >= 1, `count=${l1Alert}`);
const disabledRate = await page
  .locator("#hrc .ant-tabs-tabpane-active .ant-input-number-disabled")
  .count();
report("② L2 并发限流 5 控件全 disabled", disabledRate === 5, `count=${disabledRate}`);

// ── ③ L1：ReAct tab 可编辑 ───────────────────────────────────
await expand("#hrc1");
const l1ShellRow = page
  .locator("#hrc1 .ant-tabs-tabpane-active")
  .getByText("Shell 超时")
  .first();
await l1ShellRow.waitFor({ timeout: 3000 });
const l1ShellInput = l1ShellRow.locator("xpath=..").locator(".ant-input-number-input");
await l1ShellInput.waitFor({ timeout: 3000 });
report("③ L1 Shell 超时 InputNumber=60", (await l1ShellInput.inputValue()) === "60");
const l1ExecInput = page
  .locator("#hrc1 .ant-tabs-tabpane-active")
  .getByText("Shell 可执行文件")
  .locator("xpath=..")
  .locator("input.ant-input");
report("③ L1 Shell 可执行文件=/bin/sh", (await l1ExecInput.inputValue()) === "/bin/sh");
const l1AutoTitle = page
  .locator("#hrc1 .ant-tabs-tabpane-active")
  .getByText("自动标题")
  .locator("xpath=..")
  .locator(".ant-switch-checked");
report("③ L1 自动标题 switch=on", (await l1AutoTitle.count()) === 1);

// ── ④ L1：并发限流 + 上下文管理 ─────────────────────────────
await clickTab("#hrc1", "LLM 并发限流");
await page.waitForTimeout(300);
const rateVals = [];
for (const i of [0, 1, 2, 3, 4]) {
  rateVals.push(await page.locator("#hrc1 .ant-tabs-tabpane-active .ant-input-number-input").nth(i).inputValue());
}
report("④ L1 并发限流 5 值 2/30/5/1/60", JSON.stringify(rateVals) === JSON.stringify(["2", "30", "5", "1", "60"]), JSON.stringify(rateVals));
const l1Alert2 = await page
  .locator("#hrc1 .ant-tabs-tabpane-active")
  .getByText("L1-only 字段", { exact: false })
  .count();
report("④ L1 并发限流无 L1-only 警示", l1Alert2 === 0);

await clickTab("#hrc1", "上下文管理");
await page.waitForTimeout(300);
const ctxPane = "#hrc1 .ant-tabs-tabpane-active";
const backendText = await page.locator(`${ctxPane} .ant-select-selection-item`).first().innerText();
report("④ L1 上下文后端=light", backendText.includes("light"), backendText);
const divisorInput = page
  .locator(ctxPane)
  .getByText("词元估算除数")
  .locator("xpath=..")
  .locator(".ant-input-number-input");
// antd InputNumber step=0.5 按小数位格式化 → 实值 4 显示 "4.0"（与实盘 4.0 一致）。
report("④ L1 词元估算除数=4", Number(await divisorInput.inputValue()) === 4, await divisorInput.inputValue());
const recentN = page
  .locator(ctxPane)
  .getByText("近期保留条数")
  .locator("xpath=..")
  .locator(".ant-input-number-input");
report("④ L1 近期保留条数=2", (await recentN.inputValue()) === "2");
const exemptExt = page
  .locator(ctxPane)
  .getByText("裁剪豁免扩展名")
  .locator("xpath=..")
  .locator("input.ant-input");
report("④ L1 裁剪豁免扩展名=.md", (await exemptExt.inputValue()) === ".md", await exemptExt.inputValue());

// ── ⑤ L1：长期记忆 ──────────────────────────────────────────
await clickTab("#hrc1", "长期记忆");
await page.waitForTimeout(300);
const memPane = "#hrc1 .ant-tabs-tabpane-active";
const memBackendText = await page.locator(`${memPane} .ant-select-selection-item`).first().innerText();
report("⑤ L1 记忆后端=remelight", memBackendText.includes("remelight"), memBackendText);
const cronInput = page
  .locator(memPane)
  .getByText("Dream 定时任务")
  .locator("xpath=..")
  .locator("input.ant-input");
report("⑤ L1 dream cron=0 23 * * *", (await cronInput.inputValue()) === "0 23 * * *", await cronInput.inputValue());
const dreamOn = page
  .locator(memPane)
  .getByText("Dream 定时任务")
  .locator("xpath=..")
  .locator(".ant-switch-checked");
report("⑤ L1 dream 开关=on", (await dreamOn.count()) === 1);
const intervalInput = page
  .locator(memPane)
  .getByText("自动记忆间隔（分钟）")
  .locator("xpath=..")
  .locator(".ant-input-number-input");
report("⑤ L1 自动记忆间隔=5", (await intervalInput.inputValue()) === "5");

// ── ⑥ Loop 模板（L1 实例）──────────────────────────────────
await clickTab("#hrc1", "智能体 Loop 设置");
await page.waitForTimeout(300);
const loopPane = "#hrc1 .ant-tabs-tabpane-active";
report("⑥ Loop 模板节存在", (await page.locator(loopPane).getByText("Loop 模板", { exact: true }).count()) >= 1);
for (const t of ["安全运行", "预算研究", "质量优先", "空管道"]) {
  // tag 内含 id 副串（"安全运行 safe"）→ 子串匹配。
  report(`⑥ 模板 tag 在：${t}`, (await page.locator(loopPane).getByText(t).count()) >= 1);
}
// 选「质量优先」→ 4 gate 勾选
await page.locator(loopPane).getByText("质量优先").click();
await page.waitForTimeout(200);
const checkedCount = await page
  .locator(loopPane)
  .locator(".ant-checkbox-checked")
  .count();
report("⑥ 质量优先 → 4 gate 勾选", checkedCount === 4, `count=${checkedCount}`);
// 打开创建弹窗 → 管道预览 4 tag
await page.locator(loopPane).getByText("按模板创建自定义模式", { exact: true }).click();
await page.waitForTimeout(300);
const modal = page.locator(".ant-modal");
await modal.waitFor({ timeout: 3000 });
const previewTags = await modal
  .getByText("管道预览", { exact: true })
  .locator("xpath=..")
  .locator(".ant-tag")
  .count();
report("⑥ 弹窗管道预览 4 tag", previewTags === 4, `count=${previewTags}`);
await modal.locator(".ant-modal-close").click();
await page.waitForTimeout(200);

// ── ⑦ 术语（词元/Story）──────────────────────────────────
// Goal 节展开 → 「词元预算」
const goalHead = page.locator(loopPane).getByText("Goal 模式 · 内置参数");
if ((await goalHead.count()) > 0) {
  await goalHead.click();
  await page.waitForTimeout(200);
}
report("⑦ Goal 节「词元预算」", (await page.locator(loopPane).getByText("词元预算").count()) >= 1);
const missionHead = page.locator(loopPane).getByText("Mission 模式 · 内置参数");
if ((await missionHead.count()) > 0) {
  await missionHead.click();
  await page.waitForTimeout(200);
}
report(
  "⑦ Mission 节「每个 Story 最大重试次数」",
  (await page.locator(loopPane).getByText("每个 Story 最大重试次数").count()) >= 1,
);
// 旧术语「令牌预算」「每故事重试」不得再出现
report("⑦ 旧术语「令牌预算」已清除", (await page.locator(loopPane).getByText("令牌预算", { exact: true }).count()) === 0);

// ── ⑧ 无 pageerror ─────────────────────────────────────────
report("⑧ 无 pageerror", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
