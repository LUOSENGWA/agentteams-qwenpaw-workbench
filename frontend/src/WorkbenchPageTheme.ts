// WorkbenchPage 拆分模块——主题与插件版本。
// 自 WorkbenchPage 单体原样搬移（技术债批次 D3b）；逻辑零改动，
// 壳持有的 React state 经 ctx 传入，标识符保持原名。

import { requestJson } from "./api";
import { usePoller } from "./usePoller";
import { useThemeColors } from "./theme";
import { useHostThemeTokens } from "./hostTheme";
import { useT } from "./i18n";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

/** 连接器实时版本（GET /agentteams-proxy/health 的 version 字段——
 * 后端进程实际加载的版本，单一真相源）。立即拉取一次 + 固定间隔轮询
 * （默认 60s：插件热加载/升级后不刷页面也会跟上）。失败静默保留上次值
 * ——回退构建期版本的决定在调用方（connectorVersion || buildVersion）。 */
export function useConnectorVersion(intervalMs = 60_000): string {
  const [v, setV] = React.useState("");
  const mountedRef = React.useRef(true);
  React.useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );
  const load = React.useCallback(() => {
    void requestJson("/agentteams-proxy/health")
      .then((d) => {
        const ver = (d as { version?: string })?.version;
        if (mountedRef.current && ver) setV(ver);
      })
      .catch(() => {
        /* 后端不可达（未起/重启中）：保留上次值——调用方回退构建期版本 */
      });
  }, []);
  // 首渲立即拉一次（保持原「挂载即拉」语义；poller 首 tick 要等一个间隔）。
  React.useEffect(() => {
    load();
  }, [load]);
  // R4（16.23）：裸 setInterval → usePoller——后台 tab（document.hidden）
  // 不再每 60s 拨 /health；visibility 门控 + 回前台 catch-up 补跑均内置。
  usePoller({ fn: load, intervalMs });
  return v;
}

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
  // 版本显示（16.11 口径）：主显示 = /health 实时版本（60s 轮询——
  // 后端进程实际加载的版本，单一真相源 = agentteams_connector/
  // __init__.py；旧口径「构建期常量为主」会在旧 dist 缓存时恒显旧版）。
  // 取不到（后端未起/首载竞态/旧版无字段）→ 回退构建期注入版本
  // （vite define __PLUGIN_VERSION__，来源 package.json = 当前 dist 版本）。
  // 两者不一致时页头 tooltip 对照说明（前端 {build} · 连接器 {health}）。
  const buildVersion = __PLUGIN_VERSION__;
  const connectorVersion = useConnectorVersion(60_000);
  const pluginVersion = connectorVersion || buildVersion;
  return {
    t,
    themeCfg,
    tr,
    pluginVersion,
    connectorVersion,
    buildVersion,
  };
}
