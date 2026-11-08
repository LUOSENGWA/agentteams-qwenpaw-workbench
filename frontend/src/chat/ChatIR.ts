/**
 * ChatIR：聊天回合（turn）中间表示 + 组装逻辑。
 *
 * 纯逻辑模块——零宿主/React/antd 依赖，node 可直测
 * （见 state/chatir-selftest.mjs，批次 3 验收门 4）。
 *
 * 回合规则（批次 3 任务书 + 第二批对齐 dashboard）：
 * - 同一 sender 的连续消息 = 一个 turn；
 * - sender 切换 = 新 turn；
 * - 同 sender 但静默超过 TURN_MAX_GAP_MS（10 分钟）或跨本地日 = 新 turn
 *   （dashboard AgentTurnGrouper 的 TURN_MAX_GAP_MS 同口径）；
 * - 消息携带的 toolCalls（工具帧）吸收进 turn.toolCalls（过程条数据源），
 *   同时保留在 turn.messages 原序（渲染层决定工具帧是否独立成行）。
 */
import { isToolMessage } from "../components/RoomChatShared";
import type {
  RunBlock,
  RunBlockConfirmation,
  RunBlockError,
  RunBlockToolCall,
} from "../api";

/** 单次工具调用（一条工具帧 = 一个 ToolCall）。 */
export interface ToolCall {
  /** 来源帧 event id（溯源/去重）。 */
  id?: string;
  /** 工具名（🔧 **name** / ✅ **name**:/ ❌ **name**:）。 */
  name: string;
  /** 首行之后的内容预览（参数/结果摘要，≤80 字符）。 */
  argsSummary?: string;
  /** 帧完整正文（展开详情用）。 */
  detail?: string;
  status: "call" | "ok" | "fail";
  /** 帧 origin_server_ts（毫秒）。 */
  ts?: number;
}

/** 聊天消息 IR（渲染数据源与 RoomMessage 解耦的最小面）。 */
export interface ChatMessage {
  id: string;
  sender: string;
  ts: number;
  body: string;
  /** 消息类型（m.text/m.image/...）；非文本帧 body 可空。 */
  type?: string;
  /** 非空 = 工具帧；buildTurns 将其吸收进 turn.toolCalls。 */
  toolCalls?: ToolCall[];
  /** 结构化运行时块（org.agentteams.run）；非空时优先于 body 启发式。 */
  runBlocks?: RunBlock[];
  /** 乐观回显未确认（流式/发送中）。 */
  pending?: boolean;
}

export type TurnStatus = "active" | "done" | "failed";

/** 一个 turn：同 sender 连续消息 + 其触发的工具调用。 */
export interface Turn {
  /** = 本 turn 首条消息 id（稳定 DOM 锚 data-turn-id）。 */
  id: string;
  sender: string;
  /** = 本 turn 首条消息 ts。 */
  startTime: number;
  /** 本 turn 全部消息（原序，含工具帧）。 */
  messages: ChatMessage[];
  /** 本 turn 吸收的全部工具调用（原序）。 */
  toolCalls: ToolCall[];
  status: TurnStatus;
}

/** worker turn 的最大静默间隔：超过 = 新 turn（dashboard TURN_MAX_GAP_MS）。 */
export const TURN_MAX_GAP_MS = 10 * 60 * 1000;

/** 同发送者续行（隐藏头像/名字）的最大间隔（dashboard MainGrouper 同口径）。 */
export const CONTINUATION_MAX_INTERVAL_MS = 5 * 60 * 1000;

/** 本地日边界（毫秒）——跨本地午夜 = 新 turn / 断续行。 */
function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 是否同一本地日（跨天必须断 turn / 断续行）。 */
export function sameLocalDay(a: number, b: number): boolean {
  return startOfLocalDay(a) === startOfLocalDay(b);
}

/**
 * 消息流 → turn 序列。
 * - 连续同 sender 归入同一 turn（首条消息定 id/startTime）；
 * - sender 切换开新 turn；
 * - 同 sender 但距上一条 > TURN_MAX_GAP_MS（10 分钟）或跨本地日 → 新 turn；
 * - 工具帧的 toolCalls 吸收进 turn.toolCalls；
 * - status：任一工具调用失败 = "failed"；
 *   末次工具调用无结果 或 末条消息 pending = "active"；否则 "done"。
 * 空输入返回空数组；不修改入参。
 */
