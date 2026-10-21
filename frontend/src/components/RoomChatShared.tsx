import {
  type RoomMessage,
  type TeamMember,
  type TeamRoom,
  type WorkerLoopStatus,
} from "../api";

// 消息渲染窗上限（顶层消息条数）：长房间/长滚动会话的 DOM 与重渲成本
// 封顶——超出部分由顶部「显示更早」揭示（本地放出，无网络往返）。
// 与历史分页（每页 50 条）独立：窗口管「已载消息渲染多少」，分页管
// 「从服务端拉多少」。
export const MSG_WINDOW_LIMIT = 150;

// ── UI 常量（与 WorkbenchPage 视觉一致）──────────────────────────────
export const PRIMARY = "var(--app-accent, #FF7F16)"; // 品牌主色

/** 纯触屏设备（无 hover 能力）：hover 操作条改 tap 切换（T5）。
 * 模块级一次求值——设备指针类型在会话内不变。 */
export const TOUCH_ONLY =
  typeof window !== "undefined" &&
  !!window.matchMedia &&
  window.matchMedia("(hover: none)").matches;

// 自己的消息气泡浅橙背景：改用主题（useThemeColors().bubbleMine）
export const CARD_RADIUS = 10;

/** Agent 工具消息（QwenPaw renderer 格式）：
 * - 工具调用：`🔧 **name**` + args 代码块
 * - 工具输出：`✅ **name**:` + 结果内容（read_file 的文件内容贴这里）
 * - 失败：`❌ **name**:`（保险）
 * 折叠识别只认前缀 emoji + 工具名模式，避免误伤普通消息。 */
export const TOOL_MSG_RE =
  /^\s*(?:[^\n:]{1,80}:\s*)?(?:🔧|✅|❌)\s*(?:\*\*)?[A-Za-z0-9_.-]+/;

export function isToolMessage(body: string): boolean {
  return TOOL_MSG_RE.test(body || "");
}

/** 从工具消息里提取工具名（🔧 **name** / ✅ **name**:）。 */
export function toolNameOf(body: string): string {
  const m = /(?:🔧|✅|❌)\s*(?:\*\*)?([A-Za-z0-9_.-]+)/.exec(body || "");
  return m ? m[1] : "";
}

/** 常用快捷表情（Element 同款交互：hover 消息 → 快捷反应）。 */
export const QUICK_REACTIONS = ["👍", "❤️", "😄", "🎉", "👀", "✅"];

/** 发送者短名：优先成员 display_name，否则取 MXID 的 localpart。 */
export function senderShortName(mxid: string, room: TeamRoom | null): string {
  const member: TeamMember | undefined = room?.members?.[mxid];
  if (member?.display_name && member.display_name.trim()) {
    return member.display_name;
  }
  const localpart = (mxid.split(":")[0] || mxid).replace(/^@/, "");
  return localpart || mxid;
}

/** origin_server_ts（毫秒）→ 本地时区 HH:mm。 */
export function formatTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** 日期分隔符标签：今天/昨天/近 6 天周几/具体日期（Element 同款四级）。 */
export function dateLabel(ts: number, tr: (s: string, vars?: Record<string, string | number>) => string): string {
  const d = new Date(ts);
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round(
    (startOfDay(new Date()) - startOfDay(d)) / 86400000,
  );
  if (diff === 0) return tr("今天");
  if (diff === 1) return tr("昨天");
  if (diff > 1 && diff < 6) {
    return tr(["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()]);
  }
  return tr("{y}年{m}月{d}日", {
    y: d.getFullYear(),
    m: d.getMonth() + 1,
    d: d.getDate(),
  });
}

/** 时间分组规则（Element：>24h 或跨本地午夜插分隔符；组首强制插）。 */
export function wantsDateSeparator(prev: RoomMessage | null, cur: RoomMessage): boolean {
  if (!prev) return true;
  const dp = new Date(prev.origin_server_ts);
  const dc = new Date(cur.origin_server_ts);
  if (Math.abs(dc.getTime() - dp.getTime()) > 24 * 3600 * 1000) return true;
  return dp.getDay() !== dc.getDay();
}

/** 审批通知识别：QwenPaw 2.x「🛡️ Approval Required」/ 旧版「⏳ Waiting for approval」。 */
export function parseApproval(
  body: string,
): { approveCmd: string; denyCmd: string } | null {
  if (body.includes("🛡️") && body.includes("Approval Required")) {
    return { approveCmd: "/approval approve", denyCmd: "/approval deny" };
  }
  if (body.includes("⏳") && body.includes("Waiting for approval")) {
    // 旧版语义：/approve 批准，任意其他消息=拒绝（发「拒绝」最明确）。
    return { approveCmd: "/approve", denyCmd: "拒绝" };
  }
  return null;
}

/** loop 状态语义相等（引用稳定化用）——
 * 15s 轮询每轮拿到全新对象，state+mode 未变时须保留旧引用避免击穿 memo。 */
export function sameLoopStatus(
  a: WorkerLoopStatus | null,
  b: WorkerLoopStatus | null,
): boolean {
  if (!a || !b) return a === b;
  return (
    a.state === b.state &&
    JSON.stringify(a.mode ?? null) === JSON.stringify(b.mode ?? null)
  );
}
