/**
 * ui-harness-137.mjs — v0.5.0-beta.13.7 UI 实证（playwright-core + chromium）
 *
 * 场景：真实 React + antd（node_modules UMD）挂载四个目标组件 + fetch mock
 * （QwenPaw 消息 JSON 结构正源：type/role/content[{text}|{data.data.name/...}]）。
 *
 * 断言（13.6 四修对应；①② 按现行卡片列表/分组口径对齐）：
 * ① 会话列表（卡片列表）：session_id 卡片元行常显 + 整卡点击进详情、返回列表可回
 * ② 会话详情：工具组折叠「2 步」pill×2 收起无子行、点开懒渲染、轮尾最终文本
 * markdown 直显、带文本 assistant（含 reasoning）独立气泡
 * ③ 运行配置：基本 tab 无滑杆、迭代门 InputNumber=80、重复保护窗口=4（window_size）、
 * 改值→保存按钮点亮（diff 生效）
 * ④ 聊天渲染：ToolBubble 状态色（❌ 红）+ 展开分区（参数/错误）、
 * CodeBlock 复制钮 hover 才现
 *
 * 运行：python3 -m http.server 8765 & node scripts/ui-harness-137.mjs
 */
import { chromium } from "playwright-core";

const results = [];
function report(name, ok, extra = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
}

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium" });
const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("http://127.0.0.1:8791/harness/page.html", { waitUntil: "load" });
// 期望来源：WorkerChats.tsx——列表由 antd Table 改为卡片列表（整卡点击进详情），
// 以卡片「查看」link 钮作列表就绪锚点。
await page.waitForSelector("#hc .ant-btn-link", { timeout: 8000 });
await page.waitForTimeout(400);

// ── ① WorkerChats 列表（卡片列表）──────────────────────────────────
// 期望来源：WorkerChats.tsx 卡片列表——session_id 在卡片元行常显
// （不再有点击展开/收起交互）；整卡可点进详情，详情头「会话列表」钮返回列表。
const card = page.locator("#hc .ant-btn-link").first().locator("xpath=../..");
await card.waitFor({ timeout: 5000 });
const cardText = await card.innerText();
report("① 卡片列表常显 session_id", cardText.includes("sess-abc-123"), cardText.replace(/\n/g, " ").slice(0, 60));
// 点卡片进详情（现行等价于旧「点击展开」），再返回列表供 ② 经「查看」重新进入
await card.click();
await page.waitForSelector("#hc .ant-alert", { timeout: 5000 });
await page.locator("#hc").getByText("会话列表", { exact: true }).click();
await page.waitForSelector("#hc .ant-btn-link", { timeout: 5000 });
report("① 点卡片进详情/返回列表", (await page.locator("#hc .ant-btn-link").count()) >= 1);

