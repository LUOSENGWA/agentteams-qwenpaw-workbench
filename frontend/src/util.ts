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

/** 时刻（B-1 收敛，任务 190）：逐字等价 new Date(ms).toLocaleTimeString(locale)。
 * locale 省略 → 默认 locale，与原裸 toLocaleTimeString() 调用同输出。 */
export function formatTimeOfDay(ms: number, locale?: string): string {
  return new Date(ms).toLocaleTimeString(locale);
}

/** 完整日期+时间（B-1 收敛，任务 190）：逐字等价 new Date(ms).toLocaleString(locale)。 */
export function formatDateTime(ms: number, locale?: string): string {
  return new Date(ms).toLocaleString(locale);
}

/** 时刻不带 AM/PM（B-1 收敛，任务 190）：逐字等价 toLocaleTimeString("zh-CN", { hour12: false })。 */
export function formatTimeOfDayNo12(ms: number): string {
  return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
}

/** 短日期（B-1 收敛，任务 190）：逐字等价 toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })。 */
export function formatDateShort(ms: number): string {
  return new Date(ms).toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
  });
}

/** 短时刻（B-1 收敛，任务 190）：逐字等价 toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })。 */
export function formatTimeShort(ms: number): string {
  return new Date(ms).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 文件大小 humanize：0/空/非数值 → ""，<1KB → B，<1MB → KB，否则 MB（无空格形态）。 */
export function formatSize(bytes?: unknown): string {
  const n = Number(bytes || 0);
  if (!n) return "";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** v0.5.0-beta.14.26（F3：工具开关成功横幅与终态不一致——旧版只按
 * field 分支不看 value，关工具仍显示「已启用」）：工具开关成功文案
 * 四分支纯函数（smoke 可测，scripts/toolToggle.smoke.mjs）——横幅
 * 必须与开关终态（enabled/asyncExecution × true/false）严格一致。 */
export function toolToggleMessage(
  tr: (key: string, vars?: Record<string, string>) => string,
  field: "enabled" | "asyncExecution",
  tool: string,
  enabled: boolean,
): string {
  if (field === "enabled") {
    return tr(enabled ? "{w} 已启用" : "{w} 已停用", { w: tool });
  }
  return tr(
    enabled ? "{w} 异步执行已启用" : "{w} 异步执行已停用",
    { w: tool },
  );
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
