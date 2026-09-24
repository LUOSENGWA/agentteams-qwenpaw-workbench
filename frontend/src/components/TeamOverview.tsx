import { PictureIcon, ClipIcon, StarIcon, StarOutlineIcon, DoorIcon, TrashIcon, MessageIcon, MailIcon, CheckIcon, UsersIcon, SearchIcon, FolderIcon } from "./icons";
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
import WorkerSessionDot from "./WorkerSessionDot";
import type { WorkerSessionState } from "../workerSessionState";

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
// v0.5.0-beta.13.12（13.11 装验「房间列表排序感觉可以优化」）：排序偏好
// 客户端本地持久化（与收藏同一思路——Element 房间排序存客户端本地）。
const SORT_KEY = "agentteams-qwenpaw-workbench:room-sort";
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
): { text: string; marker: "img" | "file" | null } | null {
  const b = (body || "").replace(/\s+/g, " ").trim();
  if (!b) return null;
  const marker = MEDIA_IMG_RE.test(b) ? "img" : MEDIA_FILE_RE.test(b) ? "file" : null;
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
  workerMxids,
  projectTitles,
}: {
  room: TeamRoom;
  user_id?: string;
  onOpenRoom?: (roomId: string) => void;
  onDm?: (mxid: string, roomId?: string) => void;
  /** v0.5.0-beta.13.14：本房间项目名（卡片名称下小字显示）。 */
  projectTitles?: string[];
  /** v0.5.0-beta.12 B3：收藏态（客户端本地）。 */
  isFavorite?: boolean;
  onToggleFavorite?: (roomId: string) => void;
  /** 5.0.0 release：房间 ⋯ 菜单（退出 / 退出并删除，Element 同款列表操作）。 */
  onExitRoom?: (room: TeamRoom, forget: boolean) => void;
  /** v0.5.0-beta.12.4（A17）：全部 Worker MXID——任一 Worker 正在输入则显蓝点。 */
  workerMxids?: Set<string>;
}) {
  const t = useThemeColors();
  const tr = useT();
  const memberEntries = Object.entries(room.members || {}).slice(0, 3);
  // 装验反馈 9/19（P8b）：成员列表默认隐藏（成员多的房间 chips 占卡高度，
  // 房间列又长又密），点「N 人」tag 展开/收起。
  const [membersOpen, setMembersOpen] = React.useState(false);
  // A17：团队群只表达 running（Worker 正在打字）；不显 done/idle
  //（无 per-user last-sender 数据，人类消息会误触绿）。
  const groupRunning = !!workerMxids && (room.typing || []).some((m) =>
    workerMxids.has(m),
  );
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
            {groupRunning ? <WorkerSessionDot state="running" /> : null}
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
            {/* v0.5.0-beta.12 B3：收藏切换（stopPropagation 防误开房间） */}
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
                display: "inline-flex",
              }}
              title={isFavorite ? tr("取消收藏") : tr("收藏到顶部")}
            >
              {isFavorite ? <StarIcon size={15} /> : <StarOutlineIcon size={15} />}
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
                      label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><DoorIcon size={13} /> {tr("退出房间")}</span>,
                    },
                    {
                      key: "leave-forget",
                      danger: true,
                      label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><TrashIcon size={13} /> {tr("退出并删除")}</span>,
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
          {/* v0.5.0-beta.13.14（装验反馈）：房间名下面显示项目名
              （数据=Controller 工作流事件 room_id→title；无项目不占行）。 */}
          {projectTitles && projectTitles.length ? (
            <div
              style={{
                fontSize: 11,
                color: t.textSecondary,
                marginTop: 2,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={projectTitles.join("、")}
            >
              <span style={{ display: "inline-flex", verticalAlign: "-1px", marginRight: 3 }}>
                <FolderIcon size={10} />
              </span>
              {projectTitles.join("、")}
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
            {/* P8b：N 人 tag 兼作成员列表开关（点成员仍走 chip 的 DM 入口） */}
            <antd.Tag
              style={{ margin: 0, cursor: "pointer", userSelect: "none" }}
              title={membersOpen ? tr("隐藏成员") : tr("显示成员")}
              onClick={(e: ReactNS.MouseEvent) => {
                e.stopPropagation();
                setMembersOpen(!membersOpen);
              }}
            >
              {room.member_count} 人 {membersOpen ? "▴" : "▾"}
            </antd.Tag>
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
                title={p.text}
              >
                {p.marker === "img" ? <PictureIcon size={11} style={{ verticalAlign: "-1px", marginRight: 2 }} /> : p.marker === "file" ? <ClipIcon size={11} style={{ verticalAlign: "-1px", marginRight: 2 }} /> : null}
                {p.text}
              </div>
            ) : null;
          })()}
          {/* 成员 chips：点击成员 → DM（任务发起入口）。
              P8b：默认隐藏（membersOpen 才渲染），点「N 人」tag 展开。 */}
          {onDm && membersOpen ? (
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
                  {mxid === user_id ? "（我）" : <MessageIcon size={10} style={{ marginLeft: 3, verticalAlign: "-1px" }} />}
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
  sessionState,
}: {
  room: TeamRoom;
  user_id?: string;
  onOpenRoom?: (roomId: string) => void;
  /** v0.5.0-beta.12 B3：收藏态（客户端本地）。 */
  isFavorite?: boolean;
  onToggleFavorite?: (roomId: string) => void;
  /** 5.0.0 release：房间 ⋯ 菜单（退出 / 退出并删除，Element 同款列表操作）。 */
  onExitRoom?: (room: TeamRoom, forget: boolean) => void;
  /** v0.5.0-beta.12.4（A17）：对方 Worker 的 session 状态（仅 Worker 个人房间有值）。 */
  sessionState?: WorkerSessionState;
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
          {sessionState ? <WorkerSessionDot state={sessionState} /> : null}
          <UnreadBadge room={room} />
          {/* v0.5.0-beta.12 B3：收藏切换（stopPropagation 防误开房间） */}
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
              display: "inline-flex",
            }}
            title={isFavorite ? tr("取消收藏") : tr("收藏到顶部")}
          >
            {isFavorite ? <StarIcon size={14} /> : <StarOutlineIcon size={14} />}
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
                    label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><DoorIcon size={13} /> {tr("退出房间")}</span>,
                  },
                  {
                    key: "leave-forget",
                    danger: true,
                    label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><TrashIcon size={13} /> {tr("退出并删除")}</span>,
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
            return p ? `${tr("最后消息")}：${p.text}` : undefined;
          })()}
        >
          {tr("最后消息")} {formatChatTime(room.last_ts) || "—"}
          {(() => {
            const p = lastBodyPreview(room.last_body);
            return p ? (
              <span style={{ marginLeft: 6, opacity: 0.85 }}>
                {p.marker === "img" ? <PictureIcon size={11} style={{ verticalAlign: "-1px", marginRight: 2 }} /> : p.marker === "file" ? <ClipIcon size={11} style={{ verticalAlign: "-1px", marginRight: 2 }} /> : null}
                {p.text}
              </span>
            ) : null;
          })()}
        </div>
      </div>
    </div>
  );
}

