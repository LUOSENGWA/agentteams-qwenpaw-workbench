// R3：文件区 301 收尾 + 刷新/重试穿透缓存审计——源码文本断言单测。
// 直跑：node --experimental-strip-types frontend/tests/r3-files-refresh.test.ts
//（node:assert/strict；≥6 case；断言 shipped 实现而非分叉副本——
// humanFiles 的 3xx 跟随依赖宿主桥 window.QwenPaw.host，node 直 import
// 需完整 host shim，照 p1/r2 先例走源码文本断言，不触发真实请求）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(here, "..", rel), "utf8");

const hf = read("src/api/domains/humanFiles.ts");
const helper = read("src/lib/useForceReload.ts");
const mcp = read("src/components/WorkerMcpPanel.tsx");
const audit = read("src/components/AuditLog.tsx");
const nfc = read("src/components/NotificationCenter.tsx");
const wcr = read("src/components/WorkerCodingRuns.tsx");
const crp = read("src/components/CodingRunsPanel.tsx");
const wpp = read("src/components/WorkerPluginsPanel.tsx");
const vtp = read("src/components/VersionTablePicker.tsx");

let n = 0;
function ok(name: string, fn: () => void): void {
  fn();
  n += 1;
  console.log(`  PASS ${n} ${name}`);
}

// ── 文件区 301 收尾（humanFiles.ts）──────────────────────────────
ok("listFiles 空 dir 分支含尾斜杠（301 根因消除）", () => {
  // `${BASE(humanName, "files")}${dir ? `/${dir}` : ""}/`——空 dir = 根目录，
  // 恒以 "/" 结尾（Controller 目录列表语义）；旧分支无尾斜杠 → 301。
  assert.match(
    hf,
    /const full = `\$\{BASE\(humanName, "files"\)\}\$\{dir \? `\/\$\{dir\}` : ""\}\/`;/,
  );
});

ok("listFiles 旧空 dir 无尾斜杠分支已移除", () => {
  assert.doesNotMatch(hf, /: API\(humanName, "files"\)/);
});

