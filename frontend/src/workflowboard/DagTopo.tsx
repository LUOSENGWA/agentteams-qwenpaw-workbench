// WorkflowBoard 巨石拆分 · 拓扑主体：分层 DAG + 缩放工具条 + 捏合缩放/平移
// 手势（DagTopo）与任务详情行（TopoTaskDetailRow）。
// 手势 / auto-fit / pointer 逻辑逐字搬移，行为零变。

import type * as ReactNS from "react";
import type { WorkflowEvent } from "../api";
import ArtifactLines from "../components/ArtifactLines";
import type { ThemeColors } from "../theme";
import { useT } from "../i18n";
import { WorkflowDagSvg, buildWorkflowDag } from "../components/WorkflowDag";
import { useWbViewport } from "../WbViewportContext";
import {
  dagNodeColors,
  statusMeta,
  secTitleStyle,
  nodeLabel,
  nodeLabelUi,
} from "./helpers";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

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
export function DagTopo(props: {
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
  // 滚轮缩放（native non-passive——React 合成 onWheel 是 passive，
  // preventDefault 无效）：每格 ×/÷1.12，光标位置锚定（与双指捏合
  // 中点锚定同式：screen = content×zoom + pan → pan′ = m − (m − pan)×k）。
  const zoomRef = React.useRef(zoom);
  zoomRef.current = zoom;
  const panXRef = React.useRef(panX);
  panXRef.current = panX;
  const panYRef = React.useRef(panY);
  panYRef.current = panY;
  const clampZoomRef = React.useRef(clampZoom);
  clampZoomRef.current = clampZoom;
  React.useEffect(() => {
    const el = graphRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      userZoomedRef.current = true; // 手动缩放 → auto-fit 不再覆盖
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const z = zoomRef.current;
      const z1 = clampZoomRef.current(z * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
      if (z1 === z) return;
      const k = z1 / z;
      setZoom(z1);
      setPanX(mx - (mx - panXRef.current) * k);
      setPanY(my - (my - panYRef.current) * k);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
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

/** P2：任务详情行（dashboard TaskDetailRow 语义精简版：任务名+状态+
 * 负责人，展开显 spec/摘要/产物数/转换审计条数——完整明细走既有
 * 任务巡检 Drawer，不重复造轮子）。 */
export function TopoTaskDetailRow(props: {
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
