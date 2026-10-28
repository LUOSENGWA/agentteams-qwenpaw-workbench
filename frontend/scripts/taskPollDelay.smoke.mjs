// R4（16.23）：taskPollDelayMs 任务轮询选档冒烟（node 直跑）。
// WorkerCodingCliPanelShared.tsx 模块顶访问 window.QwenPaw.host.React/antd
// （宿主桥），故 **先 mock window 再 import**（poller.smoke.mjs 同款模式）。
// 用法：node scripts/taskPollDelay.smoke.mjs
import { buildSync } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert";

globalThis.window = {
  QwenPaw: { host: { React: {}, antd: {} } },
};

const tmp = mkdtempSync(path.join(tmpdir(), "tpd-smoke-"));
buildSync({
  entryPoints: ["src/components/WorkerCodingCliPanelShared.tsx"],
  bundle: true,
  format: "esm",
  outfile: path.join(tmp, "shared.mjs"),
  platform: "node",
});
const {
  POLL_MS,
  POLL_HIDDEN_MS,
  taskPollDelayMs,
} = await import(path.join(tmp, "shared.mjs"));

// 1. 面板可见（卡片展开/sheet）+ 页面可见 → 快档 1.5s。
assert.strictEqual(POLL_MS, 1500, "T1 快档常量 1.5s");
assert.strictEqual(taskPollDelayMs(true, true), 1500, "T1 双可见 → 1.5s");
// 2. 面板不可见（卡片收起）+ 页面可见 → 慢档 30s 兜底。
assert.strictEqual(taskPollDelayMs(false, true), 30000, "T2 卡片收起 → 30s");
// 3. 面板可见 + 页面隐藏（后台 tab）→ 慢档 30s。
assert.strictEqual(taskPollDelayMs(true, false), 30000, "T3 后台 tab → 30s");
// 4. 双不可见 → 慢档 30s。
assert.strictEqual(POLL_HIDDEN_MS, 30000, "T4 慢档常量 30s");
assert.strictEqual(taskPollDelayMs(false, false), 30000, "T4 双不可见 → 30s");

rmSync(tmp, { recursive: true, force: true });
console.log("\ntaskPollDelay 冒烟全绿（4 组）");
