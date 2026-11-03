// 右栏与弹层群（任务 D 拆分自 RoomChat，JSX 逐句搬迁）：宽屏线程面板 +
// 窄屏线程 Drawer + 消息搜索 + 成员面板 + 房间详情 + 重命名 + 文件引用 +
// 成员详情卡。除宽屏线程面板（inline flex 子项，DOM 顺序=原 flex row 第二子）
// 外全部为 portal 组件（antd Drawer/Modal、MemberDetail、FileRefPicker、
// RoomInfoDrawer）——移入 flex row 内 fragment 布局中性。
import { MxcAvatar } from "../MxcAvatar";
import MessageSearch from "./MessageSearch";
import MemberDetail from "./MemberDetail";
import RoomInfoDrawer from "./RoomInfoDrawer";
import { FileRefPicker } from "./FileRefPicker";
import WorkerSessionDot from "./WorkerSessionDot";
import { PRIMARY, senderShortName } from "./RoomChatShared";
import { ThreadIcon } from "./RoomChatThread";
import type { RoomChatProps } from "./RoomChat";
import type { RoomChatCoreState } from "./RoomChatCore";
import type { RoomChatViewState } from "./RoomChatView";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

export default function RoomChatSidebar(props: {
  p: RoomChatProps;
  c: RoomChatCoreState;
  v: RoomChatViewState;
}) {
  const { p, c, v } = props;
  const {
    room,
    threadPanelBody,
    isWide,
    panelWidth,
    dragging,
    onPanelHandleDown,
    threadOpenedInNarrowRef,
    setActiveThread,
    searchOpen,
    setSearchOpen,
    memberPanelOpen,
    setMemberPanelOpen,
    myUserId,
    workerSessionByMxid,
    memberWorkerNames,
    workerRuntimeByMxid,
    detailMxid,
    setDetailMxid,
    roomInfoOpen,
    setRoomInfoOpen,
    openRename,
    renameOpen,
    setRenameOpen,
    renameValue,
    setRenameValue,
    powerInfo,
    powerLoading,
    refPickerOpen,
    setRefPickerOpen,
    setFileRefs,
    teamName,
    insertMention,
    onDm,
    onOpenWorkerChats,
    t,
    tr,
  } = c;
  // 房间详情刷新信号：重命名完成后 bump → RoomInfoDrawer 重拉房间信息。
  // （自 RoomChat 迁入——唯一消费方在本文件，RoomChat 不再需要此状态。）
  const [roomInfoRefreshTick, setRoomInfoRefreshTick] = React.useState(0);

  return (
    <>
      {isWide && threadPanelBody ? (
        <div
          style={{
            width: panelWidth,
            minWidth: 280,
            maxWidth: 560,
            flexShrink: 0,
            overflow: "hidden",
            display: "flex",
            position: "relative",
            animation: "wbPanelIn 0.18s ease-out",
          }}
        >
          {/* 拖拽手柄：左缘 6px 竖条，横滑调宽（280-560） */}
          <div
            className="wb-panel-handle"
            onPointerDown={onPanelHandleDown}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: 6,
              cursor: "col-resize",
              zIndex: 6,
              background: dragging
                ? "color-mix(in srgb, var(--app-accent, #FF7F16) 35%, transparent)"
                : "transparent",
              transition: "background 0.15s",
              borderLeft: `1px solid ${t.border}`,
            }}
            title={tr("拖动调整宽度")}
          />
          <div
            style={{
              display: "flex",
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              padding: "10px 12px 10px 14px",
            }}
          >
            {threadPanelBody}
          </div>
        </div>
      ) : null}

      {/* 窄屏线程：钉钉式 Drawer 弹出。
15.14：仅「用户在窄屏下显式打开」的话题才自动弹 Drawer（ref 门控）——
宽屏打开/持久化恢复的话题在窗口收窄时不弹（防鬼影），点消息话题
图标可重新打开。 */}
      <antd.Drawer
        open={!isWide && threadPanelBody !== null && threadOpenedInNarrowRef.current}
        onClose={() => setActiveThread(null)}
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <ThreadIcon size={15} /> {tr("话题")}
          </span>
        }
        width={Math.min(460, typeof window !== "undefined" ? window.innerWidth * 0.92 : 460)}
        styles={{ body: { padding: 12 } }}
      >
        {threadPanelBody}
      </antd.Drawer>

      {/* 房间内消息搜索：Drawer 面板，房间过滤 + 上下文预览 + 定位 */}
      {room ? (
        <MessageSearch
          open={searchOpen}
          onClose={() => setSearchOpen(false)}
          roomId={room.room_id}
          // 16.46：先保证目标在渲染窗内再走既有定位链。
          onJump={(eventId) => void v.jumpWithEnsure(eventId)}
        />
      ) : null}

      {/* 成员面板（Element MemberList 同款交互：成员列表 + @ 提及） */}
      <antd.Drawer
        open={memberPanelOpen}
        onClose={() => setMemberPanelOpen(false)}
        title={`${room.name}（${room.member_count}${tr("人")}）`}
        width={320}
      >
        <div style={{ display: "grid", gap: 6 }}>
          {Object.entries(room.members || {}).map(([mxid, member]) => {
            const name = senderShortName(mxid, room);
            const isMe = mxid === myUserId;
            return (
              <div
                key={mxid}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "6px 8px",
                  borderRadius: 8,
                  background: t.hoverBg,
                }}
              >
                {/* ：成员列表头像角落状态灯（与消息头像同款；Worker 才有映射）。 */}
                <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
                  <MxcAvatar
                    url={member?.avatar_url}
                    size={30}
                    style={{ backgroundColor: PRIMARY, flexShrink: 0 }}
                  >
                    {name.slice(0, 1).toUpperCase()}
                  </MxcAvatar>
                  {workerSessionByMxid?.[mxid] ? (
                    <WorkerSessionDot state={workerSessionByMxid[mxid]} size={8} corner />
                  ) : null}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: 13,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {name}
                    {isMe ? (
                      <span style={{ color: t.textSecondary, fontSize: 12 }}>（我）</span>
                    ) : null}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: t.textSecondary,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {mxid}
                  </div>
                </div>
                {/* 触屏 44px 点击区（任务 D §5）：两按钮共一个 44px 命中行。 */}
                <div className="wb-member-actions" style={{ display: "flex", flexShrink: 0 }}>
                  {!isMe ? (
                    <antd.Button
                      size="small"
                      type="text"
                      onClick={() => {
                        insertMention(mxid);
                        setMemberPanelOpen(false);
                      }}
                    >
                      {tr("@ 提及")}
                    </antd.Button>
                  ) : null}
                  <antd.Button
                    size="small"
                    type="text"
                    title={tr("成员详情")}
                    aria-label={tr("成员详情")}
                    onClick={() => {
                      setDetailMxid(mxid);
                      setMemberPanelOpen(false);
                    }}
                  >
                    ⓘ
                  </antd.Button>
                </div>
              </div>
            );
          })}
        </div>
      </antd.Drawer>

      {/* 房间详情 Drawer（Element 同款：房间 ID/主题/成员角色/设置）。
退出房间走现有 leave 链路（onLeaveRoom → setActiveRoom(null) →
本组件条件渲染卸载，Drawer 自动关闭）。 */}
      <RoomInfoDrawer
        open={roomInfoOpen}
        roomId={room.room_id}
        roomName={room.name}
        onClose={() => setRoomInfoOpen(false)}
        onLeaveRoom={p.onLeaveRoom}
        onRename={() => openRename()}
        muted={p.muted}
        onToggleMute={p.onToggleMute}
        refreshTick={roomInfoRefreshTick}
      />

      {/* 重命名房间（Element 同款）+ 权限诊断。
 任务 D §4：Modal 宽度 Math.min(560, innerWidth-48)（窄屏不撑破）。 */}
      <antd.Modal
        title={tr("重命名房间")}
        width="min(560px, calc(100vw - 48px))"
        open={renameOpen}
        onCancel={() => setRenameOpen(false)}
        onOk={() => {
          if (!renameValue.trim()) return;
          const nm = renameValue.trim();
          setRenameOpen(false);
          // 重命名完成（成功/失败）后通知详情 Drawer 重拉房间信息。
          return (async () => {
            try {
              await p.onRenameRoom?.(nm);
            } finally {
              setRoomInfoRefreshTick((v) => v + 1);
            }
          })();
        }}
        okText={tr("保存")}
        cancelText={tr("取消")}
        okButtonProps={{
          disabled:
            !renameValue.trim() ||
            (powerInfo !== null && !powerLoading && !powerInfo.canRename),
        }}
      >
        <div style={{ display: "grid", gap: 8 }}>
          <antd.Input
            value={renameValue}
            onChange={(e: { target: { value: string } }) =>
              setRenameValue(e.target.value)
            }
            placeholder={tr("新房间名")}
            maxLength={100}
            autoFocus
          />
          {powerLoading ? (
            <div style={{ fontSize: 12, color: t.textSecondary }}>
              {tr("正在读取房间权限…")}
            </div>
          ) : powerInfo && !powerInfo.canRename ? (
            <antd.Alert
              type="warning"
              showIcon
              style={{ fontSize: 12 }}
              message={
                powerInfo.content
                  ? tr(
                      "权限不足：你 {a}/{b}（改名需 ≥ {b}）。需房间管理员（Manager）提权。",
                      {
                        a: String(powerInfo.myLevel),
                        b: String(powerInfo.nameRequired),
                      },
                    )
                  : tr(
                      "该房间没有有效的权限设置，按默认严格权限执行，无法改名（所有成员均被拒）。Element 的灰色输入框是同一根因，不是 Element 的问题。请管理员修复房间的权限设置后重试。",
                    )
              }
            />
          ) : null}
        </div>
      </antd.Modal>

      {/* #87 团队共享文件引用选择器（仅 Team: 房间；确认合并进已选，去重 by key）。 */}
      {teamName ? (
        <FileRefPicker
          open={refPickerOpen}
          team={teamName}
          onClose={() => setRefPickerOpen(false)}
          onConfirm={(refs) =>
            setFileRefs((prev) => [
              ...prev,
              ...refs.filter((r) => !prev.some((p) => p.key === r.key)),
            ])
          }
        />
      ) : null}

      {/* 成员详情卡：身份/角色 + 房间内最近消息 + DM */}
      {detailMxid && room ? (
        <MemberDetail
          mxid={detailMxid}
          displayName={senderShortName(detailMxid, room)}
          avatarUrl={room.members?.[detailMxid]?.avatar_url}
          role={c.memberRoles?.[detailMxid]}
          workerName={memberWorkerNames?.[detailMxid]}
          onOpenChats={onOpenWorkerChats}
          workerRuntime={workerRuntimeByMxid?.[detailMxid]}
          onMention={insertMention}
          roomId={room.room_id}
          roomName={room.name}
          onDm={onDm}
          onClose={() => setDetailMxid(null)}
        />
      ) : null}
    </>
  );
}
