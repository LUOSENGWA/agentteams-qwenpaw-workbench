// 全局命令面板（⌘K）纯函数模型：匹配打分 / 分组顺序 / 空输入快捷入口 /
// 无结果空态 / Enter 目标解析（反向对齐 dashboard R1 的可测核心）。
import { describe, expect, it } from "vitest";

import {
  buildItems,
  groupItems,
  moveIndex,
  resolveEnterTarget,
  resolveSelfHumanName,
  scoreMatch,
  EMPTY_SOURCE,
  GROUP_ORDER,
  LIMIT_PER_GROUP,
  type PaletteItem,
  type PaletteSource,
} from "../src/lib/commandPalette";

const QUICK: PaletteItem[] = [
  { id: "quick:files", group: "quick", key: "files", title: "Files", subtitle: "Files" },
  { id: "quick:workflow", group: "quick", key: "workflow", title: "Workflows", subtitle: "Flow" },
  { id: "quick:chat", group: "quick", key: "chat", title: "Chat", subtitle: "Chat" },
  { id: "quick:settings", group: "quick", key: "settings", title: "Settings", subtitle: "Cfg" },
];

const SOURCE: PaletteSource = {
  humans: [
    { name: "ada", displayName: "Ada", matrixUserID: "@ada:matrix.local" },
    { name: "adam", displayName: "Adam Lee", matrixUserID: "@adam:matrix.local" },
    { name: "xavier", displayName: "Xada", matrixUserID: "@xavier:matrix.local" },
  ],
  teams: [
    { name: "team-ada", teamName: "Ada Team", leaderName: "team-ada-lead", readyWorkers: 2, totalWorkers: 3 },
  ],
  workers: [
    { name: "team-ada-lead", workerName: "ada-lead", team: "team-ada", runtime: "qwenpaw", model: "m1" },
  ],
  projects: [
    { projectId: "proj-ada-1", title: "Ada rollout", team: "team-ada", status: "running" },
  ],
  files: [{ path: "adareport.md" }],
};

describe("scoreMatch — 分级模糊打分", () => {
  it("exact > prefix > substring > subsequence > none", () => {
    expect(scoreMatch("ada", "ada")).toBe(1000);
    expect(scoreMatch("ada lovelace", "ada")).toBe(800);
    const substring = scoreMatch("xada", "ada");
    const subsequence = scoreMatch("a-d-a", "ada");
    expect(substring).toBeGreaterThan(subsequence);
    expect(subsequence).toBe(300);
    expect(scoreMatch("team-lead", "tld")).toBe(300);
    expect(scoreMatch("team-lead", "zzz")).toBe(0);
    // 大小写 / 空白归一。
    expect(scoreMatch("  Ada  ", " ADA ")).toBe(1000);
  });
});

describe("buildItems — 打分排序", () => {
  it("组内按分数降序：完全相等 > 前缀 > 子串", () => {
    const items = buildItems(SOURCE, "ada");
    const people = items.filter((it) => it.group === "people");
    expect(people.map((p) => p.key)).toEqual(["ada", "adam", "xavier"]);
    expect(people[0].score).toBe(1000);
    expect(people[1].score).toBe(800);
    expect(people[2].score).toBeGreaterThan(0);
    expect(people[2].score).toBeLessThan(800);
  });

  it("组间顺序固定 = GROUP_ORDER（人员 → 团队 → Worker → 项目 → 文件）", () => {
    const items = buildItems(SOURCE, "ada");
    const order = items.map((it) => it.group);
    const unique = order.filter((g, i) => order.indexOf(g) === i);
    expect(unique).toEqual(["people", "team", "worker", "project", "file"]);
    expect(GROUP_ORDER.filter((g) => unique.includes(g))).toEqual(unique);
    expect(items.length).toBeLessThanOrEqual(5 * LIMIT_PER_GROUP);
  });

  it("超过每组上限时截断", () => {
    const many: PaletteSource = {
      ...EMPTY_SOURCE,
      humans: Array.from({ length: 12 }, (_, i) => ({
        name: `dev-${i}`,
        displayName: `dev-${i}`,
        matrixUserID: `@dev-${i}:m`,
      })),
    };
    const items = buildItems(many, "dev");
    expect(items).toHaveLength(LIMIT_PER_GROUP);
  });
});

describe("groupItems — 分组顺序", () => {
  it("按 GROUP_ORDER 输出且丢弃空组", () => {
    const items = buildItems(SOURCE, "ada");
    const groups = groupItems(items);
    expect(groups.map((g) => g.group)).toEqual([
      "people",
      "team",
      "worker",
      "project",
      "file",
    ]);
    // 展平后与入参顺序一致（键盘索引 = 视觉顺序）。
    expect(groups.flatMap((g) => g.items)).toEqual(items);
    expect(groupItems([])).toEqual([]);
  });
});

describe("空输入 — 快捷入口", () => {
  it("空 / 纯空白查询原样返回快捷入口（不请求、不过滤）", () => {
    expect(buildItems(SOURCE, "", QUICK)).toEqual(QUICK);
    expect(buildItems(SOURCE, "   ", QUICK)).toEqual(QUICK);
    expect(QUICK.map((q) => q.key)).toEqual([
      "files",
      "workflow",
      "chat",
      "settings",
    ]);
  });
});

describe("无结果 — 空态", () => {
  it("全不命中返回空数组（组件据此渲染空态 + 快捷入口兜底）", () => {
    expect(buildItems(SOURCE, "zzzzz", QUICK)).toEqual([]);
    // 空数据源同样安全。
    expect(buildItems(EMPTY_SOURCE, "ada", QUICK)).toEqual([]);
  });
});

describe("Enter 目标解析", () => {
  it("空列表 → null；越界索引夹到合法区间", () => {
    const items = buildItems(SOURCE, "ada");
    expect(resolveEnterTarget([], 0)).toBeNull();
    expect(resolveEnterTarget([], 3)).toBeNull();
    expect(resolveEnterTarget(items, -5)?.key).toBe("ada");
    expect(resolveEnterTarget(items, 0)?.group).toBe("people");
    const last = items.length - 1;
    expect(resolveEnterTarget(items, 999)?.id).toBe(items[last].id);
  });

  it("↑↓ 循环移动", () => {
    expect(moveIndex(0, -1, 3)).toBe(2);
    expect(moveIndex(2, 1, 3)).toBe(0);
    expect(moveIndex(1, 1, 3)).toBe(2);
    expect(moveIndex(0, 1, 0)).toBe(0);
  });
});

describe("resolveSelfHumanName — 文件组寻址", () => {
  it("命中 humans 用 CR 名；未命中回落 MXID localpart", () => {
    expect(resolveSelfHumanName(SOURCE.humans, "@ada:matrix.local")).toBe("ada");
    expect(resolveSelfHumanName(SOURCE.humans, "@ADA:matrix.local")).toBe("ada");
    expect(resolveSelfHumanName(SOURCE.humans, "@nobody:matrix.local")).toBe("nobody");
    expect(resolveSelfHumanName(SOURCE.humans, "")).toBe("");
  });
});
