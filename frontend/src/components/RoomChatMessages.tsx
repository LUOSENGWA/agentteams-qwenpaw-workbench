// 消息流（任务 D 拆分自 RoomChat 左列 relative wrapper，JSX 逐句搬迁）：
// RoomPendingBar + TurnTimeline 刻度轨 + 滚动容器（窗口化渲染）+ 一键置底。
import { WarnIcon } from "./icons";
import {
  PRIMARY,
  TOUCH_ONLY,
  isToolMessage,
  wantsDateSeparator,
  EMPTY_REPLIES,
} from "./RoomChatShared";
import { ProcessCollapseBar } from "../chat/ProcessCollapseBar";
import {
  isThinkingNotice,
  shouldContinueGroup,
  splitTurn,
  stripThinkingPrefix,
  type ChatMessage,
} from "../chat/ChatIR";
import { TurnTimeline } from "../chat/TurnTimeline";
import { TaskEventCard } from "../chat/TaskEventCard";
import {
  TurnHeader,
  ChatDatePill,
  ChatUnreadLine,
} from "./RoomChatTurnParts";
import RoomChatMessageRow from "./RoomChatMessageRow";
import { RoomPendingBar } from "./RoomPendingBar";
import type { RoomChatProps } from "./RoomChat";
import type { RoomChatCoreState } from "./RoomChatCore";
import type { RoomChatViewState } from "./RoomChatView";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

