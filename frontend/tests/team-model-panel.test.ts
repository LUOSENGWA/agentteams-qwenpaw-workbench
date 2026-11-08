// team-model-panel：团队设置 × 统一模型弹窗（ModelSettingsModal）接线单测。
// 直跑：node --experimental-strip-types frontend/tests/team-model-panel.test.ts
//（node:assert/strict；≥8 case；断言 shipped 实现而非分叉副本）。
//
// 加载路径：src/crdmanage/modelPanelWiring.ts 零运行时 import（仅
// import type，strip-types 下擦除）+ src/lib/modelDraft.ts 零 import
// → node 可直接按显式 .ts 扩展名 import，无需 bundle / window shim。
// CrdCfgModal.tsx（视图层，宿主注入）不做渲染测试——末两条以源码扫描
// 断言接线形态（import 了统一弹窗、无裸模型输入、写回链路保留）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildModelPatch } from "../src/lib/modelDraft.ts";
import {
  buildLocalProviderOptions,
  draftFromRow,
  LOCAL_PROVIDER,
  providerOfAlias,
  rowFromDraft,
} from "../src/crdmanage/modelPanelWiring.ts";
import type {
  LlmProviderLite,
  ModelSelectionOption,
} from "../src/modelCatalog.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

let n = 0;
function ok(name: string, fn: () => void): void {
  fn();
  n += 1;
  console.log(`  PASS ${n} ${name}`);
}

// ── fixtures（configured alias 带 binding；builtin 无 binding）───────
const GATEWAY: ModelSelectionOption[] = [
  {
    alias: "gpt-4o",
    kind: "configured",
    source: "gateway",
    binding: { providerName: "openai" },
  },
  {
    alias: "qwen3-max",
    kind: "configured",
    source: "gateway",
    binding: { providerName: "dashscope" },
  },
  { alias: "builtin-lm", kind: "builtin", source: "builtin" },
];
const PROVIDERS: LlmProviderLite[] = [
  {
    name: "openai",
    kind: "openai",
    rawConfigs: {
      modelMapping: {
        "gpt-4o": "gpt-4o",
        "gpt-3.5": "gpt-3.5-turbo",
        // 通配 / passthrough 键不是具体模型名（须剔除）：
        "*": "passthrough",
        "~strip": "x",
      },
    },
  },
  {
    name: "dashscope",
    kind: "openai",
    rawConfigs: { modelMapping: { "qwen3-max": "qwen-max" } },
  },
];

// ── 预填（行值 → ModelDraft）────────────────────────────────────────
ok("draftFromRow 解析序：已刷 provider > alias 绑定 > 哨兵", () => {
  // 已刷（画笔）provider 优先于 alias 绑定
  assert.deepEqual(
    draftFromRow("gpt-4o", "dashscope", GATEWAY),
    { provider: "dashscope", model: "gpt-4o" },
  );
  // provider 空 + configured alias → alias 绑定回填
  assert.deepEqual(
    draftFromRow("  gpt-4o  ", "", GATEWAY),
    { provider: "openai", model: "gpt-4o" },
  );
  // provider 空 + builtin alias（无 binding）→ 哨兵
  assert.deepEqual(
    draftFromRow("builtin-lm", undefined, GATEWAY),
    { provider: LOCAL_PROVIDER, model: "builtin-lm" },
  );
  // 全空 → 哨兵 + 空模型
  assert.deepEqual(draftFromRow("", "", GATEWAY), {
    provider: LOCAL_PROVIDER,
    model: "",
  });
});

// ── 写回（ModelDraft → 行值）────────────────────────────────────────
ok("rowFromDraft：哨兵 → alias 绑定；真实 provider 透传；trim", () => {
  // 哨兵 + 有绑定 alias → 写回该绑定
  assert.deepEqual(
    rowFromDraft({ provider: LOCAL_PROVIDER, model: "qwen3-max" }, GATEWAY),
    { model: "qwen3-max", provider: "dashscope" },
  );
  // 哨兵 + 无绑定（builtin / 在服模型）→ provider ""（= 不下发 = 不改）
  assert.deepEqual(
    rowFromDraft({ provider: LOCAL_PROVIDER, model: "builtin-lm" }, GATEWAY),
    { model: "builtin-lm", provider: "" },
  );
  // 真实 provider 原样透传（成对刷写）
  assert.deepEqual(
    rowFromDraft({ provider: "dashscope", model: " qwen3-max " }, GATEWAY),
    { model: "qwen3-max", provider: "dashscope" },
  );
  // provider 空（用户清空下拉）→ "" = 不改（PUT 合并语义）
  assert.deepEqual(
    rowFromDraft({ provider: "", model: "gpt-4o" }, GATEWAY),
    { model: "gpt-4o", provider: "" },
  );
});

