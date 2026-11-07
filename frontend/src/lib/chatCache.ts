// 本地聊天记录缓存（IndexedDB）：打开房间先见旧消息（离线可读），
// 「加载原消息」优先在本地找目标（零网络），/context 结果也落本地。
//
// 存储布局：
// · 库 `agentteams-chat`（version 1）；object store `messages`（keyPath `id`），
//   索引 `room_ts`（[roomId, ts]）与 `account`（跨账号隔离）；
// · object store `lastRead`（keyPath `key`）——已读位点（小对象，不放大消息）。
// · 无 IndexedDB（测试 / node / 隐私模式打开失败）→ 同 API 的内存 Map 适配器
//   （prune* 语义一致；进程重启即失效，不做 localStorage 大消息兜底）。
//
// 纪律：
// · 只缓存消息 JSON（含 mxc URL），不缓存附件二进制；
// · 所有读写失败静默（缓存是加速层，绝不能把聊天页带崩）；
// · 按 event_id upsert，旧记录里已有的 edited/pending/failed 标记不被
//   缺字段的新载荷抹掉（`{...old, ...new}`）。
import type { RoomMessage } from "../api";

const DB_NAME = "agentteams-chat";
const DB_VERSION = 1;
const MESSAGES = "messages";
const LAST_READ = "lastRead";

/** 默认账号键（config 未就绪 / 未登录时的兜底）。 */
export const CHAT_CACHE_DEFAULT_ACCOUNT = "default";
/** getRecent 默认条数（首屏缓存窗）。 */
export const CHAT_CACHE_RECENT = 50;
/** 单房间保留条数。 */
export const CHAT_CACHE_ROOM_KEEP = 2000;
/** pruneAll：每账号保留房间数。 */
export const CHAT_CACHE_ROOMS_MAX = 30;

/** 单条缓存记录（msg 原样存 RoomMessage，可直接回渲染）。 */
interface ChatRecord {
  id: string;
  account: string;
  roomId: string;
  eventId: string;
  ts: number;
  msg: RoomMessage;
}

interface LastReadRecord {
  key: string;
  ts: number;
}

function normAccount(account: string): string {
  return account || CHAT_CACHE_DEFAULT_ACCOUNT;
}

/** 账号 + 房间的缓存键（记录 id = `${cacheKey}:${eventId}`）。 */
export function cacheKey(account: string, roomId: string): string {
  return `${normAccount(account)}:${roomId}`;
}

function recordId(account: string, roomId: string, eventId: string): string {
  return `${cacheKey(account, roomId)}:${eventId}`;
}

function readId(account: string, roomId: string): string {
  return cacheKey(account, roomId);
}

function byTsThenId(a: { ts: number; eventId: string }, b: { ts: number; eventId: string }): number {
  return a.ts - b.ts || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0);
}

// ── 存储适配器 ─────────────────────────────────────────────────────
interface ChatStore {
  put(records: ChatRecord[]): Promise<void>;
  get(id: string): Promise<ChatRecord | undefined>;
  roomRecords(roomId: string): Promise<ChatRecord[]>;
  /** ts < beforeTs 的最近 limit 条（账号过滤在 limit 之前，跨账号同房不串窗）。 */
  rangeBefore(
    account: string,
    roomId: string,
    beforeTs: number,
    limit: number,
  ): Promise<ChatRecord[]>;
  all(): Promise<ChatRecord[]>;
  deleteIds(ids: string[]): Promise<void>;
  setLastRead(key: string, ts: number): Promise<void>;
  getLastRead(key: string): Promise<number | null>;
}

/** 内存适配器（无 IndexedDB：node/测试/隐私模式）——语义与 IDB 版对齐。 */
class MemoryStore implements ChatStore {
  private readonly map = new Map<string, ChatRecord>();
  private readonly lastRead = new Map<string, number>();

  async put(records: ChatRecord[]): Promise<void> {
    for (const r of records) this.map.set(r.id, r);
  }

  async get(id: string): Promise<ChatRecord | undefined> {
    return this.map.get(id);
  }

  async roomRecords(roomId: string): Promise<ChatRecord[]> {
    const out: ChatRecord[] = [];
    for (const r of this.map.values()) if (r.roomId === roomId) out.push(r);
    return out.sort(byTsThenId);
  }

  async rangeBefore(
    account: string,
    roomId: string,
    beforeTs: number,
    limit: number,
  ): Promise<ChatRecord[]> {
    const rows = (await this.roomRecords(roomId)).filter(
      (r) => r.account === account && r.ts < beforeTs,
    );
    return limit > 0 ? rows.slice(Math.max(0, rows.length - limit)) : [];
  }

  async all(): Promise<ChatRecord[]> {
    return Array.from(this.map.values());
  }

  async deleteIds(ids: string[]): Promise<void> {
    for (const id of ids) this.map.delete(id);
  }

