/**
 * ui-harness-1323.mjs — v0.5.0-beta.13.23 UI 实证（playwright-core + chromium）
 *
 * 覆盖 13.23 审批数据面统一 #1216（ApprovalControl 六实例分态）：
 *  A1  #1216 GET 200 → 四档卡 + OFF capability 提示行 + 当前模式 Tag
 *  A2  #1216 404 + 旧端点 200 → 回退读成功（docker 直读）
 *  A3  #1216 404 + 旧端点 401 → 新权限文案（删过期前提回归防）
 *  A4  apply #1216 PUT 200 → 成功 toast + 级别更新
 *  apply #1216 404 + 旧端点 200 → 回退写成功
 *  A6  apply OFF #1216 403（approval_policy #1273）→ 错误透传 detail
 *
 * 运行：python3 -m http.server 8793 &  node scripts/ui-harness-1323.mjs
 */
import { chromium } from "playwright-core";

const results = [];
function report(name, ok, extra = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
}

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium" });
const page = await browser.newPage({ viewport: { width: 900, height: 1400 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("http://127.0.0.1:8793/harness/page-1323.html", {
  waitUntil: "load",
});

// 点选档位卡：找 innerText 含 label 的最小 div（标签行）点击（事件冒泡到卡）
const pickCard = (sel, label) =>
  page.evaluate(
    ([s, l]) => {
      const root = document.querySelector(s);
      if (!root) return "no-root";
      // 找含 label 的最内层 div（标签文本行），点击冒泡到档位卡 onClick。
      const cand = [...root.querySelectorAll("div")].filter((d) =>
        (d.innerText || "").includes(l),
      );
      cand.sort((a, b) => (a.innerText || "").length - (b.innerText || "").length);
      if (!cand.length) return "no-card";
      cand[0].click();
      return "clicked";
    },
    [sel, label],
  );

// 等六实例全部出终态（卡或权限文案或错误）
await page.waitForFunction(
  () => {
    const t = (id) => document.querySelector(id)?.innerText || "";
    return (
      t("#a1").includes("当前模式") &&
      t("#a2").includes("当前模式") &&
      t("#a3").includes("无权限读取") &&
      t("#a4").includes("当前模式") &&
      t("#a5").includes("当前模式") &&
      t("#a6").includes("当前模式")
    );
  },
  null,
  { timeout: 15000 },
);

// ── A1：四档卡 + OFF 提示行 + 当前模式 ───────────────────────────────
const a1 = await page.locator("#a1").innerText();
report(
  "A1 四档卡齐（严格/智能/自动/关闭模式）",
  ["严格模式", "智能模式", "自动模式", "关闭模式"].every((s) => a1.includes(s)),
  "",
);
report(
  "A1 OFF capability 提示行（approval_policy / #1273）",
  a1.includes("approval_policy") && a1.includes("#1273"),
  "",
);
report("A1 当前模式=自动（AUTO）（#1216 主路径）", a1.includes("当前模式: 自动（AUTO）"), "");

// ── A2：404 回退读（旧端点 docker 直读 STRICT）──────────────────────
const a2 = await page.locator("#a2").innerText();
report("A2 回退读成功=严格（STRICT）（#1216 404 → 旧端点）", a2.includes("当前模式: 严格（STRICT）"), "");

// ── A3：新权限文案（404+401）＋ 旧过期文案回归防 ────────────────────
const a3 = await page.locator("#a3").innerText();
report(
  "A3 新权限文案（无权限读取 401/403 + L2 可读写本团队）",
  a3.includes("无权限读取（401/403）") && a3.includes("L2 账号可读写本团队 Worker"),
  "",
);
report("A3 旧过期文案已删（「上游 L2 写路径 PR 合并后自动开放」）", !a3.includes("自动开放"), "");

// ── A4：apply 主路径（#1216 PUT 200 → STRICT）──────────────────────
await pickCard("#a4", "严格模式");
await page.waitForTimeout(150);
const a4btn = page.locator("#a4 button", { hasText: "严格模式" });
report("A4 选严格后出现「应用」按钮", (await a4btn.count()) === 1, `count=${await a4btn.count()}`);
await a4btn.first().click();
await page.waitForFunction(
  () => document.body.innerText.includes("w-a4"),
  null,
  { timeout: 8000 },
);
const a4 = await page.locator("#a4").innerText();
report(
  "A4 主路径写成功（成功 toast + 当前模式更新为严格）",
  (await page.evaluate(() => document.body.innerText)).includes("工具执行安全已设为 严格") &&
    a4.includes("当前模式: 严格（STRICT）"),
  "",
);

// ── apply #1216 404 → 旧端点回退写（SMART）─────────────────────
await pickCard("#a5", "智能模式");
await page.waitForTimeout(150);
const a5btn = page.locator("#a5 button", { hasText: "智能模式" });
report("选智能后出现「应用」按钮", (await a5btn.count()) === 1, `count=${await a5btn.count()}`);
await a5btn.first().click();
await page.waitForFunction(
  () => document.body.innerText.includes("w-a5"),
  null,
  { timeout: 8000 },
);
const a5 = await page.locator("#a5").innerText();
report(
  "回退写成功（toast + 当前模式更新为智能）",
  (await page.evaluate(() => document.body.innerText)).includes("工具执行安全已设为 智能") &&
    a5.includes("当前模式: 智能（SMART）"),
  "",
);

// ── A6：apply OFF → #1216 403（capability）→ 错误透传 ──────────────
await pickCard("#a6", "关闭模式");
await page.waitForTimeout(150);
const a6btn = page.locator("#a6 button", { hasText: "关闭模式" });
report("A6 选关闭后出现「应用」按钮", (await a6btn.count()) === 1, `count=${await a6btn.count()}`);
await a6btn.first().click();
await page.waitForFunction(
  () => document.body.innerText.includes("设置失败"),
  null,
  { timeout: 8000 },
);
report(
  "A6 OFF 403 错误透传 approval_policy detail",
  (await page.evaluate(() => document.body.innerText)).includes("approval_policy"),
  "",
);
const a6 = await page.locator("#a6").innerText();
report("A6 级别未被改写（仍=严格 STRICT）", a6.includes("当前模式: 严格（STRICT）"), "");

// ── 收尾：无运行时错误 ─────────────────────────────────────────────
report("无 pageerror", errors.length === 0, errors.slice(0, 2).join(" | ").slice(0, 160));

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exit(failed ? 1 : 0);
