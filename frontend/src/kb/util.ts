// KB 视图共享小工具（QC-164 阶段 1 自 components/KnowledgeBase.tsx 纯搬移）。

// // 两栏固定等高（min(viewport 余量, 640px)，下限 460），Card 内 body 独立滚动。
// 本文件 saveTextFile 为纯 DOM 函数，无 React/antd 依赖（故不引 host 头）。
// dvh（移动端=可视区动态高，地址栏伸缩时准；桌面端=vh 无差异）。
// 全容器化需 KB 页结构重构（图谱卡夹在工具栏与两栏之间，Row 非定高父唯一
// 子）——留档 state/p1-ui-round.md，本批先消 vh 不准根。
export const KB_COL_STYLE = { height: "min(calc(100dvh - 330px), 640px)", minHeight: 460, minWidth: 0 } as const;
export const KB_CARD_STYLE = { height: "100%", display: "flex", flexDirection: "column" as const } as const;
export const KB_CARD_BODY_STYLE = { flex: 1, minHeight: 0, overflowY: "auto" as const };

/** 5.0.0-beta.6：预览内容直接存盘下载（Blob + a.download，
 * 零额外请求——content 已是完整文本，MdText 的 100000 截断只在展示层）。 */
export function saveTextFile(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
