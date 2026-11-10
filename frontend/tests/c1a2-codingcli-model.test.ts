// C1a-2：模型设置增加 CodingCLI 条目（先 Provider 后模型；provider 落
// model.baseUrl）——
// - lib/codingCliModel 纯函数行为断言（node 直 import：cliModelEntries /
//   cliCurrentModel / buildCliModelPatch）；
// - ModelEditModal / WorkerDetailPane / ManagerDetailPane 源码断言
//   （workerName 门控、putCliSettings 保存链、先 Provider 后模型控件序）；
// - api/domains/codingcli 的 objectModel + i18n 键（chat.ts 新键齐、
//   「未配置」复用 worker.ts 既有键不重复）。
// 直跑：node --experimental-strip-types frontend/tests/c1a2-codingcli-model.test.ts
//（node:assert/strict；lib 模块 node 可直 import——仅 import type，运行时零依赖；
// 其余组件依赖 window.QwenPaw host，走源码文本断言）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildCliModelPatch,
  cliCurrentModel,
  cliModelEntries,
} from "../src/lib/codingCliModel.ts";

const libSrc = readFileSync(
  new URL("../src/lib/codingCliModel.ts", import.meta.url),
  "utf8",
);
const modalSrc = readFileSync(
  new URL("../src/manage/ModelEditModal.tsx", import.meta.url),
  "utf8",
);
const workerPaneSrc = readFileSync(
  new URL("../src/manage/WorkerDetailPane.tsx", import.meta.url),
  "utf8",
);
const managerPaneSrc = readFileSync(
  new URL("../src/manage/ManagerDetailPane.tsx", import.meta.url),
  "utf8",
);
const codingCliApiSrc = readFileSync(
  new URL("../src/api/domains/codingcli.ts", import.meta.url),
  "utf8",
);
const chatI18nSrc = readFileSync(
  new URL("../src/i18n/domains/chat.ts", import.meta.url),
  "utf8",
);
const workerI18nSrc = readFileSync(
  new URL("../src/i18n/domains/worker.ts", import.meta.url),
  "utf8",
);

let n = 0;
function ok(name: string, fn: () => void): void {
  fn();
  n += 1;
  console.log(`  PASS ${n} ${name}`);
}

// ── cliModelEntries：modelProviders（{providerId: ModelConfig[]}）→ 条目 ──
ok("cliModelEntries：多 provider 多模型（models 按声明序去重；baseUrl 取第一个非空）", () => {
  const entries = cliModelEntries({
    model: { name: "gpt-4o", baseUrl: "https://a.example/v1" },
    modelProviders: {
      openai: [
        { id: "gpt-4o", baseUrl: "https://a.example/v1", envKey: "OPENAI_API_KEY" },
        { id: "gpt-4o-mini", baseUrl: "https://a.example/v1" },
        { id: "gpt-4o", baseUrl: "" }, // 重复 id → 去重
      ],
      anthropic: [{ id: "claude-3", baseUrl: "https://b.example/v1" }],
    },
  });
  assert.deepEqual(entries, [
    { id: "openai", baseUrl: "https://a.example/v1", models: ["gpt-4o", "gpt-4o-mini"] },
    { id: "anthropic", baseUrl: "https://b.example/v1", models: ["claude-3"] },
  ]);
});

ok("cliModelEntries：空 / 无 modelProviders / 形状非法 → []（不炸）", () => {
  assert.deepEqual(cliModelEntries({}), []);
  assert.deepEqual(cliModelEntries({ modelProviders: {} }), []);
  assert.deepEqual(cliModelEntries(null), []);
  assert.deepEqual(cliModelEntries(undefined), []);
  assert.deepEqual(cliModelEntries({ modelProviders: "oops" }), []);
});

ok("cliModelEntries：条目缺 models（路由数组空 / 条目无 id）→ models 空但保留 provider", () => {
  const entries = cliModelEntries({
    modelProviders: {
      openai: [],
      gemini: [{ name: "无名条目" }, "非对象条目"],
    },
  });
  assert.deepEqual(entries, [
    { id: "openai", baseUrl: "", models: [] },
    { id: "gemini", baseUrl: "", models: [] },
  ]);
});

