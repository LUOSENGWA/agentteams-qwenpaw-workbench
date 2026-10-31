// WorkflowBoard 巨石拆分 · 看板视图（第四视图）：看板卡（BoardCard）+ 看板容器
// （BoardColumnsView，三档布局 stacked/grid2/grid3——15.19 起 jira 横滚档
// 退役；15.20 宽屏 ≥950 改三列两行 grid3，中间宽度两列三行 grid2，
// 竖屏 <500 一列六行 stacked）。
// 横竖屏断点与 pointer 逻辑逐字搬移，行为零变。

import type { WorkflowEvent } from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { UserIcon, CloseIcon } from "../components/icons";
import { WbTooltip } from "../components/WbTooltip";
import { boardModeForWidth, type BoardMode } from "../boardMode";
import { useWbViewport } from "../WbViewportContext";
import {
  TERMINAL_NODE_STATUSES,
  nodeLabel,
  nodeLabelUi,
  BOARD_COLUMNS,
  boardTasksFromEvents,
  type BoardTask,
  type BoardCol,
} from "./helpers";
import { TaskCancelModal } from "./panels";
import { InterventionActions } from "./blocks";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

/** 看板任务卡：任务名 + 项目 + 负责人 + 依赖 badge + 非终态任务取消按钮。
 * 依赖不画跨列连线（与 dashboard 一致：看板列内 badge，依赖树走拓扑视图）。
 * 取消=任务级（tasks/{id}/cancel，reason 必填；终态任务 409 幂等收敛）。
 * 终态判定用上游归一化状态（completed/revision/blocked/cancelled 四态）。 */
