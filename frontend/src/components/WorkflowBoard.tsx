// WorkflowBoard 巨石拆分 · 主组件装配层（props → state/hooks → JSX）。
// 子组件与纯函数纯搬移至 src/workflowboard/（行为零变）；对外契约不变：
// default export（React.memo）+ 具名导出 WfView。

import { WarnIcon, TopologyIcon, TodoIcon, AppIcon, ChartIcon } from "./icons";
import type * as ReactNS from "react";

import {
  type WorkflowEvent,
  fetchWorkflowProjects,
} from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { WorkflowEventsTimeline } from "./WorkflowEventsTimeline";
import { WbTooltip } from "./WbTooltip";
import { useWbViewport } from "../WbViewportContext";
import type { WorkflowBoardProps, WfView } from "../workflowboard/types";
import {
  PRIMARY,
  statusMeta,
  fmtTime,
  boardTasksFromEvents,
} from "../workflowboard/helpers";
import { DagTopo } from "../workflowboard/DagTopo";
import { BoardCard, BoardColumnsView } from "../workflowboard/BoardView";
import { EventCard, TaskInspectionDrawer } from "../workflowboard/panels";
import {
  InterventionActions,
  InterruptsBlock,
  LoopBlock,
} from "../workflowboard/blocks";
import { ProjectRail, NarrowDetailBack } from "../workflowboard/rail";

export type { WfView };

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
const icons = (host.antdIcons || {}) as Record<string, ReactNS.ComponentType>;
const EmptyIcon = (() => null) as unknown as ReactNS.FC<Record<string, unknown>>;
const pick = (name: string): ReactNS.FC<Record<string, unknown>> =>
  (icons[name] as ReactNS.FC<Record<string, unknown>>) || EmptyIcon;
const ReloadIcon = pick("ReloadOutlined");

