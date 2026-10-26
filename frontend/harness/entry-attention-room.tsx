/**
 * harness/entry-attention-room.tsx — attention 房间卡徽章(L2)/房间页 pill(L3)
 * smoke 入口（不进 dist，esbuild 独立打包成 harness/bundle-attention-room.js）。
 *
 * 挂载：① TeamOverview（任务群卡有 attention / DM 卡无）② 降级 TeamOverview
 *（不传 attentionPendingByRoom=deployed=false 同口径）③ RoomChat 宽屏头
 *（room=任务房，attentionPending 2 条 → 标题栏 pill，点击上报 window 标记）。
 */
import type * as ReactNS from "react";
const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

import TeamOverview from "../src/components/TeamOverview";
import RoomChat from "../src/components/RoomChat";

const now = Date.now();

const TASK_ROOM = {
  room_id: "!task1:hs",
  name: "TASK：demo-project",
  member_count: 4,
  members: {
    "@me:hs": { displayname: "me", avatar_url: null },
    "@w1:hs": { displayname: "w1", avatar_url: null },
    "@w2:hs": { displayname: "w2", avatar_url: null },
    "@w3:hs": { displayname: "w3", avatar_url: null },
  },
  last_ts: now,
  last_body: "需要一个决策",
  is_dm: false,
} as never;

const DM_ROOM = {
  room_id: "!dm1:hs",
  name: "私聊 · w1",
  member_count: 2,
  members: {
    "@me:hs": { displayname: "me", avatar_url: null },
    "@w1:hs": { displayname: "w1", avatar_url: null },
  },
  last_ts: now,
  last_body: "hello",
  is_dm: true,
} as never;

const ITEMS = [
  {
    task_id: "t-1",
    task_title: "demo task A",
    kind: "approval",
    question: "是否继续？",
    attempt: 1,
    requested_at: "2026-10-26T00:00:00Z",
    resolved: false,
    room_id: "!task1:hs",
    options: [{ id: "yes", label: "继续" }, { id: "no", label: "停止" }],
  },
  {
    task_id: "t-2",
    task_title: "demo task B",
    kind: "decision",
    question: "选哪个方案？",
    attempt: 1,
    requested_at: "2026-10-26T00:01:00Z",
    resolved: false,
    room_id: "!task1:hs",
  },
] as never[];

function HarnessApp() {
  return (
    <div style={{ display: "grid", gap: 24, padding: 16 }}>
      {/* ① L2 房间卡徽章：任务群卡有 2 条待决策，DM 卡无 */}
      <section id="sec-cards" style={{ border: "1px solid #ccc", padding: 8 }}>
        <div style={{ fontSize: 12, marginBottom: 4 }}>TeamOverview（L2 徽章）</div>
        <TeamOverview
          rooms={[TASK_ROOM, DM_ROOM]}
          user_id="@me:hs"
          attentionPendingByRoom={{ "!task1:hs": 2 }}
        />
      </section>
      {/* ② 降级：不传 attentionPendingByRoom（deployed=false 同口径）→ 无徽章 */}
      <section id="sec-cards-degraded" style={{ border: "1px solid #ccc", padding: 8 }}>
        <div style={{ fontSize: 12, marginBottom: 4 }}>TeamOverview（降级无徽章）</div>
        <TeamOverview rooms={[TASK_ROOM, DM_ROOM]} user_id="@me:hs" />
      </section>
      {/* ③ L3 房间页 pill：宽屏标题栏，pill 点击 → 父回调定位第一条 */}
      <section
        id="sec-room"
        style={{ border: "1px solid #ccc", padding: 8, height: 420, display: "flex", flexDirection: "column" }}
      >
        <div style={{ flex: "0 0 auto", fontSize: 12, marginBottom: 4 }}>RoomChat（L3 pill）</div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <RoomChat
            room={TASK_ROOM}
            messages={[] as never}
            user_id="@me:hs"
            canSend={false}
            attentionPending={ITEMS}
            onOpenRoomAttention={(room: { room_id: string }) => {
              (window as unknown as Record<string, unknown>).__ATTN_OPENED__ =
                room.room_id;
            }}
          />
        </div>
      </section>
    </div>
  );
}

const ReactDOM = (window as unknown as { ReactDOM: { createRoot: (el: Element) => { render: (n: ReactNS.ReactNode) => void } } }).ReactDOM;
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<HarnessApp />);
