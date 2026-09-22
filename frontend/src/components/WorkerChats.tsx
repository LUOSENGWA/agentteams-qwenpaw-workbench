/**
 * 💬 会话（v0.5.0-beta.13.1 消费上游 #1295，issue #1293；
 * v0.5.0-beta.13.4 查看窗口重做——QwenPaw 原始输出口径）。
 *
 * 给 AgentTeams 里的无头 QwenPaw Worker「补头」：用户经 AgentTeams 即可
 * 看见 Worker 的 QwenPaw 会话（列表 → 完整 session，只读）。
 *
 * 位置：群内 Worker 头像点击 → 抽屉（RoomChat）。
 * 数据面：Controller 会话端点（#1295，room 级 L2 参与边界）——
 *   GET /workers/{name}/chats[/{id}[/status]]
 * 走既有通用 Controller 代理（后端零新端点）。
 *
 * v0.5.0-beta.13.4 口径（装验反馈：「查看会话的窗口参考 QwenPaw，
 * 因为这是 QwenPaw 的原始输出」）——逐条对齐 QwenPaw console
 * Control/Sessions 页（session 数据模型=QwenPaw ChatSpec 同构）：
 * - 列表：Active/Archived 双 tab（带计数）+ QwenPaw 同语义列
 *   （Name/Channel 彩色 Tag/UserID/UpdatedAt 可排序默认倒序；
 *   SessionID 与 CreatedAt 移入详情头——抽屉 560px 宽度适配）；
 *   Channel 色板逐值抄 QwenPaw constants/channel.ts CHANNEL_COLORS。
 * - 详情：QwenPaw /chat/{id} 会话口径——user 右气泡、assistant 左
 *   markdown（插件 MdText 同款零依赖渲染）、工具块紧凑标签、system
 *   居中；元信息行 = QwenPaw session 卡 meta（ID/User/Created/Updated）。
 *
 * 纪律（#1293 数据敏感性定案，不变）：
 * - detail = **agent 上下文**——可能含压缩历史/未发送工具调用输出，
 *   与实发房间消息不同，详情头部恒显蓝色标注。
 * - L2 只见自己所在 Matrix 房间的会话（服务端强制）；越权统一 404
 *   （W8 不可探测）→ 整节占位说明，不渲染空列表。
 * - /status 仅 QwenPaw ≥2.2.1：旧 runtime 404 → 隐藏状态灯（版本无关门）。
 * - 只读：无发送/编辑面。
 */
import type * as ReactNS from "react";

import { useT } from "../i18n";
import {
  type WorkerInfo,
  type WorkerChatSpec,
  type WorkerChatMessage,
  fetchWorkerChats,
  fetchWorkerChat,
  fetchWorkerChatStatus,
  httpErrorStatus,
} from "../api";
import MdText from "./MdText";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

/** 通道短名（13.8「会话列表拥挤依旧」：agentteams_matrix 全名 Tag 挤爆 64px
 *  列——短名 + Tooltip 全名；未知值原样回退）。 */
