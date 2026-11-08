// Worker 写前读 detail 门（#1477 消费侧，纯逻辑，零 UI 依赖，可 node 直测）。
//
// 背景：GET /api/v1/workers?fields=spec,status 投影瘦身——列表行不再含
// skills/mcpServers/env（仅 detail GET /workers/{name} 全量含）。写编辑器
// （技能中心技能矩阵 / MCP / WorkerEnvPanel）必须 detail 取数成功后才可
// 编辑；loading/error → 只读，禁止回退用列表行兜底（整字段替换语义下
// 基于空基线盲写 = 清掉未知存量）。
//
// 保留值契约（上游 PR #1477 设计文档 worker-list-fields-api.md）：detail
// 载入后，增删 skill/mcp 提交的是**合并后**列表——已有 skills/mcpServers
// 不得丢。合并语义：
//   · skills：并集去重，existing 序在前（投影后列表行空基线上的用户新增，
//     经 existing 补齐已有项，不丢）。
//   · mcp：按 name 合并——existing 序保留；同名项以 edited 覆盖（用户
//     改过的 url/transport 生效）；edited 新增项追加。
// env 不走本模块：rows 已按 detail.env re-baseline，用户 current 即完整
// 意图（删除=从 map 移除，整块替换语义由面板二次确认承担）。

/** detail 取数状态机（组件侧维护；gate 只看状态不看载荷）。 */
export type DetailState = "idle" | "loading" | "error" | "ready";

/** 写门：仅 detail 加载成功（ready）才可写。 */
export function canWrite(detailState: DetailState): boolean {
  return detailState === "ready";
}

/** 保留值合并（skills）：并集去重，existing 序在前。 */
export function mergeSkillList(existing: string[], edited: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [...(existing || []), ...(edited || [])]) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function mcpName(m: unknown): string {
  if (m && typeof m === "object" && "name" in m) {
    return String((m as { name: unknown }).name ?? "").trim();
  }
  return "";
}

/** 保留值合并（MCP）：按 name 去重合并——existing 序保留；同名项以
 * edited 覆盖（用户编辑生效）；edited 新增项追加；无名条目原样保留
 * （不参与去重）。 */
export function mergeMcpList(existing: unknown[], edited: unknown[]): unknown[] {
  const list = (arr: unknown[]): unknown[] => (Array.isArray(arr) ? arr : []);
  const out: unknown[] = [];
  const indexOfName = new Map<string, number>();
  for (const m of list(existing)) {
    const n = mcpName(m);
    if (!n) {
      out.push(m);
      continue;
    }
    if (indexOfName.has(n)) continue;
    indexOfName.set(n, out.length);
    out.push(m);
  }
  for (const m of list(edited)) {
    const n = mcpName(m);
    if (!n) {
      out.push(m);
      continue;
    }
    const i = indexOfName.get(n);
    if (i === undefined) {
      indexOfName.set(n, out.length);
      out.push(m);
    } else {
      out[i] = m;
    }
  }
  return out;
}
