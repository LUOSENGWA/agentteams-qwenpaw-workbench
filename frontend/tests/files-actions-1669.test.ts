// #1669：文件页动作与触控——上传入口唯一 + 44px/40px 触控目标 + 复用预览。
// 直跑：node --experimental-strip-types frontend/tests/files-actions-1669.test.ts
//（node:assert/strict；不进 vitest 面——文件名不带 .vitest.）。
//
// 加载路径：同 files-ui-1667 先例——esbuild buildSync 把 FilesSection.tsx
// 整树 bundle 到临时 .mjs（先注入 window/host shim：真 React + 最小 antd
// 桩 + document 桩），再动态 import；renderToStaticMarkup 静态渲染
//（effects 不跑 → 初始态）。
//
// 覆盖（任务书 ≥3 条）：
// ① uploadEntryPoints() 返回长度 = 1（导出纯函数列举全页唯一上传入口：
//    一个 input + 一个 onPickFiles）；结构断言：全页恰 1 处 type="file"
//    input、恰 1 处 ref={uploadInputRef}（模块级共享 ref——l1 死按钮根修）、
//    详情面板 owRef 私有 input 已移除；行为断言：requestFilePick →
//    onPickFiles 的 sink 派发（有文件 → sink(file)；取消 → 不派发；
//    sink 一次性消费）。
// ② touchTargets：TOUCH 常量 行高 ≥44 / 按钮 ≥40 / 按钮留白 ≥8 / 图标间距 ≥8；
//    touchCss() 输出 CSS 变量 + coarse 指针 10% 放大（48/44）；行与按钮
//    实际引用 var(--hf-row-min) / var(--hf-btn-min)（无硬编码 36px 残留）。
// ③ previewable()：md/png/csv/xlsx → true；bin → false（含文件名/前导点
//    形态）；FileDetail 内嵌 <FilePreview file=（复用 components/FilePreview，
//    不新写预览）；TrashDetail 不挂载预览（回收站条目不预览）。
// ④ 上传成功后强制刷新接线：load(true, {force:true})（工具条/空态 CTA 上传
//    + 详情覆盖上传）；forceListUrl 确定性（尾斜杠 + 时间戳 + 逐段
//    encodeURIComponent）；forceList 带 cache:"no-store"。
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
const tmp = mkdtempSync(path.join(tmpdir(), "files-actions-1669-"));

// ── 最小 antd 桩（同 files-ui-1667；FilePreview 初始态 file=null 渲染 null，
// 静态渲染只走 FilesSection 初始态路径）────────────────────────────
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

