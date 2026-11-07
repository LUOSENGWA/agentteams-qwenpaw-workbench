/** 聊天媒体灯箱的纯逻辑（无 React / 无 DOM 依赖）。
 *
 * 集中两件易漂移的规则：
 *  1. 「同一 turn 内连续图片」= 画廊序列的分组口径（collectGallery）；
 *  2. 缩放 / 平移 / 索引边界（clampZoom / clampPan / nextIndex / prevIndex）。
 * 组件（MediaViewer）只做渲染与指针/键盘事件，规则全部从这里取。
 */

/** 分组只看这几个字段——RoomMessage 的超集即可直接传入。 */
export interface GallerySourceMessage {
  event_id: string;
  sender: string;
  msgtype: string;
  url?: string;
  body?: string;
  filename?: string;
  mimetype?: string;
  redacted?: boolean;
}

export interface GalleryItem {
  /** 消息事件 id（灯箱内可回查是哪条消息）。 */
  eventId: string;
  /** 消息里的原始地址（mxc:// 或 http(s)://），由组件解析成可请求路径。 */
  url: string;
  name: string;
  mimetype?: string;
}

export interface PanOffset {
  x: number;
  y: number;
}

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4;
/** 滚轮/捏合每档缩放系数。 */
export const ZOOM_STEP = 1.15;
/** 双击放大到的倍数（1x ↔ 2x 切换）。 */
export const DOUBLE_CLICK_ZOOM = 2;

export function isImageMimetype(mimetype?: string): boolean {
  return typeof mimetype === "string" && mimetype.toLowerCase().startsWith("image/");
}

/** 能进灯箱的消息：m.image，或带 image/* 的 m.file（Worker 有时发文件而非图片）。
 * 撤回消息一律不参与（内容已不可取）。 */
export function isGalleryImage(msg: GallerySourceMessage): boolean {
  if (!msg.url || msg.redacted) return false;
  if (msg.msgtype === "m.image") return true;
  return msg.msgtype === "m.file" && isImageMimetype(msg.mimetype);
}

function toItem(msg: GallerySourceMessage): GalleryItem {
  return {
    eventId: msg.event_id,
    url: msg.url || "",
    name: msg.filename || msg.body || "",
    ...(msg.mimetype ? { mimetype: msg.mimetype } : {}),
  };
}

/**
 * 以 eventId 为锚点取连续图片序列。
 *
 * 规则：同 sender + 消息数组里严格相邻 + 都是图片（m.image / image 类 m.file）；
 * 任何其它消息（文本、工具、别的 sender）都打断序列。目标本身不是图片、
 * 找不到目标、或没有 url → null（调用方不打开灯箱）。
 */
export function collectGallery(
  messages: readonly GallerySourceMessage[],
  eventId: string,
): { items: GalleryItem[]; index: number } | null {
  const at = messages.findIndex((m) => m.event_id === eventId);
  if (at < 0) return null;
  const target = messages[at];
  if (!isGalleryImage(target)) return null;
  const sender = target.sender;
  let lo = at;
  while (lo > 0 && messages[lo - 1].sender === sender && isGalleryImage(messages[lo - 1])) {
    lo -= 1;
  }
  let hi = at;
  while (
    hi + 1 < messages.length &&
    messages[hi + 1].sender === sender &&
    isGalleryImage(messages[hi + 1])
  ) {
    hi += 1;
  }
  return {
    items: messages.slice(lo, hi + 1).map(toItem),
    index: at - lo,
  };
}

/** 缩放夹取到 0.5x–4x；非法值（NaN/0/负）回 1x。 */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/** 下一张（不循环：末张保持末张，按钮侧按同样规则置灰）。 */
export function nextIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(length - 1, Math.max(0, index + 1));
}

/** 上一张（不循环：首张保持首张）。 */
export function prevIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, index - 1));
}

/**
 * 平移夹取：缩放为 1x 时不允许平移；放大后按可视区尺寸限制越界
 * （拖拽超界在抬手时经本函数回弹）。
 */
export function clampPan(
  pan: PanOffset,
  zoom: number,
  viewWidth: number,
  viewHeight: number,
): PanOffset {
  const z = clampZoom(zoom);
  const maxX = Math.max(0, (viewWidth * (z - 1)) / 2);
  const maxY = Math.max(0, (viewHeight * (z - 1)) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, pan.x)),
    y: Math.min(maxY, Math.max(-maxY, pan.y)),
  };
}

export type MediaKind = "image" | "video" | "audio" | "file";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "avif"]);
const VIDEO_EXT = new Set(["mp4", "webm", "mov", "m4v", "ogv", "mkv"]);
const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "m4a", "aac", "flac", "opus"]);

function extOf(name: string): string {
  const base = name.split(/[?#]/)[0];
  const i = base.lastIndexOf(".");
  return i >= 0 ? base.slice(i + 1).toLowerCase() : "";
}

/**
 * 媒体大类判定（消息渲染分派 + 附件卡图标共用）：
 * mimetype 优先，缺 mimetype 时看 msgtype，再看文件名扩展名。
 */
export function mediaKindOf(msg: {
  msgtype?: string;
  mimetype?: string;
  filename?: string;
  body?: string;
}): MediaKind {
  const mime = (msg.mimetype || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (msg.msgtype === "m.image") return "image";
  if (msg.msgtype === "m.video") return "video";
  if (msg.msgtype === "m.audio") return "audio";
  const ext = extOf(msg.filename || msg.body || "");
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  return "file";
}
