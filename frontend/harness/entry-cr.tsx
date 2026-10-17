/**
 * harness/entry-cr.tsx — Coding Runs 面板 UI 实证入口
 * （不进 dist；esbuild 独立打包成 harness/bundle-cr.js，playwright 驱动断言）。
 *
 * 覆盖 1.2.5 #1365/#1381 coding-runs 只读端点的消费端：
 * S1 列表（v2 字段：cli/worker/status/exit_code/team/时间双源）
 * S2 空态（[] → 暂无编码执行记录）
 * S3 未部署（404 → 当前版本未提供，不报错）
 * S4 详情 modal（meta 网格 + prompt + transcript）
 */
import type * as ReactNS from "react";
const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

import CodingRunsPanel from "../src/components/CodingRunsPanel";
import { setActiveTab } from "../src/tabActivity";

// 模拟 ops tab 激活（面板实际挂载于运维 tab；useTabActive("ops") 门控 30s 轮询）。
setActiveTab("ops");

function HarnessApp() {
  return (
    <div style={{ width: "100%" }}>
      <div id="cr" style={{ padding: 12, maxWidth: 900 }}>
        <CodingRunsPanel />
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
