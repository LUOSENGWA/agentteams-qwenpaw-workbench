// #1667：文件管理页 UI/UX + 排版优化（去重）——纯函数 + 渲染结构断言。
// 直跑：node --experimental-strip-types frontend/tests/files-ui-1667.test.ts
//（node:assert/strict；不进 vitest 面——文件名不带 .vitest.）。
//
// 加载路径：照 h1-files-nav / m2-modules 先例——esbuild buildSync 把
// FilesSection.tsx 整树 bundle 到临时 .mjs（先注入 window/host shim：
// 真 React + 最小 antd 桩 + useLocale/useTheme + document 桩），再动态
// import；用 react-dom/server renderToStaticMarkup 静态渲染（effects
// 不跑 → 初始态：files=[]/quota=null/dirPath=""），断言渲染 HTML。
//
// 覆盖（任务书 ≥3 条）：
// ① 面包屑根段不出现——breadcrumbParts("") 整行隐藏；非根段不含「我的文件」；
//    渲染（4 列 mid，根目录）里「我的文件」0 处（F-V3-3 视图切换 tab 已移除，
//    回收站入口 = 工具条按钮）。
// ② 工具条按钮唯一——渲染（2 列 mid，空列表）里「上传文件」按钮恰 1 处、
//    「新建文件夹」恰 1 处；列表空态 CTA = 文字链接（data-type="link"）
//    「上传一个文件」恰 1 处（指向工具条同一处理函数，非新增按钮）。
// ③ 同步卡收敛——syncCardVisible：ok→true；empty/denied/unsupported/
//    null/undefined→false；且 SyncCard 渲染分支经 syncCardVisible 门控
//    （源码接线断言，同 h1-files-nav ⑤ 风格）。
// ④ 大小列——目录行 → 「—」（不显 0）；文件 → fmtBytes；缺 size → 「—」。
// ⑤ 列宽稳定 + F-V3-3 列自适应——columnsFor 整批无 updatedAt →
//    表头/行/grid 同步去「更新时间」列（LIST_GRID ↔ LIST_GRID_NO_TIME
//    按批切换）。
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, "..", "src", "manage", "FilesSection.tsx");
const src = readFileSync(srcPath, "utf8");
const tmp = mkdtempSync(path.join(tmpdir(), "files-ui-1667-"));

// ── 最小 antd 桩（只覆盖 FilesSection 渲染路径用到的组件；
// Modal 桩挂 .confirm——仅事件回调引用，静态渲染不触发）─────────────
const E = React.createElement;
const antdShim = {
  Button: (p: Record<string, unknown>) =>
    E(
      "button",
      {
        type: "button",
        disabled: p.disabled ? "true" : undefined,
        "data-type": p.type ? String(p.type) : undefined,
        "data-loading": p.loading ? "1" : undefined,
      },
      p.icon ?? null,
      p.children,
    ),
  Progress: (p: Record<string, unknown>) =>
    E("span", { "data-progress": String(p.percent ?? 0) }),
  Alert: (p: Record<string, unknown>) =>
    E("div", { "data-alert": String(p.type ?? "info") }, p.message),
  Switch: (p: Record<string, unknown>) =>
    E("input", {
      type: "checkbox",
      "data-switch": "1",
      checked: p.checked ? "true" : undefined,
      disabled: p.disabled ? "true" : undefined,
    }),
  Tooltip: (p: Record<string, unknown>) => E("span", null, p.children),
  Input: (p: Record<string, unknown>) =>
    E("input", { "data-input": "1", value: p.value ?? "", placeholder: p.placeholder }),
  Modal: Object.assign(
    (p: Record<string, unknown>) =>
      p.open ? E("div", { "data-modal": "1" }, p.title, p.children) : null,
    { confirm: () => {} },
  ),
  message: { success() {}, error() {}, warning() {} },
};

// window/host shim（模块顶层 window.QwenPaw.host 在 import 时读；
// document 桩 = usePoller 渲染期读 document.hidden）。
(globalThis as Record<string, unknown>).window = {
  QwenPaw: {
    host: {
      React,
      antd: antdShim,
      antdIcons: {},
      useLocale: () => "zh",
      useTheme: () => "light",
    },
  },
};
(globalThis as Record<string, unknown>).document = { hidden: false };

/** 计数子串出现次数。 */
const count = (hay: string, needle: string): number =>
  hay.split(needle).length - 1;

let n = 0;
function ok(name: string): void {
  n += 1;
  console.log(`  PASS ${n} ${name}`);
}

// ManageNav 运行时仅需 selectedFile / selectFile（FilesSection 只读这两个）；
// data 形状 = ManageData 最小集（admin.humans → humanName 推导）。
const nav = { selectedFile: null, selectFile() {} };
const data = {
  teams: [],
  admin: { humans: [{ name: "luo", matrixUserID: "@luo:local" }] },
  myUserId: "@luo:local",
  hasToken: true,
};

