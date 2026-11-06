// Q：工作区容量配额迁到人员管理——quotaMbToBytes / quotaBytesToMb 纯函数单测。
// 直跑：node --experimental-strip-types frontend/tests/q-quota.test.ts
//（node:assert/strict；≥6 case；断言 shipped 实现而非分叉副本）。
//
// 加载路径说明：humanFiles.ts 值依赖 ../shared 与 ./chat（无扩展名相对
// import，浏览器 bundle 形态），node ESM 无法直 import → 照 c1a / r2 先例
// 用 esbuild buildSync 把 humanFiles.ts bundle 到临时 .mjs（先注入 window
// 最小 shim），再动态 import 断言。依赖链（shared → hostEnv /
// localConfigBackend / requestCache；chat 域 → requestCache / file-refs）
// 顶层无浏览器全局访问（已审计，c1a 已 bundle 过整条 api 链），
// shim 为零成本兜底。
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, "..", "src", "api", "domains", "humanFiles.ts");
const src = readFileSync(srcPath, "utf8");
const tmp = mkdtempSync(path.join(tmpdir(), "q-quota-"));
try {
  (globalThis as Record<string, unknown>).window = { QwenPaw: { host: {} } };

  buildSync({
    entryPoints: [srcPath],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: path.join(tmp, "humanFiles.mjs"),
  });

  const mod = (await import(path.join(tmp, "humanFiles.mjs"))) as {
    quotaMbToBytes: (mb: number) => number;
    quotaBytesToMb: (b: number | null | undefined) => number | null;
  };
  const { quotaMbToBytes, quotaBytesToMb } = mod;

  let n = 0;
  function ok(name: string, fn: () => void): void {
    fn();
    n += 1;
    console.log(`  PASS ${n} ${name}`);
  }

  // ── quotaMbToBytes（MB → 字节；四舍五入；≤0 → 0）─────────────────
  ok("1 MB → 1048576 字节", () => {
    assert.equal(quotaMbToBytes(1), 1048576);
  });
  ok("1.4 MB → 1468006 字节（round）", () => {
    assert.equal(quotaMbToBytes(1.4), 1468006);
  });
  ok("0 → 0", () => {
    assert.equal(quotaMbToBytes(0), 0);
  });
  ok("负数（-5）→ 0", () => {
    assert.equal(quotaMbToBytes(-5), 0);
  });
  ok("100 MB → 104857600 字节", () => {
    assert.equal(quotaMbToBytes(100), 104857600);
  });

  // ── quotaBytesToMb（字节 → MB；null/非数/≤0 → null；≥1 下限）────
  ok("null → null（无限制）", () => {
    assert.equal(quotaBytesToMb(null), null);
  });
  ok("undefined → null", () => {
    assert.equal(quotaBytesToMb(undefined), null);
  });
  ok("0 → null", () => {
    assert.equal(quotaBytesToMb(0), null);
  });
  ok("NaN → null（非数）", () => {
    assert.equal(quotaBytesToMb(Number.NaN), null);
  });
  ok("1048576 字节 → 1 MB", () => {
    assert.equal(quotaBytesToMb(1048576), 1);
  });
  ok("1468006 字节（≈1.4MB）→ 1（Math.round）", () => {
    assert.equal(quotaBytesToMb(1468006), 1);
  });
  ok("极小非零（1 字节）→ 1（Math.max 下限）", () => {
    assert.equal(quotaBytesToMb(1), 1);
  });

  // ── 接线（源码文本断言：两纯函数已导出，不触发真实 GET/PUT）──────
  ok("humanFiles.ts 导出 quotaMbToBytes / quotaBytesToMb", () => {
    assert.match(src, /export function quotaMbToBytes\(/);
    assert.match(src, /export function quotaBytesToMb\(/);
  });

  console.log(`\nq-quota: ${n} passed`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
