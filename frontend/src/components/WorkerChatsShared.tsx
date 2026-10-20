/** WorkerChats 子模块——自 WorkerChats.tsx 纯搬移拆出
 * （行为零变化）。 */
import type { WorkerChatMessage } from "../api";

/** 通道短名（13.8「会话列表拥挤依旧」：agentteams_matrix 全名 Tag 挤爆 64px
 * 列——短名 + Tooltip 全名；未知值原样回退）。 */
export const CHANNEL_LABELS: Record<string, string> = {
  agentteams_matrix: "Matrix",
  matrix: "Matrix",
  console: "Console",
  qq: "QQ",
  dingtalk: "钉钉",
  feishu: "飞书",
  discord: "Discord",
  telegram: "Telegram",
  slack: "Slack",
  imessage: "iMessage",
  mattermost: "Mattermost",
  mqtt: "MQTT",
  voice: "Voice",
};

/** QwenPaw console constants/channel.ts CHANNEL_COLORS 逐值抄录
 * （会话通道色板与 QwenPaw 原生会话页一致）。 */
export const CHANNEL_COLORS: Record<string, string> = {
  imessage: "geekblue",
  discord: "blue",
  dingtalk: "green",
  feishu: "volcano",
  qq: "gold",
  telegram: "geekblue",
  slack: "purple",
  mattermost: "purple",
  mqtt: "orange",
  console: "green",
  matrix: "red",
  voice: "geekblue",
  sip: "cyan",
  wecom: "olive",
  xiaoyi: "cyan",
  yuanbao: "lime",
};

/** QwenPaw Control/Sessions formatTime 同款：无时区后缀按 UTC 归一化，
 * zh-CN 数字日期格式。 */
export function formatTime(ts?: string | number | null): string {
  if (ts === null || ts === undefined || ts === "") return "-";
  let normalized = ts;
  if (typeof ts === "string" && !/[Z+\-]\d{2}:?\d{2}$/.test(ts)) {
    normalized = ts + "Z";
  }
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return String(ts);
  try {
    return d.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return d.toLocaleString();
  }
}

/**
 * 消息结构化模型（「模仿 QwenPaw 会话消息折叠和渲染」）——
 * 正源逐条核过：
 * - QwenPaw console HostBubbles.renderResponseMessage：tool-like 类型走
 * ResponseTool 卡，REASONING 走 ResponseReasoning，HEARTBEAT → null（不渲染），
 * ERROR 恒可见（result-only 下错误也不折叠）；
 * - messageDisplay.ts result-only（默认偏好 result-collapsed 的完成态）：
 * 一个回答只显示**最后一条文本**，其前所有过程消息折叠成「N steps」手风琴
 * （LazyAccordion destroyOnClose——收起时子内容完全不渲染，本组件同款懒渲染）；
 * - 消息 JSON 结构（qwenpaw/schemas.py + chats/utils.py）：
 * {type, role, content: [{type:"text",text} | {type:"data",data:{call_id,
 * name, arguments|output, state?}} | {type:"image",image_url} | {type:"file"}]
 * | string, status, metadata}。
 * 13.6 旧版读 `b.name`（顶层）取工具名——实际在 `b.data.name`，恒 undefined，
 * 工具块全部退化 RAW JSON.stringify 输出（所见「没模仿 QwenPaw」的根因）。
 */
/** QwenPaw console responseMessageTypes.ts TOOL_LIKE 集合 + qwenpaw
 * MessageType 的 mcp_tool_call 族（双源并集，大小写归一小写比较）。 */
const TOOL_LIKE_TYPES = new Set([
  "plugin_call",
  "plugin_call_output",
  "tool_call",
  "tool_call_output",
  "function_call",
  "function_call_output",
  "component_call",
  "component_call_output",
  "mcp_call",
  "mcp_call_output",
  "mcp_tool_call",
  "mcp_tool_call_output",
]);

export type PartKind = "tool" | "thinking" | "text" | "media";
export interface MsgPart {
  kind: PartKind;
  /** 工具名 / 文本内容 / 媒体名。 */
  label: string;
  /** 工具参数 / 输出 / 错误态（已截断，单行化）。 */
  detail?: string;
  failed?: boolean;
  image?: string;
}
export interface Extracted {
  role: string;
  type: string;
  parts: MsgPart[];
}

/** 工具 data 块 → step part。data = {call_id, name, arguments} 调用 /
 * {call_id, name, output, state?} 输出（agentscope_msg_to_message 实锤）。 */
function dataPart(d: Record<string, unknown>): MsgPart {
  const name =
    typeof d.name === "string" && d.name
      ? d.name
      : typeof d.tool_name === "string"
        ? (d.tool_name as string)
        : "tool";
  const state = typeof d.state === "string" ? d.state : "";
  const squash = (s: string) =>
    s.length > 160 ? `${s.slice(0, 160)}…` : s;
  if (d.output !== undefined && d.output !== null) {
    let out: string;
    if (typeof d.output === "string") out = d.output;
    else {
      try {
        out = JSON.stringify(d.output);
      } catch {
        out = String(d.output);
      }
    }
    out = out.replace(/\s+/g, " ").trim();
    return {
      kind: "tool",
      label: name,
      detail: out ? squash(out) : undefined,
      failed: state === "error" || state === "failed",
    };
  }
  let args: string | undefined;
  if (d.arguments !== undefined && d.arguments !== null) {
    if (typeof d.arguments === "string") args = d.arguments;
    else {
      try {
        args = JSON.stringify(d.arguments);
      } catch {
        args = undefined;
      }
    }
    if (args) {
      args = args.replace(/\s+/g, " ").trim();
      args = squash(args);
    }
  }
  return { kind: "tool", label: name, detail: args };
}

