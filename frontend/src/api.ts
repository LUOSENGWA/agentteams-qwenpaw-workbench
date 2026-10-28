// api.ts — barrel（按域拆分）：纯重导出，本文件无定义。
// 消费方（components/*、crdmanage/*、kb/*、workflowboard/* 等）保持
// `from "../api"` 具名 import 零改动；域文件 = api/domains/*（按 HTTP 路径前缀/业务域），
// 跨域共享底座 = api/shared.ts（显式具名重导出——shared 的
// controllerRequest、teams 的 TeamsRoomsResponse 均为域间私有引用，
// 不进 barrel 公共面——原 228 导出面逐名不变）。
export { requestJson, httpErrorStatus, httpErrorDetail, fetchControllerJson, postController, getCachedRooms, setCachedRooms, getCachedMessages, setCachedMessages, appendCachedMessage } from "./api/shared";
export * from "./api/domains/settings";
export * from "./api/domains/gateway";
export * from "./api/domains/audit";
export * from "./api/domains/upgrade";
export * from "./api/domains/codingcli";
export * from "./api/domains/crd";
export * from "./api/domains/worker";
export * from "./api/domains/chat";
export type { InviteRoom, MemberMessage, RoomInfo, RoomInfoMember, SpawnNode, TeamFileEntry, TeamMember, TeamRoom, WorkerSpawnGroup, WorkerTreeTeam } from "./api/domains/teams";
export { acceptInvite, fetchMemberMessages, fetchRoomInfo, fetchTeamFiles, fetchTeamsRooms, fetchTeamsStructure, fetchTeamsSync, fetchWorkerSpawns, openDm, rejectInvite } from "./api/domains/teams";
export * from "./api/domains/workflow";
export * from "./api/domains/inbox";
export * from "./api/domains/approvals";
export * from "./api/domains/kb";
export * from "./api/domains/checkpoints";
export * from "./api/domains/attention";
export * from "./api/domains/templates";
export * from "./api/domains/millforge";
