// 本地聊天记录缓存（插件后端 SQLite，设计「QwenPaw插件存储与缓存」§3/§4/§6）：
// 打开房间先见旧消息（离线可读），「加载原消息」优先在本地找目标（零网络），
// /context 结果也落本地且**永久保留**（用户裁决：点过「加载原消息」后不再加载）。
//
// 数据面（前端不直接读写磁盘，浏览器沙箱）：
// · 后端 `GET/PUT/DELETE /agentteams-proxy/storage/chat/{roomId}` →
//   `<workspace>/.qwenpaw/agentteams/cache/chat.db`（SQLite 单库，按 event_id
//   增量 upsert；服务端不按房间截断历史，只在库 >2GB 时按房间 LRU 整房淘汰）；
// · GET 默认最近 500 条；带 `?event_id=&before=&after=` 取目标窗口
//   （深历史定位只传片段，不拉整窗）；
// · `POST …/storage/prune` 做全局 LRU 整理；
// · 本模块保留每个账号+房间的**内存窗口**（同房多次读写不重复走网络），
//   账号只用于内存键——磁盘按 room 存（与设计一致）；
// · 已读位点设计未要求落盘 → 仅内存 Map（进程重启即失效，仅离线首屏用）。
//
// 纪律：
// · 只缓存消息 JSON（含 mxc URL），不缓存附件二进制；
// · 所有读写失败静默（缓存是加速层，绝不能把聊天页带崩）；
// · 按 event_id upsert：旧记录里已有的 edited/pending/failed 标记不被
//   缺字段的新载荷抹掉（本会话内存里有的字段优先保留）；
// · 写只发本批增量（服务端 upsert，绝不整窗覆盖——深历史不会因新消息
//   涌入而被挤掉）；
// · 同房写串行（并发 SSE 落盘不互相覆盖）。
import type { RoomMessage } from "../api";
import { requestJson } from "../api/shared";

/** 默认账号键（config 未就绪 / 未登录时的兜底）。 */
export const CHAT_CACHE_DEFAULT_ACCOUNT = "default";
/** getRecent 默认条数（首屏缓存窗）。 */
export const CHAT_CACHE_RECENT = 50;
/** 内存窗口上限（会话级；服务端永久保留，这里只约束内存占用）。 */
export const CHAT_CACHE_ROOM_KEEP = 2000;
/** pruneAll：保留参数只为调用方语义（服务端策略为权威，见 pruneAll）。 */
export const CHAT_CACHE_ROOMS_MAX = 30;

/** 单次 GET 窗口上限（后端 MAX_CHAT_MESSAGES 同口径；非历史保留上限）。 */
const CHAT_LIMIT = 500;
/** 服务端按 event 取窗口的默认半径（与「加载原消息」注入窗口一致）。 */
const WINDOW_RADIUS = 25;
const STORAGE_BASE = "/agentteams-proxy/storage";
const EMPTY_WINDOW: ChatWindow = { messages: [], end: null, complete: true };