try {
  buildSync({
    entryPoints: [srcPath],
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "transform",
    outfile: path.join(tmp, "FilesSection.mjs"),
  });

  const mod = (await import(path.join(tmp, "FilesSection.mjs"))) as {
    default: (props: Record<string, unknown>) => React.ReactElement;
    breadcrumbParts: (p: string) => { visible: boolean; segments: string[] };
    syncCardVisible: (s: string | null | undefined) => boolean;
    sizeCell: (e: { type?: string; size?: number }) => string;
  };
  const FilesSection = mod.default;
  const { breadcrumbParts, syncCardVisible, sizeCell } = mod;

  // ── ① 面包屑根段不出现 ─────────────────────────────────────────
  const rootParts = breadcrumbParts("");
  assert.equal(rootParts.visible, false);
  assert.deepEqual(rootParts.segments, []);
  const deepParts = breadcrumbParts("docs/2026/11");
  assert.equal(deepParts.visible, true);
  assert.deepEqual(deepParts.segments, ["docs", "2026", "11"]);
  // 根部「我的文件」段永不合成（非根 = 仅路径段 + ↑）。
  assert.ok(!deepParts.segments.includes("我的文件"));
  ok("① breadcrumbParts：根 → 整行隐藏；非根 = 仅路径段（无「我的文件」根段）");

  // 渲染（4 列 mid，根目录）：「我的文件」0 处——面包屑根段永不合成，
  // 且 F-V3-3 起视图切换 tab 已移除（回收站入口 = 工具条按钮）。
  const htmlMid4 = renderToStaticMarkup(
    E(FilesSection as never, { nav, cols: 4, data, variant: "mid" }),
  );
  assert.equal(count(htmlMid4, "我的文件"), 0);
  assert.ok(htmlMid4.includes("回收站")); // 工具条「回收站」按钮（F-V3-3 弹窗入口）
  ok("①b 渲染（4 列 mid 根目录）：「我的文件」0 处（无面包屑根段 + tab 已移除）");

  // ── ② 工具条按钮唯一 + 空态 CTA 文字链接 ───────────────────────
  // 渲染（2 列 mid，初始空列表）：detail = ListArea（空态）+ FilesToolbar。
  const htmlMid2 = renderToStaticMarkup(
    E(FilesSection as never, { nav, cols: 2, data, variant: "mid" }),
  );
  assert.equal(count(htmlMid2, ">上传文件<"), 1);
  assert.equal(count(htmlMid2, ">新建文件夹<"), 1);
  assert.equal(count(htmlMid2, "暂无文件"), 1);
  // 空态 CTA = 文字链接（非按钮）：「上传一个文件」恰 1 处且是唯一
  // data-type="link"（指向工具条同一处理函数 actions.onUploadClick）。
  assert.equal(count(htmlMid2, ">上传一个文件<"), 1);
  assert.equal(count(htmlMid2, 'data-type="link"'), 1);
  ok("② 渲染（2 列 mid 空列表）：上传文件/新建文件夹各 1 处；空态 CTA = link");

  // ── ③ 同步卡仅 ok 渲染 ─────────────────────────────────────────
  assert.equal(syncCardVisible("ok"), true);
  assert.equal(syncCardVisible("empty"), false);
  assert.equal(syncCardVisible("denied"), false);
  assert.equal(syncCardVisible("unsupported"), false);
  assert.equal(syncCardVisible(null), false);
  assert.equal(syncCardVisible(undefined), false);
  // 接线：SyncCard 渲染分支经 syncCardVisible 门控（改前 = 仅 unsupported
  // 隐藏，denied/empty 占版面）。
  assert.ok(src.includes("syncCardVisible(st.state)"));
  ok("③ syncCardVisible：仅 ok 渲染；empty/denied/unsupported → 不渲染（含接线）");

  // ── ④ 大小列：目录 → 「—」，文件 → fmtBytes ───────────────────
  assert.equal(sizeCell({ type: "directory" }), "—");
  assert.equal(sizeCell({ type: "file", size: 2048 }), "2.0 KB");
  assert.equal(sizeCell({ type: "file" }), "—");
  ok("④ sizeCell：目录 → —（不显 0）；文件 → 可读大小；缺失 → —");

  // ── ⑤ 列宽稳定 + F-V3-3 列自适应：columnsFor 整批无 updatedAt →
  //    表头/行/grid 同步去「更新时间」列（LIST_GRID ↔ LIST_GRID_NO_TIME
  //    按批切换，不再是写死的 gridTemplateColumns 字面量）。
  const colsForUses = (src.match(/\bcolumnsFor\(/g) || []).length;
  assert.ok(colsForUses >= 2, `columnsFor 接线次数 = ${colsForUses}（定义 + ListArea 调用，应 ≥ 2）`);
  assert.ok(src.includes("LIST_GRID_NO_TIME"), "无更新时间列的 grid 模板在位");
  assert.ok(src.includes("showUpdatedAt"), "表头/行按 showUpdatedAt 门控渲染");
  ok(`⑤ 列自适应接线：columnsFor（${colsForUses} 处）+ LIST_GRID_NO_TIME + showUpdatedAt`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`files-ui-1667: ${n} passed`);