// ── cliCurrentModel：name+baseUrl 成对读 + providerId 按 baseUrl 反查 ──
ok("cliCurrentModel：有 baseUrl 命中 provider（反查条目）", () => {
  const cur = cliCurrentModel({
    model: { name: "gpt-4o", baseUrl: "https://a.example/v1" },
    modelProviders: {
      openai: [{ id: "gpt-4o", baseUrl: "https://a.example/v1" }],
      anthropic: [{ id: "claude-3", baseUrl: "https://b.example/v1" }],
    },
  });
  assert.deepEqual(cur, {
    name: "gpt-4o",
    baseUrl: "https://a.example/v1",
    providerId: "openai",
  });
});

ok("cliCurrentModel：baseUrl 无匹配（孤儿 baseUrl）→ providerId null", () => {
  const cur = cliCurrentModel({
    model: { name: "gpt-4o", baseUrl: "https://orphan.example/v1" },
    modelProviders: {
      openai: [{ id: "gpt-4o", baseUrl: "https://a.example/v1" }],
    },
  });
  assert.equal(cur.providerId, null);
  assert.equal(cur.baseUrl, "https://orphan.example/v1");
});

ok("cliCurrentModel：无 baseUrl（对象）→ null；扁平字符串 → name + null", () => {
  const a = cliCurrentModel({
    model: { name: "gpt-4o" },
    modelProviders: {
      openai: [{ id: "gpt-4o", baseUrl: "https://a.example/v1" }],
    },
  });
  assert.deepEqual(a, { name: "gpt-4o", baseUrl: "", providerId: null });
  const b = cliCurrentModel({ model: "flat-model" });
  assert.deepEqual(b, { name: "flat-model", baseUrl: "", providerId: null });
});

// ── buildCliModelPatch：写盘形态（PUT settings 端点 deep-merge 补丁）──
ok("buildCliModelPatch：qwen-code 对象合并保其余键（envKey 不丢）+ name/baseUrl 成对", () => {
  const patch = buildCliModelPatch(
    "qwen-code",
    { name: "old-model", envKey: "OPENAI_API_KEY", baseUrl: "https://old" },
    "new-model",
    "https://a.example/v1",
  );
  assert.deepEqual(patch, {
    model: { name: "new-model", envKey: "OPENAI_API_KEY", baseUrl: "https://a.example/v1" },
  });
});

ok("buildCliModelPatch：qwen-code baseUrl 空 → 删除该键（含旧值不残留）", () => {
  const patch = buildCliModelPatch(
    "qwen-code",
    { name: "old-model", envKey: "K", baseUrl: "https://old" },
    "new-model",
    "",
  );
  const m = patch.model as Record<string, unknown>;
  assert.deepEqual(m, { name: "new-model", envKey: "K" });
  assert.ok(!("baseUrl" in m), "baseUrl 键必须被删除");
});

ok("buildCliModelPatch：扁平形态（opencode/qoder）→ {model: name}（无 provider 维度）", () => {
  assert.deepEqual(buildCliModelPatch("opencode", "old", "new-model", "https://x"), {
    model: "new-model",
  });
  assert.deepEqual(buildCliModelPatch("qoder", "old", "q-model", ""), {
    model: "q-model",
  });
});

ok("buildCliModelPatch：existingModel 缺失/非对象 → 干净起点（qwen-code）", () => {
  assert.deepEqual(buildCliModelPatch("qwen-code", undefined, "m", "https://x"), {
    model: { name: "m", baseUrl: "https://x" },
  });
  assert.deepEqual(buildCliModelPatch("qwen-code", "flat-str", "m", ""), {
    model: { name: "m" },
  });
});