export function buildTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const m of messages) {
    const prevMsg = cur && cur.messages.length > 0 ? cur.messages[cur.messages.length - 1] : null;
    const gapBreak =
      prevMsg !== null &&
      (m.ts - prevMsg.ts > TURN_MAX_GAP_MS || !sameLocalDay(prevMsg.ts, m.ts));
    if (!cur || cur.sender !== m.sender || gapBreak) {
      cur = {
        id: m.id,
        sender: m.sender,
        startTime: m.ts,
        messages: [],
        toolCalls: [],
        status: "done",
      };
      turns.push(cur);
    }
    cur.messages.push(m);
    if (m.toolCalls && m.toolCalls.length > 0) {
      cur.toolCalls.push(...m.toolCalls);
    }
  }
  for (const turn of turns) {
    let status: TurnStatus = "done";
    if (turn.toolCalls.some((c) => c.status === "fail")) {
      status = "failed";
    } else {
      const lastCall =
        turn.toolCalls.length > 0
          ? turn.toolCalls[turn.toolCalls.length - 1]
          : null;
      const lastMsg =
        turn.messages.length > 0
          ? turn.messages[turn.messages.length - 1]
          : null;
      if ((lastCall && lastCall.status === "call") || (lastMsg && lastMsg.pending)) {
        status = "active";
      }
    }
    turn.status = status;
  }
  return turns;
}

// ── 续行分组（dashboard MainGrouper 同口径）────────────────────────
//
// 同发送者连续消息在「≤5 分钟 + 同一本地日 + 同一 msgtype 族」时隐藏
// 头像/名字（续行），否则重新起组头。RoomMessage（origin_server_ts/
// msgtype）与 ChatMessage（ts/type）两种字段口径都接受。

/** 续行判定可用的最小消息面（RoomMessage / ChatMessage 皆可）。 */
export interface GroupableMessage {
  sender: string;
  /** ChatMessage 口径（毫秒）。 */
  ts?: number;
  /** RoomMessage 口径（毫秒）。 */
  origin_server_ts?: number;
  /** RoomMessage 的 msgtype。 */
  msgtype?: string;
  /** ChatMessage 的 msgtype 别名。 */
  type?: string;
  body?: string;
  toolCalls?: ToolCall[];
}

function tsOf(msg: GroupableMessage): number | null {
  if (typeof msg.ts === "number") return msg.ts;
  if (typeof msg.origin_server_ts === "number") return msg.origin_server_ts;
  return null;
}

/** msgtype 族：text/notice 同族；媒体、文件、工具各自独立。 */
export function messageFamily(msg: GroupableMessage): string {
  if (msg.toolCalls && msg.toolCalls.length > 0) return "tool";
  // 工具帧本身是 m.text（body 前缀 🔧/✅/❌）——族判定必须先于 msgtype。
  if (isToolMessage(msg.body ?? "")) return "tool";
  const type = msg.type ?? msg.msgtype ?? "";
  if (type === "m.text" || type === "m.notice") return "text";
  if (type === "m.image" || type === "m.video" || type === "m.audio") return "media";
  if (type === "m.file" || type === "m.file_info") return "file";
  return type || "unknown";
}

/**
 * 是否续行（隐藏头像/名字）：sameSender && 间隔 ≤ 5 分钟 && 同日 && 同族。
 * 无上一条 → false（组首）；缺 ts → false（无法判定按新组处理）。
 */
export function shouldContinueGroup(
  prev: GroupableMessage | null | undefined,
  cur: GroupableMessage,
  opts?: { maxIntervalMs?: number },
): boolean {
  if (!prev) return false;
  if (prev.sender !== cur.sender) return false;
  const prevTs = tsOf(prev);
  const curTs = tsOf(cur);
  if (prevTs === null || curTs === null) return false;
  const maxInterval = opts?.maxIntervalMs ?? CONTINUATION_MAX_INTERVAL_MS;
  if (curTs - prevTs > maxInterval) return false;
  if (!sameLocalDay(prevTs, curTs)) return false;
  return messageFamily(prev) === messageFamily(cur);
}

// ── turn 拆分（渲染顺序：header → 过程条 → 回答行）──────────────────

/** 一个 turn 的分段：思考帧 / 工具调用 / 回答帧 / 结构化待办（原序）。 */
export interface SplitTurn {
  /** 思考过程帧（isThinkingNotice 或 thinking 块；渲染为过程条折叠区文本）。 */
  thoughts: ChatMessage[];
  /** 工具调用（turn.toolCalls 或 tool_call 块，过程条数据源）。 */
  calls: ToolCall[];
  /** 回答帧（思考/工具之外的其余消息，含审批卡等独立 tile）。 */
  answers: ChatMessage[];
  /** confirmation 块（只读审批卡片，不折进过程条；按 Matrix 回复审批）。 */
  confirmations: RunBlockConfirmation[];
  /** error 块（run 结束哨兵，一行状态条）。 */
  errors: RunBlockError[];
}

