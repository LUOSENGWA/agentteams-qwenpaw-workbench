/**
 * ui-harness-1324.mjs — v0.5.0-beta.13.24 UI 实证（playwright + 本地 http.server）。
 *
 * 覆盖 13.24 六件装验反馈的 UI 面：
 *   A1  F4 未读气泡：数字居中 + 永不含住外（87 全显 / 12345 → 99+ / 1 全显）
 *   A2  F5 DAG/Mermaid 合并：拓扑视图单一 DAG（无 Mermaid 切换件），
 *       层行居中布局，节点 hover 描边加粗
 *   A3  F6 团队配置批量改模型：「批量设置模型」区 + Leader/Workers 双画笔，
 *       刷值 → 对应角色行模型框同步 + 「模型已改动」diff 标
 *   A4  F3 运行配置「系统」tab：审批级别内嵌 ApprovalControl（可编辑）
 *
 * 运行：
 *   cd frontend && node scripts/ui-harness-1324.mjs
 */
import http from "node:http";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, "..");
const distFile = path.join(FRONTEND_DIR, "..", "dist", "index.js");
const bundleFile = path.join(FRONTEND_DIR, "harness", "bundle-1324.js");
const pageFile = path.join(FRONTEND_DIR, "harness", "page-1324.html");

const tmpDir = path.join(FRONTEND_DIR, "harness", ".tmp");
mkdirSync(tmpDir, { recursive: true });
writeFileSync(
  path.join(tmpDir, "index.js"),
  readFileSync(distFile),
);

const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || "/").split("?")[0]);
  if (url.endsWith("/")) url += "index.html";
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

const port = 4174;
await new Promise((r) => server.listen(port, "127.0.0.1", r));

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
});
const page = await ctx.newPage();

const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

const results = [];
function assert(name, cond, detail = "") {
  results.push({ name, ok: !!cond, detail: String(detail).slice(0, 300) });
  console.log(`${!!cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  — " + detail}`);
}

