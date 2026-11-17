// 围栏表格解包（纯函数，零宿主依赖——node 可直 import 测试）。
//
// 1:1 移植 dashboard fenced-table.ts 的纯文本路径（SEPARATOR_ROW +
// isGfmTableContent + unwrapFencedTables，行为与原文一致）。部分运行时
// 把 GFM 管道表包进 ``` 围栏，markdown 会把围栏内容当字面代码渲染、
// 表格显示成裸管道——这里把「内容恰好是一张 GFM 表」的围栏剥掉外壳，
// 让块解析按表格行渲染。formatted_body 路径（convertFencedTablesInHtml
// → 真 <table>）本仓不需要，未搬。
const SEPARATOR_ROW = /^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$/;

/** Whether the text is exactly one GFM table (header + separator [+ rows])). */
export function isGfmTableContent(text: string): boolean {
  const lines = text.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  if (!lines[0].includes("|")) return false;
  if (!SEPARATOR_ROW.test(lines[1])) return false;
  return lines.slice(2).every((l) => l.includes("|"));
}

/** Plain-body path: unwrap ``` fences whose content is a pure GFM table. */
export function unwrapFencedTables(text: string): string {
  return text.replace(
    /```[^\n]*\n([\s\S]*?)```/g,
    (whole, inner: string) =>
      isGfmTableContent(inner) ? inner.trimEnd() : whole,
  );
}
