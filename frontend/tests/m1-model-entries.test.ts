// M1：模型设置入口补全覆盖 + 创建 Worker 改成只创建（C1a-2）——
// 创建表单/团队表单的 provider-first 成对控件（filterModelOptionsByProvider /
// providerForModel / providerModelMismatch）+ createWorker body 带 modelProvider
// + 团队表单行 provider 落保存链 + 假承诺（「创建并加入团队」/「加入团队成员」）
// 清零，全源码文本断言（crdmanage 组件依赖 window.QwenPaw host，node 不可直
// import；i18n 键断言落 chat.ts 文本）。
// 直跑：node --experimental-strip-types frontend/tests/m1-model-entries.test.ts
//（node:assert/strict；readFileSync 四份源文本 + assert.match / doesNotMatch）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workerFormSrc = readFileSync(
  new URL("../src/crdmanage/CrdWorkerForm.tsx", import.meta.url),
  "utf8",
);
const teamFormSrc = readFileSync(
  new URL("../src/crdmanage/CrdTeamForm.tsx", import.meta.url),
  "utf8",
);
const teamCrdSrc = readFileSync(
  new URL("../src/crdmanage/useTeamCrd.tsx", import.meta.url),
  "utf8",
);
const chatSrc = readFileSync(
  new URL("../src/i18n/domains/chat.ts", import.meta.url),
  "utf8",
);

let n = 0;
function ok(name: string, fn: () => void): void {
  fn();
  n += 1;
  console.log(`  PASS ${n} ${name}`);
}

// ── 创建表单（CrdWorkerForm）：provider-first 成对控件 ──────────────
ok("创建表单：模型候选按 Provider 过滤 + configured alias 回填 Provider", () => {
  assert.match(workerFormSrc, /filterModelOptionsByProvider\(/);
  assert.match(workerFormSrc, /providerForModel\(/);
});

ok("创建表单：Provider 控件在模型控件前（provider 先选，model 后选）", () => {
  const p = workerFormSrc.indexOf("value={nw.provider}");
  const m = workerFormSrc.indexOf("value={nw.model}");
  assert.ok(p > 0, "provider 控件存在");
  assert.ok(m > 0, "模型控件存在");
  assert.ok(p < m, "provider 在模型之前");
});

ok("创建表单：失配黄字提示不阻塞（providerModelMismatch + 复用 C1a-1 键）", () => {
  assert.match(workerFormSrc, /providerModelMismatch\(/);
  assert.ok(
    workerFormSrc.includes("该模型不属于所选 Provider（可直接保存，以 Provider 为准）"),
  );
});

ok("创建表单：状态含 provider 且随 createWorker body 的 modelProvider 下发（类型注释实锤）", () => {
  assert.match(workerFormSrc, /modelProvider/);
});

// ── 团队表单（CrdTeamForm）：成员行 provider-first ─────────────────
ok("团队表单：行级 Provider 选择 + 候选按 Provider 过滤 + provider 落 updateRow", () => {
  assert.match(teamFormSrc, /filterModelOptionsByProvider\(/);
  assert.match(teamFormSrc, /providerForModel\(/);
  assert.match(teamFormSrc, /updateRow\(i, \{ provider/);
});

ok("团队表单：选中已有 Worker 预填其 CR 现值 modelProvider（diff 基线）", () => {
  assert.match(
    teamFormSrc,
    /workers\.find\(\(x\) => x\.name === v\)\?\.modelProvider \|\| ""/,
  );
});

// ── 保存链（useTeamCrd）：model+modelProvider 成对下发 ──────────────
ok("保存链：创建 body 带 modelProvider + 建队行级 diff 下发 + 画笔 updateWorkerModel 带 provider", () => {
  assert.match(teamCrdSrc, /modelProvider: nw\.provider/);
  assert.match(teamCrdSrc, /modelProvider: \(r\.provider/);
  assert.match(teamCrdSrc, /updateWorkerModel\([^]*provider/);
});

ok("假承诺清零：useTeamCrd 不再含「加入团队成员」措辞", () => {
  assert.doesNotMatch(teamCrdSrc, /加入团队成员/);
});

ok("创建只创建：useTeamCrd 不再经 saveCrd 写回 Team CR", () => {
  assert.doesNotMatch(teamCrdSrc, /saveCrd/);
});

ok("创建表单：按钮「创建 Worker」（不再「创建并加入团队」）", () => {
  assert.ok(workerFormSrc.includes('tr("创建 Worker")'));
  assert.doesNotMatch(workerFormSrc, /创建并加入团队/);
});

ok("创建表单：成功提示诚实（Worker 已创建 / 未配模型跟随默认 / 加入团队去成员列表）", () => {
  assert.ok(teamCrdSrc.includes('tr("Worker 已创建")'));
  assert.ok(teamCrdSrc.includes('tr("Worker 已创建——未配模型（跟随集群默认）")'));
  assert.ok(teamCrdSrc.includes('tr("加入团队请在团队配置的成员列表中操作")'));
  assert.doesNotMatch(teamCrdSrc, /已创建并加入团队/);
});

// ── i18n：M1 键齐（chat.ts；失配键复用 C1a-1 既有键，禁重复）────────
ok("i18n：M1 五键齐（4 新键 + 1 复用 C1a-1 失配键；精确键形防长键误匹配）", () => {
  assert.ok(chatSrc.includes('"创建 Worker":'));
  assert.ok(chatSrc.includes('"Worker 已创建":'));
  assert.ok(chatSrc.includes('"Worker 已创建——未配模型（跟随集群默认）":'));
  assert.ok(chatSrc.includes('"加入团队请在团队配置的成员列表中操作":'));
  assert.ok(
    chatSrc.includes('"该模型不属于所选 Provider（可直接保存，以 Provider 为准）":'),
  );
});

// ── 零新增请求：两表单叶子直调缓存包裹取数，无新取数 hook ──────────
ok("零新增请求：两表单取数走 cachedRequest 包裹的 fetchGatewayAi*（非新 hook）", () => {
  for (const [name, src] of [
    ["CrdWorkerForm", workerFormSrc],
    ["CrdTeamForm", teamFormSrc],
  ] as const) {
    assert.ok(src.includes("fetchGatewayAiRoutes()"), `${name} 取 routes`);
    assert.ok(src.includes("fetchGatewayAiProviders()"), `${name} 取 providers`);
    assert.doesNotMatch(src, /useModelUnionOptions/);
  }
});

console.log(`\n${n} tests passed`);
