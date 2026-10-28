import type * as ReactNS from "react";
import {
  downloadViaHost,
  resolveFileTarget,
  type RoomMessage,
  type TeamRoom,
} from "../api";
import { useMediaObjectUrl } from "../useMediaObjectUrl";
import { MxcAvatar } from "../MxcAvatar";
import MdText from "./MdText";
import {
  FilePreview,
  type PreviewFile,
} from "./FilePreview";
import { ActionBtn } from "./ActionBtn";
import WorkflowCard from "./WorkflowCard";
import { type WorkflowEvent } from "../api";
import {
  useThemeColors,
  readThemeColors,
} from "../theme";
import { useT } from "../i18n";
import { isQwenpawOnlyDisabled } from "../runtimeGuard";
import { formatSize } from "../util";
import {
  CheckIcon,
  CloseIcon,
  ClipIcon,
  PictureIcon,
  WrenchIcon,
  ShieldIcon,
  DocIcon,
  MessageIcon,
} from "./icons";
import WorkerSessionDot from "./WorkerSessionDot";
import { type WorkerSessionState } from "../workerSessionState";
import { WbTooltip } from "./WbTooltip";
import {
  CARD_RADIUS,
  PRIMARY,
  isToolMessage,
  parseApproval,
  senderShortName,
  toolNameOf,
} from "./RoomChatShared";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
// 宿主 antdIcons 可能非全量（部署版 vs SC main 差异）——缺图标降级为空组件，
// 避免 React #130（undefined 组件）拖垮聊天室。
const icons = (host.antdIcons || {}) as Record<string, ReactNS.ComponentType>;
const EmptyIcon = (() => null) as unknown as ReactNS.FC<Record<string, unknown>>;
const icon = (name: string): ReactNS.FC<Record<string, unknown>> =>
  (icons[name] as ReactNS.FC<Record<string, unknown>>) || EmptyIcon;
const DownloadOutlined = icon("DownloadOutlined");
const EyeOutlined = icon("EyeOutlined");
const FileOutlined = icon("FileOutlined");
const FileTextOutlined = icon("FileTextOutlined");
/** 引用回复折叠条（Element 同款：左竖色条 + 16px 小头像 + 着色名字 + 单行预览；
 * 点击滚动定位原消息并高亮闪烁，不再内联展开副本）。
 * （13.12 「很多信息『已滚出历史』但 Element 里信息
 * 都在」）：原消息不在已加载窗口时不再标死「已滚出历史」——对齐 Element
 * 按需加载语义（R2 显式跳转）：显示可点的「加载原消息」→ 显式循环串行
 * 向前分页直到原消息进窗口（onLoadOriginal，限页上限）→ 定位+高亮；
 * 成功引用条自动转为正常态（可点定位）；到上限仍无 → 落 /context 定位区
 * 兜底（onJump 现有链路）并标「原消息不在可加载历史」。 */
