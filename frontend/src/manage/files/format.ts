/**
 * format.ts — 文件管理模块共享格式化工具（F-V3-3 自 TrashPanel.tsx 迁出——
 * TrashPanel 删除后，FilesSection 与 SyncSettingsModal 共用这一份）。
 * 无 React / 宿主依赖，可独立单测。
 */

/** 触控目标常量（与 FilesSection 的 touchCss 变量同源）。 */
export const TOUCH = {
  rowMinHeight: 44,
  btnMinSize: 40,
  btnPadding: 8,
  iconGap: 8,
  coarseScale: 1.1,
} as const;

/** antd.Button 最小触控盒（CSS 变量由 FilesSection touchCss 注入；coarse 指针自动放大）。
 * 唯一实现——各文件子面板从此导入，禁止各自复制一份。 */
export const BTN_TOUCH = { minHeight: "var(--hf-btn-min, 40px)" } as const;

/** 可读文件大小（B / KB / MB / GB；缺失 → "—"）。 */
export function fmtBytes(n: number | undefined | null): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** 可读时间（"YYYY-MM-DD HH:mm"；缺失/非法 → ""——F-V3-3：不再显示 "—"）。 */
export function fmtTs(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 回收站路径展示：去掉 "files/" 前缀（列表/弹窗同一口径）。 */
export function normTrashPath(p: string): string {
  return p.startsWith("files/") ? p.slice("files/".length) : p;
}
