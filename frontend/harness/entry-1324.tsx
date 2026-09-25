/**
 * harness/entry-1324.tsx — v0.5.0-beta.13.24 UI 实证入口（不进 dist，
 * esbuild 独立打包成 harness/bundle-1324.js，playwright 驱动断言）。
 *
 * 覆盖 13.24 六件装验反馈的 UI 面：
 *  A1  F4 未读气泡：数字居中 + 永不含住外（87 全显 / 12345 → 99+）
 *  A2  F5 DAG/Mermaid 合并：拓扑单一 DAG 视图（无 Mermaid 切换件）+
 *      层行居中布局 + 节点 hover 高亮（stroke 加粗）
 *  A3  F6 团队配置批量改模型：弹窗内 Leader 批 / Workers 批双画笔，
 *      刷值 → 行内模型框同步 + 「模型已改动」diff 标
 *  A4  F3 运行配置「系统」tab：审批级别内嵌 ApprovalControl（非只读）
 */
import type * as ReactNS from "react";
const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

import TeamOverview, {
  type TeamOverviewProps,
} from "../src/components/TeamOverview";
import WorkflowBoard from "../src/components/WorkflowBoard";
import CrdManage from "../src/components/CrdManage";
import WorkerRuntimeConfig from "../src/components/WorkerRuntimeConfig";
import type { AdminData, TeamRoom, WorkflowEvent } from "../src/api";

// ── A1 fixture：两群一 DM，未读 87 / 12345 / 1 ──────────────────────
const rooms: TeamRoom[] = [
  {
    room_id: "!a1-87:matrix.local",
    name: "群-未读87",
    member_count: 3,
    members: { "@m:matrix.local": { display_name: "m" } },
    last_ts: 1789000000001,
    last_body: "hello",
    unread: 87,
  },
  {
    room_id: "!a1-99plus:matrix.local",
    name: "群-未读12345",
    member_count: 4,
    members: { "@m:matrix.local": { display_name: "m" } },
    last_ts: 1789000000002,
    last_body: "world",
    unread: 12345,
  },
  {
    room_id: "!a1-dm:matrix.local",
    name: "",
    member_count: 2,
    members: { "@m:matrix.local": { display_name: "m" } },
    last_ts: 1789000000003,
    last_body: "dm",
    unread: 1,
  },
] as unknown as TeamRoom[];

// ── A2 fixture：3 层 DAG（0 → 1,2 → 3）────────────────────────────
const wfEvent: WorkflowEvent = {
  runId: "run-a2",
  title: "harness 项目",
  status: "in_progress",
  ts: 1789000000000,
  nodes: [
    { id: "t0", task: "根任务", status: "completed", subagent: "w-root" },
    { id: "t1", task: "左支", status: "in_progress", subagent: "w-left", dependsOn: ["t0"] },
    { id: "t2", task: "右支", status: "pending", subagent: "w-right", dependsOn: ["t0"] },
    { id: "t3", task: "汇合", status: "blocked", subagent: "w-join", dependsOn: ["t1", "t2"] },
  ],
} as unknown as WorkflowEvent;

// ── A3 fixture：团队 team-a（leader + 2 workers）────────────────────
const admin = {
  workers: [
    { name: "a-lead", phase: "Running", state: "Running", model: "model-old", runtime: "qwenpaw", containerState: "running", matrixUserID: "@a-lead:matrix.local", roomID: "!r:matrix.local", team: "team-a", role: "team_leader" },
    { name: "a-w1", phase: "Running", state: "Running", model: "model-old", runtime: "qwenpaw", containerState: "running", matrixUserID: "@a-w1:matrix.local", roomID: "!r:matrix.local", team: "team-a", role: "worker" },
    { name: "a-w2", phase: "Running", state: "Running", model: "model-old", runtime: "qwenpaw", containerState: "running", matrixUserID: "@a-w2:matrix.local", roomID: "!r:matrix.local", team: "team-a", role: "worker" },
  ],
  teams: [
    {
      name: "team-a",
      teamName: "team-a",
      phase: "Running",
      description: "harness team",
      leaderName: "a-lead",
      teamRoomID: "!r:matrix.local",
      leaderReady: true,
      readyWorkers: 2,
      totalWorkers: 3,
      workerNames: ["a-lead", "a-w1", "a-w2"],
      message: "",
      workerMembers: [
        { name: "a-lead", role: "team_leader" },
        { name: "a-w1", role: "worker" },
        { name: "a-w2", role: "worker" },
      ],
    },
  ],
  humans: [],
  managers: [],
} as unknown as AdminData;

function HarnessApp() {
  const [handle, setHandle] = React.useState<{ openConfig: (n: string) => void } | null>(null);
  // 弹窗由 harness 点击 #a3-open-config 触发（auto-open 的 ant-modal 遮罩
  // 会盖住 A1/A2 区，干扰其几何断言）。

  return (
    <div style={{ padding: 12, maxWidth: 860 }}>
      <section id="a1" style={{ border: "1px solid #ccc", padding: 8, marginBottom: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 13 }}>A1 F4 未读气泡</div>
        <TeamOverview
          {...({ rooms } as TeamOverviewProps)}
          user_id="@admin:matrix.local"
        />
      </section>

      <section id="a2" style={{ border: "1px solid #ccc", padding: 8, marginBottom: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 13 }}>A2 F5 DAG 单一视图</div>
        <WorkflowBoard
          events={[wfEvent]}
          loading={false}
          view="topo"
          onRefresh={() => undefined}
        />
      </section>

      <section id="a3" style={{ border: "1px solid #ccc", padding: 8, marginBottom: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 13 }}>
          A3 F6 批量改模型{" "}
          <button
            id="a3-open-config"
            type="button"
            onClick={() => handle && handle.openConfig("team-a")}
          >
            打开 team-a 配置弹窗
          </button>
        </div>
        <CrdManage
          admin={admin}
          registerHandle={(h) => setHandle(h)}
          onRefresh={() => undefined}
        />
      </section>

      <section id="a4" style={{ border: "1px solid #ccc", padding: 8, marginBottom: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 13 }}>A4 F3 系统 tab 审批可编辑</div>
        <WorkerRuntimeConfig name="w-f3" l1 />
      </section>
    </div>
  );
}

const ReactDOM = (
  window as unknown as {
    ReactDOM: {
      createRoot: (el: Element) => { render: (n: ReactNS.ReactNode) => void };
    };
  }
).ReactDOM;
ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement,
).render(<HarnessApp />);
