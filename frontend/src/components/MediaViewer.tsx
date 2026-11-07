/** 应用内媒体灯箱（图片查看器）。
 *
 * 受控组件：items/index 由调用方持有，切换图片经 onIndexChange 回传
 * （画廊序列本身由 lib/mediaGallery.collectGallery 算好）。
 * 只负责查看体验：滚轮/双击/双指缩放、拖拽平移（超界回弹）、
 * ←/→ 切图、ESC 关闭、点遮罩关闭、下载（host.fetch 鉴权链）。
 *
 * 渲染到 document.body（portal）——消息行带入场动画 transform，
 * fixed 子节点会被该 transform 捕获成包含块、定位漂移。
 */
import type * as ReactNS from "react";
import { downloadViaHost, resolveFileTarget } from "../api";
import { useMediaObjectUrl } from "../useMediaObjectUrl";
import { useT } from "../i18n";
import {
  clampPan,
  clampZoom,
  nextIndex,
  prevIndex,
  DOUBLE_CLICK_ZOOM,
  ZOOM_STEP,
  type GalleryItem,
  type PanOffset,
} from "../lib/mediaGallery";
import { CloseIcon, DownloadIcon, PictureIcon } from "./icons";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
const ReactDOM = host.ReactDOM as
  | {
      createPortal?: (
        node: ReactNS.ReactNode,
        container: Element,
      ) => ReactNS.ReactElement;
    }
  | undefined;

const OVERLAY_Z = 2500;
/** 触控目标最小边长（关闭/切图按钮 ≥44px，触屏可达性）。 */
const HIT = 44;
/** 拖拽超过该位移视为「拖过」，抬起后不当作点击遮罩（避免误关灯箱）。 */
const DRAG_SLOP = 4;
const FOCUSABLE_SELECTOR =
  'button:not([disabled]),[href],input,select,textarea,[tabindex]:not([tabindex="-1"])';

function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  } catch {
    return false;
  }
}

export interface MediaViewerProps {
  items: GalleryItem[];
  index: number;
  onClose: () => void;
  onIndexChange: (index: number) => void;
}

