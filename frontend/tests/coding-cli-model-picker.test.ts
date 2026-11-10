// CodingCLI 模型选择器目录（单一来源）——lib/codingCliModel 纯函数行为
// 断言：
// - buildCliModelPickerProviders（跟随选项 / CLI 条目 / Worker 候选 /
//   同 id 去重 / grantedPairs 授予对）；
// - classifyCliModel 四态 + cliModelInitialSelection（孤儿回落）；
// - resolveCliModelSelection 的 baseUrl 规则；
// - ModelEditModal / ModelPicker 源码接线断言（lib 单一来源、无本地重复、
//   弹层恰好一个 ModelPicker、provider 先于 model）。
// 直跑：node --experimental-strip-types frontend/tests/coding-cli-model-picker.test.ts
//（node:assert/strict；lib 模块 node 可直 import——仅 import type，运行时
// 零依赖；组件依赖 window.QwenPaw host，走源码文本断言）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildCliModelPickerProviders,
  CLI_FOLLOW_SPAWN,
  CLI_FOLLOW_WORKER,
  CLI_WORKER_PROVIDER_PREFIX,
  classifyCliModel,
  cliModelEntries,
  cliModelInitialSelection,
  isCliFollowProvider,
  resolveCliModelSelection,
} from "../src/lib/codingCliModel.ts";

const libSrc = readFileSync(
  new URL("../src/lib/codingCliModel.ts", import.meta.url),
  "utf8",
);
const modalSrc = readFileSync(
  new URL("../src/manage/ModelEditModal.tsx", import.meta.url),
  "utf8",
);
const pickerSrc = readFileSync(
  new URL("../src/components/ModelPicker.tsx", import.meta.url),
  "utf8",
);

let n = 0;
function ok(name: string, fn: () => void): void {
  fn();
  n += 1;
  console.log(`  PASS ${n} ${name}`);
}

const LABELS = { followWorker: "跟随 Worker", followSpawn: "跟随子代理" };

// ── 常量 / 哨兵判定 ──────────────────────────────────────────────────
ok("常量：哨兵值与前缀保持既有口径（~follow~ / ~follow-spawn~ / worker:）", () => {
  assert.equal(CLI_FOLLOW_WORKER, "~follow~");
  assert.equal(CLI_FOLLOW_SPAWN, "~follow-spawn~");
  assert.equal(CLI_WORKER_PROVIDER_PREFIX, "worker:");
});

ok("isCliFollowProvider：两哨兵 true；真实 provider / worker: 前缀 / 空串 false", () => {
  assert.equal(isCliFollowProvider(CLI_FOLLOW_WORKER), true);
  assert.equal(isCliFollowProvider(CLI_FOLLOW_SPAWN), true);
  assert.equal(isCliFollowProvider("openai"), false);
  assert.equal(isCliFollowProvider("worker:openai"), false);
  assert.equal(isCliFollowProvider(""), false);
});

// ── buildCliModelPickerProviders ─────────────────────────────────────
ok("跟随 Worker 选项：models = [mainModel]、不 disabled", () => {
  const out = buildCliModelPickerProviders({
    entries: [],
    workerProviders: [],
    mainModel: "m-main",
    subagentModel: "",
    labels: LABELS,
  });
  assert.equal(out[0].name, CLI_FOLLOW_WORKER);
  assert.equal(out[0].label, "跟随 Worker");
  assert.deepEqual(out[0].models, ["m-main"]);
  assert.notEqual(out[0].disabled, true);
});

ok("mainModel === '' → 跟随 Worker 禁用（models 空）", () => {
  const out = buildCliModelPickerProviders({
    entries: [],
    workerProviders: [],
    mainModel: "",
    subagentModel: "m-spawn",
    labels: LABELS,
  });
  assert.equal(out[0].disabled, true);
  assert.deepEqual(out[0].models, []);
});

ok("跟随子代理选项：models = [subagentModel]、不 disabled", () => {
  const out = buildCliModelPickerProviders({
    entries: [],
    workerProviders: [],
    mainModel: "m-main",
    subagentModel: "m-spawn",
    labels: LABELS,
  });
  assert.equal(out[1].name, CLI_FOLLOW_SPAWN);
  assert.equal(out[1].label, "跟随子代理");
  assert.deepEqual(out[1].models, ["m-spawn"]);
  assert.notEqual(out[1].disabled, true);
});

ok("subagentModel === '' → 跟随子代理禁用", () => {
  const out = buildCliModelPickerProviders({
    entries: [],
    workerProviders: [],
    mainModel: "m-main",
    subagentModel: "",
    labels: LABELS,
  });
  assert.equal(out[1].disabled, true);
  assert.deepEqual(out[1].models, []);
});

