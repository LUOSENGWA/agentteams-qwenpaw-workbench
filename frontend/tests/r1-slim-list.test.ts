// R1：Worker 列表 slim parallel polling（dashboard #179 回灌）——纯合并函数
// （mergeWorkerRows / missingSpecNames / shouldFallbackCombined）+ conditionalCache
// ETag/304 条件读缓存（setConditionalFetch 注入假 fetch，零真网络）单测
// + crd.ts / shared.ts 接线源码文本断言（crd.ts 有浏览器 bundle import 链，
// node 不可直 import——P1 测试同款原因）。
// 直跑：node --experimental-strip-types frontend/tests/r1-slim-list.test.ts
//（node:assert/strict；lib 值依赖带 .ts 扩展名直 import；两 lib 模块零 import，
// node 可直测）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  NOT_MODIFIED,
  clearConditionalResponses,
  conditionalJson,
  getCacheSize,
  getReadScope,
  setConditionalFetch,
  setReadScopeReader,
  subscribeConditionalClear,
  type ConditionalFetch,
} from "../src/lib/conditionalCache.ts";
import {
  mergeWorkerRows,
  missingSpecNames,
  shouldFallbackCombined,
} from "../src/lib/workerListMerge.ts";

let n = 0;
async function ok(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  n += 1;
  console.log(`  PASS ${n} ${name}`);
}

// ── mergeWorkerRows（按稳定 name 合并，status 权威）────────────────────

await ok("mergeWorkerRows 基本合并：spec 字段保留 + status 覆盖同名字段", () => {
  const out = mergeWorkerRows(
    [{ name: "a", image: "x:v1", phase: "Pending" }],
    [{ name: "a", phase: "Running", podIP: "10.0.0.1" }],
  );
  assert.deepEqual(out, [
    { name: "a", image: "x:v1", phase: "Running", podIP: "10.0.0.1" },
  ]);
});

await ok("mergeWorkerRows membership=status：spec 有而 status 无 → 消失；status 新增保留", () => {
  const out = mergeWorkerRows(
    [{ name: "a", image: "x" }, { name: "gone", image: "g" }],
    [{ name: "a", phase: "Running" }, { name: "new", phase: "Pending" }],
  );
  assert.deepEqual(out.map((r) => r.name), ["a", "new"]);
});

await ok("mergeWorkerRows 顺序取 status", () => {
  const out = mergeWorkerRows(
    [{ name: "a", v: 1 }, { name: "b", v: 2 }],
    [{ name: "b" }, { name: "a" }],
  );
  assert.deepEqual(out.map((r) => r.name), ["b", "a"]);
});

await ok("mergeWorkerRows 空输入：spec 空 / status 空 / 双空", () => {
  assert.deepEqual(mergeWorkerRows([], []), []);
  assert.deepEqual(mergeWorkerRows([{ name: "a" }], []), []);
  assert.deepEqual(
    mergeWorkerRows([], [{ name: "a", phase: "Running" }]),
    [{ name: "a", phase: "Running" }],
  );
});

// ── missingSpecNames / shouldFallbackCombined（spec 重读门）────────────

await ok("missingSpecNames：status 顺序 + 去重（spec 独有不算缺失）", () => {
  assert.deepEqual(
    missingSpecNames([{ name: "a" }], [
      { name: "b" },
      { name: "c" },
      { name: "b" },
    ]),
    ["b", "c"],
  );
  assert.deepEqual(missingSpecNames([{ name: "a" }], [{ name: "a" }]), []);
  assert.deepEqual(missingSpecNames([], []), []);
});

await ok("shouldFallbackCombined：有缺失 → true；无缺失 → false", () => {
  assert.equal(shouldFallbackCombined([{ name: "a" }], [{ name: "b" }]), true);
  assert.equal(shouldFallbackCombined([{ name: "a" }], [{ name: "a" }]), false);
});

// ── conditionalCache（注入假 fetch，零真网络）──────────────────────────

type Call = { url: string; init: RequestInit | undefined };

function makeFakeFetch(
  respond: (
    url: string,
    init: RequestInit | undefined,
    callIndex: number,
  ) => Response,
): { fn: ConditionalFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn: ConditionalFetch = async (url, init) => {
    const i = calls.length;
    calls.push({ url, init });
    return respond(url, init, i);
  };
  return { fn, calls };
}

function okJson(body: unknown, etag?: string): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (etag) headers.etag = etag;
  return new Response(JSON.stringify(body), { status: 200, headers });
}

const notModified = (): Response => new Response(null, { status: 304 });

