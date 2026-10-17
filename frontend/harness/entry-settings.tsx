/**
 * harness/entry-settings.tsx — 设置页「认证分家」UI 实证入口
 *（不进 dist；esbuild 独立打包成 harness/bundle-settings.js，
 * playwright 驱动断言，mock 数据面在 page-settings.html）。
 *
 * 覆盖 10/17 反馈件：Controller 管理员 token 与 Higress Console
 * 认证是两套独立系统——
 * S1 Higress 段是独立段：L1 管理面模式（token）下可见
 * S2 L2（matrix）模式下 Higress 段仍可见（不再被模式吞掉）
 * S3 Higress 验证失败 → 错误锚定 Higress 段（harness-fail-higress）
 * S4 Controller token 验证失败 → 错误锚定 Controller 段（harness-fail-controller）
 * S5 文案：「两个不同系统的凭证——不可互相替代」可见
 */
import type * as ReactNS from "react";
const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

import SettingsTab from "../src/components/SettingsTab";
import type { WorkbenchConfig } from "../src/api";

const CFG: WorkbenchConfig = {
  matrix_homeservers: [],
  controller_urls: [],
  controller_token: "",
  matrix: { user_id: "", access_token: "", device_id: "" },
  configPath: "/app/working.secret/agentteams-qwenpaw-workbench/config.json",
  configSavedAt: 1750000000,
  configWritable: true,
  config_rev: "harness",
  config_health: { state: "ok" },
};

function HarnessApp() {
  return (
    <div style={{ width: "100%" }}>
      <div id="settings" style={{ padding: 12, maxWidth: 1000 }}>
        <SettingsTab
          config={CFG}
          configLoadState="ready"
          onRetryConfig={() => {}}
          onConfigChange={() => {}}
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
