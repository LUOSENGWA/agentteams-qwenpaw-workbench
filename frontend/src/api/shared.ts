// 跨域共享底座（按域拆分）：requestJson HTTP 底座 + controller 透传 +
// 房间/消息读缓存。域文件（./domains/*）从这里取共享 helper；api.ts
// barrel 重导出本文件，消费方 import 点零改动。
// 同源读接口经 requestCache.cachedRequest 走 TTL+在飞去重+标签失效+LRU；
// 写面（POST/DELETE）不包。

import { isLocalHost } from "../hostEnv";
import { tryLocalConfigEndpoint } from "../localConfigBackend";
import type { RoomMessage, RoomMessagesPage } from "./domains/chat";
import type { TeamsRoomsResponse } from "./domains/teams";

/** Same-origin fetch helper: prefers host.fetch, falls back to getApiUrl.
 *
 * `timeoutMs` 可选超时（AbortController）
 * ——旧版裸 fetch 无超时上限，后端冷窗（切网 failover / 探针收敛前）或
 * Controller 抖动时请求可挂起数分钟，前端恒转圈且刷新钮被 loading 禁用
 * （「手动也不行」）。超时抛「请求超时」错误（非 HTTP xxx 形态，调用方
 * toast 后可手动重试）；不传 = 原行为（SSE/长轮询等端点不受影响）。 */
