import {
  WrenchIcon,
  FolderIcon,
  SearchIcon,
  EditIcon,
  BellIcon,
  BellOffIcon,
  DoorIcon,
  TodoIcon,
  InfoIcon,
} from "./icons";
import WorkerSessionDot from "./WorkerSessionDot";
import MemberStrip from "./MemberStrip";
import { type WorkerSessionState } from "../workerSessionState";
import { useThemeColors } from "../theme";
import { copyText } from "../util";
import {PRIMARY } from "./RoomChatShared";
import type {RoomChatProps } from "./RoomChat";
import type {RoomChatCoreState } from "./RoomChatCore";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
export function RoomChatHeader(props: { p: RoomChatProps; c: RoomChatCoreState }) {
  const { p, c } = props;
  const {
    room,
    onLeaveRoom,
    onRenameRoom,
    muted,
    onToggleMute,
    onBack,
    headerPrefix,
    onNewTask,
    workerBadge,
    sessionState,
    workerMxids,
    workerSessionByMxid,
    onOpenProjectFiles,
  } = p;
  const {
    setDraft,
    setSearchOpen,
    hideTools,
    setHideTools,
    setMemberPanelOpen,
    setRoomInfoOpen,
    openRename,
    tr,
    myUserId,
  } = c;
  const t = useThemeColors();
  if (!room) {
    return null;
  }
  return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          paddingBottom: 12,
          borderBottom: "1px solid rgba(0,0,0,0.08)",
          flexWrap: "wrap",
        }}
      >
        {headerPrefix}
        {onBack ? (
          <antd.Button size="small" onClick={onBack}>
            ← 返回
          </antd.Button>
        ) : null}
        <antd.Typography.Title level={5} style={{ margin: 0 }}>
          {room.name}
        </antd.Typography.Title>
        {/* 房间 ID 可见（等宽小字 + 复制）——排查「消息发到哪个房间」
  时插件内无处可查 room_id 的修复。 */}
        <span
          style={{
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontSize: 11,
            color: t.textSecondary,
            maxWidth: 260,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={room.room_id}
        >
          {room.room_id}
        </span>
        <antd.Button
          size="small"
          type="text"
          title={tr("复制房间 ID")}
          onClick={() =>
            copyText(room.room_id, (ok) => {
              if (ok) {
                antd.message.success(tr("已复制到剪贴板"));
              } else {
                antd.message.error(tr("复制失败"));
              }
            })
          }
        >
          {tr("复制")}
        </antd.Button>
        {/* Worker session 运行指示。
 1:1 Worker 房间 = sessionState 三态（蓝呼吸/绿/灰）；
 团队房间无 sessionState → 仅当任一 Worker 正在输入时显蓝点。 */}
        {(() => {
          const eff: WorkerSessionState | undefined =
            sessionState ??
            (workerMxids &&
            (room.typing || []).some((m) => workerMxids.has(m))
              ? "running"
              : undefined);
          return eff ? <WorkerSessionDot state={eff} /> : null;
        })()}
        {/* 1:1 Worker 房间头部双徽章（phase + runtime，
 数据=Worker CR 字段，WorkbenchPage 按 room_id 匹配注入）。 */}
        {workerBadge?.phase ? (
          <antd.Tag
            color={
              workerBadge.phase === "Running"
                ? "green"
                : workerBadge.phase === "Sleeping" || workerBadge.phase === "Stopped"
                  ? "orange"
                  : "default"
            }
            style={{ margin: 0 }}
            title={tr("Worker 状态（Controller CR phase）")}
          >
            {workerBadge.phase}
          </antd.Tag>
        ) : null}
        {workerBadge?.runtime ? (
          <antd.Tag
            style={{ margin: 0 }}
            title={tr("Worker 运行时（Controller CR runtime）")}
          >
            {workerBadge.runtime}
          </antd.Tag>
        ) : null}
        <antd.Tag
          color={PRIMARY}
          style={{ margin: 0, cursor: "pointer" }}
          onClick={() => setMemberPanelOpen(true)}
          title={tr("查看成员")}
        >
          {room.member_count} 人
        </antd.Tag>
        {onOpenProjectFiles ? (
          <antd.Button
            size="small"
            onClick={() => onOpenProjectFiles(room)}
            title={tr("项目文件（任务结果/任务书/交付物，产物端点 产物端点）")}
          >
            <FolderIcon size={13} style={{ verticalAlign: "-2px" }} /> {tr("项目文件")}
          </antd.Button>
        ) : null}
        {/* 按钮对齐 QwenPaw 风格——antd Button 继承主题
  token（主色/圆角/悬停），不再手写 pill+hover（与宿主结构同款）。 */}
        <antd.Button
          size="small"
          icon={<SearchIcon size={14} />}
          onClick={() => setSearchOpen(true)}
          title={tr("搜索当前房间历史消息")}
        >
          {tr("搜索")}
        </antd.Button>
        {/* 房间详情入口（Element 同款 (i) 钮）→ 右侧 Drawer（房间 ID/主题/成员角色/设置）。 */}
        <antd.Button
          size="small"
          type="text"
          icon={<InfoIcon size={14} />}
          onClick={() => setRoomInfoOpen(true)}
          title={tr("房间详情")}
          aria-label={tr("房间详情")}
        />
        {/* 房间操作（Element 同款能力：静音 + 退出房间）。
 静音=m.muted_room account data（跨客户端状态源；插件通知引擎
 sync_watcher 同数据源消费，静音房间不再触发 @/任务通知）。
 退出=POST /rooms/{id}/leave——scope 房间会被 Controller 调和器
 重新邀请（确认文案提示）。 */}
        {onToggleMute || onLeaveRoom ? (
          <antd.Dropdown
            trigger={["click"]}
            menu={{
              items: [
                ...(onRenameRoom
                  ? [
                      {
                        key: "rename",
                        label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><EditIcon size={13} /> {tr("重命名房间")}</span>,
                      },
                    ]
                  : []),
                ...(onRenameRoom && (onToggleMute || onLeaveRoom)
                  ? [{ type: "divider" as const }]
                  : []),
                ...(onToggleMute
                  ? [
                      {
                        key: "mute",
                        label: muted
                          ? <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><BellIcon size={13} /> {tr("取消静音")}</span>
                          : <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><BellOffIcon size={13} /> {tr("静音此房间")}</span>,
                      },
                    ]
                  : []),
                ...(onLeaveRoom
                  ? [
                      { type: "divider" as const },
                      {
                        key: "leave",
                        danger: true,
                        label: <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><DoorIcon size={13} /> {tr("退出房间")}</span>,
                      },
                    ]
                  : []),
              ],
              onClick: ({ key }: { key: string }) => {
                if (key === "rename") {
                  openRename();
                } else if (key === "mute") {
                  void onToggleMute?.();
                } else if (key === "leave") {
                  antd.Modal.confirm({
                    title: tr("退出房间「{name}」？", { name: room.name }),
                    content: tr("退出后不再接收该房间消息。系统团队房间可能被 Controller 调和器自动重新邀请；非系统房间需再次被邀请才能进入。"),
                    okText: tr("退出"),
                    okButtonProps: { danger: true },
                    cancelText: tr("返回"),
                    onOk: () => onLeaveRoom?.(),
                  });
                }
              },
            }}
          >
            <antd.Button size="small" type="text">
              ⋯
            </antd.Button>
          </antd.Dropdown>
        ) : null}
        <antd.Switch
          size="small"
          checked={hideTools}
          onChange={setHideTools}
          checkedChildren={<span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><WrenchIcon size={11} /> {tr("隐藏工具")}</span>}
          unCheckedChildren={<span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><WrenchIcon size={11} /> {tr("显示工具")}</span>}
          title={tr("隐藏/显示 Agent 工具调用消息（read_file 等）")}
        />
        <div style={{ flex: 1 }} />
 {/* （模仿 dashboard 成员列表）：标题栏右侧成员头像条——
 Worker 角落状态灯 + 多出来 +N 点击展开；窄屏换行到标题栏下面。 */}
        <MemberStrip
          room={room}
          workerSessionByMxid={workerSessionByMxid}
          onOpenPanel={() => setMemberPanelOpen(true)}
        />
        {onNewTask && room.member_count <= 2 ? (
          <antd.Button
            size="small"
            type="primary"
            style={{ backgroundColor: PRIMARY, borderColor: PRIMARY }}
            onClick={() => {
              const target =
                Object.keys(room.members || {}).find((m) => m !== myUserId) ||
                "";
              const targetName = target
                ? target.split(":")[0].replace(/^@/, "")
                : room.name;
              setDraft(
                `@${targetName} 你好，我想发起一个新任务：\n\n【任务目标】\n（在这里描述你要做什么，例如：调研竞品 X 的定价策略并输出报告）\n\n【期望产出】\n（例如：一份 Markdown 报告，周五前）\n\n请先确认需求，有不清楚的直接问我。`,
              );
              onNewTask();
            }}
          >
            <TodoIcon size={13} style={{ verticalAlign: "-2px" }} /> 发起任务
          </antd.Button>
        ) : null}
      </div>
  );
}
