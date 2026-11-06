// #1669：删除确认（勾选「移入回收站（可恢复）」/彻底删除）——
// deletePlan 纯函数 + 403 错误映射行为 + 复用/目录接线断言。
// 直跑：node --experimental-strip-types frontend/tests/files-delete-1669.test.ts
//（node:assert/strict；加载路径照 files-ui-1667 先例：临时 entry 重导出
// FilesSection 的 deletePlan/hfErrorText + humanFiles 的 HumanFilesError
// （同一 bundle = 同一类，hfErrorText 内 instanceof 成立），esbuild
// buildSync 到临时 .mjs（window/host shim：真 React + 最小 antd 桩），
// 再动态 import。）
//
// 覆盖（任务书 ≥3 条）：
// ① deletePlan({recycle:true}) → ["soft"]（勾选（默认）= 仅软删，可恢复）；
// ② deletePlan({recycle:false}) → ["soft","purge"]（不带任何角色判断——
//    签名仅 recycle 参数，权限由服务端终裁）；
// ③ 调用顺序：先 soft 后 purge（soft 取 trashId，purge 用 trashId）；
//    recycle 计划不含 purge；
// ④ 403 → hfErrorText「无权限」（角色无关；前端不预判角色）；
// ⑤ 接线：useDeleteConfirm 一处定义 + 列表行/详情面板两处共用；
//    旧「移入回收站？」确认标题移除；目录行「目录删除暂不支持」提示在位。
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const srcPath = path.join(root, "src", "manage", "FilesSection.tsx");
const apiPath = path.join(root, "src", "api", "domains", "humanFiles.ts");
const src = readFileSync(srcPath, "utf8");
const tmp = mkdtempSync(path.join(tmpdir(), "files-delete-1669-"));

// ── 最小 antd 桩（模块顶层仅引用；不渲染删除确认框——open=false 不渲染）──
const E = React.createElement;
const antdShim = {
  Modal: Object.assign(
    (p: Record<string, unknown>) =>
      p.open ? E("div", { "data-modal": "1" }, p.title, p.children) : null,
    { confirm: () => {} },
  ),
  Checkbox: (p: Record<string, unknown>) =>
    E("input", {
      type: "checkbox",
      "data-checkbox": "1",
      checked: p.checked ? "true" : undefined,
    }),
  Tooltip: (p: Record<string, unknown>) => E("span", null, p.children),
  Button: (p: Record<string, unknown>) =>
    E(
      "button",
      { type: "button", disabled: p.disabled ? "true" : undefined },
      p.children,
    ),
  Input: (p: Record<string, unknown>) => E("input", { "data-input": "1" }),
  Progress: () => E("span"),
  Alert: (p: Record<string, unknown>) => E("div", null, p.message),
  Switch: (p: Record<string, unknown>) =>
    E("input", { type: "checkbox", disabled: p.disabled ? "true" : undefined }),
  message: { success() {}, error() {}, warning() {} },
};

// window/host shim（模块顶层 window.QwenPaw.host 在 import 时读）。
(globalThis as Record<string, unknown>).window = {
  QwenPaw: {
    host: {
      React,
      antd: antdShim,
      antdIcons: {},
      useLocale: () => "zh",
      useTheme: () => "light",
      fetch: () => Promise.reject(new Error("test: no network")),
    },
  },
};
(globalThis as Record<string, unknown>).document = { hidden: false };

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

try {
  // 单 bundle 入口：两模块符号同源重导出 → HumanFilesError 的
  // instanceof 判定成立（403 映射行为测试需要）。
  const entryPath = path.join(tmp, "entry.mts");
  writeFileSync(
    entryPath,
    [
      `export { deletePlan, hfErrorText } from ${JSON.stringify(srcPath)};`,
      `export { HumanFilesError } from ${JSON.stringify(apiPath)};`,
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
    deletePlan: (opts: { recycle: boolean }) => string[];
    hfErrorText: (
      e: unknown,
      tr: (s: string, v?: Record<string, string | number>) => string,
    ) => string;
    HumanFilesError: new (
      status: number,
      message: string,
      code?: string,
    ) => { status: number; message: string };
  };
  const { deletePlan, hfErrorText, HumanFilesError } = mod;

  // ── ① 勾选（默认）= 仅软删 ──────────────────────────────────────
  assert.deepEqual(deletePlan({ recycle: true }), ["soft"]);
  ok("① deletePlan({recycle:true}) → [\"soft\"]（仅软删，进回收站可恢复）");

  // ── ② 未勾选 = 软删 + 彻底删，无角色判断 ─────────────────────────
  assert.deepEqual(deletePlan({ recycle: false }), ["soft", "purge"]);
  assert.match(
    src,
    /export function deletePlan\(\s*opts: \{\s*recycle: boolean\s*\}\s*\):\s*string\[\]/,
    "签名仅 recycle 参数（无角色/权限入参）",
  );
  ok("② deletePlan({recycle:false}) → [\"soft\",\"purge\"]（不带任何角色判断）");

  // ── ③ 调用顺序：先 soft（取 trashId）后 purge（用 trashId）─────
  const both = deletePlan({ recycle: false });
  assert.equal(both.indexOf("soft"), 0, "soft 在首位");
  assert.equal(both.indexOf("purge"), 1, "purge 在末位（依赖 soft 的 trashId）");
  assert.ok(both.indexOf("soft") < both.indexOf("purge"), "soft 必须先于 purge");
  assert.ok(!deletePlan({ recycle: true }).includes("purge"), "recycle 计划不含 purge");
  ok("③ 顺序 = 先 soft（deleteFile）后 purge（purgeTrash(trashId)）");

  // ── ④ 403 →「无权限」（角色无关；前端不预判角色）────────────────
  assert.equal(
    hfErrorText(new HumanFilesError(403, "forbidden"), tr),
    "无权限",
  );
  ok("④ hfErrorText(403) →「无权限」（原「仅管理员」角色文案已移除）");

  // ── ⑤ 接线：统一确认框两处共用 + 目录提示 ───────────────────────
  const hookUses = (src.match(/useDeleteConfirm\(/g) || []).length;
  assert.ok(
    hookUses >= 3,
    `useDeleteConfirm 应 ≥3 处（1 定义 + 列表行/详情面板 2 调用点；实测 ${hookUses}）`,
  );
  assert.ok(!src.includes("移入回收站？"), "旧「移入回收站？」确认标题已移除（统一为「删除文件？」）");
  assert.ok(src.includes("删除文件？"), "新标题「删除文件？」在位");
  assert.ok(
    src.includes("目录删除暂不支持（请逐个删除文件）"),
    "目录行「目录删除暂不支持」提示在位",
  );
  ok("⑤ 接线：useDeleteConfirm 一处定义 + 列表行/详情面板共用；目录不可删提示在位");

  console.log(`\nfiles-delete-1669: ${n} passed`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
