// 团队域（/teams/*、/dm、/matrix/rooms/*/join|leave、/team-files、/matrix/member/messages）：团队结构/spawn/房间列表/邀请/共享文件/成员消息。

import { requestJson } from "../shared";
import { cachedFetch, cachedRequest } from "../../requestCache";
import { fetchProjectSummaries } from "./workflow";

// ── Team data (page shells render these; adapters fill them) ───────────

export interface TeamMember {
  display_name?: string;
  avatar_url?: string;
}

export interface TeamRoom {
  room_id: string;
  name: string;
  name_fallback?: boolean;
  member_count: number;
  members: Record<string, TeamMember>;
  /** 未读消息数（Matrix sync unread_notifications）。 */
  unread?: number;
  /** @高亮未读数（被点名）。 */
  unread_highlight?: number;
  /** 正在输入的用户（m.typing 事件，60s 快照新鲜度）。 */
  typing?: string[];
  /** 最后一条消息时间戳（/sync timeline limit=1，聊天列表排序用）。 */
  last_ts?: number;
  /** 最后一条消息正文摘要（m.room.message 才有，≤120 字）。 */
  last_body?: string;
  /** 最后一条消息的发送者 MXID（per-sender 灯源，
 * session 灯 done 回退只认 Worker 自己的消息，用户消息不再点绿整个房间）。 */
  last_sender?: string;
}

/** 邀请房间（sync rooms.invite 段，——此前插件完全不可见）。 */
export interface InviteRoom {
  room_id: string;
  name: string;
  name_fallback?: boolean;
  /** 邀请人 MXID（invite_state 的 m.room.member membership=invite 事件 sender）。 */
  inviter?: string;
  /** 邀请时间（ms epoch，排序用）。 */
  inviter_ts?: number;
}

export interface TeamsRoomsResponse {
  ok: boolean;
  rooms: TeamRoom[];
  /** 待接受邀请（Element 同款邀请区数据源）。 */
  invites?: InviteRoom[];
  /** 已静音房间（account_data m.muted_room 聚合）。 */
  muted_rooms?: string[];
  user_id: string;
  worker_groups?: WorkerSpawnGroup[];
  worker_tree?: WorkerTreeTeam[];
}

/** 接受邀请 = POST /_matrix/client/v3/rooms/{roomId}/join。
 * 实锤：生产 homeserver（Tuwunel/Conduit 系，部分实现）不识别
 * /invite/{userId}/accept 路由（真房/假房/r0/v3 全 M_UNRECOGNIZED 404），
 * 但 /join 可用——按 CS-API spec，受邀者对 invite 状态房间 join = 接受邀请
 * （Element joinRoom 对 invite 房间走的也是 join 端点）。
 * 成功后房间进 join 段，下次 sync 可见。 */
export async function acceptInvite(roomId: string): Promise<void> {
  await requestJson(
    `/agentteams-proxy/matrix/rooms/${encodeURIComponent(roomId)}/join`,
    { method: "POST", body: "{}" },
  );
}

/** 拒绝邀请（CS-API v3：invite 状态下的 leave=decline，Element 同款）。 */
export async function rejectInvite(roomId: string): Promise<void> {
  await requestJson(
    `/agentteams-proxy/matrix/rooms/${encodeURIComponent(roomId)}/leave`,
    { method: "POST", body: "{}" },
  );
}

export interface SpawnNode {
  session_id: string;
  name: string;
  status: "idle" | "running" | "done";
  last_activity?: string;
  created_at: number;
  children?: SpawnNode[];
  /** 正源：父 spawn 的 session_id（root_session_id），用于建树后不展示。 */
  rootSessionId?: string;
  /* spawn 工具/技能白名单——QwenPaw #7004 持久化（meta.subagent_allowed_tools/
 subagent_skills）经 Controller spawn 端点透传（需上游 main 64a77b5f+，v1.2.3 tag 未含）；仅当派发时
 受限且 Worker 运行 QwenPaw 2.1+ 时出现，2.0.1 恒无（不渲染）。 */
  allowedTools?: string[];
  skills?: string[];
}

export interface WorkerSpawnGroup {
  worker_name: string;
  mxid: string;
  role: "leader" | "worker" | "critic" | "unknown";
  is_self?: boolean;
  spawns: SpawnNode[];
  phase?: string;
  /* Worker 个人房间（Controller roomID，
 私聊直跳）+ runtime（CR 字段，runtime 徽章）。room-fallback 源无此二字段。 */
  room_id?: string;
  runtime?: string;
  /** ：legacy 角标（admin 源有；tree 源无=undefined）。 */
  runtimeDeprecated?: boolean;
}

export interface WorkerTreeTeam {
  team_name: string;
  room_id?: string;
  workers: WorkerSpawnGroup[];
}

