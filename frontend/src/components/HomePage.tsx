import type * as ReactNS from "react";

import {
  fetchArtifacts,
  fetchRoomApprovals,
  fetchRoomMessages,
  fetchSglangLoads,
  sendApprovalCommand,
  type Artifact,
  type RoomApproval,
  type RoomMessage,
  type ManagerInfo,
  type TeamRoom,
  type WorkbenchConfig,
  type WorkerTreeTeam,
  type WorkflowEvent,
} from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { formatChatTime } from "../util";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

const PRIMARY = "#FF7F16";
const CARD_RADIUS = 10;

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
  /** 团队结构来源（v0.4.97）："room-fallback"=Controller 未接入——房间聚合不可当团队，Leader 列表只留 Manager 入口。 */
  treeSource?: string;
  /** 再版 13：通知中心未读数（快捷入口角标）。 */
  inboxUnread?: number;
  /** 再版 13：全局搜索快捷入口（搜消息和群聊）。 */
  onGlobalSearch?: () => void;
}

/** 发起任务候选：各团队 Leader（入口 B）+ Manager（入口 A，跨团队）。 */
interface NewTaskTarget {
  key: string;
  label: string;
  team: string;
  mxid: string;
  /** Manager 行标「跨团队」；Leader 行空。 */
  crossTeam?: boolean;
}

/** 成员显示名：display_name 优先，否则 MXID localpart。 */
function memberName(room: TeamRoom, mxid: string): string {
  const m = room.members?.[mxid];
  if (m?.display_name) return m.display_name;
  const lp = mxid.startsWith("@") ? mxid.slice(1).split(":")[0] : mxid;
  return lp || mxid;
}

/** 状态分组统计（与 WorkflowBoard STATUS_COLOR 口径一致）。 */
function workflowStats(events: WorkflowEvent[]): {
  running: number;
  blocked: number;
  done: number;
} {
  let running = 0;
  let blocked = 0;
  let done = 0;
  for (const ev of events) {
    const s = String(ev.status || "").toLowerCase();
    if (s === "running" || s === "in_progress" || s === "in-progress") {
      running += 1;
    } else if (s === "blocked") {
      blocked += 1;
    } else if (s === "completed" || s === "done") {
      done += 1;
    }
  }
  return { running, blocked, done };
}

/** Worker 角色计数（领/工/审）。 */
function workerStats(tree: WorkerTreeTeam[]): {
  leaders: number;
  workers: number;
  critics: number;
} {
  let leaders = 0;
  let workers = 0;
  let critics = 0;
  for (const team of tree) {
    for (const w of team.workers) {
      if (w.role === "leader") leaders += 1;
      else if (w.role === "critic") critics += 1;
      else if (w.role === "worker") workers += 1;
    }
  }
  return { leaders, workers, critics };
}

