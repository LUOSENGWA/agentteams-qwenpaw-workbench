// 线程面板内容（Element ThreadView 同款）：root 消息 + 回复列表 + 输入框。
//
// §4.4（UI parity）：面板正文复用主列表的 turn 渲染管线——
// [root, ...replies] 逐条按消息自身修订键（editedAt ?? 发送时间，稳定排序）
// → roomMessagesToIR → buildTurns → splitTurn；每 turn 依次渲染
// TurnHeader（每 turn 一个 header/头像）→ ProcessCollapseBar（思考 +
// 工具调用）→ RunConfirmationCard（审批）→ 回答行（MessageBody——
// A2UI/审批/附件/文件引用全部保持交互，不折叠）→ RunErrorBar（run 哨兵）。
// worker 占位根（尚无最终编辑）不显示字面「处理中...」，改紧凑
// 「运行过程」状态行；最终编辑过的根按编辑时间在时序落位（与主时间线
// §4.3 同口径）。不引入第二套解析/分组——解析与主列表同源（ChatIR /
// MessageBody / parseAttentionMessage）。
// 面板保留全部原有能力：打开自动滚底/新回复跟随/一键置底、根点击跳
// 原消息、reactions、介入决策卡、composer（Enter 发送）、宽度链；
// 宽屏放右侧固定面板，窄屏放 antd.Drawer——同一组件两种容器。
import {
  type RoomMessage,
  type TeamRoom,
  type WorkflowEvent,
} from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { CloseIcon } from "./icons";
import { type WorkerSessionState } from "../workerSessionState";
import { PRIMARY, isWorkerPlaceholder } from "./RoomChatShared";
import {
  BubbleBoundary,
  MessageBodyMemo,
  ReactionChips,
} from "./RoomChatBubbles";
import MdText from "./MdText";
import { parseAttentionMessage } from "../pending/parse";
import { AttentionDecisionCard } from "./AttentionDecisionCard";
import {
  TurnHeader,
  RunConfirmationCard,
  RunErrorBar,
} from "./RoomChatTurnParts";
import { ProcessCollapseBar } from "../chat/ProcessCollapseBar";
import {
  buildTurns,
  splitTurn,
  stripThinkingPrefix,
  runBlockText,
  type ChatMessage,
} from "../chat/ChatIR";
import { roomMessagesToIR } from "../chat/roomAdapter";
import { collectGallery, type GalleryItem } from "../lib/mediaGallery";
import { MediaViewer } from "./MediaViewer";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
/** ：话题图标
 * = 消息气泡 + 小旗（currentColor 跟随文字色，替换全 🧵 emoji）。 */
export function ThreadIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      style={{ verticalAlign: "-1px", flexShrink: 0 }}
      aria-hidden="true"
    >
      <path
        d="M2 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H8l-3 2.6V11H4a2 2 0 0 1-2-2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M6.3 4.4v4.4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      <path d="M6.3 4.4h3l-0.9 1 0.9 1h-3z" fill="currentColor" />
    </svg>
  );
}

/** 线程面板内容（Element ThreadView 同款）：root 消息 + 回复列表 + 输入框。
 * 宽屏放右侧固定面板，窄屏放 antd.Drawer——同一组件两种容器。
 * 正文渲染 = 主列表 turn 管线复用（见文件头 §4.4 说明）。 */
