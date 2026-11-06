// conditionalCache —— ETag/304 内存条件读缓存（R1 worker 列表 slim polling，
// dashboard #179 权威语义端口；正源 docs/worker-list-compatibility.md）。
//
// 权威语义（#179 原文要点，逐条对应）：
// - 仅内存（无 localStorage/持久层）、≤64 条、按请求 URL 键；
// - 每次复用都必须有上游 304（不是离线缓存）：仅当响应 304 且缓存条目
//   有效、revision 未变（在飞期间无写）才返回 NOT_MODIFIED，否则绝不返回旧值；
// - 只对 GET 生效（本模块只做 GET；写面清缓存接线在 api/shared.ts
//   requestJsonFull：任何写请求前清一次、finally 再清一次）；
// - scope 变化（身份/凭据/连接切换，getReadScope）→ 清缓存；
// - 304 但缓存条目丢失（在飞被清/逐出）→ 去掉 If-None-Match 重发——
//   绝不把 304 变成空数据；
// - status/默认/all 视图永不条件缓存——调用方以 reload:true 落实（worker
//   列表 status 视图契约：恒 200，不发 If-None-Match）。
//
// LRU：命中（发 If-None-Match）或写入（200+ETag）时 delete+set 移到队尾；
// 超限（>64）从队首逐出最久未用。
//
// 纯模块硬约束（同 requestCache / workerDetailGate 一脉）：零 import，
// node --experimental-strip-types 可直测（frontend/tests/r1-slim-list.test.ts）：
// - 传输经 setConditionalFetch 注入（生产接线在 crd.ts，同源 requestJsonFull）；
// - 身份 scope 经 setReadScopeReader 注入（生产默认见 defaultScopeReader）；
// - NOT_MODIFIED 为本地定义的同值哨兵（requestCache.NOT_MODIFIED 是
//   unique symbol，node 直测纯模块无法 import 浏览器 bundle 的无扩展名依赖
//   链——任务书允许「从 api/shared.ts import 或本地定义同值」，取后者；
//   消费方 crd.ts 统一 import 本模块哨兵做判等）。

export const NOT_MODIFIED: unique symbol = Symbol(
  "conditionalCache.NOT_MODIFIED",
);

export interface CachedEntry {
  /** 上游 ETag（下次命中时作为 If-None-Match 发送）。 */
  etag: string;
  /** 200 原始响应体（原始字节；304 时调用方复用自己保存的旧 payload）。 */
  body: string;
  /** 200 响应 Content-Type（可能为空串）。 */
  contentType: string;
}

/** 条件读传输：返回原始 Response（body 未消费——本模块要自读 body + ETag）。 */
export type ConditionalFetch = (
  url: string,
  init?: RequestInit,
  timeoutMs?: number,
) => Promise<Response>;

/** 身份 scope 读取器：返回值变化 = 身份/凭据/连接切换。 */
export type ScopeReader = () => string;

const MAX_ENTRIES = 64;
const SESSION_NONCE_KEY = "agentteams.conditional-cache.session-nonce";

const cache = new Map<string, CachedEntry>();
let revision = 0;
let fetchImpl: ConditionalFetch | null = null;
let scopeReader: ScopeReader | null = null;
/** 最近一次 clear 时生效的 scope 值（首次 ensureScope 时建立）。 */
let scopeInEffect: string | null = null;
const clearListeners = new Set<() => void>();

/** 注入条件读传输（生产 = crd.ts 模块级接线；测试 = 假 fetch；null = 清除）。 */
export function setConditionalFetch(fn: ConditionalFetch | null): void {
  fetchImpl = fn;
}

/** 注入身份 scope 读取器（测试用；null = 恢复生产默认 getReadScope 语义）。 */
export function setReadScopeReader(fn: ScopeReader | null): void {
  scopeReader = fn;
}

