/**
 * ui-harness-1322.mjs — v0.5.0-beta.13.22 UI 实证（playwright-core + chromium）
 *
 * 覆盖 13.21 装验反馈 7 件中的 3 个高风险交互件：
 *  F2  WorkflowBoard 拓扑：第 5 项「Mermaid」视图退役 → 依赖图内
 *      DAG（交互）/Mermaid 样式切换（视图 tab 只剩 4 项）。
 *  F5  TeamOverview 房间卡：未读徽章挂卡片头像右上角（群卡新带头像），
 *      名称行内不再内联胶囊。
 *  F7  私聊角色：列表不再直接分割成段 → 列表上方筛选 chips
 *      （全部/Leader/Worker/Manager，空桶不显），选中=单一过滤列表。
 *
 * 运行：python3 -m http.server 8792 &  node scripts/ui-harness-1322.mjs
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
await page.goto("http://127.0.0.1:8792/harness/page-1322.html", { waitUntil: "load" });
await page.waitForSelector("#to .ant-card", { timeout: 15000 });
await page.waitForTimeout(500);

// ── F2：拓扑依赖图样式切换 ───────────────────────────────────────────
const segs = page.locator("#wf .ant-segmented");
report(
  "F2 两个 Segmented（视图 tab + 图样式）",
  (await segs.count()) === 2,
  `count=${await segs.count()}`,
);
const viewItems = page.locator("#wf .ant-segmented").nth(0).locator(".ant-segmented-item");
report(
  "F2 视图 tab 只剩 4 项（Mermaid 第 5 项已退役）",
  (await viewItems.count()) === 4,
  `count=${await viewItems.count()}`,
);
const styleSeg = page.locator("#wf .ant-segmented").nth(1);
const styleText = await styleSeg.innerText();
report(
  "F2 图样式= DAG（交互）/Mermaid",
  styleText.includes("DAG（交互）") && styleText.includes("Mermaid"),
  styleText.replace(/\n/g, "|"),
);
// 初始=DAG：DagTopo 统计条 + 任务数
const wfText = await page.locator("#wf").innerText();
report(
  "F2 默认 DAG 样式（依赖图 + 3 任务 · 2 依赖）",
  wfText.includes("依赖图") && wfText.includes("3 任务"),
  "",
);
// 切 Mermaid → 上游快照直渲染（fetch mock 返回合法 flowchart）
await page.locator('#wf .ant-segmented-item:has-text("Mermaid")').click();
await page.waitForFunction(
  () => {
    const wf = document.querySelector("#wf");
    return wf && wf.querySelector("svg") && wf.innerText.includes("快照直渲染");
  },
  null,
  { timeout: 20000 },
);
report("F2 切 Mermaid → 上游快照 svg 渲染", true);
// 切回 DAG
await page.locator('#wf .ant-segmented-item:has-text("DAG（交互）")').click();
await page.waitForFunction(
  () => {
    const wf = document.querySelector("#wf");
    return wf && wf.querySelector("svg[aria-label*='项目任务依赖图']");
  },
  null,
  { timeout: 10000 },
);
report("F2 切回 DAG → 可交互依赖图恢复（节点可点）", true);

// ── F5：未读徽章挂卡片头像右上角 ─────────────────────────────────────
// 注：房间徽章=包裹头像的徽章（提及区段头计数徽章不含头像，天然排除）；
// DmCard 根是普通 div（非 antd.Card），GroupCard 才是 antd.Card。
const badges = page.locator("#to .ant-badge:has(.ant-avatar)");
report(
  "F5 4 个房间未读徽章（g1=5 灰 / g2=2 红 / d1=3 灰 / d3=1 灰）",
  (await badges.count()) === 4,
  `count=${await badges.count()}`,
);
const badgeWithAvatar = page.locator("#to .ant-badge:has(.ant-avatar) .ant-avatar");
report(
  "F5 每个徽章都包裹头像（头像右上角定位）",
  (await badgeWithAvatar.count()) === 4,
  `count=${await badgeWithAvatar.count()}`,
);
const badgeCounts = [];
for (let i = 0; i < (await badges.count()); i += 1) {
  badgeCounts.push(await badges.nth(i).locator(".ant-badge-count").innerText());
}
report(
  "F5 徽数值 5/2/3/1",
  JSON.stringify([...badgeCounts].sort()) === JSON.stringify(["1", "2", "3", "5"]),
  badgeCounts.join(","),
);
// 名称行内不再有内联胶囊：名称文本节点的直接父行（旧设计徽章就内联
// 在这行里）不得含 .ant-badge。
const nameRowClean = await page.evaluate(() => {
  const root = document.querySelector("#to");
  if (!root) return "no-root";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (n.textContent === "团队群A") {
      const row = n.parentElement;
      return row && row.querySelector(".ant-badge") ? "badge-in-row" : "clean";
    }
  }
  return "no-name";
});
report("F5 名称行无内联徽章（旧灰胶囊退役）", nameRowClean === "clean", nameRowClean);
// 群卡新带头像（原群卡无头像）
const g1card = page.locator("#to .ant-card", { hasText: "团队群A" });
const g1avatars = await g1card.locator(".ant-avatar").count();
report("F5 群卡带头像（主头像+成员叠层）", g1avatars >= 2, `avatars=${g1avatars}`);

// ── F7：私聊角色筛选 chips ──────────────────────────────────────────
await page.locator('#to .ant-segmented-item:has-text("私聊")').click();
await page.waitForTimeout(300);
const chips = page.locator("#to button", { hasText: "（" });
const chipTexts = [];
for (let i = 0; i < (await chips.count()); i += 1) {
  chipTexts.push(await chips.nth(i).innerText());
}
report(
  "F7 角色 chips=全部（3）/Leader（1）/Worker（1）/Manager（1）（空桶不显）",
  JSON.stringify(chipTexts) ===
    JSON.stringify(["全部（3）", "Leader（1）", "Worker（1）", "Manager（1）"]),
  chipTexts.join("|"),
);
// 房间行计数（DmCard 根=div 非 antd.Card：数直接挂头像的行根）
const countRoomRows = () =>
  page.evaluate(() => {
    const to = document.querySelector("#to");
    return [...to.querySelectorAll("div")].filter(
      (d) =>
        d.querySelector(":scope > .ant-avatar") ||
        d.querySelector(":scope > .ant-badge > .ant-avatar"),
    ).length;
  });
// 默认全部=扁平 3 行（不再按角色切段）
report("F7 默认全部=3 条 DM（扁平列表）", (await countRoomRows()) === 3, `count=${await countRoomRows()}`);
// 选 Worker → 只剩 worker1 一条
await chips.filter({ hasText: "Worker（1）" }).click();
await page.waitForTimeout(300);
const afterWorker = await page.locator("#to").innerText();
report(
  "F7 选 Worker → 仅 worker1（leader/manager1 被滤掉）",
  (await countRoomRows()) === 1 &&
    afterWorker.includes("worker1") &&
    !afterWorker.includes("manager1"),
  `count=${await countRoomRows()}`,
);
// 选 Leader → 仅 leader 一条
await chips.filter({ hasText: "Leader（1）" }).click();
await page.waitForTimeout(300);
const afterLeader = await page.locator("#to").innerText();
report(
  "F7 选 Leader → 仅 leader",
  (await countRoomRows()) === 1 && afterLeader.includes("leader"),
  `count=${await countRoomRows()}`,
);
// 回全部
await chips.filter({ hasText: "全部（3）" }).click();
await page.waitForTimeout(300);
report(
  "F7 回全部 → 3 条恢复",
  (await countRoomRows()) === 3,
  `count=${await countRoomRows()}`,
);

// ── F1：onlyTeam 矩阵只渲染该团队 Worker（不跨团队泄漏）─────────────
await page.waitForFunction(
  () => {
    const f1 = document.querySelector("#f1");
    return f1 && f1.innerText.includes("wA1") && f1.innerText.includes("wA2");
  },
  null,
  { timeout: 10000 },
);
const f1Text = await page.locator("#f1").innerText();
report(
  "F1 onlyTeam=teamA 矩阵含 wA1/wA2",
  f1Text.includes("wA1") && f1Text.includes("wA2"),
  "",
);
report(
  "F1 矩阵不含 teamB 的 wB1（旧 bug=跨团队泄漏）",
  !f1Text.includes("wB1"),
  "",
);

// ── F4：2D 图谱点选后高亮跨重渲染持久（graph 引用每 300ms 换新）────
await page.waitForFunction(
  () => {
    const texts = [...document.querySelectorAll("#f4 svg text")];
    return (
      texts.some((t) => t.textContent === "文件一") &&
      texts.some((t) => t.textContent === "文件二")
    );
  },
  null,
  { timeout: 10000 },
);
const countActiveEdges = () =>
  page.evaluate(
    () =>
      document.querySelectorAll('#f4 svg line[stroke-opacity="0.9"]').length,
  );
report("F4 点击前无高亮边（基线）", (await countActiveEdges()) === 0, `n=${await countActiveEdges()}`);
const chip = page.locator("#f4 svg text", { hasText: "文件一" }).first();
const cbox = await chip.boundingBox();
if (!cbox) {
  report("F4 节点 chip 定位", false, "no boundingBox");
} else {
  await page.mouse.click(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2);
  await page.waitForFunction(
    () =>
      document.querySelectorAll('#f4 svg line[stroke-opacity="0.9"]').length === 1,
    null,
    { timeout: 5000 },
  );
  report("F4 点选后 1 条高亮边（root→文件一）", true);
  // 跨 5+ 次父级重渲染（每次 graph 新引用）——旧实现下一次 tick 即清
  // 选中（「箭头只闪一下」）；修复后选中与高亮持久。
  await page.waitForTimeout(1600);
  const persistEdges = await countActiveEdges();
  const f4Text = await page.locator("#f4").innerText();
  report(
    "F4 高亮跨重渲染持久（1.6s≈5 tick，选中未被清）",
    persistEdges === 1 && f4Text.includes("f1.md"),
    `edges=${persistEdges} panel=${f4Text.includes("f1.md")}`,
  );
}

// ── 收尾：无运行时错误 ──────────────────────────────────────────────
report("无 pageerror", errors.length === 0, errors.slice(0, 2).join(" | ").slice(0, 160));

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exit(failed ? 1 : 0);
