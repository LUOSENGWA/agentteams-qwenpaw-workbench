// Worker 列表行合并纯函数（R1 slim parallel polling，dashboard #179 权威语义
// 端口；正源 docs/worker-list-compatibility.md）。
//
// 行契约：稳定身份 = name（CR 名，恒有）；workerName（显示名，若有）只是
// 普通字段——禁止按列表位置关联行。
// 合并规则（#179 原文要点）：
// - 按稳定 name 合并，不看列表位置；
// - 同名字段：status 视图覆盖 spec 视图（status 是最新运行期真相）；
// - membership 由 status 决定：spec 有而 status 无的 Worker 必须消失；
//   status 有而 spec 无的 Worker 保留（上层据此重读一次 spec，仍缺 →
//   fields=spec,status 合并视图）；
// - 结果顺序 = status 顺序。
//
// 纯模块硬约束（同 requestCache / workerDetailGate 一脉）：零 import，
// node --experimental-strip-types 可直测（frontend/tests/r1-slim-list.test.ts）。
// 行类型用泛型 T extends { name: string } 而非依赖 crd.ts 的 WorkerInfo
// （crd.ts 有浏览器 bundle import 链，node 不可直 import——P1 测试同款原因）。

/** 行合并：status 覆盖同名字段、membership 取 status、顺序取 status。 */
export function mergeWorkerRows<T extends { name: string }>(
  specRows: readonly T[],
  statusRows: readonly T[],
): T[] {
  const byName = new Map<string, T>();
  for (const row of specRows) {
    if (typeof row.name === "string") byName.set(row.name, row);
  }
  const out: T[] = [];
  for (const row of statusRows) {
    if (typeof row.name !== "string") continue;
    const base = byName.get(row.name);
    out.push(base ? ({ ...base, ...row } as T) : ({ ...row } as T));
  }
  return out;
}

/** status 有而 spec 无的 name 列表（status 顺序、去重）——上层：重读一次
 * spec（reload 不带 If-None-Match）；仍缺 → 合并视图。 */
export function missingSpecNames<T extends { name: string }>(
  specRows: readonly T[],
  statusRows: readonly T[],
): string[] {
  const specNames = new Set<string>();
  for (const row of specRows) {
    if (typeof row.name === "string") specNames.add(row.name);
  }
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const row of statusRows) {
    if (
      typeof row.name === "string" &&
      !specNames.has(row.name) &&
      !seen.has(row.name)
    ) {
      seen.add(row.name);
      missing.push(row.name);
    }
  }
  return missing;
}

/** spec 重读后仍有 name 缺失 → 需要 fields=spec,status 合并视图。 */
export function shouldFallbackCombined<T extends { name: string }>(
  specRows: readonly T[],
  statusRows: readonly T[],
): boolean {
  return missingSpecNames(specRows, statusRows).length > 0;
}
