// model-provider-follow：provider 跟随模型 + 失配禁保存（provider+model
// 原子对契约）——源码文本断言（四入口拦截落位 + 旧放行文案零残留 + 新键
// 登记）+ modelUnion 纯函数行为回归（与 c1a-provider-first 同源同
// fixture，防纯函数被顺手改）。
//
// 主通道：node scripts/vitest-gate.mjs tests/model-provider-follow.vitest.test.ts
// - 不 import vitest：gate 的 runner（scripts/vitest-shim-runner.mjs）按
//   globalThis.__qcVt.tests = [{name, fn}] 契约执行，本文件自注册；
// - 不含 top-level await（gate 的 cjs 打包不支持）；
// - 路径锚点不用 m1 的 new URL(import.meta.url) 写法（cjs 打包下
//   import.meta.url 为 undefined 会炸）：gate 下 argv[1] =
//   scripts/vitest-shim-runner.mjs、直跑下 argv[1] = 本文件，两者上一级
//   均为 frontend/。
// 次通道（直跑）：node --experimental-strip-types tests/model-provider-follow.vitest.test.ts
// - 纯函数部分 SKIP：modelUnion 的无扩展名相对 import（./api）node ESM
//   解析不了（c1a 因此用 esbuild 预打包；本文件不能 import esbuild，
//   否则 gate 打包失败）——直跑下 SKIP 并注明，gate 下由 esbuild 打包
//   后动态 import 正常执行。
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// modelUnion.ts 顶层 `const host = window.QwenPaw.host;`（L28）读插件宿主
// ——gate 的 runner 预置 globalThis.window = globalThis（无 QwenPaw 字段），
// 动态 import modelUnion 时顶层即 TypeError。c1a 先例：api 依赖链顶层无
// 浏览器全局访问，仅 modelUnion 顶层需 shim；被测纯函数不触 host。
(globalThis as Record<string, unknown>).window = { QwenPaw: { host: {} } };

const frontendDir = path.resolve(path.dirname(process.argv[1] ?? "."), "..");

const readSrc = (rel: string): string =>
  readFileSync(path.join(frontendDir, rel), "utf8");

const swmSrc = readSrc("src/components/StandaloneWorkerModels.tsx");
const memSrc = readSrc("src/manage/ModelEditModal.tsx");
const cwfSrc = readSrc("src/crdmanage/CrdWorkerForm.tsx");
const ctfSrc = readSrc("src/crdmanage/CrdTeamForm.tsx");
const utcSrc = readSrc("src/crdmanage/useTeamCrd.tsx");
const chatI18n = readSrc("src/i18n/domains/chat.ts");
const workerI18n = readSrc("src/i18n/domains/worker.ts");

const NEW_KEY = "该模型不属于所选 Provider（不可保存：请调整 Provider 或重新选择模型）";
const OLD_TEXT = "可直接保存，以 Provider 为准";
const OWN_BASENAME = "model-provider-follow.vitest.test.ts";

type Case = { name: string; fn: () => void | Promise<void>; pure?: boolean };
const cases: Case[] = [];
function ok(name: string, fn: Case["fn"], pure = false): void {
  cases.push({ name, fn, pure });
}

