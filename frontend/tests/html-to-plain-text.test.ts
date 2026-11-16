// R1 htmlToPlainText 实测（1:1 移植 dashboard markdown-message.tsx 的
// 7 步正则链，行为与原文一致——<table>/<pre> 不做 GFM/fence 特殊化）。
//
// 双通道：
// - 直跑：node --experimental-strip-types tests/html-to-plain-text.test.ts
//   （顶层断言实测纯函数，退出码即门）；
// - vitest-gate 全量回归：静态 import 注册 it()（禁 top-level await）。
import assert from "node:assert/strict";
import { it } from "vitest";

import { htmlToPlainText } from "../src/lib/mdPlain.ts";

// 断言口径 = dashboard 实际行为：
// <br>→\n；</p|div|tr|h1-6|li>→\n；剥所有标签；实体按
// &lt; &gt; &quot; &#39; &amp; 顺序解码（&amp; 最后，不重复解码）。
// <table> 单元格不列分隔、<pre><code> 不加 fence——均为移植源的真实行为。
const cases: [string, string, string][] = [
  ["<br>/<br/> → 换行", "a<br>b<br/>c", "a\nb\nc"],
  ["</p> → 换行（段边界，尾随换行保留）", "<p>one</p><p>two</p>", "one\ntwo\n"],
  [
    "table 剥壳按行（实际行为：</tr>→\\n，单元格不列分隔）",
    "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>",
    "ab\ncd\n",
  ],
  [
    "<pre><code> 内容保留（实际行为：不加 fence）",
    "<pre><code>line1\nline2</code></pre>",
    "line1\nline2",
  ],
  ["未知标签剥壳，文本保留", "<span>hello</span> <b>world</b>", "hello world"],
  ["实体解码（&amp; 最后，不重复解码）", "&lt;b&gt; &quot;x&quot; &#39;y&#39; &amp;z", "<b> \"x\" 'y' &z"],
  ["div+br 复合", "<div>hi<br>there</div>", "hi\nthere\n"],
];

let n = 0;
for (const [name, input, expected] of cases) {
  it(`htmlToPlainText: ${name}`, () => {
    assert.equal(htmlToPlainText(input), expected);
  });
  assert.equal(htmlToPlainText(input), expected, name);
  n += 1;
  console.log(`  PASS ${n} ${name}`);
}
console.log(`html-to-plain-text: ${n} assertions passed`);
