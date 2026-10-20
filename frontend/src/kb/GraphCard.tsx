// KB 图谱卡（QC-164 阶段 1 自 components/KnowledgeBase.tsx 纯搬移；
// 3D three.js 代码整体搬移、未动一行）。

import type * as ReactNS from "react";

import Graph3D from "../components/Graph3D";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { useWbViewport } from "../WbViewportContext";
import {
  EMPTY_POS_MAP,
  EMPTY_SIZE_MAP,
  clampZoomView,
  clusterGridLayout,
  focusView,
} from "./layout2d";
import type { FocusTarget, RadialView } from "./layout2d";
import type { GraphNodeLike } from "./types";
import {
  GRAPH_ROOT_COLOR,
  GRAPH_DIRECT_COLOR,
  GRAPH_FILE_LIGHT,
  GRAPH_FILE_DARK,
  buildGraphModel,
} from "./GraphCardShared";
import { GraphDetailPanel } from "./GraphCardPanel";
import { useGraphPanTouch } from "./GraphCardTouch";
import { Graph2DView } from "./GraphCardSvg2d";

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
  // 窄屏（容器 <800）降高：3D 480→300 / 2D 420→280——之前固定高在手机上
  // 占满整屏，页面无法滚动（15.21 批真机反馈）。
  const { narrow } = useWbViewport();
  const GRAPH_H = narrow ? 280 : 420;
  const GRAPH3D_H = narrow ? 300 : 480;
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
    if (Date.now() - lastTouchRef.current < 800) return; // 触屏拖动期间防 mouse 模拟
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
  // 点选语义（mouse click 与 touch tap 共用）：view 坐标。
  const selectAt = (vx: number, vy: number) => {
    const node = hitTestNode(vx, vy);
    hitNodeRef.current = node;
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
  const handleGraphClick = (e: React.MouseEvent<SVGSVGElement>) => {
    // v3：拖拽（平移）后的 click 不当事件处理。
    if (dragMovedRef.current) {
      dragMovedRef.current = false;
      return;
    }
    // 触屏 tap 后浏览器会补发 mouse 事件——touch 刚结束 800ms 内忽略，防双发。
    if (Date.now() - lastTouchRef.current < 800) return;
    const pt = clientToView(e.clientX, e.clientY);
    if (pt) selectAt(pt.x, pt.y);
  };
  // v4：双击=聚焦（hub=簇，非 hub=节点+一度邻接邻域）；单击语义不变。
  const handleGraphDblClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (Date.now() - lastTouchRef.current < 800) return; // 触屏双击走 tap 路径
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
  const lastTouchRef = React.useRef(0);
  const {
    onSvgPanDown,
    onSvgPanMove,
    onSvgPanUp,
    onSvgTouchStart,
    onSvgTouchMove,
    onSvgTouchEnd,
  } = useGraphPanTouch({
    dragRef,
    dragMovedRef,
    lastTouchRef,
    vbRef,
    svgRef,
    hitRafRef,
    panning,
    setPanning,
    setVb,
    cancelAnim,
    view,
    clientToView,
    hitTestNode,
    selectAt,
    applyFocus,
    hubSet,
  });
  const focusLabel = focus && graph
    ? (graph.nodes.find((nd) => (focus.kind === "sector" ? nd.id === focus.hubId : nd.id === focus.id))?.name ?? "簇")
    : "簇";
  const inFocus = (id: string): boolean => focusSet ? focusSet.has(id) : true;
  const model = React.useMemo(() => buildGraphModel(graph), [graph]);

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
    <GraphDetailPanel
      sel={sel}
      nodeColor={nodeColor}
      isRoot={isRoot}
      model={model}
      nameOf={nameOf}
      onOpenNode={onOpenNode}
      onPick={setSelectedId}
    />
  ) : null;

  return (
    <antd.Card
      size="small"
      title={
        <span style={{ fontSize: 13, maxWidth: "50%" }} title={tr("知识图谱（wikilink 引用网络）")}>
          {tr("知识图谱（wikilink 引用网络）")}
          {/* 窄屏隐藏节点/边计数：header 只留标题+切换钮，防 extra 被挤没。 */}
          {graph && !narrow ? (
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
          {/* 窄屏隐藏图例（挪到 2D body 内）：之前 extra 无 flexWrap，
              图例+Segmented+收起超手机屏宽 → Segmented（3D/2D 切换）
              被挤没，切 2D 后回不去 3D（15.21 批真机反馈）。 */}
          {!narrow ? (
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
          ) : null}
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
                height={GRAPH3D_H}
              />
              {panel}
            </>
          ) : (
          <Graph2DView
            graph={graph}
            layout={layout}
            posById={posById}
            sizeById={sizeById}
            crossHubEdges={crossHubEdges}
            nodeColor={nodeColor}
            hubSet={hubSet}
            isDirect={isDirect}
            hoverId={hoverId}
            selectedId={selectedId}
            setHoverId={setHoverId}
            dimmed={dimmed}
            inFocus={inFocus}
            vb={vb}
            panning={panning}
            view={view}
            focus={focus}
            focusLabel={focusLabel}
            infoNode={infoNode}
            legendEntries={legendEntries}
            agentLegend={agentLegend}
            narrow={narrow}
            GRAPH_H={GRAPH_H}
            svgRef={svgRef}
            hitNodeRef={hitNodeRef}
            dragRef={dragRef}
            setPanning={setPanning}
            setFocus={setFocus}
            animateTo={animateTo}
            applyFocus={applyFocus}
            zoomBy={zoomBy}
            onSvgPanDown={onSvgPanDown}
            onSvgPanMove={onSvgPanMove}
            onSvgPanUp={onSvgPanUp}
            handleGraphMove={handleGraphMove}
            handleGraphClick={handleGraphClick}
            handleGraphDblClick={handleGraphDblClick}
            onSvgTouchStart={onSvgTouchStart}
            onSvgTouchMove={onSvgTouchMove}
            onSvgTouchEnd={onSvgTouchEnd}
            panel={panel}
          />
          )
        )
      ) : null}
    </antd.Card>
  );
}
