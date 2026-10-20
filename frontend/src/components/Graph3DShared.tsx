/** Graph3D 子模块——顶层类型/常量/纯函数（纯搬移，加 export 前缀）。 */
import type * as THREE from "three";
import type { ForceGraph3DInstance } from "3d-force-graph";

export interface G3DNodeInput {
  id: string;
  name: string;
  virtual?: boolean;
  category?: string;
  agent?: string;
  /** d3-force 运行时写入的布局坐标（引擎跑过即有值）。 */
  x?: number;
  y?: number;
  z?: number;
}

export interface G3DLinkInput {
  source: string;
  target: string;
}

export const ENGINE_CREDIT = "3d-force-graph (MIT) + three.js (MIT)";

// ── 相机适配（QwenPaw 2.2 MemoryGraphView 逐行移植，开源，
// 出处已在文件头注明）。官方三处调用时机：
// ① 建图后 rAF 立即 fit（0ms）——初始视角不再卡默认远位（「无限远」
// 根因：此前版本只有 onEngineStop fit，引擎收敛前相机停在默认位，
// fog 把远处节点全吞掉）
// ② 引擎收敛 onEngineStop → 平滑 480ms 重 fit
// ③ resize → 220ms 重 fit（仅无选中态）
// 算法：包围盒中心 target + 视角半径 viewRadius（距 target 最远节点，
// 下限 30）→ distance = viewRadius / tan(fov/2) × 0.92 → 沿当前视线
// 方向把相机平移到 distance 处并 lookAt target；同步收紧 zoom 上下限
// 与 far 平面（官方 applyGraphZoomLimits 同式）。
// ──
export const GRAPH_ZOOM_MIN_DISTANCE_FLOOR = 78;
export const GRAPH_ZOOM_MIN_DISTANCE_RATIO = 0.72;
export const GRAPH_ZOOM_MAX_DISTANCE_FLOOR = 420;
export const GRAPH_ZOOM_MAX_DISTANCE_CEILING = 3600;
export const GRAPH_ZOOM_MAX_DISTANCE_MULTIPLIER = 1.8;
export const GRAPH_ZOOM_MIN_DISTANCE_CAP = 240; // 近景锁定上限（见 applyGraphZoomLimits 注释）
// 拾取球半径（世界单位）= clamp(相机到 fit 中心距离 × 系数, MIN, MAX)。
// 系数 0.055：fit 距离处 ≈ 0.033×画面高（15–30px 直径级命中区）。
export const PICK_RADIUS_COEF = 0.055;
export const PICK_RADIUS_MIN = 12;
export const PICK_RADIUS_MAX = 34;

// 自持点击层阈值——3D「点不动」根因修复。库（three-graph-renderer
// Scene）鼠标拖拽判定无距离阈值：pointerdown 后任意 pointermove（1px 手抖
// 即触发）置 isPointerDragging，pointerup 时 clickAfterDrag(false) 静默
// 吞掉点击 → onNodeClick 不触发。容器自行判定「真点击」并手动 raycast
// 节点拾取球反查命中（与库 hover 同一几何，手感一致）。
export const CLICK_TAP_MAX_MOVE_PX = 5;
export const CLICK_TAP_MAX_MS = 500;
export const CLICK_DEDUP_MS = 200;

