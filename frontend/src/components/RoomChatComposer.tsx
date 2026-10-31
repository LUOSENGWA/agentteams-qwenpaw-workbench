import type * as ReactNS from "react";
import AgentActivityTrack from "./AgentActivityTrack";
import {
  CloseIcon,
  EditIcon,
} from "./icons";
import { WbTooltip } from "./WbTooltip";
import {
  PRIMARY,
  senderShortName,
} from "./RoomChatShared";
import type {RoomChatProps } from "./RoomChat";
import type {RoomChatCoreState } from "./RoomChatCore";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
// 宿主 antdIcons 可能非全量（部署版 vs SC main 差异）——缺图标降级为空组件，
// 避免 React #130（undefined 组件）拖垮聊天室。
const icons = (host.antdIcons || {}) as Record<string, ReactNS.ComponentType>;
const EmptyIcon = (() => null) as unknown as ReactNS.FC<Record<string, unknown>>;
const icon = (name: string): ReactNS.FC<Record<string, unknown>> =>
  (icons[name] as ReactNS.FC<Record<string, unknown>>) || EmptyIcon;
const ReplyOutlined = icon("ReplyOutlined");
const PaperClipOutlined = icon("PaperClipOutlined");
const LinkOutlined = icon("LinkOutlined");
export function RoomChatComposer(props: { p: RoomChatProps; c: RoomChatCoreState }) {
  const { p, c } = props;
  const {
    room,
    sending,
    // 15.38 拆分回归修：拆分前单文件版解构带默认 `= true`（2c81f15 L1715），
    // Composer 裸读原始 props 丢了默认 → 调用方不传时 undefined 落「无权限」分支。
    // 与 RoomChatCore L54 同款。
    canSend = true,
    onSendFiles,
    activityProject,
    onOpenProject,
    onWorkflowIntervened,
  } = p;
  const {
    draft,
    setDraft,
    fileRefs,
    setFileRefs,
    setRefPickerOpen,
    editing,
    setEditing,
    mentionQuery,
    mentionIndex,
    setMentionIndex,
    replyTo,
    setReplyTo,
    roomLoop,
    teamName,
    composerRef,
    composerBoxRef,
    fileInputRef,
    t,
    tr,
    handleSend,
    mentionTargets,
    insertMention,
    mentionCandidates,
    confirmMention,
    handleDraftChange,
    handleKeyDown,
    narrow,
  } = c;
  if (!room) {
    return null;
  }
  const composerAttachBtn = onSendFiles ? (
    <>
      <WbTooltip title={tr("发送文件/图片")}>
        <antd.Button
          type="text"
          size="small"
          icon={<PaperClipOutlined />}
          loading={sending}
          onClick={() => fileInputRef.current?.click()}
        />
      </WbTooltip>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          e.target.value = ""; // 重置——同一文件可再次选择
          if (files.length) void onSendFiles(files);
        }}
      />
    </>
  ) : null;
  // 15.14：发送按钮常显（真机反馈「输入框发送按钮要加回来」）——空输入时
  // disabled（不发），不再随 draft 有无消失（旧写法 draft.trim()?…:null
  // 让空态整块消失，移动端误以为「没有发送键」）。
  // #87：有已选引用时（即使文本空）发送键可用。
  const canComposerSend = !!(draft.trim() || fileRefs.length > 0);
  const composerSendBtn = (
    <antd.Button
      size={narrow ? "small" : undefined}
      loading={sending}
      disabled={!canComposerSend}
      onClick={() => void handleSend()}
      style={{
        backgroundColor: canComposerSend ? PRIMARY : undefined,
        borderColor: canComposerSend ? PRIMARY : undefined,
        color: canComposerSend ? "#fff" : undefined,
      }}
    >
      {tr("发送")}
    </antd.Button>
  );

  return (
      <div
        style={{
          display: "grid",
          gap: 8,
          paddingTop: 12,
          borderTop: `1px solid ${t.border}`,
          flexShrink: 0,
        }}
      >
        {/* ：composer 上方
 任务进度 + HITL 内联轨（数据=当前房间项目 workflow，与
 liveWorkflows 同正源，零新请求；无匹配/终态自隐）。 */}
        <AgentActivityTrack
          project={activityProject ?? null}
          onOpenProject={onOpenProject}
          onWorkflowIntervened={onWorkflowIntervened}
        />
        {replyTo ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: t.bubbleMine,
              borderRadius: 8,
              padding: "6px 10px",
              fontSize: 13,
            }}
          >
            <ReplyOutlined style={{ color: PRIMARY, flexShrink: 0 }} />
            <span
              style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#666" }}
              // 15.14 命名约定：正文短名（display_name 优先），完整 MXID 走悬停。
              title={replyTo.sender}
            >
              回复 <b>{senderShortName(replyTo.sender, room)}</b>
              {replyTo.body ? <>：{replyTo.body.slice(0, 80)}</> : null}
            </span>
            <antd.Button
              type="text"
              size="small"
              style={{ fontSize: 12 }}
              title={tr("取消回复")}
              onClick={() => setReplyTo(null)}
            >
              <CloseIcon size={12} />
            </antd.Button>
          </div>
        ) : null}
        {/* 编辑 banner（Element 同款「正在编辑此消息」）。 */}
        {editing ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
 background: "color-mix(in srgb, var(--app-accent, #FF7F16) 8%, transparent)",
 border: "1px solid color-mix(in srgb, var(--app-accent, #FF7F16) 40%, transparent)",
              borderRadius: 8,
              padding: "6px 10px",
              fontSize: 13,
            }}
          >
            <span style={{ color: PRIMARY, flexShrink: 0, display: "inline-flex" }}><EditIcon size={13} /></span>
            <span
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: "#666",
              }}
            >
              {tr("正在编辑这条消息")}
              {editing.body ? <>：{editing.body.slice(0, 80)}</> : null}
            </span>
            <antd.Button
              type="text"
              size="small"
              style={{ fontSize: 12 }}
              title={tr("取消编辑")}
              onClick={() => {
                setEditing(null);
                setDraft("");
              }}
            >
              <CloseIcon size={12} />
            </antd.Button>
          </div>
        ) : null}
        {mentionTargets.length > 0 ? (
          <div
            style={
              narrow
                ? {
                    display: "flex",
                    gap: 6,
                    flexWrap: "nowrap",
                    overflowX: "auto",
                    overflowY: "hidden",
                    alignItems: "center",
                    paddingBottom: 2,
                  }
                : { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }
            }
          >
            {mentionTargets.map(([mxid, member]) => (
              <antd.Tag
                key={mxid}
                style={{ margin: 0, cursor: "pointer", flexShrink: 0 }}
                onClick={() => insertMention(mxid)}
              >
                @
                {member?.display_name?.trim() ||
                  (mxid.split(":")[0] || mxid).replace(/^@/, "")}
              </antd.Tag>
            ))}
            {/* 提示「点击成员插入 @点名」已删——窄屏它把成员 @tag 栏纵向拉长
（成员 tag 才是功能主体，点击即插入 @ 点名，无需再提示）。 */}
          </div>
        ) : null}
        {canSend ? (
          // 输入框 + 操作行收进
          // 同一圆角容器——旧版输入框裸挂、按钮行游离下方，观感散。
          // 外层不写 overflow:hidden（@mention 弹层 absolute 向上溢出，
          // 裁掉就废了）；圆角由容器边框 + 内层各块自然贴合。
          <div
            style={{
              border: `1px solid ${t.border}`,
              borderRadius: 10,
              background: t.cardBg,
            }}
          >
          <div style={{ position: "relative" }}>
            {/* @mention 弹层：输入框正上方，Element 同款（圆角只圆上两角）。 */}
            {mentionQuery !== null && mentionCandidates.length > 0 ? (
              <div
                style={{
                  position: "absolute",
                  bottom: "100%",
                  left: 0,
                  right: 0,
                  zIndex: 10,
                  background: t.popoverBg,
                  border: `1px solid ${t.border}`,
                  borderRadius: "8px 8px 0 0",
                  boxShadow: "0 -4px 12px rgba(0,0,0,0.1)",
                  // 竖屏 @mention 弹层随收窄被"纵向拉长"（窄宽+260px 高=又高又窄）：
                  // narrow 限高 150px，少显几条、别盖住半屏（竖屏优化）。
                  maxHeight: narrow ? 150 : 260,
                  overflowY: "auto",
                  padding: 4,
                }}
                role="listbox"
              >
                {mentionCandidates.map((c, i) => {
                  const name =
                    c.member?.display_name?.trim() ||
                    (c.mxid.split(":")[0] || c.mxid).replace(/^@/, "");
                  return (
                    <div
                      key={c.mxid}
                      role="option"
                      aria-selected={i === mentionIndex}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        confirmMention(c);
                      }}
                      onMouseEnter={() => setMentionIndex(i)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 10px",
                        borderRadius: 6,
                        cursor: "pointer",
                        background:
                          i === mentionIndex ? "color-mix(in srgb, var(--app-accent, #FF7F16) 10%, transparent)" : "transparent",
                      }}
                    >
                      <antd.Avatar
                        size={24}
                        style={{ backgroundColor: PRIMARY, fontSize: 12, flexShrink: 0 }}
                      >
                        {name.slice(0, 1).toUpperCase()}
                      </antd.Avatar>
                      {/* 候选行单行 nowrap+固定行高：此前 name 无 nowrap，
    窄屏长名换行→每行被纵向拉长。name flex:1 主占位、mxid 次级收缩，均 ellipsis。 */}
                      <span style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
                      <span style={{ fontSize: 12, color: t.textSecondary, minWidth: 0, flexShrink: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {c.mxid}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : null}
            {/* #87 已选引用 chip 行（发送前可单个移除）——有选中才占行。 */}
            {fileRefs.length > 0 ? (
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 4,
                  padding: "4px 4px 0",
                }}
              >
                {fileRefs.map((r) => (
                  <antd.Tag
                    key={r.key}
                    color="blue"
                    closable
                    style={{
                      marginInlineEnd: 0,
                      fontSize: 12,
                      maxWidth: 220,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    onClose={(e: { preventDefault: () => void }) => {
                      e.preventDefault();
                      setFileRefs((prev) =>
                        prev.filter((x) => x.key !== r.key),
                      );
                    }}
                  >
                    {r.name}
                  </antd.Tag>
                ))}
              </div>
            ) : null}
            {/* 输入框 + 按钮：窄屏 附件(左)|输入框(自动增高≤5行)|发送(右) 同行；宽屏输入框整行。
      拖拽手柄已删——改 autoSize 随内容自动增高（1~5 行封顶），无需手动拖；表情按钮已删。 */}
            <div style={{ display: narrow ? "flex" : "block", alignItems: "flex-end", gap: narrow ? 6 : 0 }}>
              {narrow ? (
                <div style={{ flexShrink: 0, paddingBottom: 2 }}>{composerAttachBtn}</div>
              ) : null}
              <div ref={composerBoxRef} style={{ flex: "1 1 auto", minWidth: 0, width: "100%" }}>
                <antd.Input.TextArea
                  ref={composerRef}
                  value={draft}
                  autoSize={{ minRows: 1, maxRows: 5 }}
                  style={{ resize: "none" }}
                  placeholder={
                    editing
                      ? tr("编辑消息…（Enter 保存，Shift+Enter 换行，Esc 取消编辑）")
                      : replyTo
                        ? tr("发送回复…（Enter 发送，Shift+Enter 换行，Esc 取消回复）")
                        : tr("输入消息，@名字 可以点名成员（Enter 发送，Shift+Enter 换行）")
                  }
                  onChange={handleDraftChange}
                  onKeyDown={handleKeyDown}
                />
              </div>
              {narrow ? (
                <div style={{ flexShrink: 0, paddingBottom: 2 }}>{composerSendBtn}</div>
              ) : null}
            </div>
          </div>
          {/* 操作行移进圆角容器（Element：与输入框同
 块）——loop 状态 chip 居左（QwenPaw LoopModeSelector 同位），
 表情/附件/发送居右。chip 仅 1:1 Worker 房间且 Worker 有激活
 loop 时出现（轮询 10s；404 旧 runtime 恒不显）。 */}
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              alignItems: "center",
              gap: 4,
              // 窄屏：按钮已内联输入框行，此操作行仅放 loop chip（罕见）→padding 收紧不留空。
              padding: narrow ? "0 10px" : "2px 8px 8px 10px",
            }}
          >
            {roomLoop ? (
              <WbTooltip
                title={
                  roomLoop.mode?.description ||
                  roomLoop.mode?.name ||
                  tr("Worker 正在执行激活 loop")
                }
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    marginRight: "auto",
                    fontSize: 12,
                    lineHeight: "22px",
                    padding: "0 10px",
                    borderRadius: 11,
                    whiteSpace: "nowrap",
                    // 深色档深琥珀/深蓝字→亮向，底色加浓
                    color:
                      roomLoop.state === "awaiting_user"
                        ? (t.mode === "dark" ? "#faad14" : "#d46b08")
                        : (t.mode === "dark" ? "#4096ff" : "#0958d9"),
                    background:
                      roomLoop.state === "awaiting_user"
                        ? (t.mode === "dark" ? "rgba(250,173,20,0.16)" : "rgba(250,173,20,0.12)")
                        : (t.mode === "dark" ? "rgba(24,144,255,0.16)" : "rgba(24,144,255,0.10)"),
                    border: `1px solid ${
                      roomLoop.state === "awaiting_user"
                        ? "rgba(250,173,20,0.40)"
                        : "rgba(24,144,255,0.35)"
                    }`,
                  }}
                >
                  <span
                    className={
                      roomLoop.state === "running"
                        ? "wb-loop-dot running"
                        : "wb-loop-dot"
                    }
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      flexShrink: 0,
                      background:
                        roomLoop.state === "awaiting_user" ? "#faad14" : "#1890ff",
                    }}
                  />
                  {tr("loop: {m}", {
                    m: roomLoop.mode?.name || roomLoop.mode?.id || "…",
                  })}
                  <span style={{ opacity: 0.7 }}>
                    {roomLoop.state === "awaiting_user"
                      ? tr("等待输入")
                      : tr("运行中")}
                  </span>
                </span>
              </WbTooltip>
            ) : null}
            {/* #87 引用工作区文件：仅团队房间（房间名 "Team: <name>"
 推得出 team）显示——按钮与附件同款 text 形态。 */}
            {teamName ? (
              <WbTooltip title={tr("引用工作区文件")}>
                <antd.Button
                  type="text"
                  size="small"
                  icon={<LinkOutlined />}
                  aria-label={tr("引用工作区文件")}
                  onClick={() => setRefPickerOpen(true)}
                />
              </WbTooltip>
            ) : null}
            {/* 附件/发送：宽屏在此操作行；窄屏已内联到输入框行（上）。表情按钮已删。 */}
            {!narrow ? (
              <>
                {composerAttachBtn}
                {composerSendBtn}
              </>
            ) : null}
          </div>
          </div>
        ) : (
          <div
            style={{
              textAlign: "center",
              fontStyle: "italic",
              color: t.textSecondary,
              padding: "18px 0",
              fontSize: 13,
            }}
          >
            {tr("你没有在此房间发送消息的权限")}
          </div>
        )}
      </div>
  );
}
