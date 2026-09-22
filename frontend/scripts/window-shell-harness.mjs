/**
 * window-shell-harness.mjs — v0.5.0-beta.13.4 shell 高度重构实证
 *
 * 场景：QwenPaw Desktop OS 窗口（OsAppHost .content：定高 flex:1 容器，
 * overflow:auto）= 520px 高，浏览器视口 900px（窗口小于屏幕——真机常态）。
 *
 * 旧链（12.x–13.3）：wb-main = calc(100vh-64px)、RoomChat = calc(100vh-230px)
 *   + min-height:420px → 预期：窗口内容 scrollHeight > clientHeight（整页滚）。
 * 新链（13.4）：wb-main = 父容器 clientHeight（实测注入 520px）、
 *   RoomChat = height:100% → 预期：窗口内容 0 溢出、列表内滚、输入区贴底可见。
 *
 * 运行：node scripts/window-shell-harness.mjs
 */
import { chromium } from "playwright-core";

const MSGS = Array.from({ length: 50 }, (_, i) => `msg-${i}`).join("</div><div>");

const body = (shellH, roomH) => `
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font: 12px sans-serif; }
    .msg { height: 60px; border-bottom: 1px solid #eee; }
  </style>
  <div id="os-content" style="width:900px;height:520px;overflow:auto;border:2px solid red;position:relative;">
    <div id="wb-main" style="display:flex;flex-direction:column;overflow:hidden;height:${shellH};">
      <div style="flex:0 0 auto;height:46px;border-bottom:1px solid #ccc;">header</div>
      <div style="flex:0 0 auto;height:40px;border-bottom:1px solid #ccc;">tabbar</div>
      <div id="content" style="flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow-y:auto;padding-top:12px;">
        <div class="tabpane" style="height:100%;min-height:0;overflow-y:auto;">
          <div style="display:flex;height:100%;min-height:0;">
            <div id="rooms" style="width:300px;overflow-y:auto;border-right:1px solid #ccc;">
              ${Array.from({ length: 40 }, (_, i) => `<div style="height:48px;border-bottom:1px solid #f2f2f2;">room-${i}</div>`).join("")}
            </div>
            <div id="right" style="flex:1;min-width:0;min-height:0;position:relative;">
              <div id="roomchat" style="display:flex;flex-direction:column;height:${roomH};min-width:0;">
                <div style="flex:0 0 auto;padding:8px 0;border-bottom:1px solid #eee;">topbar</div>
                <div id="listwrap" style="flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;">
                  <div id="list" style="flex:1;min-height:0;overflow-y:auto;"><div class="msg">${MSGS}</div></div>
                </div>
                <div id="composer" style="flex:0 0 auto;height:80px;border-top:1px solid #eee;">composer</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
`;

function report(name, m) {
  const pageScroll = m.osSH - m.osCH;
  const listScrollable = m.listSH > m.listCH;
  const composerVisible =
    m.compTop >= m.osTop + 1 && m.compBot <= m.osBot - 1;
  console.log(
    `[${name}] 窗口内容溢出=${pageScroll}px(0=无整页滚) 列表可内滚=${listScrollable} ` +
      `(list ${m.listCH}px/${m.listSH}px) 输入区完整可见=${composerVisible}`,
  );
  return { pageScroll, listScrollable, composerVisible };
}

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const measure = () =>
  page.evaluate(() => {
    const r = (id) => {
      const el = document.getElementById(id);
      const b = el.getBoundingClientRect();
      return {
        ch: el.clientHeight,
        sh: el.scrollHeight,
        top: b.top,
        bot: b.bottom,
      };
    };
    const os = r("os-content");
    const list = r("list");
    const comp = r("composer");
    return {
      osCH: os.ch, osSH: os.sh, osTop: os.top, osBot: os.bot,
      listCH: list.ch, listSH: list.sh,
      compTop: comp.top, compBot: comp.bot,
    };
  });

// ── 旧链：vh 魔法数（12.x–13.3）─────────────────────────────
await page.setContent(body("calc(100vh - 64px)", "calc(100vh - 230px)"));
const oldR = report("旧链 vh 魔法数", await measure());

// ── 新链：容器相对（13.4）：shell=父容器 clientHeight（真实测量逻辑），
// RoomChat=100% ──
// 先注入占位量出父容器真实高度（与源码 setShellH(p.clientHeight) 同逻辑）
await page.setContent(body("1px", "100%"));
const parentH = await page.evaluate(
  () => document.getElementById("wb-main").parentElement.clientHeight,
);
console.log(`(父容器 clientHeight=${parentH}px → 注入为 shellH)`);
await page.setContent(body(`${parentH}px`, "100%"));
const newR = report("新链 容器相对", await measure());

await browser.close();

let fail = 0;
const check = (label, ok) => {
  console.log(`  ${ok ? "✅" : "❌"} ${label}`);
  if (!ok) fail++;
};
console.log("─".repeat(60));
check("旧链复现整页滚（溢出>0）", oldR.pageScroll > 0);
check("新链无整页滚（溢出=0）", newR.pageScroll === 0);
check("新链列表内滚", newR.listScrollable);
check("新链输入区贴底完整可见", newR.composerVisible);
process.exit(fail ? 1 : 0);
