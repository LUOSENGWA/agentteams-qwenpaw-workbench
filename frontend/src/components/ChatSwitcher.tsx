// ChatSwitcher.tsx — 聊天页头部团队/房间切换（R15）。
//
// 数据全部复用父级既有列表（rooms=/teams/sync、teams=/teams/structure），
// 零新请求；选中团队写 localStorage（房间选中沿用 ui-state-v2.roomId）。
// 桌面=两个内联 Select；窄屏折叠成一个按钮 + Popover（不占头部第二行）。

import type { TeamRoom, WorkerTreeTeam } from "../api";
import { useT } from "../i18n";
import {
  buildRoomGroups,
  readTeamPref,
  teamNameForRoom,
  writeTeamPref,
} from "../lib/chatSwitcher";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

export interface ChatSwitcherProps {
  rooms: TeamRoom[];
  teams: WorkerTreeTeam[];
  /** 当前打开的房间（标题栏所属）。 */
  activeRoom: TeamRoom;
  /** 打开房间（父级 openRoom；同时落 ui-state 持久化）。 */
  onSwitchRoom: (roomId: string) => void;
  /** 窄屏紧凑头：折叠为按钮 + Popover。 */
  narrow?: boolean;
}

export function ChatSwitcher(props: ChatSwitcherProps) {
  const { rooms, teams, activeRoom, onSwitchRoom, narrow } = props;
  const tr = useT();
  const [open, setOpen] = React.useState(false);
  // 当前房间所属团队优先；房间不属于任何团队时回退上次持久化的选择。
  const [teamPref, setTeamPref] = React.useState<string>(() => readTeamPref());
  const currentTeam =
    teamNameForRoom(teams, activeRoom.room_id) || teamPref || "";
  const teamOptions = React.useMemo(
    () => [
      { value: "", label: tr("全部团队") },
      ...teams.map((tm) => ({
        value: tm.team_name,
        label: tm.team_name,
        disabled: !tm.room_id || !rooms.some((r) => r.room_id === tm.room_id),
      })),
    ],
    [teams, rooms, tr],
  );
  const roomGroups = React.useMemo(
    () =>
      buildRoomGroups(rooms, teams).map((g) => ({
        label: g.key.startsWith("team:") ? g.label : tr(g.label),
        options: g.rooms,
      })),
    [rooms, teams, tr],
  );
  const pickTeam = React.useCallback(
    (value: string) => {
      setTeamPref(value);
      writeTeamPref(value);
      const hit = teams.find((tm) => tm.team_name === value);
      if (hit?.room_id && rooms.some((r) => r.room_id === hit.room_id)) {
        onSwitchRoom(hit.room_id);
      }
      setOpen(false);
    },
    [teams, rooms, onSwitchRoom],
  );
  const pickRoom = React.useCallback(
    (roomId: string) => {
      if (roomId && roomId !== activeRoom.room_id) onSwitchRoom(roomId);
      setOpen(false);
    },
    [activeRoom.room_id, onSwitchRoom],
  );
  if (rooms.length === 0) return null;

  const selects = (
    <div
      style={{
        display: narrow ? "grid" : "inline-flex",
        gap: 6,
        alignItems: "center",
        width: narrow ? 240 : undefined,
      }}
    >
      {teams.length > 0 ? (
        <antd.Select
          size="small"
          value={currentTeam}
          options={teamOptions}
          onChange={pickTeam}
          aria-label={tr("团队切换")}
          title={tr("团队切换")}
          style={{ width: narrow ? "100%" : 128 }}
        />
      ) : null}
      <antd.Select
        size="small"
        showSearch
        optionFilterProp="label"
        value={activeRoom.room_id}
        options={roomGroups}
        onChange={pickRoom}
        aria-label={tr("房间切换")}
        title={tr("房间切换")}
        style={{ width: narrow ? "100%" : 168 }}
      />
    </div>
  );

  if (narrow) {
    return (
      <antd.Popover
        trigger="click"
        open={open}
        onOpenChange={setOpen}
        placement="bottomRight"
        content={selects}
      >
        <antd.Button
          size="small"
          type="text"
          aria-label={tr("切换团队/房间")}
          title={tr("切换团队/房间")}
          style={{ flexShrink: 0 }}
        >
          ⇄
        </antd.Button>
      </antd.Popover>
    );
  }
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      {selects}
    </span>
  );
}
