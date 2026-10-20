/** Artifacts 子模块——自 Artifacts.tsx 纯搬移拆出
 * （行为零变化）。 */
import type * as ReactNS from "react";

const host = window.QwenPaw.host;
const React = host.React;

export function useTreeColWidth() {
  const [treeColW, setTreeColW] = React.useState(() => {
    const v = Number(localStorage.getItem("agentteams-qwenpaw-workbench:artifacts-tree-w"));
    return Number.isFinite(v) && v >= 200 && v <= 480 ? Math.round(v) : 260;
  });
  const [treeColDragging, setTreeColDragging] = React.useState(false);
  const treeColRef = React.useRef<HTMLDivElement | null>(null);
  const onTreeColDown = React.useCallback(
    (e: ReactNS.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = treeColRef.current?.clientWidth || treeColW;
      setTreeColDragging(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const onMove = (ev: MouseEvent) => {
        const next = Math.min(
          480,
          Math.max(200, Math.round(startW + (ev.clientX - startX))),
        );
        if (treeColRef.current) treeColRef.current.style.width = `${next}px`;
      };
      const onUp = (ev: MouseEvent) => {
        const next = Math.min(
          480,
          Math.max(200, Math.round(startW + (ev.clientX - startX))),
        );
        setTreeColW(next);
        localStorage.setItem(
          "agentteams-qwenpaw-workbench:artifacts-tree-w",
          String(next),
        );
        setTreeColDragging(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [treeColW],
  );
  return {
    w: treeColW,
    dragging: treeColDragging,
    ref: treeColRef,
    onDown: onTreeColDown,
  };
}