/** 单消息 → 结构化 parts（文本 / 思考 / 工具 / 媒体）。 */
export function extractMsg(m: WorkerChatMessage): Extracted {
  const role = String(m.role || "").toLowerCase();
  const type = String(m.type || "").toLowerCase();
  const blocks = Array.isArray(m.content) ? m.content : [m.content];
  const parts: MsgPart[] = [];
  const textKind: PartKind = type === "reasoning" ? "thinking" : "text";
  for (const raw of blocks) {
    if (raw === null || raw === undefined) continue;
    if (typeof raw === "string") {
      if (raw.trim()) parts.push({ kind: textKind, label: raw });
      continue;
    }
    if (typeof raw !== "object") continue;
    const b = raw as Record<string, unknown>;
    const bt = String(b.type || "").toLowerCase();
    if (typeof b.text === "string" && b.text.trim()) {
      parts.push({ kind: textKind, label: b.text });
    } else if (
      b.data &&
      typeof b.data === "object" &&
      (bt === "data" || bt === "")
    ) {
      parts.push(dataPart(b.data as Record<string, unknown>));
    } else if (bt === "image" || typeof b.image_url === "string") {
      parts.push({
        kind: "media",
        label: "一张图片",
        image: typeof b.image_url === "string" ? b.image_url : undefined,
      });
    } else if (bt === "refusal" && typeof b.refusal === "string") {
      parts.push({ kind: "text", label: b.refusal });
    } else if (bt === "file" || b.file_url) {
      parts.push({
        kind: "media",
        label: String(b.file_name || b.filename || "一个文件"),
      });
    } else {
      // 未知块：压单行（绝不整段 RAW JSON——13.6 教训）。
      let s = "";
      try {
        s = JSON.stringify(b).replace(/\s+/g, " ");
      } catch {
        s = "";
      }
      if (s)
        parts.push({
          kind: "text",
          label: s.length > 120 ? `${s.slice(0, 120)}…` : s,
        });
    }
  }
  return { role, type, parts };
}

/** 消息分类（QwenPaw 对话框语义）：
 * user→用户气泡 / error→恒可见红线 / system→居中提示 /
 * assistant 有文本→asst（**每条独立气泡**）/ 其余→step（折叠 pill）/
 * heartbeat、progress→skip（QwenPaw renderResponseMessage 对两者均不渲染）。 */
export type MsgKind = "user" | "error" | "system" | "asst" | "step" | "skip";
export function msgKind(e: Extracted): MsgKind {
  if (e.type === "heartbeat" || e.type === "progress") return "skip";
  if (e.type === "error") return "error";
  if (e.role === "user") return "user";
  if (e.role === "system") return "system";
  const hasText = e.parts.some((p) => p.kind === "text" || p.kind === "thinking");
  if (e.role === "assistant" || e.type === "result" || e.type === "message") {
    return hasText ? "asst" : "step";
  }
  if (TOOL_LIKE_TYPES.has(e.type) || e.type === "reasoning") return "step";
  return "step";
}

/** 会话转录分组（）：user/error/system 消息切段；
 * 每条带文本的 assistant 消息独立成气泡（QwenPaw 对话框口径）；
 * 连续的 tool/thinking/无文本 assistant 消息收进 steps pill（收起时
 * 不渲染子内容，点开懒渲染）。 */
export type DetailItem =
  | { k: "user" | "asst" | "error" | "system"; i: number; e: Extracted }
  | { k: "steps"; items: { i: number; e: Extracted }[] };

export function groupTurns(msgs: WorkerChatMessage[]): DetailItem[] {
  const out: DetailItem[] = [];
  let pending: { i: number; e: Extracted }[] = [];
  const flush = () => {
    if (pending.length) out.push({ k: "steps", items: pending });
    pending = [];
  };
  for (let i = 0; i < msgs.length; i++) {
    const e = extractMsg(msgs[i]);
    const k = msgKind(e);
    if (k === "skip") continue;
    // 旧版每轮
    // 只把**最后一条** assistant 文本提升为气泡、中间全部文本吞进 steps
    // （长会话几乎只剩工具行）。改 QwenPaw 对话框口径：**每条带文本的
    // assistant 消息 = 独立气泡**；仅 tool/thinking/无文本消息折叠成
    // 「N 步」pill（点开懒渲染）。
    if (k === "user" || k === "error" || k === "system") {
      flush();
      out.push({ k, i, e });
    } else if (k === "asst") {
      flush();
      out.push({ k, i, e });
    } else {
      pending.push({ i, e });
    }
  }
  flush();
  return out;
}