/** 块内参数/结果 → JSON 文本（字符串原样；不可序列化退 String）。 */
function jsonText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    const s = JSON.stringify(value);
    return s === undefined ? String(value) : s;
  } catch {
    return String(value);
  }
}

/** tool_call 块 → 过程条 ToolCall（status 四态映射到 call/ok/fail）。 */
function toolCallFromRunBlock(
  block: RunBlockToolCall,
  msg: ChatMessage,
): ToolCall {
  const argsJson = jsonText(block.arguments);
  const resultJson = block.result === undefined ? "" : jsonText(block.result);
  const detail = [argsJson, resultJson].filter((s) => s.length > 0).join("\n");
  return {
    id: block.tool_call_id || msg.id,
    name: block.tool_name,
    argsSummary: argsJson ? argsJson.slice(0, 80) : undefined,
    detail: detail || undefined,
    status:
      block.status === "succeeded"
        ? "ok"
        : block.status === "failed"
          ? "fail"
          : "call",
    ts: block.started_at ?? msg.ts,
  };
}

/**
 * 结构化块的可见文本（text 块拼接）；无 text 块 → null。
 * 有 text 块时渲染层用它替代 body（不重复渲染原正文）。
 */
export function runBlockText(blocks: RunBlock[] | undefined): string | null {
  if (!blocks || blocks.length === 0) return null;
  const texts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") texts.push(block.text);
  }
  return texts.length > 0 ? texts.join("\n\n") : null;
}

/**
 * turn → { thoughts, calls, answers, confirmations, errors }。
 * - 消息带 runBlocks（非空）时结构化优先：
 *   thinking → thoughts（strip 无需前缀）、tool_call → calls、
 *   text → answers（块文本替代 body）、confirmation/error → 独立列表；
 *   该消息不再走 body 启发式（不重复解析正文）；
 * - 无 runBlocks 时沿用既有启发式：思考判定复用 isThinkingNotice
 *   （mine / worker 表由调用方给，缺省保守：只有带 thinking 前缀的 notice
 *   算思考）；工具帧复用 isToolMessage（toolCalls 已由 buildTurns 吸收）；
 * - 其余（含审批卡/交付卡）→ answers；不修改入参。
 */
export function splitTurn(
  turn: Turn,
  opts?: {
    isMine?: (msg: ChatMessage) => boolean;
    workerMxids?: Record<string, unknown>;
  },
): SplitTurn {
  const workerMxids = opts?.workerMxids ?? {};
  const isMine = opts?.isMine;
  const thoughts: ChatMessage[] = [];
  const answers: ChatMessage[] = [];
  const calls: ToolCall[] = [];
  const confirmations: RunBlockConfirmation[] = [];
  const errors: RunBlockError[] = [];
  for (const msg of turn.messages) {
    const blocks = msg.runBlocks;
    if (blocks && blocks.length > 0) {
      const texts: string[] = [];
      for (let i = 0; i < blocks.length; i += 1) {
        const block = blocks[i];
        if (block.type === "thinking") {
          thoughts.push({
            id: `${msg.id}:thinking:${i}`,
            sender: msg.sender,
            ts: msg.ts,
            body: block.content,
            type: "m.notice",
          });
        } else if (block.type === "tool_call") {
          calls.push(toolCallFromRunBlock(block, msg));
        } else if (block.type === "text") {
          texts.push(block.text);
        } else if (block.type === "confirmation") {
          confirmations.push(block);
        } else if (block.type === "error") {
          errors.push(block);
        }
      }
      if (texts.length > 0) {
        answers.push({
          id: msg.id,
          sender: msg.sender,
          ts: msg.ts,
          body: texts.join("\n\n"),
          type: "m.text",
        });
      }
      continue;
    }
    if (msg.toolCalls && msg.toolCalls.length > 0) calls.push(...msg.toolCalls);
    if (isThinkingNotice(msg, isMine ? isMine(msg) : false, workerMxids)) {
      thoughts.push(msg);
      continue;
    }
    if (isToolMessage(msg.body ?? "")) continue;
    answers.push(msg);
  }
  return { thoughts, calls, answers, confirmations, errors };
}

/** 聚合后的单次工具调用（过程条展开行）：
 * 🔧 call 帧开槽，后续同名 ✅/❌ 结果帧并回最近一个未闭合的同名槽。 */
