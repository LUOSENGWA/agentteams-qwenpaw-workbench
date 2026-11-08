// O4：hermes 运行时配置面（#1494）——标题/图标按运行时映射 + 404 unknown
// runtime 友好化。全源码文本断言（p1/r2 先例）：不触 window/react 依赖链。
// 直跑：node --experimental-strip-types frontend/tests/o4-hermes-surface.test.ts
//（node:assert/strict；≥5 case；断言 shipped 实现而非分叉副本）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const component = readFileSync(
  path.join(here, "..", "src", "components", "WorkerRuntimeConfigSurface.tsx"),
  "utf8",
);
const chatI18n = readFileSync(path.join(here, "..", "src", "i18n", "domains", "chat.ts"), "utf8");
const api = readFileSync(path.join(here, "..", "src", "api", "domains", "memberConfig.ts"), "utf8");

let n = 0;
function ok(name: string, fn: () => void): void {
  fn();
  n += 1;
  console.log(`  PASS ${n} ${name}`);
}

/** i18n 键 → 转义后的字面量正则（键含 {list} 等特殊字符）。 */
function keyPattern(key: string): RegExp {
  return new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
}

// ── 标题/图标按运行时映射 ────────────────────────────────────────────
ok("标题映射含 hermes：runtime === \"hermes\" → Hermes 运行配置（openclaw 品牌与通用兜底保留）", () => {
  assert.match(component, /runtime === "openclaw"\s*\?\s*"OpenClaw 运行配置"/);
  assert.match(component, /runtime === "hermes"\s*\?\s*"Hermes 运行配置"/);
  assert.match(component, /:\s*"运行配置";/);
});

ok("图标：仅 openclaw 品牌图标；hermes 落通用 SettingsIcon（无品牌资产不硬造）", () => {
  assert.match(
    component,
    /icon=\{runtime === "openclaw" \? <OpenClawIcon size=\{13\} \/> : <SettingsIcon size=\{13\} \/>}/,
  );
});

// ── i18n（新键落 chat.ts，复用既有键，无重复）────────────────────────
ok("新键入 chat.ts 且各出现一次：Hermes 运行配置 / 不支持该运行时配置面（{list}）", () => {
  for (const key of ["Hermes 运行配置", "当前控制器版本不支持该运行时配置面（控制器支持：{list}）"]) {
    assert.equal(
      (chatI18n.match(new RegExp(keyPattern(key).source, "g")) ?? []).length,
      1,
      `chat.ts 键应恰好一次：${key}`,
    );
  }
  assert.match(chatI18n, /"OpenClaw 运行配置":/); // 既有键未动
  assert.match(chatI18n, /"重试":/); // 重试按钮复用既有键，未另造
});

// ── 404 友好化：形状识别（body 含 supported）─────────────────────────
ok("404 分支按响应体形状识别 supported（数组 join / 字符串直取）", () => {
  assert.match(component, /function supportedRuntimeList\(e: unknown\): string/);
  assert.match(component, /e instanceof MemberConfigError/);
  assert.match(component, /Array\.isArray\(body\.supported\)/);
  assert.match(component, /typeof body\.supported === "string"/);
});

ok("surface/config 两个 rejection 分支都前置走 404 形状识别", () => {
  const hits = component.match(/supportedRuntimeList\((sRes|cRes)\.reason\)/g) ?? [];
  assert.equal(hits.length, 2, "sRes 与 cRes 各一处");
  assert.match(component, /supportedRuntimeList\(sRes\.reason\)/);
  assert.match(component, /supportedRuntimeList\(cRes\.reason\)/);
});

ok("friendly 分支给出友好文案（supported 列表）+ 重试按钮，并抑制 SurfaceStatus 旧分支", () => {
  const key = "当前控制器版本不支持该运行时配置面（控制器支持：{list}）";
  assert.ok(component.includes(key), "组件引用 friendly 文案 i18n 键");
  assert.match(component, /list: runtimeUnknown/);
  const start = component.indexOf(key);
  const end = component.indexOf("<SurfaceStatus");
  assert.ok(start > 0 && end > start, "friendly 分支先于 SurfaceStatus 落点");
  const branch = component.slice(start, end);
  assert.ok(branch.includes('tr("重试")'), "friendly 分支保留重试按钮");
  assert.match(branch, /void load\(\)/);
  assert.match(component, /<SurfaceStatus\s+runtimeUnknown=""/, "旧分支传空串不再重复渲染");
});

ok("load() 起始清 runtimeUnknown：重试可从 friendly 态恢复到表单", () => {
  assert.match(component, /setRuntimeUnknown\(""\)/);
});

ok("其它错误保持现状：classifyLoadError / gone / setLoadErr 路径未动", () => {
  assert.match(component, /classifyLoadError\(sRes\.reason\)/);
  assert.match(component, /classifyLoadError\(cRes\.reason\)/);
  assert.match(component, /e\.kind === "gone"\) setGone\(true\)/);
  assert.match(component, /setLoadErr\(e\.detail\)/);
});

// ── 取数仍按 runtime 传参（不写死 openclaw）─────────────────────────
ok("fetchRuntimeSurface 按 runtime 传参（组件与 API 层 URL 均用参数）", () => {
  assert.match(component, /fetchRuntimeSurface\(runtime\)/);
  assert.ok(!component.includes('fetchRuntimeSurface("openclaw")'));
  assert.match(api, /fetchRuntimeSurface\(runtime: string\)/);
  assert.match(api, /runtimes\/\$\{encodeURIComponent\(runtime\)\}\/surface/);
});

console.log(`\no4-hermes-surface: ${n} passed`);