// ── ② WorkerChats 详情（result-only 折叠）───────────────────────────
await page.locator("#hc").getByText("查看", { exact: true }).first().click();
await page.waitForSelector("#hc .ant-alert", { timeout: 5000 });
await page.waitForTimeout(300);
// 用户气泡右对齐
const userBubble = page.locator("#hc").getByText("帮我读一下 README", { exact: true }).first();
await userBubble.waitFor({ timeout: 5000 });
const ubBox = await userBubble.boundingBox();
const hcBox = await page.locator("#hc").boundingBox();
report("② 用户气泡右对齐", ubBox && hcBox ? ubBox.x > hcBox.x + hcBox.width * 0.5 : false);
// 最终文本（轮 1 结果）直显
const finalText = page.locator("#hc").getByText("文件内容是", { exact: false }).first();
await finalText.waitFor({ timeout: 3000 });
// 步骤 pill：期望来源 WorkerChatsShared.tsx groupTurns/msgKind（QwenPaw 对话框
// 口径）——带文本的 assistant 消息（含 reasoning）独立成气泡，仅 tool/无文本
// 消息折叠成 pill；mock 两个工具组各 call+output=2 项 → 两个「2 步」pill。
const pill2 = page.locator("#hc").getByText("2 步", { exact: true });
await pill2.first().waitFor({ timeout: 3000 });
const pill2Count = await pill2.count();
report("② 轮 1 工具组折叠为「2 步」", pill2Count >= 1, `count=${pill2Count}`);
report("② 轮 2 工具组折叠为「2 步」", pill2Count >= 2, `count=${pill2Count}`);
// 收起时子行不渲染（懒渲染）：read_file 步骤行不可见
const stepVisible = await page.locator("#hc").getByText("read_file", { exact: true }).count();
report("② 收起时步骤子行不渲染", stepVisible === 0, `count=${stepVisible}`);
// 点开第一个 pill → 懒渲染出 read_file（bash 组仍收起）
await pill2.first().click();
await page.waitForTimeout(200);
const afterOpen = await page.locator("#hc").getByText("read_file", { exact: true }).count();
report("② 点开懒渲染步骤行", afterOpen >= 1, `count=${afterOpen}`);
// 步骤行含参数预览（read_file 的 path）
const argsPreview = await page.locator("#hc").getByText("path", { exact: false }).count();
report("② 步骤行含参数预览", argsPreview >= 1);

// ── ③ WorkerRuntimeConfig ──────────────────────────────────────────
// 展开折叠头
await page.locator("#hrc").getByText("运行配置", { exact: false }).first().click();
await page.waitForSelector("#hrc .ant-tabs", { timeout: 5000 });
await page.waitForTimeout(400);
// 基本 tab：无滑杆
const sliderCount = await page.locator("#hrc .ant-slider").count();
report("③ 基本 tab 无滑杆", sliderCount === 0, `count=${sliderCount}`);
// 最大迭代只读行 = 80（label 格含 ⓘ，取整行断言）
const iterRowCell = page.locator("#hrc .ant-tabs-tabpane-active").getByText("最大迭代").first();
await iterRowCell.waitFor({ timeout: 3000 });
const iterRowText = await iterRowCell.locator("xpath=..").innerText();
report("③ 基本 tab 最大迭代只读=80", iterRowText.includes("80"), iterRowText.replace(/\n/g, " ").slice(0, 40));
// Agent Loop tab：gate 编辑器
// 13.8：tab 改名「Agent Loop」→「智能体 Loop 设置」（六 tab 补齐）。
await page.locator("#hrc .ant-tabs-tab").getByText("智能体 Loop 设置", { exact: true }).click();
await page.waitForTimeout(300);
const gatePipeline = page.locator("#hrc").getByText("Default 模式 · gate 管道", { exact: true });
await gatePipeline.waitFor({ timeout: 3000 });
report("③ gate 管道节存在", (await gatePipeline.count()) >= 1);
// 迭代门展开 → InputNumber 值 80
await page.locator("#hrc").getByText("迭代限制", { exact: true }).click();
await page.waitForTimeout(200);
const iterInput = page.locator("#hrc .ant-input-number-input").first();
await iterInput.waitFor({ timeout: 3000 });
const iterVal = await iterInput.inputValue();
report("③ iteration 门 InputNumber=80", iterVal === "80", `value=${iterVal}`);
// 重复保护门展开 → 窗口=4（window_size 键名修正确认）
await page.locator("#hrc").getByText("重复保护", { exact: true }).click();
await page.waitForTimeout(200);
const windowInputs = page.locator("#hrc .ant-input-number-input");
const n = await windowInputs.count();
let windowVal = "";
for (let i = 0; i < n; i++) {
  const v = await windowInputs.nth(i).inputValue();
  if (v === "4") windowVal = v;
}
report("③ doom_loop 窗口=4（window_size 正源）", windowVal === "4", `inputs=${n}`);
// 干预规则行存在（stages 渲染）
const stagesRow = await page.locator("#hrc").getByText("干预规则", { exact: true }).count();
report("③ doom_loop stages 规则行", stagesRow >= 1);
// Goal/Mission 参数节
const goalSec = await page.locator("#hrc").getByText("Goal 模式 · 内置参数", { exact: true }).count();
const missionSec = await page.locator("#hrc").getByText("Mission 模式 · 内置参数", { exact: true }).count();
report("③ Goal/Mission 参数节", goalSec >= 1 && missionSec >= 1);
// 改 iteration → 保存按钮点亮（diff 生效）。antd 两字 CJK 按钮自动插空格（「保 存」）。
const saveBtn = page.locator("#hrc").getByRole("button", { name: /保\s*存/ });
report("③ 未改动时保存禁用", (await saveBtn.count()) >= 1 && (await saveBtn.first().isDisabled()));
await iterInput.fill("100");
await page.waitForTimeout(200);
report("③ 改动后保存点亮", !(await saveBtn.first().isDisabled()));
// 系统 tab：期望来源 WorkerRuntimeConfigView.tsx——tab label = tr("系统")，
// pane 内嵌 ApprovalControl（与团队管理卡同源的审批策略四档卡）；锚点用其
// 固定描述行（ApprovalControl.tsx「配置工具调用的审批策略…」）。限速器行
// 仍不在本 tab（独立「LLM 并发限流」tab，见 ui-harness-138）。
await page.locator("#hrc .ant-tabs-tab").getByText("系统", { exact: true }).click();
await page.waitForTimeout(200);
const sysPane = "#hrc .ant-tabs-tabpane-active";
const apprRows = await page.locator(sysPane).getByText("配置工具调用的审批策略").count();
const rateRows = await page.locator(sysPane).getByText("LLM 并发上限").count();
report("③ 系统 tab 内嵌审批策略控件", apprRows >= 1 && rateRows === 0, `appr=${apprRows} rate=${rateRows}`);

