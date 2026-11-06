// F-V3-3：文件页去重 + 回收站改弹窗 + 刷新语义/新鲜度 + 撤销。
// 直跑：node --experimental-strip-types frontend/tests/files-v3-3.test.ts
//（node:assert/strict；不进 vitest 面——文件名不带 .vitest.）。
//
// 加载路径：照 files-v3-1 先例——临时 entry 重导出 ManagePage（showL1）+
// FilesSection（纯函数：shouldPoll / shouldRefetchOnFocus / columnsFor /
// undoEligible / makeReloadDedup + LIST_GRID 常量）+ files/TrashDialog
//（默认组件 + TRASH_COLUMNS / trashRowsSort / trashFilter）+ files/format
//（fmtTs / fmtBytes），esbuild buildSync 到临时 .mjs（window/host shim：
// 真 React + 最小 antd 桩 + document 桩），再动态 import；
// renderToStaticMarkup 静态渲染（effects 不跑 → 仅初始态断言）。
//
// 覆盖（任务书 ≥9 条）：
// ① showL1("files",4)===false / showL1("team",4)===true（4 栏 L1 列去重）；
// ② shouldPoll 子目录也轮询（dirPath="sub" + active → true，门控已删）；
// ③ shouldPoll 三 false（未激活 / 404 / nextKey 为 string 分页中途）；
// ④ shouldRefetchOnFocus 距上次成功 >10s → true，≤10s → false；
// ⑤ columnsFor 整批无 updatedAt → 不含「更新时间」列（grid 同步缩列）；
// ⑥ fmtTs(undefined)===""（缺失不再显示 "—"）；
// ⑦ trashRowsSort desc（删除时间倒序；缺失恒排尾；不改原数组）；
// ⑧ trashFilter 按原路径大小写不敏感子串；
// ⑨ undoEligible 非空 trashId → true，空串 → false；
// ⑩ makeReloadDedup 行为（同 key in-flight 复用 / settle 后重发 / 异 key 不互斥）；
// ⑪ TrashDialog 静态渲染（空态「回收站是空的」/ 副标题计数 / 原路径去
//    files/ 前缀 / >1 项显「全部恢复」/ 错误态 Alert）；
// ⑫ 源码接线（TrashDialog 不含 listTrash——不自取数；两弹窗共用
//    DialogShell 同一套 Modal 配置；轮询门控「仅根目录」已删；
//    容器持有 makeReloadDedup 实例 + 撤销条接线）。
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
const managePath = path.join(root, "src", "manage", "ManagePage.tsx");
const srcPath = path.join(root, "src", "manage", "FilesSection.tsx");
const dialogPath = path.join(root, "src", "manage", "files", "TrashDialog.tsx");
const syncPath = path.join(root, "src", "manage", "files", "SyncSettingsModal.tsx");
const formatPath = path.join(root, "src", "manage", "files", "format.ts");
const src = readFileSync(srcPath, "utf8");
const dialogSrc = readFileSync(dialogPath, "utf8");
const syncSrc = readFileSync(syncPath, "utf8");
const tmp = mkdtempSync(path.join(tmpdir(), "files-v3-3-"));

// ── 最小 antd 桩（同 files-v3-1；Modal 桩 = open 时显容器）────────────
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
  accentBg: "#e6f4ff",
  danger: "#ff4d4f",
} as Record<string, string>;

