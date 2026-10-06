// v0.5.0-beta.14.6：createPoller 语义冒烟（node 直跑，跑法照
// scripts/roomHistory.smoke.mjs——esbuild buildSync 到临时目录 + import）。
// 15-30ms 级真实定时器 + 容差断言（非精确时刻）。
//
// usePoller.ts 模块顶访问 window.QwenPaw.host.React（宿主桥），故 **先 mock
// window/document 再 import**；createPoller 纯核心仅用 window.setTimeout/
// clearTimeout 与 document（hidden/addEventListener/removeEventListener）。
// 用法：node scripts/poller.smoke.mjs
import { buildSync } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert";

// ── mock 宿主环境（必须在 import bundle 之前）──
const docListeners = {};
globalThis.window = {
  QwenPaw: { host: { React: {} } },
  setTimeout,
  clearTimeout,
};
globalThis.document = {
  hidden: false,
  addEventListener: (ev, fn) => {
    (docListeners[ev] ||= []).push(fn);
  },
  removeEventListener: (ev, fn) => {
    if (docListeners[ev])
      docListeners[ev] = docListeners[ev].filter((f) => f !== fn);
  },
};
const fireVisibility = () =>
  (docListeners["visibilitychange"] || []).forEach((f) => f());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(path.join(tmpdir(), "poller-smoke-"));
buildSync({
  entryPoints: ["src/usePoller.ts"],
  bundle: true,
  format: "esm",
  outfile: path.join(tmp, "usePoller.mjs"),
  platform: "node",
});
const { createPoller } = await import(path.join(tmp, "usePoller.mjs"));

// 1. isActive=false 全程 → fn 不再被调（等待 ≥3 个间隔）。
{
  let calls = 0;
  const p = createPoller({
    fn: () => {
      calls++;
    },
    intervalMs: 20,
    isActive: () => false,
    jitterRatio: 0,
  });
  p.start();
  await sleep(20 * 4); // ≥3 个间隔
  p.stop();
  assert.strictEqual(calls, 0, "P1 isActive=false：fn 从未被调");
  console.log("P1 isActive=false ✓");
}

// 2. stop() 后不再调；start() 恢复。
{
  let calls = 0;
  const p = createPoller({
    fn: () => {
      calls++;
    },
    intervalMs: 20,
    isActive: () => true,
    jitterRatio: 0,
  });
  p.start();
  await sleep(50);
  const afterStart = calls;
  assert.ok(afterStart >= 1, "P2 start：fn 被调");
  p.stop();
  const atStop = calls;
  await sleep(60);
  assert.strictEqual(calls, atStop, "P2 stop：之后不再调");
  p.start();
  await sleep(50);
  assert.ok(calls > atStop, "P2 start 恢复：再调");
  p.stop();
  console.log("P2 stop/start ✓");
}

// 3. 失败退避：fn 前两次抛错第三次成功 → 第二次失败后到下一次的延迟 > 首间隔。
{
  const times = [];
  let callN = 0;
  const p = createPoller({
    fn: () => {
      callN++;
      times.push(Date.now());
      if (callN <= 2) throw new Error("boom"); // 前两次失败
    },
    intervalMs: 20,
    isActive: () => true,
    backoffFactor: 2,
    jitterRatio: 0,
  });
  p.start();
  while (callN < 3) await sleep(5);
  p.stop();
  // times[0]=第 1 次（失败），times[1]=第 2 次（失败），times[2]=第 3 次（成功）
  assert.ok(
    times[1] - times[0] > 20,
    `P3 退避：1 次失败后间隔 ${times[1] - times[0]}ms > 20ms`,
  );
  assert.ok(
    times[2] - times[1] > 20,
    `P3 退避：2 次失败后间隔 ${times[2] - times[1]}ms > 首间隔 20ms`,
  );
  console.log("P3 失败退避 ✓");
}

