/** GraphCard 子模块——自 GraphCard.tsx 纯搬移拆出
 * （行为零变化）。 */
import type { GraphNodeLike } from "./types";

export const GRAPH_ROOT_COLOR = "#FF7F16"; // QwenPaw --graph-3d-root
export const GRAPH_DIRECT_COLOR = "#389E5C"; // QwenPaw --graph-3d-direct
export const GRAPH_FILE_LIGHT = "#71665E"; // QwenPaw --graph-3d-file
export const GRAPH_FILE_DARK = "#A29A92";

export type LinkRef = { id: string; anchor?: string | null };

export interface GraphModel {
  rootIds: Set<string>;
  directIds: Set<string>;
  neighbors: Map<string, Set<string>>;
  inbound: Map<string, LinkRef[]>;
  outbound: Map<string, LinkRef[]>;
}

export function buildGraphModel(
  graph: { nodes: GraphNodeLike[]; edges: { source: string; target: string; target_anchor?: string | null }[] } | null,
): GraphModel | null {
    if (!graph) return null;
    const rootIds = new Set(
      graph.nodes
        .filter((n) => n.id.startsWith("virtual:"))
        .map((n) => n.id),
    );
    const directIds = new Set<string>();
    const neighbors = new Map<string, Set<string>>();
    const inbound = new Map<string, LinkRef[]>();
    const outbound = new Map<string, LinkRef[]>();
    const seenIO = new Set<string>();
    graph.edges.forEach((e) => {
      if (rootIds.has(e.source)) directIds.add(e.target);
      if (!neighbors.has(e.source)) neighbors.set(e.source, new Set());
      neighbors.get(e.source)!.add(e.target);
      if (!neighbors.has(e.target)) neighbors.set(e.target, new Set());
      neighbors.get(e.target)!.add(e.source);
      const ikey = `${e.source}\u0000${e.target}\u0000${e.target_anchor ?? ""}`;
      if (!seenIO.has(`o:${ikey}`)) {
        seenIO.add(`o:${ikey}`);
        if (!outbound.has(e.source)) outbound.set(e.source, []);
        outbound.get(e.source)!.push({ id: e.target, anchor: e.target_anchor });
      }
      if (!seenIO.has(`i:${ikey}`)) {
        seenIO.add(`i:${ikey}`);
        if (!inbound.has(e.target)) inbound.set(e.target, []);
        inbound.get(e.target)!.push({ id: e.source, anchor: e.target_anchor });
      }
    });
    return { rootIds, directIds, neighbors, inbound, outbound };
}
