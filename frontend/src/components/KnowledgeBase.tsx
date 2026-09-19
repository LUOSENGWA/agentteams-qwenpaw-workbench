import type * as ReactNS from "react";

import {
  fetchAgentIdList,
  fetchKbAgents,
  fetchKbDir,
  fetchKbFile,
  fetchKbGraph,
  fetchKbGraphMerged,
  fetchKbSearch,
  fetchKbTree,
  fetchTeamsStructure,
  type KbSearchMatch,
  fetchMemoryGraph,
  fetchMemoryStatus,
  listMemoryFiles,
  loadMemoryFile,
  reindexMemory,
  type KbAgent,
  type KbDirItem,
  type KbFileItem,
  type MemoryFileItem,
  type MemoryGraphNode,
  type MemorySection,
  type MemoryStatusResponse,
  type WorkerTreeTeam,
} from "../api";
import Graph3D from "./Graph3D";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import MdText from "./MdText";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

/** 本地（宿主）分类配色。 */
const SECTION_COLOR: Record<string, string> = {
  daily: "#1677ff",
  "digest/personal": "#52c41a",
  "digest/procedure": "#fa8c16",
  "digest/wiki": "#722ed1",
  virtual: "#8c8c8c",
};

/** 远端（团队 Agent）分类配色。 */
const REMOTE_CAT_COLOR: Record<string, string> = {
  profile: "#FF7F16",
  soul: "#f5222d",
  agents: "#52c41a",
  memory: "#1677ff",
  other: "#8c8c8c",
  virtual: "#bfbfbf",
};

const GRAPH_H = 420;
const EMPTY_POS_MAP = new Map<string, { x: number; y: number }>();
const EMPTY_SIZE_MAP = new Map<string, { w: number; h: number }>();

interface GraphNodeLike {
  id: string;
  name: string;
  virtual?: boolean;
  category?: string;
  /** false=未解析引用（文件不存在，不可点开）。 */
  resolved?: boolean;
  /** v0.5.0-beta.12 ：聚合图谱节点归属 Agent（agent::path 前缀）。 */
  agent?: string;
  section?: "daily" | "digest" | null;
  relative_path?: string | null;
  path?: string;
  description?: string;
}



// ── 2D v4：簇块网格布局 + 缩放/聚焦纯函数（dashboard knowledge-section
// clusterGridLayout 同算法同值——双端 2D 图谱观感一致）。
// v3（扇区+深度环）问题：簇多/环深时节点互叠成毛球、标签压盖看不清；
// 无 virtual 根时 top-3 度数 hub 把单连通簇切碎成 3 扇区（边被误判跨簇）。
// v4 = 簇矩形块：簇=连通分量（聚合模式=agent 字段），hub=簇内首个 virtual 根
// 或最高度数文件；hub 横幅置块顶 + 成员网格（depth 升序→name 升序），
// 块间大留白，标签水平直排永不重叠（网格保证）。纯函数、无 Math.random。
interface RadialView { minX: number; minY: number; width: number; height: number }

/** 簇块包围盒（渲染虚线框 + 聚焦视野）。 */
export interface ClusterBlock { hubId: string; minX: number; minY: number; w: number; h: number }

// 几何常量（双端同值——dashboard 镜像时逐字对齐，勿单端调参）。
export const KB2D = {
  CHIP_H: 26,        // 成员节点 chip 高
  HUB_H: 34,         // hub（簇横幅）chip 高
  CHIP_PAD_X: 12,    // chip 左右内边距（各）
  FONT_W: 6.2,       // 11px 字体拉丁平均字宽
  FONT_W_CJK: 11,    // 11px 字体 CJK 全角字宽（= 字号，1:1）
  MIN_W: 44,
  MAX_W: 180,
  GAP_X: 16,         // 簇内网格列距
  GAP_Y: 14,         // 簇内网格行距
  HUB_GAP_Y: 12,     // hub 与成员网格间距
  BLOCK_GAP_X: 88,   // 簇块间横向留白（「分开簇」）
  BLOCK_GAP_Y: 72,   // 簇块间纵向留白
  ROW_MAX_W: 1560,   // 块流式换行阈值
  PAD: 64,           // 视野留白
} as const;

/** 聚焦目标：簇（hub 块）或单节点邻域。 */
export type FocusTarget = { kind: "sector"; hubId: string } | { kind: "node"; id: string };

/** 一组点的包围盒 + 留白（聚焦视野）。空集 → null。 */
export function focusView(points: Array<{ x: number; y: number }>, pad = 70): RadialView | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX: minX - pad, minY: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
}

/** 缩放钳制：zoom = fit.width / vb.width ∈ [minZoom, maxZoom]，越界以视野中心为锚回缩。 */
export function clampZoomView(
  vb: RadialView,
  fit: RadialView,
  minZoom = 0.25,
  maxZoom = 8,
): RadialView {
  const zoom = fit.width / vb.width;
  if (zoom >= minZoom && zoom <= maxZoom) return vb;
  const target = zoom < minZoom ? minZoom : maxZoom;
  const width = fit.width / target;
  const cx = vb.minX + vb.width / 2;
  const cy = vb.minY + vb.height / 2;
  return { minX: cx - width / 2, minY: cy - (vb.height * (width / vb.width)) / 2, width, height: vb.height * (width / vb.width) };
}

/** chip 宽：按 name 估宽，钳制 [MIN_W, MAX_W]。 */
/** CJK 加权文本像素宽（11px 字体：CJK/全角 ≈ 字号，拉丁 ≈ FONT_W）。
 *  装验反馈 9/19（P1「簇不要重叠」）：原先 label.length * FONT_W 一律宽，
 *  中文文件名 chip 被严重低估 → 长中文名 chip 横向溢出与邻居压盖。
 *  chipWidth 与标签截断共用（同一估宽，避免两端口径漂移）。 */
export function textWidthUnits(label: string): number {
  let units = 0;
  for (const ch of label) {
    units += /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/.test(ch)
      ? KB2D.FONT_W_CJK
      : KB2D.FONT_W;
  }
  return units;
}

export function chipWidth(label: string): number {
  const w = textWidthUnits(label) + KB2D.CHIP_PAD_X * 2;
  return Math.min(KB2D.MAX_W, Math.max(KB2D.MIN_W, Math.round(w)));
}

export interface ClusterLayout {
  /** 节点 id → chip 中心。 */
  pos: Map<string, { x: number; y: number }>;
  /** 节点 id → chip 尺寸（渲染 rect）。 */
  size: Map<string, { w: number; h: number }>;
  /** 节点 id → 所属簇 hub 的节点 id。 */
  sectorOf: Map<string, string>;
  /** 簇 hub 的节点 id 列表（顺序=簇顺序）。 */
  hubs: string[];
  /** 簇块包围盒（虚线框 + 聚焦）。 */
  blocks: ClusterBlock[];
  /** 自适应视野。 */
  view: RadialView;
}

