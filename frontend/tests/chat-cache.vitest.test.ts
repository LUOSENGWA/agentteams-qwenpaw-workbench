// 本地聊天缓存（lib/chatCache）内存适配器测试——node 环境无 IndexedDB，
// 走同 API 的 MemoryStore：upsert 去重 / 编辑标记保留 / 顺序 / 窗口 /
// LRU 预算 / 已读位点。

import { describe, expect, it } from "vitest";

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

describe("chatCache: messages", () => {
  it("upserts by event_id (no duplicates, newer payload wins)", async () => {
    const acct = "acct-upsert";
    const room = "!r:hs";
    await putMessages(acct, room, [msg("$a", 100), msg("$b", 200)]);
    await putMessages(acct, room, [
      { ...msg("$a", 100), body: "edited-body" },
      msg("$c", 300),
    ]);
    const got = await getRecent(acct, room, 10);
    expect(got.map((m) => m.event_id)).toEqual(["$a", "$b", "$c"]);
    expect(got[0].body).toBe("edited-body");
  });

  it("keeps edited/pending flags when the fresh payload omits them", async () => {
    const acct = "acct-flags";
    const room = "!r:hs";
    await putMessages(acct, room, [msg("$a", 100, { edited: true, pending: true })]);
    // 服务端页不带 edited/pending 字段 → 本地标记不被抹掉
    await putMessages(acct, room, [msg("$a", 100, { body: "server-body" })]);
    const [got] = await getRecent(acct, room, 10);
    expect(got.body).toBe("server-body");
    expect(got.edited).toBe(true);
    expect(got.pending).toBe(true);
  });

  it("returns getRecent in ascending ts order, newest window last", async () => {
    const acct = "acct-recent";
    const room = "!r:hs";
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

  it("getRange returns messages strictly before beforeTs (ascending)", async () => {
    const acct = "acct-range";
    const room = "!r:hs";
    await putMessages(acct, room, [
      msg("$a", 100),
      msg("$b", 200),
      msg("$c", 300),
      msg("$d", 400),
    ]);
    const got = await getRange(acct, room, 300, 10);
    expect(got.map((m) => m.event_id)).toEqual(["$a", "$b"]);
    const limited = await getRange(acct, room, 400, 2);
    expect(limited.map((m) => m.event_id)).toEqual(["$b", "$c"]);
  });

  it("isolates accounts and rooms", async () => {
    await putMessages("acct-x", "!r1:hs", [msg("$x1", 100)]);
    await putMessages("acct-y", "!r1:hs", [msg("$y1", 100)]);
    await putMessages("acct-x", "!r2:hs", [msg("$x2", 100)]);
    expect((await getRecent("acct-x", "!r1:hs", 10)).map((m) => m.event_id)).toEqual(["$x1"]);
    expect((await getRecent("acct-y", "!r1:hs", 10)).map((m) => m.event_id)).toEqual(["$y1"]);
    expect((await getRecent("acct-x", "!r2:hs", 10)).map((m) => m.event_id)).toEqual(["$x2"]);
  });

  it("getWindow returns the target ±N (ascending, target included)", async () => {
    const acct = "acct-window";
    const room = "!r:hs";
    const all = Array.from({ length: 11 }, (_, i) => msg(`$m${i}`, 100 + i));
    await putMessages(acct, room, all);
    const win = await getWindow(acct, room, "$m5", 2, 2);
    expect(win.map((m) => m.event_id)).toEqual(["$m3", "$m4", "$m5", "$m6", "$m7"]);
    expect(await getWindow(acct, room, "$missing", 2, 2)).toEqual([]);
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

describe("chatCache: budgets (LRU)", () => {
  it("pruneRoom keeps only the newest keep messages", async () => {
    const acct = "acct-prune-room";
    const room = "!r:hs";
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

  it("pruneAll drops the oldest rooms per account (lastTs LRU)", async () => {
    const acct = "acct-prune-all";
    await putMessages(acct, "!old:hs", [msg("$o1", 100)]);
    await putMessages(acct, "!mid:hs", [msg("$m1", 200)]);
    await putMessages(acct, "!new:hs", [msg("$n1", 300)]);
    // 另一个账号不受本账号预算影响
    await putMessages("acct-prune-all-other", "!keep:hs", [msg("$k1", 50)]);
    await pruneAll(2);
    expect(await getRecent(acct, "!old:hs", 10)).toEqual([]);
    expect((await getRecent(acct, "!mid:hs", 10)).map((m) => m.event_id)).toEqual(["$m1"]);
    expect((await getRecent(acct, "!new:hs", 10)).map((m) => m.event_id)).toEqual(["$n1"]);
    expect(
      (await getRecent("acct-prune-all-other", "!keep:hs", 10)).map((m) => m.event_id),
    ).toEqual(["$k1"]);
  });
});

describe("chatCache: last read", () => {
  it("stores and reads the last-read position per account+room", async () => {
    await setLastRead("acct-lr", "!r:hs", 1234);
    expect(await getLastRead("acct-lr", "!r:hs")).toBe(1234);
    expect(await getLastRead("acct-lr", "!other:hs")).toBeNull();
    await setLastRead("acct-lr", "!r:hs", 9999);
    expect(await getLastRead("acct-lr", "!r:hs")).toBe(9999);
  });
});
