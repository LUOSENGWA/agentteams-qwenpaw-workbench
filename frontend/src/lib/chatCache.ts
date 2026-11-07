// 本地聊天记录缓存（插件后端磁盘，设计「QwenPaw插件存储与缓存」§3/§4/§6）：
// 打开房间先见旧消息（离线可读），「加载原消息」优先在本地找目标（零网络），
// /context 结果也落本地。
//
// 数据面（前端不直接读写磁盘，浏览器沙箱）：
// · 后端 `GET/PUT/DELETE /agentteams-proxy/storage/chat/{roomId}` →
//   `<workspace>/.qwenpaw/agentteams/cache/chat/<roomId>.json`（{messages, end}）；
// · 每房窗口 ≤500 条（服务端截断，保留最新）；`POST …/storage/prune` 做
//   房间数/总量 LRU 整理；
// · 本模块保留每个账号+房间的**内存窗口**（同房多次读写不重复走网络），
//   账号只用于内存键——磁盘按 room 存（与设计一致）。
// · 已读位点设计未要求落盘 → 仅内存 Map（进程重启即失效，仅离线首屏用）。
//
// 纪律：
// · 只缓存消息 JSON（含 mxc URL），不缓存附件二进制；
// · 所有读写失败静默（缓存是加速层，绝不能把聊天页带崩）；
// · 按 event_id upsert：旧记录里已有的 edited/pending/failed 标记不被
//   缺字段的新载荷抹掉（`{...old, ...new}`）；
// · 同房写串行（读-合并-写整窗；并发 SSE 落盘不互相覆盖）。
import type { RoomMessage } from "../api";
import { requestJson } from "../api/shared";

/** 默认账号键（config 未就绪 / 未登录时的兜底）。 */
export const CHAT_CACHE_DEFAULT_ACCOUNT = "default";
/** getRecent 默认条数（首屏缓存窗）。 */
export const CHAT_CACHE_RECENT = 50;
/** 单房间保留条数（历史常量；服务端窗口上限 500，见 CHAT_LIMIT）。 */
export const CHAT_CACHE_ROOM_KEEP = 2000;
/** pruneAll：每账号保留房间数（服务端策略 30 房为权威）。 */
export const CHAT_CACHE_ROOMS_MAX = 30;

/** 服务端单房窗口上限（后端 MAX_CHAT_MESSAGES 同口径）。 */
const CHAT_LIMIT = 500;
const STORAGE_BASE = "/agentteams-proxy/storage";
const EMPTY_WINDOW: ChatWindow = { messages: [], end: null };

interface ChatWindow {
  messages: RoomMessage[];
  /** Matrix /messages 更旧方向游标（null = 无更早历史/未缓存）。 */
  end: string | null;
}

function normAccount(account: string): string {
  return account || CHAT_CACHE_DEFAULT_ACCOUNT;
}

/** 账号 + 房间的内存缓存键（磁盘按 roomId 存）。 */
export function cacheKey(account: string, roomId: string): string {
  return `${normAccount(account)}:${roomId}`;
}

function byTsThenId(a: RoomMessage, b: RoomMessage): number {
  const ta = Number(a.origin_server_ts) || 0;
  const tb = Number(b.origin_server_ts) || 0;
  return ta - tb || (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0);
}

function isMessage(m: unknown): m is RoomMessage {
  const v = m as RoomMessage | null;
  return !!v && typeof v === "object" && typeof v.event_id === "string" && v.event_id.length > 0;
}

// ── 内存窗口（会话级读缓存；账号只在键上，不与磁盘布局绑定）──────────
const windows = new Map<string, ChatWindow>();
/** 已读位点：设计未要求落盘，仅会话内存（离线首屏用）。 */
const lastRead = new Map<string, number>();
/** 同房写串行链（读-合并-写整窗；并发写不丢更新）。 */
const writeChains = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(key) ?? Promise.resolve();
  // 前序失败不阻断后续（缓存写入失败静默是既有纪律）。
  const next = prev.then(fn, fn);
  writeChains.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

function remember(key: string, win: ChatWindow): void {
  windows.delete(key);
  windows.set(key, win);
}

function chatUrl(roomId: string): string {
  return `${STORAGE_BASE}/chat/${encodeURIComponent(roomId)}`;
}

/** 后端整窗读取；失败 → null（不缓存失败，后续可重试）。 */
async function fetchWindow(roomId: string): Promise<ChatWindow | null> {
  try {
    const payload = (await requestJson(
      `${chatUrl(roomId)}?limit=${CHAT_LIMIT}`,
    )) as { messages?: unknown; end?: unknown } | null;
    if (!payload || !Array.isArray(payload.messages)) return null;
    return {
      messages: (payload.messages as unknown[])
        .filter(isMessage)
        .sort(byTsThenId)
        .slice(-CHAT_LIMIT),
      end: typeof payload.end === "string" ? payload.end : null,
    };
  } catch {
    return null;
  }
}

/** 读整窗（内存命中 → 直接用；未命中 → 一次后端 GET；读失败 → null）。
 *
 * null 与「空窗口」严格区分：null = 后端不可用/失败，调用方不得据此
 * 覆盖磁盘（否则仅凭增量把整窗写残）。 */
async function loadWindow(account: string, roomId: string): Promise<ChatWindow | null> {
  if (!roomId) return EMPTY_WINDOW;
  const key = cacheKey(account, roomId);
  const hit = windows.get(key);
  if (hit) {
    remember(key, hit); // 命中刷新 LRU 次序
    return hit;
  }
  const fresh = await fetchWindow(roomId);
  if (!fresh) return null;
  remember(key, fresh);
  return fresh;
}