// ── ④ RoomChat ToolBubble + MdText CodeBlock ───────────────────────
const roomPane = page.locator("#hroom");
await roomPane.getByText("read_file", { exact: true }).first().waitFor({ timeout: 3000 });
// ❌ 失败工具名红色
const failNames = roomPane.locator("span").filter({ hasText: /^bash$/ });
const failName = failNames.first();
const failColor = await failName.evaluate((el) => getComputedStyle(el).color);
report("④ 失败工具名红色", failColor === "rgb(229, 72, 77)", failColor);
// 展开失败气泡 → 「错误」分区
const failBubble = roomPane.locator("div[title]").filter({ hasText: "bash" }).first();
await failBubble.click();
await page.waitForTimeout(150);
const errLabel = await roomPane.getByText("错误", { exact: true }).count();
report("④ 失败展开显「错误」区", errLabel >= 1);
// 展开调用气泡 → 「参数」分区
const callBubble = roomPane.locator("div[title]").filter({ hasText: "read_file" }).first();
await callBubble.click();
await page.waitForTimeout(150);
const argsLabel = await roomPane.getByText("参数", { exact: true }).count();
report("④ 调用展开显「参数」区", argsLabel >= 1);
// CodeBlock 复制钮 hover 才现
const copyWrap = page.locator("#hmd span[style*='opacity']").first();
const preOpacity = await copyWrap.evaluate((el) => getComputedStyle(el).opacity);
report("④ CodeBlock 复制钮默认隐藏", preOpacity === "0", `opacity=${preOpacity}`);
await copyWrap.hover();
await page.waitForTimeout(250);
const hoverOpacity = await copyWrap.evaluate((el) => getComputedStyle(el).opacity);
report("④ CodeBlock hover 显复制钮", hoverOpacity === "1", `opacity=${hoverOpacity}`);

// ── 页面级错误 ─────────────────────────────────────────────────────
const jsErrors = errors.filter((e) => !/Download the React DevTools/i.test(e));
report("页面无 JS 异常", jsErrors.length === 0, jsErrors.slice(0, 2).join(" | ").slice(0, 120));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
process.exit(failed.length ? 1 : 0);
