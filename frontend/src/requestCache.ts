// v0.5.0-beta.14.6：前端内存读缓存（requestCache）单例模块。
//
// 用途：api.ts 的同源读接口（teams/admin/gateway/skills/kb/...）统一经
// cachedRequest 走「TTL 过期 + 在飞去重 + 标签失效 + LRU 限容」，消除
// rc-tabs 保活下「多 tab 轮询并发 + 同接口重复调用」的持续负载。
//
// 纯模块硬约束（任务书 §模块 A）：
// - 不 import React、不访问 window（模块级单例，node 可直测——
// 见 scripts/requestCache.smoke.mjs）；
// - 命中未过期且非 force → 返回缓存值 hits++，不调 fetcher；
// - 未命中/过期/force → 调 fetcher，成功才写（expiry=now+ttl）misses++，
// 失败原样抛、不写缓存；
// - 在飞去重：同 key 未完成 Promise 直接复用 deduped++（force 同样参与，
// 防同刻双发）；
// - maxEntries LRU：命中或写入刷新 recency，超限淘汰最旧；过期惰性删；
// - invalidateTags 删任一 tag 命中的条目；invalidateKey 删单键。
//
// 已知限制（如实标注）：失效时刻若有在飞 fetch 尚未完成，该 fetch 完成时
// 仍会写回缓存（stale-write race）——调用方在写操作后紧跟 force:true 或
// invalidateTags 即可自愈（见 api.ts 失效接线）。

interface RequestCacheOptions {
  /** true=跳过读缓存（仍参与在飞去重；完成后覆盖写缓存） */
  force?: boolean;
  /** 失效标签 */
  tags?: string[];
  /** 默认 300；超限 LRU 淘汰 */
  maxEntries?: number;
}

interface RequestCacheStats {
  hits: number;
  misses: number;
  deduped: number;
  size: number;
}

interface CacheEntry<T> {
  value: T;
  expiry: number;
  tags: string[];
}

const DEFAULT_MAX_ENTRIES = 300;

// LRU 用 Map 插入序表达：命中/写入时 delete+set 把键移到尾部（最新），
// 超容时从头部（最旧）淘汰。
const store = new Map<string, CacheEntry<unknown>>();
// 在飞去重表：key → 未完成的 Promise（settle 时移除）。
const inflight = new Map<string, Promise<unknown>>();

const stats = { hits: 0, misses: 0, deduped: 0 };

/** 刷新 recency：把 key 移到 Map 尾部（最新）。 */
function touch(key: string): void {
  const e = store.get(key);
  if (e) {
    store.delete(key);
    store.set(key, e);
  }
}

/** 超容淘汰：从最旧（头部）开始删到 size <= maxEntries。 */
function evictOverflow(maxEntries: number): void {
  while (store.size > maxEntries) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/**
 * 带缓存的读请求。key 必须包含所有影响结果的参数（调用方约定）。
 */
export function cachedRequest<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  opts?: RequestCacheOptions,
): Promise<T> {
  const force = opts?.force === true;
  const maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;

  // 在飞去重（先于 force/命中判定）：同 key 有未完成 Promise → 直接复用，
  // force 同样参与，防止同刻双发。
  const existing = inflight.get(key);
  if (existing) {
    stats.deduped += 1;
    return existing as Promise<T>;
  }

  if (!force) {
    const hit = store.get(key);
    if (hit) {
      if (hit.expiry > Date.now()) {
        // 命中：未过期且非 force → 返回缓存值，不调 fetcher。
        stats.hits += 1;
        touch(key);
        return Promise.resolve(hit.value as T);
      }
      // 过期惰性清理：命中时发现过期即删，按未命中处理。
      store.delete(key);
    }
  }

  // 未命中/过期/force → 调 fetcher；成功才写缓存，misses++。
  stats.misses += 1;
  const p: Promise<T> = (async () => {
    const value = await fetcher();
    store.delete(key);
    store.set(key, {
      value,
      expiry: Date.now() + ttlMs,
      tags: (opts?.tags ?? []).slice(),
    });
    evictOverflow(maxEntries);
    return value;
  })().finally(() => {
    inflight.delete(key);
  }) as Promise<T>;

  inflight.set(key, p);
  return p;
}

/** 删除任一 tag 命中的条目（标签为空的条目不受影响）。 */
export function invalidateTags(tags: string[]): void {
  if (tags.length === 0) return;
  for (const [key, entry] of store) {
    if (entry.tags.some((t) => tags.includes(t))) store.delete(key);
  }
}

/** 删除单键。 */
function invalidateKey(key: string): void {
  store.delete(key);
}

/** 缓存统计（size=当前条目数）。 */
export function cacheStats(): RequestCacheStats {
  return {
    hits: stats.hits,
    misses: stats.misses,
    deduped: stats.deduped,
    size: store.size,
  };
}

/** 仅供测试：清空缓存表、在飞表与统计。 */
export function __clearCacheForTest(): void {
  store.clear();
  inflight.clear();
  stats.hits = 0;
  stats.misses = 0;
  stats.deduped = 0;
}