ok("CLI 条目：label `id · baseUrl`（无 baseUrl → 纯 id）+ 声明 models", () => {
  const out = buildCliModelPickerProviders({
    entries: [
      { id: "openai", baseUrl: "https://a.example/v1", models: ["gpt-4o", "gpt-4o-mini"] },
      { id: "gemini", baseUrl: "", models: ["gemini-2"] },
    ],
    workerProviders: [],
    mainModel: "m",
    subagentModel: "",
    labels: LABELS,
  });
  assert.deepEqual(out.slice(2), [
    { name: "openai", label: "openai · https://a.example/v1", models: ["gpt-4o", "gpt-4o-mini"] },
    { name: "gemini", label: "gemini", models: ["gemini-2"] },
  ]);
});

ok("Worker 候选：CLI 条目同 id 时 CLI 优先（不列 worker:<同id>）；label `<name> · Worker`（用 wp.label）", () => {
  const out = buildCliModelPickerProviders({
    entries: [{ id: "deepseek", baseUrl: "https://d.example/v1", models: ["deepseek-chat"] }],
    workerProviders: [
      { name: "deepseek", models: ["deepseek-chat"] },
      { name: "qwen", label: "Qwen (worker)", models: ["qwen3"] },
    ],
    mainModel: "m",
    subagentModel: "",
    labels: LABELS,
  });
  assert.deepEqual(out.map((p) => p.name), [
    CLI_FOLLOW_WORKER,
    CLI_FOLLOW_SPAWN,
    "deepseek",
    "worker:qwen",
  ]);
  const w = out.find((p) => p.name === "worker:qwen")!;
  assert.equal(w.label, "Qwen (worker) · Worker");
  assert.deepEqual(w.models, ["qwen3"]);
});

ok("Worker 候选：name 空 / models 空者剔除；无 label 时回退 name", () => {
  const out = buildCliModelPickerProviders({
    entries: [],
    workerProviders: [
      { name: "", models: ["x"] },
      { name: "empty", models: [] },
      { name: "solo", models: ["s1"] },
    ],
    mainModel: "m",
    subagentModel: "",
    labels: LABELS,
  });
  const workers = out.filter((p) => p.name.startsWith(CLI_WORKER_PROVIDER_PREFIX));
  assert.deepEqual(workers, [
    { name: "worker:solo", label: "solo · Worker", models: ["s1"] },
  ]);
});

ok("grantedPairs 非空：授予对是唯一独立候选源（模型去重、顺序保留；label 命中条目 → id · baseUrl；不列 Worker 候选）", () => {
  const out = buildCliModelPickerProviders({
    entries: [{ id: "openai", baseUrl: "https://a.example/v1", models: ["gpt-4o", "gpt-4o-mini"] }],
    workerProviders: [
      { name: "openai", models: ["gpt-4o"] },
      { name: "qwen", models: ["qwen3"] },
    ],
    mainModel: "m",
    subagentModel: "",
    labels: LABELS,
    grantedPairs: [
      { provider: "openai", model: "gpt-4o" },
      { provider: "openai", model: "gpt-4o-mini" },
      { provider: "openai", model: "gpt-4o" }, // 重复对 → 去重
      { provider: "anthropic", model: "claude-3" },
    ],
  });
  assert.deepEqual(out.slice(2), [
    { name: "openai", label: "openai · https://a.example/v1", models: ["gpt-4o", "gpt-4o-mini"] },
    { name: "anthropic", label: "anthropic", models: ["claude-3"] },
  ]);
});

ok("grantedPairs 缺省 → 无限制（跟随 + 条目 + Worker 候选全列）", () => {
  const out = buildCliModelPickerProviders({
    entries: [{ id: "openai", baseUrl: "https://a.example/v1", models: ["gpt-4o"] }],
    workerProviders: [{ name: "qwen", models: ["qwen3"] }],
    mainModel: "m",
    subagentModel: "s",
    labels: LABELS,
  });
  assert.deepEqual(out.map((p) => p.name), [
    CLI_FOLLOW_WORKER,
    CLI_FOLLOW_SPAWN,
    "openai",
    "worker:qwen",
  ]);
});

// ── classifyCliModel：四态 ───────────────────────────────────────────
ok("classifyCliModel：未配置（无 settings / 无 model / 空名）→ none", () => {
  assert.equal(classifyCliModel({}, "main", "spawn"), "none");
  assert.equal(classifyCliModel(null, "main", "spawn"), "none");
  assert.equal(classifyCliModel({ model: { name: "" } }, "main", "spawn"), "none");
});

