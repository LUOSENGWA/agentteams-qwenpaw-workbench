import { CheckIcon, UsersIcon, MessageIcon, StarIcon, SearchIcon } from "./icons";
import type * as ReactNS from "react";
import { type InviteRoom, type TeamRoom } from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { WbTooltip } from "./WbTooltip";
import type { WorkerSessionState } from "../workerSessionState";
import { CARD_RADIUS, FAV_KEY, PRIMARY, SORT_KEY } from "./TeamOverviewShared";
import { DmCard, GroupCard } from "./TeamOverviewCards";
import { InviteSection } from "./TeamOverviewInvite";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
const icons = (host.antdIcons || {}) as Record<string, ReactNS.ComponentType>;
const EmptyIcon = (() => null) as unknown as ReactNS.FC<Record<string, unknown>>;
const pick = (name: string): ReactNS.FC<Record<string, unknown>> =>
  (icons[name] as ReactNS.FC<Record<string, unknown>>) || EmptyIcon;
const ReloadIcon = pick("ReloadOutlined");

interface TeamOverviewProps {
  rooms: TeamRoom[]; // 数据由父组件通过 api.ts fetchTeamsSync 获取（14.x 起 sync 为唯一房间源）
  /** 待接受邀请（独立区块，不受群/私聊过滤影响）。 */
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
  /** Worker 个人房间 room_id → session 状态（DM 卡圆点）。 */
  workerSessionByRoom?: Record<string, WorkerSessionState>;
  /** 全部 Worker MXID（团队群 running 判定）。 */
  workerMxids?: Set<string>;
  /** 房间 room_id → 该项目名列表（房间卡名称下显示）。 */
  roomProjectNames?: Record<string, string[]>;
  /** ：MXID → 角色标签
 * （Leader/Worker/Manager）——「私聊」视图按对象角色分区显示；
 * 无此 prop 或查不到角色时退回扁平列表（人类 DM 归「其他」）。 */
  workerRoleByMxid?: Record<string, string>;
}

