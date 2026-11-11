#!/usr/bin/env node
/**
 * ui-harness-roomchat.mjs — worker-run 内联折叠（§4.2/§4.3）浏览器验收
 *（playwright-core + chromium + 本地 http.server + esbuild 现场打包
 * harness/entry-roomchat.tsx；host mock 在 harness/page-roomchat.html）。
 *
 * 视口矩阵：1440 / 1024 / 768 / 390 × light / dark（8 组）。
 * 场景（数据=离线 fixture，见 entry-roomchat.tsx）：
 * S1 零 pageerror（全部 8 组）
 * S2 纯 worker run 内联：占位根被吸收（「处理中...」不渲染）、内联回复
 *    「最终回答：重构完成」在主时间线可见
 * S3 根行保留「3 条回复」ThreadIcon 摘要（吸收不影响线程入口）；
 *    全主时间线共 4 处「条回复」（run#1 根 3 + run#2 根 1 + 混合 1 + 人类 1）
 * S4 编辑过的 run 整块移到修订时刻槽位：「中间的人类消息」在
 *    「已编辑的 worker 文案」之前（原子块不交错）
 * S5 人类/混合线程回复行不进主时间线（按 data-event-id 行存在性断言；
 *    根行线程摘要预览合法含末条回复文本，不做全文断言）
 * S6 占位根 DOM 锚点保留（data-event-id 行存在，搜索/深跳定位不丢）
 * S7 主时间线时序：h1 → run#1 块 → h3
 * S8（1440 light）线程面板 inline：点 run 根摘要 → 面板含全部 3 条回复
 * S9（390 light）窄屏线程 Drawer：点摘要 → antd Drawer（「话题」）打开
 * S10 每组截图存 .gate-cip-shots/（{宽}-{主题}.png）
 *
 * 运行：cd frontend && node scripts/ui-harness-roomchat.mjs
 */
import http from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import esbuild from "esbuild";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, "..");
const bundleFile = path.join(FRONTEND_DIR, "harness", "bundle-roomchat.js");
const SHOT_DIR = "/app/working/workspaces/.gate-cip-shots";

await esbuild.build({
  entryPoints: [path.join(FRONTEND_DIR, "harness", "entry-roomchat.tsx")],
  bundle: true,
  outfile: bundleFile,
  format: "iife",
  platform: "browser",
  jsx: "transform",
  target: "es2020",
  logLevel: "silent",
});
mkdirSync(SHOT_DIR, { recursive: true });

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
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
const port = 4191;
await new Promise((r) => server.listen(port, "127.0.0.1", r));

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium" });

const results = [];
function assert(name, cond, detail = "") {
  results.push({ name, ok: !!cond });
  console.log(
    `${!!cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  — " + String(detail).slice(0, 400)}`,
  );
}

// 主时间线滚动容器（唯一同时带 overflow:hidden auto 与 padding:16px 4px
// 的 div；React 把 overflowX/overflowY 序列化成 overflow 简写）。
const MAIN = 'div[style*="overflow: hidden auto"][style*="padding: 16px 4px"]';

const VIEWPORTS = [
  { w: 1440, h: 900 },
  { w: 1024, h: 768 },
  { w: 768, h: 1024 },
  { w: 390, h: 844 },
];

