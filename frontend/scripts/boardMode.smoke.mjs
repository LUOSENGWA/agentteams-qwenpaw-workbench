// v0.5.0-beta.15.19：看板两档布局断点回归冒烟（node 直跑）。
//
// 背景：15.15 横屏回归修复——「横屏被搞烂」根因是断点误判（横屏手机
// 667px 曾 <800 恒 narrow 落进竖屏堆叠）。断点逻辑收敛进纯模块
// src/boardMode.ts 后，本冒烟锁死两档断点（500）+ 边界值，防未来
// 改断点时再把横屏/竖屏划错。
//
// 15.19 起 jira 档（≥950，8 列固定 250px 横滚）退役：整板 2000px 窄窗
// 右列被裁、250px 列内卡文字 3 行+被裁切 → 宽屏一并回 grid2（两列三行）。
//
// boardMode.ts 零 React/window 依赖，直接 esbuild 编译 import 即可。
// 用法：node scripts/boardMode.smoke.mjs
import { buildSync } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert";

const tmp = mkdtempSync(path.join(tmpdir(), "boardMode-smoke-"));
buildSync({
  entryPoints: ["src/boardMode.ts"],
  bundle: true,
  format: "esm",
  outfile: path.join(tmp, "boardMode.mjs"),
  platform: "node",
});
const { boardModeForWidth, BOARD_STACKED_MAX_W } = await import(
  path.join(tmp, "boardMode.mjs")
);

// 常量与断点一致（改断点必须同步常量）。
assert.strictEqual(BOARD_STACKED_MAX_W, 500, "C1 stacked 上界 = 500");
console.log("C1 常量一致 ✓");

// 两档典型宽度（真实设备）。
const cases = [
  // stacked（竖屏手机）
  [0, "stacked"], // 0 宽（隐藏/未布局）→ stacked 兜底
  [360, "stacked"], // Android 竖屏
  [375, "stacked"], // iPhone 竖屏（逻辑宽）
  [390, "stacked"], // iPhone 14 竖屏
  [430, "stacked"], // 大屏 Android 竖屏
  [499, "stacked"], // 边界下沿
  // grid2（横屏手机 / 平板 / 中间宽度 / 桌面宽屏）——「两列三行」
  [500, "grid2"], // 边界上沿
  [667, "grid2"], // iPhone 横屏
  [700, "grid2"], // Android 横屏
  [768, "grid2"], // 平板竖屏
  [800, "grid2"], // 旧 narrow 阈值（正是回归点：曾 <800 恒窄）
  [900, "grid2"], // 大屏手机横屏
  [949, "grid2"], // 原 jira 边界下沿
  [950, "grid2"], // 原 jira 边界上沿（15.19 起回 grid2）
  [1024, "grid2"], // 平板横屏
  [1194, "grid2"], // iPad 横屏
  [1440, "grid2"], // 桌面
];
for (const [w, expect] of cases) {
  const got = boardModeForWidth(w);
  assert.strictEqual(got, expect, `W=${w} 应为 ${expect}，实得 ${got}`);
}
console.log(`两档 ${cases.length} 宽度断言 ✓`);

// 边界紧邻（500 两侧的判定翻转）。
assert.strictEqual(boardModeForWidth(499), "stacked");
assert.strictEqual(boardModeForWidth(500), "grid2");
console.log("500 边界翻转 ✓");

rmSync(tmp, { recursive: true, force: true });
console.log("\nboardMode 断点冒烟全绿");