/** cachedFetch 包裹（teams/structure，TTL 15s + SWR 15s，tags
 * ["teams"]）——已有 force 参数透传（team tab 切回 30s 节流后走此缓存）；
 * requestJson 第 3 参 30000 超时保留。SWR：15-30s 段先回旧树（零等待）+
 * 后台再验证；force=true 一律跳过缓存直回源。 */
export async function fetchTeamsStructure(
  force = false,
): Promise<{ ok: boolean; tree: WorkerTreeTeam[]; source: string }> {
  return cachedFetch(
    "teams/structure",
    15000,
    async () => {
      // 30s 封顶——冷窗后端已 ≤~6s（connect 3s
      // failover + 探针 3s 收敛），30s 未回 = 真故障，显形可重试优于恒转圈。
      return (await requestJson(
        `/agentteams-proxy/teams/structure${force ? "?force=true" : ""}`,
        undefined,
        30000,
      )) as { ok: boolean; tree: WorkerTreeTeam[]; source: string };
    },
    { force, tags: ["teams"], swrMs: 15000 },
  );
}

/** spawn 正源（上游已合并）：projects list + 每项目 /spawns 聚合 →
 * 按 worker 名建 spawn 树（root_session_id 链 = 父子）。返回 apiOk=false
 * 时调用方降级为空 spawns（现状）。
 * 外层 cachedRequest 包裹（worker/spawns，60s，
 * tags ["spawns"]）——重复调用（组件多处唤起）合并为一次。 */
async function loadWorkerSpawnsRaw(): Promise<{
  byWorker: Record<string, SpawnNode[]>;
  apiOk: boolean;
}> {
  try {
    const projects = await fetchProjectSummaries();
    const byWorker: Record<string, SpawnNode[]> = {};
    if (projects.length === 0) return { byWorker, apiOk: true };
    await Promise.all(
      projects.slice(0, 20).map(async (proj) => {
        const pid = String(proj.project_id || "");
        if (!pid) return;
        // project_id 跨团队歧义时控制器返回 409
        // 「retry with ?team=」（project_handler.go）——带上 team_id 消歧。
        const team = String(proj.team_id || "");
        try {
          const resp = (await requestJson(
            `/agentteams-proxy/controller/api/v1/projects/${encodeURIComponent(pid)}/spawns` +
              (team ? `?team=${encodeURIComponent(team)}` : ""),
          )) as { workers?: { worker?: string; spawns?: Record<string, unknown>[] }[] };
          for (const w of resp.workers || []) {
            const name = String(w.worker || "");
            if (!name) continue;
            const nodes = (w.spawns || []).map(mapSpawnInfo);
            if (!byWorker[name]) byWorker[name] = [];
            byWorker[name].push(...nodes);
          }
        } catch {
          /* 单项目失败跳过 */
        }
      }),
    );
    // root_session_id 链 → 树：root 指向另一个 spawn session 的挂为子节点；
    // 指向房间（matrix:）或空的为顶层。
    for (const name of Object.keys(byWorker)) {
      const all = byWorker[name];
      const bySession = new Map(all.map((n) => [n.session_id, n]));
      const roots: SpawnNode[] = [];
      for (const n of all) {
        const rootKey = (n as unknown as { rootSessionId?: string }).rootSessionId;
        if (rootKey && bySession.has(rootKey)) {
          const parent = bySession.get(rootKey)!;
          if (!parent.children) parent.children = [];
          parent.children.push(n);
        } else {
          roots.push(n);
        }
      }
      byWorker[name] = roots;
    }
    return { byWorker, apiOk: true };
  } catch {
    return { byWorker: {}, apiOk: false };
  }
}

/** 对外缓存包装（worker/spawns，60s，tags
 * ["spawns"]）——让重复调用（组件多处唤起）合并为一次。 */
export async function fetchWorkerSpawns(): Promise<{
  byWorker: Record<string, SpawnNode[]>;
  apiOk: boolean;
}> {
  return cachedRequest("worker/spawns", 60000, loadWorkerSpawnsRaw, {
    tags: ["spawns"],
  });
}

/** Controller spawn 端点白名单字段 → string[]（防御：非数组/空串过滤；空=undefined 不渲染）。 */
function spawnStringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter(
    (x): x is string => typeof x === "string" && x !== "",
  );
  return out.length ? out : undefined;
}

/** spawnInfo → SpawnNode（UI 契约映射）。 */
function mapSpawnInfo(s: Record<string, unknown>): SpawnNode {
  const createdIso = typeof s.created_at === "string" ? s.created_at : "";
  return {
    session_id: String(s.session_id || ""),
    name: typeof s.name === "string" ? s.name : "",
    status: (["idle", "running", "done"].includes(String(s.status))
      ? String(s.status)
      : "idle") as SpawnNode["status"],
    last_activity:
      typeof s.updated_at === "string" ? s.updated_at : undefined,
    created_at: createdIso ? Date.parse(createdIso) || 0 : 0,
    ...((s as { root_session_id?: unknown }).root_session_id
      ? {
          rootSessionId: String(
            (s as { root_session_id?: unknown }).root_session_id,
          ),
        }
      : {}),
    allowedTools: spawnStringList(s.subagent_allowed_tools),
    skills: spawnStringList(s.subagent_skills),
  } as SpawnNode;
}

