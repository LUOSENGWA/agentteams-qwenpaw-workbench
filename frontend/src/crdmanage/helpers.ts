// CrdManage 拆分（QC-196 方案 §5.2）· 纯叶子 helpers：SOUL 预算 / 选项
// 标签 / 行数——纯函数，零 React 依赖（node 可直测，见
// scripts/crdmanageHelpers.smoke.mjs）。函数体逐字自 components/CrdManage.tsx
// 搬移。

import type { AdminData } from "../api";
import type { TrFn } from "./types";

/** SOUL 行数预算（设计约束 v2.39.2：Worker ≤150 / Leader ≤250 行）——超了告警不阻断。 */
export function soulBudget(role: string): number {
  return role === "team_leader" ? 250 : 150;
}

/** ：Worker 选择选项 = 名字 + 现况（所属团队 · 现用模型），
 * 一眼分辨"换谁、现在跑的什么模型"；无数据时退回纯名字。 */
export function workerOptionLabel(
  name: string,
  workers: AdminData["workers"],
): string {
  const w = workers.find((x) => x.name === name);
  const parts = [w?.team, w?.model].filter(Boolean);
  return parts.length ? `${name} (${parts.join(" · ")})` : name;
}

/** 角色选择选项（建队行/团队配置共用）：人话标签 + 原始枚举（提交值不变，
 * Controller 仍收 team_leader/worker）。 */
export function roleSelectOptions(tr: TrFn) {
  return [
    { value: "team_leader", label: tr("Leader (team_leader)") },
    { value: "worker", label: tr("Worker (worker)") },
  ];
}

export function soulLines(s: string): number {
  return (s || "").split("\n").length;
}
