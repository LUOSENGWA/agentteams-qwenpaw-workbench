/**
 * 检查点端点能力降级单测（vitest 风格，任务书：≥4 条，实际 10 条）。
 *
 * 背景：控制器 #1186 引入 /workers/{n}/checkpoints/{graph,status} 只读代理；
 * 更早的控制器版本无该路由 → Go mux 回 404（或 405）。前端域层
 * （api/domains/checkpoints.ts）用纯函数 checkpointRouteMissing 探测错误
 * 状态码，404/405 转 CheckpointNotSupportedError——UI（WorkerManageTree
 * CheckpointCard）隐藏入口行并显示「该控制器不支持检查点图」，不再裸报错。
 * 502（QwenPaw<2.1）保持 CheckpointUnavailableError；正常 200 路径零改动。
 *
 * 运行：npx --no-install vitest run（*.vitest.test.ts 约定，无需改配置）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// 只替掉 requestJson（单测不拨号）；httpErrorStatus 等保留真实实现——
// shared.ts 模块级是 node 安全的（无 window/localStorage 访问）。
vi.mock("../src/api/shared", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/api/shared")>();
  return { ...actual, requestJson: vi.fn() };
});

import {
  CheckpointNotSupportedError,
  CheckpointUnavailableError,
  checkpointRouteMissing,
  fetchWorkerCheckpointGraph,
  fetchWorkerCheckpointStatus,
} from "../src/api/domains/checkpoints";
import { requestJson } from "../src/api/shared";
import { __clearCacheForTest } from "../src/requestCache";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

function graphPayload(): Record<string, unknown> {
  return {
    nodes: [
      {
        ref: "ck-1",
        kind: "auto",
        session_key: "s1",
        name: "n1",
        commit: "",
        sha: "abc123",
        timestamp_ms: 1700000000000,
        subject: "subj1",
        query: null,
        channel: "c",
        is_head: true,
        user_id: "u1",
      },
      {
        ref: "ck-2",
        kind: "snap",
        session_key: "s2",
        name: "n2",
        commit: "",
        sha: "def456",
        timestamp_ms: 1700000001000,
        subject: "subj2",
        query: "q2",
        channel: "c",
        is_head: false,
        user_id: "u1",
      },
    ],
    sessions: [],
    summary: { total: 2, auto: 1, snapshots: 1, safety: 0, heads: 1 },
    truncated: false,
  };
}

describe("checkpointRouteMissing（能力探测纯函数）", () => {
  it("404/405 → true（控制器无路由）", () => {
    expect(
      checkpointRouteMissing(new Error("HTTP 404: 404 page not found")),
    ).toBe(true);
    expect(checkpointRouteMissing(new Error("HTTP 405"))).toBe(true);
    expect(
      checkpointRouteMissing(new Error("HTTP 405: Method Not Allowed")),
    ).toBe(true);
  });

  it("502（QwenPaw<2.1）/ 网络错误 / 非 Error → false（非路由缺失信号）", () => {
    expect(
      checkpointRouteMissing(
        new Error("HTTP 502: checkpoint API unavailable (requires QwenPaw 2.1)"),
      ),
    ).toBe(false);
    expect(checkpointRouteMissing(new Error("Failed to fetch"))).toBe(false);
    expect(checkpointRouteMissing("HTTP 404: not an Error")).toBe(false);
    expect(checkpointRouteMissing(null)).toBe(false);
  });
});

describe("404/405 → CheckpointNotSupportedError 降级", () => {
  beforeEach(() => {
    __clearCacheForTest();
    vi.mocked(requestJson).mockReset();
  });

  it("graph：404 → CheckpointNotSupportedError（不再裸错）", async () => {
    vi.mocked(requestJson).mockRejectedValue(
      new Error("HTTP 404: 404 page not found"),
    );
    await expect(fetchWorkerCheckpointGraph("w-404")).rejects.toBeInstanceOf(
      CheckpointNotSupportedError,
    );
  });

  it("status：405 → CheckpointNotSupportedError", async () => {
    vi.mocked(requestJson).mockRejectedValue(new Error("HTTP 405"));
    await expect(fetchWorkerCheckpointStatus("w-405")).rejects.toBeInstanceOf(
      CheckpointNotSupportedError,
    );
  });

  it("502 QwenPaw<2.1 保持原 CheckpointUnavailableError（回归护栏）", async () => {
    vi.mocked(requestJson).mockRejectedValue(
      new Error("HTTP 502: checkpoint API unavailable (requires QwenPaw 2.1)"),
    );
    const p = fetchWorkerCheckpointGraph("w-502");
    await expect(p).rejects.toBeInstanceOf(CheckpointUnavailableError);
    await expect(p).rejects.not.toBeInstanceOf(CheckpointNotSupportedError);
  });

  it("404 失败不写缓存（下次调用重新拨号即恢复）", async () => {
    vi.mocked(requestJson).mockRejectedValue(new Error("HTTP 404"));
    await expect(fetchWorkerCheckpointGraph("w-rec")).rejects.toBeInstanceOf(
      CheckpointNotSupportedError,
    );
    vi.mocked(requestJson).mockResolvedValueOnce(graphPayload());
    const r = await fetchWorkerCheckpointGraph("w-rec");
    expect(r.summary.total).toBe(2);
    expect(requestJson).toHaveBeenCalledTimes(2);
  });
});

describe("正常分支（原路径不变）", () => {
  beforeEach(() => {
    __clearCacheForTest();
    vi.mocked(requestJson).mockReset();
  });

  it("graph 200：URL 不变 + 解析 nodes/summary/truncated", async () => {
    vi.mocked(requestJson).mockResolvedValueOnce(graphPayload());
    const r = await fetchWorkerCheckpointGraph("w-ok", 100);
    expect(requestJson).toHaveBeenCalledWith(
      "/agentteams-proxy/controller/api/v1/workers/w-ok/checkpoints/graph?limit=100",
    );
    expect(r.nodes).toHaveLength(2);
    expect(r.nodes[0]).toMatchObject({
      ref: "ck-1",
      kind: "auto",
      is_head: true,
    });
    expect(r.nodes[1]).toMatchObject({ ref: "ck-2", query: "q2" });
    expect(r.summary).toEqual({
      total: 2,
      auto: 1,
      snapshots: 1,
      safety: 0,
      heads: 1,
    });
    expect(r.truncated).toBe(false);
  });

  it("status 200：解析 {auto_enabled, has_checkpoints, workspace_dir}", async () => {
    vi.mocked(requestJson).mockResolvedValueOnce({
      auto_enabled: true,
      has_checkpoints: true,
      workspace_dir: "/ws",
    });
    const r = await fetchWorkerCheckpointStatus("w-ok");
    expect(r).toEqual({
      auto_enabled: true,
      has_checkpoints: true,
      workspace_dir: "/ws",
    });
  });
});

describe("源码接线（URL 拼装收敛在域层，UI 经域层消费）", () => {
  it("checkpoints/graph|status 字面量只出现在 api/domains/checkpoints.ts", () => {
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
          text.includes("checkpoints/graph") ||
          text.includes("checkpoints/status")
        ) {
          offenders.push(relative(srcDir, p));
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual(["api/domains/checkpoints.ts"]);
  });

  it("WorkerManageTree 经域层消费 + notSupported 降级渲染已接线", () => {
    const src = readFileSync(
      join(srcDir, "components", "WorkerManageTree.tsx"),
      "utf8",
    );
    expect(src).toContain("CheckpointNotSupportedError");
    expect(src).toContain('tr("该控制器不支持检查点图")');
    expect(src).not.toContain("checkpoints/graph");
    expect(src).not.toContain("checkpoints/status");
  });
});
