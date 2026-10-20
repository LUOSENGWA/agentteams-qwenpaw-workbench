/** GraphCard 子模块——自 GraphCard.tsx 纯搬移拆出
 * （行为零变化）。 */
import type * as ReactNS from "react";
import { clampZoomView } from "./layout2d";
import type { FocusTarget, RadialView } from "./layout2d";
import type { GraphNodeLike } from "./types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

export function useGraphPanTouch({
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
}: {
  dragRef: { current: { startX: number; startY: number; vb0: RadialView; moved: boolean } | null };
  dragMovedRef: { current: boolean };
  lastTouchRef: { current: number };
  vbRef: { current: RadialView };
  svgRef: { current: SVGSVGElement | null };
  hitRafRef: { current: number };
  panning: boolean;
  setPanning: ReactNS.Dispatch<ReactNS.SetStateAction<boolean>>;
  setVb: ReactNS.Dispatch<ReactNS.SetStateAction<RadialView>>;
  cancelAnim: () => void;
  view: RadialView;
  clientToView: (cx: number, cy: number) => DOMPoint | null;
  hitTestNode: (x: number, y: number) => GraphNodeLike | null;
  selectAt: (vx: number, vy: number) => void;
  applyFocus: (target: FocusTarget | null) => void;
  hubSet: Set<string>;
}) {
  // 拖拽平移（位移 <4px 视为单击，click 处理保留）。
  const onSvgPanDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    if (Date.now() - lastTouchRef.current < 800) return; // 触屏拖动期间防 mouse 模拟
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
  // ── 2D 触屏手势（15.21 批）：单指拖动=平移 / 双指捏合=缩放 /
  // tap=点选 / 双击=聚焦。CSS touch-action:none（svg 已设）挡住浏览器
  // 默认页面滚动/捏合，故合成 touch 事件无需 preventDefault。
  const lastTapRef = React.useRef<{ x: number; y: number; t: number } | null>(null);
  const touchRef = React.useRef<{
    mode: "idle" | "pan" | "pinch";
    t0: number;
    sx: number;
    sy: number;
    vb0: RadialView | null;
    moved: boolean;
    pd0: number;
    pvb0: RadialView | null;
    pax: number;
    pay: number;
  }>({ mode: "idle", t0: 0, sx: 0, sy: 0, vb0: null, moved: false, pd0: 0, pvb0: null, pax: 0, pay: 0 });
  const onSvgTouchStart = (e: React.TouchEvent<SVGSVGElement>) => {
    lastTouchRef.current = Date.now();
    cancelAnim();
    const st = touchRef.current;
    if (e.touches.length === 2) {
      // 双指：pinch（基线=手势起点的距离/中点/vb，每帧绝对计算不累加）。
      const a = e.touches[0];
      const b = e.touches[1];
      const pt = clientToView((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
      st.mode = "pinch";
      st.pd0 = Math.max(8, Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY));
      st.pvb0 = { ...vbRef.current };
      st.pax = pt ? pt.x : vbRef.current.minX + vbRef.current.width / 2;
      st.pay = pt ? pt.y : vbRef.current.minY + vbRef.current.height / 2;
      st.moved = true;
      if (!panning) setPanning(true);
    } else if (e.touches.length === 1) {
      const p = e.touches[0];
      st.mode = "idle";
      st.t0 = Date.now();
      st.sx = p.clientX;
      st.sy = p.clientY;
      st.vb0 = { ...vbRef.current };
      st.moved = false;
    }
  };
  const onSvgTouchMove = (e: React.TouchEvent<SVGSVGElement>) => {
    const st = touchRef.current;
    if (st.mode === "pinch" && e.touches.length >= 2) {
      const a = e.touches[0];
      const b = e.touches[1];
      const dist = Math.max(8, Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY));
      const v0 = st.pvb0;
      if (!v0) return;
      // 捏开=dist 增大=放大=w 缩小（与 wheel 同式：中点 view 坐标锚定）。
      const w1 = v0.width * (st.pd0 / dist);
      const h1 = v0.height * (st.pd0 / dist);
      const fx = (st.pax - v0.minX) / v0.width;
      const fy = (st.pay - v0.minY) / v0.height;
      setVb(clampZoomView({ minX: st.pax - fx * w1, minY: st.pay - fy * h1, width: w1, height: h1 }, view));
      return;
    }
    if (e.touches.length !== 1) return;
    const p = e.touches[0];
    if (st.mode === "idle") {
      if (Math.hypot(p.clientX - st.sx, p.clientY - st.sy) > 4) {
        st.mode = "pan";
        st.moved = true;
        if (!panning) setPanning(true);
      } else {
        return;
      }
    }
    if (st.mode === "pan") {
      const v0 = st.vb0;
      if (!v0) return;
      const svg = svgRef.current;
      let scale = v0.width / Math.max(1, svg?.getBoundingClientRect().width || 1);
      const ctm = svg?.getScreenCTM && svg.getScreenCTM();
      if (ctm && ctm.a) scale = 1 / ctm.a;
      setVb({ ...v0, minX: v0.minX - (p.clientX - st.sx) * scale, minY: v0.minY - (p.clientY - st.sy) * scale });
    }
  };
  const onSvgTouchEnd = (e: React.TouchEvent<SVGSVGElement>) => {
    const st = touchRef.current;
    lastTouchRef.current = Date.now();
    if (st.mode === "pinch") {
      if (e.touches.length === 1) {
        // 剩一指：从当前 vb 继续平移（防 tap 误判）。
        const p = e.touches[0];
        st.mode = "idle";
        st.sx = p.clientX;
        st.sy = p.clientY;
        st.vb0 = { ...vbRef.current };
        st.moved = true;
        return;
      }
      st.mode = "idle";
      setPanning(false);
      return;
    }
    if (e.touches.length === 0) {
      const wasTap = st.mode === "idle" && !st.moved && Date.now() - st.t0 < 400;
      st.mode = "idle";
      setPanning(false);
      if (!wasTap || !e.changedTouches[0]) return;
      const ct = e.changedTouches[0];
      const now = Date.now();
      const lt = lastTapRef.current;
      const isDbl = Boolean(lt && now - lt.t < 320 && Math.hypot(ct.clientX - lt.x, ct.clientY - lt.y) < 24);
      if (isDbl) {
        // 双击=聚焦（触屏无 dblclick 事件，tap 对实现）。
        lastTapRef.current = null;
        const pt = clientToView(ct.clientX, ct.clientY);
        if (!pt) return;
        const node = hitTestNode(pt.x, pt.y);
        if (node) applyFocus(hubSet.has(node.id) ? { kind: "sector", hubId: node.id } : { kind: "node", id: node.id });
        return;
      }
      lastTapRef.current = { x: ct.clientX, y: ct.clientY, t: now };
      const pt = clientToView(ct.clientX, ct.clientY);
      if (pt) selectAt(pt.x, pt.y);
    }
  };
  return {
    onSvgPanDown,
    onSvgPanMove,
    onSvgPanUp,
    onSvgTouchStart,
    onSvgTouchMove,
    onSvgTouchEnd,
  };
}