  async setLastRead(key: string, ts: number): Promise<void> {
    this.lastRead.set(key, ts);
  }

  async getLastRead(key: string): Promise<number | null> {
    return this.lastRead.get(key) ?? null;
  }
}

function requestDone<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** IndexedDB 适配器。 */
class IdbStore implements ChatStore {
  constructor(private readonly db: IDBDatabase) {}

  async put(records: ChatRecord[]): Promise<void> {
    if (records.length === 0) return;
    const tx = this.db.transaction(MESSAGES, "readwrite");
    const store = tx.objectStore(MESSAGES);
    for (const r of records) store.put(r);
    await txDone(tx);
  }

  async get(id: string): Promise<ChatRecord | undefined> {
    const tx = this.db.transaction(MESSAGES, "readonly");
    return requestDone(
      tx.objectStore(MESSAGES).get(id) as IDBRequest<ChatRecord | undefined>,
    );
  }

  async roomRecords(roomId: string): Promise<ChatRecord[]> {
    const tx = this.db.transaction(MESSAGES, "readonly");
    // [roomId, 0] … [roomId, []]：数组键大于任何数字键 → 覆盖该房全部 ts。
    const range = IDBKeyRange.bound([roomId, 0], [roomId, []]);
    const rows = await requestDone(
      tx.objectStore(MESSAGES).index("room_ts").getAll(range) as IDBRequest<ChatRecord[]>,
    );
    return rows.sort(byTsThenId);
  }

  async rangeBefore(
    account: string,
    roomId: string,
    beforeTs: number,
    limit: number,
  ): Promise<ChatRecord[]> {
    if (limit <= 0) return [];
    const tx = this.db.transaction(MESSAGES, "readonly");
    const range = IDBKeyRange.bound([roomId, 0], [roomId, beforeTs], false, true);
    const out: ChatRecord[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = tx
        .objectStore(MESSAGES)
        .index("room_ts")
        .openCursor(range, "prev");
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) {
          resolve();
          return;
        }
        const rec = cur.value as ChatRecord;
        // 账号过滤在 limit 之前（同房跨账号记录不占窗口名额）。
        if (rec.account === account) out.push(rec);
        if (out.length >= limit) {
          resolve();
          return;
        }
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
    return out.reverse();
  }

  async all(): Promise<ChatRecord[]> {
    const tx = this.db.transaction(MESSAGES, "readonly");
    return requestDone(
      tx.objectStore(MESSAGES).getAll() as IDBRequest<ChatRecord[]>,
    );
  }

  async deleteIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const tx = this.db.transaction(MESSAGES, "readwrite");
    const store = tx.objectStore(MESSAGES);
    for (const id of ids) store.delete(id);
    await txDone(tx);
  }

  async setLastRead(key: string, ts: number): Promise<void> {
    const tx = this.db.transaction(LAST_READ, "readwrite");
    tx.objectStore(LAST_READ).put({ key, ts } satisfies LastReadRecord);
    await txDone(tx);
  }

  async getLastRead(key: string): Promise<number | null> {
    const tx = this.db.transaction(LAST_READ, "readonly");
    const rec = await requestDone(
      tx.objectStore(LAST_READ).get(key) as IDBRequest<LastReadRecord | undefined>,
    );
    return rec ? rec.ts : null;
  }
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined" || indexedDB === null) {
      resolve(null);
      return;
    }
    let open: IDBOpenDBRequest;
    try {
      open = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    open.onupgradeneeded = () => {
      const db = open.result;
      const tx = open.transaction;
      const msgStore = db.objectStoreNames.contains(MESSAGES)
        ? tx?.objectStore(MESSAGES)
        : db.createObjectStore(MESSAGES, { keyPath: "id" });
      if (!msgStore) return;
      if (!msgStore.indexNames.contains("room_ts")) {
        msgStore.createIndex("room_ts", ["roomId", "ts"]);
      }
      if (!msgStore.indexNames.contains("account")) {
        msgStore.createIndex("account", "account");
      }
      if (!db.objectStoreNames.contains(LAST_READ)) {
        db.createObjectStore(LAST_READ, { keyPath: "key" });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => resolve(null);
    open.onblocked = () => resolve(null);
  });
}

let storePromise: Promise<ChatStore> | null = null;

function resolveStore(): Promise<ChatStore> {
  if (!storePromise) {
    storePromise = openDb().then((db) => (db ? new IdbStore(db) : new MemoryStore()));
  }
  return storePromise;
}

/** 缓存读写一律失败静默（加速层不能影响主流程）。 */
async function withStore<T>(fn: (s: ChatStore) => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn(await resolveStore());
  } catch {
    return fallback;
  }
}

