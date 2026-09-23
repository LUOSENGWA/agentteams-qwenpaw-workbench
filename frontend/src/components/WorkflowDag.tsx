import type * as ReactNS from "react";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

// ── 项目任务 DAG（移植 dashboard src/lib/project-dag + project-dag-svg，
//    适配插件数据面：workflow API 的 nodes[].dependsOn → 边；无 `next`
//    字段 → ready 走本地推导。算法与 dashboard 同源——拓扑视图观感一致）──

/** 插件 workflow 节点（api.ts WorkflowNode 的 DAG 投影）。
 * v0.5.0-beta.13.11（F7 拓扑优化）：补 subagent/task——Controller
 * workflow_run nodes 自带执行者字段，此前投影丢弃（节点只有名字，
 * 看不出谁在跑）。 */
interface WfNodeInput {
  id?: string;
  name?: string;
  status?: string;
  dependsOn?: string[];
  subagent?: string;
  task?: string;
}

export interface DagNode {
  id: string;
  title: string;
  status: string;
  ready: boolean;
  /** 执行者（subagent 短名；无则不渲染第二行）。 */
  subagent?: string;
  /** 0-based 依赖深度（分层布局用）。 */
  layer: number;
}

export interface DagEdge {
  source: string;
  target: string;
}

export interface ProjectDag {
  nodes: DagNode[];
  edges: DagEdge[];
  /** 依赖了本项目之外 id 的边来源（展示用，不阻塞 ready 推导）。 */
  externalDeps: string[];
}

/** 节点状态 → 看板状态空间（revision 保留自身状态；
 * v0.5.0-beta.13.12：cancelled 独立态——此前折入 blocked 是状态映射
 * 不一致缺陷（现场 9/23 报告：cancelled 任务显示成 blocked）。 */
const WORKFLOW_STATUS_MAP: Record<string, string> = {
  pending: "pending",
  planned: "pending",
  delegated: "assigned",
  assigned: "assigned",
  "in-progress": "in_progress",
  in_progress: "in_progress",
  submitted: "in_progress",
  completed: "completed",
  done: "completed",
  failed: "failed",
  error: "failed",
  revision: "revision",
  blocked: "blocked",
  cancelled: "cancelled",
  canceled: "cancelled",
  unknown: "unknown",
};

/** 终态集合（ready 推导排除——终态节点不再画「就绪」青虚线框）。 */
const DAG_TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "revision",
  "blocked",
  "cancelled",
]);

/**
 * 从 workflow nodes（dependsOn 建边）构建 ProjectDag + 迭代分层
 * （layer = max(依赖 layer)+1；无依赖=0；pass 上限防环死循环）。
 * ready = 本项目内依赖全 completed 且自身非终态（无 controller `next`
 * 字段时的本地推导，与 dashboard 回退路径同语义）。
 */