function ReplyBanner({
  msg,
  room,
  messages,
  onJump,
  onLoadOriginal,
  pendingOriginal,
}: {
  msg: RoomMessage;
  room: TeamRoom | null;
  messages: RoomMessage[];
  onJump: (eventId: string) => void;
  onLoadOriginal?: (
    eventId: string,
  ) => Promise<"found" | "exhausted" | "cancelled">;
  /** 该引用条正是正在滚动回填的目标。 */
  pendingOriginal?: string | null;
}) {
  const t = useThemeColors();
  const tr = useT();
  const reply = msg.reply;
  const [loadState, setLoadState] = React.useState<
    "idle" | "loading" | "notfound"
  >("idle");
  React.useEffect(() => {
    // 换引用目标（同组件实例复用）时复位。
    setLoadState("idle");
  }, [reply?.event_id]);
  if (!reply) return null;
  // 原消息在已加载历史里 → 渲染原消息内容缩略（Element ReplyTile 同款：
  // 文本截断 / 图片缩略 / 文件图标名 / 工具消息名）；否则用 fallback 摘要。
  const original = messages.find((m) => m.event_id === reply.event_id);
  const senderName = reply.sender
    ? senderShortName(reply.sender, room)
    : original
      ? senderShortName(original.sender, room)
      : tr("消息");
  let summary = "";
  let summaryIcon: ReactNS.ReactNode = null;
  if (original) {
    if (original.msgtype === "m.image") {
      summaryIcon = <PictureIcon size={12} style={{ verticalAlign: "-1px", marginRight: 2 }} />;
      summary = "图片";
    } else if (original.msgtype === "m.file") {
      summaryIcon = <ClipIcon size={12} style={{ verticalAlign: "-1px", marginRight: 2 }} />;
      summary = original.filename || original.body || "文件";
    } else if (isToolMessage(original.body || "")) {
      summaryIcon = <WrenchIcon size={12} style={{ verticalAlign: "-1px", marginRight: 2 }} />;
      summary = toolNameOf(original.body || "") || original.body;
    } else {
      summary = (original.body || "").replace(/\n+/g, " ").slice(0, 120);
    }
  } else {
    summary = (reply.body || "").replace(/\n+/g, " ").slice(0, 120);
  }
  return (
    <div
      onClick={() => {
        // 跳转修复（用户真机报「消息点击不跳转」根因）：
        // 此前误传 reply.event_id（=被点击消息自身）→ 滚动回原地看似无反应。
        // 应为 original.event_id（被引用的原消息）。
        if (original) onJump(original.event_id);
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 3,
        maxWidth: 560,
        cursor: original ? "pointer" : "default",
        borderLeft: `4px solid ${PRIMARY}`,
        borderRadius: "0 8px 8px 0",
        background: t.toolBg,
        padding: "4px 10px",
        fontSize: 12.5,
        color: t.textSecondary,
      }}
      title={original ? tr("点击定位原消息") : tr("原消息不在当前加载范围内")}
    >
      <antd.Avatar size={16} style={{ backgroundColor: PRIMARY, fontSize: 10, flexShrink: 0 }}>
        {(senderName || "?").slice(0, 1).toUpperCase()}
      </antd.Avatar>
      <span style={{ color: t.textSecondary, flexShrink: 0 }}>回复</span>
      <span style={{ color: PRIMARY, fontWeight: 600, flexShrink: 0 }}>
        {senderName}
      </span>
      <span style={{ color: "#bbb", flexShrink: 0 }}>：</span>
      <span
        style={{
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {summaryIcon}
        {summary || "…"}
      </span>
      {original ? (
        <span style={{ fontSize: 11, color: "#aaa", flexShrink: 0 }}>↗</span>
      ) : loadState === "loading" || pendingOriginal === reply.event_id ? (
        <span style={{ fontSize: 11, color: PRIMARY, flexShrink: 0 }}>
          {tr("正在加载原消息…")}
        </span>
      ) : loadState === "notfound" ? (
        <span style={{ fontSize: 11, color: "#ccc", flexShrink: 0 }}>
          {tr("原消息不在可加载历史")}
        </span>
      ) : (
        <span
          style={{
            fontSize: 11,
            color: onLoadOriginal ? PRIMARY : "#ccc",
            cursor: onLoadOriginal ? "pointer" : "default",
            textDecoration: onLoadOriginal ? "underline" : "none",
            flexShrink: 0,
          }}
          title={
            onLoadOriginal
              ? tr("开始按需加载，自动翻页定位到原消息")
              : undefined
          }
          onClick={async (e) => {
            if (!onLoadOriginal) return;
            e.stopPropagation();
            setLoadState("loading");
            const r = await onLoadOriginal(reply.event_id);
            if (r === "exhausted") {
              // 到底仍无 → 现有 /context 定位区兜底（不丢信息）。
              setLoadState("notfound");
              onJump(reply.event_id);
            } else if (r === "cancelled") {
              // 换目标/切房 → 回 idle（可再点）。
              setLoadState("idle");
            }
            // found：原消息进窗口 → 本条自动转正常态（上方 original 分支）。
          }}
        >
          {onLoadOriginal ? tr("加载原消息") : tr("已滚出历史")}
        </span>
      )}
    </div>
  );
}

/** memo——props：msg/room 稳定引用；
 * messages（visibleMessages）每数据变才新；onJump=handleSearchJump
 * （useCallback，直接传不再包内联箭头）；onLoadOriginal 父侧稳定。 */
export const ReplyBannerMemo = React.memo(ReplyBanner);

/** 表情反应 chips（emoji + 计数，点击追加同款反应）。
 * eventId 提为 prop + 父侧传稳定双参
 * 回调（(eventId, emoji)）+ memo——此前父侧每次渲染为每行内联闭包
 * （捕获 event_id），memo 无法生效。 */
export const ReactionChips = React.memo(function ReactionChips({
  reactions,
  eventId,
  onReact,
}: {
  reactions?: Record<string, number>;
  eventId: string;
  onReact?: (eventId: string, emoji: string) => void;
}) {
  if (!reactions || Object.keys(reactions).length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 3 }}>
      {Object.entries(reactions).map(([emoji, count]) => (
        <span
          key={emoji}
          onClick={onReact ? () => onReact(eventId, emoji) : undefined}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            padding: "1px 8px",
            borderRadius: 10,
            background: "color-mix(in srgb, var(--app-accent, #FF7F16) 10%, transparent)",
            border: "1px solid color-mix(in srgb, var(--app-accent, #FF7F16) 35%, transparent)",
            fontSize: 12,
            cursor: onReact ? "pointer" : "default",
          }}
        >
          {emoji} {count > 1 ? count : ""}
        </span>
      ))}
    </div>
  );
});

