// resourceControl.ts — #1536 资源控制（创建/删除 Team/Human/Worker 等）
// 权限判定纯函数：只给 Manager/Admin（L1 = permissionLevel 1）；
// L2/L3 调用 403 → 前端入口 disabled + 统一提示（保留可发现性，不隐藏）。

/** 调用者（当前登录账号）可执行资源控制（创建/删除 Team/Human/Worker）？
 * 仅 L1（permissionLevel === 1）放行；未知（null/undefined/非 1 数值）
 * = false（fail closed——未知档位不得假设有权）。 */
export function canControlResources(
  level: number | null | undefined,
): boolean {
  return level === 1;
}

/** 入口禁用态的统一 Tooltip 文案（各入口同一措辞，i18n 键见 manage 域）。 */
export function resourceControlDeniedHint(tr: (s: string) => string): string {
  return tr("仅管理员可创建或删除资源");
}