export async function requestJson(
  path: string,
  init?: RequestInit,
  timeoutMs?: number,
): Promise<unknown> {
  const host = window.QwenPaw.host;
  // 独立宿主（轴 A kind='local'，hostEnv.ts；旧 shell 回退 isOffline）——
  // 配置域走 localStorage 模拟层（脱敏/合并语义对齐服务端连接器）；未命中
  // 的端点放行宿主 fetch → 受控 503（独立配置页入口级不挂载数据页，不会拨号）。
  // console/远端宿主（server）→ 本分支恒 false，在线路径零改动。
  if (isLocalHost()) {
    const emu = tryLocalConfigEndpoint(path, init);
    if (emu !== null) return await emu;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  let response: Response;
  try {
    if (timeoutMs && timeoutMs > 0) {
      const ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const merged: RequestInit = { ...init, signal: ctrl.signal };
      response = host.fetch
        ? await host.fetch(path, merged)
        : await fetch(host.getApiUrl(path), {
            ...merged,
            headers: {
              ...(init?.headers || {}),
              ...(host.getApiToken()
                ? { Authorization: `Bearer ${host.getApiToken()}` }
                : {}),
            },
          });
    } else {
      response = host.fetch
        ? await host.fetch(path, init)
        : await fetch(host.getApiUrl(path), {
            ...init,
            headers: {
              ...(init?.headers || {}),
              ...(host.getApiToken()
                ? { Authorization: `Bearer ${host.getApiToken()}` }
                : {}),
            },
          });
    }
  } catch (e) {
    if (timer) clearTimeout(timer);
    const aborted =
      e instanceof DOMException && e.name === "AbortError";
    if (aborted) {
      const err = new Error(
        `请求超时（${Math.round((timeoutMs || 0) / 1000)}s）——网络或后端冷启动中，稍后点刷新重试`,
      );
      // 15.29 标记：超时≠失败（服务端可能仍在完成写——coding-cli settings
      // 同步写尾延迟可达分钟级），调用方可读回验证而非直接报失败。
      (err as Error & { isTimeout?: boolean }).isTimeout = true;
      throw err;
    }
    throw e;
  }
  if (timer) clearTimeout(timer);
  const content = await response.text();
  let payload: unknown = null;
  try {
    payload = content ? JSON.parse(content) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    // 错误体兼容三种来源：插件后端 FastAPI（{detail}）、Controller 透传
    // （{message}，httputil.ErrorResponse）、Matrix（{errcode}/{error}）。
    let detail: unknown;
    if (payload && typeof payload === "object") {
      const p = payload as Record<string, unknown>;
      if (typeof p.detail === "string") detail = p.detail;
      // 对象 detail（FastAPI HTTPException(detail=dict)——如千锻 compile 422
      // {exit_code, stage, error, stderr_tail}）→ JSON 串（调用方可再解析）。
      else if (typeof p.detail === "object" && p.detail !== null) {
        try {
          detail = JSON.stringify(p.detail);
        } catch {
          detail = String(p.detail);
        }
      } else if (typeof p.message === "string") detail = p.message;
      else if (typeof p.error === "string") detail = p.error;
      else if (typeof p.errcode === "string")
        detail = `${p.errcode}: ${String(p.error ?? "")}`.trim();
    }
    throw new Error(
      typeof detail === "string" && detail
        ? `HTTP ${response.status}: ${detail}`
        : `HTTP ${response.status}`,
    );
  }
  return payload;
}

/** 从 requestJson 错误消息提取 HTTP 状态码（failReason 分类单一真相源）。 */
export function httpErrorStatus(e: unknown): number | null {
  const m = e instanceof Error ? /^HTTP (\d{3})/.exec(e.message) : null;
  return m ? Number(m[1]) : null;
}

/** 从 requestJson 错误消息提取 detail 段（剥 "HTTP xxx: " 前缀）。 */
export function httpErrorDetail(e: unknown): string {
  if (!(e instanceof Error)) return "";
  const m = /^HTTP \d{3}: (.*)$/s.exec(e.message);
  return m ? m[1] : e.message;
}

export async function fetchControllerJson<T>(path: string): Promise<T> {
  // 调用方传 "/workers" 时模板拼接会产生 /api/v1//workers 双斜杠，
  // uvicorn 对双斜杠 301——strip 前导斜杠根治。
  // 30s 封顶（冷窗后端已 ≤~6s；超时显形可重试）。
  const clean = path.replace(/^\/+/, "");
  return (await requestJson(
    `/agentteams-proxy/controller/api/v1/${clean}`,
    undefined,
    30000,
  )) as T;
}

/** Controller POST（wake/sleep 等生命周期操作）。 */
export async function postController(
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const clean = path.replace(/^\/+/, "");
  return requestJson(`/agentteams-proxy/controller/api/v1/${clean}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ── CRD 管理（L1）——走现有通用 Controller 代理（PUT/DELETE 已支持）──

export async function controllerRequest(
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const clean = path.replace(/^\/+/, "");
  return requestJson(`/agentteams-proxy/controller/api/v1/${clean}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ── 模块级缓存（页面重开立即显示，后台刷新）──────────────────────────
// 离开 tab 组件卸载后数据仍在；重新打开先用缓存渲染再后台拉新。
let roomsCache: TeamsRoomsResponse | null = null;
// 缓存从「最新
// 50 条页」升级为「全量已加载历史」（含 loadMore 前插的更早消息）——
// 旧版切页/切房间回来 refresh 用最新 50 全量替换，翻过的历史全丢
// （「很多没了」「乱了」）。
const messagesCache = new Map<string, { messages: RoomMessage[]; end: string }>();

export function getCachedRooms(): TeamsRoomsResponse | null {
  return roomsCache;
}

export function setCachedRooms(data: TeamsRoomsResponse): void {
  roomsCache = data;
}

export function getCachedMessages(
  roomId: string,
): { messages: RoomMessage[]; end: string } | null {
  // 读命中刷新 LRU 次序。
  // 旧版逐出取「首个插入键」（Map 插入序≈FIFO），长期使用的热房会因
  // 「插入早」被逐、而偶访的冷房因「插入新」常驻——与 LRU 语义相反。
  // 命中即 delete+re-set 移到末尾（最近使用），逐出改逐队首（最久未用）。
  const hit = messagesCache.get(roomId);
  if (hit) {
    messagesCache.delete(roomId);
    messagesCache.set(roomId, hit);
  }
  return hit ?? null;
}

export function setCachedMessages(
  roomId: string,
  page: RoomMessagesPage,
  /** 当前 UI 全量消息（含 loadMore 前插历史）——缺省=只存本页。 */
  fullList?: RoomMessage[],
): void {
  // 写亦按 LRU：已存在先删再设（移到末尾=最近使用），避免沿用旧插入位。
  messagesCache.delete(roomId);
  messagesCache.set(roomId, {
    messages: fullList && fullList.length > 0 ? fullList : page.messages,
    end: page.end,
  });
  // 上限 20 个房间，防内存膨胀（逐最久未用=队首）
  if (messagesCache.size > 20) {
    const lru = messagesCache.keys().next().value;
    if (lru) messagesCache.delete(lru);
  }
}

/**
 * R1（16.23）：SSE room_message → 非活动房间的单条新消息直接追加进
 * 该房间的消息缓存（切回时首帧即含新消息，不必等回拉完成）。
 *
 * 约束：
 * - 只更新**已有缓存条目**的房间（打开过）；从未打开的房间不建条目
 *   （首次打开本就会全量拉最新页，单条浅窗反而让窗口游标以空 end 起步）；
 * - event_id 去重（乐观回显可能已写入同一条目）；
 * - 尾追加不动 end 游标（end 是更旧方向游标，与尾部新消息无关——
 *   roomHistory I1 不变量不受影响）；
 * - 调用方只对简单 m.text 且无 relates_to 的载荷调用（与活跃房直合
 *   同款门控）——复杂消息的真相源 = 打开时的全量拉取。
 */
export function appendCachedMessage(
  roomId: string,
  msg: RoomMessage,
): void {
  if (!roomId || !msg || !msg.event_id) return;
  const hit = messagesCache.get(roomId);
  if (!hit) return;
  if (hit.messages.some((m) => m.event_id === msg.event_id)) {
    // 已存在（乐观回显先行写入）→ 仅刷新 LRU 次序。
    messagesCache.delete(roomId);
    messagesCache.set(roomId, hit);
    return;
  }
  // 新数组引用（不 mutate 缓存原数组——React state 可能持有它）。
  const next = { messages: [...hit.messages, msg], end: hit.end };
  messagesCache.delete(roomId);
  messagesCache.set(roomId, next);
  if (messagesCache.size > 20) {
    const lru = messagesCache.keys().next().value;
    if (lru) messagesCache.delete(lru);
  }
}