// ── 物理收敛（，）──
// 「首访拖动卡」根因（dist 实证）：库 d3AlphaMin 默认 0 → alpha 阈值永不
// 触发，引擎 tick 到 cooldownTicks(160) 硬停——2070 节点每 tick ~8ms
// 物理与 orbit 交互/渲染竞争（60fps 下 ~2.7s 卡顿窗口），引擎停后即
// 顺滑（与「过一会/切走再切回就顺了」完全吻合）。
// 修复 = warmup 前置 + 启用 alpha 阈值：首帧后即 1-2 帧内停引擎。
// 布局形态不变：warmup 与 live 是同一段 tick 序列（同轨迹），只改
// 「首帧前跑多少 tick / 尾部截断点」；力参数与 dashboard 孪生保持
// 同值（charge -50 / link 38/0.52 / decay 0.038），仅收敛时机为本
// 组件 专属。
// 同步阻塞成本（容器 CPU 实测 d3-force-3d 同参基准）：2070 节点
// ≈0.95s / 300 节点 ≈0.13s / 40 节点 ≈8ms——「布局计算中」遮罩下的
// 一次性成本，换交互期零物理竞争。
export const WARMUP_TICKS_CAP = 200;
// 自适应收敛阈值：大图 alpha 0.01 截断（该处每 tick 漂移已亚像素级，
// 比 0.001 省 ~0.5s 主线程阻塞）；小图（≤500 节点）保留 0.001 全精度
// ——179 tick 成本 ≤0.15s，无理由牺牲。
export const LARGE_GRAPH_NODE_THRESHOLD = 500;
export const alphaMinFor = (nodeCount: number): number =>
  nodeCount > LARGE_GRAPH_NODE_THRESHOLD ? 0.01 : 0.001;

export function applyGraphZoomLimits(graph: ForceGraph3DInstance, fitDistance: number): void {
  const controls = graph.controls() as {
    minDistance: number;
    maxDistance: number;
  };
  // 官方式 minDistance = max(78, fit×0.72) 对大图会把近景锁死
  // （fit 1000+ → min 720+，放大极限不够）；官方记忆图小无感。
  // 修正：近景锁定封顶 GRAPH_ZOOM_MIN_DISTANCE_CAP（官方下限 78 起，
  // 大图最多锁到 240——仍可贴近读节点标签/环）。
  controls.minDistance = Math.max(
    GRAPH_ZOOM_MIN_DISTANCE_FLOOR,
    Math.min(
      fitDistance * GRAPH_ZOOM_MIN_DISTANCE_RATIO,
      GRAPH_ZOOM_MIN_DISTANCE_CAP,
    ),
  );
  controls.maxDistance = Math.max(
    fitDistance,
    Math.min(
      GRAPH_ZOOM_MAX_DISTANCE_CEILING,
      Math.max(
        GRAPH_ZOOM_MAX_DISTANCE_FLOOR,
        fitDistance * GRAPH_ZOOM_MAX_DISTANCE_MULTIPLIER,
      ),
    ),
  );
  const camera = graph.camera() as unknown as THREE.PerspectiveCamera;
  const requiredFarPlane = controls.maxDistance * 1.6;
  if (camera.far < requiredFarPlane) {
    camera.far = requiredFarPlane;
    camera.updateProjectionMatrix();
  }
}

export function fitGraphModel(
  graph: ForceGraph3DInstance,
  nodes: G3DNodeInput[],
  duration: number,
  targetRef?: { current: { x: number; y: number; z: number } | null },
): void {
  const positioned = nodes.filter(
    (n) =>
      Number.isFinite(n.x) &&
      Number.isFinite(n.y) &&
      Number.isFinite(n.z),
  );
  if (positioned.length < 2) {
    if (targetRef) targetRef.current = null;
    if (nodes.length < 2) {
      applyGraphZoomLimits(
        graph,
        GRAPH_ZOOM_MIN_DISTANCE_FLOOR / GRAPH_ZOOM_MIN_DISTANCE_RATIO,
      );
    }
    graph.zoomToFit(duration, 64);
    return;
  }
  const bounds = positioned.reduce(
    (cur, n) => ({
      maxX: Math.max(cur.maxX, Number(n.x)),
      maxY: Math.max(cur.maxY, Number(n.y)),
      maxZ: Math.max(cur.maxZ, Number(n.z)),
      minX: Math.min(cur.minX, Number(n.x)),
      minY: Math.min(cur.minY, Number(n.y)),
      minZ: Math.min(cur.minZ, Number(n.z)),
    }),
    {
      maxX: -Infinity,
      maxY: -Infinity,
      maxZ: -Infinity,
      minX: Infinity,
      minY: Infinity,
      minZ: Infinity,
    },
  );
  const target = {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
    z: (bounds.minZ + bounds.maxZ) / 2,
  };
  if (targetRef) targetRef.current = { ...target };
  const camera = graph.camera() as unknown as THREE.PerspectiveCamera;
  const viewRadius = Math.max(
    ...positioned.map(
      (n) =>
        Math.hypot(
          Number(n.x) - target.x,
          Number(n.y) - target.y,
          Number(n.z) - target.z,
        ),
    ),
    30,
  );
  const distance =
    (viewRadius / Math.tan((camera.fov * Math.PI) / 360)) * 0.92;
  applyGraphZoomLimits(graph, distance);
  const currentCamera = graph.cameraPosition();
  const offset = {
    x: currentCamera.x - target.x,
    y: currentCamera.y - target.y,
    z: currentCamera.z - target.z,
  };
  const offsetLength =
    Math.hypot(offset.x, offset.y, offset.z) || 1;
  graph.cameraPosition(
    {
      x: target.x + (offset.x / offsetLength) * distance,
      y: target.y + (offset.y / offsetLength) * distance,
      z: target.z + (offset.z / offsetLength) * distance,
    },
    target,
    duration,
  );
}

