// 本地内存 LRU（批次 4 任务 4）：低频变化数据的读缓存（CRD admin 视图 /
// 模型列表 / 网关 Provider 列表，TTL 120s 档）。打开即读旧值 + 后台刷新。
//
// 纯模块硬约束（与 requestCache 同谱系）：不 import React、不访问
// window——node 可直测。
//
// 语义：
// - get：命中 → 移尾（最近使用）+ hits++；未命中/过期（惰性删）→ misses++；
// - set：null/undefined 不写（失败态不缓存）；超容逐头（最久未用）
//   evictions++；
// - invalidate(prefix)：删前缀命中的全部条目（写面失效配对，写后读新鲜）；
// - readThrough：命中 → 立即回旧值 + 后台静默刷新（失败保旧值不抛错）；
//   未命中 → 回源，成功才写。

interface LruEntry<T> {
  value: T;
  expiry: number;
}

export interface LruStats {
  hits: number;
  misses: number;
  size: number;
  evictions: number;
}

export class MemoryLru<T> {
  private capacity: number;
  private map = new Map<string, LruEntry<T>>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(capacity: number = 200) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiry <= Date.now()) {
      // 过期惰性删。
      this.map.delete(key);
      this.misses += 1;
      return undefined;
    }
    // 命中：移到尾部（最近使用）。
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    if (value === null || value === undefined) return; // 失败态不缓存
    this.map.delete(key);
    this.map.set(key, { value, expiry: Date.now() + ttlMs });
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
      this.evictions += 1;
    }
  }

  /** 删前缀命中的全部条目（写面失效用）。 */
  invalidate(prefix: string): void {
    for (const key of [...this.map.keys()]) {
      if (key.startsWith(prefix)) this.map.delete(key);
    }
  }

  clear(): void {
    this.map.clear();
  }

  stats(): LruStats {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.map.size,
      evictions: this.evictions,
    };
  }
}

// 模块级单例（工作台各读面共享一张表）。
const memoryLru = new MemoryLru<unknown>(200);

/** readThrough：命中 → 立即回旧值 + 后台静默刷新（失败保旧值不抛错）；
 * 未命中 → 回源，成功才写（失败态不缓存）。 */
export function lruReadThrough<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const hit = memoryLru.get(key) as T | undefined;
  if (hit !== undefined) {
    void fetcher()
      .then((v) => memoryLru.set(key, v, ttlMs))
      .catch(() => {
        /* 后台刷新失败：保旧值 */
      });
    return Promise.resolve(hit);
  }
  return fetcher().then((v) => {
    memoryLru.set(key, v, ttlMs);
    return v;
  });
}

/** 写面失效：删前缀命中的全部条目。 */
export function lruInvalidate(prefix: string): void {
  memoryLru.invalidate(prefix);
}

/** 全清（换身份/凭据后整表作废）。 */
export function lruClear(): void {
  memoryLru.clear();
}

export function lruStats(): LruStats {
  return memoryLru.stats();
}

let statsLogged = false;

/** 启动时打印一次统计（console.debug，开发观测面；只打一次）。 */
export function logCacheStatsOnce(): void {
  if (statsLogged) return;
  statsLogged = true;
  // eslint-disable-next-line no-console
  console.debug("[cache]", lruStats());
}