function makeSessionNonce(): string {
  try {
    const c = globalThis.crypto as
      | { randomUUID?: () => string }
      | undefined;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
  } catch {
    /* 落到下方回退 */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 生产默认身份 scope：
 * - origin：连接/后端身份（宿主切换 → scope 变化）；
 * - host.getApiToken()：同步稳定凭据信号（qwenpaw-host.d.ts 声明，所有同源
 *   请求 Authorization 同源；重登录/重认证 → scope 变化）。L1 flag
 *   （hasCtlToken）派生自异步 React config 状态（WorkbenchPageData.ts），
 *   lib 模块无同步取法；且 controller_token 变更必伴随 settings 写请求，
 *   shared.ts 写清是第二道闸，此处不等它；
 * - per-tab sessionStorage nonce：页面重载即变（内存缓存重载本已空，此处为
 *   跨 tab/跨会话隔离的防御纵深）；
 * - node 环境（无 window）返回固定 "node"（测试经 setter 注入读取器）。 */
function defaultScopeReader(): string {
  try {
    if (typeof window === "undefined") return "node";
    const origin = window.location.origin;
    const host = window.QwenPaw?.host;
    const token =
      host && typeof host.getApiToken === "function"
        ? host.getApiToken()
        : null;
    let nonce = "";
    try {
      nonce = window.sessionStorage.getItem(SESSION_NONCE_KEY) || "";
      if (!nonce) {
        nonce = makeSessionNonce();
        window.sessionStorage.setItem(SESSION_NONCE_KEY, nonce);
      }
    } catch {
      /* sessionStorage 不可用（隐私模式等）→ 置空，不影响主 scope */
    }
    return `${origin}\u0000${token ?? ""}\u0000${nonce}`;
  } catch {
    return "unknown";
  }
}

/** 当前身份 scope（调用方注入的读取器优先，否则生产默认）。 */
export function getReadScope(): string {
  return (scopeReader ?? defaultScopeReader)();
}

/** 当前缓存 revision（每次 clear +1）——在飞 304/200 落库的守卫基准。 */
export function currentRevision(): number {
  return revision;
}

/** 清空全部条件缓存条目（revision +1、通知订阅者、scope 基准重置为当前）。
 * 调用方：api/shared.ts 写前/写后（requestJsonFull）、本模块 scope 变化、测试。 */
export function clearConditionalResponses(): void {
  cache.clear();
  revision += 1;
  scopeInEffect = getReadScope();
  for (const fn of clearListeners) fn();
}

/** 订阅清缓存事件（worker 列表 lastSpecRows 随清——防 304 复用旧数据）。 */
export function subscribeConditionalClear(fn: () => void): () => void {
  clearListeners.add(fn);
  return () => {
    clearListeners.delete(fn);
  };
}

/** 测试/观测：当前条目数（≤64）。 */
export function getCacheSize(): number {
  return cache.size;
}

/** 入口 scope 守卫：首读建立基准；之后 scope 变化 → 清缓存再续读。 */
function ensureScope(): string {
  const scope = getReadScope();
  if (scopeInEffect === null) {
    scopeInEffect = scope;
    return scope;
  }
  if (scope !== scopeInEffect) {
    clearConditionalResponses(); // 内部把 scopeInEffect 置为当前 scope
    return getReadScope();
  }
  return scope;
}

/** LRU 命中刷新（delete+set 移到队尾）。 */
function touchEntry(url: string): void {
  const entry = cache.get(url);
  if (!entry) return;
  cache.delete(url);
  cache.set(url, entry);
}

/** 写入条目（delete+set 移到队尾）+ 超限从队首逐出最久未用。 */
function writeEntry(url: string, entry: CachedEntry): void {
  cache.delete(url);
  cache.set(url, entry);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

export interface ConditionalJsonResult<T> {
  /** 200：解析后的 JSON；304：NOT_MODIFIED 哨兵（调用方复用自存旧值）。 */
  payload: T | typeof NOT_MODIFIED;
  response: Response;
}

/** 条件再验证读（GET）：
 * 入口 scope 守卫 →（命中且非 reload → If-None-Match）→ 请求 → 请求完成后
 * scope 复检（变了 → 抛「身份已切换」并清缓存）→
 * 304：缓存有效且 revision 未变 → NOT_MODIFIED；否则去掉 If-None-Match 重发
 * → 200+ETag：存 body+etag（revision 守卫）；无 ETag：删该 URL 条目
 * → 非 2xx：HTTP xxx 错误（httpErrorStatus 兼容，调用方判 400 回退）。 */
export async function conditionalJson<T>(
  path: string,
  opts?: { reload?: boolean; timeoutMs?: number },
): Promise<ConditionalJsonResult<T>> {
  if (!fetchImpl) {
    throw new Error(
      "条件读传输未接线（setConditionalFetch，生产接线在 crd.ts）",
    );
  }
  const fetcher = fetchImpl;
  const scopeBefore = ensureScope();
  for (let attempt = 0; attempt < 2; attempt++) {
    const revAtSend = currentRevision();
    // 命中且非 reload → 带 If-None-Match（命中刷新 LRU 新鲜度）；
    // 重发（attempt=1）与 reload 一律不带（强制 200）。
    const entry =
      attempt === 0 && !opts?.reload ? cache.get(path) : undefined;
    if (entry) touchEntry(path);
    const init: RequestInit | undefined = entry
      ? { headers: { "If-None-Match": entry.etag } }
      : undefined;
    let response: Response;
    try {
      response = await fetcher(path, init, opts?.timeoutMs);
    } catch (e) {
      // 超时 abort（传输的 AbortController）→ 与 requestJsonFull 同款消息
      // 形态（非 HTTP xxx，isTimeout 标记，调用方 toast 后可重试）。
      if (e instanceof DOMException && e.name === "AbortError") {
        const err = new Error(
          `请求超时（${Math.round((opts?.timeoutMs || 0) / 1000)}s）——网络或后端冷启动中，稍后点刷新重试`,
        );
        (err as Error & { isTimeout?: boolean }).isTimeout = true;
        throw err;
      }
      throw e;
    }
    // 请求完成后再比一次 scope：在飞期间身份已切换 → 清缓存 + 抛错（调用方重读）
    if (getReadScope() !== scopeBefore) {
      ensureScope();
      throw new Error("身份已切换，请重新读取");
    }
    if (response.status === 304) {
      // 304：仅当缓存条目仍在且 revision 未变（在飞无写清）才返回哨兵；
      // 条目丢失（在飞被清/逐出）→ 去掉 If-None-Match 重发——绝不把 304
      // 变成空数据。
      const entryNow = cache.get(path);
      if (entryNow && currentRevision() === revAtSend) {
        touchEntry(path);
        return { payload: NOT_MODIFIED, response };
      }
      continue;
    }
    if (response.ok) {
      const body = await response.text();
      const etag = response.headers.get("etag");
      if (etag) {
        // 200+ETag → 存 body+etag（revision 守卫：在飞过写则不落库）
        if (currentRevision() === revAtSend) {
          writeEntry(path, {
            etag,
            body,
            contentType: response.headers.get("content-type") ?? "",
          });
        }
      } else {
        // 无 ETag → 该 URL 不可条件缓存，删除条目
        cache.delete(path);
      }
      let payload: T;
      try {
        payload = (body ? JSON.parse(body) : null) as T;
      } catch {
        payload = null as T;
      }
      return { payload, response };
    }
    // 非 2xx 非 304（400/401/403/404/5xx…）：解析错误体 → HTTP xxx 消息
    // （与 requestJsonFull 同形态，httpErrorStatus 可判；调用方 400 → 回退
    // 完整列表，其余照抛）。
    let detail = "";
    try {
      const text = await response.text();
      const j = (text ? JSON.parse(text) : null) as
        | Record<string, unknown>
        | null;
      if (j && typeof j === "object") {
        if (typeof j.detail === "string") detail = j.detail;
        else if (typeof j.message === "string") detail = j.message;
        else if (typeof j.error === "string")
          detail = `${
            typeof j.errcode === "string" ? `${j.errcode}: ` : ""
          }${j.error}`.trim();
      }
    } catch {
      /* 错误体非 JSON → 无 detail */
    }
    throw new Error(
      detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`,
    );
  }
  // 两次请求仍 304（仅当服务端在无 If-None-Match 时也 304——超出契约）：
  // 不把 304 变成空数据，抛错由调用方重读。
  throw new Error("304 再验证持续丢失缓存，请重新读取");
}
