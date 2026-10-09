import type * as ReactNS from "react";

const PRIMARY = "var(--app-accent, #FF7F16)"; // 品牌主色

import {
  fetchAdminData,
  fetchRoomMessages,
  type RoomMessagesPage,
  enrichWorkflowRoomNames,
  fetchTeamsStructure,
  fetchRoomPowerInfo,
  fetchTeamsSync,
  renameRoom,
  fetchWorkflowEvents,
  fetchWorkflowProjects,
  fetchWorkerSpawns,
  getCachedMessages,
  getCachedRooms,
  markAllRoomsRead,
  markRoomRead,
  openDm,
  redactRoomMessage,
  requestJson,
  roomMatchesProject,
  leaveRoom,
  sendRoomMessage,
  sendApprovalCommand,
  sendRoomMessageEdit,
  sendRoomFile,
  sendReaction,
  setRoomMuted,
  testAddresses,
  uploadMedia,
  entryUrl,
  exportFullConfig,
  importFullConfig,
  setCachedMessages,
  setCachedRooms,
  verifyAdmin,
  type AdminData,
  type VerifyAdminResult,
  type AddressEntry,
  type AddressTestResult,
  type ConfigTestResponse,
  type L3RoomResult,
  type ProbeDiag,
  type RoomMessage,
  type SelfCheckResult,
  type SpawnNode,
  type TeamRoom,
  type InviteRoom,
  type WorkbenchConfig,
  type WorkerTreeTeam,
  type WorkflowEvent,
  fetchAuthStatus,
  type AuthStatus,
} from "./api";
// v0.5.0-beta.13.20：群消息加载收敛——窗口游标/预取槽/在飞闸/空页走查
// 单一权威（I1–I6 不变量见模块头注释）；本地 mergeMessagePages 退役。
import { RoomHistory, mergeForward } from "./roomHistory";
import RoomChat from "./components/RoomChat";

import TeamOverview from "./components/TeamOverview";
import LOGO_URL from "./lib/logo";
import HomePage from "./components/HomePage";
import WorkflowBoard, { WfView } from "./components/WorkflowBoard";
import Artifacts from "./components/Artifacts";
import OpsPanel from "./components/OpsPanel";
import SettingsTab, { readStartupPref } from "./components/SettingsTab";
import MessageSearch from "./components/MessageSearch";
import ProjectFiles from "./components/ProjectFiles";
import NotificationCenter from "./components/NotificationCenter";
import WorkerChats from "./components/WorkerChats";
import { useThemeColors } from "./theme";
import { useHostThemeTokens } from "./hostTheme";
import { useT } from "./i18n";
import { useWorkerSessionStates } from "./workerSessionState";
import { useWorkerChatStatuses } from "./workerChatStatus";
import WorkerManage from "./components/WorkerManage";
import { TeamIcon, TopologyIcon, HomeIcon, MessageIcon, BellIcon, BoxIcon, NotesIcon, SearchIcon, WrenchIcon, BrainIcon, SettingsIcon, RefreshIcon, MenuIcon, CheckIcon, CloseIcon, WarnIcon, BulbIcon, FolderIcon } from "./components/icons";
import KnowledgeBase from "./components/KnowledgeBase";
import ModelsTab from "./ModelsTab";
// v0.5.0-beta.14.6：轮询统一走 usePoller/createPoller（16 处迁移之一）；
// setActiveTab 供 tab 切换时同步活跃 tab 单源（tabActivity）。
import { usePoller, createPoller, type Poller } from "./usePoller";
import { setActiveTab as setActiveTabState } from "./tabActivity";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
const { message } = antd;

function StatusIcon({ ok }: { ok: boolean }) {
  return (
    <span style={{ color: ok ? "#52c41a" : "#ff4d4f", display: "inline-flex" }}>
      {ok ? <CheckIcon size={14} /> : <CloseIcon size={14} />}
    </span>
  );
}