export function clusterGridLayout(
  nodes: GraphNodeLike[],
  edgePairs: Array<[string, string]>,
  agentOrder?: string[],
): ClusterLayout {
  const n = nodes.length;
  const empty: ClusterLayout = {
    pos: new Map(),
    size: new Map(),
    sectorOf: new Map(),
    hubs: [],
    blocks: [],
    view: { minX: -450, minY: -210, width: 900, height: 420 },
  };
  if (n === 0) return empty;
  const idxOf = new Map<string, number>(nodes.map((nd, i) => [nd.id, i]));
  const adj: number[][] = Array.from({ length: n }, () => []);
  const deg = new Array<number>(n).fill(0);
  for (const [a, b] of edgePairs) {
    const i = idxOf.get(a);
    const j = idxOf.get(b);
    if (i == null || j == null || i === j) continue;
    adj[i].push(j); adj[j].push(i); deg[i] += 1; deg[j] += 1;
  }
  // 1) 簇 = 连通分量（v4 语义：一块=一个连通簇）。
  //    聚合模式例外：簇按 agent 字段划分（Agent 块），不被跨 Agent 链接切碎。
  const isVirtual = (nd: GraphNodeLike): boolean =>
    Boolean(nd.virtual) || nd.id.startsWith("virtual:");
  const degRank = (x: number, y: number) =>
    // 降序：最高度数优先（hub=簇内最连接文件）。v3 的 deg[x]-deg[y] 是升序，
    // hub 会取到最低度叶子——R12 冒烟 T1 抓出，双端同修。
    deg[y] - deg[x] || nodes[x].name.localeCompare(nodes[y].name) || x - y;
  const sectorIdx = new Array<number>(n).fill(-1);
  const sectors: { hub: number }[] = [];
  if (agentOrder && agentOrder.length > 0) {
    agentOrder.forEach((agent, si) => {
      const members: number[] = [];
      nodes.forEach((nd, i) => { if (nd.agent === agent) members.push(i); });
      if (members.length === 0) return;
      let hub = -1;
      for (const i of members) if (isVirtual(nodes[i])) { hub = i; break; }
      if (hub < 0) { members.sort(degRank); hub = members[0]; }
      sectors.push({ hub });
      nodes.forEach((nd, i) => { if (nd.agent === agent) sectorIdx[i] = si; });
    });
  } else {
    // 连通分量（按最小节点序确定顺序）→ 每分量一个簇：
    // hub = 分量内 virtual 根（首个）；无 virtual → 分量内最高度数节点。
    const comp = new Array<number>(n).fill(-1);
    let ci = 0;
    for (let s = 0; s < n; s += 1) {
      if (comp[s] !== -1) continue;
      const queue = [s];
      comp[s] = ci;
      let head = 0;
      while (head < queue.length) {
        const u = queue[head];
        head += 1;
        for (const v of adj[u]) if (comp[v] === -1) { comp[v] = ci; queue.push(v); }
      }
      ci += 1;
    }
    for (let c = 0; c < ci; c += 1) {
      const members: number[] = [];
      for (let i = 0; i < n; i += 1) if (comp[i] === c) members.push(i);
      let hub = -1;
      for (const i of members) if (isVirtual(nodes[i])) { hub = i; break; }
      if (hub < 0) { members.sort(degRank); hub = members[0]; }
      sectors.push({ hub });
      members.forEach((i) => { sectorIdx[i] = sectors.length - 1; });
    }
  }
  if (sectors.length === 0) sectors.push({ hub: 0 });
  // 未归属节点（agent 不在列表/陈旧数据）→ 挂末簇，不丢点。
  nodes.forEach((_, i) => { if (sectorIdx[i] === -1) sectorIdx[i] = sectors.length - 1; });
  const depth = new Array<number>(n).fill(-1);
  {
    const queue: number[] = [];
    sectors.forEach((s) => { depth[s.hub] = 0; queue.push(s.hub); });
    let head = 0;
    while (head < queue.length) {
      const u = queue[head];
      head += 1;
      for (const v of adj[u]) {
        if (depth[v] === -1) { depth[v] = depth[u] + 1; queue.push(v); }
      }
    }
    for (let i = 0; i < n; i += 1) if (depth[i] === -1) depth[i] = 1;
  }
  // 2) 逐簇排块：hub 横幅置顶 + 成员网格（depth 升序 → name 升序，确定性）。
  const pos = new Map<string, { x: number; y: number }>();
  const size = new Map<string, { w: number; h: number }>();
  const sectorOf = new Map<string, string>();
  interface PlacedBlock { hub: number; members: number[]; w: number; h: number; hubW: number }
  const colsOf = (m: number): number =>
    m <= 1 ? 1 : m <= 3 ? 2 : m <= 8 ? 3 : m <= 15 ? 4 : m <= 24 ? 5 : 6;
  const placed: PlacedBlock[] = sectors.map((s) => {
    const members: number[] = [];
    for (let i = 0; i < n; i += 1) {
      if (sectorIdx[i] === sectors.indexOf(s) && i !== s.hub) members.push(i);
    }
    members.sort((x, y) => depth[x] - depth[y] || nodes[x].name.localeCompare(nodes[y].name) || x - y);
    const m = members.length;
    const cols = colsOf(m);
    const rows = Math.ceil(m / cols);
    const widths = members.map((i) => chipWidth(nodes[i].name));
    const cellW = widths.length > 0 ? Math.max(...widths) : 0;
    const hubW = chipWidth(nodes[s.hub].name);
    const gridW = cols * cellW + (cols - 1) * KB2D.GAP_X;
    const w = Math.max(gridW, hubW);
    const h = KB2D.HUB_H + KB2D.HUB_GAP_Y + (rows > 0 ? rows * KB2D.CHIP_H + (rows - 1) * KB2D.GAP_Y : 0);
    return { hub: s.hub, members, w, h, hubW };
  });
  // 3) 块流式布局（按簇顺序，超 ROW_MAX_W 换行，行内整体居中）。
  const rowsBlocks: PlacedBlock[][] = [];
  {
    let row: PlacedBlock[] = [];
    let rowW = 0;
    for (const b of placed) {
      const need = row.length === 0 ? b.w : rowW + KB2D.BLOCK_GAP_X + b.w;
      if (row.length > 0 && need > KB2D.ROW_MAX_W) {
        rowsBlocks.push(row);
        row = [b];
        rowW = b.w;
      } else {
        row.push(b);
        rowW = need;
      }
    }
    if (row.length > 0) rowsBlocks.push(row);
  }
  rowsBlocks.forEach((row, ri) => {
    const rowW = row.reduce((acc, b) => acc + b.w, 0) + (row.length - 1) * KB2D.BLOCK_GAP_X;
    let x = -rowW / 2;
    const yTop = ri * (Math.max(...row.map((b) => b.h)) + KB2D.BLOCK_GAP_Y);
    for (const b of row) {
      // 行内块顶对齐（hub 横幅一条线，最直观）。
      const cx = x + b.w / 2;
      const hubY = yTop + KB2D.HUB_H / 2;
      pos.set(nodes[b.hub].id, { x: cx, y: hubY });
      size.set(nodes[b.hub].id, { w: b.hubW, h: KB2D.HUB_H });
      sectorOf.set(nodes[b.hub].id, nodes[b.hub].id);
      const m = b.members.length;
      const cols = colsOf(m);
      const widths = b.members.map((i) => chipWidth(nodes[i].name));
      const cellW = widths.length > 0 ? Math.max(...widths) : 0;
      const gridX0 = x + (b.w - (cols * cellW + (cols - 1) * KB2D.GAP_X)) / 2;
      const gridY0 = yTop + KB2D.HUB_H + KB2D.HUB_GAP_Y;
      b.members.forEach((i, k) => {
        const r = Math.floor(k / cols);
        const c = k % cols;
        const nw = chipWidth(nodes[i].name);
        const px = gridX0 + c * (cellW + KB2D.GAP_X) + cellW / 2;
        const py = gridY0 + r * (KB2D.CHIP_H + KB2D.GAP_Y) + KB2D.CHIP_H / 2;
        pos.set(nodes[i].id, { x: px, y: py });
        size.set(nodes[i].id, { w: nw, h: KB2D.CHIP_H });
        sectorOf.set(nodes[i].id, nodes[b.hub].id);
      });
      x += b.w + KB2D.BLOCK_GAP_X;
    }
  });
  // 4) 簇块包围盒（含 chip 半宽半高的外扩）。
  const blocks: ClusterBlock[] = placed.map((b) => {
    // 块原点=行内左缘 x0（渲染需 x0——这里从 hub 中心反推）。
    const hubPos = pos.get(nodes[b.hub].id)!;
    return {
      hubId: nodes[b.hub].id,
      minX: hubPos.x - b.w / 2,
      minY: hubPos.y - KB2D.HUB_H / 2 - 8,
      w: b.w + 16,
      h: b.h + 16,
    };
  });
  // 5) 视野自适应。
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  blocks.forEach((b) => {
    minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.minX + b.w); maxY = Math.max(maxY, b.minY + b.h);
  });
  if (!Number.isFinite(minX)) { minX = -450; minY = -210; maxX = 450; maxY = 210; }
  return {
    pos,
    size,
    sectorOf,
    hubs: sectors.map((s) => nodes[s.hub].id),
    blocks,
    view: { minX: minX - KB2D.PAD, minY: minY - KB2D.PAD, width: maxX - minX + KB2D.PAD * 2, height: maxY - minY + KB2D.PAD * 2 },
  };
}


/** 5.0.0-beta.6：预览内容直接存盘下载（Blob + a.download，
 * 零额外请求——content 已是完整文本，MdText 的 100000 截断只在展示层）。 */