interface ChatWindow {
  messages: RoomMessage[];
  /** Matrix /messages 更旧方向游标（null = 无更早历史/未缓存）。 */
  end: string | null;
  /** 是否等于库里的整窗（false = 只含本会话见过的片段，读时向库补齐）。 */
  complete?: boolean;
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
/** 稀疏窗口：按 event 按需取回的片段（深历史定位用，不与首屏窗口混用）。 */
const sparse = new Map<string, RoomMessage[]>();
/** 已读位点：设计未要求落盘，仅会话内存（离线首屏用）。 */
const lastRead = new Map<string, number>();
/** 同房写串行链（并发写不互相覆盖）。 */
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

function toWindow(payload: unknown): ChatWindow | null {
  const p = payload as { messages?: unknown; end?: unknown } | null;
  if (!p || !Array.isArray(p.messages)) return null;
  return {
    messages: (p.messages as unknown[]).filter(isMessage).sort(byTsThenId),
    end: typeof p.end === "string" ? p.end : null,
  };
}

/** 后端最近整窗读取（500 条）；失败 → null（不缓存失败，后续可重试）。 */
async function fetchWindow(roomId: string): Promise<ChatWindow | null> {
  try {
    const win = toWindow(
      await requestJson(`${chatUrl(roomId)}?limit=${CHAT_LIMIT}`),
    );
    if (!win) return null;
    return {
      messages: win.messages.slice(-CHAT_LIMIT),
      end: win.end,
      complete: true,
    };
  } catch {
    return null;
  }
}

/** 后端按 event 取窗口（深历史定位专用，免拉整窗）；失败/未命中 → null。 */
async function fetchWindowAround(
  roomId: string,
  eventId: string,
  before: number,
  after: number,
): Promise<ChatWindow | null> {
  try {
    const query =
      `event_id=${encodeURIComponent(eventId)}` +
      `&before=${Math.max(0, Math.trunc(before))}` +
      `&after=${Math.max(0, Math.trunc(after))}`;
    const win = toWindow(await requestJson(`${chatUrl(roomId)}?${query}`));
    return win && win.messages.length > 0 ? win : null;
  } catch {
    return null;
  }
}

/** 读整窗（内存整窗命中 → 直接用；否则向后端补齐一次；读失败 → null）。
 *
 * `complete=false` 的内存窗口只是「本会话见过的片段」（增量写建立），
 * 不能当整窗用——必须向库补齐，否则离线首屏只剩几条。
 * null 与「空窗口」严格区分：null = 后端不可用/失败，调用方不得据此
 * 当作「库里没消息」。 */
async function loadWindow(account: string, roomId: string): Promise<ChatWindow | null> {
  if (!roomId) return EMPTY_WINDOW;
  const key = cacheKey(account, roomId);
  const hit = windows.get(key);
  if (hit?.complete) {
    remember(key, hit); // 命中刷新 LRU 次序
    return hit;
  }
  const fresh = await fetchWindow(roomId);
  if (!fresh) return hit ?? null;
  const next: ChatWindow = hit
    ? {
        messages: mergeInto(hit.messages, fresh.messages, CHAT_CACHE_ROOM_KEEP),
        end: fresh.end ?? hit.end,
        complete: true,
      }
    : fresh;
  remember(key, next);
  return next;
}

/** 增量写回（服务端按 event_id upsert；失败静默）。 */
async function putBatch(
  roomId: string,
  messages: readonly RoomMessage[],
  end?: string | null,
): Promise<void> {
  try {
    await requestJson(chatUrl(roomId), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, end: end ?? undefined }),
    });
  } catch {
    /* 缓存写入失败静默——聊天主流程不受影响 */
  }
}

function mergeInto(
  base: readonly RoomMessage[],
  incoming: readonly RoomMessage[],
  cap: number,
): RoomMessage[] {
  const map = new Map<string, RoomMessage>();
  for (const m of base) map.set(m.event_id, m);
  for (const m of incoming) {
    const old = map.get(m.event_id);
    // 新载荷缺字段时保留本地标记（edited/pending/failed 不在服务端载荷里）
    map.set(m.event_id, old ? { ...old, ...m } : m);
  }
  const merged = Array.from(map.values()).sort(byTsThenId);
  return merged.length > cap ? merged.slice(-cap) : merged;
}

// ── 消息 ───────────────────────────────────────────────────────────

/** upsert 一批消息（按 event_id；只发本批增量，不整窗覆盖）。
 *
 * 内存窗口里有同 id 的旧记录时保留其本地标记（edited/pending/failed）。
 */
