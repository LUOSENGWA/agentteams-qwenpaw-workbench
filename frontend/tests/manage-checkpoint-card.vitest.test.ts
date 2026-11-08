/**
 * 管理页 Worker 详情·检查点卡（CheckpointCard 从旧拓扑 WorkerManageTree 迁入）。
 *
 * 渲染环境：本仓 vitest 是 node 环境，未装 jsdom/@testing-library（本单禁装
 * 依赖）。沿用 mf-workbench / manage-session-dot 先例：注入 window.QwenPaw.host
 * （真 React + 最小 antd 桩）后用 react-dom/server 的 renderToStaticMarkup
 * 静态渲染（effects 不跑）。
 *
 * 覆盖：
 * - 四态 + 空态 + 截断提示的静态渲染（mock 域层）；
 * - 「展开才请求」= 折叠静态渲染零拨号 + 源码接线治理（effect 内 open 门控）；
 * - 错误 → 状态映射永不 reject（能力缺口不裸报错）；
 * - WorkerDetailPane 接线 + 旧拓扑回退保留 + URL 仍收敛在域层。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const here = dirname(fileURLToPath(import.meta.url));
const srcText = (rel: string): string =>
  readFileSync(join(here, "..", "src", rel), "utf8");
const E = React.createElement;

// 只替掉拨号函数；错误类保持真实实现（instanceof 语义与运行时一致）。
vi.mock("../src/api/domains/checkpoints", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/api/domains/checkpoints")>();
  return {
    ...actual,
    fetchWorkerCheckpointStatus: vi.fn(),
    fetchWorkerCheckpointGraph: vi.fn(),
  };
});

// window/host shim——必须在动态 import 业务模块之前就位（模块顶层读
// window.QwenPaw.host / window.QwenPaw.host.antdIcons）。
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
      },
      antdIcons: {},
      useLocale: () => "zh",
      useTheme: () => "light",
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" }),
      getApiUrl: (p: string) => p,
      getApiToken: () => "",
    },
  },
};
(globalThis as Record<string, unknown>).document = {
  hidden: false,
  documentElement: {},
};

let Card: typeof import("../src/manage/CheckpointCard").default;
let CardBody: typeof import("../src/manage/CheckpointCard").CheckpointCardBody;
let loadWorkerCheckpoints: typeof import("../src/manage/CheckpointCard").loadWorkerCheckpoints;
let checkpointStateFromError: typeof import("../src/manage/CheckpointCard").checkpointStateFromError;
let ckpt: typeof import("../src/api/domains/checkpoints");
let fmtTime: typeof import("../src/components/WorkerManageShared").fmtTime;

beforeAll(async () => {
  const mod = await import("../src/manage/CheckpointCard");
  Card = mod.default;
  CardBody = mod.CheckpointCardBody;
  loadWorkerCheckpoints = mod.loadWorkerCheckpoints;
  checkpointStateFromError = mod.checkpointStateFromError;
  ckpt = await import("../src/api/domains/checkpoints");
  ({ fmtTime } = await import("../src/components/WorkerManageShared"));
});

function node(
  ref: string,
  kind: string,
  ts: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ref,
    kind,
    session_key: "s1",
    name: ref,
    commit: "",
    sha: `sha-${ref}`,
    timestamp_ms: ts,
    subject: "",
    query: null,
    channel: "",
    is_head: false,
    user_id: "u1",
    ...extra,
  };
}

function graph(
  nodes: Record<string, unknown>[],
  opts: { truncated?: boolean } = {},
): Record<string, unknown> {
  const auto = nodes.filter((n) => n.kind === "auto").length;
  const snap = nodes.filter((n) => n.kind === "snap").length;
  return {
    nodes,
    sessions: [],
    summary: {
      total: nodes.length,
      auto,
      snapshots: snap,
      safety: nodes.length - auto - snap,
      heads: nodes.filter((n) => n.is_head).length,
    },
    truncated: !!opts.truncated,
  };
}

const status = { auto_enabled: true, has_checkpoints: true, workspace_dir: "/ws" };
const html = (state: unknown): string =>
  renderToStaticMarkup(E(CardBody, { state: state as never }));

describe("CheckpointCardBody 四态渲染", () => {
  it("loading / idle → 加载中…", () => {
    expect(html({ kind: "loading" })).toContain("加载中…");
    expect(html({ kind: "idle" })).toContain("加载中…");
  });

  it("notSupported → 该控制器不支持检查点图（能力缺口不报错）", () => {
    const out = html({ kind: "notSupported" });
    expect(out).toContain("该控制器不支持检查点图");
    expect(out).not.toContain("检查点加载失败");
  });

  it("unavailable → 该 Worker 需 QwenPaw 2.1 才有检查点", () => {
    const out = html({ kind: "unavailable" });
    expect(out).toContain("该 Worker 需 QwenPaw 2.1 才有检查点");
    expect(out).not.toContain("检查点加载失败");
  });

  it("error → 检查点加载失败 + 原始信息；裸 404 走升级提示", () => {
    expect(html({ kind: "error", message: "boom" })).toContain(
      "检查点加载失败：boom",
    );
    expect(html({ kind: "error", message: "HTTP 404: nope" })).toContain(
      "Controller 升级后自动生效",
    );
  });

  it("ok + 空 graph → 暂无打点（数量 0，不出列表）", () => {
    const out = html({ kind: "ok", status, graph: graph([]) });
    expect(out).toContain("暂无打点");
    expect(out).toContain("检查点数量");
  });

  it("ok + 有数据 → 数量 / 最新时间 / 名字+时间+kind / HEAD 标记", () => {
    const out = html({
      kind: "ok",
      status,
      graph: graph([
        node("ck-1", "auto", 1700000000000, { is_head: true }),
        node("ck-2", "snap", 1700000001000),
      ]),
    });
    expect(out).toContain("自动打点开");
    expect(out).toContain("检查点数量");
    expect(out).toContain("ck-1");
    expect(out).toContain("ck-2");
    expect(out).toContain("auto");
    expect(out).toContain("snap");
    // 列表时间 = fmtTime（MM-DD HH:mm）；「最新」= 最大 timestamp。
    expect(out).toContain(fmtTime(1700000000000));
    expect(out).toContain(fmtTime(1700000001000));
    expect(out).toContain("最新");
    expect(out).toContain("●");
  });

  it("ok + truncated → 明示只显示最近 100 条", () => {
    const out = html({
      kind: "ok",
      status,
      graph: graph([node("ck-1", "auto", 1700000000000)], { truncated: true }),
    });
    expect(out).toContain("仅显示最近 100 条");
  });

  it("清单最多 100 条（上游超发也只渲染前 100）", () => {
    const nodes = Array.from({ length: 120 }, (_, i) =>
      node(`n${i}`, "auto", 1700000000000 + i),
    );
    const out = html({ kind: "ok", status, graph: graph(nodes) });
    expect(out).toContain(">n99<");
    expect(out).not.toContain(">n100<");
  });
});

describe("展开才请求（懒加载）", () => {
  beforeEach(() => {
    vi.mocked(ckpt.fetchWorkerCheckpointStatus).mockReset();
    vi.mocked(ckpt.fetchWorkerCheckpointGraph).mockReset();
  });

  it("折叠静态渲染：零拨号、aria-expanded=false、无卡体", () => {
    const out = renderToStaticMarkup(
      E(Card, { workerName: "w1", runtime: "qwenpaw" }),
    );
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain("展开后加载");
    expect(out).not.toContain("检查点数量");
    expect(ckpt.fetchWorkerCheckpointStatus).not.toHaveBeenCalled();
    expect(ckpt.fetchWorkerCheckpointGraph).not.toHaveBeenCalled();
  });

  it("非 qwenpaw 运行时禁用入口 + 说明（不拨号）", () => {
    const out = renderToStaticMarkup(
      E(Card, { workerName: "w1", runtime: "openclaw" }),
    );
    expect(out).toContain("disabled");
    expect(out).toContain("仅 QwenPaw 运行时可用");
  });

  it("源码接线：effect 内 open 门控 + 展开才调 loadWorkerCheckpoints", () => {
    const src = srcText("manage/CheckpointCard.tsx");
    expect(src).toContain("if (!open || gated) return;");
    expect(src).toContain("}, [open, workerName, gated]);");
    expect(src).toContain("loadWorkerCheckpoints(workerName)");
  });
});

describe("loadWorkerCheckpoints / 错误映射（永不 reject）", () => {
  beforeEach(() => {
    vi.mocked(ckpt.fetchWorkerCheckpointStatus).mockReset();
    vi.mocked(ckpt.fetchWorkerCheckpointGraph).mockReset();
  });

  it("并行拨 status + graph(100) → ok", async () => {
    vi.mocked(ckpt.fetchWorkerCheckpointStatus).mockResolvedValue(status);
    vi.mocked(ckpt.fetchWorkerCheckpointGraph).mockResolvedValue(
      graph([node("ck-1", "auto", 1700000000000)]) as never,
    );
    const state = await loadWorkerCheckpoints("w1");
    expect(ckpt.fetchWorkerCheckpointStatus).toHaveBeenCalledWith("w1");
    expect(ckpt.fetchWorkerCheckpointGraph).toHaveBeenCalledWith("w1", 100);
    expect(state.kind).toBe("ok");
    if (state.kind === "ok") expect(state.graph.summary.total).toBe(1);
  });

  it("CheckpointNotSupportedError → notSupported（404/405 能力缺口）", async () => {
    vi.mocked(ckpt.fetchWorkerCheckpointStatus).mockRejectedValue(
      new ckpt.CheckpointNotSupportedError("no route"),
    );
    vi.mocked(ckpt.fetchWorkerCheckpointGraph).mockResolvedValue(graph([]) as never);
    await expect(loadWorkerCheckpoints("w1")).resolves.toEqual({
      kind: "notSupported",
    });
  });

  it("CheckpointUnavailableError → unavailable（QwenPaw <2.1）", async () => {
    vi.mocked(ckpt.fetchWorkerCheckpointStatus).mockResolvedValue(status);
    vi.mocked(ckpt.fetchWorkerCheckpointGraph).mockRejectedValue(
      new ckpt.CheckpointUnavailableError("requires QwenPaw 2.1"),
    );
    await expect(loadWorkerCheckpoints("w1")).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("其它错误 → error 状态（不抛）；非 Error 也归一成字符串", () => {
    expect(checkpointStateFromError(new Error("boom"))).toEqual({
      kind: "error",
      message: "boom",
    });
    expect(checkpointStateFromError("weird")).toEqual({
      kind: "error",
      message: "weird",
    });
  });
});

describe("接线与回退", () => {
  it("WorkerDetailPane 在详情区渲染 CheckpointCard（worker 名 + runtime）", () => {
    const detail = srcText("manage/WorkerDetailPane.tsx");
    expect(detail).toContain('import CheckpointCard from "./CheckpointCard";');
    expect(detail).toContain("<CheckpointCard");
    expect(detail).toContain("workerName={worker.name}");
    expect(detail).toContain("runtime={worker.runtime}");
  });

  it("旧拓扑组件退场后 WorkerDetailPane 是新卡唯一挂载点", () => {
    // 旧文件 WorkerManageTree/Tables 的删除由 legacy-migrate 测试断言；
    // 此处只锁新挂载点，避免与删除门重复失败。
    const detail = srcText("manage/WorkerDetailPane.tsx");
    expect(detail).toContain('import CheckpointCard from "./CheckpointCard";');
    expect(detail).toContain("<CheckpointCard");
  });

  it("两端点字面量仍只在域层（新卡经域层消费）", () => {
    const card = srcText("manage/CheckpointCard.tsx");
    expect(card).toContain("../api/domains/checkpoints");
    expect(card).not.toContain("checkpoints/graph");
    expect(card).not.toContain("checkpoints/status");
  });
});
