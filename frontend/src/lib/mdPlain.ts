// 消息渲染源纯文本归一（纯函数，零宿主依赖——node 可直 import 测试）。
//
// htmlToPlainText = 3 个结构化 pre-pass + 7 步正则链（7 步链 1:1 移植
// dashboard markdown-message.tsx，语义与顺序不变）。dashboard 主路是富 HTML
// 渲染（<table> 原生出表格、<pre> 原生出代码块），该函数在其管线里只做
// "纯文本检视"；本仓 MdText 是纯文本块解析器（parseBlocks），标签直接剥壳
// 会让三类结构退化（单元格粘连/围栏丢失/列表前缀丢失），而生产
// formatted_body 来自 markdown-it commonmark+breaks+strikethrough+table，
// 三类结构全部命中——故在 7 步链之前先恢复结构：
//   1. <pre><code> → ``` 围栏（lang 取 class="language-x"，无 class 无语言
//      标记；inner 原样保留，实体由 7 步链统一解码）；
//   2. <table> → GFM 管道表（行=tr，格=th/td，第一行后插列数同表的
//      |---| 分隔行；多张表各自成块、空行分隔）；
//   3. <li> → "- " 列表项。嵌套列表 v1 不处理（生产数据基本平铺；
//      嵌套时按平铺降级，可接受）。
// pre-pass 产物再走 7 步链：剥残余标签 + 实体解码。markdown-it 已把
// 代码/表格格内容里的 & < > 转义成实体，解码统一落在后续 7 步链，
// 顺序天然正确、不重复解码。
//
// 7 步链：（<br>→\n；</p|div|tr|h1-6|li>→\n；剥所有标签；&lt; &gt;
// &quot; &#39; &amp; 顺序解码）。软换行 <br>→\n 必须保持。

const PRE_CODE_RE = /<pre[^>]*>\s*<code([^>]*)>([\s\S]*?)<\/code>\s*<\/pre>/gi;
const TABLE_RE = /<table[^>]*>[\s\S]*?<\/table>/gi;
const TR_RE = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
const CELL_RE = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
// GFM 表内行不能含换行（硬断行 <br> 已在格级先行转空格，此处只防手写
// HTML 的裸换行）——压成空格。
const NEWLINE_RE = /\n/g;
const INLINE_TAG_RE = /<[^>]+>/g;

/** pre-pass 1：<pre><code> → ``` 围栏（inner 原样保留）。 */
function preCodeToFence(_m: string, codeAttrs: string, inner: string): string {
  const classM = /class\s*=\s*["']([^"']*)["']/i.exec(codeAttrs);
  const langM = classM ? /language-([^"'\s]+)/.exec(classM[1]) : null;
  const lang = langM ? langM[1] : "";
  // markdown-it 的 fence 内容恒以 \n 收尾；手写 HTML 可能缺尾换行——
  // 统一保证闭合围栏独占一行。
  const body = inner !== "" && !inner.endsWith("\n") ? inner + "\n" : inner;
  return "\n```" + lang + "\n" + body + "```\n";
}

/** pre-pass 2：<table> → GFM 管道表（首行=表头，后插 |---| 分隔行）。 */
function tableToGfm(tableHtml: string): string {
  const rows: string[][] = [];
  for (const rowM of tableHtml.matchAll(TR_RE)) {
    const cells = [...rowM[0].matchAll(CELL_RE)].map((c) =>
      // <br> 是硬断行：先转空格（剥标签会丢分隔致 "a<br>b"→"ab"；markdown-it 表内硬断行产生 <br>）
      c[1]
        .replace(/<br\s*\/?>/gi, " ")
        .replace(INLINE_TAG_RE, "")
        .replace(NEWLINE_RE, " ")
        .trim(),
    );
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return "";
  const lines = ["| " + rows[0].join(" | ") + " |"];
  lines.push("|" + rows[0].map(() => "---").join("|") + "|");
  for (const row of rows.slice(1)) lines.push("| " + row.join(" | ") + " |");
  // 前后空行：保证表格行独占行首（不与相邻文本粘连）、多表空行分隔。
  return "\n" + lines.join("\n") + "\n";
}

export function htmlToPlainText(html: string): string {
  return (
    html
      // —— 结构化 pre-pass（7 步链之前，见文件头注释）——
      .replace(PRE_CODE_RE, preCodeToFence)
      .replace(TABLE_RE, tableToGfm)
      .replace(/<li[^>]*>/gi, "- ") // </li> 由 7 步链转 \n
      // —— 7 步链（1:1 移植 dashboard，语义与顺序不动）——
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|tr|h[1-6]|li)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
  );
}
