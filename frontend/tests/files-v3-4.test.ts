// F-V3-4：文件「树形视图」纯逻辑 treeModel（视图解析 / 祖先路径 / 缩进 /
// 树拍平 / 键盘导航）。直接 import（treeModel 只 import type，strip-types
// 擦除后不加载 humanFiles 实体），不碰 UI、不进 vitest 面（文件名不带
// .vitest.）。
// 直跑：node --experimental-strip-types frontend/tests/files-v3-4.test.ts
//（node:assert/strict）。
//
// 覆盖（任务书 ≥8 条）：
// ① parseFilesView 三态："tree"→tree；"list"→list；空/缺省→list；
// ② ancestorsOf 两例 + 前缀不做假设（"a/b/c.txt" / 根层 "a" / files/ 前缀原样）；
// ③ treeIndent：0→0；2→32；负值→0；
// ④ flattenTree 深度优先顺序 + 展开/折叠（折叠目录不输出子项）；
// ⑤ flattenTree children 缺失 → 视为未加载不输出子项（expanded 旗标仍反映集合）；
// ⑥ treeKeyNav Up/Down 夹取（顶格 Up 不动 / 底格 Down 不动 / 中间移动）；
// ⑦ treeKeyNav ArrowRight 目录 → onToggle(path) 且 index 不变；文件不触发；
//    Left/Enter 返回原 index；
// ⑧ 源码断言：treeModel 纯类型，无 window/document、无值 import、不引 UI 模块。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ancestorsOf,
  flattenTree,
  parseFilesView,
  treeIndent,
  treeKeyNav,
  type TreeRow,
} from "../src/manage/files/treeModel.ts";
import type { HumanFileEntry } from "../src/api/domains/humanFiles.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

// ── 测试数据（#1518 新形态：path 为相对存储根全路径，目录以 / 结尾）────
const dirA: HumanFileEntry = { name: "a", path: "files/a/", type: "directory" };
const fileB: HumanFileEntry = { name: "b.txt", path: "files/b.txt", type: "file", size: 12 };
const dirC: HumanFileEntry = { name: "c", path: "files/c/", type: "directory" };
const fileD: HumanFileEntry = { name: "d.txt", path: "files/a/d.txt", type: "file" };
const dirE: HumanFileEntry = { name: "e", path: "files/a/e/", type: "directory" };
const fileF: HumanFileEntry = { name: "f.txt", path: "files/a/e/f.txt", type: "file" };

const children = new Map<string, HumanFileEntry[]>([
  ["files/a/", [fileD, dirE]],
  ["files/a/e/", [fileF]],
]);

// ① parseFilesView 三态
assert.equal(parseFilesView("tree"), "tree");
assert.equal(parseFilesView("list"), "list");
assert.equal(parseFilesView(""), "list");
assert.equal(parseFilesView(undefined), "list");

// ② ancestorsOf（按传入字符串原样处理，不剥前缀）
assert.deepEqual(ancestorsOf("a/b/c.txt"), ["a", "a/b"]);
assert.deepEqual(ancestorsOf("a"), []);
assert.deepEqual(ancestorsOf("files/a/b.txt"), ["files", "files/a"]);

// ③ treeIndent
assert.equal(treeIndent(0), 0);
assert.equal(treeIndent(2), 32);
assert.equal(treeIndent(-3), 0);

// ④ flattenTree：深度优先顺序 + 展开状态
const rows = flattenTree({
  roots: [dirA, fileB, dirC],
  children,
  expanded: new Set(["files/a/", "files/a/e/"]),
});
assert.deepEqual(
  rows.map((r) => r.path),
  ["files/a/", "files/a/d.txt", "files/a/e/", "files/a/e/f.txt", "files/b.txt", "files/c/"],
);
assert.deepEqual(rows.map((r) => r.depth), [0, 1, 1, 2, 0, 0]);
assert.deepEqual(rows.map((r) => r.isDir), [true, false, true, false, false, true]);
assert.deepEqual(rows.map((r) => r.expanded), [true, false, true, false, false, false]);
// name：条目带 name 原样；目录 path 末尾 / 不残留
assert.deepEqual(rows.map((r) => r.name), ["a", "d.txt", "e", "f.txt", "b.txt", "c"]);

// ④ 折叠：未展开目录不输出子项
const collapsed = flattenTree({ roots: [dirA, fileB, dirC], children, expanded: new Set() });
assert.deepEqual(
  collapsed.map((r) => r.path),
  ["files/a/", "files/b.txt", "files/c/"],
);
assert.ok(collapsed.every((r) => r.depth === 0 && r.expanded === false));

// ⑤ flattenTree：children 缺失 = 未加载（不输出子项；旗标仍反映集合）
const unloaded = flattenTree({
  roots: [dirC],
  children: new Map(),
  expanded: new Set(["files/c/"]),
});
assert.deepEqual(unloaded.map((r) => r.path), ["files/c/"]);
assert.equal(unloaded[0].expanded, true);

// ⑥ treeKeyNav：Up/Down 夹取
assert.equal(treeKeyNav({ rows, index: 0 }, "ArrowUp"), 0);
assert.equal(treeKeyNav({ rows, index: rows.length - 1 }, "ArrowDown"), rows.length - 1);
assert.equal(treeKeyNav({ rows, index: 2 }, "ArrowUp"), 1);
assert.equal(treeKeyNav({ rows, index: 2 }, "ArrowDown"), 3);

// ⑦ treeKeyNav：ArrowRight 目录触发 onToggle；文件不触发；Left/Enter 不动
const toggled: string[] = [];
const onToggle = (p: string) => toggled.push(p);
assert.equal(treeKeyNav({ rows, index: 0 }, "ArrowRight", onToggle), 0);
assert.deepEqual(toggled, ["files/a/"]);
assert.equal(treeKeyNav({ rows, index: 1 }, "ArrowRight", onToggle), 1);
assert.deepEqual(toggled, ["files/a/"]);
assert.equal(treeKeyNav({ rows, index: 3 }, "ArrowLeft"), 3);
assert.equal(treeKeyNav({ rows, index: 3 }, "Enter"), 3);

// ⑧ 源码断言：纯类型，无 UI 运行时依赖
const modelSrc = readFileSync(
  path.join(here, "..", "src", "manage", "files", "treeModel.ts"),
  "utf8",
);
// Comments describe the contract; only executable lines count.
const modelCode = modelSrc
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
assert.ok(!/\bwindow\b/.test(modelCode), "treeModel 不应引用 window");
assert.ok(!/\bdocument\b/.test(modelCode), "treeModel 不应引用 document");
assert.ok(!/^import(?!\s+type)/m.test(modelCode), "treeModel 只允许 import type");
assert.ok(!/["'](react|antd)/.test(modelCode), "treeModel 不应引用 UI 模块");

// 防回归：TreeRow 导出为接口（类型面可被 UI 层复用）
const _rowCheck: TreeRow = rows[0];
assert.ok(_rowCheck);

console.log("files-v3-4: all assertions passed");
