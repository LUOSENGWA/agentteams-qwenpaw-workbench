#!/usr/bin/env node
/**
 * vitest-gate.mjs — vitest 兼容门（本地 shim 通道）。
 *
 * 容器内 node_modules/vitest 是注册型 shim（describe/it/expect/vi →
 * globalThis.__qcVt，无 runner）。本门按任务书 §6 用 esbuild 现场打包
 * 单个 *.vitest.test.ts（alias vitest → shim）+ node 逐个执行
 * （vitest-shim-runner.mjs），一个测试文件 = 一个独立 node 进程
 * （fresh globalThis 状态，等价 vitest 的 per-file isolate）。
 *
 * 运行：cd frontend && node scripts/vitest-gate.mjs [tests/xxx.vitest.test.ts ...]
 * 缺省跑本任务书 §6 最小集（chat 三修 + 过程条 + 线程面板）。
 *
 * 局限（如实声明，不包装成完整 vitest 等价物）：
 * - 只支持 shim 覆盖的 API 子集（无 vi.mock / fake timers / 快照）；
 * - 宿主 shim（window.QwenPaw.host）由各测试文件自行按需在模块顶层/
 *   beforeAll 前设置；
 * - 打包产物落 os.tmpdir，不进仓库。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, "..");
const SHIM = path.join(FRONTEND_DIR, "node_modules", "vitest", "index.js");
const RUNNER = path.join(__dirname, "vitest-shim-runner.mjs");

const DEFAULT_FILES = [
  "tests/chat-inline-worker-runs.vitest.test.ts",
  "tests/chat-replace-aggregate.vitest.test.ts",
  "tests/chat-render2.vitest.test.ts",
  "tests/chat-run-blocks.vitest.test.ts",
  "tests/chat-think-fold.vitest.test.ts",
  "tests/chat-thread-panel.vitest.test.ts",
  // process-bar-ux.vitest.test.ts 需要 jsdom（@vitest-environment jsdom +
  // react-dom/client createRoot）——容器无 jsdom/happy-dom，本地 shim
  // 通道无法覆盖，如实记为门局限（可 CLI 显式指定文件试跑）。
];

const files = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_FILES;
const tmp = mkdtempSync(path.join(os.tmpdir(), "vitest-gate-"));

let gateFail = false;
for (const rel of files) {
  const entry = path.resolve(FRONTEND_DIR, rel);
  const bundle = path.join(tmp, `${path.basename(rel).replace(/[^a-zA-Z0-9_-]/g, "_")}.bundle.cjs`);
  try {
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      outfile: bundle,
      // cjs：react-dom/server 是 CJS（ESM 输出下动态 require 内置模块
      // "stream" 会炸）；测试内的动态 import 经 esbuild 转为惰性
      // __esm 包装，模块顶层求值顺序（宿主 shim 先于组件模块）不变。
      format: "cjs",
      platform: "node",
      target: "node22",
      jsx: "transform",
      alias: { vitest: SHIM },
      logLevel: "silent",
    });
  } catch (e) {
    console.log(`FAIL  ${rel} — esbuild 打包失败：${String(e.message || e).split("\n").slice(0, 4).join(" | ")}`);
    gateFail = true;
    continue;
  }
  console.log(`\n── ${rel} ──`);
  const r = spawnSync(process.execPath, [RUNNER, bundle], {
    encoding: "utf8",
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (r.status !== 0) gateFail = true;
}
process.exit(gateFail ? 1 : 0);
