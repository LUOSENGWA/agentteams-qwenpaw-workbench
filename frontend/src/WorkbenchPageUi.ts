// WorkbenchPage 拆分模块——tab/房间/UI 状态记忆。
// 自 WorkbenchPage 单体原样搬移（技术债批次 D3b）；逻辑零改动，
// 壳持有的 React state 经 ctx 传入，标识符保持原名。

import { type TeamRoom } from "./api";
import { readStartupPref } from "./components/SettingsTab";
import { setActiveTab as setActiveTabState } from "./tabActivity";

const host = window.QwenPaw.host;
const React = host.React;

export function useWorkbenchUi() {

 // ── 状态记忆：重开插件恢复上次 tab + 房间 + 话题 + 面板宽度 ──
  // tab key 随名字归位（房间 team→chat、管理 spawn→team）——
  // storage key 升 v2 区分新旧格式：否则新版写入的 "team"（管理）会被
  // 旧迁移表误判成 "chat"（房间）。旧 key 只读一次做迁移，迁完即删。
  const UI_STATE_KEY = "agentteams-qwenpaw-workbench:ui-state-v2";
  const UI_STATE_KEY_LEGACY = "agentteams-qwenpaw-workbench:ui-state";
  /** 旧 tab key 迁移：管理 admin→spawn；spawn→team（管理）、team（旧=房间）→chat。 */
  const UI_TAB_MIGRATION: Record<string, string> = {
    admin: "team",
    spawn: "team",
    team: "chat",
  };
  // v2 已存 key 的收编迁移（与 legacy 表不同——legacy 里
  // "team"=旧房间语义，v2 里 "team"=团队管理现行 key，不能共表）。
  const UI_TAB_MIGRATION_V2: Record<string, string> = {
    "skill-center": "team",
    // skills 区块已从配置页移除 → 旧持久化 tab
    // 落地首页（不再落设置页——该页已无技能区，落家最自然）。
    skills: "home",
  };
  const readUiState = (
    key: string,
  ): {
    tab?: string;
    roomId?: string;
    wfView?: string;
    wfTopo?: string;
    // P6：聊天分栏宽度（string 存储，读取时 Number 化）+ 房间列折叠状态。
    chatSplitW?: string;
    chatListHidden?: string;
    // 12.14：强制左右分栏开关（忽略宽度判定）。
    chatForceWide?: string;
  } => {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as ReturnType<typeof readUiState>;
      return typeof parsed === "object" && parsed ? parsed : {};
    } catch {
      return {};
    }
  };
  // 合并写——对象扩了 wfView/wfTopo 字段，切大 tab 不能把
  // 工作流页记忆冲掉（读旧值→合并→写回；storage 不可用静默跳过）。
  const mergeUiState = React.useCallback(
    (patch: Record<string, string>) => {
      try {
        const prev = readUiState(UI_STATE_KEY);
        window.localStorage.setItem(
          UI_STATE_KEY,
          JSON.stringify({ ...prev, ...patch }),
        );
      } catch {
        /* storage 不可用则跳过 */
      }
    },
    [],
  );
  const writeUiState = React.useCallback(
    (tabKey: string, roomId: string | null) => {
      mergeUiState({ tab: tabKey, roomId: roomId || "" });
    },
    [mergeUiState],
  );
  const initialUi = React.useRef<
    { tab?: string; roomId?: string; wfView?: string; wfTopo?: string } | null
  >(null);
  if (initialUi.current === null) {
    initialUi.current = readUiState(UI_STATE_KEY);
    // v2 已存的被收编 tab key 迁移（否则 activeKey 无
    // 匹配项 = 空白内容区）。
    const staleTab = initialUi.current.tab;
    if (staleTab && UI_TAB_MIGRATION_V2[staleTab]) {
      initialUi.current = {
        ...initialUi.current,
        tab: UI_TAB_MIGRATION_V2[staleTab],
      };
      try {
        window.localStorage.setItem(
          UI_STATE_KEY,
          JSON.stringify(initialUi.current),
        );
      } catch {
        /* storage 不可用则忽略 */
      }
    }
    if (!initialUi.current.tab) {
      // 升级后首次：读旧 key 迁移（admin/spawn=管理→team，team=房间→chat），
      // 立即写回 v2 再删旧 key，防下次启动回退首页。
      const legacy = readUiState(UI_STATE_KEY_LEGACY);
      if (legacy.tab) {
        const migrated = {
          ...legacy,
          tab: UI_TAB_MIGRATION[legacy.tab] ?? legacy.tab,
        };
        initialUi.current = migrated;
        try {
          window.localStorage.setItem(UI_STATE_KEY, JSON.stringify(migrated));
          window.localStorage.removeItem(UI_STATE_KEY_LEGACY);
        } catch {
          /* storage 不可用则跳过（回退首页兜底） */
        }
      }
    }
  }
  const [activeRoom, setActiveRoom] = React.useState<TeamRoom | null>(null);
  // 启动偏好："home" → 强制首页；"last"（默认）→ 恢复上次 tab（无记忆回退首页）。
  const [tab, setTabState] = React.useState(
    readStartupPref() === "home" ? "home" : initialUi.current.tab || "home",
  );
  const setTab = React.useCallback(
    (next: string) => {
 // 切换=非紧急更新——重渲染不阻塞
      // 点击反馈与输入（React 18 concurrent；memo 后渲染本身也变快）。
      React.startTransition(() => setTabState(next));
      writeUiState(next, activeRoom?.room_id || null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeRoom, writeUiState],
  );

  // ══ tab 栏窄屏横滚渐隐（P1）══
  // 11 个 tab 在 390px 竖屏只装 ~4 个——overflowX 横滚本已有但无任何
  // 视觉提示（scrollbar 隐藏）→ 用户不知道后面还有。业界做法
  // （shadcn scroll-fade / 各 tab 库）= 边缘渐隐；scroll-driven
  // animation（animation-timeline）iOS Safari 支持太晚 → 用
  // 兼容稳妥的「mask-image 固定渐变 + scroll 事件切态」：
  // 左缘可滚=左边渐隐，右缘可滚=右边渐隐，滚到头该侧消失。
  const tabBarRef = React.useRef<HTMLDivElement | null>(null);
  const [tabFade, setTabFade] = React.useState<
    "both" | "l" | "r" | "none"
  >("none");
  const updateTabFade = React.useCallback(() => {
    const el = tabBarRef.current;
    if (!el) return;
    const canL = el.scrollLeft > 2;
    const canR = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setTabFade(canL && canR ? "both" : canL ? "l" : canR ? "r" : "none");
  }, []);
  React.useEffect(() => {
    updateTabFade();
    window.addEventListener("resize", updateTabFade);
    return () => window.removeEventListener("resize", updateTabFade);
  }, [updateTabFade]);
  // 切 tab 后把目标 tab 滚入可见区（横滚栏 UX 必备——否则点了「配置」
  // 高亮在屏外，用户以为没选中）。
  const scrollTabIntoView = React.useCallback((key: string) => {
    requestAnimationFrame(() => {
      const el = tabBarRef.current?.querySelector<HTMLElement>(
        `[data-tabkey="${key}"]`,
      );
      el?.scrollIntoView({ inline: "nearest", block: "nearest" });
    });
  }, []);
 // 活跃 tab 单源（tabActivity）同步——各消费方
  // （useTabActive 布尔快照：HomePage/NotificationCenter/OpsPanel/RoomChat
 // 轮询门；从 useActiveTab 字符串快照切换）
  // 以本组件的 tab 状态为准，直接 setState 驱动（setTabState 直改处亦覆盖）。
  React.useEffect(() => {
    setActiveTabState(tab);
  }, [tab]);
 // 切页轻过渡（transform/opacity，仅 WAAPI）——
  // 170ms 淡入 + 4px 上浮，reduced-motion 守卫；不加 key 重挂（keep-alive
  // 面板的状态/滚动位置不受影响），动画结束 transform 自动还原。
  const paneRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    try {
      if (
        window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      )
        return;
      el.animate(
        [
          { opacity: 0.55, transform: "translateY(4px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 170, easing: "cubic-bezier(0.2,0.8,0.2,1)" },
      );
    } catch {
      /* noop */
    }
  }, [tab]);
  // team tab 强制刷新的节流时间戳。
  const lastTeamForceAtRef = React.useRef(0);
  // 工作流页 tab 记忆（用户「点开过的 tab 加上记忆，参考大
  // tab」）——与大 tab 同一 ui-state 对象（wfView/wfTopo 字段，合并写），
  // 不新造 storage key。WorkflowBoard 改受控（view/topoRun 由此下发）。
  // 「mermaid」视图退役并入拓扑——旧持久化值
  // wfView="mermaid"（13.21 装过 13.21 的用户）迁移到 "topo"（拓扑内可切
  // Mermaid 样式，体验不丢）。
  const WF_VIEW_VALUES = ["list", "card", "board", "topo"];
  const [wfMem, setWfMemState] = React.useState<{
    view: string;
    topoRun: string;
  }>(() => {
    const u = initialUi.current ?? {};
    const savedView = u.wfView === "mermaid" ? "topo" : (u.wfView || "");
    return {
      view: WF_VIEW_VALUES.includes(savedView) ? savedView : "list",
      topoRun: typeof u.wfTopo === "string" ? u.wfTopo : "",
    };
  });
  const setWfMem = React.useCallback(
    (patch: { view?: string; topoRun?: string }) => {
      setWfMemState((cur) => {
        const next = { ...cur, ...patch };
        mergeUiState({ wfView: next.view, wfTopo: next.topoRun });
        return next;
      });
    },
    [mergeUiState],
  );
  return {
    activeRoom,
    setActiveRoom,
    tab,
    setTab,
    setTabState,
    readUiState,
    mergeUiState,
    writeUiState,
    initialUi,
    UI_STATE_KEY,
    wfMem,
    setWfMem,
    tabBarRef,
    tabFade,
    updateTabFade,
    scrollTabIntoView,
    paneRef,
    lastTeamForceAtRef,
  };
}
