/**
 * AgentTeams QwenPaw Workbench frontend entry.
 *
 * Two routes, one component:
 * - /apps/agentteams-qwenpaw-workbench (PawApp, via registerRoutes) → App Center +
 * desktop Dock window. /apps/ routes intentionally get NO sidebar menu.
 * - /plugin/agentteams-qwenpaw-workbench (plain route, via route.add) → sidebar click
 * renders the page inline in the content area (no App shell).
 *
 * Note: registerRoutes would synthesize a "Plugins" group header for any
 * non-/apps/ path — route.add avoids that (no empty group left behind). We
 * also remove a plugins-group left by earlier plugin versions.
 */
import type * as ReactNS from "react";
import LOGO_URL from "./lib/logo";

// v0.5.0-beta.12.2（用户反馈：去掉占位 emoji，直接用 AgentTeams logo）——
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

// v0.5.0-beta.13.11（F5 QwenPaw 同款 Tab 震动）：侧栏 logo 待审批徽标——
// 轮询 /room-approvals（与通知中心同源），出现待审批即红点计数 + 图标
// 晃一次（wbTabShake）。宿主侧栏 icon 接受 ReactNode（console types.ts
// 「ReactNode for custom」）；宿主 React 缺失时降级回静态 LOGO_ICON。
// 轮询失败/未登录静默降级为 0（不打扰，也不误报）。
function SidebarApprovalIcon() {
  const [count, setCount] = hostReact.useState(0);
  const [shake, setShake] = hostReact.useState(false);
  const prevRef = hostReact.useRef(0);
  hostReact.useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const list = await fetchRoomApprovals(30);
        if (alive) setCount(Array.isArray(list) ? list.length : 0);
      } catch {
        /* 未登录/后端不可达 → 静默 0 */
      }
    };
    void poll();
    const id = window.setInterval(() => void poll(), 15000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);
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
              right: -7,
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
import { fetchRoomApprovals } from "./api";

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
/* v0.5.0-beta.12.4（A17）：Worker session 运行指示呼吸动画——照搬 QwenPaw
   AgentStatusIndicator 的 statusPulse（1.2s ease-in-out，opacity 1↔0.35 +
   box-shadow 扩散）。动画挂在 class 上（非内联），reduced-motion 可关。 */
@keyframes wbSessionPulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(59,130,246,0.5); }
  50% { opacity: 0.35; box-shadow: 0 0 0 4px rgba(59,130,246,0); }
}
.wb-session-dot.running {
  animation: wbSessionPulse 1.2s ease-in-out infinite;
}
/* v0.5.0-beta.12.8（第 11 轮）：聊天工作流卡 LIVE 徽标脉冲点（绿，节奏同
   wbSessionPulse 1.2s）。 */
@keyframes wbLivePulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(16,185,129,0.5); }
  50% { opacity: 0.4; box-shadow: 0 0 0 4px rgba(16,185,129,0); }
}
.wb-live-dot {
  animation: wbLivePulse 1.2s ease-in-out infinite;
}
/* v0.5.0-beta.13.6：聊天输入区 loop 状态 chip 呼吸点（复用 wbSessionPulse
   蓝色节奏；awaiting_user 为静态琥珀点，不挂动画）。 */
.wb-loop-dot.running {
  animation: wbSessionPulse 1.2s ease-in-out infinite;
}
/* v0.5.0-beta.13.11（F5 QwenPaw 同款 Tab 震动）：有待审批时侧栏 logo
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
/* 页面布局（用户反馈「上下边界固定撑满屏幕，参考控制台」）：
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
`;
  document.head.appendChild(style);
}

// 宿主聊天审批卡定制渲染（Phase 4 审批流）：
// 覆盖工具审批主来源 driver_policy 的原生卡——批准/拒绝走同一后端
// POST /approval/{action} 链路，成功 onResolved 关闭卡片。
// v0.5.0-beta.12 agentteams 源——Worker 工具审批经后端 host_bridge
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
