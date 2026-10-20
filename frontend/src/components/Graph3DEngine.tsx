/** Graph3D 子模块——挂载 init effect 纯搬移为 hook（行为零变化）。
 * 类型按 3d-force-graph/three-forcegraph d.ts 收口：链头经 unknown
 * 双断言实例化 ForceGraph3DInstance<G3DNodeRuntime, G3DLinkRuntime>
 *（工厂 d.ts 不带泛型实参，accessor 默认 NodeObject → 回调逆变不过）；
 * centerAt 为真缺口（d.ts 未暴露）→ 局部结构断言 + 注释，不引入 any。 */
import type * as ReactNS from "react";
import * as THREE from "three";
import ForceGraph3DImpl, { type ForceGraph3DInstance } from "3d-force-graph";
import {
  alphaMinFor,
  CLICK_DEDUP_MS,
  CLICK_TAP_MAX_MS,
  CLICK_TAP_MAX_MOVE_PX,
  fitGraphModel,
  GRAPH_ZOOM_MAX_DISTANCE_CEILING,
  GRAPH_ZOOM_MIN_DISTANCE_FLOOR,
  WARMUP_TICKS_CAP,
} from "./Graph3DShared";
import type {
  G3DControls,
  G3DLinkRuntime,
  G3DNodeInput,
  G3DNodeRuntime,
  G3DState,
  NodeVisual,
} from "./Graph3DShared";
import { buildNodeVisual } from "./Graph3DVisuals";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

export interface Graph3DEngineCtx {
  containerRef: { current: HTMLDivElement | null };
  nodes: G3DNodeInput[];
  height: number;
  stateRef: { current: G3DState };
  nodeVisualsRef: { current: Map<string, NodeVisual> };
  graphRef: { current: ForceGraph3DInstance | null };
  fitTargetRef: { current: { x: number; y: number; z: number } | null };
  selIdRef: { current: string };
  libClickRef: { current: { id: string; t: number } };
  hoverIdRef: { current: string };
  pauseBitsRef: {
    current: {
      vis: boolean;
      idle: boolean;
      physicallyPaused: boolean;
      engineStopped: boolean;
      rePauseTimer: number;
    };
  };
  graphData: { nodes: G3DNodeRuntime[]; links: G3DLinkRuntime[] };
  graphDataRef: {
    current: { nodes: G3DNodeRuntime[]; links: G3DLinkRuntime[] };
  };
  setWebglFail: (v: boolean) => void;
  setInitError: (v: string) => void;
  setReady: (v: boolean) => void;
  setSelectedId: (v: string) => void;
  onSelect: ((id: string) => void) | undefined;
  updatePickScales: () => void;
  applyHoverVisual: (id: string, on: boolean) => void;
  markGraphActivity: () => void;
  applyGraphPause: () => void;
  graphVisible: () => boolean;
  handleGraphEngineStop: () => void;
}

export function useGraph3DEngine(ctx: Graph3DEngineCtx): void {
  const {
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
  } = ctx;
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
            // d.ts 未暴露 centerAt（真缺口，运行时存在）——局部结构断言。
            // G3DNodeInput.x/y/z 为可选（引擎未跑时 undefined）——参数照收。
            (graphRef.current as unknown as { centerAt: (
              x: number | undefined, y: number | undefined,
              z: number | undefined, ms: number
            ) => void })?.centerAt(n.x, n.y, n.z, 600);
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
      });
      // 工厂 d.ts IForceGraph3D 不带泛型实参（accessor 默认 NodeObject，
      // 具型回调逆变不过）——链头结构断言实例化（经 unknown 双断言绕
      // TS2352 比较性；两实例方法级互可赋，运行时零差异；构造与链拆
      // 两条语句是 as 后换行接 .method 的 TS1128 语法错误规避）。
      (graph as unknown as
        ForceGraph3DInstance<G3DNodeRuntime, G3DLinkRuntime>)
        .width(Math.max(1, el.clientWidth || 960))
        .height(height)
        .backgroundColor(p.surface)
        .numDimensions(3)
        .nodeId("id")
        // 自绘节点（官方 extend=false 替换默认）+ nodeOpacity
        // **必须数字**（L1168 直接乘，函数=NaN 全隐形）。
        .nodeRelSize(1)
        .nodeVal((n: G3DNodeRuntime) => n.val)
        .nodeOpacity(1)
        .nodeResolution(24)
        .nodeColor(() => "#ffffff")
        .nodeThreeObject((n: G3DNodeRuntime) => {
          nodeVisualsRef.current.delete(n.id);
          const { obj, visual } = buildNodeVisual(n, stateRef.current);
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
        .linkCurvature((l: G3DLinkRuntime) => (l._bi ? 0.12 : 0))
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
        .onNodeClick((n: G3DNodeRuntime) => {
          markGraphActivity(); // 选中视觉变更需帧；稳态暂停中点击须先恢复
          libClickRef.current = {
            id: n.id,
            t: performance.now(),
          };
          handleNodeActivate(n);
        })
        .onNodeHover((n: G3DNodeRuntime | null) => {
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
      const camera = graph.camera() as unknown as THREE.PerspectiveCamera;
      camera.fov = 44;
      camera.near = 0.1;
      camera.far = GRAPH_ZOOM_MAX_DISTANCE_CEILING * 1.6;
      camera.updateProjectionMatrix();
      const controls = graph.controls() as G3DControls;
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
      const linkForce = graph.d3Force("link");
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
          (graph.controls?.() as G3DControls)?.removeEventListener?.(
            "change",
            updatePickScales,
          );
          (graph.controls?.() as G3DControls)?.removeEventListener?.(
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
}