/** 整窗写回（原子语义由后端保证；失败静默）。 */
async function putWindow(
  roomId: string,
  win: ChatWindow,
): Promise<void> {
  try {
    await requestJson(chatUrl(roomId), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: win.messages,
        end: win.end ?? undefined,
      }),
    });
  } catch {
    /* 缓存写入失败静默——聊天主流程不受影响 */
  }
}

// ── 消息 ───────────────────────────────────────────────────────────

/** upsert 一批消息（按 event_id；旧记录的 edited/pending 等标记保留）。 */
export async function putMessages(
  account: string,
  roomId: string,
  msgs: readonly RoomMessage[],
): Promise<void> {
  const incoming = (msgs || []).filter(isMessage);
  if (!roomId || incoming.length === 0) return;
  const key = cacheKey(account, roomId);
  await enqueue(key, async () => {
    const win = await loadWindow(account, roomId);
    if (!win) return; // 读不到旧窗口 → 不写（防增量覆盖整窗）
    const map = new Map<string, RoomMessage>();
    for (const m of win.messages) map.set(m.event_id, m);
    for (const m of incoming) {
      const old = map.get(m.event_id);
      // 新载荷缺字段时保留本地标记（edited/pending/failed 不在服务端载荷里）
      map.set(m.event_id, old ? { ...old, ...m } : m);
    }
    const merged = Array.from(map.values()).sort(byTsThenId);
    const next: ChatWindow = {
      messages: merged.length > CHAT_LIMIT ? merged.slice(-CHAT_LIMIT) : merged,
      end: win.end,
    };
    remember(key, next);
    await putWindow(roomId, next);
  });
}

/** 最近 limit 条（升序返回）。 */
export async function getRecent(
  account: string,
  roomId: string,
  limit: number = CHAT_CACHE_RECENT,
): Promise<RoomMessage[]> {
  const n = Math.max(0, Math.trunc(limit));
  if (n === 0) return [];
  const win = await loadWindow(account, roomId);
  return win ? win.messages.slice(-n) : [];
}

/** beforeTs 之前（严格小）的最近 limit 条，正序返回。 */
export async function getRange(
  account: string,
  roomId: string,
  beforeTs: number,
  limit: number,
): Promise<RoomMessage[]> {
  const n = Math.max(0, Math.trunc(limit));
  if (n === 0) return [];
  const win = await loadWindow(account, roomId);
  if (!win) return [];
  const rows = win.messages.filter((m) => (Number(m.origin_server_ts) || 0) < beforeTs);
  return rows.slice(-n);
}

/** 缓存中目标消息前后各 N 条（升序，含目标）；未命中返回 []。
 * 「加载原消息」缓存命中路径用它零网络建窗口。 */
export async function getWindow(
  account: string,
  roomId: string,
  eventId: string,
  before = 25,
  after = 25,
): Promise<RoomMessage[]> {
  const win = await loadWindow(account, roomId);
  if (!win) return [];
  const idx = win.messages.findIndex((m) => m.event_id === eventId);
  if (idx < 0) return [];
  const start = Math.max(0, idx - Math.max(0, before));
  const end = Math.min(win.messages.length, idx + Math.max(0, after) + 1);
  return win.messages.slice(start, end);
}

/** 纯函数合并：按 event_id 去重，fresh 覆盖 cached；稳定按 ts+id 排序。 */
export function mergeMessages<
  T extends { event_id: string; origin_server_ts: number },
>(cached: readonly T[], fresh: readonly T[]): T[] {
  const map = new Map<string, T>();
  for (const m of cached) map.set(m.event_id, m);
  for (const m of fresh) map.set(m.event_id, m);
  return Array.from(map.values()).sort(
    (a, b) =>
      a.origin_server_ts - b.origin_server_ts ||
      (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0),
  );
}

// ── 容量（LRU 逐出）────────────────────────────────────────────────

/** 单房间只留最近 keep 条（逐更早）。
 *
 * 服务端已按 500 条截断；keep ≥ 500 时无需额外写（默认 2000 → no-op）。 */
export async function pruneRoom(
  account: string,
  roomId: string,
  keep: number = CHAT_CACHE_ROOM_KEEP,
): Promise<void> {
  const limit = Math.max(0, Math.trunc(keep));
  if (!roomId || limit >= CHAT_LIMIT) return;
  const key = cacheKey(account, roomId);
  await enqueue(key, async () => {
    const win = await loadWindow(account, roomId);
    if (!win || win.messages.length <= limit) return;
    const next: ChatWindow = {
      messages: limit === 0 ? [] : win.messages.slice(-limit),
      end: win.end,
    };
    remember(key, next);
    await putWindow(roomId, next);
  });
}

/** 房间级容量整理（服务端 30 房 / 64MB 策略为权威）。
 *
 * maxRooms 保留参数只为调用方语义（前端常量）；服务端不接受覆盖。
 * 整理后清空内存窗口——被淘汰的房间下次不再凭旧内存窗口回写复活。 */
export async function pruneAll(maxRooms: number = CHAT_CACHE_ROOMS_MAX): Promise<void> {
  void maxRooms;
  try {
    await requestJson(`${STORAGE_BASE}/prune`, { method: "POST" });
    windows.clear();
  } catch {
    /* 整理失败静默（缓存加速层） */
  }
}

// ── 已读位点（仅会话内存；设计未要求落盘）────────────────────────────

export async function setLastRead(
  account: string,
  roomId: string,
  ts: number,
): Promise<void> {
  if (!roomId) return;
  lastRead.set(cacheKey(account, roomId), ts);
}

export async function getLastRead(
  account: string,
  roomId: string,
): Promise<number | null> {
  if (!roomId) return null;
  return lastRead.get(cacheKey(account, roomId)) ?? null;
}
