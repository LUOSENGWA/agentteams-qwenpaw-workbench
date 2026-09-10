import type * as ReactNS from "react";

import {
  acceptInvite,
  rejectInvite,
  type InviteRoom,
  type TeamMember,
  type TeamRoom,
  leaveRoom,
  forgetRoom,
} from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { MxcAvatar } from "../MxcAvatar";
import { formatChatTime } from "../util";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
const icons = (host.antdIcons || {}) as Record<string, ReactNS.ComponentType>;
const EmptyIcon = (() => null) as unknown as ReactNS.FC<Record<string, unknown>>;
const pick = (name: string): ReactNS.FC<Record<string, unknown>> =>
  (icons[name] as ReactNS.FC<Record<string, unknown>>) || EmptyIcon;
const ReloadIcon = pick("ReloadOutlined");

// ── UI 常量（与 WorkbenchPage 视觉一致）──────────────────────────────
const PRIMARY = "#FF7F16"; // 品牌主色
const GREEN = "#52c41a"; // 状态绿（DM 标签）
const FAV_KEY = "agentteams-qwenpaw-workbench:favorites";
const CARD_RADIUS = 10; // 卡片圆角

/** 成员显示名：优先 display_name，否则取 MXID 的 localpart（@ 前段）。 */
function memberShortName(mxid: string, member?: TeamMember): string {
  if (member?.display_name && member.display_name.trim()) {
    return member.display_name;
  }
  const localpart = (mxid.split(":")[0] || mxid).replace(/^@/, "");
  return localpart || mxid;
}

function UnreadBadge({ room }: { room: TeamRoom }) {
  if ((room.unread_highlight || 0) > 0) {
    return (
      <antd.Badge
        count={room.unread_highlight}
        overflowCount={99}
        style={{ marginLeft: 8 }}
      />
    );
  }
  if ((room.unread || 0) > 0) {
    return (
      <antd.Badge
        count={room.unread}
        overflowCount={99}
        color="#bfbfbf"
        style={{ marginLeft: 8 }}
      />
    );
  }
  return null;
}

/* v0.5.0-beta.12（A8c-b，dashboard 对齐：房间卡最后消息正文预览）。
   72 字截断 + 媒体标记（图片 🖼 / 文件 📎，按扩展名判定；后端 last_body
   已含 m.image/m.file 的 body=文件名）。 */
const MEDIA_IMG_RE = /\.(png|jpe?g|gif|webp|heic|bmp|svg)$/i;
const MEDIA_FILE_RE =
  /\.(pdf|docx?|xlsx?|pptx?|zip|tar|gz|7z|rar|mp4|mov|mkv|avi|mp3|wav|m4a|csv|json|log|txt)$/i;
function lastBodyPreview(
  body?: string,
): { text: string; marker: string } | null {
  const b = (body || "").replace(/\s+/g, " ").trim();
  if (!b) return null;
  const marker = MEDIA_IMG_RE.test(b) ? "🖼 " : MEDIA_FILE_RE.test(b) ? "📎 " : "";
  return { text: b.length > 72 ? b.slice(0, 72) + "…" : b, marker };
}

