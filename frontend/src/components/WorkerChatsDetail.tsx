/** WorkerChats 子模块——自 WorkerChats.tsx 纯搬移拆出
 * （行为零变化）。 */
import type * as ReactNS from "react";
import { PictureIcon, UserIcon, WarnIcon, RobotIcon } from "./icons";
import { useT } from "../i18n";
import type { WorkerChatSpec } from "../api";
import MdText from "./MdText";
import WorkerSessionDot from "./WorkerSessionDot";
import { CHANNEL_COLORS, formatTime } from "./WorkerChatsShared";
import type { DetailItem, MsgPart } from "./WorkerChatsShared";
import { StepLine, StepsCollapse } from "./WorkerChatsSteps";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export function ChatDetail({
  openId,
  openChatSpec,
  status,
  detailErr,
  detailLoading,
  msgsLen,
  turns,
  copyParts,
  listRef,
  onScroll,
  onBack,
}: {
  openId: string;
  openChatSpec: WorkerChatSpec | undefined;
  status: "" | "idle" | "running";
  detailErr: string;
  detailLoading: boolean;
  msgsLen: number;
  turns: DetailItem[];
  copyParts: (parts: MsgPart[]) => void;
  listRef: { current: HTMLDivElement | null };
  onScroll: () => void;
  onBack: () => void;
}) {
  const tr = useT();
  return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10, height: "100%", minHeight: 0 }}>
        {/* ：气泡 hover 复制钮样式。 */}
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
          /* 纯触屏无 hover：复制按钮常显，否则 hover 才显 = 触屏不可达 */
          @media (hover: none) {
            .wb-chat-bubble .wb-copy { opacity: 1; }
          }
        `}</style>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", flex: "0 0 auto" }}>
          <antd.Button
            size="small"
            icon={<span>←</span>}
            onClick={onBack}
          >
            {tr("会话列表")}
          </antd.Button>
          <span style={{ fontWeight: 600, fontSize: 13.5 }}>
            {openChatSpec?.name || openId.slice(0, 12)}
          </span>
 {/* （13.9 「蓝点能不能改成 QwenPaw 同款
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
          {/* 会话级 loop 标签撤出——显示位置=聊天页
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
            ref={listRef}
            onScroll={onScroll}
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
 {/* （「会话页面依旧不能滚动」根因·浏览器 harness
 实证）：13.5 的 display:grid + alignContent:"end" 在内容超容器
 时顶部溢出进入不可滚动区（scrollTop 恒 0，实测 scrollH==clientH）
 ——上半截会话永远看不了。改普通块级流 + 既有 JS 滚底
 （scrollTop=scrollHeight，实测 scrollable=true）。 */}
            {detailLoading ? (
              <antd.Spin size="small" />
            ) : msgsLen === 0 ? (
              <antd.Alert type="info" showIcon message={tr("该会话暂无消息")} />
            ) : (
              /* （13.6 「要模仿 QwenPaw 的会话消息折叠和
 渲染」）：QwenPaw result-only 轮分组——每轮只显示最后一条文本
 （assistant 气泡），中间工具/思考步收进「N 步」pill（懒渲染，
 点开才渲染子行）；user 右气泡 / error 红线恒可见 / system 居中。
 旧版逐条平铺 + tool 块 RAW JSON 输出，全部替换。 */
              turns.map((it) => {
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
                            background: "color-mix(in srgb, var(--app-accent, #FF7F16) 14%, transparent)",
                            border: "1px solid color-mix(in srgb, var(--app-accent, #FF7F16) 35%, transparent)",
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
                      {/* （QwenPaw 化：HostBubbles 同款
 Avatar 分侧——user 右 / assistant 左）。 */}
                      <antd.Avatar size="small" style={{ background: "var(--app-accent, #FF7F16)", flexShrink: 0 }}>
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
                    {/* ：assistant 左 Avatar。 */}
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
