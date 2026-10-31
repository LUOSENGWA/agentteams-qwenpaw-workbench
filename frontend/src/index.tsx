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
import { logoUrl as LOGO_URL } from "./lib/logo";

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
import StandaloneConfigPage from "./StandaloneConfigPage";
import { PendingProvider } from "./pending/store";
import { isLocalHost } from "./hostEnv";
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
 /* wbViewIn 已退役（10/30）：切页过渡统一走 WAAPI（WorkbenchPageUi paneRef），
 不再叠加 CSS keyframes，避免双重动画。 */
 @keyframes wbL2PushIn {
  from { opacity: 0; transform: translateX(14px); }
  to   { opacity: 1; transform: translateX(0); }
}
 @keyframes wbL2PopIn {
  from { opacity: 0; transform: translateX(-14px); }
  to   { opacity: 1; transform: translateX(0); }
}
 @keyframes wbSheetIn {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
/* Worker session 运行指示呼吸动画——照搬 QwenPaw
 AgentStatusIndicator 的 statusPulse（1.2s ease-in-out，opacity 1↔0.35 +
 box-shadow 扩散）。动画挂在 class 上（非内联），reduced-motion 可关。 */
@keyframes wbSessionPulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(59,130,246,0.5); }
  50% { opacity: 0.35; box-shadow: 0 0 0 4px rgba(59,130,246,0); }
}
/* SGLang 卡刷新脉冲（14.34）——每收到一帧负载快照，绿点 ping 一次
 （remount 重放）。取代恒显 0 的「快照 N 秒前」age 文字：空闲数值
 不变时也能肉眼看出正在刷新。 */