function saveTextFile(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

interface SelectedFile {
  section: MemorySection | "remote";
  filename: string;
  title: string;
}

/** 图谱卡（本地/远端共用；对齐 QwenPaw 最新版
 * MemoryGraphView 视觉语言，2D 实现）：
 * - 三级节点色：根（虚拟分类根 virtual:*，橙 #FF7F16）/
 * 直接关联（根邻接，绿 #389E5C）/ 记忆文件（暖灰 #71665E，
 * 深色 #A29A92）——取自 QwenPaw 2.2 --graph-3d-* 调色板；
 * - 节点大小=链接度；≤42 节点全标注，否则 根+高度数+hover/选中；
 * - 点节点选中：邻接高亮、其余变暗，详情面板=入边/出边列表+打开文件；
 * - 边箭头=引用方向；图例=三级+方向。
 * 聚合图谱（agentLegend 提供）保留 v0.5.0-beta.12  按 Agent 着色。 */
const GRAPH_ROOT_COLOR = "#FF7F16"; // QwenPaw --graph-3d-root
const GRAPH_DIRECT_COLOR = "#389E5C"; // QwenPaw --graph-3d-direct
const GRAPH_FILE_LIGHT = "#71665E"; // QwenPaw --graph-3d-file
const GRAPH_FILE_DARK = "#A29A92";

/** v0.5.0-beta.12 ：聚合图谱按 Agent 着色的调色板（GraphCard 切片误删，补回）。 */
const AGENT_PALETTE = [
  "#FF7F16", "#1677ff", "#52c41a", "#f5222d", "#722ed1",
  "#fa8c16", "#13c2c2", "#eb2f96",
];

type LinkRef = { id: string; anchor?: string | null };

interface GraphModel {
  rootIds: Set<string>;
  directIds: Set<string>;
  neighbors: Map<string, Set<string>>;
  inbound: Map<string, LinkRef[]>;
  outbound: Map<string, LinkRef[]>;
}

function GraphCard(props: {
  graph: { nodes: GraphNodeLike[]; edges: { source: string; target: string; target_anchor?: string | null }[] } | null;
  loading: boolean;
  error: string;
  onOpenNode: (node: GraphNodeLike) => void;
  /** v0.5.0-beta.12 ：聚合图谱按 Agent 着色（提供时覆盖三级配色+图例）。 */
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
    setSelectedId("");
    setHoverId("");
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
  // 装验反馈 9/19（P1「空白处可拖动整个画板」）：pan 本身 beta.12.8 已有
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
    // 切到 2D 后必须重跑才挂上监听（R12 装验反馈「插件没有滚轮缩放」根因）。
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
                  🎯 {focusLabel} · 退出
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
              onMouseMove={handleGraphMove}
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

// ── 远端团队知识库视图（主视图）──────────────────────────────

/** v0.5.0-beta.12：KB 团队/Worker 选择记忆（用户反馈「知识库的团队和 worker
 * 选择那里也要加记忆」，同工作流 tab 记忆惯例——localStorage 持久
 * 选中态，刷新/重装不丢）。失效值（worker/团队已不存在）回退默认。 */
const KB_STATE_KEY = "kb-state-v1";
interface KbState {
  agent?: string;
  team?: string;
  graphMode?: "agent" | "merged";
}
function loadKbState(): KbState {
  try {
    const raw = window.localStorage.getItem(KB_STATE_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw) as Record<string, unknown>;
    return {
      agent:
        typeof o?.agent === "string" && o.agent ? o.agent : undefined,
      team:
        typeof o?.team === "string" && o.team ? o.team : undefined,
      graphMode:
        o?.graphMode === "merged"
          ? "merged"
          : o?.graphMode === "agent"
            ? "agent"
            : undefined,
    };
  } catch {
    return {};
  }
}
function saveKbState(
  agent: string,
  team: string,
  graphMode: string,
): void {
  try {
    window.localStorage.setItem(
      KB_STATE_KEY,
      JSON.stringify({ agent, team, graphMode }),
    );
  } catch {
    /* noop */
  }
}

function RemoteKbView(props: {
  agents: KbAgent[];
  refreshTick: number;
}) {
  const { agents, refreshTick } = props;
  const t = useThemeColors();
  const tr = useT();
  // v0.5.0-beta.12：选择记忆（只读一次，失效校验在初始化 effect 里做）。
  const kbStateRef = React.useRef<KbState>(loadKbState());
  const [agent, setAgent] = React.useState("");
  const [tree, setTree] = React.useState<{
    files: KbFileItem[];
    dirs: KbDirItem[];
    workspace: string;
  } | null>(null);
  const [graph, setGraph] = React.useState<{ nodes: GraphNodeLike[]; edges: { source: string; target: string; target_anchor?: string | null }[] } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [graphLoading, setGraphLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [selected, setSelected] = React.useState<SelectedFile | null>(null);
  const [content, setContent] = React.useState("");
  const [contentLoading, setContentLoading] = React.useState(false);
  const [contentError, setContentError] = React.useState("");
  // ：文件取回竞态守卫——慢请求的迟到响应（含其报错）不得覆盖新选择。
  const fileSeqRef = React.useRef(0);
  // v0.5.0-beta.12 ：图谱模式（当前 Agent / 团队聚合）
  // v0.5.0-beta.12：记忆恢复（非法值回退 "agent"，loadKbState 已校验枚举）。
  const [graphMode, setGraphMode] = React.useState<
    "agent" | "merged"
  >(() => kbStateRef.current.graphMode ?? "agent");
  /** 聚合图谱团队化——聚合=当前团队内（非全部团队）。
   * kbTeams=团队→成员（/teams/structure）；kbTeam=选中团队（""=全部，
   * 默认=当前 agent 所在团队，缺省第一个团队）。 */
  const [kbTeams, setKbTeams] = React.useState<WorkerTreeTeam[]>([]);
  // v0.5.0-beta.12：记忆恢复（团队列表落地后校验存在性，失效回退默认）。
  const [kbTeam, setKbTeam] = React.useState(
    () => kbStateRef.current.team ?? "",
  );
  const [mergedGraph, setMergedGraph] = React.useState<{
    nodes: GraphNodeLike[];
    edges: { source: string; target: string; target_anchor?: string | null }[];
    agents: string[];
  } | null>(null);
  const [mergedLoading, setMergedLoading] = React.useState(false);
  // v0.5.0-beta.12 ：团队知识搜索（跨 Worker）
  const [searchQ, setSearchQ] = React.useState("");
  const [searchBusy, setSearchBusy] = React.useState(false);
  const [searchResults, setSearchResults] = React.useState<
    KbSearchMatch[] | null
  >(null);
  // 目录懒加载（工作区子目录文件可见可开）
  const [dirCache, setDirCache] = React.useState<
    Record<string, DirChild | "loading">
  >({});
  const [expandedDirs, setExpandedDirs] = React.useState<
    Record<string, boolean>
  >({});

  // 默认选第一个 leader（无则首个 worker）。
  // v0.5.0-beta.12：优先恢复记忆的 Worker（仍在列表中才用，失效回退默认）。
  React.useEffect(() => {
    if (!agent && agents.length > 0) {
      const saved = kbStateRef.current.agent;
      const savedOk = saved
        ? agents.find((a) => a.name === saved)
        : undefined;
      const lead =
        savedOk ||
        agents.find((a) => a.role === "leader") ||
        agents[0];
      setAgent(lead.name);
    }
  }, [agents, agent]);

  // v0.5.0-beta.12：记忆持久化（worker/团队/图谱模式三态）。
  React.useEffect(() => {
    if (agent) saveKbState(agent, kbTeam, graphMode);
  }, [agent, kbTeam, graphMode]);

  const loadAll = React.useCallback(
    (silent = false) => {
      if (!agent) return;
      if (!silent) {
        setLoading(true);
        setGraphLoading(true);
      }
      setError("");
      void (async () => {
        const [trRes, gRes] = await Promise.allSettled([
          fetchKbTree(agent),
          fetchKbGraph(agent),
        ]);
        if (trRes.status === "fulfilled") {
          setTree({
            files: trRes.value.files,
            dirs: trRes.value.dirs || [],
            workspace: trRes.value.workspace,
          });
        } else {
          setError(trRes.reason instanceof Error ? trRes.reason.message : String(trRes.reason));
          setTree(null);
        }
        if (gRes.status === "fulfilled") {
          setGraph({ nodes: gRes.value.nodes, edges: gRes.value.edges });
        } else {
          setGraph(null);
        }
        setLoading(false);
        setGraphLoading(false);
      })();
    },
    [agent],
  );

  React.useEffect(() => {
    setTree(null);
    setGraph(null);
    setSelected(null);
    setContent("");
    setContentError("");
    setDirCache({});
    setExpandedDirs({});
    void loadAll();
  }, [agent, loadAll]);

  // 目录展开=懒加载一级（/kb/{a}/ls）；收起不缓存清理（再展开免费）。
  const toggleDir = React.useCallback(
    (d: KbDirItem) => {
      const willExpand = !expandedDirs[d.path];
      setExpandedDirs((m) => ({ ...m, [d.path]: willExpand }));
      if (willExpand && !(d.path in dirCache)) {
        setDirCache((m) => ({ ...m, [d.path]: "loading" }));
        fetchKbDir(agent, d.path)
          .then((r) =>
            setDirCache((m) => ({
              ...m,
              [d.path]: { files: r.files, dirs: r.dirs },
            })),
          )
          .catch((e) => {
            setDirCache((m) => {
              const n = { ...m };
              delete n[d.path];
              return n;
            });
            antd.message.error(
              e instanceof Error ? e.message : String(e),
            );
          });
      }
    },
    [agent, dirCache, expandedDirs],
  );

  // 切 tab 刷新（rc-tabs 保活）。
  React.useEffect(() => {
    if (refreshTick > 0 && agent) void loadAll(true);
    if (graphMode === "merged") void loadMerged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  // v0.5.0-beta.12 ：首次切到聚合模式时拉一次。
  // 团队化：先拉团队结构（确定聚合范围），就绪后再拉聚合图谱——
  // 避免团队列表未落地时先拉了"全部团队"。
  React.useEffect(() => {
    if (graphMode !== "merged") return;
    if (kbTeams.length === 0) {
      void fetchTeamsStructure()
        .then((r) => {
          const tree = r.tree || [];
          setKbTeams(tree);
          setKbTeam((prev) => {
            // v0.5.0-beta.12：记忆团队仍在团队列表 → 恢复；失效 → 走默认。
            if (prev && tree.some((t) => t.team_name === prev)) {
              return prev;
            }
            // 默认=当前 agent 所在团队；不在任何团队→第一个团队；空→""（全部）
            const home = tree.find((t) =>
              (t.workers || []).some((w) => w.worker_name === agent),
            );
            return (home || tree[0] || { team_name: "" }).team_name;
          });
        })
        .catch(() => setKbTeams([]));
      return;
    }
    if (!mergedGraph && !mergedLoading) void loadMerged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphMode, kbTeams]);

  // 切换聚合团队 → 清旧图重拉（避免旧团队图谱残留显示）。
  React.useEffect(() => {
    if (graphMode === "merged" && kbTeams.length > 0) {
      setMergedGraph(null);
      void loadMerged();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kbTeam]);

  // v0.5.0-beta.12 ：agentOverride——跨 Agent 搜索结果点击直接打开目标 Agent 文件
  // （不等 setAgent 状态落地）。
  const openFile = React.useCallback(
    (path: string, agentOverride?: string) => {
      const a = agentOverride || agent;
      const title = path.split("/").pop() || path;
      // （用户反馈「左边文件树一点击就开、图谱基本不开」）：不再
      // setAgent(agentOverride)。旧副作用「点图谱节点（聚合模式）切到目标
      // Agent」触发 [agent, loadAll] effect 的 setSelected(null)+
      // setContent("")，把刚发起的预览擦掉——fetch 回来时 selected 已 null，
      // 面板不渲染 = 点击无反应；文件树点击不带 override 故一直正常。
      // 取内容本就按 a=agentOverride 进行，无需切换 UI 当前 Agent（v0.5.0-beta.12 
      // 跨 Agent 搜索的原始意图就是「不等 setAgent 落地」）。
      setSelected({ section: "remote", filename: path, title });
      const seq = ++fileSeqRef.current;
      setContent("");
      setContentError("");
      setContentLoading(true);
      fetchKbFile(a, path)
        .then((f) => {
          if (fileSeqRef.current !== seq) return; // 迟到旧响应，丢弃
          setContent(f.content);
        })
        .catch((e) => {
          if (fileSeqRef.current !== seq) return;
          setContentError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (fileSeqRef.current !== seq) return;
          setContentLoading(false);
        });
    },
    [agent],
  );

  const openNode = React.useCallback(
    (node: GraphNodeLike) => {
      if (node.virtual) {
        antd.message.info(tr("该节点为虚拟根节点，不可打开"));
        return;
      }
      if (node.resolved === false) {
        antd.message.info(tr("未解析引用（对应文件不存在）"));
        return;
      }
      // v0.5.0-beta.12 ：聚合图谱 id = agent::path（跨 Agent 跳转）。
      const sep = node.id.indexOf("::");
      if (graphMode === "merged" && sep > 0) {
        openFile(node.id.slice(sep + 2), node.id.slice(0, sep));
      } else {
        openFile(node.id);
      }
    },
    [openFile, tr, graphMode],
  );

  // v0.5.0-beta.12 ：团队聚合图谱（节点按 Agent 着色；边保留原 Agent 内）。
  // 团队化：按选中团队成员聚合（kbTeam=""→全部团队）。
  const loadMerged = React.useCallback(() => {
    setMergedLoading(true);
    const team = kbTeams.find((t) => t.team_name === kbTeam);
    const agents = team
      ? (team.workers || []).map((w) => w.worker_name).filter(Boolean).join(",")
      : "";
    void fetchKbGraphMerged(agents || undefined)
      .then((g) =>
        setMergedGraph({ nodes: g.nodes as GraphNodeLike[], edges: g.edges, agents: g.agents }),
      )
      .catch(() => setMergedGraph(null))
      .finally(() => setMergedLoading(false));
  }, [kbTeams, kbTeam]);

  // v0.5.0-beta.12 ：团队知识搜索（跨 Worker，后端并发扫各 Agent 知识文件）。
  const runSearch = React.useCallback((q: string) => {
    const term = q.trim();
    setSearchQ(term);
    if (!term) {
      setSearchResults(null);
      return;
    }
    setSearchBusy(true);
    void fetchKbSearch(term)
      .then((r) => setSearchResults(r.matches))
      .catch((e) =>
        antd.message.error(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setSearchBusy(false));
  }, []);

  // 四分类（用户要求对齐 QwenPaw 最新版文件管理：
  // 文件/档案/日记/知识库）——后端 tree 已带 category 字段。
  const groups = React.useMemo(() => {
    const files = tree?.files || [];
    const byCat = (c: string) =>
      files.filter((f) => (f.category || "file") === c);
    const profile = byCat("profile");
    const byDay = new Map<string, KbFileItem[]>();
    for (const f of byCat("daily")) {
      // memory/YYYY-MM-DD/x.md → YYYY-MM-DD；memory/x.md → 顶层
      const parts = f.path.split("/").filter(Boolean);
      const seg = parts.length >= 3 ? (parts[1] || "other") : "top";
      const arr = byDay.get(seg) || [];
      arr.push(f);
      byDay.set(seg, arr);
    }
    const days = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));
    const bySeg = new Map<string, KbFileItem[]>();
    for (const f of byCat("digest")) {
      // digest/personal|x.md → 段名；digest/x.md → 顶层
      const parts = f.path.split("/").filter(Boolean);
      const seg =
        parts.length >= 3 ? (parts[1] || "other").toLowerCase() : "top";
      const arr = bySeg.get(seg) || [];
      arr.push(f);
      bySeg.set(seg, arr);
    }
    const segs = [...bySeg.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const otherFiles = byCat("file");
    return { profile, days, segs, otherFiles, dirs: tree?.dirs || [] };
  }, [tree]);

  const latestMtime = React.useMemo(() => {
    const files = tree?.files || [];
    let m = 0;
    for (const f of files) if (f.mtime > m) m = f.mtime;
    return m;
  }, [tree]);

  const agentInfo = agents.find((a) => a.name === agent);

  return (
    <antd.Space direction="vertical" size={12} style={{ width: "100%" }}>
      {/* Agent 选择 + 状态行 */}
      <antd.Card
        size="small"
        title={
          <span style={{ fontSize: 13 }}>
            {tr("团队 Agent")}
            <antd.Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
              {tr("远端 · Controller Docker API 直读容器工作区（只读）")}
            </antd.Typography.Text>
          </span>
        }
        extra={
          <antd.Button size="small" icon={<RefreshIcon />} onClick={() => void loadAll()}>
            {tr("刷新")}
          </antd.Button>
        }
      >
        <antd.Space size={14} wrap>
          <antd.Select
            style={{ minWidth: 240 }}
            value={agent || undefined}
            placeholder={tr("选择 Agent")}
            onChange={(v: string) => setAgent(v)}
            options={agentSelectOptions(agents, tr)}
          />
          {agentInfo ? (
            <>
              <StatusChip
                label={tr("角色")}
                value={
                  agentInfo.kind === "manager"
                    ? "Manager"
                    : agentInfo.role === "leader"
                      ? tr("Leader")
                      : agentInfo.role === "critic"
                        ? tr("评审")
                        : tr("Worker")
                }
                ok
              />
              {agentInfo.team ? (
                <StatusChip label={tr("团队")} value={agentInfo.team} ok />
              ) : null}
              <StatusChip
                label={tr("容器")}
                value={agentInfo.state || "—"}
                ok={agentInfo.state === "running"}
              />
            </>
          ) : null}
        </antd.Space>
        <div style={{ marginTop: 8, display: "flex", gap: 16, flexWrap: "wrap" }}>
          <StatusChip
            label={tr("知识文件")}
            value={String(tree?.files.length ?? 0)}
            ok
          />
          {latestMtime ? (
            <StatusChip
              label={tr("最近更新")}
              value={new Date(latestMtime * 1000).toLocaleString()}
              ok
            />
          ) : null}
          {tree ? (
            <antd.Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {tr("工作区")}：
              <antd.Typography.Text code style={{ fontSize: 11 }}>
                {tree.workspace}
              </antd.Typography.Text>
            </antd.Typography.Text>
          ) : null}
        </div>
      </antd.Card>

      {/* v0.5.0-beta.12 ：图谱模式 + 团队知识搜索 */}
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <antd.Segmented
          size="small"
          value={graphMode}
          onChange={(v: unknown) => setGraphMode(v as "agent" | "merged")}
          options={[
            { value: "agent", label: tr("当前 Agent 图谱") },
            { value: "merged", label: tr("团队聚合图谱") },
          ]}
        />
        {/* 聚合范围=选中团队（默认当前 agent 所在团队；可切"全部"） */}
        {graphMode === "merged" && kbTeams.length > 0 ? (
          <antd.Select
            size="small"
            style={{ minWidth: 160 }}
            value={kbTeam || undefined}
            placeholder={tr("聚合团队")}
            onChange={(v: string) => setKbTeam(v)}
            options={[
              ...kbTeams.map((t) => ({ value: t.team_name, label: t.team_name })),
              { value: "", label: tr("全部团队") },
            ]}
          />
        ) : null}
        <div style={{ flex: 1 }} />
        <antd.Input
          size="small"
          allowClear
          style={{ width: 280 }}
          placeholder={tr("搜索团队知识（跨 Worker）…")}
          value={searchQ}
          onChange={(e: { target: { value: string } }) => setSearchQ(e.target.value)}
          onPressEnter={() => runSearch(searchQ)}
          prefix={<span style={{ fontSize: 12 }}>🔍</span>}
          suffix={searchBusy ? <antd.Spin size="small" /> : null}
        />
      </div>

      {/* v0.5.0-beta.12 ：搜索结果显示（点击=切到该 Agent 并打开文件） */}
      {searchResults !== null ? (
        <antd.Card
          size="small"
          title={
            <span style={{ fontSize: 13 }}>
              {tr("团队知识搜索")}
              {searchResults.length
                ? tr("（匹配 {count} 条）", { count: searchResults.length })
                : ""}
            </span>
          }
        >
          {searchResults.length === 0 ? (
            <antd.Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {tr("无搜索结果")}
            </antd.Typography.Text>
          ) : (
            <div style={{ display: "grid", gap: 6, maxHeight: 260, overflow: "auto" }}>
              {searchResults.map((m, i) => (
                <div
                  key={`${m.agent}-${m.path}-${m.line}-${i}`}
                  onClick={() => openFile(m.path, m.agent)}
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "baseline",
                    padding: "6px 8px",
                    borderRadius: 6,
                    background: t.hoverBg,
                    cursor: "pointer",
                  }}
                >
                  <antd.Tag color="orange" style={{ margin: 0, flexShrink: 0 }}>
                    {m.agent}
                  </antd.Tag>
                  <span style={{ fontSize: 11, color: t.textSecondary, flexShrink: 0 }}>
                    {m.path}:{m.line}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      color: t.text,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {m.snippet}
                  </span>
                </div>
              ))}
            </div>
          )}
        </antd.Card>
      ) : null}

      {/* 图谱（v0.5.0-beta.12 ：可切团队聚合，节点按 Agent 着色） */}
      <GraphCard
        graph={
          graphMode === "merged" && mergedGraph
            ? { nodes: mergedGraph.nodes, edges: mergedGraph.edges }
            : graph
        }
        loading={graphMode === "merged" ? mergedLoading : graphLoading}
        error=""
        onOpenNode={openNode}
        agentLegend={
          graphMode === "merged"
            ? (mergedGraph?.agents || []).map((a, i) => ({
                name: a,
                color: AGENT_PALETTE[i % AGENT_PALETTE.length],
              }))
            : null
        }
      />

      {/* 文件浏览 + 预览 */}
      {error ? (
        <antd.Alert type="error" showIcon message={error} />
      ) : null}
      <antd.Row gutter={12}>
        <antd.Col span={10} style={{ minWidth: 0 }}>
          <antd.Card size="small" title={<span style={{ fontSize: 13 }}>{tr("知识文件")}</span>}>
            <antd.Spin spinning={loading}>
              <FileGroup
                title={tr("档案（工作区核心文件）")}
                color={REMOTE_CAT_COLOR.profile}
                files={groups.profile}
                selected={selected}
                onSelect={(k) => openFile(k)}
              />
              {groups.days.map(([day, files]) => (
                <FileGroup
                  key={`daily-${day}`}
                  title={tr("日记 · {d}", { d: day === "top" ? tr("顶层") : day })}
                  color={REMOTE_CAT_COLOR.memory}
                  files={files}
                  selected={selected}
                  onSelect={(k) => openFile(k)}
                  limit={80}
                />
              ))}
              {groups.segs.map(([seg, files]) => (
                <FileGroup
                  key={`digest-${seg}`}
                  title={tr("知识库 · {s}", { s: seg === "top" ? tr("顶层") : seg })}
                  color="#722ed1"
                  files={files}
                  selected={selected}
                  onSelect={(k) => openFile(k)}
                />
              ))}
              <FileGroup
                title={tr("文件（工作区其他）")}
                color={REMOTE_CAT_COLOR.other}
                files={groups.otherFiles}
                selected={selected}
                onSelect={(k) => openFile(k)}
                limit={40}
              />
              {groups.dirs.length > 0 ? (
                <div style={{ marginBottom: 10 }}>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: t.textSecondary,
                      marginBottom: 4,
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                    }}
                  >
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        background: REMOTE_CAT_COLOR.other,
                        display: "inline-block",
                      }}
                    />
                    {tr("工作区目录（点文件夹展开）")}
                    <span style={{ fontWeight: 400 }}>
                      ({groups.dirs.length})
                    </span>
                  </div>
                  {groups.dirs.map((d) => (
                    <DirNode
                      key={d.path}
                      dir={d}
                      depth={0}
                      expanded={expandedDirs}
                      cache={dirCache}
                      onToggle={(dd) => void toggleDir(dd)}
                      onOpenFile={(p) => openFile(p)}
                      selected={selected}
                    />
                  ))}
                </div>
              ) : null}
              {tree && tree.files.length === 0 ? (
                <antd.Empty
                  image={antd.Empty.PRESENTED_IMAGE_SIMPLE}
                  description={tr("该 Agent 暂无知识文件（工作区可能未初始化）")}
                  style={{ margin: "30px 0" }}
                />
              ) : null}
            </antd.Spin>
          </antd.Card>
        </antd.Col>
        <antd.Col span={14} style={{ minWidth: 0 }}>
          <antd.Card
            size="small"
            title={
              <span style={{ fontSize: 13 }}>
                {selected ? selected.title : tr("预览")}
              </span>
            }
            extra={
              selected && !contentLoading && !contentError && content
                ? (
                  <antd.Button
                    size="small"
                    onClick={() =>
                      saveTextFile(selected.title, content)
                    }
                  >
                    ⬇ {tr("下载")}
                  </antd.Button>
                )
                : null
            }
          >
            {contentLoading ? (
              <antd.Spin style={{ display: "block", margin: "40px auto" }} />
            ) : contentError ? (
              <antd.Alert type="error" showIcon message={contentError} />
            ) : content ? (
              <div
                style={{
                  maxHeight: 560,
                  overflow: "auto",
                  fontSize: 13,
                  lineHeight: 1.7,
                  color: t.text,
                }}
              >
                <MdText text={content} maxLength={100000} />
              </div>
            ) : (
              <antd.Empty
                image={antd.Empty.PRESENTED_IMAGE_SIMPLE}
                description={tr("点击左侧文件查看内容")}
                style={{ margin: "40px 0" }}
              />
            )}
          </antd.Card>
        </antd.Col>
      </antd.Row>
    </antd.Space>
  );
}

/** Agent 选择器分组：Manager 单列 + 各团队（Leader 在前）。 */
function agentSelectOptions(
  agents: KbAgent[],
  tr: (key: string, vars?: Record<string, string | number>) => string,
) {
  const managers = agents.filter((a) => a.kind === "manager");
  const byTeam = new Map<string, KbAgent[]>();
  for (const a of agents.filter((x) => x.kind === "worker")) {
    const team = a.team || tr("未分组");
    const arr = byTeam.get(team) || [];
    arr.push(a);
    byTeam.set(team, arr);
  }
  const roleOrder = { leader: 0, worker: 1, critic: 2 };
  const opts: { value: string; label: string; options?: { value: string; label: string }[] }[] = [];
  if (managers.length > 0) {
    opts.push({
      value: "manager",
      label: "Manager",
      options: managers.map((a) => ({
        value: a.name,
        label: `Manager · ${a.name}`,
      })),
    });
  }
  for (const [team, ws] of [...byTeam.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    ws.sort(
      (x, y) =>
        (roleOrder[x.role || "worker"] ?? 3) - (roleOrder[y.role || "worker"] ?? 3) ||
        x.name.localeCompare(y.name),
    );
    opts.push({
      value: `team-${team}`,
      label: team,
      options: ws.map((a) => ({
        value: a.name,
        label: `${a.role === "leader" ? "👑 " : ""}${a.name}`,
      })),
    });
  }
  return opts;
}

// ── 本地（宿主）知识库视图（原实现保留）────────────────────────
function LocalKbView(props: { refreshTick: number }) {
  const { refreshTick } = props;
  const t = useThemeColors();
  const tr = useT();
  const [agentId, setAgentId] = React.useState("");
  const [graph, setGraph] = React.useState<{ nodes: MemoryGraphNode[]; edges: { source: string; target: string; target_anchor?: string | null }[] } | null>(null);
  const [graphUnavailable, setGraphUnavailable] = React.useState(false);
  const [status, setStatus] = React.useState<MemoryStatusResponse | null>(null);
  const [statusUnavailable, setStatusUnavailable] = React.useState(false);
  const [graphLoading, setGraphLoading] = React.useState(true);
  const [digestFiles, setDigestFiles] = React.useState<MemoryFileItem[]>([]);
  const [dailyFiles, setDailyFiles] = React.useState<MemoryFileItem[]>([]);
  const [filesLoading, setFilesLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [selected, setSelected] = React.useState<SelectedFile | null>(null);
  const [content, setContent] = React.useState("");
  const [contentLoading, setContentLoading] = React.useState(false);
  const [contentError, setContentError] = React.useState("");
  // ：文件取回竞态守卫（同 RemoteKbView）。
  const fileSeqRef = React.useRef(0);
  const [reindexing, setReindexing] = React.useState(false);
  const reindexPoll = React.useRef<ReturnType<typeof setInterval> | null>(null);

  // agentId：宿主当前选中 agent（X-Agent-Id 同会话隔离）。
  React.useEffect(() => {
    let alive = true;
    try {
      const h = window.QwenPaw?.host;
      if (h && typeof h.getSelectedAgentId === "function") {
        const id = h.getSelectedAgentId() || "";
        if (id) {
          setAgentId(id);
          return;
        }
      }
    } catch {
      /* fall through → /agents 兜底 */
    }
    void fetchAgentIdList()
      .then((ids) => {
        if (alive && ids.length > 0) setAgentId(ids[0]);
      })
      .catch(() => {
        /* 无宿主/全失败 → agentId 空 */
      });
    return () => {
      alive = false;
    };
  }, []);

  React.useEffect(() => {
    return () => {
      if (reindexPoll.current) clearInterval(reindexPoll.current);
    };
  }, []);

  const loadAll = React.useCallback(
    (silent = false) => {
      if (!agentId) return;
      if (!silent) {
        setGraphLoading(true);
        setFilesLoading(true);
      }
      setError("");
      setGraphUnavailable(false);
      setStatusUnavailable(false);
      void (async () => {
        try {
          const [g, s] = await Promise.allSettled([
            fetchMemoryGraph(agentId),
            fetchMemoryStatus(agentId),
          ]);
          if (g.status === "fulfilled") setGraph(g.value);
          else setGraphUnavailable(true);
          if (s.status === "fulfilled") setStatus(s.value);
          else setStatusUnavailable(true);
        } finally {
          setGraphLoading(false);
        }
        const [df, daily] = await Promise.allSettled([
          listMemoryFiles("digest"),
          listMemoryFiles("daily"),
        ]);
        if (df.status === "fulfilled") setDigestFiles(df.value);
        if (daily.status === "fulfilled") setDailyFiles(daily.value);
        setFilesLoading(false);
      })();
    },
    [agentId],
  );

  React.useEffect(() => {
    if (agentId) void loadAll();
  }, [agentId, loadAll]);

  React.useEffect(() => {
    if (refreshTick > 0 && agentId) void loadAll(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  const openFile = React.useCallback(
    (section: MemorySection, filename: string) => {
      const title = filename.split("/").pop() || filename;
      setSelected({ section, filename, title });
      const seq = ++fileSeqRef.current;
      setContent("");
      setContentError("");
      setContentLoading(true);
      loadMemoryFile(filename, section)
        .then((c) => {
          if (fileSeqRef.current !== seq) return; // 迟到旧响应，丢弃
          setContent(c);
        })
        .catch((e) => {
          if (fileSeqRef.current !== seq) return;
          setContentError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (fileSeqRef.current !== seq) return;
          setContentLoading(false);
        });
    },
    [],
  );

  const openNode = React.useCallback(
    (node: GraphNodeLike) => {
      const mn = node as MemoryGraphNode;
      if (mn.virtual) {
        antd.message.info(tr("该节点为虚拟根节点，不可打开"));
        return;
      }
      const section: MemorySection | null =
        mn.section === "daily"
          ? "daily"
          : mn.section === "digest"
            ? "digest"
            : null;
      if (!section) return;
      let p = mn.relative_path || "";
      if (!p && mn.path) {
        const prefix = section === "digest" ? "digest/" : "memory/";
        p = mn.path.startsWith(prefix)
          ? mn.path.slice(prefix.length)
          : mn.path;
      }
      if (!p) {
        antd.message.warning(tr("节点缺少文件路径，无法打开"));
        return;
      }
      openFile(section, p);
    },
    [openFile, tr],
  );

  const startReindex = React.useCallback(() => {
    antd.Modal.confirm({
      title: tr("确认重建记忆索引？"),
      content: tr(
        "会重新扫描当前 Agent 的全部记忆文件（memory/ + digest/）。大库耗时数分钟，期间检索可能不完整。",
      ),
      okText: tr("重建"),
      cancelText: tr("取消"),
      onOk: () => {
        setReindexing(true);
        void reindexMemory(agentId)
          .catch((e) => {
            setReindexing(false);
            antd.message.error(
              `${tr("索引重建失败")}: ${e instanceof Error ? e.message : String(e)}`,
            );
          })
          .finally(() => {
            if (reindexPoll.current) clearInterval(reindexPoll.current);
            let tries = 0;
            reindexPoll.current = setInterval(() => {
              tries += 1;
              if (tries > 180) {
                if (reindexPoll.current) clearInterval(reindexPoll.current);
                setReindexing(false);
                return;
              }
              void fetchMemoryStatus(agentId)
                .then((s) => {
                  setStatus(s);
                  if (!s.runtime.reindexing) {
                    if (reindexPoll.current) clearInterval(reindexPoll.current);
                    setReindexing(false);
                    antd.message.success(tr("索引重建完成"));
                    void loadAll(true);
                  }
                })
                .catch(() => {
                  if (reindexPoll.current) clearInterval(reindexPoll.current);
                  setReindexing(false);
                });
            }, 5000);
          });
      },
    });
  }, [agentId, loadAll, tr]);

  const digestGroups = React.useMemo(() => {
    const groups = new Map<string, MemoryFileItem[]>();
    for (const f of [...digestFiles].sort((a, b) =>
      a.filename.localeCompare(b.filename),
    )) {
      const seg =
        f.filename.split("/").filter(Boolean)[0]?.toLowerCase() || "other";
      const arr = groups.get(seg) || [];
      arr.push(f);
      groups.set(seg, arr);
    }
    return groups;
  }, [digestFiles]);
  const dailySorted = React.useMemo(
    () => [...dailyFiles].sort((a, b) => b.filename.localeCompare(a.filename)),
    [dailyFiles],
  );

  const auto = status?.runtime?.auto_memory;
  const workerStatus = status?.runtime?.worker?.status;

  if (!agentId) {
    return (
      <antd.Space direction="vertical" style={{ width: "100%", padding: 16 }}>
        <antd.Alert
          type="warning"
          showIcon
          message={tr("宿主环境不可用（无法获取当前 Agent）")}
        />
      </antd.Space>
    );
  }

  return (
    <antd.Space direction="vertical" size={12} style={{ width: "100%" }}>
      <antd.Card
        size="small"
        title={
          <span style={{ fontSize: 13 }}>
            {tr("当前 Agent")}：
            <antd.Typography.Text code style={{ fontSize: 12 }}>
              {agentId}
            </antd.Typography.Text>
            <antd.Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
              {tr("本机宿主 QwenPaw")}
            </antd.Typography.Text>
          </span>
        }
        extra={
          <antd.Space size={6}>
            <antd.Button size="small" icon={<RefreshIcon />} onClick={() => void loadAll()}>
              {tr("刷新")}
            </antd.Button>
            <antd.Button
              size="small"
              type="primary"
              ghost
              loading={reindexing}
              disabled={statusUnavailable}
              onClick={startReindex}
            >
              {reindexing ? tr("正在重建索引…") : tr("重建索引")}
            </antd.Button>
          </antd.Space>
        }
      >
        <antd.Space size={16} wrap>
          <StatusChip
            label={tr("自动记忆")}
            value={
              auto?.enabled
                ? `${tr("开")}（${tr("每 N 轮").replace("N", String(auto.interval || 5))}）`
                : tr("关")
            }
            ok={Boolean(auto?.enabled)}
          />
          <StatusChip
            label={tr("记忆 worker")}
            value={
              workerStatus === "idle"
                ? tr("空闲")
                : workerStatus === "busy"
                  ? tr("忙碌")
                  : workerStatus === "stopping"
                    ? tr("停止中")
                    : workerStatus
                      ? tr("错误")
                      : "—"
            }
            ok={workerStatus === "idle"}
          />
          <StatusChip label={tr("进程内存")} value={status?.process_rss || "—"} ok />
          {status?.runtime?.recent?.last_error ? (
            <antd.Tooltip title={status.runtime.recent.last_error}>
              <StatusChip label={tr("最近错误")} value="⚠" ok={false} />
            </antd.Tooltip>
          ) : null}
          {graphUnavailable ? (
            <antd.Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {tr("图谱/状态 API 需宿主 2.1.0+（当前 404），仅文件浏览可用")}
            </antd.Typography.Text>
          ) : null}
        </antd.Space>
      </antd.Card>

      <GraphCard
        graph={graph}
        loading={graphLoading}
        error={error}
        onOpenNode={openNode}
      />

      <antd.Row gutter={12}>
        <antd.Col span={10} style={{ minWidth: 0 }}>
          <antd.Card size="small" title={<span style={{ fontSize: 13 }}>{tr("记忆文件")}</span>}>
            <antd.Spin spinning={filesLoading}>
              <FileGroup
                title={tr("个人偏好")}
                color={SECTION_COLOR["digest/personal"]}
                files={digestGroups.get("personal") || []}
                selected={selected}
                onSelect={(k) => openFile("digest", k)}
              />
              <FileGroup
                title={tr("操作流程")}
                color={SECTION_COLOR["digest/procedure"]}
                files={digestGroups.get("procedure") || []}
                selected={selected}
                onSelect={(k) => openFile("digest", k)}
              />
              <FileGroup
                title={tr("Wiki 知识")}
                color={SECTION_COLOR["digest/wiki"]}
                files={digestGroups.get("wiki") || []}
                selected={selected}
                onSelect={(k) => openFile("digest", k)}
              />
              {digestGroups.get("other") && digestGroups.get("other")!.length > 0 ? (
                <FileGroup
                  title={tr("其他")}
                  color={SECTION_COLOR.virtual}
                  files={digestGroups.get("other") || []}
                  selected={selected}
                  onSelect={(k) => openFile("digest", k)}
                />
              ) : null}
              <FileGroup
                title={tr("每日记忆")}
                color={SECTION_COLOR.daily}
                files={dailySorted}
                selected={selected}
                onSelect={(k) => openFile("daily", k)}
                limit={60}
              />
            </antd.Spin>
          </antd.Card>
        </antd.Col>
        <antd.Col span={14} style={{ minWidth: 0 }}>
          <antd.Card
            size="small"
            title={
              <span style={{ fontSize: 13 }}>
                {selected ? selected.title : tr("预览")}
              </span>
            }
            extra={
              selected && !contentLoading && !contentError && content
                ? (
                  <antd.Button
                    size="small"
                    onClick={() =>
                      saveTextFile(selected.title, content)
                    }
                  >
                    ⬇ {tr("下载")}
                  </antd.Button>
                )
                : null
            }
          >
            {contentLoading ? (
              <antd.Spin style={{ display: "block", margin: "40px auto" }} />
            ) : contentError ? (
              <antd.Alert type="error" showIcon message={contentError} />
            ) : content ? (
              <div
                style={{
                  maxHeight: 560,
                  overflow: "auto",
                  fontSize: 13,
                  lineHeight: 1.7,
                  color: t.text,
                }}
              >
                <MdText text={content} maxLength={100000} />
              </div>
            ) : (
              <antd.Empty
                image={antd.Empty.PRESENTED_IMAGE_SIMPLE}
                description={tr("点击左侧文件查看内容")}
                style={{ margin: "40px 0" }}
              />
            )}
          </antd.Card>
        </antd.Col>
      </antd.Row>
    </antd.Space>
  );
}

/**
 * 知识库 tab（用户定位）：
 * 主视图 = 远端团队知识库（自己团队的 Leader/Worker 的 knowledge base——
 * Controller Docker API 只读直读 Worker 容器工作区，需 Controller token）。
 * 降级视图 = 本机宿主 Agent（无 token / L2 用户）。
 */
export default function KnowledgeBase(props: { refreshTick?: number }) {
  const { refreshTick = 0 } = props;
  const tr = useT();
  const [mode, setMode] = React.useState<"remote" | "local">("local");
  const [probing, setProbing] = React.useState(true);
  const [remoteAvailable, setRemoteAvailable] = React.useState(false);
  const [agents, setAgents] = React.useState<KbAgent[]>([]);
  const [probeError, setProbeError] = React.useState("");

  // 探测：有 Controller token 且远端有 Agent → remote；否则 local。
  const probe = React.useCallback(() => {
    setProbing(true);
    setProbeError("");
    void fetchKbAgents()
      .then((list) => {
        setAgents(list);
        const ok = list.length > 0;
        setRemoteAvailable(ok);
        setMode(ok ? "remote" : "local");
        if (!ok) setProbeError("no-agents");
      })
      .catch((e) => {
        setRemoteAvailable(false);
        setMode("local");
        setProbeError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setProbing(false));
  }, []);

  React.useEffect(() => {
    void probe();
  }, [probe]);

  return (
    <antd.Space direction="vertical" size={10} style={{ width: "100%" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <antd.Segmented
          value={mode}
          onChange={(v: string | number) => setMode(v as "remote" | "local")}
          options={[
            {
              label: `🌐 ${tr("远端团队知识库")}`,
              value: "remote",
              // 探测失败/无远端 Agent → remote 不可选（点「重新检测」再试）。
              disabled: !remoteAvailable || probing,
            },
            { label: `💻 ${tr("本机宿主 Agent")}`, value: "local" },
          ]}
        />
        <antd.Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {mode === "remote"
            ? tr("读自己团队 Leader/Worker 的远端知识库（只读）")
            : tr("读本机 QwenPaw Agent 的记忆库")}
        </antd.Typography.Text>
        <antd.Button
          size="small"
          type="link"
          onClick={() => void probe()}
          style={{ marginLeft: "auto" }}
        >
          {tr("重新检测")}
        </antd.Button>
      </div>
      {probeError ? (
        <antd.Alert
          type="warning"
          showIcon
          message={tr("远端团队知识库不可用，当前为本机宿主知识库")}
          description={
            /401/.test(probeError)
              ? tr("远端团队知识库需要 L1（管理员）凭据——配置页填写 Controller 管理员 token 后点「重新检测」。L2 用户没有该 token，此视图不可用（保持本机知识库，或向管理员申请 L1 凭据）")
              : probeError === "no-agents"
                ? tr("远端未找到 Worker 容器（Controller 未接入？）")
                : probeError
          }
        />
      ) : null}
      {mode === "remote" ? (
        <RemoteKbView agents={agents} refreshTick={refreshTick} />
      ) : (
        <LocalKbView refreshTick={refreshTick} />
      )}
    </antd.Space>
  );
}

function StatusChip({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok: boolean;
}) {
  return (
    <span style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: ok ? "#52c41a" : "#faad14",
          display: "inline-block",
        }}
      />
      <antd.Typography.Text type="secondary">{label}</antd.Typography.Text>
      <antd.Typography.Text style={{ fontSize: 12 }}>{value}</antd.Typography.Text>
    </span>
  );
}

interface AnyFile {
  filename?: string;
  path?: string;
  size?: number;
  mtime?: number;
}

/** 目录懒加载缓存条目。 */
type DirChild = { files: KbFileItem[]; dirs: KbDirItem[] };

/** （真机反馈：知识库「只能看见工作区目录，不能点开看；
 * 子目录文件在哪里也看不见」）：目录树节点——原「工作区目录」是
 * 不可点静态 Tag，现改懒加载可展开树：点目录=拉一级（/kb/{a}/ls），
 * 点文件=openFile 预览（路径=工作区相对全路径，/file 端点直读）。
 * 深度上限 6 层防失控。 */
function DirNode(props: {
  dir: KbDirItem;
  depth: number;
  expanded: Record<string, boolean>;
  cache: Record<string, DirChild | "loading">;
  onToggle: (d: KbDirItem) => void;
  onOpenFile: (path: string) => void;
  selected: SelectedFile | null;
}) {
  const { dir, depth, expanded, cache, onToggle, onOpenFile, selected } =
    props;
  const t = useThemeColors();
  const tr = useT();
  const isExp = Boolean(expanded[dir.path]);
  const child = cache[dir.path];
  const indent = depth * 14 + 4;
  const childIndent = depth * 14 + 18;
  return (
    <div style={{ marginBottom: 1 }}>
      <div
        onClick={() => depth < 6 ? onToggle(dir) : undefined}
        style={{
          cursor: depth >= 6 ? "default" : "pointer",
          fontSize: 12,
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: `2px 4px 2px ${indent}px`,
        }}
      >
        <span style={{ width: 10, color: t.textSecondary, fontSize: 10 }}>
          {isExp ? "▾" : "▸"}
        </span>
        <span>📁</span>
        <span style={{ color: t.text }}>
          {dir.name}
          {child === "loading" ? " …" : ""}
        </span>
      </div>
      {isExp && child && child !== "loading" ? (
        <div>
          {child.dirs.map((cd) => (
            <DirNode
              key={cd.path}
              dir={cd}
              depth={depth + 1}
              expanded={expanded}
              cache={cache}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
              selected={selected}
            />
          ))}
          {child.files.map((f) => {
            const isSel =
              selected?.section === "remote" && selected.filename === f.path;
            return (
              <div
                key={f.path}
                onClick={() => onOpenFile(f.path)}
                title={f.path}
                style={{
                  cursor: "pointer",
                  fontSize: 12,
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: `2px 4px 2px ${childIndent}px`,
                  color: isSel ? "#FF7F16" : t.text,
                  background: isSel ? "rgba(255,127,22,0.08)" : undefined,
                }}
              >
                <span style={{ width: 10, display: "inline-block" }} />
                <span>📄</span>
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {f.name}
                </span>
              </div>
            );
          })}
          {child.files.length === 0 && child.dirs.length === 0 ? (
            <div
              style={{
                fontSize: 11.5,
                color: t.textSecondary,
                opacity: 0.6,
                padding: `2px 4px 2px ${childIndent}px`,
              }}
            >
              {tr("空目录")}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function FileGroup({
  title,
  color,
  files,
  selected,
  onSelect,
  limit,
}: {
  title: string;
  color: string;
  files: AnyFile[];
  selected: SelectedFile | null;
  /** 传解析后的相对路径/文件名（非空字符串）。 */
  onSelect: (key: string) => void;
  limit?: number;
}) {
  const t = useThemeColors();
  const keyOf = (f: AnyFile) => f.path || f.filename || "";
  const shown = limit ? files.slice(0, limit) : files;
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: t.textSecondary,
          marginBottom: 4,
          display: "flex",
          alignItems: "center",
          gap: 5,
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: color,
            display: "inline-block",
          }}
        />
        {title}
        <span style={{ fontWeight: 400, color: t.textSecondary }}>
          ({files.length})
        </span>
      </div>
      {shown.length === 0 ? (
        <div
          style={{
            fontSize: 12,
            color: t.textSecondary,
            padding: "2px 0 2px 12px",
            opacity: 0.6,
          }}
        >
          —
        </div>
      ) : (
        <div>
          {shown.map((f) => {
            const key = keyOf(f);
            const name = key.split("/").pop() || key;
            const active = selected?.filename === key;
            return (
              <div
                key={key}
                onClick={() => onSelect(key)}
                title={`${key}${f.mtime ? ` · ${new Date(f.mtime * 1000).toLocaleString("zh-CN")}` : ""}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12.5,
                  padding: "3px 8px 3px 12px",
                  borderRadius: 6,
                  cursor: "pointer",
                  color: active ? "#fff" : t.text,
                  background: active ? color : "transparent",
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                }}
              >
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {name}
                </span>
                {f.size != null && f.size > 0 ? (
                  <span style={{ color: active ? "rgba(255,255,255,0.75)" : t.textSecondary, fontSize: 10.5, flexShrink: 0 }}>
                    {formatFileSize(f.size)}
                  </span>
                ) : null}
                {/* v0.5.0-beta.12 ：文件更新时间（tar mtime） */}
                {f.mtime ? (
                  <span style={{ color: active ? "rgba(255,255,255,0.75)" : t.textSecondary, fontSize: 10, flexShrink: 0 }}>
                    {new Date(f.mtime * 1000).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })}{" "}
                    {new Date(f.mtime * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                ) : null}
              </div>
            );
          })}
          {limit && files.length > limit ? (
            <div style={{ fontSize: 11, color: t.textSecondary, paddingLeft: 12 }}>
              +{files.length - limit}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function formatFileSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function RefreshIcon() {
  const icons = window.QwenPaw.host.antdIcons as Record<
    string,
    ReactNS.ComponentType
  >;
  const I = (icons["ReloadOutlined"] || icons["SyncOutlined"]) as ReactNS.ComponentType;
  if (!I) return null;
  return <I />;
}