/** 团队群卡片：名称+未读+成员 chips（点成员发 DM）+头像堆叠。 */
function GroupCard({
  room,
  user_id,
  onOpenRoom,
  onDm,
  isFavorite = false,
  onToggleFavorite,
  onExitRoom,
}: {
  room: TeamRoom;
  user_id?: string;
  onOpenRoom?: (roomId: string) => void;
  onDm?: (mxid: string, roomId?: string) => void;
  /** 0.4.99 B3：收藏态（客户端本地）。 */
  isFavorite?: boolean;
  onToggleFavorite?: (roomId: string) => void;
  /** 5.0.0 release：房间 ⋯ 菜单（退出 / 退出并删除，Element 同款列表操作）。 */
  onExitRoom?: (room: TeamRoom, forget: boolean) => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  const memberEntries = Object.entries(room.members || {}).slice(0, 3);
  return (
    <antd.Card
      hoverable
      onClick={() => onOpenRoom?.(room.room_id)}
      style={{ borderRadius: CARD_RADIUS, cursor: "pointer" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontWeight: 600,
              fontSize: 15,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {room.name}
            <UnreadBadge room={room} />
            <span
              style={{
                fontSize: 11,
                color: t.textSecondary,
                fontWeight: 400,
                marginLeft: 8,
              }}
            >
              {formatChatTime(room.last_ts)}
            </span>
            {/* 0.4.99 B3：收藏切换（stopPropagation 防误开房间） */}
            <span
              role="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleFavorite?.(room.room_id);
              }}
              style={{
                cursor: "pointer",
                fontSize: 15,
                color: isFavorite ? "#faad14" : t.textSecondary,
                opacity: isFavorite ? 1 : 0.45,
                marginLeft: 6,
              }}
              title={isFavorite ? tr("取消收藏") : tr("收藏到顶部")}
            >
              {isFavorite ? "★" : "☆"}
            </span>
            {/* 5.0.0 release：房间 ⋯ 菜单（退出/退出并删除，Element 列表操作同款） */}
            <span
              role="button"
              onClick={(e) => e.stopPropagation()}
              style={{ display: "inline-block" }}
            >
              <antd.Dropdown
                trigger={["click"]}
                menu={{
                  items: [
                    {
                      key: "leave",
                      danger: true,
                      label: `🚪 ${tr("退出房间")}`,
                    },
                    {
                      key: "leave-forget",
                      danger: true,
                      label: `🗑️ ${tr("退出并删除")}`,
                    },
                  ],
                  onClick: ({ key }: { key: string }) =>
                    onExitRoom?.(room, key === "leave-forget"),
                }}
              >
                <span
                  style={{
                    cursor: "pointer",
                    fontSize: 14,
                    opacity: 0.45,
                    marginLeft: 2,
                  }}
                >
                  ⋯
                </span>
              </antd.Dropdown>
            </span>
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
            <antd.Tag style={{ margin: 0 }}>{room.member_count} 人</antd.Tag>
          </div>
          {/* v0.5.0-beta.12（A8c-b）：最后消息正文预览（72 字 + 媒体标记）。 */}
          {(() => {
            const p = lastBodyPreview(room.last_body);
            return p ? (
              <div
                style={{
                  fontSize: 12,
                  color: t.textSecondary,
                  marginTop: 4,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={p.marker + p.text}
              >
                {p.marker}
                {p.text}
              </div>
            ) : null;
          })()}
          {/* 成员 chips：点击成员 → DM（任务发起入口） */}
          {onDm ? (
            <div
              style={{
                display: "flex",
                gap: 6,
                marginTop: 8,
                flexWrap: "wrap",
              }}
            >
              {Object.entries(room.members || {}).map(([mxid, member]) => (
                <antd.Tag
                  key={mxid}
                  style={{
                    margin: 0,
                    cursor: mxid === user_id ? "default" : "pointer",
                  }}
                  onClick={(e: ReactNS.MouseEvent) => {
                    e.stopPropagation();
                    if (mxid !== user_id) onDm(mxid);
                  }}
                >
                  {memberShortName(mxid, member)}
                  {mxid === user_id ? "（我）" : " 💬"}
                </antd.Tag>
              ))}
            </div>
          ) : null}
        </div>
        {/* 成员头像堆叠（取前 3） */}
        <div style={{ display: "flex", alignItems: "center" }}>
          {memberEntries.length === 0 ? (
            <antd.Avatar size="small" style={{ backgroundColor: PRIMARY }}>
              {room.name.slice(0, 1)}
            </antd.Avatar>
          ) : (
            memberEntries.map(([mxid, member], i) => (
              <antd.Tooltip key={mxid} title={memberShortName(mxid, member)}>
                <MxcAvatar
                  url={member.avatar_url}
                  size="small"
                  style={{
                    backgroundColor: PRIMARY,
                    marginLeft: i === 0 ? 0 : -8,
                    border: `2px solid ${t.popoverBg}`,
                  }}
                >
                  {memberShortName(mxid, member).slice(0, 1)}
                </MxcAvatar>
              </antd.Tooltip>
            ))
          )}
          {room.member_count > 3 ? (
            <span style={{ fontSize: 12, color: t.textSecondary, marginLeft: 6 }}>
              +{room.member_count - 3}
            </span>
          ) : null}
        </div>
      </div>
    </antd.Card>
  );
}

/** DM 紧凑卡片：头像 + 对方名 + 未读。 */
function DmCard({
  room,
  user_id,
  onOpenRoom,
  isFavorite = false,
  onToggleFavorite,
  onExitRoom,
}: {
  room: TeamRoom;
  user_id?: string;
  onOpenRoom?: (roomId: string) => void;
  /** 0.4.99 B3：收藏态（客户端本地）。 */
  isFavorite?: boolean;
  onToggleFavorite?: (roomId: string) => void;
  /** 5.0.0 release：房间 ⋯ 菜单（退出 / 退出并删除，Element 同款列表操作）。 */
  onExitRoom?: (room: TeamRoom, forget: boolean) => void;
}) {
  const other = Object.entries(room.members || {}).find(
    ([mxid]) => mxid !== user_id,
  );
  const t = useThemeColors();
  const tr = useT();
  const otherName = other
    ? memberShortName(other[0], other[1])
    : room.name;
  return (
    <div
      onClick={() => onOpenRoom?.(room.room_id)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        borderRadius: 8,
        cursor: "pointer",
        border: `1px solid ${t.border}`,
        background: t.popoverBg,
      }}
    >
      <MxcAvatar
        url={other?.[1].avatar_url}
        size={32}
        style={{ backgroundColor: GREEN, flexShrink: 0 }}
      >
        {otherName.slice(0, 1).toUpperCase()}
      </MxcAvatar>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontWeight: 600,
            fontSize: 14,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {otherName}
          <UnreadBadge room={room} />
          {/* 0.4.99 B3：收藏切换（stopPropagation 防误开房间） */}
          <span
            role="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite?.(room.room_id);
            }}
            style={{
              cursor: "pointer",
              fontSize: 14,
              color: isFavorite ? "#faad14" : t.textSecondary,
              opacity: isFavorite ? 1 : 0.45,
              marginLeft: 6,
            }}
            title={isFavorite ? tr("取消收藏") : tr("收藏到顶部")}
          >
            {isFavorite ? "★" : "☆"}
          </span>
          {/* 5.0.0 release：房间 ⋯ 菜单（退出/退出并删除，Element 列表操作同款） */}
          <span
            role="button"
            onClick={(e) => e.stopPropagation()}
            style={{ display: "inline-block" }}
          >
            <antd.Dropdown
              trigger={["click"]}
              menu={{
                items: [
                  {
                    key: "leave",
                    danger: true,
                    label: `🚪 ${tr("退出房间")}`,
                  },
                  {
                    key: "leave-forget",
                    danger: true,
                    label: `🗑️ ${tr("退出并删除")}`,
                  },
                ],
                onClick: ({ key }: { key: string }) =>
                  onExitRoom?.(room, key === "leave-forget"),
              }}
            >
              <span
                style={{
                  cursor: "pointer",
                  fontSize: 14,
                  opacity: 0.45,
                  marginLeft: 2,
                }}
              >
                ⋯
              </span>
            </antd.Dropdown>
          </span>
        </div>
        <div
          style={{
            fontSize: 12,
            color: t.textSecondary,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={(() => {
            const p = lastBodyPreview(room.last_body);
            return p ? `${tr("最后消息")}：${p.marker}${p.text}` : undefined;
          })()}
        >
          {tr("最后消息")} {formatChatTime(room.last_ts) || "—"}
          {(() => {
            const p = lastBodyPreview(room.last_body);
            return p ? (
              <span style={{ marginLeft: 6, opacity: 0.85 }}>
                {p.marker}
                {p.text}
              </span>
            ) : null;
          })()}
        </div>
      </div>
    </div>
  );
}

/** v0.4.98 再版 8：邀请区（Element 同款邀请交互）。
 *  数据=/sync rooms.invite 段（后端 _parse_sync_rooms 解析）；
 *  接受=POST /rooms/{id}/invite/{userId}/accept，拒绝=POST /rooms/{id}/leave
 *  （CS-API v3 标准端点，走通用代理零新后端；Element matrix-js-sdk
 *  joinRoom 对 invite 房间内部走同一条 accept 路径）。
 *  操作成功后 onInviteSettled（父组件 force 重同步——绕过 60s 缓存，
 *  接受的房间立即进团队群/私聊列表）。 */
function InviteSection(props: {
  invites: InviteRoom[];
  onSettled?: () => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  const { invites, onSettled } = props;
  const [busy, setBusy] = React.useState<
    Record<string, "accept" | "reject">
  >({});

  const run = async (
    room: InviteRoom,
    kind: "accept" | "reject",
  ) => {
    setBusy((prev) => ({ ...prev, [room.room_id]: kind }));
    try {
      if (kind === "accept") {
        // 9/3 修复：homeserver（Tuwunel 系）不识别 /invite/{uid}/accept，
        // 按 spec 受邀者 join = 接受邀请（join 端点已实锤可用）。
        await acceptInvite(room.room_id);
        antd.message.success(tr("已接受邀请，正在进入房间列表"));
      } else {
        await rejectInvite(room.room_id);
        antd.message.success(tr("已拒绝邀请"));
      }
      onSettled?.();
    } catch (e) {
      antd.message.error(
        `${kind === "accept" ? tr("接受邀请失败") : tr("拒绝邀请失败")}${
          e instanceof Error ? `：${e.message}` : ""
        }`,
      );
    } finally {
      setBusy((prev) => {
        const next = { ...prev };
        delete next[room.room_id];
        return next;
      });
    }
  };

  return (
    <div
      style={{
        display: "grid",
        gap: 8,
        padding: 12,
        borderRadius: CARD_RADIUS,
        border: `1px solid rgba(255,127,22,0.4)`,
        background: "rgba(255,127,22,0.05)",
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 13 }}>
        📩 {tr("邀请（{n}）", { n: invites.length })}
      </div>
      {invites.map((inv) => {
        const state = busy[inv.room_id];
        const inviterName = inv.inviter
          ? memberShortName(inv.inviter)
          : "—";
        return (
          <div
            key={inv.room_id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 12px",
              borderRadius: 8,
              border: `1px solid ${t.border}`,
              background: t.popoverBg,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontWeight: 600,
                  fontSize: 14,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {inv.name}
              </div>
              <div style={{ fontSize: 12, color: t.textSecondary, whiteSpace: "nowrap" }}>
                {tr("邀请人：")} {inviterName}
                {inv.inviter_ts ? ` · ${formatChatTime(inv.inviter_ts)}` : ""}
              </div>
            </div>
            <antd.Popconfirm
              title={tr("拒绝邀请「{name}」？（系统团队房间可能被 Controller 调和器自动重新邀请）", {
                name: inv.name,
              })}
              okText={tr("拒绝")}
              cancelText={tr("返回")}
              onConfirm={() => void run(inv, "reject")}
              disabled={state !== undefined}
            >
              <antd.Button
                size="small"
                danger
                type="text"
                loading={state === "reject"}
                disabled={state === "accept"}
              >
                {tr("拒绝")}
              </antd.Button>
            </antd.Popconfirm>
            <antd.Button
              size="small"
              type="primary"
              loading={state === "accept"}
              disabled={state === "reject"}
              onClick={() => void run(inv, "accept")}
            >
              {tr("接受")}
            </antd.Button>
          </div>
        );
      })}
    </div>
  );
}

export interface TeamOverviewProps {
  rooms: TeamRoom[]; // 数据由父组件通过 api.ts fetchTeamsRooms 获取
  /** v0.4.98 再版 8：待接受邀请（独立区块，不受群/私聊过滤影响）。 */
  invites?: InviteRoom[];
  /** 接受/拒绝成功后回调（父组件 force 重同步）。 */
  onInviteSettled?: () => void;
  loading?: boolean;
  user_id?: string;
  onOpenRoom?: (roomId: string) => void; // 点击房间 → 父组件切到 RoomChat
  onRefresh?: () => void;
  /** 点击成员 → 打开/创建 DM（Phase 2 任务向导入口，§6.6〇）。 */
  onDm?: (mxid: string, roomId?: string) => void;
  /** 跨房间消息搜索入口（B1）：打开全局搜索面板。 */
  onGlobalSearch?: () => void;
  /** 一键全部已读（8/18 批次 1）：所有未读房间逐房间双写回执。 */
  onMarkAllRead?: () => void;
  markingAllRead?: boolean;
}

export default function TeamOverview(props: TeamOverviewProps) {
  const t = useThemeColors();
  const tr = useT();
  const {
    rooms,
    invites,
    onInviteSettled,
    loading,
    user_id,
    onOpenRoom,
    onRefresh,
    onDm,
    onGlobalSearch,
    onMarkAllRead,
    markingAllRead,
  } = props;
  const [filter, setFilter] = React.useState<"all" | "group" | "dm">("all");
  // 0.4.99 B3：房间收藏（客户端本地 localStorage——Element 无房间级收藏协议：
  // 其 pin = m.room.pinned_events 消息固定且需房间写权限；收藏=本地偏好，
  // 与 Element X 房间排序存客户端本地同一思路，跨设备不共享）。
  const [favorites, setFavorites] = React.useState<string[]>(() => {
    try {
      const arr = JSON.parse(localStorage.getItem(FAV_KEY) || "[]");
      return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  });
  const toggleFavorite = React.useCallback((roomId: string) => {
    setFavorites((prev) => {
      const next = prev.includes(roomId)
        ? prev.filter((x) => x !== roomId)
        : [...prev, roomId];
      try {
        localStorage.setItem(FAV_KEY, JSON.stringify(next));
      } catch {
        /* localStorage 不可用时仅内存态 */
      }
      return next;
    });
  }, []);
  // 未读房间数（一键全部已读按钮显隐）。
  // 5.0.0 release：房间离开/删除（Element 同款列表操作）。
  // 退出=CS-API leave；删除=forget（须先 leave）。系统团队房间退出后
  // 可能被 Controller 调和器自动重新邀请（确认文案提示）。
  const doRoomExit = React.useCallback(
    (room: TeamRoom, forget: boolean) => {
      const doIt = async () => {
        try {
          await leaveRoom(room.room_id);
          if (forget) await forgetRoom(room.room_id);
          antd.message.success(
            forget ? tr("已退出并删除房间") : tr("已退出房间"),
          );
          onRefresh?.();
        } catch (e) {
          antd.message.error(e instanceof Error ? e.message : tr("操作失败"));
        }
      };
      antd.Modal.confirm({
        title: forget
          ? tr("退出并删除「{name}」？", { name: room.name })
          : tr("退出房间「{name}」？", { name: room.name }),
        content: forget
          ? tr("退出并忘记该房间：本地不再保留其历史，列表不再显示。此操作不可撤销。系统团队房间可能被 Controller 调和器自动重新邀请。")
          : tr("退出后不再接收该房间消息。系统团队房间可能被 Controller 调和器自动重新邀请；非系统房间需再次被邀请才能进入。"),
        okText: forget ? tr("退出并删除") : tr("退出"),
        okButtonProps: { danger: true },
        cancelText: tr("返回"),
        onOk: () => doIt(),
      });
    },
    [onRefresh, tr],
  );

  const unreadRoomCount = rooms.filter(
    (r) => (r.unread || 0) > 0 || (r.unread_highlight || 0) > 0,
  ).length;

  const totalMembers = rooms.reduce(
    (sum, r) => sum + (r.member_count || 0),
    0,
  );
  // 分区：团队群（>2 人）与 DM 私聊，顶层 Segmented 切换。
  // v0.4.80: member_count 未填充（新房间 summary 未回）按 0 计——
  // 否则新建的 DM 两个列表都不进，表现为"说已创建实际没有"。
  // v0.4.81: 分区内按最后消息时间新到旧排序（用户：聊天主页要时间+倒序）。
  // 再版 12: 「全部」改 Element 式单一时间序混合列表（群/DM 交错）——
  // 此前两段式（群段整段在前）最新 DM 会沉到所有旧群下面，真机反馈
  // 「房间列表没做时间排序」= 感知无时间序。群/DM 过滤仍分区展示。
  const byRecent = (list: TeamRoom[]) =>
    [...list].sort((a, b) => (b.last_ts || 0) - (a.last_ts || 0));
  const isFav = (r: TeamRoom) => favorites.includes(r.room_id);
  // 收藏区独立置顶；主列表剔除收藏（不重复展示，同 Element Favourites 分区语义）。
  const mainRooms = rooms.filter((r) => !isFav(r));
  const groups = byRecent(mainRooms.filter((r) => (r.member_count ?? 0) > 2));
  const dms = byRecent(mainRooms.filter((r) => (r.member_count ?? 0) <= 2));
  const allByRecent = byRecent(mainRooms);
  const showGroups = filter === "all" || filter === "group";
  const showDms = filter === "all" || filter === "dm";
  const favRoomsForFilter =
    filter === "group"
      ? byRecent(rooms.filter((r) => isFav(r) && (r.member_count ?? 0) > 2))
      : filter === "dm"
        ? byRecent(rooms.filter((r) => isFav(r) && (r.member_count ?? 0) <= 2))
        : byRecent(rooms.filter(isFav));

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* 标题行：团队房间 + 成员数 Badge + 刷新按钮 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <antd.Typography.Title level={4} style={{ margin: 0 }}>
          {tr("团队房间")}
        </antd.Typography.Title>
        <antd.Badge
          count={totalMembers}
          showZero
          overflowCount={999}
          style={{ backgroundColor: PRIMARY }}
        />
        {user_id ? (
          <antd.Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {tr("当前身份：")} {user_id}
          </antd.Typography.Text>
        ) : null}
        <div style={{ flex: 1 }} />
        {onMarkAllRead ? (
          <antd.Button
            size="small"
            disabled={unreadRoomCount === 0}
            loading={markingAllRead}
            onClick={() => onMarkAllRead()}
            title={tr("一键全部已读（m.read + m.fully_read 双写，清 Element 侧未读）")}
          >
            ✓ {tr("全部已读")}
            {unreadRoomCount > 0 ? `（${unreadRoomCount}）` : ""}
          </antd.Button>
        ) : null}
        <antd.Segmented
          size="small"
          value={filter}
          onChange={(v: ReactNS.Key | number) =>
            setFilter(v as "all" | "group" | "dm")
          }
          options={[
            { value: "all", label: `全部（${rooms.length}）` },
            { value: "group", label: `👥 ${tr("团队群（{n}）", { n: groups.length })}` },
            { value: "dm", label: `💬 私聊（${dms.length}）` },
          ]}
        />
        <antd.Tooltip title="刷新">
          <antd.Button
            type="text"
            size="small"
            icon={<ReloadIcon />}
            loading={loading}
            onClick={() => onRefresh?.()}
          />
        </antd.Tooltip>
        {onGlobalSearch ? (
          <button
            onClick={onGlobalSearch}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              border: `1px solid ${t.border}`,
              background: t.cardBg,
              color: t.textSecondary,
              borderRadius: 16,
              padding: "3px 12px",
              fontSize: 12.5,
              cursor: "pointer",
              transition: "all 0.18s ease",
              lineHeight: "20px",
            }}
            onMouseEnter={(e) => {
              const el = e.currentTarget as HTMLElement;
              el.style.borderColor = "#FF7F16";
              el.style.color = "#FF7F16";
              el.style.background = "rgba(255,127,22,0.08)";
              el.style.transform = "translateY(-1px)";
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget as HTMLElement;
              el.style.borderColor = t.border;
              el.style.color = t.textSecondary;
              el.style.background = t.cardBg;
              el.style.transform = "none";
            }}
          >
            <span style={{ fontSize: 14, lineHeight: 1 }}>🔍</span>
            {tr("搜索消息")}
          </button>
        ) : null}
      </div>

      {rooms.length === 0 && (!invites || invites.length === 0) ? (
        <antd.Card style={{ borderRadius: CARD_RADIUS }} loading={loading}>
          <antd.Empty description={tr("还没有加入任何团队房间")} />
        </antd.Card>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          {/* 邀请区（v0.4.98 再版 8：Element 同款接受/拒绝；置顶显示，
              不受群/私聊过滤影响——待办动作优先于已加入房间） */}
          {invites && invites.length > 0 ? (
            <InviteSection
              invites={invites}
              onSettled={onInviteSettled}
            />
          ) : null}
          {/* 0.4.99 B3：⭐ 收藏区（置顶，主列表不再重复） */}
          {favRoomsForFilter.length > 0 ? (
            <div style={{ display: "grid", gap: 8 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: t.textSecondary,
                }}
              >
                ⭐ {tr("收藏（{n}）", { n: favRoomsForFilter.length })}
              </div>
              {favRoomsForFilter.map((room) =>
                (room.member_count ?? 0) > 2 ? (
                  <GroupCard
                    key={`fav-${room.room_id}`}
                    room={room}
                    user_id={user_id}
                    onOpenRoom={onOpenRoom}
                    onDm={onDm}
                    isFavorite
                    onToggleFavorite={toggleFavorite}
                    onExitRoom={doRoomExit}
                  />
                ) : (
                  <DmCard
                    key={`fav-${room.room_id}`}
                    room={room}
                    user_id={user_id}
                    onOpenRoom={onOpenRoom}
                    isFavorite
                    onToggleFavorite={toggleFavorite}
                    onExitRoom={doRoomExit}
                  />
                ),
              )}
            </div>
          ) : null}
          {/* 「全部」= Element 式单一时间序混合列表（群/DM 交错，新到旧）。
              群/DM 过滤 = 分区展示（各自内部时间序）。 */}
          {filter === "all" ? (
            allByRecent.length > 0 ? (
              <div style={{ display: "grid", gap: 12 }}>
                {allByRecent.map((room) =>
                  (room.member_count ?? 0) > 2 ? (
                    <GroupCard
                      key={room.room_id}
                      room={room}
                      user_id={user_id}
                      onOpenRoom={onOpenRoom}
                      onToggleFavorite={toggleFavorite}
                    onExitRoom={doRoomExit}
                      onDm={onDm}
                    />
                  ) : (
                    <DmCard
                      key={room.room_id}
                      room={room}
                      user_id={user_id}
                      onOpenRoom={onOpenRoom}
                      onToggleFavorite={toggleFavorite}
                    onExitRoom={doRoomExit}
                    />
                  ),
                )}
              </div>
            ) : null
          ) : (
            <>
              {/* 团队群 */}
              {showGroups && groups.length > 0 ? (
                <div style={{ display: "grid", gap: 12 }}>
                  {groups.map((room) => (
                    <GroupCard
                      key={room.room_id}
                      room={room}
                      user_id={user_id}
                      onOpenRoom={onOpenRoom}
                      onToggleFavorite={toggleFavorite}
                    onExitRoom={doRoomExit}
                      onDm={onDm}
                    />
                  ))}
                </div>
              ) : null}
              {/* DM 私聊 */}
              {showDms && dms.length > 0 ? (
                <div style={{ display: "grid", gap: 8 }}>
                  {dms.map((room) => (
                    <DmCard
                      key={room.room_id}
                      room={room}
                      user_id={user_id}
                      onOpenRoom={onOpenRoom}
                      onToggleFavorite={toggleFavorite}
                    onExitRoom={doRoomExit}
                    />
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  );
}
