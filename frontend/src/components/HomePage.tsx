import {
  SendIcon,
  MessageIcon,
  TopologyIcon,
  SearchIcon,
  BellIcon,
  NotesIcon,
  BoltIcon,
  SettingsIcon,
  UserIcon,
  UsersIcon,
  TodoIcon,
  BotIcon,
  BoxIcon,
} from "./icons";
import type * as ReactNS from "react";
import {
  fetchArtifacts,
  fetchRoomApprovals,
  fetchSglangLoads,
  sendApprovalCommand,
  type Artifact,
  type RoomApproval,
  type SglangRank,
  type ManagerInfo,
  type TeamRoom,
  type WorkbenchConfig,
  type WorkerTreeTeam,
  type WorkflowEvent,
} from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { useTabActive } from "../tabActivity";
import { usePoller } from "../usePoller";
import { useWbViewport } from "../WbViewportContext";
import { logoUrl as LOGO_URL } from "../lib/logo";
import { formatChatTime } from "../util";
import {
  CARD_RADIUS,
  PRIMARY,
  memberName,
  workflowStats,
  workerStats,
  type NewTaskTarget,
} from "./HomePageShared";
import { QuickBtn } from "./HomePageQuick";
import { ApprovalsCard } from "./HomePageApprovals";
import { SglangCard } from "./HomePageSglang";
import { NewTaskModal } from "./HomePageNewTask";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

interface HomePageProps {
  rooms: TeamRoom[];
  config: WorkbenchConfig | null;
  workflowEvents: WorkflowEvent[];
  workerTree: WorkerTreeTeam[];
  /** Manager 列表（跨团队任务入口 A）。 */
  managers?: ManagerInfo[];
  onOpenRoom: (roomId: string) => void;
  onGotoTab: (tabKey: string) => void;
  /** 发起任务弹窗选定目标 → DM 该 Leader/Manager。 */
  onDm?: (mxid: string, roomId?: string) => void;
  /** 团队结构来源（）："room-fallback"=Controller 未接入——房间聚合不可当团队，Leader 列表只留 Manager 入口。 */
  treeSource?: string;
  /** ：通知中心未读数（快捷入口角标）。 */
  inboxUnread?: number;
  /** ：全局搜索快捷入口（搜消息和群聊）。 */
  onGlobalSearch?: () => void;
}