const CHANNEL_LABELS: Record<string, string> = {
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

/** 容器宽测量（13.8 列自适应：<640 隐藏通道列，把宽度让给会话列/查看钮）。 */
function useContainerWidth(
  ref: ReactNS.RefObject<HTMLDivElement | null>,
): number {
  const [w, setW] = React.useState(0);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((es) => {
      const r = es[0]?.contentRect;
      if (r) setW(Math.round(r.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** QwenPaw console constants/channel.ts CHANNEL_COLORS 逐值抄录
 *  （会话通道色板与 QwenPaw 原生会话页一致）。 */
const CHANNEL_COLORS: Record<string, string> = {
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
 *  zh-CN 数字日期格式。 */
function formatTime(ts?: string | number | null): string {
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
 * v0.5.0-beta.13.7 消息结构化模型（「模仿 QwenPaw 会话消息折叠和渲染」定案）——
 * 正源逐条核过：
 * - QwenPaw console HostBubbles.renderResponseMessage：tool-like 类型走
 *   ResponseTool 卡，REASONING 走 ResponseReasoning，HEARTBEAT → null（不渲染），
 *   ERROR 恒可见（result-only 下错误也不折叠）；
 * - messageDisplay.ts result-only（默认偏好 result-collapsed 的完成态）：
 *   一个回答只显示**最后一条文本**，其前所有过程消息折叠成「N steps」手风琴
 *   （LazyAccordion destroyOnClose——收起时子内容完全不渲染，本组件同款懒渲染）；
 * - 消息 JSON 结构（qwenpaw/schemas.py + chats/utils.py）：
 *   {type, role, content: [{type:"text",text} | {type:"data",data:{call_id,
 *   name, arguments|output, state?}} | {type:"image",image_url} | {type:"file"}]
 *   | string, status, metadata}。
 * 13.6 旧版读 `b.name`（顶层）取工具名——实际在 `b.data.name`，恒 undefined，
 * 工具块全部退化 RAW JSON.stringify 输出（装验所见「没模仿 QwenPaw」的真根因）。
 */
/** QwenPaw console responseMessageTypes.ts TOOL_LIKE 集合 + qwenpaw
 *  MessageType 的 mcp_tool_call 族（双源并集，大小写归一小写比较）。 */
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

type PartKind = "tool" | "thinking" | "text" | "media";
interface MsgPart {
  kind: PartKind;
  /** 工具名 / 文本内容 / 媒体名。 */
  label: string;
  /** 工具参数 / 输出 / 错误态（已截断，单行化）。 */
  detail?: string;
  failed?: boolean;
  image?: string;
}
interface Extracted {
  role: string;
  type: string;
  parts: MsgPart[];
}

/** 工具 data 块 → step part。data = {call_id, name, arguments} 调用 /
 *  {call_id, name, output, state?} 输出（agentscope_msg_to_message 实锤）。 */
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
function extractMsg(m: WorkerChatMessage): Extracted {
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

/** 消息分类（QwenPaw result-only 语义）：
 *  user→用户气泡 / error→恒可见红线 / system→居中提示 /
 *  assistant 有文本→asst（轮尾=结果可见，轮中=折叠）/ 其余→step（折叠）/
 *  heartbeat、progress→skip（QwenPaw renderResponseMessage 对两者均不渲染）。 */
type MsgKind = "user" | "error" | "system" | "asst" | "step" | "skip";
function msgKind(e: Extracted): MsgKind {
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

/** 轮分组（QwenPaw 每回答一个 response，此处按 user 消息切轮——
 *  只读转录的最接近等价）：每轮里**最后一条有文本的 assistant** 提升为
 *  可见结果（result-only），其余全部收进 steps（收起时不渲染子内容）。 */
type DetailItem =
  | { k: "user" | "asst" | "error" | "system"; i: number; e: Extracted }
  | { k: "steps"; items: { i: number; e: Extracted }[] };

function groupTurns(msgs: WorkerChatMessage[]): DetailItem[] {
  const out: DetailItem[] = [];
  let pending: { i: number; e: Extracted }[] = [];
  const flush = () => {
    if (!pending.length) return;
    let last = -1;
    for (let j = pending.length - 1; j >= 0; j--) {
      const e = pending[j].e;
      if (
        (e.role === "assistant" || e.type === "result") &&
        e.parts.some((p) => p.kind === "text")
      ) {
        last = j;
        break;
      }
    }
    const head = last >= 0 ? pending.slice(0, last) : pending;
    if (head.length) out.push({ k: "steps", items: head });
    if (last >= 0) {
      out.push({ k: "asst", i: pending[last].i, e: pending[last].e });
      const tail = pending.slice(last + 1);
      if (tail.length) out.push({ k: "steps", items: tail });
    }
    pending = [];
  };
  for (let i = 0; i < msgs.length; i++) {
    const e = extractMsg(msgs[i]);
    const k = msgKind(e);
    if (k === "skip") continue;
    if (k === "user" || k === "error" || k === "system") {
      flush();
      out.push({ k, i, e });
    } else {
      pending.push({ i, e });
    }
  }
  flush();
  return out;
}

/** 步骤行：工具（名+参数/输出单行预览，失败 ❌）/ 思考 💭 / 中间文本 💬 / 媒体。 */
function StepLine({
  e,
  tr,
}: {
  e: Extracted;
  tr: (k: string, v?: Record<string, string | number>) => string;
}) {
  return (
    <div
      style={{
        fontSize: 11.5,
        color: "rgba(0,0,0,0.62)",
        background: "rgba(127,127,127,0.07)",
        borderRadius: 6,
        padding: "3px 8px",
      }}
    >
      {e.parts.length === 0 ? (
        <span style={{ color: "rgba(0,0,0,0.35)" }}>{e.type || e.role || "…"}</span>
      ) : (
        e.parts.map((p, j) => {
          if (p.kind === "tool") {
            return (
              <div
                key={j}
                style={{
                  display: "flex",
                  gap: 6,
                  alignItems: "baseline",
                  overflow: "hidden",
                }}
              >
                <span style={{ flexShrink: 0 }}>{p.failed ? "❌" : "🔧"}</span>
                <span
                  style={{
                    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {p.label}
                </span>
                {p.detail ? (
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: "rgba(0,0,0,0.45)",
                    }}
                  >
                    {p.detail}
                  </span>
                ) : null}
              </div>
            );
          }
          if (p.kind === "media") {
            return (
              <div key={j}>
                {p.image ? (
                  <img
                    src={p.image}
                    alt={p.label}
                    style={{ maxWidth: 160, maxHeight: 120, borderRadius: 6, display: "block" }}
                  />
                ) : null}
                🖼️ {p.label}
              </div>
            );
          }
          const txt =
            p.label.length > 150 ? `${p.label.slice(0, 150)}…` : p.label;
          return (
            <div
              key={j}
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                color: "rgba(0,0,0,0.55)",
              }}
            >
              {p.kind === "thinking" ? "💭" : "💬"} {txt}
            </div>
          );
        })
      )}
    </div>
  );
}

/** 步骤折叠（QwenPaw LazyAccordion 同款语义：收起 = 子内容完全不渲染，
 *  懒加载；完成态默认收起——getCollapsedGroupStatus 的 stepsCompleted 形态）。 */
function StepsCollapse({
  items,
  tr,
}: {
  items: { i: number; e: Extracted }[];
  tr: (k: string, v?: Record<string, string | number>) => string;
}) {
  const [open, setOpen] = React.useState(false);
  // v0.5.0-beta.13.8（13.7 装验「折叠可以做得更像 QwenPaw」）：inline pill
  // 改 QwenPaw LazyAccordion 同款**整行头**——图标 + 文案 + 计数 + 右对齐
  // 旋转 chevron，整行可点，浅底圆角行（@agentscope-ai/chat Accordion
  // group header 同构；收起=子内容不渲染的懒语义保持）。
  return (
    <div style={{ margin: "0 0 8px 12px" }}>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "5px 10px",
          borderRadius: 8,
          background: "rgba(127,127,127,0.08)",
          border: "1px solid rgba(127,127,127,0.14)",
          fontSize: 11.5,
          color: "rgba(0,0,0,0.62)",
          userSelect: "none",
        }}
        title={open ? tr("收起") : tr("点击展开步骤详情")}
      >
        <span>🔧</span>
        <span>{tr("{n} 步", { n: items.length })}</span>
        <span
          style={{
            marginLeft: "auto",
            fontSize: 9,
            transition: "transform 0.15s",
            transform: open ? "rotate(180deg)" : "none",
            display: "inline-block",
          }}
        >
          ▼
        </span>
      </div>
      {open ? (
        <div
          style={{
            marginTop: 5,
            display: "grid",
            gap: 4,
            paddingLeft: 6,
            borderLeft: "2px solid rgba(127,127,127,0.18)",
          }}
        >
          {items.map(({ i, e }) => (
            <StepLine key={i} e={e} tr={tr} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * v0.5.0-beta.13.1（9/19 入口迁移）：`fixedWorker` = 头像抽屉模式——
 * 锁定单个 Worker（跳过选择器）。
 */
function WorkerChats({
  workers,
  fixedWorker,
}: {
  workers: WorkerInfo[];
  fixedWorker?: string;
}) {
  const tr = useT();
  const [sel, setSel] = React.useState(fixedWorker ?? "");
  const [gate, setGate] = React.useState<"" | "404" | "err">("");
  const [gateMsg, setGateMsg] = React.useState("");
  const [chats, setChats] = React.useState<WorkerChatSpec[]>([]);
  const [loading, setLoading] = React.useState(false);

  // v0.5.0-beta.13.4：QwenPaw 会话页同款 Active/Archived 双 tab。
  const [tab, setTab] = React.useState<"active" | "archived">("active");

  // v0.5.0-beta.13.7（13.6 装验「依旧拥挤，会话列可以缩短并增加鼠标悬浮和
  // 点击展开」）：会话名点击行内展开（全名换行 + session_id 全值），
  // 悬浮 = antd.Tooltip 全名（QwenPaw Table ellipsis 同语义）。
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  const [openId, setOpenId] = React.useState<string | null>(null);
  const [msgs, setMsgs] = React.useState<WorkerChatMessage[]>([]);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailErr, setDetailErr] = React.useState("");
  const [status, setStatus] = React.useState<"" | "idle" | "running">("");
  const detailListRef = React.useRef<HTMLDivElement | null>(null);

  const load = React.useCallback(async () => {
    if (!sel) return;
    setLoading(true);
    setGate("");
    setGateMsg("");
    try {
      const data = await fetchWorkerChats(sel);
      setChats(Array.isArray(data) ? data : []);
    } catch (e) {
      const st = httpErrorStatus(e);
      if (st === 404) {
        setGate("404");
        setChats([]);
      } else {
        setGate("err");
        setGateMsg(e instanceof Error ? e.message : tr("加载失败"));
        setChats([]);
      }
    } finally {
      setLoading(false);
    }
  }, [sel, tr]);

  React.useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  const openChat = async (chatId: string) => {
    if (!sel) return;
    setOpenId(chatId);
    setMsgs([]);
    setDetailErr("");
    setStatus("");
    setDetailLoading(true);
    // 状态灯与详情并发拉取；404 = 旧 runtime，隐藏灯
    // （会话级 loop 状态显示点迁至聊天页输入区——RoomChat composer chip，
    // 9/22 定案，本视图不再查 /loops/status。）
    void fetchWorkerChatStatus(sel, chatId)
      .then((r) => setStatus(r?.status === "running" ? "running" : "idle"))
      .catch(() => setStatus(""));
    try {
      const d = await fetchWorkerChat(sel, chatId);
      setMsgs(Array.isArray(d?.messages) ? d.messages : []);
    } catch (e) {
      const st = httpErrorStatus(e);
      if (st === 404) setDetailErr(tr("会话不存在或无访问权（404）"));
      else
        setDetailErr(e instanceof Error ? e.message : tr("加载失败"));
    } finally {
      setDetailLoading(false);
    }
  };

  // 详情加载完滚到底（会话口径：最新在下）。
  React.useEffect(() => {
    if (!detailLoading && openId && detailListRef.current) {
      const el = detailListRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [detailLoading, openId, msgs]);

  // v0.5.0-beta.13.8：容器宽测量——**必须在所有早退 return 之前**（列表/
  // 详情/空态/gate 各视图 hook 数必须一致，否则 React #300 崩）。
  const cwrapRef = React.useRef<HTMLDivElement | null>(null);
  const cwrapW = useContainerWidth(cwrapRef);

  if (workers.length === 0) {
    return <antd.Alert type="info" showIcon message={tr("无 Worker")} />;
  }

  if (gate === "404") {
    return (
      <antd.Alert
        type="info"
        showIcon
        message={tr("无可见会话（Controller 版本较低或无该 Worker 访问权）")}
        description={tr(
          "L2 仅可查看自己所在 Matrix 房间内的会话；Controller 版本未含会话端点或当前账号无该 Worker 访问权时同样显示此提示。升级 Controller 后本节自动点亮。",
        )}
      />
    );
  }

  if (gate === "err") {
    return (
      <antd.Alert
        type="error"
        showIcon
        message={tr("会话加载失败")}
        description={gateMsg}
        action={
          <antd.Button size="small" onClick={() => void load()}>
            {tr("重试")}
          </antd.Button>
        }
      />
    );
  }

  const active = chats.filter((c) => !c.archived);
  const archived = chats.filter((c) => !!c.archived);
  const list = tab === "active" ? active : archived;
  const openChatSpec = openId
    ? chats.find((c) => c.id === openId)
    : undefined;

  // ── 详情视图（QwenPaw /chat/{id} 口径：列表让位，← 返回列表）──────
  // v0.5.0-beta.13.5：高度链改容器相对（#629 家规）——抽屉 body 是定高
  // flex 项，消息区 flex:1 + minHeight:0 自滚，不再写 420 魔法数（窗口
  // 矮时旧写法内容被抽屉底裁切且不可滚）。
  if (openId) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10, height: "100%", minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", flex: "0 0 auto" }}>
          <antd.Button
            size="small"
            icon={<span>←</span>}
            onClick={() => setOpenId(null)}
          >
            {tr("会话列表")}
          </antd.Button>
          <span style={{ fontWeight: 600, fontSize: 13.5 }}>
            {openChatSpec?.name || openId.slice(0, 12)}
          </span>
          {status === "running" ? (
            <antd.Tag color="blue" style={{ marginInlineEnd: 0 }}>
              running
            </antd.Tag>
          ) : null}
          {status === "idle" ? (
            <antd.Tag style={{ marginInlineEnd: 0 }}>idle</antd.Tag>
          ) : null}
          {/* v0.5.0-beta.13.6：会话级 loop 标签撤出——显示位置定案=聊天页
              输入区（QwenPaw console LoopModeSelector 正源），唯一落点，
              不双显。running/idle 灯保留（会话状态，非 loop）。 */}
          {openChatSpec?.channel ? (
            <antd.Tag
              color={CHANNEL_COLORS[openChatSpec.channel] || "default"}
              style={{ marginInlineEnd: 0 }}
            >
              {openChatSpec.channel}
            </antd.Tag>
          ) : null}
        </div>
        {/* QwenPaw session 卡 meta 行：ID / User / Created / Updated */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "2px 14px",
            fontSize: 11,
            color: "rgba(127,127,127,0.95)",
            flex: "0 0 auto",
          }}
        >
          <span style={{ fontFamily: "monospace" }}>
            ID: {openChatSpec?.session_id || openId}
          </span>
          {openChatSpec?.user_id ? <span>User: {openChatSpec.user_id}</span> : null}
          {openChatSpec?.created_at ? (
            <span>Created: {formatTime(openChatSpec.created_at)}</span>
          ) : null}
          {openChatSpec?.updated_at ? (
            <span>Updated: {formatTime(openChatSpec.updated_at)}</span>
          ) : null}
        </div>
        <antd.Alert
          type="info"
          showIcon
          style={{ flex: "0 0 auto" }}
          message={tr(
            "Agent 上下文视图——可能含压缩历史与未发送的工具调用/输出，与实发房间消息不同。",
          )}
        />
        {detailErr ? (
          <antd.Alert type="error" showIcon style={{ flex: "0 0 auto" }} message={detailErr} />
        ) : (
          <div
            ref={detailListRef}
            style={{
              border: "1px solid rgba(127,127,127,0.25)",
              borderRadius: 8,
              padding: 10,
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              overscrollBehavior: "contain",
              background: "rgba(127,127,127,0.05)",
            }}
          >
            {/* v0.5.0-beta.13.6（「会话页面依旧不能滚动」真根因·浏览器 harness
                实证）：13.5 的 display:grid + alignContent:"end" 在内容超容器
                时顶部溢出进入不可滚动区（scrollTop 恒 0，实测 scrollH==clientH）
                ——上半截会话永远看不了。改普通块级流 + 既有 JS 滚底
                （scrollTop=scrollHeight，实测 scrollable=true）。 */}
            {detailLoading ? (
              <antd.Spin size="small" />
            ) : msgs.length === 0 ? (
              <antd.Alert type="info" showIcon message={tr("该会话暂无消息")} />
            ) : (
              /* v0.5.0-beta.13.7（13.6 装验「要模仿 QwenPaw 的会话消息折叠和
                 渲染」）：QwenPaw result-only 轮分组——每轮只显示最后一条文本
                 （assistant 气泡），中间工具/思考步收进「N 步」pill（懒渲染，
                 点开才渲染子行）；user 右气泡 / error 红线恒可见 / system 居中。
                 旧版逐条平铺 + tool 块 RAW JSON 输出，全部替换。 */
              groupTurns(msgs).map((it) => {
                if (it.k === "steps") {
                  return (
                    <StepsCollapse key={`s${it.items[0].i}`} items={it.items} tr={tr} />
                  );
                }
                const { i, e } = it;
                if (it.k === "user") {
                  return (
                    <div
                      key={i}
                      style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}
                    >
                      <div
                        style={{
                          maxWidth: "86%",
                          background: "rgba(255,127,22,0.14)",
                          border: "1px solid rgba(255,127,22,0.35)",
                          borderRadius: "10px 2px 10px 10px",
                          padding: "6px 10px",
                          fontSize: 12.5,
                          wordBreak: "break-word",
                        }}
                      >
                        {e.parts.map((p, j) =>
                          p.kind === "media" ? (
                            p.image ? (
                              <img
                                key={j}
                                src={p.image}
                                alt={p.label}
                                style={{ maxWidth: 220, maxHeight: 160, borderRadius: 6, display: "block", margin: "4px 0" }}
                              />
                            ) : (
                              <div key={j} style={{ fontSize: 12, opacity: 0.8 }}>
                                🖼️ {p.label}
                              </div>
                            )
                          ) : (
                            <MdText key={j} text={p.label} maxLength={2000} />
                          )
                        )}
                      </div>
                    </div>
                  );
                }
                if (it.k === "error") {
                  const txt =
                    e.parts.map((p) => p.label).join("\n") || e.type;
                  return (
                    <div
                      key={i}
                      style={{
                        marginBottom: 8,
                        padding: "4px 10px",
                        borderRadius: 8,
                        border: "1px solid rgba(245,34,45,0.35)",
                        background: "rgba(245,34,45,0.06)",
                        fontSize: 12,
                        color: "#cf1322",
                        wordBreak: "break-word",
                      }}
                    >
                      ⚠️ {txt}
                    </div>
                  );
                }
                if (it.k === "system") {
                  const txt = e.parts.map((p) => p.label).join("\n");
                  return (
                    <div
                      key={i}
                      style={{
                        textAlign: "center",
                        fontSize: 11,
                        color: "rgba(127,127,127,0.9)",
                        marginBottom: 8,
                        wordBreak: "break-word",
                      }}
                    >
                      {txt || e.type || "…"}
                    </div>
                  );
                }
                // asst = 该轮结果（最后一条文本，QwenPaw result-only 可见项）。
                return (
                  <div
                    key={i}
                    style={{ display: "flex", justifyContent: "flex-start", marginBottom: 8 }}
                  >
                    <div
                      style={{
                        maxWidth: "92%",
                        background: "rgba(255,255,255,0.75)",
                        border: "1px solid rgba(127,127,127,0.22)",
                        borderRadius: "2px 10px 10px 10px",
                        padding: "6px 10px",
                      }}
                    >
                      {e.parts.map((p, j) =>
                        p.kind === "tool" || p.kind === "thinking" ? (
                          <StepLine
                            key={j}
                            e={{ role: e.role, type: e.type, parts: [p] }}
                            tr={tr}
                          />
                        ) : p.kind === "media" ? (
                          <div key={j} style={{ margin: "4px 0" }}>
                            {p.image ? (
                              <img
                                src={p.image}
                                alt={p.label}
                                style={{ maxWidth: 220, maxHeight: 160, borderRadius: 6, display: "block" }}
                              />
                            ) : (
                              <span style={{ fontSize: 12 }}>🖼️ {p.label}</span>
                            )}
                          </div>
                        ) : (
                          // QwenPaw assistant 文本=markdown 渲染（原始输出原样）。
                          <MdText key={j} text={p.label} maxLength={4000} />
                        )
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    );
  }

  // ── 列表视图（QwenPaw Control/Sessions 同语义列）────────────────
  // v0.5.0-beta.13.8（13.7 装验「会话列表拥挤依旧，自适应宽度，查看按钮
  // 不被挤压」）：① 通道列 64→56 + 短名（agentteams_matrix 全名 Tag 是
  // 挤爆主因）+ <640px 容器整列隐藏（宽度让给会话列）② 查看列 48→44
  // + 按钮 nowrap + padding 收窄，任何容器宽恒整词可见 ③ 会话列 =
  // 唯一弹性列（min 120）+ 每会话 status 点（running 蓝呼吸，/chats
  // 自带字段，零新请求）。
  const showChannelCol = cwrapW === 0 || cwrapW >= 640;
  const columns = [
    {
      title: tr("会话"),
      dataIndex: "name",
      key: "name",
      render: (_: unknown, c: WorkerChatSpec) => {
        const full = c.name || c.id.slice(0, 10);
        const running = c.status === "running";
        if (expandedId === c.id) {
          return (
            <div
              style={{ cursor: "pointer", minWidth: 0 }}
              onClick={() => setExpandedId(null)}
              title={tr("点击收起")}
            >
              <div
                style={{
                  fontWeight: 500,
                  whiteSpace: "normal",
                  wordBreak: "break-word",
                  lineHeight: 1.4,
                }}
              >
                {full}
              </div>
              <div
                style={{
                  fontSize: 10.5,
                  fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
                  color: "rgba(127,127,127,0.85)",
                  wordBreak: "break-all",
                  marginTop: 2,
                }}
              >
                {c.session_id || c.id}
              </div>
            </div>
          );
        }
        return (
          <antd.Tooltip title={running ? `${full}（running）` : full} mouseEnterDelay={0.3}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                minWidth: 0,
                width: "100%",
                cursor: "pointer",
              }}
              onClick={() => setExpandedId(c.id)}
            >
              {/* 13.8：per-session 状态点（/chats 自带 status 字段——
                  qwenpaw app 自维护的会话状态，零新请求）：running=蓝呼吸，
                  idle 不显（避免满屏灰点）。 */}
              {running ? (
                <span
                  className="wb-session-dot running"
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "#3b82f6",
                    flexShrink: 0,
                    display: "inline-block",
                  }}
                />
              ) : null}
              <span
                style={{
                  flex: "1 1 auto",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontWeight: 500,
                }}
              >
                {full}
              </span>
              {c.pinned ? (
                <antd.Tag color="gold" style={{ marginInlineEnd: 0, flexShrink: 0 }}>
                  {tr("置顶")}
                </antd.Tag>
              ) : null}
            </div>
          </antd.Tooltip>
        );
      },
    },
    ...(showChannelCol
      ? [
          {
            // QwenPaw Channel 列：彩色 Tag（CHANNEL_COLORS 逐值抄录）；
            // 13.8 短名 + Tooltip 全名（agentteams_matrix 全名是挤爆主因）。
            title: tr("通道"),
            dataIndex: "channel",
            key: "channel",
            width: 56,
            render: (v?: string) =>
              v ? (
                <antd.Tooltip title={v} mouseEnterDelay={0.3}>
                  <antd.Tag
                    color={CHANNEL_COLORS[v] || "default"}
                    style={{ marginInlineEnd: 0, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }}
                  >
                    {CHANNEL_LABELS[v] || v}
                  </antd.Tag>
                </antd.Tooltip>
              ) : (
                "-"
              ),
          },
        ]
      : []),
    {
      // QwenPaw UpdatedAt 列：可排序、默认倒序。13.8 112→104（给会话列让位）。
      title: tr("最后活动"),
      dataIndex: "updated_at",
      key: "updated_at",
      width: 104,
      defaultSortOrder: "descend" as const,
      sorter: (a: WorkerChatSpec, b: WorkerChatSpec) =>
        String(a.updated_at || "").localeCompare(String(b.updated_at || "")),
      render: (v?: string) => (
        <span style={{ fontSize: 11, whiteSpace: "nowrap" }}>{formatTime(v)}</span>
      ),
    },
    {
      // 13.8：查看列 48→44 + 按钮 nowrap/padding 收窄——任何容器宽整词可见。
      title: "",
      key: "op",
      width: 44,
      render: (_: unknown, c: WorkerChatSpec) => (
        // QwenPaw Action 列 View=绿色 link 按钮（#52c41a）。
        <antd.Button
          size="small"
          type="link"
          style={{
            padding: "0 2px",
            color: "#52c41a",
            fontSize: 12,
            whiteSpace: "nowrap",
          }}
          onClick={() => void openChat(c.id)}
        >
          {tr("查看")}
        </antd.Button>
      ),
    },
  ];

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {fixedWorker ? (
          <span style={{ fontWeight: 600 }}>
            {tr("Worker")}：{fixedWorker}
          </span>
        ) : (
          <>
            <span style={{ fontWeight: 600 }}>{tr("Worker")}</span>
            <antd.Select
              size="small"
              style={{ width: 220 }}
              value={sel || undefined}
              onChange={(v: string) => {
                setSel(v);
                setOpenId(null);
                setMsgs([]);
                setStatus("");
                setExpandedId(null);
              }}
              options={workers.map((w) => ({
                value: w.name,
                label: `${w.name}${w.role === "leader" ? "（Leader）" : ""}`,
              }))}
              placeholder={tr("选择 Worker")}
            />
          </>
        )}
        <div style={{ flex: 1 }} />
        <antd.Button size="small" onClick={() => void load()} loading={loading}>
          {tr("刷新")}
        </antd.Button>
      </div>

      <antd.Tabs
        size="small"
        activeKey={tab}
        onChange={(k: string) => {
          setTab(k === "archived" ? "archived" : "active");
          setOpenId(null);
          setExpandedId(null);
        }}
        items={[
          { key: "active", label: `${tr("活跃")} (${active.length})` },
          { key: "archived", label: `${tr("已归档")} (${archived.length})` },
        ]}
      />

      <div ref={cwrapRef} style={{ minWidth: 0 }}>
        <antd.Table
          rowKey="id"
          size="small"
          tableLayout="fixed"
          loading={loading}
          columns={columns}
          dataSource={list}
          pagination={false}
          locale={{
            emptyText:
              tab === "active"
                ? tr("当前账号在此 Worker 的可见范围内没有活跃会话（L2 仅自己所在房间）")
                : tr("没有已归档会话"),
          }}
        />
      </div>
    </div>
  );
}

export default WorkerChats;
