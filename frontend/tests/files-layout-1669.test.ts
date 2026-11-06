// #1669：文件页 master-detail 断点（split / drawer / sheet）——
// 右栏不空、详情不重复、断点按容器宽度（ResizeObserver，禁 window.innerWidth）。
// 直跑：node --experimental-strip-types frontend/tests/files-layout-1669.test.ts
//（node:assert/strict；不进 vitest 面——文件名不带 .vitest.）。
//
// 加载路径：照 files-ui-1667 先例——esbuild buildSync 把 FilesSection.tsx
// 整树 bundle 到临时 .mjs（window/host shim：真 React + 最小 antd 桩 +
// document 桩），再动态 import；断言 = 纯函数（layoutMode / panesFor /
// detailRenderCount / detailState）+ 静态渲染结构（renderToStaticMarkup，
// effects 不跑 → 容器宽度首帧 0 = sheet 语义，仅列表）。
//
// 覆盖（任务书 ≥3 条）：
// ① 断点纯函数——layoutMode(1300)=split / (1000)=drawer / (700)=sheet
//    + 边界 1200/1199/768/767；
// ② 详情渲染次数 = 1——任何 mode 下 detailRenderCount(panesFor(m, true))
//    === 1（未选中 = 0）；不渲染 DOM；
// ③ panesFor("split", false).detail === "empty-state"（split 未选中 =
//    右栏空态，不空白）+ 各 mode 的 detail/overlay 槽位划分；
// ④ detailState 四态（detail / loading / empty-dir / pick）；
// ⑤ 静态渲染：4 列 mid（首帧 sheet，未选中）= 仅列表、无详情空态文案；
//    1 列 mid + 选中 = 全屏 Sheet 浮层（data-drawer="bottom"）+ 详情降级
//    文案恰 1 处；2 列 right 未选中 = 「此目录为空」+ 上传按钮恰 1 处；
//    2 列 right + 选中 = 详情降级文案恰 1 处（右栏不空白、不重复）；
// ⑥ 源码接线——4 列 mid 旧特判已删、ResizeObserver 已接、
//    window.innerWidth 无实际使用（仅注释）、panesFor 已接。
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
const tmp = mkdtempSync(path.join(tmpdir(), "files-layout-1669-"));

