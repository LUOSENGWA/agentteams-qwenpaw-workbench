// C1：统一模型设置弹窗——纯函数单测（可测组件层）。
// 直跑：node --experimental-strip-types frontend/tests/c1-model-modal.test.ts
//（node:assert/strict；≥10 case；断言 shipped 实现而非分叉副本）。
//
// 加载路径说明：src/lib/modelDraft.ts 零 import、顶层无浏览器全局
//（插件宿主注入无关）→ node strip-types 可直接按显式 .ts 扩展名 import，
// 无需 c1a 的 esbuild bundle / window shim 先例。
// 视图组件 ModelSettingsModal.tsx 不做渲染测试（本单只交可测组件）；
// 末条 case 以源码扫描断言「不 import 后端 api / 无 fetch 调用」。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_FALLBACKS,
  buildModelPatch,
  dedupeFallbacks,
  fieldsFor,
  filterProviders,
  fromModelValue,
  isDraftDirty,
  modelsForProvider,
  toModelValue,
  validateModelDraft,
} from "../src/lib/modelDraft.ts";
import type {
  ModelDraft,
  ProviderOption,
} from "../src/lib/modelDraft.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

let n = 0;
function ok(name: string, fn: () => void): void {
  fn();
  n += 1;
  console.log(`  PASS ${n} ${name}`);
}

// ── runtime 三形态适配 ─────────────────────────────────────────────
ok("qwenpaw 往返：{provider,model} → to → from 归一相等", () => {
  const norm: ModelDraft = { provider: "openai", model: "gpt-4o" };
  const stored = toModelValue(norm, "qwenpaw");
  assert.deepEqual(stored, { provider: "openai", model: "gpt-4o" });
  assert.deepEqual(fromModelValue(stored, "qwenpaw"), {
    provider: "openai",
    model: "gpt-4o",
  });
});

ok("openclaw 与 qwenpaw 同形：{provider,model} 往返一致", () => {
  const stored = toModelValue(
    { provider: "anthropic", model: "claude-x" },
    "openclaw",
  );
  assert.deepEqual(stored, { provider: "anthropic", model: "claude-x" });
  assert.deepEqual(fromModelValue(stored, "openclaw"), {
    provider: "anthropic",
    model: "claude-x",
  });
});

ok("hermes 形态：to → {name,provider}；from {name,provider} → 归一；往返一致", () => {
  const stored = toModelValue({ provider: "y", model: "x" }, "hermes");
  assert.deepEqual(stored, { name: "x", provider: "y" });
  assert.deepEqual(fromModelValue({ name: "x", provider: "y" }, "hermes"), {
    provider: "y",
    model: "x",
  });
  // 往返
  assert.deepEqual(fromModelValue(stored, "hermes"), { provider: "y", model: "x" });
  // 跨形兜底：hermes 对象被按 qwenpaw 解析仍得动（name 兜底）
  assert.deepEqual(fromModelValue({ name: "x", provider: "y" }), {
    provider: "y",
    model: "x",
  });
});

ok("纯字符串 = 仅模型名：from → provider 空；to → {provider:'',model}", () => {
  assert.deepEqual(fromModelValue("m1"), { provider: "", model: "m1" });
  assert.deepEqual(toModelValue("m1", "qwenpaw"), { provider: "", model: "m1" });
  assert.deepEqual(toModelValue("m1", "hermes"), { name: "m1", provider: "" });
});

ok("空值 → null（不抛）：null/undefined/空串/纯空白/空对象", () => {
  assert.equal(fromModelValue(null), null);
  assert.equal(fromModelValue(undefined), null);
  assert.equal(fromModelValue(""), null);
  assert.equal(fromModelValue("   "), null);
  assert.equal(fromModelValue({}), null);
  assert.equal(fromModelValue({ provider: "", model: "" }), null);
  assert.equal(toModelValue(null), null);
  assert.equal(toModelValue("", "hermes"), null);
  assert.equal(toModelValue(42), null);
});

