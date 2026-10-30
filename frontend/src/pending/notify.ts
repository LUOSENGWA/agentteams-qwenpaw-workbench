// P0 人工介入闭环 — 系统通知（任务书 §3 Stage 2）。
//
// 纪律：
// - 只在 Notification.permission === "granted" 时发；denied 时**绝不
//   再请求**（用户反馈「没有通知」的补法，不是反复弹窗要权限）；
// - 已通知过（localStorage 台账 agentteams-notified-v1，上限 200）
//   的 id 不再发——同一待办被轮询反复 upsert 只响一次；
// - 点击深链：写 store 的 pendingChatRoomId / pendingProjectKey 后
//   emitPendingNav，由 WorkbenchPage 订阅应用（通知回调里没有
//   React 句柄，不能直接 setState）。

import type { PendingItem } from "./types";
import {
  emitPendingNav,
  setPendingChatRoomId,
  setPendingProjectKey,
} from "./store";

export const NOTIFIED_KEY = "agentteams-notified-v1";
const NOTIFIED_CAP = 200;

function loadNotified(): Set<string> {
  try {
    const raw = window.localStorage.getItem(NOTIFIED_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : null;
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function saveNotified(set: Set<string>): void {
  try {
    const arr = [...set];
    if (arr.length > NOTIFIED_CAP) arr.splice(0, arr.length - NOTIFIED_CAP);
    window.localStorage.setItem(NOTIFIED_KEY, JSON.stringify(arr));
  } catch {
    /* 台账写不进不影响通知本体 */
  }
}

const TITLES: Record<PendingItem["kind"], string> = {
  intervention: "🙋 需要你介入",
  approval: "🛡️ 待你审批",
  interrupt: "⏸️ 项目等待介入",
  mention: "💬 有人 @你",
};

/** 新待办 → 系统通知（已通知/未授权/无 Notification API 静默跳过）。 */
export function notifyPending(item: PendingItem): void {
  try {
    if (typeof window === "undefined" || typeof window.Notification === "undefined") {
      return;
    }
    if (window.Notification.permission !== "granted") return; // 绝不主动请求

    const ledger = loadNotified();
    if (ledger.has(item.id)) return;
    ledger.add(item.id);
    saveNotified(ledger);

    const body = (item.question || item.raw || "")
      .replace(/\*\*/g, "")
      .slice(0, 160);
    const n = new window.Notification(TITLES[item.kind] ?? "📋 待处理", {
      body,
      tag: item.id,
      data: { roomId: item.roomId ?? null, projectId: item.projectId ?? null },
    });
    n.onclick = () => {
      if (item.roomId) setPendingChatRoomId(item.roomId);
      if (item.projectId) setPendingProjectKey(item.projectId);
      emitPendingNav();
      try {
        window.focus();
      } catch {
        /* noop */
      }
      n.close();
    };
  } catch {
    /* 通知失败不阻塞主流程 */
  }
}
