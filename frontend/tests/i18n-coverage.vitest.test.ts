// i18n 覆盖门：所有 tr("中文键") 必须在 domains 里有 en 对照。
// 防止「英文界面漏中文」回潮（16.110 补齐 177 键时立此门）。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const TR_RE = /\btr\(\s*"((?:[^"\\]|\\.)*)"/g;
const DICT_RE = /^\s*"((?:[^"\\]|\\.)*)"\s*:/gm;
const CJK = /[\u4e00-\u9fff]/;

describe("i18n coverage", () => {
  it("every Chinese tr() key has an English entry", () => {
    const srcDir = join(process.cwd(), "src");
    const files = walk(srcDir);
    const keys = new Set<string>();
    for (const f of files) {
      const s = readFileSync(f, "utf8");
      for (const m of s.matchAll(TR_RE)) keys.add(m[1]);
    }
    const dict = new Set<string>();
    for (const f of files.filter((p) => p.includes("/i18n/domains/"))) {
      const s = readFileSync(f, "utf8");
      for (const m of s.matchAll(DICT_RE)) dict.add(m[1]);
    }
    const missing = [...keys].filter((k) => CJK.test(k) && !dict.has(k));
    expect(missing).toEqual([]);
  });

  it("placeholder tokens are preserved verbatim", () => {
    const srcDir = join(process.cwd(), "src");
    const dictFile = readFileSync(
      join(srcDir, "i18n/domains/missing.ts"),
      "utf8",
    );
    const pairs = [...dictFile.matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:\s*\{\s*en:\s*"((?:[^"\\]|\\.)*)"\s*\}/gm)];
    expect(pairs.length).toBeGreaterThan(100);
    for (const [, zh, en] of pairs) {
      const a = (zh.match(/\{[a-z]+\}/g) ?? []).sort().join(",");
      const b = (en.match(/\{[a-z]+\}/g) ?? []).sort().join(",");
      expect(b, `placeholders differ for ${zh}`).toBe(a);
    }
  });
});