try {
  // 单 bundle 入口：ManagePage（showL1）+ FilesSection（纯函数集合）+
  // TrashDialog（默认组件 + 纯函数）+ format（fmtTs/fmtBytes）。
  const entryPath = path.join(tmp, "entry.mts");
  writeFileSync(
    entryPath,
    [
      `export { default as ManagePage, showL1 } from ${JSON.stringify(managePath)};`,
      `export { default as FilesSection } from ${JSON.stringify(srcPath)};`,
      `export * from ${JSON.stringify(srcPath)};`,
      `export { default as TrashDialog, TRASH_COLUMNS, trashRowsSort, trashFilter } from ${JSON.stringify(
        dialogPath,
      )};`,
      `export { fmtTs, fmtBytes, normTrashPath } from ${JSON.stringify(formatPath)};`,
      "",
    ].join("\n"),
  );
  buildSync({
    entryPoints: [entryPath],
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "transform",
    // ManagePage 图含 OpenClawIcon → assets/*.svg（vite 下 = URL 字符串；
    // 测试以文本内联，<img src> 消费字符串即可）。
    loader: { ".svg": "text" },
    outfile: path.join(tmp, "bundle.mjs"),
  });

  const mod = (await import(path.join(tmp, "bundle.mjs"))) as Record<
    string,
    (...args: unknown[]) => unknown
  > & {
    showL1: (s: string, c: number) => boolean;
    shouldPoll: (o: {
      active: boolean;
      status: "" | "404" | "err";
      dirPath: string;
      nextKey: string | null | undefined;
    }) => boolean;
    shouldRefetchOnFocus: (last: number, now: number) => boolean;
    FOCUS_REFETCH_MS: number;
    columnsFor: (entries: unknown[]) => { showUpdatedAt: boolean; grid: string };
    undoEligible: (id: string) => boolean;
    makeReloadDedup: () => (key: string, run: () => Promise<void>) => Promise<void>;
    LIST_GRID: string;
    LIST_GRID_NO_TIME: string;
    TrashDialog: (props: Record<string, unknown>) => React.ReactElement;
    TRASH_COLUMNS: readonly string[];
    trashRowsSort: (rows: unknown[], dir: "desc" | "asc") => unknown[];
    trashFilter: (rows: unknown[], q: string) => unknown[];
    fmtTs: (iso?: string | null) => string;
    fmtBytes: (n?: number | null) => string;
    normTrashPath: (p: string) => string;
  };
  const {
    showL1,
    shouldPoll,
    shouldRefetchOnFocus,
    FOCUS_REFETCH_MS,
    columnsFor,
    undoEligible,
    makeReloadDedup,
    LIST_GRID,
    LIST_GRID_NO_TIME,
    TrashDialog,
    TRASH_COLUMNS,
    trashRowsSort,
    trashFilter,
    fmtTs,
    normTrashPath,
  } = mod;

  // ── ① 4 栏 L1 列去重：files 例外 ────────────────────────────────
  assert.equal(showL1("files", 4), false, "files 4 栏无 L1 列表列");
  assert.equal(showL1("team", 4), true, "team 4 栏 L1 列常显");
  assert.equal(showL1("files", 3), false, "非 4 栏无 L1 列（原行为）");
  ok("① showL1：files 4 栏 false / team 4 栏 true");

  // ── ② 子目录也静默轮询（「仅根目录」门控已删）──────────────────
  assert.equal(
    shouldPoll({ active: true, dirPath: "sub", status: "", nextKey: undefined }),
    true,
    "子目录（dirPath 非空）也轮询",
  );
  assert.equal(
    shouldPoll({ active: true, dirPath: "", status: "", nextKey: undefined }),
    true,
    "根目录照旧轮询",
  );
  ok("② shouldPoll：子目录也轮询（门控删除生效）");

  // ── ③ shouldPoll 三个保留门控 ──────────────────────────────────
  assert.equal(
    shouldPoll({ active: false, dirPath: "", status: "", nextKey: undefined }),
    false,
    "未激活（后台 tab）不轮询",
  );
  assert.equal(
    shouldPoll({ active: true, dirPath: "", status: "404", nextKey: undefined }),
    false,
    "404 停重试",
  );
  assert.equal(
    shouldPoll({ active: true, dirPath: "", status: "", nextKey: "cursor-1" }),
    false,
    "分页中途（nextKey 为 string）跳过",
  );
  ok("③ shouldPoll 三 false：未激活 / 404 / 分页中途");

  // ── ④ 焦点感知新鲜度阈值（>10s 重取）───────────────────────────
  const t0 = 1_700_000_000_000;
  assert.equal(shouldRefetchOnFocus(t0, t0 + FOCUS_REFETCH_MS + 1), true, ">10s → 重取");
  assert.equal(shouldRefetchOnFocus(t0, t0 + FOCUS_REFETCH_MS), false, "恰好 10s → 不重取");
  assert.equal(shouldRefetchOnFocus(t0, t0), false, "0s → 不重取");
  ok("④ shouldRefetchOnFocus：>10s true / ≤10s false");

  // ── ⑤ 列自适应：整批无 updatedAt → 无「更新时间」列 ────────────
  const rowsNoTime = [
    { name: "a.txt", type: "file", size: 12 },
    { name: "sub", type: "dir" },
  ];
  const c1 = columnsFor(rowsNoTime);
  assert.equal(c1.showUpdatedAt, false, "整批无 updatedAt → 不渲染该列");
  assert.equal(c1.grid, LIST_GRID_NO_TIME, "grid 模板同步缩列");
  assert.ok(!c1.grid.includes("120px"), "缩列后 grid 无 120px 时间列宽");
  const c2 = columnsFor([{ name: "b.txt", type: "file", size: 1, updatedAt: "2026-11-06T00:00:00Z" }]);
  assert.equal(c2.showUpdatedAt, true, "有 updatedAt → 保留该列");
  assert.equal(c2.grid, LIST_GRID, "grid 模板 = 四列");
  ok("⑤ columnsFor：无 updatedAt 不含「更新时间」列（表头/行/grid 同步）");

  // ── ⑥ fmtTs 缺失 → ""（不再 "—"）───────────────────────────────
  assert.equal(fmtTs(undefined), "");
  assert.equal(fmtTs(null), "");
  assert.equal(fmtTs(""), "");
  assert.equal(fmtTs("not-a-date"), "");
  assert.ok(fmtTs("2026-11-06T12:00:00Z").length > 0, "合法 ISO → 非空");
  ok("⑥ fmtTs：undefined / null / 空串 / 非法 → \"\"");

  // ── ⑦ trashRowsSort：删除时间排序（desc 默认；缺失恒排尾；纯）──
  const rows = [
    { id: "a", path: "files/a.txt", size: 1, deletedAt: "2026-11-06T10:00:00Z", caller: "x", role: "r" },
    { id: "b", path: "files/b.txt", size: 1, deletedAt: "2026-11-06T12:00:00Z", caller: "x", role: "r" },
    { id: "c", path: "files/c.txt", size: 1, deletedAt: undefined, caller: "x", role: "r" },
  ];
  const before = JSON.stringify(rows);
  const desc = trashRowsSort(rows, "desc") as { id: string }[];
  assert.deepEqual(
    desc.map((r) => r.id),
    ["b", "a", "c"],
    "desc：新→旧，缺失恒排尾",
  );
  const asc = trashRowsSort(rows, "asc") as { id: string }[];
  assert.deepEqual(
    asc.map((r) => r.id),
    ["a", "b", "c"],
    "asc：旧→新，缺失恒排尾",
  );
  assert.equal(JSON.stringify(rows), before, "不改原数组（纯函数）");
  ok("⑦ trashRowsSort：desc/asc 排序 + 缺失排尾 + 不可变");

  // ── ⑧ trashFilter：原路径子串（大小写不敏感）───────────────────
  assert.equal(trashFilter(rows, "").length, 3, "空白查询 = 原样");
  assert.equal(trashFilter(rows, "  ").length, 3, "纯空白 = 原样");
  // 过滤按展示口径（normTrashPath 去 files/ 前缀）匹配。
  assert.deepEqual(
    (trashFilter(rows, "a.txt") as { id: string }[]).map((r) => r.id),
    ["a"],
    "精确路径命中（归一化口径）",
  );
  const mixed = [
    { id: "e", path: "files/Logs/APP.log", size: 1, caller: "x", role: "r" },
    { id: "f", path: "files/notes.md", size: 1, caller: "x", role: "r" },
  ];
  assert.equal(
    (trashFilter(mixed, "logs/app") as { id: string }[]).length,
    1,
    "小写查询命中原路径（不敏感）",
  );
  assert.equal(
    (trashFilter(mixed, "LOGS/APP") as { id: string }[]).length,
    1,
    "大写查询命中原路径（不敏感）",
  );
  assert.equal(trashFilter(mixed, "zzz").length, 0, "无命中 → 空");
  ok("⑧ trashFilter：原路径子串 + 大小写不敏感");

  // ── ⑨ undoEligible：trashId 非空才出撤销条 ─────────────────────
  assert.equal(undoEligible("trash-123"), true, "非空 → 可撤销");
  assert.equal(undoEligible(""), false, "空串 → 不出条");
  ok("⑨ undoEligible：非空 true / 空串 false");

  // ── ⑩ makeReloadDedup：in-flight 去重 + 尾随重放 ────────────────
  {
    let runs = 0;
    let resolve: () => void = () => {};
    const run = (): Promise<void> =>
      new Promise<void>((res) => {
        runs += 1;
        resolve = res;
      });
    const d = makeReloadDedup();
    const p1 = d("k", run);
    const p2 = d("k", run);
    assert.equal(runs, 1, "同 key in-flight → 复用，不叠发");
    assert.equal(p1, p2, "同 key 返回同一 Promise");
    resolve();
    await p1;
    // 被合并的那次点击在落地后补跑一次：刷新按钮不会被静默吞掉。
    assert.equal(runs, 2, "排队请求在 settle 后重放");
    resolve();
    // 没有排队请求时，settle 不产生多余重发。
    let runsOnce = 0;
    const dOnce = makeReloadDedup();
    await dOnce("once", () => {
      runsOnce += 1;
      return Promise.resolve();
    });
    assert.equal(runsOnce, 1, "无排队 → 只跑一次");
    // 异 key 不互斥。
    let runs2 = 0;
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((res) => {
      releaseGate = res;
    });
    const d2 = makeReloadDedup();
    void d2("a", () => {
      runs2 += 1;
      return gate.then(() => {});
    });
    void d2("b", () => {
      runs2 += 1;
      return gate.then(() => {});
    });
    assert.equal(runs2, 2, "异 key 并发不互斥");
    releaseGate();
  }
  ok("⑩ makeReloadDedup：同 key 复用 / settle 重发 / 异 key 不互斥");

  // ── ⑪ TrashDialog 静态渲染（effects 不跑 → 初始态）─────────────
  const dialogBase = {
    t,
    tr,
    open: true,
    onClose() {},
    humanName: "luo",
    isAdmin: true,
    loading: false,
    trashStatus: "" as "" | "err",
    trashError: "",
    onReload() {},
  };
  assert.deepEqual([...TRASH_COLUMNS], ["原路径", "大小", "删除时间", "操作"]);
  const htmlEmpty = renderToStaticMarkup(
    E(TrashDialog as never, { ...dialogBase, entries: [] }),
  );
  assert.ok(htmlEmpty.includes("回收站是空的"), "空态文案在位");
  assert.ok(htmlEmpty.includes("共 0 项"), "副标题计数 0");
  const entryA = { id: "a", path: "files/a.txt", size: 1, deletedAt: "2026-11-06T10:00:00Z", caller: "x", role: "r" };
  const entryB = { id: "b", path: "files/b.log", size: 2, deletedAt: "2026-11-06T12:00:00Z", caller: "x", role: "r" };
  const htmlRows = renderToStaticMarkup(
    E(TrashDialog as never, { ...dialogBase, entries: [entryA, entryB] }),
  );
  assert.ok(htmlRows.includes("共 2 项"), "副标题计数 2");
  assert.ok(htmlRows.includes(normTrashPath("files/a.txt")), "原路径去 files/ 前缀展示");
  assert.ok(htmlRows.includes("全部恢复"), ">1 项显「全部恢复」");
  const htmlErr = renderToStaticMarkup(
    E(TrashDialog as never, { ...dialogBase, entries: [], trashStatus: "err" }),
  );
  assert.ok(htmlErr.includes("回收站加载失败"), "错误态 Alert 文案");
  ok("⑪ TrashDialog 静态渲染：空态 / 计数副标题 / 路径展示 / 全部恢复 / 错误态");

  // ── ⑫ 源码接线（数据流 / 单一外壳 / 门控删除 / 撤销条）─────────
  assert.ok(!dialogSrc.includes("listTrash("), "弹窗不自取数（无 listTrash 调用）");
  assert.ok(dialogSrc.includes("DialogShell"), "回收站弹窗走统一外壳");
  assert.ok(syncSrc.includes("DialogShell"), "同步弹窗走同一外壳（禁两份 Modal 配置）");
  assert.ok(
    !src.includes('if (dirPath !== "") return'),
    "轮询「仅根目录」门控已删",
  );
  assert.ok(src.includes("makeReloadDedup()"), "容器持有去重实例");
  assert.ok(src.includes("offerUndo"), "软删 → 撤销条登记接线");
  assert.ok(src.includes("已移入回收站"), "撤销条文案在位");
  assert.equal(
    count(src, "fs.onOpenTrash()"),
    1,
    "工具条「回收站」按钮 → 打开弹窗",
  );
  ok("⑫ 源码接线：弹窗不自取数 / DialogShell 单套 / 门控删除 / 撤销条");

  console.log(`\nfiles-v3-3: ${n} passed`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
