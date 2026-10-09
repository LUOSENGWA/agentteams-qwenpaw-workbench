/**
 * AgentTeams QwenPaw Workbench frontend entry.
 *
 * Two routes, one component:
 * - /apps/agentteams-qwenpaw-workbench (PawApp, via registerRoutes) → App Center +
 * desktop Dock window. /apps/ routes intentionally get NO sidebar menu.
 * ⚠ web console 的 PawApp 加载器按 plugin_type 门控
 * （expectedType="app"），本插件 manifest 有 meta.tools → 推断 TOOL →
 * web 端直接打开 /apps/ 会报 "PawApp frontend plugin not found"（实测
 * 2.2.2b4）。入口统一走 /plugin/（见下）；/apps/ 仅 desktop PawApp
 * 宿主场景保留。plugin.json meta.pawapp.entry_page 已指 /plugin/。
 * - /plugin/agentteams-qwenpaw-workbench (plain route, via route.add) → sidebar click
 * renders the page inline in the content area (no App shell)。全模式可用
 * （web console 侧栏「团队工作台」+ meta.pawapp.entry_page 默认入口）。
 *
 * Note: registerRoutes would synthesize a "Plugins" group header for any
 * non-/apps/ path — route.add avoids that (no empty group left behind). We
 * also remove a plugins-group left by earlier plugin versions.
 */
import type * as ReactNS from "react";
import LOGO_URL from "./lib/logo";

// ——
// 宿主 menu.add/registerRoutes 的 icon 接受 ReactNode（console types.ts
// 「ReactNode for custom」）：传 AgentTeams logo（?inline data URI）的
// <img> 元素；宿主 React 缺失的极端场景降级回 emoji。
const hostReact = window.QwenPaw?.host?.React;
const LOGO_ICON: ReactNS.ReactNode = hostReact
  ? hostReact.createElement("img", {
      src: LOGO_URL,
      width: 16,
      height: 16,
      alt: "",
      style: { display: "block" },
    })
  : "🏢";

// 侧栏 logo 待审批徽标——
// 轮询 /room-approvals（与通知中心同源），出现待审批即红点计数 + 图标
// 晃一次（wbTabShake）。宿主侧栏 icon 接受 ReactNode（console types.ts
// 「ReactNode for custom」）；宿主 React 缺失时降级回静态 LOGO_ICON。
// 轮询失败/未登录静默降级为 0（不打扰，也不误报）。
function SidebarApprovalIcon() {
  const [count, setCount] = hostReact.useState(() => getApprovalCount());
  const [shake, setShake] = hostReact.useState(false);
  const prevRef = hostReact.useRef(count);
  // 纯订阅：插件内活跃消费方（HomePage/NotificationCenter）真实取数或
  // SSE 审批事件失效缓存重取后，计数经 fetchRoomApprovals 内
  // publishApprovalCount 发布 → 本图标零拨号跟随。
  hostReact.useEffect(
    () => subscribeApprovalCount(() => setCount(getApprovalCount())),
    [],
  );
  // 60s 兜底轮询：覆盖「插件 tab 不活跃、无任何消费方在跑」的死角
  // （usePoller 内置 !document.hidden 暂停）。成本 4 拨/分 → 1 拨/分；
  // 活跃期新鲜度由上面订阅路径保证（≤15s，无额外拨号）。
  const backstop = hostReact.useCallback(async () => {
    try {
      await fetchRoomApprovals(30); // 成功即自动 publish（api 内）
    } catch {
      /* 未登录/后端不可达 → 静默 */
    }
  }, []);
  hostReact.useEffect(() => {
    void backstop();
  }, [backstop]);
  usePoller({ fn: backstop, intervalMs: 60000 });
  // 新增审批（0→n 或 n→n+m）触发一次震动（reduced-motion 由 CSS 关闭）。
  hostReact.useEffect(() => {
    if (count > prevRef.current) {
      setShake(true);
      const t = window.setTimeout(() => setShake(false), 1300);
      prevRef.current = count;
      return () => window.clearTimeout(t);
    }
    prevRef.current = count;
  }, [count]);
  return hostReact.createElement(
    "span",
    { style: { position: "relative", display: "inline-flex" } },
    hostReact.createElement("img", {
      src: LOGO_URL,
      width: 16,
      height: 16,
      alt: "",
      className: shake ? "wb-tab-shake" : undefined,
      style: {
        display: "block",
        animation: shake ? "wbTabShake 1.2s ease-in-out" : undefined,
      },
    }),
    count > 0
      ? hostReact.createElement(
          "span",
          {
            style: {
              position: "absolute",
              top: -5,
 left: -7, // 未读气泡左上角
              minWidth: 13,
              height: 13,
              lineHeight: "13px",
              padding: "0 3px",
              boxSizing: "border-box",
              borderRadius: 7,
              background: "#ff4d4f",
              color: "#fff",
              fontSize: 9,
              fontWeight: 700,
              textAlign: "center",
              border: "1px solid rgba(255,255,255,0.75)",
            },
          },
          count > 99 ? "99+" : String(count),
        )
      : null,
  );
}
const SIDEBAR_ICON: ReactNS.ReactNode = hostReact
  ? hostReact.createElement(SidebarApprovalIcon)
  : LOGO_ICON;

