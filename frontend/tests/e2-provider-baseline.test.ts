// E2：列表投影丢 modelProvider（#1477，16.61 起 worker 列表走
// fields=spec + fields=status 两道投影，均不含 modelProvider）→
// 模型弹窗写盘基线修复：providerBaseline 纯函数单测（三档优先级
// trusted 判定 + providerForWrite 下发判定）+ WorkerDetailPane 写前
// 读 detail 接线断言 + envEditable 渲染门回归防护（16.61 投影同丢
// envEditable → 环境变量面板消失，门控改「仅明确 false 隐藏」）。
// 直跑：node --experimental-strip-types frontend/tests/e2-provider-baseline.test.ts
//（node:assert/strict；providerBaseline 值依赖带 .ts 扩展名直 import；
// 组件/域源码 readFileSync 文本断言——crdmanage 组件依赖 window.QwenPaw
// host，node 不可直 import）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  providerForWrite,
  resolveProviderBaseline,
} from "../src/lib/providerBaseline.ts";

const paneSrc = readFileSync(
  new URL("../src/manage/WorkerDetailPane.tsx", import.meta.url),
  "utf8",
);
const crdSrc = readFileSync(
  new URL("../src/api/domains/crd.ts", import.meta.url),
  "utf8",
);
const chatSrc = readFileSync(
  new URL("../src/i18n/domains/chat.ts", import.meta.url),
  "utf8",
);
const envPanelSrc = readFileSync(
  new URL("../src/components/WorkerEnvPanel.tsx", import.meta.url),
  "utf8",
);
const treeSrc = readFileSync(
  new URL("../src/components/WorkerManageTree.tsx", import.meta.url),
  "utf8",
);

let n = 0;
function ok(name: string, fn: () => void): void {
  fn();
  n += 1;
  console.log(`  PASS ${n} ${name}`);
}

// ── resolveProviderBaseline：detail > list（trusted）> alias（untrusted）──
ok("优先级①：detail 值压过 list 与 alias，trusted=true", () => {
  assert.deepEqual(
    resolveProviderBaseline("deepseek", "qwen3.6-local", "gpt-x"),
    { value: "deepseek", trusted: true },
  );
});

ok("优先级②：detail 空/缺 → list 值，trusted=true（列表事实档）", () => {
  assert.deepEqual(
    resolveProviderBaseline(undefined, "qwen3.6-local", "gpt-x"),
    { value: "qwen3.6-local", trusted: true },
  );
  assert.deepEqual(
    resolveProviderBaseline("", "qwen3.6-local", "gpt-x"),
    { value: "qwen3.6-local", trusted: true },
  );
});

ok("优先级③：detail/list 皆空 → alias 回填，trusted=false（推导非事实）", () => {
  assert.deepEqual(resolveProviderBaseline("", undefined, "gpt-x"), {
    value: "gpt-x",
    trusted: false,
  });
});

ok("三档皆空 → value=\"\" trusted=false（基线不可信）", () => {
  assert.deepEqual(
    resolveProviderBaseline(undefined, "", undefined),
    { value: "", trusted: false },
  );
});

ok("空白 trim：detail 带空白仍可信且去空白", () => {
  assert.deepEqual(resolveProviderBaseline("  deepseek ", "qwen", "gpt-x"), {
    value: "deepseek",
    trusted: true,
  });
});

// ── providerForWrite：不可信 + 未改 → 不下发；可信 → 现值/用户值 ──────
ok("不可信基线 + 用户未改（undefined）→ undefined（不下发 modelProvider）", () => {
  assert.equal(providerForWrite({ value: "gpt-x", trusted: false }, undefined), undefined);
});

ok("不可信基线 + 用户未改（空串/纯空白）→ undefined", () => {
  assert.equal(providerForWrite({ value: "gpt-x", trusted: false }, ""), undefined);
  assert.equal(providerForWrite({ value: "", trusted: false }, "   "), undefined);
});

ok("可信基线 + 用户未改 → 下发现值（与旧行为一致）", () => {
  assert.equal(providerForWrite({ value: "deepseek", trusted: true }, undefined), "deepseek");
  assert.equal(providerForWrite({ value: "deepseek", trusted: true }, ""), "deepseek");
});

ok("用户显式改 provider（可信基线）→ 下发用户值", () => {
  assert.equal(
    providerForWrite({ value: "deepseek", trusted: true }, "qwen3.6-local"),
    "qwen3.6-local",
  );
});

