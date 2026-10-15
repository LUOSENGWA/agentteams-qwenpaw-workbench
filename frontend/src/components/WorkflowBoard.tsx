import { UserIcon, CloseIcon, PauseIcon, PlayIcon, CheckIcon, TodoIcon, RefreshIcon, HistoryIcon, WarnIcon, ChartIcon, AppIcon } from "./icons";
import type * as ReactNS from "react";

import {
  type WorkflowEvent,
  type WorkflowNode,
  type WorkflowInterrupt,
  type TaskDetail,
  pauseProject,
  resumeProject,
  cancelTask,
  completeProject,
  replanProject,
  fetchProjectHistory,
  fetchProjectHistorySnapshot,
  fetchWorkflowProjects,
} from "../api";
import ArtifactLines from "./ArtifactLines";
import { useThemeColors, type ThemeColors } from "../theme";
import { useT } from "../i18n";
import {
  WorkflowDagSvg,
  buildWorkflowDag,
  type DagNodeColor,
} from "./WorkflowDag";
import { WorkflowEventsTimeline } from "./WorkflowEventsTimeline";
import { TopologyIcon } from "./icons";
import { WbTooltip } from "./WbTooltip";
import { boardModeForWidth, type BoardMode } from "../boardMode";
import { useWbViewport } from "../WbViewportContext";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
const icons = (host.antdIcons || {}) as Record<string, ReactNS.ComponentType>;
const EmptyIcon = (() => null) as unknown as ReactNS.FC<Record<string, unknown>>;
const pick = (name: string): ReactNS.FC<Record<string, unknown>> =>
  (icons[name] as ReactNS.FC<Record<string, unknown>>) || EmptyIcon;
const ReloadIcon = pick("ReloadOutlined");

const PRIMARY = "var(--app-accent, #FF7F16)";
const STATUS_COLOR: Record<string, string> = {
  running: "#1677ff",
  in_progress: "#1677ff",
  "in-progress": "#1677ff",
  completed: "#52c41a",
  done: "#52c41a",
  failed: "#ff4d4f",
  error: "#ff4d4f",
  blocked: "#fa8c16",
 // （报告顺带缺陷：cancelled 显示成
  // blocked）：cancelled 独立态——深红 #cf1322（与 failed #ff4d4f 区分：
  // 失败=执行出错，取消=人为终止，语义不同不同色）。
  cancelled: "#cf1322",
  canceled: "#cf1322",
  pending: "#999",
  merging: "#722ed1",
  created: "#999",
};
// 状态中文标签（cancelled→已取消；其余原样）。
const STATUS_LABEL: Record<string, string> = {
  cancelled: "已取消",
  canceled: "已取消",
};

function statusMeta(status: string): { label: string; color: string } {
  const s = status || "";
  return {
    label: STATUS_LABEL[s] || s || "?",
    color: STATUS_COLOR[s] || "#999",
  };
}

function fmtTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

/** DAG 节点配色（主题感知；stroke 与 STATUS_COLOR 同源——看板/DAG 一致）。 */
function dagNodeColors(t: ThemeColors): Record<string, DagNodeColor> {
  return {
    pending: { fill: "rgba(153,153,153,0.12)", stroke: "#999", text: t.text },
    assigned: { fill: "rgba(22,119,255,0.10)", stroke: "#1677ff", text: t.text },
    in_progress: { fill: "rgba(114,46,209,0.10)", stroke: "#722ed1", text: t.text },
    revision: { fill: "rgba(250,140,22,0.10)", stroke: "#fa8c16", text: t.text },
    completed: { fill: "rgba(82,196,26,0.12)", stroke: "#52c41a", text: t.text },
    failed: { fill: "rgba(255,77,79,0.12)", stroke: "#ff4d4f", text: t.text },
    blocked: { fill: "rgba(250,140,22,0.10)", stroke: "#fa8c16", text: t.text },
    // cancelled 独立节点色（深红，与 failed 区分）。
    cancelled: { fill: "rgba(207,19,34,0.10)", stroke: "#cf1322", text: t.text },
    unknown: { fill: "rgba(140,140,140,0.08)", stroke: "#8c8c8c", text: t.text },
  };
}

/** 左栏项目列表（卡片/拓扑视图共用选择；排序=顶部下拉，独立滚动——
 * 对齐 dashboard 任务看板「项目」区 master-detail 结构）。 */