import WorkbenchPage from "./WorkbenchPage";
import ApprovalCard from "./components/ApprovalCard";
import { fetchRoomApprovals, requestJson } from "./api";
import { getApprovalCount, subscribeApprovalCount } from "./approvalsStore";
import { usePoller } from "./usePoller";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

// 全局动画 keyframes（工具条淡入上浮 / 线程面板滑入）。
// 挂在 document.head，插件卸载也不清理（无害，幂等定义）。
const WB_STYLE_ID = "agentteams-qwenpaw-workbench-keyframes";
if (typeof document !== "undefined" && !document.getElementById(WB_STYLE_ID)) {
  const style = document.createElement("style");
  style.id = WB_STYLE_ID;
  style.textContent = `
@keyframes wbToolbarIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes wbPanelIn {
  from { opacity: 0; transform: translateX(16px); }
  to { opacity: 1; transform: translateX(0); }
}
@keyframes wbMsgIn {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes wbResultIn {
  from { opacity: 0; transform: translateY(8px) scale(0.99); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes wbJumpIn {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}
/* Worker session 运行指示呼吸动画——照搬 QwenPaw
 AgentStatusIndicator 的 statusPulse（1.2s ease-in-out，opacity 1↔0.35 +
 box-shadow 扩散）。动画挂在 class 上（非内联），reduced-motion 可关。 */
@keyframes wbSessionPulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(59,130,246,0.5); }
  50% { opacity: 0.35; box-shadow: 0 0 0 4px rgba(59,130,246,0); }
}
.wb-session-dot.running {
  animation: wbSessionPulse 1.2s ease-in-out infinite;
}
/* ：聊天工作流卡 LIVE 徽标脉冲点（绿，节奏同
 wbSessionPulse 1.2s）。 */
@keyframes wbLivePulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(16,185,129,0.5); }
  50% { opacity: 0.4; box-shadow: 0 0 0 4px rgba(16,185,129,0); }
}
.wb-live-dot {
  animation: wbLivePulse 1.2s ease-in-out infinite;
}
/* 聊天输入区 loop 状态 chip 呼吸点（复用 wbSessionPulse
 蓝色节奏；awaiting_user 为静态琥珀点，不挂动画）。 */
.wb-loop-dot.running {
  animation: wbSessionPulse 1.2s ease-in-out infinite;
}
/* ：有待审批时侧栏 logo
 晃一次（bell shake，1.2s）；持续待批挂红点计数（静态，不循环晃）。 */
@keyframes wbTabShake {
  0%, 100% { transform: rotate(0); }
  15% { transform: rotate(-14deg); }
  30% { transform: rotate(11deg); }
  45% { transform: rotate(-8deg); }
  60% { transform: rotate(6deg); }
  75% { transform: rotate(-3deg); }
}
@media (prefers-reduced-motion: reduce) {
  .wb-session-dot.running { animation: none; }
  .wb-live-dot { animation: none; }
  .wb-loop-dot.running { animation: none; }
  .wb-tab-shake { animation: none !important; }
}
/* 页面布局（上下边界固定撑满屏幕，参考控制台）：
 main 撑满（height 100% + minHeight 兜底）+ flex column；header 固定；
 tab 内容区 tabpane 层滚动——nav 固定不动，聊天室输入区固定在
 tabpane 底部。注意：content-holder 用 overflow hidden（不是 auto），
 滚动只在 tabpane 层，避免双重滚动条。 */
.wb-main { height: 100%; }
.wb-main-tabs.ant-tabs {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.wb-main-tabs .ant-tabs-nav { flex: 0 0 auto; margin-bottom: 10px; }
.wb-main-tabs .ant-tabs-content-holder {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
.wb-main-tabs .ant-tabs-content { height: 100%; }
.wb-main-tabs .ant-tabs-tabpane {
  height: 100%;
  overflow: auto;
}
/* 控制台特效三档（console_effects，
 默认 light）取代旧 console_calm bool——旧 data-wb-calm 属性删除
 （迁移后不再写）：
 - off = 旧 calm 行为照搬（RunningGlow 旋转光环/呼吸层停动画，
 console 玻璃模糊全停）——最省电；
 - light = 动画全保留（上游观感），模糊半径封顶 6px（降重活、
 保观感），ambientLight 环境光层降透明；
 - full = 零覆盖（上游原样）。
 门控属性在 <html data-wb-fx="...">（启动先写 light，配置加载后覆写）。 */
html[data-wb-fx="off"] [class*="RunningGlow-module"],
html[data-wb-fx="off"] [class*="RunningGlow-module"] *,
html[data-wb-fx="off"] [class*="ambientLight"] {
  animation: none !important;
}
/* console 玻璃模糊选择器清单（各
 backdrop-filter 元素是核显常驻合成负担）。清单 = 对运行中
 qwenpaw 2.2.2b4 console dist CSS 的全量扫描（36 处声明 / 17 个选择器，
 实际 blur 规则全列；已 backdrop-filter:none 的规则——dockableSidebar
 floating/mainContentLayout header/settingsPage pageHeader/popover
 级联终值等——不重复列，仅保留任务指定的两条幂等防回归）。各元素
 背景均为 88–96% 不透明（--app-glass/--sidebar-sticky-bg 等）或高
 对比深色（x-markdown 调试层 #000 75–85%、floatingCapsule #000 50%
 白字），去模糊后可读性不受损，无需回退色。排除：antd 通知堆叠
 内联 blur(10px)（仅多条通知叠加时出现，非常驻）。 */
/* off 档：玻璃模糊全停。 */
html[data-wb-fx="off"] [class*="stickyGroupHeader"],
html[data-wb-fx="off"] [class*="dockableSidebar"][class*="floating"],
html[data-wb-fx="off"] [class*="layout-right-header"],
html[data-wb-fx="off"] .x-markdown-debug-modal-overlay,
html[data-wb-fx="off"] .x-markdown-debug-panel,
html[data-wb-fx="off"] [class*="index-module__header__"],
html[data-wb-fx="off"] [class*="index-module__pageHeader__"],
html[data-wb-fx="off"] [class*="floatingCapsule"],
html[data-wb-fx="off"] [class*="drawerHeader"],
html[data-wb-fx="off"] [class*="MemoryGraphView-module__legend"],
html[data-wb-fx="off"] [class*="HubShell-module__sidebar"],
html[data-wb-fx="off"] [class*="HubShell-module__topbar"] {
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}
/* light 档（默认）——同清单 blur 半径
 封顶 6px（保留玻璃观感，大幅降低大半径 blur 的合成负担）。 */
html[data-wb-fx="light"] [class*="stickyGroupHeader"],
html[data-wb-fx="light"] [class*="dockableSidebar"][class*="floating"],
html[data-wb-fx="light"] [class*="layout-right-header"],
html[data-wb-fx="light"] .x-markdown-debug-modal-overlay,
html[data-wb-fx="light"] .x-markdown-debug-panel,
html[data-wb-fx="light"] [class*="index-module__header__"],
html[data-wb-fx="light"] [class*="index-module__pageHeader__"],
html[data-wb-fx="light"] [class*="floatingCapsule"],
html[data-wb-fx="light"] [class*="drawerHeader"],
html[data-wb-fx="light"] [class*="MemoryGraphView-module__legend"],
html[data-wb-fx="light"] [class*="HubShell-module__sidebar"],
html[data-wb-fx="light"] [class*="HubShell-module__topbar"] {
  backdrop-filter: blur(6px) !important;
  -webkit-backdrop-filter: blur(6px) !important;
}
/* light 档：ambientLight 环境光层降透明（减小常驻合成面积，观感保留）。 */
html[data-wb-fx="light"] [class*="ambientLight"] {
  opacity: 0.55 !important;
}
/* light 档：1.2s infinite 呼吸动画暂停——75 房侧栏多状态点同屏时
 是持续合成层重绘源。paused 停在首帧（点仍可见、颜色/Tooltip 继续
 承载 running 语义），观感无损；off 档本就全停。 */
html[data-wb-fx="light"] .wb-session-dot.running,
html[data-wb-fx="light"] .wb-live-dot,
html[data-wb-fx="light"] .wb-loop-dot.running {
  animation-play-state: paused !important;
}
`;
  document.head.appendChild(style);
}
// 启动默认 light 档（配置加载后覆写为
// 落盘值；旧 data-wb-calm 属性已删除，迁移后不再写）。
if (typeof document !== "undefined") {
  document.documentElement.dataset.wbFx = "light";
}

