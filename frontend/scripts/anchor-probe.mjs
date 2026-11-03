#!/usr/bin/env node
// anchor-probe.mjs — 原生 overflow-anchor 在本容器 headless chromium 的
// 行为探针：scrollTop=0 时顶插 20 行，浏览器是否补偿 scrollTop 锚定视口。
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, "..");
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  const filePath = path.join(FRONTEND_DIR, url);
  if (!filePath.startsWith(FRONTEND_DIR)) { res.writeHead(403); res.end(); return; }
  try {
    const data = readFileSync(filePath);
    res.writeHead(200, { "Content-Type": url.endsWith(".html") ? "text/html" : "text/javascript" });
    res.end(data);
  } catch { res.writeHead(404); res.end("nf"); }
});
const port = 4190;
await new Promise((r) => server.listen(port, "127.0.0.1", r));
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium" });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
await page.goto(`http://127.0.0.1:${port}/harness/page-anchor-probe.html`);
await page.waitForTimeout(300);
const before = await page.evaluate(() => ({ top: __P__.top, height: __P__.height }));
await page.evaluate(() => __P__.prepend20());
await page.waitForTimeout(300);
const after = await page.evaluate(() => ({ top: __P__.top, height: __P__.height }));
console.log("before:", JSON.stringify(before));
console.log("after: ", JSON.stringify(after));
console.log(
  after.top > 1000
    ? "结论：原生 overflow-anchor 生效（scrollTop 补偿 ≈ 顶插高度）"
    : "结论：原生 overflow-anchor 未生效（scrollTop 未补偿）",
);
await browser.close();
server.close();
process.exit(0);
