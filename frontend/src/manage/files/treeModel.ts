// F-V3-4：文件「树形视图」纯逻辑——视图开关解析、祖先路径、缩进、
// 树拍平、键盘导航。只引类型，不依赖 UI 运行时（无 React/antd/window）；
// UI 接线在后续提交。
//
// 直跑：node --experimental-strip-types frontend/tests/files-v3-4.test.ts

import type { HumanFileEntry } from "../../api/domains/humanFiles";

export type FilesView = "list" | "tree";

/** 解析持久化的视图设置："tree"→tree，其它/空/非法→list（回落）。 */
export function parseFilesView(raw: unknown): FilesView {
  return raw === "tree" ? "tree" : "list";
}

/** 传入路径的全部祖先路径（不含自身），根到近排序。
 *  按传入字符串原样处理，不做前缀假设：
 *  "a/b/c.txt" → ["a","a/b"]；根层 "a" → []。 */
export function ancestorsOf(path: string): string[] {
  const parts = path.split("/");
  const out: string[] = [];
  for (let k = 1; k < parts.length; k++) {
    out.push(parts.slice(0, k).join("/"));
  }
  return out;
}

/** 每级缩进：depth*16 px，负值按 0。 */
export function treeIndent(depth: number): number {
  return depth < 0 ? 0 : depth * 16;
}

export interface TreeRow {
  path: string;
  name: string;
  depth: number;
  isDir: boolean;
  expanded: boolean;
  entry?: HumanFileEntry;
}

function entryPath(e: HumanFileEntry): string {
  return e.path ?? e.name ?? "";
}

function entryName(e: HumanFileEntry): string {
  if (e.name) return e.name;
  if (e.path) {
    const seg = e.path.split("/").filter(Boolean).pop();
    if (seg !== undefined) return seg;
  }
  return "";
}

/** 目录判定：显式 type 优先；type 缺省（#1518 新形态可能缺省）时
 *  按「path 以 / 结尾 = 目录」推断。 */
function entryIsDir(e: HumanFileEntry): boolean {
  if (e.type !== undefined) return e.type === "directory";
  return typeof e.path === "string" && e.path.endsWith("/");
}

/** 深度优先拍平：目录未展开则不输出子项；children 缺失该目录 path
 *  视为未加载（同样不输出子项）。depth 0 = 当前目录条目。 */
export function flattenTree(opts: {
  roots: HumanFileEntry[];                    // 当前目录条目
  children: Map<string, HumanFileEntry[]>;    // 已加载的子目录条目（key = 目录 path）
  expanded: Set<string>;
}): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (entries: HumanFileEntry[], depth: number): void => {
    for (const e of entries) {
      const p = entryPath(e);
      const dir = entryIsDir(e);
      const isOpen = dir && opts.expanded.has(p);
      rows.push({
        path: p,
        name: entryName(e),
        depth,
        isDir: dir,
        expanded: isOpen,
        entry: e,
      });
      if (isOpen) {
        const kids = opts.children.get(p);
        if (kids !== undefined) walk(kids, depth + 1);
      }
    }
  };
  walk(opts.roots, 0);
  return rows;
}

/** 树形键盘导航：返回新的 index（焦点移动由调用方执行）。
 *  Up/Down 夹在 [0, rows.length-1]；Right 落在目录上触发 onToggle(path)
 *  （展开/收起由调用方决定）；Left/Enter/其它一律返回原 index。 */
export function treeKeyNav(
  state: { rows: TreeRow[]; index: number },
  key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Enter",
  onToggle?: (path: string) => void,
): number {
  const { rows, index } = state;
  if (key === "ArrowUp") return index <= 0 ? index : index - 1;
  if (key === "ArrowDown") return index >= rows.length - 1 ? index : index + 1;
  if (key === "ArrowRight") {
    const row = rows[index];
    if (row !== undefined && row.isDir) onToggle?.(row.path);
  }
  return index;
}