const base = `http://127.0.0.1:${port}/`;
try {
  await page.goto(base + "harness/page-1324.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);

  // ── A1：F4 未读气泡 ─────────────────────────────────────────────
  const a1 = page.locator("#a1");
  await a1.waitFor({ timeout: 8000 });
  const bubble87 = a1.getByText("87", { exact: true }).first();
  const bubble99 = a1.getByText("99+", { exact: true }).first();
  const bubble1 = a1.getByText("1", { exact: true }).first();
  assert("A1 未读 87 全显（不截断）", (await bubble87.count()) > 0, "87 未找到");
  assert("A1 未读 12345 → 99+ 截断", (await bubble99.count()) > 0, "99+ 未找到");
  assert("A1 未读 1 全显", (await bubble1.count()) > 0, "1 未找到");
  // 几何：气泡=单个 flex span（UnreadBubble）——
  //  ① 含住：scrollWidth/scrollHeight ≤ clientWidth/clientHeight（零溢出）
  //  ② 居中：Range 实测文字盒 vs span 盒，水平/垂直偏差 <2px
  const bubble87span = await page.evaluate(() => {
    const span = [...document.querySelectorAll("#a1 span")].find(
      (s) => s.textContent === "87" && s.style.position === "absolute",
    );
    if (!span) return null;
    const sr = span.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(span);
    const tr = range.getBoundingClientRect();
    return {
      overflow: {
        x: span.scrollWidth - span.clientWidth,
        y: span.scrollHeight - span.clientHeight,
      },
      cx: Math.abs(sr.x + sr.width / 2 - (tr.x + tr.width / 2)),
      cy: Math.abs(sr.y + sr.height / 2 - (tr.y + tr.height / 2)),
    };
  });
  assert(
    "A1 气泡盒包住数字（零溢出）",
    bubble87span && bubble87span.overflow.x <= 0 && bubble87span.overflow.y <= 0,
    bubble87span
      ? `overflowX=${bubble87span.overflow.x} overflowY=${bubble87span.overflow.y}`
      : "气泡 span 未找到",
  );
  assert(
    "A1 数字水平+垂直居中（偏差 <2px）",
    bubble87span && bubble87span.cx < 2 && bubble87span.cy < 2,
    bubble87span ? `dx=${bubble87span.cx.toFixed(2)} dy=${bubble87span.cy.toFixed(2)}` : "气泡 span 未找到",
  );

  // ── A2：F5 DAG 单一视图 + 居中 + hover ─────────────────────────
  const a2 = page.locator("#a2");
  await a2.waitFor({ timeout: 8000 });
  // DAG/Mermaid 样式切换件退役——断言无任何 Segmented 选项含 DAG/Mermaid
  // （视图选择器 Segmented——项目列表/项目卡片/看板/拓扑——保留，属正常）。
  const segItems = await a2
    .locator(".ant-segmented-item-label")
    .allTextContents();
  const dagMermaidSeg = segItems.filter((t) => /Mermaid|DAG/i.test(t));
  assert("A2 无 DAG/Mermaid 样式切换件", dagMermaidSeg.length === 0, `选项=${segItems.join(",")}`);
  const mermaidText = (await a2.getByText(/Mermaid/i).count());
  assert("A2 拓扑区无 Mermaid 字样", mermaidText === 0, `出现 ${mermaidText} 处`);
  // DAG svg = 含 200 宽节点 rect 的 svg（排除图标 svg）
  const svgInfo = await a2.evaluate(() => {
    const svgs = [...document.querySelectorAll("#a2 svg")];
    const dag = svgs.find((s) =>
      [...s.querySelectorAll("rect")].some(
        (r) => r.getAttribute("width") === "200",
      ),
    );
    if (!dag) return null;
    const rects = [...dag.querySelectorAll("rect")].filter(
      (r) => r.getAttribute("width") === "200",
    );
    if (rects.length < 3) return null;
    // 按 y 分组出层
    const layers = new Map();
    for (const r of rects) {
      const y = r.getAttribute("y");
      if (!layers.has(y)) layers.set(y, []);
      layers.get(y).push(r);
    }
    const groups = [...layers.values()];
    const single = groups.find((g) => g.length === 1);
    const multi = groups.find((g) => g.length > 1);
    if (!single || !multi) return null;
    const s = single[0].getBoundingClientRect();
    const m0 = multi[0].getBoundingClientRect();
    const m1 = multi[multi.length - 1].getBoundingClientRect();
    return {
      singleCx: s.x + s.width / 2,
      rowCx: (m0.x + m1.x + m1.width) / 2,
    };
  });
  assert("A2 DAG svg 渲染（≥3 节点）", svgInfo !== null, "未找到节点 rect=200 的 svg");
  assert(
    "A2 层行水平居中（单节点行中心 ≈ 多节点行中心 ±8px）",
    svgInfo && Math.abs(svgInfo.singleCx - svgInfo.rowCx) < 8,
    svgInfo ? `single=${svgInfo.singleCx.toFixed(1)} row=${svgInfo.rowCx.toFixed(1)}` : "层不足",
  );
  // hover：滚动进视口后真鼠标移到节点中心 → stroke-width 加粗到 2
  const nodeRect = a2.locator("rect[width='200']").first();
  await nodeRect.scrollIntoViewIfNeeded();
  const swBefore = await nodeRect.evaluate((r) => r.getAttribute("stroke-width"));
  const nb = await nodeRect.boundingBox();
  if (nb) {
    await page.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2);
  }
  await page.waitForTimeout(250);
  const swAfter = await nodeRect.evaluate((r) => r.getAttribute("stroke-width"));
  assert(
    "A2 节点 hover 描边加粗（→2）",
    swAfter === "2" && swBefore !== "2",
    `before=${swBefore} after=${swAfter}`,
  );

  // ── A3：F6 批量改模型（antd Modal 传送门在 body 下，作用域用 .ant-modal）
  const a3 = page.locator("#a3");
  await a3.waitFor({ timeout: 8000 });
  await a3.locator("#a3-open-config").click();
  const modal = page.locator(".ant-modal").first();
  const batchHeader = modal.getByText("批量设置模型", { exact: false }).first();
  await batchHeader.waitFor({ timeout: 10000 });
  assert("A3 弹窗出现「批量设置模型」区", (await batchHeader.count()) > 0);
  assert(
    "A3 Leader 批标签（1 人）",
    (await modal.getByText("Leader 批（1 人）").count()) > 0,
    "Leader 批标签未找到",
  );
  assert(
    "A3 Workers 批标签（2 人）",
    (await modal.getByText("Workers 批（2 人）").count()) > 0,
    "Workers 批标签未找到",
  );
  // 画笔刷值：Leader 批选 model-new-a → leader 行模型框同步 + diff 标
  const leaderInput = modal
    .locator("div")
    .filter({ hasText: "Leader 批（1 人）" })
    .filter({ hasNotText: "Workers 批" })
    .locator("input")
    .first();
  await leaderInput.click();
  await leaderInput.fill("model-new-a");
  await page.waitForTimeout(400);
  // 检测用 inputValue（AutoComplete 值在 <input> 里，getByText 不匹配 input）：
  // 画笔框 + leader 行内框 = 2 个 input 的 value 应为 model-new-a
  const inputVals = await modal
    .locator("input")
    .evaluateAll((els) => els.map((e) => e.value));
  const newModelInputs = inputVals.filter((v) => v === "model-new-a").length;
  assert(
    "A3 Leader 批刷值 → 行内模型框同步",
    newModelInputs >= 2, // 画笔框 + leader 行内框
    `inputs=${JSON.stringify(inputVals.slice(0, 10))}`,
  );
  assert(
    "A3 刷值后行内「模型已改动」diff 标",
    (await modal.getByText("模型已改动", { exact: false }).count()) >= 1,
    "diff 标未出现",
  );
  // Workers 批独立：不刷 workers → worker 行仍是 model-old（2 个 input）
  const oldModelInputs = inputVals.filter((v) => v === "model-old").length;
  assert(
    "A3 Workers 批未刷 → worker 行保持原模型",
    oldModelInputs >= 2,
    `model-old input=${oldModelInputs}`,
  );
  // 关弹窗：先 Esc 关 AutoComplete 下拉，再 Esc 关 Modal（遮罩不挡 A4）
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);

  // ── A4：F3 运行配置「系统」tab 审批可编辑 ─────────────────────
  const a4 = page.locator("#a4");
  await a4.waitFor({ timeout: 8000 });
  // 点「运行配置」展开（页面深处，真点击命中检查易被视口/覆盖卡死 →
  // 滚动进视口后 dispatchEvent click，React 合成事件等效）
  const openTrigger = a4.getByText("运行配置", { exact: false }).first();
  await openTrigger.waitFor({ timeout: 8000 });
  await openTrigger.scrollIntoViewIfNeeded();
  await openTrigger.dispatchEvent("click");
  // 等 Tabs 出现
  const systemTab = a4.locator(".ant-tabs-tab", { hasText: "系统" }).first();
  await systemTab.waitFor({ timeout: 10000 });
  assert("A4 系统 tab 出现（标签=「系统」）", (await systemTab.count()) > 0);
  await systemTab.scrollIntoViewIfNeeded();
  await systemTab.dispatchEvent("click");
  await page.waitForTimeout(800);
  // ApprovalControl = 四档卡网格（非 Segmented）——可编辑证据 = 卡可点 +
  // 选中后出现「应用」钮
  const approvalSection = await a4
    .getByText("工具执行安全", { exact: false })
    .count();
  const smartCard = a4.getByText("智能模式", { exact: true }).first();
  const cardCount = await a4
    .getByText(/自动模式|智能模式|严格模式|关闭模式/, { exact: true })
    .count();
  assert(
    "A4 系统 tab 内嵌四档审批卡（非只读文本）",
    approvalSection >= 1 && cardCount >= 4,
    `section=${approvalSection} cards=${cardCount}`,
  );
  await smartCard.scrollIntoViewIfNeeded();
  await smartCard.dispatchEvent("click");
  await page.waitForTimeout(400);
  // 选中档卡后 footer 出现「应用: 智能模式」——regex 匹配（exact 会因
  // 「应用: 智能模式」整体文本而失配）
  const applyBtn = await a4.getByText(/应用\s*[:：]/).count();
  assert(
    "A4 点档卡 → 「应用」footer 出现（真可编辑）",
    applyBtn >= 1,
    `apply=${applyBtn}`,
  );

  // ── 全局：无页面错误 ────────────────────────────────────────────
  assert("无 pageerror", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} catch (e) {
  results.push({ name: "harness 异常", ok: false, detail: String(e).slice(0, 300) });
  console.log("FAIL  harness 异常 — " + String(e).slice(0, 300));
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
await browser.close();
server.close();
process.exit(passed === results.length ? 0 : 1);