/** 发送者头像（5.0.0-beta.4：左键点击弹层=@提及/Worker 配置/私聊；
 * 右键菜单保留：@提及 / 私聊 / 复制 MXID，Element 头像交互同款）。 */
function SenderAvatar({
  mxid,
  room,
  myUserId,
  onMention,
  onDm,
  workerName,
  onDetail,
  sessionState,
  onOpenChats,
  workerRuntime,
}: {
  mxid: string;
  room: TeamRoom | null;
  myUserId: string;
  onMention: (mxid: string) => void;
  onDm?: (mxid: string, roomId?: string) => void;
  /** Worker 容器名（有值=Worker 成员，弹层出「Worker 配置」）。 */
  workerName?: string;
  /** 打开成员详情卡（含审批卡）。 */
  onDetail?: (mxid: string) => void;
 /** （头像角落灯）：该发送者的 session 状态——有值才显灯
 * （人类/未知发送者无映射 → 不显）。 */
  sessionState?: WorkerSessionState;
  /** 打开该 Worker 的会话抽屉（完整 session，只读）。 */
  onOpenChats?: (workerName: string) => void;
  /** ：该 Worker 的 runtime——非 qwenpaw 时
 * 隐藏「查看会话」入口（worker chats 是 qwenpaw 独有面）。 */
  workerRuntime?: string;
}) {
  const tr = useT();
  const [popOpen, setPopOpen] = React.useState(false);
  const name = senderShortName(mxid, room);
  const member = room?.members?.[mxid];
  const isMe = mxid === myUserId;
  // 左键点击弹层（需求：「点击头像可以@和改 worker 配置」）
  // worker chats 是 QwenPaw 独有面——非
  // qwenpaw runtime 隐藏「查看会话」入口（runtime 未知=放行不误伤）。
  const chatsGated = workerName && onOpenChats && !isQwenpawOnlyDisabled(workerRuntime);
  const quick: Array<{ label: ReactNS.ReactNode; act: () => void }> = [];
  if (chatsGated) {
    quick.push({
      label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><MessageIcon size={13} /> {tr("查看会话")}</span>,
      act: () => onOpenChats(workerName),
    });
  }
  if (!isMe) {
    quick.push({
      label: `@ ${tr("提及")} ${name}`,
      act: () => onMention(mxid),
    });
  }
  if (workerName && onDetail) {
    quick.push({
      label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><ShieldIcon size={13} /> {tr("Worker 配置（审批模式）")}</span>,
      act: () => onDetail(mxid),
    });
  }
  if (!isMe && onDm) {
    quick.push({
      label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><MessageIcon size={13} /> {tr("私聊")} {name}</span>,
      act: () => onDm(mxid),
    });
  }
  // 复制 MXID——原本只在右键菜单（触屏无右键）；并入 tap 可达的
  // quick 面板（P4 收口：右键菜单唯一独有功能补齐）。
  quick.push({
    label: tr("复制 MXID"),
    act: () => {
      void navigator.clipboard?.writeText(mxid).then(
        () => host.antd.message?.success(tr("已复制")),
        () => host.antd.message?.error(tr("复制失败")),
      );
    },
  });
  const items = [
    ...(!isMe
      ? [
          {
            key: "mention",
            label: `@ ${tr("提及")} ${name}`,
            onClick: () => onMention(mxid),
          },
        ]
      : []),
    ...(!isMe && onDm
      ? [
          {
            key: "dm",
            label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><MessageIcon size={13} /> {tr("私聊")} {name}</span>,
            onClick: () => onDm(mxid),
          },
        ]
      : []),
    ...(chatsGated
      ? [
          {
            key: "chats",
            label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><MessageIcon size={13} /> {tr("查看会话")}</span>,
            onClick: () => onOpenChats(workerName),
          },
        ]
      : []),
    {
      key: "copy",
      label: tr("复制 MXID"),
      onClick: () => {
        void navigator.clipboard.writeText(mxid).catch(() => undefined);
      },
    },
  ];
  return (
    <antd.Dropdown menu={{ items }} trigger={["contextMenu"]}>
      <antd.Popover
        open={quick.length > 0 ? popOpen : false}
        onOpenChange={(o: boolean) => setPopOpen(o)}
        trigger={["click"]}
        content={
          quick.length > 0 ? (
            <div style={{ display: "grid", gap: 2, minWidth: 170 }}>
              {quick.map((q) => (
                <antd.Button
                  key={q.label}
                  type="text"
                  size="small"
                  style={{
                    width: "100%",
                    justifyContent: "flex-start",
                    padding: "2px 8px",
                    whiteSpace: "nowrap",
                  }}
                  onClick={() => {
                    setPopOpen(false);
                    q.act();
                  }}
                >
                  {q.label}
                </antd.Button>
              ))}
            </div>
          ) : undefined
        }
      >
 {/* （灯在头像角落）：relative 容器 + 角落状态灯。 */}
        <span style={{ position: "relative", display: "inline-flex" }}>
          <MxcAvatar
            url={member?.avatar_url}
            size={28}
            style={{
              backgroundColor: PRIMARY,
              fontSize: 13,
              flexShrink: 0,
              cursor: quick.length > 0 ? "pointer" : "default",
            }}
          >
            {name.slice(0, 1).toUpperCase()}
          </MxcAvatar>
          {sessionState ? (
            <WorkerSessionDot
              state={sessionState}
              size={7}
              corner
            />
          ) : null}
        </span>
      </antd.Popover>
    </antd.Dropdown>
  );
}