// 特效档位跨页生效。 的配置驱动覆写只
// 写在 WorkbenchPage 的配置回填里（工作台挂载才执行），其余页面（chat、
// /plugin/*、设置……）永远停在模块级 light 默认。这里补全局同步：插件前端
// 启动即 GET /config，把 console_effects 写到 html[data-wb-fx]（取数失败
// 保持 light 默认）；window focus / visibilitychange 轻量复读（3s 节流 +
// 在飞去重，防多窗改档不同步）。与 WorkbenchPage 自身的回填/实时切换写同
// 值、互不干扰（其逻辑原样保留）。CSS 门控（[data-wb-fx]）本就是全页
// 选择器，无需改动。
const WB_FX_VALUES: readonly string[] = ["off", "light", "full"];

function applyWbFxFromConfig(cfg: unknown): void {
  const c =
    cfg && typeof cfg === "object" ? (cfg as Record<string, unknown>) : {};
  // 与 WorkbenchPage 回填同款兜底/迁移规则：新键 console_effects 优先，
  // 旧键 console_calm bool 仅 false→full（后端 load 已迁移，此为双保险）。
  const fx = c.console_effects ?? (c.console_calm === false ? "full" : "light");
  if (typeof fx === "string" && WB_FX_VALUES.includes(fx)) {
    document.documentElement.dataset.wbFx = fx;
  }
}