export async function putMessages(
  account: string,
  roomId: string,
  msgs: readonly RoomMessage[],
): Promise<void> {
  const incoming = (msgs || []).filter(isMessage);
  if (!roomId || incoming.length === 0) return;
  const key = cacheKey(account, roomId);
  await enqueue(key, async () => {
    const prev = windows.get(key);
    const oldBy = new Map((prev?.messages ?? []).map((m) => [m.event_id, m]));
    const outgoing = incoming.map((m) => {
      const old = oldBy.get(m.event_id);
      return old ? { ...old, ...m } : m;
    });
    // 内存窗口（会话级）：合并增量 + 上限约束；end 维持既有值。
    // 无既有窗口 → 片段标记 complete=false（读整窗时再向库补齐）。
    const merged = mergeInto(prev?.messages ?? [], outgoing, CHAT_CACHE_ROOM_KEEP);
    if (prev || merged.length) {
      remember(key, {
        messages: merged,
        end: prev?.end ?? null,
        complete: prev?.complete === true,
      });
    }
    const sp = sparse.get(key);
    if (sp) sparse.set(key, mergeInto(sp, outgoing, CHAT_CACHE_ROOM_KEEP));
    await putBatch(roomId, outgoing, prev?.end);
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

function sliceAround(
  messages: readonly RoomMessage[],
  index: number,
  before: number,
  after: number,
): RoomMessage[] {
  const start = Math.max(0, index - Math.max(0, before));
  const end = Math.min(messages.length, index + Math.max(0, after) + 1);
  return messages.slice(start, end);
}

/** 目标消息前后各 N 条（升序，含目标）；未命中返回 []。
 *
 * 命中路径（全部不碰 Matrix 网络）：
 * ① 本会话内存窗口 → 直接切片；
 * ② 稀疏窗口（本会话此前按 event 取回的片段）→ 切片；
 * ③ 后端 `GET …?event_id=&before=&after=`（SQLite 按 ts 取两侧）→ 存稀疏窗口。
 * /context 落库后，第二次 locate 走 ①/② 零网络。 */
export async function getWindow(
  account: string,
  roomId: string,
  eventId: string,
  before = WINDOW_RADIUS,
  after = WINDOW_RADIUS,
): Promise<RoomMessage[]> {
  if (!roomId || !eventId) return [];
  const key = cacheKey(account, roomId);
  const win = windows.get(key);
  if (win) {
    remember(key, win); // 命中刷新 LRU 次序
    const idx = win.messages.findIndex((m) => m.event_id === eventId);
    if (idx >= 0) return sliceAround(win.messages, idx, before, after);
  }
  const sp = sparse.get(key);
  const spIdx = sp ? sp.findIndex((m) => m.event_id === eventId) : -1;
  if (sp && spIdx >= 0) {
    sparse.delete(key);
    sparse.set(key, sp); // LRU 次序
    return sliceAround(sp, spIdx, before, after);
  }
  const around = await fetchWindowAround(roomId, eventId, before, after);
  if (!around) return [];
  sparse.delete(key);
  sparse.set(key, around.messages.slice(-CHAT_CACHE_ROOM_KEEP));
  const idx = around.messages.findIndex((m) => m.event_id === eventId);
  return idx >= 0 ? sliceAround(around.messages, idx, before, after) : [];
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

// ── 容量（全局 LRU）────────────────────────────────────────────────

/** 单房间条数裁剪——**已退役**（用户裁决：历史永久保留）。
 *
 * 保留导出只为调用方/测试兼容：服务端不再按房间截断，也没有「删消息」
 * 路由；历史只在库 >2GB 时按房间 LRU 整房淘汰（`pruneAll`）。
 */
export async function pruneRoom(
  account: string,
  roomId: string,
  keep: number = CHAT_CACHE_ROOM_KEEP,
): Promise<void> {
  void account;
  void roomId;
  void keep;
}

/** 全局容量整理（服务端 2GB / 房间 LRU 策略为权威）。
 *
 * maxRooms 保留参数只为调用方语义（前端常量）；服务端不接受覆盖。
 * 整理后清空内存窗口/稀疏窗口——被淘汰的房间下次不再凭旧内存窗口回写复活。 */
export async function pruneAll(maxRooms: number = CHAT_CACHE_ROOMS_MAX): Promise<void> {
  void maxRooms;
  try {
    await requestJson(`${STORAGE_BASE}/prune`, { method: "POST" });
    windows.clear();
    sparse.clear();
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