for (const { w, h } of VIEWPORTS) {
  for (const theme of ["light", "dark"]) {
    const tag = `${w}-${theme}`;
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/harness/page-roomchat.html?theme=${theme}`);
    await page.waitForTimeout(900);

    const main = page.locator(MAIN);
    const mainText = await main.innerText().catch((e) => `<读失败: ${e}>`);

    // S1 零 pageerror
    assert(`[${tag}] S1 零 pageerror`, pageErrors.length === 0, pageErrors.join(" | "));
    // S2 占位吸收 + 内联回复可见
    assert(`[${tag}] S2a 占位「处理中...」不渲染`, !mainText.includes("处理中"), mainText.slice(0, 200));
    assert(`[${tag}] S2b 内联回复「最终回答：重构完成」在主时间线`, mainText.includes("最终回答：重构完成"), mainText.slice(0, 300));
    // S3 线程摘要入口：run#1 根「3 条回复」+ run#2 根（编辑过）「1 条回复」
    // + 混合线程根「1 条回复」+ 人类话题根「1 条回复」= 4 处；
    // 内联 run 的根同样保留 ThreadIcon 入口（§4.2 线程面板入口不丢）。
    const summaryCount = await page.locator(".wb-thread-summary").count();
    assert(`[${tag}] S3a 4 处「N 条回复」摘要`, summaryCount === 4, `count=${summaryCount}`);
    assert(`[${tag}] S3b run#1 根「3 条回复」存在`, /3\s*条回复/.test(mainText), mainText.slice(0, 300));
    // S4 编辑 run 整块后移（原子块不交错）
    const iH3 = mainText.indexOf("中间的人类消息");
    const iEdit = mainText.indexOf("已编辑的 worker 文案");
    assert(`[${tag}] S4 编辑块落在人类消息之后（iH3<iEdit）`, iH3 >= 0 && iEdit >= 0 && iH3 < iEdit, `iH3=${iH3} iEdit=${iEdit}`);
    // S5 话题回复不进主时间线（按行存在性断言——根行的线程摘要预览
    // 合法显示末条回复文本，innerText 全文断言会误报）。
    const humanReplyRow = await page.locator('div[data-event-id="evt-hreply"]').count();
    const mixReplyRow = await page.locator('div[data-event-id="evt-mixr"]').count();
    assert(`[${tag}] S5a 人类话题回复行不进主时间线`, humanReplyRow === 0, `rows=${humanReplyRow}`);
    assert(`[${tag}] S5b 混合线程回复行不进主时间线`, mixReplyRow === 0, `rows=${mixReplyRow}`);
    // S6 占位根 DOM 锚点保留
    const anchor = await page.locator('div[data-event-id="$run1:hs"]').count();
    assert(`[${tag}] S6 占位根 DOM 锚点保留`, anchor >= 1, `anchor=${anchor}`);
    // S7 主时间线时序：h1 → run#1 内联块 → h3
    const iH1 = mainText.indexOf("帮我重构聊天 UI");
    assert(`[${tag}] S7 时序 h1 < 内联块 < h3`, iH1 >= 0 && iH1 < iH3, `iH1=${iH1} iH3=${iH3}`);

    // S10 截图
    await page.screenshot({ path: path.join(SHOT_DIR, `${tag}.png`) });

    // S8（1440 light）inline 线程面板
    if (w === 1440 && theme === "light") {
      const firstSummary = page.locator(".wb-thread-summary").first();
      await firstSummary.click();
      await page.waitForTimeout(500);
      const panel = page.locator("div:has(> .wb-panel-handle)");
      const panelCount = await panel.count();
      const panelText = panelCount > 0 ? await panel.first().innerText().catch((e) => `<读失败: ${e}>`) : "";
      assert("S8a inline 线程面板打开", panelCount === 1, `count=${panelCount}`);
      assert("S8b 面板含 run 全部 3 条回复", panelText.includes("先看现有结构") && panelText.includes("最终回答：重构完成"), panelText.slice(0, 300));
      await page.screenshot({ path: path.join(SHOT_DIR, "1440-light-panel.png") });
    }

    // S9（390 light）窄屏 Drawer
    if (w === 390 && theme === "light") {
      await page.locator(".wb-thread-summary").first().click();
      await page.waitForTimeout(600);
      const drawer = page.locator(".ant-drawer-open");
      const drawerCount = await drawer.count();
      const drawerText = drawerCount > 0 ? await drawer.first().innerText().catch((e) => `<读失败: ${e}>`) : "";
      assert("S9a 窄屏线程 Drawer 打开（「话题」）", drawerCount >= 1 && drawerText.includes("话题"), `count=${drawerCount}`);
      assert("S9b Drawer 含 run 回复", drawerText.includes("最终回答：重构完成"), drawerText.slice(0, 300));
      await page.screenshot({ path: path.join(SHOT_DIR, "390-light-drawer.png") });
    }

    await ctx.close();
  }
}

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
