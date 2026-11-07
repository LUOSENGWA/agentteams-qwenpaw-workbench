/**
 * 管理页 Worker 会话指示灯（重构回归）——「有 state 渲染灯 / 无 state 不渲染」。
 *
 * 渲染环境：本仓 vitest 是 node 环境，未装 jsdom/@testing-library，且本单禁装
 * 依赖。沿用 mf-workbench.vitest 先例：注入 window.QwenPaw.host（真 React +
 * 最小 Tooltip 桩）后用 react-dom/server 的 renderToStaticMarkup 静态渲染
 * （effects 不跑）。管理页 section 树体量太大（antd 面广、懒挂载子树多），
 * 故渲染断言打在门控组件 SessionDot 上；三处调用点的数据来源/透传走源码
 * 接线断言（同 a11y-static / c2-runtime-panel 风格）。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkerSessionState } from "../src/workerSessionState";

const here = dirname(fileURLToPath(import.meta.url));
const srcText = (rel: string): string =>
  readFileSync(join(here, "..", "src", rel), "utf8");
const E = React.createElement;

// window/host shim——必须在动态 import 业务模块之前就位（模块顶层读
// window.QwenPaw.host；WorkerSessionDot → WbTooltip → antd.Tooltip）。
(globalThis as Record<string, unknown>).window = {
  QwenPaw: {
    host: {
      kind: "server",
      React,
      antd: {
        Tooltip: (p: { title?: unknown; children?: unknown }) =>
          E(
            "span",
            { "data-tooltip": String(p.title ?? "") },
            p.children as React.ReactNode,
          ),
      },
      useLocale: () => "zh",
      useTheme: () => "light",
    },
  },
};

let SessionDot: React.FC<{ state?: WorkerSessionState }>;

beforeAll(async () => {
  ({ SessionDot } = await import("../src/components/WorkerSessionDot"));
});

describe("SessionDot 门控渲染（有 state 渲染 / 无 state 不渲染）", () => {
  it("running → 蓝灯呼吸 + aria-label 运行中 + 8px 圆点、名字旁 6px", () => {
    const html = renderToStaticMarkup(E(SessionDot, { state: "running" }));
    expect(html).toContain('class="wb-session-dot running"');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="运行中"');
    // 8px 圆点（不撑行高）+ marginLeft 6（紧邻名字，不额外占行高）。
    expect(html).toContain("width:8px");
    expect(html).toContain("height:8px");
    expect(html).toContain("margin-left:6px");
    expect(html).toContain("#3b82f6");
  });

  it("done / idle → 常亮不呼吸，文案与色板各自正确", () => {
    const done = renderToStaticMarkup(E(SessionDot, { state: "done" }));
    expect(done).toContain('class="wb-session-dot"');
    expect(done).not.toContain("running");
    expect(done).toContain('aria-label="运行完成"');
    expect(done).toContain("#52c41a");

    const idle = renderToStaticMarkup(E(SessionDot, { state: "idle" }));
    expect(idle).toContain('aria-label="无任务"');
    expect(idle).toContain("#c0c4cc");
  });

  it("无 state → 不渲染任何节点（空串，不留占位/不假装 idle）", () => {
    expect(renderToStaticMarkup(E(SessionDot, {}))).toBe("");
    expect(renderToStaticMarkup(E(SessionDot, { state: undefined }))).toBe("");
  });
});

describe("管理页三处接线（详情头 / 团队行 / 独立 Worker 行）", () => {
  const team = srcText("manage/TeamSection.tsx");
  const detail = srcText("manage/WorkerDetailPane.tsx");

  it("详情头：可选 sessionState prop，名字旁渲染灯", () => {
    expect(detail).toContain("sessionState?: WorkerSessionState");
    expect(detail).toContain("<SessionDot state={sessionState} />");
  });

  it("团队行：leader 会话态 lookup（row.leader 存在时）", () => {
    expect(team).toContain("workerSessionByName?.[row.leader.worker_name]");
    expect(team).toContain("<SessionDot state={leaderState} />");
  });

  it("独立 Worker 行：新增 prop 由 TeamSection 透传，每行 lookup 自身", () => {
    expect(team).toContain("workerSessionByName={workerSessionByName}");
    expect(team).toContain("workerSessionByName?.[n]");
    expect(team).toContain("<SessionDot state={st} />");
  });

  it("状态仍来自父层 workerSessionByName（section 不自派发/不新增请求）", () => {
    expect(team).toContain("workerSessionByName={data.workerSessionByName}");
    expect(team).toContain(
      "sessionState={data.workerSessionByName?.[workerInfo.name]}",
    );
    expect(team).not.toContain("useWorkerSessionStates(");
    expect(detail).not.toContain("useWorkerSessionStates(");
  });
});