function toMessages(rows: ChatRecord[], account: string, roomId: string): RoomMessage[] {
  const acc = normAccount(account);
  return rows
    .filter((r) => r.account === acc && r.roomId === roomId)
    .sort(byTsThenId)
    .map((r) => r.msg);
}

// ── 消息 ───────────────────────────────────────────────────────────

/** upsert 一批消息（按 event_id）。旧记录里的 edited/pending 等标记保留。 */
export async function putMessages(
  account: string,
  roomId: string,
  msgs: readonly RoomMessage[],
): Promise<void> {
  const acc = normAccount(account);
  const rows: ChatRecord[] = (msgs || [])
    .filter((m) => m && m.event_id)
    .map((m) => ({
      id: recordId(acc, roomId, m.event_id),
      account: acc,
      roomId,
      eventId: m.event_id,
      ts: Number(m.origin_server_ts) || 0,
      msg: m,
    }));
  if (rows.length === 0) return;
  await withStore(async (s) => {
    const existing = await Promise.all(rows.map((r) => s.get(r.id)));
    await s.put(
      rows.map((r, i) => {
        const old = existing[i];
        // 新载荷缺字段时保留本地标记（edited/pending/failed 不在服务端载荷里）
        return old ? { ...r, msg: { ...old.msg, ...r.msg } } : r;
      }),
    );
  }, undefined);
}

/** 最近 limit 条（ts 倒序取再正序返回）。 */
export async function getRecent(
  account: string,
  roomId: string,
  limit: number = CHAT_CACHE_RECENT,
): Promise<RoomMessage[]> {
  return withStore(async (s) => {
    const rows = await s.rangeBefore(
      normAccount(account),
      roomId,
      Number.MAX_SAFE_INTEGER,
      limit,
    );
    return toMessages(rows, account, roomId);
  }, []);
}

/** beforeTs 之前（严格小）的最近 limit 条，正序返回。 */
export async function getRange(
  account: string,
  roomId: string,
  beforeTs: number,
  limit: number,
): Promise<RoomMessage[]> {
  return withStore(async (s) => {
    const rows = await s.rangeBefore(normAccount(account), roomId, beforeTs, limit);
    return toMessages(rows, account, roomId);
  }, []);
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
  return withStore(async (s) => {
    const rows = await s.roomRecords(roomId);
    const msgs = toMessages(rows, account, roomId);
    const idx = msgs.findIndex((m) => m.event_id === eventId);
    if (idx < 0) return [];
    const start = Math.max(0, idx - Math.max(0, before));
    const end = Math.min(msgs.length, idx + Math.max(0, after) + 1);
    return msgs.slice(start, end);
  }, []);
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

// ── 预算（LRU 逐出）──────────────────────────────────────────────

/** 单房间只留最近 keep 条（逐更早）。 */
export async function pruneRoom(
  account: string,
  roomId: string,
  keep: number = CHAT_CACHE_ROOM_KEEP,
): Promise<void> {
  const acc = normAccount(account);
  await withStore(async (s) => {
    const rows = (await s.roomRecords(roomId)).filter((r) => r.account === acc);
    if (rows.length <= keep) return;
    rows.sort(byTsThenId);
    await s.deleteIds(rows.slice(0, rows.length - keep).map((r) => r.id));
  }, undefined);
}

/** 每账号最多保留 maxRooms 个房间（房间按 lastTs LRU 逐出）。 */
export async function pruneAll(maxRooms: number = CHAT_CACHE_ROOMS_MAX): Promise<void> {
  await withStore(async (s) => {
    const rows = await s.all();
    const byAccount = new Map<string, Map<string, number>>();
    for (const r of rows) {
      let rooms = byAccount.get(r.account);
      if (!rooms) {
        rooms = new Map<string, number>();
        byAccount.set(r.account, rooms);
      }
      rooms.set(r.roomId, Math.max(rooms.get(r.roomId) || 0, r.ts));
    }
    const stale = new Map<string, Set<string>>();
    for (const [account, rooms] of byAccount) {
      if (rooms.size <= maxRooms) continue;
      const ordered = Array.from(rooms.entries()).sort((a, b) => a[1] - b[1]);
      const drop = new Set(
        ordered.slice(0, rooms.size - maxRooms).map(([roomId]) => roomId),
      );
      stale.set(account, drop);
    }
    if (stale.size === 0) return;
    const ids = rows
      .filter((r) => stale.get(r.account)?.has(r.roomId))
      .map((r) => r.id);
    await s.deleteIds(ids);
  }, undefined);
}

// ── 已读位点 ─────────────────────────────────────────────────────

export async function setLastRead(
  account: string,
  roomId: string,
  ts: number,
): Promise<void> {
  await withStore((s) => s.setLastRead(readId(account, roomId), ts), undefined);
}

export async function getLastRead(
  account: string,
  roomId: string,
): Promise<number | null> {
  return withStore((s) => s.getLastRead(readId(account, roomId)), null);
}
