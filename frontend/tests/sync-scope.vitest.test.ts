// 同步范围目录选择（SyncScopeDialog）纯函数测试。
// 覆盖：目录推导、树构造、开关 → include glob（递归/非递归）。

import { describe, expect, it } from "vitest";

import {
  buildDirTree,
  entriesToDirs,
  selectionToInclude,
} from "../src/lib/syncScopeModel";

const entries = (paths: string[]) =>
  paths.map((path) => ({ path, size: 1, etag: "e", updatedAt: "" })) as never;

describe("entriesToDirs", () => {
  it("从文件路径推导全部祖先目录", () => {
    const dirs = entriesToDirs(
      entries(["files/a.md", "files/文档/b.md", "files/文档/2026/c.md"]),
    );
    expect(dirs).toEqual(["文档", "文档/2026"]);
  });

  it("忽略非 files/ 前缀与根级文件", () => {
    expect(entriesToDirs(entries(["memory/x.md", "files/root.md"]))).toEqual([]);
  });
});

describe("buildDirTree", () => {
  it("按层级建树（父在前）", () => {
    const tree = buildDirTree(["文档/2026", "文档", "照片"]);
    expect(tree.map((n) => n.name)).toEqual(["文档", "照片"]);
    expect(tree[0].children.map((n) => n.path)).toEqual(["文档/2026"]);
    expect(tree[0].children[0].depth).toBe(1);
  });
});

describe("selectionToInclude", () => {
  const dirs = ["文档", "文档/2026", "照片"];

  it("全选 + 递归 → files/**（改造前行为）", () => {
    expect(selectionToInclude({}, true, dirs)).toEqual(["files/**"]);
  });

  it("全选 + 非递归 → 根文件 + 每个目录的直接文件（不进子目录）", () => {
    expect(selectionToInclude({}, false, dirs)).toEqual([
      "files/*",
      "files/文档/*",
      "files/文档/2026/*",
      "files/照片/*",
    ]);
  });

  it("递归：关掉一个目录 → 根直接文件 + 其余目录（子目录被父覆盖）", () => {
    expect(selectionToInclude({ 照片: false }, true, dirs)).toEqual([
      "files/*",
      "files/文档/**",
    ]);
  });

  it("递归：父目录关 → 子目录一并视为不同步（UI 同口径禁用）", () => {
    expect(selectionToInclude({ 文档: false }, true, dirs)).toEqual([
      "files/*",
      "files/照片/**",
    ]);
  });

  it("非递归：只同步根与所选目录的直接文件（不跨子目录）", () => {
    // 非递归 = 每个所选目录只同步其直接文件；子目录单独列。
    expect(selectionToInclude({ 照片: false }, false, dirs)).toEqual([
      "files/*",
      "files/文档/*",
      "files/文档/2026/*",
    ]);
  });

  it("根开关关掉 → 全部不同步（空规则）", () => {
    expect(selectionToInclude({ "": false }, true, dirs)).toEqual([]);
  });

  it("根开关开 + 关一个子目录 → 根文件与其余目录仍同步", () => {
    const inc = selectionToInclude({ "": true, 照片: false }, true, dirs);
    expect(inc).toEqual(["files/*", "files/文档/**"]);
  });

  it("全部关闭 → 空规则（调用方用 exclude files/** 表达不同步）", () => {
    expect(
      selectionToInclude(
        { "": false, 文档: false, "文档/2026": false, 照片: false },
        true,
        dirs,
      ),
    ).toEqual([]);
  });
});