export async function openDm(
  mxidOrName: string,
  /** 房间显示名（后端建房写入 m.room.name；缺省后端兜底  私聊 · <localpart>）。 */
  name?: string,
): Promise<{ ok: boolean; target: string; room_id: string; created: boolean }> {
  const trimmed = (name || "").trim();
  return (await requestJson("/agentteams-proxy/dm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      trimmed ? { user: mxidOrName, name: trimmed } : { user: mxidOrName },
    ),
  })) as { ok: boolean; target: string; room_id: string; created: boolean };
}

/** 【历史替代，勿删·预埋清单 P2】/teams/rooms 实时聚合版——现役链路用
 * /teams/sync（缓存+force 超集）；保留作实时无缓存替代（排查缓存问题时用）。
 * 死码审计豁免：见 PREEMBED-EXEMPT.md（方案 §5.5c）。 */
export async function fetchTeamsRooms(): Promise<TeamsRoomsResponse> {
  return (await requestJson("/agentteams-proxy/teams/rooms")) as TeamsRoomsResponse;
}

/** cachedFetch 包裹（teams/sync，TTL 15s + SWR 15s，tags
 * ["teams"]）——已有 force 参数透传。SWR：15-30s 段先回旧列表（零等待）+
 * 后台再验证；force=true 一律跳过缓存直回源。 */
export async function fetchTeamsSync(
  force = false,
): Promise<TeamsRoomsResponse & { elapsed?: number }> {
  return cachedFetch(
    "teams/sync",
    15000,
    async () =>
      (await requestJson(
        `/agentteams-proxy/teams/sync${force ? "?force=true" : ""}`,
      )) as TeamsRoomsResponse & { elapsed?: number },
    { force, tags: ["teams"], swrMs: 15000 },
  );
}

// ── 团队共享文件（#87 聊天引用工作区文件 · 数据面）──────────────
// 后端 = GET /agentteams-proxy/team-files|team-file（Controller Docker
// 代理 × admin token；team→worker 容器→shared 根，见 team_files_api）。
export interface TeamFileEntry {
  /** 裸名（目录/文件）。 */
  name: string;
  /** shared 根相对键（目录导航用）。 */
  key: string;
  /** true=目录（或符号链接目录），可进入。 */
  isPrefix: boolean;
  /** 文件字节数（目录恒 0）。 */
  size: number;
}

/** 列取团队共享目录一层（非递归）；prefix 为空=根。 */
export async function fetchTeamFiles(
  team: string,
  prefix = "",
): Promise<TeamFileEntry[]> {
  const q = new URLSearchParams({ team });
  if (prefix) q.set("prefix", prefix);
  const data = await requestJson(
    `/agentteams-proxy/team-files?${q.toString()}`,
  );
  return Array.isArray(data) ? (data as TeamFileEntry[]) : [];
}

// ── 成员详情：某成员在房间内的最近消息（messages 翻页过滤）───

export interface MemberMessage {
  event_id: string;
  sender: string;
  body: string;
  origin_server_ts: number;
}

export async function fetchMemberMessages(
  roomId: string,
  sender: string,
  limit = 5,
): Promise<{ ok: boolean; messages: MemberMessage[] }> {
  const params = new URLSearchParams({
    roomId,
    sender,
    limit: String(limit),
  });
  return (await requestJson(
    `/agentteams-proxy/matrix/member/messages?${params.toString()}`,
  )) as { ok: boolean; messages: MemberMessage[] };
}

// ── 房间详情（Element 同款房间详情面板 · 数据面）──────────────
// 后端 = GET /agentteams-proxy/matrix/rooms/{roomId}/info（matrix_api，
// 聚合 7 个房间 state 事件 + joined_members；角色映射 owner/moderator/
// member 按 power level 100/50 阈值，Element 同款）。

export interface RoomInfoMember {
  user_id: string;
  display_name: string;
  avatar_url: string;
  power_level: number;
  role: "owner" | "moderator" | "member";
}

export interface RoomInfo {
  room_id: string;
  name: string;
  topic: string;
  canonical_alias: string;
  creator: string;
  join_rule: string;
  encrypted: boolean;
  member_count: number;
  members: RoomInfoMember[];
}

export async function fetchRoomInfo(
  roomId: string,
): Promise<RoomInfo> {
  return (await requestJson(
    `/agentteams-proxy/matrix/rooms/${encodeURIComponent(roomId)}/info`,
  )) as RoomInfo;
}
