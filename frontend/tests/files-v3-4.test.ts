// F-V3-4：文件「树形/网格视图」纯逻辑 treeModel（视图解析 / 祖先路径 /
// 缩进 / 树拍平 / 键盘导航 / 网格最小列数）。直接 import（treeModel 只
// import type，strip-types 擦除后不加载 humanFiles 实体），不碰 UI、不进
// vitest 面（文件名不带 .vitest.）。
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
// ⑩ parseFilesView 认 "grid" → grid（第三态；其余回落 list 已由 ① 覆盖）；
// ⑪ gridMinCols 四档（含边界）：≤600 → 2；≤900 → 3；≤1400 → 4；否则 → 5；
// ⑫ 源码接线断言：FilesSection 含 filesView === "grid" 分支 + gridMinCols
//    接线 + 网格模板字面量 + 「网格」分段按钮文案 + 缩略图懒加载接线。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ancestorsOf,
  flattenTree,
  gridMinCols,
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

// ⑨ 源码接线断言：FilesSection 已 import 并消费树模型（视图解析 / 树拍平 /
// 键盘导航），工具条有「树」分段按钮文案（模型自身行为 ①–⑦ 已覆盖，不重复）。
const sectionSrc = readFileSync(
  path.join(here, "..", "src", "manage", "FilesSection.tsx"),
  "utf8",
);
assert.ok(sectionSrc.includes("parseFilesView"), "FilesSection 接线 parseFilesView（视图持久化解析）");
assert.ok(sectionSrc.includes("flattenTree"), "FilesSection 接线 flattenTree（树拍平渲染）");
assert.ok(sectionSrc.includes("treeKeyNav"), "FilesSection 接线 treeKeyNav（键盘导航）");
assert.ok(sectionSrc.includes('tr("树")'), "工具条有「树」分段按钮文案");

// ⑩ parseFilesView 认 "grid"（第三态）
assert.equal(parseFilesView("grid"), "grid");

// ⑪ gridMinCols 四档（含边界）
assert.equal(gridMinCols(0), 2);
assert.equal(gridMinCols(600), 2);
assert.equal(gridMinCols(601), 3);
assert.equal(gridMinCols(900), 3);
assert.equal(gridMinCols(901), 4);
assert.equal(gridMinCols(1400), 4);
assert.equal(gridMinCols(1401), 5);
assert.equal(gridMinCols(4000), 5);

// ⑫ 源码接线断言：FilesSection 网格视图分支 + 接线（模型自身行为 ⑩–⑪
// 已覆盖，不重复）
assert.ok(sectionSrc.includes('filesView === "grid"'), 'FilesSection 含 filesView === "grid" 分支');
assert.ok(sectionSrc.includes("gridMinCols"), "FilesSection 接线 gridMinCols（窄容器按档收窄 min 边）");
assert.ok(
  sectionSrc.includes("repeat(auto-fill, minmax(180px, 1fr))"),
  "网格列模板 = 任务书字面形态",
);
assert.ok(sectionSrc.includes('tr("网格")'), "工具条有「网格」分段按钮文案");
assert.ok(sectionSrc.includes("useMediaObjectUrl"), "网格缩略图走 useMediaObjectUrl（host.fetch blob → objectURL）");
assert.ok(sectionSrc.includes("IntersectionObserver"), "缩略图懒加载用 IntersectionObserver（不可用 → 只出图标）");

// 防回归：TreeRow 导出为接口（类型面可被 UI 层复用）
const _rowCheck: TreeRow = rows[0];
assert.ok(_rowCheck);

console.log("files-v3-4: all assertions passed");

// ── 列表列：Finder 风格类型列（F-COLS）+ files-ux-r2 列分档（按列表宽）──
{
  // FilesSection / icons 的模块顶层读 window.QwenPaw.host（React / antd）→
  // 动态 import 前先装最小宿主 shim。
  const ReactNS = (await import("react")).default as unknown;
  (globalThis as Record<string, unknown>).window = {
    QwenPaw: {
      host: {
        React: ReactNS,
        antd: {},
        antdIcons: {},
        useLocale: () => "zh",
        useTheme: () => "light",
      },
    },
  };
  const { fileTypeLabel, columnsFor, listGrid } = await import("../src/manage/FilesSection.tsx");
  assert.equal(fileTypeLabel({ name: "a.PNG", type: "file", size: 1 }), "PNG");
  assert.equal(fileTypeLabel({ name: "docs", type: "dir" }), "文件夹");
  // 轨道数 = 列数（显式列，无隐式 auto 轨）；操作轨 152px 含 3 个触控按钮。
  assert.equal(listGrid(["name", "size", "type", "modified", "actions"]), "minmax(0, 1fr) 72px 84px 120px 152px");
  assert.equal(listGrid(["select", "name", "more"]), "44px minmax(0, 1fr) 44px");
  // 列分档按**列表列宽**：≥900 全列 / <900 收「修改」/ <700 只留名称 + 更多。
  assert.equal(columnsFor(950, false).showUpdatedAt, true);
  assert.equal(columnsFor(680, false).showUpdatedAt, false);
  assert.equal(columnsFor(680, false).compactActions, true);
  assert.equal(columnsFor(950, false).compactActions, false);
}