export interface AggregatedCall {
  key: string;
  name: string;
  status: "call" | "ok" | "fail";
  argsSummary?: string;
  detail?: string;
  startTs?: number;
  endTs?: number;
  /** 耗时（秒）；未闭合 = undefined（进行中）。 */
  durationSec?: number;
}

/**
 * 工具帧序列 → 聚合调用序列（call+result 配对；同名连续调用开新槽）。
 * 无 ts 时 durationSec 缺省（过程条显示进行中/省略号）。
 */
export function aggregateToolCalls(calls: ToolCall[]): AggregatedCall[] {
  const out: AggregatedCall[] = [];
  let k = 0;
  for (const c of calls) {
    if (c.status === "call") {
      out.push({
        key: `c${k++}`,
        name: c.name,
        status: "call",
        argsSummary: c.argsSummary,
        detail: c.detail,
        startTs: c.ts,
      });
    } else {
      let slot: AggregatedCall | null = null;
      for (let i = out.length - 1; i >= 0; i -= 1) {
        if (out[i].name === c.name && out[i].status === "call") {
          slot = out[i];
          break;
        }
      }
      if (slot) {
        slot.status = c.status;
        slot.endTs = c.ts;
        if (c.detail) slot.detail = c.detail;
        if (c.argsSummary && !slot.argsSummary) slot.argsSummary = c.argsSummary;
      } else {
        // 仅结果帧（无对应 call 帧）：独立槽，自始自终。
        out.push({
          key: `c${k++}`,
          name: c.name,
          status: c.status,
          argsSummary: c.argsSummary,
          detail: c.detail,
          startTs: c.ts,
          endTs: c.ts,
        });
      }
    }
  }
  for (const a of out) {
    if (a.status !== "call" && a.startTs && a.endTs) {
      a.durationSec = Math.max(0, (a.endTs - a.startTs) / 1000);
    }
  }
  return out;
}

// ── 思考过程识别（m.notice 推理帧 → 过程折叠条）────────────────────
//
// 适配器没发结构化 run 块（协议 opt-in，qwenpaw 侧未采用），只能启发式：
// - 前缀：流式推理结束帧 body = `Thinking:\n\n<text>`；老格式 `[thinking]`；
// - 长度：completed 推理帧 = m.notice + 推理原文（无前缀）——worker 发来的
//   长文本 notice 视为思考；短 notice（ACL 拒绝/操作提示）保持原样渲染。
// 自己的消息（mine）永不吸收：自己写的 notice 就是正文。

/** 长文本启发式阈值（字符）——低于它的 worker notice 视为提示而非推理。 */
const THINKING_NOTICE_MIN_LENGTH = 200;

/** thinking 前缀（流式结束帧 `Thinking:` / 老格式 `[thinking]`）。 */
const THINKING_PREFIX_RE = /^(?:Thinking:|\[thinking\])/i;

/** 待判定消息：RoomMessage 带 msgtype；ChatMessage 把 msgtype 存在 type。 */
export interface ThinkingNoticeLike {
  sender?: string;
  body?: string;
  msgtype?: string;
  /** ChatMessage 侧的 msgtype 别名（roomMessagesToIR 写入）。 */
  type?: string;
}

/**
 * 是否「思考过程」notice（应吸收进过程折叠条、不再独立成正文气泡）。
 * - 自己的消息 → false；
 * - 非 m.notice → false；
 * - body 带 thinking 前缀 → true（不看发送者/长度）；
 * - worker 发送且 body ≥ 阈值 → true；
 * - 其它 → false（短 notice / 未知发送者照旧渲染）。
 */
export function isThinkingNotice(
  msg: ThinkingNoticeLike,
  mine: boolean,
  workerMxids: Record<string, unknown>,
): boolean {
  if (mine) return false;
  const msgtype = msg.msgtype ?? msg.type ?? "";
  if (msgtype !== "m.notice") return false;
  const body = msg.body ?? "";
  if (THINKING_PREFIX_RE.test(body)) return true;
  const sender = msg.sender ?? "";
  if (!sender || !Object.prototype.hasOwnProperty.call(workerMxids, sender)) {
    return false;
  }
  return body.length >= THINKING_NOTICE_MIN_LENGTH;
}

/** 去掉 thinking 前缀及其后的空行（trim 收口），返回折叠条展示文本。 */
export function stripThinkingPrefix(body: string): string {
  const text = body || "";
  const m = THINKING_PREFIX_RE.exec(text);
  return (m ? text.slice(m[0].length) : text).trim();
}