export function buildWorkflowDag(nodes: WfNodeInput[]): ProjectDag {
  const valid = nodes.filter((n) => typeof n.id === "string" && n.id.trim() !== "");
  const byId = new Map<string, WfNodeInput>(valid.map((n) => [String(n.id), n]));

  const edges: DagEdge[] = [];
  const externalDeps = new Set<string>();
  for (const n of valid) {
    const deps = (n.dependsOn || []).filter(
      (d): d is string => typeof d === "string" && d.trim() !== "",
    );
    for (const dep of deps) {
      if (byId.has(dep)) edges.push({ source: dep, target: String(n.id) });
      else externalDeps.add(dep);
    }
  }

  const layerOf = new Map<string, number>();
  const maxPasses = valid.length + 1;
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    for (const n of valid) {
      const id = String(n.id);
      const deps = (n.dependsOn || []).filter(
        (d): d is string => typeof d === "string" && byId.has(d),
      );
      if (deps.length === 0) {
        if (layerOf.get(id) !== 0) {
          layerOf.set(id, 0);
          changed = true;
        }
        continue;
      }
      let maxDep = -1;
      for (const d of deps) {
        const l = layerOf.get(d);
        if (l === undefined) {
          maxDep = -1;
          break;
        }
        if (l > maxDep) maxDep = l;
      }
      if (maxDep >= 0) {
        const next = maxDep + 1;
        if (layerOf.get(id) !== next) {
          layerOf.set(id, next);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  const completedSet = new Set(
    valid
      .filter((n) => WORKFLOW_STATUS_MAP[String(n.status ?? "")] === "completed")
      .map((n) => String(n.id)),
  );
  const dagNodes: DagNode[] = valid.map((n) => {
    const id = String(n.id);
    const deps = (n.dependsOn || []).filter(
      (d): d is string => typeof d === "string" && byId.has(d),
    );
    const allDepsDone = deps.every((d) => completedSet.has(d));
    const status = WORKFLOW_STATUS_MAP[String(n.status ?? "")] ?? "unknown";
    const subagent =
      typeof n.subagent === "string" && n.subagent.trim() !== ""
        ? n.subagent.trim()
        : undefined;
    return {
      id,
      title:
        typeof n.name === "string" && n.name.trim() !== ""
          ? n.name.trim()
          : id,
      status,
      // v0.5.0-beta.13.12：终态（completed/failed/revision/blocked/
      // cancelled）不画 ready 青框——此前只排 completed，cancelled 节点
      // 依赖全绿时误显「就绪」。
      ready: allDepsDone && !DAG_TERMINAL_STATUSES.has(status),
      subagent,
      layer: layerOf.get(id) ?? 0,
    };
  });

  return {
    nodes: dagNodes,
    edges,
    externalDeps: Array.from(externalDeps),
  };
}

export interface DagLayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  gapX?: number;
  gapY?: number;
  padding?: number;
}

export interface DagLayout {
  width: number;
  height: number;
  positions: Map<string, { x: number; y: number }>;
}

/** 自上而下分层布局（与 dashboard layoutProjectDag 同算法）：
 * layer 0 在顶，同层左→右。 */
export function layoutProjectDag(
  dag: ProjectDag,
  options: DagLayoutOptions = {},
): DagLayout {
  const W = options.nodeWidth ?? 190;
  const H = options.nodeHeight ?? 40;
  const GX = options.gapX ?? 24;
  const GY = options.gapY ?? 64;
  const PAD = options.padding ?? 12;

  const byLayer = new Map<number, DagNode[]>();
  for (const n of dag.nodes) {
    const arr = byLayer.get(n.layer) ?? [];
    arr.push(n);
    byLayer.set(n.layer, arr);
  }
  const layers = Array.from(byLayer.keys()).sort((a, b) => a - b);

  const positions = new Map<string, { x: number; y: number }>();
  let width = 0;
  const height = layers.length > 0 ? layers.length * GY + H : H;
  layers.forEach((layer, i) => {
    const nodes = byLayer.get(layer) ?? [];
    let x = PAD;
    for (const n of nodes) {
      positions.set(n.id, { x, y: i * GY + 8 });
      x += W + GX;
    }
    width = Math.max(width, x - GX + PAD);
  });
  return { width, height, positions };
}

// ── SVG 渲染（移植 dashboard project-dag-svg：bezier 边 + 箭头 +
//    ready 青虚线框；配色表主题感知，与插件 STATUS_COLOR 同源）──────

export interface DagNodeColor {
  fill: string;
  stroke: string;
  text: string;
}

export function WorkflowDagSvg(props: {
  dag: ProjectDag;
  nodeColors: Record<string, DagNodeColor>;
  nodeWidth?: number;
  nodeHeight?: number;
  gapY?: number;
  title?: string;
  /** v0.5.0-beta.13.11（F7 拓扑优化）：缩放（工具条 +/-/复位驱动）。 */
  scale?: number;
  /** 节点点击 → 任务巡检 Drawer（看板任务卡同款入口）。 */
  onNodeClick?: (id: string) => void;
}) {
  const {
    dag,
    nodeColors,
    nodeWidth = 190,
    nodeHeight = 40,
    gapY = 64,
    scale = 1,
    onNodeClick,
  } = props;
  const W = nodeWidth;
  const H = nodeHeight;
  const GY = gapY;
  const tr = useT();

  // 每实例唯一 marker id（同页可能渲染多个 DAG，共享 document id 会让
  // url(#...) 恒指向第一个实例——dashboard 同款注释）。
  const markerId = React.useId();
  const layout = React.useMemo(
    () => layoutProjectDag(dag, { nodeWidth: W, nodeHeight: H, gapY: GY }),
    [dag, W, H, GY],
  );
  const { width, height, positions } = layout;

  if (dag.nodes.length === 0) return null;

  return (
    <svg
      width={width * scale}
      height={height * scale}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={props.title ?? tr("项目任务依赖图")}
      style={{ display: "block", maxWidth: "none" }}
    >
      {dag.edges.map((e, i) => {
        const a = positions.get(e.source);
        const b = positions.get(e.target);
        if (!a || !b) return null;
        const x1 = a.x + W / 2;
        const y1 = a.y + H;
        const x2 = b.x + W / 2;
        const y2 = b.y;
        const my = (y1 + y2) / 2;
        return (
          <path
            key={`edge-${i}`}
            d={`M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`}
            fill="none"
            stroke="rgba(148,163,184,0.55)"
            strokeWidth={1.2}
            markerEnd={`url(#${markerId})`}
          />
        );
      })}
      <defs>
        <marker
          id={markerId}
          markerWidth="7"
          markerHeight="7"
          refX="6"
          refY="3"
          orient="auto"
        >
          <path d="M0,0 L7,3 L0,6 Z" fill="rgba(148,163,184,0.7)" />
        </marker>
      </defs>
      {dag.nodes.map((n) => {
        const p = positions.get(n.id);
        if (!p) return null;
        const colors = nodeColors[n.status] ?? nodeColors.unknown;
        // ~14 个 CJK 字形在 11px 下放得进默认 190px 节点宽。
        const label = n.title.length > 14 ? `${n.title.slice(0, 14)}…` : n.title;
        const sub = n.subagent ? (n.subagent.length > 16 ? `${n.subagent.slice(0, 16)}…` : n.subagent) : null;
        return (
          <g
            key={n.id}
            onClick={onNodeClick ? () => onNodeClick(n.id) : undefined}
            style={onNodeClick ? { cursor: "pointer" } : undefined}
          >
            <title>{sub ? `${n.title} — ${n.subagent}` : n.title}</title>
            <rect
              x={p.x}
              y={p.y}
              width={W}
              height={H}
              rx={7}
              fill={colors.fill}
              stroke={n.ready ? "#22d3ee" : colors.stroke}
              strokeWidth={n.ready ? 1.8 : 1}
              strokeDasharray={n.ready ? "5 3" : undefined}
            />
            {n.ready ? (
              <circle cx={p.x + 10} cy={p.y + H / 2} r={3} fill="#22d3ee" />
            ) : null}
            {sub ? (
              <>
                <text
                  x={p.x + 18}
                  y={p.y + H / 2 - 3}
                  fontSize={11}
                  fontWeight={600}
                  fill={colors.text}
                  fontFamily="inherit"
                >
                  {label}
                </text>
                <text
                  x={p.x + 18}
                  y={p.y + H / 2 + 11}
                  fontSize={9.5}
                  fill={colors.text}
                  opacity={0.7}
                  fontFamily="inherit"
                >
                  {sub}
                </text>
              </>
            ) : (
              <text
                x={p.x + 18}
                y={p.y + H / 2 + 4}
                fontSize={11}
                fill={colors.text}
                fontFamily="inherit"
              >
                {label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
