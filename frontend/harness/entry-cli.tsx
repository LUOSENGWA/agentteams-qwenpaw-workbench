/**
 * harness/entry-cli.tsx — Worker Coding CLI 面板 UI 实证入口
 *（不进 dist；esbuild 独立打包成 harness/bundle-cli.js，
 * playwright 驱动断言，mock 数据面在 page-cli.html）。
 *
 * 覆盖 1.2.5 #1360 消费端：
 * S1 full：折叠头 → 展开 → 三 CLI 行（installed/version/auth 徽标）
 * S2 full：opencode 安装（202 task → 1.5s 轮询 → done → 重拉列表）
 * S3 full：qwen-code 卸载二次确认 modal → POST uninstall
 * S4 full：settings 编辑（模型名 + redacted 密钥留空=*** 哨兵 + JSON 补丁）
 * S5 full：preset p-gencode（空 patch）→ 只标记不 PUT + 建议清单
 * S6 l2：PUT 403 → 只读横幅
 * S7 404：GET 404 → 「暂不可用，升级 AgentTeams 后自动生效」
 */
import type * as ReactNS from "react";
const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

import WorkerCodingCliPanel from "../src/components/WorkerCodingCliPanel";

const scen = new URLSearchParams(location.search).get("scen") || "full";

function HarnessApp() {
  return (
    <div style={{ width: "100%" }}>
      <div id="cli" style={{ padding: 12, maxWidth: 900 }}>
        <WorkerCodingCliPanel
          worker={{ name: "w1" } as never}
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
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <HarnessApp />,
);