/** 节点半径——QwenPaw graphNodeRadius 同值。 */
export function nodeRadius(n: G3DNodeInput, isRoot: boolean, isDirect: boolean, degree: number): number {
  if (isRoot) return 4.8;
  if (isDirect) return 3.55;
  if (n.virtual) return 2.55;
  return Math.min(3.35, 2.7 + Math.sqrt(degree) * 0.24);
}

/** 选中/静音态直接操作 material 所需的引用与基准值
 * （QwenPaw GraphNodeVisual 同结构）。 */
export interface NodeVisual {
  coreMat: THREE.MeshStandardMaterial;
  orbit: THREE.Mesh;
  orbitMat: THREE.MeshBasicMaterial;
  glow: THREE.Mesh;
  glowMat: THREE.MeshBasicMaterial;
  /** 拾取放大球（单位球几何，scale=当前拾取半径，随相机距离自适应）。 */
  pick: THREE.Mesh;
  baseColor: string;
  isRoot: boolean;
  isDirect: boolean;
  isVirtual: boolean;
}

export interface G3DGraph {
  nodes: G3DNodeInput[];
  links: G3DLinkInput[];
  colorFor: (n: G3DNodeInput) => string;
  isRoot: (n: G3DNodeInput) => boolean;
  isDirect: (n: G3DNodeInput) => boolean;
  onOpenNode: (n: G3DNodeInput) => void;
  /** 选中状态外抛（详情面板双视图共享）。 */
  onSelect?: (id: string) => void;
  onExit3D: () => void;
  height?: number;
}

// 类型收编（按 three-forcegraph / 3d-force-graph d.ts 实际声明）：
// NodeObject/LinkObject 全 optional 字段，G3DNodeRuntime/G3DLinkRuntime 可赋给
// node*/link* accessor 泛型（参数双变）。

/** palette useMemo 的形状（主壳 → buildNodeVisual 传参）。 */
export interface G3DPalette {
  surface: string;
  label: string;
  labelBackground: string;
  labelBorder: string;
  root: string;
  active: string;
  muted: string;
  isDark: boolean;
}

/** 闭包读最新值的 stateRef 形状（accessor 不随重渲染重建）。 */
export interface G3DState {
  palette: G3DPalette;
  colorFor: (n: G3DNodeInput) => string;
  isRoot: (n: G3DNodeInput) => boolean;
  isDirect: (n: G3DNodeInput) => boolean;
  onOpenNode: (n: G3DNodeInput) => void;
  neighborSets: Map<string, Set<string>>;
  degree: Map<string, number>;
  nodeCount: number;
}

/** graphData 节点——G3DNodeInput + useMemo 计算列（d3 运行时另写 x/y/z）。 */
export interface G3DNodeRuntime extends G3DNodeInput {
  val: number;
  _deg: number;
}

/** graphData 链接——G3DLinkInput + 双向边标记。 */
export interface G3DLinkRuntime extends G3DLinkInput {
  _bi: boolean;
}

/** OrbitControls 用到的形状——d.ts controls(): object，按实际使用面收口。 */
export interface G3DControls {
  minDistance: number;
  maxDistance: number;
  autoRotate: boolean;
  target: { x: number; y: number; z: number };
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}