// 4. poke() 立即执行（激活后 30ms 内至少一次；intervalMs 设 500 排除首 tick 干扰）。
{
  let calls = 0;
  const p = createPoller({
    fn: () => {
      calls++;
    },
    intervalMs: 500,
    isActive: () => true,
    jitterRatio: 0,
  });
  p.start();
  p.poke();
  await sleep(30);
  p.stop();
  assert.ok(calls >= 1, "P4 poke：30ms 内立即执行");
  console.log("P4 poke 立即 ✓");
}

// 5. catch-up：隐藏（停摆）> catchUpMs 后转可见 → 立即补跑一次。
{
  let calls = 0;
  const p = createPoller({
    fn: () => {
      calls++;
    },
    intervalMs: 20,
    isActive: () => true,
    catchUpMs: 50,
    jitterRatio: 0,
  });
  p.start();
  await sleep(60); // 先跑若干 tick（lastTickAt>0）
  const beforeHide = calls;
  assert.ok(beforeHide >= 1, "P5 初始有 tick");
  // 隐藏 → 清定时器停摆
  globalThis.document.hidden = true;
  fireVisibility();
  const atHide = calls;
  await sleep(80); // 闲置 > catchUpMs(50)
  assert.strictEqual(calls, atHide, "P5 隐藏：停摆不再调");
  // 转可见 → 立即补跑
  globalThis.document.hidden = false;
  fireVisibility();
  await sleep(30);
  p.stop();
  assert.ok(calls > atHide, "P5 恢复可见：立即补跑（catch-up）");
  console.log("P5 catch-up ✓");
}

// 6. minPokeMs：刚跑过（< minPokeMs）→ poke 跳过；超窗 → 恢复。
// intervalMs=800 保证首 tick（t=800）不干扰测试窗（累计 ≈490ms）。
{
  let calls = 0;
  const p = createPoller({
    fn: () => {
      calls++;
    },
    intervalMs: 800,
    isActive: () => true,
    jitterRatio: 0,
    minPokeMs: 400,
  });
  p.start();
  p.poke(); // lastTickAt=0 → 必跑
  await sleep(30);
  assert.strictEqual(calls, 1, "P6 首次 poke：执行");
  p.poke(); // 距上次 < 400ms → 节流跳过
  await sleep(30);
  assert.strictEqual(calls, 1, "P6 minPokeMs 窗口内：poke 跳过");
  await sleep(450); // 累计 ≈480ms > 400ms（仍 < 500ms 首 tick）
  p.poke(); // 超窗 → 恢复执行
  await sleep(20);
  assert.strictEqual(calls, 2, "P6 超出 minPokeMs：poke 恢复");
  p.stop();
  console.log("P6 minPokeMs 节流 ✓");
}

// 7. v0.5.0-beta.14.16（深度体检）：失活 poller 的可见性恢复不补跑。
// 场景：settings 轮询（active=tab==='settings'）；用户隐藏窗口后切到
// chat tab（active 假），再恢复可见——旧行为 catch-up 多打一发，
// 修后 isActive=false → 只恢复调度链、不执行 fn。
{
  let calls = 0;
  let active = true;
  const p = createPoller({
    fn: () => {
      calls++;
    },
    intervalMs: 20,
    isActive: () => active,
    catchUpMs: 50,
    jitterRatio: 0,
  });
  p.start();
  await sleep(60); // 活跃期跑若干 tick
  const beforeHide = calls;
  assert.ok(beforeHide >= 1, "P7 初始有 tick");
  // 隐藏 → 停摆；停摆期间切走 tab（失活）
  globalThis.document.hidden = true;
  fireVisibility();
  active = false;
  await sleep(80); // 闲置 > catchUpMs(50)
  // 恢复可见（poller 已失活）→ 不应补跑
  globalThis.document.hidden = false;
  fireVisibility();
  await sleep(40);
  assert.strictEqual(calls, beforeHide, "P7 失活下可见恢复：不补跑");
  // 调度链应已恢复：转回活跃后 tick 正常执行（poke 或自然 tick）
  active = true;
  await sleep(60);
  assert.ok(calls > beforeHide, "P7 转回活跃：调度链正常");
  p.stop();
  console.log("P7 失活可见性恢复不补跑 ✓");
}

rmSync(tmp, { recursive: true, force: true });
console.log("\npoller 冒烟全绿（7 断言）");
