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
import { CloseIcon, WrenchIcon, PictureIcon, ThoughtIcon, MessageIcon, UserIcon, WarnIcon, RobotIcon } from "./icons";
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
import WorkerSessionDot from "./WorkerSessionDot";

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

/** 消息分类（v0.5.0-beta.13.10 QwenPaw 对话框语义）：
 *  user→用户气泡 / error→恒可见红线 / system→居中提示 /
 *  assistant 有文本→asst（**每条独立气泡**）/ 其余→step（折叠 pill）/
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

/** 会话转录分组（v0.5.0-beta.13.10）：user/error/system 消息切段；
 *  每条带文本的 assistant 消息独立成气泡（QwenPaw 对话框口径）；
 *  连续的 tool/thinking/无文本 assistant 消息收进 steps pill（收起时
 *  不渲染子内容，点开懒渲染）。 */
type DetailItem =
  | { k: "user" | "asst" | "error" | "system"; i: number; e: Extracted }
  | { k: "steps"; items: { i: number; e: Extracted }[] };

function groupTurns(msgs: WorkerChatMessage[]): DetailItem[] {
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
    // v0.5.0-beta.13.10（13.9 装验「太多消息被收进回复里」）：旧版每轮
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
                <span style={{ flexShrink: 0 }}>{p.failed ? <CloseIcon size={12} style={{ color: "#ff4d4f", verticalAlign: "-1px" }} /> : <WrenchIcon size={12} style={{ verticalAlign: "-1px" }} />}</span>
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
                <PictureIcon size={12} style={{ verticalAlign: "-1px", marginRight: 2 }} /> {p.label}
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
              {p.kind === "thinking" ? <ThoughtIcon size={12} style={{ verticalAlign: "-1px", marginRight: 2 }} /> : <MessageIcon size={12} style={{ verticalAlign: "-1px", marginRight: 2 }} />} {txt}
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
        <span style={{ display: "inline-flex" }}><WrenchIcon size={12} /></span>
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
 * v0.5.0-beta.13.11（13.10 装验 E1 定案「卡片化是会话列表」）：列表
 * antd.Table → 卡片列表（参照 dashboard worker-chats-panel 口径：整卡
 * 点击进详情、全名/全 session_id 换行不裁切、窄容器不挤压）；
 * `refreshTick` = SSE room_message 事件驱动刷新（Element 式主路——
 * 房间来消息即刷当前会话；4s 轮询降为断连兜底）。
 */
function WorkerChats({
  workers,
  fixedWorker,
  refreshTick,
}: {
  workers: WorkerInfo[];
  fixedWorker?: string;
  refreshTick?: number;
}) {
  const tr = useT();
  const [sel, setSel] = React.useState(fixedWorker ?? "");
  const [gate, setGate] = React.useState<"" | "404" | "err" | "notoken">("");
  const [gateMsg, setGateMsg] = React.useState("");
  const [chats, setChats] = React.useState<WorkerChatSpec[]>([]);
  const [loading, setLoading] = React.useState(false);

  // v0.5.0-beta.13.4：QwenPaw 会话页同款 Active/Archived 双 tab。
  const [tab, setTab] = React.useState<"active" | "archived">("active");

  // v0.5.0-beta.13.11：卡片列表排序（Table sorter 的卡片等价物；
  // 默认最后活动倒序 = QwenPaw 会话页默认）。
  const [sortKey, setSortKey] = React.useState<"updated" | "created" | "name">(
    "updated",
  );

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
      } else if (st === 401 || st === 502) {
        // v0.5.0-beta.13.10：凭证缺失（L1 账号密码登录不带 Controller
        // token / L2 无数据面 / controller 不可达）→ 明确指引，不笼统
        // 「加载失败」（13.9 装验「经常显示无worker」的根因面之一）。
        setGate("notoken");
        setChats([]);
      } else if (st === 403) {
        // W8 防探测：跨团队/无该 Worker 访问权（有 token 但 scope 不够）。
        setGate("err");
        setGateMsg(tr("无该 Worker 访问权（跨团队或当前账号 scope 不含该 Worker）"));
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
    // v0.5.0-beta.13.10：打开即视为贴底（首屏滚底 + 后续跟随基准）。
    nearBottomRef.current = true;
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

  // v0.5.0-beta.13.10（13.9 装验「会话窗能不能实时更新」）→
  // v0.5.0-beta.13.11（13.10 装验「4s 一轮有点蠢，参考 Element」）：
  // 实时主路 = **事件驱动**（Element /sync 同款语义）——后端 sync watcher
  // 收到房间消息 → SSE room_message → WorkbenchPage 递增 refreshTick →
  // 下方 effect 立即拉详情/状态（延迟≈网络 RTT，非周期轮询）；4s 轮询
  // 降为 SSE 断连/事件丢失兜底（RoomChat P6 同构语义）。消息列表按
  // 「长度+末条」轻量判变（避免无变化时重渲染），状态灯同步刷。
  const selRef = React.useRef(sel);
  selRef.current = sel;
  const openIdRef = React.useRef(openId);
  openIdRef.current = openId;
  const refreshOpenChat = React.useCallback(async () => {
    const s = selRef.current;
    const oid = openIdRef.current;
    if (!s || !oid) return;
    try {
      const d = await fetchWorkerChat(s, oid);
      const next = Array.isArray(d?.messages) ? d.messages : null;
      if (next)
        setMsgs((prev) =>
          prev.length === next.length &&
          (next.length === 0 ||
            JSON.stringify(prev[prev.length - 1]) ===
              JSON.stringify(next[next.length - 1]))
            ? prev
            : next,
        );
    } catch {
      /* 静默——失败不打扰（下一轮再试） */
    }
    try {
      const r = await fetchWorkerChatStatus(s, oid);
      if (r?.status === "running" || r?.status === "idle")
        setStatus(r.status);
    } catch {
      /* 静默 */
    }
  }, []);
  React.useEffect(() => {
    if (!openId) return;
    const id = window.setInterval(() => void refreshOpenChat(), 4000);
    return () => window.clearInterval(id);
  }, [openId, refreshOpenChat]);
  // SSE 事件驱动主路：refreshTick 变化（room_message 等）→ 立即刷新。
  const tickRef = React.useRef(refreshTick);
  React.useEffect(() => {
    if (refreshTick === undefined) return;
    if (refreshTick !== tickRef.current) {
      tickRef.current = refreshTick;
      void refreshOpenChat();
    }
  }, [refreshTick, refreshOpenChat]);

  // 底部跟随（QwenPaw 对话框口径）：消息变化时——用户已在底部（近底
  // 100px 内）= 自动贴底；用户上翻看历史 = 不动（不打断阅读）。
  const nearBottomRef = React.useRef(true);
  const handleDetailScroll = React.useCallback(() => {
    const el = detailListRef.current;
    if (!el) return;
    nearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  }, []);
  React.useEffect(() => {
    if (detailLoading || !openId || !detailListRef.current) return;
    if (nearBottomRef.current) {
      detailListRef.current.scrollTop = detailListRef.current.scrollHeight;
    }
  }, [detailLoading, openId, msgs]);

  // 容器宽测量——**必须在所有早退 return 之前**（列表/详情/空态/gate 各
  // 视图 hook 数必须一致，否则 React #300 崩）。13.11 卡片列表后宽度
  // 阈值逻辑移除，ref 保留（hook 顺序 + 列表容器锚点）。
  const cwrapRef = React.useRef<HTMLDivElement | null>(null);

  // v0.5.0-beta.13.10（13.9 装验「从点开会话之后，经常显示无worker」
  // 真根因）：workers 列表来自 adminData（需要 Controller token）——
  // L1 账号密码登录只带 Higress Console 会话、不带 Controller token 时
  // adminData=null → workers=[] → 旧门恒「无 Worker」。fixedWorker 模式
  // （头像抽屉锁定单 Worker）不依赖列表，直接按名拉取，门只看列表
  // 选择器是否可用。
  if (workers.length === 0 && !fixedWorker) {
    return <antd.Alert type="info" showIcon message={tr("无 Worker")} />;
  }
  // fixedWorker 模式 + 列表为空：**不硬阻断**——adminData 是异步的，
  // 首次打开点头像可能早于管理数据加载完成（token 实际可用）。直接
  // 按 fixedWorker 拉取；真无 token 时 401/502 落到 gate=err 分支，
  // 由那里给出 token 明确指引（见下）。

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

  if (gate === "notoken") {
    // v0.5.0-beta.13.10：Controller token 缺失的明确指引（L1 账号密码
    // 登录只带 Higress Console 会话 ≠ Controller 管理 token）。
    return (
      <antd.Alert
        type="warning"
        showIcon
        message={tr("会话列表需要 Controller 管理员 token（当前账号未配置或不可达）")}
        description={tr(
          "L1 账号密码登录只带 Higress Console 会话（网关面），不含 Controller 管理 token（CRD/数据面）。请在 设置 → ① Controller 管理员 token 字段粘贴（部署宿主机取法：docker exec agentteams-controller cat /var/run/agentteams/cli-token）。",
        )}
        action={
          <antd.Button size="small" onClick={() => void load()}>
            {tr("重试")}
          </antd.Button>
        }
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
  const list = React.useMemo(() => {
    const arr = [...(tab === "active" ? active : archived)];
    arr.sort((a, b) => {
      if (sortKey === "name")
        return String(a.name || a.id).localeCompare(String(b.name || b.id));
      const key = sortKey === "created" ? "created_at" : "updated_at";
      return String(b[key] || "").localeCompare(String(a[key] || ""));
    });
    return arr;
  }, [tab, active, archived, sortKey]);
  const openChatSpec = openId
    ? chats.find((c) => c.id === openId)
    : undefined;

  // v0.5.0-beta.13.11（F8 QwenPaw 化：ResponseActions 同款复制——气泡
  // hover 显 ⧉，复制该条全部文本部分）。
  const copyParts = React.useCallback(
    async (parts: MsgPart[]) => {
      const txt = parts
        .filter((p) => p.kind === "text" || p.kind === "thinking")
        .map((p) => p.label)
        .join("\n");
      try {
        await navigator.clipboard.writeText(txt);
        antd.message.success(tr("已复制"));
      } catch {
        antd.message.error(tr("复制失败"));
      }
    },
    [tr],
  );

  // ── 详情视图（QwenPaw /chat/{id} 口径：列表让位，← 返回列表）──────
  // v0.5.0-beta.13.5：高度链改容器相对（#629 家规）——抽屉 body 是定高
  // flex 项，消息区 flex:1 + minHeight:0 自滚，不再写 420 魔法数（窗口
  // 矮时旧写法内容被抽屉底裁切且不可滚）。
  if (openId) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10, height: "100%", minHeight: 0 }}>
        {/* v0.5.0-beta.13.11（F8 QwenPaw 化）：气泡 hover 复制钮样式。 */}
        <style>{`
          .wb-chat-bubble .wb-copy {
            position: absolute;
            top: 2px;
            right: 2px;
            z-index: 1;
            cursor: pointer;
            font-size: 11px;
            line-height: 1;
            padding: 2px 4px;
            border-radius: 4px;
            color: rgba(127,127,127,0.7);
            background: rgba(255,255,255,0.9);
            border: 1px solid rgba(127,127,127,0.25);
            opacity: 0;
            transition: opacity 0.12s;
          }
          .wb-chat-bubble:hover .wb-copy { opacity: 1; }
          .wb-chat-bubble .wb-copy:hover { color: #1677ff; border-color: #1677ff; }
        `}</style>
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
          {/* v0.5.0-beta.13.10（13.9 装验「蓝点能不能改成 QwenPaw 同款
              灯」）：状态 Tag（蓝 tag/灰 tag）→ WorkerSessionDot——
              QwenPaw console AgentStatusIndicator 同款呼吸灯（组件
              既有：8px 圆点 + 1.2s 呼吸 + Tooltip + reduced-motion
              降级），与成员头像角落灯同一正源。 */}
          {status === "running" || status === "idle" ? (
            <span style={{ display: "inline-flex", alignItems: "center" }}>
              <WorkerSessionDot state={status} />
              <span style={{ fontSize: 11, marginLeft: 2, color: "rgba(127,127,127,0.9)" }}>
                {status === "running" ? tr("运行中") : tr("无任务")}
              </span>
            </span>
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
            onScroll={handleDetailScroll}
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
                      className="wb-chat-bubble"
                      style={{ display: "flex", justifyContent: "flex-end", alignItems: "flex-start", gap: 6, marginBottom: 8 }}
                    >
                      <div style={{ position: "relative" }}>
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
                                  <PictureIcon size={12} style={{ verticalAlign: "-1px", marginRight: 2 }} /> {p.label}
                                </div>
                              )
                            ) : (
                              <MdText key={j} text={p.label} maxLength={2000} />
                            )
                          )}
                        </div>
                        <span
                          className="wb-copy"
                          onClick={() => void copyParts(e.parts)}
                          title={tr("复制")}
                        >
                          ⧉
                        </span>
                      </div>
                      {/* v0.5.0-beta.13.11（F8 QwenPaw 化：HostBubbles 同款
                          Avatar 分侧——user 右 / assistant 左）。 */}
                      <antd.Avatar size="small" style={{ background: "#ff7f16", flexShrink: 0 }}>
                        <UserIcon size={12} style={{ color: "#fff" }} />
                      </antd.Avatar>
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
                      <WarnIcon size={12} style={{ verticalAlign: "-1px", marginRight: 2 }} /> {txt}
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
                    className="wb-chat-bubble"
                    style={{ display: "flex", justifyContent: "flex-start", alignItems: "flex-start", gap: 6, marginBottom: 8 }}
                  >
                    {/* v0.5.0-beta.13.11（F8 QwenPaw 化）：assistant 左 Avatar。 */}
                    <antd.Avatar size="small" style={{ background: "#1677ff", flexShrink: 0 }}>
                      <RobotIcon size={12} style={{ color: "#fff" }} />
                    </antd.Avatar>
                    <div style={{ position: "relative", flex: "0 1 auto", minWidth: 0 }}>
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
                              <span style={{ fontSize: 12 }}><PictureIcon size={12} style={{ verticalAlign: "-1px", marginRight: 2 }} /> {p.label}</span>
                            )}
                          </div>
                        ) : (
                          // QwenPaw assistant 文本=markdown 渲染（原始输出原样）。
                          <MdText key={j} text={p.label} maxLength={4000} />
                        )
                      )}
                      </div>
                      <span
                        className="wb-copy"
                        onClick={() => void copyParts(e.parts)}
                        title={tr("复制")}
                      >
                        ⧉
                      </span>
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
  // v0.5.0-beta.13.11（13.10 装验 E1 定案「卡片化是会话列表」）：
  // antd.Table → 卡片列表——Table fixed 布局在窄容器被挤压（查看列
  // 裁切，13.8 已三次压列宽打地鼠）。卡片口径参照 dashboard
  // worker-chats-panel：整卡可点进详情、全名/全 session_id 换行
  // 不裁切、窄容器抗挤压；Table sorter 能力保留为排序下拉。
  const emptyText =
    tab === "active"
      ? tr("当前账号在此 Worker 的可见范围内没有活跃会话（L2 仅自己所在房间）")
      : tr("没有已归档会话");

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
        <antd.Select
          size="small"
          style={{ width: 128 }}
          value={sortKey}
          onChange={(v: "updated" | "created" | "name") => setSortKey(v)}
          options={[
            { value: "updated", label: tr("最后活动 ↓") },
            { value: "created", label: tr("创建 ↓") },
            { value: "name", label: tr("名称 A-Z") },
          ]}
        />
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
        }}
        items={[
          { key: "active", label: `${tr("活跃")} (${active.length})` },
          { key: "archived", label: `${tr("已归档")} (${archived.length})` },
        ]}
      />

      <div ref={cwrapRef} style={{ minWidth: 0 }}>
        {loading && chats.length === 0 ? (
          <antd.Spin size="small" />
        ) : list.length === 0 ? (
          <antd.Alert type="info" showIcon message={emptyText} />
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {list.map((c) => {
              const full = c.name || c.id.slice(0, 10);
              // v0.5.0-beta.13.12（13.11 装验「状态点没看见」）：此前灯只在
              // running 时渲染（idle/done 无点）——盘上会话多为 idle → 恒不见。
              // 改恒显 WorkerSessionDot（与详情头/成员头像角灯同一正源：
              // idle 灰常亮 / running 蓝呼吸，含 Tooltip；/chats 的
              // status 二值 idle|running 直接映射）。
              const dotState: "running" | "idle" =
                c.status === "running" ? "running" : "idle";
              return (
                <div
                  key={c.id}
                  onClick={() => void openChat(c.id)}
                  style={{
                    border: "1px solid rgba(127,127,127,0.25)",
                    borderRadius: 8,
                    padding: "8px 10px",
                    cursor: "pointer",
                    background: "rgba(127,127,127,0.03)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      minWidth: 0,
                    }}
                  >
                    <WorkerSessionDot state={dotState} size={8} />
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: 12.5,
                        wordBreak: "break-word",
                        whiteSpace: "normal",
                        flex: "1 1 auto",
                        minWidth: 0,
                      }}
                    >
                      {full}
                    </span>
                    {c.pinned ? (
                      <antd.Tag
                        color="gold"
                        style={{ marginInlineEnd: 0, flexShrink: 0 }}
                      >
                        {tr("置顶")}
                      </antd.Tag>
                    ) : null}
                    {c.archived ? (
                      <antd.Tag style={{ marginInlineEnd: 0, flexShrink: 0 }}>
                        {tr("已归档")}
                      </antd.Tag>
                    ) : null}
                    <antd.Button
                      size="small"
                      type="link"
                      style={{
                        padding: "0 2px",
                        color: "#52c41a",
                        fontSize: 12,
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                      }}
                      onClick={(e: ReactNS.MouseEvent) => {
                        e.stopPropagation();
                        void openChat(c.id);
                      }}
                    >
                      {tr("查看")}
                    </antd.Button>
                  </div>
                  <div
                    style={{
                      fontSize: 10.5,
                      fontFamily:
                        "ui-monospace, SFMono-Regular, Consolas, monospace",
                      color: "rgba(127,127,127,0.85)",
                      wordBreak: "break-all",
                      marginTop: 3,
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      gap: "2px 10px",
                    }}
                  >
                    <span>{c.session_id || c.id}</span>
                    {c.channel ? (
                      <antd.Tag
                        color={CHANNEL_COLORS[c.channel] || "default"}
                        style={{ marginInlineEnd: 0, fontFamily: "inherit" }}
                      >
                        {CHANNEL_LABELS[c.channel] || c.channel}
                      </antd.Tag>
                    ) : null}
                    {c.updated_at ? (
                      <span style={{ fontFamily: "inherit" }}>
                        {formatTime(c.updated_at)}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default WorkerChats;