// ── 1. StandaloneWorkerModels：provider 无条件跟随 + save 拦截 ──────
ok("SWM：模型 onChange 无条件跟随（无 if (auto && !prov) 保护）", () => {
  assert.doesNotMatch(swmSrc, /if \(auto && !prov\)/);
  assert.match(swmSrc, /if \(auto\) \{/);
});
ok("SWM：save 内失配拦截先于 updateWorkerModel（源码 index 判定）", () => {
  const m = swmSrc.indexOf("providerModelMismatch(");
  const w = swmSrc.indexOf("updateWorkerModel(");
  assert.ok(m > 0, "失配判定存在（首个调用点即 save 内拦截）");
  assert.ok(w > 0, "updateWorkerModel 调用存在");
  assert.ok(m < w, "失配拦截在写盘调用之前");
});

// ── 2. ModelEditModal：provider 无条件跟随 + handleOk 拦截 ──────────
ok("MEM：主模型 onChange 无条件跟随（无 !p && m ? 保护）", () => {
  assert.doesNotMatch(memSrc, /!p && m \?/);
  assert.match(memSrc, /const auto = m \? providerForModel\(/);
});
ok("MEM：handleOk 内失配拦截先于 onSave(", () => {
  const m = memSrc.indexOf("providerModelMismatch(");
  const s = memSrc.indexOf("onSave(");
  assert.ok(m > 0, "失配判定存在（首个调用点即 handleOk 内拦截）");
  assert.ok(s > 0, "onSave 调用存在");
  assert.ok(m < s, "失配拦截在提交之前");
});

// ── 3. useTeamCrd：批量失配整批拦截 + 创建路径拦截 ──────────────────
ok("UTC：doCfg 失配判定在 proceedCfg 之前（badCfg 范式处拦截 return）", () => {
  const doCfg = utcSrc.indexOf("const doCfg = React.useCallback");
  const proceed = utcSrc.indexOf("const proceedCfg = async");
  const m = utcSrc.indexOf("providerModelMismatch(", doCfg);
  const batch = utcSrc.indexOf("updateWorkerModel(", doCfg);
  assert.ok(doCfg > 0 && proceed > doCfg, "doCfg/proceedCfg 存在");
  assert.ok(m > 0 && m < proceed, "失配判定先于批量段（proceedCfg）");
  assert.ok(proceed < batch, "批量 updateWorkerModel 在 proceedCfg 内");
  assert.match(
    utcSrc.slice(doCfg, proceed),
    /if \(badPairs\.length\) \{[\s\S]*?return;/,
  );
});
ok("UTC：doCreateWorker 失配拦截先于 createWorker(", () => {
  const dcw = utcSrc.indexOf("const doCreateWorker = React.useCallback");
  const cw = utcSrc.indexOf("await createWorker({", dcw);
  const m = utcSrc.indexOf("providerModelMismatch(", dcw);
  assert.ok(dcw > 0 && cw > dcw, "doCreateWorker/createWorker 存在");
  assert.ok(m > 0 && m < cw, "失配拦截在创建之前");
});

// ── 4. CrdWorkerForm：展示新键 + 创建写路径拦截落位 ─────────────────
ok("CWF：失配黄字用新键；创建写路径（doCreateWorker）拦截在 createWorker 前", () => {
  assert.match(cwfSrc, /providerModelMismatch\(/);
  assert.ok(cwfSrc.includes(NEW_KEY), "黄字提示用新键");
  const dcw = utcSrc.indexOf("const doCreateWorker = React.useCallback");
  assert.ok(
    utcSrc.indexOf("providerModelMismatch(", dcw) <
      utcSrc.indexOf("await createWorker({", dcw),
  );
});
ok("CTF：团队表单行失配黄字用新键（放行语义注释同步）", () => {
  assert.match(ctfSrc, /providerModelMismatch\(/);
  assert.ok(ctfSrc.includes(NEW_KEY));
  assert.doesNotMatch(ctfSrc, /失配黄字提示不阻塞/);
});

// ── 5. 全局：旧放行文案零残留 + 新键 i18n 登记 ──────────────────────
ok("全局：旧放行文案「可直接保存，以 Provider 为准」零残留（src + tests 全树）", () => {
  const scanDir = (dir: string): string[] => {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) out.push(...scanDir(p));
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  };
  const files = [
    ...scanDir(path.join(frontendDir, "src")),
    ...scanDir(path.join(frontendDir, "tests")),
  ].filter((f) => path.basename(f) !== OWN_BASENAME); // 本文件常量含旧文案（判据自身）
  const hits = files.filter((f) => readFileSync(f, "utf8").includes(OLD_TEXT));
  assert.deepEqual(hits, [], `旧文案残留：${hits.join(", ")}`);
});
ok("i18n：新失配键登记（chat.ts zh 键形 + en 值）", () => {
  assert.ok(chatI18n.includes(`"${NEW_KEY}":`));
  assert.match(
    chatI18n,
    /cannot save: adjust the Provider or reselect the model/i,
  );
});
ok("i18n：批量失配键 + 底部提示新键登记（chat.ts / worker.ts）", () => {
  assert.ok(
    chatI18n.includes('"模型与 Provider 失配（不可保存，请调整后重试）：{list}":'),
  );
  assert.ok(
    workerI18n.includes(
      "Provider 自动跟随模型归属（configured alias）；模型与 Provider 不匹配不可保存。",
    ),
  );
});

// ── 6. 纯函数行为回归（与 c1a-provider-first 同源 fixture）──────────
type GwOption = {
  alias: string;
  kind: string;
  binding?: { providerName?: string } | null;
};
type ModelUnionMod = {
  providerForModel: (options: GwOption[], model: string) => string;
  providerModelMismatch: (
    options: GwOption[],
    model: string,
    provider: string,
  ) => boolean;
};
// gatewayOptions：alias-a/alias-c → provX，alias-b → provY；
// builtin 无 binding（不属于任何 Provider）。
const gw: GwOption[] = [
  {
    alias: "alias-a",
    kind: "configured",
    binding: { providerName: "provX" },
  },
  {
    alias: "alias-b",
    kind: "configured",
    binding: { providerName: "provY" },
  },
  {
    alias: "alias-c",
    kind: "configured",
    binding: { providerName: "provX" },
  },
  { alias: "gpt-5.4", kind: "builtin" },
  { alias: "qwen3.6-plus", kind: "builtin" },
];
let modPromise: Promise<ModelUnionMod> | null = null;
const loadModelUnion = (): Promise<ModelUnionMod> =>
  (modPromise ??= import("../src/modelUnion") as Promise<ModelUnionMod>);

ok("纯函数：providerForModel configured→归属 / builtin→空 / 未知→空", async () => {
  const mod = await loadModelUnion();
  assert.equal(mod.providerForModel(gw, "alias-a"), "provX");
  assert.equal(mod.providerForModel(gw, "  alias-c  "), "provX");
  assert.equal(mod.providerForModel(gw, "gpt-5.4"), "");
  assert.equal(mod.providerForModel(gw, "qwen3.6-plus"), "");
  assert.equal(mod.providerForModel(gw, "no-such-model"), "");
}, true);
ok("纯函数：providerModelMismatch 失配/一致/空值矩阵", async () => {
  const mod = await loadModelUnion();
  assert.equal(mod.providerModelMismatch(gw, "alias-a", "provY"), true);
  assert.equal(mod.providerModelMismatch(gw, "alias-a", "provX"), false);
  assert.equal(mod.providerModelMismatch(gw, "qwen3.6:27b-fp8", "provX"), false);
  assert.equal(mod.providerModelMismatch(gw, "gpt-5.4", "provX"), false);
  assert.equal(mod.providerModelMismatch(gw, "alias-a", ""), false);
  assert.equal(mod.providerModelMismatch(gw, "", "provX"), false);
  assert.equal(mod.providerModelMismatch(gw, "  ", "provX"), false);
}, true);

// ── 执行：gate 下按 runner 契约自注册；直跑下自计数自打印 ───────────
const underGate = /vitest-shim-runner/.test(process.argv[1] ?? "");
const vtState = (globalThis as Record<string, unknown>).__qcVt ??= {
  tests: [],
  beforeAll: [],
  afterAll: [],
  beforeEach: [],
  afterEach: [],
  prefix: [],
};
if (underGate) {
  for (const c of cases)
    (vtState as { tests: Case[] }).tests.push({ name: c.name, fn: c.fn });
} else {
  let n = 0;
  let failed = 0;
  let skipped = 0;
  const run = async (): Promise<void> => {
    let pureAvailable = true;
    if (cases.some((c) => c.pure)) {
      try {
        await loadModelUnion();
      } catch {
        pureAvailable = false; // node ESM 解析不了 modelUnion 无扩展名 import
      }
    }
    for (const c of cases) {
      if (c.pure && !pureAvailable) {
        skipped += 1;
        console.log(
          `  SKIP ${c.name}（纯函数部分需 gate 通道：node ESM 无法解析 modelUnion 无扩展名相对 import）`,
        );
        continue;
      }
      try {
        await c.fn();
        n += 1;
        console.log(`  PASS ${n} ${c.name}`);
      } catch (e) {
        failed += 1;
        console.error(`  FAIL ${c.name}`);
        console.error(
          String((e as Error)?.stack ?? e).split("\n").slice(0, 6).join("\n"),
        );
      }
    }
    console.log(`\n${n} passed, ${skipped} skipped, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  };
  void run();
}
