/**
 * harness/entry-roomchat.tsx — worker-run 内联折叠（§4.2/§4.3）浏览器验收入口
 *（不进 dist，esbuild 独立打包成 harness/bundle-roomchat.js；
 * 断言见 scripts/ui-harness-roomchat.mjs）。
 *
 * 数据 = 离线 fixture（RoomChat 直接吃 messages prop，零网络请求）：
 * ① 纯 worker run（未编辑）：「处理中...」占位根 + 3 条 m.thread 回复
 *    （w1×2 + w2×1）→ 内联原子块；占位根被吸收（只留 DOM 锚点），
 *    根行保留「3 条回复」ThreadIcon 摘要（线程面板入口不丢）；
 * ② 编辑过的纯 worker run：根带 editedAt（m.replace 聚合形态）→
 *    整块移到修订时刻槽位（落在 T0+30s 人类消息之后）；
 * ③ 混合线程（worker 根 + 人类回复）/ 人类线程 → 话题分组不内联，
 *    回复不进主时间线，根行显「1 条回复」摘要。
 */
import type * as ReactNS from "react";
const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

import RoomChat from "../src/components/RoomChat";
import { WbViewportProvider } from "../src/WbViewportContext";
import { PendingProvider } from "../src/pending/store";
import { setActiveTab } from "../src/tabActivity";
import type { RoomMessage, TeamRoom } from "../src/api";

// 真实应用 WorkbenchPage 切到 chat tab 时 setActiveTab("chat")；缺它时
// useTabActive("chat")=false → core 立即关话题（Drawer/inline 面板不开）。
setActiveTab("chat");

const W1 = "@w1:hs";
const W2 = "@w2:hs";
const ME = "@me:hs";
const T0 = 1_733_800_000_000;

function m(
  event_id: string,
  sender: string,
  ts: number,
  body: string,
  extra: Partial<RoomMessage> = {},
): RoomMessage {
  return { event_id, sender, origin_server_ts: ts, body, msgtype: "m.text", ...extra };
}

// 纯 worker run #1（未编辑）：占位根 + 线程回复（块锚 = T0+1000）。
const RUN1 = "$run1:hs";
const messages: RoomMessage[] = [
  m("evt-h1", ME, T0, "帮我重构聊天 UI"),
  m(RUN1, W1, T0 + 1000, "处理中...", { msgtype: "m.notice" }),
  m("evt-rr1a", W1, T0 + 2000, "Thinking:\n\n先看现有结构", {
    msgtype: "m.notice",
    threadRoot: RUN1,
    isThreadReply: true,
  }),
  m("evt-rr1b", W1, T0 + 3000, "✅ **read_file**:\nchat.ts", {
    threadRoot: RUN1,
    isThreadReply: true,
  }),
  m("evt-rr1c", W2, T0 + 4000, "最终回答：重构完成", {
    threadRoot: RUN1,
    isThreadReply: true,
  }),
  // 纯 worker run #2（编辑过）：根经 m.replace（fetchRoomMessages 聚合形态：
  // body=新文案 + edited + editedAt=修订事件 ts）；整块锚 = editedAt(T0+60s)，
  // 应整体落在 T0+30s 人类消息之后（块不与其它顶层消息交错）。
  m("evt-run2", W1, T0 + 20000, "已编辑的 worker 文案", {
    edited: true,
    editedAt: T0 + 60000,
    latestEventId: "evt-edit-run2",
  }),
  m("evt-rr2a", W1, T0 + 21000, "🔧 **grep**\nsrc/components", {
    threadRoot: "evt-run2",
    isThreadReply: true,
  }),
  m("evt-h3", ME, T0 + 30000, "中间的人类消息"),
  // 混合线程（worker 根 + 人类回复）：话题分组，不内联。
  m("evt-mix", W1, T0 + 70000, "混合线程根"),
  m("evt-mixr", ME, T0 + 71000, "混合线程人类回复", {
    threadRoot: "evt-mix",
    isThreadReply: true,
  }),
  // 人类线程：话题分组，不内联。
  m("evt-hroot", ME, T0 + 80000, "人类话题根"),
  m("evt-hreply", ME, T0 + 81000, "人类话题回复", {
    threadRoot: "evt-hroot",
    isThreadReply: true,
  }),
];

const ROOM = {
  room_id: "!chatui:hs",
  name: "任务房 · chat-ui",
  member_count: 3,
  members: {
    [ME]: { user_id: ME, displayname: "me", avatar_url: null },
    [W1]: { user_id: W1, displayname: "w1", avatar_url: null },
    [W2]: { user_id: W2, displayname: "w2", avatar_url: null },
  },
  last_ts: T0 + 82000,
  is_dm: false,
} as unknown as TeamRoom;

/** narrow 随窗口实时（与 WorkbenchPage measure 同口径：容器宽 < 800）。 */
function VpProvider(props: { children: ReactNS.ReactNode }) {
  const [vp, setVp] = React.useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    narrow: window.innerWidth < 800,
  }));
  React.useEffect(() => {
    const onResize = () =>
      setVp({
        width: window.innerWidth,
        height: window.innerHeight,
        narrow: window.innerWidth < 800,
      });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return <WbViewportProvider value={vp}>{props.children}</WbViewportProvider>;
}

function HarnessApp() {
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      {/* PendingProvider：真实应用在 index.tsx 层包裹（vitest 夹具同口径）。 */}
      <PendingProvider>
        <VpProvider>
          <RoomChat
            room={ROOM}
            messages={messages}
            user_id={ME}
            canSend={false}
            memberWorkerNames={{ [W1]: "w1", [W2]: "w2" }}
            workerMxids={new Set([W1, W2])}
          />
        </VpProvider>
      </PendingProvider>
    </div>
  );
}

const ReactDOM = (
  window as unknown as {
    ReactDOM: { createRoot: (el: Element) => { render: (n: ReactNS.ReactNode) => void } };
  }
).ReactDOM;
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<HarnessApp />);
