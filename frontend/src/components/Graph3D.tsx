import type * as ReactNS from "react";
import * as THREE from "three";
import SpriteText from "three-spritetext";
import ForceGraph3DImpl, { type ForceGraph3DInstance } from "3d-force-graph";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

/** 3D 知识图谱**完全对齐 QwenPaw 2.2 MemoryGraphView**
 * （对标 QwenPaw 官方知识图谱实现——同引擎同宿主，
 * 逐行照抄其渲染配方，不再自创）。
 *
 * 两轮修复后实锤的三个官方要点：
 * ① **节点完全自绘**：nodeThreeObject 返回自定义 Group
 * （MeshStandardMaterial 球体 + root 轨道环 + 光晕 + SpriteText
 * 标签），nodeThreeObjectExtend(**false**) 替换默认球——
 * 不依赖默认节点对象（用 extend=true 赌默认球存在，错了）。
 * ② **nodeOpacity 只接受数字**（three-forcegraph mjs L1168
 * `state.nodeOpacity * colorAlpha(color)` 直接乘——传函数 =
 * opacity NaN = 节点全隐形，历史版本「什么都没有只剩箭头」根因；
 * d.ts 声明 number 是对的）。选中变暗改**直接操作存下来的
 * material**（QwenPaw nodeVisuals map + applyGraphVisualState
 * 同模式）。
 * ③ **DOM 所有权**（已修，保留）：3D 容器零 React 子节点、
 * 遮罩兄弟位、cleanup el.replaceChildren()。
 *
 * 参数全部抄 QwenPaw（radius/灯光/fog/相机/物理/链接逐值对齐），
 * 开源引用：three.js (MIT) / 3d-force-graph (MIT, Vasturiano) /
 * three-spritetext (MIT, Jay Weisskopf)——包内 THIRD-PARTY-NOTICES.md。
 */

