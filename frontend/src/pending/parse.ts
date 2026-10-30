// P0 人工介入闭环 — 解析层（任务书 §3 Stage 1；纯函数，node 可直测）。
// ① parseAttentionMessage：` @mxid ATTENTION_KIND: task_id - question`
//    首行识别（kind 取原始大写值）；
// ② parseOptions：移植 agentteams-dashboard intervention-heuristic 的
//    选项识别（数字 1）/1. 、字母 A. 、圈号 ①②；从 1 连续递增、
//    数字≤9 / 字母≤6、代码块行不参与）——选项 id 用裸值（"1"/"A"/"①"，
//    非 dashboard 的 "opt-N" 前缀）；
// ③ classifyMentions：m.mentions.user_ids 含当前用户 → @我（当前用户 id
//    由调用方从 config.matrix.user_id 传入——不硬编码个人 mxid）；
// ④ 答复识别（self-resolve）：【干预答复】/ /approve / 拒绝 等关键词
//    （hitl-inbox 口径）+ 关联目标选择（in_reply_to / m.reference 优先，
//    绝不用 m.thread 当答复证据——任务书 §5）。

import type { PendingItem, PendingOption } from "./types";

// ── ① ATTENTION 消息 ──────────────────────────────────────────────

export interface AttentionParseResult {
  /** 原始 kind（大写：APPROVAL / INTERVENTION / DECISION / ...）。 */
  kind: string;
  taskId: string;
  question: string;
}

// 首行形态：` @mxid ATTENTION_KIND: task_id - question`（bridge 统一拼
// 「空格 + @提及」前缀；task_id 无空格；question 可跨行）。
const ATTENTION_RE = /^ @?\S*\s*ATTENTION_([A-Z_]+):\s*(\S+)\s*-\s*([\s\S]+)$/;

export function parseAttentionMessage(
  body: string | null | undefined,
): AttentionParseResult | null {
  if (!body) return null;
  const m = ATTENTION_RE.exec(body);
  if (!m) return null;
  return { kind: m[1], taskId: m[2], question: m[3].trim() };
}

/** 待处理 kind 口径（attention 30s 轮询与房间消息同一规则）：
 * 有 question = 干预（要人判断内容），无 question = 审批（二态裁决）。 */
export function attentionPendingKind(
  question: string | null | undefined,
): "intervention" | "approval" {
  return question ? "intervention" : "approval";
}

// ── ② 选项识别（intervention-heuristic 移植，裸 id）────────────────

const SEP_CLASS = "[）).、:：=＝\\-–—|｜→]";
const DIGIT_MARKER = String.raw`(?:[（(\[【]\s*(\d{1,2})\s*[）)\]】]|(?:选项\s*)?(\d{1,2})\s*${SEP_CLASS})`;
const ALPHA_MARKER = String.raw`(?:[（(\[【]\s*([A-Fa-f])\s*[）)\]】]|(?:选项\s*)?([A-Fa-f])\s*${SEP_CLASS})`;
const DIGIT_OPTION_RE = new RegExp(String.raw`^\s*${DIGIT_MARKER}\s*(.+?)\s*$`);
const ALPHA_OPTION_RE = new RegExp(String.raw`^\s*${ALPHA_MARKER}\s*(.+?)\s*$`);
// 列表 bullet + 粗体剥掉后的「A 尾焰特效」空格形态（仅限大写，防吞普通散文）。
const ALPHA_SPACE_OPTION_RE = /^\s*([A-F])\s+(\S.*?)\s*$/;
const DIGIT_INLINE_RE = new RegExp(
  String.raw`(?:[（(\[【]\s*(\d{1,2})\s*[）)\]】]|(?:^|\s)(?:选项\s*)?(\d{1,2})\s*${SEP_CLASS})\s*`,
  "g",
);
const ALPHA_INLINE_RE = new RegExp(
  String.raw`(?:[（(\[【]\s*([A-Fa-f])\s*[）)\]】]|(?:^|\s)(?:选项\s*)?([A-Fa-f])\s*${SEP_CLASS})\s*`,
  "g",
);
const ALPHA_INDEX = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CIRCLED_INDEX = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
const CIRCLED_RE = /[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]/g;

/** 剥行内 Markdown 装饰（`**页面类型**：` / `### 头` / `- 前缀`）。 */
function stripInlineMarkdown(line: string): string {
  return line
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/`/g, "")
    .trim();
}

/** 代码块（``` 围栏）与引用行置空——行号保持不变（防行号错位）。 */
function stripNonContent(body: string): string[] {
  const lines = body.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      out.push("");
      continue;
    }
    out.push(inFence || trimmed.startsWith(">") ? "" : line);
  }
  return out;
}

