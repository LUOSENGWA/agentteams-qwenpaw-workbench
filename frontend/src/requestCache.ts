// 前端内存读缓存（requestCache）单例模块。
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
// - 条件再验证（批次 4）：条目过期不立即删，保留为 stale 并调
//   fetcher(stale.etag)；fetcher 返回 NOT_MODIFIED（后端 304）→ 不覆盖
//   本地缓存、返回旧值并给条目续 TTL（再验证新鲜）；返回
//   ConditionalEnvelope（conditionalValue 包装）→ 解包 value + etag 入库。
//   旧式 0 参 fetcher 不发 etag、收不到 304，语义不变。
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

interface CachedFetchOptions extends RequestCacheOptions {
  /**
   * SWR 窗口（ms）：条目过期后仍在此窗内 → 立即返回旧值 + 后台再验证
   * （stale-while-revalidate）；0/缺省 = 与 cachedRequest 同语义（过期即等
   * 回源）。再验证失败保留旧值（不向调用方抛错）——后台任务吞异常。
   */
  swrMs?: number;
}

/** 304 哨兵：后端 304 Not Modified 时 fetcher 返回它（身份判等）。 */
export const NOT_MODIFIED: unique symbol = Symbol("requestCache.NOT_MODIFIED");

/** 条件再验证信封：fetcher 收到带 ETag 的 200 时用它包装结果。 */
export interface ConditionalEnvelope<T> {
  __cond: true;
  value: T;
  etag: string | null;
}

/** 信封构造（域层条件化 fetcher 包 200 结果用）。 */
export function conditionalValue<T>(
  value: T,
  etag: string | null,
): ConditionalEnvelope<T> {
  return { __cond: true, value, etag };
}

interface RequestCacheStats {
  hits: number;
  misses: number;
  deduped: number;
  notModified: number;
  size: number;
}

interface CacheEntry<T> {
  value: T;
  expiry: number;
  tags: string[];
  /** 条件再验证用；缺省 = 无 etag（下次回源不带 If-None-Match）。 */
  etag?: string;
}

const DEFAULT_MAX_ENTRIES = 300;

// LRU 用 Map 插入序表达：命中/写入时 delete+set 把键移到尾部（最新），
// 超容时从头部（最旧）淘汰。
const store = new Map<string, CacheEntry<unknown>>();
// 在飞去重表：key → 未完成的 Promise（settle 时移除）。
const inflight = new Map<string, Promise<unknown>>();

const stats = { hits: 0, misses: 0, deduped: 0, notModified: 0 };

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

/** 解包条件信封（NOT_MODIFIED 由调用方先行身份判等处理）。 */
function unwrapConditional<T>(
  raw: T | ConditionalEnvelope<T>,
): { value: T; etag: string | undefined } {
  if (
    typeof raw === "object" &&
    raw !== null &&
    (raw as { __cond?: unknown }).__cond === true
  ) {
    const env = raw as ConditionalEnvelope<T>;
    return { value: env.value, etag: env.etag ?? undefined };
  }
  return { value: raw as T, etag: undefined };
}

/**
 * 带缓存的读请求。key 必须包含所有影响结果的参数（调用方约定）。
 *
 * fetcher 首参 = stale 条目 etag（仅过期条件再验证路径发送）；返回值
 * 可以是 T（旧式 0 参 fetcher 形态）、ConditionalEnvelope<T>（条件 200，
 * value + etag 入库）或 NOT_MODIFIED（后端 304 → 不覆盖本地缓存，返回
 * 旧值并续条目 TTL）。
 */
export function cachedRequest<T>(
  key: string,
  ttlMs: number,
  fetcher: (
    etag?: string,
  ) => Promise<T | ConditionalEnvelope<T> | typeof NOT_MODIFIED>,
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

  let stale: CacheEntry<T> | null = null;
  if (!force) {
    const hit = store.get(key);
    if (hit) {
      if (hit.expiry > Date.now()) {
        // 命中：未过期且非 force → 返回缓存值，不调 fetcher。
        stats.hits += 1;
        touch(key);
        return Promise.resolve(hit.value as T);
      }
      // 过期：保留条目（stale）供条件再验证（If-None-Match）——304 保
      // 旧值并续条目（再验证新鲜），200 正常覆盖；不在此删除。
      stale = hit as CacheEntry<T>;
    }
  }

  // 未命中/过期/force → 调 fetcher；成功才写缓存，misses++。
  stats.misses += 1;
  const p: Promise<T> = (async () => {
    const raw = await fetcher(stale?.etag);
    if (raw === NOT_MODIFIED) {
      // 304：不覆盖本地缓存——返回旧值；条目若未被失效删除 → 续 expiry
      // （再验证新鲜）。
      stats.notModified += 1;
      if (stale) {
        const current = store.get(key);
        if (current) {
          store.delete(key);
          store.set(key, {
            ...current,
            expiry: Date.now() + ttlMs,
            etag: current.etag ?? stale.etag,
          });
          evictOverflow(maxEntries);
        }
        return stale.value as T;
      }
      // 理论不可达：未发 etag 的 fetcher 收不到 304（fetcher 契约违规）。
      return undefined as T;
    }
    const { value, etag } = unwrapConditional(raw);
    store.delete(key);
    store.set(key, {
      value,
      expiry: Date.now() + ttlMs,
      tags: (opts?.tags ?? []).slice(),
      etag,
    });
    evictOverflow(maxEntries);
    return value;
  })().finally(() => {
    inflight.delete(key);
  }) as Promise<T>;

  inflight.set(key, p);
  return p;
}

