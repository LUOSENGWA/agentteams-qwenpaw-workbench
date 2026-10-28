// R4（16.23）：cachedFetch（TTL + 在飞去重 + SWR）语义冒烟（node 直跑，
// 跑法照 scripts/requestCache.smoke.mjs——esbuild buildSync 到临时目录
// + import）。cachedFetch 与 cachedRequest 复用同一 store/inflight 表。
// 用法：node scripts/cachedFetch.smoke.mjs
import { buildSync } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert";

const tmp = mkdtempSync(path.join(tmpdir(), "cf-smoke-"));
buildSync({
  entryPoints: ["src/requestCache.ts"],
  bundle: true,
  format: "esm",
  outfile: path.join(tmp, "requestCache.mjs"),
  platform: "node",
});
const {
  cachedFetch,
  invalidateTags,
  __clearCacheForTest,
} = await import(path.join(tmp, "requestCache.mjs"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. fresh 命中：TTL 内两次调用 → fetcher 只跑 1 次（零网络）。
{
  __clearCacheForTest();
  let n = 0;
  const f = async () => {
    n++;
    return "v" + n;
  };
  const a = await cachedFetch("k", 10000, f, { swrMs: 5000 });
  const b = await cachedFetch("k", 10000, f, { swrMs: 5000 });
  assert.strictEqual(n, 1, "F1 fresh：fetcher 只跑 1 次");
  assert.strictEqual(a, "v1");
  assert.strictEqual(b, "v1");
  console.log("F1 fresh 命中 ✓");
}

// 2. stale 在 SWR 窗内：立即回旧值（零等待）+ 后台再验证（恰好 1 次回源，
// 成功后缓存换新值）。
{
  __clearCacheForTest();
  let n = 0;
  const f = async () => {
    n++;
    await sleep(15);
    return "v" + n;
  };
  await cachedFetch("k", 30, f, { swrMs: 60 }); // miss → v1（expiry=30ms）
  assert.strictEqual(n, 1);
  await sleep(40); // 已过期（>30），仍在 SWR 窗内（<90）
  const t0 = Date.now();
  const b = await cachedFetch("k", 10000, f, { swrMs: 60 });
  assert.ok(Date.now() - t0 < 10, "F2 stale：立即回旧值（零等待）");
  assert.strictEqual(b, "v1", "F2 stale：返回旧值");
  await sleep(60); // 等后台再验证 settle
  assert.strictEqual(n, 2, "F2 stale：后台再验证恰好 1 次");
  const c = await cachedFetch("k", 10000, f, { swrMs: 0 });
  assert.strictEqual(c, "v2", "F2 stale：再验证后缓存为新值（fresh 命中）");
  assert.strictEqual(n, 2, "F2 stale：新值命中不再回源");
  console.log("F2 stale + SWR 再验证 ✓");
}

// 3. 超出 SWR 窗：条目丢弃，等回源（与 cachedRequest 过期语义一致）。
{
  __clearCacheForTest();
  let n = 0;
  const f = async () => {
    n++;
    return "v" + n;
  };
  await cachedFetch("k", 30, f, { swrMs: 30 }); // expiry=30，窗止于 60
  assert.strictEqual(n, 1);
  await sleep(70);
  const b = await cachedFetch("k", 30, f, { swrMs: 30 });
  assert.strictEqual(n, 2, "F3 超窗：走回源");
  assert.strictEqual(b, "v2");
  console.log("F3 超 SWR 窗等回源 ✓");
}

// 4. 并发 stale 调用去重：两个并发 stale 读 → 只触发 1 次回源
// （后台再验证复用 cachedRequest 的 inflight 表）。
{
  __clearCacheForTest();
  let n = 0;
  const f = async () => {
    n++;
    await sleep(20);
    return "v" + n;
  };
  await cachedFetch("k", 30, f, { swrMs: 200 });
  assert.strictEqual(n, 1);
  await sleep(40);
  const p1 = cachedFetch("k", 10000, f, { swrMs: 200 });
  const p2 = cachedFetch("k", 10000, f, { swrMs: 200 });
  const [a, b] = await Promise.all([p1, p2]);
  assert.strictEqual(a, "v1", "F4 并发：两者都拿旧值");
  assert.strictEqual(b, "v1");
  await sleep(60);
  assert.strictEqual(n, 2, "F4 并发：再验证只发 1 次");
  console.log("F4 并发 stale 再验证去重 ✓");
}

// 5. 再验证失败：保留旧值、不向调用方抛错（后台异常自吞）。
{
  __clearCacheForTest();
  let n = 0;
  const f = async () => {
    n++;
    if (n >= 2) throw new Error("boom");
    return "v1";
  };
  await cachedFetch("k", 30, f, { swrMs: 100 });
  await sleep(40);
  const b = await cachedFetch("k", 10000, f, { swrMs: 100 });
  assert.strictEqual(b, "v1", "F5 再验证失败：调用方仍得旧值（不抛错）");
  await sleep(30); // 后台失败 promise settle
  const c = await cachedFetch("k", 10000, f, { swrMs: 100 });
  assert.strictEqual(c, "v1", "F5 再验证失败：旧条目未被覆盖，仍可读");
  console.log("F5 再验证失败保留旧值 ✓");
}

// 6. 标签失效：invalidateTags 后重取 → 回源（SWR 不豁免失效）。
{
  __clearCacheForTest();
  let n = 0;
  const f = async () => {
    n++;
    return "v" + n;
  };
  await cachedFetch("k", 10000, f, { tags: ["t"], swrMs: 10000 });
  assert.strictEqual(n, 1);
  invalidateTags(["t"]);
  const b = await cachedFetch("k", 10000, f, { tags: ["t"], swrMs: 10000 });
  assert.strictEqual(n, 2, "F6 失效：invalidateTags 后重取回源");
  assert.strictEqual(b, "v2");
  console.log("F6 标签失效 ✓");
}

// 7. force：绕过 fresh 缓存直回源（写后强刷语义）。
{
  __clearCacheForTest();
  let n = 0;
  const f = async () => {
    n++;
    return "v" + n;
  };
  await cachedFetch("k", 10000, f);
  assert.strictEqual(n, 1);
  const b = await cachedFetch("k", 10000, f, { force: true });
  assert.strictEqual(n, 2, "F7 force：绕过 fresh 缓存回源");
  assert.strictEqual(b, "v2");
  console.log("F7 force 绕过 ✓");
}

rmSync(tmp, { recursive: true, force: true });
console.log("\ncachedFetch 冒烟全绿（7 组）");
