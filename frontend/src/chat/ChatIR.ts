/**
 * ChatIR：聊天回合（turn）中间表示 + 组装逻辑。
 *
 * 纯逻辑模块——零宿主/React/antd 依赖，node 可直测
 * （见 state/chatir-selftest.mjs，批次 3 验收门 4）。
 *
 * 回合规则（批次 3 任务书）：
 * - 同一 sender 的连续消息 = 一个 turn；
 * - sender 切换 = 新 turn；
 * - 消息携带的 toolCalls（工具帧）吸收进 turn.toolCalls（过程条数据源），
 *   同时保留在 turn.messages 原序（渲染层决定工具帧是否独立成行）。
 */

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

/**
 * 消息流 → turn 序列。
 * - 连续同 sender 归入同一 turn（首条消息定 id/startTime）；
 * - sender 切换开新 turn；
 * - 工具帧的 toolCalls 吸收进 turn.toolCalls；
 * - status：任一工具调用失败 = "failed"；
 *   末次工具调用无结果 或 末条消息 pending = "active"；否则 "done"。
 * 空输入返回空数组；不修改入参。
 */
export function buildTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const m of messages) {
    if (!cur || cur.sender !== m.sender) {
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