interface OptionMatch {
  id: string;
  label: string;
  seq: number;
}

function matchOption(
  line: string,
  kind: "digit" | "alpha",
): OptionMatch | null {
  const text = stripInlineMarkdown(line);
  if (!text) return null;
  const re = kind === "digit" ? DIGIT_OPTION_RE : ALPHA_OPTION_RE;
  const m = re.exec(text);
  if (!m) {
    if (kind !== "alpha") return null;
    const space = ALPHA_SPACE_OPTION_RE.exec(text);
    if (!space) return null;
    return { id: space[1], label: space[2], seq: ALPHA_INDEX.indexOf(space[1]) + 1 };
  }
  const raw = m[1] ?? m[2];
  if (!raw) return null;
  if (kind === "digit") return { id: raw, label: m[3], seq: Number(raw) };
  const upper = raw.toUpperCase();
  return { id: upper, label: m[3], seq: ALPHA_INDEX.indexOf(upper) + 1 };
}

/** 整行多选项（`1）甲 2）乙` / `A. 甲 B. 乙`，/ 或空格分隔压一行）。 */
function parseInlineLine(
  line: string,
  kind: "digit" | "alpha",
): PendingOption[] | null {
  const t = stripInlineMarkdown(line);
  if (!t) return null;
  const re = kind === "digit" ? DIGIT_INLINE_RE : ALPHA_INLINE_RE;
  re.lastIndex = 0;
  const matches = [...t.matchAll(re)];
  if (matches.length < 2 || (matches[0].index ?? 0) !== 0) return null;
  const maxItems = kind === "digit" ? 9 : 6;
  const items: PendingOption[] = [];
  for (let i = 0; i < matches.length && i < maxItems; i += 1) {
    const raw = matches[i][1] ?? matches[i][2];
    const seq = kind === "digit" ? Number(raw) : ALPHA_INDEX.indexOf(raw.toUpperCase()) + 1;
    if (seq !== i + 1) return null;
    const labelStart = (matches[i].index ?? 0) + matches[i][0].length;
    const labelEnd = i + 1 < matches.length ? (matches[i + 1].index ?? t.length) : t.length;
    // 分隔符（/ 与 | 等）不属 label。
    const label = t.slice(labelStart, labelEnd).replace(/[／/|｜;；]\s*$/, "").trim();
    if (!label) return null;
    items.push({ id: kind === "digit" ? raw : raw.toUpperCase(), label });
  }
  return items;
}

/** 圈号行（① A ② B …，多选常见）：必须从 ① 起连续。 */
function parseCircledLine(line: string): PendingOption[] | null {
  const t = stripInlineMarkdown(line);
  if (!t) return null;
  const matches = [...t.matchAll(CIRCLED_RE)];
  if (matches.length < 2 || (matches[0].index ?? 0) !== 0) return null;
  const items: PendingOption[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const marker = matches[i][0];
    if (CIRCLED_INDEX.indexOf(marker) !== i) return null;
    const labelStart = (matches[i].index ?? 0) + marker.length;
    const labelEnd = i + 1 < matches.length ? (matches[i + 1].index ?? t.length) : t.length;
    const label = t.slice(labelStart, labelEnd).trim();
    if (!label) return null;
    items.push({ id: marker, label });
  }
  return items;
}

/** 问题文本 → 选项组（数字轮 → 字母轮 → 整行 → 圈号；无 → undefined）。 */
export function parseOptions(
  question: string | null | undefined,
): PendingOption[] | undefined {
  if (!question || !question.trim()) return undefined;
  const lines = stripNonContent(question);

  // 分行连续组（须从 1 起连续递增；块内允许一个空行）。
  for (const kind of ["digit", "alpha"] as const) {
    const maxItems = kind === "digit" ? 9 : 6;
    for (let i = 0; i < lines.length; i += 1) {
      const first = matchOption(lines[i] ?? "", kind);
      if (!first || first.seq !== 1) continue;
      const items: PendingOption[] = [];
      let cursor = i;
      let expected = first.seq;
      let blankGap = false;
      while (cursor < lines.length) {
        const trimmed = (lines[cursor] ?? "").trim();
        if (!trimmed) {
          if (blankGap) break;
          blankGap = true;
          cursor += 1;
          continue;
        }
        const m = matchOption(lines[cursor] ?? "", kind);
        if (!m || m.seq !== expected) break;
        items.push({ id: m.id, label: m.label });
        expected += 1;
        blankGap = false;
        cursor += 1;
        if (items.length >= maxItems) break;
      }
      if (items.length >= 2) return items;
      i = Math.max(cursor, i + 1) - 1;
    }
  }

  // 整行多选项（`1）甲 2）乙` 压一行）。
  for (let i = 0; i < lines.length; i += 1) {
    for (const kind of ["digit", "alpha"] as const) {
      const items = parseInlineLine(lines[i] ?? "", kind);
      if (items) return items;
    }
  }

  // 圈号行（① A ② B）。
  for (let i = 0; i < lines.length; i += 1) {
    const items = parseCircledLine(lines[i] ?? "");
    if (items) return items;
  }

  return undefined;
}

