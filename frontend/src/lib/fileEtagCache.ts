// 文件正文 ETag 条件请求缓存（#1544：controller 的
// GET /humans/{h}/files/{path} 支持 If-None-Match → 304 + HEAD）。
//
// 纯逻辑（不碰 DOM / 具体传输）：缓存 Map<key, {etag, bytes, type}>
// 走模块级 LRU（上限 50 条，防大文件无限占内存）；readFileThroughCache
// 负责「带 If-None-Match → 304 复用 / 200 更新 / 无 ETag 不缓存」这
// 一段协议语义，具体 fetch 由调用方注入（生产 = host.fetch 通道）。
// node 可直测（tests/file-etag-cache.vitest.test.ts）。

/** 单条文件缓存。 */
export interface FileCacheEntry {
  /** 响应 ETag（原样字符串，含引号/弱校验 W/ 前缀）。 */
  etag: string;
  /** 文件字节（304 命中时重建 Blob）。 */
  bytes: ArrayBuffer;
  /** MIME（重建 Blob 保留 type；缺省 = ""）。 */
  type: string;
}

/** 缓存条数上限（LRU 淘汰，够覆盖一屏文件预览/读取）。 */
export const FILE_ETAG_CACHE_LIMIT = 50;

/** 进程内 LRU 缓存（Map 插入序 = 最近使用序，命中/写入即提到末尾）。 */
export class FileEtagCache {
  private readonly limit: number;
  private readonly map = new Map<string, FileCacheEntry>();

  constructor(limit: number = FILE_ETAG_CACHE_LIMIT) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  get size(): number {
    return this.map.size;
  }

  /** 读缓存（命中即刷新 LRU 位次）；未命中 → undefined。 */
  get(key: string): FileCacheEntry | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  /** 写缓存（空 etag 不写——无 ETag 响应不可复验）；超上限淘汰最久未用。 */
  set(key: string, entry: FileCacheEntry): void {
    if (!entry.etag) return;
    this.map.delete(key);
    this.map.set(key, entry);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  /** 当前键（旧 → 新），测试/调试用。 */
  keys(): string[] {
    return Array.from(this.map.keys());
  }
}

/** 条件读文件结果：
 * - cached = 304 命中本地缓存（blob 由缓存字节重建）；
 * - fresh = 200 更新缓存（无 ETag 时不写）；
 * - response = 其余状态（调用方按原错误语义处理，如 401/403/404/405/501）。 */
export type CachedFileResult =
  | { kind: "cached"; blob: Blob }
  | { kind: "fresh"; blob: Blob }
  | { kind: "response"; response: Response };

/** 带 ETag 条件的文件读取（304 不算错误）。
 *
 * doFetch 必须把 init（含 If-None-Match）透传给实际请求；3xx 跟随等
 * 传输细节由调用方处理，本函数只看最终 Response。
 */
export async function readFileThroughCache(
  key: string,
  doFetch: (init?: RequestInit) => Promise<Response>,
  cache: FileEtagCache,
): Promise<CachedFileResult> {
  const cached = cache.get(key);
  const init: RequestInit | undefined = cached
    ? { headers: { "If-None-Match": cached.etag } }
    : undefined;
  const resp = await doFetch(init);
  if (resp.status === 304 && cached) {
    // 未变更：服务端不读 body，直接用缓存字节（保 MIME）。
    return {
      kind: "cached",
      blob: new Blob([cached.bytes], { type: cached.type }),
    };
  }
  if (resp.status === 200) {
    const blob = await resp.blob();
    const etag = resp.headers.get("ETag");
    if (etag) {
      // 无 ETag 响应不写缓存（下次无法复验，304 永远不会发生）。
      cache.set(key, {
        etag,
        bytes: await blob.arrayBuffer(),
        type: blob.type || resp.headers.get("Content-Type") || "",
      });
    }
    return { kind: "fresh", blob };
  }
  return { kind: "response", response: resp };
}
