/**
 * standalone.ts — 「未归属团队的 Worker」判定（单一实现）。
 *
 * 独立 Worker = Worker CRD 存在、但不在任何 Team 的 workerNames / workerMembers 里
 * （WorkerSpec 本身没有 team 字段，团队靠 Team 引用 Worker，见
 * agentteams-controller/api/v1beta1/types.go）。
 *
 * 从 HumanAccessModal 抽出：该函数此前住在弹窗组件里，导致管理页（TeamSection /
 * TeamSettingsPane）为了一个纯函数把整个弹窗模块（含 antd 表单）拉进首屏，
 * 并在 16.41 触发管理页整体渲染失败。
 */
import type { AdminData } from "../api";

export function computeStandaloneWorkers(
  teams: Array<{ workerNames?: string[]; workerMembers?: Array<{ name: string }> }>,
  workers: AdminData["workers"],
): string[] {
  const inTeam = new Set<string>();
  for (const tm of teams || []) {
    for (const n of tm.workerNames ?? []) inTeam.add(n);
    for (const m of tm.workerMembers ?? []) inTeam.add(m.name);
  }
  return (workers || []).map((w) => w.name).filter((n) => !inTeam.has(n));
}
