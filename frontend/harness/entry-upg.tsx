/**
 * harness/entry-upg.tsx — 运行时升级面板 UI 实证入口
 * （不进 dist；esbuild 独立打包成 harness/bundle-upg.js，playwright 驱动断言）。
 *
 * 覆盖 1.2.5 #1364/#1343 消费端三态：
 * U1 预检列表（候选 + C1-C4 门控 + 推荐/不可升级/预发布/告警）
 * U2 404 降级（无升级服务 → 空态不报错）
 * U3 触发流（确认 modal → run 202 → job 跟踪卡 + log_tail）
 */
import type * as ReactNS from "react";
const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

import RuntimeUpgradePanel from "../src/components/RuntimeUpgradePanel";
import { setActiveTab } from "../src/tabActivity";

// 模拟 ops tab 激活（面板实际挂载于运维 tab；useTabActive("ops") 门控 job 轮询）。
setActiveTab("ops");

function HarnessApp() {
  return (
    <div style={{ width: "100%" }}>
      <div id="upg" style={{ padding: 12, maxWidth: 900 }}>
        <RuntimeUpgradePanel />
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