/** 重置模块级状态：reader → node 默认 scope（"node"）+ 清缓存 + 重接假 fetch。 */
function withFetch(fake: { fn: ConditionalFetch }): void {
  setReadScopeReader(null);
  clearConditionalResponses();
  setConditionalFetch(fake.fn);
}

await ok("200+ETag → 存条目（getCacheSize 0→1）+ JSON 解析", async () => {
  const fake = makeFakeFetch(() => okJson([{ name: "a" }], "E1"));
  withFetch(fake);
  assert.equal(getCacheSize(), 0);
  const res = await conditionalJson<{ name: string }[]>("/w/t7");
  assert.deepEqual(res.payload, [{ name: "a" }]);
  assert.equal(getCacheSize(), 1);
});

await ok("第二次请求带 If-None-Match（首次不带）", async () => {
  const fake = makeFakeFetch(() => okJson([{ name: "a" }], "E1"));
  withFetch(fake);
  await conditionalJson("/w/t8");
  await conditionalJson("/w/t8");
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0].init, undefined);
  const h = (fake.calls[1].init?.headers ?? {}) as Record<string, string>;
  assert.equal(h["If-None-Match"], "E1");
});

await ok("304 且有缓存 → NOT_MODIFIED 哨兵（调用方复用自存旧 200 值）", async () => {
  const fake = makeFakeFetch((_u, _i, i) =>
    i === 0 ? okJson([{ name: "a", phase: "Pending" }], "E1") : notModified(),
  );
  withFetch(fake);
  const first = await conditionalJson<unknown>("/w/t9");
  assert.notEqual(first.payload, NOT_MODIFIED);
  const res = await conditionalJson<unknown>("/w/t9");
  assert.equal(res.payload, NOT_MODIFIED);
  // 调用方复用语义：模块 304 时不返回旧值——调用方手里旧 200 payload 不变
  assert.deepEqual(first.payload, [{ name: "a", phase: "Pending" }]);
  const h = (fake.calls[1].init?.headers ?? {}) as Record<string, string>;
  assert.equal(h["If-None-Match"], "E1");
  assert.equal(getCacheSize(), 1);
});

await ok("304 但在飞期间缓存被清 → 去掉 If-None-Match 自动重发（绝不返回空）", async () => {
  const fake = makeFakeFetch((_u, _i, i) => {
    if (i === 0) return okJson([{ name: "a", v: 1 }], "E1"); // 预热条目
    if (i === 1) {
      clearConditionalResponses(); // 模拟在飞期间写请求清缓存（revision +1）
      return notModified();
    }
    return okJson([{ name: "a", v: 2 }], "E2"); // 重发强制 200
  });
  withFetch(fake);
  const first = await conditionalJson<unknown>("/w/t10");
  assert.notEqual(first.payload, NOT_MODIFIED);
  const res = await conditionalJson<unknown>("/w/t10");
  assert.equal(fake.calls.length, 3);
  const h1 = (fake.calls[1].init?.headers ?? {}) as Record<string, string>;
  assert.equal(h1["If-None-Match"], "E1"); // 在飞请求带 etag
  assert.equal(fake.calls[2].init, undefined); // 重发不带 If-None-Match
  assert.deepEqual(res.payload, [{ name: "a", v: 2 }]);
  assert.equal(getCacheSize(), 1);
});

await ok("无 ETag 的 200 → 不存（已有条目也删掉）", async () => {
  const fake = makeFakeFetch((_u, _i, i) =>
    i === 0 ? okJson([{ name: "a" }], "E1") : okJson([{ name: "a", v: 2 }]),
  );
  withFetch(fake);
  await conditionalJson("/w/t11");
  assert.equal(getCacheSize(), 1);
  const res = await conditionalJson("/w/t11");
  assert.deepEqual(res.payload, [{ name: "a", v: 2 }]);
  assert.equal(getCacheSize(), 0);
});

await ok("上限 64：写 65 个不同 URL → getCacheSize()===64（最旧逐出）", async () => {
  const fake = makeFakeFetch((u) => okJson([{ name: u }], `E:${u}`));
  withFetch(fake);
  for (let i = 0; i < 65; i++) await conditionalJson(`/w/cap-${i}`);
  assert.equal(getCacheSize(), 64);
  // cap-0 已被逐出：再请求它不带 If-None-Match（无条目），写回后仍 64
  const before = fake.calls.length;
  await conditionalJson("/w/cap-0");
  assert.equal(fake.calls[before].init, undefined);
  assert.equal(getCacheSize(), 64);
});

