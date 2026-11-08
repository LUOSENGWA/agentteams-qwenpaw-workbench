// S：条件复验统一到 requestCache（删重复 store）+ skills 接入 #1480——
// workerListMerge 纯函数单测 + 接线源码文本断言（crd.ts 有浏览器 bundle
// import 链不可直 import，同 P1 先例：源码文本断言）。
// 直跑：node --experimental-strip-types frontend/tests/s-conditional-unify.test.ts
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import {
  mergeWorkerRows,
  missingSpecNames,
  shouldFallbackCombined,
} from "../src/lib/workerListMerge.ts";

let n = 0;
function ok(name: string, fn: () => void): void {
  fn();
  n += 1;
  console.log(`  PASS ${n} ${name}`);
}

const crdSrc = readFileSync(
  new URL("../src/api/domains/crd.ts", import.meta.url),
  "utf8",
);
const workerSrc = readFileSync(
  new URL("../src/api/domains/worker.ts", import.meta.url),
  "utf8",
);
const sharedSrc = readFileSync(
  new URL("../src/api/shared.ts", import.meta.url),
  "utf8",
);

// 行类型（泛型 T extends { name: string }；显式 Row 规避两参数组字面量
// 推断出不同 T 的问题）。
type Row = { name: string; [k: string]: unknown };

// ── mergeWorkerRows（#179 合并语义：status 覆盖 + membership + 顺序）────
ok("mergeWorkerRows 基本：status 覆盖同名字段，spec 独有字段保留", () => {
  const out = mergeWorkerRows<Row>(
    [{ name: "w1", image: "img", team: "t1" }],
    [{ name: "w1", phase: "Running" }],
  );
  assert.deepEqual(out, [
    { name: "w1", image: "img", team: "t1", phase: "Running" },
  ]);
});

ok("mergeWorkerRows membership：spec 有而 status 无的 Worker 必须消失", () => {
  const out = mergeWorkerRows<Row>(
    [{ name: "w1" }, { name: "w2" }],
    [{ name: "w1" }],
  );
  assert.deepEqual(out, [{ name: "w1" }]);
});

ok("mergeWorkerRows 顺序 = status 顺序（不看列表位置）", () => {
  const out = mergeWorkerRows<Row>(
    [{ name: "a" }, { name: "b" }],
    [{ name: "b" }, { name: "a" }],
  );
  assert.deepEqual(
    out.map((r) => r.name),
    ["b", "a"],
  );
});

ok("mergeWorkerRows 新增保留：status 有而 spec 无的 Worker 保留（上层据此重读）", () => {
  const out = mergeWorkerRows<Row>(
    [{ name: "a" }],
    [{ name: "a" }, { name: "new" }],
  );
  assert.deepEqual(
    out.map((r) => r.name),
    ["a", "new"],
  );
});

ok("mergeWorkerRows 空输入：[] + [] → []", () => {
  assert.deepEqual(mergeWorkerRows<Row>([], []), []);
});

// ── missingSpecNames（spec 快照缺名：status 顺序、去重）────────────────
ok("missingSpecNames：status 有 spec 无 → status 顺序、去重", () => {
  assert.deepEqual(
    missingSpecNames<Row>(
      [{ name: "a" }],
      [{ name: "b" }, { name: "a" }, { name: "c" }, { name: "b" }],
    ),
    ["b", "c"],
  );
});

ok("missingSpecNames 全覆盖 → 空", () => {
  assert.deepEqual(
    missingSpecNames<Row>(
      [{ name: "a" }, { name: "b" }],
      [{ name: "b" }, { name: "a" }],
    ),
    [],
  );
});

// ── shouldFallbackCombined（spec 重读后仍缺 → 合并视图）────────────────
ok("shouldFallbackCombined：缺名 → true；全覆盖 → false", () => {
  assert.equal(
    shouldFallbackCombined<Row>(
      [{ name: "a" }],
      [{ name: "a" }, { name: "z" }],
    ),
    true,
  );
  assert.equal(
    shouldFallbackCombined<Row>(
      [{ name: "a" }, { name: "z" }],
      [{ name: "a" }],
    ),
    false,
  );
});

// ── crd.ts：requestCache 条件复验接线（源码断言）──────────────────────
ok("crd.ts：spec 腿条件复验六要素（requestJsonConditional/conditionalValue/fields=spec/fields=status/fields=spec,status/tags [\"admin\"]）", () => {
  assert.match(crdSrc, /requestJsonConditional/);
  assert.match(crdSrc, /conditionalValue/);
  // fields=spec 字面量（后随引号，排除 fields=spec,status 借位误判）
  assert.match(crdSrc, /fields=spec"/);
  assert.match(crdSrc, /fields=status/);
  assert.match(crdSrc, /fields=spec,status/);
  assert.match(crdSrc, /tags: \["admin"\]/);
});

ok("crd.ts：不再引用 conditionalCache", () => {
  assert.ok(!crdSrc.includes("conditionalCache"));
});

ok("crd.ts：三段回退链（缺名 force 重读一次 → 合并视图 → 400 完整列表）", () => {
  assert.match(crdSrc, /force: true/);
  assert.match(crdSrc, /missingSpecNames/);
  assert.match(crdSrc, /shouldFallbackCombined/);
  assert.match(crdSrc, /httpErrorStatus\(e\) === 400/);
  assert.match(crdSrc, /fetchControllerJson<unknown>\("\/workers"/);
});

// ── worker.ts：fetchSkillCatalog 条件复验（源码断言）──────────────────
ok("worker.ts：fetchSkillCatalog 接条件复验（requestJsonConditional/conditionalValue//skills/tags [\"skills\"]）", () => {
  const i = workerSrc.indexOf("function fetchSkillCatalog");
  assert.ok(i !== -1, "fetchSkillCatalog 未找到");
  const j = workerSrc.indexOf("\nexport ", i + 10);
  const body = workerSrc.slice(i, j === -1 ? undefined : j);
  assert.match(body, /requestJsonConditional/);
  assert.match(body, /conditionalValue/);
  assert.match(body, /\/skills\$\{q\}/);
  assert.match(body, /tags: \["skills"\]/);
});

// ── shared.ts：R1 写清钩子已还原（源码断言）───────────────────────────
ok("shared.ts：不含 conditionalCache", () => {
  assert.ok(!sharedSrc.includes("conditionalCache"));
});

ok("shared.ts：requestJsonFull 恢复原样（无写清包装/委托壳）", () => {
  assert.ok(!sharedSrc.includes("doRequestJsonFull"));
  assert.ok(!sharedSrc.includes("clearConditionalResponses"));
  assert.ok(!sharedSrc.includes("isWrite"));
  assert.match(sharedSrc, /export async function requestJsonFull\(/);
});

// ── 全仓零引用（readFileSync + 目录列表递归，不用 find）────────────────
ok("frontend/src 全仓零 conditionalCache 引用（.ts/.tsx 逐文件）", () => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${ent.name}`;
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith(".ts") || ent.name.endsWith(".tsx"))
        files.push(p);
    }
  };
  walk(new URL("../src/", import.meta.url).pathname);
  assert.ok(files.length >= 20, `src 文件数异常：${files.length}（walk 失败？）`);
  const hit = files.filter((f) =>
    readFileSync(f, "utf8").includes("conditionalCache"),
  );
  assert.deepEqual(hit, [], `conditionalCache 残留：${hit.join(", ")}`);
});

console.log(`\n${n} tests passed`);
