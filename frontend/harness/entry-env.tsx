/**
 * harness/entry-env.tsx — Worker 环境变量 + 网关探测面板
 * UI 实证入口（不进 dist；esbuild 独立打包成 harness/bundle-env.js，
 * playwright 驱动断言）。
 *
 * 覆盖 1.2.5 #1306 消费端：
 * S1 full：折叠/展开 + 行渲染 + 添加行 → 脏 → 保存（PUT 全量 env 读回）
 *    + 模型探测成功卡 + 无 MCP 空态
 * S2 empty：envEditable=true 无 env → 空态
 * S3 l2：envEditable=false → 面板不渲染（L2 遮蔽）
 * S4 oldctl：无 env 字段（旧 Controller）→ 面板不渲染
 * S5 full：键名校验（非法/系统保留/重复）
 * S6 full：清空全部 → 二次确认 → PUT env={}
 */
import type * as ReactNS from "react";
const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

import WorkerEnvPanel from "../src/components/WorkerEnvPanel";

const scen =
  new URLSearchParams(location.search).get("scen") || "full";

const worker: Record<string, unknown> = {
  name: "w1",
  model: "qwen3.6-27b-fp8",
  runtime: "qwenpaw",
};
if (scen === "full") {
  worker.env = { FOO: "1", BAR: "x" };
  worker.envEditable = true;
} else if (scen === "empty") {
  worker.envEditable = true;
} else if (scen === "l2") {
  worker.env = {};
  worker.envEditable = false;
}
// scen === "oldctl"：不设 env / envEditable（旧 Controller 响应形态）。

function HarnessApp() {
  return (
    <div style={{ width: "100%" }}>
      <div id="env" style={{ padding: 12, maxWidth: 900 }}>
        <WorkerEnvPanel
          worker={worker as never}
          onChanged={() => {
            (window as unknown as { __CHANGED__?: boolean }).__CHANGED__ =
              true;
          }}
        />
      </div>
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
