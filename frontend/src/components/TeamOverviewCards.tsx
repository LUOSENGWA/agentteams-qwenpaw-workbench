/** TeamOverview 子模块——自 TeamOverview.tsx 纯搬移拆出
 * （行为零变化）。 */
import {
  PictureIcon,
  ClipIcon,
  StarIcon,
  StarOutlineIcon,
  DoorIcon,
  TrashIcon,
  MessageIcon,
  UsersIcon,
  FolderIcon,
} from "./icons";
import type * as ReactNS from "react";
import type { TeamRoom } from "../api";
import type { WorkerSessionState } from "../workerSessionState";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { MxcAvatar } from "../MxcAvatar";
import { formatChatTime } from "../util";
import WorkerSessionDot from "./WorkerSessionDot";
import { WbTooltip } from "./WbTooltip";
import {
  CARD_RADIUS,
  GREEN,
  PRIMARY,
  lastBodyPreview,
  memberShortName,
  unreadBadgeOf,
  UnreadBubble,
} from "./TeamOverviewShared";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

/** 团队群卡片：名称+未读+成员 chips（点成员发 DM）+头像堆叠。 */
export function GroupCard({
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
  /** 本房间项目名（卡片名称下小字显示）。 */
  projectTitles?: string[];
  /** B3：收藏态（客户端本地）。 */
  isFavorite?: boolean;
  onToggleFavorite?: (roomId: string) => void;
  /** 5.0.0 release：房间 ⋯ 菜单（退出 / 退出并删除，Element 同款列表操作）。 */
  onExitRoom?: (room: TeamRoom, forget: boolean) => void;
  /** 全部 Worker MXID——任一 Worker 正在输入则显蓝点。 */
  workerMxids?: Set<string>;
}) {
  const t = useThemeColors();
  const tr = useT();
  const memberEntries = Object.entries(room.members || {}).slice(0, 3);
 // （P8b）：成员列表默认隐藏（成员多的房间 chips 占卡高度，
  // 房间列又长又密），点「N 人」tag 展开/收起。
  const [membersOpen, setMembersOpen] = React.useState(false);
  // 团队群只表达 running（Worker 正在打字）；不显 done/idle
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
 {/* 群卡片加头像（原无头像，未读气泡无处挂）——
 头像右上角=未读徽章（红=highlight/灰=普通未读）。 */}
        {(() => {
          const avatar = (
            <antd.Avatar size={32} style={{ backgroundColor: PRIMARY, flexShrink: 0 }}>
              <UsersIcon size={16} />
            </antd.Avatar>
          );
          // 自绘 UnreadBubble（居中+含住+白描边环）。
          const ub = unreadBadgeOf(room);
          return (
            <div style={{ position: "relative", flexShrink: 0, lineHeight: 0 }}>
              {avatar}
              {ub ? <UnreadBubble count={ub.count} color={ub.color} /> : null}
            </div>
          );
        })()}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontWeight: 600,
              fontSize: 15,
              // 房间名自动换行防省略号丢信息（行尾时间/收藏/⋯随 inline
              // 流续排）；卡片高度动态随行数。
              whiteSpace: "normal",
              wordBreak: "break-word",
            }}
          >
            {room.name}
            {groupRunning ? <WorkerSessionDot state="running" /> : null}
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
            {/* B3：收藏切换（stopPropagation 防误开房间） */}
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
          {/* 房间名下面显示项目名
 （数据=Controller 工作流事件 room_id→title；无项目不占行）。 */}
          {projectTitles && projectTitles.length ? (
            <div
              style={{
                fontSize: 11,
                color: t.textSecondary,
                marginTop: 2,
                // 多项目名自动换行（不 ellipsis 截断）；卡高随内容。
                whiteSpace: "normal",
                wordBreak: "break-word",
              }}
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
          {/* 最后消息正文预览（72 字 + 媒体标记）。 */}
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
              <WbTooltip key={mxid} title={memberShortName(mxid, member)}>
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
              </WbTooltip>
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
export function DmCard({
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
  /** B3：收藏态（客户端本地）。 */
  isFavorite?: boolean;
  onToggleFavorite?: (roomId: string) => void;
  /** 5.0.0 release：房间 ⋯ 菜单（退出 / 退出并删除，Element 同款列表操作）。 */
  onExitRoom?: (room: TeamRoom, forget: boolean) => void;
  /** 对方 Worker 的 session 状态（仅 Worker 个人房间有值）。 */
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
 {/* 未读徽章挂头像右上角（原名称行内灰胶囊）。 */}
      {(() => {
        const avatar = (
          <MxcAvatar
            url={other?.[1].avatar_url}
            size={32}
            style={{ backgroundColor: GREEN, flexShrink: 0 }}
          >
            {otherName.slice(0, 1).toUpperCase()}
          </MxcAvatar>
        );
        // 自绘 UnreadBubble（居中+含住+白描边环）。
        const ub = unreadBadgeOf(room);
        return (
          <div style={{ position: "relative", flexShrink: 0, lineHeight: 0 }}>
            {avatar}
            {ub ? <UnreadBubble count={ub.count} color={ub.color} /> : null}
          </div>
        );
      })()}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontWeight: 600,
            fontSize: 14,
            // DM 名自动换行防省略号丢信息（行尾收藏/⋯随 inline 流续排）。
            whiteSpace: "normal",
            wordBreak: "break-word",
          }}
        >
          {otherName}
          {sessionState ? <WorkerSessionDot state={sessionState} /> : null}
          {/* B3：收藏切换（stopPropagation 防误开房间） */}
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
