// KB 图谱卡（QC-164 阶段 1 自 components/KnowledgeBase.tsx 纯搬移；
// 3D three.js 代码整体搬移、未动一行）。

import { TargetIcon } from "../components/icons";
import type * as ReactNS from "react";

import Graph3D from "../components/Graph3D";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import {
  EMPTY_POS_MAP,
  EMPTY_SIZE_MAP,
  clampZoomView,
  clusterGridLayout,
  focusView,
  textWidthUnits,
} from "./layout2d";
import type { FocusTarget, RadialView } from "./layout2d";
import type { GraphNodeLike } from "./types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

/** 图谱卡（本地/远端共用；对齐 QwenPaw 最新版
 * MemoryGraphView 视觉语言，2D 实现）：
 * - 三级节点色：根（虚拟分类根 virtual:*，橙 #FF7F16）/
 * 直接关联（根邻接，绿 #389E5C）/ 记忆文件（暖灰 #71665E，
 * 深色 #A29A92）——取自 QwenPaw 2.2 --graph-3d-* 调色板；
 * - 节点大小=链接度；≤42 节点全标注，否则 根+高度数+hover/选中；
 * - 点节点选中：邻接高亮、其余变暗，详情面板=入边/出边列表+打开文件；
 * - 边箭头=引用方向；图例=三级+方向。
 * 聚合图谱（agentLegend 提供）保留 按 Agent 着色。 */
const GRAPH_ROOT_COLOR = "#FF7F16"; // QwenPaw --graph-3d-root
const GRAPH_DIRECT_COLOR = "#389E5C"; // QwenPaw --graph-3d-direct
const GRAPH_FILE_LIGHT = "#71665E"; // QwenPaw --graph-3d-file
const GRAPH_FILE_DARK = "#A29A92";

type LinkRef = { id: string; anchor?: string | null };

interface GraphModel {
  rootIds: Set<string>;
  directIds: Set<string>;
  neighbors: Map<string, Set<string>>;
  inbound: Map<string, LinkRef[]>;
  outbound: Map<string, LinkRef[]>;
}

const GRAPH_H = 420;

