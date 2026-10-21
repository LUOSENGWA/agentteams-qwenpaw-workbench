// WorkbenchPage 拆分模块——主题与插件版本。
// 自 WorkbenchPage 单体原样搬移（技术债批次 D3b）；逻辑零改动，
// 壳持有的 React state 经 ctx 传入，标识符保持原名。

import { requestJson } from "./api";
import { useThemeColors } from "./theme";
import { useHostThemeTokens } from "./hostTheme";
import { useT } from "./i18n";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

export function useWorkbenchTheme() {

  const t = useThemeColors();
  // QwenPaw ≥2.2.2 配色跟随：主色 token 取自宿主生效主题（GET /config/theme，
  // 经 host.fetch 桥）；旧宿主/取不到 = 内置橙（DEFAULT_ACCENT，行为不变）。
  const hostTokens = useHostThemeTokens(t.mode);
  // theme 对象 memoize——此前每次 WP 渲染新建
  // （dark 时还产新数组字面量）→ antd ConfigContext 更新传播，React.memo
  // 面板挡不住 context 更新（WP 是最高频渲染组件）。t.mode/hostTokens
  // 稳定时 theme 引用稳定 → 下游 context 不重刷。
  const themeCfg = React.useMemo(
    () => ({
      algorithm:
        t.mode === "dark" ? [antd.theme.darkAlgorithm] : undefined,
      token: hostTokens,
    }),
    [t.mode, hostTokens],
  );
  const tr = useT();
  // 插件版本：从后端 /health 读（单一真相源 = agentteams_connector/__init__.py）。
  // 主显示改**构建
  // 期注入版本**（vite define __PLUGIN_VERSION__，来源 package.json）——
  // 永远等于当前 dist 的版本，不再受后端进程未随安装重启（health 滞后）
  // 或请求失败（旧版恒显占位「…」）影响；连接器运行版本仍查 /health，
  // 仅入 tooltip 对照说明。
  const pluginVersion = __PLUGIN_VERSION__;
  const [connectorVersion, setConnectorVersion] = React.useState("");
  React.useEffect(() => {
    let cancelled = false;
    void requestJson("/agentteams-proxy/health")
      .then((d) => {
        const v = (d as { version?: string })?.version;
        if (!cancelled && v) setConnectorVersion(v);
      })
      .catch(() => {
        /* 后端不可达：tooltip 少一行对照，不影响主显示 */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return {
    t,
    themeCfg,
    tr,
    pluginVersion,
    connectorVersion,
  };
}