/** 多选语义（「（多选）」「可多选」）——PendingItem.multiSelect 填值。 */
export function detectMultiSelect(question: string | null | undefined): boolean {
  return Boolean(question && /多选|可多选|多项选择/.test(question));
}

// ── ③ @我 判定 ────────────────────────────────────────────────────

/** m.mentions.user_ids 含当前用户 → 命中（content 为 Matrix 原始
 * content 形态；无 m.mentions 的极简载荷 → false，不误报）。 */
export function classifyMentions(
  content: { "m.mentions"?: { user_ids?: string[] } } | null | undefined,
  myUserId: string,
): boolean {
  if (!content || !myUserId) return false;
  const ids = content["m.mentions"]?.user_ids;
  return Array.isArray(ids) && ids.indexOf(myUserId) >= 0;
}

// ── ④ 答复识别（self-resolve）─────────────────────────────────────

const APPROVE_KEYWORDS = new Set([
  "/approve",
  "approve",
  "approved",
  "同意",
  "批准",
  "允许",
]);
const REJECT_KEYWORDS = new Set([
  "/deny",
  "deny",
  "denied",
  "/reject",
  "reject",
  "rejected",
  "拒绝",
  "驳回",
  "不允许",
]);
const INTERVENTION_REPLY_MARKER = "【干预答复】";

/** 剥开头发起的 @提及前缀（worker 房间答复自动带 @worker，不剥则
 * /approve 与干预答复都匹配不到）。 */
export function stripLeadingMentions(body: string): string {
  let text = body.trim();
  const mention = /^@[^\s:]+(?::[^\s]+)?\s*/;
  let guard = 0;
  while (mention.test(text) && guard < 8) {
    text = text.replace(mention, "");
    guard += 1;
  }
  return text;
}

export type HitlResolutionKind = "intervention" | "verdict";

/** 答复语义：【干预答复】前缀 = 干预答复；approve/reject 关键词集
 * （大小写不敏感）= 裁决；其余 = null（不是答复）。 */
export function hitlResolutionKind(body: string): HitlResolutionKind | null {
  if (!body) return null;
  const text = stripLeadingMentions(body).toLowerCase();
  if (text.startsWith(INTERVENTION_REPLY_MARKER)) return "intervention";
  if (APPROVE_KEYWORDS.has(text) || REJECT_KEYWORDS.has(text)) return "verdict";
  return null;
}

/**
 * 答复目标选择（resolveRoomReply 纯函数版，RoomChatCore 自解决用）：
 * - 显式关联（in_reply_to / m.reference 的 eventId）→ 只认该卡，不猜；
 * - 无关联 → 同房间同类池：干预答复只对应带 question 的项（无则放弃，
 *   不误伤裁决项）；裁决优先无 question 项，找不到才回退全部待办
 *   （单条待办场景）；池内取最旧一条。
 * 绝不用 m.thread 当关联证据（任务书 §5——线程是结构性关系，
 * 所有回复都指向根，不构成「答复了根卡片」的证据）。
 */
export function resolveRoomReplyTarget(
  items: PendingItem[],
  roomId: string,
  body: string,
  relatedEventId?: string,
): string | null {
  const kind = hitlResolutionKind(body);
  if (!kind || !roomId) return null;
  const inRoom = items.filter((it) => it.roomId === roomId);
  if (relatedEventId) {
    const linked = inRoom.find((it) => it.eventId === relatedEventId);
    return linked ? linked.id : null;
  }
  const sameKind = inRoom.filter((it) =>
    kind === "intervention" ? Boolean(it.question) : !it.question,
  );
  if (kind === "intervention" && sameKind.length === 0) return null;
  const pool = sameKind.length > 0 ? sameKind : inRoom;
  if (pool.length === 0) return null;
  pool.sort((a, b) => a.createdAt - b.createdAt);
  return pool[0].id;
}
