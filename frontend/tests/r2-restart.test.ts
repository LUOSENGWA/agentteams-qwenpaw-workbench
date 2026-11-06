// R2：#1473 消费侧——重启动作 + 主模型热应用文案单测。
// 直跑：node --experimental-strip-types frontend/tests/r2-restart.test.ts
//（node:assert/strict；≥7 case；断言 shipped 实现而非分叉副本）。
//
// 加载路径说明：lifecycle.ts 值依赖 ../shared（无扩展名相对 import，
// 浏览器 bundle 形态），node ESM 无法直 import → 照 c1a 先例用 esbuild
// buildSync 把 lifecycle.ts bundle 到临时 .mjs（先注入 window 最小
// shim），再动态 import 断言；依赖链（shared → hostEnv /
// localConfigBackend / requestCache）顶层无浏览器全局访问（已审计），
// shim 为零成本兜底。restartWorker/restartManager 路由路径 = 源码
// 文本断言（p1 先例，不触发真实 POST）。
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, "..", "src", "api", "domains", "lifecycle.ts");
const src = readFileSync(srcPath, "utf8");
const tmp = mkdtempSync(path.join(tmpdir(), "r2-restart-"));
try {
  (globalThis as Record<string, unknown>).window = { QwenPaw: { host: {} } };

  buildSync({
    entryPoints: [srcPath],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: path.join(tmp, "lifecycle.mjs"),
  });

  const mod = (await import(path.join(tmp, "lifecycle.mjs"))) as {
    modelSaveCopyKey: (runtime: string) => string;
    restartWorker: (name: string) => Promise<{ name: string; phase: string }>;
    restartManager: (name: string) => Promise<{ name: string; phase: string }>;
  };
  const { modelSaveCopyKey } = mod;

  let n = 0;
  function ok(name: string, fn: () => void): void {
    fn();
    n += 1;
    console.log(`  PASS ${n} ${name}`);
  }

  // ── modelSaveCopyKey（#1473 热应用：qwenpaw 立即生效）─────────────
  ok("qwenpaw → 模型已保存（立即生效）", () => {
    assert.equal(modelSaveCopyKey("qwenpaw"), "模型已保存（立即生效）");
  });
  ok("openclaw → 模型已保存（重启 Worker 后生效）", () => {
    assert.equal(modelSaveCopyKey("openclaw"), "模型已保存（重启 Worker 后生效）");
  });
  ok("hermes → 模型已保存（重启 Worker 后生效）", () => {
    assert.equal(modelSaveCopyKey("hermes"), "模型已保存（重启 Worker 后生效）");
  });
  ok("deepseek-harness → 模型已保存（重启 Worker 后生效）", () => {
    assert.equal(
      modelSaveCopyKey("deepseek-harness"),
      "模型已保存（重启 Worker 后生效）",
    );
  });
  ok("copaw → 模型已保存（重启 Worker 后生效）", () => {
    assert.equal(modelSaveCopyKey("copaw"), "模型已保存（重启 Worker 后生效）");
  });
  ok("空 runtime → 需重启（保守兜底）", () => {
    assert.equal(modelSaveCopyKey(""), "模型已保存（重启 Worker 后生效）");
  });
  ok("大小写敏感（QwenPaw ≠ qwenpaw，与库内严格相等口径一致）", () => {
    assert.equal(modelSaveCopyKey("QwenPaw"), "模型已保存（重启 Worker 后生效）");
  });

  // ── restart 路由（源码文本断言，不触发真实 POST）──────────────────
  ok("restartWorker → POST /workers/{name}/restart（encodeURIComponent）", () => {
    assert.match(src, /export async function restartWorker\(/);
    assert.match(src, /`\/workers\/\$\{encodeURIComponent\(name\)\}\/restart`/);
    assert.match(src, /postController\(\s*`\/workers/);
  });
  ok("restartManager → POST /managers/{name}/restart（encodeURIComponent）", () => {
    assert.match(src, /export async function restartManager\(/);
    assert.match(src, /`\/managers\/\$\{encodeURIComponent\(name\)\}\/restart`/);
    assert.match(src, /postController\(\s*`\/managers/);
  });

  console.log(`\nr2-restart: ${n} passed`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
