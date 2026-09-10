/**
 * AgentTeams QwenPaw Workbench frontend entry.
 *
 * Two routes, one component:
 * - /apps/agentteams-qwenpaw-workbench (PawApp, via registerRoutes) → App Center +
 *   desktop Dock window. /apps/ routes intentionally get NO sidebar menu.
 * - /plugin/agentteams-qwenpaw-workbench (plain route, via route.add) → sidebar click
 *   renders the page inline in the content area (no App shell).
 *
 * Note: registerRoutes would synthesize a "Plugins" group header for any
 * non-/apps/ path — route.add avoids that (no empty group left behind). We
 * also remove a plugins-group left by earlier plugin versions.
 */
import type * as ReactNS from "react";

import WorkbenchPage from "./WorkbenchPage";
import ApprovalCard from "./components/ApprovalCard";

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
/* 页面布局（用户 8/15「上下边界固定撑满屏幕，参考控制台」）：
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
// v0.5.0-beta.11 re7：agentteams 源——Worker 工具审批经后端 host_bridge
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
  icon: "🏢",
  route: "agentteams-qwenpaw-workbench.main",
  order: 12, // right after core.inbox (10), before core.app-center (15)
});

export { React };
