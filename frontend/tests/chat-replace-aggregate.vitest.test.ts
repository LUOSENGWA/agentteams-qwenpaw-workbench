// m.replace 编辑聚合（审计 Fix 1 回归）：同一目标的多条编辑事件——
// dir=b（新→旧）预扫「首次命中 = 最新编辑」：body/msgtype/editedAt/
// latestEventId 必须全部来自最新编辑（旧 bug：无条件 set 让旧编辑
// 覆盖新编辑）。editedAt = 编辑事件自身的 origin_server_ts，不是
// 原消息的发送时间（读模型排序口径）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRoomMessages } from "../src/api/domains/chat";
import type { RoomMessage } from "../src/api";

const T0 = 1_733_800_000_000;
const ROOT = "$root:hs";

/** m.replace 编辑事件（非标注客户端 fallback body 带 [edit] 前缀）。 */
function replaceEvent(
  id: string,
  ts: number,
  body: string,
  msgtype: string,
): Record<string, unknown> {
  return {
    type: "m.room.message",
    event_id: id,
    sender: "@w1:hs",
    origin_server_ts: ts,
    content: {
      msgtype,
      body: `[edit] ${body}`,
      "m.new_content": { msgtype, body },
      "m.relates_to": { rel_type: "m.replace", event_id: ROOT },
    },
  };
}

function textEvent(
  id: string,
  sender: string,
  ts: number,
  body: string,
  msgtype = "m.text",
): Record<string, unknown> {
  return {
    type: "m.room.message",
    event_id: id,
    sender,
    origin_server_ts: ts,
    content: { msgtype, body },
  };
}

let chunk: Record<string, unknown>[];
const fetchMock: ReturnType<typeof vi.fn> = vi.fn(async () =>
  new Response(JSON.stringify({ chunk, end: "", start: "" }), { status: 200 }),
);

beforeEach(() => {
  fetchMock.mockClear();
  // dir=b：chunk 从新到旧排列。
  chunk = [];
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

describe("fetchRoomMessages m.replace 多编辑聚合", () => {
  it("同一目标两条编辑：body/msgtype/editedAt/latestEventId 全部来自最新编辑", async () => {
    // 新编辑（m.text）→ 人类消息 → 旧编辑（m.notice）→ 原消息。
    chunk = [
      replaceEvent("$edit-new:hs", T0 + 40_000, "最终版 v2", "m.text"),
      textEvent("$other:hs", "@me:hs", T0 + 20_000, "人类消息"),
      replaceEvent("$edit-old:hs", T0 + 10_000, "第一版 v1", "m.notice"),
      textEvent(ROOT, "@w1:hs", T0, "处理中...", "m.notice"),
    ];
    const page = await fetchRoomMessages("!r:hs");
    const root = page.messages.find((m) => m.event_id === ROOT);
    expect(root).toBeDefined();
    // body / msgtype = 最新编辑（旧编辑的「第一版 v1」/ m.notice 不残留）
    expect(root!.body).toBe("最终版 v2");
    expect(root!.msgtype).toBe("m.text");
    expect(root!.edited).toBe(true);
    expect(root!.latestEventId).toBe("$edit-new:hs");
    // 替换事件本身不独立成行
    expect(page.messages.map((m) => m.event_id)).not.toContain("$edit-new:hs");
    expect(page.messages.map((m) => m.event_id)).not.toContain("$edit-old:hs");
    // 无关消息不受影响
    expect(page.messages.map((m) => m.event_id)).toContain("$other:hs");
    expect(
      page.messages.find((m) => m.event_id === "$other:hs")?.edited,
    ).toBeUndefined();
  });

  it("editedAt = 编辑事件自身的 origin_server_ts（不是原消息的发送时间）", async () => {
    chunk = [
      replaceEvent("$edit-new:hs", T0 + 40_000, "最终版", "m.text"),
      replaceEvent("$edit-old:hs", T0 + 10_000, "第一版", "m.text"),
      textEvent(ROOT, "@w1:hs", T0, "原文", "m.text"),
    ];
    const page = await fetchRoomMessages("!r:hs");
    const root = page.messages.find((m) => m.event_id === ROOT);
    expect(root?.origin_server_ts).toBe(T0);
    expect(root?.editedAt).toBe(T0 + 40_000);
  });

  it("单条编辑回归：既有单编辑路径不受首命中门控影响", async () => {
    chunk = [
      replaceEvent("$e1:hs", T0 + 5_000, "改后的正文", "m.text"),
      textEvent(ROOT, "@w1:hs", T0, "原文", "m.notice"),
    ];
    const page = await fetchRoomMessages("!r:hs");
    const root = page.messages.find((m) => m.event_id === ROOT);
    expect(root).toMatchObject({
      body: "改后的正文",
      msgtype: "m.text",
      edited: true,
      editedAt: T0 + 5_000,
      latestEventId: "$e1:hs",
    });
  });
});