// ── 回退链：去重 + 上限 ─────────────────────────────────────────────
ok("dedupeFallbacks：trim 后保序去重，非字符串项忽略", () => {
  assert.deepEqual(dedupeFallbacks(["a", "a", "b", " a "]), ["a", "b"]);
  assert.deepEqual(dedupeFallbacks(["a", 1, null, "b", {}]), ["a", "b"]);
  assert.deepEqual(dedupeFallbacks(["", "  ", "x"]), ["x"]);
  assert.deepEqual(dedupeFallbacks([]), []);
});

ok(`dedupeFallbacks：上限 ${MAX_FALLBACKS}（5 唯一 → 前 3）`, () => {
  assert.equal(MAX_FALLBACKS, 3);
  assert.deepEqual(dedupeFallbacks(["a", "b", "c", "d", "e"]), [
    "a",
    "b",
    "c",
  ]);
  assert.deepEqual(dedupeFallbacks(["a", "a", "b", "c", "d"]), ["a", "b", "c"]);
});

// ── 校验（错误码）──────────────────────────────────────────────────
const base: ModelDraft = { provider: "openai", model: "gpt-4o", fallbacks: [] };

ok("校验 missing-main：主模型空 → ok=false 且含 missing-main", () => {
  const r = validateModelDraft({ model: "", fallbacks: [] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes("missing-main"));
  const r2 = validateModelDraft(null);
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.includes("missing-main"));
});