/** 首页 = 全局总览（用户 8/14 定案：进门先看卡片，团队/群聊才是第二个 tab）。 */
export default function HomePage(props: HomePageProps) {
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

  // 发起任务弹窗（v0.4.80：选 Leader 入口——入口 B 默认 / Manager 跨团队 A）。
  const [newTaskOpen, setNewTaskOpen] = React.useState(false);
  const [newTaskSel, setNewTaskSel] = React.useState<string>("");
  const newTaskTargets = React.useMemo<NewTaskTarget[]>(() => {
    const out: NewTaskTarget[] = [];
    // v0.4.97: room-fallback（Controller 未接入）时房间聚合不是真团队——
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
  const [lastMessages, setLastMessages] = React.useState<
    Record<string, RoomMessage>
  >({});
  const [sglang, setSglang] = React.useState<{
    loaded: boolean;
    ranks: { dp_rank: number; num_running_reqs: number; num_waiting_reqs: number }[];
  }>({ loaded: false, ranks: [] });
  // 待审批（房间审批源：/room-approvals=Worker Tool Guard 真实队列，
  // 30s 轮询）。v0.5.0-beta.10 再版 2：弃用宿主 push-messages——集群
  // Worker 的审批发生在 Worker 所在进程，本机队列恒 0（用户反馈「首页没有」）。
  const [approvals, setApprovals] = React.useState<RoomApproval[]>([]);
  const [approvalBusy, setApprovalBusy] = React.useState<string>("");

  const refreshApprovals = React.useCallback(async () => {
    try {
      const items = await fetchRoomApprovals(30);
      setApprovals(items);
    } catch {
      /* 未登录 Matrix 时保持现状 */
    }
  }, []);

  React.useEffect(() => {
    void refreshApprovals();
    const timer = window.setInterval(() => void refreshApprovals(), 30000);
    return () => window.clearInterval(timer);
  }, [refreshApprovals]);

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

  // 最近动态：每房间拉最后 1 条消息（rooms 通常 ≤10，成本低）。
  React.useEffect(() => {
    let cancelled = false;
    if (!rooms.length) return;
    void Promise.allSettled(
      rooms.map(async (r) => {
        const page = await fetchRoomMessages(r.room_id, 1);
        const last = page.messages[0];
        return { roomId: r.room_id, msg: last };
      }),
    ).then((results) => {
      if (cancelled) return;
      const map: Record<string, RoomMessage> = {};
      for (const res of results) {
        if (res.status === "fulfilled" && res.value.msg) {
          map[res.value.roomId] = res.value.msg;
        }
      }
      setLastMessages(map);
    });
    return () => {
      cancelled = true;
    };
  }, [rooms]);

  // 产物计数。
  React.useEffect(() => {
    let cancelled = false;
    void fetchArtifacts()
      .then((items) => {
        if (!cancelled) setArtifacts(items);
      })
      .catch(() => {
        /* 后端不可达时保持空 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 集群负载（可选模块，仅配置开启时拉取；1s 静默轮询——用户 8/19：实时刷新，
  // /v1/loads 读 SHM 快照专为高频轮询设计，1 QPS 零负担）。
  React.useEffect(() => {
    let cancelled = false;
    if (!config?.sglang?.enabled) return;
    const pull = () =>
      fetchSglangLoads()
        .then((d) => {
          if (!cancelled) setSglang({ loaded: true, ranks: d.ranks || [] });
        })
        .catch(() => {
          /* 404/网络失败 → 保持未加载 */
        });
    void pull();
    const timer = window.setInterval(() => void pull(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [config?.sglang?.enabled]);

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

  // 快捷操作（文字+emoji，零 antdIcons 依赖——教训 #322）。
  const quickBtn = (
    emoji: string,
    label: string,
    desc: string,
    onClick: () => void,
  ): ReactNS.ReactElement => (
    <div
      onClick={onClick}
      style={{
        flex: 1,
        minWidth: 140,
        cursor: "pointer",
        borderRadius: CARD_RADIUS,
        background: "#FFF3E8",
        border: "1px solid #FFD9B3",
        padding: "12px 14px",
        transition: "box-shadow .2s",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow =
          "0 2px 8px rgba(255,127,22,.25)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow = "none";
      }}
    >
      <div style={{ fontSize: 20, lineHeight: "24px" }}>{emoji}</div>
      <div
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: "#c2410c",
          marginTop: 4,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 10.5, color: "#9a3412", marginTop: 2 }}>
        {desc}
      </div>
    </div>
  );

  // 0.4.99：两种排序语义分开——团队卡=未读优先再按活跃（动作导向）；
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
        padding: "16px 20px 24px",
        maxWidth: 1080,
        margin: "0 auto",
        width: "100%",
      }}
    >
      {/* 欢迎条 + 快捷操作 */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: t.text }}>
            🏢 {tr("AgentTeams 工作台")}
          </div>
          {/* 0.4.99：身份行——当前账号 + Controller 视图级别（多账号/双模式
              时一眼看清看的是谁的数据；L2 只看到授权团队，L1 全量）。 */}
          <div style={{ fontSize: 11, color: t.textSecondary }}>
            {config?.matrix?.user_id
              ? `👤 ${config.matrix.user_id.startsWith("@")
                  ? config.matrix.user_id.slice(1).split(":")[0]
                  : config.matrix.user_id} · `
              : ""}
            {config?.controller_token
              ? tr("Controller L1 全量")
              : config?.matrix?.user_id
                ? tr("Controller L2 授权范围")
                : tr("Controller 未接入")}
          </div>
        </div>
        <div style={{ fontSize: 12, color: t.textSecondary, marginTop: 2 }}>
          {tr("团队协作总览")}
        </div>
        <div
          style={{
            display: "flex",
            gap: 12,
            marginTop: 14,
            flexWrap: "wrap",
          }}
        >
          {quickBtn(
            "🚀",
            tr("发起任务"),
            tr("选 Leader 派发新任务"),
            openNewTask,
          )}
          {quickBtn(
            "💬",
            tr("打开群聊"),
            unreadTotal > 0 ? tr("有 {n} 条未读", { n: unreadTotal }) : tr("进入团队群聊"),
            () => onGotoTab("chat"),
          )}
          {quickBtn(
            "🔍",
            tr("全局搜索"),
            tr("搜消息和群聊"),
            () => onGlobalSearch?.(),
          )}
          {quickBtn(
            "🔔",
            tr("通知中心"),
            inboxUnread > 0 ? tr("有 {n} 条通知", { n: inboxUnread }) : tr("审批与房间 @你"),
            () => onGotoTab("inbox"),
          )}
          {quickBtn(
            "📚",
            tr("知识库"),
            tr("团队知识一屏览"),
            () => onGotoTab("knowledge"),
          )}
          {quickBtn(
            "🧩",
            tr("技能中心"),
            tr("团队技能与 MCP 矩阵"),
            () => onGotoTab("team"),
          )}
          {quickBtn("⚙️", tr("快速配置"), tr("检查连接与自检"), () =>
            onGotoTab("settings"),
          )}
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
                👥 {tr("团队")}
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
                  {/* 0.4.99：房间行动态时间（与聊天列表同口径 formatChatTime） */}
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
                📋 {tr("任务进展")}
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
                🌳 {tr("Worker")}
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

      {/* 审批卡（房间审批源 /room-approvals=Worker Tool Guard 真实队列，
          30s 轮询；v0.5.0-beta.10 再版 2 弃宿主 push-messages 死源） */}
      <antd.Row gutter={[12, 12]}>
        <antd.Col span={24}>
          <antd.Card style={cardStyle} styles={{ body: cardBody }}>
            {/* 0.4.99：空态压缩为单行细条（此前空态也占整卡高度） */}
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: t.text }}>
                🛡️ {tr("待审批")}
                {approvals.length > 0 && (
                  <span
                    style={{
                      display: "inline-block",
                      marginLeft: 8,
                      minWidth: 18,
                      textAlign: "center",
                      fontSize: 11,
                      color: "#fff",
                      background: "#fa8c16",
                      borderRadius: 9,
                      padding: "0 6px",
                      lineHeight: "18px",
                    }}
                  >
                    {approvals.length}
                  </span>
                )}
              </div>
              {approvals.length === 0 ? (
                <div style={{ fontSize: 11, color: t.textSecondary, flex: 1 }}>
                  {tr("暂无待审批请求")} · {tr("Worker 请求审批时会桌面通知提醒")}
                </div>
              ) : null}
            </div>
            {approvals.length === 0 ? null : (

              approvals.map((item) => {
                // 房间审批源是纯文本消息——severity/tool 从 body 解析
                // （RoomChat parseApproval 同款正则）。
                const sevMatch = /Severity\s*[:：]\s*(?:🔴|🟡|🟢|🟠)?\s*([A-Za-z]+)/i.exec(
                  item.body,
                );
                const toolMatch = /Tool\s*[:：]\s*`?([^`\n*]+?)`?[\s*]*(?:$|\n)/i.exec(
                  item.body,
                );
                const sev = sevMatch?.[1]?.toUpperCase() || "MEDIUM";
                const sevColor =
                  sev === "CRITICAL" || sev === "HIGH"
                    ? "#ff4d4f"
                    : sev === "LOW"
                      ? "#52c41a"
                      : "#fa8c16";
                const when = new Date(item.ts * 1000).toLocaleTimeString(
                  "zh-CN",
                  { hour: "2-digit", minute: "2-digit" },
                );
                const workerShort = (item.sender.split(":")[0] || "")
                  .replace(/^@/, "");
                const toolName = toolMatch?.[1]?.trim() || "";
                const summary = (item.body || "")
                  .replace(/\*\*/g, "")
                  .replace(/\s+/g, " ")
                  .trim();
                const key = item.event_id || item.room_id;
                return (
                  <div
                    key={key}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      flexWrap: "wrap",
                      padding: "8px 10px",
                      borderRadius: 8,
                      background: t.hoverBg,
                      marginTop: 8,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        color: sevColor,
                        flexShrink: 0,
                        width: 34,
                      }}
                    >
                      {sev}
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: t.text,
                        flexShrink: 0,
                        maxWidth: 180,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={toolName || item.room_name}
                    >
                      {toolName || item.room_name || item.room_id}
                    </span>
                    <span style={{ fontSize: 11, color: t.textSecondary, flexShrink: 0 }}>
                      @{workerShort} · {when}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        color: t.textSecondary,
                        flex: 1,
                        minWidth: 120,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={summary}
                    >
                      {summary.slice(0, 80)}
                    </span>
                    <antd.Button
                      size="small"
                      type="primary"
                      loading={approvalBusy === key}
                      onClick={() => void handleApproval("approve", item)}
                    >
                      ✅ {tr("批准")}
                    </antd.Button>
                    <antd.Button
                      size="small"
                      danger
                      loading={approvalBusy === key}
                      onClick={() => void handleApproval("deny", item)}
                    >
                      ❌ {tr("拒绝")}
                    </antd.Button>
                  </div>
                );
              })
            )}
          </antd.Card>
        </antd.Col>
      </antd.Row>

      {/* 第二行：最近动态（左宽）/ 右列=产物+集群负载堆叠（0.4.99 重排） */}
      <antd.Row gutter={[12, 12]} style={{ marginTop: 0 }}>
        <antd.Col xs={24} sm={16}>
          <antd.Card style={cardStyle} styles={{ body: cardBody }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: t.text }}>
              💬 {tr("最近动态")}
            </div>
            {roomsByActivity.length === 0 ? (
              <div
                style={{ fontSize: 11, color: t.textSecondary, marginTop: 10 }}
              >
                {tr("暂无房间消息")}
              </div>
            ) : (
              roomsByActivity.slice(0, 4).map((r) => {
                const msg = lastMessages[r.room_id];
                const sender = msg ? memberName(r, msg.sender) : "";
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
                      {msg
                        ? `${sender}: ${msg.body || tr("（非文本消息）")}`
                        : tr("加载中…")}
                    </span>
                    {/* 0.4.99：动态行时间戳（此前最近动态无时间=无法判断新鲜度） */}
                    <span
                      style={{
                        fontSize: 10,
                        color: t.textSecondary,
                        flexShrink: 0,
                      }}
                    >
                      {formatChatTime(msg?.origin_server_ts || r.last_ts)}
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
        <antd.Col xs={24} sm={8}>
          {/* 0.4.99：右列=产物+集群负载堆叠（此前产物卡半空、负载独占整行） */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
  <antd.Card style={cardStyle} styles={{ body: cardBody }}>
              <div
                style={{ cursor: "pointer" }}
                onClick={() => onGotoTab("artifacts")}
              >
                <div style={{ fontSize: 13, fontWeight: 700, color: t.text }}>
                  📦 {tr("产物")}
                </div>
                <div style={{ display: "flex", gap: 20, marginTop: 8 }}>
                  <div>
                    <div style={bigNumber}>{artifactCount}</div>
                    <div style={subLabel}>{tr("个产物")}</div>
                  </div>
                </div>
                {/* 0.4.99：最新产物行（此前卡片下半空白=信息密度低） */}
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
          {config?.sglang?.enabled && (
  <antd.Card style={cardStyle} styles={{ body: cardBody }}>
                <div
                  style={{ cursor: "pointer" }}
                  onClick={() => onGotoTab("ops")}
                >
                  <div style={{ fontSize: 13, fontWeight: 700, color: t.text }}>
                    ⚡ {tr("集群负载")}
                  </div>
                  {!sglang.loaded ? (
                    <div
                      style={{ fontSize: 11, color: t.textSecondary, marginTop: 6 }}
                    >
                      {tr("暂无负载数据")}
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 16, marginTop: 8, flexWrap: "wrap" }}>
                      {sglang.ranks.map((r) => (
                        <div
                          key={r.dp_rank}
                          style={{
                            border: `1px solid ${t.border}`,
                            borderRadius: 8,
                            padding: "8px 12px",
                            minWidth: 140,
                          }}
                        >
                          <div style={{ fontSize: 11, fontWeight: 700, color: t.text }}>
                            DP {r.dp_rank}
                          </div>
                          <div style={{ fontSize: 11, color: t.textSecondary, marginTop: 2 }}>
                            {tr("运行 {a} · 排队 {b}", {
                              a: r.num_running_reqs,
                              b: r.num_waiting_reqs,
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </antd.Card>
)}
          </div>
        </antd.Col>

      </antd.Row>

      

      {/* 发起任务 · 选择 Leader（v0.4.80：入口 B Leader 默认 / 入口 A Manager 跨团队） */}
      <antd.Modal
        open={newTaskOpen}
        title={tr("发起任务 · 选择 Leader")}
        onCancel={() => setNewTaskOpen(false)}
        footer={
          <antd.Space>
            <antd.Button onClick={() => setNewTaskOpen(false)}>
              {tr("取消")}
            </antd.Button>
            <antd.Button
              type="primary"
              disabled={!newTaskSel}
              onClick={() => {
                const tgt = newTaskTargets.find((x) => x.key === newTaskSel);
                if (tgt) {
                  onDm?.(tgt.mxid);
                  setNewTaskOpen(false);
                }
              }}
            >
              {tr("发起任务")}
            </antd.Button>
          </antd.Space>
        }
      >
        {treeSource === "room-fallback" ? (
          <antd.Alert
            type="info"
            showIcon
            style={{ marginBottom: 10 }}
            message={tr(
              "团队 Leader 列表不可用（Controller 未接入）——以下为 Manager 入口（跨团队）",
            )}
          />
        ) : null}
        {newTaskTargets.length === 0 ? (
          <div style={{ fontSize: 12, color: t.textSecondary, padding: "8px 0" }}>
            {tr("未找到 Leader（团队结构未加载或 Controller 未接入）。请先到配置页检查 Controller 连接，再重新打开本弹窗。")}
          </div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {newTaskTargets.map((tgt) => {
              const sel = newTaskSel === tgt.key;
              return (
                <div
                  key={tgt.key}
                  onClick={() => setNewTaskSel(tgt.key)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    border: `1px solid ${sel ? PRIMARY : t.border}`,
                    background: sel ? `${PRIMARY}14` : "transparent",
                    borderRadius: 8,
                    padding: "10px 12px",
                    cursor: "pointer",
                  }}
                >
                  <span
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: "50%",
                      border: `2px solid ${sel ? PRIMARY : t.border}`,
                      background: sel ? PRIMARY : "transparent",
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: t.text }}>
                      {tgt.label}
                      {tgt.crossTeam ? (
                        <span style={{ fontSize: 10, color: PRIMARY, marginLeft: 8 }}>
                          {tr("跨团队入口")}
                        </span>
                      ) : null}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: t.textSecondary,
                        marginTop: 2,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {tgt.team} · {tgt.mxid}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </antd.Modal>
    </div>
  );
}