/** v0.5.0-beta.12 ：邀请区（Element 同款邀请交互）。
 * 数据=/sync rooms.invite 段（后端 _parse_sync_rooms 解析）；
 * 接受=POST /rooms/{id}/invite/{userId}/accept，拒绝=POST /rooms/{id}/leave
 * （CS-API v3 标准端点，走通用代理零新后端；Element matrix-js-sdk
 * joinRoom 对 invite 房间内部走同一条 accept 路径）。
 * 操作成功后 onInviteSettled（父组件 force 重同步——绕过 60s 缓存，
 * 接受的房间立即进团队群/私聊列表）。 */
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
        // 修复：homeserver（Tuwunel 系）不识别 /invite/{uid}/accept，
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
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><MailIcon size={13} /> {tr("邀请（{n}）", { n: invites.length })}</span>
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
  /** v0.5.0-beta.12 ：待接受邀请（独立区块，不受群/私聊过滤影响）。 */
  invites?: InviteRoom[];
  /** 接受/拒绝成功后回调（父组件 force 重同步）。 */
  onInviteSettled?: () => void;
  loading?: boolean;
  user_id?: string;
  onOpenRoom?: (roomId: string) => void; // 点击房间 → 父组件切到 RoomChat
  onRefresh?: () => void;
  /** 点击成员 → 打开/创建 DM（Phase 2 任务向导入口，〇）。 */
  onDm?: (mxid: string, roomId?: string) => void;
  /** 跨房间消息搜索入口：打开全局搜索面板。 */
  onGlobalSearch?: () => void;
  /** 一键全部已读：所有未读房间逐房间双写回执。 */
  onMarkAllRead?: () => void;
  markingAllRead?: boolean;
  /** v0.5.0-beta.12.4（A17）：Worker 个人房间 room_id → session 状态（DM 卡圆点）。 */
  workerSessionByRoom?: Record<string, WorkerSessionState>;
  /** v0.5.0-beta.12.4（A17）：全部 Worker MXID（团队群 running 判定）。 */
  workerMxids?: Set<string>;
  /** v0.5.0-beta.13.14：房间 room_id → 该项目名列表（房间卡名称下显示）。 */
  roomProjectNames?: Record<string, string[]>;
  /** v0.5.0-beta.13.21（A8c 侧栏角色分组）：MXID → 角色标签
   *  （Leader/Worker/Manager）——「私聊」视图按对象角色分区显示；
   *  无此 prop 或查不到角色时退回扁平列表（人类 DM 归「其他」）。 */
  workerRoleByMxid?: Record<string, string>;
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
    workerSessionByRoom,
    workerMxids,
    roomProjectNames,
    workerRoleByMxid,
  } = props;
  const [filter, setFilter] = React.useState<"all" | "group" | "dm">("all");
  // v0.5.0-beta.12 B3：房间收藏（客户端本地 localStorage——Element 无房间级收藏协议：
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
  // v0.5.0-beta.13.12：排序偏好（recent=最后消息新到旧 / name=名称 A-Z）。
  // 客户端本地持久化；主列表与分区共用，收藏/提及区恒置顶不受影响。
  const [roomSort, setRoomSort] = React.useState<"recent" | "name">(() => {
    try {
      const v = localStorage.getItem(SORT_KEY);
      return v === "name" ? "name" : "recent";
    } catch {
      return "recent";
    }
  });
  const setRoomSortPersist = React.useCallback((v: "recent" | "name") => {
    setRoomSort(v);
    try {
      localStorage.setItem(SORT_KEY, v);
    } catch {
      /* localStorage 不可用时仅内存态 */
    }
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
  // v0.5.0-beta.12: member_count 未填充（新房间 summary 未回）按 0 计——
  // 否则新建的 DM 两个列表都不进，表现为"说已创建实际没有"。
  // v0.5.0-beta.12: 分区内按最后消息时间新到旧排序（用户：聊天主页要时间+倒序）。
  // : 「全部」改 Element 式单一时间序混合列表（群/DM 交错）——
  // 此前两段式（群段整段在前）最新 DM 会沉到所有旧群下面，真机反馈
  // 「房间列表没做时间排序」= 感知无时间序。群/DM 过滤仍分区展示。
  // v0.5.0-beta.13.12：排序=用户偏好（recent 默认时间新到旧 / name A-Z），
  // 替代此前恒定时间序。roomSort 来自 state（闭包每渲染更新，无需 memo）。
  const sortRooms = (list: TeamRoom[]) =>
    roomSort === "name"
      ? [...list].sort((a, b) =>
          (a.name || "").localeCompare(b.name || "", "zh-Hans-CN"),
        )
      : [...list].sort((a, b) => (b.last_ts || 0) - (a.last_ts || 0));
  const isFav = (r: TeamRoom) => favorites.includes(r.room_id);
  // v0.5.0-beta.13.12（Element X 提及区语义）：@我/高亮未读的房间独立置顶
  // 分区（unread_highlight>0），主列表剔除——被 @ 的房间不再沉在时间序
  // 深处。无高亮时该分区整体隐藏（不占位）。
  const isMention = (r: TeamRoom) => (r.unread_highlight || 0) > 0;
  // 收藏区独立置顶；主列表剔除收藏（不重复展示，同 Element Favourites 分区语义）。
  const mainRooms = rooms.filter((r) => !isFav(r) && !isMention(r));
  const groups = sortRooms(mainRooms.filter((r) => (r.member_count ?? 0) > 2));
  const dms = sortRooms(mainRooms.filter((r) => (r.member_count ?? 0) <= 2));
  const allByRecent = sortRooms(mainRooms);
  // v0.5.0-beta.13.21（A8c 侧栏角色分组）：私聊视图按对象角色分区
  // （Leader/Worker/Manager/其他，组内仍按 roomSort 序）。仅当提供了
  // 角色映射时启用——无 L1 管理数据时自动退回扁平列表。
  const dmOtherMxid = (r: TeamRoom): string | null => {
    const hit = Object.entries(r.members || {}).find(([mx]) => mx !== user_id);
    return hit ? hit[0] : null;
  };
  const dmRoleGroups = React.useMemo(() => {
    if (!workerRoleByMxid) return null;
    const order: Array<{ key: string; label: string }> = [
      { key: "Leader", label: "Leader" },
      { key: "Worker", label: "Worker" },
      { key: "Manager", label: "Manager" },
      { key: "other", label: "其他" },
    ];
    const buckets: Record<string, TeamRoom[]> = {
      Leader: [],
      Worker: [],
      Manager: [],
      other: [],
    };
    for (const r of dms) {
      const role = workerRoleByMxid[dmOtherMxid(r) || ""] || "other";
      (buckets[role] || buckets.other).push(r);
    }
    return order
      .map((g) => ({ ...g, rooms: buckets[g.key] || [] }))
      .filter((g) => g.rooms.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dms, workerRoleByMxid, user_id]);
  const showGroups = filter === "all" || filter === "group";
  const showDms = filter === "all" || filter === "dm";
  const favRoomsForFilter =
    filter === "group"
      ? sortRooms(rooms.filter((r) => isFav(r) && (r.member_count ?? 0) > 2))
      : filter === "dm"
        ? sortRooms(rooms.filter((r) => isFav(r) && (r.member_count ?? 0) <= 2))
        : sortRooms(rooms.filter(isFav));
  const mentionRoomsForFilter =
    filter === "group"
      ? sortRooms(rooms.filter((r) => isMention(r) && !isFav(r) && (r.member_count ?? 0) > 2))
      : filter === "dm"
        ? sortRooms(rooms.filter((r) => isMention(r) && !isFav(r) && (r.member_count ?? 0) <= 2))
        : sortRooms(rooms.filter((r) => isMention(r) && !isFav(r)));

  // v0.5.0-beta.13.12：房间卡渲染 helper——提及/收藏/主列表三区共用，
  // 群/DM 按 member_count 分派（此前三区各写一份，新增分区会三处漂移）。
  const renderRoomCard = (room: TeamRoom, keyPrefix = "") => {
    const key = `${keyPrefix}${room.room_id}`;
    return (room.member_count ?? 0) > 2 ? (
      <GroupCard
        key={key}
        room={room}
        user_id={user_id}
        onOpenRoom={onOpenRoom}
        onDm={onDm}
        isFavorite={isFav(room)}
        onToggleFavorite={toggleFavorite}
        onExitRoom={doRoomExit}
        workerMxids={workerMxids}
        projectTitles={roomProjectNames?.[room.room_id]}
      />
    ) : (
      <DmCard
        key={key}
        room={room}
        user_id={user_id}
        onOpenRoom={onOpenRoom}
        isFavorite={isFav(room)}
        onToggleFavorite={toggleFavorite}
        onExitRoom={doRoomExit}
        sessionState={workerSessionByRoom?.[room.room_id]}
      />
    );
  };

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
            <CheckIcon size={12} style={{ verticalAlign: "-1px", marginRight: 3 }} /> {tr("全部已读")}
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
            { value: "group", label: <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><UsersIcon size={12} /> {tr("团队群（{n}）", { n: groups.length })}</span> },
            { value: "dm", label: <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><MessageIcon size={12} /> 私聊（{dms.length}）</span> },
          ]}
        />
        {/* v0.5.0-beta.13.12：排序切换（时间↓默认 / 名称 A-Z），本地持久化 */}
        <antd.Segmented
          size="small"
          value={roomSort}
          onChange={(v: ReactNS.Key | number) =>
            setRoomSortPersist(v as "recent" | "name")
          }
          options={[
            { value: "recent", label: tr("时间 ↓") },
            { value: "name", label: tr("名称 A-Z") },
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
            <SearchIcon size={14} />
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
          {/* 邀请区（v0.5.0-beta.12 ：Element 同款接受/拒绝；置顶显示，
              不受群/私聊过滤影响——待办动作优先于已加入房间） */}
          {invites && invites.length > 0 ? (
            <InviteSection
              invites={invites}
              onSettled={onInviteSettled}
            />
          ) : null}
          {/* v0.5.0-beta.13.12（Element X 提及区）：@我/高亮未读置顶分区，
              主列表剔除（isMention 已在 mainRooms 过滤）。无高亮整体隐藏。 */}
          {mentionRoomsForFilter.length > 0 ? (
            <div style={{ display: "grid", gap: 8 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "#FF7F16",
                }}
              >
                @ {tr("提及（{n}）", { n: mentionRoomsForFilter.length })}
              </div>
              {mentionRoomsForFilter.map((room) =>
                renderRoomCard(room, "mention-"),
              )}
            </div>
          ) : null}
          {/* v0.5.0-beta.12 B3：⭐ 收藏区（置顶，主列表不再重复） */}
          {favRoomsForFilter.length > 0 ? (
            <div style={{ display: "grid", gap: 8 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: t.textSecondary,
                }}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><StarIcon size={12} style={{ color: "#faad14" }} /> {tr("收藏（{n}）", { n: favRoomsForFilter.length })}</span>
              </div>
              {favRoomsForFilter.map((room) => renderRoomCard(room, "fav-"))}
            </div>
          ) : null}
          {/* 「全部」= Element 式单一排序混合列表（群/DM 交错，按 roomSort）。
              群/DM 过滤 = 分区展示（各自内部同序）。 */}
          {filter === "all" ? (
            allByRecent.length > 0 ? (
              <div style={{ display: "grid", gap: 12 }}>
                {allByRecent.map((room) => renderRoomCard(room))}
              </div>
            ) : null
          ) : (
            <>
              {/* 团队群 */}
              {showGroups && groups.length > 0 ? (
                <div style={{ display: "grid", gap: 12 }}>
                  {groups.map((room) => renderRoomCard(room))}
                </div>
              ) : null}
              {/* DM 私聊
                  v0.5.0-beta.13.21（A8c）：有角色映射时按对象角色分区
                  （组头=角色标签，组内房间卡同前）；否则扁平。 */}
              {showDms && dms.length > 0 ? (
                dmRoleGroups ? (
                  <div style={{ display: "grid", gap: 12 }}>
                    {dmRoleGroups.map((g) => (
                      <div key={g.key} style={{ display: "grid", gap: 8 }}>
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            color: t.textSecondary,
                          }}
                        >
                          {tr(g.label)}（{g.rooms.length}）
                        </div>
                        {g.rooms.map((room) => renderRoomCard(room, `role-${g.key}-`))}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ display: "grid", gap: 8 }}>
                    {dms.map((room) => renderRoomCard(room))}
                  </div>
                )
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  );
}