// ── 最小 antd 桩（files-ui-1667 同款 + Drawer——16.69 断点浮层）──────
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
  // Drawer 桩：open 时显容器（placement 标记断点形态）+ 标题 + 内容。
  Drawer: (p: Record<string, unknown>) =>
    p.open ? E("div", { "data-drawer": String(p.placement ?? "right") }, p.title, p.children) : null,
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
const navSel = { selectedFile: "a.txt", selectFile() {} };
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
    layoutMode: (w: number) => "split" | "drawer" | "sheet";
    panesFor: (
      m: "split" | "drawer" | "sheet",
      hasSelection: boolean,
    ) => { list: "list"; detail: "detail" | "empty-state" | null; overlay: "drawer" | "sheet" | null };
    detailRenderCount: (p: { detail: "detail" | "empty-state" | null; overlay: "drawer" | "sheet" | null }) => number;
    detailState: (o: {
      hasSelection: boolean;
      loading: boolean;
      status: "" | "404" | "err";
      view: "files" | "trash";
      entryCount: number;
    }) => "detail" | "loading" | "empty-dir" | "pick";
  };
  const FilesSection = mod.default;
  const { layoutMode, panesFor, detailRenderCount, detailState } = mod;

  // ── ① 断点纯函数（容器宽度 → split / drawer / sheet）──────────
  assert.equal(layoutMode(1300), "split");
  assert.equal(layoutMode(1000), "drawer");
  assert.equal(layoutMode(700), "sheet");
  // 边界：1200 起 split；1199 → drawer；768 起 drawer；767 → sheet。
  assert.equal(layoutMode(1200), "split");
  assert.equal(layoutMode(1199), "drawer");
  assert.equal(layoutMode(768), "drawer");
  assert.equal(layoutMode(767), "sheet");
  ok("① layoutMode：1300→split / 1000→drawer / 700→sheet（含 1200/1199/768/767 边界）");

  // ── ② 详情渲染次数 = 1（纯函数，不渲染 DOM）────────────────────
  for (const m of ["split", "drawer", "sheet"] as const) {
    assert.equal(detailRenderCount(panesFor(m, true)), 1, `${m} 选中 → 详情恰 1 处`);
    assert.equal(detailRenderCount(panesFor(m, false)), 0, `${m} 未选中 → 0 处`);
  }
  ok("② detailRenderCount：任何 mode 下 选中 = 1 / 未选中 = 0（详情不重复）");

  // ── ③ panesFor 槽位划分（split 未选中 = 空态，右栏不空白）──────
  assert.equal(panesFor("split", false).detail, "empty-state");
  assert.equal(panesFor("split", false).overlay, null);
  assert.equal(panesFor("split", true).detail, "detail");
  assert.equal(panesFor("split", true).overlay, null);
  assert.equal(panesFor("drawer", true).overlay, "drawer");
  assert.equal(panesFor("drawer", true).detail, null);
  assert.equal(panesFor("drawer", false).overlay, null);
  assert.equal(panesFor("sheet", true).overlay, "sheet");
  assert.equal(panesFor("sheet", true).detail, null);
  assert.equal(panesFor("sheet", false).overlay, null);
  ok("③ panesFor：split 未选中 = empty-state；drawer/sheet 未选中 = 无浮层");

  // ── ④ detailState 四态（右栏不得空白）──────────────────────────
  assert.equal(
    detailState({ hasSelection: true, loading: false, status: "", view: "files", entryCount: 0 }),
    "detail",
  );
  assert.equal(
    detailState({ hasSelection: false, loading: true, status: "", view: "files", entryCount: 0 }),
    "loading",
  );
  assert.equal(
    detailState({ hasSelection: false, loading: false, status: "", view: "files", entryCount: 0 }),
    "empty-dir",
  );
  assert.equal(
    detailState({ hasSelection: false, loading: false, status: "", view: "files", entryCount: 5 }),
    "pick",
  );
  // 有错误 → 不判空目录（错误由列表区自显）。
  assert.equal(
    detailState({ hasSelection: false, loading: false, status: "err", view: "files", entryCount: 0 }),
    "pick",
  );
  // 回收站视图无「空目录」语义 → pick。
  assert.equal(
    detailState({ hasSelection: false, loading: false, status: "", view: "trash", entryCount: 0 }),
    "pick",
  );
  ok("④ detailState：detail / loading / empty-dir / pick 四态（含错误与回收站分支）");

  // ── ⑤ 静态渲染结构（首帧容器宽 0 = sheet 语义：仅列表）─────────
  // 4 列 mid（未选中）：恒出列表；旧缺陷 = 只出详情/空态（右栏空白 + 重复）。
  const htmlMid4 = renderToStaticMarkup(
    E(FilesSection as never, { nav, cols: 4, data, variant: "mid" }),
  );
  assert.ok(htmlMid4.includes("共 0 个条目"), "4 列 mid 应出列表头部计数");
  assert.ok(htmlMid4.includes("暂无文件"), "4 列 mid 应出列表空态");
  assert.ok(!htmlMid4.includes("选择文件查看详情"), "4 列 mid 未选中不出 split 空态（首帧 sheet）");
  assert.ok(!htmlMid4.includes("此目录为空"), "4 列 mid 未选中不出 split 空态（首帧 sheet）");
  assert.equal(count(htmlMid4, ">上传文件<"), 1, "上传按钮恰 1 处（工具条）");
  // F-V3-3：视图切换 tab 移除 →「我的文件」0 处（回收站入口 = 工具条按钮）。
  assert.equal(count(htmlMid4, "我的文件"), 0, "「我的文件」tab 已移除（F-V3-3）");
  ok("⑤a 渲染（4 列 mid 未选中）：恒出列表（不空白、不出详情空态）");

  // 1 列 mid + 选中：首帧 sheet → 详情只在全屏 Sheet 浮层一处。
  const htmlMid1Sel = renderToStaticMarkup(
    E(FilesSection as never, { nav: navSel, cols: 1, data, variant: "mid" }),
  );
  assert.equal(count(htmlMid1Sel, 'data-drawer="bottom"'), 1, "选中 → 全屏 Sheet 恰 1 处");
  // 条目不在数据中（静态渲染 files=[]）→ FileDetail 自显降级文案，恰 1 处。
  assert.equal(count(htmlMid1Sel, "所选文件已不在最新数据中"), 1);
  ok("⑤b 渲染（1 列 mid 选中）：详情只在全屏 Sheet 一处（data-drawer=bottom）");

  // 2 列 right 未选中：右栏 = 空目录空态 + 上传按钮（不空白）。
  const htmlRight2 = renderToStaticMarkup(
    E(FilesSection as never, { nav, cols: 2, data, variant: "right" }),
  );
  assert.ok(htmlRight2.includes("此目录为空"));
  assert.ok(htmlRight2.includes("上传或新建文件夹后开始管理"));
  // F-V3-3：右栏 DetailPane 的大「上传文件」按钮已删（文件页 4 栏去重）
  // → 改一行次要文字「上传请使用上方工具条」。
  assert.equal(count(htmlRight2, ">上传文件<"), 0, "右栏大上传按钮已删（F-V3-3）");
  assert.ok(
    htmlRight2.includes("上传请使用上方工具条"),
    "右栏空态引导文字在位",
  );
  assert.ok(!htmlRight2.includes("选择文件查看详情"), "空目录 → 不叠 pick 空态");
  ok("⑤c 渲染（2 列 right 未选中空目录）：此目录为空 + 引导文字（F-V3-3 去重）");

  // 2 列 right + 选中：右栏 = 详情（恰 1 处降级文案），不叠空态。
  const htmlRight2Sel = renderToStaticMarkup(
    E(FilesSection as never, { nav: navSel, cols: 2, data, variant: "right" }),
  );
  assert.equal(count(htmlRight2Sel, "所选文件已不在最新数据中"), 1);
  assert.ok(!htmlRight2Sel.includes("此目录为空"), "选中 → 不叠空目录空态");
  ok("⑤d 渲染（2 列 right 选中）：详情恰 1 处（不重复、不叠空态）");

  // ── ⑥ 源码接线 ────────────────────────────────────────────────
  assert.ok(!src.includes('cols === 4 && variant === "mid"'), "4 列 mid 旧特判已删");
  assert.ok(src.includes("new ResizeObserver("), "容器宽度走 ResizeObserver");
  const innerWidthLines = src.split("\n").filter((l) => l.includes("window.innerWidth"));
  assert.ok(
    innerWidthLines.every((l) => {
      const c = l.trim();
      return c.startsWith("*") || c.startsWith("/*") || c.startsWith("//");
    }),
    `window.innerWidth 仅允许出现在注释（实际使用 ${innerWidthLines.length} 处）`,
  );
  assert.ok(src.includes("panesFor(mode, hasSelection)"), "mid 分支已接 panesFor");
  ok("⑥ 源码接线：旧特判已删 / ResizeObserver 已接 / window.innerWidth 无实际使用 / panesFor 已接");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`files-layout-1669: ${n} passed`);
