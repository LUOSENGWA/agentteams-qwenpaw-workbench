/** TeamOverview 子模块——自 TeamOverview.tsx 纯搬移拆出
 * （行为零变化）。 */
import type { TeamMember, TeamRoom } from "../api";

const host = window.QwenPaw.host;
const React = host.React;

// ── UI 常量（与 WorkbenchPage 视觉一致）──────────────────────────────
export const PRIMARY = "var(--app-accent, #FF7F16)"; // 品牌主色
export const GREEN = "#52c41a"; // 状态绿（DM 标签）
export const FAV_KEY = "agentteams-qwenpaw-workbench:favorites";
// 排序偏好
// 客户端本地持久化（与收藏同一思路——Element 房间排序存客户端本地）。
export const SORT_KEY = "agentteams-qwenpaw-workbench:room-sort";
export const CARD_RADIUS = 10; // 卡片圆角

/** 成员显示名：优先 display_name，否则取 MXID 的 localpart（@ 前段）。 */
export function memberShortName(mxid: string, member?: TeamMember): string {
  if (member?.display_name && member.display_name.trim()) {
    return member.display_name;
  }
  const localpart = (mxid.split(":")[0] || mxid).replace(/^@/, "");
  return localpart || mxid;
}

/** ：
 * 原实现=名称行内灰色胶囊（占宽、挤名字）。改为返回徽章参数，由卡片
 * 头像外层 UnreadBubble 渲染（头像右上角，Element 同款；13.24 自绘
 * 居中+含住）。红=highlight（@我/提及），灰=普通未读；都 0 = null。 */
export function unreadBadgeOf(
  room: TeamRoom,
): { count: number; color: string } | null {
  const hl = room.unread_highlight || 0;
  const un = room.unread || 0;
  if (hl > 0) return { count: hl, color: "#f5222d" };
  if (un > 0) return { count: un, color: "#bfbfbf" };
  return null;
}

/** ：自绘
 * 未读气泡替代 antd.Badge——antd 默认胶囊在窄字宽/自定义色下数字偏心
 * 且 3 位数+overflowCount 时溢出气泡边缘。本组件 flex 双向居中 +
 * min-width 16/padding 0 4（气泡随内容长宽自适应，永不溢出）+ 1.5px
 * 白描边环（卡片底色上对比清晰，Element 同款观感）。
 * 用法：头像外套 <div style={{position:"relative"}}>，气泡 absolute
 * 挂右上角（top:-6/right:-6，13.21 的头像角标位置语义）。 */
export function UnreadBubble({ count, color }: { count: number; color: string }) {
  const label = count > 99 ? "99+" : String(count);
  return (
    <span
      style={{
        position: "absolute",
        top: -6,
        right: -6,
        minWidth: 16,
        height: 16,
        padding: "0 4px",
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 8,
        backgroundColor: color,
        border: "1.5px solid rgba(255,255,255,0.92)",
        fontSize: 10,
        lineHeight: 1,
        fontWeight: 600,
        color: "#fff",
        whiteSpace: "nowrap",
        pointerEvents: "none",
      }}
    >
      {label}
    </span>
  );
}

/* 。
 72 字截断 + 媒体标记（图片 🖼 / 文件 📎，按扩展名判定；后端 last_body
 已含 m.image/m.file 的 body=文件名）。 */
const MEDIA_IMG_RE = /\.(png|jpe?g|gif|webp|heic|bmp|svg)$/i;
const MEDIA_FILE_RE =
  /\.(pdf|docx?|xlsx?|pptx?|zip|tar|gz|7z|rar|mp4|mov|mkv|avi|mp3|wav|m4a|csv|json|log|txt)$/i;
export function lastBodyPreview(
  body?: string,
): { text: string; marker: "img" | "file" | null } | null {
  const b = (body || "").replace(/\s+/g, " ").trim();
  if (!b) return null;
  const marker = MEDIA_IMG_RE.test(b) ? "img" : MEDIA_FILE_RE.test(b) ? "file" : null;
  return { text: b.length > 72 ? b.slice(0, 72) + "…" : b, marker };
}
