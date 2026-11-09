/**
 * session-tabs.vitest.test.ts — Worker 详情「会话」卡双 tab 的纯函数单测。
 *
 * 运行时口径：QwenPaw 没有 /spawns 路由，子代理会话 = 聊天会话上的
 * 运行时标记（meta.spawn / source / sub- 前缀 / 父子链接）。这里覆盖
 * spawn 判据、树键优先序、父子成树、旧 runtime 扁平降级、折叠。
 */
import { describe, expect, it } from "vitest";
import {
  buildSpawnChatRows,
  isSpawnChat,
  spawnChatKey,
} from "../src/components/WorkerChatsShared";
import type { WorkerChatSpec } from "../src/api/domains/worker";

const chat = (over: Partial<WorkerChatSpec> = {}): WorkerChatSpec => ({
  id: "chat-1",
  name: "chat",
  session_id: "s-1",
  ...over,
});

describe("isSpawnChat：spawn 判据并集", () => {
  it("meta.spawn=true / meta.spawn='true' → spawn", () => {
    expect(isSpawnChat(chat({ meta: { spawn: true } }))).toBe(true);
    expect(isSpawnChat(chat({ meta: { spawn: "true" } }))).toBe(true);
  });

  it("source=spawn / subagent → spawn（QwenPaw SessionSource 实值）", () => {
    expect(isSpawnChat(chat({ source: "spawn" }))).toBe(true);
    expect(isSpawnChat(chat({ source: "subagent" }))).toBe(true);
  });

  it("session_id 前缀 sub- → spawn", () => {
    expect(isSpawnChat(chat({ session_id: "sub-abc" }))).toBe(true);
  });

  it("parent/root 链接存在 → spawn（新 runtime 父子字段）", () => {
    expect(isSpawnChat(chat({ parent_session_id: "s-root" }))).toBe(true);
    expect(isSpawnChat(chat({ root_session_id: "s-root" }))).toBe(true);
  });

  it("普通聊天 / 仅 cron 来源 → 不是 spawn", () => {
    expect(isSpawnChat(chat())).toBe(false);
    expect(isSpawnChat(chat({ source: "cron" }))).toBe(false);
    expect(isSpawnChat(chat({ meta: { spawn: false } }))).toBe(false);
  });
});

describe("spawnChatKey：session_id 优先，缺省回退 chat id", () => {
  it("有 session_id → 用它（父子链接都指向 session_id）", () => {
    expect(spawnChatKey(chat({ id: "c-9", session_id: "s-9" }))).toBe("s-9");
  });

  it("无 session_id → 回退 chat id", () => {
    expect(spawnChatKey({ id: "c-only" })).toBe("c-only");
  });
});

describe("buildSpawnChatRows：parent_session_id 成树", () => {
  const spawn = (session: string, parent?: string, updated = "2026-01-01T00:00:00Z") =>
    chat({
      id: `id-${session}`,
      name: session,
      session_id: session,
      parent_session_id: parent,
      source: "subagent",
      updated_at: updated,
    });

  it("三层父子 → depth 0/1/2 + hasChildren", () => {
    const rows = buildSpawnChatRows([
      spawn("sub-root"),
      spawn("sub-child", "sub-root"),
      spawn("sub-grand", "sub-child"),
    ]);
    expect(rows.map((r) => [r.chat.session_id, r.depth, r.hasChildren])).toEqual([
      ["sub-root", 0, true],
      ["sub-child", 1, true],
      ["sub-grand", 2, false],
    ]);
  });

  it("旧 runtime 无 parent 字段 → 全部根层（扁平列表，不虚构层级）", () => {
    const rows = buildSpawnChatRows([
      spawn("sub-a"),
      spawn("sub-b"),
      spawn("sub-c"),
    ]);
    expect(rows.map((r) => [r.chat.session_id, r.depth])).toEqual([
      ["sub-a", 0],
      ["sub-b", 0],
      ["sub-c", 0],
    ]);
  });

  it("父 session 不在 spawn 列表（属普通智能体会话）→ 落根层", () => {
    const rows = buildSpawnChatRows([
      spawn("sub-orphan", "matrix:!room:hs"),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].depth).toBe(0);
  });

  it("同层按 updated_at 倒序", () => {
    const rows = buildSpawnChatRows([
      spawn("sub-old", undefined, "2026-01-01T00:00:00Z"),
      spawn("sub-new", undefined, "2026-02-01T00:00:00Z"),
    ]);
    expect(rows.map((r) => r.chat.session_id)).toEqual(["sub-new", "sub-old"]);
  });

  it("collapsed 命中 → 保留父行、收起整棵子树", () => {
    const rows = buildSpawnChatRows(
      [spawn("sub-root"), spawn("sub-child", "sub-root")],
      new Set(["sub-root"]),
    );
    expect(rows.map((r) => r.chat.session_id)).toEqual(["sub-root"]);
    expect(rows[0].hasChildren).toBe(true);
  });
});
