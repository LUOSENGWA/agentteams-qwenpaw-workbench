/**
 * harness/entry-1322.tsx — v0.5.0-beta.13.22 UI 实证入口（不进 dist，
 * esbuild 独立打包成 harness/bundle-1322.js，playwright 驱动断言）。
 *
 * 覆盖 13.21 装验反馈 7 件中的 3 个高风险交互件：
 *  F2  工作流拓扑：第 5 项「Mermaid」视图退役 → 拓扑依赖图内 DAG/Mermaid
 *      样式切换（WorkflowBoard）。
 *  F5  房间卡未读徽章：从名称行内胶囊移到卡片头像右上角（TeamOverview，
 *      群卡新带头像）。
 *  F7  私聊角色：从列表直接分割改为列表下方筛选 chips（TeamOverview）。
 */
import type * as ReactNS from "react";
const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

import WorkflowBoard from "../src/components/WorkflowBoard";
import TeamOverview from "../src/components/TeamOverview";
import SkillCenter from "../src/components/SkillCenter";
import { GraphCard } from "../src/components/KnowledgeBase";

/* ── F1：onlyTeam 矩阵团队隔离 ──────────────────────────────────────── */
function F1Section() {
  return (
    <section id="f1" style={{ border: "1px solid #ccc", padding: 8 }}>
      <SkillCenter onlyTeam="teamA" sections={["matrix"]} />
    </section>
  );
}

/* ── F4：2D 图谱点选持久性（复现聚合模式旧父组件：graph 每次 render
 *     新对象引用 + 300ms 强制重渲染；旧 effect 会在下一次重渲染清
 *     selectedId=「箭头闪一下」）──────────────────────────────────── */
function F4Section() {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    const t = window.setInterval(() => setTick((x) => x + 1), 300);
    return () => window.clearInterval(t);
  }, []);
  void tick;
  return (
    <section id="f4" style={{ border: "1px solid #ccc", padding: 8 }}>
      <GraphCard
        graph={{
          nodes: [
            { id: "root", name: "团队知识库", virtual: true },
            { id: "f1.md", name: "文件一" },
            { id: "f2.md", name: "文件二" },
          ],
          edges: [
            { source: "root", target: "f1.md" },
            { source: "root", target: "f2.md" },
          ],
        }}
        loading={false}
        error=""
        onOpenNode={() => setTick((x) => x + 1)}
      />
    </section>
  );
}

const now = 1761100000000;

/* ── F2：拓扑视图 + 图样式切换 ───────────────────────────────────────── */
const EVENTS = [
  {
    runId: "run1",
    title: "Harness 项目",
    status: "running",
    room_id: "!r1:hs",
    room_name: "r1",
    sender: "@me:hs",
    ts: now,
    team_id: "team1",
    nodes: [
      { id: "t1", subagent: "w1", task: "任务一", dependsOn: [], status: "done" },
      { id: "t2", subagent: "w2", task: "任务二", dependsOn: ["t1"], status: "running" },
      { id: "t3", subagent: "w3", task: "任务三", dependsOn: ["t1", "t2"], status: "pending" },
    ],
  },
] as never[];

/* ── F5/F7：房间卡（2 群 + 3 私聊，未读/高亮/角色映射齐全）──────────── */
const ME = "@me:hs";
const ROOMS = [
  {
    room_id: "!g1:hs",
    name: "团队群A",
    member_count: 4,
    members: {
      [ME]: { name: "me" },
      "@leader:hs": { name: "leader" },
      "@worker1:hs": { name: "worker1" },
      "@worker2:hs": { name: "worker2" },
    },
    unread: 5,
    last_ts: now,
  },
  {
    room_id: "!g2:hs",
    name: "团队群B",
    member_count: 3,
    members: {
      [ME]: { name: "me" },
      "@worker2:hs": { name: "worker2" },
      "@worker3:hs": { name: "worker3" },
    },
    unread_highlight: 2,
    last_ts: now - 1000,
  },
  {
    room_id: "!d1:hs",
    name: "leader",
    member_count: 2,
    members: { [ME]: { name: "me" }, "@leader:hs": { name: "leader" } },
    unread: 3,
    last_ts: now - 2000,
  },
  {
    room_id: "!d2:hs",
    name: "worker1",
    member_count: 2,
    members: { [ME]: { name: "me" }, "@worker1:hs": { name: "worker1" } },
    last_ts: now - 3000,
  },
  {
    // 注：unread_highlight>0 的房间会被 Element 式「提及」区置顶摘出主列表
    // （mainRooms 剔除 isMention）——d3 保持普通未读，专供 F7 角色桶覆盖。
    room_id: "!d3:hs",
    name: "manager1",
    member_count: 2,
    members: { [ME]: { name: "me" }, "@manager1:hs": { name: "manager1" } },
    unread: 1,
    last_ts: now - 4000,
  },
] as never[];

const ROLE_MAP = {
  "@leader:hs": "Leader",
  "@worker1:hs": "Worker",
  "@worker2:hs": "Worker",
  "@worker3:hs": "Worker",
  "@manager1:hs": "Manager",
};

function HarnessApp() {
  return (
    <div style={{ display: "grid", gap: 16, padding: 12 }}>
      <section id="wf" style={{ border: "1px solid #ccc", padding: 8 }}>
        <WorkflowBoard
          events={EVENTS}
          loading={false}
          view="topo"
          onViewChange={() => undefined}
          topoRun="run1"
          onTopoRunChange={() => undefined}
          onRefresh={() => undefined}
        />
      </section>
      <section id="to" style={{ border: "1px solid #ccc", padding: 8 }}>
        <TeamOverview
          rooms={ROOMS}
          user_id={ME}
          loading={false}
          workerRoleByMxid={ROLE_MAP}
          onOpenRoom={() => undefined}
        />
      </section>
      <F1Section />
      <F4Section />
    </div>
  );
}

const ReactDOM = (window as unknown as { ReactDOM: { createRoot: (el: Element) => { render: (n: ReactNS.ReactNode) => void } } }).ReactDOM;
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<HarnessApp />);
