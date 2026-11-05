// P1：Worker 列表瘦身（#1477 消费侧）——fields 投影常量 + 写前读 detail
// 门纯逻辑（mergeSkillList / mergeMcpList / canWrite）单测。
// 直跑：node --experimental-strip-types frontend/tests/p1-worker-fields.test.ts
//（node:assert/strict；lib 值依赖带 .ts 扩展名直 import；crd.ts 有运行时
// 依赖链且 import 无扩展名（浏览器 bundle 形态），node 不可直 import →
// WORKER_LIST_FIELDS 及两处列表请求经源码文本断言）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canWrite,
  mergeMcpList,
  mergeSkillList,
} from "../src/lib/workerDetailGate.ts";

let n = 0;
function ok(name: string, fn: () => void): void {
  fn();
  n += 1;
  console.log(`  PASS ${n} ${name}`);
}

// ── WORKER_LIST_FIELDS（crd.ts 源码断言）────────────────────────────
const crdSrc = readFileSync(
  new URL("../src/api/domains/crd.ts", import.meta.url),
  "utf8",
);

ok('WORKER_LIST_FIELDS === "spec,status"（导出常量）', () => {
  assert.match(
    crdSrc,
    /export const WORKER_LIST_FIELDS = "spec,status";/,
  );
});

ok("列表两处请求均带 fields=WORKER_LIST_FIELDS（fetchAdminData + fetchL2AdminData）", () => {
  const uses = crdSrc.match(/`\/workers\?fields=\$\{WORKER_LIST_FIELDS\}`/g) || [];
  assert.equal(uses.length, 2);
});

ok("fetchWorkerDetail：GET /workers/{name} + 15s TTL + tags [\"admin\"]", () => {
  assert.match(crdSrc, /export async function fetchWorkerDetail\(/);
  assert.match(crdSrc, /`worker-detail:\$\{name\}`/);
  assert.match(crdSrc, /\/workers\/\$\{encodeURIComponent\(name\)\}/);
  assert.match(crdSrc, /15000/);
  assert.match(crdSrc, /tags: \["admin"\]/);
});

// ── mergeSkillList（保留值契约：并集去重、existing 序在前）──────────
ok("mergeSkillList 基本：existing a,b + edited b,c → [a,b,c]", () => {
  assert.deepEqual(mergeSkillList(["a", "b"], ["b", "c"]), ["a", "b", "c"]);
});

ok("mergeSkillList 空 existing：纯 edited 原样（去重）", () => {
  assert.deepEqual(mergeSkillList([], ["c", "b", "b"]), ["c", "b"]);
});

ok("mergeSkillList 空 edited：existing 原样", () => {
  assert.deepEqual(mergeSkillList(["a", "b"], []), ["a", "b"]);
});

ok("mergeSkillList 保序：existing 序优先，edited 新增追加", () => {
  assert.deepEqual(mergeSkillList(["z", "a"], ["a", "m"]), ["z", "a", "m"]);
});

ok("mergeSkillList 投影场景：空基线（列表行投影后空）+ 用户新增 → 已有补齐不丢", () => {
  assert.deepEqual(mergeSkillList(["s1", "s2"], ["s3"]), ["s1", "s2", "s3"]);
});

// ── mergeMcpList（按 name 去重合并）─────────────────────────────────
ok("mergeMcpList 同名去重：edited 覆盖（用户改过的 url 生效）", () => {
  const out = mergeMcpList(
    [{ name: "x", url: "http://old" }],
    [{ name: "x", url: "http://new" }],
  );
  assert.deepEqual(out, [{ name: "x", url: "http://new" }]);
});

ok("mergeMcpList 保留 existing + 追加新增（序：existing 在前）", () => {
  const out = mergeMcpList(
    [{ name: "a", url: "u1" }, { name: "b", url: "u2" }],
    [{ name: "b", url: "u2x" }, { name: "c", url: "u3" }],
  );
  assert.deepEqual(out, [
    { name: "a", url: "u1" },
    { name: "b", url: "u2x" },
    { name: "c", url: "u3" },
  ]);
});

ok("mergeMcpList 空输入：[] + [] → []；[] + 新增 → 新增", () => {
  assert.deepEqual(mergeMcpList([], []), []);
  assert.deepEqual(mergeMcpList([], [{ name: "x" }]), [{ name: "x" }]);
});

// ── canWrite（写门四态）────────────────────────────────────────────
ok("canWrite ready → true", () => {
  assert.equal(canWrite("ready"), true);
});

ok("canWrite idle/loading/error → false", () => {
  assert.equal(canWrite("idle"), false);
  assert.equal(canWrite("loading"), false);
  assert.equal(canWrite("error"), false);
});

console.log(`\n${n} tests passed`);
