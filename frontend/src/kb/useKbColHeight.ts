// KB 两栏全容器化高度量测 hook（QC-164 阶段 2）。
//
// 背景：两栏 Col 高度原为 KB_COL_STYLE 的静态值
// min(calc(100dvh-330px),640px) —— 视口相关且封顶 640px，高容器里两栏停在
// 640px、整页滚动。本 hook 运行时量「最近可滚动容器」，把两栏给到恰好
// 填满剩余可视高度（Row 顶 → 容器底），各栏 Card body 独立滚动、整页不滚。
//
// 算法（内容坐标，与滚动位置无关 → 无需 scroll 监听）：
//   top = row.top - contTop + cont.scrollTop   （Row 顶在内容坐标）
//   h   = max(MIN_H, cont.clientHeight - top - BOTTOM_PAD)
//
// 工程要点（防屎山）：
//   - 回调 ref 驱动：row 可能晚挂载（LocalKbView 的 !agentId 早退分支先渲染
//     Alert，agentId 就绪后才渲染 Row）→ 用回调 ref + state 而非「挂载时
//     一次性 effect」（plain ref 的 effect 只跑首帧，row 晚挂载会漏建
//     observer）。setRowEl 同值 Object.is bail-out，不产生渲染循环。
//   - 最近可滚动祖先 = 从 row 向上找首个 overflowY=auto|scroll（document.body
//     为止）；无则回退视口。
//   - 0 宽早退（keep-alive 隐藏 tab）：保留上次值，不写 0。
//   - rAF 合并 + >=2px 去抖（亚像素抖动不触发重渲）。
//   - 触发：ResizeObserver(滚动容器) + ResizeObserver(.ant-space，Row 上方
//     内容如图谱卡高度变化时 Space 随之变化 → 捕获重测) + ResizeObserver(row)
//     + window resize。收敛性：Row 顶只由上方内容决定（与 Row 自身高度无关）
//     → 自重测值不变 → 去抖终止，无循环。
//   - 环境无 ResizeObserver：仅 window resize 监听 + 首帧量测兜底（与
//     WorkflowBoard/RoomChat 的既有兜底口径一致）。
//   - 未测得（row 未挂载/不可测）→ 返回 null → 调用方回退旧 CSS 值
//     （失败即退回现状行为，不闪 0 高）。
import type * as ReactNS from "react";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

const MIN_H = 460; // 与旧 KB_COL_STYLE.minHeight 一致的下限
const BOTTOM_PAD = 16; // 容器底留白

/** 向上找最近可滚动祖先（overflowY=auto|scroll）；无则 null（回退视口）。 */
function findScrollContainer(el: HTMLElement): HTMLElement | null {
  let c: HTMLElement | null = el.parentElement;
  while (c && c !== document.body) {
    const oy = getComputedStyle(c).overflowY;
    if (oy === "auto" || oy === "scroll") return c;
    c = c.parentElement;
  }
  return null;
}

/**
 * 两栏 Row 全容器化高度量测。
 * 返回 { setRowRef, colH }：setRowRef 挂到包裹 Row 的 div 上；
 * colH = Row 应占高度（填满最近可滚动容器剩余可视区），未测得 → null
 * （调用方回退旧 CSS 值）。
 */
export function useKbColHeight(): {
  setRowRef: (el: HTMLDivElement | null) => void;
  colH: number | null;
} {
  const [rowEl, setRowEl] = React.useState<HTMLDivElement | null>(null);
  const [colH, setColH] = React.useState<number | null>(null);
  const lastRef = React.useRef<number | null>(null);

  const setRowRef = React.useCallback((el: HTMLDivElement | null) => {
    setRowEl(el);
  }, []);

  const measure = React.useCallback(() => {
    const row = rowEl;
    if (!row) return;
    const rr = row.getBoundingClientRect();
    if (rr.width === 0) return; // 隐藏 tab：保留上次值

    const cont = findScrollContainer(row);
    let next: number;
    if (cont) {
      const cr = cont.getBoundingClientRect();
      const top = rr.top - cr.top + cont.scrollTop;
      next = cont.clientHeight - top - BOTTOM_PAD;
    } else {
      // 视口回退：Row 顶（视口坐标）→ 视口底。
      next = window.innerHeight - rr.top - BOTTOM_PAD;
    }
    next = Math.max(MIN_H, Math.round(next));
    if (lastRef.current === null || Math.abs(next - lastRef.current) >= 2) {
      lastRef.current = next;
      setColH(next);
    }
  }, [rowEl]);

  React.useLayoutEffect(() => {
    if (!rowEl) return;

    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };

    let obs: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      obs = new ResizeObserver(schedule);
      const cont = findScrollContainer(rowEl);
      if (cont) obs.observe(cont);
      // Space 容器：Row 上方内容（图谱卡等）高度变化时其高度随之变 → 捕获重测。
      const space = rowEl.closest(".ant-space");
      if (space) obs.observe(space);
      obs.observe(rowEl);
    }
    window.addEventListener("resize", schedule);

    measure(); // 首帧（useLayoutEffect → 绘制前，无错高闪烁）

    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (obs) obs.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [rowEl, measure]);

  return { setRowRef, colH };
}