export function MediaViewer({
  items,
  index,
  onClose,
  onIndexChange,
}: MediaViewerProps) {
  const tr = useT();
  const total = items.length;
  const idx = total === 0 ? 0 : Math.min(total - 1, Math.max(0, index));
  const item: GalleryItem | undefined = items[idx];

  const overlayRef = React.useRef<HTMLDivElement | null>(null);
  const stageRef = React.useRef<HTMLDivElement | null>(null);

  const [zoom, setZoomState] = React.useState(1);
  const [pan, setPanState] = React.useState<PanOffset>({ x: 0, y: 0 });
  const [dragging, setDragging] = React.useState(false);
  const [broken, setBroken] = React.useState(false);
  const [stalled, setStalled] = React.useState(false);
  // 手势期间要读最新值，state 闭包不够——ref 是手势基准的唯一真源。
  const zoomRef = React.useRef(1);
  const panRef = React.useRef<PanOffset>({ x: 0, y: 0 });
  const pointersRef = React.useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = React.useRef<{
    startZoom: number;
    startPan: PanOffset;
    startDist: number;
    startX: number;
    startY: number;
  } | null>(null);
  const movedRef = React.useRef(0);

  const applyZoom = (z: number) => {
    zoomRef.current = z;
    setZoomState(z);
  };
  const applyPan = (p: PanOffset) => {
    panRef.current = p;
    setPanState(p);
  };
  const stageSize = () => {
    const rect = stageRef.current?.getBoundingClientRect();
    return { w: rect?.width || 0, h: rect?.height || 0 };
  };

  const target = React.useMemo(
    () => resolveFileTarget(item?.url),
    [item?.url],
  );
  const src = useMediaObjectUrl(item ? target.apiPath : undefined, target.url);
  const reduced = prefersReducedMotion();

  // 换图：缩放/平移/失败态全部复位（否则切到下一张还停在上张的 3x 偏移）。
  React.useEffect(() => {
    applyZoom(1);
    applyPan({ x: 0, y: 0 });
    setBroken(false);
  }, [idx]);

  // 空 src 可能是「还在拉 blob」也可能是「拉失败」——超时后落失败态，
  // 否则用户面对一个永远转的圆圈。
  React.useEffect(() => {
    if (src) {
      setStalled(false);
      return;
    }
    const id = window.setTimeout(() => setStalled(true), 6000);
    return () => window.clearTimeout(id);
  }, [src]);

  React.useEffect(() => {
    setBroken(false);
  }, [src]);

  // 打开期间锁背景滚动 + 初始聚焦 + 关闭后焦点归还触发元素（灯箱里的
  // 图片按钮可能是键盘/读屏用户的唯一入口，焦点落在 body 会迷失位置）。
  React.useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    overlayRef.current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      if (prevFocus && typeof prevFocus.focus === "function") {
        try {
          prevFocus.focus();
        } catch {
          /* 触发元素已卸载 */
        }
      }
    };
  }, []);

  // 键盘：ESC 关闭 / ←→ 切图 / Tab 焦点陷阱（不让焦点跑到底层聊天）。
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Tab") {
        const root = overlayRef.current;
        if (!root) return;
        const list = Array.from(
          root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        );
        if (list.length === 0) return;
        const active = document.activeElement as HTMLElement | null;
        const first = list[0];
        const last = list[list.length - 1];
        const outside = !active || !root.contains(active);
        if (e.shiftKey && (outside || active === first)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (outside || active === last)) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowLeft" && total > 1) {
        e.preventDefault();
        onIndexChange(prevIndex(idx, total));
      } else if (e.key === "ArrowRight" && total > 1) {
        e.preventDefault();
        onIndexChange(nextIndex(idx, total));
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [idx, total, onClose, onIndexChange]);

  // 滚轮缩放：React 的 onWheel 是 passive 监听，preventDefault 无效——
  // 原生监听 + { passive: false } 才能既缩放又阻断页面滚动。
  React.useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      // 以光标为锚点缩放（指针下的像素保持不动）。
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      const cur = zoomRef.current;
      const next = clampZoom(cur * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
      if (next === cur) return;
      const ratio = next / cur;
      applyZoom(next);
      applyPan(
        clampPan(
          {
            x: cx - (cx - panRef.current.x) * ratio,
            y: cy - (cy - panRef.current.y) * ratio,
          },
          next,
          rect.width,
          rect.height,
        ),
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e: ReactNS.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const el = stageRef.current;
    if (e.target === el && zoomRef.current <= 1) {
      // 空白处按下：交给 click 处理关闭，不进入拖拽。
      return;
    }
    el?.setPointerCapture?.(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    movedRef.current = 0;
    const pts = [...pointersRef.current.values()];
    if (pts.length === 1) {
      gestureRef.current = {
        startZoom: zoomRef.current,
        startPan: panRef.current,
        startDist: 0,
        startX: e.clientX,
        startY: e.clientY,
      };
      setDragging(true);
    } else if (pts.length === 2) {
      const [a, b] = pts;
      gestureRef.current = {
        startZoom: zoomRef.current,
        startPan: panRef.current,
        startDist: Math.hypot(a.x - b.x, a.y - b.y),
        startX: 0,
        startY: 0,
      };
    }
  };

  const onPointerMove = (e: ReactNS.PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gestureRef.current;
    if (!g) return;
    const pts = [...pointersRef.current.values()];
    movedRef.current = Math.max(
      movedRef.current,
      Math.abs(e.clientX - g.startX),
      Math.abs(e.clientY - g.startY),
    );
    const { w, h } = stageSize();
    if (pts.length >= 2) {
      // 双指捏合：两指距离比即缩放比（不引第三方手势库）。
      const [a, b] = pts;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (g.startDist > 0) {
        const next = clampZoom(g.startZoom * (dist / g.startDist));
        applyZoom(next);
        applyPan(clampPan(g.startPan, next, w, h));
      }
      return;
    }
    if (zoomRef.current <= 1) return;
    applyPan(
      clampPan(
        {
          x: g.startPan.x + (e.clientX - g.startX),
          y: g.startPan.y + (e.clientY - g.startY),
        },
        zoomRef.current,
        w,
        h,
      ),
    );
  };

  const endPointer = (e: ReactNS.PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.delete(e.pointerId);
    const pts = [...pointersRef.current.values()];
    const { w, h } = stageSize();
    if (pts.length === 0) {
      gestureRef.current = null;
      setDragging(false);
      // 抬手回弹：拖出边界的偏移一次性收回到可及范围。
      applyPan(clampPan(panRef.current, zoomRef.current, w, h));
    } else if (pts.length === 1) {
      // 捏合松掉一指 → 剩下的手指重新作为单指拖拽基准。
      gestureRef.current = {
        startZoom: zoomRef.current,
        startPan: panRef.current,
        startDist: 0,
        startX: pts[0].x,
        startY: pts[0].y,
      };
    }
  };

  const onStageClick = (e: ReactNS.MouseEvent<HTMLDivElement>) => {
    if (movedRef.current > DRAG_SLOP) {
      movedRef.current = 0;
      return;
    }
    if (e.target === stageRef.current) onClose();
  };

  const onStageDoubleClick = () => {
    const { w, h } = stageSize();
    if (zoomRef.current > 1) {
      applyZoom(1);
      applyPan({ x: 0, y: 0 });
    } else {
      applyZoom(DOUBLE_CLICK_ZOOM);
      applyPan(clampPan(panRef.current, DOUBLE_CLICK_ZOOM, w, h));
    }
  };

  const doDownload = async () => {
    const name = item?.name || "image";
    if (target.apiPath) {
      const ok = await downloadViaHost(target.apiPath, name);
      if (!ok) antd.message.error(tr("下载失败，请稍后重试"));
      return;
    }
    antd.message.error(tr("下载失败，请稍后重试"));
  };

  const ariaLabel = item?.name
    ? `${tr("图片预览")}: ${item.name}`
    : tr("图片预览");
  const transition =
    dragging || reduced ? "none" : "transform 0.18s ease-out";
  const failed = broken || (stalled && !src);

  const overlay = (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      tabIndex={-1}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: OVERLAY_Z,
        background: "rgba(0,0,0,0.92)",
        display: "flex",
        flexDirection: "column",
        outline: "none",
        color: "rgba(255,255,255,0.92)",
      }}
    >
      {/* 顶栏：文件名 + 计数 + 缩放比例 + 下载/关闭（点击不触发遮罩关闭） */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 13,
          }}
          title={item?.name || tr("图片")}
        >
          {item?.name || tr("图片")}
        </div>
        {total > 1 ? (
          <span style={{ fontSize: 12, opacity: 0.7, flexShrink: 0 }}>
            {idx + 1} / {total}
          </span>
        ) : null}
        <span
          style={{
            fontSize: 12,
            opacity: 0.7,
            flexShrink: 0,
            minWidth: 44,
            textAlign: "center",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={() => {
            void doDownload();
          }}
          title={tr("下载")}
          aria-label={tr("下载")}
          style={{
            width: HIT,
            height: HIT,
            display: "grid",
            placeItems: "center",
            borderRadius: 8,
            border: "none",
            background: "rgba(255,255,255,0.12)",
            color: "inherit",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <DownloadIcon size={18} />
        </button>
        <button
          type="button"
          onClick={onClose}
          title={tr("关闭")}
          aria-label={tr("关闭")}
          style={{
            width: HIT,
            height: HIT,
            display: "grid",
            placeItems: "center",
            borderRadius: 8,
            border: "none",
            background: "rgba(255,255,255,0.12)",
            color: "inherit",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <CloseIcon size={18} />
        </button>
      </div>

      {/* 图像舞台：滚轮/双击/拖拽/捏合都挂这里；点空白（target===stage）关闭 */}
      <div
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onDoubleClick={onStageDoubleClick}
        onClick={onStageClick}
        style={{
          position: "relative",
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          touchAction: "none",
          cursor:
            zoom > 1 ? (dragging ? "grabbing" : "grab") : "zoom-in",
          userSelect: "none",
        }}
      >
        {failed ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 10,
              opacity: 0.85,
              padding: 24,
              textAlign: "center",
            }}
          >
            <PictureIcon size={28} />
            <span style={{ fontSize: 13 }}>{tr("图片加载失败")}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void doDownload();
              }}
              style={{
                height: HIT,
                padding: "0 16px",
                borderRadius: 8,
                border: "none",
                background: "rgba(255,255,255,0.16)",
                color: "inherit",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              {tr("下载")}
            </button>
          </div>
        ) : src ? (
          <img
            src={src}
            alt={item?.name || tr("图片")}
            draggable={false}
            onError={() => setBroken(true)}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              objectFit: "contain",
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: "center center",
              transition,
              userSelect: "none",
            }}
          />
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              opacity: 0.75,
              fontSize: 13,
            }}
          >
            <antd.Spin size="small" /> {tr("加载中…")}
          </div>
        )}

        {total > 1 ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onIndexChange(prevIndex(idx, total));
            }}
            disabled={idx === 0}
            title={tr("上一张")}
            aria-label={tr("上一张")}
            style={{
              position: "absolute",
              left: 8,
              top: "50%",
              transform: "translateY(-50%)",
              width: HIT,
              height: HIT,
              display: "grid",
              placeItems: "center",
              borderRadius: HIT / 2,
              border: "none",
              background: "rgba(0,0,0,0.45)",
              color: "inherit",
              fontSize: 20,
              cursor: idx === 0 ? "default" : "pointer",
              opacity: idx === 0 ? 0.3 : 1,
            }}
          >
            ‹
          </button>
        ) : null}
        {total > 1 ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onIndexChange(nextIndex(idx, total));
            }}
            disabled={idx === total - 1}
            title={tr("下一张")}
            aria-label={tr("下一张")}
            style={{
              position: "absolute",
              right: 8,
              top: "50%",
              transform: "translateY(-50%)",
              width: HIT,
              height: HIT,
              display: "grid",
              placeItems: "center",
              borderRadius: HIT / 2,
              border: "none",
              background: "rgba(0,0,0,0.45)",
              color: "inherit",
              fontSize: 20,
              cursor: idx === total - 1 ? "default" : "pointer",
              opacity: idx === total - 1 ? 0.3 : 1,
            }}
          >
            ›
          </button>
        ) : null}
      </div>
    </div>
  );

  const createPortal = ReactDOM?.createPortal;
  return createPortal ? createPortal(overlay, document.body) : overlay;
}