// ── 源码断言：objectModel（api 域）+ ModelEditModal 区块 ─────────────
ok("api/codingcli：objectModel 判定存在（纯映射 qwen-code→true）", () => {
  assert.match(codingCliApiSrc, /export function objectModel\(cli: CodingCliId\): boolean/);
  assert.match(codingCliApiSrc, /return cli === "qwen-code";/);
});

ok("ModelEditModal：新 props workerName/l1 + 区块门控（仅 workerName 存在时渲染）", () => {
  assert.match(modalSrc, /workerName\?: string;/);
  assert.match(modalSrc, /l1\?: boolean;/);
  assert.match(modalSrc, /\{workerName && l1 \?/);
  assert.match(
    modalSrc,
    /<CodingCliModelSection[\s\S]{0,400}?workerName=\{workerName\}[\s\S]{0,200}?mainModel=\{currentModel\}/,
  );
});

ok("ModelEditModal：数据链齐全（listCodingCli 探针 + getCliSettings + putCliSettings 保存）", () => {
  assert.match(modalSrc, /listCodingCli\(workerName\)/);
  assert.match(modalSrc, /getCliSettings\(workerName, /);
  assert.match(modalSrc, /putCliSettings\(workerName, cli, patch/);
  assert.match(modalSrc, /p\.installed/);
});

ok("ModelEditModal：弹层单一 ModelPicker（先 Provider 后模型由 ModelPicker 统一执行）", () => {
  const start = modalSrc.indexOf("function CliModelEditDialog");
  assert.ok(start > 0, "CliModelEditDialog 存在");
  const dialogSrc = modalSrc.slice(start);
  assert.equal(
    dialogSrc.split("<ModelPicker").length - 1,
    1,
    "弹层恰好一个 ModelPicker",
  );
  assert.match(dialogSrc, /providers=\{pickerProviders\}/);
});

ok("ModelEditModal：Provider 候选目录 = buildCliModelPickerProviders（lib 单一来源：cliModelEntries 条目 id · baseUrl + 跟随 Worker）", () => {
  assert.match(modalSrc, /cliModelEntries\(settings\.settings\)/);
  assert.match(modalSrc, /buildCliModelPickerProviders\(/);
  assert.match(libSrc, /\$\{e\.id\} · \$\{e\.baseUrl\}/);
  assert.match(libSrc, /labels\.followWorker/);
  assert.doesNotMatch(modalSrc, /label: tr\("跟随 Worker"\)/);
});

ok("WorkerDetailPane：传 workerName={worker.name} + l1={l1}；Manager 不传（自检①）", () => {
  assert.match(workerPaneSrc, /workerName=\{worker\.name\}/);
  assert.match(workerPaneSrc, /l1=\{l1\}/);
  assert.doesNotMatch(managerPaneSrc, /workerName=/);
});

ok("ModelEditModal：扁平形态无 provider 维度提示 + 读失败可重试（自检⑤⑥）", () => {
  assert.match(modalSrc, /该 CLI 不支持 Provider 维度（扁平模型名）/);
  assert.match(modalSrc, /Provider 条目由 Coding CLI 面板维护（L1）/);
  assert.match(modalSrc, /retryCli\(p\.cli\)/);
  assert.match(modalSrc, /onClick=\{\(\) => setReload\(\(n\) => n \+ 1\)\}/);
});

ok("i18n：C1a-2 新键齐（chat.ts；「未配置」复用 worker.ts 既有键，禁重复）", () => {
  for (const key of [
    '"CodingCLI 模型":',
    '"跟随 Worker":',
    '"跟随主模型":',
    '"独立":',
    '"修改":',
    '"该 CLI 不支持 Provider 维度（扁平模型名）":',
    '"Provider 条目由 Coding CLI 面板维护（L1）":',
  ]) {
    assert.ok(chatI18nSrc.includes(key), `chat.ts 缺键 ${key}`);
  }
  assert.ok(!chatI18nSrc.includes('"未配置":'), "「未配置」已在 worker.ts，chat.ts 不得重复");
  assert.ok(workerI18nSrc.includes('"未配置":'));
});

console.log(`\n${n} tests passed`);