function ProjectRail(props: {
  events: WorkflowEvent[];
  selected: string;
  onSelect: (runId: string) => void;
  /** fill=撑满父级可用高（flex:1+minHeight:0，窄屏 drill-in 整高列表用）；
   * 默认（宽屏 master-detail）限高=容器高（百分比对栅格行解析）。
   * 高度一律容器相对，禁 100vh（宿主为可拖拽容器，100vh≠容器高）。 */
  fill?: boolean;
}) {
  const t = useThemeColors();
  const tr = useT();
  const { events, selected, onSelect, fill } = props;
  if (events.length === 0) return null;
  return (
    <div
      style={{
        border: `1px solid ${t.border}`,
        borderRadius: 8,
        background: t.cardBg,
        boxSizing: "border-box",
        ...(fill ? { flex: 1, minHeight: 0 } : { maxHeight: "100%" }),
        overflowY: "auto",
      }}
    >
      {events.map((ev) => {
        const active = ev.runId === selected;
        const meta = statusMeta(ev.status);
        const n = (ev.nodes ?? []).length;
        return (
          <div
            key={ev.runId}
            onClick={() => onSelect(ev.runId)}
            style={{
              cursor: "pointer",
              // compact 单卡（≈40px ≤ 48px）：标题 1 行 + 元信息 1 行，
              // drill-in 列表一屏 ≥5 卡。
              padding: "4px 12px",
              borderBottom: `1px solid ${t.border}`,
              borderLeft: active ? `3px solid ${meta.color}` : "3px solid transparent",
              background: active ? `${meta.color}14` : undefined,
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                lineHeight: 1.25,
                color: t.text,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {ev.title}
            </div>
            <div
              style={{
                marginTop: 2,
                display: "flex",
                gap: 6,
                alignItems: "center",
                fontSize: 11,
                lineHeight: 1.25,
                whiteSpace: "nowrap",
                color: t.textSecondary,
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: meta.color,
                  display: "inline-block",
                  flexShrink: 0,
                }}
              />
              <span>{tr(meta.label)}</span>
              <span>·</span>
              <span>
                {n} {tr("任务")}
              </span>
              {ev.ts ? (
                <span style={{ marginLeft: "auto", flexShrink: 0 }}>
                  {fmtTime(ev.ts)}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 窄屏单栏 drill-in：详情顶部返回条（← 返回 + 项目标题）——
 * 与聊天房间紧凑头「← 返回」同一交互心智（列表 → 点进详情 → 返回列表）。 */
function NarrowDetailBack(props: { title: string; onBack: () => void }) {
  const tr = useT();
  return (
    // flexShrink:0——drill-in 详情为纵向 flex 链，返回条恒占自身高（不被详情区挤压）。
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flexShrink: 0 }}>
      <antd.Button size="small" onClick={props.onBack} style={{ flexShrink: 0 }}>
        ← {tr("返回")}
      </antd.Button>
      <span
        title={props.title}
        style={{
          flex: 1,
          minWidth: 0,
          fontWeight: 700,
          fontSize: 14,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {props.title}
      </span>
    </div>
  );
}

/** 拓扑主体：分层 DAG（buildWorkflowDag → WorkflowDagSvg，dashboard
 * 同源算法）+ 外部依赖注记 + ready 图例。
 * * ① 统计条（N 任务·M 依赖·K 外部依赖——dashboard ProjectDagView 同款）
 * ② 缩放工具条（- / 百分比 / + / 复位）——宽图不裁切、细节可读
 * ③ 节点带 subagent 执行者行 + 点击 → 任务巡检 Drawer。 */
// （·「DAG 和 mermaid 没必要分两个，只需优化
// 这个图」）：Mermaid 视图整体退役——两图同结构（mermaid=上游
// ?format=mermaid 快照，非交互：节点点击降级提示），自绘 DAG 保交互
// （节点点看任务）且内联依赖撤除后主包 −5.1MB。图本身优化见
// WorkflowDag.tsx（层行居中/hover 高亮/节点尺寸）。
function DagTopo(props: {
  ev: WorkflowEvent;
  t: ThemeColors;
  onNodeClick?: (nodeId: string) => void;
}) {
  const { ev, t, onNodeClick } = props;
  const tr = useT();
  const dag = React.useMemo(() => buildWorkflowDag(ev.nodes ?? []), [ev]);
  const colors = dagNodeColors(t);
  // 缩放（0.4–2.0；1 = 原始尺寸）+ 平移 panX/panY。
  // 按钮 0.2 步进（0.1 取整）；触屏捏合在同区间内连续。
  const [zoom, setZoom] = React.useState(1);
  const [panX, setPanX] = React.useState(0);
  const [panY, setPanY] = React.useState(0);
  const clampZoom = (z: number) => Math.min(2, Math.max(0.4, z));
  const stepZoom = (z: number, d: number) => {
    userZoomedRef.current = true;
    return clampZoom(Math.round((z + d) * 10) / 10);
  };
  const { narrow } = useWbViewport();
  // 窄屏 auto-fit（列宽受容器约束，容器=屏幕宽）：DAG 布局宽（列×200px 节点）
  // 远超 376px 容器 → 初始 zoom 自动缩到整图宽=容器宽（捏合可放大细看）；
  // 用户手动缩放后不覆盖。宽屏恒 1（现状不变）。
  const graphRef = React.useRef<HTMLDivElement | null>(null);
  const [contentSize, setContentSize] = React.useState<{ w: number; h: number } | null>(null);
  const [graphW, setGraphW] = React.useState(0);
  const userZoomedRef = React.useRef(false);
  const handleContentSize = React.useCallback((w: number, h: number) => {
    setContentSize({ w, h });
  }, []);
  React.useEffect(() => {
    const el = graphRef.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => {
      for (const e of es) setGraphW(e.contentRect.width);
    });
    ro.observe(el);
    setGraphW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  React.useEffect(() => {
    if (!narrow || !contentSize || userZoomedRef.current) return;
    const avail = graphW - 20; // contentRect=content box：只扣 padding 10×2
    if (avail <= 0 || contentSize.w <= 0) return;
    const fit = Math.min(1, avail / contentSize.w);
    setZoom(fit);
    setPanX(0);
    setPanY(0);
  }, [narrow, contentSize, graphW]);
  // 触屏手势（pinch-zoom / pan）：Pointer Events 统一 touch+mouse；
  // 基线存 ref，每帧从手势起点绝对计算（不累加 delta，无漂移）。
  const pointersRef = React.useRef<Map<number, { x: number; y: number }>>(new Map());
  const gestureRef = React.useRef<{
    mode: "idle" | "pan" | "pinch";
    panId: number;
    startPanX: number;
    startPanY: number;
    originX: number;
    originY: number;
    startDist: number;
    startZoom: number;
    lastPanX: number;
    lastPanY: number;
  }>({ mode: "idle", panId: -1, startPanX: 0, startPanY: 0, originX: 0, originY: 0, startDist: 0, startZoom: 1, lastPanX: 0, lastPanY: 0 });
  const graphLocalPt = (e: ReactNS.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onGraphPointerDown = (e: ReactNS.PointerEvent<HTMLDivElement>) => {
    const pts = pointersRef.current;
    if (pts.size >= 5) pts.clear();
    const p = graphLocalPt(e);
    pts.set(e.pointerId, p);
    const g = gestureRef.current;
    if (pts.size === 1) {
      // 单指：移动超阈值才接管为 pan——轻点/点击（节点 → 任务巡检）原样穿透。
      g.mode = "idle";
      g.originX = p.x;
      g.originY = p.y;
    } else if (pts.size === 2 && g.mode !== "pinch") {
      // 双指：pinch-zoom（距离比 → zoom）。
      userZoomedRef.current = true; // 手动缩放 → auto-fit 不再覆盖
      const [a, b] = [...pts.entries()];
      g.mode = "pinch";
      g.startDist = Math.max(8, Math.hypot(b[1].x - a[1].x, b[1].y - a[1].y));
      g.startZoom = zoom;
      g.startPanX = panX;
      g.startPanY = panY;
      g.lastPanX = panX;
      g.lastPanY = panY;
      for (const [id] of pts) {
        try {
          e.currentTarget.setPointerCapture(id);
        } catch {
          /* 捕获失败不影响手势计算 */
        }
      }
    }
  };
  const onGraphPointerMove = (e: ReactNS.PointerEvent<HTMLDivElement>) => {
    const pts = pointersRef.current;
    if (!pts.has(e.pointerId)) return;
    const p = graphLocalPt(e);
    pts.set(e.pointerId, p);
    const g = gestureRef.current;
    if (g.mode === "pinch") {
      if (pts.size < 2) return;
      const [a, b] = [...pts.entries()];
      const dist = Math.hypot(b[1].x - a[1].x, b[1].y - a[1].y);
      const midX = (a[1].x + b[1].x) / 2;
      const midY = (a[1].y + b[1].y) / 2;
      const newZoom = clampZoom(g.startZoom * (dist / g.startDist));
      // 双指中点保持不动：screen = content×zoom + pan → pan′ = mid − (mid − pan₀)×(zoom′/zoom₀)
      const k = newZoom / g.startZoom;
      const newPanX = midX - (midX - g.startPanX) * k;
      const newPanY = midY - (midY - g.startPanY) * k;
      g.lastPanX = newPanX;
      g.lastPanY = newPanY;
      setZoom(newZoom);
      setPanX(newPanX);
      setPanY(newPanY);
      return;
    }
    if (g.mode === "idle" && pts.size === 1) {
      if (Math.hypot(p.x - g.originX, p.y - g.originY) > 4) {
        g.mode = "pan";
        g.panId = e.pointerId;
        g.startPanX = panX;
        g.startPanY = panY;
        g.originX = p.x;
        g.originY = p.y;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* 捕获失败不影响手势计算 */
        }
        e.currentTarget.style.cursor = "grabbing";
      }
    }
    if (g.mode === "pan" && e.pointerId === g.panId) {
      setPanX(g.startPanX + (p.x - g.originX));
      setPanY(g.startPanY + (p.y - g.originY));
    }
  };
  const endGraphPointer = (e: ReactNS.PointerEvent<HTMLDivElement>) => {
    const pts = pointersRef.current;
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    const g = gestureRef.current;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* 未捕获则忽略 */
    }
    if (g.mode === "pinch") {
      if (pts.size === 1) {
        // 剩一指：从当前 pan 继续拖动（该指针捏合时已捕获）。
        const [id, p] = [...pts.entries()][0];
        g.mode = "pan";
        g.panId = id;
        g.startPanX = g.lastPanX;
        g.startPanY = g.lastPanY;
        g.originX = p.x;
        g.originY = p.y;
        e.currentTarget.style.cursor = "grabbing";
      } else if (pts.size === 0) {
        g.mode = "idle";
        g.panId = -1;
        e.currentTarget.style.cursor = "grab";
      }
      return;
    }
    if (g.mode === "pan" && e.pointerId === g.panId) {
      g.mode = "idle";
      g.panId = -1;
      e.currentTarget.style.cursor = "grab";
    }
  };
  const onGraphPointerLeave = (e: ReactNS.PointerEvent<HTMLDivElement>) => {
    // 未捕获（超阈值前）的单指移出容器即清记录，避免陈旧指针干扰下一次手势。
    if (gestureRef.current.mode !== "idle") return;
    pointersRef.current.delete(e.pointerId);
  };
  // P2：任务分布 = 节点按 status 计数（dashboard NODE_STATUS 分布同语义）。
  const statuses = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const n of ev.nodes ?? []) {
      const st = n.status || "unknown";
      m.set(st, (m.get(st) ?? 0) + 1);
    }
    return [...m.entries()];
  }, [ev]);
  return (
    <div>
      {/* 统计条 + 缩放工具条（dashboard 同款统计；缩放为本插件改进）。 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          marginBottom: 8,
          fontSize: 11,
          color: t.textSecondary,
        }}
      >
        <span style={{ fontWeight: 600 }}>
          {tr("依赖图")}
        </span>
        <span>
          {dag.nodes.length} {tr("任务")} · {dag.edges.length}{" "}
          {tr("依赖")}
          {dag.externalDeps.length > 0 &&
            ` · ${dag.externalDeps.length} ${tr("外部依赖")}`}
        </span>
 {/* DAG/Mermaid 样式切换退役——两图同结构、
 Mermaid 非交互，保单一 DAG 视图（图本身优化见 WorkflowDag.tsx）。 */}
        <span style={{ flex: 1 }} />
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <button
            type="button"
            onClick={() => setZoom((z) => stepZoom(z, -0.2))}
            disabled={zoom <= 0.4}
            style={{
              width: 22,
              height: 22,
              border: `1px solid ${t.border}`,
              borderRadius: 5,
              background: t.cardBg,
              color: t.text,
              cursor: zoom <= 0.4 ? "not-allowed" : "pointer",
              fontSize: 13,
              lineHeight: 1,
            }}
            title={tr("缩小")}
          >
            −
          </button>
          <button
            type="button"
            onClick={() => {
              // 复位：窄屏=回到 auto-fit 缩放（整图宽=容器宽）；宽屏=zoom 归 1。pan 一并归零。
              userZoomedRef.current = false;
              if (narrow && contentSize && graphW > 0 && contentSize.w > 0) {
                setZoom(Math.min(1, Math.max(0.4, (graphW - 20) / contentSize.w)));
              } else {
                setZoom(1);
              }
              setPanX(0);
              setPanY(0);
            }}
            style={{
              height: 22,
              padding: "0 7px",
              border: `1px solid ${t.border}`,
              borderRadius: 5,
              background: t.cardBg,
              color: t.text,
              cursor: "pointer",
              fontSize: 11,
            }}
            title={tr("复位")}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            onClick={() => setZoom((z) => stepZoom(z, 0.2))}
            disabled={zoom >= 2}
            style={{
              width: 22,
              height: 22,
              border: `1px solid ${t.border}`,
              borderRadius: 5,
              background: t.cardBg,
              color: t.text,
              cursor: zoom >= 2 ? "not-allowed" : "pointer",
              fontSize: 13,
              lineHeight: 1,
            }}
            title={tr("放大")}
          >
            +
          </button>
        </span>
      </div>
      <div
        style={{
          position: "relative",
          overflow: "hidden",
          border: `1px solid ${t.border}`,
          borderRadius: 8,
          padding: 10,
          // 依赖图降高：窄屏再收窄（≤260px 且 ≤32vh）——之前 42vh 在桌面高视口下
          // =378px 挡住页面划动；封顶后下方节点卡更快可见，图内 pan/捏合看全貌。宽屏 56vh。
          maxHeight: narrow ? "min(32vh, 260px)" : "56vh",
          // 手势由本容器接管（双指捏合 / 单指拖动），不让浏览器默认滚动/缩放抢占。
          touchAction: "none",
          userSelect: "none",
          WebkitUserSelect: "none",
          cursor: "grab",
          // 容器宽=父级（项目详情）满宽——narrow 下即屏幕宽；
          // DAG 内容超宽由 auto-fit zoom 收纳，不横向溢出。
          width: "100%",
          maxWidth: "100%",
        }}
        ref={graphRef}
        onPointerDown={onGraphPointerDown}
        onPointerMove={onGraphPointerMove}
        onPointerUp={endGraphPointer}
        onPointerCancel={endGraphPointer}
        onPointerLeave={onGraphPointerLeave}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div
          style={{
            // 变换只挂这一层（GPU 合成层）；内层 SVG 保持原始尺寸，不逐帧重排。
            transform: `translate(${panX}px, ${panY}px) scale(${zoom})`,
            transformOrigin: "0 0",
            willChange: "transform",
          }}
        >
          <WorkflowDagSvg
            dag={dag}
            nodeColors={colors}
            scale={1}
            onNodeClick={onNodeClick}
            onContentSize={handleContentSize}
            title={`${ev.title} — ${tr("项目任务依赖图")}`}
          />
        </div>
      </div>
      {dag.externalDeps.length > 0 ? (
        <div style={{ marginTop: 8, fontSize: 11, color: t.textSecondary }}>
          {tr("外部依赖（非本项目）：{list}", {
            list: dag.externalDeps.join(", "),
          })}
        </div>
      ) : null}
      <div style={{ marginTop: 8, fontSize: 11, color: t.textSecondary }}>
        <span style={{ color: "#13c2c2" }}>◌</span>{" " + tr("依赖已满足（就绪，待开始）")}
      </div>
 {/* （P2）：拓扑详情区补 dashboard 任务详情页三区
 （任务分布 / 任务详情(N) / 节点(N)——projects-section
 WorkflowDetail 同语义；对齐要求：抄该
 实现，插件 antd 风格）。数据=ev.nodes / ev.taskDetails 既有
 通道，零新请求。 */}
      {statuses.length > 0 ? (
        <div style={{ marginTop: 10 }}>
          <p style={secTitleStyle(t)}>{tr("任务分布")}</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {statuses.map(([st, count]) => {
              const info = statusMeta(st);
              return (
                <antd.Tag
                  key={st}
                  style={{
                    margin: 0,
                    fontSize: 11,
                    borderColor: info.color,
                    color: info.color,
                    background: "transparent",
                  }}
                >
                  {info.label}: {count}
                </antd.Tag>
              );
            })}
          </div>
        </div>
      ) : null}
      {ev.taskDetails && ev.taskDetails.length > 0 ? (
        <div style={{ marginTop: 10 }}>
          <p style={secTitleStyle(t)}>
            {tr("任务详情（{n}）", { n: ev.taskDetails.length })}
          </p>
          <div style={{ display: "grid", gap: 6 }}>
            {ev.taskDetails.map((td) => (
              <TopoTaskDetailRow key={td.task_id} td={td} t={t} ev={ev} />
            ))}
          </div>
        </div>
      ) : null}
      <div style={{ marginTop: 10 }}>
        <p style={secTitleStyle(t)}>
          {tr("节点（{n}）", { n: (ev.nodes ?? []).length })}
        </p>
        {/* 窄屏单列全宽堆叠（双列在 <800 容器内每列 <340px，节点名+
状态 Tag 挤爆横向）；宽屏保持双列。 */}
        <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "1fr 1fr", gap: 6 }}>
          {(ev.nodes ?? []).map((n) => {
            const st = n.status || "";
            const info = statusMeta(st);
            return (
              <div
                key={n.id || nodeLabel(n)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  border: `1px solid ${t.border}`,
                  borderRadius: 6,
                  padding: "6px 8px",
                  background: t.bg,
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <p
                    style={{
                      margin: 0,
                      fontSize: 12,
                      fontWeight: 500,
                      // 窄屏换行：长名/长 id 的 min-content 撑爆 flex 行→横向拖动；
                      // 换行后节点卡顶满容器宽、超出文字自动换行。宽屏保持 ellipsis。
                      overflow: narrow ? "visible" : "hidden",
                      textOverflow: narrow ? "clip" : "ellipsis",
                      whiteSpace: narrow ? "normal" : "nowrap",
                      wordBreak: narrow ? "break-word" : undefined,
                    }}
                    // 15.14：正文短名（MXID→localpart），全名走 title 悬停。
                    title={nodeLabel(n)}
                  >
                    {nodeLabelUi(n)}
                  </p>
                  <p
                    style={{
                      margin: 0,
                      fontSize: 10,
                      fontFamily: "monospace",
                      color: t.textSecondary,
                      overflow: narrow ? "visible" : "hidden",
                      textOverflow: narrow ? "clip" : "ellipsis",
                      whiteSpace: narrow ? "normal" : "nowrap",
                      wordBreak: narrow ? "break-all" : undefined,
                    }}
                  >
                    {typeof n.id === "string" ? n.id : ""}
                  </p>
                </div>
                <antd.Tag
                  style={{
                    margin: 0,
                    fontSize: 10,
                    lineHeight: "16px",
                    borderColor: info.color,
                    color: info.color,
                    background: "transparent",
                    flexShrink: 0,
                  }}
                >
                  {info.label}
                </antd.Tag>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** P2：详情区 section 标题样式（三区统一）。 */
function secTitleStyle(t: ThemeColors): ReactNS.CSSProperties {
  return {
    margin: "0 0 6px",
    fontSize: 11,
    fontWeight: 600,
    color: t.textSecondary,
  };
}

/** P2：任务详情行（dashboard TaskDetailRow 语义精简版：任务名+状态+
 * 负责人，展开显 spec/摘要/产物数/转换审计条数——完整明细走既有
 * 任务巡检 Drawer，不重复造轮子）。 */
function TopoTaskDetailRow(props: {
  td: import("../api").TaskDetail;
  t: ThemeColors;
  /** 传 ev 供 ArtifactLines 构造产物 URL（此前缺
 runId 上下文 → 本行只有路径文本无查看/下载，结果产物没解决）。 */
  ev: WorkflowEvent;
}) {
  const { td, t, ev } = props;
  const tr = useT();
  const [open, setOpen] = React.useState(false);
  const info = statusMeta(td.status || "");
  const deliverablesList = (
    Array.isArray(td.deliverables) ? td.deliverables : []
  ).filter((d): d is string => typeof d === "string");
  const deliverables = deliverablesList.length;
  const histCount = Array.isArray(td.history) ? td.history.length : 0;
  return (
    <div
      style={{
        border: `1px solid ${t.border}`,
        borderRadius: 6,
        background: t.bg,
      }}
    >
      {/* 展开开关只挂头部行——整卡 onClick 会把展开区内
 按钮（ArtifactLines「查看/下载」）的点击也当切换，点「查看」即收起
 面板、预览 Modal 随组件卸载消失（点击查看却收回了菜单）。 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          cursor: "pointer",
        }}
        onClick={() => setOpen(!open)}
      >
        <span style={{ fontSize: 10, color: t.textSecondary }}>{open ? "▾" : "▸"}</span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            fontWeight: 500,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={td.task_id}
        >
          {td.task_id}
        </span>
        {td.assigned_to ? (
          <span style={{ fontSize: 10, color: t.textSecondary, flexShrink: 0 }}>
            {td.assigned_to}
          </span>
        ) : null}
        <antd.Tag
          style={{
            margin: 0,
            fontSize: 10,
            lineHeight: "16px",
            borderColor: info.color,
            color: info.color,
            background: "transparent",
            flexShrink: 0,
          }}
        >
          {info.label}
        </antd.Tag>
      </div>
      {open ? (
        <div style={{ padding: "0 10px 8px 28px", fontSize: 11, color: t.textSecondary, lineHeight: 1.7 }}>
          {/* spec/结果产物/交付物 = 共享 ArtifactLines
 （monospace 路径 + 查看内联预览 + 下载），与任务巡检 Drawer
 同一组件同一行为。 */}
          <ArtifactLines
            runId={ev.runId}
            taskId={td.task_id}
            compact
            lines={[
              ...(td.spec_path ? [{ label: tr("spec"), path: td.spec_path }] : []),
              ...(td.result_path ? [{ label: tr("结果产物"), path: td.result_path }] : []),
              ...deliverablesList.map((d) => ({ label: tr("交付物"), path: d })),
            ]}
          />
          {td.summary ? (
            <div
              className="wb-clamp-2"
              title={td.summary}
            >
              {td.summary}
            </div>
          ) : null}
          <div>
            {tr("产物 {a} · 状态转换 {b}", { a: deliverables, b: histCount })}
            {td.result_status ? ` · ${tr("验收")}: ${td.result_status}` : ""}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 节点显示名：task 优先，否则 subagent/name/id。 */
/** MXID → 显示短名（命名约定：UI 正文用名字，完整 MXID 走 title 悬停）。
 `@tech-writer:example.org` → `tech-writer`。
 只认 @开头且含 : 的串（真 MXID 形态）——普通任务名不误伤。 */
function mxidShort(s: string): string {
  const t = s.trim();
  if (!t.startsWith("@")) return t;
  const at = t.indexOf(":", 1);
  return at > 0 ? t.slice(1, at) : t.slice(1);
}

function nodeLabel(n: WorkflowNode): string {
  const task = typeof n.task === "string" ? n.task.trim() : "";
  if (task) return task;
  const sub = typeof n.subagent === "string" ? n.subagent.trim() : "";
  if (sub) return sub;
  const name = typeof n.name === "string" ? n.name.trim() : "";
  if (name) return name;
  // 空串 id 兜底（15.14 真盘：节点 id 为空时旧逻辑返回 ""→ 卡标题行
  // 塌 0 高的诱因之一）——恒返回非空显示值。
  return typeof n.id === "string" && n.id.trim() ? n.id : "节点";
}

/** 显示用短名：nodeLabel 的值若为 MXID → 短名（title 悬停仍走原名）。 */
function nodeLabelUi(n: WorkflowNode): string {
  return mxidShort(nodeLabel(n));
}



// ── 看板视图（第四视图）──────────────────────────────
// 状态映射与 dashboard #85 workflowStatusToTaskStatus 逐条对齐
//（联合交叉验证基准：SC/agentteams-dashboard src/hooks/use-projects.ts）。

type BoardCol =
  | "pending"
  | "assigned"
  | "in_progress"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "unknown";

function workflowStatusToTaskStatus(status?: string): BoardCol {
  switch (status) {
    case "pending":
    case "planned":
    case "":
      return "pending";
    case "delegated":
    case "assigned":
      return "assigned";
    case "in-progress":
    case "in_progress":
    case "submitted":
      return "in_progress";
    case "completed":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "blocked":
    case "revision":
      return "blocked";
    // cancelled 独立列（不再折入 blocked——状态映射
 // 不一致缺陷，报告）。
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return "unknown";
  }
}

/** 列配置（顺序/语义同 dashboard TASK_STATUS_COLUMNS + 已取消列）。 */
const BOARD_COLUMNS: Array<{ key: BoardCol; zh: string; color: string }> = [
  { key: "pending", zh: "待办", color: "#64748b" },
  { key: "assigned", zh: "已派发", color: "#1677ff" },
  { key: "in_progress", zh: "进行中", color: "#722ed1" },
  { key: "completed", zh: "已完成", color: "#52c41a" },
  { key: "failed", zh: "失败", color: "#ff4d4f" },
  { key: "blocked", zh: "阻塞", color: "#fa8c16" },
  { key: "cancelled", zh: "已取消", color: "#cf1322" },
  { key: "unknown", zh: "未知", color: "#8c8c8c" },
];

interface BoardTask {
  runId: string;
  projectTitle: string;
  projectStatus: string;
  node: WorkflowNode;
  col: BoardCol;
  /** 原节点序（列内时间排序的同项目保序键）。 */
  __seq?: number;
}

/** 事件流 nodes → 看板任务（按状态分列）。 */
function boardTasksFromEvents(events: WorkflowEvent[]): BoardTask[] {
  const out: BoardTask[] = [];
  for (const ev of events) {
    for (const node of ev.nodes || []) {
      out.push({
        runId: ev.runId,
        projectTitle: ev.title || ev.runId,
        projectStatus: ev.status || "",
        node,
        col: workflowStatusToTaskStatus(
          typeof node.status === "string" ? node.status : undefined,
        ),
      });
    }
  }
  return out;
}

/** 终态任务判定（上游归一化状态：completed/revision/blocked/cancelled）。
 * 上移——任务巡检 Drawer 的门控也要用。
 * cancelled 升为独立终态（不再藏进 blocked）。 */
const TERMINAL_NODE_STATUSES = ["completed", "revision", "blocked", "cancelled"];

/** 任务级取消 Modal（dashboard TaskDetailRow CancelTaskButton 同款语义：
 * reason 必填、非终态门控、上游 409 幂等收敛）。（P3
 * 对齐）：看板卡 + 任务巡检 Drawer 共用——此前只有看板卡有取消入口，
 * 拓扑/卡片视图点开任务详情后取消功能「消失」（dashboard 任务行始终可
 * 取消）。 */
function TaskCancelModal(props: {
  open: boolean;
  title: string;
  runId: string;
  taskId: string;
  onClose: () => void;
  onDone?: () => void;
}) {
  const tr = useT();
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const ok = async () => {
    const r = reason.trim();
    if (!r) return;
    setBusy(true);
    try {
      await cancelTask(props.runId, props.taskId, r);
      antd.message.success(tr("任务已取消"));
      setReason("");
      props.onClose();
      props.onDone?.();
    } catch (e) {
      antd.message.error(
        `${tr("取消任务失败")}${e instanceof Error ? `：${e.message}` : ""}`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <antd.Modal
      open={props.open}
      title={`${tr("取消任务")} — ${props.title}`}
      okText={tr("确认取消")}
      cancelText={tr("返回")}
      okButtonProps={{ disabled: !reason.trim() }}
      confirmLoading={busy}
      onOk={() => void ok()}
      onCancel={() => {
        setReason("");
        props.onClose();
      }}
      width={440}
    >
      <div style={{ fontSize: 12, color: "#999", marginBottom: 8, lineHeight: 1.6 }}>
        {tr("取消将写入项目任务图并通知项目群；依赖此任务的任务将保持阻塞。")}
      </div>
      <antd.Input.TextArea
        value={reason}
        onChange={(e: ReactNS.ChangeEvent<HTMLTextAreaElement>) =>
          setReason(e.target.value)
        }
        placeholder={tr("取消原因（必填，将通知团队）")}
        rows={3}
        maxLength={200}
      />
    </antd.Modal>
  );
}

/** #1230 任务巡检 Drawer：任务级明细（正源 tasks_detail 强类型 taskDetails）
 * + 依赖（nodes 反推 dependsOn）+ tracing 过滤提示。
 * 入口 = 看板/卡片视图任务卡点击。数据边界：Matrix 降级轨事件无 taskDetails
 * → 显式提示，不编造。tracing 提示语义=过滤提示（值匹配 worker entry span
 * 的 agentteams.project.id / agentteams.task.id 属性，不构造 URL）。
 * 补 result_path 查看/下载（此前
 * 类型有字段、UI 不渲染）+ 任务级取消（走共享 TaskCancelModal）。 */
function TaskInspectionDrawer(props: {
  ev: WorkflowEvent | null;
  taskId: string | null;
  onClose: () => void;
  /** 取消成功后父组件静默刷新（对齐看板卡 onTaskDone 语义）。 */
  onDone?: () => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  const { ev, taskId } = props;
  // spec/结果产物/交付物的查看/下载/预览 = 共享
  // ArtifactLines（与拓扑任务详情行同一组件——预览态随组件内聚，
  // 本 Drawer 不再自持 preview/downloading）。
  // 任务级取消——与看板卡同一门控/同一共享 Modal。
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const open = ev !== null && taskId !== null;
  const detail =
    ev && taskId
      ? (ev.taskDetails || []).find((d) => d.task_id === taskId)
      : undefined;
  const node =
    ev && taskId ? (ev.nodes || []).find((n) => n.id === taskId) : undefined;
  const deps = (node?.dependsOn || []).filter(Boolean);
  const history = Array.isArray(detail?.history) ? detail.history : [];
  const deliverables = (
    Array.isArray(detail?.deliverables) ? detail.deliverables : []
  ).filter((d): d is string => typeof d === "string");
  const assignee =
    (typeof node?.subagent === "string" && node.subagent.trim()) ||
    detail?.assigned_to ||
    "";
  const status = String(node?.status || detail?.status || "");
  const meta = statusMeta(status);
  const canCancel =
    !!taskId && status !== "" && !TERMINAL_NODE_STATUSES.includes(status);
  return (
    <antd.Drawer
      open={open}
      onClose={props.onClose}
      width={460}
      title={node ? nodeLabel(node) : taskId || tr("任务巡检")}
    >
      {!ev || !taskId ? null : (
        <div style={{ display: "grid", gap: 12, fontSize: 12.5 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <antd.Tag color={meta.color} style={{ margin: 0 }}>
              {tr(meta.label)}
            </antd.Tag>
            {assignee ? (
              // worker 短名（@name，保留 @，非全 MXID）。
              <antd.Tag style={{ margin: 0, maxWidth: "100%", overflow: "hidden" }}>
                <UserIcon size={11} style={{ verticalAlign: "-1px", marginRight: 2 }} /> {assignee.split(":")[0]}
              </antd.Tag>
            ) : null}
            <span style={{ fontFamily: "monospace", fontSize: 11, color: t.textSecondary, overflowWrap: "anywhere" }}>
              {taskId}
            </span>
            {canCancel ? (
              <antd.Button
                size="small"
                danger
                style={{ marginLeft: "auto" }}
                onClick={() => setCancelOpen(true)}
              >
                {tr("取消任务")}
              </antd.Button>
            ) : null}
          </div>
          {!detail ? (
            <div style={{ color: t.textSecondary, fontSize: 12 }}>
              {tr("无任务级明细——正源任务图有该任务，但 TaskMeta 未落盘（或 Matrix 降级轨无 tasks_detail）")}
            </div>
          ) : (
            <>
              {detail.summary ? (
                <div>
                  <div style={{ color: t.textSecondary, fontSize: 11, marginBottom: 3 }}>{tr("摘要")}</div>
                  <div style={{ lineHeight: 1.6 }}>{detail.summary}</div>
                </div>
              ) : null}
              {detail.result_status ? (
                <div>
                  <div style={{ color: t.textSecondary, fontSize: 11, marginBottom: 3 }}>{tr("验收结果")}</div>
                  <div>{detail.result_status}</div>
                </div>
              ) : null}
              {detail.cancel_reason ? (
                <div>
                  <div style={{ color: t.textSecondary, fontSize: 11, marginBottom: 3 }}>{tr("取消原因")}</div>
                  <div>{detail.cancel_reason}</div>
                </div>
              ) : null}
              {/* 共享 ArtifactLines（与拓扑任务详情行
 同一组件——monospace 路径 + 查看内联预览 + 下载）。 */}
              <ArtifactLines
                runId={ev.runId}
                taskId={taskId}
                lines={[
                  ...(detail.spec_path
                    ? [{ label: tr("任务规格"), path: detail.spec_path }]
                    : []),
                  ...(detail.result_path
                    ? [{ label: tr("结果产物"), path: detail.result_path }]
                    : []),
                  ...deliverables.map((d) => ({
                    label: tr("交付物"),
                    path: d,
                  })),
                ]}
              />
              {deps.length > 0 ? (
                <div>
                  <div style={{ color: t.textSecondary, fontSize: 11, marginBottom: 3 }}>{tr("依赖任务")}</div>
                  {deps.map((d) => (
                    <antd.Tag key={d} color="geekblue" style={{ fontFamily: "monospace", fontSize: 10.5 }}>
                      {d}
                    </antd.Tag>
                  ))}
                </div>
              ) : null}
              {history.length > 0 ? (
                <div>
                  <div style={{ color: t.textSecondary, fontSize: 11, marginBottom: 6 }}>
                    {tr("状态转换（{n}，新→旧）", { n: history.length })}
                  </div>
                  <antd.Timeline
                    items={[...history].reverse().map((h, i) => ({
                      key: h.seq ?? i,
                      children: (
                        <div style={{ fontSize: 11.5, fontFamily: "monospace", paddingBottom: 2 }}>
                          <b>{h.from || "∅"} → {h.to}</b>
                          <span style={{ color: t.textSecondary }}>
                            {" "}{h.action}
                            {/* actor 短名（@name，非全 MXID） */}
                            {h.actor ? `（${h.actor.split(":")[0]}）` : ""}
                          </span>
                          <div style={{ color: t.textSecondary, fontSize: 10.5, fontFamily: "inherit" }}>
                            {h.ts}
                            {h.note ? ` · ${h.note}` : ""}
                          </div>
                        </div>
                      ),
                    }))}
                  />
                </div>
              ) : null}
            </>
          )}
          <div>
            <div style={{ color: t.textSecondary, fontSize: 11, marginBottom: 3 }}>{tr("tracing 过滤提示")}</div>
            <antd.Typography.Text
              copyable={{ text: `agentteams.project.id=${ev.runId} · agentteams.task.id=${taskId}` }}
              style={{ fontFamily: "monospace", fontSize: 11 }}
            >
              agentteams.project.id={ev.runId} · agentteams.task.id={taskId}
            </antd.Typography.Text>
            <div style={{ color: t.textSecondary, fontSize: 10.5, marginTop: 2 }}>
              {tr("值用于匹配 worker entry span 属性（tracing 后端为部署特定，不构造 URL）")}
            </div>
          </div>
        </div>
      )}
      {ev && taskId ? (
        <TaskCancelModal
          open={cancelOpen}
          title={node ? nodeLabel(node) : taskId}
          runId={ev.runId}
          taskId={taskId}
          onClose={() => setCancelOpen(false)}
          onDone={props.onDone}
        />
      ) : null}
    </antd.Drawer>
  );
}

/** 看板任务卡：任务名 + 项目 + 负责人 + 依赖 badge + 非终态任务取消按钮。
 * 依赖不画跨列连线（与 dashboard 一致：看板列内 badge，依赖树走拓扑视图）。
 * 取消=任务级（tasks/{id}/cancel，reason 必填；终态任务 409 幂等收敛）。
 * 终态判定用上游归一化状态（completed/revision/blocked/cancelled 四态）。 */
function BoardCard(props: {
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

/** 看板容器（B7，13.14 「项目看板改成两行四列，
 * 每个看板显示三个卡片，再多滚动 col，时间排序要做好」）：
 * - 宽屏/横屏：Jira/Trello 标准看板——8 状态列固定 250px 不压缩、
 *   看板横向滚动、列等高（=容器可用高实测）、卡区列内纵向滚动
 *   （中间宽度不再把列压成竖条；放不下一屏时横向滑出余列）；
 * - 窄屏（容器 < 800）：单列全宽纵向堆叠 + 卡行横向滑动（移动端看板交互）；
 * - 列内显式时间排序：项目活动 ts 新→旧（看板恒时间序——项目级 sortBy
 *   是列表/轨道视图语义，不应扰动看板列内顺序；旧版列内顺序=events
 *   传入序，受 sortBy 影响，「时间排序」不成立）。 */
// 列高实测推导（BoardColumnsView 的 ResizeObserver：约束底 − 看板顶），
// 随屏幕高度伸缩；BOARD_CARD_CAP_PX 仅作首次测量前的初始/回退值（≈3 卡）。
const BOARD_CARD_CAP_PX = 330;
// 15.15 三档布局模式（横屏回归修复）：判定收敛进纯模块 boardMode.ts
// （断点回归护栏——本次横屏被搞烂的根因就是断点误判：横屏手机 667px 曾
// 因 <800 恒 narrow 落进竖屏堆叠）。stacked=竖屏堆叠、grid2=两列定宽+3 卡
// 限高滚（横屏）、jira=250px 横滚（桌面）；按实测容器宽 500/950 断点。
function BoardColumnsView(props: {
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

/** replan 种子：当前 DAG 节点 → 任务数组（taskId/title/assignedTo/dependsOn，
 * 省略 status——上游 normalizeReplanTasks 对已存在 taskId 继承旧状态）。
 * 仅带非空键，保持 JSON 紧凑。 */
function replanSeedJson(ev: WorkflowEvent): string {
  const tasks = (ev.nodes || []).map((n) => {
    const t: Record<string, unknown> = {};
    const id = typeof n.id === "string" ? n.id.trim() : "";
    if (!id) return null;
    t.taskId = id;
    if (typeof n.name === "string" && n.name.trim()) t.title = n.name;
    const who =
      (typeof n.assignee === "string" && n.assignee) ||
      (typeof n.subagent === "string" && n.subagent) ||
      "";
    if (who) t.assignedTo = who;
    if (Array.isArray(n.dependsOn) && n.dependsOn.length > 0) {
      t.dependsOn = n.dependsOn;
    }
    return t;
  }).filter(Boolean) as Record<string, unknown>[];
  return JSON.stringify(tasks, null, 2);
}

/** 事件级干预（上游已合并）：Pause / Resume / 完成 / 重规划 + interrupts 渲染。
 * 成功后回调 onDone 刷新工作流。门控语义对齐 Controller（v1.2.3 源码）：
 * active/planning 可 pause；paused interrupt（action_request.resume +
 * allow_accept）可 resume；active/planning 可 complete（上游要求全任务终态，
 * 否则 409 带原因透传）；active + dag + 无 in-progress 节点可 replan。 */
function InterventionActions({
  ev,
  onDone,
}: {
  ev: WorkflowEvent;
  onDone?: () => void;
}) {
  const tr = useT();
  const [pauseOpen, setPauseOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [completeOpen, setCompleteOpen] = React.useState(false);
  const [replanOpen, setReplanOpen] = React.useState(false);
  const [replanText, setReplanText] = React.useState("");
  const [busy, setBusy] = React.useState<
    "pause" | "resume" | "complete" | "replan" | null
  >(null);

  const resumeInterrupt = (ev.interrupts || []).find(
    (it) => it.action_request?.action === "resume" && it.config?.allow_accept,
  );
  const canPause = ev.status === "active" || ev.status === "planning";
  const canComplete = ev.status === "active" || ev.status === "planning";
  const canReplan =
    ev.status === "active" &&
    (!ev.plan_type || ev.plan_type === "dag") &&
    !((ev.nodes || []).some((n) => n.status === "in-progress"));

  const handlePause = async () => {
    setBusy("pause");
    try {
      await pauseProject(ev.runId, reason.trim() || undefined);
      antd.message.success(tr("项目已暂停"));
      setPauseOpen(false);
      setReason("");
      onDone?.();
    } catch (e) {
      antd.message.error(e instanceof Error ? e.message : tr("暂停失败"));
    } finally {
      setBusy(null);
    }
  };

  const handleResume = async () => {
    setBusy("resume");
    try {
      await resumeProject(ev.runId);
      antd.message.success(tr("项目已恢复"));
      onDone?.();
    } catch (e) {
      antd.message.error(e instanceof Error ? e.message : tr("恢复失败"));
    } finally {
      setBusy(null);
    }
  };

  const handleComplete = async () => {
    setBusy("complete");
    try {
      await completeProject(ev.runId);
      antd.message.success(tr("项目已标记完成"));
      setCompleteOpen(false);
      onDone?.();
    } catch (e) {
      antd.message.error(
        `${tr("完成失败")}${e instanceof Error ? `：${e.message}` : ""}`,
      );
    } finally {
      setBusy(null);
    }
  };

  const openReplan = () => {
    setReplanText(replanSeedJson(ev));
    setReplanOpen(true);
  };

  const handleReplan = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(replanText);
    } catch {
      antd.message.error(tr("任务 JSON 解析失败，请检查格式"));
      return;
    }
    if (!Array.isArray(parsed)) {
      antd.message.error(tr("任务必须是 JSON 数组（[{taskId, ...}]）"));
      return;
    }
    for (const [i, t] of (parsed as unknown[]).entries()) {
      const tid =
        t && typeof t === "object"
          ? (t as Record<string, unknown>).taskId
          : undefined;
      if (typeof tid !== "string" || !tid.trim()) {
        antd.message.error(tr("第 {n} 项缺少 taskId", { n: i + 1 }));
        return;
      }
    }
    setBusy("replan");
    try {
      await replanProject(ev.runId, parsed);
      antd.message.success(tr("项目已重规划"));
      setReplanOpen(false);
      onDone?.();
    } catch (e) {
      antd.message.error(
        `${tr("重规划失败")}${e instanceof Error ? `：${e.message}` : ""}`,
      );
    } finally {
      setBusy(null);
    }
  };

  if (
    !canPause &&
    !canComplete &&
    !canReplan &&
    !resumeInterrupt &&
    !(ev.interrupts || []).length
  ) {
    return null;
  }

  return (
    <>
      {canPause ? (
        <antd.Button
          size="small"
          loading={busy === "pause"}
          onClick={() => setPauseOpen(true)}
          style={{ color: "#fa8c16" }}
        >
          <PauseIcon size={12} style={{ verticalAlign: "-1px", marginRight: 3 }} /> {tr("暂停")}
        </antd.Button>
      ) : null}
      {resumeInterrupt ? (
        <antd.Button
          size="small"
          type="primary"
          loading={busy === "resume"}
          onClick={() => void handleResume()}
        >
          <PlayIcon size={12} style={{ verticalAlign: "-1px", marginRight: 3 }} /> {tr("恢复")}
        </antd.Button>
      ) : null}
      {canComplete ? (
        <antd.Button
          size="small"
          loading={busy === "complete"}
          onClick={() => setCompleteOpen(true)}
          style={{ color: "#52c41a" }}
        >
          <CheckIcon size={12} style={{ verticalAlign: "-1px", marginRight: 3 }} /> {tr("完成")}
        </antd.Button>
      ) : null}
      {canReplan ? (
        <antd.Button
          size="small"
          loading={busy === "replan"}
          onClick={openReplan}
          style={{ color: "#1677ff" }}
        >
          <TodoIcon size={12} style={{ verticalAlign: "-1px", marginRight: 3 }} /> {tr("重规划")}
        </antd.Button>
      ) : null}
      <antd.Modal
        open={pauseOpen}
        title={`${tr("暂停项目")} — ${ev.title || ev.runId}`}
        okText={tr("确认暂停")}
        cancelText={tr("取消")}
        confirmLoading={busy === "pause"}
        onOk={() => void handlePause()}
        onCancel={() => setPauseOpen(false)}
        width={440}
      >
        <antd.Input.TextArea
          value={reason}
          onChange={(e: ReactNS.ChangeEvent<HTMLTextAreaElement>) =>
            setReason(e.target.value)
          }
          placeholder={tr("暂停原因（可选，将通知团队）")}
          rows={3}
          maxLength={200}
        />
      </antd.Modal>
      <antd.Modal
        open={completeOpen}
        title={`${tr("完成项目")} — ${ev.title || ev.runId}`}
        okText={tr("确认完成")}
        cancelText={tr("取消")}
        confirmLoading={busy === "complete"}
        onOk={() => void handleComplete()}
        onCancel={() => setCompleteOpen(false)}
        width={440}
      >
        <div style={{ fontSize: 13, lineHeight: 1.7 }}>
          {tr(
            "确认将项目标记为已完成？所有任务须已终止（完成/失败/阻塞/取消），否则上游会拒绝。完成后会通知项目群。",
          )}
        </div>
      </antd.Modal>
      <antd.Modal
        open={replanOpen}
        title={`${tr("重规划项目（编辑任务 DAG）")} — ${ev.title || ev.runId}`}
        okText={tr("提交重规划")}
        cancelText={tr("取消")}
        confirmLoading={busy === "replan"}
        onOk={() => void handleReplan()}
        onCancel={() => setReplanOpen(false)}
        width={560}
      >
        <div style={{ fontSize: 12, color: "#999", marginBottom: 8, lineHeight: 1.6 }}>
          {tr(
            "已按当前任务预填（不含 status）：保留的 taskId 省略字段将继承旧值，新增任务只需 taskId（可选 title/assignedTo/dependsOn）。重规划后项目通知群内。",
          )}
        </div>
        <antd.Input.TextArea
          value={replanText}
          onChange={(e: ReactNS.ChangeEvent<HTMLTextAreaElement>) =>
            setReplanText(e.target.value)
          }
          rows={12}
          style={{ fontFamily: "monospace", fontSize: 12 }}
        />
      </antd.Modal>
    </>
  );
}

/** 中断横幅：展示 interrupts 与暂停原因（paused interrupt）。
 * （13.12 「顶上三个 ⚠ blocked 只显示 '⚠ blocked'
 * 有点突兀」）：interrupt.id 即 task_id（实盘某项目 3 条 blocked
 * interrupt id=...-03/-04/-07 与 tasks_detail task_id 一一对应）→
 * 横幅带任务短编号 + 当前状态 + 分配 Worker，可定位到具体任务。
 * 无 task 匹配（interrupt 非任务维度）→ 保持原样。 */
function InterruptsBlock({
  interrupts,
  pauseReason,
  tasks,
}: {
  interrupts: WorkflowInterrupt[];
  pauseReason?: string;
  tasks?: TaskDetail[];
}) {
  const tr = useT();
  const t = useThemeColors(); 
  if (interrupts.length === 0) return null;
  const taskById = new Map<string, TaskDetail>();
  (tasks || []).forEach((tk) => {
    if (tk.task_id) taskById.set(tk.task_id, tk);
  });
  const shortId = (id: string) => {
    const parts = id.split("-");
    return parts.length > 1 ? parts[parts.length - 1] : id;
  };
  return (
    <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
      {interrupts.map((it) => {
        const task = taskById.get(it.id);
        const detail: string[] = [];
        if (task) {
          detail.push(tr("任务 {n}", { n: shortId(it.id) }));
          if (task.status) detail.push(task.status);
          if (task.assigned_to) detail.push(task.assigned_to);
        }
        return (
          <div
            key={it.id || it.value}
            style={{
              fontSize: 12,
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid #fa8c16",
              // 深色档：6% 橙底太淡 / 深橙字不可读 → 加浓 + 亮向
              background: t.mode === "dark" ? "rgba(250,140,22,0.14)" : "rgba(250, 140, 22, 0.06)",
              color: t.mode === "dark" ? "#faad14" : "#d46b08",
            }}
          >
            {it.value === "paused" ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <PauseIcon size={12} /> {tr("项目已暂停")}
              </span>
            ) : (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <WarnIcon size={12} /> {it.value === "blocked" ? tr("阻塞") : it.value}
              </span>
            )}
            {detail.length > 0 ? (
              <span style={{ opacity: 0.85 }}>
                {"："}
                {detail.join(" · ")}
              </span>
            ) : null}
            {it.description ? (
              <span style={{ opacity: 0.8 }}> — {it.description}</span>
            ) : null}
            {pauseReason && it.value !== "paused" ? (
              <span style={{ opacity: 0.8 }}>：{pauseReason}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Loop 计划块（plan_type=loop 项目的迭代进度/停止条件/任务图）。 */
function LoopBlock({
  loop,
}: {
  loop: NonNullable<WorkflowEvent["loop"]>;
}) {
  const tr = useT();
  const t = useThemeColors(); 
  const cur = typeof loop.current_iteration === "number" ? loop.current_iteration : 0;
  const max = typeof loop.max_iterations === "number" ? loop.max_iterations : 0;
  const pct = max > 0 ? Math.min(100, Math.round((cur / max) * 100)) : 0;
  return (
    <div
      style={{
        display: "grid",
        gap: 6,
        marginTop: 8,
        padding: "8px 10px",
        borderRadius: 8,
        border: `1px solid ${t.border}`,
        background: t.hoverBg,
        fontSize: 12,
      }}
    >
      <div style={{ fontWeight: 700 }}>
        <RefreshIcon size={12} style={{ verticalAlign: "-1px", marginRight: 3 }} /> {tr("循环任务")}
        {loop.status ? (
          <span style={{ marginLeft: 8, fontWeight: 400, opacity: 0.7 }}>
            {loop.status}
          </span>
        ) : null}
        {max > 0 ? (
          <span style={{ float: "right", fontWeight: 400, opacity: 0.7 }}>
            {cur}/{max}
          </span>
        ) : null}
      </div>
      {max > 0 ? (
        <div
          style={{
            height: 6,
            borderRadius: 3,
            background: t.hoverBg, // 进度槽
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${pct}%`,
              background: "#722ed1",
              borderRadius: 3,
            }}
          />
        </div>
      ) : null}
      {loop.goal ? (
        <div style={{ opacity: 0.8 }}>目标：{loop.goal}</div>
      ) : null}
      {loop.stop_condition ? (
        <div style={{ opacity: 0.7 }}>停止条件：{loop.stop_condition}</div>
      ) : null}
      {(loop.tasks || []).length > 0 ? (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {(loop.tasks || []).map((t, i) => {
            const st = statusMeta(String(t.status || ""));
            return (
              <antd.Tag key={t.task_id || i} color={st.color} style={{ margin: 0, fontSize: 11 }}>
                {t.title || t.task_id || `步骤 ${i + 1}`}
              </antd.Tag>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** 项目干预时间线（history 端点；懒加载：展开时才请求）。
 * teamId 透传 ?team=——跨团队重名项目裸 id 409（同 /workflow 契约）。 */
function ProjectTimeline({ projectId, teamId }: { projectId: string; teamId?: string }) {
  const tr = useT();
  const [open, setOpen] = React.useState(false);
  const [state, setState] = React.useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ok"; snapshots: { timestamp: string }[] }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [detail, setDetail] = React.useState<Record<string, unknown> | null>(
    null,
  );

  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    setState({ kind: "loading" });
    fetchProjectHistory(projectId, teamId)
      .then((resp) => {
        if (alive) setState({ kind: "ok", snapshots: resp.snapshots });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const msg = e instanceof Error ? e.message : String(e);
        setState({ kind: "error", message: msg });
      });
    return () => {
      alive = false;
    };
  }, [open, projectId]);

  const openDetail = (ts: string) => {
    fetchProjectHistorySnapshot(projectId, ts, teamId)
      .then((raw) => setDetail(raw))
      .catch(() => setDetail(null));
  };

  return (
    <div style={{ marginTop: 8, fontSize: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          cursor: "pointer",
          fontWeight: 600,
        }}
        onClick={() => setOpen((v) => !v)}
      >
        <span style={{ fontSize: 11, color: "#888" }}>
          {open ? "▾" : "▸"}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><HistoryIcon size={12} /> {tr("时间线")}</span>
        {state.kind === "ok" && state.snapshots.length > 0 ? (
          <antd.Badge
            count={state.snapshots.length}
            size="small"
            style={{ backgroundColor: "#8c8c8c", marginLeft: 4 }}
          />
        ) : null}
      </div>
      {open ? (
        <div style={{ marginTop: 6, paddingLeft: 16, display: "grid", gap: 4 }}>
          {state.kind === "loading" ? (
            <span style={{ color: "#999" }}>{tr("加载中…")}</span>
          ) : null}
          {state.kind === "error" ? (
            <span style={{ color: "#999" }}>
              {state.message.includes("not found") ||
              /HTTP 404/.test(state.message)
                ? tr("Controller 升级后自动生效")
                : `${tr("时间线加载失败")}：${state.message}`}
            </span>
          ) : null}
          {state.kind === "ok" && state.snapshots.length === 0 ? (
            <span style={{ color: "#999" }}>{tr("暂无干预记录")}</span>
          ) : null}
          {state.kind === "ok"
            ? state.snapshots.map((s) => (
                <div
                  key={s.timestamp}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    cursor: "pointer",
                    color: "#666",
                  }}
                  onClick={() => openDetail(s.timestamp)}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: "#bbb",
                      flexShrink: 0,
                    }}
                  />
                  <span>
                    {fmtTime(Number(s.timestamp) / 1e6)}
                    <span style={{ color: "#aaa", marginLeft: 6 }}>
                      {s.timestamp.slice(0, 10)}…
                    </span>
                  </span>
                </div>
              ))
            : null}
        </div>
      ) : null}
      <antd.Drawer
        title={tr("干预前快照")}
        open={detail !== null}
        onClose={() => setDetail(null)}
        width={420}
      >
        {detail ? (
          <SnapshotDetail raw={detail} />
        ) : (
          <span style={{ color: "#999" }}>{tr("快照加载失败")}</span>
        )}
      </antd.Drawer>
    </div>
  );
}

/** 单份快照关键字段展示（raw meta JSON）。 */
function SnapshotDetail({ raw }: { raw: Record<string, unknown> }) {
  const tr = useT();
  const rows: [string, unknown][] = [
    [tr("状态"), raw.status],
    [tr("标题"), raw.title],
    [tr("操作人"), raw.updated_by],
    [tr("操作时间"), raw.updated_at],
    [tr("暂停原因"), raw.pause_reason],
  ];
  const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  return (
    <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
      {rows.map(([label, value]) =>
        value === undefined || value === null || value === "" ? null : (
          <div key={label}>
            <div style={{ color: "#999", fontSize: 12 }}>{label}</div>
            <div>{String(value)}</div>
          </div>
        ),
      )}
      <div>
        <div style={{ color: "#999", fontSize: 12 }}>
          {tr("任务数")}
        </div>
        <div>{tasks.length}</div>
      </div>
    </div>
  );
}

/** 卡片视图：单事件卡片（title/status/summary/coordinator/steps 行）。 */
function EventCard({
  ev,
  t,
  onIntervention,
}: {
  ev: WorkflowEvent;
  t: ReturnType<typeof useThemeColors>;
  onIntervention?: () => void;
}) {
  const tr = useT();
  const st = statusMeta(ev.status);
  const steps = (ev.steps || []).slice(0, 8);
  return (
    <antd.Card
      size="small"
      style={{ borderRadius: 10 }}
      title={
        <span>
          {ev.title || tr("未命名任务")}
          <antd.Tag color={st.color} style={{ marginLeft: 8 }}>
            {st.label}
          </antd.Tag>
        </span>
      }
      extra={
        <span style={{ fontSize: 12, color: t.textSecondary }}>
          {fmtTime(ev.ts)}
        </span>
      }
    >
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          marginBottom: 8,
        }}
      >
        <InterventionActions ev={ev} onDone={onIntervention} />
      </div>
      <InterruptsBlock
        interrupts={ev.interrupts || []}
        pauseReason={ev.pause_reason}
        tasks={ev.taskDetails}
      />
      {ev.loop ? <LoopBlock loop={ev.loop} /> : null}
      {ev.runId ? <ProjectTimeline projectId={ev.runId} teamId={ev.team_id} /> : null}
      {/* 任务状态转换事件流（#1233 events 端点）——与干预时间线并列。 */}
      {ev.runId ? <WorkflowEventsTimeline projectId={ev.runId} teamId={ev.team_id} /> : null}
      {ev.summary ? (
        <div
          style={{
            fontSize: 13,
            color: t.textSecondary,
            marginBottom: 8,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={ev.summary}
        >
          {ev.summary}
        </div>
      ) : null}
      {ev.coordinator ? (
        <div style={{ fontSize: 12, color: t.textSecondary, marginBottom: 4 }}>
          协调者：{ev.coordinator.split(":")[0].replace(/^@/, "")}
        </div>
      ) : null}
      {steps.length > 0 ? (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {steps.map((s, i) => {
            const row = typeof s === "string" ? { name: s } : (s as Record<string, unknown>);
            const name = String(row.name || row.id || `步骤 ${i + 1}`);
            const stt = statusMeta(String(row.status || ""));
            return (
              <antd.Tag key={i} color={stt.color} style={{ margin: 0, fontSize: 11 }}>
                {name}
              </antd.Tag>
            );
          })}
        </div>
      ) : null}
    </antd.Card>
  );
}

interface WorkflowBoardProps {
  events: WorkflowEvent[]; // 由父组件通过 api.ts fetchWorkflowEvents 获取
  loading?: boolean;
  onRefresh?: () => void;
  /** 聊天 workflow 卡片点击跳转：高亮/滚动到该项目。 */
  highlightRunId?: string;
  /** 正源状态——rooms=已降级到「只扫已加入房间」。 */
  source?: "controller" | "rooms";
  failReason?: "auth" | "not_deployed" | "error";
  /** error 分支的真实上游错误（如 Controller 500 的 mc 报错）。 */
  failDetail?: string;
  /** 视图 tab 受控（父组件记忆到大 tab 同款 ui-state）。 */
  view?: WfView;
  onViewChange?: (v: WfView) => void;
  /** 拓扑视图选中的 runId 受控（父组件记忆）。 */
  topoRun?: string;
  onTopoRunChange?: (runId: string) => void;
}

/** ：13.21 曾加第 5 项「mermaid」独立
 * 视图——与拓扑依赖图同结构（并入拓扑：「不需要新开第 5 项，把
 * 拓扑的依赖图优化就好」）→ mermaid 退役为拓扑视图内的图样式切换。 */
export type WfView = "list" | "card" | "board" | "topo";

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
