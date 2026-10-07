/** 共享工具（无 DOM 依赖的纯函数）。 */

/** 聊天时间格式化：0/空 → ""，今天 → HH:mm，跨天 → MM-DD HH:mm（本地时间）。
 * v0.5.0-beta.12：聊天 tab 房间列表「最后消息时间」列。 */
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

/** 文件大小 humanize：0/空/非数值 → ""，<1KB → B，<1MB → KB，否则 MB（无空格形态）。 */
export function formatSize(bytes?: unknown): string {
  const n = Number(bytes || 0);
  if (!n) return "";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** 复制到剪贴板（五处重复片段收敛）：clipboard 不可用 → 直接 onResult(false)，
 * 不静默吞掉。成败 toast 由调用点传入（各点文案/级别原样保留，i18n 零新条目）——
 * tr 只有 i18n hooks（useT）可达，util 纯模块不复制 DICT 查找逻辑。 */
export function copyText(x: string, onResult: (ok: boolean) => void): void {
  // typeof 守卫（与真值判断语义一致）：TS 5.9 对「函数引用真值判断 + 分支内
  // 普通函数调用」误报 TS2774，真值写法在分支体含函数调用时不可用。
  if (typeof navigator.clipboard?.writeText === "function") {
    navigator.clipboard.writeText(x).then(
      () => onResult(true),
      () => onResult(false),
    );
  } else {
    onResult(false);
  }
}
