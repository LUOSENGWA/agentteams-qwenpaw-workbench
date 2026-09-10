import type * as ReactNS from "react";

import {
  deleteInboxEvent,
  fetchInboxEvents,
  fetchRoomApprovals,
  fetchRoomMentions,
  markInboxRead,
  sendApprovalCommand,
  type InboxEvent,
  type InviteRoom,
  type RoomApproval,
  type RoomMention,
} from "../api";
import { senderShort } from "./MessageSearch";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

const PRIMARY = "#FF7F16";

const SEV_COLOR: Record<string, string> = {
  CRITICAL: "#f5222d",
  HIGH: "#f5222d",
  MEDIUM: "#fa8c16",
  LOW: "#52c41a",
};

function formatWhen(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hh}:${mm}`;
}

/** 通知中心（B2，§6.6）：宿主 /console/inbox 事件流聚合。
 *  与 OS 通知/MenuBar 铃铛同一事件源（useOsNotifyPoller 同款端点）。
 *  30s 轮询 + 未读/全部筛选 + 全部已读 + 单条删除 + 待审批入口。
 *  refreshTick（SSE 事件驱动，用户 8/15 IM 式触发）：变化时立即刷新，
 *  无需等轮询周期。 */
export default function NotificationCenter(props: {
  onUnreadCount?: (count: number) => void;
  onGotoApprovals?: () => void;
  /** 带 room_id 的通知 → 跳房间（8/18 批次 1）；
   *  再版 13：eventId 可选 → 跳房间并定位到该消息。 */
  onGotoRoom?: (roomId: string, eventId?: string) => void;
  refreshTick?: number;
  /** v0.5.0-beta.10（邀请主动通知）：待接受邀请（/sync rooms.invite 段，
   *  WorkbenchPage 已随 /teams/sync 持有）——此处只做入口卡，接受/拒绝
   *  UI 留在团队概览（单一事实源，Tuwunel /join 修复不重复实现）。 */
  invites?: InviteRoom[];
  /** 跳团队概览处理邀请（chat tab + 无激活房间 → 邀请区可见）。 */
  onGotoInvites?: () => void;
}) {
  const { onUnreadCount, onGotoApprovals, onGotoRoom, refreshTick, invites, onGotoInvites } =
    props;
  const t = useThemeColors();
  const tr = useT();
  // 再版 13：房间通知（团队房间 @提到我，Matrix 侧——宿主 inbox 事件
  // 无 room_id 是「点击不跳转」的根因；真·团队通知在这里）。
  const [mentions, setMentions] = React.useState<RoomMention[]>([]);
  const [mentionsLoading, setMentionsLoading] = React.useState(true);
  const [mentionsError, setMentionsError] = React.useState("");
  const [events, setEvents] = React.useState<InboxEvent[]>([]);
  const [unread, setUnread] = React.useState(0);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [unreadOnly, setUnreadOnly] = React.useState(false);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [marking, setMarking] = React.useState(false);
  // v0.5.0-beta.10（审批主动通知）：房间级 Worker Tool Guard 审批请求——
  // 与上面「宿主待审批」（本机 QwenPaw 原生队列）不同源：Worker 的受控
  // 工具调用在 Matrix 房间发「🛡️ Approval Required」，不带 @人类，
  // 旧逻辑零提示（用户反馈：「只能在聊天群看见，并 @相关 worker」）。
  const [approvals, setApprovals] = React.useState<RoomApproval[]>([]);
  const [approvalsError, setApprovalsError] = React.useState("");
  const [approvalActing, setApprovalActing] = React.useState<string | null>(null);

  const loadApprovals = React.useCallback(async () => {
    try {
      const list = await fetchRoomApprovals(30);
      setApprovals(list);
      setApprovalsError("");
    } catch (e) {
      setApprovalsError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  /** 一键批准/拒绝：向房间发带 @Worker 的审批命令（RoomChat 审批卡同款
   *  语义）。v0.5.0-beta.10 再版 2：此前裸发命令（无 @）——群房间
   *  _require_mention=True 时 Worker 不消费；sender 缺失（异常数据）时
   *  降级为无 @ 命令（比不发强，DM 房间本就不需要 mention）。 */
  const doApproval = React.useCallback(
    async (a: RoomApproval, action: "approve" | "deny") => {
      const key = a.event_id || a.room_id;
      setApprovalActing(key);
      try {
        const cmd = action === "approve" ? a.approve_cmd : a.deny_cmd;
        const replyTo = a.event_id
          ? { event_id: a.event_id, sender: a.sender, body: a.body }
          : undefined;
        if (!a.sender) throw new Error(tr("审批消息缺少发送者，无法定向 @，请去房间手动处理"));
        await sendApprovalCommand(a.room_id, a.sender, cmd, replyTo);
        antd.message.success(
          action === "approve" ? tr("已发送批准命令（Worker 继续执行）") : tr("已发送拒绝命令"),
        );
        setApprovals((prev) => prev.filter((x) => (x.event_id || x.room_id) !== key));
      } catch (e) {
        antd.message.error(e instanceof Error ? e.message : tr("发送失败"));
      } finally {
        setApprovalActing(null);
      }
    },
    [tr],
  );

  const loadMentions = React.useCallback(async (silent = false) => {
    if (!silent) setMentionsLoading(true);
    try {
      const list = await fetchRoomMentions(30);
      setMentions(list);
      setMentionsError("");
    } catch (e) {
      setMentionsError(e instanceof Error ? e.message : String(e));
    } finally {
      setMentionsLoading(false);
    }
  }, []);

  const load = React.useCallback(async () => {
    try {
      const page = await fetchInboxEvents({
        limit: 50,
        unread_only: unreadOnly,
      });
      setEvents(page.events || []);
      setUnread(page.unread_count ?? 0);
      setTotal(page.total ?? (page.events || []).length);
      setError("");
      onUnreadCount?.(page.unread_count ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
    void loadMentions(true);
    void loadApprovals();
  }, [unreadOnly, onUnreadCount, loadMentions, loadApprovals]);

  // 30s 轮询（含未读计数 → tab badge）。
  React.useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30000);
    return () => window.clearInterval(timer);
  }, [load]);

  // SSE 事件触发（IM 式）：refreshTick 变化 → 立即刷新（不等轮询）。
  const tickRef = React.useRef(refreshTick);
  React.useEffect(() => {
    if (refreshTick !== undefined && refreshTick !== tickRef.current) {
      tickRef.current = refreshTick;
      void load();
    }
  }, [refreshTick, load]);

  // 待审批计数（顶部入口条，跳首页审批卡）= 房间审批源（load() 30s 轮询
  // 已含 loadApprovals）。v0.5.0-beta.10 再版 2：弃用宿主 push-messages
  // 队列（远程 Worker 审批在该进程内，本机队列恒 0——用户反馈「首页没有」）。

  const markAll = async () => {
    setMarking(true);
    try {
      await markInboxRead({ all: true });
      await load();
    } catch {
      /* 静默 */
    } finally {
      setMarking(false);
    }
  };

  const markOne = async (ev: InboxEvent) => {
    if (ev.read) return;
    try {
      await markInboxRead({ event_ids: [ev.id] });
      setEvents((prev) =>
        prev.map((e) => (e.id === ev.id ? { ...e, read: true } : e)),
      );
      setUnread((n) => Math.max(0, n - 1));
      onUnreadCount?.(Math.max(0, unread - 1));
    } catch {
      /* 静默 */
    }
  };

  const removeOne = async (ev: InboxEvent) => {
    try {
      await deleteInboxEvent(ev.id);
      setEvents((prev) => prev.filter((e) => e.id !== ev.id));
    } catch {
      /* 静默 */
    }
  };

  const sevColor = (sev: string) => SEV_COLOR[String(sev || "").toUpperCase()] || "#888";

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {/* 顶部工具条 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <antd.Typography.Title level={4} style={{ margin: 0 }}>
          🔔 {tr("通知中心")}
        </antd.Typography.Title>
        {unread > 0 ? (
          <antd.Badge count={unread} overflowCount={99} style={{ backgroundColor: PRIMARY }} />
        ) : null}
        <div style={{ flex: 1 }} />
        <antd.Segmented
          size="small"
          value={unreadOnly ? "unread" : "all"}
          onChange={(v: string | number) => setUnreadOnly(v === "unread")}
          options={[
            { value: "all", label: `${tr("全部")} (${total})` },
            { value: "unread", label: `${tr("未读")} (${unread})` },
          ]}
        />
        <antd.Button
          size="small"
          loading={marking}
          disabled={unread === 0}
          onClick={() => void markAll()}
        >
          ✓ {tr("全部已读")}
        </antd.Button>
        <antd.Button size="small" onClick={() => void load()}>
          ↻ {tr("刷新")}
        </antd.Button>
      </div>

      {/* 待审批入口（跳首页审批卡；房间审批源=Worker Tool Guard 真实队列） */}
      {approvals.length > 0 && onGotoApprovals ? (
        <div
          onClick={onGotoApprovals}
          style={{
            border: "1px solid rgba(255,127,22,0.4)",
            background: "rgba(255,127,22,0.08)",
            borderRadius: 10,
            padding: "10px 14px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ fontSize: 16 }}>🛡️</span>
          <span style={{ fontWeight: 600, color: PRIMARY, flex: 1 }}>
            {tr("有 {n} 条工具调用待审批", { n: approvals.length })}
          </span>
          <span style={{ color: t.textSecondary, fontSize: 12 }}>
            {tr("去首页审批")} ▸
          </span>
        </div>
      ) : null}

      {error ? (
        <div style={{ color: "#ff4d4f", fontSize: 13 }}>⚠️ {error}</div>
      ) : null}

      {/* v0.5.0-beta.10（邀请主动通知）：新邀请卡片 → 跳团队概览处理。
          OS toast/铃铛由后端 sync_watcher 写宿主收件箱（本区是面板内入口，
          防 toast 漏看——用户反馈：「邀请有时候收不到，要去 Element 点」）。 */}
      {invites && invites.length > 0 ? (
        <div>
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: t.text,
              marginBottom: 8,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            📩 {tr("邀请（{n}）", { n: invites.length })}
            <span style={{ fontSize: 11, color: t.textSecondary, fontWeight: 400 }}>
              {tr("新房间邀请 · 点击到团队概览接受/拒绝")}
            </span>
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            {invites.map((inv) => (
              <div
                key={inv.room_id}
                onClick={() => onGotoInvites?.()}
                title={tr("点击处理邀请")}
                style={{
                  border: "1px solid rgba(255,127,22,0.4)",
                  borderRadius: 10,
                  padding: "8px 12px",
                  background: "rgba(255,127,22,0.08)",
                  cursor: "pointer",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700, fontSize: 13, color: t.text, flex: "0 1 60%" }}>
                    {inv.name}
                  </span>
                  <span style={{ color: t.textSecondary, fontSize: 11.5 }}>
                    {tr("邀请人：")}
                    {inv.inviter ? senderShort(inv.inviter) : "—"}
                    {inv.inviter_ts ? ` · ${formatWhen(inv.inviter_ts)}` : ""}
                  </span>
                  <span style={{ flex: 1 }} />
                  <span style={{ color: PRIMARY, fontSize: 12, fontWeight: 600 }}>
                    {tr("去处理")} ▸
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* v0.5.0-beta.10（审批主动通知）：房间级 Worker Tool Guard 审批请求
          ——OS toast 由 sync_watcher 推宿主收件箱，此处可一键批准/拒绝
          （向房间发 /approval 命令，RoomChat 审批卡同款语义）。 */}
      <div>
        <div
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: t.text,
            marginBottom: 8,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          🛡️ {tr("待审批请求（{n}）", { n: approvals.length })}
          <span style={{ fontSize: 11, color: t.textSecondary, fontWeight: 400 }}>
            {tr("Worker 受控工具调用 · 一键批准/拒绝或去房间")}
          </span>
        </div>
        {approvalsError ? (
          <div style={{ color: t.textSecondary, fontSize: 12 }}>
            ⚠️ {tr("待审批请求加载失败")}：{approvalsError}
          </div>
        ) : approvals.length === 0 ? (
          <div style={{ color: t.textSecondary, fontSize: 12, padding: "4px 0" }}>
            {tr("暂无待审批的工具调用")}
          </div>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {approvals.map((a, idx) => (
              <div
                key={a.event_id || `${a.room_id}-${idx}`}
                style={{
                  border: "1px solid rgba(245,34,45,0.35)",
                  borderRadius: 10,
                  padding: "8px 12px",
                  background: t.cardBg,
                  animation: `wbResultIn 0.25s ease-out both`,
                  animationDelay: `${Math.min(idx, 8) * 30}ms`,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span
                    style={{
                      color: PRIMARY,
                      fontWeight: 600,
                      fontSize: 12.5,
                      maxWidth: "50%",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {a.room_name || a.room_id}
                  </span>
                  <span style={{ fontWeight: 600, fontSize: 12.5, color: t.text }}>
                    {senderShort(a.sender)}
                  </span>
                  <span style={{ flex: 1 }} />
                  <span style={{ color: t.textSecondary, fontSize: 11.5 }}>
                    {formatWhen(a.ts)}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 12.5,
                    color: t.textSecondary,
                    marginTop: 2,
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {a.body}
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center" }}>
                  <antd.Button
                    size="small"
                    type="primary"
                    loading={approvalActing === (a.event_id || a.room_id)}
                    onClick={() => void doApproval(a, "approve")}
                  >
                    ✓ {tr("批准")}
                  </antd.Button>
                  <antd.Button
                    size="small"
                    danger
                    disabled={approvalActing === (a.event_id || a.room_id)}
                    onClick={() => void doApproval(a, "deny")}
                  >
                    ✗ {tr("拒绝")}
                  </antd.Button>
                  <antd.Button
                    size="small"
                    type="text"
                    style={{ fontSize: 11.5 }}
                    onClick={() => onGotoRoom?.(a.room_id, a.event_id || undefined)}
                  >
                    💬 {tr("去房间")}
                  </antd.Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 房间通知（再版 13：团队房间 @提到我 → 点击跳房间+定位消息） */}
      <div>
        <div
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: t.text,
            marginBottom: 8,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          💬 {tr("房间通知")}
          <span style={{ fontSize: 11, color: t.textSecondary, fontWeight: 400 }}>
            {tr("团队房间 @提到你 · 点击跳转对应消息")}
          </span>
        </div>
        {mentionsLoading ? (
          <antd.Skeleton active paragraph={{ rows: 2 }} />
        ) : mentionsError ? (
          <div style={{ color: t.textSecondary, fontSize: 12 }}>
            ⚠️ {tr("房间通知加载失败")}：{mentionsError}
          </div>
        ) : mentions.length === 0 ? (
          <div style={{ color: t.textSecondary, fontSize: 12, padding: "4px 0" }}>
            {tr("暂无 @你 的房间消息")}
          </div>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {mentions.map((m, idx) => (
              <div
                key={m.event_id || `${m.room_id}-${idx}`}
                onClick={() => onGotoRoom?.(m.room_id, m.event_id)}
                title={tr("点击跳转对应消息")}
                style={{
                  border: `1px solid ${t.border}`,
                  borderRadius: 10,
                  padding: "8px 12px",
                  background: t.cardBg,
                  cursor: "pointer",
                  animation: `wbResultIn 0.25s ease-out both`,
                  animationDelay: `${Math.min(idx, 8) * 30}ms`,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    style={{
                      color: PRIMARY,
                      fontWeight: 600,
                      fontSize: 12.5,
                      maxWidth: "55%",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {m.room_name || m.room_id}
                  </span>
                  <span style={{ fontWeight: 600, fontSize: 12.5, color: t.text }}>
                    {senderShort(m.sender)}
                  </span>
                  <span style={{ flex: 1 }} />
                  <span style={{ color: t.textSecondary, fontSize: 11.5 }}>
                    {formatWhen(m.ts)}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 12.5,
                    color: t.textSecondary,
                    marginTop: 2,
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {m.body}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 宿主通知（本机 QwenPaw Agent 事件：审批/cron/邮件等） */}
      <div>
        <div
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: t.text,
            marginBottom: 8,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          🖥️ {tr("宿主通知")}
          <span style={{ fontSize: 11, color: t.textSecondary, fontWeight: 400 }}>
            {tr("本机 QwenPaw 事件 · 与团队房间通知不同源，多数无房间可跳")}
          </span>
        </div>

      {/* 事件列表 */}
      {loading ? (
        <antd.Skeleton active paragraph={{ rows: 4 }} />
      ) : events.length === 0 ? (
        <antd.Empty
          description={
            unreadOnly ? tr("没有未读通知") : tr("暂无通知")
          }
        />
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {events.map((ev, idx) => {
            const sev = sevColor(ev.severity);
            const isExpanded = expandedId === ev.id;
            // 8/29 re16：房间跳转能力区分——宿主事件多数无 room_id（审批/cron/
            // 记忆等本机事件），带 room_id 的点击即跳（re12 行为保留）。
            const evRoomId =
              typeof ev.payload?.room_id === "string"
                ? (ev.payload.room_id as string)
                : "";
            return (
              <div
                key={ev.id}
                title={
                  evRoomId
                    ? tr("点击跳转对应房间")
                    : tr("本机事件 · 无可跳转房间（点击展开/标记已读）")
                }
                style={{
                  border: `1px solid ${ev.read ? t.border : sev}`,
                  borderRadius: 10,
                  padding: "10px 12px",
                  background: ev.read ? t.cardBg : `${sev}0f`,
                  cursor: "pointer",
                  animation: `wbResultIn 0.25s ease-out both`,
                  animationDelay: `${Math.min(idx, 10) * 30}ms`,
                }}
                onClick={() => {
                  if (!ev.read) void markOne(ev);
                  // 再版 12：卡片点击即跳转——带 room_id 的通知直接跳对应房间
                  //（此前只有右下角「去房间」小按钮能跳，卡片点击仅展开+已读，
                  // 用户真机反馈「通知点击要能跳转」）。无 room_id 保持展开切换。
                  if (evRoomId) {
                    onGotoRoom?.(evRoomId);
                    return;
                  }
                  setExpandedId(isExpanded ? null : ev.id);
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: ev.read ? "#ccc" : sev,
                      flexShrink: 0,
                      marginTop: 5,
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        flexWrap: "wrap",
                      }}
                    >
                      <span
                        style={{
                          fontWeight: ev.read ? 500 : 700,
                          fontSize: 13.5,
                          color: t.text,
                        }}
                      >
                        {ev.title}
                      </span>
                      {ev.severity ? (
                        <antd.Tag color={sev} style={{ margin: 0, fontSize: 11 }}>
                          {ev.severity}
                        </antd.Tag>
                      ) : null}
                      {!ev.read ? (
                        <span style={{ color: sev, fontSize: 11, fontWeight: 700 }}>
                          {tr("未读")}
                        </span>
                      ) : null}
                      <span style={{ flex: 1 }} />
                      <span style={{ color: t.textSecondary, fontSize: 11.5 }}>
                        {formatWhen(ev.created_at)}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 12.5,
                        color: t.textSecondary,
                        marginTop: 2,
                        display: "-webkit-box",
                        WebkitLineClamp: isExpanded ? undefined : 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {ev.body}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        marginTop: 4,
                      }}
                    >
                      {ev.agent_id ? (
                        <span style={{ color: t.textSecondary, fontSize: 11 }}>
                          {String(ev.agent_id).split(":")[0].replace(/^@/, "")}
                        </span>
                      ) : null}
                      {ev.source_type ? (
                        <span style={{ color: t.textSecondary, fontSize: 11 }}>
                          {ev.source_type}
                        </span>
                      ) : null}
                      <span style={{ flex: 1 }} />
                      {typeof ev.payload?.room_id === "string" && ev.payload.room_id ? (
                        <antd.Button
                          type="text"
                          size="small"
                          style={{ fontSize: 11, padding: "0 4px" }}
                          onClick={(e: ReactNS.MouseEvent) => {
                            e.stopPropagation();
                            onGotoRoom?.(String(ev.payload?.room_id));
                          }}
                          title={tr("去房间")}
                        >
                          💬 {tr("去房间")}
                        </antd.Button>
                      ) : null}
                      <antd.Button
                        type="text"
                        size="small"
                        style={{ fontSize: 11, padding: "0 4px" }}
                        onClick={(e: ReactNS.MouseEvent) => {
                          e.stopPropagation();
                          void removeOne(ev);
                        }}
                        title={tr("删除")}
                      >
                        🗑
                      </antd.Button>
                    </div>
                  </div>
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
