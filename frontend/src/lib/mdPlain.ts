// 消息渲染源纯文本归一（纯函数，零宿主依赖——node 可直 import 测试）。
//
// htmlToPlainText：1:1 移植 dashboard markdown-message.tsx 的 7 步正则链
// （<br>→\n；</p|div|tr|h1-6|li>→\n；剥所有标签；&lt; &gt; &quot; &#39; &amp;
// 顺序解码）。behavior 与原文一致——不简化、不扩展（<table>/<pre> 不做
// GFM/fence 特殊化：标签剥壳后按纯文本走，与 dashboard 行为相同）。
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
