// F-V3-1：文件管理页 v3——回收站 + 同步设置弹窗。
// 直跑：node --experimental-strip-types frontend/tests/files-v3-1.test.ts
//（node:assert/strict；不进 vitest 面——文件名不带 .vitest.）。
//
// F-V3-3 更新：回收站独立页（TrashPanel）已移除 → 改工具条按钮打开的
// files/TrashDialog 弹窗（数据 = 容器 load 的 trash 腿，弹窗不自取数）；
// 视图切换 tab 移除（「我的文件」/「回收站」tab 不再渲染，回收站入口 =
// 工具条按钮）。
//
// 加载路径：照 files-ui-1667 先例——临时 entry 重导出 FilesSection（视图
// 常量 + 默认组件）+ files/TrashDialog（TRASH_COLUMNS + 默认组件）+
// files/SyncSettingsModal（SYNC_RUN_PATH / MIRROR_DIR + 默认组件），
// esbuild buildSync 到临时 .mjs（window/host shim：真 React + 最小 antd
// 桩 + document 桩），再动态 import；renderToStaticMarkup 静态渲染
//（effects 不跑 → 仅初始态断言）。
//
// 覆盖（任务书 ≥3 条）：
// ① fileViews() = ["files","trash"] 且默认 files；mid-4 渲染含页标题
//    「文件管理」；「我的文件」0 处（F-V3-3 视图切换移除）且「回收站」
//    在位（工具条按钮入口）；
// ② 回收站弹窗——TRASH_COLUMNS = ["原路径","大小","删除时间","操作"]
//    （导出常量断言）+ TrashDialog 独立渲染空态（回收站是空的）+ 源码
//    接线（列头经 TRASH_COLUMNS.map 渲染；restoreTrash/purgeTrash 两
//    API——listTrash 已上移容器三腿，弹窗源码不得出现；空态
//    「回收站是空的」；409「同名文件已存在」+ 管理员「覆盖恢复」；
//    彻底删确认；非管理员禁用 purge）；
// ③ 同步长条移除——hasInlineSyncCard === false；FilesSection 源码无
//    <SyncCard 渲染残留；mid-2 渲染「同步设置」按钮恰 1 处（工具条）、
//    旧「复制清单原文」按钮 0 处；弹窗入口已接（<SyncSettingsModal）；
// ④ 同步弹窗——直接渲染 open=true：st=null →「加载中…」；st=empty →
//    未就绪原因（服务端终裁，按钮仍可点）；st=ok → 条目/代/最后写入者；
// ⑤ 常量口径——SYNC_RUN_PATH = "/agentteams-proxy/sync/run"；
//    MIRROR_DIR = "<workspace>/.qwenpaw/agentteams"（任务书口径）；
//    弹窗源码经 SYNC_RUN_PATH + method POST 调「立即同步」。
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const srcPath = path.join(root, "src", "manage", "FilesSection.tsx");
const trashPath = path.join(root, "src", "manage", "files", "TrashDialog.tsx");
const syncPath = path.join(
  root,
  "src",
  "manage",
  "files",
  "SyncSettingsModal.tsx",
);
const src = readFileSync(srcPath, "utf8");
const trashSrc = readFileSync(trashPath, "utf8");
const syncSrc = readFileSync(syncPath, "utf8");
const tmp = mkdtempSync(path.join(tmpdir(), "files-v3-1-"));

// ── 最小 antd 桩（同 files-ui-1667；Modal 桩 = open 时显容器）────────
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

/** tr = zh 直通（useT 的 zh 分支原样返回；变量插值同宿主实现）。 */
const tr = (s: string, v?: Record<string, string | number>): string => {
  for (const [k, val] of Object.entries(v ?? {}))
    s = s.split(`{${k}}`).join(String(val));
  return s;
};

// ThemeColors 运行时 dummy（组件只读色值字符串，无 TS 类型检查）。
const t = {
  text: "#111",
  textSecondary: "#666",
  border: "#ddd",
  hoverBg: "#f5f5f5",
  cardBg: "#fff",
  inputBg: "#fafafa",
  accent: "#1677ff",
  danger: "#ff4d4f",
} as Record<string, string>;