ok("classifyCliModel：无 baseUrl + 名 = 主模型 → follow-worker", () => {
  assert.equal(
    classifyCliModel({ model: { name: "main-model" } }, "main-model", "spawn-model"),
    "follow-worker",
  );
});

ok("classifyCliModel：无 baseUrl + 名 = 子代理模型（≠ 主模型）→ follow-spawn", () => {
  assert.equal(
    classifyCliModel({ model: { name: "spawn-model" } }, "main-model", "spawn-model"),
    "follow-spawn",
  );
});

ok("classifyCliModel：子代理模型 = 主模型 → follow-worker（不判 spawn）", () => {
  assert.equal(classifyCliModel({ model: { name: "same" } }, "same", "same"), "follow-worker");
});

ok("classifyCliModel：有 baseUrl（含孤儿）/ 名与两目标都不相等 → independent；扁平字符串同判", () => {
  assert.equal(
    classifyCliModel(
      { model: { name: "gpt-4o", baseUrl: "https://a.example/v1" } },
      "main",
      "spawn",
    ),
    "independent",
  );
  assert.equal(
    classifyCliModel(
      { model: { name: "orphan", baseUrl: "https://orphan.example/v1" } },
      "main",
      "spawn",
    ),
    "independent",
  );
  assert.equal(classifyCliModel({ model: { name: "other" } }, "main", "spawn"), "independent");
  assert.equal(classifyCliModel({ model: "other" }, "main", "spawn"), "independent");
});

// ── cliModelInitialSelection ─────────────────────────────────────────
ok("cliModelInitialSelection：独立态 baseUrl 命中条目 → 该 provider + 名", () => {
  const sel = cliModelInitialSelection(
    {
      model: { name: "gpt-4o", baseUrl: "https://a.example/v1" },
      modelProviders: { openai: [{ id: "gpt-4o", baseUrl: "https://a.example/v1" }] },
    },
    "main-model",
    "spawn-model",
  );
  assert.deepEqual(sel, { provider: "openai", model: "gpt-4o" });
});

ok("cliModelInitialSelection：孤儿 baseUrl（未命中条目）→ 回落跟随 Worker + 主模型（孤儿值不回显）", () => {
  const sel = cliModelInitialSelection(
    {
      model: { name: "gpt-4o", baseUrl: "https://orphan.example/v1" },
      modelProviders: { openai: [{ id: "gpt-4o", baseUrl: "https://a.example/v1" }] },
    },
    "main-model",
    "spawn-model",
  );
  assert.deepEqual(sel, { provider: CLI_FOLLOW_WORKER, model: "main-model" });
});

ok("cliModelInitialSelection：follow-spawn / follow-worker / 未配置 的投影", () => {
  assert.deepEqual(
    cliModelInitialSelection({ model: { name: "spawn-model" } }, "main-model", "spawn-model"),
    { provider: CLI_FOLLOW_SPAWN, model: "spawn-model" },
  );
  assert.deepEqual(
    cliModelInitialSelection({ model: { name: "main-model" } }, "main-model", "spawn-model"),
    { provider: CLI_FOLLOW_WORKER, model: "main-model" },
  );
  assert.deepEqual(cliModelInitialSelection({}, "main-model", "spawn-model"), {
    provider: CLI_FOLLOW_WORKER,
    model: "main-model",
  });
});

// ── resolveCliModelSelection：保存语义 ───────────────────────────────
ok("resolveCliModelSelection：跟随 = 目标模型名、不写 baseUrl、isFollow true（不受所选模型影响）", () => {
  assert.deepEqual(
    resolveCliModelSelection(CLI_FOLLOW_WORKER, "ignored", "main-model", "spawn-model", []),
    { name: "main-model", baseUrl: "", isFollow: true },
  );
  assert.deepEqual(
    resolveCliModelSelection(CLI_FOLLOW_SPAWN, "ignored", "main-model", "spawn-model", []),
    { name: "spawn-model", baseUrl: "", isFollow: true },
  );
});

ok("resolveCliModelSelection：独立 = 模型名 trim + 条目 baseUrl（worker: 前缀 / 无匹配条目 → 不写 baseUrl）", () => {
  const entries = [{ id: "openai", baseUrl: "https://a.example/v1", models: ["gpt-4o"] }];
  assert.deepEqual(resolveCliModelSelection("openai", "  gpt-4o  ", "m", "s", entries), {
    name: "gpt-4o",
    baseUrl: "https://a.example/v1",
    isFollow: false,
  });
  assert.deepEqual(resolveCliModelSelection("worker:qwen", "qwen3", "m", "s", entries), {
    name: "qwen3",
    baseUrl: "",
    isFollow: false,
  });
  assert.deepEqual(resolveCliModelSelection("no-such", "m1", "m", "s", entries), {
    name: "m1",
    baseUrl: "",
    isFollow: false,
  });
});

