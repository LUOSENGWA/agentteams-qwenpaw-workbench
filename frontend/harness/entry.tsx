/**
 * harness/entry.tsx — v0.5.0-beta.13.7 UI 实证入口（不进 dist，esbuild 独立
 * 打包成 harness/bundle.js）。直接挂载四个目标组件，playwright 驱动断言。
 */
import type * as ReactNS from "react";
const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

import WorkerChats from "../src/components/WorkerChats";
import WorkerRuntimeConfig from "../src/components/WorkerRuntimeConfig";
import RoomChat from "../src/components/RoomChat";
import MdText from "../src/components/MdText";

const ROOM = {
  room_id: "!room1:hs",
  name: "test-room",
  is_dm: false,
} as never;

const now = 1761100000000;
const MSGS = [
  {
    event_id: "$e1",
    sender: "@w1:hs",
    body: "🔧 **read_file**\n```json\n{\"path\":\"README.md\"}\n```",
    msgtype: "m.text",
    origin_server_ts: now,
  },
  {
    event_id: "$e2",
    sender: "@w1:hs",
    body: "✅ **read_file**:\n# Title\ncontent here",
    msgtype: "m.text",
    origin_server_ts: now + 1000,
  },
  {
    event_id: "$e3",
    sender: "@w1:hs",
    body: "❌ **bash**:\nerror: no such file or directory",
    msgtype: "m.text",
    origin_server_ts: now + 2000,
  },
];

function HarnessApp() {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <section id="hc" style={{ border: "1px solid #ccc", padding: 8, height: 480, display: "flex", flexDirection: "column" }}>
        <div style={{ flex: "0 0 auto", fontSize: 12, marginBottom: 4 }}>WorkerChats</div>
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <WorkerChats workers={[{ name: "w1", role: "worker" } as never]} fixedWorker="w1" />
        </div>
      </section>
      <section id="hrc" style={{ border: "1px solid #ccc", padding: 8 }}>
        <div style={{ fontSize: 12, marginBottom: 4 }}>WorkerRuntimeConfig</div>
        <WorkerRuntimeConfig name="w1" />
      </section>
      <section id="hroom" style={{ border: "1px solid #ccc", padding: 8, height: 420, display: "flex", flexDirection: "column" }}>
        <div style={{ flex: "0 0 auto", fontSize: 12, marginBottom: 4 }}>RoomChat</div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <RoomChat
            room={ROOM}
            messages={MSGS as never}
            user_id="@me:hs"
            canSend={false}
            onSend={async () => undefined}
          />
        </div>
      </section>
      <section id="hmd" style={{ border: "1px solid #ccc", padding: 8 }}>
        <div style={{ fontSize: 12, marginBottom: 4 }}>MdText CodeBlock</div>
        <MdText text={"hello world\n\n```python\nprint('hi')\n```\n\ntail"} />
      </section>
    </div>
  );
}

const ReactDOM = (window as unknown as { ReactDOM: { createRoot: (el: Element) => { render: (n: ReactNS.ReactNode) => void } } }).ReactDOM;
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<HarnessApp />);