function TeamOverview(props: TeamOverviewProps) {
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
  // B3：房间收藏（客户端本地 localStorage——Element 无房间级收藏协议：
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
  // 排序偏好（recent=最后消息新到旧 / name=名称 A-Z）。
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
  // 房间操作（退出/退出并删除）已收口到「房间详情」Drawer。
  const unreadRoomCount = rooms.filter(
    (r) => (r.unread || 0) > 0 || (r.unread_highlight || 0) > 0,
  ).length;

  const totalMembers = rooms.reduce(
    (sum, r) => sum + (r.member_count || 0),
    0,
  );
  // 分区：团队群（>2 人）与 DM 私聊，顶层 Segmented 切换。
  // member_count 未填充（新房间 summary 未回）按 0 计——
  // 否则新建的 DM 两个列表都不进，表现为"说已创建实际没有"。
  // 分区内按最后消息时间新到旧排序（用户：聊天主页要时间+倒序）。
  // 「全部」改 Element 式单一时间序混合列表（群/DM 交错）——
  // 此前两段式（群段整段在前）最新 DM 会沉到所有旧群下面，真机反馈
  // 「房间列表没做时间排序」= 感知无时间序。群/DM 过滤仍分区展示。
  // 排序=用户偏好（recent 默认时间新到旧 / name A-Z），
  // 替代此前恒定时间序。roomSort 来自 state（闭包每渲染更新，无需 memo）。
  const sortRooms = (list: TeamRoom[]) =>
    roomSort === "name"
      ? [...list].sort((a, b) =>
          (a.name || "").localeCompare(b.name || "", "zh-Hans-CN"),
        )
      : [...list].sort((a, b) => (b.last_ts || 0) - (a.last_ts || 0));
  const isFav = (r: TeamRoom) => favorites.includes(r.room_id);
  // @我/高亮未读的房间独立置顶
  // 分区（unread_highlight>0），主列表剔除——被 @ 的房间不再沉在时间序
  // 深处。无高亮时该分区整体隐藏（不占位）。
  const isMention = (r: TeamRoom) => (r.unread_highlight || 0) > 0;
  // 收藏区独立置顶；主列表剔除收藏（不重复展示，同 Element Favourites 分区语义）。
  const mainRooms = rooms.filter((r) => !isFav(r) && !isMention(r));
  const groups = sortRooms(mainRooms.filter((r) => (r.member_count ?? 0) > 2));
  const dms = sortRooms(mainRooms.filter((r) => (r.member_count ?? 0) <= 2));
  const allByRecent = sortRooms(mainRooms);
  // 私聊视图按对象角色分区
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
  // 私聊角色从「列表直接分割成
  // 4 段+组头」改为「列表下方按对象角色筛选 chips」（原话：「应该在
  // 下面加个按对象角色分区显示，而不是直接在列表分割」）——默认全部=扁平
  // 列表（不再切段），选某角色=只看该角色的私聊（仍是单一排序列表）。
  const [dmRole, setDmRole] = React.useState<string>("all");
  const dmRoleFiltered = React.useMemo(() => {
    if (!dmRoleGroups || dmRole === "all") return dms;
    return dmRoleGroups.find((g) => g.key === dmRole)?.rooms ?? [];
  }, [dmRoleGroups, dmRole, dms]);
  // 角色桶消失（刷新后该角色无私聊/映射失效）→ 自动回「全部」，
  // 防筛选卡在已不存在的角色上显示空列表。
  React.useEffect(() => {
    if (
      dmRole !== "all" &&
      dmRoleGroups &&
      !dmRoleGroups.some((g) => g.key === dmRole)
    ) {
      setDmRole("all");
    }
  }, [dmRoleGroups, dmRole]);
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

  // 房间卡渲染 helper——提及/收藏/主列表三区共用，
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
        sessionState={workerSessionByRoom?.[room.room_id]}
      />
    );
  };
  // 房间列表容器（主列表「全部」区与「团队群」区共用同款 grid 容器，
  // 两处同形 map 收敛一处，防容器样式漂移）。
  const renderRoomList = (list: TeamRoom[]) => (
    <div style={{ display: "grid", gap: 12 }}>
      {list.map((room) => renderRoomCard(room))}
    </div>
  );

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
        {/* 排序切换（时间↓默认 / 名称 A-Z），本地持久化 */}
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
        <WbTooltip title="刷新" tap={false} >
          <antd.Button
            type="text"
            size="small"
            icon={<ReloadIcon />}
            loading={loading}
            onClick={() => onRefresh?.()}
          />
        </WbTooltip>
        {/* 按钮对齐 QwenPaw 风格（antd Button 继承主题
  token；旧版手写 pill 圆角 16 + 自绘 hover 与宿主方形按钮不一致）。 */}
        {onGlobalSearch ? (
          <antd.Button
            size="small"
            icon={<SearchIcon size={14} />}
            onClick={onGlobalSearch}
          >
            {tr("搜索消息")}
          </antd.Button>
        ) : null}
      </div>

      {rooms.length === 0 && (!invites || invites.length === 0) ? (
        <antd.Card style={{ borderRadius: CARD_RADIUS }} loading={loading}>
          <antd.Empty description={tr("还没有加入任何团队房间")} />
        </antd.Card>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          {/* 邀请区（Element 同款接受/拒绝；置顶显示，
 不受群/私聊过滤影响——待办动作优先于已加入房间） */}
          {invites && invites.length > 0 ? (
            <InviteSection
              invites={invites}
              onSettled={onInviteSettled}
            />
          ) : null}
          {/* ：@我/高亮未读置顶分区，
 主列表剔除（isMention 已在 mainRooms 过滤）。无高亮整体隐藏。 */}
          {mentionRoomsForFilter.length > 0 ? (
            <div style={{ display: "grid", gap: 8 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--app-accent, #FF7F16)",
                }}
              >
                @ {tr("提及（{n}）", { n: mentionRoomsForFilter.length })}
              </div>
              {mentionRoomsForFilter.map((room) =>
                renderRoomCard(room, "mention-"),
              )}
            </div>
          ) : null}
          {/* B3：⭐ 收藏区（置顶，主列表不再重复） */}
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
            allByRecent.length > 0 ? renderRoomList(allByRecent) : null
          ) : (
            <>
              {/* 团队群 */}
              {showGroups && groups.length > 0 ? renderRoomList(groups) : null}
              {/* DM 私聊
 角色改为下方 chips 筛选（不再直接
 分割列表）；默认「全部」=扁平列表（roomSort 同序）。 */}
              {showDms ? (
                <div style={{ display: "grid", gap: 8 }}>
                  {/* 角色筛选 chips（有角色映射才出；「全部」恒在） */}
                  {dmRoleGroups ? (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {[
                        { key: "all", label: tr("全部"), n: dms.length },
                        ...dmRoleGroups.map((g) => ({
                          key: g.key,
                          label: tr(g.label),
                          n: g.rooms.length,
                        })),
                      ].map((o) => {
                        const active = dmRole === o.key;
                        return (
                          <button
                            key={o.key}
                            type="button"
                            onClick={() => setDmRole(o.key)}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 4,
 border: `1px solid ${active ? "var(--app-accent, #FF7F16)" : t.border}`,
 background: active ? "color-mix(in srgb, var(--app-accent, #FF7F16) 10%, transparent)" : t.cardBg,
 color: active ? "var(--app-accent, #FF7F16)" : t.textSecondary,
                              borderRadius: 14,
                              padding: "2px 12px",
                              fontSize: 12,
                              cursor: "pointer",
                              lineHeight: "18px",
                              transition: "all 0.15s ease",
                            }}
                          >
                            {o.label}（{o.n}）
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                  {dmRoleFiltered.length > 0 ? (
                    dmRoleFiltered.map((room) => renderRoomCard(room))
                  ) : (
                    <antd.Empty
                      image={antd.Empty.PRESENTED_IMAGE_SIMPLE}
                      description={
                        dmRole === "all"
                          ? tr("还没有私聊房间")
                          : tr("该角色暂无私聊")
                      }
                      style={{ margin: "12px 0" }}
                    />
                  )}
                </div>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// memo 化——rc-tabs 保活下本组件首访后
// 常驻挂载，WorkbenchPage 每次重渲（SSE 帧/数据波/tab 切换）此前都会
// 无差别重渲它（房间列表卡片族）。props 已稳定化（rooms/invites 保引用
// 、workerSessionStates 保引用 、roomProjectNames/workerRoleByMxid
// useMemo、回调 useCallback）→ 值未变时 bail out。
export default React.memo(TeamOverview);