ok("校验 fallback-duplicates-main：回退含主模型 → 命中", () => {
  const r = validateModelDraft({ model: "m", fallbacks: ["m", "x"] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes("fallback-duplicates-main"));
});

ok("校验 too-many-fallbacks + fallback-duplicate", () => {
  const many = validateModelDraft({
    model: "m",
    fallbacks: ["a", "b", "c", "d"],
  });
  assert.equal(many.ok, false);
  assert.ok(many.errors.includes("too-many-fallbacks"));
  const dup = validateModelDraft({ model: "m", fallbacks: ["x", "x", "y"] });
  assert.ok(dup.errors.includes("fallback-duplicate"));
});

ok("校验 invalid-model-name：路径 / URL / 含空格 → 命中", () => {
  for (const bad of ["/abs/path", "https://x", "a b"]) {
    const r = validateModelDraft({ model: bad, fallbacks: [] });
    assert.ok(r.errors.includes("invalid-model-name"), bad);
  }
});

ok("校验合法草稿 → ok=true、errors 空", () => {
  const r = validateModelDraft({
    ...base,
    fallbacks: ["f1", "f2", "f3"],
    temperature: 0.7,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

// ── features 开关（fieldsFor）──────────────────────────────────────
ok("features 开关：缺省全关；advanced/fallbacks 各自 opt-in", () => {
  assert.deepEqual(fieldsFor(), ["main"]);
  assert.deepEqual(fieldsFor({ advanced: false, fallbacks: false }), ["main"]);
  const adv = fieldsFor({ advanced: true });
  assert.ok(adv.includes("temperature"));
  assert.ok(adv.includes("maxTokens"));
  assert.ok(adv.includes("stream"));
  assert.ok(!adv.includes("fallbacks"));
  assert.ok(fieldsFor({ fallbacks: true }).includes("fallbacks"));
  const all = fieldsFor({ advanced: true, fallbacks: true });
  assert.deepEqual(all, ["main", "fallbacks", "temperature", "maxTokens", "stream"]);
});

// ── provider 过滤 ──────────────────────────────────────────────────
const PROVIDERS: ProviderOption[] = [
  { name: "OpenAI", models: ["gpt-4o", "gpt-4.1"] },
  { name: "dashscope", models: ["qwen3.6-plus"] },
  { name: "openrouter", models: ["claude-x", "gpt-4o"] },
];

ok("filterProviders：空查询同一引用；大小写不敏感子串过滤", () => {
  assert.equal(filterProviders(PROVIDERS, ""), PROVIDERS);
  assert.equal(filterProviders(PROVIDERS, "   "), PROVIDERS);
  assert.deepEqual(
    filterProviders(PROVIDERS, "open").map((p) => p.name),
    ["OpenAI", "openrouter"],
  );
  assert.deepEqual(
    filterProviders(PROVIDERS, "DASH").map((p) => p.name),
    ["dashscope"],
  );
  assert.deepEqual(filterProviders(PROVIDERS, "nope"), []);
});

ok("modelsForProvider：所选 provider 的模型清单；未选 / 未知 → []", () => {
  assert.deepEqual(modelsForProvider(PROVIDERS, "OpenAI"), [
    "gpt-4o",
    "gpt-4.1",
  ]);
  assert.deepEqual(modelsForProvider(PROVIDERS, ""), []);
  assert.deepEqual(modelsForProvider(PROVIDERS, "   "), []);
  assert.deepEqual(modelsForProvider(PROVIDERS, "nope"), []);
});

// ── patch 构建（features 未开的区块保留原值）───────────────────────
ok("buildModelPatch：trim + 去重；未开 advanced 时保留 value 高级字段", () => {
  const value: ModelDraft = {
    provider: "openai",
    model: "gpt-4o",
    fallbacks: ["f1"],
    temperature: 0.3,
    maxTokens: 4096,
    stream: true,
  };
  const draft: ModelDraft = {
    provider: "  openai  ",
    model: " gpt-4.1 ",
    fallbacks: ["f2", "f2", "f1", "f3", "f4"],
  };
  const off = buildModelPatch(draft, value, {});
  assert.equal(off.provider, "openai");
  assert.equal(off.model, "gpt-4.1");
  // features.fallbacks 未开 → 保留 value 回退链（不被草稿冲掉）
  assert.deepEqual(off.fallbacks, ["f1"]);
  // features.advanced 未开 → 保留 value 高级字段
  assert.equal(off.temperature, 0.3);
  assert.equal(off.maxTokens, 4096);
  assert.equal(off.stream, true);

  const on = buildModelPatch(draft, value, { advanced: true, fallbacks: true });
  assert.deepEqual(on.fallbacks, ["f2", "f1", "f3"]); // 去重 + 上限 3
  assert.equal(on.temperature, undefined); // 草稿未设 → 不带（入口不传）
  assert.equal(on.maxTokens, undefined);
  assert.equal(on.stream, undefined);
});

ok("isDraftDirty：无变化 false；实质变化 true；纯空白变化不假脏", () => {
  const value: ModelDraft = { provider: "openai", model: "gpt-4o" };
  assert.equal(isDraftDirty(value, value), false);
  assert.equal(
    isDraftDirty({ ...value, model: "gpt-4.1" }, value),
    true,
  );
  assert.equal(isDraftDirty({ ...value, provider: "  openai " }, value), false);
  assert.equal(isDraftDirty({ ...value, provider: "anthropic" }, value), true);
});

// ── 源码不 import 后端 api（视图层零后端）──────────────────────────
function importSpecifiers(src: string): string[] {
  const out: string[] = [];
  const reFrom = /(?:^|\n)\s*import\s[^;]*?from\s+["']([^"']+)["']/g;
  const reSide = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  for (const re of [reFrom, reSide]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) out.push(m[1]);
  }
  return out;
}

ok("源码不 import 后端 api / 无 fetch：modelDraft 零 import；组件只引视图依赖", () => {
  const draftSrc = readFileSync(
    path.join(here, "..", "src", "lib", "modelDraft.ts"),
    "utf8",
  );
  const modalSrc = readFileSync(
    path.join(here, "..", "src", "manage", "ModelSettingsModal.tsx"),
    "utf8",
  );

  // 纯函数模块：零 import（node strip-types 直 import 的前提）
  assert.deepEqual(importSpecifiers(draftSrc), []);

  const specs = importSpecifiers(modalSrc);
  assert.ok(specs.length > 0, "组件应有 import（视图依赖）");
  for (const s of specs) {
    assert.ok(
      !/(^|\/)api(\/|$)/.test(s) && !s.includes("api/domains"),
      `组件不应 import 后端 api：${s}`,
    );
  }
  // 无后端调用原语
  assert.ok(!/fetch\s*\(/.test(modalSrc), "组件内不应出现 fetch( 调用");
  assert.ok(!modalSrc.includes("XMLHttpRequest"));
  assert.ok(!modalSrc.includes("qwenpaw.chat"));
});

console.log(`\nc1-model-modal: ${n} passed`);