/**
 * cachedFetch = cachedRequest + SWR（stale-while-revalidate）。
 *
 * 三档语义（key 约定同 cachedRequest——须含所有影响结果的参数）：
 * 1. fresh（now < expiry，非 force）→ 直接返回缓存（零网络，hits++）；
 * 2. 过期但仍在 SWR 窗内（expiry ≤ now < expiry + swrMs，非 force）→
 *    **立即返回旧值**（UI 零等待）+ 后台再验证（复用 cachedRequest 的
 *    在飞去重表，并发同 key 只发一次回源；成功覆盖写缓存，下次读拿到
 *    新值；失败保留旧值——后台异常自吞，不向调用方抛错）；
 * 3. 无条目 / 超出 SWR 窗 / force → 等 fetcher 完成后返回（失败原样抛，
 *    与 cachedRequest 同语义）。
 *
 * 与 cachedRequest 的关系：复用同一 store/inflight 表与 stats 计数，
 * 不另开缓存面（标签失效 / LRU / 在飞去重行为逐条一致）。
 */
export function cachedFetch<T>(
  key: string,
  ttlMs: number,
  fetcher: (
    etag?: string,
  ) => Promise<T | ConditionalEnvelope<T> | typeof NOT_MODIFIED>,
  opts?: CachedFetchOptions,
): Promise<T> {
  if (!opts?.force) {
    const hit = store.get(key);
    if (hit) {
      const now = Date.now();
      if (hit.expiry > now) {
        // 档 1：fresh → 直接返回缓存。
        stats.hits += 1;
        touch(key);
        return Promise.resolve(hit.value as T);
      }
      const swrMs = opts?.swrMs ?? 0;
      if (swrMs > 0 && now < hit.expiry + swrMs) {
        // 档 2：stale 但在 SWR 窗内 → 立即回旧值 + 后台再验证。
        // 再验证走条件路径（条目保留 etag → If-None-Match → 304 保旧值
        // 续 TTL / 200 覆盖新值），复用 inflight 去重——并发多个调用者
        // 只触发一次回源。（force 在此不可达：档 2 仅在 !force 时进入。）
        stats.hits += 1;
        touch(key);
        void cachedRequest(key, ttlMs, fetcher, opts).catch(() => {
          /* 再验证失败：保留旧值，不向调用方抛错 */
        });
        return Promise.resolve(hit.value as T);
      }
      // 超出 SWR 窗：惰性删除，落档 3 走回源。
      store.delete(key);
    }
  }
  // 档 3：回源（未命中/超窗/force），语义与 cachedRequest 一致。
  return cachedRequest(key, ttlMs, fetcher, opts);
}

/** 删除任一 tag 命中的条目（标签为空的条目不受影响）。 */
export function invalidateTags(tags: string[]): void {
  if (tags.length === 0) return;
  for (const [key, entry] of store) {
    if (entry.tags.some((t) => tags.includes(t))) store.delete(key);
  }
}

/**
 * 清空全部缓存条目（保留在飞表——在飞 Promise settle 时仍会写回，
 * 与 invalidateTags 同款 stale-write race；调用方语义是「全量数据面
 * 重置」（如 importFullConfig 换凭据/身份），页面刷新或下轮 TTL
 * 即自愈）。
 */
export function clearAll(): void {
  store.clear();
}

/** 缓存统计（size=当前条目数）。 */
export function cacheStats(): RequestCacheStats {
  return {
    hits: stats.hits,
    misses: stats.misses,
    deduped: stats.deduped,
    notModified: stats.notModified,
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
  stats.notModified = 0;
}
