// 本地聊天缓存（lib/chatCache）后端磁盘适配器测试——mock 宿主 fetch +
// 假磁盘（Map<roomId, {messages, end}>）：PUT 合并去重 / GET 整窗切片 /
// 写失败静默 / prune 路由 / 已读位点内存语义。

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

interface Win {
  messages: RoomMessage[];
  end: string | null;
}

/** 假磁盘：与后端 cache/chat/<roomId>.json 同形（整窗覆盖 + 500 截断）。 */
const disk = new Map<string, Win>();
let requests: { method: string; path: string; body?: unknown }[] = [];
let failAll = false;
let pruneCalls = 0;

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

  const [rawPath] = path.split("?");
  if (rawPath === `${BASE}/prune` && method === "POST") {
    pruneCalls += 1;
    return json({ removedFiles: 0, freedBytes: 0 });
  }
  if (rawPath.startsWith(CHAT)) {
    const roomId = decodeURIComponent(rawPath.slice(CHAT.length));
    if (method === "GET") {
      const win = disk.get(roomId) ?? { messages: [], end: null };
      const limit = Number(new URLSearchParams(path.split("?")[1] || "").get("limit") || LIMIT);
      const messages = limit > 0 ? win.messages.slice(-limit) : [];
      return json({ messages, end: win.end });
    }
    if (method === "PUT") {
      const payload = (body || {}) as { messages?: RoomMessage[]; end?: string };
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const capped = messages.slice(-LIMIT);
      disk.set(roomId, { messages: capped, end: payload.end ?? null });
      return json({ ok: true, count: capped.length });
    }
    if (method === "DELETE") {
      disk.delete(roomId);
      return json({ ok: true });
    }
  }
  return json({ detail: "not found" }, 404);
});

beforeEach(() => {
  disk.clear();
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

describe("chatCache: 后端磁盘适配器（PUT/GET）", () => {
  it("PUT merges by event_id (newer payload wins, no duplicates)", async () => {
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
    // 落盘 = 合并后的整窗（不是两次覆盖的残片）
    expect(disk.get(room)?.messages.map((m) => m.event_id)).toEqual([
      "$a",
      "$b",
      "$c",
    ]);
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
  });

  it("server truncates to 500 and client keeps the newest window", async () => {
    const acct = "acct-cap";
    const room = "!r-cap:hs";
    const all = Array.from({ length: 600 }, (_, i) => msg(`$m${i}`, i));
    await putMessages(acct, room, all);
    expect(disk.get(room)?.messages.length).toBe(LIMIT);
    const got = await getRecent(acct, room, LIMIT);
    expect(got.length).toBe(LIMIT);
    expect(got[0].event_id).toBe("$m100");
    expect(got[got.length - 1].event_id).toBe("$m599");
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
    disk.set(room, {
      messages: Array.from({ length: 10 }, (_, i) => msg(`$m${i}`, 100 + i)),
      end: "e10",
    });
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
    disk.set(room, { messages: [msg("$a", 100)], end: null });
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
  it("pruneRoom trims the window via PUT (keep < 500)", async () => {
    const acct = "acct-prune-room";
    const room = "!r-prune-room:hs";
    await putMessages(acct, room, [
      msg("$a", 100),
      msg("$b", 200),
      msg("$c", 300),
      msg("$d", 400),
      msg("$e", 500),
    ]);
    await pruneRoom(acct, room, 3);
    expect((await getRecent(acct, room, 10)).map((m) => m.event_id)).toEqual([
      "$c",
      "$d",
      "$e",
    ]);
  });

  it("pruneRoom is a no-op at or above the server window cap", async () => {
    const acct = "acct-prune-noop";
    const room = "!r-prune-noop:hs";
    await putMessages(acct, room, [msg("$a", 100)]);
    const before = requestsFor(room, "PUT").length;
    await pruneRoom(acct, room); // 默认 2000 ≥ 500
    expect(requestsFor(room, "PUT").length).toBe(before);
  });

  it("pruneAll asks the backend to prune (server policy is authoritative)", async () => {
    await pruneAll();
    expect(pruneCalls).toBe(1);
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
