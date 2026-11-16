// R1 htmlToPlainText 实测（3 结构化 pre-pass + 7 步正则链；7 步链 1:1
// 移植 dashboard markdown-message.tsx，语义与顺序不变——本仓 MdText 是
// 纯文本块解析器，formatted_body 主渲染源需先恢复 pre/code 围栏、
// table GFM 管道表、li 列表项三类结构；软换行 <br>→\n 保持）。
//
// 双通道：
// - 直跑：node --experimental-strip-types tests/html-to-plain-text.test.ts
//   （顶层断言实测纯函数，退出码即门）；
// - vitest-gate 全量回归：静态 import 注册 it()（禁 top-level await）。
import assert from "node:assert/strict";
import { it } from "vitest";

import { htmlToPlainText } from "../src/lib/mdPlain.ts";

// 断言口径：
// 1. <pre><code class="language-x"> → "```x 围栏"（无 class 无语言标记；
//    inner 原样保留，实体由 7 步链解码）；
// 2. <table> → GFM 管道表（行=tr 格=th/td，首行后插列数同表 |---| 分隔行，
//    格内剥内联标签留文本，多表空行分隔）；
// 3. <li> → "- "（嵌套列表 v1 不处理，按平铺降级）；
// 4. 7 步链：<br>→\n；</p|div|tr|h1-6|li>→\n；剥所有标签；实体按
//    &lt; &gt; &quot; &#39; &amp; 顺序解码（&amp; 最后，不重复解码）。
const cases: [string, string, string][] = [
  ["<br>/<br/> → 换行（软换行回归）", "a<br>b<br/>c", "a\nb\nc"],
  ["</p> → 换行（段边界，尾随换行保留）", "<p>one</p><p>two</p>", "one\ntwo\n"],
  [
    "table（无 thead）→ GFM（首行 tr 作表头 + |---| 分隔行）",
    "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>",
    "\n| a | b |\n|---|---|\n| c | d |\n",
  ],
  [
    "table（thead+tbody 生产样例）→ GFM 管道表",
    "<table>\n<thead>\n<tr>\n<th>字段</th>\n<th>值</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>status</td>\n<td>ok</td>\n</tr>\n<tr>\n<td>latency</td>\n<td>12ms</td>\n</tr>\n</tbody>\n</table>",
    "\n| 字段 | 值 |\n|---|---|\n| status | ok |\n| latency | 12ms |\n",
  ],
  [
    "多张表各自成块、空行分隔",
    "<table><tr><td>a</td></tr></table><table><tr><td>b</td></tr></table>",
    "\n| a |\n|---|\n\n| b |\n|---|\n",
  ],
  [
    "格内内联标签剥壳留文本",
    "<table><tr><th><b>k</b></th></tr><tr><td><i>v</i></td></tr></table>",
    "\n| k |\n|---|\n| v |\n",
  ],
  [
    "<pre><code> → 围栏（无 class 无语言标记）",
    "<pre><code>line1\nline2</code></pre>",
    "\n```\nline1\nline2\n```\n",
  ],
  [
    "<pre><code class=language-python> → ```python 围栏（inner 两行完整）",
    '<pre><code class="language-python">print(&quot;a &amp; b&quot;)\nx = 1\n</code></pre>',
    '\n```python\nprint("a & b")\nx = 1\n```\n',
  ],
  [
    "ul → 列表项（- 前缀，</li> → 换行）",
    "<ul><li>第一步</li><li>第二步</li></ul>",
    "- 第一步\n- 第二步\n",
  ],
  [
    "ol 同样降级 -（v1 不区分有序）",
    "<ol><li>一</li><li>二</li></ol>",
    "- 一\n- 二\n",
  ],
  [
    "混合文档（段+表+码+列表）结构不串味：表格行不进围栏、围栏内实体还原",
    '<p>说明</p><table>\n<thead>\n<tr>\n<th>k</th>\n<th>v</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>ok</td>\n<td>1</td>\n</tr>\n</tbody>\n</table><pre><code class="language-js">a &amp;&amp; b\n</code></pre><ul><li>一</li></ul>',
    "说明\n\n| k | v |\n|---|---|\n| ok | 1 |\n\n```js\na && b\n```\n- 一\n",
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