// ManageNav 运行时仅需 selectedFile / selectFile；data 形状 = ManageData 最小集。
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
    TOUCH: {
      rowMinHeight: number;
      btnMinSize: number;
      btnPadding: number;
      iconGap: number;
      coarseScale: number;
    };
    touchCss: () => string;
    previewable: (nameOrExt: string) => boolean;
    uploadEntryPoints: () => {
      id: string;
      inputCount: number;
      pickHandler: string;
      surfaces: string[];
    }[];
    requestFilePick: (sink: (file: File) => void | Promise<void>) => void;
    onPickFiles: (e: unknown) => Promise<void>;
    forceListUrl: (humanName: string, dir: string, now?: number) => string;
  };
  const FilesSection = mod.default;
  const {
    TOUCH,
    touchCss,
    previewable,
    uploadEntryPoints,
    requestFilePick,
    onPickFiles,
    forceListUrl,
  } = mod;

  // ── ① 上传入口唯一（纯函数 + 结构 + 行为）────────────────────
  const eps = uploadEntryPoints();
  assert.equal(eps.length, 1, `uploadEntryPoints().length = ${eps.length}（应 = 1）`);
  assert.equal(eps[0].inputCount, 1, "页面内隐藏 file input 数 = 1");
  assert.equal(eps[0].pickHandler, "onPickFiles", "唯一 pick 处理器 = onPickFiles");
  // 结构：全页恰 1 处 <input type="file">（详情面板 owRef 私有 input 已移除），
  // 且恰 1 处绑定模块级共享 ref（l1/mid 双实例死按钮根修）。
  assert.equal(count(src, 'type="file"'), 1, "type=\"file\" 应恰 1 处");
  assert.equal(count(src, "ref={uploadInputRef}"), 1, "ref={uploadInputRef} 应恰 1 处");
  assert.equal(count(src, "ref={owRef}"), 0, "详情面板 owRef 私有 input 应已移除");
  assert.ok(src.includes("export async function onPickFiles"), "onPickFiles 已导出");
  // 工具条按钮与列表空态 CTA 共享同一 onUploadClick（同一入口的上传表面）。
  assert.ok(count(src, "onClick={actions.onUploadClick}") >= 2, "工具条 + 空态 CTA 共用 onUploadClick");
  ok("① uploadEntryPoints() = 1 个入口（一个 input + 一个 onPickFiles；结构 + 接线断言）");

  // ①b 行为：requestFilePick 注册 sink → onPickFiles 派发；取消不派发；
  // sink 一次性消费（防「点 A 选文件、落到 B 的旧 sink」类错配）。
  let picked: unknown = null;
  let pickCalls = 0;
  requestFilePick((f) => {
    pickCalls += 1;
    picked = f;
  });
  const f1 = new File(["hello"], "a.txt", { type: "text/plain" });
  const pickEvt = (files: File[] | null, value: string) =>
    ({ target: { files, value } }) as unknown;
  await onPickFiles(pickEvt([f1], "a.txt"));
  assert.equal(pickCalls, 1, "有文件 → sink 调用 1 次");
  assert.equal(picked, f1, "sink 收到所选文件");
  let cancelCalls = 0;
  requestFilePick(() => {
    cancelCalls += 1;
  });
  await onPickFiles(pickEvt([], ""));
  assert.equal(cancelCalls, 0, "取消（无文件）→ 不派发");
  await onPickFiles(pickEvt([f1], "a.txt"));
  assert.equal(pickCalls, 1, "sink 一次性消费（未重新点击 → 不再派发）");
  ok("①b requestFilePick → onPickFiles：sink 派发 / 取消不派发 / 一次性消费");

  // ── ② 触控目标：常量 + CSS 变量 + 实际引用 ───────────────────
  assert.ok(TOUCH.rowMinHeight >= 44, `行高 ${TOUCH.rowMinHeight} ≥ 44`);
  assert.ok(TOUCH.btnMinSize >= 40, `按钮 ${TOUCH.btnMinSize} ≥ 40`);
  assert.ok(TOUCH.btnPadding >= 8, `按钮留白 ${TOUCH.btnPadding} ≥ 8`);
  assert.ok(TOUCH.iconGap >= 8, `图标间距 ${TOUCH.iconGap} ≥ 8`);
  const css = touchCss();
  assert.ok(css.includes(`--hf-row-min:${TOUCH.rowMinHeight}px`), "touchCss 输出行高变量");
  assert.ok(css.includes(`--hf-btn-min:${TOUCH.btnMinSize}px`), "touchCss 输出按钮变量");
  const rowC = Math.ceil(TOUCH.rowMinHeight * TOUCH.coarseScale);
  const btnC = Math.ceil(TOUCH.btnMinSize * TOUCH.coarseScale);
  assert.ok(css.includes("@media (pointer: coarse)"), "touchCss 含 coarse 指针媒体查询");
  assert.ok(css.includes(`--hf-row-min:${rowC}px`), `coarse 行高 10% 放大（${rowC}px）`);
  assert.ok(css.includes(`--hf-btn-min:${btnC}px`), `coarse 按钮 10% 放大（${btnC}px）`);
  // 行（FileRow/TrashRow 各 compact + 非 compact）引用行高变量；
  // 按钮（iconBtnStyle / 视图 Tab / 面包屑）引用按钮变量。
  const rowVarUses = count(src, "var(--hf-row-min, 44px)");
  assert.ok(rowVarUses >= 4, `行高变量引用 ${rowVarUses} 处（应 ≥ 4）`);
  const btnVarUses = count(src, "var(--hf-btn-min, 40px)");
  assert.ok(btnVarUses >= 5, `按钮变量引用 ${btnVarUses} 处（应 ≥ 5）`);
  assert.ok(!src.includes("height: 36") && !src.includes("minHeight: 36"), "无硬编码 36px 行高残留");
  ok(`② touchTargets：行 ≥44 / 按钮 ≥40 / 间距 ≥8；coarse +10%；行 ${rowVarUses} 处 + 按钮 ${btnVarUses} 处引用变量`);

  // ── ③ 预览：previewable 类型集 + FilePreview 复用 + 回收站不预览 ──
  for (const ext of ["md", "png", "csv", "xlsx"]) {
    assert.equal(previewable(ext), true, `previewable(${ext}) = true`);
  }
  assert.equal(previewable("bin"), false, "previewable(bin) = false");
  assert.equal(previewable("README.md"), true, "previewable(README.md) = true（文件名形态）");
  assert.equal(previewable("archive.bin"), false, "previewable(archive.bin) = false");
  assert.equal(previewable(".xlsx"), true, "previewable(.xlsx) = true（前导点形态）");
  // FileDetail 内嵌 <FilePreview file=（复用 components/FilePreview，不新写预览）。
  assert.ok(src.includes("<FilePreview file="), "FileDetail 内嵌 <FilePreview file=");
  assert.ok(src.includes('from "../components/FilePreview"'), "import components/FilePreview");
  // 回收站条目不预览：TrashDetail 函数体内无 FilePreview。
  const tdStart = src.indexOf("function TrashDetail");
  const tdEnd = src.indexOf("function SyncCard");
  assert.ok(tdStart > 0 && tdEnd > tdStart, "定位 TrashDetail 区间");
  assert.ok(!src.slice(tdStart, tdEnd).includes("FilePreview"), "TrashDetail 不挂载预览（回收站条目不预览）");
  ok("③ previewable：md/png/csv/xlsx → true；bin → false；FilePreview 复用 + 回收站不预览");

  // ── ④ 上传成功后强制刷新接线（时间戳 + no-store）─────────────
  assert.ok(src.includes("inp.load(true, { force: true })"), "工具条/空态 CTA 上传成功 → load(true,{force:true})");
  assert.ok(src.includes("fs.load(true, { force: true })"), "详情覆盖上传成功 → load(true,{force:true})");
  assert.ok(src.includes('cache: "no-store"'), "forceList 带 cache:\"no-store\"");
  // forceListUrl 确定性：与 legacy 端点同形态（尾斜杠）+ 时间戳 + 逐段编码。
  assert.equal(
    forceListUrl("luo", "docs", 123),
    "/agentteams-proxy/controller/api/v1/humans/luo/files/docs/?_ts=123",
    "子目录 force URL（尾斜杠 + 时间戳）",
  );
  assert.equal(
    forceListUrl("luo", "", 123),
    "/agentteams-proxy/controller/api/v1/humans/luo/files/?_ts=123",
    "根目录 force URL",
  );
  assert.equal(
    forceListUrl("luo", "a b/c", 1),
    "/agentteams-proxy/controller/api/v1/humans/luo/files/a%20b/c/?_ts=1",
    "逐段 encodeURIComponent",
  );
  ok("④ 强制刷新接线：load(true,{force:true}) + forceListUrl 尾斜杠/时间戳/编码 + no-store");

  // ── ⑤ 渲染 smoke：触控改动不破初始态渲染；左 CTA 仍在；CSS 注入 ──
  const htmlMid2 = renderToStaticMarkup(
    E(FilesSection as never, { nav, cols: 2, data, variant: "mid" }),
  );
  assert.equal(count(htmlMid2, ">上传文件<"), 1, "工具条上传按钮渲染");
  assert.equal(count(htmlMid2, 'type="file"'), 1, "渲染出的 file input 恰 1 个");
  assert.ok(htmlMid2.includes("<style>"), "触控 CSS 变量 <style> 已注入");
  const htmlL1 = renderToStaticMarkup(
    E(FilesSection as never, { nav, cols: 4, data, variant: "l1" }),
  );
  assert.ok(htmlL1.includes(">上传一个文件<"), "l1 空态 CTA（左按钮）渲染——经模块级共享 ref 可用");
  ok("⑤ 渲染 smoke：mid 初始态 + 唯一 file input + CSS 注入；l1 左 CTA 渲染");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`files-actions-1669: ${n} passed`);
