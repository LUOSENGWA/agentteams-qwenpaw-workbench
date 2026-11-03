// 房间聊天（任务 D 拆分后的壳）：props 面逐字保留（不改接口）；
// 状态收敛在 RoomChatCore（useRoomChatCore），视图层状态（ChatIR 回合 /
// 任务事件交错 / 视口窗口化）收敛在 RoomChatView（useRoomChatView），
// 渲染拆为 RoomChatHeader / RoomChatMessages（含 RoomChatMessageRow 行级
// memo）/ RoomChatComposer / RoomChatSidebar 四子组件。本文件只剩
// 布局编排 + 搜索定位区（DOM 顺序钉在消息流与输入框之间，不可移）。
import type * as ReactNS from "react";
import {
  type AttentionItem,
  type RoomMessage,
  type TeamRoom,
  type WorkerInfo,
  type WorkflowEvent,
} from "../api";
import { type FileRef } from "../lib/file-refs";
import { CloseIcon, PinIcon } from "./icons";
import { type WorkerSessionState } from "../workerSessionState";
import { PRIMARY, senderShortName } from "./RoomChatShared";
import { useRoomChatCore } from "./RoomChatCore";
import type { RoomChatCoreState } from "./RoomChatCore";
import { applyContextWindow } from "../jumpContextWindow";
import { RoomChatHeader } from "./RoomChatHeader";
import { RoomChatComposer } from "./RoomChatComposer";
import RoomChatMessages from "./RoomChatMessages";
import RoomChatSidebar from "./RoomChatSidebar";
import { useRoomChatView } from "./RoomChatView";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