/** 首页 = 全局总览（进门先看卡片，团队/群聊才是第二个 tab）。 */
function HomePage(props: HomePageProps) {
  const {
    rooms,
    config,
    workflowEvents,
    workerTree,
    managers,
    onOpenRoom,
    onGotoTab,
    onDm,
    treeSource = "",
    inboxUnread = 0,
    onGlobalSearch,
  } = props;
  const t = useThemeColors();
  const tr = useT();
  const { narrow } = useWbViewport();

  // 发起任务弹窗（选 Leader 入口——入口 B 默认 / Manager 跨团队 A）。
  const [newTaskOpen, setNewTaskOpen] = React.useState(false);
  const [newTaskSel, setNewTaskSel] = React.useState<string>("");
  const newTaskTargets = React.useMemo<NewTaskTarget[]>(() => {
    const out: NewTaskTarget[] = [];
    // room-fallback（Controller 未接入）时房间聚合不是真团队——
    // 项目群聊里的 manager 会被 spawn 归类 leader 列成垃圾，只留 Manager 入口。
    if (treeSource !== "room-fallback") {
      for (const team of workerTree) {
        for (const w of team.workers) {
          if (w.role !== "leader") continue;
          const mxid = w.mxid || w.worker_name;
          out.push({
            key: `leader:${w.worker_name}`,
            label: w.worker_name,
            team: team.team_name,
            mxid,
          });
        }
      }
    }
    const mgr = (managers || [])[0];
    if (mgr && mgr.name) {
      out.push({
        key: `manager:${mgr.name}`,
        label: mgr.name,
        team: tr("跨团队"),
        // matrixUserID 缺失回退裸 localpart（后端 /dm 补全 MXID）。
        mxid: mgr.matrixUserID || mgr.name,
        crossTeam: true,
      });
    }
    return out;
  }, [workerTree, managers, tr, treeSource]);
  const openNewTask = React.useCallback(() => {
    setNewTaskSel("");
    setNewTaskOpen(true);
  }, []);

  const [artifacts, setArtifacts] = React.useState<Artifact[]>([]);
  const [sglang, setSglang] = React.useState<{
    loaded: boolean;
    ranks: SglangRank[];
  }>({ loaded: false, ranks: [] });
  // 刷新感知（14.34）：最后一次成功轮询时刻——每轮必刷（独立于
  // setSglang 的 diff 门，空闲数值不变时也跳）。作脉冲点 remount
  // key：每来一帧数据绿点 ping 一次=「正在刷新」肉眼可感知。
  // （14.33「快照 N 秒前」age 文字在 1s 轮询下恒显 0、无可感知
  // 性，用户点名删——改脉冲点。）
  const [sgLocalAt, setSgLocalAt] = React.useState(0);
  // 待审批（房间审批源：/room-approvals=Worker Tool Guard 真实队列，
  // 30s 轮询）。弃用宿主 push-messages——集群
 // Worker 的审批发生在 Worker 所在进程，本机队列恒 0（首页没有）。
  const [approvals, setApprovals] = React.useState<RoomApproval[]>([]);
  const [approvalBusy, setApprovalBusy] = React.useState<string>("");

  const refreshApprovals = React.useCallback(async () => {
    try {
      const items = await fetchRoomApprovals(30);
      // 内容 diff 门——无变化复用 prev 引用
      // （30s 空转轮询不再重渲整个首页）。
      setApprovals((prev) =>
        JSON.stringify(prev) === JSON.stringify(items) ? prev : items,
      );
    } catch {
      /* 未登录 Matrix 时保持现状 */
    }
  }, []);

  // home tab 轮询活跃门控（tabActivity 单源 +
  // 页面可见；rc-tabs 保活：切走组件不卸载，必须显式门控）。
  // 字符串快照 → 布尔快照（useTabActive）
  // ——非 home tab 的互切不再触发本面板重渲（连点 Tab CPU 成本）。
  const homeActive = useTabActive("home") && !document.hidden;
  // 挂载首拉。
  React.useEffect(() => {
    void refreshApprovals();
  }, [refreshApprovals]);
  // 旧定时器 → usePoller（30s，!document.hidden
  // 由 hook 内置再 AND 一次）。
  usePoller({
    fn: refreshApprovals,
    intervalMs: 30000,
    active: homeActive,
  });

  const handleApproval = React.useCallback(
    async (action: "approve" | "deny", item: RoomApproval) => {
      const key = item.event_id || item.room_id;
      setApprovalBusy(key);
      try {
        const cmd = action === "approve" ? item.approve_cmd : item.deny_cmd;
        // 带 @Worker（群房间无 mention 的命令 Worker 不消费）。
        await sendApprovalCommand(
          item.room_id,
          item.sender,
          cmd,
          item.event_id
            ? { event_id: item.event_id, sender: item.sender, body: item.body }
            : undefined,
        );
        // 乐观移除 + 兜底刷新（Worker 处理完命令后队列自清）。
        setApprovals((prev) => prev.filter((x) => (x.event_id || x.room_id) !== key));
        await refreshApprovals();
      } catch (e) {
        antd.message.error(
          e instanceof Error ? e.message : tr("操作失败"),
        );
      } finally {
        setApprovalBusy("");
      }
    },
    [refreshApprovals],
  );

  // 最近动态改「零拉取派生」——直接消费 rooms 自带摘要
  // （last_sender/last_body/last_ts，由服务端 /sync timeline limit=1 与 SSE
  // room_list_update 增量维护）。已删原「每房拉最后 1 条」effect：
  // 其依赖整个 rooms 数组，任何增量合并都会全量重拉（实测 20+ 房 × 数秒级）。

  // 产物计数（·）：首屏不拉——home 激活 + 4s
  // 后拉（2.5s→4s + 隐藏页不拉）；避免整页装载窗口内
  // 触发服务端 75 房深扫（实测冷 55.9s）。
  React.useEffect(() => {
    if (!homeActive) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      // 延迟窗口内切走（页隐藏）不拉。
      if (document.hidden) return;
      void fetchArtifacts()
        .then((items) => {
          if (!cancelled) setArtifacts(items);
        })
        .catch(() => {
          /* 后端不可达时保持空 */
        });
    }, 4000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [homeActive]);

 // 集群负载（可选模块，仅配置开启时拉取；1s 静默轮询——实时刷新，
  // /v1/loads 读 SHM 快照专为高频轮询设计，1 QPS 零负担）。
 // 1s 旧定时器 → usePoller + 自适应间隔——
  // 上轮耗时 >300ms（后端慢窗）→ 本轮改 5000 降频，恢复快 → 回 1000；
  // 仅 home tab 激活 + 页面可见时跑（homeActive）。
  const sglangEnabled = Boolean(config?.sglang?.enabled);
  const sglangEnabledRef = React.useRef(sglangEnabled);
  sglangEnabledRef.current = sglangEnabled;
  const sglangAliveRef = React.useRef(true);
  React.useEffect(() => {
    sglangAliveRef.current = true;
    return () => {
      sglangAliveRef.current = false;
    };
  }, []);
  // 自适应节奏（与 OpsPanel 同名卡对齐，14.26 修复）：负载在变=1s 快档
  // （实时感），连续 2 周期不变（空闲）=5s 慢档。15s 慢档是「15s 一帧」
  // 被感知为「刷新慢几乎不刷」的真凶（14.26 在 OpsPanel 侧实证 15s→5s；
  // 本卡同批漏修，14.33 补平）。指纹=ranks JSON。
  const SG_FAST_MS = 1000;
  const SG_SLOW_MS = 5000;
  const sgCadenceRef = React.useRef(SG_FAST_MS);
  const sgStableRef = React.useRef(0);
  const sgRanksRef = React.useRef<SglangRank[] | null>(null);
  const pullSglang = React.useCallback(async () => {
    // 关闭后在飞请求不写状态（原 cancelled flag 语义）。
    if (!sglangEnabledRef.current || !sglangAliveRef.current) return;
    try {
      const d = await fetchSglangLoads();
      if (!sglangAliveRef.current) return;
      const ranks = d.ranks || [];
      // 脉冲点每轮必刷（独立于下方 diff 门——空闲数值不变时
      // 也 ping，刷新可感知）。
      setSgLocalAt(Date.now());
      const changed =
        JSON.stringify(sgRanksRef.current) !== JSON.stringify(ranks);
      if (changed) {
        sgRanksRef.current = ranks;
        sgStableRef.current = 0;
        sgCadenceRef.current = SG_FAST_MS;
        setSglang({ loaded: true, ranks });
      } else {
        // 连续 2 周期不变才降速（一周期确认，防快变场景误判空闲）。
        sgStableRef.current += 1;
        if (sgStableRef.current >= 2) sgCadenceRef.current = SG_SLOW_MS;
      }
    } catch {
      /* 404/网络失败 → 保持未加载 */
    }
  }, []);
  // 首拉（enabled 门走 ref 不进 deps——假→真切换由 usePoller 的 poke 覆盖，
  // 避免同刻双发）。
  React.useEffect(() => {
    if (sglangEnabledRef.current) void pullSglang();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pullSglang]);
  usePoller({
    fn: pullSglang,
    // 自适应节奏（getter 档；sgCadenceRef 在
    // pullSglang 内按 ranks 指纹切 1s/5s）。
    intervalMs: () => sgCadenceRef.current,
    active: homeActive && sglangEnabled,
    minPokeMs: 800,
  });

  const stats = workflowStats(workflowEvents);
  const wstats = workerStats(workerTree);
  const unreadTotal = rooms.reduce((a, r) => a + (r.unread || 0), 0);
  const highlightTotal = rooms.reduce(
    (a, r) => a + (r.unread_highlight || 0),
    0,
  );
  const artifactCount = artifacts.length;

  const cardStyle: ReactNS.CSSProperties = {
    borderRadius: CARD_RADIUS,
    background: t.cardBg,
    borderColor: t.border,
  };
  const cardBody: ReactNS.CSSProperties = { padding: 14 };
  const bigNumber: ReactNS.CSSProperties = {
    fontSize: 26,
    fontWeight: 800,
    color: t.text,
    lineHeight: "30px",
  };
  const subLabel: ReactNS.CSSProperties = {
    fontSize: 11,
    color: t.textSecondary,
    marginTop: 2,
  };

  // 两种排序语义分开——团队卡=未读优先再按活跃（动作导向）；
  // 最近动态=严格时间序（此前按未读排，全 0 未读时顺序任意=观感无时间序）。
  const roomsByUnread = [...rooms].sort(
    (a, b) =>
      (b.unread || 0) - (a.unread || 0) || (b.last_ts || 0) - (a.last_ts || 0),
  );
  const roomsByActivity = [...rooms].sort(
    (a, b) => (b.last_ts || 0) - (a.last_ts || 0),
  );

  return (
    <div
      style={{
        // 窄屏左右外边距收窄（20→12，屏幕侧贴一点）；宽屏保持 20。
        // border-box：width:100% 默认 content-box 时 padding 计入外宽，
        // 容器 <1080 的每个宽度档页头/入口卡/卡片整体右移 2×padding 溢出。
        boxSizing: "border-box",
        padding: narrow ? "14px 12px 24px" : "16px 20px 24px",
        maxWidth: 1080,
        margin: "0 auto",
        width: "100%",
      }}
    >
      {/* 欢迎条 + 快捷操作 */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: t.text }}>
            {/* AgentTeams logo 替代 🏢。 */}
            <img
              src={LOGO_URL}
              width={18}
              height={18}
              alt=""
              style={{ verticalAlign: "-3px", marginRight: 4 }}
            />
            {tr("AgentTeams 工作台")}
          </div>
          {/* 身份行——当前账号 + Controller 视图级别（多账号/双模式
 时一眼看清看的是谁的数据；L2 只看到授权团队，L1 全量）。 */}
          <div style={{ fontSize: 11, color: t.textSecondary }}>
            {config?.matrix?.user_id ? (
              <>
                <UserIcon size={11} style={{ verticalAlign: "-1px", marginRight: 2 }} />
                {config.matrix.user_id.startsWith("@")
                  ? config.matrix.user_id.slice(1).split(":")[0]
                  : config.matrix.user_id}{" · "}
              </>
            ) : null}
            {config?.controller_token
              ? tr("Controller L1 全量")
              : config?.matrix?.user_id
                ? tr("Controller L2 授权范围")
                : tr("Controller 未接入")}
            {/* 15.15：首页可见插件版本（页头版本行竖屏被 !narrow 隐藏，
 手机上无处可查版本；构建期注入 __PLUGIN_VERSION__，与页头同源）。 */}
            {" · v"}
            {__PLUGIN_VERSION__}
          </div>
        </div>
        <div style={{ fontSize: 12, color: t.textSecondary, marginTop: 2 }}>
          {tr("团队协作总览")}
        </div>
        {/* 7 快捷卡：窄屏 2 列 grid（等宽不拉伸，末行不满也整齐）；宽屏 flex-wrap。 */}
        <div
          style={{
            display: narrow ? "grid" : "flex",
            gridTemplateColumns: narrow ? "1fr 1fr" : undefined,
            gap: narrow ? 10 : 12,
            marginTop: 14,
            flexWrap: narrow ? undefined : "wrap",
          }}
        >
          <QuickBtn
            icon={<SendIcon size={20} />}
            label={tr("发起任务")}
            desc={tr("选 Leader 派发新任务")}
            onClick={openNewTask}
          />
          <QuickBtn
            icon={<MessageIcon size={20} />}
            label={tr("打开群聊")}
            desc={unreadTotal > 0 ? tr("有 {n} 条未读", { n: unreadTotal }) : tr("进入团队群聊")}
            onClick={() => onGotoTab("chat")}
          />
          <QuickBtn
            icon={<TopologyIcon size={20} />}
            label={tr("工作流")}
            desc={tr("项目进展与任务拓扑")}
            onClick={() => onGotoTab("workflow")}
          />
          <QuickBtn
            icon={<SearchIcon size={20} />}
            label={tr("全局搜索")}
            desc={tr("搜消息和群聊")}
            onClick={() => onGlobalSearch?.()}
          />
          <QuickBtn
            icon={<BellIcon size={20} />}
            label={tr("通知中心")}
            desc={inboxUnread > 0 ? tr("有 {n} 条通知", { n: inboxUnread }) : tr("审批与房间 @你")}
            onClick={() => onGotoTab("inbox")}
          />
          <QuickBtn
            icon={<NotesIcon size={20} />}
            label={tr("知识库")}
            desc={tr("团队知识一屏览")}
            onClick={() => onGotoTab("knowledge")}
          />
          <QuickBtn
            icon={<BoltIcon size={20} />}
            label={tr("技能中心")}
            desc={tr("团队技能与 MCP 矩阵")}
            onClick={() => onGotoTab("team")}
          />
          <QuickBtn
            icon={<SettingsIcon size={20} />}
            label={tr("快速配置")}
            desc={tr("检查连接与自检")}
            onClick={() => onGotoTab("settings")}
          />
        </div>
      </div>

      {/* 第一行：团队 / 任务进展 / Worker */}
      <antd.Row gutter={[12, 12]}>
        <antd.Col xs={24} sm={8}>
          <antd.Card style={cardStyle} styles={{ body: cardBody }}>
            <div
              style={{ cursor: "pointer" }}
              onClick={() => onGotoTab("chat")}
            >
              <div style={{ fontSize: 13, fontWeight: 700, color: t.text }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><UsersIcon size={14} /> {tr("团队")}</span>
              </div>
              <div style={{ display: "flex", gap: 20, marginTop: 8 }}>
                <div>
                  <div style={bigNumber}>{rooms.length}</div>
                  <div style={subLabel}>{tr("个房间")}</div>
                </div>
                <div>
                  <div style={bigNumber}>{unreadTotal}</div>
                  <div style={subLabel}>{tr("条未读")}</div>
                </div>
                {highlightTotal > 0 && (
                  <div>
                    <div style={{ ...bigNumber, color: "#ff4d4f" }}>
                      {highlightTotal}
                    </div>
                    <div style={subLabel}>@{tr("提到我")}</div>
                  </div>
                )}
              </div>
              {roomsByUnread.slice(0, 2).map((r) => (
                <div
                  key={r.room_id}
                  style={{
                    fontSize: 11,
                    color: t.text,
                    marginTop: 6,
                    padding: "4px 8px",
                    borderRadius: 6,
                    background: t.hoverBg,
                    cursor: "pointer",
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenRoom(r.room_id);
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
                    {r.name}
                  </span>
                  {/* 房间行动态时间（与聊天列表同口径 formatChatTime） */}
                  <span style={{ fontSize: 10, color: t.textSecondary, flexShrink: 0 }}>
                    {r.last_ts ? formatChatTime(r.last_ts) : ""}
                  </span>
                  {r.unread ? (
                    <span style={{ color: PRIMARY, fontWeight: 700, flexShrink: 0 }}>
                      {r.unread}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          </antd.Card>
        </antd.Col>
        <antd.Col xs={24} sm={8}>
          <antd.Card style={cardStyle} styles={{ body: cardBody }}>
            <div
              style={{ cursor: "pointer" }}
              onClick={() => onGotoTab("workflow")}
            >
              <div style={{ fontSize: 13, fontWeight: 700, color: t.text }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><TodoIcon size={14} /> {tr("任务进展")}</span>
              </div>
              <div style={{ display: "flex", gap: 20, marginTop: 8 }}>
                <div>
                  <div style={{ ...bigNumber, color: "#1677ff" }}>
                    {stats.running}
                  </div>
                  <div style={subLabel}>{tr("进行中")}</div>
                </div>
                <div>
                  <div
                    style={{
                      ...bigNumber,
                      color: stats.blocked > 0 ? "#fa8c16" : t.text,
                    }}
                  >
                    {stats.blocked}
                  </div>
                  <div style={subLabel}>{tr("阻塞")}</div>
                </div>
                <div>
                  <div style={{ ...bigNumber, color: "#52c41a" }}>
                    {stats.done}
                  </div>
                  <div style={subLabel}>{tr("已完成")}</div>
                </div>
              </div>
              <div style={{ fontSize: 11, color: t.textSecondary, marginTop: 10 }}>
                {workflowEvents.length === 0
                  ? tr("暂无工作流数据")
                  : tr("共 {n} 条工作流", { n: workflowEvents.length })}
              </div>
            </div>
          </antd.Card>
        </antd.Col>
        <antd.Col xs={24} sm={8}>
          <antd.Card style={cardStyle} styles={{ body: cardBody }}>
            <div
              style={{ cursor: "pointer" }}
              onClick={() => onGotoTab("team")}
            >
              <div style={{ fontSize: 13, fontWeight: 700, color: t.text }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><BotIcon size={14} /> {tr("Worker")}</span>
              </div>
              <div style={{ display: "flex", gap: 20, marginTop: 8 }}>
                <div>
                  <div style={{ ...bigNumber, color: PRIMARY }}>
                    {wstats.leaders}
                  </div>
                  <div style={subLabel}>{tr("领")}</div>
                </div>
                <div>
                  <div style={{ ...bigNumber, color: "#1677ff" }}>
                    {wstats.workers}
                  </div>
                  <div style={subLabel}>{tr("工")}</div>
                </div>
                <div>
                  <div style={{ ...bigNumber, color: "#fa8c16" }}>
                    {wstats.critics}
                  </div>
                  <div style={subLabel}>{tr("审")}</div>
                </div>
              </div>
              <div style={{ fontSize: 11, color: t.textSecondary, marginTop: 10 }}>
                {workerTree.length === 0
                  ? tr("暂无 Worker 数据")
                  : tr("共 {n} 个团队", { n: workerTree.length })}
              </div>
            </div>
          </antd.Card>
        </antd.Col>
      </antd.Row>

      <ApprovalsCard approvals={approvals} busy={approvalBusy} onAction={handleApproval} />

      {/* 第二行：最近动态（左宽）/ 右列=产物+集群负载堆叠（重排） */}
      <antd.Row gutter={[12, 12]} style={{ marginTop: 0 }}>
        {/* 窄容器（窗口仍 ≥576 触发 antd sm 断点）强制通宽堆叠——
  sm=16/8 按窗口断点切，窄插件容器下右列被压到 33% 宽不可用。 */}
        <antd.Col xs={24} sm={narrow ? 24 : 16}>
          <antd.Card style={cardStyle} styles={{ body: cardBody }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: t.text }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><MessageIcon size={14} /> {tr("最近动态")}</span>
            </div>
            {roomsByActivity.length === 0 ? (
              <div
                style={{ fontSize: 11, color: t.textSecondary, marginTop: 10 }}
              >
                {tr("暂无房间消息")}
              </div>
            ) : (
              roomsByActivity.slice(0, 4).map((r) => {
                // 直接用自带摘要（零拉取）。
                const sender = r.last_sender ? memberName(r, r.last_sender) : "";
                return (
                  <div
                    key={r.room_id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "7px 8px",
                      borderRadius: 6,
                      background: t.hoverBg,
                      marginTop: 8,
                      cursor: "pointer",
                    }}
                    onClick={() => onOpenRoom(r.room_id)}
                  >
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: t.text,
                        flexShrink: 0,
                        maxWidth: 140,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.name}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        color: t.textSecondary,
                        flex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.last_sender || r.last_body
                        ? `${sender}: ${r.last_body || tr("（非文本消息）")}`
                        : tr("暂无消息")}
                    </span>
                    {/* 动态行时间戳（此前最近动态无时间=无法判断新鲜度） */}
                    <span
                      style={{
                        fontSize: 10,
                        color: t.textSecondary,
                        flexShrink: 0,
                      }}
                    >
                      {formatChatTime(r.last_ts)}
                    </span>
                    {r.unread ? (
                      <span
                        style={{
                          fontSize: 10,
                          color: "#fff",
                          background: PRIMARY,
                          borderRadius: 8,
                          padding: "0 6px",
                          lineHeight: "16px",
                          flexShrink: 0,
                        }}
                      >
                        {r.unread}
                      </span>
                    ) : null}
                  </div>
                );
              })
            )}
          </antd.Card>
        </antd.Col>
        <antd.Col xs={24} sm={narrow ? 24 : 8}>
          {/* 右列=产物+集群负载堆叠（此前产物卡半空、负载独占整行） */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
  <antd.Card style={cardStyle} styles={{ body: cardBody }}>
              <div
                style={{ cursor: "pointer" }}
                onClick={() => onGotoTab("artifacts")}
              >
                <div style={{ fontSize: 13, fontWeight: 700, color: t.text }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><BoxIcon size={14} /> {tr("产物")}</span>
                </div>
                <div style={{ display: "flex", gap: 20, marginTop: 8 }}>
                  <div>
                    <div style={bigNumber}>{artifactCount}</div>
                    <div style={subLabel}>{tr("个产物")}</div>
                  </div>
                </div>
                {/* 最新产物行（此前卡片下半空白=信息密度低） */}
                {(() => {
                  const latest = artifacts.reduce<Artifact | null>(
                    (acc, a) => (!acc || (a.ts || 0) > (acc.ts || 0) ? a : acc),
                    null,
                  );
                  return latest ? (
                    <div
                      style={{
                        marginTop: 10,
                        padding: "6px 8px",
                        borderRadius: 6,
                        background: t.hoverBg,
                        fontSize: 11,
                      }}
                    >
                      <div
                        style={{
                          color: t.text,
                          fontWeight: 600,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={`${latest.filename}（${latest.room_name}）`}
                      >
                        {latest.filename || tr("图片")}
                      </div>
                      <div style={{ fontSize: 10, color: t.textSecondary, marginTop: 2 }}>
                        {latest.room_name} · {formatChatTime(latest.ts)}
                      </div>
                    </div>
                  ) : null;
                })()}
              </div>
            </antd.Card>
          {sglangEnabled && (
            <SglangCard
              sglang={sglang}
              sgLocalAt={sgLocalAt}
              onOpen={() => onGotoTab("ops")}
            />
          )}
          </div>
        </antd.Col>

      </antd.Row>

      

      <NewTaskModal
        open={newTaskOpen}
        targets={newTaskTargets}
        sel={newTaskSel}
        treeSource={treeSource}
        onSel={setNewTaskSel}
        onClose={() => setNewTaskOpen(false)}
        onConfirm={(tgt) => {
          onDm?.(tgt.mxid);
          setNewTaskOpen(false);
        }}
      />
    </div>
  );
}

// 面板级 memo——父级（WorkbenchPage）重渲染
// 且 props 无变化时跳过（修复前全仓零 memo，切 tab 帧断 183-200ms）。
export default React.memo(HomePage);
