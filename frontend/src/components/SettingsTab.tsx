import type { WorkbenchConfig } from "../api";

import { useSettingsTabCore } from "./SettingsTabCore";
import { SettingsTabView } from "./SettingsTabView";

const host = window.QwenPaw.host;
const React = host.React;

const SettingsTab = React.memo(function SettingsTab({
  config,
  configLoadState,
  onRetryConfig,
  onConfigChange,
  onLoginSuccess,
  chatForceWide,
  onChatForceWideChange,
  sseState,
}: {
  config: WorkbenchConfig | null;
  // config 加载态（加载中横幅 / 失败+重试 / 保存钮门控）。
  configLoadState: "loading" | "ready" | "failed";
  onRetryConfig: () => void;
  onConfigChange: () => void;
  // 登录（账号切换）成功后 → 清本地旧账号数据 + 全量刷新。
  onLoginSuccess?: () => void;
  // 12.14：聊天分栏强制开关（忽略宽度判定）。
  chatForceWide?: boolean;
  onChatForceWideChange?: (v: boolean) => void;
  // (S1-4)：事件流连接态（设置页可见——排障一眼定位 S1 类问题）。
  sseState?: { status: "connected" | "reconnecting"; since: number };
}) {
  const c = useSettingsTabCore({ config, configLoadState, onRetryConfig, onConfigChange, onLoginSuccess, chatForceWide, onChatForceWideChange, sseState });
  return (
    <SettingsTabView p={{ config, configLoadState, onRetryConfig, onConfigChange, onLoginSuccess, chatForceWide, onChatForceWideChange, sseState }} c={c} />
  );
});
export default SettingsTab;
export { readStartupPref } from "./SettingsTabShared";
