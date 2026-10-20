/** GraphCard 子模块——自 GraphCard.tsx 纯搬移拆出
 * （行为零变化）。 */
import { TargetIcon } from "../components/icons";
import type * as ReactNS from "react";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { clusterGridLayout, textWidthUnits } from "./layout2d";
import type { FocusTarget, RadialView } from "./layout2d";
import type { GraphNodeLike } from "./types";
import { GRAPH_ROOT_COLOR } from "./GraphCardShared";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export function Graph2DView({
  graph,
  layout,
  posById,
  sizeById,
  crossHubEdges,
  nodeColor,
  hubSet,
  isDirect,
  hoverId,
  selectedId,
  setHoverId,
  dimmed,
  inFocus,
  vb,
  panning,
  view,
  focus,
  focusLabel,
  infoNode,
  legendEntries,
  agentLegend,
  narrow,
  GRAPH_H,
  svgRef,
  hitNodeRef,
  dragRef,
  setPanning,
  setFocus,
  animateTo,
  applyFocus,
  zoomBy,
  onSvgPanDown,
  onSvgPanMove,
  onSvgPanUp,
  handleGraphMove,
  handleGraphClick,
  handleGraphDblClick,
  onSvgTouchStart,
  onSvgTouchMove,
  onSvgTouchEnd,
  panel,
}: {
  graph: { nodes: GraphNodeLike[]; edges: { source: string; target: string; target_anchor?: string | null }[] };
  layout: ReturnType<typeof clusterGridLayout> | null;
  posById: Map<string, { x: number; y: number }>;
  sizeById: Map<string, { w: number; h: number }>;
  crossHubEdges: { a: string; b: string; k: string }[];
  nodeColor: (n: GraphNodeLike) => string;
  hubSet: Set<string>;
  isDirect: (n: GraphNodeLike) => boolean;
  hoverId: string;
  selectedId: string;
  setHoverId: (id: string) => void;
  dimmed: (id: string) => boolean;
  inFocus: (id: string) => boolean;
  vb: RadialView;
  panning: boolean;
  view: RadialView;
  focus: FocusTarget | null;
  focusLabel: string;
  infoNode: GraphNodeLike | null;
  legendEntries: { key: string; label: string; color: string }[];
  agentLegend: { name: string; color: string }[] | null | undefined;
  narrow: boolean;
  GRAPH_H: number;
  svgRef: { current: SVGSVGElement | null };
  hitNodeRef: { current: GraphNodeLike | null };
  dragRef: { current: { startX: number; startY: number; vb0: RadialView; moved: boolean } | null };
  setPanning: ReactNS.Dispatch<ReactNS.SetStateAction<boolean>>;
  setFocus: ReactNS.Dispatch<ReactNS.SetStateAction<FocusTarget | null>>;
  animateTo: (target: RadialView, ms?: number) => void;
  applyFocus: (target: FocusTarget | null) => void;
  zoomBy: (factor: number) => void;
  onSvgPanDown: (e: React.MouseEvent<SVGSVGElement>) => void;
  onSvgPanMove: (e: React.MouseEvent<SVGSVGElement>) => void;
  onSvgPanUp: () => void;
  handleGraphMove: (e: React.MouseEvent<SVGSVGElement>) => void;
  handleGraphClick: (e: React.MouseEvent<SVGSVGElement>) => void;
  handleGraphDblClick: (e: React.MouseEvent<SVGSVGElement>) => void;
  onSvgTouchStart: (e: React.TouchEvent<SVGSVGElement>) => void;
  onSvgTouchMove: (e: React.TouchEvent<SVGSVGElement>) => void;
  onSvgTouchEnd: (e: React.TouchEvent<SVGSVGElement>) => void;
  panel: ReactNS.ReactNode;
}) {
  const t = useThemeColors();
  const tr = useT();
  return (
          <div style={{ position: "relative" }}>
            {/* 窄屏图例（header 不展示图例时兜底，2D 视图内展示）。 */}
            {narrow ? (
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "2px 10px",
                  fontSize: 11,
                  marginBottom: 4,
                }}
              >
                {legendEntries.map((l) => (
                  <span
                    key={l.key}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 3,
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: l.color,
                        display: "inline-block",
                      }}
                    />
                    {l.label}
                  </span>
                ))}
                {!agentLegend ? (
                  <span style={{ color: t.textSecondary }}>
                    → {tr("引用方向")}
                  </span>
                ) : null}
              </div>
            ) : null}
            <div
              style={{
                fontSize: 12,
                color: t.textSecondary,
                marginBottom: 4,
                minHeight: 18,
              }}
            >
              {focus ? (
                <antd.Button
                  size="small"
                  type="link"
                  style={{ padding: 0, height: "auto", fontSize: 12 }}
                  onClick={() => applyFocus(null)}
                >
                  <TargetIcon size={11} style={{ verticalAlign: "-1px", marginRight: 3 }} /> {focusLabel} · 退出
                </antd.Button>
              ) : null}
              {infoNode
                ? `${infoNode.name}${infoNode.description ? ` — ${infoNode.description}` : ""}`
                : tr("点节点查看 · 滚轮缩放 · 拖拽平移 · 点簇根聚焦 · 双击节点邻域 · Esc 退出")}
            </div>
            <div style={{ position: "absolute", right: 0, top: 0, zIndex: 2 }}>
              <antd.Button size="small" onClick={() => zoomBy(1 / 1.5)} title="放大" aria-label="放大">
                +
              </antd.Button>
              <antd.Button size="small" onClick={() => zoomBy(1.5)} title="缩小" aria-label="缩小">
                −
              </antd.Button>
              <antd.Button
                size="small"
                onClick={() => {
                  setFocus(null);
                  animateTo(view, 320);
                }}
                title="复位视野"
                aria-label="复位视野"
              >
                ⟳
              </antd.Button>
            </div>
            <svg
              ref={svgRef}
              viewBox={`${vb.minX} ${vb.minY} ${vb.width} ${vb.height}`}
              width="100%"
              height={GRAPH_H}
              style={{ display: "block", touchAction: "none", cursor: panning ? "grabbing" : "grab" }}
              onClick={handleGraphClick}
              onDoubleClick={handleGraphDblClick}
              onMouseMove={(e) => {
                onSvgPanMove(e);
                handleGraphMove(e);
              }}
              onMouseDown={onSvgPanDown}
              onMouseUp={onSvgPanUp}
              onMouseLeave={() => {
                setHoverId("");
                hitNodeRef.current = null;
                dragRef.current = null;
                setPanning(false);
                if (svgRef.current) svgRef.current.style.cursor = "grab";
              }}
              onTouchStart={onSvgTouchStart}
              onTouchMove={onSvgTouchMove}
              onTouchEnd={onSvgTouchEnd}
              onTouchCancel={onSvgTouchEnd}
            >
              <defs>
                <marker
                  id="gvarrow"
                  viewBox="0 -3 6 6"
                  refX="5"
                  refY="0"
                  markerWidth="5"
                  markerHeight="6"
                  orient="auto"
                >
                  <path d="M0,-3L6,0L0,3" fill={t.textSecondary} opacity={0.45} />
                </marker>
                <marker
                  id="gvarrow-active"
                  viewBox="0 -3 6 6"
                  refX="5"
                  refY="0"
                  markerWidth="5"
                  markerHeight="6"
                  orient="auto"
                >
                  <path d="M0,-3L6,0L0,3" fill={GRAPH_ROOT_COLOR} />
                </marker>
              </defs>
              {/* ③ 簇块虚线框（簇分离视觉锚，替代 v3 扇区边界弧）。 */}
              {layout
                ? layout.blocks.map((b) => {
                    const hubNode =
                      graph.nodes.find((n) => n.id === b.hubId) || {
                        id: b.hubId,
                        name: "",
                      };
                    return (
                      <rect
                        key={`blk-${b.hubId}`}
                        x={b.minX}
                        y={b.minY}
                        width={b.w}
                        height={b.h}
                        rx={16}
                        fill={nodeColor(hubNode)}
                        fillOpacity={0.045}
                        stroke={nodeColor(hubNode)}
                        strokeOpacity={0.3}
                        strokeWidth={1}
                        strokeDasharray="4 5"
                      />
                    );
                  })
                : null}
              {/* ②a 簇内边：节点级（chip 之下；箭头止于 chip 边界）。 */}
              {graph.edges.map((e, i) => {
                const sa = layout?.sectorOf.get(e.source) ?? e.source;
                const sb = layout?.sectorOf.get(e.target) ?? e.target;
                if (sa !== sb) return null; // 跨簇边走下面的 hub 线层
                const a = posById.get(e.source);
                const b = posById.get(e.target);
                if (!a || !b) return null;
                const tb = sizeById.get(e.target) || { w: 44, h: 26 };
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.1);
                const ux = dx / d;
                const uy = dy / d;
                // 终点裁剪到目标 chip 矩形边界（+3px 间距），箭头不埋进 chip。
                const tx =
                  Math.abs(ux) > 1e-6 ? (tb.w / 2 + 3) / Math.abs(ux) : Infinity;
                const ty =
                  Math.abs(uy) > 1e-6 ? (tb.h / 2 + 3) / Math.abs(uy) : Infinity;
                const tEnd = Math.min(tx, ty, d);
                const x2 = b.x - ux * tEnd;
                const y2 = b.y - uy * tEnd;
                const active =
                  Boolean(selectedId) &&
                  (e.source === selectedId || e.target === selectedId);
                const dim = Boolean(selectedId) && !active;
                // 聚焦淡出：两端都在聚焦集内=全不透明，否则 0.12。
                const fdim =
                  inFocus(e.source) && inFocus(e.target) ? 1 : 0.12;
                return (
                  <line
                    key={i}
                    x1={a.x}
                    y1={a.y}
                    x2={x2}
                    y2={y2}
                    stroke={active ? GRAPH_ROOT_COLOR : t.border}
                    strokeOpacity={(active ? 0.9 : dim ? 0.08 : 0.5) * fdim}
                    strokeWidth={active ? 1.6 : 1}
                    markerEnd={
                      active
                        ? "url(#gvarrow-active)"
                        : "url(#gvarrow)"
                    }
                  />
                );
              })}
              {/* ②b 跨簇边：簇对去重后 hub→hub 块级单线（v4 毛球治理）。 */}
              {crossHubEdges.map(({ a, b, k }) => {
                const pa = posById.get(a);
                const pb = posById.get(b);
                if (!pa || !pb) return null;
                const hubA = graph.nodes.find((n) => n.id === a);
                const fdim = inFocus(a) && inFocus(b) ? 1 : 0.15;
                return (
                  <line
                    key={`x-${k}`}
                    x1={pa.x}
                    y1={pa.y}
                    x2={pb.x}
                    y2={pb.y}
                    stroke={hubA ? nodeColor(hubA) : t.border}
                    strokeOpacity={0.22 * fdim}
                    strokeWidth={1.4}
                  />
                );
              })}
              {/* ① 节点=矩形 chip（标签恒显，网格保证不重叠；hover=描边加粗）。 */}
              {graph.nodes.map((node) => {
                const p = posById.get(node.id);
                const s = sizeById.get(node.id);
                if (!p || !s) return null;
                const hub = hubSet.has(node.id);
                const hovered = hoverId === node.id;
                const selected = selectedId === node.id;
                const dim = dimmed(node.id);
                const fd = inFocus(node.id) ? 1 : 0.1;
                // P1：截断用 CJK 加权宽逐字累加估（与 chipWidth 同口径），
                // 不再一律 / FONT_W——否则 CJK 截断过晚、文字溢出 rect。
                let usedW = 0;
                let maxChars = 0;
                for (let ci = 0; ci < node.name.length; ci += 1) {
                  const cw = textWidthUnits(node.name[ci]);
                  if (usedW + cw > s.w - 14) break;
                  usedW += cw;
                  maxChars = ci + 1;
                }
                maxChars = Math.max(3, maxChars);
                const shown =
                  node.name.length > maxChars
                    ? `${node.name.slice(0, maxChars - 1)}…`
                    : node.name;
                return (
                  <g
                    key={node.id}
                    transform={`translate(${p.x},${p.y})`}
                    style={{
                      opacity: dim ? 0.24 : fd,
                      pointerEvents: "none",
                    }}
                  >
                    <rect
                      x={-s.w / 2}
                      y={-s.h / 2}
                      width={s.w}
                      height={s.h}
                      rx={s.h / 2}
                      fill={nodeColor(node)}
                      fillOpacity={
                        dim ? 0.06 : hovered || selected ? 0.32 : hub ? 0.22 : 0.13
                      }
                      stroke={
                        selected
                          ? GRAPH_ROOT_COLOR
                          : hovered
                            ? t.text
                            : nodeColor(node)
                      }
                      strokeOpacity={dim ? 0.15 : hovered || selected ? 1 : 0.75}
                      strokeWidth={selected ? 2 : hovered ? 1.8 : hub ? 1.4 : 1}
                    />
                    <text
                      y={4}
                      textAnchor="middle"
                      fontSize={hub ? 11.5 : 11}
                      fontWeight={hub || isDirect(node) ? 600 : 400}
                      fill={selected ? GRAPH_ROOT_COLOR : t.text}
                      style={{ paintOrder: "stroke" }}
                      stroke={t.cardBg}
                      strokeWidth={3}
                      strokeLinejoin="round"
                    >
                      {shown}
                    </text>
                    <title>{node.name}</title>
                  </g>
                );
              })}
            </svg>
            {panel}
          </div>
  );
}
