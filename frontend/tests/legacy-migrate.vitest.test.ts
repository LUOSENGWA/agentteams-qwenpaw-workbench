/**
 * legacy-migrate.vitest.test.ts — 旧拓扑组件（WorkerManageTree/Tables）能力
 * 迁入「管理」页后的验收单测。
 *
 * 覆盖：
 * ① spawn 树 flatten/递归/折叠 + 状态色映射；
 * ② spawn 消息错误分类 404/403/其他 + has_more/折叠阈值纯函数；
 * ③ 子会话卡 / 消息三态静态渲染（加载 / 失败重试 / 空态 / 树行）；
 * ④ 私聊入口参数（mxid, roomId）与两详情面板接线；
 * ⑤ Manager 容器日志解析 / 空态 / 错误分类 + 静态渲染；
 * ⑥ 旧组件文件已删且无 import 引用（WorkerManageShared 保留）。
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SpawnNode } from "../src/api/domains/teams";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");
const srcText = (rel: string): string => readFileSync(join(srcDir, rel), "utf8");
const E = React.createElement;

// window/host shim——必须在动态 import 业务模块之前就位（模块顶层读
// window.QwenPaw.host / host.antdIcons）。与 manage-checkpoint-card 同款。
(globalThis as Record<string, unknown>).window = {
  innerWidth: 1200,
  innerHeight: 900,
  QwenPaw: {
    host: {
      kind: "server",
      React,
      antd: {
        Tag: (p: { color?: string; style?: unknown; children?: unknown }) =>
          E(
            "span",
            { "data-tag": p.color ?? "default", style: p.style as never },
            p.children as React.ReactNode,
          ),
        Button: (p: {
          children?: unknown;
          disabled?: boolean;
          onClick?: () => void;
        }) =>
          E(
            "button",
            { disabled: p.disabled, onClick: p.onClick },
            p.children as React.ReactNode,
          ),
      },
      antdIcons: {},
      useLocale: () => "zh",
      useTheme: () => "light",
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => "",
      }),
      getApiUrl: (p: string) => p,
      getApiToken: () => "",
    },
  },
};
(globalThis as Record<string, unknown>).document = {
  hidden: false,
  documentElement: {},
};

let spawnModel: typeof import("../src/manage/spawnModel");
let dmTarget: typeof import("../src/manage/dmTarget");
let managerLogs: typeof import("../src/manage/managerLogs");
let SpawnTreeCard: typeof import("../src/manage/SpawnTreeCard");
let ManagerLogsCard: typeof import("../src/manage/ManagerLogsCard");
let shared: typeof import("../src/components/WorkerManageShared");

beforeAll(async () => {
  spawnModel = await import("../src/manage/spawnModel");
  dmTarget = await import("../src/manage/dmTarget");
  managerLogs = await import("../src/manage/managerLogs");
  SpawnTreeCard = await import("../src/manage/SpawnTreeCard");
  ManagerLogsCard = await import("../src/manage/ManagerLogsCard");
  shared = await import("../src/components/WorkerManageShared");
});

function node(id: string, extra: Partial<SpawnNode> = {}): SpawnNode {
  return {
    session_id: id,
    name: `name-${id}`,
    status: "running",
    created_at: 1700000000000,
    ...extra,
  };
}

const tree = (): SpawnNode[] => [
  node("a", {
    children: [node("b", { children: [node("c")] }), node("b2")],
  }),
  node("d"),
];

describe("① spawn 树 flatten / 递归 / 折叠 / 状态色", () => {
  it("递归展开为平面行（parent → children，深度递增）", () => {
    const rows = spawnModel.flattenSpawnTree(tree());
    expect(rows.map((r) => [r.node.session_id, r.depth])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["b2", 1],
      ["d", 0],
    ]);
    expect(rows[0].hasChildren).toBe(true);
    expect(rows[3].hasChildren).toBe(false);
  });

  it("collapsed 命中：保留自身、收起子树（不丢父行）", () => {
    const rows = spawnModel.flattenSpawnTree(tree(), new Set(["a"]));
    expect(rows.map((r) => r.node.session_id)).toEqual(["a", "d"]);
  });

  it("countSpawnNodes 递归计数（含全部层级）", () => {
    expect(spawnModel.countSpawnNodes(tree())).toBe(5);
    expect(spawnModel.countSpawnNodes(undefined)).toBe(0);
    expect(spawnModel.countSpawnNodes([])).toBe(0);
  });

  it("行名回退：name 缺失 → session_id", () => {
    expect(spawnModel.spawnRowName(node("s1", { name: "" }))).toBe("s1");
    expect(spawnModel.spawnRowName(node("s2", { name: "hello" }))).toBe("hello");
  });

  it("状态色/标签映射三态齐（idle/running/done）", () => {
    expect(shared.SPAWN_STATUS_COLOR.idle).toBeTruthy();
    expect(shared.SPAWN_STATUS_COLOR.running).toBeTruthy();
    expect(shared.SPAWN_STATUS_COLOR.done).toBeTruthy();
    expect(shared.SPAWN_STATUS_LABEL.idle).toBe("待命");
    expect(shared.SPAWN_STATUS_LABEL.running).toBe("进行中");
    expect(shared.SPAWN_STATUS_LABEL.done).toBe("已完成");
  });
});

describe("② spawn 消息错误分类 / has_more / 折叠阈值", () => {
  it("404 → empty（不报错）；403 → forbidden；500/网络 → error", () => {
    expect(shared.classifySpawnMsgError(new Error("HTTP 404: gone"))).toBe(
      "empty",
    );
    expect(shared.classifySpawnMsgError(new Error("HTTP 403: denied"))).toBe(
      "forbidden",
    );
    expect(shared.classifySpawnMsgError(new Error("HTTP 500: boom"))).toBe(
      "error",
    );
    expect(shared.classifySpawnMsgError(new Error("network down"))).toBe(
      "error",
    );
  });

  it("has_more 提示条数：true 且有条目才给 N", () => {
    expect(spawnModel.spawnHasMoreCount(true, 200)).toBe(200);
    expect(spawnModel.spawnHasMoreCount(true, 0)).toBe(0);
    expect(spawnModel.spawnHasMoreCount(false, 200)).toBe(0);
    expect(spawnModel.spawnHasMoreCount(undefined, 200)).toBe(0);
  });

  it("折叠阈值 = 6 行（恰 6 行不折叠，第 7 行折叠）", () => {
    expect(shared.SPAWN_MSG_FOLD_LINES).toBe(6);
    const six = Array.from({ length: 6 }, (_, i) => `L${i + 1}`).join("\n");
    expect(shared.foldMessageContent(six)).toEqual({ text: six, folded: false });
    const seven = `${six}\nL7`;
    const r = shared.foldMessageContent(seven);
    expect(r.folded).toBe(true);
    expect(r.text.split("\n")).toHaveLength(6);
  });
});

describe("③ 子会话卡静态渲染", () => {
  const html = (state: unknown): string =>
    renderToStaticMarkup(
      E(SpawnTreeCard.SpawnTreeBody, { state: state as never }),
    );

  it("loading → 加载中…", () => {
    expect(html({ kind: "loading" })).toContain("加载中…");
  });

  it("error → 加载失败 · 重试（卡内可重试，不外溢）", () => {
    const out = html({ kind: "error", message: "HTTP 500: boom" });
    expect(out).toContain("加载失败");
    expect(out).toContain("重试");
    expect(out).toContain("HTTP 500: boom");
  });

  it("ok + 空 → 暂无子会话", () => {
    expect(html({ kind: "ok", spawns: [] })).toContain("暂无子会话");
  });

  it("ok + 嵌套树 → 名字 / 状态标签 / 工具与技能白名单 / 子节点", () => {
    const out = html({
      kind: "ok",
      spawns: [
        node("p", {
          name: "parent-agent",
          status: "running",
          allowedTools: ["read"],
          skills: ["sk-a"],
          project_id: "proj-1",
          children: [node("c1", { name: "child-agent", status: "done" })],
        }),
      ],
    });
    expect(out).toContain("parent-agent");
    expect(out).toContain("child-agent");
    expect(out).toContain("进行中");
    expect(out).toContain("已完成");
    expect(out).toContain("工具白名单");
    expect(out).toContain("read");
    expect(out).toContain("技能白名单");
    expect(out).toContain("sk-a");
    // 消息入口仅 project_id 节点出现。
    expect(out).toContain("消息");
  });

  it("absent（老控制器无 /spawns 路由）→ 空渲染（整卡隐藏）", () => {
    expect(html({ kind: "absent" })).toBe("");
  });
});

describe("④ 私聊入口参数透传", () => {
  it("dmTargetFor：mxid 必有，room 可选，缺失 → null", () => {
    expect(
      dmTarget.dmTargetFor({ matrixUserID: "@w:hs", roomID: "!r:hs" }),
    ).toEqual({ mxid: "@w:hs", roomId: "!r:hs" });
    expect(dmTarget.dmTargetFor({ matrixUserID: "@w:hs" })).toEqual({
      mxid: "@w:hs",
    });
    expect(
      dmTarget.dmTargetFor({ matrixUserID: "  ", roomID: "!r:hs" }),
    ).toBeNull();
    expect(dmTarget.dmTargetFor(null)).toBeNull();
  });

  it("两详情面板都按 (mxid, roomId) 调 onDm，并透传入参声明", () => {
    const worker = srcText("manage/WorkerDetailPane.tsx");
    expect(worker).toContain("onDm?: (mxid: string, roomId?: string) => void;");
    expect(worker).toContain("onDm(dm.mxid, dm.roomId)");
    const manager = srcText("manage/ManagerDetailPane.tsx");
    expect(manager).toContain("onDm?: (mxid: string, roomId?: string) => void;");
    expect(manager).toContain("onDm(dm.mxid, dm.roomId)");
  });

  it("TeamSection 把 data.onDm 透传给 Worker / Manager 详情", () => {
    const team = srcText("manage/TeamSection.tsx");
    const hits = team.match(/onDm=\{data\.onDm\}/g) || [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });
});

describe("⑤ Manager 容器日志", () => {
  const html = (state: unknown): string =>
    renderToStaticMarkup(
      E(ManagerLogsCard.ManagerLogsBody, { state: state as never }),
    );

  it("路径：encodeURIComponent + tail=300", () => {
    expect(managerLogs.managerLogPath("mgr/1", 300)).toBe(
      "/agentteams-proxy/docker-logs/mgr%2F1?tail=300",
    );
  });

  it("解析：ts + error 标记 + message；坏行/缺 lines → 跳过/空", () => {
    const lines = managerLogs.parseDockerLogLines({
      lines: [
        { timestamp: "2026-11-08T00:00:00Z", level: "info", message: "started" },
        { timestamp: "2026-11-08T00:00:01Z", level: "error", message: "boom" },
        "garbage",
        {},
      ],
    });
    expect(lines).toEqual(["2026-11-08T00:00:00Z started", "2026-11-08T00:00:01Z ❌ boom"]);
    expect(managerLogs.parseDockerLogLines({})).toEqual([]);
    expect(managerLogs.parseDockerLogLines(null)).toEqual([]);
  });

  it("错误分类：404 missing / 403 forbidden / 其余 error", () => {
    expect(
      managerLogs.classifyManagerLogError(new Error("HTTP 404: nope")),
    ).toBe("missing");
    expect(
      managerLogs.classifyManagerLogError(new Error("HTTP 403: denied")),
    ).toBe("forbidden");
    expect(managerLogs.classifyManagerLogError(new Error("HTTP 500"))).toBe(
      "error",
    );
  });

  it("静态渲染：loading / 404 / 403 / 空态 / 有行（不白屏）", () => {
    expect(html({ kind: "loading" })).toContain("加载中…");
    expect(html({ kind: "missing" })).toContain("无容器日志端点");
    expect(html({ kind: "forbidden" })).toContain("无权限查看日志");
    expect(html({ kind: "ok", lines: [] })).toContain("（无日志行）");
    const out = html({ kind: "ok", lines: ["line-1", "line-2"] });
    expect(out).toContain("line-1");
    expect(out).toContain("line-2");
  });

  it("面板接线：ManagerDetailPane 挂载日志卡（L1 门控）", () => {
    const manager = srcText("manage/ManagerDetailPane.tsx");
    expect(manager).toContain("<ManagerLogsCard");
    expect(manager).toContain("enabled={l1}");
  });
});

describe("⑥ 旧组件退场 / 新挂载点 / 无 import 引用", () => {
  it("旧文件已删除，WorkerManageShared 保留", () => {
    expect(
      existsSync(join(srcDir, "components", "WorkerManageTree.tsx")),
    ).toBe(false);
    expect(
      existsSync(join(srcDir, "components", "WorkerManageTables.tsx")),
    ).toBe(false);
    expect(
      existsSync(join(srcDir, "components", "WorkerManageShared.tsx")),
    ).toBe(true);
  });

  it("全 src 无对旧文件的 import/require", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          walk(p);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name)) continue;
        const text = readFileSync(p, "utf8");
        if (
          /from\s+["'][^"']*WorkerManage(?:Tree|Tables)["']/.test(text) ||
          /require\(\s*["'][^"']*WorkerManage(?:Tree|Tables)["']/.test(text)
        ) {
          offenders.push(p);
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });

  it("新挂载点：WorkerDetailPane 挂子会话卡；TeamSection 拓扑行有数量徽标", () => {
    expect(srcText("manage/WorkerDetailPane.tsx")).toContain("<SpawnTreeCard");
    const team = srcText("manage/TeamSection.tsx");
    expect(team).toContain("countSpawnNodes(w.spawns)");
    expect(team).toContain('tr("{n} 个子会话", { n: spawnCount })');
  });

  it("卡片数据源：fetchWorkerSpawns(force) + endpointMissing 隐藏 + 60s 缓存", () => {
    const card = srcText("manage/SpawnTreeCard.tsx");
    expect(card).toContain("fetchWorkerSpawns(force)");
    expect(card).toContain("endpointMissing");
    expect(srcText("api/domains/teams.ts")).toContain(
      'cachedRequest("worker/spawns", 60000',
    );
  });

  it("消息渲染只在新组件挂载一套（旧文件无副本）", () => {
    const messages = srcText("manage/SpawnMessages.tsx");
    expect(messages).toContain("getSpawnMessages(projectId, sessionId, 200)");
    expect(messages).toContain('tr("仅显示最近 {n} 条"');
    expect(messages).toContain("foldMessageContent(m.content)");
  });
});