interface G3DNodeInput {
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
interface G3DLinkInput {
  source: string;
  target: string;
}

const ENGINE_CREDIT = "3d-force-graph (MIT) + three.js (MIT)";

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
const GRAPH_ZOOM_MIN_DISTANCE_FLOOR = 78;
const GRAPH_ZOOM_MIN_DISTANCE_RATIO = 0.72;
const GRAPH_ZOOM_MAX_DISTANCE_FLOOR = 420;
const GRAPH_ZOOM_MAX_DISTANCE_CEILING = 3600;
const GRAPH_ZOOM_MAX_DISTANCE_MULTIPLIER = 1.8;
const GRAPH_ZOOM_MIN_DISTANCE_CAP = 240; // 近景锁定上限（见 applyGraphZoomLimits 注释）
// 拾取球半径（世界单位）= clamp(相机到 fit 中心距离 × 系数, MIN, MAX)。
// 系数 0.055：fit 距离处 ≈ 0.033×画面高（15–30px 直径级命中区）。
const PICK_RADIUS_COEF = 0.055;
const PICK_RADIUS_MIN = 12;
const PICK_RADIUS_MAX = 34;

// 自持点击层阈值——3D「点不动」根因修复。库（three-graph-renderer
// Scene）鼠标拖拽判定无距离阈值：pointerdown 后任意 pointermove（1px 手抖
// 即触发）置 isPointerDragging，pointerup 时 clickAfterDrag(false) 静默
// 吞掉点击 → onNodeClick 不触发。容器自行判定「真点击」并手动 raycast
// 节点拾取球反查命中（与库 hover 同一几何，手感一致）。
const CLICK_TAP_MAX_MOVE_PX = 5;
const CLICK_TAP_MAX_MS = 500;
const CLICK_DEDUP_MS = 200;

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
const WARMUP_TICKS_CAP = 200;
// 自适应收敛阈值：大图 alpha 0.01 截断（该处每 tick 漂移已亚像素级，
// 比 0.001 省 ~0.5s 主线程阻塞）；小图（≤500 节点）保留 0.001 全精度
// ——179 tick 成本 ≤0.15s，无理由牺牲。
const LARGE_GRAPH_NODE_THRESHOLD = 500;
const alphaMinFor = (nodeCount: number): number =>
  nodeCount > LARGE_GRAPH_NODE_THRESHOLD ? 0.01 : 0.001;

function applyGraphZoomLimits(graph: ForceGraph3DInstance, fitDistance: number): void {
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

function fitGraphModel(
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
function nodeRadius(n: G3DNodeInput, isRoot: boolean, isDirect: boolean, degree: number): number {
  if (isRoot) return 4.8;
  if (isDirect) return 3.55;
  if (n.virtual) return 2.55;
  return Math.min(3.35, 2.7 + Math.sqrt(degree) * 0.24);
}

/** 选中/静音态直接操作 material 所需的引用与基准值
 * （QwenPaw GraphNodeVisual 同结构）。 */
interface NodeVisual {
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

interface G3DGraph {
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

function Graph3D(props: G3DGraph) {
  const {
    nodes,
    links,
    colorFor,
    isRoot,
    isDirect,
    onOpenNode,
    onSelect,
    onExit3D,
    height = 480,
  } = props;
  const t = useThemeColors();
  const tr = useT();
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const graphRef = React.useRef<any>(null);
  const [ready, setReady] = React.useState(false);
  // 换数据（切 KB agent）= 又一次
  // warmup 同步阻塞（大图 ~1s）——无遮罩=无解释的 UI 冻结。双 rAF 先
  // 上屏再阻塞（直接 setState→同步阻塞会让遮罩来不及 paint）。
  const [recomputing, setRecomputing] = React.useState(false);
  const [webglFail, setWebglFail] = React.useState(false);
  const [initError, setInitError] = React.useState("");
  const [autoRotate, setAutoRotate] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState("");
  // 选中 ref（onNodeClick 只在 init effect
  // 注册一次，闭包读不到最新 selectedId，走 ref 同步）。
  const selIdRef = React.useRef("");
  React.useEffect(() => {
    selIdRef.current = selectedId;
  }, [selectedId]);
  // fit 中心（拾取球自适应距离基准）+ hover 节点（ref 直改
  // material，零 re-render——hover 是高频事件）。
  const fitTargetRef = React.useRef<{
    x: number;
    y: number;
    z: number;
  } | null>(null);
  const hoverIdRef = React.useRef("");
  // 库自身 onNodeClick 触发时间戳（自持点击层去重——静止点击库已
  // 派发回调则跳过；被「拖拽」吞掉的点击库不派发 → 自持层补位）。
  const libClickRef = React.useRef<{ id: string; t: number }>({
    id: "",
    t: 0,
  });

  // 拾取球自适应缩放：所有节点拾取球 scale = clamp(距离×系数, MIN, MAX)。
  // 相机在 fit 距离处时命中区 ≈ 画面高的 3.3%（15–30px 直径）；放大/
  // 缩小/换图（viewRadius 变）都保持恒定屏幕尺寸。O(节点数)×1 赋值，
  // 'change' 事件频率下成本可忽略。
  const updatePickScales = React.useCallback(() => {
    const g = graphRef.current;
    if (!g) return;
    const cam = g.camera?.() as
      | THREE.PerspectiveCamera
      | undefined;
    if (!cam) return;
    const t = fitTargetRef.current;
    const dist = t
      ? cam.position.distanceTo(
          new THREE.Vector3(t.x, t.y, t.z),
        )
      : cam.position.length();
    const r = Math.min(
      PICK_RADIUS_MAX,
      Math.max(PICK_RADIUS_MIN, dist * PICK_RADIUS_COEF),
    );
    nodeVisualsRef.current.forEach((v) => {
      v.pick.scale.setScalar(r);
    });
  }, []);

  // hover 视觉（QwenPaw setHoveredGraphNodeColor 同机制）：悬停节点
  // 提亮 emissive + 点亮 glow——给用户可见的"对准了"反馈（瞄准辅助，
  // 比光标变化强一个量级）。选中态由选中 effect 独占，这里不碰选中节点。
  const applyHoverVisual = React.useCallback(
    (id: string, on: boolean) => {
      const v = nodeVisualsRef.current.get(id);
      if (!v || selIdRef.current === id) return;
      if (on) {
        v.coreMat.emissiveIntensity = v.isRoot
          ? 0.3
          : v.isDirect
            ? 0.28
            : 0.5;
        v.glow.visible = true;
        v.glowMat.opacity = 0.3;
      } else {
        v.coreMat.emissiveIntensity = v.isRoot
          ? 0.13
          : v.isDirect
            ? 0.07
            : 0.03;
        v.glow.visible = false;
        v.glowMat.opacity = 0;
      }
    },
    [],
  );

  // 渲染循环双位暂停状态机。
  // vis = 既有可见性门控（.7 ，切 tab/隐藏即停）；
  // idle = 稳态自动暂停——引擎已停 + 无相机 tween + 无指针交互时场景
  // 完全静态，但 3d-force-graph 循环仍 60fps 全场景 drawArrays
  // （实测 KB 驻留 2184–2944 draws/s）→ 持续垃圾 → V8 GC 常开
  // （实测驻留 6s 主线程 71% (program)）→ 切走瞬间分配波触发大 GC
  // → KB→其他 100–150ms 顿帧。稳态暂停后驻留 0 draws/s（与既有
  // 「切走即停」同机制，仅延后触发点从「切走」提前到「引擎收敛后 800ms」）。
  // 库无 onEngineStart（1.80.0 dist 实证）——引擎重启只由 graphData
  // 变更触发（数据 effect 显式复位 engineStopped），初始引擎从建图
  // 起即在转（engineStopped=false），两条路径均被覆盖。
  // re-pause 延时须 > 最长相机 tween（onEngineStop 后 60ms+480ms 重 fit /
  // 「适配视图」650ms），否则 tween 中途停帧相机停在半途。
  const GRAPH_IDLE_REPAUSE_MS = 800;
  const pauseBitsRef = React.useRef({
    vis: false,
    idle: false,
    physicallyPaused: false,
    engineStopped: false,
    rePauseTimer: 0 as number,
  });

  const applyGraphPause = React.useCallback(() => {
    const s = pauseBitsRef.current;
    const g = graphRef.current;
    if (!g) return;
    const want = s.vis || s.idle;
    if (want === s.physicallyPaused) return;
    s.physicallyPaused = want;
    try {
      if (want) g.pauseAnimation();
      else g.resumeAnimation();
    } catch {
      /* noop */
    }
  }, []);

  // 容器真实可见性（原挂载 effect 闭包版上提——RO/定时器共用）。
  const graphVisible = React.useCallback((): boolean => {
    const el = containerRef.current;
    if (document.hidden) return false;
    if (!el) return false;
    try {
      if (!el.getClientRects().length) return false;
      if (getComputedStyle(el).visibility === "hidden") return false;
      if (el.clientWidth === 0 || el.clientHeight === 0) return false;
    } catch {
      return true;
    }
    return true;
  }, []);

  const scheduleGraphIdlePause = React.useCallback(() => {
    const s = pauseBitsRef.current;
    if (s.rePauseTimer) window.clearTimeout(s.rePauseTimer);
    s.rePauseTimer = window.setTimeout(() => {
      s.rePauseTimer = 0;
      const st = pauseBitsRef.current;
      if (st.engineStopped && !st.vis && graphVisible()) {
        st.idle = true;
        applyGraphPause();
      }
    }, GRAPH_IDLE_REPAUSE_MS);
  }, [applyGraphPause, graphVisible]);

  // 活动标记：恢复（若 idle 暂停中）+ 重排 re-pause 计时器。
  // 触发点：controls change（orbit/zoom/pan/autoRotate/tween 收尾）、
  // 指针进入/移动/按下 canvas（hover raycast 在库帧循环内执行，
  // 停帧即停摆——活动必须恢复帧循环）、节点/背景点击（选中视觉）、
  // RO 尺寸变化（resize+fit）、graphData 变更（引擎重启）。
  const markGraphActivity = React.useCallback(() => {
    const s = pauseBitsRef.current;
    if (s.idle) {
      s.idle = false;
      applyGraphPause();
    }
    if (s.rePauseTimer) {
      window.clearTimeout(s.rePauseTimer);
      s.rePauseTimer = 0;
    }
    if (s.engineStopped) scheduleGraphIdlePause();
  }, [applyGraphPause, scheduleGraphIdlePause]);

  // onEngineStop 共享入口（挂载/数据两处注册的回调都先过这里）。
  const handleGraphEngineStop = React.useCallback(() => {
    const s = pauseBitsRef.current;
    s.engineStopped = true;
    if (!s.vis) scheduleGraphIdlePause();
  }, [scheduleGraphIdlePause]);

  // QwenPaw 同款 palette——官方从宿主 CSS 变量读，这里用其
  // 回退值映射（active #d9650b / muted #c7bfb8 / root #ff7f16 /
  // label 浅底桃边——原值照抄，深色按同色温推导）。
  const palette = React.useMemo(
    () => ({
      surface: t.bg,
      label:
        t.mode === "dark"
          ? "rgba(255,255,255,0.88)"
          : "#292522",
      labelBackground:
        t.mode === "dark" ? "#2a2622" : "#fffdfb",
      labelBorder:
        t.mode === "dark"
          ? "rgba(255,127,22,0.55)"
          : "#ffc58f",
      root: "#ff7f16",
      active: t.mode === "dark" ? "#ff8a33" : "#d9650b",
      muted: t.mode === "dark" ? "#57534e" : "#c7bfb8",
      isDark: t.mode === "dark",
    }),
    [t],
  );

  // 闭包读最新值（accessor 不随 React 重渲染重建）。
  const stateRef = React.useRef({
    palette,
    colorFor,
    isRoot,
    isDirect,
    onOpenNode,
    neighborSets: new Map<string, Set<string>>() as Map<string, Set<string>>,
    degree: new Map<string, number>(),
    nodeCount: 0,
  });
  stateRef.current.palette = palette;
  stateRef.current.colorFor = colorFor;
  stateRef.current.isRoot = isRoot;
  stateRef.current.isDirect = isDirect;
  stateRef.current.onOpenNode = onOpenNode;
  stateRef.current.nodeCount = nodes.length;

  // 度数表（半径 + 标签阈值）。
  const degree = React.useMemo(() => {
    const d = new Map<string, number>();
    links.forEach((e) => {
      d.set(e.source, (d.get(e.source) || 0) + 1);
      d.set(e.target, (d.get(e.target) || 0) + 1);
    });
    return d;
  }, [links]);
  stateRef.current.degree = degree;

  const neighborSets = React.useMemo(() => {
    const m = new Map<string, Set<string>>();
    links.forEach((e) => {
      if (!m.has(e.source)) m.set(e.source, new Set());
      m.get(e.source)!.add(e.target);
      if (!m.has(e.target)) m.set(e.target, new Set());
      m.get(e.target)!.add(e.source);
    });
    return m;
  }, [links]);
  stateRef.current.neighborSets = neighborSets;

  // 自绘节点对象——QwenPaw createGraphNodeVisual 同构。
  const nodeVisualsRef = React.useRef(
    new Map<string, NodeVisual>(),
  );

  const buildNodeVisual = (
    n: G3DNodeInput,
  ): { obj: THREE.Group; visual: NodeVisual } => {
    const s = stateRef.current;
    const p = s.palette;
    const root = s.isRoot(n);
    const direct = s.isDirect(n);
    const deg = s.degree.get(n.id) || 0;
    const radius = nodeRadius(n, root, direct, deg);
    const segments = s.nodeCount > 220 ? 14 : 24;
    const obj = new THREE.Group();
    const baseColor = s.colorFor(n);

    // 核心球（MeshStandardMaterial + 自发光同色——QwenPaw 原值）。
    const coreMat = new THREE.MeshStandardMaterial({
      color: baseColor,
      emissive: new THREE.Color(baseColor),
      emissiveIntensity: root ? 0.14 : direct ? 0.07 : 0.03,
      metalness: root || direct ? 0.08 : 0.035,
      opacity: n.virtual ? 0.74 : 1,
      roughness: root ? 0.38 : direct ? 0.46 : 0.58,
      transparent: Boolean(n.virtual),
      wireframe: Boolean(n.virtual) && !root,
    });
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(
        radius,
        segments,
        Math.max(10, segments - 6),
      ),
      coreMat,
    );
    obj.add(core);

 // 拾取放大球（引入，改自适应——命中区还是太小）。
    // 可见球半径只有 2.55–4.8 世界单位（link distance 72），而团队合并
    // 图谱（100+ 节点）fit 后 viewRadius 大，节点屏幕占比远小于官方
    // 单 agent 记忆图谱（10–40 节点）——同半径不同图规模=屏幕尺寸不同。
    // 官方在它的图规模下"点得中"，靠不了照抄半径，靠的是目标在屏幕上
    // 恒有足够像素。这里：单位球几何 + scale 随相机距离联动
    // （updatePickScales），保证屏幕命中区恒定 ≈15–30px，缩放/换图
    // 都自适应。material.visible=false = 不渲染，但 mesh 对
    // THREE.Raycaster 仍可见；force-graph hover/click 走
    // intersectingObjects(recursive) + getGraphObj 父级回溯到节点组。
    // 半径 clamp[12,34]：34 < 典型邻节点间距（link 72）→ 不互抢。
    const pickMat = new THREE.MeshBasicMaterial({ visible: false });
    const pick = new THREE.Mesh(
      new THREE.SphereGeometry(1, 10, 7),
      pickMat,
    );
    pick.scale.setScalar(PICK_RADIUS_MIN);
    // 自持点击层 raycast 命中后由此反查节点 id。
    pick.userData.nodeId = n.id;
    obj.add(pick);

    // root 轨道环（QwenPaw 同款 Torus）。
    const orbitMat = new THREE.MeshBasicMaterial({
      color: p.root,
      depthWrite: false,
      opacity: root ? 0.42 : 0,
      transparent: true,
    });
    const orbit = new THREE.Mesh(
      new THREE.TorusGeometry(
        radius * 1.43,
        radius * 0.035,
        8,
        44,
      ),
      orbitMat,
    );
    orbit.rotation.set(
      Math.PI * 0.38,
      Math.PI * 0.12,
      Math.PI * 0.08,
    );
    orbit.visible = root;
    obj.add(orbit);

    // 光晕（选中时点亮——QwenPaw glow 同机制）。
    const glowMat = new THREE.MeshBasicMaterial({
      color: p.active,
      depthWrite: false,
      opacity: 0,
      side: THREE.BackSide,
      transparent: true,
    });
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 1.28, 18, 12),
      glowMat,
    );
    glow.visible = false;
    obj.add(glow);

 // 标签——与 dashboard 知识库 3D 同标准：全节点标注（验收「每个点都有
    // 标题」；旧官方条件 count<=42 || root || deg>=4 废弃，双端对齐）。
    // SpriteText(text, textHeight世界单位, color)；fontSize=76 是
    // 画布分辨率（清晰度），不是字号（混淆了两者）。
    {
      const raw = String(n.name);
      const text =
        raw.length > 22 ? `${raw.slice(0, 21)}…` : raw;
      const label = new SpriteText(
        text,
        root ? 4.3 : 3.7,
        p.label,
      );
      label.backgroundColor = root
        ? p.labelBackground
        : "transparent";
      label.borderColor = p.labelBorder;
      label.borderRadius = 1.1;
      label.borderWidth = root ? 0.14 : 0;
      label.fontFace =
        "Inter, ui-sans-serif, system-ui, sans-serif";
      label.fontSize = 76;
      label.fontWeight = root ? "650" : "560";
      label.padding = root ? [1.05, 0.68] : [0.32, 0.1];
      label.position.set(0, -(radius + 3.6), 0);
      label.renderOrder = 4;
      obj.add(label);
    }

    return {
      obj,
      visual: {
        coreMat,
        orbit,
        orbitMat,
        glow,
        glowMat,
        pick,
        baseColor,
        isRoot: root,
        isDirect: direct,
        isVirtual: Boolean(n.virtual),
      },
    };
  };

  const graphData = React.useMemo(() => {
    const s = stateRef.current;
    const nd = nodes.map((n) => {
      const deg = s.degree.get(n.id) || 0;
      const r = nodeRadius(
        n,
        s.isRoot(n),
        s.isDirect(n),
        deg,
      );
      return { ...n, val: r ** 3, _deg: deg };
    });
    const idset = new Set(nodes.map((n) => n.id));
    const lk = links
      .filter((l) => idset.has(l.source) && idset.has(l.target))
      .map((l) => ({
        source: l.source,
        target: l.target,
        _bi:
          l.source < l.target &&
          links.some(
            (o) =>
              o.source === l.target &&
              o.target === l.source,
          ),
      }));
    return { nodes: nd, links: lk };
  }, [nodes, links, degree]);

  // latest-ref：init 效果的 ResizeObserver 闭包只捕获首帧 graphData，
  // 数据更新后 resize 重 fit 必须用当前节点（官方 resizeAndFit 同理
  // 取当前 graphModel；此处用 ref 避免闭包陈旧）。
  const graphDataRef = React.useRef(graphData);
  React.useEffect(() => {
    graphDataRef.current = graphData;
  }, [graphData]);

  // 挂载 3D 图（一次）；数据变化时换 graphData。
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el || nodes.length === 0) return;
    try {
      const cv = document.createElement("canvas");
      const gl =
        cv.getContext("webgl2") || cv.getContext("webgl");
      if (!gl) {
        setWebglFail(true);
        return;
      }
    } catch {
      setWebglFail(true);
      return;
    }
    let cancelled = false;
    const p = stateRef.current.palette;
    // 容器 = 3d 独占 DOM（零 React 子节点）。
    try {
      el.replaceChildren();
    } catch {
      /* noop */
    }

    try {
      // 节点点击激活（root=相机聚焦不选中；其余=切换选中+开预览）。
      // 库 onNodeClick 与自持点击层共用此出口。
      const handleNodeActivate = (n: G3DNodeInput) => {
        if (stateRef.current.isRoot(n)) {
          // root 大球不再是"点了没反应"的最大目标——
          // 官方 onNodeClick=focusGraphNode 同款：相机聚焦到 root
          // （centerAt 600ms 平滑），不选中。
          try {
            graphRef.current?.centerAt(n.x, n.y, n.z, 600);
          } catch {
            /* noop */
          }
          return;
        }
        const next = selIdRef.current === n.id ? "" : n.id;
        setSelectedId(next);
        onSelect?.(next);
        // 点文件节点直接开预览（2D 同款）。改为
 // 「点选+面板按钮」后点没反应——再选中才开，再次点击仅取消选中。
        if (next) stateRef.current.onOpenNode(n);
      };

      // 实例类型化（tsc 对照 d.ts 验证链式调用）。
      const graph = new ForceGraph3DImpl(el, {
        controlType: "orbit",
 // 混合 GPU 机器优先独显（真机
        // 卡顿面——核显跑 2070 节点 4 灯 MeshStandard 场景 fillrate 吃
        // 紧）。antialias 保持（库默认 true；关掉球体边缘锯齿=可见
        // 劣化，不偿失）。
        rendererConfig: {
          powerPreference: "high-performance",
        },
      })
        .width(Math.max(1, el.clientWidth || 960))
        .height(height)
        .backgroundColor(p.surface)
        .numDimensions(3)
        .nodeId("id")
        // 自绘节点（官方 extend=false 替换默认）+ nodeOpacity
        // **必须数字**（L1168 直接乘，函数=NaN 全隐形）。
        .nodeRelSize(1)
        .nodeVal((n: any) => n.val)
        .nodeOpacity(1)
        .nodeResolution(24)
        .nodeColor(() => "#ffffff")
        .nodeThreeObject((n: any) => {
          nodeVisualsRef.current.delete(n.id);
          const { obj, visual } = buildNodeVisual(n);
          nodeVisualsRef.current.set(n.id, visual);
          return obj;
        })
        .nodeThreeObjectExtend(false)
        // 官方同款：禁内置 HTML tooltip（自绘标签已覆盖）。
        .nodeLabel(() => "")
        .linkOpacity(0.64)
        .linkResolution(4)
        .linkColor(() =>
          p.isDark
            ? "rgba(255,255,255,0.55)"
            : "rgba(0,0,0,0.42)",
        )
        .linkDirectionalArrowRelPos(0.94)
        .linkDirectionalArrowLength(4.2)
        .linkDirectionalArrowResolution(10)
        .linkDirectionalArrowColor(() =>
          p.isDark
            ? "rgba(255,255,255,0.6)"
            : "rgba(0,0,0,0.5)",
        )
        // 官方双向边曲率 ±0.12（单向 0）。
        .linkCurvature((l: any) => (l._bi ? 0.12 : 0))
        .enableNodeDrag(false)
        .enableNavigationControls(true)
 // 物理——力参数与 dashboard 知识库 3D 图谱定值同值（见下方
 // charge/link 设置）；收敛时机 重构（见 WARMUP_TICKS_CAP /
        // alphaMinFor 注释）：同轨迹，只改首帧前/尾部截断点。
        .d3AlphaDecay(0.038)
        .d3VelocityDecay(0.3)
 // 启用 alpha 停引擎阈值
        // （库默认 0 = 永不触发 → tick 到 cooldownTicks 硬停，首访
        // 2.7s 卡顿窗口根因）。
        .d3AlphaMin(alphaMinFor(nodes.length))
        // warmup 前置：循环内由 d3AlphaMin 阈值自动截断（大图 ~120
        // tick / 小图 ~179 tick），200 上限仅兜底——首帧即带近收敛
        // 布局，交互期引擎 1-2 帧内停。
        .warmupTicks(WARMUP_TICKS_CAP)
        .cooldownTicks(160)
        .graphData({ nodes: [], links: [] })
        // 点击激活逻辑抽成共享函数——库 onNodeClick（静止点击）与
        // 自持点击层（被吞点击补位）走同一出口，行为完全一致。
        .onNodeClick((n: any) => {
          markGraphActivity(); // 选中视觉变更需帧；稳态暂停中点击须先恢复
          libClickRef.current = {
            id: n.id,
            t: performance.now(),
          };
          handleNodeActivate(n);
        })
        .onNodeHover((n: any) => {
          // hover 视觉反馈（提亮+glow）——可见的"对准了"提示。
          const prev = hoverIdRef.current;
          const next = n && !stateRef.current.isRoot(n) ? n.id : "";
          if (prev !== next) {
            if (prev) applyHoverVisual(prev, false);
            if (next) applyHoverVisual(next, true);
            hoverIdRef.current = next;
          }
          el.style.cursor = next ? "pointer" : "default";
        })
        .onBackgroundClick(() => {
          markGraphActivity(); // 取消选中的视觉变更需帧
          setSelectedId("");
          onSelect?.("");
        });

      // 相机——官方原值（fov 44 / near 0.1 / far CEILING*1.6；
      // zoom 上下限由 fitGraphModel 的 applyGraphZoomLimits 动态收紧）。
      const camera: any = graph.camera();
      camera.fov = 44;
      camera.near = 0.1;
      camera.far = GRAPH_ZOOM_MAX_DISTANCE_CEILING * 1.6;
      camera.updateProjectionMatrix();
      const controls: any = graph.controls();
      controls.minDistance = GRAPH_ZOOM_MIN_DISTANCE_FLOOR;
      controls.maxDistance = GRAPH_ZOOM_MAX_DISTANCE_CEILING;
 // 渲染像素比封顶 1.5——库初始化
      // 固定 min(2, devicePixelRatio)：2x/3x 真机上 1242×480 画布=
      // 248/508 万物理像素，fillrate 为 1x 的 2.5/6.3 倍（真机 GPU
      // 卡顿面）。1.5 封顶：2x 机省 44% 像素、3x 机省 78%；节点球/
      // 标签在 1.5 下仍清晰（dpr2 截图对照自证）。后续 setSize 沿用
      // 当前 pixelRatio，一次设置即持久（库仅 init 时调过一次）。
      try {
        graph.renderer().setPixelRatio(
          Math.min(window.devicePixelRatio || 1, 1.5),
        );
      } catch {
        /* noop */
      }
      // 相机移动（缩放/平移/旋转 tween/fit tween）→ 拾取球
      // 半径自适应（屏幕命中区恒定）。
      controls.addEventListener("change", updatePickScales);

      // 雾——官方原值。
      graph.scene().fog = new THREE.FogExp2(
        new THREE.Color(p.surface).getHex(),
        p.isDark ? 0.00085 : 0.0016,
      );
      // 四灯组——官方 createGraphLights 原值。
      const lights: THREE.Light[] = [];
      const ambient = new THREE.AmbientLight(
        "#ffffff",
        p.isDark ? 1.45 : 1.25,
      );
      const hemi = new THREE.HemisphereLight(
        "#ffffff",
        "#8899bb",
        p.isDark ? 1.22 : 1.05,
      );
      const key = new THREE.DirectionalLight(
        "#ffffff",
        p.isDark ? 2.7 : 2.3,
      );
      key.position.set(110, 150, 190);
      const fill = new THREE.DirectionalLight(
        "#ffffff",
        p.isDark ? 1.08 : 0.82,
      );
      fill.position.set(-120, -55, -90);
      lights.push(ambient, hemi, key, fill);
      lights.forEach((l) => graph.scene().add(l));
      graph.renderer().toneMappingExposure = p.isDark
        ? 1.1
        : 0.98;
      // 物理力——收紧值与 dashboard 知识库 3D 图谱定值同款（双端同值）：
      // charge -50 / 距离 38 / 强度 0.52（两轮收紧终值；原官方 -108/72/0.46
      // 与 -60/44/0.5 均废弃；不设 collide 同官方）。
      graph.d3Force("charge")?.strength?.(-50);
      const linkForce: any = graph.d3Force("link");
      linkForce?.distance?.(38);
      linkForce?.strength?.(0.52);

      // 数据灌入 + 官方双 fit：rAF 立即 fit（初始视角根治「无限远」）
      // + 引擎收敛 onEngineStop 平滑 480ms 重 fit。
      graph.graphData(graphData);
      let fitTimer = 0;
      window.requestAnimationFrame(() => {
        if (!cancelled && graphRef.current === graph) {
          fitGraphModel(
            graph,
            graphData.nodes,
            0,
            fitTargetRef,
          );
          updatePickScales();
        }
      });
      graph.onEngineStop(() => {
        if (cancelled) return;
        handleGraphEngineStop(); // 引擎收敛 → 800ms 无活动后稳态暂停
        window.clearTimeout(fitTimer);
        fitTimer = window.setTimeout(
          () => {
            if (!cancelled) {
              markGraphActivity(); // 60ms 后 480ms 重 fit——tween 期间须保持帧
              fitGraphModel(
                graph,
                graphData.nodes,
                480,
                fitTargetRef,
              );
              updatePickScales();
            }
          },
          60,
        );
      });
      graphRef.current = graph;
      setReady(true);

      // 可见性门控——3d-force-graph 渲染循环
      // 与物理冷却无关，挂载后即 60fps 永续（实测切走后仍 2340 draw calls/s）。
      // 容器不可见（rc-tabs 保活切走/收起）或页面隐藏 → vis 位暂停。
      // vis 位并入双位状态机
      // （pauseBitsRef）——idle 位（稳态自动暂停）见组件级状态机注释。
      const setVisPaused = (p: boolean) => {
        const s = pauseBitsRef.current;
        const becameVisible = !p && s.vis;
        s.vis = p;
        if (becameVisible) {
          // 切回可见 = 用户活动：清 idle 位立即恢复（对齐 .7「显示即
          // 恢复」语义，保 KB 回访 ≤1.3s 不依赖 RO 时序；回访后若引擎
          // 已收敛，800ms 再进 idle 暂停）。注意 visTimer 2s 轮询在
          // 稳态可见时 p 恒 false 且 s.vis 已 false → 不走此分支，
          // 不会周期性唤醒已暂停的图。
          markGraphActivity();
        }
        // 物理状态无条件同步（幂等，want===pp 时直接返回）——
        // RO 常先于 IO 触发（实测回访 37.9ms vs 45.0ms）：RO→
        // markGraphActivity 先清 idle（此刻 vis 位尚 true，want 仍
        // true，不恢复）；随后 IO→setVisPaused(false) 的
        // becameVisible 分支只走 markGraphActivity，而 idle 已 false
        // → 不碰 physicallyPaused → 死锁（实测回访首帧拖到 visTimer
        // 2s 轮询才恢复，1196–2080ms）。补此调用：vis/idle 全 false
        // → want false → 立即 resume。
        applyGraphPause();
      };
      const syncAnimState = () => setVisPaused(!graphVisible());
      const io = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) setVisPaused(true);
          else syncAnimState();
        },
        { threshold: 0 },
      );
      io.observe(el);
      document.addEventListener("visibilitychange", syncAnimState);
      // 兜底复查：visibility:hidden / display 变化未必触发 IO
      // （本地 DOM 状态检查，非网络拨号；5s 档足够）。
      const visTimer = window.setInterval(syncAnimState, 5000);
      syncAnimState();

      // 相机活动（orbit/zoom/pan/autoRotate/fit tween 收尾）→ 恢复 + 重排。
      const onControlsChange = () => markGraphActivity();
      controls.addEventListener("change", onControlsChange);
      // 指针进入/移动 canvas：hover raycast 在库帧循环内执行，停帧即停摆
      // ——指针一进来必须恢复帧循环（移动持续重排 re-pause）。
      const onPointerOver = () => markGraphActivity();
      el.addEventListener("pointerenter", onPointerOver);
      el.addEventListener("pointermove", onPointerOver);

      // resize → 官方 resizeAndFit：改尺寸 + 220ms 重 fit
      // （有选中态不重 fit——官方同款保护选中视角）。
      // 隐藏容器（display:none →
      // rect 0）跳过 resize——旧式 `b.width || 960` 会在切走瞬间把
      // 1242x480 缓冲重分配成 960x480（实测），切回再改回 → 双份
      // WebGL 缓冲 churn 落进切换帧。恢复可见时 RO 以真实尺寸触发。
      let resizeFrame = 0;
      const ro = new ResizeObserver(() => {
        if (!graphVisible()) return;
        markGraphActivity();
        const b = el.getBoundingClientRect();
        graph.width(Math.max(1, Math.round(b.width || 960)));
        graph.height(height);
        window.cancelAnimationFrame(resizeFrame);
        resizeFrame = window.requestAnimationFrame(() => {
          if (!selIdRef.current) {
            fitGraphModel(
              graph,
              graphDataRef.current.nodes,
              220,
              fitTargetRef,
            );
            updatePickScales();
          }
        });
      });
      ro.observe(el);

      // 自持点击层（根因修复「3D 点不动」——库鼠标拖拽判定无距离
      // 阈值，1px 手抖即吞点击；详见文件头 CLICK_TAP_* 常量注释）。
      // 容器自行记录 pointerdown/up：位移 <5px 且 <500ms = 真点击 →
      // raycast 节点拾取球（PICK 球，与库 hover 同一几何）反查命中 →
      // 走 handleNodeActivate。库监听同元素更早注册先派发：静止点击库
      // 已回调 → CLICK_DEDUP_MS 窗口内跳过，双路不重复。
      let pressInfo:
        | { x: number; y: number; t: number; pid: number }
        | null = null;
      const onSelfPointerDown = (ev: PointerEvent) => {
        if (ev.button !== 0) return;
        markGraphActivity(); // 按下 = 交互开始（拖拽旋转/长按）
        pressInfo = {
          x: ev.clientX,
          y: ev.clientY,
          t: performance.now(),
          pid: ev.pointerId,
        };
      };
      const onSelfPointerUp = (ev: PointerEvent) => {
        if (!pressInfo || ev.pointerId !== pressInfo.pid) return;
        const moved = Math.hypot(
          ev.clientX - pressInfo.x,
          ev.clientY - pressInfo.y,
        );
        const held = performance.now() - pressInfo.t;
        pressInfo = null;
        if (
          moved > CLICK_TAP_MAX_MOVE_PX ||
          held > CLICK_TAP_MAX_MS
        )
          return; // 真拖拽（旋转视角）/长按——不是点击
        if (
          performance.now() - libClickRef.current.t <
          CLICK_DEDUP_MS
        )
          return; // 库已派发（静止点击）
        const g = graphRef.current;
        const cam = g?.camera?.() as
          | THREE.PerspectiveCamera
          | undefined;
        if (!g || !cam) return;
        const rect = el.getBoundingClientRect();
        const ndc = new THREE.Vector2(
          ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
          -((ev.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
        );
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(ndc, cam);
        const pickMeshes: THREE.Object3D[] = [];
        nodeVisualsRef.current.forEach((v) => pickMeshes.push(v.pick));
        const hits = raycaster.intersectObjects(pickMeshes, false);
        const hitId = hits.length
          ? ((hits[0].object.userData.nodeId as string) || "")
          : "";
        if (!hitId) return;
        const node = graphDataRef.current.nodes.find(
          (nd) => nd.id === hitId,
        );
        if (node) handleNodeActivate(node);
      };
      el.addEventListener("pointerdown", onSelfPointerDown);
      el.addEventListener("pointerup", onSelfPointerUp);

      return () => {
        cancelled = true;
        window.clearTimeout(fitTimer);
        window.cancelAnimationFrame(resizeFrame);
        const pb = pauseBitsRef.current;
        if (pb.rePauseTimer) {
          window.clearTimeout(pb.rePauseTimer);
          pb.rePauseTimer = 0;
        }
        pb.idle = false;
        ro.disconnect();
        io.disconnect();
        document.removeEventListener("visibilitychange", syncAnimState);
        window.clearInterval(visTimer);
        el.removeEventListener("pointerdown", onSelfPointerDown);
        el.removeEventListener("pointerup", onSelfPointerUp);
        el.removeEventListener("pointerenter", onPointerOver);
        el.removeEventListener("pointermove", onPointerOver);
        try {
          (graph.controls?.() as any)?.removeEventListener?.(
            "change",
            updatePickScales,
          );
          (graph.controls?.() as any)?.removeEventListener?.(
            "change",
            onControlsChange,
          );
        } catch {
          /* noop */
        }
        try {
          graph._destructor?.();
        } catch {
          /* noop */
        }
        // _destructor 不清 DOM——canvas/navInfo 残留会撞 React
        // 协调（历史修复的根因）。官方 container.replaceChildren() 同款。
        try {
          el.replaceChildren();
        } catch {
          /* noop */
        }
        graphRef.current = null;
        setReady(false);
      };
    } catch (e) {
      // 引擎异常 → 降级 2D 不炸 tab（历史修复）。
      try {
        el.replaceChildren();
      } catch {
        /* noop */
      }
      setInitError(
        e instanceof Error ? e.message : String(e),
      );
      return undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 数据变化 → 换图 + 重新 fit（选中态清空、visual 表由
  // nodeThreeObject accessor 重建）。
  // 真实换数据时 warmup 同步阻塞
  // （大图 ~1s）——双 rAF 先让「布局计算中」遮罩上屏再阻塞。首次
  // 挂载 ready=false→true 重跑时 graphData 引用未变（init effect 已
  // 灌入同一对象，库 kapsule 按引用 no-op）→ 跳过遮罩与双 rAF，
  // 避免 2 帧遮罩闪。
  const lastGraphDataRef = React.useRef(graphData);
  React.useEffect(() => {
    const g = graphRef.current;
    if (!g || !ready) return;
    const isDataChange = lastGraphDataRef.current !== graphData;
    lastGraphDataRef.current = graphData;
    setSelectedId("");
    hoverIdRef.current = "";
    nodeVisualsRef.current.clear();
    // 换数据 = 引擎重启——复位收敛态
    // 并恢复帧循环（库无 onEngineStart，重启路径只有此处）。
    pauseBitsRef.current.engineStopped = false;
    markGraphActivity();
    const loadData = () => {
      // 自适应收敛阈值须在 graphData
      // 之前设（warmup 循环读 state.d3AlphaMin 决定截断点）。
      g.d3AlphaMin(alphaMinFor(graphData.nodes.length));
      g.graphData(graphData);
      // 官方同款：换数据立即 fit（0ms）+ 引擎收敛后平滑 480ms 重 fit。
      window.requestAnimationFrame(() => {
        if (graphRef.current === g) {
          fitGraphModel(g, graphData.nodes, 0, fitTargetRef);
          updatePickScales();
        }
      });
      let ft = 0;
      g.onEngineStop(() => {
        handleGraphEngineStop();
        window.clearTimeout(ft);
        ft = window.setTimeout(
          () => {
            markGraphActivity(); // 480ms 重 fit——tween 期间须保持帧
            fitGraphModel(g, graphData.nodes, 480, fitTargetRef);
            updatePickScales();
          },
          60,
        );
      });
      setRecomputing(false);
    };
    if (isDataChange) {
      setRecomputing(true);
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          if (graphRef.current !== g) return;
          loadData();
        });
      });
    } else {
      loadData();
    }
  }, [
    graphData,
    ready,
    updatePickScales,
    markGraphActivity,
    handleGraphEngineStop,
  ]);

  // 选中态 → **直接操作 material**——QwenPaw applyGraphVisualState
  // 逐行同构（nodeOpacity 不支持 accessor，隐形根因；
  // 不透明材质调 opacity 无效，必须切 transparent + needsUpdate）。
  React.useEffect(() => {
    const p = stateRef.current.palette;
    const nb = selectedId
      ? neighborSets.get(selectedId)
      : undefined;
    nodeVisualsRef.current.forEach((v, id) => {
      const isSelected = id === selectedId;
      const isNeighbor = Boolean(nb && nb.has(id));
      const isMuted =
        Boolean(selectedId) && !isSelected && !isNeighbor;
      const nodeColor = isSelected
        ? p.active
        : isMuted
        ? p.muted
        : v.baseColor;
      v.coreMat.color.set(nodeColor);
      v.coreMat.emissive.set(
        isSelected ? p.active : v.baseColor,
      );
      v.coreMat.emissiveIntensity = isSelected
        ? 0.32
        : v.isRoot
        ? 0.13
        : v.isDirect
        ? 0.07
        : 0.03;
      v.coreMat.opacity = isMuted
        ? 0.24
        : v.isVirtual
        ? 0.74
        : 1;
      v.coreMat.transparent = isMuted || v.isVirtual;
      v.coreMat.needsUpdate = true;
      v.orbit.visible = isSelected || v.isRoot;
      v.orbitMat.color.set(
        isSelected ? p.active : p.root,
      );
      v.orbitMat.opacity = isSelected
        ? 0.78
        : isMuted
        ? 0.12
        : 0.42;
      v.glow.visible = isSelected;
      v.glowMat.color.set(p.active);
      v.glowMat.opacity = isSelected ? 0.13 : 0;
    });
  }, [selectedId, neighborSets]);

  // 自动旋转 = OrbitControls.autoRotate（tick 每帧
  // controls.update 生效，three-render-objects tick 实锤）。
  React.useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    if (autoRotate) markGraphActivity(); // 稳态暂停中开启须先恢复帧循环
    try {
      const controls = g.controls?.();
      if (controls) controls.autoRotate = Boolean(autoRotate);
    } catch {
      /* noop */
    }
  }, [autoRotate, ready, markGraphActivity]);

  // 缩放 = cameraPosition 相对 controls.target 位移（zoom() 未代理，
  // 历史缺陷修复）。factor<1 放大，>1 缩小。
  const zoomBy = (factor: number) => {
    const g = graphRef.current;
    if (!g) return;
    markGraphActivity(); // 240ms zoom tween——tween 期间须保持帧
    try {
      const cam = g.camera?.();
      const controls = g.controls?.();
      const target = controls?.target || { x: 0, y: 0, z: 0 };
      g.cameraPosition(
        {
          x: target.x + (cam.position.x - target.x) * factor,
          y: target.y + (cam.position.y - target.y) * factor,
          z: target.z + (cam.position.z - target.z) * factor,
        },
        240,
      );
    } catch {
      /* noop */
    }
  };

  if (webglFail) {
    return (
      <antd.Alert
        type="warning"
        showIcon
        message={tr("当前浏览器/设备不支持 WebGL，3D 图谱不可用")}
        description={tr("已自动保留 2D 图谱视图")}
        style={{ margin: "40px 0" }}
        action={
          <antd.Button size="small" onClick={onExit3D}>
            {tr("回到 2D")}
          </antd.Button>
        }
      />
    );
  }

  if (initError) {
    return (
      <antd.Alert
        type="warning"
        showIcon
        message={tr("3D 图谱初始化失败，已回退 2D")}
        description={
          <span style={{ fontFamily: "monospace" }}>
            {initError}
          </span>
        }
        style={{ margin: "40px 0" }}
        action={
          <antd.Button size="small" onClick={onExit3D}>
            {tr("回到 2D")}
          </antd.Button>
        }
      />
    );
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          gap: 6,
          alignItems: "center",
          marginBottom: 6,
          flexWrap: "wrap",
        }}
      >
        <antd.Button
          size="small"
          onClick={() => zoomBy(1 / 1.25)}
          disabled={!ready}
        >
          ＋
        </antd.Button>
        <antd.Button
          size="small"
          onClick={() => zoomBy(1.25)}
          disabled={!ready}
        >
          －
        </antd.Button>
        <antd.Button
          size="small"
          onClick={() => {
            const g = graphRef.current;
            if (g) {
              markGraphActivity(); // 650ms fit tween——tween 期间须保持帧
              fitGraphModel(g, graphData.nodes, 650);
            }
          }}
          disabled={!ready}
        >
          {tr("适配视图")}
        </antd.Button>
        <antd.Switch
          size="small"
          checked={autoRotate}
          onChange={setAutoRotate}
          disabled={!ready}
        />
        <span style={{ fontSize: 11.5, color: t.textSecondary }}>
          {tr("自动旋转")}
        </span>
        <span style={{ flex: 1 }} />
        <span
          title={ENGINE_CREDIT}
          style={{ fontSize: 11, color: t.textSecondary }}
        >
          {tr("引擎：{e}", { e: ENGINE_CREDIT })}
        </span>
        <antd.Button size="small" onClick={onExit3D}>
          {tr("回到 2D")}
        </antd.Button>
      </div>
      {/* 3D 容器零 React 子节点 + 兄弟位遮罩。 */}
      <div
        style={{
          width: "100%",
          height,
          borderRadius: 8,
          overflow: "hidden",
          border: `1px solid ${t.border}`,
          position: "relative",
        }}
      >
        <div
          ref={containerRef}
          style={{ position: "absolute", inset: 0 }}
        />
 {/* recomputing=换数据 warmup
 * 同步阻塞期（大图 ~1s），复用同一遮罩（文案相同，零 i18n 新键）。 */}
        {!ready || recomputing ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              gap: 10,
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
            }}
          >
            <antd.Spin />
            <span style={{ fontSize: 12, color: t.textSecondary }}>
              {tr("3D 布局计算中…")}
            </span>
          </div>
        ) : null}
      </div>
      <div
        style={{
          fontSize: 11.5,
          color: t.textSecondary,
          marginTop: 4,
        }}
      >
        {tr("拖拽旋转 · 滚轮缩放 · 右键平移 · 点节点选中（邻接高亮）· 点空白取消")}
      </div>
    </div>
  );
}

export default Graph3D;