export function BoardCard(props: {
  task: BoardTask;
  t: ReturnType<typeof useThemeColors>;
  onTaskDone?: () => void;
  /** #1230：卡标题点击 → 任务巡检 Drawer（runId 显式传——看板列跨项目混排）。 */
  onOpenDetail?: (taskId: string, runId: string) => void;
  /** P0 人工介入闭环：所属项目事件——paused / 有 interrupts 时项目名行
   * 挂事件级干预操作（暂停/恢复/完成/重规划），看板视图也可达。 */
  ev?: WorkflowEvent;
}) {
  const { task, t, onTaskDone, onOpenDetail, ev } = props;
  const tr = useT();
  const { node } = task;
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const assignee =
    (typeof node.subagent === "string" && node.subagent.trim()) ||
    (typeof node.assignee === "string" && (node.assignee as string).trim()) ||
    "";
  const deps = (node.dependsOn || []).filter(Boolean);
  const taskId = typeof node.id === "string" ? node.id.trim() : "";
  const canCancel =
    taskId !== "" &&
    !TERMINAL_NODE_STATUSES.includes(String(node.status || ""));

  return (
    <div
      style={{
        border: `1px solid ${t.border}`,
        borderRadius: 8,
        padding: "8px 10px",
        background: t.cardBg,
        display: "grid",
        gap: 4,
        minWidth: 0,
        // 15.14 根因：卡容器 overflow:hidden + display:grid → grid 项
        // min-height:auto 塌 0（CSS 规范：overflow≠visible 时 min-height
        // 自动尺寸归零）。真盘实证：Chromium 154 下 20 卡列每卡塌 18px
        // 细条（标题/项目名行 0 高，只剩 tag 行）= 真机「挤在一起」。
        // 去掉容器 overflow——标题/项目名各自的 clamp div 自带
        // overflow:hidden 限高，tag 行 flexWrap，无需容器再兜底；
        // 横向由 grid 单列 232px + minWidth:0 钳制，不会撑破。
        // flexShrink:0——看板卡区（flex column）内卡高恒=内容高。
        flexShrink: 0,
      }}
    >
      <div
        // 15.14：clamp 走全局标准类（.wb-clamp-2）；15.20 该类已补
        // -webkit-box 三件套真 clamp（旧版 block+max-height 半行泄漏已修）。
        // 标题=节点短名，两行封顶足够，全文走 title 悬停。
        className="wb-clamp-2"
        style={{
          fontWeight: 600,
          fontSize: 12.5,
          lineHeight: 1.3,
          color: t.text,
          cursor: taskId && onOpenDetail ? "pointer" : "default",
        }}
        // 15.14 命名约定：正文显示短名（nodeLabelUi，MXID→localpart），
        // 完整 MXID/原文走 title 悬停（nodeLabel 原值），不丢信息。
        title={
          taskId && onOpenDetail
            ? `${nodeLabel(node)}（点击巡检：明细/依赖/状态转换/tracing）`
            : nodeLabel(node)
        }
        onClick={
          taskId && onOpenDetail ? () => onOpenDetail(taskId, task.runId) : undefined
        }
      >
        {nodeLabelUi(node)}
      </div>
      <div
        // 15.20：项目名全文展示（原 wb-clamp-2 两行封顶=「卡片被纵向
        // 压缩遮挡」主诉）——卡高随内容动态长，列卡区限高+列内纵滚兜底；
        // 列宽变化时行尾自然回折。
        // P0 人工介入闭环：paused / 有 interrupts 的项目，项目名行右挂
        // 事件级干预操作（同拓扑详情，任意视图可达）。
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 6,
          fontSize: 11.5,
          color: t.textSecondary,
          whiteSpace: "normal",
          wordBreak: "break-word",
          lineHeight: 1.3,
        }}
      >
        <span
          style={{ flex: "1 1 auto", minWidth: 0 }}
          title={task.projectTitle}
        >
          {task.projectTitle}
        </span>
        {ev &&
        (ev.status === "paused" || (ev.interrupts || []).length > 0) ? (
          <span
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 4,
              justifyContent: "flex-end",
              flex: "0 1 auto",
              minWidth: 0,
            }}
          >
            <InterventionActions ev={ev} onDone={onTaskDone} />
          </span>
        ) : null}
      </div>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", minWidth: 0 }}>
        {assignee ? (
          /* worker 名允许换行/断词（下划线长名无断点）——不撑破卡片容器。 */
          <antd.Tag
            style={{
              margin: 0,
              fontSize: 10.5,
              maxWidth: "100%",
              whiteSpace: "normal",
              wordBreak: "break-word",
            }}
          >
            <UserIcon size={11} style={{ verticalAlign: "-1px", marginRight: 2 }} /> {assignee.split(":")[0].replace(/^@/, "")}
          </antd.Tag>
        ) : null}
        {deps.length > 0 ? (
          <antd.Tag
            color="geekblue"
            style={{ margin: 0, fontSize: 10.5 }}
            title={deps.join(", ")}
          >
            {tr("依赖 {n} 项", { n: deps.length })}
          </antd.Tag>
        ) : null}
        {canCancel ? (
          <WbTooltip title={tr("取消此任务（须填原因，不可恢复）")}>
            <antd.Button
              size="small"
              type="text"
              danger
              style={{ marginLeft: "auto", padding: "0 4px", height: 20 }}
              onClick={() => setCancelOpen(true)}
            >
              <CloseIcon size={12} />
            </antd.Button>
          </WbTooltip>
        ) : null}
      </div>
      <TaskCancelModal
        open={cancelOpen}
        title={nodeLabel(node)}
        runId={task.runId}
        taskId={taskId}
        onClose={() => setCancelOpen(false)}
        onDone={onTaskDone}
      />
    </div>
  );
}

