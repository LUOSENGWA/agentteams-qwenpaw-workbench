// useCallerLevel.ts — 调用者（当前登录账号）的权限档位（#1536 入口收敛用）。
//
// 数据源（任务书 B 二选一 → 选「复用 ManagePage 已有数据」，不另起请求）：
// - data.admin = fetchAdminData（30s 轮询，cachedFetch TTL/SWR 30s）四腿之一
//   就是 GET /humans 全量列表——比任务书「缓存 60s」更新鲜，且与页面展示
//   的人员列表同一数据源（gating 与所见永远一致，不出现两套真相）；
// - myUserId = config.matrix.user_id（WorkbenchPage → ManagePage 既有 prop，
//   与 MyScopeCard 读 host 的口径同源）；
// - 本函数自身零网络（纯派生，无内部 React hooks——可直呼、可单测）；
// - fail closed：无 token（admin=null）/ 未登录（myUserId 空）/ 找不到
//   self / 档位缺失 → null（= 不可控制资源，入口 disabled）。

import type { AdminData } from "../api";

export interface CallerLevelSource {
  /** L1 管理全量数据（无 Controller 管理员 token 时 = null）。 */
  admin: AdminData | null;
  /** 当前登录账号 MXID（config.matrix.user_id；空 = 未登录）。 */
  myUserId?: string;
  /** 是否已配置 Controller 管理员 token。 */
  hasToken?: boolean;
}

/** 当前登录账号的权限档位（1/2/3）；null = 未知（按不可控制处理）。 */
export function useCallerLevel(src: CallerLevelSource): number | null {
  if (!src.hasToken || !src.admin) return null;
  const myUserId = src.myUserId ?? "";
  if (!myUserId) return null;
  const self = src.admin.humans.find((h) => h.matrixUserID === myUserId);
  const level = self?.permissionLevel;
  return typeof level === "number" ? level : null;
}
