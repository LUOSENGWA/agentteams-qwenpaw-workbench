// syncScopeModel — 同步范围目录选择的纯逻辑（无 window/React 依赖，node 可测）。
//
// 语义对齐 Dropbox「Selective sync」/ OneDrive「Choose folders」/ Nextcloud
// 桌面端：只列文件夹、逐个开关；关掉 = 该文件夹不再同步到本机，云端保留。
// 「递归同步子文件夹」总开关决定导出 glob 是 `files/<dir>/**`（递归）还是
// `files/<dir>/*`（仅直接文件）；引擎 should_sync 是权威判定。

import type { HumanFileEntry } from "../api";

export interface SyncScope {
  /** 目录相对路径（无 files/ 前缀；"" = 根）→ 是否同步。 */
  selection: Record<string, boolean>;
  /** 递归同步子文件夹。 */
  recursive: boolean;
}

export interface DirNode {
  name: string;
  path: string;
  depth: number;
  children: DirNode[];
}

/** 目录集合 → 树（根节点不入树，根下目录 depth=0）。 */
export function buildDirTree(dirs: string[]): DirNode[] {
  const root: DirNode = { name: "", path: "", depth: -1, children: [] };
  const index = new Map<string, DirNode>([["", root]]);
  const sorted = [...new Set(dirs)].filter(Boolean).sort();
  for (const d of sorted) {
    const segs = d.split("/").filter(Boolean);
    let parent = root;
    let acc = "";
    for (let i = 0; i < segs.length; i += 1) {
      acc = acc ? `${acc}/${segs[i]}` : segs[i];
      let node = index.get(acc);
      if (!node) {
        node = { name: segs[i], path: acc, depth: i, children: [] };
        index.set(acc, node);
        parent.children.push(node);
      }
      parent = node;
    }
  }
  return root.children;
}

/** 目录树 → 全路径列表（父在前，便于整枝开关）。 */
export function flattenTree(nodes: DirNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    out.push(n.path);
    flattenTree(n.children, out);
  }
  return out;
}

/** files/ 前缀剥掉（Controller 列表与镜像清单同拼写）。 */
export function entriesToDirs(entries: HumanFileEntry[]): string[] {
  const out = new Set<string>();
  for (const e of entries) {
    const p = String(e.path ?? "").replace(/^\/+/, "");
    if (!p.startsWith("files/")) continue;
    const rel = p.slice("files/".length);
    const segs = rel.split("/").filter(Boolean);
    // 最后一段 = 文件（无目录），其前缀段才是目录。
    for (let i = 1; i < segs.length; i += 1) {
      out.add(segs.slice(0, i).join("/"));
    }
  }
  return [...out].sort();
}

/** 目录开关 → include glob（引擎权威判定；递归/非递归两态）。
 *
 * 规则：
 * - 根（""）与全部目录都开 → 单条 `files/**`（递归）/ `files/*`（非递归）；
 * - 否则：根开 → `files/*`（根下直接文件）；每个「生效且在递归模式下
 *   未被父目录覆盖」的目录 → `files/<d>/**` 或 `files/<d>/*`；
 * - 全关 → `[]`（调用方配 exclude=`files/**` 表达「一个都不同步」，
 *   因为 include 为空时引擎回退默认 files/**）。
 */
export function selectionToInclude(
  selection: Record<string, boolean>,
  recursive: boolean,
  dirs: string[],
): string[] {
  const all = [...new Set(dirs.filter(Boolean))].sort();
  const rawOn = (p: string): boolean => selection[p] !== false;
  const ancestorOff = (p: string): boolean => {
    // 根开关（""）是全部目录的祖先：根关 → 其后代一律不同步。
    if (p !== "" && !rawOn("")) return true;
    const segs = p.split("/");
    for (let i = 1; i < segs.length; i += 1) {
      if (!rawOn(segs.slice(0, i).join("/"))) return true;
    }
    return false;
  };
  const isOn = (p: string): boolean => rawOn(p) && !ancestorOff(p);
  const rootOn = rawOn("");
  if (rootOn && all.every(isOn) && recursive) {
    // 递归 + 全选 → 一条通配覆盖全部（含根下文件）。
    return ["files/**"];
  }
  const inc = new Set<string>();
  if (rootOn) inc.add("files/*");
  for (const d of all) {
    if (!isOn(d)) continue;
    if (recursive) {
      // 递归：任一祖先已选 → 覆盖，跳过。
      let covered = false;
      const segs = d.split("/");
      for (let i = 1; i < segs.length; i += 1) {
        if (isOn(segs.slice(0, i).join("/"))) {
          covered = true;
          break;
        }
      }
      if (covered) continue;
      inc.add(`files/${d}/**`);
    } else {
      inc.add(`files/${d}/*`);
    }
  }
  return [...inc].sort();
}