// ── 端到端：entries → 目录 → 初始选择 → 保存解析 ─────────────────────
ok("端到端：cliModelEntries → buildCliModelPickerProviders → cliModelInitialSelection → resolveCliModelSelection", () => {
  const settings = {
    model: { name: "gpt-4o", baseUrl: "https://a.example/v1" },
    modelProviders: {
      openai: [
        { id: "gpt-4o", baseUrl: "https://a.example/v1" },
        { id: "gpt-4o-mini", baseUrl: "https://a.example/v1" },
      ],
    },
  };
  const entries = cliModelEntries(settings);
  const out = buildCliModelPickerProviders({
    entries,
    workerProviders: [
      { name: "openai", models: ["gpt-4o"] },
      { name: "qwen", models: ["qwen3"] },
    ],
    mainModel: "main-model",
    subagentModel: "",
    labels: LABELS,
  });
  // 同 id Worker 候选被 CLI 条目顶掉。
  assert.deepEqual(out.map((p) => p.name), [
    CLI_FOLLOW_WORKER,
    CLI_FOLLOW_SPAWN,
    "openai",
    "worker:qwen",
  ]);
  const initial = cliModelInitialSelection(settings, "main-model", "");
  const sel = resolveCliModelSelection(
    initial.provider,
    initial.model,
    "main-model",
    "",
    entries,
  );
  assert.deepEqual(sel, {
    name: "gpt-4o",
    baseUrl: "https://a.example/v1",
    isFollow: false,
  });
});

// ── 源码接线：ModelEditModal 走 lib 单一来源 ─────────────────────────
ok("ModelEditModal：四个 lib 函数全部在用（目录/四态/初始选择/保存语义）", () => {
  for (const fn of [
    "buildCliModelPickerProviders",
    "classifyCliModel",
    "cliModelInitialSelection",
    "resolveCliModelSelection",
  ]) {
    assert.ok(modalSrc.includes(fn), `modal 缺少 ${fn}`);
  }
});

ok("ModelEditModal：无本地重复（哨兵常量 / workerOptions / modelOptionsFor / providerLabel 均不定义）", () => {
  assert.doesNotMatch(modalSrc, /const FOLLOW_PROVIDER\b/);
  assert.doesNotMatch(modalSrc, /const FOLLOW_SPAWN_PROVIDER/);
  assert.doesNotMatch(modalSrc, /const WORKER_PROVIDER_PREFIX/);
  assert.doesNotMatch(modalSrc, /const workerOptions/);
  assert.doesNotMatch(modalSrc, /modelOptionsFor\(/);
  assert.doesNotMatch(modalSrc, /providerLabel/);
});

ok("ModelEditModal：workerProviders 原样透传（JSX 不再 .filter）", () => {
  assert.match(modalSrc, /workerProviders=\{pickerProviders\}/);
  assert.doesNotMatch(modalSrc, /workerProviders=\{pickerProviders\.filter/);
});

ok("弹层恰好一个 ModelPicker（无新并行选择器）且 providers={pickerProviders}", () => {
  const start = modalSrc.indexOf("function CliModelEditDialog");
  assert.ok(start > 0, "CliModelEditDialog 存在");
  const dialogSrc = modalSrc.slice(start);
  assert.equal(dialogSrc.split("<ModelPicker").length - 1, 1);
  assert.match(dialogSrc, /providers=\{pickerProviders\}/);
});

ok("lib：`id · baseUrl` label + 跟随标签来自调用方 labels（纯函数不碰 window）", () => {
  assert.match(libSrc, /\`\$\{id\} · \$\{e\.baseUrl\}\`/);
  assert.match(libSrc, /labels\.followWorker/);
  assert.match(libSrc, /labels\.followSpawn/);
  assert.doesNotMatch(libSrc, /window\./);
});

ok("ModelPicker：Provider 选择器在 Model 选择器之前（唯一选择器，顺序不变）", () => {
  const p = pickerSrc.indexOf("value={provider");
  const m = pickerSrc.indexOf("value={model");
  assert.ok(p > 0 && m > 0, "ModelPicker 有 provider/model 两个 Select");
  assert.ok(p < m, "provider 在 model 之前");
});

console.log(`\ncoding-cli-model-picker: ${n} passed`);