// 15.15 布局模式（横屏回归修复）：判定收敛进纯模块 boardMode.ts
// （断点回归护栏——横屏被搞烂的根因是断点误判：横屏手机 667px 曾因 <800
// 恒 narrow 落进竖屏堆叠）。15.20 起三档：stacked=竖屏堆叠一列六行
// （<500）、grid2=两列三行（500–949，横屏手机/平板/中间宽度）、
// grid3=三列两行（≥950 桌面宽屏——15.19 曾把宽屏并入 grid2，15.20 按
// 定案宽屏要三列两行：列更宽、卡文字行数更少）。jira 250px 横滚档自
// 15.19 退役，不再恢复。
export function BoardColumnsView(props: {
  events: WorkflowEvent[];
  t: ReturnType<typeof useThemeColors>;
  onTaskDone?: () => void;
  onOpenDetail?: (taskId: string, runId: string) => void;
}) {
  const { events, t, onTaskDone, onOpenDetail } = props;
  const tr = useT();
  // WbViewport 容器宽快照（翻转时刻值）——仅作 mode 初值；正源=wrapRef
  // 实测宽（手机旋转 376↔667 不触发 narrow 翻转，快照会过期）。
  const { width: vw } = useWbViewport();
  // P0 人工介入闭环：runId → 项目事件（看板列跨项目混排，卡按项目
  // 找回上下文——paused/interrupts 门控与干预操作都用它）。
  const evByRunId = React.useMemo(() => {
    const m = new Map<string, WorkflowEvent>();
    for (const e of events) m.set(e.runId, e);
    return m;
  }, [events]);
  // 列内时间序：按 (项目 ts 新→旧, 原节点序) 稳定排序。
  const tasksByCol = React.useMemo(() => {
    const tsOf = new Map(events.map((e) => [e.runId, e.ts || 0]));
    const m = new Map<BoardCol, BoardTask[]>();
    for (const col of BOARD_COLUMNS) m.set(col.key, []);
    boardTasksFromEvents(events).forEach((tk, idx) => {
      m.get(tk.col)?.push(tk);
      tk.__seq = idx; // 原节点序（同项目内保序）
    });
    for (const list of m.values()) {
      list.sort(
        (a, b) =>
          (tsOf.get(b.runId) || 0) - (tsOf.get(a.runId) || 0) ||
          (a.__seq || 0) - (b.__seq || 0),
      );
    }
    return m;
  }, [events]);

  // 布局容器（RO 实测宽正源）。15.19 起列高等高测量退役（仅 jira 档消费，
  // jira 已退）——grid2 列高=内容高（卡区限高 min(40vh,320px) 内滚）。
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  // 布局模式：初值取 WbViewport 快照，RO 回调按实测宽纠偏（0 宽早退防误翻）。
  const [mode, setMode] = React.useState<BoardMode>(() =>
    boardModeForWidth(vw),
  );
  React.useEffect(() => {
    const compute = () => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      // keep-alive 隐藏 tab（0 宽）不测量——RO 会在再次可见（0→N 尺寸
      // 变化）时重触发，届时拿到正确布局。
      if (rect.width <= 0) return;
      // 模式随实测宽切换（正源；旋转不触发 narrow 翻转，快照会过期）。
      const m = boardModeForWidth(rect.width);
      setMode((prev) => (prev === m ? prev : m));
    };
    compute();
    window.addEventListener("resize", compute);
    let ro: ResizeObserver | null = null;
    try {
      if (typeof ResizeObserver !== "undefined" && wrapRef.current) {
        ro = new ResizeObserver(() => compute());
        ro.observe(wrapRef.current);
      }
    } catch {
      /* 环境无 ResizeObserver：仅 resize 监听兜底 */
    }
    return () => {
      window.removeEventListener("resize", compute);
      ro?.disconnect();
    };
  }, []);

  // ── 三布局（15.15 横屏回归修复；15.19 退 jira 档；15.20 宽屏 grid3）──
  // 按实测容器宽 W 分流（初值=WbViewport 快照，RO 回调纠偏：手机旋转
  // 376↔667 不触发 narrow 翻转，快照会过期，实测宽是唯一正源）：
  // stacked（W<500，竖屏手机 376）：状态列纵向堆叠全宽 + 列内 165px 卡行
  //   横滚 + snap（15.11 移动看板布局，竖屏验过，不动）；
  // grid2（500≤W<950，横屏手机 667 / 平板 / 中间宽度）：两列定宽网格
  //   minmax(0,1fr)（列=容器半宽，永不压缩、不横滑）+ 每列卡区限高
  //   min(40vh,320px)≈3 卡、超出列内纵向滚（=3c93a10「看板 2 列 3 卡滚」）；
  // grid3（W≥950，桌面宽屏）：三列定宽网格 repeat(3,minmax(0,1fr))
  //   （列=容器 1/3 宽）+ 每列卡区限高 min(30vh,260px)≈2 卡、超出列内
  //   纵向滚（15.20「宽屏三列两行」定案）。
  const wrapperStyle: React.CSSProperties =
    mode === "grid3"
      ? {
          display: "grid",
          gridTemplateColumns:
            "minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)",
          gap: 8,
          minWidth: 0,
        }
      : mode === "grid2"
        ? {
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
            gap: 8,
            minWidth: 0,
          }
        : { display: "grid", gap: 8, minWidth: 0 };

  return (
    <div ref={wrapRef} style={wrapperStyle}>
      {BOARD_COLUMNS.map((col) => {
        const colTasks = tasksByCol.get(col.key) || [];
        return (
          <div
            key={col.key}
            style={{
              border: `1px solid ${t.border}`,
              borderRadius: 10,
              background: t.cardBg,
              padding: 8,
              boxSizing: "border-box",
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontWeight: 700,
                fontSize: 12.5,
                color: col.color,
                flexShrink: 0,
                marginBottom: colTasks.length > 0 ? 8 : 0,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: col.color,
                  flexShrink: 0,
                }}
              />
              {tr(col.zh)}（{colTasks.length}）
            </div>
            {colTasks.length === 0 ? null : mode === "stacked" ? (
              // 堆叠卡行：固定卡宽 165px（~2 张半可见=滚动暗示），
              // snap 对齐（proximity=轻扫不锁死，与原生列表手感一致）。
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  minWidth: 0,
                  overflowX: "auto",
                  overflowY: "hidden",
                  paddingBottom: 2,
                  scrollSnapType: "x proximity",
                }}
              >
                {colTasks.map((task) => (
                  <div
                    key={`${task.runId}-${String(task.node.id || nodeLabel(task.node))}`}
                    style={{
                      flex: "0 0 165px",
                      width: 165,
                      minWidth: 0,
                      scrollSnapAlign: "start",
                    }}
                  >
                    <BoardCard
                      task={task}
                      t={t}
                      onTaskDone={onTaskDone}
                      onOpenDetail={
                        onOpenDetail
                          ? (tid) => onOpenDetail(tid, task.runId)
                          : undefined
                      }
                      ev={evByRunId.get(task.runId)}
                    />
                  </div>
                ))}
              </div>
            ) : (
              // grid2/grid3 卡区：限高 ~3 卡（grid2 min(40vh,320px)）或
              // ~2 卡（grid3 min(30vh,260px)），超出列内纵向滚。卡高=
              // 内容高（flexShrink:0 + 项目名 15.20 起全文展示，卡随内容
              // 动态长），列限高只控「一屏几卡」，不再压卡。
              <div
                style={{
                  display: "grid",
                  gap: 8,
                  minWidth: 0,
                  maxHeight:
                    mode === "grid3" ? "min(30vh, 260px)" : "min(40vh, 320px)",
                  overflowY: "auto",
                  overflowX: "hidden",
                }}
              >
                {colTasks.map((task) => (
                  <BoardCard
                    key={`${task.runId}-${String(task.node.id || nodeLabel(task.node))}`}
                    task={task}
                    t={t}
                    onTaskDone={onTaskDone}
                    onOpenDetail={
                      onOpenDetail
                        ? (tid) => onOpenDetail(tid, task.runId)
                        : undefined
                    }
                    ev={evByRunId.get(task.runId)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