ok("用户显式改 provider（不可信基线）→ 显式选择即意图，下发用户值", () => {
  assert.equal(
    providerForWrite({ value: "gpt-x", trusted: false }, "qwen3.6-local"),
    "qwen3.6-local",
  );
});

ok("可信基线 + 用户清空 → 空 provider 永不下发（crd.ts 守卫同款），回现值", () => {
  assert.equal(providerForWrite({ value: "deepseek", trusted: true }, "  "), "deepseek");
});

ok("不可信基线 + 用户清空 → undefined（保持控制器现值）", () => {
  assert.equal(providerForWrite({ value: "gpt-x", trusted: false }, ""), undefined);
});

// ── WorkerDetailPane 接线：写前读 detail + 走 providerForWrite ─────────
ok("pane：打开弹窗前读 detail（fetchWorkerDetail(worker.name) 已接线）", () => {
  assert.match(paneSrc, /fetchWorkerDetail\(worker\.name\)/);
});

ok("pane：handleModelSave 走 providerForWrite 且不再裸传 p", () => {
  const start = paneSrc.indexOf("const handleModelSave");
  const end = paneSrc.indexOf("const handleLifecycle");
  assert.ok(start > 0 && end > start, "handleModelSave 区块定位");
  const body = paneSrc.slice(start, end);
  assert.match(body, /providerForWrite\(provBaseline/);
  assert.match(body, /updateWorkerModel\(worker\.name, m, pSend, subIn\)/);
  assert.doesNotMatch(body, /updateWorkerModel\(worker\.name, m, p, subIn\)/);
});

ok("pane：弹窗 loading——入口禁用 + provider 字段显「正在读取…」占位", () => {
  assert.match(paneSrc, /l1 && !provDetail\.loading \? openModelModal/);
  assert.match(paneSrc, /provDetail\.loading \? tr\("正在读取 Worker 配置…"\)/);
  // 占位文案守卫：加载中（含竞态窗口）禁止把占位当 provider 下发。
  const start = paneSrc.indexOf("const handleModelSave");
  const end = paneSrc.indexOf("const handleLifecycle");
  assert.match(paneSrc.slice(start, end), /pIn\.trim\(\) === loadingText/);
});

ok("pane：基线优先级接线（detail > list > alias 三档进 resolveProviderBaseline）", () => {
  assert.match(
    paneSrc,
    /resolveProviderBaseline\(\s*provDetail\.modelProvider,\s*worker\.modelProvider,/s,
  );
});

// ── crd.ts：merge 语义守卫不回归（空 provider 永不下发）────────────────
ok("crd.ts：updateWorkerModel 空 provider 守卫仍在（merge 语义不变）", () => {
  assert.match(
    crdSrc,
    /if \(modelProvider !== undefined && modelProvider !== ""\) body\.modelProvider = modelProvider;/,
  );
});

// ── i18n：两键齐（「正在读取…」复用既有键；「未读取到…」新键）─────────
ok("i18n：「正在读取 Worker 配置…」存在（复用）+「未读取到 Provider（保存时保持不变）」新键", () => {
  assert.ok(chatSrc.includes('"正在读取 Worker 配置…":'));
  assert.ok(chatSrc.includes('"未读取到 Provider（保存时保持不变）":'));
});

// ── 追加：envEditable 渲染门回归防护（16.61 投影丢字段 → 面板消失）──────
ok("env 门控：两文件不再用 === true / !== true 做渲染门", () => {
  for (const [name, src] of [
    ["WorkerEnvPanel", envPanelSrc],
    ["WorkerManageTree", treeSrc],
  ] as const) {
    assert.doesNotMatch(src, /envEditable\s*===\s*true/, `${name} 无 === true`);
    assert.doesNotMatch(src, /envEditable\s*!==\s*true/, `${name} 无 !== true`);
  }
});

ok("env 门控：改为仅明确 false 隐藏（面板内门 === false；树三处 !== false）", () => {
  assert.match(envPanelSrc, /if \(worker\.envEditable === false\) return null;/);
  const uses = treeSrc.match(/envEditable !== false/g) || [];
  assert.ok(uses.length >= 2, `WorkerManageTree 门控处数=${uses.length}（期望 ≥2）`);
});

console.log(`\n${n} tests passed`);
