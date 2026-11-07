/**
 * chatSwitcher.ts — 聊天页团队/房间切换纯函数层（R15）。
 *
 * 分工：
 * - 本文件：团队↔房间映射 / 分组选项 / 选中团队持久化——无副作用，
 *   不碰 React/DOM（storage 可注入，便于单测）；
 * - components/ChatSwitcher.tsx：Select/Popover 渲染与交互。
 *
 * 数据来源（零新请求）：rooms = /teams/sync 房间列表（TeamRoom[]），
 * teams = /teams/structure 团队树（WorkerTreeTeam[]，team.room_id 即团队群）。
 */

import type { TeamRoom, WorkerTreeTeam } from "../api";

/** 选中团队持久化键（房间选中由既有 ui-state-v2.roomId 承担）。 */
export const CHAT_TEAM_KEY = "agentteams-qwenpaw-workbench:chat-team";

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): KeyValueStorage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** 读上次选中的团队名（无/损坏/storage 不可用 → 空串）。 */
export function readTeamPref(
  storage: KeyValueStorage | null = defaultStorage(),
): string {
  try {
    return (storage?.getItem(CHAT_TEAM_KEY) || "").trim();
  } catch {
    return "";
  }
}

/** 写选中团队名（空串 = 清除选择；storage 不可用静默跳过）。 */
export function writeTeamPref(
  name: string,
  storage: KeyValueStorage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(CHAT_TEAM_KEY, (name || "").trim());
  } catch {
    /* storage 不可用则跳过 */
  }
}

/** 房间归属团队名（team.room_id = 团队群房间）；无归属 → 空串。 */
export function teamNameForRoom(
  teams: WorkerTreeTeam[],
  roomId: string,
): string {
  if (!roomId) return "";
  const hit = teams.find((tm) => !!tm.room_id && tm.room_id === roomId);
  return hit ? hit.team_name : "";
}

export interface SwitcherRoomOption {
  value: string;
  label: string;
}

export interface SwitcherRoomGroup {
  key: string;
  /** 分组标题（团队名原样；非团队组为中文键，渲染侧 tr()）。 */
  label: string;
  rooms: SwitcherRoomOption[];
}

/** 房间下拉分组：团队群（按团队名）→ 私聊（≤2 人）→ 其他房间。 */
export function buildRoomGroups(
  rooms: TeamRoom[],
  teams: WorkerTreeTeam[],
): SwitcherRoomGroup[] {
  const teamByRoom = new Map<string, string>();
  for (const tm of teams) {
    if (tm.room_id) teamByRoom.set(tm.room_id, tm.team_name);
  }
  const teamRooms = new Map<string, SwitcherRoomOption[]>();
  for (const tm of teams) {
    if (!teamRooms.has(tm.team_name)) teamRooms.set(tm.team_name, []);
  }
  const dm: SwitcherRoomOption[] = [];
  const other: SwitcherRoomOption[] = [];
  for (const r of rooms) {
    const opt = { value: r.room_id, label: r.name || r.room_id };
    const team = teamByRoom.get(r.room_id);
    if (team) {
      teamRooms.get(team)?.push(opt);
    } else if ((r.member_count ?? 0) <= 2) {
      dm.push(opt);
    } else {
      other.push(opt);
    }
  }
  const groups: SwitcherRoomGroup[] = [];
  for (const [name, list] of teamRooms) {
    if (list.length > 0) {
      groups.push({ key: `team:${name}`, label: name, rooms: list });
    }
  }
  if (dm.length > 0) groups.push({ key: "dm", label: "私聊", rooms: dm });
  if (other.length > 0) {
    groups.push({ key: "other", label: "其他房间", rooms: other });
  }
  return groups;
}
