/** SkillCenter 子模块——自 SkillCenter.tsx 纯搬移拆出
 * （行为零变化）。 */
import type { WorkerInfo, SkillCatalogItem } from "../api";

export interface SkillDetail {
  name: string;
  description?: string;
  source?: string;
  version?: string;
  runtimes?: string[];
  agents?: string[];
  channels?: string[];
}

export interface MatrixState {
  workers: WorkerInfo[];
  loading: boolean;
  catalog: SkillCatalogItem[] | null | undefined; // null=加载中；[]=已加载空；undefined=404 不可用
  catalogNote: string; // 404 时的说明
}

/** ：Worker 行按 team 分组
 * （保持原始相对序；无 team 的归「未分组」殿后）。 */
export function groupWorkersByTeam(
  workers: WorkerInfo[],
): { team: string; workers: WorkerInfo[] }[] {
  const order: string[] = [];
  const m = new Map<string, WorkerInfo[]>();
  for (const w of workers) {
    const key = w.team || "\u0000";
    if (!m.has(key)) {
      m.set(key, []);
      order.push(key);
    }
    m.get(key)!.push(w);
  }
  // 未分组殿后（稳定：先分组、组内原序）。
  order.sort((a, b) => {
    if (a === "\u0000") return 1;
    if (b === "\u0000") return -1;
    return 0;
  });
  return order.map((team) => ({
    team: team === "\u0000" ? "" : team,
    workers: m.get(team)!,
  }));
}