export default function RoomChatMessages(props: {
  p: RoomChatProps;
  c: RoomChatCoreState;
  v: RoomChatViewState;
}) {
  const { p, c, v } = props;

  const {
    room,
    loading,
    hasMore,
    loadingMore,
    onSendFiles,
    errorNote,
    threadGroups,
    stickToBottom,
    listRef,
    dragOver,
    setDragOver,
    hoveredId,
    setHoveredId,
    hoverTimerRef,
    myUserId,
    readTs,
    visibleMessages,
    liveByRunId,
    teamName,
    resolvedApprovals,
    activeThread,
    workerSessionByMxid,
    memberWorkerNames,
    workerRuntimeByMxid,
    onOpenProject,
    onDm,
    onOpenWorkerChats,
    onReact,
    onRedact,
    onLoadOriginal,
    insertMention,
    openDetailMxid,
    handleApprovalAction,
    handleDeliverable,
    setReplyTo,
    setEditing,
    setDraft,
    composerRef,
    setActiveThread,
    revealWindow,
    kickLoadMore,
    t,
    tr,
  } = c;
  const onWorkflowIntervened = p.onWorkflowIntervened;

  // 思考过程识别（m.notice 推理帧）的 worker 判定表：成员名表 ∪ 会话状态表。
  const workerMxids = React.useMemo(
    () => ({ ...(memberWorkerNames || {}), ...(workerSessionByMxid || {}) }),
    [memberWorkerNames, workerSessionByMxid],
  );

  // 只有「列表尾部 turn」才可能是进行中：历史 turn 的未闭合工具帧
  // （call 后没有结果帧）不该让过程条永久停在「进行中/展开」。
  const lastTurnId = React.useMemo(() => {
    for (let i = v.renderItems.length - 1; i >= 0; i -= 1) {
      const it = v.renderItems[i];
      if (it.kind === "turn") return it.range.turn.id;
    }
    return null;
  }, [v.renderItems]);

  // 首次渲染消息时（renderItems 从空→有值）：paint 前贴底（不闪顶）。
  // 根因：useStickToBottom 换房间是 useEffect（paint 后）→ 用户看到 1 帧顶部。
  // useLayoutEffect = DOM ready 后 paint 前 = 唯一不闪时机。
  const initialScrollDone = React.useRef(false);
  React.useLayoutEffect(() => {
    if (initialScrollDone.current) return;
    if (v.renderItems.length > 0 && stickToBottom.isAtBottom && listRef.current) {
      // DOM 有内容（非空容器）才贴底——空容器 scrollHeight = padding，
      // 贴了也无意义且会锁死 initialScrollDone。
      const el = listRef.current;
      if (el.children.length > 0) {
        el.scrollTop = el.scrollHeight;
        initialScrollDone.current = true;
      }
    }
  }, [v.renderItems.length, stickToBottom.isAtBottom, listRef, v.vwin]);

  return (
    /* 消息流（relative wrapper = 一键置底按钮锚点）。
minHeight: 0 是 flex 高度链必配项（教训 #615：
高度链沿链验证到容器属性）——overflow 可见的中间层 flex 子项
自动最小高度 = 内容最小高度（子列表的 overflow:auto 钳制不会
穿透传递），缺它 wrapper 被 300 条消息撑到 7500+px、列表失去
独立滚动 → 滚轮冒泡成整页滚动 + 旧消息滚出视野（回归，
浏览器 A/B 实测证实；话题面板 wrapper 本就带此值）。 */
    <div
      style={{
        position: "relative",
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        minHeight: 0,
      }}
    >
      {/* 房间内「项目阻塞」处理条（10/30 反馈：在房间就能处理，不必先去工作流）。
          常驻于列表上方、滚动容器外；无当前房间待办时自渲染 null。 */}
      <RoomPendingBar
        roomId={room?.room_id}
        onSend={(text: string) => p.onSend?.(text)}
        canSend={!!p.onSend && p.canSend !== false}
        onOpenProject={onOpenProject}
      />
      {/* 批次 3：会话导航刻度轨——turn 数 > 8 才显形；sticky 28px，
          在滚动容器之外、输入框上方（不遮输入框）。
          16.46：刻度只渲染可视窗 ±5；>500 turn 退化为文字条。 */}
      <TurnTimeline
        turns={v.turnTicks}
        listRef={listRef}
        room={room}
        tr={tr}
        onJumpToBottom={() => void v.jumpToBottomWindowed()}
      />
      <div
        ref={listRef}
        onScroll={stickToBottom.handleScroll}
        style={{
          flex: 1,
          overflowY: "auto",
          overflowX: "hidden",
          // R2 前插锚定：容器保持浏览器原生滚动锚（overflow-anchor: auto
          // 默认）作第一道防线；顶部动态块（加载按钮/错误条/最早标记，见下）
          // 设 overflow-anchor: none 排除出锚定候选，浏览器才会选消息行做
          // 锚点；useStickToBottom 的锚定元素层兜底原生未覆盖的边界
          // （内容未溢出等），两层合成、无手工 scrollHeight 差值补偿。
          padding: "16px 4px",
          // 15.14：minHeight:300 → 0。旧值在「可用高 < 300」时强制列表
          // 300px → 穿透撑破列 → tabpane 整页滚动 → 输入框随页动。
          // flex:1 + minHeight:0 = 列表恒=可用高，内部自滚（Element 同款）。
          minHeight: 0,
          minWidth: 0,
          // 拖拽文件高亮（Element 同款 drop zone）。
          outline: dragOver && onSendFiles ? "2px dashed color-mix(in srgb, var(--app-accent, #FF7F16) 60%, transparent)" : "none",
          outlineOffset: -4,
        }}
        onDragOver={
          onSendFiles
            ? (e) => {
                if (e.dataTransfer?.types?.includes("Files")) {
                  e.preventDefault();
                  setDragOver(true);
                }
              }
            : undefined
        }
        onDragLeave={
          onSendFiles
            ? (e) => {
                // 自审：dragleave 在移到子元素时也会触发（高亮闪烁）——
                // 只有真正离开容器才清标记。
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setDragOver(false);
                }
              }
            : undefined
        }
        onDrop={
          onSendFiles
            ? (e) => {
                e.preventDefault();
                setDragOver(false);
                const files = Array.from(e.dataTransfer?.files || []);
                if (files.length > 0) void onSendFiles(files);
              }
            : undefined
        }
      >
        {errorNote ? (
          <div
            style={{
              marginBottom: 12,
              padding: "8px 12px",
              borderRadius: 8,
              background: "rgba(250,140,22,0.08)",
              color: "#fa8c16",
              fontSize: 13,
              // R2：顶部可控动态块——排除出原生滚动锚候选（内容随时增删，
              // 若被选为锚点，前插时浏览器锚到它 = 视图钉在顶部）。
              overflowAnchor: "none",
            }}
          >
            <WarnIcon size={13} style={{ verticalAlign: "-2px" }} /> {errorNote}
          </div>
        ) : null}
        {hasMore || threadGroups.hiddenCount > 0 ? (
          <div
            style={{
              textAlign: "center",
              paddingBottom: 12,
              overflowAnchor: "none", // R2：同上，动态块不配做锚点
            }}
          >
            {/* 预载中显形（自动预载与手动共用同一状态）；窗口揭示
                无网络往返，按钮即时放出更早消息。 */}
            {loadingMore ? (
              <span style={{ fontSize: 12, color: t.textSecondary }}>
                {tr("正在加载更早的消息…")}
              </span>
            ) : (
              <antd.Button
                size="small"
                type="link"
                onClick={() => {
                  if (threadGroups.hiddenCount > 0) revealWindow();
                  else kickLoadMore();
                }}
              >
                {threadGroups.hiddenCount > 0
                  ? tr("显示更早的消息 ↑")
                  : tr("加载更早的消息 ↑")}
              </antd.Button>
            )}
          </div>
        ) : visibleMessages.length > 0 ? (
          // 翻到头标记（Element「no more events」同款）。
          <div
            style={{
              textAlign: "center",
              fontSize: 11,
              color: t.textSecondary,
              paddingBottom: 8,
              opacity: 0.7,
              overflowAnchor: "none", // R2：同上，动态块不配做锚点
            }}
          >
            {tr("已到最早的消息")}
          </div>
        ) : null}
        {visibleMessages.length === 0 ? (
          loading ? (
            <antd.Typography.Text
              type="secondary"
              style={{ display: "block", textAlign: "center", padding: 24 }}
            >
              正在加载消息…
            </antd.Typography.Text>
          ) : (
            <antd.Empty description={tr("还没有消息，发一条打个招呼吧")} />
          )
        ) : (
          <div>
            {/* 16.46：顶哨兵——进入视口触发窗口上扩（overflow-anchor:none
                排除出原生滚动锚候选，与顶部动态块同口径）。 */}
            {v.vwin.start > 0 ? (
              <div ref={v.topSentinelRef} style={{ height: 1, overflowAnchor: "none" }} />
            ) : null}
            {v.renderItems.slice(v.vwin.start, v.vwin.end).map((item) => {
              // 批次 3：任务事件卡按 ts 与 turn 交错「插入」（不替换消息）。
              if (item.kind === "event") {
                return <TaskEventCard key={item.key} ev={item.ev} />;
              }
              const { turn, start, end } = item.range;
              // 批次 3 + 第二批：turn 拆三段（思考帧/工具调用/回答帧）。
              // 有过程的 turn → 渲染顺序 TurnHeader → 过程条 → 回答行；
              // 无过程的 turn（人聊）→ 仍由组首行自带 header（现状视觉），
              // 续行判定走 shouldContinueGroup（5 分钟 + 同日 + 同族）。
              const { thoughts: thoughtMsgs, calls } = splitTurn(turn, {
                isMine: (m: ChatMessage) => myUserId !== "" && m.sender === myUserId,
                workerMxids,
              });
              const thoughts: string[] = [];
              for (const m of thoughtMsgs) {
                const text = stripThinkingPrefix(m.body);
                if (text) thoughts.push(text);
              }
              const hasProcess = calls.length > 0 || thoughts.length > 0;
              const turnMine = myUserId !== "" && turn.sender === myUserId;
              const firstTop = start < v.tops.length ? v.tops[start] : null;
              const prevTop = start > 0 ? v.tops[start - 1] : null;
              // 日期分隔/未读线：有过程的 turn 提到 header 之前渲染
              // （顺序：分隔 → header → 过程条 → 回答行）；判定条件不变。
              const turnSep =
                hasProcess && firstTop ? wantsDateSeparator(prevTop, firstTop) : false;
              const turnUnread =
                hasProcess &&
                firstTop !== null &&
                readTs > 0 &&
                firstTop.origin_server_ts > readTs &&
                (!prevTop || prevTop.origin_server_ts <= readTs);
              const turnHeaderShowTime =
                firstTop !== null &&
                (hoveredId === firstTop.event_id ||
                  TOUCH_ONLY ||
                  start === v.renderedLastTopIdx);
              const turnAlign = {
                display: "flex",
                justifyContent: turnMine ? "flex-end" : "flex-start",
                padding: "0 6px",
              } as const;
              return (
                <div key={turn.id} data-turn-id={turn.id}>
                {turnUnread ? <ChatUnreadLine tr={tr} /> : null}
                {turnSep && firstTop ? (
                  <ChatDatePill ts={firstTop.origin_server_ts} t={t} tr={tr} />
                ) : null}
                {/* turn 级 header：头像 + 名字 + 时间/状态，只出现一次。 */}
                {hasProcess && firstTop ? (
                  <div style={turnAlign}>
                    <div style={{ maxWidth: "82%", minWidth: 0, paddingTop: 3 }}>
                      <TurnHeader
                        msg={firstTop}
                        room={room}
                        myUserId={myUserId}
                        t={t}
                        tr={tr}
                        showTime={turnHeaderShowTime}
                        workerSessionByMxid={workerSessionByMxid}
                        memberWorkerNames={memberWorkerNames}
                        workerRuntimeByMxid={workerRuntimeByMxid}
                        insertMention={insertMention}
                        openDetailMxid={openDetailMxid}
                        onDm={onDm}
                        onOpenWorkerChats={onOpenWorkerChats}
                      />
                    </div>
                  </div>
                ) : null}
                {/* 过程条在回答之前：思考 + 工具调用（流式中自动展开）。 */}
                {hasProcess ? (
                  <div
                    key={`${turn.id}-process`}
                    style={{ ...turnAlign, padding: "0 6px 3px" }}
                  >
                    <div style={{ maxWidth: "82%", minWidth: 0 }}>
                      <ProcessCollapseBar
                        calls={calls}
                        thoughts={thoughts}
                        active={turn.status === "active" && turn.id === lastTurnId}
                      />
                    </div>
                  </div>
                ) : null}
                {v.tops.slice(start, end).map((msg, i) => {
                  const idx = start + i;
                  const prev = idx > 0 ? v.tops[idx - 1] : null;
                  const sep =
                    hasProcess && i === 0
                      ? false
                      : wantsDateSeparator(prev, msg);
                  const mine = myUserId !== "" && msg.sender === myUserId;
                  // 16.46：窗口化后以「渲染窗末行」为末行（全列表尾不可见）。
                  const isLast = idx === v.renderedLastTopIdx;
                  // 有过程的 turn：header 已在 turn 顶只出现一次 → 行内全部
                  // 视为续行（不再重复头像/名字）；无过程的 turn：沿用
                  // dashboard MainGrouper 口径（5 分钟 + 同日 + 同族续行）。
                  const sameSender = hasProcess
                    ? true
                    : !sep && shouldContinueGroup(prev, msg);
                  // gutter 时间：hover ∥ 末行 ∥（触屏：组头行常显）——触屏无
                  // hover，tap 虽经 hoveredId 也能显时间，但 tap 的语义是
                  // 弹操作条（对消息动手）不是看时间；组头行（头像+名）常显
                  // 时间是移动端聊天通行做法，gutter 高 28px 固定不 reflow，
                  // 组内延续行照旧隐（tap 显）。
                  const showTime =
                    hoveredId === msg.event_id ||
                    isLast ||
                    (TOUCH_ONLY && !sameSender);
                  // 未读线：打开房间后新到的消息（ts > readTs）第一条前插线。
                  const unreadLine =
                    !(hasProcess && i === 0) &&
                    readTs > 0 &&
                    msg.origin_server_ts > readTs &&
                    (!prev || prev.origin_server_ts <= readTs);
                  // EMPTY_REPLIES 常量 fallback（任务 D §2.3）：此前 `|| []`
                  // 每渲染新建 [] → 行级 memo 该 props 引用永变、白做。
                  const replies =
                    threadGroups.repliesOf.get(msg.event_id) ?? EMPTY_REPLIES;
                  // 批次 3：无回复的工具帧吸收进本 turn 的过程折叠条
                  // （turn.toolCalls 聚合，见循环尾 ProcessCollapseBar）——
                  // 外层 key div 保留（日期分隔/未读线照旧），只省独立气泡行。
                  const absorbedTool =
                    isToolMessage(msg.body || "") && replies.length === 0;
                  // 思考 notice：同上不独立成行（正文改由上方过程折叠条承载）；
                  // 有回复的 notice 保留行——回复入口不能随正文一起消失。
                  const absorbedThinking =
                    !absorbedTool &&
                    replies.length === 0 &&
                    isThinkingNotice(msg, mine, workerMxids);
                  return (
                    <RoomChatMessageRow
                      key={msg.event_id || `${msg.sender}-${msg.origin_server_ts}`}
                      msg={msg}
                      idx={idx}
                      topsLen={v.tops.length}
                      sep={sep}
                      sameSender={sameSender}
                      unreadLine={unreadLine}
                      absorbedTool={absorbedTool}
                      absorbedThinking={absorbedThinking}
                      mine={mine}
                      hovered={hoveredId === msg.event_id}
                      showTime={showTime}
                      replies={replies}
                      activeThread={activeThread}
                      room={room}
                      myUserId={myUserId}
                      t={t}
                      tr={tr}
                      workerSessionByMxid={workerSessionByMxid}
                      memberWorkerNames={memberWorkerNames}
                      workerRuntimeByMxid={workerRuntimeByMxid}
                      visibleMessages={visibleMessages}
                      liveByRunId={liveByRunId}
                      teamName={teamName}
                      resolvedApprovals={resolvedApprovals}
                      onReact={onReact}
                      onDm={onDm}
                      onOpenWorkerChats={onOpenWorkerChats}
                      onOpenProject={onOpenProject}
                      onWorkflowIntervened={onWorkflowIntervened}
                      onRedact={onRedact}
                      onLoadOriginal={onLoadOriginal}
                      setHoveredId={setHoveredId}
                      hoverTimerRef={hoverTimerRef}
                      insertMention={insertMention}
                      openDetailMxid={openDetailMxid}
                      jumpWithEnsure={v.jumpWithEnsure}
                      handleApprovalAction={handleApprovalAction}
                      handleDeliverable={handleDeliverable}
                      setReplyTo={setReplyTo}
                      setEditing={setEditing}
                      setDraft={setDraft}
                      composerRef={composerRef}
                      setActiveThread={setActiveThread}
                    />
                  );
                })}
                </div>
              );
            })}
            {/* 16.46：底哨兵——进入视口触发窗口下扩。 */}
            {v.vwin.end < v.renderItems.length ? (
              <div ref={v.bottomSentinelRef} style={{ height: 1, overflowAnchor: "none" }} />
            ) : null}
          </div>
        )}
      </div>
      {!stickToBottom.isAtBottom ? (
        /* 悬浮右下：不在底部就显示（上翻即现，不依赖新消息到达）；
点击平滑置底并清零未读；回到底部自动消失。 */
        <div
          style={{
            position: "absolute",
            right: 14,
            // safe-area：notch/手势条设备上抬高到安全区之上
            bottom: "max(10px, env(safe-area-inset-bottom))",
            zIndex: 5,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}
        >
          {stickToBottom.unread > 0 ? (
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: PRIMARY,
                background: t.bubbleOther,
                border: `1px solid ${t.border}`,
                borderRadius: 10,
                padding: "1px 8px",
                whiteSpace: "nowrap",
              }}
            >
              {/* 封顶 99：长流式会话防徽章无限膨胀（>99 显「99 条新消息」）。 */}
              {Math.min(stickToBottom.unread, 99)} {tr("条新消息")}
            </span>
          ) : null}
          {/* 置底按钮：纯 div 圆（弃 antd Button——其 CSS 与 inline 尺寸对抗，
竖屏被纵向拉长）。flex:none 防 column wrapper 拉伸。44px 触控目标规则：
外层 44×44 命中盒 + 内层 38 视觉圆（恒圆）；hover/active 状态反馈走
全局类 .wb-jumpbottom（index.tsx 样式块）。 */}
          <div
            className="wb-jumpbottom"
            role="button"
            aria-label={tr("回到最新消息")}
            title={tr("回到最新消息")}
            // 16.46：窗口化置底（先尾锚窗口再平滑置底，见 jumpToBottomWindowed）。
            onClick={() => void v.jumpToBottomWindowed()}
            style={{
              width: 44,
              height: 44,
              flex: "none",
              boxSizing: "border-box",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <div
              style={{
                width: 38,
                height: 38,
                boxSizing: "border-box",
                borderRadius: "50%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: PRIMARY,
                color: "#fff",
                border: `1px solid ${PRIMARY}`,
                boxShadow: "0 2px 8px rgba(0,0,0,0.20)",
                fontSize: 16,
                lineHeight: 1,
              }}
            >
              ↓
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