// export=UI harness 测试缝（ui-harness-1322 ：选点持久性），非公共 API。
export function GraphCard(props: {
  graph: { nodes: GraphNodeLike[]; edges: { source: string; target: string; target_anchor?: string | null }[] } | null;
  loading: boolean;
  error: string;
  onOpenNode: (node: GraphNodeLike) => void;
  /** 聚合图谱按 Agent 着色（提供时覆盖三级配色+图例）。 */
  agentLegend?: { name: string; color: string }[] | null;
}) {
  const { graph, loading, error, onOpenNode, agentLegend } = props;
  const t = useThemeColors();
  const tr = useT();
  const [hoverId, setHoverId] = React.useState("");

  // 2D 图统一命中测试。svg 层 mousemove 测试（chip 矩形优先，其次 8px 外扩
  // 命中圈，归一化距离最近者胜），click 用同一测试 → 所见即所点。
  // v4 网格布局下 chip 互不重叠，矩形判定无歧义。
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const hitNodeRef = React.useRef<GraphNodeLike | null>(null);
  const hitRafRef = React.useRef(0);
  const clientToView = (cx: number, cy: number) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    return new DOMPoint(cx, cy).matrixTransform(ctm.inverse());
  };
  const hitTestNode = (x: number, y: number): GraphNodeLike | null => {
    if (!graph) return null;
    let vis: { node: GraphNodeLike; d: number } | null = null;
    let ext: { node: GraphNodeLike; d: number } | null = null;
    for (const node of graph.nodes) {
      const p = posById.get(node.id);
      const s = sizeById.get(node.id);
      if (!p || !s) continue;
      const dx = Math.abs(x - p.x);
      const dy = Math.abs(y - p.y);
      const hw = s.w / 2;
      const hh = s.h / 2;
      if (dx <= hw && dy <= hh) {
        const d = Math.max(dx / hw, dy / hh);
        if (!vis || d < vis.d) vis = { node, d };
      } else if (dx <= hw + 8 && dy <= hh + 8) {
        const d = Math.max(dx / (hw + 8), dy / (hh + 8));
        if (!ext || d < ext.d) ext = { node, d };
      }
    }
    return (vis || ext)?.node || null;
  };
  const handleGraphMove = (e: React.MouseEvent<SVGSVGElement>) => {
    // 12.12：拖拽中悬停停更（平移由 onSvgPanMove 处理——原实现 move 未接线，
    // 「鼠标无法拖动」根因）。
    if (dragRef.current) return;
    const cx = e.clientX;
    const cy = e.clientY;
    cancelAnimationFrame(hitRafRef.current);
    hitRafRef.current = requestAnimationFrame(() => {
      const pt = clientToView(cx, cy);
      if (!pt) return;
      const hit = hitTestNode(pt.x, pt.y);
      hitNodeRef.current = hit;
      setHoverId((prev) =>
        prev === (hit ? hit.id : "") ? prev : hit ? hit.id : "",
      );
      if (svgRef.current) {
        svgRef.current.style.cursor = hit
          ? isRoot(hit)
            ? "default"
            : "pointer"
          : "default";
      }
    });
  };
  const handleGraphClick = (e: React.MouseEvent<SVGSVGElement>) => {
    // v3：拖拽（平移）后的 click 不当事件处理。
    if (dragMovedRef.current) {
      dragMovedRef.current = false;
      return;
    }
    const pt = clientToView(e.clientX, e.clientY);
    if (pt) hitNodeRef.current = hitTestNode(pt.x, pt.y);
    const node = hitNodeRef.current;
    if (!node) {
      setSelectedId("");
      if (focusRef.current) applyFocus(null); // 点空白=退出聚焦
      return;
    }
    if (hubSet.has(node.id)) {
      // v4：hub（簇根，可能为非 virtual 的高度数文件）单击=簇聚焦；
      // 其余节点单击=开预览（virtual 根非 hub 时也走预览，不再特殊）。
      setSelectedId(node.id);
      applyFocus({ kind: "sector", hubId: node.id });
      return;
    }
    // （设计结论）：已选中
    // 节点再点=不操作（不刷新、不取消）——连点只会在旧语义下反复重取。
    // 取消选中统一走点空白（svg 背景）。
    if (selectedId === node.id) return;
    setSelectedId(node.id);
    onOpenNode(node);
  };
  // v4：双击=聚焦（hub=簇，非 hub=节点+一度邻接邻域）；单击语义不变。
  const handleGraphDblClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const pt = clientToView(e.clientX, e.clientY);
    if (!pt) return;
    const node = hitTestNode(pt.x, pt.y);
    if (!node) return;
    applyFocus(
      hubSet.has(node.id) ? { kind: "sector", hubId: node.id } : { kind: "node", id: node.id },
    );
  };
  const [selectedId, setSelectedId] = React.useState("");
  const [graphVisible, setGraphVisible] = React.useState(true);
  // 2D/3D 视图切换（默认 3D，对齐 QwenPaw 2.2 知识库体验；
  // 偏好持久化 graph-view-mode）。
  const [viewMode, setViewMode] = React.useState<"2d" | "3d">(() => {
    try {
      return localStorage.getItem("graph-view-mode") === "2d"
        ? "2d"
        : "3d";
    } catch {
      return "3d";
    }
  });
  const switchViewMode = React.useCallback(
    (m: "2d" | "3d") => {
      setViewMode(m);
      try {
        localStorage.setItem("graph-view-mode", m);
      } catch {
        /* noop */
      }
    },
    [],
  );
  const fileColor =
    t.mode === "dark" ? GRAPH_FILE_DARK : GRAPH_FILE_LIGHT;

  React.useEffect(() => {
    setHoverId("");
    if (!graph) {
      setSelectedId("");
      return;
    }
 // // 旧实现 graph 引用一变就清 selectedId——聚合（merged）模式的 graph
    // prop 是每次 render 新建的对象字面量（点节点→openFile→父侧 3 次
    // state 更新→3 次新引用）→ 高亮闪一帧即被清除。正确语义=只在选中
    // 节点在新图中不存在时清除（切 Agent/重拉）；同图同形重渲染保持选中。
    setSelectedId((prev) =>
      prev && !graph.nodes.some((n) => n.id === prev) ? "" : prev,
    );
  }, [graph]);

  const layout = React.useMemo(() => {
    if (!graph) return null;
    const pairs = graph.edges.map(
      (e) => [e.source, e.target] as [string, string],
    );
    const order = agentLegend ? agentLegend.map((l) => l.name) : undefined;
    return clusterGridLayout(graph.nodes, pairs, order);
  }, [graph, agentLegend]);
  const posById = layout?.pos ?? EMPTY_POS_MAP;
  const sizeById = layout?.size ?? EMPTY_SIZE_MAP;
  const view: RadialView = layout?.view ?? {
    minX: -450,
    minY: -210,
    width: 900,
    height: 420,
  };

  // ── 2D v3：缩放/平移 + 聚焦 + 簇分离（dashboard knowledge-section v3 同算法）──
  const [vb, setVb] = React.useState<RadialView>(view);
  const [focus, setFocus] = React.useState<FocusTarget | null>(null);
  const [panning, setPanning] = React.useState(false);
 // （P1「空白处可拖动整个画板」）：pan 本身 beta.12.8 已有
  //（整 SVG mousedown + 4px 阈值），但无 cursor 提示 → 用户不知道可拖。
  // grab/grabbing 双态给可发现性。
  const vbRef = React.useRef(vb);
  const focusRef = React.useRef(focus);
  const animRafRef = React.useRef(0);
  const dragRef = React.useRef<{ startX: number; startY: number; vb0: RadialView; moved: boolean } | null>(null);
  const dragMovedRef = React.useRef(false);
  // 布局换图（切 Agent/聚合）→ 重置缩放与聚焦（render 阶段状态调整，
  // React「adjusting state when props change」模式）。
  const layoutSig = layout
    ? `${layout.view.minX},${layout.view.minY},${layout.view.width},${layout.view.height}#${layout.pos.size}`
    : "none";
  const [layoutSigRef, setLayoutSigRef] = React.useState(layoutSig);
  if (layoutSig !== layoutSigRef) {
    setLayoutSigRef(layoutSig);
    setVb(view);
    setFocus(null);
  }
  React.useEffect(() => { vbRef.current = vb; });
  React.useEffect(() => { focusRef.current = focus; });
  const cancelAnim = React.useCallback(() => {
    if (animRafRef.current) cancelAnimationFrame(animRafRef.current);
    animRafRef.current = 0;
  }, []);
  const animateTo = React.useCallback((target: RadialView, ms = 320) => {
    cancelAnim();
    const from = { ...vbRef.current };
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      const e = 1 - Math.pow(1 - k, 3); // easeOutCubic
      setVb({
        minX: from.minX + (target.minX - from.minX) * e,
        minY: from.minY + (target.minY - from.minY) * e,
        width: from.width + (target.width - from.width) * e,
        height: from.height + (target.height - from.height) * e,
      });
      if (k < 1) animRafRef.current = requestAnimationFrame(step);
    };
    animRafRef.current = requestAnimationFrame(step);
  }, [cancelAnim]);
  React.useEffect(() => cancelAnim, [cancelAnim]);
  const hubSet = React.useMemo(
    () => new Set(layout?.hubs && layout.hubs.length > 0 ? layout.hubs : []),
    [layout],
  );
  // 聚焦集：扇区=全成员；节点=节点+一度邻接。
  const focusSet = React.useMemo<Set<string> | null>(() => {
    if (!focus || !graph) return null;
    const s = new Set<string>();
    if (focus.kind === "sector") {
      graph.nodes.forEach((nd) => {
        if ((layout?.sectorOf.get(nd.id) ?? nd.id) === focus.hubId) s.add(nd.id);
      });
      if (s.size === 0) s.add(focus.hubId);
    } else {
      s.add(focus.id);
      graph.edges.forEach((e) => {
        if (e.source === focus.id) s.add(e.target);
        if (e.target === focus.id) s.add(e.source);
      });
    }
    return s;
  }, [focus, graph, layout]);
  // 跨簇边收敛：同簇对只画一条 hub→hub 线（块-块语义），簇内边=节点级。
  const crossHubEdges = React.useMemo(() => {
    const out: { a: string; b: string; k: string }[] = [];
    if (!graph || !layout) return out;
    const seen = new Set<string>();
    graph.edges.forEach((e) => {
      const sa = layout.sectorOf.get(e.source) ?? e.source;
      const sb = layout.sectorOf.get(e.target) ?? e.target;
      if (sa === sb) return;
      const key = sa < sb ? `${sa}|${sb}` : `${sb}|${sa}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ a: sa, b: sb, k: key });
    });
    return out;
  }, [graph, layout]);
  const applyFocus = React.useCallback((target: FocusTarget | null) => {
    cancelAnim();
    setFocus(target);
    if (!target || !graph || !layout) {
      animateTo(view, 320);
      return;
    }
    const ids = new Set<string>();
    if (target.kind === "sector") {
      graph.nodes.forEach((nd) => {
        if ((layout.sectorOf.get(nd.id) ?? nd.id) === target.hubId) ids.add(nd.id);
      });
    } else {
      ids.add(target.id);
      graph.edges.forEach((e) => {
        if (e.source === target.id) ids.add(e.target);
        if (e.target === target.id) ids.add(e.source);
      });
    }
    const pts = [...ids]
      .map((id) => layout.pos.get(id))
      .filter((p): p is { x: number; y: number } => Boolean(p));
    animateTo(focusView(pts) ?? view, 320);
  }, [graph, layout, view, animateTo, cancelAnim]);
  // Esc 退出聚焦。
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && focusRef.current) applyFocus(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applyFocus]);
  // wheel 缩放：原生 non-passive（React 合成 onWheel 为 passive，preventDefault 无效）。
  React.useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cancelAnim();
      const vb0 = vbRef.current;
      const factor = e.deltaY < 0 ? 1 / 1.18 : 1.18;
      let ax = vb0.minX + vb0.width / 2;
      let ay = vb0.minY + vb0.height / 2;
      const pt = clientToView(e.clientX, e.clientY);
      if (pt) { ax = pt.x; ay = pt.y; }
      const w1 = vb0.width * factor;
      const h1 = vb0.height * factor;
      const fx = (ax - vb0.minX) / vb0.width;
      const fy = (ay - vb0.minY) / vb0.height;
      setVb(clampZoomView({ minX: ax - fx * w1, minY: ay - fy * h1, width: w1, height: h1 }, view));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
    // viewMode 入依赖：默认 3D 时 2D svg 未挂载，effect 首跑空跑；
 // 切到 2D 后必须重跑才挂上监听（R12 插件没有滚轮缩放根因）。
  }, [view, cancelAnim, viewMode]);
  const zoomBy = React.useCallback((factor: number) => {
    const vb0 = vbRef.current;
    const w1 = vb0.width * factor;
    const h1 = vb0.height * factor;
    const cx = vb0.minX + vb0.width / 2;
    const cy = vb0.minY + vb0.height / 2;
    animateTo(clampZoomView({ minX: cx - w1 / 2, minY: cy - h1 / 2, width: w1, height: h1 }, view), 160);
  }, [animateTo, view]);
  // 拖拽平移（位移 <4px 视为单击，click 处理保留）。
  const onSvgPanDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    cancelAnim();
    cancelAnimationFrame(hitRafRef.current); // 12.12：拖拽优先，停掉悬停 rAF
    dragRef.current = { startX: e.clientX, startY: e.clientY, vb0: { ...vbRef.current }, moved: false };
    dragMovedRef.current = false;
  };
  const onSvgPanMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    dragMovedRef.current = true;
    const svg = svgRef.current;
    if (!svg) return;
    let scale = d.vb0.width / Math.max(1, svg.getBoundingClientRect().width);
    const ctm = svg.getScreenCTM && svg.getScreenCTM();
    if (ctm && ctm.a) scale = 1 / ctm.a;
    if (!panning) setPanning(true);
    setVb({ ...d.vb0, minX: d.vb0.minX - dx * scale, minY: d.vb0.minY - dy * scale });
  };
  const onSvgPanUp = () => {
    dragRef.current = null;
    setPanning(false);
  };
  const focusLabel = focus && graph
    ? (graph.nodes.find((nd) => (focus.kind === "sector" ? nd.id === focus.hubId : nd.id === focus.id))?.name ?? "簇")
    : "簇";
  const inFocus = (id: string): boolean => focusSet ? focusSet.has(id) : true;
  const model = React.useMemo((): GraphModel | null => {
    if (!graph) return null;
    const rootIds = new Set(
      graph.nodes
        .filter((n) => n.id.startsWith("virtual:"))
        .map((n) => n.id),
    );
    const directIds = new Set<string>();
    const neighbors = new Map<string, Set<string>>();
    const inbound = new Map<string, LinkRef[]>();
    const outbound = new Map<string, LinkRef[]>();
    const seenIO = new Set<string>();
    graph.edges.forEach((e) => {
      if (rootIds.has(e.source)) directIds.add(e.target);
      if (!neighbors.has(e.source)) neighbors.set(e.source, new Set());
      neighbors.get(e.source)!.add(e.target);
      if (!neighbors.has(e.target)) neighbors.set(e.target, new Set());
      neighbors.get(e.target)!.add(e.source);
      const ikey = `${e.source}\u0000${e.target}\u0000${e.target_anchor ?? ""}`;
      if (!seenIO.has(`o:${ikey}`)) {
        seenIO.add(`o:${ikey}`);
        if (!outbound.has(e.source)) outbound.set(e.source, []);
        outbound.get(e.source)!.push({ id: e.target, anchor: e.target_anchor });
      }
      if (!seenIO.has(`i:${ikey}`)) {
        seenIO.add(`i:${ikey}`);
        if (!inbound.has(e.target)) inbound.set(e.target, []);
        inbound.get(e.target)!.push({ id: e.source, anchor: e.target_anchor });
      }
    });
    return { rootIds, directIds, neighbors, inbound, outbound };
  }, [graph]);

  const nameOf = (id: string): string =>
    graph?.nodes.find((n) => n.id === id)?.name || id;
  const isRoot = (n: GraphNodeLike): boolean =>
    n.id.startsWith("virtual:");
  const isDirect = (n: GraphNodeLike): boolean =>
    Boolean(model?.directIds.has(n.id));
  const sel = selectedId
    ? (graph?.nodes.find((n) => n.id === selectedId) || null)
    : null;
  const selNeighbors =
    selectedId && model ? model.neighbors.get(selectedId) : undefined;
  const dimmed = (id: string): boolean =>
    Boolean(selectedId) && id !== selectedId && !selNeighbors?.has(id);

  const nodeColor = (node: GraphNodeLike): string => {
    if (agentLegend && node.agent) {
      return (
        agentLegend.find((l) => l.name === node.agent)?.color || "#8c8c8c"
      );
    }
    if (isRoot(node)) return GRAPH_ROOT_COLOR;
    if (isDirect(node)) return GRAPH_DIRECT_COLOR;
    return fileColor;
  };

  const legendEntries: { key: string; label: string; color: string }[] =
    agentLegend
      ? agentLegend.map((l) => ({
          key: l.name,
          label: l.name,
          color: l.color,
        }))
      : [
          { key: "root", label: tr("分类根"), color: GRAPH_ROOT_COLOR },
          {
            key: "direct",
            label: tr("根邻接"),
            color: GRAPH_DIRECT_COLOR,
          },
          { key: "file", label: tr("记忆文件"), color: fileColor },
        ];

  const hoverNode = hoverId
    ? (graph?.nodes.find((n) => n.id === hoverId) || null)
    : null;
  const infoNode = hoverNode || sel;

  const panel = sel ? (

              <div
                style={{
                  marginTop: 8,
                  border: `1px solid ${t.border}`,
                  borderRadius: 8,
                  padding: "8px 12px",
                  background: t.hoverBg,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 6,
                  }}
                >
                  <span
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: "50%",
                      background: nodeColor(sel),
                      display: "inline-block",
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      fontSize: 10.5,
                      lineHeight: "18px",
                      padding: "0 7px",
                      borderRadius: 9,
                      border: `1px solid ${
                        isRoot(sel)
                          ? "#722ed1"
                          : sel.resolved === false
                          ? "#faad14"
                          : "#52c41a"
                      }`,
                      color: isRoot(sel)
                        ? "#722ed1"
                        : sel.resolved === false
                        ? "#faad14"
                        : "#52c41a",
                      flexShrink: 0,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {isRoot(sel)
                      ? tr("分类根")
                      : sel.resolved === false
                      ? tr("未解析链接")
                      : tr("已索引文件")}
                  </span>
                  <span
                    style={{ fontWeight: 600, fontSize: 12.5 }}
                    title={sel.id}
                  >
                    {sel.name}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      color: t.textSecondary,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {sel.id}
                  </span>
                  <span style={{ flex: 1 }} />
                  {!isRoot(sel) && sel.resolved !== false ? (
                    <antd.Button
                      size="small"
                      onClick={() => onOpenNode(sel)}
                    >
                      {tr("打开 Markdown")}
                    </antd.Button>
                  ) : null}
                  <antd.Button
                    size="small"
                    type="text"
                    onClick={() => setSelectedId("")}
                  >
                    {tr("关闭")}
                  </antd.Button>
                </div>
                {sel.description ? (
                  <div
                    style={{
                      fontSize: 12,
                      color: t.textSecondary,
                      marginBottom: 6,
                    }}
                  >
                    {sel.description}
                  </div>
                ) : null}
                <div
                  style={{
                    display: "flex",
                    gap: 24,
                    flexWrap: "wrap",
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: 11,
                        color: t.textSecondary,
                        marginBottom: 3,
                      }}
                    >
                      {tr("出链 · {n}", {
                        n: (model?.outbound.get(sel.id) || []).length,
                      })}
                    </div>
                    {(model?.outbound.get(sel.id) || []).map((it) => (
                      <div
                        key={`${it.id}:${it.anchor ?? ""}`}
                        onClick={() => setSelectedId(it.id)}
                        style={{
                          cursor: "pointer",
                          fontSize: 12,
                          lineHeight: "20px",
                        }}
                        title={it.id}
                    >
                      {nameOf(it.id)} →
                        {it.anchor ? (
                          <span
                            style={{
                              fontSize: 11,
                              color: t.textSecondary,
                            }}
                          >
                            #{it.anchor}
                          </span>
                        ) : null}
                    </div>
                    ))}
                  </div>
                  <div>
                    <div
                      style={{
                        fontSize: 11,
                        color: t.textSecondary,
                        marginBottom: 3,
                      }}
                    >
                      {tr("入链 · {n}", {
                        n: (model?.inbound.get(sel.id) || []).length,
                      })}
                    </div>
                    {(model?.inbound.get(sel.id) || []).map((it) => (
                      <div
                        key={it.id}
                        onClick={() => setSelectedId(it.id)}
                        style={{
                          cursor: "pointer",
                          fontSize: 12,
                          lineHeight: "20px",
                        }}
                        title={it.id}
                      >
                        ← {nameOf(it.id)}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

  ) : null;

  return (
    <antd.Card
      size="small"
      title={
        <span style={{ fontSize: 13 }}>
          {tr("知识图谱（wikilink 引用网络）")}
          {graph ? (
            <antd.Typography.Text
              type="secondary"
              style={{ fontSize: 12, marginLeft: 8 }}
            >
              {tr("N 节点 · M 边")
                .replace("N", String(graph.nodes.length))
                .replace("M", String(graph.edges.length))}
            </antd.Typography.Text>
          ) : null}
        </span>
      }
      extra={
        <antd.Space size={8}>
          <antd.Space size={10} style={{ fontSize: 11 }}>
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
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 3,
                  color: t.textSecondary,
                }}
              >
                → {tr("引用方向")}
              </span>
            ) : null}
          </antd.Space>
          <antd.Segmented
            size="small"
            value={viewMode}
            onChange={(v: string | number) =>
              switchViewMode(v === "2d" ? "2d" : "3d")}
            options={[
              { label: "3D", value: "3d" },
              { label: "2D", value: "2d" },
            ]}
          />
          <antd.Button
            size="small"
            type="link"
            onClick={() => setGraphVisible((v) => !v)}
          >
            {graphVisible ? tr("收起") : tr("展开")}
          </antd.Button>
        </antd.Space>
      }
    >
      {error ? (
        <antd.Alert type="error" showIcon message={error} />
      ) : null}
      {graphVisible ? (
        loading ? (
          <antd.Spin style={{ display: "block", margin: "60px auto" }} />
        ) : !graph || graph.nodes.length === 0 ? (
          <antd.Empty
            image={antd.Empty.PRESENTED_IMAGE_SIMPLE}
            description={tr("暂无图谱数据")}
            style={{ margin: "40px 0" }}
          />
        ) : (
          viewMode === "3d" ? (
            <>
              <Graph3D
                nodes={graph.nodes}
                links={graph.edges}
                colorFor={nodeColor}
                isRoot={isRoot}
                isDirect={isDirect}
                onOpenNode={onOpenNode}
                onExit3D={() => switchViewMode("2d")}
                onSelect={setSelectedId}
              />
              {panel}
            </>
          ) : (
          <div style={{ position: "relative" }}>
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
          )
        )
      ) : null}
    </antd.Card>
  );
}
