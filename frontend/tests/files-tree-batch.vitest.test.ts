// 树视图批量选择：shift 区间按可见行顺序（目录跳过）、折叠保选
//（已知条目含已加载子层；可见行收窄不清选择）。
import { describe, expect, it } from "vitest";

import type { HumanFileEntry } from "../src/api/domains/humanFiles";
import { pruneSelection, toggleSelection } from "../src/lib/filesSelection";
import { collectTreeEntries, flattenTree } from "../src/manage/files/treeModel";

const isDir = (e: HumanFileEntry): boolean =>
  e.type === "directory" || (e.path ?? "").endsWith("/");

const ROOTS: HumanFileEntry[] = [
  { path: "a.txt", size: 10 },
  { path: "d/", type: "directory" },
  { path: "e.txt", size: 20 },
];
const CHILDREN = new Map<string, HumanFileEntry[]>([
  [
    "d/",
    [
      { path: "d/b.txt", size: 5 },
      { path: "d/c.txt", size: 6 },
    ],
  ],
]);

/** 可见文件行路径（flattenTree 深优先序，目录行跳过）。 */
function visibleFilePaths(
  roots: HumanFileEntry[],
  children: Map<string, HumanFileEntry[]>,
  expanded: Set<string>,
): string[] {
  return flattenTree({ roots, children, expanded })
    .filter((r) => !r.isDir)
    .map((r) => r.path);
}

describe("shift 区间 — 按可见顺序（任务书必测：树选择区间）", () => {
  it("展开 d/ 后可见序 = 根文件 + 子目录文件；区间含两端且跳过目录行", () => {
    const expanded = new Set(["d/"]);
    const paths = visibleFilePaths(ROOTS, CHILDREN, expanded);
    expect(paths).toEqual(["a.txt", "d/b.txt", "d/c.txt", "e.txt"]);

    // 点 a.txt 设锚点，shift + 点 d/c.txt → 可见区间 [a.txt..d/c.txt]。
    const anchored = toggleSelection(new Set(), "a.txt");
    const ranged = toggleSelection(anchored, "d/c.txt", {
      shiftKey: true,
      anchor: "a.txt",
      paths,
    });
    expect([...ranged].sort()).toEqual(["a.txt", "d/b.txt", "d/c.txt"]);
    expect(ranged.has("e.txt")).toBe(false);
    expect(ranged.has("d/")).toBe(false); // 目录不可选
  });

  it("折叠后区间只在可见行内（折叠子项不在 paths → 不选中）", () => {
    const paths = visibleFilePaths(ROOTS, CHILDREN, new Set());
    expect(paths).toEqual(["a.txt", "e.txt"]);
    const ranged = toggleSelection(new Set(["a.txt"]), "e.txt", {
      shiftKey: true,
      anchor: "a.txt",
      paths,
    });
    expect([...ranged].sort()).toEqual(["a.txt", "e.txt"]);
  });

  it("锚点已折叠不可见 → 回落单点 toggle（不误扩区间）", () => {
    const paths = visibleFilePaths(ROOTS, CHILDREN, new Set());
    const s = toggleSelection(new Set(), "e.txt", {
      shiftKey: true,
      anchor: "d/b.txt",
      paths,
    });
    expect([...s]).toEqual(["e.txt"]);
  });
});

describe("折叠保选（任务书必测）", () => {
  it("折叠隐藏子项后，已知条目仍含缓存子文件 → prune 保留已选", () => {
    const expanded = new Set(["d/"]);
    const visibleExpanded = visibleFilePaths(ROOTS, CHILDREN, expanded);
    const selected = toggleSelection(new Set(), "d/b.txt", {
      paths: visibleExpanded,
    });
    expect(selected.has("d/b.txt")).toBe(true);

    // 折叠：可见行不再含 d/b.txt（仅可见基准会丢选择）。
    const visibleCollapsed = visibleFilePaths(ROOTS, CHILDREN, new Set());
    expect(visibleCollapsed).toEqual(["a.txt", "e.txt"]);
    expect(pruneSelection(selected, visibleCollapsed).has("d/b.txt")).toBe(false);

    // 已知条目 = 根 + 已加载子层（与展开状态无关）→ 选择保留。
    const knownPaths = collectTreeEntries(ROOTS, CHILDREN)
      .filter((e) => !isDir(e))
      .map((e) => e.path ?? "");
    expect(knownPaths).toEqual(["a.txt", "e.txt", "d/b.txt", "d/c.txt"]);
    const kept = pruneSelection(selected, knownPaths);
    expect(kept.has("d/b.txt")).toBe(true);
    expect(kept).toBe(selected); // 无变化原样返回（避免重渲染）
  });

  it("collectTreeEntries 未加载的子目录不凭空产生条目", () => {
    const known = collectTreeEntries(ROOTS, new Map());
    expect(known.map((e) => e.path)).toEqual(["a.txt", "d/", "e.txt"]);
  });
});