/** memo——每行一个 antd.Dropdown +
 * antd.Popover（重组件）。props 全稳定：mxid/myUserId/workerName
 * 字符串；room 每房稳定；onMention=insertMention（useCallback）；
 * onDm 父侧稳定；onDetail/onOpenChats 本组件 useCallback；
 * sessionState 随 workerSessionByMxid（值稳定化）才变。 */
export const SenderAvatarMemo = React.memo(SenderAvatar);

/** 工具消息：默认折叠一行（工具名 + 预览），点击展开全文（QwenPaw 聊天页同款）。 */
/** ：对齐 QwenPaw
 * ResponseTool 卡——状态识别（🔧 调用中 / ✅ 成功 / ❌ 失败，名称着色）+
 * 展开后分区展示（调用=参数区 / 输出=结果区，失败红色调），替代 13.6 的
 * 无状态行 + 整段 RAW pre。Matrix 工具消息格式（bridge 口径）：
 * 调用 `🔧 **name**` + args；输出 `✅ **name**:` + 结果；失败 `❌ **name**:`。 */
function ToolBubble({ msg, mine }: { msg: RoomMessage; mine: boolean }) {
  const t = useThemeColors();
  const tr = useT();
  const [open, setOpen] = React.useState(false);
  const body = msg.body || "";
  // body 派生缓存——流式期父行重渲染
  // 不再重跑 split/join/replace 串处理（工具输出 body 可达数百行）。
  const derived = React.useMemo(() => {
    const firstLine = body.split("\n")[0] || tr("工具调用");
    const head = firstLine.trimStart();
    const status: "call" | "ok" | "fail" = head.startsWith("✅")
      ? "ok"
      : head.startsWith("❌")
        ? "fail"
        : "call";
    // 预览：第一行后的内容前 80 字符（输出消息的实质内容）。
    const rest = body
      .split("\n")
      .slice(1)
      .join(" ")
      .replace(/```/g, "")
      .trim()
      .slice(0, 80);
    const detail = body.split("\n").slice(1).join("\n").trim();
    return { firstLine, name: toolNameOf(body), head, status, rest, detail };
  }, [body, tr]);
  const { firstLine, name, status, rest, detail } = derived;
  const statusIcon = status === "ok" ? (
    <CheckIcon size={12} style={{ color: "#30a46c" }} />
  ) : status === "fail" ? (
    <CloseIcon size={12} style={{ color: "#e5484d" }} />
  ) : (
    <WrenchIcon size={12} />
  );
  const nameColor =
    status === "fail" ? "#e5484d" : status === "ok" ? "#30a46c" : t.textSecondary;
  return (
    <div
      onClick={() => setOpen((v) => !v)}
      style={{
        cursor: "pointer",
        padding: "4px 10px",
        borderRadius: CARD_RADIUS,
        background: mine ? t.bubbleMine : t.toolBg,
        fontSize: 12.5,
        maxWidth: 560,
        color: t.textSecondary,
      }}
      title={open ? tr("收起") : tr("点击展开工具调用详情")}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ flexShrink: 0, fontSize: 12 }}>{statusIcon}</span>
        <span
          style={{
            fontFamily: "monospace",
            fontSize: 12,
            fontWeight: 600,
            color: nameColor,
            flexShrink: 0,
          }}
        >
          {name || firstLine.slice(0, 40)}
        </span>
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: t.textSecondary,
          }}
        >
          {rest}
        </span>
        <span style={{ color: "#bbb", fontSize: 11, flexShrink: 0 }}>
          {open ? "▲" : "▼"}
        </span>
      </div>
      {open && detail ? (
        <div style={{ margin: "6px 0 0" }}>
          <div
            style={{
              fontSize: 10.5,
              color: "rgba(127,127,127,0.9)",
              marginBottom: 3,
            }}
          >
            {status === "call" ? tr("参数") : status === "fail" ? tr("错误") : tr("结果")}
          </div>
          <pre
            style={{
              margin: 0,
              padding: "8px 10px",
              background:
                status === "fail" ? "rgba(229,72,77,0.06)" : "rgba(127,127,127,0.08)",
              border:
                status === "fail"
                  ? "1px solid rgba(229,72,77,0.3)"
                  : "1px solid rgba(127,127,127,0.2)",
              color: status === "fail" ? "#a13336" : t.textSecondary,
              borderRadius: 6,
              fontSize: 12,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              maxHeight: 420,
              overflow: "auto",
            }}
          >
            {detail}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

/** 消息渲染防线：子组件崩溃时降级为纯文本，不拖垮整个聊天室。 */
export class BubbleBoundary extends React.Component<
  { fallback: string; children?: ReactNS.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div
          style={{
            fontSize: 12,
            color: readThemeColors().textSecondary,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxWidth: 520,
          }}
        >
          {this.props.fallback}
        </div>
      );
    }
    return this.props.children ?? null;
  }
}

/** 消息气泡主体：文本 / 图片 / 文件 / 审批卡片 / 其他。 */
function MessageBody({
  msg,
  mine,
  onApprovalAction,
  approvalResolved,
  onDeliverable,
  onOpenProject,
  onWorkflowIntervened,
  live,
  fileRefTeam,
}: {
  msg: RoomMessage;
  mine: boolean;
  /** 当前房间的 team 名（#87 文件引用 chip 点击预览走 team-file 端点；
 * 非团队房间/推不出 team 时缺省，chip 不渲染）。 */
  fileRefTeam?: string | null;
  onApprovalAction?: (
    msg: RoomMessage,
    action: "approve" | "deny",
  ) => void;
  approvalResolved?: "approve" | "deny" | null;
  /** 产物验收：accept=接受交付；revise=提出修改意见（text 非空）。 */
  onDeliverable?: (
    msg: RoomMessage,
    action: "accept" | "revise",
    text?: string,
  ) => void;
  /** workflow 卡片点击 → 工作流 tab 选中该项目。 */
  onOpenProject?: (runId: string) => void;
  /** workflow 卡片干预成功 → 刷新工作流。 */
  onWorkflowIntervened?: () => void;
  /** 项目文件面板（）：顶部 📁 按钮 → 抽屉。 */
  onOpenProjectFiles?: (room: TeamRoom) => void;
  /** ：该卡片 runId 对应的 live 工作流事件
 * （controller 正源，15s 轮询）→ 卡片状态/步骤/Worker 实时 overlay。 */
  live?: WorkflowEvent | null;
}) {
  const tr = useT();
  const t = useThemeColors();
  // 文件地址统一解析（m.image/m.file 共用）——mxc → 媒体代理
  // apiPath（fetch 必须走 host.fetch 带鉴权；裸插件路径落 SPA 兜底返回
  // index.html 壳 = 「内容是网页」根因）。fileSrc 供 img src /
  // a href（裸导航带不了鉴权头，只能 objectURL）。
  const fileTarget = React.useMemo(
    () => (msg.url ? resolveFileTarget(msg.url) : { url: "" }),
    [msg.url],
  );
  const fileSrc = useMediaObjectUrl(fileTarget.apiPath, fileTarget.url);
  // m.file 分支的 state 上提组件顶部——hooks 禁止在分支内
  // 条件调用：撤回（redaction）让同一事件改走 redacted 早退分支，
  // 分支 hook 数量变化 → React #310（Rendered fewer hooks than expected）
  // 崩掉整个消息列表。上提后所有 msgtype 分支 hook 数量恒定。
  const [previewFile, setPreviewFile] = React.useState<PreviewFile | null>(null);
  const [revising, setRevising] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [accepted, setAccepted] = React.useState(false);
  // 撤回消息（redaction）——固定提示替代原内容（Element
  // 同款「This message was redacted」；优先级最高，workflow/审批/文件全不渲染）。
  if (msg.redacted) {
    return (
      <span style={{ color: t.textSecondary, fontStyle: "italic", fontSize: 13 }}>
        {tr("这条消息已被撤回")}
      </span>
    );
  }
  // workflow 卡片（dashboard normalize 规则 1 同款优先级=最高）：
  // content.agentteams.workflow 载荷 → 交互卡片（项目名/状态/步骤进度/干预按钮）。
  if (msg.workflow) {
    return (
      <WorkflowCard
        payload={msg.workflow}
        body={msg.body || undefined}
        live={live ?? null}
        onOpenProject={onOpenProject}
        onIntervened={onWorkflowIntervened}
      />
    );
  }
  // 审批通知（非自己发的文本消息）：渲染审批卡片替代裸文本。
  const approval =
    !mine && msg.msgtype === "m.text" && !msg.pending
      ? parseApproval(msg.body || "")
      : null;
  if (approval) {
    const body = msg.body || "";
    const sevMatch = /Severity\s*[:：]\s*(?:🔴|🟡|🟢|🟠)?\s*([A-Za-z]+)/i.exec(
      body,
    );
    const toolMatch = /Tool\s*[:：]\s*`?([^`\n*]+?)`?[\s*]*(?:$|\n)/i.exec(body);
    const severity = sevMatch?.[1]?.toUpperCase() || "MEDIUM";
    const sevColor =
      severity === "CRITICAL" || severity === "HIGH"
        ? "#f5222d"
        : severity === "MEDIUM"
          ? "#fa8c16"
          : "#52c41a";
    const resolved = approvalResolved || null;
    return (
      <div
        style={{
          border: `1px solid ${resolved ? "#d9d9d9" : sevColor}`,
          borderRadius: CARD_RADIUS,
          padding: "10px 14px",
          maxWidth: 420,
          background: resolved ? "rgba(0,0,0,0.03)" : "rgba(255,255,255,0.6)",
          opacity: resolved ? 0.7 : 1,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 6,
          }}
        >
          <ShieldIcon size={16} />
          <span style={{ fontWeight: 600, fontSize: 14 }}>
            {toolMatch?.[1]?.trim() || tr("工具调用审批")}
          </span>
          <antd.Tag
            color={resolved ? undefined : sevColor}
            style={{ margin: 0, fontSize: 12 }}
          >
            {severity}
          </antd.Tag>
          {resolved ? (
            <span style={{ fontSize: 12, color: "#888" }}>
              {resolved === "approve" ? tr("已批准") : tr("已拒绝")}
            </span>
          ) : null}
        </div>
        <div
          style={{
            fontSize: 12,
            color: t.textSecondary,
            maxHeight: 96,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            marginBottom: 8,
          }}
        >
          {body.slice(0, 600)}
        </div>
        {resolved ? null : (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <antd.Button
              size="small"
              style={{
                backgroundColor: "#52c41a",
                borderColor: "#52c41a",
                color: "#fff",
              }}
              onClick={() => onApprovalAction?.(msg, "approve")}
            >
              <CheckIcon size={12} style={{ verticalAlign: "-1px" }} /> {tr("批准")}
            </antd.Button>
            <antd.Button
              size="small"
              danger
              onClick={() => onApprovalAction?.(msg, "deny")}
            >
              <CloseIcon size={12} style={{ verticalAlign: "-1px" }} /> {tr("拒绝")}
            </antd.Button>
            <span style={{ fontSize: 11, color: "#bbb", alignSelf: "center" }}>
              {tr("将发送 @{name} {cmd}", {
                name: (msg.sender.split(":")[0] || "").replace(/^@/, ""),
                cmd: approval.approveCmd,
              })}
            </span>
          </div>
        )}
      </div>
    );
  }
  if (msg.msgtype === "m.image" && msg.url) {
    // mxc 走 host.fetch blob → objectURL（img src 裸导航带不了
    // 鉴权头，会落 SPA 兜底/401）；http 直链原样。
    const thumb = fileSrc;
    return (
      <div style={{ display: "grid", gap: 6 }}>
        <img
          src={thumb}
          alt={msg.body || tr("图片")}
          loading="lazy"
          style={{
            maxWidth: 320,
            maxHeight: 240,
            borderRadius: 8,
            objectFit: "cover",
            cursor: "pointer",
            border: mine ? "1px solid color-mix(in srgb, var(--app-accent, #FF7F16) 25%, transparent)" : "1px solid rgba(0,0,0,0.06)",
          }}
          onClick={() => thumb && window.open(thumb, "_blank")}
        />
        <div style={{ fontSize: 12, color: "#999" }}>
          {msg.body || tr("图片")} · {tr("点击预览")} /{" "}
          <a href={thumb} download={msg.body || "image"} style={{ color: PRIMARY }}>
            下载
          </a>
        </div>
      </div>
    );
  }
  if (msg.msgtype === "m.file" && msg.url) {
    // fileTarget（mxc→媒体代理 apiPath+解析 URL，http 直链→原样）；
    // 预览/下载走 host 鉴权链，不再裸路径。
    // 直链也带 apiPath（media/proxy 服务端代抓绕 CORS）
    // → 下载统一走 host.fetch blob（跨域 a[download] 会变导航）。
    const url = fileTarget.url;
    // 尺寸取自 msg.size（映射补的 content.info.size——
    // 此前 formatSize(msg.info) 传对象恒 ""，文件卡尺寸从未显示过）。
    const sizeLine = [formatSize(msg.size), msg.mimetype].filter(Boolean).join(" · ");
    return (
      <div
        style={{
          display: "grid",
          gap: 8,
          padding: "10px 12px",
          borderRadius: 10,
          background: t.cardBg,
          border: `1px solid ${t.border}`,
          minWidth: 220,
          maxWidth: 360,
        }}
      >
        {/* 文件卡：名称行(icon+名/尺寸) + 操作行(下载/查看右对齐) 分两行——
  窄屏 376 单行被挤，拆两行让文件名吃满宽度。 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              background: "color-mix(in srgb, var(--app-accent, #FF7F16) 10%, transparent)",
              display: "grid",
              placeItems: "center",
              flexShrink: 0,
            }}
          >
            <FileOutlined style={{ fontSize: 20, color: PRIMARY }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <WbTooltip
              title={(msg.filename || msg.body || tr("附件")).length > 19 ? msg.filename || msg.body : undefined}
            >
              <div
                style={{
                  fontWeight: 600,
                  fontSize: 13,
                  // 窄屏文件名换行（不 ellipsis 截断——完整可见）。
                  whiteSpace: "normal",
                  wordBreak: "break-word",
                }}
              >
                {msg.filename || msg.body || tr("附件")}
              </div>
            </WbTooltip>
            {sizeLine ? (
              <div style={{ fontSize: 12, color: t.textSecondary }}>{sizeLine}</div>
            ) : null}
          </div>
          </div>
          {/* 操作行：下载/查看 右对齐（从名称行拆出，窄屏不挤）。 */}
          <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end" }}>
          {/* 插件路径走 host.fetch blob 下载（带鉴权）；
 直链经代抓同样有 apiPath → 全类型统一
 host 链（跨域 a[download] 会变导航）。url 为空时不渲染
 href（href="" 点击会重载当前页面）。 */}
          {/* 消息文件卡操作统一 ActionBtn（图标+文字+可见规格）。 */}
          <ActionBtn
            icon={<DownloadOutlined />}
            label={tr("下载")}
            href={fileTarget.apiPath ? undefined : url || undefined}
            disabled={!url && !fileTarget.apiPath}
            download={msg.filename || msg.body || "file"}
            onClick={
              fileTarget.apiPath
                ? (e) => {
                    e.preventDefault();
                    void (async () => {
                      const ok = await downloadViaHost(
                        fileTarget.apiPath as string,
                        msg.filename || msg.body || "file",
                      );
                      if (!ok) antd.message.error("下载失败，请稍后重试");
                    })();
                  }
                : undefined
            }
          />
          <ActionBtn
            icon={<EyeOutlined />}
            label={tr("查看")}
            onClick={() =>
              setPreviewFile({
                name: msg.filename || msg.body || "file",
                url,
                apiPath: fileTarget.apiPath,
                mimeType: msg.mimetype,
                // size 激活预览大小守卫；rawUrl 进预览
                // 错误态（失败时可见原值+状态码，截图即可定位）。
                rawUrl: fileTarget.rawUrl,
                ...(typeof msg.size === "number" ? { size: msg.size } : {}),
              })
            }
          />
          </div>
        </div>
        {/* 产物验收（Phase 4 交付闭环）：Agent 交付的 m.file 消息
 带验收按钮——接受发确认，修改意见弹输入。 */}
        {!mine && onDeliverable ? (
          accepted ? (
            <div style={{ fontSize: 12, color: "#52c41a" }}>
              <CheckIcon size={12} style={{ color: "#52c41a", verticalAlign: "-1px" }} /> {tr("已接受")}
            </div>
          ) : revising ? (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <antd.Input
                size="small"
                value={note}
                autoFocus
                placeholder={tr("修改意见…")}
                onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                  setNote(e.target.value)
                }
                onKeyDown={(e: ReactNS.KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === "Enter") {
                    onDeliverable(msg, "revise", note.trim() || undefined);
                    setRevising(false);
                    setNote("");
                  }
                  if (e.key === "Escape") setRevising(false);
                }}
                style={{ flex: 1, fontSize: 12 }}
              />
              <antd.Button
                size="small"
                type="primary"
                style={{ backgroundColor: PRIMARY, borderColor: PRIMARY }}
                onClick={() => {
                  onDeliverable(msg, "revise", note.trim() || undefined);
                  setRevising(false);
                  setNote("");
                }}
              >
                {tr("发送")}
              </antd.Button>
              <antd.Button size="small" onClick={() => setRevising(false)}>
                {tr("取消")}
              </antd.Button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 6 }}>
              <antd.Button
                size="small"
                style={{
                  backgroundColor: "#52c41a",
                  borderColor: "#52c41a",
                  color: "#fff",
                }}
                onClick={() => {
                  onDeliverable(msg, "accept");
                  setAccepted(true);
                }}
              >
                <CheckIcon size={12} style={{ verticalAlign: "-1px" }} /> {tr("接受")}
              </antd.Button>
              <antd.Button size="small" onClick={() => setRevising(true)}>
                <DocIcon size={12} style={{ verticalAlign: "-1px" }} /> {tr("修改意见")}
              </antd.Button>
            </div>
          )
        ) : null}
        <FilePreview file={previewFile} onClose={() => setPreviewFile(null)} />
      </div>
    );
  }
  if (msg.msgtype !== "m.text") {
    return (
      <div style={{ color: t.textSecondary, fontSize: 13 }}>
        [{msg.msgtype.replace(/^m\./, "")}] {msg.body || ""}
      </div>
    );
  }
  // Agent 工具调用显示（TeamHarness 格式：🔧 tool_name）→ 折叠一行，
  // 点击展开全文（Element 里这些消息会把群刷乱）。
  if (isToolMessage(msg.body || "")) {
    return <ToolBubble msg={msg} mine={mine} />;
  }
  // （13.7 应该加上聊天气泡，QwenPaw console
  // 口径：user 右对齐橙调气泡 / 对方左对齐中性气泡）：13.6 的扁平无框
  // 时间线改回气泡——常态背景 bubbleMine（右，橙调）/bubbleOther（左，
  // 中性），圆角 10（己方右上角 3 做尾），hover 行背景仍由外层提供。
  // 媒体/工具/审批/线程保留各自容器（不套气泡，避免双框）。
  return (
    <div
      style={{
        fontSize: 14,
        maxWidth: 520,
        minWidth: 0,
        padding: "8px 12px",
        borderRadius: mine ? "10px 3px 10px 10px" : "3px 10px 10px 10px",
        background: mine ? t.bubbleMine : t.bubbleOther,
        border: mine
          ? "1px solid color-mix(in srgb, var(--app-accent, #FF7F16) 25%, transparent)"
          : `1px solid ${t.border}`,
      }}
    >
      <MdText text={msg.body || ""} />
      {/* 「已编辑」标记（Element 同款；m.replace 聚合在
 fetchRoomMessages——替换事件不独立显示，正文写回原消息）。 */}
      {msg.edited ? (
        <span
          style={{
            fontSize: 11,
            color: t.textSecondary,
            marginLeft: 6,
            whiteSpace: "nowrap",
          }}
        >
          {tr("已编辑")}
        </span>
      ) : null}
      {/* 团队共享文件引用（#87）——chip 行；点击经 team-file 端点
 * 预览（复用 m.file 分支同款 previewFile 状态 + FilePreview，
 * apiPath 走 host.fetch 带鉴权）。纯引用消息（body 空）也渲染。 */}
      {msg.file_refs && msg.file_refs.length > 0 && fileRefTeam ? (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 4,
            marginTop: msg.body ? 6 : 0,
          }}
        >
          {msg.file_refs.map((r) => {
            const apiPath = `/agentteams-proxy/team-file?team=${encodeURIComponent(
              fileRefTeam,
            )}&key=${encodeURIComponent(r.key)}`;
            return (
              <antd.Tag
                key={r.key}
                color="blue"
                style={{
                  cursor: "pointer",
                  marginInlineEnd: 0,
                  fontSize: 12,
                  maxWidth: 240,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                onClick={() =>
                  setPreviewFile({
                    name: r.name,
                    url: apiPath,
                    apiPath,
                    size: r.size,
                    needsFetch: true,
                  })
                }
              >
                <FileTextOutlined style={{ marginRight: 4 }} />
                {r.name}
              </antd.Tag>
            );
          })}
        </div>
      ) : null}
      <FilePreview file={previewFile} onClose={() => setPreviewFile(null)} />
    </div>
  );
}

/** memo——mergeForward 对未变消息保持
 * 对象引用（append-only 合并），流式期间历史行的 msg 引用不变 → memo
 * 跳过整棵子树（MdText/审批卡/工作流卡/文件预览全不重渲染）；只有新行
 * 与数据真变的行才渲染。props 全为稳定引用：mergeForward 保 msg 身份；
 * mine 布尔；onApprovalAction/onDeliverable 本组件 useCallback（依赖
 * 稳定的父回调 + 记忆化 tr）；approvalResolved 取值稳定；
 * onOpenProject/onWorkflowIntervened 父侧稳定；live 随 liveWorkflows
 * （15s 轮询）才变。 */
export const MessageBodyMemo = React.memo(MessageBody);