await ok("scope 变化（setReadScopeReader 换值）→ 缓存清空、再请求不带 If-None-Match", async () => {
  const fake = makeFakeFetch((_u, _i, i) =>
    okJson([{ name: "a", v: i }], `S${i}`),
  );
  withFetch(fake);
  setReadScopeReader(() => "A");
  clearConditionalResponses(); // 建立 scope 基准 "A"
  const r1 = await conditionalJson<unknown>("/w/scope");
  assert.notEqual(r1.payload, NOT_MODIFIED);
  assert.equal(getCacheSize(), 1);
  setReadScopeReader(() => "B"); // 身份/凭据切换
  const r2 = await conditionalJson<unknown>("/w/scope");
  assert.equal(getReadScope(), "B");
  assert.notEqual(r2.payload, NOT_MODIFIED);
  // scope 变化清了缓存 → 再请求无条目可带（若未清会带 If-None-Match "S0"）
  assert.equal(fake.calls[1].init, undefined);
  assert.equal(getCacheSize(), 1);
});

await ok("reload:true（status 契约）→ 有缓存条目也不发 If-None-Match", async () => {
  const fake = makeFakeFetch((_u, _i, i) => okJson([{ name: "a", v: i }], "R1"));
  withFetch(fake);
  await conditionalJson("/w/status");
  assert.equal(getCacheSize(), 1);
  const res = await conditionalJson<unknown>("/w/status", { reload: true });
  assert.notEqual(res.payload, NOT_MODIFIED);
  const last = fake.calls[fake.calls.length - 1];
  assert.equal(last.init, undefined);
});

await ok("subscribeConditionalClear：清时通知、退订后不再通知", () => {
  let hits = 0;
  const unsub = subscribeConditionalClear(() => {
    hits += 1;
  });
  clearConditionalResponses();
  assert.equal(hits, 1);
  unsub();
  clearConditionalResponses();
  assert.equal(hits, 1);
});

await ok("非 2xx（400）→ 抛 'HTTP 400: detail'（httpErrorStatus 可判），不存条目", async () => {
  const fake = makeFakeFetch(() =>
    new Response(JSON.stringify({ detail: "fields not supported" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
  );
  withFetch(fake);
  await assert.rejects(
    conditionalJson("/w/t16"),
    /HTTP 400: fields not supported/,
  );
  assert.equal(getCacheSize(), 0);
});

await ok("传输未接线（setConditionalFetch(null)）→ 明确报错", async () => {
  setConditionalFetch(null);
  await assert.rejects(
    conditionalJson("/w/unwired"),
    /条件读传输未接线/,
  );
});

// ── crd.ts / shared.ts 接线（源码文本断言——node 不可直 import）────────

const crdSrc = readFileSync(
  new URL("../src/api/domains/crd.ts", import.meta.url),
  "utf8",
);
const sharedSrc = readFileSync(
  new URL("../src/api/shared.ts", import.meta.url),
  "utf8",
);

await ok("crd.ts：spec（条件复验）+ status（reload:true）Promise.all 并行", () => {
  assert.match(
    crdSrc,
    /Promise\.all\(\[\s*conditionalJson<unknown>\(specPath, \{ timeoutMs \}\),\s*conditionalJson<unknown>\(statusPath, \{ reload: true, timeoutMs \}\),/,
  );
});

await ok("crd.ts：spec/status 分拆 fields（spec 条件缓存、status 恒 200）", () => {
  assert.match(
    crdSrc,
    /const specPath = `\$\{CONTROLLER_API\}\/workers\?fields=spec\$\{strongQ\}`/,
  );
  assert.match(
    crdSrc,
    /const statusPath = `\$\{CONTROLLER_API\}\/workers\?fields=status\$\{strongQ\}`/,
  );
});

await ok("crd.ts：400（拒绝 fields）→ 回退不带 fields 的完整列表", () => {
  assert.match(crdSrc, /if \(httpErrorStatus\(e\) === 400\)/);
  assert.match(crdSrc, /fetchControllerJson<unknown>\(\s*"\/workers",/);
});

await ok("crd.ts：fetchAdminData + fetchL2AdminData 均接入 listWorkerSummaries", () => {
  assert.match(
    crdSrc,
    /listWorkerSummaries\(strong \? \{ strong: true \} : undefined\)/,
  );
  assert.match(crdSrc, /listWorkerSummaries\(\),/);
});

await ok("shared.ts：任何写请求前后各清一次条件缓存（requestJsonFull 包装）", () => {
  assert.equal(
    (sharedSrc.match(/clearConditionalResponses\(\)/g) || []).length,
    2,
  );
});

console.log(`\n${n} tests passed`);
