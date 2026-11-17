#!/usr/bin/env node
/**
 * vitest-shim-runner.mjs — 执行单个 esbuild 打包好的 vitest-shim 测试包。
 * 由 vitest-gate.mjs 以独立 node 进程拉起（per-file isolate 语义）。
 * 用法：node scripts/vitest-shim-runner.mjs <bundle.mjs>
 */
import { pathToFileURL } from "node:url";

const bundle = process.argv[2];
if (!bundle) {
  console.error("用法：node vitest-shim-runner.mjs <bundle.cjs>");
  process.exit(2);
}
// 兜底全局：个别测试文件顶层裸读 `window`（如 `globalThis.window = window`）——
// Node 无 window 会 ReferenceError。先挂 globalThis 自身，测试文件随后
// 按自己的宿主 shim 覆盖（覆盖语义不变）。
if (typeof globalThis.window === "undefined") globalThis.window = globalThis;
if (typeof globalThis.document === "undefined") {
  globalThis.document = { hidden: false };
}
await import(pathToFileURL(bundle).href);

const st = globalThis.__qcVt;
if (!st || !Array.isArray(st.tests)) {
  console.error("bundle 未注册任何测试（globalThis.__qcVt 缺失）");
  process.exit(2);
}

let pass = 0;
let fail = 0;
const fmtErr = (e) =>
  String((e && e.stack) || e || "").split("\n").slice(0, 6).join("\n      ");

for (const fn of st.beforeAll) await fn();
for (const t of st.tests) {
  let err = null;
  try {
    for (const fn of st.beforeEach) await fn();
    await t.fn();
  } catch (e) {
    err = e;
  }
  for (const fn of st.afterEach) await fn();
  if (err) {
    fail += 1;
    console.log(`FAIL  ${t.name}\n      ${fmtErr(err)}`);
  } else {
    pass += 1;
    console.log(`PASS  ${t.name}`);
  }
}
for (const fn of st.afterAll) await fn();

console.log(`\n${pass}/${st.tests.length} 通过${fail ? `，${fail} 失败` : ""}`);
process.exit(fail ? 1 : 0);