@keyframes wbSgTick {
  0% { box-shadow: 0 0 0 0 rgba(82,196,26,0.65); }
  100% { box-shadow: 0 0 0 6px rgba(82,196,26,0); }
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
/* 插件动效不受系统「减少动态效果」设置压制（10/30 定案）：
  状态点/转场/提示抖动都是插件 UI 设计的一部分，系统开关只影响系统层动效。 */
/* 页面布局（上下边界固定撑满屏幕，参考控制台）：
 main 撑满（height 100% + minHeight 兜底）+ flex column；header 固定；
 tab 内容区 tabpane 层滚动——nav 固定不动，聊天室输入区固定在
 tabpane 底部。注意：content-holder 用 overflow hidden（不是 auto），
 滚动只在 tabpane 层，避免双重滚动条。 */
.wb-main { height: 100%; }
/* .wb-main-tabs.* 布局链已删（10/30）：容器类从未在 TSX 挂载，规则永不命中；
 实际高度链由 WorkbenchPageShared WB_MAIN_CSS 双前缀规则 + 内联 style 承接。 */
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
/* 10/30 定案：console_effects 三档只控 QwenPaw Console 壳的特效
（玻璃模糊 / RunningGlow 光环 / ambientLight 环境光——都是宿主元素），
不再门控插件页内动效——状态点呼吸、转场、抖动等属于插件自身 UI，
任何档位都照常播放。旧 light 档状态点暂停规则已删。 */
/* 多行截断（跨 Chromium 版本安全的通用写法）。
 15.14 根因：内联 display:-webkit-box + -webkit-line-clamp 在 Chromium 154
 计算为 flow-root（盒模型损坏）——在 grid 容器内与 overflow:hidden 叠加时
 行高塌 0（看板已完成列 20 卡全变细条，真盘实证）。标准 block +
 max-height 兜底：旧版无 line-clamp 属性时退化为「硬截断不夹中间」，
 新版（Chromium 135+ 标准化 line-clamp）行为一致。类挂在 <div> 上
 （非内联 style），全仓 8 处 -webkit-box 统一迁移。 */
/* N 行 clamp（15.14 引入全局类以脱离内联 -webkit-box；15.20 根因修复：
   line-clamp 三件套（-webkit-box + box-orient + -webkit-line-clamp）缺一
   即整条失效——旧版只配 display:block + line-clamp + max-height，实测
   浏览器只执行 overflow:hidden + max-height，N 行之后再多露出
   (max-height − N×line-height) 的半行残字（看板卡项目名「整e」半行
   泄漏即此）。三件套是标准 line-clamp 实现组合（类 CSS 完整规则，非
   15.14 撞过的 React 内联样式），max-height 退役（clamp 自身控高，
   半行泄漏的载体）。 */
.wb-clamp-1, .wb-clamp-2, .wb-clamp-3 {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.wb-clamp-1 { -webkit-line-clamp: 1; line-clamp: 1; }
.wb-clamp-2 { -webkit-line-clamp: 2; line-clamp: 2; }
.wb-clamp-3 { -webkit-line-clamp: 3; line-clamp: 3; }
/* antd Tabs 导航条：溢出时可横滚（鼠标滚轮横滚由全局 wheel 委托驱动，
 见 index.tsx 模块级 listener）。滚动条隐藏（与顶栏自写 tab 条同款
 scrollbar-width:none + webkit 伪元素）。 */
.wb-main .ant-tabs-nav-wrap,
.wb-main .qwenpaw-tabs-nav-wrap {
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.wb-main .ant-tabs-nav-wrap::-webkit-scrollbar,
.wb-main .qwenpaw-tabs-nav-wrap::-webkit-scrollbar {
  display: none;
  height: 0;
}
/* ══ 44px 触控目标全局档（.wb-touch = 入口检测挂的 html 类，见本文件
   模块级 matchMedia 块）═══════════════════════════════════════════════
   纯触屏/粗指针设备（平板、笔记本触屏）把主控件命中区放大到 44px——
   移动端触控目标通行下限（Apple HIG 44pt / Material 48dp 的下界档）。
   桌面（fine 指针 + hover）不加类 → 本段全部规则零生效。
   与现有触屏档不叠加：.wb-touch-lg = 15.33 逐点 ::before 扩命中区
   （视觉尺寸不变，高频路径）；.wbc-narrow .ant-btn-sm 32px = 表单内
   小按钮地板（dense 例外）。本档只管「主控件」默认尺寸（非 sm），
   min-height 只增不减，与逐点档共存不冲突。前缀双写（宿主 antd
   自定义前缀分支 qwenpaw-*）。 */
/* 非 sm 按钮 min-height 44（含图标钮宽度 44，纯图标钮方形命中区）。 */
.wb-touch .ant-btn:not(.ant-btn-sm),
.wb-touch .qwenpaw-btn:not(.qwenpaw-btn-sm) {
  min-height: 44px;
}
.wb-touch .ant-btn-icon-only:not(.ant-btn-sm),
.wb-touch .qwenpaw-btn-icon-only:not(.qwenpaw-btn-sm) {
  min-width: 44px;
}
/* tab 条：li 层 min-height 44（内层 tab-btn 是居中 flex 行，高度跟随）。 */
.wb-touch .ant-tabs-tab,
.wb-touch .qwenpaw-tabs-tab {
  min-height: 44px;
}
/* 分段器：外壳与 item 40+（外壳自带固定 height，min-height 覆盖后仍
   生效——min-height ≥ height）。 */
.wb-touch .ant-segmented,
.wb-touch .qwenpaw-segmented,
.wb-touch .ant-segmented-item,
.wb-touch .qwenpaw-segmented-item {
  min-height: 40px;
}
/* 独立输入 / 选择器触发盒 min-height 44（sm 尺寸是 dense 场景例外，
   与按钮档同口径排除）。 */
.wb-touch .ant-input:not(.ant-input-sm),
.wb-touch .qwenpaw-input:not(.qwenpaw-input-sm),
.wb-touch .ant-select:not(.ant-select-sm) .ant-select-selector,
.wb-touch .qwenpaw-select:not(.qwenpaw-select-sm) .qwenpaw-select-selector {
  min-height: 44px;
}
/* 开关：antd 轨道 = 元素自身背景，直接加 padding 会放大轨道（违
   「轨道本身不动」约束）→ 同 .wb-touch-lg 手法 ::before 扩命中区
   （默认轨道 44×22：上下各扩 11px = 44px 命中高，左右各 6px 留余量；
   视觉尺寸/位置不变）。antd 的 switch handle 占 ::after，::before 空着。 */
.wb-touch .ant-switch,
.wb-touch .qwenpaw-switch {
  position: relative;
}
.wb-touch .ant-switch::before,
.wb-touch .qwenpaw-switch::before {
  content: "";
  position: absolute;
  top: -11px;
  left: -6px;
  right: -6px;
  bottom: -11px;
}
/* 小号轨道 h=16：±11 仅 38px 不够 → ±14（16+28=44）。 */
.wb-touch .ant-switch-small::before,
.wb-touch .qwenpaw-switch-small::before {
  top: -14px;
  bottom: -14px;
}
/* 一键置底钮（RoomChat 主列表）：纯 div 圆无 antd Button 的 hover/active
   状态 → 本类补状态反馈（结构=外层 44×44 命中盒 + 内层 38 视觉圆，见
   RoomChat.tsx）：hover 微放大、active 缩放 0.95。transform 纯视觉不影响
   布局（列内 flex 项）。 */
.wb-jumpbottom {
  transition: transform 0.12s ease-out;
}
.wb-jumpbottom:hover {
  transform: scale(1.04);
}
.wb-jumpbottom:active {
  transform: scale(0.95);
}
/* 页面转场：切页=WAAPI（paneRef wrapper，WorkbenchPageUi）；L2/弹窗=CSS。
 10/30 定案：不跟随系统「减少动态效果」设置。 */
.wb-l2-push { animation: wbL2PushIn 220ms cubic-bezier(0.2, 0, 0, 1); }
.wb-l2-pop  { animation: wbL2PopIn  220ms cubic-bezier(0.2, 0, 0, 1); }
.wb-sheet-in { animation: wbSheetIn 200ms cubic-bezier(0.2, 0, 0, 1); }
`;
  document.head.appendChild(style);
}
// 启动默认 light 档（配置加载后覆写为
// 落盘值；旧 data-wb-calm 属性已删除，迁移后不再写）。
if (typeof document !== "undefined") {
  document.documentElement.dataset.wbFx = "light";
}

// 触屏检测（44px 目标档）：纯触屏 / 粗指针设备（平板、笔记本触屏）→
// html.wb-touch；全局样式表 .wb-touch 作用域规则把主控件（非 sm 按钮、
// tab、分段、输入/选择器、开关）放大到 44px 触控目标。桌面（fine +
// hover）不加类 → 全部规则零生效，桌面路径零改动。
if (
  typeof document !== "undefined" &&
  window.matchMedia("(hover: none), (pointer: coarse)").matches
) {
  document.documentElement.classList.add("wb-touch");
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

// 插件内所有「纯横向滚动条」（顶栏 tab 条 / 视图切换 / 技能 tab 条 /
// antd Tabs nav……）统一支持鼠标滚轮横滚（15.14 点名：「顶部 tab
// 可以用鼠标滚动，其他 tab 也是」）。
// 委托实现（capture 阶段挂 document，一次覆盖全部 tab 条）：
//  1. 只认插件渲染区（.wb-main / .wb-offline-page）内的目标——console
//     本体与宿主聊天页零影响；
//  2. 从事件目标向上找最近的「可横滚且不可纵滚」祖先：
//     overflow-x auto/scroll + scrollWidth 超宽 + scrollHeight 不超高。
//     纵向可滚的容器（消息流 / 看板卡区 / 页面）一律不劫持——滚给它们
//     自己（防「滚轮想滚消息结果在滚 tab」的事故）；
//  3. 边缘放行：已到横滚边界且滚轮方向继续往外 → 不 preventDefault，
//     交回页面纵向滚动（与桌面端「滚到头穿透」手感一致）。
if (typeof document !== "undefined") {
  document.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; // 已横滚输入不劫持
      const target = e.target as HTMLElement | null;
      if (!target || !target.closest(".wb-main, .wb-offline-page")) return;
      let el: HTMLElement | null = target;
      while (el && el !== document.body) {
        const s = getComputedStyle(el);
        const hScroll =
          (s.overflowX === "auto" || s.overflowX === "scroll") &&
          el.scrollWidth > el.clientWidth + 4;
        const vScroll =
          (s.overflowY === "auto" || s.overflowY === "scroll") &&
          el.scrollHeight > el.clientHeight + 4;
        if (hScroll && !vScroll) {
          const atStart = el.scrollLeft <= 0;
          const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
          if ((e.deltaY < 0 && atStart) || (e.deltaY > 0 && atEnd)) return;
          el.scrollLeft += e.deltaY;
          e.preventDefault();
          return;
        }
        el = el.parentElement;
      }
    },
    { passive: false, capture: true },
  );
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

// 入口分流（两轴模型，hostEnv.ts）：轴 A 独立宿主（kind='local'，旧 shell
// 回退 isOffline）挂独立配置页（数据域不挂载，配置域走 localStorage 模拟
// 层）；caps.net 端侧桥落地后 local+数据面可达改挂完整工作台（P2）。
// console/远端宿主（server）照旧挂全量工作台。分流在渲染时读 host 标志——
// 同一份产物两端通用，console 路径零改动。
function WorkbenchEntry() {
  return isLocalHost()
    ? React.createElement(StandaloneConfigPage)
    // P0 人工介入闭环：pending store（待处理池 + resolutions）是
    // 工作台级单例——RoomChatCore 摄取 / 三源同步 / 通知中心消费
    // 都在 provider 子树内。
    : React.createElement(PendingProvider, null, React.createElement(WorkbenchPage));
}

window.QwenPaw.registerRoutes?.("agentteams-qwenpaw-workbench", [
  {
    path: "/apps/agentteams-qwenpaw-workbench",
    component: WorkbenchEntry,
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
  component: WorkbenchEntry,
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
