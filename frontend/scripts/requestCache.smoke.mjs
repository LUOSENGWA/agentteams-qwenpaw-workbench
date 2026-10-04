// v0.5.0-beta.14.6（R1）：requestCache 语义冒烟（node 直跑，跑法照
// scripts/roomHistory.smoke.mjs——esbuild buildSync 到临时目录 + import）。
// 用法：node scripts/requestCache.smoke.mjs
import { buildSync } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert";

const tmp = mkdtempSync(path.join(tmpdir(), "rc-smoke-"));
buildSync({
  entryPoints: ["src/requestCache.ts"],
  bundle: true,
  format: "esm",
  outfile: path.join(tmp, "requestCache.mjs"),
  platform: "node",
});
const {
  cachedRequest,
  invalidateTags,
  cacheStats,
  __clearCacheForTest,
} = await import(path.join(tmp, "requestCache.mjs"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. 命中：同 key 连续两次 → fetcher 只跑 1 次（hits=1）。
{
  __clearCacheForTest();
  let n = 0;
  const f = async () => {
    n++;
    return "v1";
  };
  const a = await cachedRequest("k", 10000, f);
  const b = await cachedRequest("k", 10000, f);
  assert.strictEqual(n, 1, "R1 命中：fetcher 只跑 1 次");
  assert.strictEqual(a, "v1");
  assert.strictEqual(b, "v1");
  assert.strictEqual(cacheStats().hits, 1, "R1 命中：hits=1");
  console.log("R1 命中 ✓");
}

// 2. 过期：ttl=30ms，sleep 40ms 后再调 → fetcher 第 2 次。
{
  __clearCacheForTest();
  let n = 0;
  const f = async () => {
    n++;
    return "v" + n;
  };
  const a = await cachedRequest("k", 30, f); // miss → n=1
  assert.strictEqual(n, 1, "R2 过期：首次 miss");
  assert.strictEqual(a, "v1");
  await sleep(40);
  const b = await cachedRequest("k", 30, f); // 过期 → miss → n=2
  assert.strictEqual(n, 2, "R2 过期：40ms 后第 2 次 fetch");
  assert.strictEqual(b, "v2");
  console.log("R2 过期 ✓");
}

// 3. 在飞去重：并发两次同 key（fetcher 延迟 30ms）→ fetcher 只跑 1 次。
{
  __clearCacheForTest();
  let n = 0;
  const f = async () => {
    n++;
    await sleep(30);
    return "v";
  };
  const p1 = cachedRequest("k", 10000, f);
  const p2 = cachedRequest("k", 10000, f); // 在飞去重
  const [a, b] = await Promise.all([p1, p2]);
  assert.strictEqual(n, 1, "R3 在飞去重：fetcher 只跑 1 次");
  assert.ok(cacheStats().deduped >= 1, "R3 在飞去重：deduped≥1");
  assert.strictEqual(a, b, "R3 在飞去重：同值");
  console.log("R3 在飞去重 ✓");
}

// 4. force：force=true 跳过读缓存但仍写（计数 +1；随后非 force 命中新值）。
{
  __clearCacheForTest();
  let n = 0;
  const f = async () => {
    n++;
    return "v" + n;
  };
  const a = await cachedRequest("k", 10000, f); // n=1 v1
  assert.strictEqual(n, 1);
  const b = await cachedRequest("k", 10000, f, { force: true }); // n=2 v2
  assert.strictEqual(n, 2, "R4 force：跳过读缓存再 fetch");
  assert.strictEqual(b, "v2");
  const c = await cachedRequest("k", 10000, f); // 命中 force 写回的新值
  assert.strictEqual(n, 2, "R4 force：随后非 force 命中新值（不再 fetch）");
  assert.strictEqual(c, "v2");
  console.log("R4 force ✓");
}

// 5. 失效：invalidateTags 后同 key 重取（fetcher +1）。
{
  __clearCacheForTest();
  let n = 0;
  const f = async () => {
    n++;
    return "v" + n;
  };
  const a = await cachedRequest("k", 10000, f, { tags: ["t"] }); // n=1
  assert.strictEqual(n, 1);
  invalidateTags(["t"]);
  const b = await cachedRequest("k", 10000, f, { tags: ["t"] }); // n=2
  assert.strictEqual(n, 2, "R5 失效：invalidateTags 后重取再 fetch");
  assert.strictEqual(b, "v2");
  console.log("R5 失效 ✓");
}

// 6. LRU：maxEntries=2，写 3 键 → size=2 且最旧被淘汰。
{
  __clearCacheForTest();
  let n = 0;
  const f = async () => {
    n++;
    return "v" + n;
  };
  await cachedRequest("a", 10000, f, { maxEntries: 2 });
  await cachedRequest("b", 10000, f, { maxEntries: 2 });
  await cachedRequest("c", 10000, f, { maxEntries: 2 }); // 淘汰最旧 a
  assert.strictEqual(cacheStats().size, 2, "R6 LRU：size=2");
  const before = n;
  await cachedRequest("a", 10000, f, { maxEntries: 2 }); // a 已被淘汰 → miss
  assert.strictEqual(n, before + 1, "R6 LRU：最旧 a 被淘汰（重取=miss）");
  console.log("R6 LRU ✓");
}

// 7. 失败不缓存：fetcher reject → 下次重试再跑。
{
  __clearCacheForTest();
  let n = 0;
  const f = async () => {
    n++;
    if (n === 1) throw new Error("boom");
    return "v";
  };
  let threw = false;
  try {
    await cachedRequest("k", 10000, f);
  } catch {
    threw = true;
  }
  assert.ok(threw, "R7 失败不缓存：首次 reject 原样抛");
  const a = await cachedRequest("k", 10000, f); // 重试 → n=2 成功
  assert.strictEqual(n, 2, "R7 失败不缓存：失败未写缓存，重试再跑");
  assert.strictEqual(a, "v");
  console.log("R7 失败不缓存 ✓");
}

rmSync(tmp, { recursive: true, force: true });
console.log("\nrequestCache 冒烟全绿（7 断言）");
