// UI 批次 R15（聊天多团队切换）+ R13（任务备注入口）+ R2（移动端快捷条）
// 纯函数门：持久化 / 分组 / 入口可见性 / 断点 / i18n 键齐全。

import { describe, expect, it } from "vitest";

import {
  CHAT_TEAM_KEY,
  buildRoomGroups,
  readTeamPref,
  teamNameForRoom,
  writeTeamPref,
  type KeyValueStorage,
} from "../src/lib/chatSwitcher";
import { canEditTaskMeta } from "../src/lib/metaEntry";
import {
  QUICK_BAR_ITEMS,
  QUICK_BAR_MAX_WIDTH,
  shouldShowQuickBar,
} from "../src/lib/mobileQuickBar";
import { chatDict } from "../src/i18n/domains/chat";
import { generalDict } from "../src/i18n/domains/general";
import { kbDict } from "../src/i18n/domains/kb";
import { teamDict } from "../src/i18n/domains/team";
import { workerDict } from "../src/i18n/domains/worker";
import { workflowDict } from "../src/i18n/domains/workflow";
import type { TeamRoom, WorkerTreeTeam } from "../src/api";

function memStorage(seed: Record<string, string> = {}): KeyValueStorage & {
  data: Record<string, string>;
} {
  const data = { ...seed };
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
}

const ROOMS: TeamRoom[] = [
  { room_id: "!team-a:mx", name: "Team: Alpha", member_count: 5, members: {} },
  { room_id: "!team-b:mx", name: "Team: Beta", member_count: 4, members: {} },
  { room_id: "!dm-lead:mx", name: "Alpha Lead", member_count: 2, members: {} },
  { room_id: "!misc:mx", name: "散群", member_count: 3, members: {} },
];

const TEAMS: WorkerTreeTeam[] = [
  { team_name: "alpha", room_id: "!team-a:mx", workers: [] },
  { team_name: "beta", room_id: "!team-b:mx", workers: [] },
];

describe("R15 团队切换持久化", () => {
  it("无记录 → 空串；写入后可读回并自动 trim", () => {
    const store = memStorage();
    expect(readTeamPref(store)).toBe("");
    writeTeamPref("  alpha  ", store);
    expect(store.data[CHAT_TEAM_KEY]).toBe("alpha");
    expect(readTeamPref(store)).toBe("alpha");
  });

  it("清空选择写空串；storage 抛错时读返回空串、写静默", () => {
    const store = memStorage({ [CHAT_TEAM_KEY]: "beta" });
    writeTeamPref("", store);
    expect(readTeamPref(store)).toBe("");
    const broken: KeyValueStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readTeamPref(broken)).toBe("");
    expect(() => writeTeamPref("x", broken)).not.toThrow();
  });
});

describe("R15 团队↔房间映射与分组", () => {
  it("team.room_id 命中返回团队名，否则空串", () => {
    expect(teamNameForRoom(TEAMS, "!team-a:mx")).toBe("alpha");
    expect(teamNameForRoom(TEAMS, "!dm-lead:mx")).toBe("");
    expect(teamNameForRoom(TEAMS, "")).toBe("");
  });

  it("分组顺序 = 团队群 → 私聊 → 其他房间，且组内保留房间名", () => {
    const groups = buildRoomGroups(ROOMS, TEAMS);
    expect(groups.map((g) => g.key)).toEqual([
      "team:alpha",
      "team:beta",
      "dm",
      "other",
    ]);
    expect(groups[0].rooms).toEqual([
      { value: "!team-a:mx", label: "Team: Alpha" },
    ]);
    expect(groups[2].rooms.map((r) => r.value)).toEqual(["!dm-lead:mx"]);
    expect(groups[3].rooms.map((r) => r.value)).toEqual(["!misc:mx"]);
  });

  it("无团队/无房间时返回空分组（不造空组）", () => {
    expect(buildRoomGroups([], [])).toEqual([]);
  });
});

describe("R13 备注入口可见性（metaSupported 门）", () => {
  it("端点在（undefined/true）且有回调 → 显示", () => {
    expect(canEditTaskMeta(undefined, true)).toBe(true);
    expect(canEditTaskMeta(true, true)).toBe(true);
  });

  it("端点 405（false）或无回调 → 隐藏", () => {
    expect(canEditTaskMeta(false, true)).toBe(false);
    expect(canEditTaskMeta(true, false)).toBe(false);
    expect(canEditTaskMeta(undefined, false)).toBe(false);
  });
});

describe("R2 移动端快捷条断点", () => {
  it("≤600 显示，601 起隐藏，非法宽度不显示", () => {
    expect(QUICK_BAR_MAX_WIDTH).toBe(600);
    expect(shouldShowQuickBar(600)).toBe(true);
    expect(shouldShowQuickBar(375)).toBe(true);
    expect(shouldShowQuickBar(601)).toBe(false);
    expect(shouldShowQuickBar(1440)).toBe(false);
    expect(shouldShowQuickBar(0)).toBe(false);
    expect(shouldShowQuickBar(Number.NaN)).toBe(false);
  });

  it("四项且 tab key 固定为 文件/工作流/消息/设置", () => {
    expect(QUICK_BAR_ITEMS.map((i) => i.key)).toEqual([
      "artifacts",
      "workflow",
      "chat",
      "settings",
    ]);
    expect(QUICK_BAR_ITEMS.map((i) => i.label)).toEqual([
      "文件",
      "工作流",
      "消息",
      "设置",
    ]);
  });
});

describe("i18n 键 — 本批新增键均有英文对照", () => {
  const merged: Record<string, { en: string }> = {
    ...chatDict,
    ...generalDict,
    ...kbDict,
    ...teamDict,
    ...workerDict,
    ...workflowDict,
  };
  const required = [
    "备注",
    "打开任务备注（meta.json）",
    "团队切换",
    "房间切换",
    "切换团队/房间",
    "其他房间",
    "移动端快捷入口",
    "全部团队",
    "私聊",
    "文件",
    "工作流",
    "消息",
    "设置",
  ];
  it("必需键全部存在且 en 非空", () => {
    const missing = required.filter((k) => !merged[k]?.en?.trim());
    expect(missing).toEqual([]);
  });
});
