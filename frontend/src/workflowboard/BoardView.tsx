// WorkflowBoard 巨石拆分 · 看板视图（第四视图）：看板卡（BoardCard）+ 看板容器
// （BoardColumnsView，三档布局 stacked/grid2/jira + 列高实测）。
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
  BOARD_CARD_CAP_PX,
  type BoardTask,
  type BoardCol,
} from "./helpers";
import { TaskCancelModal } from "./panels";

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
}) {
  const { task, t, onTaskDone, onOpenDetail } = props;
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
        // 15.14：clamp 走全局标准类（.wb-clamp-2，block+max-height，
        // 跨 Chromium 版本安全）——内联 -webkit-box 在 Chromium 154
        // 计算为 flow-root（盒模型损坏）是细条塌缩的另一半根因。
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
        className="wb-clamp-2"
        style={{
          fontSize: 11.5,
          color: t.textSecondary,
          // 窄屏项目名换行（2 行封顶，不 ellipsis 截断）。
          whiteSpace: "normal",
          lineHeight: 1.3,
        }}
        title={task.projectTitle}
      >
        {task.projectTitle}
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

// 15.15 三档布局模式（横屏回归修复）：判定收敛进纯模块 boardMode.ts
// （断点回归护栏——本次横屏被搞烂的根因就是断点误判：横屏手机 667px 曾
// 因 <800 恒 narrow 落进竖屏堆叠）。stacked=竖屏堆叠、grid2=两列定宽+3 卡
// 限高滚（横屏）、jira=250px 横滚（桌面）；按实测容器宽 500/950 断点。
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

  // （13.15 「每个看板要等高 + 随屏幕高度动态调整」）：列高由
  // 容器可用高实测推导（约束底 − 看板顶）。
  // 横屏/中间宽度（800-950，手机横屏常落此带）旧 4×2 网格每列仅
  // ~190px → 卡挤成竖条。改 **Jira/Trello 标准看板**：列固定 250px +
  // 看板横向滚动 + 列等高（=可用高）+ 列内卡区纵向滚——所有宽度同一布局，
  // 列永不压缩，宽度不足时横向滑（移动端看板通用交互）。
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const [colH, setColH] = React.useState<number>(BOARD_CARD_CAP_PX);
  // 15.15 布局模式：初值取快照，RO 回调按实测宽纠偏（0 宽早退防误翻）。
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
      // // 可用高 = 约束底 − 看板顶，**全部实测**（旧版用 innerHeight-240 估算
      // 页面头高，系统性偏大 → 列高超出容器 → 整页滚动）。
      // 约束底 = 最近的可滚动祖先容器底（无则视口底）。
      let bottom =
        (typeof window !== "undefined" ? window.innerHeight : 900) - 12;
      let anc: HTMLElement | null = wrap.parentElement;
      while (anc && anc !== document.body) {
        const ov = window.getComputedStyle(anc).overflowY;
        if ((ov === "auto" || ov === "scroll") && anc.clientHeight > 0) {
          bottom = anc.getBoundingClientRect().bottom - 6;
          break;
        }
        anc = anc.parentElement;
      }
      // 看板顶（视口坐标；夹 ≥64 防容器已内滚时的负值放大估算——新显 tab
      // 时容器 scrollTop=0，测量即准）。
      const top = Math.max(64, rect.top);
      const avail = Math.max(320, bottom - top);
      setColH((prev) => (prev === avail ? prev : avail));
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

﻿  // ── 三布局（15.15 横屏回归修复）──────────────────────────────────
  // 按实测容器宽 W 分流（初值=WbViewport 快照，RO 回调纠偏：手机旋转
  // 376↔667 不触发 narrow 翻转，快照会过期，实测宽是唯一正源）：
  // stacked（W<500，竖屏手机 376）：状态列纵向堆叠全宽 + 列内 165px 卡行
  //   横滚 + snap（15.11 移动看板布局，竖屏验过，不动）；
  // grid2（500≤W<950，横屏手机 667 / 平板竖屏 / 中间宽度）：两列定宽网格
  //   minmax(0,1fr)（列=容器半宽，永不压缩、不横滑）+ 每列卡区限高
  //   min(40vh,320px)≈3 卡、超出列内纵向滚（=恢复 3c93a10「看板 2 列 3
  //   卡滚」）。15.13 曾把 ≥800 一律改 Jira 250px 横滚，但横屏手机
  //   667<800 恒 narrow → 被卷进竖屏堆叠布局 = 本次「横屏被搞烂」根因；
  // jira（W≥950，桌面宽屏）：8 列固定 250px 横滚 + 列等高（实测可用高）
  //   + 卡区列内纵滚（15.13 起，桌面验过，不动）。
  const wrapperStyle: React.CSSProperties =
    mode === "jira"
      ? {
          display: "flex",
          gap: 10,
          minWidth: 0,
          overflowX: "auto",
          overflowY: "hidden",
          paddingBottom: 4,
          scrollSnapType: "x proximity",
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
            style={
              mode === "jira"
                ? {
                    flex: "0 0 250px",
                    width: 250,
                    height: colH,
                    boxSizing: "border-box",
                    border: `1px solid ${t.border}`,
                    borderRadius: 10,
                    background: t.cardBg,
                    padding: 8,
                    minWidth: 0,
                    display: "flex",
                    flexDirection: "column",
                    scrollSnapAlign: "start",
                  }
                : {
                    border: `1px solid ${t.border}`,
                    borderRadius: 10,
                    background: t.cardBg,
                    padding: 8,
                    boxSizing: "border-box",
                    minWidth: 0,
                    display: "flex",
                    flexDirection: "column",
                  }
            }
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
                    />
                  </div>
                ))}
              </div>
            ) : mode === "grid2" ? (
              // grid2 卡区：限高 ~3 卡（min(40vh,320px)），超出列内纵向滚
              // （3c93a10「2 列 3 卡滚」机制原样恢复）。
              <div
                style={{
                  display: "grid",
                  gap: 8,
                  minWidth: 0,
                  maxHeight: "min(40vh, 320px)",
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
                  />
                ))}
              </div>
            ) : (
              // jira 卡区 = 列高 − 头行（flex:1 + min-0），超出列内纵滚。
              // 15.14：grid→flex column——grid 定高容器在「卡片数 × 卡高
              // > 容器高」时 auto 行参与收缩（行塌 18px 细条，20 卡列
              // 实证）；flex 子项恒不缩，卡高=内容高，列滚动，免疫。
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  flex: 1,
                  minHeight: 0,
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