// ── 行值 ↔ ModelDraft 往返（模拟弹窗 onSave 全链）──────────────────
ok("往返（改值）：行 → 预填 → 弹窗改 → buildModelPatch → 写回 → 再预填", () => {
  let row = { model: "gpt-4o", provider: "openai" };
  const value = draftFromRow(row.model, row.provider, GATEWAY);
  assert.deepEqual(value, { provider: "openai", model: "gpt-4o" });
  // 弹窗内改：换 provider + 模型
  const draft = { ...value, provider: "dashscope", model: "qwen3-max" };
  const patch = buildModelPatch(draft, value);
  row = rowFromDraft(patch, GATEWAY);
  assert.deepEqual(row, { model: "qwen3-max", provider: "dashscope" });
  // 再预填 = 用户改后的值（往返成立）
  assert.deepEqual(draftFromRow(row.model, row.provider, GATEWAY), {
    provider: "dashscope",
    model: "qwen3-max",
  });
});

ok("往返（清空，已刷 provider）：主模型清空 → 行 model=\"\"；painted provider 保留（同旧 UI）", () => {
  const row = { model: "qwen3-max", provider: "dashscope" };
  const value = draftFromRow(row.model, row.provider, GATEWAY);
  assert.equal(value.provider, "dashscope");
  // 弹窗内只清空主模型（allowEmptyMain 入口允许保存）
  const patch = buildModelPatch({ ...value, model: "" }, value);
  assert.equal(patch.model, "");
  const back = rowFromDraft(patch, GATEWAY);
  assert.equal(back.model, "");
  // painted provider 未动 → 原样写回（doCfg：p 触发该行下发，同旧语义）
  assert.equal(back.provider, "dashscope");
});

ok("往返（清空，哨兵）：builtin 行清空主模型 → 干净 {model:\"\", provider:\"\"}", () => {
  const row = { model: "builtin-lm", provider: "" };
  const value = draftFromRow(row.model, row.provider, GATEWAY);
  assert.equal(value.provider, LOCAL_PROVIDER);
  const patch = buildModelPatch({ ...value, model: "" }, value);
  const back = rowFromDraft(patch, GATEWAY);
  assert.deepEqual(back, { model: "", provider: providerOfAlias(GATEWAY, "") });
  assert.deepEqual(back, { model: "", provider: "" });
});

// ── Provider 目录 ───────────────────────────────────────────────────
ok("buildLocalProviderOptions：真实 provider（剔通配键）+ 哨兵组在前 + 去重", () => {
  const opts = buildLocalProviderOptions(PROVIDERS, GATEWAY, [
    "gpt-4o",
    "local-lm",
    "local-lm",
    " ",
  ]);
  assert.equal(opts[0].name, LOCAL_PROVIDER);
  assert.deepEqual(opts[0].models, ["gpt-4o", "local-lm"]);
  const byName = new Map(opts.map((o) => [o.name, o.models]));
  assert.deepEqual(byName.get("openai"), ["gpt-4o", "gpt-3.5"]); // "*"/"~" 键剔除
  assert.deepEqual(byName.get("dashscope"), ["qwen3-max"]);
  assert.equal(opts.length, 3); // 哨兵 + 2 真实
});

// ── 源码断言（接线形态）─────────────────────────────────────────────
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

ok("源码：CrdCfgForm import 了 ModelSettingsModal，无裸模型输入（AutoComplete/Select）", () => {
  const src = readFileSync(
    path.join(here, "..", "src", "crdmanage", "CrdCfgModal.tsx"),
    "utf8",
  );
  assert.ok(
    src.includes('import ModelSettingsModal from "../manage/ModelSettingsModal"'),
    "应 import 统一模型弹窗",
  );
  assert.ok(!src.includes("antd.AutoComplete"), "不应再有裸模型 AutoComplete");
  assert.ok(!src.includes("antd.Select"), "不应再有裸模型 Select");
  // 写回链路保留：弹窗保存只写本地 state，落盘仍由「保存」= doCfg 提交
  assert.ok(src.includes("updateCfgRow("), "行写回应仍走 updateCfgRow");
  assert.ok(src.includes("applyCfgBatch("), "批量写回应仍走 applyCfgBatch");
  // 「留空 = 继承」行可清空
  assert.ok(src.includes("allowEmptyMain"), "允许清空的入口应传 allowEmptyMain");
});

ok("源码：modelPanelWiring 零运行时 import（strip-types 直跑的前提）", () => {
  const src = readFileSync(
    path.join(here, "..", "src", "crdmanage", "modelPanelWiring.ts"),
    "utf8",
  );
  const specs = importSpecifiers(src);
  assert.ok(specs.length > 0, "应有 import type（catalog / modelDraft 类型）");
  for (const s of specs) {
    assert.ok(!s.includes("api"), `不应 import 后端 api：${s}`);
  }
  assert.ok(
    !/(?:^|\n)\s*import\s+(?!type\b)[^;]*?from/.test(src),
    "应仅 import type（无运行时 import）",
  );
});

console.log(`\nteam-model-panel: ${n} passed`);
