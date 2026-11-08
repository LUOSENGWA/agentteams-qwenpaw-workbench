// 本地聊天缓存（lib/chatCache）SQLite 后端适配器测试——mock 宿主 fetch +
// 假 SQLite（Map<roomId, Map<event_id, msg>>，upsert 语义）：增量落库不截断、
// 按 event 取窗口（稀疏缓存）、/context 落库后第二次 locate 零网络、
// 写失败静默。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getLastRead,
  getRange,
  getRecent,
  getWindow,
  mergeMessages,
  pruneAll,
  pruneRoom,
  putMessages,
  setLastRead,
} from "../src/lib/chatCache";
import type { RoomMessage } from "../src/api";

const BASE = "/agentteams-proxy/storage";
const CHAT = `${BASE}/chat/`;
const LIMIT = 500;

function msg(
  id: string,
  ts: number,
  extra: Partial<RoomMessage> = {},
): RoomMessage {
  return {
    event_id: id,
    sender: "@u:hs",
    body: `body-${id}`,
    msgtype: "m.text",
    origin_server_ts: ts,
    ...extra,
  };
}

/** 假 SQLite：`messages` 按 event_id upsert；`rooms` 存游标。 */
const messages = new Map<string, Map<string, RoomMessage>>();
const cursors = new Map<string, string | null>();
let requests: { method: string; path: string; body?: unknown }[] = [];
let failAll = false;
let pruneCalls = 0;

function roomRows(roomId: string): RoomMessage[] {
  return Array.from(messages.get(roomId)?.values() ?? []).sort(
    (a, b) =>
      (Number(a.origin_server_ts) || 0) - (Number(b.origin_server_ts) || 0) ||
      (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0),
  );
}

function seedDisk(roomId: string, msgs: RoomMessage[], end: string | null = null): void {
  const rows = new Map<string, RoomMessage>();
  for (const m of msgs) rows.set(m.event_id, m);
  messages.set(roomId, rows);
  cursors.set(roomId, end);
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn(async (path: string, init?: RequestInit): Promise<Response> => {
  const method = (init?.method || "GET").toUpperCase();
  let body: unknown;
  if (typeof init?.body === "string" && init.body) {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = null;
    }
  }
  requests.push({ method, path, body });
  if (failAll) return json({ detail: "boom" }, 500);

  const [rawPath, rawQuery = ""] = path.split("?");
  const query = new URLSearchParams(rawQuery);
  if (rawPath === `${BASE}/prune` && method === "POST") {
    pruneCalls += 1;
    return json({ removedFiles: 0, freedBytes: 0 });
  }
  if (rawPath.startsWith(CHAT)) {
    const roomId = decodeURIComponent(rawPath.slice(CHAT.length));
    if (method === "GET") {
      const all = roomRows(roomId);
      const end = cursors.get(roomId) ?? null;
      const target = query.get("event_id");
      if (target) {
        // 服务端按目标 ts 取两侧窗口（chat_db.get_window 同口径）
        const idx = all.findIndex((m) => m.event_id === target);
        if (idx < 0) return json({ messages: [], end });
        const before = Math.max(0, Number(query.get("before") ?? 25));
        const after = Math.max(0, Number(query.get("after") ?? 25));
        return json({
          messages: all.slice(Math.max(0, idx - before), idx + after + 1),
          end,
        });
      }
      const limit = Number(query.get("limit") ?? LIMIT);
      return json({ messages: limit > 0 ? all.slice(-limit) : [], end });
    }
    if (method === "PUT") {
      const payload = (body || {}) as { messages?: RoomMessage[]; end?: string };
      const incoming = Array.isArray(payload.messages) ? payload.messages : [];
      const rows = messages.get(roomId) ?? new Map<string, RoomMessage>();
      let count = 0;
      for (const m of incoming) {
        if (!m || typeof m.event_id !== "string" || !m.event_id) continue;
        if (!rows.has(m.event_id)) count += 1;
        rows.set(m.event_id, m);
      }
      messages.set(roomId, rows);
      if (payload.end != null) cursors.set(roomId, payload.end);
      else if (!cursors.has(roomId)) cursors.set(roomId, null);
      return json({ ok: true, count });
    }
    if (method === "DELETE") {
      messages.delete(roomId);
      cursors.delete(roomId);
      return json({ ok: true });
    }
  }
  return json({ detail: "not found" }, 404);
});