let _wbFxSyncPending: Promise<void> | null = null;
let _wbFxSyncAt = 0;
function syncWbFx(): Promise<void> {
  const now = Date.now();
  if (now - _wbFxSyncAt < 3000) return _wbFxSyncPending ?? Promise.resolve();
  _wbFxSyncAt = now;
  _wbFxSyncPending = requestJson("/agentteams-proxy/config")
    .then((cfg) => applyWbFxFromConfig(cfg))
    .catch(() => {
      /* 后端不可达/未登录 → 保持 light 默认（上方已写） */
    })
    .finally(() => {
      _wbFxSyncPending = null;
    });
  return _wbFxSyncPending;
}

if (typeof window !== "undefined") {
  void syncWbFx();
  const onWbFxReread = (): void => {
    if (document.visibilityState === "visible") void syncWbFx();
  };
  window.addEventListener("focus", onWbFxReread);
  document.addEventListener("visibilitychange", onWbFxReread);
}

// 宿主聊天审批卡定制渲染（Phase 4 审批流）：
// 覆盖工具审批主来源 driver_policy 的原生卡——批准/拒绝走同一后端
// POST /approval/{action} 链路，成功 onResolved 关闭卡片。
// agentteams 源——Worker 工具审批经后端 host_bridge
// 注入宿主收件箱（source_type="agentteams"），同一张卡渲染（卡内按
// toolParams.worker 区分显示 Worker/房间/审批请求详情）。
const APPROVAL_CARD_SOURCES = ["driver_policy", "agentteams"] as const;
try {
  for (const sourceType of APPROVAL_CARD_SOURCES) {
    window.QwenPaw.chat.approval.render(
      "agentteams-qwenpaw-workbench",
      sourceType,
      ({ approval, onResolved }) => (
        <ApprovalCard
          approval={approval as unknown as import("./components/ApprovalCard").ApprovalPayload}
          onResolved={onResolved}
        />
      ),
    );
  }
} catch (e) {
  // 2.0 宿主无 approval.render——静默降级（RoomChat 内审批卡不受影响）。
  console.warn("[agentteams-qwenpaw-workbench] chat.approval.render unavailable:", e);
}

window.QwenPaw.registerRoutes?.("agentteams-qwenpaw-workbench", [
  {
    path: "/apps/agentteams-qwenpaw-workbench",
    component: WorkbenchPage,
    label: "团队工作台",
    // /apps/ 路由的 icon 是死代码（宿主 shim 对 PawApp 路由只注册 route，
    // 不渲染 sidebar；类型也只收 string）——App Center 卡片 logo 走
    // plugin.json meta.pawapp.icon_url（data URI，desktop 模式生效）。
    icon: "🏢",
    priority: 0,
  },
]);

// Plain route for the sidebar (no menu synthesis, no plugins-group).
window.QwenPaw.route?.add("agentteams-qwenpaw-workbench", {
  id: "agentteams-qwenpaw-workbench.main",
  path: "/plugin/agentteams-qwenpaw-workbench",
  component: WorkbenchPage,
});

// Clean up the empty group header synthesized by v0.1.2/0.1.3/0.1.4.
window.QwenPaw.menu?.remove("plugins-group");
window.QwenPaw.menu?.remove("legacy:agentteams-qwenpaw-workbench:plugin/agentteams-qwenpaw-workbench");

// Sidebar entry in the agentScoped bucket (Inbox下方, order 12).
window.QwenPaw.menu?.add("agentteams-qwenpaw-workbench", {
  id: "agentteams-qwenpaw-workbench.sidebar",
  location: "primary.agentScoped",
  label: "团队工作台",
  icon: SIDEBAR_ICON,
  route: "agentteams-qwenpaw-workbench.main",
  order: 12, // right after core.inbox (10), before core.app-center (15)
});

export { React };