// ManageNav 运行时仅需 selectedFile / selectFile；data = ManageData 最小集。
const nav = { selectedFile: null, selectFile() {} };
const data = {
  teams: [],
  admin: { humans: [{ name: "luo", matrixUserID: "@luo:local" }] },
  myUserId: "@luo:local",
  hasToken: true,
};

try {
  // 单 bundle 入口：FilesSection 星号重导出（视图常量等）+ 两新组件
  // 命名导出（星号不含 default → 无重复导出冲突）。
  const entryPath = path.join(tmp, "entry.mts");
  writeFileSync(
    entryPath,
    [
      `export { default as FilesSection } from ${JSON.stringify(srcPath)};`,
      `export * from ${JSON.stringify(srcPath)};`,
      `export { default as TrashDialog, TRASH_COLUMNS } from ${JSON.stringify(trashPath)};`,
      `export { default as SyncSettingsModal, SYNC_RUN_PATH, MIRROR_DIR } from ${JSON.stringify(syncPath)};`,
      "",
    ].join("\n"),
  );
  buildSync({
    entryPoints: [entryPath],
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "transform",
    outfile: path.join(tmp, "bundle.mjs"),
  });

  const mod = (await import(path.join(tmp, "bundle.mjs"))) as {
    FilesSection: (props: Record<string, unknown>) => React.ReactElement;
    fileViews: () => ("files" | "trash")[];
    FILE_VIEW_DEFAULT: "files" | "trash";
    hasInlineSyncCard: boolean;
    TRASH_COLUMNS: readonly string[];
    TrashDialog: (props: Record<string, unknown>) => React.ReactElement;
    SyncSettingsModal: (props: Record<string, unknown>) => React.ReactElement;
    SYNC_RUN_PATH: string;
    MIRROR_DIR: string;
  };
  const {
    FilesSection,
    fileViews,
    FILE_VIEW_DEFAULT,
    hasInlineSyncCard,
    TRASH_COLUMNS,
    TrashDialog,
    SyncSettingsModal,
    SYNC_RUN_PATH,
    MIRROR_DIR,
  } = mod;

  // ── ① 视图常量 + F-V3-3 视图切换移除（回收站入口 = 工具条按钮）──
  assert.deepEqual(fileViews(), ["files", "trash"]);
  assert.equal(FILE_VIEW_DEFAULT, "files");
  const htmlMid4 = renderToStaticMarkup(
    E(FilesSection as never, { nav, cols: 4, data, variant: "mid" }),
  );
  assert.ok(htmlMid4.includes("文件管理"), "标题行含页标题「文件管理」");
  assert.equal(count(htmlMid4, "我的文件"), 0, "「我的文件」tab 已移除（F-V3-3）");
  assert.ok(htmlMid4.includes("回收站"), "工具条「回收站」按钮入口在位");
  ok("① fileViews() = [\"files\",\"trash\"] 且默认 files；mid-4 视图切换移除 + 工具条回收站入口");

  // ── ② 回收站弹窗：列头常量 + 独立渲染 + API 接线 ──────────────
  assert.deepEqual(TRASH_COLUMNS, ["原路径", "大小", "删除时间", "操作"]);
  // TrashDialog 独立渲染（数据全由 props 传入；effects 不跑 → 空态）。
  const htmlTrash = renderToStaticMarkup(
    E(TrashDialog as never, {
      t,
      tr,
      open: true,
      onClose() {},
      humanName: "luo",
      isAdmin: true,
      entries: [],
      loading: false,
      trashStatus: "",
      trashError: "",
      onReload() {},
    }),
  );
  assert.ok(htmlTrash.includes("回收站是空的"), "TrashDialog 空态文案");
  // 源码接线：列头经 TRASH_COLUMNS.map（非硬编码四 <span>）；恢复/彻底删
  // 两个已有 API 直接调用；listTrash 已上移容器三腿（弹窗不得自取数）；
  // 空态/409/彻底删确认/非管理员禁用 purge。
  assert.ok(trashSrc.includes("TRASH_COLUMNS.map"), "列头渲染经 TRASH_COLUMNS.map");
  for (const api of ["restoreTrash", "purgeTrash"]) {
    assert.ok(trashSrc.includes(api), `TrashDialog 调已有 API ${api}`);
  }
  assert.ok(!trashSrc.includes("listTrash("), "弹窗不自取数（无 listTrash 调用）");
  assert.ok(trashSrc.includes("回收站是空的"), "空态「回收站是空的」在位");
  assert.ok(trashSrc.includes("同名文件已存在"), "409 文案在位");
  assert.ok(trashSrc.includes("覆盖恢复"), "管理员「覆盖恢复」在位");
  assert.ok(trashSrc.includes("彻底删除此项？"), "彻底删二次确认在位");
  assert.ok(trashSrc.includes("!isAdmin"), "非管理员禁用彻底删除");
  ok("② TRASH_COLUMNS = [原路径/大小/删除时间/操作]；TrashDialog 独立渲染 + API 接线（无 listTrash）");

  // ── ③ 同步长条移除：hasInlineSyncCard=false + 无渲染残留 + 入口 ─
  assert.equal(hasInlineSyncCard, false, "hasInlineSyncCard 导出 = false");
  assert.ok(!src.includes("<SyncCard"), "FilesSection 源码无 <SyncCard 渲染残留");
  const htmlMid2 = renderToStaticMarkup(
    E(FilesSection as never, { nav, cols: 2, data, variant: "mid" }),
  );
  assert.equal(count(htmlMid2, ">同步设置<"), 1, "工具条「同步设置」按钮恰 1 处");
  assert.equal(count(htmlMid2, "复制清单原文"), 0, "旧 SyncCard「复制清单原文」按钮 0 处");
  assert.ok(src.includes("<SyncSettingsModal"), "弹窗组件已接入容器");
  assert.ok(src.includes("setSyncModalOpen(true)"), "「同步设置」按钮 → 打开弹窗");
  ok("③ hasInlineSyncCard=false；无 <SyncCard 残留；工具条「同步设置」恰 1 处 + 弹窗已接");

  // ── ④ 同步弹窗：直接渲染 open=true（三态：null / empty / ok）────
  const modalBase = {
    t,
    tr,
    humanName: "luo",
    open: true,
    onClose() {},
    onSynced() {},
  };
  const htmlMNull = renderToStaticMarkup(
    E(SyncSettingsModal as never, { ...modalBase, st: null, syncOk: false }),
  );
  assert.ok(htmlMNull.includes("加载中…"), "st=null →「加载中…」");
  const htmlMEmpty = renderToStaticMarkup(
    E(SyncSettingsModal as never, {
      ...modalBase,
      st: { state: "empty", entries: 0, tombstones: 0, generation: 0 },
      syncOk: false,
    }),
  );
  assert.ok(
    htmlMEmpty.includes("尚无清单（本地同步客户端未写入）"),
    "st=empty → 未就绪原因（按钮仍可点，服务端终裁）",
  );
  assert.ok(!htmlMEmpty.includes("disabled=\"true\""), "未就绪态「立即同步」未禁用");
  const htmlMOk = renderToStaticMarkup(
    E(SyncSettingsModal as never, {
      ...modalBase,
      st: {
        state: "ok",
        entries: 12,
        tombstones: 3,
        generation: 7,
        updatedAt: "2026-11-06T12:00:00Z",
        updatedBy: "luo",
      },
      syncOk: true,
    }),
  );
  assert.ok(htmlMOk.includes("条目 12"), "st=ok → 条目计数");
  assert.ok(htmlMOk.includes("最后写入者 luo"), "st=ok → 最后写入者");
  ok("④ SyncSettingsModal open=true：null→加载中… / empty→原因 / ok→条目+写入者");

  // ── ⑤ 常量口径 + 「立即同步」POST 接线 ────────────────────────
  assert.equal(SYNC_RUN_PATH, "/agentteams-proxy/sync/run");
  assert.equal(MIRROR_DIR, "<workspace>/.qwenpaw/agentteams");
  assert.ok(syncSrc.includes("SYNC_RUN_PATH"), "弹窗源码引用 SYNC_RUN_PATH");
  assert.ok(syncSrc.includes('method: "POST"'), "「立即同步」= POST /sync/run");
  assert.ok(syncSrc.includes("MIRROR_DIR"), "弹窗展示镜像目录常量");
  ok("⑤ SYNC_RUN_PATH / MIRROR_DIR 常量口径 + POST 接线");

  console.log(`\nfiles-v3-1: ${n} passed`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