beforeEach(() => {
  messages.clear();
  cursors.clear();
  requests = [];
  failAll = false;
  pruneCalls = 0;
  fetchMock.mockClear();
  // requestJsonFull 走宿主 fetch（node 无 window → 手工搭最小宿主）。
  (globalThis as unknown as { window: unknown }).window = {
    QwenPaw: {
      host: {
        fetch: fetchMock,
        getApiUrl: (p: string) => p,
        getApiToken: () => "",
      },
    },
  };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

function requestsFor(room: string, method: string) {
  const path = `${CHAT}${encodeURIComponent(room)}`;
  return requests.filter((r) => r.path.startsWith(path) && r.method === method);
}

describe("chatCache: SQLite 后端（增量 upsert / 读回）", () => {
  it("PUT upserts by event_id (no duplicates, newer payload wins)", async () => {
    const acct = "acct-upsert";
    const room = "!r-upsert:hs";
    await putMessages(acct, room, [msg("$a", 100), msg("$b", 200)]);
    await putMessages(acct, room, [
      { ...msg("$a", 100), body: "edited-body" },
      msg("$c", 300),
    ]);
    const got = await getRecent(acct, room, 10);
    expect(got.map((m) => m.event_id)).toEqual(["$a", "$b", "$c"]);
    expect(got[0].body).toBe("edited-body");
    // 库内 3 条（同 id 覆盖，不重复）
    expect(Array.from(messages.get(room)?.keys() ?? [])).toEqual(["$a", "$b", "$c"]);
  });

  it("keeps edited/pending flags when the fresh payload omits them", async () => {
    const acct = "acct-flags";
    const room = "!r-flags:hs";
    await putMessages(acct, room, [msg("$a", 100, { edited: true, pending: true })]);
    await putMessages(acct, room, [msg("$a", 100, { body: "server-body" })]);
    const [got] = await getRecent(acct, room, 10);
    expect(got.body).toBe("server-body");
    expect(got.edited).toBe(true);
    expect(got.pending).toBe(true);
    // 落库载荷也保留了本地标记（会话内存里有的字段优先）
    expect(messages.get(room)?.get("$a")?.edited).toBe(true);
  });

  it("writes the full batch (no 500 truncation) and reads the newest window", async () => {
    const acct = "acct-cap";
    const room = "!r-cap:hs";
    const all = Array.from({ length: 1200 }, (_, i) => msg(`$m${i}`, i));
    await putMessages(acct, room, all);
    expect(messages.get(room)?.size).toBe(1200); // 永久保留
    // 内存窗口上限 2000 → 1200 条全量可读（不是 500 窗口）
    const got = await getRecent(acct, room, 1200);
    expect(got.length).toBe(1200);
    expect(got[got.length - 1].event_id).toBe("$m1199");
  });

  it("server GET window is sliced to 500 by default", async () => {
    const acct = "acct-window";
    const room = "!r-window:hs";
    seedDisk(room, Array.from({ length: 600 }, (_, i) => msg(`$m${i}`, i)));
    const got = await getRecent(acct, room, 500);
    expect(got.length).toBe(LIMIT);
    expect(got[0].event_id).toBe("$m100");
  });

  it("getRecent returns ascending ts order, newest window last", async () => {
    const acct = "acct-recent";
    const room = "!r-recent:hs";
    await putMessages(acct, room, [
      msg("$c", 300),
      msg("$a", 100),
      msg("$e", 500),
      msg("$b", 200),
      msg("$d", 400),
    ]);
    const got = await getRecent(acct, room, 3);
    expect(got.map((m) => m.event_id)).toEqual(["$c", "$d", "$e"]);
  });

  it("loads the whole window once, then slices in memory", async () => {
    const acct = "acct-slice";
    const room = "!r-slice:hs";
    seedDisk(room, Array.from({ length: 10 }, (_, i) => msg(`$m${i}`, 100 + i)), "e10");
    const recent = await getRecent(acct, room, 3);
    expect(recent.map((m) => m.event_id)).toEqual(["$m7", "$m8", "$m9"]);
    const range = await getRange(acct, room, 105, 2);
    expect(range.map((m) => m.event_id)).toEqual(["$m3", "$m4"]);
    const win = await getWindow(acct, room, "$m5", 2, 2);
    expect(win.map((m) => m.event_id)).toEqual(["$m3", "$m4", "$m5", "$m6", "$m7"]);
    // 整窗只 GET 一次（其余走内存）
    expect(requestsFor(room, "GET").length).toBe(1);
    expect(await getWindow(acct, room, "$missing", 2, 2)).toEqual([]);
  });

  it("does not cache failed reads (retry hits the backend again)", async () => {
    const acct = "acct-retry";
    const room = "!r-retry:hs";
    failAll = true;
    expect(await getRecent(acct, room, 5)).toEqual([]);
    failAll = false;
    seedDisk(room, [msg("$a", 100)]);
    expect((await getRecent(acct, room, 5)).map((m) => m.event_id)).toEqual(["$a"]);
    expect(requestsFor(room, "GET").length).toBe(2);
  });

  it("write/read failures are silent (return empty, never throw)", async () => {
    const acct = "acct-fail";
    const room = "!r-fail:hs";
    failAll = true;
    await expect(putMessages(acct, room, [msg("$a", 100)])).resolves.toBeUndefined();
    expect(await getRecent(acct, room, 10)).toEqual([]);
    expect(await getRange(acct, room, 1000, 10)).toEqual([]);
    expect(await getWindow(acct, room, "$a", 2, 2)).toEqual([]);
  });
});

describe("chatCache: 深历史定位（稀疏窗口）", () => {
  it("fetches a target window via ?event_id= (not the whole room) once", async () => {
    const acct = "acct-sparse";
    const room = "!r-sparse:hs";
    seedDisk(
      room,
      Array.from({ length: 3000 }, (_, i) => msg(`$m${i}`, 1000 + i)),
      "e3000",
    );
    const win = await getWindow(acct, room, "$m10", 2, 2);
    expect(win.map((m) => m.event_id)).toEqual(["$m8", "$m9", "$m10", "$m11", "$m12"]);
    const gets = requestsFor(room, "GET");
    expect(gets.length).toBe(1);
    expect(gets[0].path).toContain("event_id=");
    expect(gets[0].path).toContain("before=2");
    expect(gets[0].path).toContain("after=2");
    // 第二次：稀疏窗口命中 → 零网络
    await getWindow(acct, room, "$m10", 2, 2);
    expect(requestsFor(room, "GET").length).toBe(1);
  });

  it("context 结果落库后第二次 locate 零网络", async () => {
    const acct = "acct-locate";
    const room = "!r-locate:hs";
    // ① 库里没有目标 → 一次按 event 的 GET（返回空）→ 调用方转向 /context
    expect(await getWindow(acct, room, "$old", 1, 1)).toEqual([]);
    const gets = requestsFor(room, "GET").length;
    expect(gets).toBe(1);
    // ② /context 命中：before/target/after 全部落库（refreshMessages 同款调用）
    const events = [msg("$before", 100), msg("$old", 200), msg("$after", 300)];
    await putMessages(acct, room, events);
    expect(requestsFor(room, "PUT").length).toBe(1);
    expect(Array.from(messages.get(room)?.keys() ?? []).sort()).toEqual([
      "$after",
      "$before",
      "$old",
    ]);
    // ③ 第二次 locate：内存命中 → 不再发 GET（零网络）
    const got = await getWindow(acct, room, "$old", 1, 1);
    expect(got.map((m) => m.event_id)).toEqual(["$before", "$old", "$after"]);
    expect(requestsFor(room, "GET").length).toBe(gets);
  });
});

describe("chatCache: mergeMessages", () => {
  it("dedupes by event_id, fresh overrides cached, stable ts+id order", () => {
    const merged = mergeMessages(
      [msg("$b", 200), msg("$a", 100)],
      [msg("$b", 200, { body: "fresh" }), msg("$c", 100)],
    );
    expect(merged.map((m) => m.event_id)).toEqual(["$a", "$c", "$b"]);
    expect(merged[2].body).toBe("fresh");
  });
});

describe("chatCache: budgets", () => {
  it("pruneRoom is a no-op (history is kept permanently)", async () => {
    const acct = "acct-prune-room";
    const room = "!r-prune-room:hs";
    await putMessages(acct, room, [msg("$a", 100), msg("$b", 200)]);
    const before = requestsFor(room, "PUT").length;
    await pruneRoom(acct, room, 1); // 旧「按房间裁剪」已退役
    await pruneRoom(acct, room);
    expect(requestsFor(room, "PUT").length).toBe(before);
    expect(await getRecent(acct, room, 10)).toHaveLength(2);
  });

  it("pruneAll asks the backend to prune and clears in-memory windows", async () => {
    const acct = "acct-prune-all";
    const room = "!r-prune-all:hs";
    seedDisk(room, [msg("$a", 100)]);
    expect(await getRecent(acct, room, 5)).toHaveLength(1);
    expect(requestsFor(room, "GET").length).toBe(1);
    await pruneAll();
    expect(pruneCalls).toBe(1);
    // 内存窗口已清 → 下次读重新走 GET（被淘汰房间不靠旧内存复活）
    expect(await getRecent(acct, room, 5)).toHaveLength(1);
    expect(requestsFor(room, "GET").length).toBe(2);
    failAll = true;
    await expect(pruneAll()).resolves.toBeUndefined();
  });
});

describe("chatCache: last read", () => {
  it("keeps the last-read position in session memory per account+room", async () => {
    await setLastRead("acct-lr", "!r-lr:hs", 1234);
    expect(await getLastRead("acct-lr", "!r-lr:hs")).toBe(1234);
    expect(await getLastRead("acct-lr", "!other-lr:hs")).toBeNull();
    await setLastRead("acct-lr", "!r-lr:hs", 9999);
    expect(await getLastRead("acct-lr", "!r-lr:hs")).toBe(9999);
  });
});