export interface RoomChatProps {
  room: TeamRoom | null;
  messages: RoomMessage[];
  loading?: boolean;
  sending?: boolean;
  /** 是否还有更早的消息（分页）。 */
  hasMore?: boolean;
  /** 父侧「更早消息」加载中（顶部预载提示 + 防并发）。 */
  loadingMore?: boolean;
  /** 当前登录用户 MXID（自己的消息右对齐）。 */
  user_id?: string;
  /** 是否允许发消息；false 时整个输入区替换为居中提示条（Element 同款语义）。 */
  canSend?: boolean;
  /** 发送文本消息；replyTo 非空时作为引用回复发送；threadRoot 非空时
 * 作为线程回复（m.thread）发送到该线程；fileRefs 非空时把团队共享
 * 文件引用（#87）挂到出站 content（com.agentteams.file_refs 信封）。 */
  onSend?: (
    text: string,
    replyTo?: { event_id: string; sender: string; body: string },
    threadRoot?: string,
    fileRefs?: FileRef[],
  ) => Promise<void> | void;
  /** 发送文件/图片（上传 → m.file/m.image 消息）。 */
  onSendFiles?: (files: File[]) => Promise<void> | void;
  /** 审批命令带 @Worker（sendApprovalCommand）。
 * 群房间无 mention 的命令 Worker 收不到（QwenPaw _require_mention），
 * 审批卡按钮改走此路径而非裸 onSend 文本。 */
  onSendApproval?: (
    targetMxid: string,
    cmd: string,
    replyTo?: { event_id: string; sender: string; body: string },
  ) => Promise<void> | void;
  /** 编辑自己的消息（m.replace 标注替换，Element 同款）。 */
  onSendEdit?: (originalEventId: string, body: string) => Promise<void> | void;
  /** 撤回自己的消息（redaction）。 */
  onRedact?: (eventId: string) => Promise<void> | void;
  /** 退出房间（房间详情 Drawer；forget=true 退出并删除/忘记）。 */
  onLeaveRoom?: (forget?: boolean) => Promise<void> | void;
  /** 房间重命名（房间详情 Drawer；Element 同款能力，
 * 权限不足时展示诊断——团队房间权限表普遍 null 为平台侧已知问题）。 */
  onRenameRoom?: (name: string) => Promise<void> | void;
  /** 房间静音状态 + 切换（m.muted_room account data）。 */
  muted?: boolean;
  onToggleMute?: () => Promise<void> | void;
  /** 发送表情反应（m.reaction）。 */
  onReact?: (eventId: string, emoji: string) => Promise<void> | void;
  /** workflow 卡片点击 → 工作流 tab 选中该项目。 */
  onOpenProject?: (runId: string) => void;
  /** ：live 工作流事件（controller 正源，15s 轮询）——
 * 聊天内 workflow 卡片按 runId 匹配做 live overlay（状态/步骤/Worker 实时）。
 * WorkbenchPage 仅在正源轨（workflowSource=controller）时传入；降级轨传空
 * （events=原始卡重解析=快照恒等，overlay 无增量且会误导 LIVE 徽标）。 */
  liveWorkflows?: WorkflowEvent[];
  /** ：当前房间匹配的项目
 * （roomMatchesProject 同源，父组件算好传入）——composer 上方任务
 * 进度 + HITL 内联轨；无匹配/项目终态时组件自身不渲染。 */
  activityProject?: WorkflowEvent | null;
  /** ：向父组件上报话题面板
 * 占用（inline 面板吃宽；drawer 覆盖层不吃）。父组件将其计入
 * 单/双栏判定——此前未计入：开着话题把窗口拖窄时聊天区早已
 * 局促但判定不触发，要继续收窄才切单栏。open=false 时 width 忽略。 */
  onThreadPanelLayout?: (open: boolean, width: number) => void;
  /** workflow 卡片干预成功 → 刷新工作流。 */
  onWorkflowIntervened?: () => void;
  /** 项目文件面板（）：顶部 📁 按钮 → 抽屉。 */
  onOpenProjectFiles?: (room: TeamRoom) => void;
  /** 打开/创建与成员的私聊（头像右键菜单）。 */
  onDm?: (mxid: string, roomId?: string) => void;
  onBack?: () => void;
 /** ：顶栏最左
 * 前置节点（Element 汉堡位）——WorkbenchPage 宽屏收起列表时把
 * 「☰ 房间列表」按钮传进来，不再 absolute 浮在聊天区左上角压住返回键。 */
  headerPrefix?: ReactNS.ReactNode;
  /** 头像「查看会话」→ 父组件打开 WorkerChats 抽屉（会话窗与聊天区
 * 解耦为兄弟视图：SSE 消息 tick 只刷新抽屉，不触发聊天整树重渲）。 */
  onOpenWorkerChats?: (worker: string) => void;
  /** DM 房间显示"发起任务"按钮（Phase 2 任务向导入口，〇）。 */
  onNewTask?: () => void;
  /** 向上翻页（父组件 fetch 更早消息并前插）。 */
  onLoadMore?: () => void;
  /** 长轮询收新消息（父组件实现增量拉取）。 */
  onPoll?: () => void;
  /** 房间异常提示（如 404 僵尸房间），非空显示警示条。 */
  errorNote?: string;
  /** 跨房间搜索跳转：变化时尝试定位该事件（已加载则滚动+高亮）。
 * 定位完成后父组件应清除（onJumpHandled），避免重复触发。 */
  jumpToEventId?: string | null;
  onJumpHandled?: () => void;
  /** 成员角色表（成员详情卡）：MXID → 领/工/审/unknown。 */
  memberRoles?: Record<string, string>;
  /** MXID → Worker 容器名（5.0.0-beta.3：成员卡显示审批卡用）。 */
  memberWorkerNames?: Record<string, string>;
  /** ：MXID → runtime（头像「查看会话」入口门控）。 */
  workerRuntimeByMxid?: Record<string, string>;
  /** 当前房间对应 Worker 的 phase/runtime 徽章
 * （1:1 个人房间才有；数据=Worker CR 字段，零新请求）。 */
  workerBadge?: { phase?: string; runtime?: string };
  /** 当前房间对应 Worker 的 session 状态
 * （1:1 个人房间才有；typing/last_ts 派生，零新请求）。 */
  sessionState?: WorkerSessionState;
  /** 全部 Worker MXID——团队房间任一 Worker 正在输入则显蓝点。 */
  workerMxids?: Set<string>;
 /** （落点：聊天群内）：Worker MXID → 任务状态（头像角落灯；
 * 心跳优先派生，人类发送者无映射 → 不显）。 */
  workerSessionByMxid?: Record<string, WorkerSessionState>;
 /** ：Worker 列表——头像抽屉「查看会话」
 * （WorkerChats fixedWorker 模式）的数据源。 */
  workers?: WorkerInfo[];
  /** ：引用条「加载原消息」（R2 显式跳转）——
 * 点击后串行向前分页直到原消息进入窗口（限页上限），随后走既有
 * 定位+高亮链；返回结果（exhausted=上限内未找到，由 UI 落
 * /context 定位区兜底；cancelled=切房/换目标/看门狗）。
 * 不再依赖「滚到顶自动续拉」接力（其边界态是旧版「加载不出来」根因）。 */
  onLoadOriginal?: (
    eventId: string,
  ) => Promise<"found" | "exhausted" | "cancelled">;
  /** 正在回填的原消息 event_id（引用条显示
 * 「正在加载原消息…」；非空时渲染窗口旁路全量，直到定位完成
 * （onJumpHandled）才释放——深层目标不丢）。 */
  pendingOriginal?: string | null;
  /** （R2 显式跳转）渲染窗口下界：「加载原消息」命中后，从最新数起至少
 * 保留该条数的顶层消息（单向棘轮：只升不降，切房由父组件重置 0）——
 * 防止 pendingOriginal 旁路释放后渲染窗口把深层目标裁掉、拽走已定位视图。 */
  minWindowTops?: number;
  /** attention 待决策项（父组件已过滤已答/已解决；deployed=false 不传）——
 * 房间标题栏 pill（L3 入口）数据源，按 room_id 匹配当前房间。 */
  attentionPending?: AttentionItem[];
  /** 房间标题栏 attention pill 点击 → 父组件打开全局待决策弹窗并定位该房间第一条。 */
  onOpenRoomAttention?: (room: TeamRoom) => void;
}
function RoomChat(props: RoomChatProps) {
  const c = useRoomChatCore(props);
  if (!props.room) {
    return c as ReactNS.ReactElement;
  }
  const core = c as RoomChatCoreState;
  const {
    room,
    t,
    tr,
    narrow,
    compactHeader,
    jumpContext,
    jumpContextRef,
    clearJumpContext,
  } = core;
  // 定位区上下文片段折叠窗：默认只渲染目标 ±2（applyContextWindow）；
  // 新的定位上下文进来时恒复位折叠（新片段从 ±2 窗开始，不继承旧展开态）。
  const [jumpContextExpanded, setJumpContextExpanded] = React.useState(false);
  React.useEffect(() => {
    setJumpContextExpanded(false);
  }, [jumpContext]);

  // 视图层状态（ChatIR 回合 + 任务事件交错 + 视口窗口化）——
  // 逻辑全部在 RoomChatView hook（本组件只做布局与渲染）。
  const v = useRoomChatView(props, core);

  // 定位片段窗（任务 D §2.3 memo：此前每渲染在 IIFE 里重算 applyContextWindow）。
  const jcWin = React.useMemo(
    () =>
      jumpContext
        ? applyContextWindow(
            jumpContext.events,
            jumpContext.highlightId,
            jumpContextExpanded,
          )
        : null,
    [jumpContext, jumpContextExpanded],
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        // 撑满容器（Element 模型）——
        // 父链已全程定高：wb-main(shellH 实测) → 内容区 flex:1 min-0 →
        // Tabs/content-holder/content → tabpane-active(height:100% min-0)
        // → 分栏行 height:100% → 右栏 flex:1 min-0（窄屏模式 RoomChat 直挂
        // tabpane，同款定高）。12.x 的 calc(100vh-230px)+minHeight:420 在
        // OS 窗口小于屏幕时撑破容器 → 整页滚 + 顶栏 flexWrap 时进一步溢出。
        height: "100%",
        minWidth: 0,
      }}
    >
      {/* 顶部栏：窄屏走紧凑头（1 行，次要控件进 ⋯ 菜单）；宽屏走完整头部 */}
      {narrow ? compactHeader : <RoomChatHeader p={props} c={core} />}

      {/* 主区：左消息流 + 右线程面板（宽屏）；窄屏线程走 Drawer */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* 15.14：左列补 minHeight:0——flex 高度链断点（教训 #615 同款）：
缺它时列的自动最小高=内容最小高，列表 minHeight:300 会穿透撑破
列 → RoomChat 根溢出 → tabpane（overflow auto）出现整页滚动 →
「拖聊天页时输入框跟着动」（真机反馈）。补上后列恒=分配高，
滚动只发生在列表内部，输入框钉在列底。 */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            minWidth: 0,
            minHeight: 0,
          }}
        >
          <RoomChatMessages p={props} c={core} v={v} />

          {/* 搜索跳转定位区（修复）：目标事件不在已加载窗口时，展示
/context 前后文片段 + 高亮目标 + 关闭；点击结果后滚动至此。
16.23 霸屏修复：片段容器限高 40vh + 内部自滚，默认只渲染目标 ±2 条
（applyContextWindow），其余收在「展开全部上下文」按钮后——全量
/context 片段不再把正常消息列表挤出屏幕。
DOM 顺序钉在消息流与输入框之间（jumpContextRef scroll 目标），不可移。 */}
          {jumpContext && jcWin ? (
            <div
              ref={jumpContextRef}
              style={{
                border: `1px solid ${PRIMARY}`,
                borderRadius: 10,
                padding: "8px 10px",
                background: "color-mix(in srgb, var(--app-accent, #FF7F16) 5%, transparent)",
                marginBottom: 8,
                animation: "wbJumpIn 0.3s ease-out",
                // 霸屏修复：片段高度封顶 + 内部滚动；flexShrink:0 保证纵向
                // 空间紧张时由上方消息列表（flex:1 min-0）让位，而非压扁本区。
                maxHeight: "40vh",
                overflowY: "auto",
                flexShrink: 0,
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
                <span style={{ fontSize: 12, fontWeight: 700, color: PRIMARY }}>
                  <PinIcon size={12} style={{ verticalAlign: "-1px" }} /> {tr("搜索定位")}
                </span>
                <span style={{ fontSize: 11.5, color: t.textSecondary, flex: 1 }}>
                  {tr("目标消息不在已加载范围，显示前后文片段")}
                </span>
                {jcWin.hiddenCount > 0 ? (
                  <antd.Button
                    size="small"
                    type="link"
                    onClick={() => setJumpContextExpanded(!jumpContextExpanded)}
                    style={{ fontSize: 12, flex: "none" }}
                  >
                    {jumpContextExpanded
                      ? tr("收起")
                      : tr("展开全部上下文")} (
                    {jumpContext.events.length} {tr("条")})
                  </antd.Button>
                ) : null}
                <antd.Button
                  size="small"
                  type="text"
                  onClick={clearJumpContext}
                  style={{ fontSize: 12 }}
                >
                  <CloseIcon size={12} />
                </antd.Button>
              </div>
              {jcWin.events.map((m) => {
                const isTarget = m.event_id === jumpContext.highlightId;
                return (
                  <div
                    key={m.event_id}
                    style={{
                      padding: "6px 10px",
                      borderRadius: 8,
                      marginBottom: 4,
                      fontSize: 12.5,
                      background: isTarget ? "color-mix(in srgb, var(--app-accent, #FF7F16) 12%, transparent)" : t.bubbleOther,
                      border: isTarget
                        ? `1px solid ${PRIMARY}`
                        : "1px solid transparent",
                      wordBreak: "break-word",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    <div
                      style={{
                        color: t.textSecondary,
                        fontSize: 11.5,
                        marginBottom: 2,
                        display: "flex",
                        gap: 6,
                      }}
                    >
                      <span style={{ fontWeight: 600, color: t.text }}>
                        {senderShortName(m.sender, room)}
                      </span>
                      {isTarget ? (
                        <span style={{ color: PRIMARY, fontWeight: 700 }}>●</span>
                      ) : null}
                    </div>
                    <div style={{ color: t.text }}>
                      {m.body.slice(0, 600)}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}

          {/* typing 指示（Element WhoIsTypingTile 同款交互：房间内正在输入提示） */}
          {(room.typing || []).length > 0 ? (
            <div
              style={{
                fontSize: 12,
                color: t.textSecondary,
                fontStyle: "italic",
                padding: "2px 4px",
              }}
            >
              {(room.typing || [])
                .map((mxid) => senderShortName(mxid, room))
                .join("、")}{" "}
              {tr("正在输入…")}
            </div>
          ) : null}

          {/* 底部输入区。15.14：flexShrink:0——窗口矮时输入区不被压缩
 （压缩会挤压 textarea/autoSize 计算高度 → 输入框视觉跳变），
 纵向空间全让给上方消息列表（flex:1 min-0）内部滚动。 */}
          <RoomChatComposer p={props} c={core} />
        </div>
        <RoomChatSidebar p={props} c={core} v={v} />
      </div>
    </div>
  );
}
// 面板级 memo——父级（WorkbenchPage）重渲染
// 且 props 无变化时跳过（修复前全仓零 memo，切 tab 帧断 183-200ms）。
export default React.memo(RoomChat);
