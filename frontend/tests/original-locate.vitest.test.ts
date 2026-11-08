// 「加载原消息」定位决策（chat/originalLocate）：
// 窗口命中零网络 / 缓存命中零网络 / /context 命中注入 / context 失败回退
// 分页 / 切房取消。

import { describe, expect, it, vi } from "vitest";

import { locateOriginalMessage } from "../src/chat/originalLocate";
import type { RoomMessage } from "../src/api";

function msg(id: string, ts: number): RoomMessage {
  return {
    event_id: id,
    sender: "@u:hs",
    body: `body-${id}`,
    msgtype: "m.text",
    origin_server_ts: ts,
  };
}

const target = msg("$target", 500);

function deps(over: Partial<Parameters<typeof locateOriginalMessage>[0]> = {}) {
  return {
    window: [msg("$w1", 900), msg("$w2", 950)],
    eventId: "$target",
    cancelled: () => false,
    readCache: vi.fn(async () => null),
    readContext: vi.fn(async () => null),
    paginate: vi.fn(async () => "exhausted" as const),
    ...over,
  };
}

describe("locateOriginalMessage", () => {
  it("finds in the loaded window with zero network", async () => {
    const d = deps({ window: [target] });
    const r = await locateOriginalMessage(d);
    expect(r).toEqual({ outcome: "found", source: "window", inject: [] });
    expect(d.readCache).not.toHaveBeenCalled();
    expect(d.readContext).not.toHaveBeenCalled();
    expect(d.paginate).not.toHaveBeenCalled();
  });

  it("uses the local cache window without any network call", async () => {
    const cached = [msg("$before", 400), target, msg("$after", 600)];
    const d = deps({ readCache: vi.fn(async () => cached) });
    const r = await locateOriginalMessage(d);
    expect(r.outcome).toBe("found");
    expect(r.source).toBe("cache");
    expect(r.inject.map((m) => m.event_id)).toEqual(["$before", "$target", "$after"]);
    expect(d.readContext).not.toHaveBeenCalled();
    expect(d.paginate).not.toHaveBeenCalled();
  });

  it("falls back to /context when the cache misses (single request)", async () => {
    const ctx = [msg("$c1", 450), target, msg("$c2", 550)];
    const d = deps({ readContext: vi.fn(async () => ctx) });
    const r = await locateOriginalMessage(d);
    expect(r).toEqual({ outcome: "found", source: "context", inject: ctx });
    expect(d.paginate).not.toHaveBeenCalled();
  });

  it("falls back to pagination when /context fails (404/501)", async () => {
    const d = deps({
      readContext: vi.fn(async () => {
        throw new Error("HTTP 404");
      }),
      paginate: vi.fn(async () => "found" as const),
    });
    const r = await locateOriginalMessage(d);
    expect(r.outcome).toBe("found");
    expect(r.source).toBe("pagination");
    expect(r.inject).toEqual([]);
    expect(d.paginate).toHaveBeenCalledTimes(1);
  });

  it("paginates when /context returns without the target event", async () => {
    const d = deps({
      readContext: vi.fn(async () => [msg("$other", 480)]),
      paginate: vi.fn(async () => "exhausted" as const),
    });
    const r = await locateOriginalMessage(d);
    expect(r.outcome).toBe("exhausted");
    expect(r.source).toBe("pagination");
  });

  it("cancels immediately when the room/mode switched", async () => {
    const d = deps({ cancelled: () => true });
    const r = await locateOriginalMessage(d);
    expect(r.outcome).toBe("cancelled");
    expect(d.readCache).not.toHaveBeenCalled();
    expect(d.readContext).not.toHaveBeenCalled();
    expect(d.paginate).not.toHaveBeenCalled();
  });

  it("cancels after an awaited cache read when the target changed", async () => {
    let cancelled = false;
    const d = deps({
      readCache: vi.fn(async () => {
        cancelled = true;
        return null;
      }),
      cancelled: () => cancelled,
    });
    const r = await locateOriginalMessage(d);
    expect(r.outcome).toBe("cancelled");
    expect(d.readContext).not.toHaveBeenCalled();
    expect(d.paginate).not.toHaveBeenCalled();
  });
});
