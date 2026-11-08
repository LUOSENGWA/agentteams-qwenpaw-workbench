// spawnModel.ts — 「子会话」树的纯派生函数（无 React / 无 window 依赖，
// node 环境直测）。旧拓扑 WorkerManageTree.SpawnRow 的递归渲染迁入 manage
// 后，树展开/计数/折叠阈值判定收敛在此，UI 只做呈现。

import type { SpawnNode } from "../api";

/** 树行：node + 深度 + 是否有子节点（决定 caret 是否渲染）。 */
export interface SpawnRowModel {
  node: SpawnNode;
  depth: number;
  hasChildren: boolean;
}

/** 递归展开 spawn 树为平面行（缩进按 depth）。collapsed 命中的节点
 * 保留自身、不展开其子树（不丢行，只收起）。 */
export function flattenSpawnTree(
  nodes: SpawnNode[] | undefined,
  collapsed: ReadonlySet<string> = new Set<string>(),
): SpawnRowModel[] {
  const out: SpawnRowModel[] = [];
  const walk = (list: SpawnNode[] | undefined, depth: number): void => {
    if (!Array.isArray(list)) return;
    for (const node of list) {
      if (!node || typeof node.session_id !== "string") continue;
      const children = Array.isArray(node.children) ? node.children : [];
      out.push({ node, depth, hasChildren: children.length > 0 });
      if (children.length > 0 && !collapsed.has(node.session_id)) {
        walk(children, depth + 1);
      }
    }
  };
  walk(nodes, 0);
  return out;
}

/** 递归子会话总数（含全部层级；徽标/卡头副标用）。 */
export function countSpawnNodes(nodes: SpawnNode[] | undefined): number {
  if (!Array.isArray(nodes)) return 0;
  let total = 0;
  for (const node of nodes) {
    if (!node) continue;
    total += 1 + countSpawnNodes(node.children);
  }
  return total;
}

/** 行展示名：name 优先，缺失回退 session_id（旧 SpawnRow 同款）。 */
export function spawnRowName(node: SpawnNode): string {
  return node.name || node.session_id || "?";
}

/** has_more=true 且确有展示条数时给出提示用的 N（0 = 不显示提示）。 */
export function spawnHasMoreCount(
  hasMore: boolean | undefined,
  shown: number,
): number {
  return hasMore === true && shown > 0 ? shown : 0;
}