function CheckList({ result }: { result: SelfCheckResult | null }) {
  if (!result) return null;
  const levels: SelfCheckResult[] = result.levels ? result.levels : [result];
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {levels.map((lv, i) => (
        <div
          key={`${lv.level}-${i}`}
          style={{
            border: "1px solid rgba(0,0,0,0.08)",
            borderRadius: 10,
            padding: "12px 16px",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 8 }}>
            <StatusIcon ok={lv.ok} /> {lv.level}
          </div>
          {(lv.checks || []).map((c, j) => (
            <div
              key={`${c.name}-${j}`}
              style={{
                display: "grid",
                gridTemplateColumns: "24px 1fr",
                gap: 4,
                padding: "4px 0",
                fontSize: 13,
              }}
            >
              <StatusIcon ok={c.ok} />
              <div>
                <span style={{ fontWeight: 600 }}>{c.name}</span>
                {c.detail ? (
                  <span style={{ color: "#666", marginLeft: 8 }}>{c.detail}</span>
                ) : null}
                {c.hint ? (
                  <div style={{ color: "#fa8c16", fontSize: 12, marginTop: 2 }}>
                    <BulbIcon size={12} style={{ verticalAlign: "-1px" }} /> {c.hint}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function RoomResultTable({ rooms }: { rooms: L3RoomResult[] }) {
  const tr = useT();
  if (!rooms || rooms.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ fontWeight: 700 }}>房间实测结果</div>
      {rooms.map((r) => (
        <div
          key={r.room_id}
          style={{
            border: "1px solid rgba(0,0,0,0.08)",
            borderRadius: 10,
            padding: "10px 14px",
            display: "grid",
            gap: 6,
            fontSize: 13,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <StatusIcon ok={r.ping_ok && r.reply?.ok} />
            <span style={{ fontWeight: 600, wordBreak: "break-all" }}>
              {r.room_id}
            </span>
            {r.members != null ? (
              <antd.Tag style={{ margin: 0 }}>{r.members} 人</antd.Tag>
            ) : null}
            <antd.Tag color={r.ping_ok ? "green" : "red"} style={{ margin: 0 }}>
              发送 {r.ping_ok ? <CheckIcon size={11} style={{ verticalAlign: "-1px" }} /> : <CloseIcon size={11} style={{ verticalAlign: "-1px" }} />}
            </antd.Tag>
            <antd.Tag color={r.reply?.ok ? "green" : "orange"} style={{ margin: 0 }}>
              回复 {r.reply?.ok ? <CheckIcon size={11} style={{ verticalAlign: "-1px" }} /> : <CloseIcon size={11} style={{ verticalAlign: "-1px" }} />}
            </antd.Tag>
          </div>
          {r.ping_error ? (
            <div style={{ color: "#ff4d4f" }}>发送失败：{r.ping_error}</div>
          ) : null}
          {r.reply?.ok ? (
            <div style={{ color: "#666" }}>
              {r.reply.sender}：{r.reply.body}
            </div>
          ) : (
            <div style={{ color: "#fa8c16" }}>
              <BulbIcon size={12} style={{ verticalAlign: "-1px" }} /> {r.reply?.detail || tr("无回复")}
              —— 可能被权限墙静默拦截（allowlist 不含你），或 Agent 未响应
            </div>
          )}
          {r.artifact ? (
            <div style={{ color: r.artifact.ok ? "#52c41a" : "#888" }}>
              产物：{r.artifact.detail}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** 12.14：聊天布局客户端诊断（自检页）——分栏/滚动问题的数字现场。 */
function ChatLayoutDiagCard({
  layout,
}: {
  layout?: { wide: boolean; forced: boolean; threshold: number };
}) {
  const tr = useT();
  const [lines, setLines] = React.useState<string[]>([]);
  const measure = React.useCallback(() => {
    const out: string[] = [];
    out.push(`window.innerWidth = ${window.innerWidth}px`);
    const main = document.querySelector(".wb-main") as HTMLElement | null;
    if (main) {
      out.push(`容器 .wb-main = ${main.clientWidth} × ${main.clientHeight}px`);
    }
    if (layout) {
      out.push(
        `模式 = ${layout.wide ? "宽屏分栏" : "窄屏单列"}（横屏且≥${layout.threshold}px 才分栏${layout.forced ? "；已强制分栏" : ""}）`,
      );
    }
    if (main) {
      out.push(
        `长宽比 = ${(main.clientHeight / Math.max(main.clientWidth, 1)).toFixed(2)}（${main.clientWidth >= main.clientHeight ? "横屏" : "竖屏"}）`,
      );
    }
    const left = document.querySelector(
      '.wb-main div[style*="overscroll"]',
    ) as HTMLElement | null;
    if (left && left.clientHeight > 0) {
      out.push(
        `左栏: 可视高 ${left.clientHeight}px / 内容高 ${left.scrollHeight}px / overflowY=${getComputedStyle(left).overflowY} → ${left.scrollHeight > left.clientHeight ? "内容超限（应可滚动）" : "内容未超限"}`,
      );
    } else {
      out.push(
        "左栏未渲染或聊天 tab 未激活（先点「聊天」tab 再回自检点「重新测量」可测左栏滚动数据）",
      );
    }
    setLines(out);
  }, [layout]);
  React.useEffect(() => {
    measure();
  }, [measure]);
  return (
    <antd.Card
      size="small"
      title={tr("聊天布局诊断（客户端）")}
      extra={
        <antd.Button size="small" onClick={measure}>
          {tr("重新测量")}
        </antd.Button>
      }
    >
      <pre
        style={{
          margin: 0,
          fontSize: 12,
          whiteSpace: "pre-wrap",
          lineHeight: 1.7,
        }}
      >
        {lines.join("\n") || "…"}
      </pre>
      <div style={{ fontSize: 11, color: "#888", marginTop: 6 }}>
        {tr("排查「聊天分栏/滚动」问题时：把上面几行原样发我（数字即现场）。")}
      </div>
    </antd.Card>
  );
}

// v0.5.0-beta.14.10：面板级 memo（同 SettingsTab）。
const SelfCheckTab = React.memo(function SelfCheckTab({
  config,
  layout,
}: {
  config: WorkbenchConfig | null;
  layout?: { wide: boolean; forced: boolean; threshold: number };
}) {
  const tr = useT();
  const [result, setResult] = React.useState<SelfCheckResult | null>(null);
  const [running, setRunning] = React.useState<string | null>(null);

  const run = async (level: string) => {
    setRunning(level);
    try {
      const payload = await requestJson(`/agentteams-proxy/selfcheck/${level}`, {
        method: "POST",
      });
      setResult(payload as SelfCheckResult);
    } catch (e) {
      message.error(e instanceof Error ? e.message : tr("自检失败"));
    } finally {
      setRunning(null);
    }
  };

  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 760 }}>
      <ChatLayoutDiagCard layout={layout} />
      <antd.Space wrap>
        <antd.Button loading={running === "l0"} onClick={() => void run("l0")}>
          L0 本地环境
        </antd.Button>
        <antd.Button loading={running === "l1"} onClick={() => void run("l1")}>
          L1 连通性
        </antd.Button>
        <antd.Button loading={running === "l2"} onClick={() => void run("l2")}>
          L2 认证/API
        </antd.Button>
        <antd.Button
          type="primary"
          loading={running === "all"}
          onClick={() => void run("all")}
        >
          全部自检
        </antd.Button>
      </antd.Space>
      <antd.Space wrap>
        <antd.Button
          loading={running === "l3"}
          onClick={() => void run("l3")}
        >
          L3 房间实测（会发 [selfcheck] ping）
        </antd.Button>
        <antd.Button loading={running === "l4"} onClick={() => void run("l4")}>
          L4 端到端（L3 + 产物检查）
        </antd.Button>
      </antd.Space>
      {!config?.matrix_homeservers?.length ? (
        <div style={{ color: "#fa8c16", display: "flex", alignItems: "center", gap: 4 }}>
          <BulbIcon size={12} style={{ flexShrink: 0 }} /> {tr("尚未配置 Matrix 地址——先去「配置」tab 填写并保存，再跑自检。")}
        </div>
      ) : null}
      <CheckList result={result} />
      <RoomResultTable rooms={result?.rooms || []} />
      <div style={{ fontSize: 12, color: "#888" }}>
        L0=插件环境 / L1=连通性（自动探测生效地址） / L2=登录与 API 权限 /
        L3=每个房间发一条 [selfcheck] ping 并等回复（约 45 秒，检测权限墙静默拦截）/
        L4=端到端 + 产物检查。
      </div>
    </div>
  );
});

/** 12.14：聊天分栏最小容器宽——1024→600（宿主内嵌面板/窄窗场景
 * 1024 下判定窄屏、曾报告「无分栏」；600 以下=手机竖屏语义）。
 * 12.16：宽窄判定「长宽比优先」——竖屏（高>宽）一律单列，横屏且 ≥600 才分栏。 */
/** 聊天分栏最小容器宽（13.8：600→800——双栏可用性下限：列表 160 + 聊天
 * ≥320 + 拖柄；16:9 全屏恒过线，竖屏手机不过线）。 */
const CHAT_SPLIT_MIN_CONTAINER_W = 800;

// v0.5.0-beta.13.20：mergeMessagePages 退役 → roomHistory.mergeForward
//（语义原样迁移，单一出处）。
/** 12.16→13.10：宽窄判定基准 = **窗口宽**（window.innerWidth）。
 * v0.5.0-beta.13.8（13.7 16:9 全屏被识别成竖屏→聊天单栏）：
 * 旧判定 w>=600 且 w>=h——宽高比项在「定高内嵌容器/高分屏」下误判
 * （容器高度随内容或视口变化，宽 ≥ 高不成立→单栏）。改纯宽度阈值。
 * v0.5.0-beta.13.10（13.9 「窄屏行为识别不了，框拖到最窄也不行；
 * 窗口横向拉满就行；上一版横向全屏被识别成竖屏」）：容器测量被宿主
 * 左右留空（面板 padding/导航）压窄 → 窗口横向拉满时容器仍 <800 被误判
 * 窄屏；且宿主窗口最小宽 + 留空使「拖最窄」永远过不了阈值（窄屏行为
 * 识别不了）。以**窗口**横向宽为准——横向拉满=分栏，真窄
 * 窗口（<800）=单栏；窄内嵌面板逃生口=「强制分栏」开关 + ⟨ 收起列表。 */
/** 13.11（13.10 宽窄屏没修，只需容器能横向铺满）：宽窄双基准——
 * win = 浏览器/webview 窗口宽，cont = 插件容器实测宽（宿主可能只给
 * 半窗/带留白）。**min(win, cont) ≥ 800 才分栏**：窗口满宽时容器随宿主
 * 铺满（主容器 width:100%）→ 分栏；宿主给窄容器或真窄窗口 → 聊天页
 * 自动单栏（不硬塞双栏）。13.9 容器单基准被宿主留白压窄误判、13.10
 * 窗口单基准在半窗面板误判——双基准取交集，两边都宽才是"真宽"。 */
function isWideLayout(win: number, cont: number): boolean {
  return Math.min(win, cont) >= CHAT_SPLIT_MIN_CONTAINER_W;
}

// ── @mention 发送侧（— Element 三件套，我点击的 @mention 不是正确格式）──
// 此前发送只有裸 body 文本（短 @name）：无 m.mentions 三元组 → 收端不通知/不高亮；
// 无 formatted_body → 标准客户端不认。Element 口径：body 保留人类可读短名，
// formatted_body 用 matrix.to 链接，`m.mentions.user_ids` 三元组负责通知
// （服务端 _require_mention 也认三元组——13.7 已实证）。
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** 从文本提取被 @ 的房间成员（localpart 精确 / displayname 精确，与 @ 弹层同口径；
 * 词边界防 @sys 误中 @sys-dev）。 */
function detectMentions(
  text: string,
  members?: Record<string, { display_name?: string }>,
): string[] {
  const out: string[] = [];
  if (!members) return out;
  const lower = text.toLowerCase();
  for (const [mxid, member] of Object.entries(members)) {
    const local = (mxid.split(":")[0] || mxid).replace(/^@/, "").toLowerCase();
    const disp = (member?.display_name || "").trim().toLowerCase();
    const reLocal = new RegExp(`@${escapeRe(local)}(?![\\w.=-])`, "i");
    const reDisp = disp
      ? new RegExp(`@${escapeRe(disp)}(?![\\w.=-])`, "i")
      : null;
    if (reLocal.test(lower) || (reDisp && reDisp.test(lower))) out.push(mxid);
  }
  return out;
}
export default function WorkbenchPage() {
  const t = useThemeColors();
  // QwenPaw ≥2.2.2 配色跟随：主色 token 取自宿主生效主题（GET /config/theme，
  // 经 host.fetch 桥）；旧宿主/取不到 = 内置橙（DEFAULT_ACCENT，行为不变）。
  const hostTokens = useHostThemeTokens(t.mode);
  // v0.5.0-beta.14.19：theme 对象 memoize——此前每次 WP 渲染新建
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
  // v0.5.0-beta.13.17（13.16 顶部版本号显示不对）：主显示改**构建
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
  const [config, setConfig] = React.useState<WorkbenchConfig | null>(null);
 // v0.5.0-beta.14.16：config 稳定镜像 ref——refreshConfig（deps=[]）
  // 读它判断首载/静默刷新，避免把 config 放进 useCallback deps（引用变化
  // 连锁重建下游全部回调）。
  const configRef = React.useRef<WorkbenchConfig | null>(null);
  configRef.current = config;
 // v0.5.0-beta.14.16：config 加载态——设置页「加载中/失败+重试」横幅
  // + 保存钮禁用（防默认态覆盖真数据）的数据源。
  const [configLoadState, setConfigLoadState] = React.useState<
    "loading" | "ready" | "failed"
  >("loading");
 // v0.5.0-beta.14.19: 登录态/凭据健康（30s 低频轮询；端点零外发请求，
  // 成本=一次进程内读——token 失效后 @通知静默全断，此前前端零感知）。
  const [authStatus, setAuthStatus] = React.useState<AuthStatus | null>(null);
 // v0.5.0-beta.14.24: 半连通（Controller 通 + Matrix 未登录）info 横幅的关闭态
 // ——持久化到 localStorage，避免每次重开插件都打扰（登录态轮询会重拉数据）。
 const [matrixNoneDismissed, setMatrixNoneDismissed] =
    React.useState<boolean>(() => {
      try {
        return (
          window.localStorage.getItem(
            "agentteams-qwenpaw-workbench:matrix-none-dismissed",
          ) === "1"
        );
      } catch {
        return false;
      }
    });
 const dismissMatrixNone = React.useCallback(() => {
    setMatrixNoneDismissed(true);
    try {
      window.localStorage.setItem(
        "agentteams-qwenpaw-workbench:matrix-none-dismissed",
        "1",
      );
    } catch {
      /* storage 不可用则跳过（横幅仍可点「登录」进入配置） */
    }
  }, []);
 // ── 状态记忆：重开插件恢复上次 tab + 房间 + 话题 + 面板宽度 ──
  // v0.5.0-beta.12: tab key 随名字归位（房间 team→chat、管理 spawn→team）——
  // storage key 升 v2 区分新旧格式：否则新版写入的 "team"（管理）会被
  // 旧迁移表误判成 "chat"（房间）。旧 key 只读一次做迁移，迁完即删。
  const UI_STATE_KEY = "agentteams-qwenpaw-workbench:ui-state-v2";
  const UI_STATE_KEY_LEGACY = "agentteams-qwenpaw-workbench:ui-state";
  /** 旧 tab key 迁移：v0.5.0-beta.12 管理 admin→spawn；v0.5.0-beta.12 spawn→team（管理）、team（旧=房间）→chat。 */
  const UI_TAB_MIGRATION: Record<string, string> = {
    admin: "team",
    spawn: "team",
    team: "chat",
  };
  // v0.5.0-beta.12 ：v2 已存 key 的收编迁移（与 legacy 表不同——legacy 里
  // "team"=旧房间语义，v2 里 "team"=团队管理现行 key，不能共表）。
  const UI_TAB_MIGRATION_V2: Record<string, string> = {
    "skill-center": "team",
    // v0.5.0-beta.14.16：skills 区块已从配置页移除 → 旧持久化 tab
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
  // v0.5.0-beta.12 ：合并写——对象扩了 wfView/wfTopo 字段，切大 tab 不能把
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
    // v0.5.0-beta.12 ：v2 已存的被收编 tab key 迁移（否则 activeKey 无
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
 // v0.5.0-beta.14.10：切换=非紧急更新——重渲染不阻塞
      // 点击反馈与输入（React 18 concurrent；memo 后渲染本身也变快）。
      React.startTransition(() => setTabState(next));
      writeUiState(next, activeRoom?.room_id || null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeRoom, writeUiState],
  );
 // v0.5.0-beta.14.6：活跃 tab 单源（tabActivity）同步——各消费方
  // （useTabActive 布尔快照：HomePage/NotificationCenter/OpsPanel/RoomChat
 // 轮询门；v0.5.0-beta.14.14 从 useActiveTab 字符串快照切换）
  // 以本组件的 tab 状态为准，直接 setState 驱动（setTabState 直改处亦覆盖）。
  React.useEffect(() => {
    setActiveTabState(tab);
  }, [tab]);
 // v0.5.0-beta.14.8：切页轻过渡（transform/opacity，仅 WAAPI）——
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
  // v0.5.0-beta.14.6：team tab 强制刷新的节流时间戳。
  const lastTeamForceAtRef = React.useRef(0);
  // v0.5.0-beta.12 ：工作流页 tab 记忆（用户「点开过的 tab 加上记忆，参考大
  // tab」）——与大 tab 同一 ui-state 对象（wfView/wfTopo 字段，合并写），
  // 不新造 storage key。WorkflowBoard 改受控（view/topoRun 由此下发）。
  // v0.5.0-beta.13.22：「mermaid」视图退役并入拓扑——旧持久化值
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
  // 恢复房间（rooms 加载后自动定位；找不到静默回退聊天页）。
  const restoredRoomRef = React.useRef(false);
  // Team tab state
  const [rooms, setRooms] = React.useState<TeamRoom[]>([]);
  const [roomsLoading, setRoomsLoading] = React.useState(false);
  /** v0.5.0-beta.12 ：待接受邀请（sync rooms.invite 段；接受/拒绝后 force 重同步）。 */
  const [invites, setInvites] = React.useState<InviteRoom[]>([]);
  /** v0.5.0-beta.12 ：已静音房间（m.muted_room account data 聚合）。 */
  const [mutedRooms, setMutedRooms] = React.useState<string[]>([]);
  const [messages, setMessages] = React.useState<RoomMessage[]>([]);
  // messages 的 ref 镜像（pollMessages 去重用，避免闭包过期）。
  const messagesRef = React.useRef<RoomMessage[]>([]);
  // v0.5.0-beta.13.20：消息历史窗口状态机——收敛原 windowRoomRef /
  // messagesEndRef / loadingMoreRef / prefetchRef 四个散落 ref（I1–I6
  // 不变量见 roomHistory.ts 模块头；组件只持有消息数组与 React 镜像）。
  const histRef = React.useRef<RoomHistory | null>(null);
  if (!histRef.current) histRef.current = new RoomHistory(fetchRoomMessages);
  const hist = histRef.current;
  React.useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  // v0.5.0-beta.13.11（根因——13.10 消息滚出历史仍未修）：
  // 换房间时消息状态必须整体重置。此前 messagesRef/messagesEnd 残留**上
  // 一个房间**的数据 → refreshMessages 的 mergeMessagePages(旧房全量,
  // 新房最新页) 把两房消息混进同一窗口（「乱了」），setCachedMessages
  // 再把混合体写进新房缓存（切回再「没了」）。Element 口径：timeline
  // 状态是 per-room 的——room_id 变化即归零，再拉/再恢复该房自己的缓存。
  React.useEffect(() => {
    // v0.5.0-beta.14.8：切房有缓存则先恢复缓存（即时显示，
    // 不闪空态/「正在加载消息…」——旧逻辑归零后 1 帧内屏上无数据即闪
    // loading 文案）；无缓存照旧归零。I1 首窗重建仍在 refreshMessages
    // （缓存 end ?? 本页 end），I2 合并基底取缓存/在屏较长者——语义不变
    // （并消除一个潜在边界：旧房在屏条数 ≥ 新房缓存长度时，旧逻辑用空
    // 基底合并丢深历史）。
    const roomId = activeRoom?.room_id;
    const cached = roomId ? getCachedMessages(roomId) : undefined;
    setMessages(cached ? cached.messages : []);
    setMessagesEnd(cached ? (cached.end || "") : "");
    setHasMore(Boolean(cached?.end));
    setRoomError("");
    messagesRef.current = cached ? cached.messages : [];
  }, [activeRoom?.room_id]);
  const [messagesLoading, setMessagesLoading] = React.useState(false);
  const [messagesEnd, setMessagesEnd] = React.useState(""); // 分页 token（I1：hist.cursor 的 React 镜像）
  const [hasMore, setHasMore] = React.useState(false);
  const [roomError, setRoomError] = React.useState("");
  const [sending, setSending] = React.useState(false);
  // Workflow tab state
  const [workflowEvents, setWorkflowEvents] = React.useState<WorkflowEvent[]>([]);
  const [workflowLoading, setWorkflowLoading] = React.useState(false);
  // v0.5.0-beta.12: 正源状态——降级时工作流 tab 顶部横幅提示（不静默）。
  const [workflowSource, setWorkflowSource] = React.useState<
    "controller" | "rooms"
  >("controller");
  const [workflowFailReason, setWorkflowFailReason] = React.useState<
    "auth" | "not_deployed" | "error"
  >("error");
  // error 分支的真实上游错误（横幅展示，不再只显示「正源不可用」）。
  const [workflowFailDetail, setWorkflowFailDetail] = React.useState("");
  // workflow 卡片点击 → 工作流 tab 选中该项目。
  const [selectedRunId, setSelectedRunId] = React.useState("");
  const handleOpenProject = React.useCallback(
    (runId: string) => {
      setSelectedRunId(runId);
      setTabState("workflow");
      writeUiState("workflow", activeRoom?.room_id || null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeRoom, writeUiState],
  );
  // 项目文件面板（v0.5.0-beta.12）：聊天室 📁 → 抽屉。
  const [projectFilesRoom, setProjectFilesRoom] = React.useState<TeamRoom | null>(null);
  const openProjectFiles = React.useCallback(
    (room: TeamRoom) => setProjectFilesRoom(room),
    [],
  );
  // Spawn tab state — Worker-dimension groups from teams/rooms (design).
  // spawn lists stay empty until the spawn endpoint merges; adapter swaps the data source.
  const [workerTree, setWorkerTree] = React.useState<WorkerTreeTeam[]>([]);
  // v0.5.0-beta.12: 团队结构来源（"controller-workers" 正源 / "room-fallback" 房间聚合）
  // ——room-fallback 时 WorkerManage 出警示横幅、首页发起任务弹窗只留 Manager 入口。
  const [treeSource, setTreeSource] = React.useState<string>("");
  const [spawnLoading, setSpawnLoading] = React.useState(false);
  // L1 admin view state.
  const [adminData, setAdminData] = React.useState<AdminData | null>(null);
  const [adminLoading, setAdminLoading] = React.useState(false);

  // v0.5.0-beta.14.16（配置记忆根治）：进行锁——退避重试链最长 15.5s，
  // 期间 poller / 切 tab / 手动重试的重入直接丢弃（避免并发链互踩 loadState）。
  const configFetchingRef = React.useRef(false);
  const refreshConfig = React.useCallback(async () => {
    if (configFetchingRef.current) return;
    configFetchingRef.current = true;
    try {
      // v0.5.0-beta.14.16（配置记忆根治）：失败重试 3 次（1.5/4/10s 退避）。
      // 根因（地址模式/凭据没有记忆）：插件安装重载窗口 /
      // WAN 抖动时首个 GET /config 失败被静默吞掉 → config=null 贯穿页面
      // 生命周期 → 设置页全默认态 → 用户以为「没记住」重填。回环（保存→落盘→
      // 重载→回填）本身完好（debug 插桩+回环实验实锤）。重试覆盖重载窗口
      // （实测 <30s 恢复）。
      const backoffs = [1500, 4000, 10000];
      let lastErr: unknown;
      for (let attempt = 0; attempt <= backoffs.length; attempt++) {
        try {
          const payload = await requestJson("/agentteams-proxy/config");
          if (attempt > 0) {
            // eslint-disable-next-line no-console
            console.info(
              `[workbench] config fetch recovered on retry #${attempt}`,
            );
          }
          // 首载（null→payload）走高优先立即落地——保证设置页首帧即回填；
          // 静默刷新（已有 config）仍走 transition（切 tab 数据波
          // 是可中断低优先工作，不压切换帧）。
          if (configRef.current === null) {
            setConfig(payload as WorkbenchConfig);
          } else {
            React.startTransition(() =>
              setConfig(payload as WorkbenchConfig),
            );
          }
          setConfigLoadState("ready");
          return;
        } catch (e) {
          lastErr = e;
          if (attempt < backoffs.length) {
            await new Promise((r) => setTimeout(r, backoffs[attempt]));
          }
        }
      }
      // 全部重试失败：显式置 failed（设置页出「加载失败+重试」横幅），
      // 不再静默——静默吞错 = 用户把默认态当成已保存值（本次事故根因）。
      setConfigLoadState("failed");
      // eslint-disable-next-line no-console
      console.error("[workbench] config fetch failed after retries", lastErr);
      // v0.5.0-beta.14.22：重试链（15.5s）覆盖不了的安装重载长窗
      // （换容器/重载 >60s）——failed 后转低频后台自恢复（10s 间隔、
      // 至多 6 次=60s），成功即落地回填（与首载同语义）；不再依赖
      // 用户手动点「重试」。期间 poller 触发的 refreshConfig 被
      // configFetchingRef/本链互斥，不叠链。
      void (async () => {
        for (let n = 1; n <= 6; n++) {
          await new Promise((r) => setTimeout(r, 10000));
          if (configRef.current !== null) return;
          try {
            const payload = await requestJson("/agentteams-proxy/config");
            configRef.current === null
              ? setConfig(payload as WorkbenchConfig)
              : React.startTransition(() =>
                  setConfig(payload as WorkbenchConfig),
                );
            setConfigLoadState("ready");
            // eslint-disable-next-line no-console
            console.info(
              `[workbench] config recovered on background retry #${n}`,
            );
            return;
          } catch {
            /* 继续下一轮 */
          }
        }
      })();
    } finally {
      configFetchingRef.current = false;
    }
  }, []);

  const refreshRooms = React.useCallback(async (silent = false, force = false) => {
    // 静默刷新（自动/切换刷新不闪页）——保留旧数据在屏，新数据到达才换；
    // 仅手动刷新/首载显示 loading 骨架。
    // v0.5.0-beta.12 ：force=绕过 60s 服务端缓存（邀请接受/拒绝后立即重同步，
    // 否则缓存期邀请区/房间列表不更新）。
    if (!silent) setRoomsLoading(true);
    try {
      const payload = await fetchTeamsSync(force);
      // diff 跳过：数据无变化 → 返回原引用 → React 跳过重渲染（零闪）。
      // v0.5.0-beta.14.13：数据波 setState 转 transition
      // （可中断——切换帧不再被整波落地渲染压满）。
      React.startTransition(() => {
        setRooms((prev) => (JSON.stringify(prev) === JSON.stringify(payload.rooms) ? prev : payload.rooms));
        const nextInvites = payload.invites || [];
        setInvites((prev) => (JSON.stringify(prev) === JSON.stringify(nextInvites) ? prev : nextInvites));
        const nextMuted = payload.muted_rooms || [];
        setMutedRooms((prev) => (JSON.stringify(prev) === JSON.stringify(nextMuted) ? prev : nextMuted));
        setCachedRooms(payload);
        setActiveRoom((current) =>
          current
            ? payload.rooms.find((r) => r.room_id === current.room_id) || current
            : null,
        );
      });
      // 状态记忆恢复：首次加载完成后自动打开上次房间。
      if (!restoredRoomRef.current) {
        restoredRoomRef.current = true;
        const savedRoomId = initialUi.current?.roomId || "";
        if (savedRoomId) {
          const saved = payload.rooms.find(
            (r) => r.room_id === savedRoomId,
          );
          if (saved) {
            React.startTransition(() => {
              setActiveRoom(saved);
              setCachedRooms(payload);
            });
            // v0.5.0-beta.13.20：状态恢复与 openRoom 同源——旧内联取数
            // 块是第 4 条窗口建立路径（无 I2 合并 / 无 I1 窗口游标 /
            // 缓存被浅页覆盖：上会话翻过的深历史在恢复瞬间蒸发，游标
            // 回退假死家族）。refreshMessages = 缓存即时显示 + 合并 +
            // 首窗游标 + 预取起步，一条路径全语义。
            void refreshMessages(saved);
          }
        }
      }
    } catch (e) {
      if (!silent) message.error(e instanceof Error ? e.message : tr("获取房间列表失败"));
    } finally {
      if (!silent) setRoomsLoading(false);
    }
  }, []);

  // Worker 树数据源 = 真实团队结构（Team/Worker CRD）+ spawn 正源填充
  // （端点已合并；apiOk=false → spawns 保持空，UI 显示占位文案）。
  // v0.5.0-beta.13.12（13.11 「团队管理 tab 刷不出完整信息，手动刷新
  // 也不行，要等 30s 自动刷新」根因）：后端 /teams/structure 有 60s TTL
  // 缓存，且**首次失败/空树也写缓存（负缓存）**——token 未就绪时首拉得
  // 空树，之后 60s 内所有手动刷新都命中空缓存；30s tick 恰在 TTL 过期后
  // miss 重拉才"活"。force 语义：用户意图（手动钮/切 tab/登录/mount）
  // 一律 force=true 绕过缓存；仅 30s 后台 tick 走缓存（silent=true 且不
  // 显式 force）保护 Controller。
  // v0.5.0-beta.13.24（首刷 race·前端半）：structure 与 spawn 拆分——
  // 旧 Promise.all 让整棵树等 20 项目 spawn 扇出（冷窗每请求 +6s，最坏
  // +2min）：团队管理「一开始刷不出、手动也不行」。现 structure 一到即
  // 渲染树（携带旧 spawns 值防闪烁），spawn 异步合并（in-flight 闸防
  // 30s tick 重叠双拉）；树首帧不再被 spawn 拖累。
  const spawnsInFlightRef = React.useRef(false);
  const loadSpawns = React.useCallback(async () => {
    if (spawnsInFlightRef.current) return;
    spawnsInFlightRef.current = true;
    try {
      const spawns = await fetchWorkerSpawns();
      if (!spawns.apiOk) return;
      // v0.5.0-beta.14.13：数据波 setState 转 transition。
      React.startTransition(() => {
        setWorkerTree((prev) => {
          if (!prev) return prev;
          const tree = prev.map((team) => ({
            ...team,
            workers: team.workers.map((w) => ({
              ...w,
              spawns: spawns.byWorker[w.worker_name] || [],
            })),
          }));
          return JSON.stringify(tree) === JSON.stringify(prev) ? prev : tree;
        });
      });
    } catch {
      /* spawn 失败 = 树保持无 spawn 占位（旧语义），不炸主流程 */
    } finally {
      spawnsInFlightRef.current = false;
    }
  }, []);

  const refreshTree = React.useCallback(
    async (silent = false, force?: boolean) => {
      const useForce = force ?? !silent;
      if (!silent) setSpawnLoading(true);
      try {
        const payload = await fetchTeamsStructure(useForce);
 // v0.5.0-beta.14.13：数据波 setState 转 transition。
        React.startTransition(() => {
          setTreeSource(payload.source);
          // 结构先到先渲染；每 (team, worker) 携带旧 spawns（新扇出回来前
          // spawn chip 不闪空），无旧值（新增 Worker/首载）= 空。
          setWorkerTree((prev) => {
            const prevByName = new Map<string, { spawns?: SpawnNode[] }>();
            for (const t of prev || [])
              for (const w of t.workers) prevByName.set(w.worker_name, w);
            const tree = payload.tree.map((team) => ({
              ...team,
              workers: team.workers.map((w) => ({
                ...w,
                spawns: prevByName.get(w.worker_name)?.spawns || [],
              })),
            }));
            return JSON.stringify(tree) === JSON.stringify(prev)
              ? prev
              : tree;
          });
        });
        void loadSpawns();
      } catch (e) {
        if (!silent) message.error(e instanceof Error ? e.message : tr("获取团队结构失败"));
      } finally {
        if (!silent) setSpawnLoading(false);
      }
    },
    [loadSpawns, tr],
  );

  React.useEffect(() => {
    // 缓存即时显示（页面重开不空白），后台静默刷新。
    const cached = getCachedRooms();
    if (cached) {
      setRooms(cached.rooms);
      setInvites(cached.invites || []);
      setMutedRooms(cached.muted_rooms || []);
    }
    void refreshRooms();
    void refreshTree();
    void refreshConfig();
  }, [refreshConfig, refreshRooms, refreshTree]);

  // 登录态轮询（30s）——usePoller（hidden 自动停 + 回前台 catch-up 立即
  // 刷：失效态要马上上横幅，不等 30s 节拍）+ 字段级值门：网络层每回包
  // 必新对象，登录态却几乎不变，无条件 set 会让 3400 行本组件每 30s
  // 空转重渲一次。
  const authPollerFn = React.useCallback(async () => {
    const s = await fetchAuthStatus();
    if (!s) return; // 取数失败保旧值（横幅状态不因瞬时抖动闪变）
    setAuthStatus((prev) => {
      const same =
        prev !== null &&
        prev.matrix_token === s.matrix_token &&
        prev.console_session === s.console_session &&
        prev.controller_token === s.controller_token;
      return same ? prev : s;
    });
  }, []);
  usePoller({ fn: authPollerFn, intervalMs: 30000 });

  // ── 已读回执（m.read + m.fully_read 双写）──────────
  // 打开房间/轮询到新消息 → 对最新消息发回执 → Element 侧不再显示未读。
  // 去重：同一 (room, event) 只发一次；本地未读 badge 同步清零。
  const lastReadRef = React.useRef<{ roomId: string; eventId: string } | null>(null);
  const markCurrentRead = React.useCallback(
    async (roomId: string, latestEventId?: string) => {
      const eventId = (latestEventId || "").trim();
      if (!roomId || !eventId) return;
      const last = lastReadRef.current;
      if (last && last.roomId === roomId && last.eventId === eventId) return;
      const res = await markRoomRead(roomId, eventId);
      if (res && res.ok) {
        lastReadRef.current = { roomId, eventId };
        setRooms((prev) =>
          prev.map((r) =>
            r.room_id === roomId
              ? { ...r, unread: 0, unread_highlight: 0 }
              : r,
          ),
        );
      }
    },
    [],
  );

  // 一键全部已读（聊天页工具条按钮）。
  const [markingAllRead, setMarkingAllRead] = React.useState(false);
  const handleMarkAllRead = React.useCallback(async () => {
    const unreadIds = rooms
      .filter((r) => (r.unread || 0) > 0 || (r.unread_highlight || 0) > 0)
      .map((r) => r.room_id);
    if (unreadIds.length === 0) return;
    setMarkingAllRead(true);
    const res = await markAllRoomsRead(unreadIds);
    if (res && res.ok) {
      setRooms((prev) =>
        prev.map((r) =>
          unreadIds.includes(r.room_id)
            ? { ...r, unread: 0, unread_highlight: 0 }
            : r,
        ),
      );
    }
    setMarkingAllRead(false);
  }, [rooms]);

  // ── 消息窗口同步（开房 / 状态恢复 / 静默刷新）────────────────────
  // v0.5.0-beta.13.20 收敛：窗口游标（I1）/ 预取单槽（I3）/ 在飞闸（I5）
 // / 空页走查（I4）全部收敛进 RoomHistory 状态机（不变量与溯源见
  // roomHistory.ts 模块头）。本函数是**唯一的窗口建立路径**——13.19 的
  // 状态恢复内联块已退役（它曾是第 4 条分叉路径：无 I2 合并 / 无 I1 窗口
  // 游标 / 缓存被浅页覆盖 → 深历史蒸发 + 游标回退家族）。
  //
  // 保留的验收语义（13.10 / 13.16 / 13.18 / 13.19 逐条可溯源）：
  // · 缓存即时显示 + 后台拉新；
  // · I1 游标只在首窗建立（= 缓存 end ?? 本页 end），refresh 永不回退
  // 浅游标（13.19 假死根因）；
  // · I2 合并而非替换（mergeForward——13.10「消息滚出历史」根因）；
  // · I3 开房即预取下一页（13.18 管道起步 → 首次上翻零等待）；
  // · I6 缓存 = 全量窗口 + 窗口游标（13.10/13.19）。
  const refreshMessages = React.useCallback(async (room: TeamRoom, silent = false) => {
    if (!silent) setMessagesLoading(true);
    try {
      // 缓存即时显示，后台拉新。
      const cached = getCachedMessages(room.room_id);
      // I1 判定用**调用瞬间**的已加载条数（不是 set 之后的新值）。
      const curCount = messagesRef.current.length;
      const fresh = hist.isFresh(room.room_id, curCount);
      if (cached) {
        setMessages(cached.messages);
        if (fresh) {
          setMessagesEnd(cached.end);
          setHasMore(Boolean(cached.end));
        }
      }
      const page = await fetchRoomMessages(room.room_id, 50);
      // I2 合并基底 = 当前在屏全量 与 缓存窗口 的较长者：
      // · 切房时 room-reset effect 已把 messagesRef 归零，取缓存（否则
      // 旧逻辑用空基底合并 → 浅页覆盖缓存深历史，13.10 语义在开房
      // 路径上破洞——本轮修复的实存 bug）；
      // · 同房静默刷新时两者同长，取 ref（含 poll/send 的尾部增量）。
      const base =
        curCount >= (cached?.messages.length ?? 0)
          ? messagesRef.current
          : (cached?.messages ?? []);
      const merged = mergeForward(base, page.messages);
      setMessages(merged);
      // I1 窗口游标：首窗 = 缓存 end ?? 本页 end；非首窗 = 既有游标
      // （loadOlder 单调推进的那个；缓存被逐出时也不回退）。
      const windowEnd = hist.windowEnd(room.room_id, curCount, cached?.end, page.end);
      hist.commit(room.room_id, windowEnd);
      setMessagesEnd(windowEnd);
      setHasMore(Boolean(windowEnd));
      // I3：开房即预取下一页（管道起步 → 首次上翻即零等待）。
      hist.prefetch(room.room_id, windowEnd);
      setRoomError(page.error === "not_found" ? "not_found" : "");
      // I6：缓存存全量已加载历史（含 loadOlder 前插）+ 窗口游标（不回退）。
      setCachedMessages(room.room_id, { ...page, end: windowEnd }, merged);
      // 已读：messages 升序，末条 = 最新。
      void markCurrentRead(room.room_id, page.messages[page.messages.length - 1]?.event_id);
    } catch (e) {
      if (!silent) message.error(e instanceof Error ? e.message : tr("获取消息失败"));
    } finally {
      if (!silent) setMessagesLoading(false);
    }
  }, []);

  // ── 分页：加载更早的消息（dir=b，from=窗口游标），前插 ──────────────
  // v0.5.0-beta.13.20 收敛：I3 命中/兜底 + I4 空页走查收敛进
  // hist.walkFrom；组件侧只剩 I2 前插 + I6 落盘 + I3 预取续接 + I5 闸
  // 的 UI 镜像（loadingMore → RoomChat 顶部预载提示）。
  // 13.16/13.17 验收语义不变：滚动预载与手动按钮同窗双触发时 I5 闸
  // 保证同游标不双拉（重复前插同一页的根因）。
  const [loadingMore, setLoadingMore] = React.useState(false);
  const loadMore = React.useCallback(async () => {
    if (!activeRoom || !messagesEnd) return;
    if (hist.busy) return; // I5 在飞单发
    hist.setBusy(true);
    setLoadingMore(true);
    try {
      // I4 空页走查 + I3 预取命中：从当前窗口游标取页；整页去重零新增
      // → 立即续走下一页（≤WALK_CAP；游标不前进即停）——「空页 → 6s 锁
      // → 再触发」的假死一次走完（13.19 验收）；预取命中 = 零网络等待，
      // miss/预取失败 = 直拉兜底（13.18 验收）。
      const known = new Set(messagesRef.current.map((m) => m.event_id));
      const { page, older } = await hist.walkFrom(activeRoom.room_id, known);
      // I2 前插（零新增 = 不前插 = 无渲染变化 = 不闪跳）。
      const merged = older.length
        ? [...older, ...messagesRef.current]
        : messagesRef.current;
      setMessages(merged);
      // I1 游标沿更早方向推进 + I6 落盘全量窗口（游标不回退）。
      hist.commit(activeRoom.room_id, page.end);
      setMessagesEnd(page.end);
      setHasMore(Boolean(page.end));
      setCachedMessages(activeRoom.room_id, { ...page, messages: merged }, merged);
      // I3 管道常驻：落盘后立即预取再下一页（用户滚到边界时通常已零等待）。
      hist.prefetch(activeRoom.room_id, page.end);
    } catch (e) {
      message.error(e instanceof Error ? e.message : tr("加载更早消息失败"));
    } finally {
      hist.setBusy(false);
      setLoadingMore(false);
    }
  }, [activeRoom, messagesEnd]);

 // v0.5.0-beta.13.13（13.12 「很多信息『已滚出历史』但 Element 里
  // 信息都在，看看 Element 怎么做的」）：引用条原消息不在已加载窗口时 →
  // 点「加载原消息」→ backfill 到原消息进窗口（不标死『滚出历史』）。
 // v0.5.0-beta.13.15（B2 Element 式滚动化，13.14 「加载原消息能不能
  // 滚动到哪里就自动加载，参考 Element」）：旧版 = 点一下后台 burst 连拉
  // （500 页护栏内一口气拉完，用户看不见进度、API 突发）。新版 =
  // 滚动驱动的分页节奏：
  // ① 点「加载原消息」→ set pending + kickstart 一页（用户未必在顶部，
  // 40px 触发不可依赖）；
  // ② 之后 RoomChat 侧滚动到哪加载到哪：40px 触顶自动触发（既有）+
  // 停在顶部时每次前插后自动续一页（新增 effect）——页面按用户
  // 滚动节奏逐页前进，锚保持视口稳定（13.6 锚机制）；
  // ③ 终止条件：原消息进窗口（自动定位 + 高亮，jumpToEventId 复用
  // 搜索跳转链路）/ 触底（!hasMore → banner 落 /context 兜底）/
  // 用户滚离顶部（停止续拉）/ 切房（pending 作废 resolve false）。
  // v0.5.0-beta.13.20：hasMoreRef 退役（只写不读的死镜像——回填效果
  // 直接读 hasMore state）。
  const [pendingOriginalId, setPendingOriginalId] =
    React.useState<string | null>(null);
  const pendingOrigResolveRef = React.useRef<
    ((kind: "found" | "exhausted" | "cancelled") => void) | null
  >(null);
  const pendingOrigIdRef = React.useRef<string | null>(null);
  // v0.5.0-beta.13.19：加载原消息**超量上限**——自动后翻期间窗口净增超过
  // 3000 条仍未命中 → 判「不在可加载历史」（banner 走 /context 兜底），
  // 防自动链在超大历史里有尽无头地翻（请求量上下界可控）。
  const pendingStartLenRef = React.useRef(0);
  React.useEffect(() => {
    pendingOrigIdRef.current = pendingOriginalId;
  }, [pendingOriginalId]);
  const settlePendingOriginal = React.useCallback(
    (kind: "found" | "exhausted" | "cancelled") => {
      if (pendingOrigResolveRef.current) {
        pendingOrigResolveRef.current(kind);
        pendingOrigResolveRef.current = null;
      }
      setPendingOriginalId(null);
    },
    [],
  );
  React.useEffect(() => {
    // 切房/关房 → 作废进行中的加载（cancelled：banner 回 idle，不标 notfound）。
    if (pendingOrigIdRef.current) settlePendingOriginal("cancelled");
  }, [activeRoom?.room_id, settlePendingOriginal]);
 // 原消息进窗口 → 自动定位 + 高亮；触底仍无 → 交给 banner 兜底。
  React.useEffect(() => {
    if (!pendingOriginalId) return;
    if (messagesRef.current.some((m) => m.event_id === pendingOriginalId)) {
      setJumpToEventId(pendingOriginalId);
      settlePendingOriginal("found");
      return;
    }
    if (
      messagesRef.current.length - pendingStartLenRef.current > 3000
    ) {
      settlePendingOriginal("exhausted"); // 超量仍未命中：判不在可加载历史
      return;
    }
    if (!hasMore) settlePendingOriginal("exhausted");
  }, [messages, hasMore, pendingOriginalId, settlePendingOriginal]);
  // 停滞看门狗：每页落地会重置计时（deps 含 messages）；30s 无任何新页
  // （服务端分页异常）→ 释放 pending（banner 回 idle 可再点），不静默死挂。
  React.useEffect(() => {
    if (!pendingOriginalId) return;
    const timer = window.setTimeout(() => {
      settlePendingOriginal("cancelled");
    }, 30000);
    return () => window.clearTimeout(timer);
  }, [messages, hasMore, pendingOriginalId, settlePendingOriginal]);
  const loadOriginal = React.useCallback(
    async (
      eventId: string,
    ): Promise<"found" | "exhausted" | "cancelled"> => {
      if (!activeRoom || !eventId) return "cancelled";
      if (pendingOrigIdRef.current === eventId) return "cancelled"; // 已在进行中
      if (pendingOrigIdRef.current)
        settlePendingOriginal("cancelled"); // 换目标：旧目标回 idle
      pendingStartLenRef.current = messagesRef.current.length;
      setPendingOriginalId(eventId);
      // Kickstart 一页：用户点引用条时大概率不在列表顶部（banner 在中部），
      // 40px 触顶触发不会来——先拉一页保证前进（后续页由滚动驱动）。
      void loadMore();
      return new Promise((resolve) => {
        pendingOrigResolveRef.current = resolve;
      });
    },
    [activeRoom, loadMore, settlePendingOriginal],
  );

  // 长轮询：增量拉新消息（dir=b 前 10 条），按 event_id 去重合并。
  const pollMessages = React.useCallback(async () => {
    if (!activeRoom) return;
    try {
      const page = await fetchRoomMessages(activeRoom.room_id, 10);
      const known = new Set(
        messagesRef.current.map((m) => m.event_id),
      );
      const fresh = page.messages.filter((m) => !known.has(m.event_id));
      if (fresh.length) {
        // I2：与窗口路径同一合并原语（去重追加；ref 二次防御并发前插）。
        setMessages((prev) => mergeForward(prev, fresh));
        // 已读：正在看的房间来了新消息 → 对最新一条发回执。
        void markCurrentRead(
          activeRoom.room_id,
          fresh[fresh.length - 1].event_id,
        );
      }
    } catch {
      /* 静默——轮询失败不打扰用户 */
    }
  }, [activeRoom, markCurrentRead]);

  const openRoom = React.useCallback(
    (roomId: string): boolean => {
      const room = rooms.find((r) => r.room_id === roomId);
      if (!room) return false;
      setActiveRoom(room);
      // 开房间必落 chat tab（首页最近动态点行不跳转——
      // 此前 writeUiState(tab=home) + 调用方漏 setTab → 房间开了但停在首页）。
      writeUiState("chat", room.room_id);
      void refreshMessages(room);
      return true;
    },
    [rooms, refreshMessages, writeUiState],
  );

  // 跨房间搜索：全局面板 + 跳转定位事件（传给 RoomChat）。
  const [globalSearchOpen, setGlobalSearchOpen] = React.useState(false);
  const [jumpToEventId, setJumpToEventId] = React.useState<string | null>(null);

  const handleGlobalSearchOpenRoom = React.useCallback(
    (roomId: string, eventId: string) => {
      openRoom(roomId);
      setJumpToEventId(eventId);
    },
    [openRoom],
  );

  // 通知中心「去房间」：@提到你 等通知带 room_id → 切聊天 tab + 打开房间
  //（跳转修复：此前通知条目只有展开/已读，没有任何跳转）。
  // eventId 可选 → 跳房间并定位到该条消息（房间通知 @你 跳转）。
  const handleGotoRoom = React.useCallback(
    (roomId: string, eventId?: string) => {
      setTab("chat");
      const ok = openRoom(roomId);
      if (eventId) setJumpToEventId(eventId);
      if (ok) return;
      // 房间不在缓存（新加入/缓存过期）→ 此前静默失败
      //（真机反馈「点击消息跳转还不行」的另一根因：openRoom 找不到
      // 直接 return）。强制刷新一次重试，仍无 → 明确提示。
      void (async () => {
        try {
          const payload = await fetchTeamsSync(true);
          const fresh = payload.rooms.find((r) => r.room_id === roomId);
          if (fresh) {
            setRooms(
              (prev) =>
                prev.some((r) => r.room_id === roomId)
                  ? prev.map((r) => (r.room_id === roomId ? fresh : r))
                  : [...prev, fresh],
            );
            setActiveRoom(fresh);
            writeUiState("chat", roomId);
            void refreshMessages(fresh);
          } else {
            message.warning(
              tr("未找到该房间（可能尚未加入）——可先在聊天 tab 列表手动打开"),
            );
          }
        } catch {
          /* 刷新失败——用户可手动打开 */
        }
      })();
    },
    [openRoom, refreshMessages, writeUiState, tr],
  );

  // 成员角色表（成员详情卡）：MXID → 领/工/审/unknown（Worker 树推断）。
  const memberRoles = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const team of workerTree || []) {
      for (const w of team.workers || []) {
        if (w.mxid && w.role) map[w.mxid] = w.role;
      }
    }
    return map;
  }, [workerTree]);

  // MXID → Worker 容器名（v0.5.0-beta.12：聊天房间成员卡的「工具执行安全」
  // 审批卡需要容器名寻址 agent.json；L2 房间降级树无容器名 → 不显示）。
  const memberWorkerNames = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const team of workerTree || []) {
      for (const w of team.workers || []) {
        if (w.mxid && w.worker_name) map[w.mxid] = w.worker_name;
      }
    }
    return map;
  }, [workerTree]);

  // v0.5.0-beta.12：room_id → Worker phase/runtime 徽章（聊天头注入）。
  // 数据 = Worker CR 字段：admin 数据优先（全量），tree 兜底（L2/未配 token）。
  // v0.5.0-beta.14.22（D4）：runtimeDeprecated 同批透传（legacy 角标 #8）。
  const workerBadgeMap = React.useMemo(() => {
    const map: Record<
      string,
      { phase?: string; runtime?: string; runtimeDeprecated?: boolean }
    > = {};
    for (const w of adminData?.workers || []) {
      if (w.roomID)
        map[w.roomID] = {
          phase: w.phase || undefined,
          runtime: w.runtime || undefined,
          runtimeDeprecated: w.runtimeDeprecated || undefined,
        };
    }
    for (const team of workerTree || []) {
      for (const w of team.workers || []) {
        if (w.room_id && !map[w.room_id])
          map[w.room_id] = {
            phase: w.phase || undefined,
            runtime: w.runtime || undefined,
            runtimeDeprecated: w.runtimeDeprecated || undefined,
          };
      }
    }
    return map;
  }, [adminData, workerTree]);

  // v0.5.0-beta.14.22（D4 #6/#8）：MXID → runtime（头像菜单「查看会话」
  // 入口门控 + 消息行 legacy 角标；admin 数据优先，tree 兜底）。
  const workerRuntimeByMxid = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const team of workerTree || []) {
      for (const w of team.workers || []) {
        if (w.mxid && w.runtime) map[w.mxid] = w.runtime;
      }
    }
    for (const w of adminData?.workers || []) {
      if (w.matrixUserID && w.runtime) map[w.matrixUserID] = w.runtime;
    }
    return map;
  }, [adminData, workerTree]);

  // v0.5.0-beta.12.4：Worker session 运行指示——统一派生（四落点共用：
  // 房间卡列表 / Worker 行 / 1:1 聊天头 / 聊天主列表发送者行）。
  // v0.5.0-beta.12.9：心跳优先（adminData.workers 的 agentStatus/runningTaskCount/
  // lastFinishAt，GET /workers 既有通道零新请求；旧版 controller 无 → 降级
  // typing+last_ts），60s 老化。
 // v0.5.0-beta.13.8（13.7 状态灯不准确）：session 级正源轮询——
  // /chats per-session status（idle|running，qwenpaw app 自维护）。
  // v1.2.4 GET /workers 无心跳字段，消息级启发式在「任务执行中未发言」时
  // 恒灰；chat.running 优先于 typing，修掉该盲区。30s tick、仅可见时、
  // 失败静默保旧值（降级回消息级启发式）。
  const chatPollNames = React.useMemo(() => {
    const s = new Set<string>();
    for (const team of workerTree || [])
      for (const w of team.workers || []) if (w.worker_name) s.add(w.worker_name);
    for (const w of adminData?.workers || [])
      if (w.name) s.add(w.name);
    return Array.from(s).sort();
  }, [workerTree, adminData?.workers]);
  const chatStatuses = useWorkerChatStatuses(chatPollNames, true);
  const workerSessionStates = useWorkerSessionStates(
    rooms,
    workerTree,
    adminData?.workers,
    chatStatuses,
  );

  // 通知未读计数（通知 tab badge）。
  const [inboxUnread, setInboxUnread] = React.useState(0);

 // P6（⑨「自动刷新有点蠢，即时信息」）：/sync 事件驱动主路。
  // ref 镜像——SSE effect deps 为空（一次连接），闭包必须走 ref 取最新。
  const activeRoomRef = React.useRef<TeamRoom | null>(null);
  React.useEffect(() => {
    activeRoomRef.current = activeRoom;
  }, [activeRoom]);
  const pollMessagesRef = React.useRef<() => Promise<void>>(async () => {});
  React.useEffect(() => {
    pollMessagesRef.current = pollMessages;
  }, [pollMessages]);

  // v0.5.0-beta.14.7：事件合并——600ms 窗口内的多个 room_message 只拉一次；
  // 拉取在飞时置脏位，完成后补拉一次（防丢失、防风暴；实测活跃房曾达 ~2 次/秒）。
  const pollSoonRef = React.useRef<{
    timer?: number;
    dirty?: boolean;
    inflight?: boolean;
  }>({});
  const pollSoon = React.useCallback(() => {
    const s = pollSoonRef.current;
    if (s.inflight) {
      s.dirty = true;
      return;
    }
    if (s.timer) return;
    s.timer = window.setTimeout(() => {
      s.timer = undefined;
      s.inflight = true;
      void pollMessagesRef.current().finally(() => {
        s.inflight = false;
        if (s.dirty) {
          s.dirty = false;
          pollSoon();
        }
      });
    }, 600);
  }, []);
  // v0.5.0-beta.14.1 (S1-1)：同上 ref 镜像——SSE 重连追平要拉房间列表全量
  // （effect deps=[]，闭包必须走 ref 取最新）。
  const refreshRoomsRef = React.useRef<() => Promise<void>>(async () => {});
  React.useEffect(() => {
    refreshRoomsRef.current = refreshRooms;
  }, [refreshRooms]);
  // v0.5.0-beta.13.21：房间列表预览/未读的 10s 节流全量刷新退役——改由
  // room_list_update 增量 SSE 就地合并（Element 式；全量 /teams/sync 降为
  // 60s 兜底 + 邀请/手动）。

  // v0.5.0-beta.14.1 (S1-4)：事件流连接态（设置页可见——「断开自动重连」
  // 从黑箱变可见，排障一眼定位 S1 类问题）。
  const [sseState, setSseState] = React.useState<{
    status: "connected" | "reconnecting";
    since: number;
  }>({ status: "reconnecting", since: Date.now() });

 // ── IM 式事件触发（30s 轮询太笨）────────────────────
  // 后端 sync watcher：Matrix /sync 长轮询检测 @提到我 / 任务状态变化 →
  // 写宿主收件箱 + SSE 广播（GET /agentteams-proxy/events）。前端订阅：
  // 收到 mention → 刷新房间 + 通知 tab；task_status → 刷新工作流。
  // EventSource 不支持自定义 auth header（宿主启用 auth 时 401）——
  // 用 fetch + ReadableStream 手动解析 SSE（宿主 PawApp SDK 同款方案，
  // console/src/plugins/pawapp-sdk/task.ts），带 Bearer token。
  const [notifyTick, setNotifyTick] = React.useState(0);
  const [opsTick, setOpsTick] = React.useState(0);
  const [knowledgeTick, setKnowledgeTick] = React.useState(0);
 // v0.5.0-beta.13.11（会话窗 Element 化）：任意房间来消息 → 递增 →
  // WorkerChats 打开的会话窗立即刷新（事件驱动主路；4s 轮询降兜底）。
  // tick 只喂 WorkerChats 抽屉（兄弟视图）——不进 RoomChat props，
  // 避免每条消息击穿 4200 行聊天组件的 memo 整树重渲。
  const [chatsTick, setChatsTick] = React.useState(0);
  const [chatsWorker, setChatsWorker] = React.useState<string | null>(null);
  // SSE 帧回调闭包里的抽屉开合镜像（75 房集群下 room_message 高频到达，
  // 抽屉没开时递增 tick=纯浪费；抽屉自带 4s poller 会补齐期间增量）。
  const chatsDrawerOpenRef = React.useRef(false);
  chatsDrawerOpenRef.current = tab === "chat" && chatsWorker !== null;
  const handleOpenWorkerChats = React.useCallback(
    (w: string) => setChatsWorker(w),
    [],
  );
  React.useEffect(() => {
    let abort: AbortController | null = null;
 // v0.5.0-beta.14.6：旧定时器 → 命令式 createPoller（60s SSE 断连
    // 兜底；!document.hidden——后台不拉；closure 捕获首渲染 refreshRooms，
    // 与原行为一致）。
    let fallback: Poller | null = null;
    let closed = false;
    let retryDelay = 1000;
    let lastDownSince = 0; // v0.5.0-beta.14.1 (S1-1)：最近一次断连开始时刻（0=当前连着）

    const bootFallback = () => {
      if (!fallback) {
        fallback = createPoller({
          fn: () => {
            void refreshRooms();
            setNotifyTick((t) => t + 1);
          },
          intervalMs: 60000,
          isActive: () => !document.hidden,
        });
        fallback.start();
      }
    };
    const clearFallback = () => {
      if (fallback) {
        fallback.stop();
        fallback = null;
      }
    };
    // v0.5.0-beta.14.19：重连调度统一加可见性感知——token 失效态/
    // 断连态 + 后台 tab 此前每 60s 一次 SSE 空拨（浏览器节流下定时器仍
    // 会跑，只是降频）。后台期间不拨；回前台立即重拨（visibility 追平
    // 路径已覆盖数据新鲜度，SSE 恢复只需在可见时进行）。
    let pendingVisListener: (() => void) | null = null;
    const clearPendingVis = () => {
      if (pendingVisListener) {
        document.removeEventListener("visibilitychange", pendingVisListener);
        pendingVisListener = null;
      }
    };
    const scheduleReconnect = (delay: number) => {
      window.setTimeout(() => {
        if (closed) return;
        if (document.hidden) {
          if (pendingVisListener) return; // 已有待回前台的重拨
          const onVis = () => {
            if (closed) return;
            clearPendingVis();
            if (document.visibilityState !== "visible") return;
            void connect();
          };
          pendingVisListener = onVis;
          document.addEventListener("visibilitychange", onVis);
        } else {
          void connect();
        }
      }, delay);
    };

    const connect = async () => {
      // v0.5.0-beta.14.1 (S1-2)：watchdog 句柄 hoist 到 connect() 顶部——
      // 清理统一走 catch 后的唯一收敛点（done/abort/网络异常全路径覆盖，
      // 防 interval 泄漏周期性杀下一次重连）。
 // v0.5.0-beta.14.6：number → Poller（createPoller，语义不变）。
      let watchdog: Poller | null = null;
      if (closed) return;
      if (!lastDownSince) lastDownSince = Date.now();
      try {
        abort = new AbortController();
        const url = window.QwenPaw.host.getApiUrl
          ? window.QwenPaw.host.getApiUrl("/agentteams-proxy/events")
          : "/api/agentteams-proxy/events";
        const token = window.QwenPaw.host.getApiToken
          ? window.QwenPaw.host.getApiToken()
          : "";
        const headers: Record<string, string> = {
          Accept: "text/event-stream",
        };
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(url, { headers, signal: abort.signal });
        if (!res.ok || !res.body) {
          if (res.status === 401 || res.status === 403) {
            // v0.5.0-beta.14.1 (S1-1/H6)：会话失效不再永停——60s 周期继续探
            // （重登后宿主 token 刷新，下次 connect 自动恢复）；轮询兜底并行。
            bootFallback();
            setSseState({ status: "reconnecting", since: lastDownSince });
            scheduleReconnect(60000);
            return;
          }
          throw new Error(`SSE ${res.status}`);
        }
        clearFallback();
        retryDelay = 1000;
        // v0.5.0-beta.14.1 (S1-1/H3)：重连追平——watcher /sync 不回放断连期
        // 事件，断开 >5s 恢复时立即拉一次：活动房间消息 + 房间列表全量。
        const downMs = lastDownSince ? Date.now() - lastDownSince : 0;
        lastDownSince = 0;
        setSseState({ status: "connected", since: Date.now() });
        if (downMs > 5000) {
          void pollMessagesRef.current();
          void refreshRoomsRef.current();
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        // v0.5.0-beta.14.1 (S1-2)：流看门狗——后端每 15s 发 ": keepalive"
        // 注释帧；45s（3 周期+裕量）无任何字节（含 keepalive）= TCP 半死挂
        // （NAT 超时/代理 idle-kill 未发 FIN）→ abort 读 → 走重连路径。
        let lastFrameAt = Date.now();
 // v0.5.0-beta.14.6：旧定时器 → createPoller（5s；语义不变——
        // 45s 无帧 abort；!document.hidden——后台暂停，恢复后首 tick 即判定）。
        watchdog = createPoller({
          fn: () => {
            if (Date.now() - lastFrameAt > 45000) {
              lastFrameAt = Date.now(); // 防重复触发
              abort?.abort();
            }
          },
          intervalMs: 5000,
          isActive: () => !document.hidden,
        });
        watchdog.start();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          lastFrameAt = Date.now(); // 任何字节=帧到达（data 或 keepalive 注释）
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const data = JSON.parse(line.slice(6)) as {
                type?: string;
              };
              if (data.type === "mention") {
                // v0.5.0-beta.13.21（房间列表 Element 化）：房间列表元数据由
                // room_list_update 增量覆盖（未读/预览/排序），不再全量重拉。
                setNotifyTick((t) => t + 1);
              } else if (data.type === "task_status") {
                // 任务状态变化 → 刷新工作流三视图 + 通知中心。
                void refreshWorkflow();
                setNotifyTick((t) => t + 1);
              } else if (
                // v0.5.0-beta.12：新邀请 / 审批请求 / 审批解决 → 通知中心立即
                // 更新（IM 式）。邀请=members 变化仍走全量（邀请区数据源=
                // /teams/sync）；审批不产房间元数据变化（13.21 起不再全量）。
                data.type === "invite" ||
                data.type === "approval_request" ||
                data.type === "approval_resolved"
              ) {
                if (data.type === "invite") void refreshRooms();
                setNotifyTick((t) => t + 1);
              } else if (data.type === "room_list_update") {
                // v0.5.0-beta.13.21（Element 式房间列表）：watcher 每轮 /sync
                // 的元数据增量 diff——就地合并（更新/插入新房间/移除 leave），
                // 不做全量 /teams/sync（那是一次带全房间 state 的 Matrix 全量
 // /sync，房间列表「慢而笨」的根因）。
                const upd = ((data as { rooms?: TeamRoom[] }).rooms || []) as Array<
                  Partial<TeamRoom> & { room_id: string; new?: boolean }
                >;
                const left: string[] = (data as { left?: string[] }).left || [];
                setRooms((prev) => {
                  let next = left.length
                    ? prev.filter((r) => !left.includes(r.room_id))
                    : prev;
                  for (const it of upd) {
                    if (!it || !it.room_id) continue;
                    const idx = next.findIndex((r) => r.room_id === it.room_id);
                    if (idx >= 0) {
                      const cur = next[idx];
                      // v0.5.0-beta.14.19：逐字段比对——全等则复用
                      // 原 item 与原数组引用（此前每帧产新对象+新数组 →
                      // openRoom deps [rooms] 连锁 → HomePage/TeamOverview
                      // memo 失效 + 全消费方重渲）。首个变化字段才克隆。
                      let m: TeamRoom = cur;
                      const touch = (patch: Partial<TeamRoom>) => {
                        if (m === cur) m = { ...cur };
                        Object.assign(m, patch);
                      };
                      if (typeof it.name === "string" && it.name !== cur.name) touch({ name: it.name });
                      if (typeof it.member_count === "number" && it.member_count !== cur.member_count) touch({ member_count: it.member_count });
                      if (typeof it.unread === "number" && it.unread !== cur.unread) touch({ unread: it.unread });
                      if (typeof it.unread_highlight === "number" && it.unread_highlight !== cur.unread_highlight) touch({ unread_highlight: it.unread_highlight });
                      if (typeof it.last_ts === "number" && it.last_ts !== cur.last_ts) touch({ last_ts: it.last_ts });
                      if (typeof it.last_sender === "string" && it.last_sender !== cur.last_sender) touch({ last_sender: it.last_sender });
                      if (typeof it.last_body === "string" && it.last_body !== cur.last_body) touch({ last_body: it.last_body });
                      if (Array.isArray(it.typing)) {
                        const curTyping = cur.typing || [];
                        if (it.typing.length !== curTyping.length || it.typing.some((u, i) => curTyping[i] !== u)) {
                          touch({ typing: it.typing });
                        }
                      }
                      if (m !== cur) {
                        next = [...next.slice(0, idx), m, ...next.slice(idx + 1)];
                      }
                    } else if (it.new) {
                      next = [
                        ...next,
                        {
                          room_id: it.room_id,
                          name: it.name || it.room_id,
                          name_fallback: !it.name,
                          member_count: it.member_count || 0,
                          members: {},
                          unread: it.unread || 0,
                          unread_highlight: it.unread_highlight || 0,
                          last_ts: it.last_ts || 0,
                          last_sender: it.last_sender || undefined,
                          last_body: it.last_body || undefined,
                        },
                      ];
                    }
                  }
                  return next;
                });
              } else if (data.type === "room_message") {
                // P6：/sync 事件驱动消息刷新（IM 式主路；RoomChat 12s 轮询
                // 降为断连兜底）。当前房间 → 立即拉新（内容源=拉取，附件/
                // 工作流渲染路径零改动）。房间列表预览/未读由 room_list_update
                // 增量覆盖（13.21：10s 节流全量刷新退役）。
                const rid = String((data as { room_id?: string }).room_id || "");
                if (rid && rid === activeRoomRef.current?.room_id) {
                  // v0.5.0-beta.14.7（T4b）：载荷直合——watcher 已附解析后的
                  // 最小载荷（event: id/sender/ts/body/msgtype/relates_to）。
                  // 普通文本消息直接合并（零回拉——5Mbps 链路上活跃房回拉
                  // 的大头）；非文本/带关系（回复/编辑/附件）仍走 600ms
                  // 事件合并兜底拉取（行为与旧版一致）。
                  const evp = (data as {
                    event?: {
                      event_id?: string;
                      sender?: string;
                      ts?: number;
                      body?: string;
                      msgtype?: string;
                      relates_to?: unknown;
                    };
                  }).event;
                  const evId = String(evp?.event_id || "");
                  if (evp && evId && evp.msgtype === "m.text" && !evp.relates_to) {
                    const known = new Set(
                      messagesRef.current.map((m) => m.event_id),
                    );
                    if (!known.has(evId)) {
                      const incoming: RoomMessage = {
                        event_id: evId,
                        sender: String(evp.sender || ""),
                        body: String(evp.body || ""),
                        msgtype: "m.text",
                        origin_server_ts: Number(evp.ts || Date.now()),
                      };
                      setMessages((prev) => mergeForward(prev, [incoming]));
                    }
                    // 正在看的房间来了新消息 → 回执（与 pollMessages 同款）。
                    void markCurrentRead(rid, evId);
                  } else {
                    // 非文本/复杂消息：兜底拉取（14.7 前的既有行为）。
                    pollSoon();
                  }
                }
 // 任意房间来消息 → 递增 chatsTick → 打开的头像会话窗立即刷新
                // （事件驱动主路，Element 式延迟≈0）。门控：仅抽屉打开
                // 时递增（75 房集群下任意房消息=全页重渲染源）；抽屉
                // 关闭期间由 4s poller 兜底，打开瞬间立即补齐。
                if (chatsDrawerOpenRef.current) setChatsTick((v) => v + 1);
              }
            } catch {
              /* 忽略非法帧 */
            }
          }
        }
      } catch {
        /* 网络抖动 → 重连 */
      }
      // v0.5.0-beta.14.1 (S1-2)：watchdog 唯一清理收敛点——覆盖 for 循环
      // 全部退出路径（done 正常结束 / 看门狗或卸载 abort / 网络异常）。
 // v0.5.0-beta.14.6：clearInterval → poller.stop()。
      if (watchdog) {
        watchdog.stop();
        watchdog = null;
      }
      // 流结束（连接被断开）→ 指数退避重连；**退避封顶 60s 后不再永停**
      // （v0.5.0-beta.14.1 S1-1：宿主重启/换容器/网络恢复即自愈），持续断连
      // 时 60s 轮询兜底并行。
      if (closed) return;
      if (retryDelay >= 60000) bootFallback(); // 幂等
      setSseState({ status: "reconnecting", since: lastDownSince });
      scheduleReconnect(retryDelay);
      retryDelay = Math.min(retryDelay * 2, 60000);
    };

    void connect();
    return () => {
      closed = true;
      clearPendingVis();
      abort?.abort();
      clearFallback();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // v0.5.0-beta.14.1 (S1-3)：可见性追平——后台 tab 的定时器被浏览器
  // 节流至 ≥60s（SSE 也可能已死），回到前台/窗口聚焦时立即拉一次（3s 防抖
  // 防事件风暴）——不等下一个 tick。
  React.useEffect(() => {
    let lastCatch = 0;
    const catchUp = () => {
      const now = Date.now();
      if (now - lastCatch < 3000) return;
      lastCatch = now;
      void pollMessagesRef.current();
      void refreshRoomsRef.current();
    };
    const onVis = () => {
      if (document.visibilityState === "visible") catchUp();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", catchUp);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", catchUp);
    };
  }, []);

  const handleSend = React.useCallback(
    async (
      text: string,
      replyTo?: { event_id: string; sender: string; body: string },
      threadRoot?: string,
    ) => {
      if (!activeRoom) return;
      // 乐观回显：先本地插入 pending 消息，成功后 refresh 拉正式事件替换；
      // 失败标记 failed（红叹号徽标）保留在列表里可识别。
      const pendingId = `pending-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const pendingMsg: RoomMessage = {
        event_id: pendingId,
        sender: config?.matrix?.user_id || "",
        body: text,
        msgtype: "m.text",
        origin_server_ts: Date.now(),
        pending: true,
        ...(replyTo?.event_id
          ? { reply: replyTo }
          : threadRoot
            ? { reply: { event_id: threadRoot, sender: "", body: "" } }
            : {}),
      };
      setMessages((prev) => [...prev, pendingMsg]);
      setSending(true);
      try {
 // @mention 三件套（body 短名不变；formatted_body=matrix.to
        // 链接；m.mentions 三元组负责通知——Element 同款，api.ts 内构造）。
        const detected = detectMentions(text, activeRoom.members);
        const mentionList = detected.map((mxid) => ({
          mxid,
          localpart: (mxid.split(":")[0] || mxid).replace(/^@/, ""),
        }));
        await sendRoomMessage(
          activeRoom.room_id,
          text,
          replyTo,
          threadRoot,
          mentionList,
        );
        await refreshMessages(activeRoom);
      } catch (e) {
        setMessages((prev) =>
          prev.map((m) =>
            m.event_id === pendingId ? { ...m, pending: false, failed: true } : m,
          ),
        );
        message.error(e instanceof Error ? e.message : tr("发送失败"));
      } finally {
        setSending(false);
      }
    },
    [activeRoom, config?.matrix?.user_id, refreshMessages],
  );

  // v0.5.0-beta.12 ：审批命令带 @Worker（裸文本群内不被 Worker 消费）。
  const handleSendApproval = React.useCallback(
    async (
      targetMxid: string,
      cmd: string,
      replyTo?: { event_id: string; sender: string; body: string },
    ) => {
      if (!activeRoom || !targetMxid) return;
      try {
        await sendApprovalCommand(
          activeRoom.room_id,
          targetMxid,
          cmd,
          replyTo,
        );
        await refreshMessages(activeRoom);
      } catch (e) {
        message.error(e instanceof Error ? e.message : tr("发送失败"));
        throw e;
      }
    },
    [activeRoom, refreshMessages],
  );

  // 表情反应：发 m.reaction 后刷新消息（聚合计数更新）。
  const handleReact = React.useCallback(
    async (eventId: string, emoji: string) => {
      if (!activeRoom) return;
      try {
        await sendReaction(activeRoom.room_id, eventId, emoji);
        await refreshMessages(activeRoom);
      } catch (e) {
        message.error(e instanceof Error ? e.message : tr("反应发送失败"));
      }
    },
    [activeRoom, refreshMessages],
  );

  // 文件发送：上传 → mxc → 发 m.file/m.image（反向交付通道）。
  const handleSendFiles = React.useCallback(
    async (files: File[]) => {
      if (!activeRoom || files.length === 0) return;
      setSending(true);
      try {
        for (const f of files) {
          const mxc = await uploadMedia(f);
          const msgtype = f.type.startsWith("image/") ? "m.image" : "m.file";
          await sendRoomFile(activeRoom.room_id, {
            mxcUri: mxc,
            filename: f.name || "file",
            msgtype,
            mimetype: f.type,
            size: f.size,
          });
        }
        message.success(tr("已发送 {n} 个文件", { n: files.length }));
        await refreshMessages(activeRoom);
      } catch (e) {
        message.error(e instanceof Error ? e.message : tr("文件发送失败"));
      } finally {
        setSending(false);
      }
    },
    [activeRoom, refreshMessages],
  );

  // ── v0.5.0-beta.12 ：Element 对齐四件（编辑/撤回/退出/静音）──────────
  /** 编辑自己的消息（m.replace 标注替换，Element 同款）。 */
  const handleSendEdit = React.useCallback(
    async (originalEventId: string, body: string) => {
      if (!activeRoom) return;
      try {
        await sendRoomMessageEdit(activeRoom.room_id, originalEventId, body);
        await refreshMessages(activeRoom, true);
      } catch (e) {
        throw e; // RoomChat 编辑态保留草稿
      }
    },
    [activeRoom, refreshMessages],
  );

  /** 撤回自己的消息（redaction；他人事件 403 透传 toast）。 */
  const handleRedact = React.useCallback(
    async (eventId: string) => {
      if (!activeRoom) return;
      try {
        await redactRoomMessage(activeRoom.room_id, eventId);
        message.success(tr("已撤回"));
        await refreshMessages(activeRoom, true);
      } catch (e) {
        message.error(e instanceof Error ? e.message : tr("撤回失败"));
      }
    },
    [activeRoom, refreshMessages],
  );

  /** 退出房间（leave；scope 房间会被 Controller 调和器重新邀请）。 */
  const handleLeaveRoom = React.useCallback(async () => {
    if (!activeRoom) return;
    const roomName = activeRoom.name;
    try {
      await leaveRoom(activeRoom.room_id);
      message.success(tr("已退出「{name}」", { name: roomName }));
      setActiveRoom(null);
      void refreshRooms(true, true); // force：房间立即从列表消失
    } catch (e) {
      message.error(e instanceof Error ? e.message : tr("退出房间失败"));
    }
  }, [activeRoom, refreshRooms]);

  /** 房间重命名（m.room.name state 事件）。
 * 团队房间权限表普遍为 null（平台侧已知问题）→ 403 时展示
 * fetchRoomPowerInfo 诊断 + 修复指引，而非裸错误。 */
  const handleRenameRoom = React.useCallback(
    async (name: string) => {
      if (!activeRoom) return;
      const nm = name.trim();
      if (!nm) {
        message.warning(tr("房间名不能为空"));
        return;
      }
      try {
        await renameRoom(activeRoom.room_id, nm);
        const rid = activeRoom.room_id;
        setRooms((prev) =>
          prev.map((r) => (r.room_id === rid ? { ...r, name: nm } : r)),
        );
        setActiveRoom((prev) =>
          prev && prev.room_id === rid ? { ...prev, name: nm } : prev,
        );
        message.success(tr("已重命名为「{n}」", { n: nm }));
        void refreshRooms(true, true);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/403|FORBIDDEN|power/i.test(msg)) {
          void (async () => {
            let detail = "";
            try {
              const info = await fetchRoomPowerInfo(
                activeRoom.room_id,
                config?.matrix?.user_id || "",
              );
              detail = info.content
                ? tr(
                    "你的权限 {a}/{b}（需 ≥ {b}）——找房间管理员（Manager）在房间内提权后重试。",
                    { a: String(info.myLevel), b: String(info.nameRequired) },
                  )
                : tr(
                    "该房间没有有效的权限设置（平台侧已知问题）。请管理员修复房间的权限设置后重试。",
                  );
            } catch {
              /* 诊断失败用默认文案 */
            }
            antd.Modal.error({
              title: tr("改名失败：权限不足"),
              content: detail || msg,
            });
          })();
          return;
        }
        message.error(msg || tr("改名失败"));
      }
    },
    [activeRoom, config, refreshRooms, tr],
  );

  /** 房间静音切换（m.muted_room account data；通知引擎 sync_watcher
 * 同数据源消费——静音房间不再触发 @/任务状态通知）。 */
  const handleToggleMute = React.useCallback(async () => {
    if (!activeRoom) return;
    const userId = config?.matrix?.user_id;
    if (!userId) return;
    const nowMuted = !mutedRooms.includes(activeRoom.room_id);
    try {
      await setRoomMuted(activeRoom.room_id, userId, nowMuted);
      setMutedRooms((prev) =>
        nowMuted
          ? [...prev, activeRoom.room_id]
          : prev.filter((r) => r !== activeRoom.room_id),
      );
      message.success(
        nowMuted ? tr("已静音该房间（@/任务通知不再推送）") : tr("已取消静音"),
      );
      // force 重同步（自审：60s 服务端缓存会让下一轮背景刷新用旧值
      // 覆盖乐观更新的静音状态——force 立即拿到新 account_data）。
      void refreshRooms(true, true);
    } catch (e) {
      message.error(e instanceof Error ? e.message : tr("静音设置失败"));
    }
  }, [activeRoom, config, mutedRooms]);

  // Phase 2: DM entry — click a member → create-or-reuse DM → open room.
  const handleDm = React.useCallback(
    async (mxid: string, roomId?: string) => {
      // v0.5.0-beta.12：Worker 个人房间（CR roomID）
      // 直跳——Worker 容器无法接受 Matrix 邀请，新建 DM 房间 Worker 进不来
      // （房间建了、消息发不出去）= 死路。room_id 存在且房间在列表 → 直跳；
      // 房间不在列表（已退房/数据未同步）→ fallthrough 走 openDm 兜底。
      if (roomId) {
        try {
          const p0 = await fetchTeamsSync(true);
          setRooms(p0.rooms);
          setCachedRooms(p0);
          const direct = p0.rooms.find((r) => r.room_id === roomId);
          if (direct) {
            setTabState("chat");
            writeUiState("chat", roomId);
            setActiveRoom(direct);
            void refreshMessages(direct);
            message.success(tr("已打开 {target} 的个人房间", { target: mxid }));
            return;
          }
        } catch (e) {
          message.warning(
            tr("个人房间打开失败（{e}），回退新建 DM", {
              e: e instanceof Error ? e.message : String(e),
            }),
          );
        }
      }
      try {
        const dm = await openDm(mxid);
        // v0.5.0-beta.12: 先验证房间真的出现在房间列表，再报成功——
        // 修「Worker 管理点私聊说已创建、实际没有」的假成功（房间未落地/
        // homeserver 错位时静默吞掉）。
        const payload = await fetchTeamsSync(true);
        setRooms(payload.rooms);
        setCachedRooms(payload);
        let room = payload.rooms.find((r) => r.room_id === dm.room_id);
        if (!room) {
          // New DM may not appear in joined_rooms instantly; retry once.
          await new Promise((res) => setTimeout(res, 1500));
          const p2 = await fetchTeamsSync(true);
          setRooms(p2.rooms);
          setCachedRooms(p2);
          room = p2.rooms.find((r) => r.room_id === dm.room_id);
        }
        if (room) {
          const members = room.member_count ?? 0;
          message.success(
            dm.created && members <= 1
              ? tr("已创建私聊，等待对方接受邀请")
              : dm.created
                ? tr("已创建与 {target} 的私聊", { target: dm.target })
                : tr("打开已有私聊"),
          );
          // v0.5.0-beta.12: 开 DM 必切聊天 tab——从团队管理/首页发起时此前房间
          // 在后台打开、屏幕停在原地，用户视角「说已创建实际没有」（与
          // openRoom「开房间必落聊天 tab」同模式，跳转修复的私聊版）。
          setTabState("chat");
          writeUiState("chat", dm.room_id);
          setActiveRoom(room);
          void refreshMessages(room);
        } else {
          message.error(
            tr("房间创建返回成功但未出现在房间列表（homeserver 配置可能错位），请检查配置后重试"),
          );
        }
      } catch (e) {
        message.error(e instanceof Error ? e.message : tr("打开私聊失败"));
      }
    },
    [refreshMessages],
  );

  // Workflow adapter 双轨：正源 = Controller projects/workflow API（端点已合并）；
  // apiOk=false（端点未部署/网络失败）→ 降级 Matrix agentteams.workflow 事件聚合。
  // 首页「任务进展」卡需要 workflow 数据——启动时也拉一次（定义后置，独立 effect）。
  React.useEffect(() => {
    void refreshWorkflow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // v0.5.0-beta.14.19 注（评估后不改）：15s 周期内的 JSON.stringify
  // 全量 diff 是**正确性门**（steps 内容变而 status/数量不变的情况只有
  // 全量比对能抓住）；双 poller 翻倍问题已由双 poller 合并修复，单 poller
  // 下数组规模（数十项）stringify 为毫秒级，指纹门方案有更新丢失风险，
  // 收益不抵风险 → 保持原样。
  const refreshWorkflow = React.useCallback(async (silent = false) => {
    // v0.5.0-beta.13.13: 记录拉取时间——切 tab 立即刷新用 2s 去抖（防连环拉）。
    workflowLastFetchRef.current = Date.now();
    if (!silent) setWorkflowLoading(true);
    try {
      const { events, apiOk, failReason, failDetail } =
        await fetchWorkflowProjects();
      // v0.5.0-beta.14.13：数据波 setState 转 transition。
      if (apiOk) {
        const enriched = enrichWorkflowRoomNames(events);
        React.startTransition(() => {
          setWorkflowEvents((prev) =>
            JSON.stringify(prev) === JSON.stringify(enriched) ? prev : enriched
          );
          setWorkflowSource("controller");
          setWorkflowFailDetail("");
        });
      } else {
        // v0.5.0-beta.12: 记录降级原因——横幅提示「只看已加入房间的项目」+
        // 可操作指引（此前静默降级，正源 401 时用户以为数据就是这样）。
        // 同时记录真实错误 detail（5xx 上游故障不再被通用文案掩盖）。
        React.startTransition(() => {
          setWorkflowSource("rooms");
          setWorkflowFailReason(failReason || "error");
          setWorkflowFailDetail(failDetail || "");
        });
        const payload = await fetchWorkflowEvents();
        React.startTransition(() => {
          setWorkflowEvents((prev) => (JSON.stringify(prev) === JSON.stringify(payload.events) ? prev : payload.events));
        });
      }
    } catch (e) {
      if (!silent) message.error(e instanceof Error ? e.message : tr("获取工作流失败"));
    } finally {
      if (!silent) setWorkflowLoading(false);
    }
  }, []);

  // v0.5.0-beta.12.5：工作流 tab 自动刷新（15s，仅可见期活跃）——
  // 对齐 dashboard 15s 轮询（useProjectWorkflow refetchInterval:15000）。
  // 此前插件只在挂载/手动刷新/登录时拉取，任务推进时看板不自动更新
  // 仅 workflow tab 激活或聊天消息含工作流卡片时轮询（聊天内卡片
  // live overlay 复用 workflowEvents 正源）；页面隐藏即停（内置）。
  // v0.5.0-beta.14.19：memoize——此前每次 WP 渲染 O(n) 扫全量
  // messages（最高频渲染组件 × 消息数组大）。messages 引用只在 mergeForward
  // 换数组时变（无变化复用 prev）→ 扫描只随消息到达发生。
  const chatHasWfCards = React.useMemo(
    () => tab === "chat" && messages.some((m) => m.workflow != null),
    [tab, messages],
  );
  usePoller({
    fn: () => void refreshWorkflow(true),
    intervalMs: 15000,
    active: tab === "workflow" || chatHasWfCards,
  });

  // v0.5.0-beta.13.13（13.12 「工作流一点开应先自动刷新，而不是等 15s
  // 自动刷新或手动刷新」）：切到工作流 tab（或聊天出现工作流卡）立即拉一次
  // 正源——此前只有 15s interval + 手动/登录时拉，tab 切回时看到的是最长
  // 15s 前的数据。2s 去抖防止快速切 tab 连环拉取。
  const workflowLastFetchRef = React.useRef(0);
  React.useEffect(() => {
    if (tab !== "workflow" && !chatHasWfCards) return;
    const now = Date.now();
    if (now - workflowLastFetchRef.current < 2000) return;
    workflowLastFetchRef.current = now;
    void refreshWorkflow(true);
  }, [tab, chatHasWfCards, refreshWorkflow]);

  // v0.5.0-beta.12: L1 数据面可用 = 本地配置 token 或宿主 env
  // （AGENTTEAMS_CONTROLLER_TOKEN，env 不落盘——config.controller_token 为空
  // 但 controllerTokenSource="env" 时数据面同样可用，门控以此为准）。
  const hasCtlToken = Boolean(
    config?.controller_token || config?.controllerTokenSource === "env",
  );

  // v0.5.0-beta.13.21（13.20 一开始只能看见拓扑，CRD 管理要点刷新才出）：
  // admin 取数连续失败计数——静默失败不再无感空面板，累计后在面板显 Alert+重试。
  const [adminFailCount, setAdminFailCount] = React.useState(0);

  // L1 admin view: only when a Controller token is available (config or env).
  const refreshAdmin = React.useCallback(async (silent = false) => {
    if (!hasCtlToken) return;
    if (!silent) setAdminLoading(true);
    try {
      const data = await fetchAdminData();
      // v0.5.0-beta.14.13：数据波 setState 转 transition。
      React.startTransition(() => {
        setAdminFailCount(0);
        setAdminData((prev) => (prev && JSON.stringify(prev) === JSON.stringify(data) ? prev : data));
      });
    } catch (e) {
      setAdminFailCount((n) => n + 1);
      if (!silent) message.error(e instanceof Error ? e.message : tr("获取管理视图失败"));
    } finally {
      if (!silent) setAdminLoading(false);
    }
  }, [hasCtlToken]);

  // v0.5.0-beta.13.21（同批缺口②）：hasCtlToken false→true 翻转（config 异步就绪/
  // env 注入晚于挂载）触发首次 admin 取数。此前该翻转无任何重触发——token 未就绪
  // 窗口内所有 admin 取数被 `if (!hasCtlToken) return` 短路，token 就绪后 admin
  // 面板恒空，直到用户手动点刷新（首屏只显拓扑的根因之一）。
  const adminArmedRef = React.useRef(false);
  React.useEffect(() => {
    if (!hasCtlToken) {
      adminArmedRef.current = false;
      return;
    }
    if (adminArmedRef.current) return;
    adminArmedRef.current = true;
    void refreshAdmin(true);
  }, [hasCtlToken, refreshAdmin]);

  // v0.5.0-beta.14.20（模型页 L2 门控配套）：记忆 tab=models 但当前 L2
  // （config 已落地且无 token）→ 回首页。config ready 前不判——L1 用户
  // 的 config 异步窗口内 hasCtlToken 短暂为 false，不能误踢。
  React.useEffect(() => {
    if (tab === "models" && !hasCtlToken && configLoadState === "ready") {
      setTabState("home");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, hasCtlToken, configLoadState]);

  // v0.5.0-beta.12: 账号切换（登录成功）= 数据源全切——清本地旧账号数据 + 全量重取。
  // 与后端联动：/login 已同步清 60s 聚合缓存（rooms/workflow/artifacts/
  // structure）+ 重置 sync 游标；前端本地状态不清的话，切完账号屏幕还挂着
  // 上一个账号的房间/树/管理数据，要等下一轮静默刷新（真机反馈：
  // 「点刷新看起来是刷新了，但团队管理和产物没有刷新」）。
  const onLoginSuccess = React.useCallback(() => {
    setRooms([]);
    setWorkerTree([]);
    setTreeSource("");
    setAdminData(null);
    setWorkflowEvents([]);
    void refreshConfig();
    void refreshRooms();
    void refreshTree();
    void refreshAdmin();
    void refreshWorkflow();
  }, [refreshConfig, refreshRooms, refreshTree, refreshAdmin, refreshWorkflow]);

  // 点 Tab 即刷新（用户要求，所有 top tab）：rc-tabs 内容挂载后保活不卸载，
  // 切回不会自动重取——这里按 tab 显式触发对应数据刷新。
  // v0.5.0-beta.13.21（同批缺口③）：首次运行（prev===""，=挂载/恢复的初始 tab，
  // tab 是持久化的——上次停在「团队管理」则首开即 team）也触发该 tab 的数据刷新。
  // 旧版 prev==="" 早退 = 持久化首开 team tab 时 admin 取数零触发（首屏只显拓扑
  // 的根因之二；hasCtlToken 翻转 effect 兜底 token 就绪，本处兜底首访意图）。
  const prevTabRef = React.useRef("");
  // v0.5.0-beta.14.13：team tab 激活态稳定 ref——
  // WorkerManage 的 30s 轮询门控读此 ref（tick 时取当前值）。
  // boolean prop `active={tab === "team"}` 每次切 tab 翻转 → 整树
  // 重渲落进切换帧（实测无 fetch 的 →团队 切换帧 61ms）；ref 身份
  // 恒定 → React.memo(WorkerManage) 命中，切 tab 零重渲。
  const teamActiveRef = React.useRef(false);
  teamActiveRef.current = tab === "team";
  React.useEffect(() => {
    const prev = prevTabRef.current;
    prevTabRef.current = tab;
    if (prev === tab) return;
    switch (tab) {
      case "home":
        // 静默刷新（切 tab/自动刷新不闪页——rc-tabs 保活有旧数据在屏）
        void refreshRooms(true);
        void refreshConfig();
        void refreshWorkflow(true);
        void refreshTree(true);
        break;
      case "chat":
        void refreshRooms(true);
        if (activeRoom) void refreshMessages(activeRoom, true);
        break;
      case "inbox":
        setNotifyTick((n) => n + 1);
        break;
      case "workflow":
        void refreshWorkflow(true);
        break;
      case "artifacts":
        void refreshRooms(true);
        break;
      case "team": {
        // v0.5.0-beta.14.6：force 改 stale-first——30s 内免 force
        // （前端 15s TTL + 后端 60s 缓存已足够新），避免每次切 tab 全量
        // 回源；超过 30s 才强制取最新。
        const forceNow = Date.now() - lastTeamForceAtRef.current > 30000;
        if (forceNow) lastTeamForceAtRef.current = Date.now();
        void refreshTree(true, forceNow);
        void refreshAdmin(true);
        break;
      }
      case "knowledge":
        setKnowledgeTick((n) => n + 1);
        break;
      case "selfcheck":
        void refreshConfig();
        break;
      case "ops":
        setOpsTick((n) => n + 1);
        break;
      case "settings":
        void refreshConfig();
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // 自己的显示名：从房间成员里找 display_name，fallback MXID localpart。
  const selfDisplayName = React.useMemo(() => {
    const me = config?.matrix?.user_id;
    if (!me) return "";
    for (const room of rooms) {
      const member = room.members?.[me];
      if (member?.display_name) return member.display_name;
    }
    return "";
  }, [config?.matrix?.user_id, rooms]);

 // ── P6 聊天 tab：宽屏 Element 式分栏 / 窄屏微信式单屏 ──
  // 宽屏：左房间/DM 列表（宽度可拖 220-560，持久化）+ 右聊天（未选房间显占位）。
  // 窄屏（<1024px，竖屏/手机）：保持微信移动版语义——列表页点击进全屏聊天，
  // 左上角 ← 返回退出（RoomChat onBack 既有按钮）。列表可隐藏（宽屏）。
  const [chatWideMeasured, setChatWideMeasured] = React.useState(
    // 初值按容器满宽假设（首帧），挂载后 measure 实测容器宽修正。
    () => isWideLayout(window.innerWidth, window.innerWidth),
  );
  // 12.14：强制分栏开关（配置页）——忽略宽度判定，持久化 ui-state。
  const [chatForceWide, setChatForceWide] = React.useState<boolean>(
    () => readUiState(UI_STATE_KEY).chatForceWide === "true",
  );
  const setChatForceWidePersist = React.useCallback(
    (v: boolean) => {
      setChatForceWide(v);
      mergeUiState({ chatForceWide: v ? "true" : "false" });
    },
    [mergeUiState],
  );
  // 12.13→13.10：判定基准=**窗口宽**（13.9 ：容器测量被宿主
  // 左右留空压窄→横向全屏误判窄屏；宿主最小窗宽又使拖窄永远不触发
  // 单栏）。窗口 resize 跟随；强制开关优先。
  const mainRef = React.useRef<HTMLDivElement | null>(null);
  // v0.5.0-beta.13.12（13.11 聊天页自动单栏没做到根因）：
  // 13.11 的 cont = mainRef.clientWidth 只量插件自己的 <main>——它
  // width:100% 跟随**直接父级**，而宿主的真实约束层（Desktop OS 窗
  // 口 frame / 内嵌面板 / 侧栏容器）在更上层祖先：窗口拖窄时若约束
  // 层是 transform/scale 或非父链布局，main 的 clientWidth 可能不跟
  // 宿主走（疑似按聊天窗宽判断——实测基准确实离宿主约束
  // 层太远）。改 Element 式「实际可见宽」：从 main 沿父链到 body 取
  // 每层 clientWidth 的 min（任何一层变窄都会拉低），再与视口宽取
  // min；ResizeObserver 观察**整条父链**（任一层变化即重测）。宿主形
  // 态无关（OS 窗口/经典页/iframe 都取到真实可见宽）。
  // v0.5.0-beta.14.2（分栏计话题面板）：RoomChat 上报话题面板占宽
  // （inline 面板与聊天列同占空间）——打开话题时可用宽 = 实测可见宽 −
  // 面板宽。此前判定完全不含面板：开着话题拖窄窗口，聊天区早已局促
  // 却仍双栏，继续收窄才切（14.2）。
  const threadPanelRef = React.useRef<{ open: boolean; width: number }>({
    open: false,
    width: 0,
  });
  const measureRef = React.useRef<() => void>(() => {});
  const onThreadPanelLayout = React.useCallback(
    (open: boolean, width: number) => {
      threadPanelRef.current = { open, width };
      measureRef.current();
    },
    [],
  );
  React.useEffect(() => {
    const measure = () => {
      let visible = window.innerWidth;
      let el: HTMLElement | null = mainRef.current;
      while (el) {
        if (el.clientWidth < visible) visible = el.clientWidth;
        el = el.parentElement;
      }
      const tp = threadPanelRef.current;
      const eff = tp.open ? visible - tp.width : visible;
      setChatWideMeasured(eff >= CHAT_SPLIT_MIN_CONTAINER_W);
    };
    measure();
    measureRef.current = measure;
    window.addEventListener("resize", measure);
    let ro: ResizeObserver | null = null;
    if (mainRef.current && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(measure);
      // 观察 main + 全部祖先（到 body 为止，DOM 深度有限 ≤ ~20 层）。
      let el: HTMLElement | null = mainRef.current;
      while (el) {
        ro.observe(el);
        if (el.tagName === "BODY") break;
        el = el.parentElement;
      }
    }
    return () => {
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, []);
 // v0.5.0-beta.13.4（第二轮反馈·滚动根因重构）：shell 高度改为
  // 容器相对（Element 模型）——12.x 起用 calc(100vh-64px) 经验值，但宿主
  // 是 Desktop OS 窗口（OsAppHost .content：flex:1 + overflow:auto 定高
  // 容器，可拖拽任意大小，100vh=浏览器视口≠窗口内容高）：窗口小于屏幕时
  // shell 溢出 → .content 整页滚 →「聊天框带着整个页面滚」。
  // 实测优先，三级判定：
  // ① iframe 宿主（PawApps iframe 模式）→ iframe 视口=全部可用区；
  // ② 父容器定高且小于视口（OS 窗口 .content / 任何定高内嵌容器）→ 用父
  // 容器 clientHeight（窗口拖拽/宿主重排时 ResizeObserver 跟随）；
  // ③ 父容器不定高（经典页面挂载）→ 回退 calc(100vh - 64px) 旧经验值。
  const [shellH, setShellH] = React.useState<number | null>(null);
  React.useEffect(() => {
    const measure = () => {
      const el = mainRef.current;
      if (!el) return;
      try {
        if (window.self !== window.top) {
          setShellH(window.innerHeight);
          return;
        }
      } catch {
        /* 跨域 iframe 访问异常——按非 iframe 处理 */
      }
      const p = el.parentElement;
      if (
        p &&
        p.clientHeight > 0 &&
        p.clientHeight < window.innerHeight - 4
      ) {
        setShellH(p.clientHeight);
        return;
      }
      setShellH(null);
    };
    measure();
    const p = mainRef.current?.parentElement;
    if (p && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(measure);
      ro.observe(p);
      window.addEventListener("resize", measure);
      return () => {
        ro.disconnect();
        window.removeEventListener("resize", measure);
      };
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const chatWide = chatForceWide || chatWideMeasured;
  const [chatSplitW, setChatSplitW] = React.useState<number>(() => {
    const v = Number(readUiState(UI_STATE_KEY).chatSplitW);
    return Number.isFinite(v) && v >= 160 && v <= 480 ? v : 300;
  });
  const [chatListHidden, setChatListHidden] = React.useState<boolean>(
    () => readUiState(UI_STATE_KEY).chatListHidden === "true",
  );
  const setChatListHiddenPersist = React.useCallback(
    (hidden: boolean) => {
      setChatListHidden(hidden);
      mergeUiState({ chatListHidden: hidden ? "true" : "false" });
    },
    [mergeUiState],
  );
  const closeChatRoom = React.useCallback(() => {
    setActiveRoom(null);
    setRoomError("");
    writeUiState(tab, null);
  }, [tab, writeUiState]);
  const startChatSplitDrag = React.useCallback(
    (e: ReactNS.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = chatSplitW;
      const clamp = (w: number) => Math.min(480, Math.max(160, w));
      const onMove = (ev: globalThis.MouseEvent) => {
        setChatSplitW(clamp(startW + (ev.clientX - startX)));
      };
      const onUp = (ev: globalThis.MouseEvent) => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        // 落点一次写 localStorage（拖动中不写——高频写盘无谓）。
        mergeUiState({
          chatSplitW: String(clamp(startW + (ev.clientX - startX))),
        });
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [chatSplitW, mergeUiState],
  );

 // v0.5.0-beta.13.6（房间列表按钮与返回按钮重叠）：
  // 「☰ 房间列表」按钮不再 absolute 浮在聊天区左上角（与 RoomChat 顶栏
  // ← 返回 键重叠）——有房间时经 headerPrefix 进 RoomChat 顶栏最左
  // （Element 汉堡位）；无房间时（占位页）仍浮在左上角（无顶栏可挂）。
 // v0.5.0-beta.14.10：useMemo 钉住引用（headerPrefix 传给
  // RoomChat——普通 const 每次渲染新 JSX 元素引用会击穿 memo）。t 是每次
  // 渲染新对象 → deps 用原语色值。
  const chatListToggleBtn = React.useMemo(() => (chatListHidden ? (
    <button
      type="button"
      onClick={() => setChatListHiddenPersist(false)}
      title={tr("显示房间列表")}
      style={{
        border: `1px solid ${t.border}`,
        background: t.bg,
        color: t.text,
        borderRadius: 6,
        cursor: "pointer",
        padding: "3px 9px",
        fontSize: 13,
        lineHeight: "20px",
      }}
    >
      <MenuIcon size={14} style={{ verticalAlign: "-2px" }} /> {tr("房间列表")}
    </button>
  ) : null),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [chatListHidden, tr, t.border, t.bg, t.text, setChatListHiddenPersist]);

  // v0.5.0-beta.13.21（AgentActivityTrack）：房间 → 匹配项目事件
  // （与 roomProjectNames 同匹配源 roomMatchesProject，取首个命中；
  // 活动轨只需一个项目，多项目房间以列表首个为准，工作流 tab 仍可全看）。
  const roomProjectByRoom = React.useMemo(() => {
    const m: Record<string, WorkflowEvent> = {};
    for (const room of rooms) {
      for (const ev of workflowEvents) {
        if (roomMatchesProject(room.room_id, room.name, undefined, ev)) {
          m[room.room_id] = ev;
          break;
        }
      }
    }
    return m;
  }, [rooms, workflowEvents]);

 // v0.5.0-beta.14.10：Tabs items / 聊天双元素的回调 prop 稳定化
  // ——修复前全是内联箭头（每次渲染新引用 → 面板 memo 全部击穿，memo 白包）。
  // 数据类 props（rooms/messages/config/refreshTick 等）保持原样不动。
  const handleHomeOpenRoom = React.useCallback(
    (roomId: string) => {
      setTab("chat");
      void openRoom(roomId);
    },
    [setTab, openRoom],
  );
  const handleGotoTab = React.useCallback(
    (tabKey: string) => setTab(tabKey),
    [setTab],
  );
  const handleDmStable = React.useCallback(
    (mxid: string, roomId?: string) => void handleDm(mxid, roomId),
    [handleDm],
  );
  const openGlobalSearch = React.useCallback(() => setGlobalSearchOpen(true), []);
 // v0.5.0-beta.14.14：MessageSearch props 稳定化（内联箭头
  // 每次渲染新引用 → memo 击穿，每次点击/数据波都重渲组件体）。
  const handleGlobalSearchClose = React.useCallback(
    () => setGlobalSearchOpen(false),
    [],
  );
  const handleGlobalSearchOpenRoomOnly = React.useCallback(
    (roomId: string) => {
      setTab("chat");
      openRoom(roomId);
    },
    [setTab, openRoom],
  );
  const gotoApprovals = React.useCallback(() => setTab("home"), [setTab]);
  const gotoInvites = React.useCallback(() => {
    setActiveRoom(null);
    setTab("chat");
  }, [setTab]);
  const gotoSettings = React.useCallback(() => setTab("settings"), [setTab]);
  const handleWfRefresh = React.useCallback(
    () => void refreshWorkflow(),
    [refreshWorkflow],
  );
  const handleWfViewChange = React.useCallback(
    (v: WfView) => setWfMem({ view: v }),
    [setWfMem],
  );
  const handleWfTopoRunChange = React.useCallback(
    (runId: string) => setWfMem({ topoRun: runId }),
    [setWfMem],
  );
  const handleWfIntervened = React.useCallback(
    () => void refreshWorkflow(true),
    [refreshWorkflow],
  );
  const handleRoomsRefresh = React.useCallback(
    () => void refreshRooms(),
    [refreshRooms],
  );
  const handleInviteSettled = React.useCallback(
    () => void refreshRooms(true, true),
    [refreshRooms],
  );
  const handleConfigChange = React.useCallback(
    () => void refreshConfig(),
    [refreshConfig],
  );
 // v0.5.0-beta.14.16：设置页「重试」按钮——置回 loading 再走
  // refreshConfig（内部含 3 次退避重试）。
  const handleConfigRetry = React.useCallback(() => {
    setConfigLoadState("loading");
    void refreshConfig();
  }, [refreshConfig]);
 // v0.5.0-beta.14.16：周期兜底——settings tab 激活且 config 未就绪时
  // 每 5s 重取（refreshConfig 自带退避重试，此处只是「第二次机会」的定时器；
  // 就绪即停，零空转）。覆盖「首 GET 撞上插件重载窗口 + 用户不切 tab 不操作」
 // 的静默失败路径（「没有记忆」事故链）。
  usePoller({
    fn: () => void refreshConfig(),
    intervalMs: 5000,
    active: tab === "settings" && configLoadState !== "ready",
  });
  const handleChatBack = React.useCallback(
    () => {
      closeChatRoom();
      if (!chatWide) setChatListHiddenPersist(false);
    },
    [closeChatRoom, chatWide, setChatListHiddenPersist],
  );
  const handleJumpHandled = React.useCallback(() => setJumpToEventId(null), []);
  const noopStable = React.useCallback(() => void 0, []);
  // 内联字面量也是每次渲染新引用（[] / ?? []）→ useMemo 钉住。
  const liveWorkflows = React.useMemo(
    () => (workflowSource === "controller" ? workflowEvents : []),
    [workflowSource, workflowEvents],
  );
  const adminWorkers = React.useMemo(() => adminData?.workers ?? [], [adminData]);
  const selfCheckLayout = React.useMemo(
    () => ({
      wide: chatWide,
      forced: chatForceWide,
      threshold: CHAT_SPLIT_MIN_CONTAINER_W,
    }),
    [chatWide, chatForceWide],
  );

  // P6：聊天双元素提取（宽/窄屏两分支共用一份 JSX——props 长，禁止复制）。
  const chatRoomEl = activeRoom ? (
    <RoomChat
      room={activeRoom}
      messages={messages}
      liveWorkflows={liveWorkflows}
      loading={messagesLoading}
      sending={sending}
      hasMore={hasMore}
      onLoadOriginal={loadOriginal}
      pendingOriginal={pendingOriginalId}
      user_id={config?.matrix?.user_id}
      errorNote={
        roomError === "not_found"
          ? tr("该房间历史暂时无法加载——可能是房间已失效，也可能是权限或服务端问题。可返回聊天页换其他房间。")
          : ""
      }
 // v0.5.0-beta.14.10：回调 prop 全部改用上方稳定化
      // useCallback 引用（内联箭头每次渲染新引用会击穿 RoomChat memo）。
      onSend={handleSend}
      onSendApproval={handleSendApproval}
      onSendFiles={handleSendFiles}
      onSendEdit={handleSendEdit}
      onRedact={handleRedact}
      onLeaveRoom={handleLeaveRoom}
      onRenameRoom={handleRenameRoom}
      muted={activeRoom ? mutedRooms.includes(activeRoom.room_id) : false}
      onToggleMute={handleToggleMute}
      onReact={handleReact}
      onThreadPanelLayout={onThreadPanelLayout}
      onDm={handleDmStable}
      headerPrefix={chatListToggleBtn}
      onBack={handleChatBack}
      onNewTask={noopStable}
      onOpenWorkerChats={handleOpenWorkerChats}
      onLoadMore={loadMore}
      loadingMore={loadingMore}
      onPoll={pollMessages}
      jumpToEventId={jumpToEventId}
      onJumpHandled={handleJumpHandled}
      memberRoles={memberRoles}
      memberWorkerNames={memberWorkerNames}
      workerBadge={
        activeRoom ? workerBadgeMap[activeRoom.room_id] : undefined
      }
      sessionState={
        activeRoom ? workerSessionStates.byRoom[activeRoom.room_id] : undefined
      }
      workerMxids={workerSessionStates.workerMxids}
      workerSessionByMxid={workerSessionStates.byMxid}
      workers={adminWorkers}
      activityProject={
        activeRoom ? roomProjectByRoom[activeRoom.room_id] ?? null : null
      }
      onOpenProject={handleOpenProject}
      onWorkflowIntervened={handleWfIntervened}
      onOpenProjectFiles={openProjectFiles}
    />
  ) : null;
 // v0.5.0-beta.13.14：房间卡项目名——与 ProjectFiles 面板
  // 同一正源数据。v0.5.0-beta.13.15：匹配改 roomMatchesProject
  // 双源（source_room_id 严格匹配 ∪ 标准项目群命名 `Project: <项目名>`）
  // ——旧版只按 ev.room_id 建索引，标准项目群（source_room_id 指向发起
 // 房间）卡片恒无项目名（13.14）。
  const roomProjectNames = React.useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const room of rooms) {
      for (const ev of workflowEvents) {
        if (roomMatchesProject(room.room_id, room.name, undefined, ev)) {
          const list = m[room.room_id] || (m[room.room_id] = []);
          const title = ev.title || ev.runId;
          if (!list.includes(title)) list.push(title);
        }
      }
    }
    return m;
  }, [rooms, workflowEvents]);

  // v0.5.0-beta.13.21（侧栏角色分组）：MXID → 角色标签（Leader/
  // Worker/Manager）。WorkerInfo 自带 role（team_leader→Leader，余→
  // Worker）；Manager 单独归 Manager 类。无 L1 管理数据 → undefined →
  // TeamOverview 自动退回扁平列表。
  const workerRoleByMxid = React.useMemo(() => {
    if (!adminData) return undefined;
    const m: Record<string, string> = {};
    for (const w of adminData.workers || []) {
      if (w.matrixUserID) m[w.matrixUserID] = w.role === "team_leader" ? "Leader" : "Worker";
    }
    for (const mg of adminData.managers || []) {
      if (mg.matrixUserID) m[mg.matrixUserID] = "Manager";
    }
    return Object.keys(m).length ? m : undefined;
  }, [adminData]);

  const chatListEl = (
    <TeamOverview
      rooms={rooms}
      invites={invites}
      loading={roomsLoading}
      user_id={config?.matrix?.user_id}
      workerSessionByRoom={workerSessionStates.byRoom}
      workerMxids={workerSessionStates.workerMxids}
      roomProjectNames={roomProjectNames}
      workerRoleByMxid={workerRoleByMxid}
 // v0.5.0-beta.14.10：回调 prop 稳定化（同 RoomChat）。
      onOpenRoom={openRoom}
      onRefresh={handleRoomsRefresh}
      onInviteSettled={handleInviteSettled}
      onDm={handleDmStable}
      onGlobalSearch={openGlobalSearch}
      onMarkAllRead={handleMarkAllRead}
      markingAllRead={markingAllRead}
    />
  );
  const chatTabChildren = chatWide ? (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      {!chatListHidden ? (
        <>
          <div
            style={{
              position: "relative",
              width: chatSplitW,
              flexShrink: 0,
              minWidth: 0,
 // （P8a）：房间列表独立滚动（原先 overflow:hidden
              // 直接裁掉底部房间，列表无法滚动）；overscroll-contain 防
              // 滚动链传播到页面。
              overflowY: "auto",
              overscrollBehavior: "contain",
              borderRight: `1px solid ${t.border}`,
            }}
          >
            {chatListEl}
            <button
              type="button"
              onClick={() => setChatListHiddenPersist(true)}
              title={tr("隐藏房间列表")}
              style={{
                position: "absolute",
                top: 8,
                right: 8,
                zIndex: 10,
                border: `1px solid ${t.border}`,
                background: t.bg,
                color: t.textSecondary,
                borderRadius: 6,
                cursor: "pointer",
                padding: "2px 7px",
                fontSize: 12,
                lineHeight: "18px",
              }}
            >
              ⟨
            </button>
          </div>
          <div
            onMouseDown={startChatSplitDrag}
            title={tr("拖动调整房间列表宽度")}
            style={{
              width: 5,
              flexShrink: 0,
              cursor: "col-resize",
              background: "transparent",
            }}
          />
        </>
      ) : null}
      <div style={{ flex: 1, minWidth: 0, position: "relative", minHeight: 0 }}>
        {chatListHidden && !chatRoomEl ? (
          // 无房间选中（占位页）：顶栏不存在，按钮仍浮左上角。
          <div style={{ position: "absolute", top: 10, left: 10, zIndex: 10 }}>
            {chatListToggleBtn}
          </div>
        ) : null}
        {chatRoomEl || (
          <div
            style={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              color: t.textSecondary,
            }}
          >
            <span style={{ display: "inline-flex" }}><MessageIcon size={34} /></span>
            <div style={{ fontSize: 13 }}>
              {chatListHidden
                ? tr("房间列表已隐藏——点左上角 ☰ 显示")
                : tr("选择左侧房间开始聊天")}
            </div>
          </div>
        )}
      </div>
    </div>
  ) : activeRoom ? (
    chatRoomEl
  ) : (
    chatListEl
  );

  return (
    <antd.ConfigProvider theme={themeCfg}>
    <main
      ref={mainRef}
      className="wb-main"
      style={{
        // v0.5.0-beta.13.4：容器相对高度（Element 模型）——shellH 实测：
        // ① iframe 宿主=iframe 视口 ② 定高父容器（OS 窗口 .content）=父
        // clientHeight ③ 不定高回退旧经验值 calc(100vh-64px)（经典页面：
        // 宿主 header 56px + 8px 边距，见宿主 layouts/index.module.less
        // .sider）。12.x 的纯 vh 经验值在 OS 窗口小于屏幕时溢出 → 整页滚。
        height: shellH != null ? `${shellH}px` : "calc(100vh - 64px)",
 // v0.5.0-beta.13.8（13.7 左右留空太多，插件宽度应自适应）：
        // 去掉 1160 硬上限——16:9 全屏两侧各 ~380px 留空。全宽自适应：
        // 内容随窗口伸缩（表格/网格自行 minmax(0,1fr) 收放）。
        width: "100%",
        padding: "12px 20px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
 {/* 竖屏窄视口优化（团队管理竖屏用有点宽）——inline style
 无媒体查询能力，scoped CSS 注入；700px 断点=竖屏手机/窄窗。 */}
      <style>{`
        /* 宽元素防撑链（全视口，v0.5.0-beta.12）：flex/grid 项默认 min-width:auto，
 不可收缩内容（长 Tag/长占位符）会把 Col→Row→容器撑宽 → min-width:0
 断链：内容自行换行/内滚，容器恒宽、顶屏刚刚好。 */
        .wb-main .ant-row,
        .wb-main .ant-row .ant-col,
        .wb-main .ant-card,
        .wb-main .ant-card-body,
        .wb-main .qwenpaw-row,
        .wb-main .qwenpaw-row .qwenpaw-col,
        .wb-main .qwenpaw-card,
        .wb-main .qwenpaw-card-body { min-width: 0; max-width: 100%; }
        /* v0.5.0-beta.12：行内 Select 默认 min-width:auto=内容宽（长占位符撑行）
 → 强制可收缩（内容自行裁剪），断「创建团队卡溢出」最后一条链。 */
        .wb-main .ant-select,
        .wb-main .qwenpaw-select { min-width: 0; }
 /* （P8a）：聊天分栏左右独立滚动——antd Tabs 内部
 content 链默认无高度（auto 跟随内容）→ 分栏容器 height:100%
 塌陷、房间列表撑高被 wb-main overflow:hidden 裁掉。锁定
 content holder/content/tabpane 高度链（chatWide 分栏专用；
 其他 tab 内容自身有高度约束；12.11 起 tabpane 加 overflow-y:auto
 回退滚动、内容区容器 flex 化——整链真正接通）。 */
        /* 12.15 真机复现（宿主实测）：QwenPaw 宿主是自家前缀的 antd 分支
 （qwenpaw-tabs-*，无 .ant-tabs-*）——上面整条链在真宿主从未命中
 （左栏被撑到 8193px、整页滚动 4 轮复报的确证根因）。双前缀双写。 */
        .wb-main .ant-tabs-content-holder,
        .wb-main .qwenpaw-tabs-content-holder { flex: 1; min-height: 0; }
        .wb-main .ant-tabs-content,
        .wb-main .qwenpaw-tabs-content { height: 100%; }
        .wb-main .ant-tabs-tabpane-active,
        .wb-main .qwenpaw-tabs-tabpane-active { height: 100%; min-height: 0; overflow-y: auto; }
        /* v0.5.0-beta.12（390px 审计根因）：antd 断点最小档 xs=576px——
 390px 手机低于一切断点，Col 无任何断点样式 → 基础 width:100%
 + flex-shrink 把「员工入职/创建团队」两卡挤成 50/50（各 174px，
 内容需 330+ → 整条溢出链的源头）。<576px 强制单列通宽。 */
        @media (max-width: 575px) {
          .wb-main .ant-row > .ant-col,
          .wb-main .qwenpaw-row > .qwenpaw-col {
            flex: 0 0 100% !important;
            max-width: 100% !important;
          }
        }
        /* v0.5.0-beta.12（390px 实测审计实锤）：无列模板的 display:grid
 单 auto 列宽=max-min-content（创建团队表单被撑到 490px>390 视口）
 → minmax(0,1fr) 锁轨道=容器宽、item 可收缩。内联
 gridTemplateColumns 的网格不受影响（inline 优先级更高）。 */
        .wb-main [style*="display:grid"],
        .wb-main [style*="display: grid"] { grid-template-columns: minmax(0, 1fr); }
        /* 卡片标题：flex item min-width:auto 撑宽（"员工入职（Human CRD）"
 166>136 溢出）→ 允许收缩换行。 */
        .wb-main .ant-card-head-title { min-width: 0; }
        @media (max-width: 700px) {
          .wb-main { padding: 8px 10px 12px !important; gap: 8px !important; }
          .wb-main .ant-card-body { padding: 10px !important; }
          .wb-main .ant-table-cell { padding-left: 6px !important; padding-right: 6px !important; }
          .wb-main .ant-table-thead > tr > th { padding-left: 6px !important; padding-right: 6px !important; }
          .wb-main .ant-tag { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
          .wb-main pre, .wb-main code { white-space: pre-wrap; word-break: break-all; }
        }
      `}</style>
      <header
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: 12,
          paddingBottom: 10,
          borderBottom: `1px solid ${t.border}`,
        }}
      >
        {/* v0.5.0-beta.12.2：AgentTeams logo 替代 🏢（同 dashboard 侧边栏）。 */}
        <img
          src={LOGO_URL}
          width={28}
          height={28}
          alt="AgentTeams"
          style={{ display: "block" }}
        />
        <div>
          <antd.Typography.Title level={3} style={{ margin: 0 }}>
            AgentTeams 团队工作台
          </antd.Typography.Title>
          <antd.Tooltip
            title={
              connectorVersion && connectorVersion !== pluginVersion
                ? tr("前端 {f} · 连接器 {b}", {
                    f: pluginVersion,
                    b: connectorVersion,
                  })
                : tr("插件版本 {v}", { v: pluginVersion })
            }
          >
            <antd.Typography.Text type="secondary" style={{ fontSize: 12 }}>
              v{pluginVersion} —— 多团队工作台（聊天/工作流/产物/运维/管理）
            </antd.Typography.Text>
          </antd.Tooltip>
        </div>
        <div style={{ flex: 1 }} />
        {config?.matrix?.user_id ? (
          <antd.Tooltip title={tr("点击进入配置页")}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                cursor: "pointer",
                padding: "4px 10px",
                borderRadius: 20,
 background: "color-mix(in srgb, var(--app-accent, #FF7F16) 6%, transparent)",
              }}
              onClick={() => setTab("settings")}
            >
              <antd.Avatar
                size="small"
 style={{ backgroundColor: "var(--app-accent, #FF7F16)", fontSize: 13 }}
              >
                {(selfDisplayName || config.matrix.user_id.split(":")[0].replace(/^@/, "")).slice(0, 1).toUpperCase()}
              </antd.Avatar>
              <span style={{ fontSize: 12, color: t.textSecondary }}>
                {selfDisplayName ||
                  config.matrix.user_id.split(":")[0].replace(/^@/, "")}
              </span>
            </div>
          </antd.Tooltip>
        ) : (
          <antd.Button size="small" onClick={() => setTab("settings")}>
            {tr("登录")}
          </antd.Button>
        )}
      </header>

 {/* v0.5.0-beta.14.19: 登录态/凭据失效横幅——token 失效后 @通知静默
 全断、Higress 会话过期后 alias 层静默消失，此前前端零感知（产品
 盲点）。数据源=30s 轮询 /auth-status（零外发请求）。 */}
      {authStatus?.matrix_token === "invalid" && (
        <antd.Alert
          type="error"
          showIcon
          style={{ flex: "0 0 auto" }}
          message={tr("Matrix 登录已失效")}
          description={tr(
            "你的 Matrix 访问令牌已被服务器拒绝（通常是密码修改、设备被移除或管理员重置）。@提到我、通知与任务状态更新不可用——请重新登录后恢复。",
          )}
          action={
            <antd.Button size="small" danger onClick={() => setTab("settings")}>
              {tr("重新登录")}
            </antd.Button>
          }
        />
      )}
      {authStatus?.console_session === "expired" && (
        <antd.Alert
          type="warning"
          showIcon
          style={{ flex: "0 0 auto" }}
          message={tr("Higress 管理会话已过期")}
          description={tr(
            "模型 alias 层的 Console 管理会话已失效——设置页用管理员账号密码重新验证后恢复。",
          )}
          action={
            <antd.Button size="small" onClick={() => setTab("settings")}>
              {tr("重新验证")}
            </antd.Button>
          }
        />
      )}
      {/* v0.5.0-beta.14.24: 半连通 info 横幅——Controller 已连通（团队/工作流
      数据正常）但 Matrix 未登录（聊天/通知/@提醒/任务状态受限）。此前首页
      静默显示部分数据零提示（Pi 实测：1 team 正常 + 0 rooms 0 unread）。
      与上方两条不同：这是「可降级可用」而非「故障」，故 type=info + 可关闭，
      关闭态持久化避免每次重开打扰。 */}
      {authStatus?.matrix_token === "none" && !matrixNoneDismissed && (
        <antd.Alert
          type="info"
          showIcon
          closable
          onClose={() => dismissMatrixNone()}
          style={{ flex: "0 0 auto" }}
          message={tr("Matrix 未登录——部分功能受限")}
          description={tr(
            "团队 / 工作流等数据来自 Controller，显示正常；但聊天、通知、@提醒与任务状态同步需要 Matrix 账号。在「配置」页完成 Matrix 登录后功能即补齐。",
          )}
          action={
            <antd.Button size="small" onClick={() => setTab("settings")}>
              {tr("登录")}
            </antd.Button>
          }
        />
      )}

 {/* 自定义 tab 栏（布局自控——antd Tabs 内部 DOM 不可控，
 高度链断导致头部不固定。自写 tab bar + 内容容器 flex 布局） */}
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          gap: 2,
          borderBottom: `1px solid ${t.border}`,
          overflowX: "auto",
          scrollbarWidth: "none",
        }}
      >
        {[
          { key: "home", label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><HomeIcon size={15} /> {tr("首页")}</span> },
          { key: "chat", label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><MessageIcon size={15} /> {tr("聊天")}</span> },
          { key: "inbox", label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><BellIcon size={15} /> {tr("通知")}</span> },
          { key: "workflow", label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><TopologyIcon size={15} /> {tr("工作流")}</span> },
          { key: "artifacts", label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><BoxIcon size={15} /> {tr("产物")}</span> },
          {
            key: "team",
            // v0.5.0-beta.13.12：👷 工人 → 双人重叠图标（表团队/协作）。
            label: (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <TeamIcon size={15} /> {tr("团队管理")}
              </span>
            ),
          },
          { key: "knowledge", label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><NotesIcon size={15} /> {tr("知识库")}</span> },
          { key: "selfcheck", label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><SearchIcon size={15} /> {tr("自检")}</span> },
          { key: "ops", label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><WrenchIcon size={15} /> {tr("运维")}</span> },
          { key: "models", label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><BrainIcon size={15} /> {tr("模型")}</span> },

          { key: "settings", label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><SettingsIcon size={15} /> {tr("配置")}</span> },
        ]
          // v0.5.0-beta.14.20（用户 14.19 验收：模型页不应向 L2 提供）：
          // 无 Controller token（L1 不可用）时隐藏「模型」入口。
          .filter((item) => item.key !== "models" || hasCtlToken)
          .map((item) => {
          const active = tab === item.key;
          return (
            <button
              key={item.key}
              onClick={() => setTab(item.key)}
              style={{
                border: "none",
                background: "transparent",
                cursor: "pointer",
                padding: "9px 14px",
                fontSize: 13.5,
                whiteSpace: "nowrap",
                color: active ? PRIMARY : t.textSecondary,
                fontWeight: active ? 700 : 400,
                borderBottom: `2px solid ${active ? PRIMARY : "transparent"}`,
                transition: "color 0.15s, border-color 0.15s",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
              onMouseEnter={(e) => {
                if (!active)
                  (e.currentTarget as HTMLElement).style.color = PRIMARY;
              }}
              onMouseLeave={(e) => {
                if (!active)
                  (e.currentTarget as HTMLElement).style.color =
                    t.textSecondary;
              }}
            >
              {item.label}
              {item.key === "inbox" && inboxUnread > 0 ? (
                <span
                  style={{
                    background: PRIMARY,
                    color: "#fff",
                    borderRadius: 10,
                    fontSize: 10.5,
                    padding: "0 6px",
                    lineHeight: "16px",
                    fontWeight: 700,
                  }}
                >
                  {inboxUnread > 99 ? "99+" : inboxUnread}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* 内容区：flex 1 + 内部滚动——头部与 tab 栏固定，只有这里滚 */}
 {/* v0.5.0-beta.14.8：切页轻过渡目标（paneRef）——
 内容区最外层容器 div（antd.Tabs 的直接包裹层，keep-alive
 面板不重挂，只对该层做一次 170ms 淡入上浮）。 */}
      <div
        ref={paneRef}
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          /* v0.5.0-beta.12.11（P8a 真修复·最后一跳）：本容器必须 flex 化——
 否则 Tabs 的 flex:1 空转 → content-holder 的 flex:1 整链塌陷，
 分栏左右仍不能独立滚动（12.10 只锁了 CSS 链，漏了这里）。 */
          display: "flex",
          flexDirection: "column",
          /* v0.5.0-beta.12（第二轮：容器过宽）：overflowX 锁死——宽叶子不撑出横向滚动，容器恒=视口宽；
 配合 scoped CSS min-width:0 断 flex/grid 撑宽链。 */
          overflowY: "auto",
          overflowX: "hidden",
          maxWidth: "100%",
          paddingTop: 12,
        }}
      >
      <antd.Tabs
        renderTabBar={() => null}
        activeKey={tab}
        onChange={setTab}
        style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
        items={[
          {
            key: "home",
            label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><HomeIcon size={15} /> {tr("首页")}</span>,
            children: (
              <HomePage
                rooms={rooms}
                config={config}
                workflowEvents={workflowEvents}
                workerTree={workerTree}
                // 首页是 chat tab 之外：点房间必须 setTab("chat")+openRoom
                //（与通知中心 handleGotoRoom 同模式，跳转修复）。
                // v0.5.0-beta.14.10：回调 prop 稳定化引用。
                onOpenRoom={handleHomeOpenRoom}
                onGotoTab={handleGotoTab}
                managers={adminData?.managers}
                onDm={handleDmStable}
                treeSource={treeSource}
                inboxUnread={inboxUnread}
                onGlobalSearch={openGlobalSearch}
              />
            ),
          },
          {
            key: "chat",
            label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><MessageIcon size={15} /> {tr("聊天")}</span>,
            children: chatTabChildren,
          },
          {
            key: "inbox",
            label: (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <BellIcon size={15} /> {tr("通知")}
                {inboxUnread > 0 ? (
                  <antd.Badge
                    count={inboxUnread}
                    overflowCount={99}
                    size="small"
                    style={{ marginLeft: 6, backgroundColor: "var(--app-accent, #FF7F16)" }}
                  />
                ) : null}
              </span>
            ),
            children: (
              <NotificationCenter
                onUnreadCount={setInboxUnread}
                // v0.5.0-beta.14.10：回调 prop 稳定化引用。
                onGotoApprovals={gotoApprovals}
                onGotoRoom={handleGotoRoom}
                refreshTick={notifyTick}
                // v0.5.0-beta.12：邀请区数据 + 跳团队概览（邀请接受/拒绝
                // UI 在那里；chat tab 需无激活房间才显示 TeamOverview）。
                invites={invites}
                onGotoInvites={gotoInvites}
              />
            ),
          },
          {
            key: "workflow",
            label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><TopologyIcon size={15} /> {tr("工作流")}</span>,
            children: (
              <WorkflowBoard
                events={workflowEvents}
                loading={workflowLoading}
                // v0.5.0-beta.14.10：回调 prop 稳定化引用。
                onRefresh={handleWfRefresh}
                highlightRunId={selectedRunId}
                source={workflowSource}
                failReason={workflowFailReason}
                failDetail={workflowFailDetail}
                view={wfMem.view as WfView}
                onViewChange={handleWfViewChange}
                topoRun={wfMem.topoRun}
                onTopoRunChange={handleWfTopoRunChange}
              />
            ),
          },
          {
            key: "artifacts",
            label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><BoxIcon size={15} /> {tr("产物")}</span>,
            children: <Artifacts rooms={rooms} />,
          },
          {
            key: "team",
            // v0.5.0-beta.13.12：👷 → 双人重叠图标（与横排 tab 同源）。
            label: (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <TeamIcon size={15} /> {tr("团队管理")}
              </span>
            ),
            children: (
              <WorkerManage
                teams={workerTree}
                admin={adminData}
                treeLoading={spawnLoading}
                adminLoading={adminLoading}
                adminFailCount={adminFailCount}
                /* v0.5.0-beta.12 参数透传：` =>` 会吃掉 30s 自动刷新的 silent；
 v0.5.0-beta.14.10：直接透传稳定 useCallback 原引用
 （签名含 silent，等价于原内联箭头）。 */
                onRefreshTree={refreshTree}
                onRefreshAdmin={refreshAdmin}
                onDm={handleDmStable}
                /* v0.5.0-beta.13.10：L1 只读 Alert「去设置」跳配置页 */
                onOpenSettings={gotoSettings}
                hasToken={hasCtlToken}
                activeRef={teamActiveRef}
                treeSource={treeSource}
                workerSessionByName={workerSessionStates.byName}
                myUserId={config?.matrix?.user_id || ""}
                /* L1 走 controller token（config 或 env）且未配 admin 账号密码 = 无 Higress Console 会话 */
                l1TokenMode={hasCtlToken && !config?.admin_username}
              />
            ),
          },
          {
            key: "knowledge",
            label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><NotesIcon size={15} /> {tr("知识库")}</span>,
            children: <KnowledgeBase refreshTick={knowledgeTick} />,
          },
          {
            key: "selfcheck",
            label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><SearchIcon size={15} /> {tr("自检")}</span>,
            children: (
              <SelfCheckTab
                config={config}
                // v0.5.0-beta.14.10：内联对象字面量 → useMemo 稳定引用。
                layout={selfCheckLayout}
              />
            ),
          },
          {
            key: "ops",
            label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><WrenchIcon size={15} /> {tr("运维")}</span>,
            children: (
              <OpsPanel refreshTick={opsTick} />
            ),
          },
          {
            key: "models",
            label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><BrainIcon size={15} /> {tr("模型")}</span>,
            children: <ModelsTab />,
          },
          {
            key: "settings",
            label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><SettingsIcon size={15} /> {tr("配置")}</span>,
            children: (
              <SettingsTab
                onLoginSuccess={onLoginSuccess}
                config={config}
                configLoadState={configLoadState}
                onRetryConfig={handleConfigRetry}
                // v0.5.0-beta.14.10：回调 prop 稳定化引用。
                onConfigChange={handleConfigChange}
                chatForceWide={chatForceWide}
                onChatForceWideChange={setChatForceWidePersist}
                sseState={sseState}
              />
            ),
          },
        ]
          // v0.5.0-beta.14.20：与侧栏同门控——L2 无「模型」页。
          .filter((it) => it.key !== "models" || hasCtlToken)}
      />
      </div>
      {/* 跨房间消息搜索：点击结果 → 打开房间 + 定位事件；
 ：群名搜索（微信式）→ 点击直达房间 */}
      <MessageSearch
        open={globalSearchOpen}
        // v0.5.0-beta.14.14：props 全稳定引用（memo bail out）。
        onClose={handleGlobalSearchClose}
        onOpenRoom={handleGlobalSearchOpenRoom}
        rooms={rooms}
        onOpenRoomOnly={handleGlobalSearchOpenRoomOnly}
      />
      {/* 项目文件面板（产物端点 版：任务结果/任务书/交付物） */}
 {/* v0.5.0-beta.13.14：项目文件 Drawer 标题带文件夹 SVG；
 面板内不再重复「项目文件」标题行。 */}
      <antd.Drawer
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <FolderIcon size={14} /> {tr("项目文件")}
          </span>
        }
        open={projectFilesRoom !== null}
        onClose={() => setProjectFilesRoom(null)}
        width={440}
        destroyOnClose
      >
        <ProjectFiles
          room={projectFilesRoom}
          workflowEvents={workflowEvents}
          onClose={() => setProjectFilesRoom(null)}
        />
      </antd.Drawer>
      {/* 头像 → Worker 会话抽屉（只读，#1295 端点 + 版本门；内容=会话列表
          → agent 上下文完整 session）。兄弟视图：SSE tick 只刷新此抽屉，
          不重渲聊天整树；切离 chat tab 即随门控消失（与挂载于聊天区时
          的卸载语义一致）。 */}
      {tab === "chat" && chatsWorker ? (
        // QwenPaw 会话口径五列表需要更宽（560→620）。
        <antd.Drawer
          open
          onClose={() => setChatsWorker(null)}
          width={620}
          title={`${chatsWorker} — ${tr("会话")}`}
          styles={{ body: { padding: 14, background: t.bg } }}
        >
          <WorkerChats
            workers={adminWorkers}
            fixedWorker={chatsWorker}
            refreshTick={chatsTick}
          />
        </antd.Drawer>
      ) : null}
    </main>
    </antd.ConfigProvider>
  );
}