ok("3xx 单跳跟随：仅 301/308 且带 Location，三路径全接入", () => {
  assert.match(hf, /async function followRedirectOnce\(/);
  assert.match(hf, /resp\.status !== 301 && resp\.status !== 308/);
  assert.match(hf, /resp\.headers\.get\("Location"\)/);
  // listFiles（rawJsonFetch——shared 通道 3xx 丢 Location，故自带 raw 通道）
  assert.match(hf, /followRedirectOnce\(await rawJsonFetch\(full\)\)/);
  // readFileSync
  assert.match(hf, /const resp = await followRedirectOnce\(resp0\);/);
  // writeFileSync（带 init 透传）
  assert.match(hf, /const resp = await followRedirectOnce\(resp0, init\);/);
});

ok("写路径 method-preserving（PUT init 透传，不降级 GET）", () => {
  assert.match(
    hf,
    /const init: RequestInit = \{ method: "PUT", headers, body \};/,
  );
  assert.match(hf, /followRedirectOnce\(resp0, init\);/);
  // 跟随工具链内无任何 method 改写。
  assert.doesNotMatch(hf, /method: "GET"/);
});

ok("readHttpError 的 code 保留未破坏（413 size/quota 分支依赖）", () => {
  assert.match(
    hf,
    /if \(typeof j\.code === "string" && j\.code\) code = j\.code;/,
  );
  assert.match(
    hf,
    /return new HumanFilesError\(resp\.status, message \|\| `HTTP \$\{resp\.status\}`, code\);/,
  );
});

// ── 共享 helper（useForceReload：同一反模式唯一实现）──────────────
ok("useForceReload：invalidateTags 先于 load，暴露 reload/loading/err", () => {
  assert.match(helper, /export function useForceReload\(/);
  assert.match(helper, /import \{ invalidateTags \} from "\.\.\/requestCache";/);
  assert.match(helper, /invalidateTags\(\[\.\.\.tagsRef\.current\]\);/);
  assert.match(helper, /await Promise\.resolve\(loadRef\.current\(\)\);/);
  assert.match(helper, /return \{ reload, loading, err \};/);
  const iInv = helper.indexOf("invalidateTags(");
  const iLoad = helper.indexOf("loadRef.current()");
  assert.ok(iInv !== -1 && iLoad !== -1 && iInv < iLoad, "先失效后取数");
});

// ── 被修组件真调 helper（非装饰性 import）────────────────────────
ok("WorkerMcpPanel：useForceReload(load, [worker-mcp]) + 按钮 loading/reload", () => {
  assert.match(mcp, /import \{ useForceReload \} from "\.\.\/lib\/useForceReload";/);
  assert.match(mcp, /useForceReload\(load, \["worker-mcp"\]\)/);
  assert.match(mcp, /loading=\{loading \|\| reloadLoading\}/);
  assert.match(mcp, /onClick=\{\(\) => void reload\(\)\}/);
});

ok("AuditLog：useForceReload(fetchPage(false), [audit]) + 按钮 loading/reload", () => {
  assert.match(audit, /import \{ useForceReload \} from "\.\.\/lib\/useForceReload";/);
  assert.match(audit, /useForceReload\(/);
  assert.match(audit, /\(\) => fetchPage\(false\),/);
  assert.match(audit, /\["audit"\]/);
  assert.match(audit, /loading=\{loading \|\| reloadLoading\}/);
  assert.match(audit, /onClick=\{\(\) => void reload\(\)\}/);
});

ok("NotificationCenter：useForceReload(load, [inbox]) + 按钮 loading/reload", () => {
  assert.match(nfc, /import \{ useForceReload \} from "\.\.\/lib\/useForceReload";/);
  assert.match(nfc, /useForceReload\(load, \["inbox"\]\)/);
  assert.match(nfc, /loading=\{reloadLoading\}/);
  assert.match(nfc, /onClick=\{\(\) => void reload\(\)\}/);
});

ok("WorkerCodingRuns / CodingRunsPanel / WorkerPluginsPanel / VersionTablePicker 全接入", () => {
  // coding-runs 30s 缓存（WorkerCodingRuns 委托 listCodingRuns 同享 tag）
  assert.match(wcr, /import \{ useForceReload \} from "\.\.\/lib\/useForceReload";/);
  assert.match(wcr, /\["coding-runs"\]/);
  assert.match(wcr, /loading=\{reloadLoading\}/);
  assert.match(wcr, /void reload\(\)/);
  // 运维页编码执行记录段
  assert.match(crp, /import \{ useForceReload \} from "\.\.\/lib\/useForceReload";/);
  assert.match(crp, /\["coding-runs"\]/);
  assert.match(crp, /loading=\{loading \|\| reloadLoading\}/);
  assert.match(crp, /void reload\(\)/);
  // 插件只读段（worker:plugins:* 30s）
  assert.match(wpp, /useForceReload\(load, \["worker-plugins"\]\)/);
  assert.match(wpp, /loading=\{loading \|\| reloadLoading\}/);
  assert.match(wpp, /void reload\(\)/);
  // 版本表（upgrade 300s——最长陈旧窗）
  assert.match(vtp, /useForceReload\(load, \["upgrade"\]\)/);
  assert.match(vtp, /loading=\{loading \|\| reloadLoading\}/);
  assert.match(vtp, /void reload\(\)/);
});

ok("同一反模式一个实现：7 个被修组件无直调 invalidateTags（全走 helper）", () => {
  const fixed: Array<[string, string]> = [
    ["WorkerMcpPanel", mcp],
    ["AuditLog", audit],
    ["NotificationCenter", nfc],
    ["WorkerCodingRuns", wcr],
    ["CodingRunsPanel", crp],
    ["WorkerPluginsPanel", wpp],
    ["VersionTablePicker", vtp],
  ];
  for (const [name, src] of fixed) {
    assert.ok(!src.includes("invalidateTags("), `${name} 不得直调 invalidateTags`);
  }
});

console.log(`\nr3-files-refresh: ${n} passed`);
