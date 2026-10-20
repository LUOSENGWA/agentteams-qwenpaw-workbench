import type * as ReactNS from "react";
import * as THREE from "three";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import type { ForceGraph3DInstance } from "3d-force-graph";
import {
  alphaMinFor,
  ENGINE_CREDIT,
  fitGraphModel,
  nodeRadius,
  PICK_RADIUS_COEF,
  PICK_RADIUS_MAX,
  PICK_RADIUS_MIN,
} from "./Graph3DShared";
import type {
  G3DControls,
  G3DGraph,
  G3DState,
  NodeVisual,
} from "./Graph3DShared";
import { useGraph3DEngine } from "./Graph3DEngine";

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
  const graphRef = React.useRef<ForceGraph3DInstance | null>(null);
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
  const stateRef = React.useRef<G3DState>({
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
  useGraph3DEngine({
    containerRef,
    nodes,
    height,
    stateRef,
    nodeVisualsRef,
    graphRef,
    fitTargetRef,
    selIdRef,
    libClickRef,
    hoverIdRef,
    pauseBitsRef,
    graphData,
    graphDataRef,
    setWebglFail,
    setInitError,
    setReady,
    setSelectedId,
    onSelect,
    updatePickScales,
    applyHoverVisual,
    markGraphActivity,
    applyGraphPause,
    graphVisible,
    handleGraphEngineStop,
  });

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
      const controls = g.controls?.() as G3DControls;
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
      const controls = g.controls?.() as G3DControls;
      const target = controls?.target || { x: 0, y: 0, z: 0 };
      // d.ts 声明 cameraPosition(position, lookAt?, transitionMs?)，
      // 原调用把 240 传第二参（any 时代历史调用；runtime 1.80.0 行为
      // 不变）——局部结构断言保原调用逐字。
      (g as unknown as {
        cameraPosition: (
          p: { x: number; y: number; z: number },
          ms?: number,
        ) => void;
      }).cameraPosition(
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
