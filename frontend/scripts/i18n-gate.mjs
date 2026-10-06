#!/usr/bin/env node
/**
 * i18n 门（固化自每批手打的内联检查，v0.5.0-beta.14.17）。
 *
 * 判据（与 14.16 同法）：
 *   1. DICT 无重复 key
 *   2. 全树 tr("字面量") 使用都在 DICT（0 缺）
 * 注意：动态 tr 场景（模板拼接 key）不统计——与历次门同口径；
 * key 提取必须排除 setStr/xxStr 等后缀误匹配（lookbehind 边界）。
 *
 * 用法：node scripts/i18n-gate.mjs（frontend/ 目录外任意位置，自解析 src/）
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");

const i18n = readFileSync(join(srcDir, "i18n.ts"), "utf8");
const keys = [...i18n.matchAll(/^\s*"([^"]+)"\s*:\s*\{\s*en:/gm)].map((m) => m[1]);
const dictKeys = new Set(keys);
const dups = keys.length - dictKeys.size;

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && name !== "i18n.ts") out.push(p);
  }
  return out;
}

const used = new Set();
for (const f of walk(srcDir, [])) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(/(?<![A-Za-z])tr\(\s*"([^"]+)"/g)) used.add(m[1]);
}
const missing = [...used].filter((k) => !dictKeys.has(k)).sort();

console.log(`DICT=${dictKeys.size} 字面量使用=${used.size} 缺=${missing.length} 重=${dups}`);
for (const m of missing.slice(0, 15)) console.log("  缺:", m);
if (missing.length > 0 || dups > 0) {
  console.error("i18n 门红");
  process.exit(1);
}
console.log("i18n 门 ✓");