export function ThreadPanelView({
  root,
  replies,
  room,
  myUserId,
  onSendThread,
  onClose,
  onReact,
  onJump,
  workerSessionByMxid,
  memberWorkerNames,
  workerRuntimeByMxid,
  workerMxids,
  liveByRunId,
  teamName,
  resolvedApprovals,
  onApprovalAction,
  onDeliverable,
  onOpenProject,
  onWorkflowIntervened,
  onOpenProjectFiles,
  openDetailMxid,
  onDm,
  onOpenWorkerChats,
}: {
  root: RoomMessage;
  replies: RoomMessage[];
  room: TeamRoom;
  myUserId: string;
  onSendThread: (text: string) => Promise<void> | void;
  onClose: () => void;
  onReact?: (eventId: string, emoji: string) => Promise<void> | void;
  /** 根行点击 → 主列表跳转到原消息（handleSearchJump 兜底 /context）。 */
  onJump?: (eventId: string) => void;
  /** 话题内 Worker 头像角落状态灯（与主列表消息头像同源）。 */
  workerSessionByMxid?: Record<string, WorkerSessionState>;
  /** 成员 worker 名表（TurnHeader 头像弹层显示名）。 */
  memberWorkerNames?: Record<string, string>;
  /** worker runtime 表（TurnHeader 头像「查看会话」门控）。 */
  workerRuntimeByMxid?: Record<string, string>;
  /** worker 判定表（四集合并，core 经 mergeWorkerMxids 预算）。 */
  workerMxids?: Record<string, string>;
  /** runId → live 工作流事件（workflow 卡片实时 overlay）。 */
  liveByRunId?: Map<string, WorkflowEvent> | null;
  /** team 名（文件引用 chip 点击预览走 team-file 端点）。 */
  teamName?: string | null;
  /** 已裁决审批（event_id → approve/deny，审批卡回只读态）。 */
  resolvedApprovals?: Record<string, "approve" | "deny">;
  /** 审批通知卡动作（Matrix 回复 approve/deny，主列表同源 handler）。 */
  onApprovalAction?: (msg: RoomMessage, action: "approve" | "deny") => void;
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
  /** 项目文件面板：顶部 📁 按钮 → 抽屉。 */
  onOpenProjectFiles?: (room: TeamRoom) => void;
  /** 头像 → Worker 详情抽屉（主列表同口径）。 */
  openDetailMxid: (m: string) => void;
  onDm?: (mxid: string, roomId?: string) => void;
  onOpenWorkerChats?: (worker: string) => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  const [draft, setDraft] = React.useState("");
  const [sending, setSending] = React.useState(false);

  // ── 滚动跟随 / 一键置底（主消息列表同款 nearBottom 逻辑）─────────
  const threadScrollRef = React.useRef<HTMLDivElement | null>(null);
  const threadOpenKeyRef = React.useRef<string>("");
  // 话题内一键置底（与主列表同款，窄面板故无徽章）。
  const [threadShowJump, setThreadShowJump] = React.useState(false);
  const threadJumpToBottom = React.useCallback(() => {
    const el = threadScrollRef.current;
    if (!el) return;
    // 与主列表同款修——instant 置底（smooth 目标漂移）。
    el.scrollTop = el.scrollHeight;
    setThreadShowJump(false);
  }, []);
  const handleThreadScroll = React.useCallback(() => {
    const el = threadScrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    setThreadShowJump(dist >= 120);
  }, []);

  // 打开话题自动滚到最新回复；开着时新回复到达且已在底部 → 跟随。
  // （此前话题面板永远停在顶部，长话题要手动翻到底，用户「话题页面
  // 从旧到新」体验的一部分。）
  React.useEffect(() => {
    const el = threadScrollRef.current;
    if (!el) return;
    const key = root.event_id;
    if (threadOpenKeyRef.current !== key) {
      threadOpenKeyRef.current = key;
      el.scrollTop = el.scrollHeight;
      setThreadShowJump(false);
      return;
    }
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
      el.scrollTop = el.scrollHeight;
    }
  }, [root.event_id, replies.length]);

  // 话题内 DOM 增高跟随（主列表同款：观察子节点）。
  React.useEffect(() => {
    const el = threadScrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
        el.scrollTop = el.scrollHeight;
      }
    });
    for (const c of Array.from(el.children) as HTMLElement[]) {
      ro.observe(c);
    }
    return () => ro.disconnect();
  }, [root, replies]);

  // ── 面板时间线：[root, ...replies] 逐条按自身修订键排序 → IR → turns ──
  // 稳定排序（同键保持原相对序）；最终编辑过的根按编辑时间落位（与
  // 主时间线 §4.3 同口径）——buildTurns 按输入序分组（不重排），所以
  // 排序必须在本管线完成。
  const unified = React.useMemo(() => {
    const all = [root, ...replies];
    return all
      .map((m, i) => ({ m, i }))
      .sort((a, b) => {
        const ka = a.m.editedAt ?? a.m.origin_server_ts ?? 0;
        const kb = b.m.editedAt ?? b.m.origin_server_ts ?? 0;
        return ka - kb || a.i - b.i;
      })
      .map((x) => x.m);
  }, [root, replies]);

  // IR 消息 id（= event_id）→ RoomMessage 回查（TurnHeader/回答行需要
  // RoomMessage 口径：reactions/workflow/url/runBlocks/edited 标记）。
  const byId = React.useMemo(() => {
    const map = new Map<string, RoomMessage>();
    for (const m of unified) map.set(m.event_id, m);
    return map;
  }, [unified]);

  const turns = React.useMemo(
    () => buildTurns(roomMessagesToIR(unified)),
    [unified],
  );
  const lastTurnId =
    turns.length > 0 ? turns[turns.length - 1].id : null;

  // ── 图片灯箱（主列表同款 collectGallery，范围 = 本话题内容）──────
  // 点开时现场算「同发送者连续图片」画廊（快照保存）——轮询追加消息
  // 不会把已打开的画廊序列改掉。
  const [viewer, setViewer] = React.useState<{
    items: GalleryItem[];
    index: number;
  } | null>(null);
  const closeViewer = React.useCallback(() => setViewer(null), []);
  const changeViewerIndex = React.useCallback((index: number) => {
    setViewer((prev) => (prev ? { ...prev, index } : prev));
  }, []);
  const openMedia = React.useCallback(
    (eventId: string) => {
      const gallery = collectGallery(unified, eventId);
      if (gallery) setViewer(gallery);
    },
    [unified],
  );

  // 头像弹层 @提及 → 追加到本话题 composer（主列表 insertMention 同款
  // 格式，目标是线程 draft 而非主 composer）。
  const insertMentionThread = React.useCallback(
    (mxid: string) => {
      const member = room.members?.[mxid];
      const name =
        member?.display_name?.trim() ||
        (mxid.split(":")[0] || mxid).replace(/^@/, "");
      setDraft((d) => (d ? `${d}@${name} ` : `@${name} `));
    },
    [room],
  );

  const handleSend = async () => {
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    try {
      await onSendThread(text);
      setDraft("");
    } finally {
      setSending(false);
    }
  };

  // 回答行渲染（主列表 RoomChatMessageRow 的气泡口径，去掉主列表独占
  // 的 hover 工具条/编辑/撤回/回复态——面板 composer 即回复入口）。
  // 入参 = RoomMessage 口径（splitTurn 的答案 body 已按 run 块文本替换，
  // 这里从 roomMsg.runBlocks 重推同口径文本，无需再传 IR 消息）。
  const workerTable = workerMxids ?? {};
  const renderRow = (roomMsg: RoomMessage, isRootRow: boolean) => {
    const mine = myUserId !== "" && roomMsg.sender === myUserId;
    // worker 占位（尚无最终编辑）：不显示字面「处理中...」——紧凑
    // 「运行过程」状态行（过程细节由本 turn 的过程折叠条承载）。
    if (isWorkerPlaceholder(roomMsg, workerTable)) {
      return (
        <div
          key={roomMsg.event_id}
          data-event-id={roomMsg.event_id}
          onClick={
            isRootRow && onJump ? () => onJump(root.event_id) : undefined
          }
          title={isRootRow && onJump ? tr("跳转到原消息") : undefined}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: t.textSecondary,
            padding: isRootRow ? "8px 10px" : "2px 0",
            borderRadius: isRootRow ? 10 : 0,
            background: isRootRow ? t.hoverBg : "transparent",
            cursor: isRootRow && onJump ? "pointer" : "default",
          }}
        >
          <span className="wb-process-spin" aria-hidden="true" />
          <span style={{ fontWeight: 600 }}>{tr("运行过程")}</span>
        </div>
      );
    }
    // ATTENTION_* 请求（他人消息）：正文照渲 + 紧凑决策卡（线程内正文已
    // 带全文，卡只留操作行）——与 MessageBody 内部分支同判定式，卡渲染
    // 在跳转包裹之外（stopPropagation），作答不触发跳原消息。
    const attention =
      !mine &&
      roomMsg.msgtype === "m.text" &&
      !roomMsg.pending &&
      !!parseAttentionMessage(roomMsg.body || "");
    // 结构化 run 的 text 块替代 body（主列表 runBlockBodies 同口径）：
    // splitTurn 已把答案 body 换成功块文本，渲染时写回原消息副本。
    const renderMsg: RoomMessage =
      roomMsg.runBlocks && roomMsg.runBlocks.length > 0
        ? {
            ...roomMsg,
            body: runBlockText(roomMsg.runBlocks) ?? roomMsg.body,
            msgtype: "m.text",
          }
        : roomMsg;
    const live = roomMsg.workflow?.runId
      ? (liveByRunId?.get(roomMsg.workflow.runId) ?? null)
      : null;
    const jump =
      isRootRow && onJump ? () => onJump(root.event_id) : undefined;
    return (
      <div
        key={roomMsg.event_id}
        data-event-id={roomMsg.event_id}
        onClick={jump}
        title={jump ? tr("跳转到原消息") : undefined}
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 4,
          flexDirection: mine ? "row-reverse" : "row",
          minWidth: 0,
          maxWidth: "100%",
          ...(isRootRow
            ? {
                background: t.hoverBg,
                borderRadius: 10,
                padding: "6px 8px",
                cursor: jump ? ("pointer" as const) : ("default" as const),
              }
            : {}),
        }}
      >
        <div style={{ minWidth: 0, maxWidth: "100%" }}>
          <BubbleBoundary fallback={renderMsg.body || ""}>
            {attention ? (
              <>
                <div
                  style={{
                    fontSize: 13,
                    maxWidth: 420,
                    minWidth: 0,
                    padding: "8px 12px",
                    borderRadius: 12,
                    background: mine ? t.bubbleMine : t.bubbleOther,
                    border: `1px solid ${t.border}`,
                    wordBreak: "break-word",
                    overflowWrap: "anywhere",
                  }}
                >
                  <MdText text={renderMsg.body || ""} formattedBody={renderMsg.formatted_body} />
                </div>
                <div
                  onClick={(e) => {
                    if (isRootRow) e.stopPropagation();
                  }}
                >
                  <AttentionDecisionCard msg={renderMsg} room={room} compact />
                </div>
              </>
            ) : (
              <MessageBodyMemo
                msg={renderMsg}
                mine={mine}
                room={room}
                fileRefTeam={teamName ?? null}
                onApprovalAction={onApprovalAction}
                approvalResolved={
                  resolvedApprovals?.[roomMsg.event_id] || null
                }
                onDeliverable={onDeliverable}
                onOpenProject={onOpenProject}
                onWorkflowIntervened={onWorkflowIntervened}
                onOpenProjectFiles={onOpenProjectFiles}
                live={live}
                onOpenMedia={openMedia}
              />
            )}
          </BubbleBoundary>
        </div>
        {onReact ? (
          <div
            onClick={(e) => {
              // 根行整块可点跳原消息——reactions 点击只应触发表情。
              if (isRootRow) e.stopPropagation();
            }}
          >
            <ReactionChips
              reactions={roomMsg.reactions}
              eventId={roomMsg.event_id}
              onReact={(id, emoji) => void onReact(id, emoji)}
            />
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        // 面板容器是 flex（row），本根是 flex item——没有 width/minWidth 约束时
        // flex item 按 max-content（= 滚动区内容全宽，代码块单行可上千 px）撑宽
        // 整条链，pre 宽=内容宽 → 无溢出无滚动条 → 截断（浏览器实测复现）。
        // 显式 100% + minWidth:0 切断 max-content 传播，滚动条恢复。
        width: "100%",
        minWidth: 0,
        maxWidth: "100%",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          paddingBottom: 10,
          borderBottom: `1px solid ${t.border}`,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 14,
            fontWeight: 700,
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
          }}
        >
          <ThreadIcon size={15} /> {tr("话题")}
        </span>
        <span style={{ fontSize: 12, color: t.textSecondary }}>
          {replies.length}
          {tr("条回复")}
        </span>
        <div style={{ flex: 1 }} />
        <antd.Button type="text" size="small" onClick={onClose} title={tr("关闭话题")}>
          <CloseIcon size={12} />
        </antd.Button>
      </div>
      {/* relative wrapper = 话题内一键置底按钮锚点。 */}
      <div
        style={{
          position: "relative",
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          minWidth: 0,
          maxWidth: "100%",
        }}
      >
      <div
        ref={threadScrollRef}
        onScroll={handleThreadScroll}
        data-thread-scroll=""
        style={{
          flex: 1,
          overflowY: "auto",
          overflowX: "hidden",
          padding: "10px 0",
          minHeight: 0,
          minWidth: 0,
          maxWidth: "100%",
        }}
      >
        <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
          {turns.map((turn) => {
            // 批次 3 同款三段拆分（思考帧/工具调用/回答帧）+ 结构化块。
            const {
              thoughts: thoughtMsgs,
              calls,
              answers,
              confirmations,
              errors,
            } = splitTurn(turn, {
              isMine: (m: ChatMessage) =>
                myUserId !== "" && m.sender === myUserId,
              workerMxids: workerTable,
            });
            const thoughts: string[] = [];
            for (const m of thoughtMsgs) {
              const text = stripThinkingPrefix(m.body);
              if (text) thoughts.push(text);
            }
            const hasProcess = calls.length > 0 || thoughts.length > 0;
            const turnMine = myUserId !== "" && turn.sender === myUserId;
            // turn 首条消息（RoomMessage 口径）= header 来源。
            const firstIr =
              turn.messages.length > 0 ? turn.messages[0] : null;
            const headerMsg = firstIr ? byId.get(firstIr.id) : undefined;
            const turnAlign = {
              display: "flex",
              justifyContent: turnMine ? "flex-end" : "flex-start",
              padding: "0 2px",
            } as const;
            const partStyle: React.CSSProperties = {
              maxWidth: "88%",
              minWidth: 0,
            };
            return (
              <div key={turn.id} data-turn-id={turn.id} style={{ minWidth: 0 }}>
                {/* turn 级 header：头像 + 名字 + 时间，只出现一次（每
                    turn 一个 header/头像；续行不带头像，与主列表一致）。 */}
                {headerMsg ? (
                  <div style={turnAlign}>
                    <div style={partStyle}>
                      <TurnHeader
                        msg={headerMsg}
                        room={room}
                        myUserId={myUserId}
                        t={t}
                        tr={tr}
                        showTime
                        workerSessionByMxid={workerSessionByMxid}
                        memberWorkerNames={memberWorkerNames}
                        workerRuntimeByMxid={workerRuntimeByMxid}
                        insertMention={insertMentionThread}
                        openDetailMxid={openDetailMxid}
                        onDm={onDm}
                        onOpenWorkerChats={onOpenWorkerChats}
                      />
                    </div>
                  </div>
                ) : null}
                {/* 过程条在回答之前：思考 + 工具调用（流式中自动展开）。 */}
                {hasProcess ? (
                  <div style={{ ...turnAlign, padding: "0 2px 3px" }}>
                    <div style={partStyle}>
                      <ProcessCollapseBar
                        calls={calls}
                        thoughts={thoughts}
                        active={
                          turn.status === "active" && turn.id === lastTurnId
                        }
                      />
                    </div>
                  </div>
                ) : null}
                {/* confirmation 块：只读审批卡（主列表同款，审批动作
                    走 Matrix 回复，不新造交互）。 */}
                {confirmations.length > 0 ? (
                  <div style={{ ...turnAlign, padding: "0 2px 3px" }}>
                    <div style={partStyle}>
                      {confirmations.map((block, i) => (
                        <RunConfirmationCard
                          key={`${block.confirmation_id}-${i}`}
                          block={block}
                          t={t}
                          tr={tr}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
                {/* 回答行（MessageBody 全交互：A2UI/审批/附件/文件引用
                    不折叠；根行整块可点跳原消息）。 */}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: turnMine ? "flex-end" : "flex-start",
                    gap: 6,
                    minWidth: 0,
                    padding: "0 2px",
                  }}
                >
                  {answers.map((irMsg) => {
                    const roomMsg = byId.get(irMsg.id);
                    if (!roomMsg) return null;
                    return renderRow(
                      roomMsg,
                      roomMsg.event_id === root.event_id,
                    );
                  })}
                </div>
                {/* error 块：run 结束哨兵（一行状态条，排在回答行之后）。 */}
                {errors.length > 0 ? (
                  <div style={{ ...turnAlign, padding: "0 2px" }}>
                    <div style={partStyle}>
                      {errors.map((block, i) => (
                        <RunErrorBar
                          key={`${turn.id}-error-${i}`}
                          block={block}
                          t={t}
                          tr={tr}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      {/* 纯 div 圆（弃 antd Button——CSS 对抗 inline 尺寸致纵向拉长），32×32 恒圆。 */}
      {threadShowJump ? (
        <div
          role="button"
          aria-label={tr("回到最新消息")}
          title={tr("回到最新消息")}
          onClick={threadJumpToBottom}
          style={{
            position: "absolute",
            right: 10,
            // safe-area：notch/手势条设备上抬高到安全区之上
            bottom: "max(8px, env(safe-area-inset-bottom))",
            zIndex: 5,
            width: 32,
            height: 32,
            boxSizing: "border-box",
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: PRIMARY,
            color: "#fff",
            border: `1px solid ${PRIMARY}`,
            boxShadow: "0 2px 8px rgba(0,0,0,0.20)",
            fontSize: 14,
            lineHeight: 1,
            cursor: "pointer",
          }}
        >
          ↓
        </div>
      ) : null}
      </div>
      <div style={{ flexShrink: 0, paddingTop: 10, borderTop: `1px solid ${t.border}` }}>
        <antd.Input.TextArea
          value={draft}
          rows={2}
          placeholder={tr("回复此话题…（Enter 发送，Shift+Enter 换行）")}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(e.target.value)}
          onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
          <antd.Button
            className="wb-touch-lg"
            loading={sending}
            disabled={!draft.trim()}
            onClick={() => void handleSend()}
            style={{ backgroundColor: PRIMARY, borderColor: PRIMARY, color: "#fff" }}
          >
            {tr("发送")}
          </antd.Button>
        </div>
      </div>
      {/* 应用内灯箱（portal 到 body）：面板卸载即关闭，不影响消息流。 */}
      {viewer ? (
        <MediaViewer
          items={viewer.items}
          index={viewer.index}
          onClose={closeViewer}
          onIndexChange={changeViewerIndex}
        />
      ) : null}
    </div>
  );
}
