/**
 * FileDropTarget.tsx — 文件区拖拽上传外壳（列表 / 树 / 网格三视图共用）。
 *
 * 职责只到「收集拖入内容」：drop 时同步拍快照（webkitGetAsEntry 的浏览器
 * 生命周期限制，见 files/fileDrop.ts）→ 交调用方异步递归 + 入上传队列
 * （上传逻辑复用 useUploadQueue，本组件不碰上传）。
 *
 * 交互：
 * - 拖入文件 → 区域半透明遮罩 + 「松开上传到 <目录>」（role=status + aria-live）；
 * - 遮罩 pointerEvents:none——不挡树行自己的 drop 目标（树目录行高亮）；
 * - 拖拽激活期间在 window 上 preventDefault dragover/drop：拖到区域外松手
 *   也不会让浏览器直接打开文件；离开/放下即摘除监听；
 * - 触摸端没有 drag 事件 → 遮罩永不出现，不影响按钮上传。
 */
import type * as ReactNS from "react";

import type { ThemeColors } from "../../theme";
import {
  dragHasFiles,
  snapshotDrop,
  type DataTransferLike,
  type DropSnapshot,
} from "./fileDrop";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

type Tr = (s: string, v?: Record<string, string | number>) => string;

export interface FileDropTargetProps {
  t: ThemeColors;
  tr: Tr;
  /** 遮罩文案里的目标目录展示名（根目录传「我的文件」）。 */
  dirLabel: string;
  onDrop: (snap: DropSnapshot) => void;
  children: ReactNS.ReactNode;
}

export default function FileDropTarget({
  t,
  tr,
  dirLabel,
  onDrop,
  children,
}: FileDropTargetProps) {
  const [active, setActive] = React.useState(false);
  // 进入/离开成对计数：子元素间移动会连发 enter/leave，用深度避免遮罩闪烁。
  const depthRef = React.useRef(0);

  // 遮罩激活期间吞掉 window 级 dragover/drop：区域外松手也不会被浏览器
  // 当成「打开文件」。遮罩消失即摘除，不留全局监听。
  React.useEffect(() => {
    if (!active) return;
    const stop = (e: DragEvent): void => {
      e.preventDefault();
    };
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
    };
  }, [active]);

  const onDragEnter = (e: ReactNS.DragEvent<HTMLDivElement>): void => {
    if (!dragHasFiles(e.dataTransfer as unknown as DataTransferLike)) return;
    e.preventDefault();
    depthRef.current += 1;
    if (!active) setActive(true);
  };

  const onDragOver = (e: ReactNS.DragEvent<HTMLDivElement>): void => {
    if (!dragHasFiles(e.dataTransfer as unknown as DataTransferLike)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  };

  const onDragLeave = (): void => {
    depthRef.current = Math.max(0, depthRef.current - 1);
    if (depthRef.current === 0) setActive(false);
  };

  const onDropHandler = (e: ReactNS.DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    depthRef.current = 0;
    setActive(false);
    const snap = snapshotDrop(e.dataTransfer as unknown as DataTransferLike);
    if (snap.entries.length === 0 && snap.files.length === 0) return;
    onDrop(snap);
  };

  return (
    <div
      data-file-drop="1"
      style={{ position: "relative", minWidth: 0 }}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDropHandler}
    >
      {children}
      {active ? (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 6,
            display: "grid",
            placeItems: "center",
            borderRadius: 10,
            border: "2px dashed var(--app-accent, #FF7F16)",
            background: t.accentBg,
            pointerEvents: "none",
          }}
        >
          <span
            style={{
              padding: "8px 14px",
              borderRadius: 8,
              background: t.cardBg,
              border: `1px solid ${t.border}`,
              color: t.text,
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            {tr("松开上传到 {dir}", { dir: dirLabel })}
          </span>
        </div>
      ) : null}
    </div>
  );
}
