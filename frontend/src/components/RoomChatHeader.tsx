import {
  WrenchIcon,
  FolderIcon,
  SearchIcon,
  TodoIcon,
  InfoIcon,
} from "./icons";
import WorkerSessionDot from "./WorkerSessionDot";
import MemberStrip from "./MemberStrip";
import { type WorkerSessionState } from "../workerSessionState";
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
    tr,
    myUserId,
  } = c;
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
        {/* 房间 ID 已收口到「房间详情」Drawer（标题栏不再展示）。 */}
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
        {/* 房间操作（重命名/静音/退出/退出并删除）已收口到
 「房间详情」Drawer 的「房间操作」区块——标题栏不再设 ⋯ 菜单。 */}
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
