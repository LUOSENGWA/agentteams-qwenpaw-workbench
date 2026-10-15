/* 本地离线模式入口页（本地插件宿主 shell，QP.host.isOffline）：
 * 数据域（会话/聊天/工作流/产物）整体不挂载——结构上消除 503 拨号与
 * 刷屏 toast；配置域（SettingsTab）保留可用，数据走 localStorage 模拟层
 * （offlineBackend.ts，脱敏/合并语义对齐服务端连接器）。
 *
 * 本地宿主 shell 无任何网络路径到 QwenPaw 服务端，故此处不设「重试连接」
 * 入口——连接恢复只能由用户在设备侧完成（安装并启动服务端后，经 Web
 * 控制台「备份与恢复 → 导入」应用此本地留存配置）。 */
import type * as ReactNS from "react";

import { useThemeColors } from "./theme";
import { useT } from "./i18n";
import { requestJson, type WorkbenchConfig } from "./api";
import SettingsTab from "./components/SettingsTab";

const host = window.QwenPaw.host;
const React = host.React;

export default function WorkbenchOfflinePage() {
  const tr = useT();
  const t = useThemeColors();
  const [config, setConfig] = React.useState<WorkbenchConfig | null>(null);
  const [loadState, setLoadState] = React.useState<"loading" | "ready" | "failed">("loading");

  const loadConfig = React.useCallback(async () => {
    setLoadState("loading");
    try {
      const data = (await requestJson("/agentteams-proxy/config")) as WorkbenchConfig;
      setConfig(data);
      setLoadState("ready");
    } catch {
      setLoadState("failed");
    }
  }, []);

  React.useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const bannerBox: React.CSSProperties = {
    border: `1px solid ${t.border}`,
    borderRadius: 8,
    padding: "10px 12px",
    background: t.cardBg,
  };

  const retryBtn: React.CSSProperties = {
    padding: "6px 18px",
    borderRadius: 6,
    border: `1px solid ${t.border}`,
    background: t.cardBg,
    color: t.text,
    fontSize: 13,
    cursor: "pointer",
  };

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: t.bg,
        color: t.text,
      }}
    >
      <div style={{ padding: "12px 16px 0" }}>
        <div style={bannerBox}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{tr("本地离线模式")}</div>
          <div style={{ marginTop: 4, fontSize: 12, color: t.textSecondary, lineHeight: 1.7 }}>
            {tr("本机无 QwenPaw 服务端——数据接口（会话 / 聊天 / 工作流 / 产物）不可用。")}{" "}
            {tr(
              "连接配置可先填写并保存（本地留存、凭据脱敏）。点「连接测试」会真实拨号探测每个地址：",
            )}{" "}
            {tr(
              "① 不可达=地址/网络问题；② 可达但未启用跨域（CORS）=浏览器直拨被拦。修复=在远程服务端配置 QWENPAW_CORS_ORIGINS（上游开关已存在），或在该服务端前配同源反代。",
            )}
          </div>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "12px 16px 16px" }}>
        {config !== null ? (
          <SettingsTab
            config={config}
            configLoadState={loadState}
            onRetryConfig={loadConfig}
            onConfigChange={loadConfig}
          />
        ) : loadState === "failed" ? (
          <div style={{ padding: 24, textAlign: "center" }}>
            <div style={{ color: t.textSecondary, fontSize: 13, marginBottom: 12 }}>
              {tr("本地配置加载失败")}
            </div>
            <button type="button" style={retryBtn} onClick={() => void loadConfig()}>
              {tr("重试")}
            </button>
          </div>
        ) : (
          <div style={{ padding: 24, textAlign: "center", color: t.textSecondary, fontSize: 13 }}>
            {tr("载入中…")}
          </div>
        )}
      </div>
    </div>
  );
}
