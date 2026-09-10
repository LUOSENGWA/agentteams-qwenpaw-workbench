/** 共享工具（无 DOM 依赖的纯函数）。 */

/** 聊天时间格式化：0/空 → ""，今天 → HH:mm，跨天 → MM-DD HH:mm（本地时间）。
 *  v0.4.81：聊天 tab 房间列表「最后消息时间」列。 */
export function formatChatTime(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return `${hh}:${mm}`;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")} ${hh}:${mm}`;
}