function WorkflowBoard(props: WorkflowBoardProps) {
  const {
    events,
    loading,
    onRefresh,
    highlightRunId,
    source,
    failReason,
    failDetail,
    view: viewProp,
    onViewChange,
    topoRun: topoRunProp,
    onTopoRunChange,
  } = props;
  const t = useThemeColors();
  const tr = useT();
  // 受控——父组件（WorkbenchPage）持有记忆并下发；
  // 未传时回退内部 "list"（组件单独使用不报错）。
  const view: WfView = viewProp ?? "list";
  const setView = (v: WfView) => onViewChange?.(v);
  // // 拓扑依赖图样式切换退役——两图同结构、Mermaid 快照非交互，保单一
  // DAG 视图（图本身优化见 WorkflowDag.tsx）。旧 localStorage 键
  // wf-topo-graph-style 不再读写（残留值无害）。
  /** 排序（用户「工作流的排序要加上时间排序」）。
 * 默认时间新→旧（与聊天列表一致）；ts 数据源=api.ts projectActivityTs
 * 多源富化（此前恒 0——上游列表端点无时间戳字段）。 */
  const [sortBy, setSortBy] = React.useState<
    "time_desc" | "time_asc" | "status" | "name"
  >("time_desc");
  const sortedEvents = React.useMemo(() => {
    const arr = [...events];
    const rank: Record<string, number> = {
      failed: 0,
      paused: 1,
      active: 2,
      planning: 3,
      completed: 4,
      unknown: 5,
    };
    switch (sortBy) {
      case "time_asc":
        arr.sort((a, b) => (a.ts || 0) - (b.ts || 0));
        break;
      case "status":
        arr.sort(
          (a, b) =>
            (rank[a.status] ?? 9) - (rank[b.status] ?? 9) ||
            (b.ts || 0) - (a.ts || 0),
        );
        break;
      case "name":
        arr.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
        break;
      default:
        arr.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    }
    return arr;
  }, [events, sortBy]);
  // 拓扑视图：选一个有 nodes 的 runId。
  const withNodes = events.filter((e) => (e.nodes || []).length > 0);
  // 空态说真话——项目已列出但 nodes 全空（create-project.sh 建的项目
  // 是 planning 状态：meta.json 只有 workers 没有任务 DAG，任务在群聊 @mention
  // 协调）。此前空态一律说"等 DAG 模式"，用户「看板和拓扑都没有信息」无从下手。
  const emptyEventCount = events.length;
  // 看板任务数（Segmented label 用）。
  const boardTaskCount = React.useMemo(
    () => boardTasksFromEvents(events).length,
    [events],
  );
  // 受控——拓扑选中的 runId 由父组件记忆下发；失效值由
  // 下方 topoEvent 的 withNodes[0] 兜底（Select value 跟随 topoEvent）。
  const topoRun = topoRunProp ?? "";
  const setTopoRun = (runId: string) => onTopoRunChange?.(runId);
  // 窄屏单栏 drill-in（narrow = 容器宽 < 800，与聊天单栏同源判定）：
  // 卡片/拓扑视图在窄屏从左右两栏改「项目列表（整宽）→ 点项目 → 详情（整宽）+ ← 返回」，
  // 与聊天「房间列表 → 点进房间」同一心智；宽屏（narrow=false）路径保持原两栏不变。
  // detailOpen = 局部「已钻进详情」标记——topoEvent 有 withNodes[0] 回退、恒非空，
  // 不能用来判「是否钻进了详情」。
  const { narrow } = useWbViewport();
  const [detailOpen, setDetailOpen] = React.useState(false);

  // ── ：首载状态机 ──
  // 冷启动期 /projects-workflow 快照为空（后端首扫 1-3 分钟），旧行为渲染
  // 空表格/「暂无工作流事件」占位（「UI 好像烂了，要过很久或者
  // 刷新才正常」）。现在：正源健康（source=controller）且 events 空 →
  // 「首聚合」态：Spin + 每 3s 自动重试（非 force，30s 缓存过期后实际
  // 穿透后端，与父级 15s 轮询经在飞去重合并），最长 180s；超时仍空 →
  // 停自动重试，留手动重试提示（右上刷新按钮保留）。数据到达（events
  // 非空）或正源降级（source=rooms）→ 立即退出本态恢复原渲染；已有
  // 内容期间从不触发本态（gate 要求 events 为空，不清空已有内容）。
  const aggGate = events.length === 0 && source === "controller";
  const [aggPhase, setAggPhase] = React.useState<
    "idle" | "aggregating" | "timeout"
  >("idle");
  const aggStartRef = React.useRef(0);
  React.useEffect(() => {
    if (!aggGate) {
      if (aggPhase !== "idle") setAggPhase("idle");
      return;
    }
    if (aggPhase === "idle") {
      aggStartRef.current = Date.now();
      setAggPhase("aggregating");
      return;
    }
    if (aggPhase !== "aggregating") return; // timeout：停等手动刷新再武装
    let timer = 0;
    const tick = async () => {
      if (Date.now() - aggStartRef.current >= 180000) {
        setAggPhase("timeout");
        return;
      }
      try {
        await fetchWorkflowProjects(); // 非 force：30s 缓存 + 在飞去重
      } catch {
        /* 取数异常：由父级轮询/降级横幅收敛，不打断重试链 */
      }
      timer = window.setTimeout(tick, 3000);
    };
    timer = window.setTimeout(tick, 3000);
    return () => window.clearTimeout(timer);
  }, [aggGate, aggPhase]);

 // 手动刷新必穿透——force=true 绕过
 // 30s 缓存 + ?refresh=1 触发连接器后台补扫；结果仍空 →
  // （重新）进入首聚合态（180s 预算重置）。随后 onRefresh 让父级同步
  // 状态（其无参调用命中 force 刚写入的新缓存，events prop 收敛同值）。
  const [manualRefresh, setManualRefresh] = React.useState(false);
  const handleRefreshClick = React.useCallback(async () => {
    setManualRefresh(true);
    try {
      const res = await fetchWorkflowProjects(true);
      if (res.apiOk && res.events.length === 0) {
        aggStartRef.current = Date.now();
        setAggPhase("aggregating");
      }
    } catch {
      /* 穿透取数异常：由父级刷新路径（message/横幅）收敛 */
    } finally {
      setManualRefresh(false);
    }
    void onRefresh?.();
  }, [onRefresh]);

  // 聊天 workflow 卡片跳转：切列表视图 + 同步 topo 选中 +
  // 滚动高亮行。
  React.useEffect(() => {
    if (!highlightRunId) return;
    setView("list");
    setTopoRun(highlightRunId);
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-run-id="${CSS.escape(highlightRunId)}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightRunId, onViewChange, onTopoRunChange]);

  const topoEvent = events.find((e) => e.runId === topoRun) || withNodes[0] || null;
  // 卡片视图：选中项目的任务卡（复用看板 BoardCard——状态/取消同一条路）。
  const cardTasks = React.useMemo(
    () => (topoEvent ? boardTasksFromEvents([topoEvent]) : []),
    [topoEvent],
  );
  // #1230 任务巡检：任务卡点击 → Drawer（runId+taskId 双键定位；
  // 事件被刷新剔除时 find 落 null → Drawer 自动空态关闭语义由 open 判空覆盖）。
  const [inspect, setInspect] = React.useState<{
    runId: string;
    taskId: string;
  } | null>(null);
  const inspectEv = inspect
    ? events.find((e) => e.runId === inspect.runId) || null
    : null;

  // 窄屏 drill-in：选中项目在刷新后从列表消失（topoEvent 落 null）→
  // 自动回列表，避免停在空详情上回不去。
  React.useEffect(() => {
    if (narrow && detailOpen && !topoEvent) setDetailOpen(false);
  }, [narrow, detailOpen, topoEvent]);

  // 窄/宽共用：卡片视图详情体（EventCard + 任务卡网格）。提为变量供
  // 窄屏钻取详情与宽屏右栏两分支共用——宽屏渲染同一元素，输出不变。
  const cardDetail = topoEvent ? (
    <div>
      <EventCard ev={topoEvent} t={t} onIntervention={() => onRefresh?.()} />
      {cardTasks.length > 0 ? (
        /* 窄屏单列全宽堆叠（auto-fill 230px 在窄容器内换行不彻底、
卡被压窄）；宽屏保持 auto-fill。 */
        <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "repeat(auto-fill, minmax(230px, 1fr))", gap: 10, marginTop: 12 }}>
          {cardTasks.map((task, i) => (
            <BoardCard
              key={`${task.node.id ?? i}`}
              task={task}
              t={t}
              onTaskDone={() => onRefresh?.()}
              onOpenDetail={(tid) =>
                setInspect({ runId: topoEvent.runId, taskId: tid })
              }
            />
          ))}
        </div>
      ) : (
        <div style={{ marginTop: 12, fontSize: 12, color: t.textSecondary, padding: "14px 12px", border: `1px dashed ${t.border}`, borderRadius: 8 }}>
          {tr("暂无任务——项目可能还在 planning（Coordinator 起草计划中），任务登记后会显示任务卡")}
        </div>
      )}
    </div>
  ) : (
    <antd.Empty description={tr("请选择左侧项目")} />
  );

  // 窄/宽共用：拓扑视图详情体（标题行 + 干预/中断/loop + DAG + 事件流）。
  const topoDetail = topoEvent ? (
    <div>
      {/* 标题行随内容滚（非常驻）——竖屏下 sticky 常驻吃掉纵向空间，
      竖屏反馈「标题栏改成和下面一起滚动，增加可滚动空间」。 */}
      <div
        style={{
          fontWeight: 700,
          marginBottom: 10,
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        {topoEvent.title || topoEvent.runId}
        <antd.Tag
          color={statusMeta(topoEvent.status).color}
          style={{ margin: 0 }}
        >
          {statusMeta(topoEvent.status).label}
        </antd.Tag>
        <InterventionActions ev={topoEvent} onDone={() => onRefresh?.()} />
      </div>
      <InterruptsBlock
        interrupts={topoEvent.interrupts || []}
        pauseReason={topoEvent.pause_reason}
        tasks={topoEvent.taskDetails}
      />
      {topoEvent.loop ? <LoopBlock loop={topoEvent.loop} /> : null}
      {(topoEvent.nodes || []).length > 0 ? (
        <DagTopo
          ev={topoEvent}
          t={t}
          onNodeClick={(nodeId) =>
            setInspect({ runId: topoEvent.runId, taskId: nodeId })
          }
        />
      ) : (
        <div style={{ color: t.textSecondary, fontSize: 12 }}>
          {tr("暂无拓扑数据——本项目可能还在 planning（Coordinator 起草计划中），计划生成后请重试")}
        </div>
      )}
      <WorkflowEventsTimeline projectId={topoEvent.runId} teamId={topoEvent.team_id} />
    </div>
  ) : (
    <antd.Empty description={tr("请选择左侧项目")} />
  );

  // 左栏宽
  // 220–520，默认 320，持久化（与聊天分栏 chatSplitW 同款交互）。
  const RAIL_KEY = "agentteams-qwenpaw-workbench:workflow-rail-w";
  const [railW, setRailW] = React.useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(RAIL_KEY));
      return Number.isFinite(v) && v >= 220 && v <= 520 ? v : 320;
    } catch {
      return 320;
    }
  });
  const railWRef = React.useRef(railW);
  railWRef.current = railW;
  const startRailDrag = React.useCallback((e: ReactNS.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = railWRef.current;
    const clamp = (w: number) => Math.min(520, Math.max(220, w));
    const onMove = (ev: globalThis.MouseEvent) =>
      setRailW(clamp(startW + (ev.clientX - startX)));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      try {
        localStorage.setItem(RAIL_KEY, String(railWRef.current));
      } catch {
        /* 隐私模式 localStorage 不可用——本次会话有效即可 */
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  return (
    // 根容器对齐宿主可见宽高：height:100%（父 = tabpane，定高链见
    // WorkbenchPage scoped CSS：content-holder flex:1 → content 100% →
    // tabpane-active height:100%+overflow-y:auto）。纵向 flex 链，视图区
    // 取剩余高（flex:1+minHeight:0），全程容器相对——文件内不再出现 100vh
    // （宿主为 Desktop OS 可拖拽容器，100vh≠容器高，短窗口下列表被压到
    // 不可用/内容外溢）。wide 布局结构不变（仅高度来源由视口换为容器）。
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        width: "100%",
        boxSizing: "border-box",
        minWidth: 0,
        gap: 12,
      }}
    >
      {/* 正源降级横幅（不再静默）——用户「Leader 项目看不到，只有
 Manager 的」= 正源 401 静默回退、只剩自己已加入房间的 Matrix 扫描。 */}
      {source === "rooms" ? (
        <div
          style={{
            background: `color-mix(in srgb, ${PRIMARY} 8%, transparent)`,
            border: `1px solid color-mix(in srgb, ${PRIMARY} 33%, transparent)`,
            borderRadius: 8,
            padding: "8px 12px",
            fontSize: 12,
            flexShrink: 0,
            color: t.text,
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><WarnIcon size={12} /> {tr("当前只显示你已加入房间的项目")}</span>
          {failReason === "auth"
            ? tr("——Controller 正源未接通（token 未配置或无效）。配置页填入 controller_token（L1）后可查看全部项目（含 Leader 创建、你不在其房间内的）")
            : failReason === "not_deployed"
              ? tr("——Controller 未升级到含 workflow API 的版本（404）")
              : (
                <>
                  {tr("——Controller 正源不可用")}
                  {failDetail ? (
                    <span style={{ color: t.textSecondary }}>
                      （{failDetail.slice(0, 160)}）
                    </span>
                  ) : null}
                </>
              )}
        </div>
      ) : null}
      {/* 竖屏工具行：「工作流」标题去掉（tab 已有）；拆两行——
      RowA 计数+ⓘ+视图 tab；RowB 排序(左)+刷新(右)贴左右两边。 */}
      <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        {/* Row A：仅视图 tab（项目计数+ⓘ 移到下行，与排序/刷新同 col——省一行）。 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <antd.Segmented
            size="small"
            value={view}
            onChange={(v: ReactNS.Key | number) =>
              setView(v as "list" | "card" | "board" | "topo")
            }
            options={[
              { value: "list", label: <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><TodoIcon size={12} /> {tr("项目列表")}</span> },
              { value: "card", label: <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><AppIcon size={12} /> {tr("项目卡片")}</span> },
              { value: "board", label: <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><ChartIcon size={12} /> {tr("看板")}</span> },
              {
                value: "topo",
                label: (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <TopologyIcon size={14} /> {tr("拓扑")}
                  </span>
                ),
              },
            ]}
          />
        </div>
        {/* Row B：返回(恒最左) + 项目(N) + ⓘ + 排序 + 刷新（返回按钮始终在最左，
        「项目 (N)」在返回钮右侧；排序/刷新贴右不变）。 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* 返回钮：窄屏 topo/card 钻详情时显示——恒占最左位。 */}
          {narrow && detailOpen && (view === "topo" || view === "card") ? (
            <antd.Button size="small" onClick={() => setDetailOpen(false)} style={{ flexShrink: 0 }}>
              ← {tr("返回")}
            </antd.Button>
          ) : null}
          <span style={{ fontSize: 12.5, color: t.textSecondary, flexShrink: 0 }}>
            {tr("项目")}（{events.length}）
          </span>
          <WbTooltip
            title={tr("项目列表/项目卡片/看板/拓扑 四种视图；项目卡片与拓扑为左侧项目列表+右侧详情（对齐 dashboard 任务看板「项目」区）；看板列映射与 dashboard 同源（workflow API）；拓扑依赖图=DAG（交互，节点点看任务；13.24 起单一视图，Mermaid 快照已合并退役）")}
          >
            <span style={{ color: t.textSecondary, cursor: "help", fontSize: 12 }}>ⓘ</span>
          </WbTooltip>
          <div style={{ flex: 1 }} />
          {/* 排序（时间/状态/名称）——列表/看板跟随；卡片/拓扑左栏项目列表跟随。 */}
          <antd.Select
            size="small"
            value={sortBy}
            onChange={(v: "time_desc" | "time_asc" | "status" | "name") =>
              setSortBy(v)
            }
            style={{ width: 128 }}
            options={[
              { value: "time_desc", label: tr("时间 新→旧") },
              { value: "time_asc", label: tr("时间 旧→新") },
              { value: "status", label: tr("按状态") },
              { value: "name", label: tr("名称 A→Z") },
            ]}
          />
          <WbTooltip title="刷新">
            <antd.Button
              type="text"
              size="small"
              icon={<ReloadIcon />}
              loading={loading || manualRefresh}
              onClick={() => void handleRefreshClick()}
            />
          </WbTooltip>
        </div>
      </div>

      {/* 视图区：占根容器剩余高（flex:1+minHeight:0，容器相对链的唯一出口）。
窄屏各分支在此内部纵向滚（返回条/表头不随内容滚走）；宽屏分支内容溢出
时仍由 tabpane（overflow-y:auto）承接整页滚动——现状不变。 */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", minWidth: 0 }}>
      {aggGate && aggPhase === "aggregating" ? (
        /* ：首聚合态——冷启动期不渲染空
 表格（「烂」的直接观感源），明确加载态 + 自动重试（状态机见上）。 */
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 10,
            padding: "64px 0",
          }}
        >
          <antd.Spin />
          <span style={{ fontSize: 12.5, color: t.textSecondary }}>
            {tr("首次聚合中（自动刷新）…")}
          </span>
        </div>
      ) : aggGate && aggPhase === "timeout" ? (
        /* 180s 仍空：停自动重试，手动重试提示（右上刷新按钮保留）。 */
        <antd.Empty
          description={tr("暂无可显示的工作流；可点击右上刷新重试")}
        />
      ) : view === "list" ? (
        events.length === 0 ? (
          <antd.Empty description={tr("暂无工作流事件——Agent 执行任务时会在这里聚合")} />
        ) : narrow ? (
          // 窄屏「项目列表」tab：表格 7 列(合计~825px)在 360px 下"每栏太宽不可用"
          // → 卡片列表(整宽、标题/元信息自动换行、操作按钮成行)——mobile table→cards。
          <div style={{ flex: 1, minHeight: 0, minWidth: 0, overflowY: "auto", padding: "4px 2px" }}>
            {sortedEvents.map((ev) => {
              const meta = statusMeta(ev.status);
              return (
                <div
                  key={ev.runId}
                  style={{ border: `1px solid ${t.border}`, borderRadius: 8, padding: "8px 10px", background: t.cardBg, marginBottom: 8, boxSizing: "border-box" }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <b style={{ flex: 1, minWidth: 0, fontSize: 13, whiteSpace: "normal", wordBreak: "break-word" }}>{ev.title || ev.runId}</b>
                    <antd.Tag color={meta.color} style={{ margin: 0, flexShrink: 0 }}>{meta.label}</antd.Tag>
                  </div>
                  <div style={{ fontSize: 11, color: t.textSecondary, marginTop: 4, whiteSpace: "normal", wordBreak: "break-word" }}>
                    {(ev.coordinator || "").split(":")[0].replace(/^@/, "")}{(ev.steps || []).length ? ` · ${(ev.steps || []).length} 步` : ""}{ev.ts ? ` · ${fmtTime(ev.ts)}` : ""}
                  </div>
                  <div style={{ marginTop: 6 }}><InterventionActions ev={ev} onDone={() => onRefresh?.()} /></div>
                </div>
              );
            })}
          </div>
        ) : (
          // 宽屏：表格在视口区内部纵向滚；长表仍由 tabpane 整页滚动（现状不变）。
          <div style={{ flex: 1, minHeight: 0, minWidth: 0, overflowY: "visible" }}>
          <antd.Table
            rowKey={(r: WorkflowEvent) => r.runId}
            size="small"
            pagination={false}
            dataSource={sortedEvents}
            rowClassName={(ev: WorkflowEvent) =>
              ev.runId === highlightRunId ? "atw-highlight-row" : ""
            }
            onRow={(ev: WorkflowEvent) => ({
              "data-run-id": ev.runId,
              style:
                ev.runId === highlightRunId
 ? { outline: "2px solid var(--app-accent, #FF7F16)", outlineOffset: -2, borderRadius: 6 }
                  : undefined,
            })}
            columns={[
              {
                title: tr("任务"),
                dataIndex: "title",
                render: (_: unknown, ev: WorkflowEvent) => <b>{ev.title || ev.runId}</b>,
              },
              {
                title: tr("状态"),
                dataIndex: "status",
                width: 110,
                render: (v: string) => (
                  <antd.Tag color={statusMeta(v).color} style={{ margin: 0 }}>
                    {statusMeta(v).label}
                  </antd.Tag>
                ),
              },
              {
                title: tr("协调者"),
                dataIndex: "coordinator",
                width: 130,
 // 协调者为原始
                // matrix ID（未富化名字）时长 ID 换行撑高行（40→61px）
                // → 首屏底缘半裁行视觉「双影/糊」。ellipsis 截断 +
                // antd 自动 title 悬停见全文（不丢信息）。
                ellipsis: true,
                render: (v: string) => (v || "").split(":")[0].replace(/^@/, ""),
              },
              {
                title: tr("步骤"),
                dataIndex: "steps",
                width: 90,
                render: (v: unknown[]) => (v || []).length,
              },
              {
                title: tr("来源房间"),
                dataIndex: "room_name",
                width: 150,
                ellipsis: true,
                // 房间名未富化（用户未加入该房间）时回退显示 room_id，
                // 与 dashboard tasks 栏 shortId(roomId) 行为对齐。
                render: (v: string, ev: WorkflowEvent) => v || ev.room_id || "",
              },
              {
                title: tr("时间"),
                dataIndex: "ts",
                width: 120,
                render: (v: number) => fmtTime(v),
              },
              {
                title: tr("操作"),
                key: "actions",
 // 3 个操作按钮
                // （暂停/完成/重规划 ≈205px）在 150px 列内换行 → 行高
                // 40/65px 混杂 → 首屏底缘半裁行两行按钮各切一半，
                // 视觉「双影/糊」（DOM 实证无 transform/克隆/opacity，
                // 非渲染层双影）。加宽 + nowrap 单行 → 行高统一 40px。
                width: 225,
                render: (_: unknown, ev: WorkflowEvent) => (
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "nowrap",
                      gap: 4,
                      whiteSpace: "nowrap",
                    }}
                  >
                    <InterventionActions ev={ev} onDone={() => onRefresh?.()} />
                  </div>
                ),
              },
            ]}
          />
          </div>
        )
      ) : view === "card" ? (
        events.length === 0 ? (
          <antd.Empty description={tr("暂无工作流事件")} />
        ) : narrow ? (
          /* 窄屏单栏 drill-in：未选 = 项目列表（整宽，无拖拽分隔条）；
点项目 = 详情（整宽）+ 顶部返回条。高度=容器相对 flex 链：列表填满
剩余高纵向滚（compact 卡一屏 ≥5 张）；详情区占返回条以下剩余高、内部
滚（返回条固定不随内容滚走）。 */
          detailOpen ? (
            <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, gap: 10 }}>
              <NarrowDetailBack
                title={topoEvent ? topoEvent.title || topoEvent.runId : ""}
                onBack={() => setDetailOpen(false)}
              />
              <div style={{ flex: 1, minHeight: 0, overflowY: "auto", minWidth: 0 }}>{cardDetail}</div>
            </div>
          ) : (
            <ProjectRail
              fill
              events={sortedEvents}
              selected={topoEvent?.runId ?? ""}
              onSelect={(runId) => {
                setTopoRun(runId);
                setDetailOpen(true);
              }}
            />
          )
        ) : (
          /* master-detail：左=项目列表（排序/独立滚动），右=选中项目详情
 （EventCard + 任务卡网格）——对齐 dashboard 任务看板「项目」区。 */
          <div style={{ display: "grid", gridTemplateColumns: `${railW}px 6px minmax(0, 1fr)`, gridTemplateRows: "100%", gap: "12px 0", alignItems: "start", flex: 1, minHeight: 0 }}>
            <ProjectRail events={sortedEvents} selected={topoEvent?.runId ?? ""} onSelect={setTopoRun} />
            <div
              onMouseDown={startRailDrag}
              title={tr("拖动调整项目列表宽度")}
              style={{
                cursor: "col-resize",
                alignSelf: "stretch",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <div style={{ width: 3, height: "100%", background: t.border, borderRadius: 2 }} />
            </div>
            <div style={{ minWidth: 0, paddingLeft: 12 }}>{cardDetail}</div>
          </div>
        )
      ) : view === "board" ? (
        boardTaskCount === 0 ? (
          <antd.Empty
            description={
              emptyEventCount > 0
                ? tr("已有 {n} 个项目，但任务图（nodes）全空——多为 planning 状态：项目刚建、任务在群聊 @mention 协调，未登记进 Controller 的任务 DAG", { n: emptyEventCount })
                : tr("暂无看板数据——Agent 以 DAG 模式（workflow_run nodes）执行任务后这里会显示任务看板")
            }
          />
        ) : (
          // 窄屏：看板=单列纵向堆叠（见 BoardColumnsView），整块在视口区
          // 内部纵向滚、不外溢页面；宽屏：overflow visible，8 列自适应
          // 等高网格恰好铺满容器，滚动行为现状不变。
          <div style={{ flex: 1, minHeight: 0, minWidth: 0, overflowY: narrow ? "auto" : "visible" }}>
          <BoardColumnsView
            events={sortedEvents}
            t={t}
            onTaskDone={() => onRefresh?.()}
            onOpenDetail={(tid, rid) => setInspect({ runId: rid, taskId: tid })}
          />
          </div>
        )
      ) : narrow ? (
        /* 窄屏单栏 drill-in（同卡片视图）：项目列表（整宽）→ 点项目 →
 详情（整宽）+ 返回条；拖拽分隔条窄屏不出现。 */
        events.length === 0 ? (
          <antd.Empty description={tr("暂无工作流事件")} />
        ) : detailOpen ? (
          /* 高度=容器相对：返回条固定，详情盒占剩余高（flex:1+minHeight:0）
内部滚——旧 calc(100vh - 300px) 在宿主容器高≠视口高时外溢/过矮。 */
          <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, gap: 10 }}>
            {/* 返回钮在工具栏排序钮左侧——上方重复标题栏/NarrowDetailBack 已删省纵向空间。 */}
            <div
              style={{
                flex: 1,
                minHeight: 0,
                minWidth: 0,
                padding: 12,
                paddingTop: 4,
                borderRadius: 10,
                border: `1px solid ${t.border}`,
                boxSizing: "border-box",
                overflow: "auto",
              }}
            >
              {topoDetail}
            </div>
          </div>
        ) : (
          <ProjectRail
            fill
            events={sortedEvents}
            selected={topoEvent?.runId ?? ""}
            onSelect={(runId) => {
              setTopoRun(runId);
              setDetailOpen(true);
            }}
          />
        )
      ) : (
        /* master-detail：左=项目列表（含 planning 项目，诚实空态），右=
 依赖图（DagTopo 单一 DAG 视图，13.24 Mermaid 退役）+ 干预/中断/loop。 */
        <div style={{ display: "grid", gridTemplateColumns: `${railW}px 6px minmax(0, 1fr)`, gap: "12px 0", alignItems: "start" }}>
          <ProjectRail events={sortedEvents} selected={topoEvent?.runId ?? ""} onSelect={setTopoRun} />
          <div
            onMouseDown={startRailDrag}
            title={tr("拖动调整项目列表宽度")}
            style={{
              cursor: "col-resize",
              alignSelf: "stretch",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div style={{ width: 3, height: "100%", background: t.border, borderRadius: 2 }} />
          </div>
          <div
            style={{
              minWidth: 0,
              padding: 12,
              paddingLeft: 24,
              borderRadius: 10,
              border: `1px solid ${t.border}`,
              // 容器相对：maxHeight:100% 对栅格行（gridTemplateRows:100% =
              // 视口区高）解析；padding 由 border-box 吃掉，不撑爆。
              boxSizing: "border-box",
              maxHeight: "100%",
              overflow: "auto",
            }}
          >
            {topoDetail}
          </div>
        </div>
      )}
      </div>
      {/* #1230 任务巡检 Drawer（看板/卡片任务卡点击） */}
      <TaskInspectionDrawer
        ev={inspectEv}
        taskId={inspect?.taskId ?? null}
        onClose={() => setInspect(null)}
        onDone={() => onRefresh?.()}
      />
    </div>
  );
}

// 面板级 memo——父级（WorkbenchPage）重渲染
// 且 props 无变化时跳过（修复前全仓零 memo，切 tab 帧断 183-200ms）。
export default React.memo(WorkflowBoard);
