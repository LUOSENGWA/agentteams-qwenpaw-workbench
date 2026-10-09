// 审批计数共享 store——宿主侧栏审批徽标与插件内各消费方
// （HomePage/NotificationCenter/聊天页）读同一正源。
//
// 背景：侧栏徽标曾是 15s 常驻轮询（插件 tab 不活跃也照跑，成为
// /room-approvals 缓存的唯一"加热者"）。改为：
// - 网络刷新由活跃消费方驱动（各自 15s 窗轮询，requestCache 合流
//   后同一窗最多 1 次真实拨号；fetchRoomApprovals 成功取数即
//   publishApprovalCount 写入本 store）；
// - SSE approval_request/resolved 事件 → 消费方失效缓存重取 → 再
//   publish（事件驱动，零额外拨号）；
// - 侧栏图标退化为纯订阅者 + 60s 兜底轮询（仅 document 可见时，
//   覆盖"插件 tab 不活跃、无任何消费方在跑"的死角）。
//
// 宿主桥模式（本项目不可 import React from "react"）：纯模块，
// 零 React 依赖，node 可直测。

let _count = 0;
let _at = 0;
const _subs = new Set<() => void>();

/** 当前待审批数（未取过数=0；徽标"0"=无未读，语义与旧行为一致）。 */
export function getApprovalCount(): number {
  return _count;
}

/** 最近一次真实取数时刻（epoch ms；0=从未取过）。 */
export function approvalCountAt(): number {
  return _at;
}

/** 发布新计数（同值不广播——防多消费方同窗重取触发无谓订阅抖动）。 */
export function publishApprovalCount(n: number): void {
  if (n === _count) return;
  _count = n;
  _at = Date.now();
  for (const s of Array.from(_subs)) {
    try {
      s();
    } catch {
      /* 订阅者异常不拖垮其余订阅者 */
    }
  }
}

/** 订阅计数变化；返回退订函数。 */
export function subscribeApprovalCount(fn: () => void): () => void {
  _subs.add(fn);
  return () => {
    _subs.delete(fn);
  };
}

/** 测试辅助：重置。 */
export function __resetApprovalCountStore(): void {
  _count = 0;
  _at = 0;
  _subs.clear();
}
