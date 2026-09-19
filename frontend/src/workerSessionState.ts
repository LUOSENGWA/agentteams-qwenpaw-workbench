// v0.5.0-beta.12.4（A17）：Worker session 运行指示——纯前端派生，零后端改动。
// v0.5.0-beta.12.9（A17 升级，与 dashboard 3ad94e2 同源）：派生升级为
// 心跳优先（agentStatus/runningTaskCount = 任务级真相，无时间上限），
// typing 降为实时回退，lastFinishAt/last_ts 10min 衰减。
//
// 数据源（全部既有通道，零新增请求）：
//   WorkerInfo 心跳字段  —— GET /workers（fetchAdminData 已拉）agent 状态
//   TeamRoom.typing      —— m.typing 事件（25s 续期，2min 硬上限——仅回退位）
//   TeamRoom.last_ts     —— 房间最后一条消息时间戳（/sync timeline limit=1）
//   TeamRoom.members     —— 房间成员 MXID 表
//
// 状态机（9/14 定稿 + 9/18 心跳升级，产品色板：蓝=运行中（呼吸）/绿=运行完成/灰=无任务）：
//   running = agentStatus "running" / runningTaskCount>0（任务级，无上限）
//           或该 Worker 的 MXID 在任一房间 typing[] 内（实时回退）
//   done    = lastFinishAt 或最近活动（last_ts）距今 ≤ 10min（衰减窗口）
//   idle    = 其余
//
// 旧版 controller（无心跳字段）→ 优雅降级 typing + last_ts（同 12.4 行为，
// 不产生超出 10min 衰减的假 done）。
//
// done 语义边界（1:1 房间）：last_ts 不区分发送方——用户刚发出任务、
// Worker 尚未开始 typing 的短窗口内可能短暂显绿。Worker 端「收到即
// 立即 typing」（matrix_channel 实锤），窗口极短，接受。
// 团队房间无 per-user last-sender 数据（零后端约束）→ 团队房间只表达
// running（Worker 正在打字/有活动任务），不显 done/idle（避免人类消息误触绿）。

import type { TeamRoom, WorkerTreeTeam } from "./api";

export type WorkerSessionState = "running" | "done" | "idle";

/** done 窗口：最后活动距今 ≤10min 视为「刚完成」。 */
export const DONE_WINDOW_MS = 10 * 60 * 1000;
/** 老化 tick：60s 重派生一次（done→idle 边界翻转不依赖新消息）。 */
const TICK_MS = 60 * 1000;

/** 派生所需的最小房间形状（TeamRoom 满足；测试可传瘦对象）。 */
export interface SessionRoomLike {
  typing?: string[];
  last_ts?: number;
  members?: Record<string, unknown>;
}

/** Worker 心跳 agent 状态子集（WorkerInfo 同形状；测试可传瘦对象）。 */
export interface WorkerHeartbeatInfo {
  agentStatus?: string;
  runningTaskCount?: number;
  lastRunAt?: string;
  lastFinishAt?: string;
}

/**
 * Per-Worker 三态派生（v2 心跳优先，与 dashboard worker-session-state.ts
 * 逐句同源——单一事实源语义，两端独立维护但逻辑锁定一致）：
 *   1) 任务级真相（心跳，无时间上限）
 *   2) 实时 typing（回退）
 *   3) 最近完成（lastFinishAt 或最后活动，10min 衰减）
 */
export function deriveWorkerSessionState(opts: {
  heartbeat?: WorkerHeartbeatInfo | null;
  isTyping: boolean;
  /** Worker 最后活动 epoch ms（0/undefined = 无）。 */
  lastActivityTs?: number;
  now?: number;
}): WorkerSessionState {
  const { heartbeat, isTyping, lastActivityTs, now = Date.now() } = opts;
  if (
    heartbeat?.agentStatus === "running" ||
    (heartbeat?.runningTaskCount ?? 0) > 0
  ) {
    return "running";
  }
  if (isTyping) return "running";
  const finishTs = heartbeat?.lastFinishAt
    ? Date.parse(heartbeat.lastFinishAt)
    : Number.NaN;
  const recentTs =
    Number.isFinite(finishTs) && finishTs > 0
      ? finishTs
      : (lastActivityTs ?? 0);
  if (recentTs > 0 && now - recentTs <= DONE_WINDOW_MS) return "done";
  return "idle";
}

/** Per-Worker 三态：按 Worker MXID 跨全部房间派生（心跳优先，v2）。 */
export function workerSessionState(
  mxid: string | undefined,
  rooms: readonly SessionRoomLike[],
  heartbeat?: WorkerHeartbeatInfo | null,
  now: number = Date.now(),
): WorkerSessionState {
  if (!mxid) return "idle";
  let isTyping = false;
  let lastActivityTs = 0;
  for (const r of rooms) {
    if ((r.typing || []).includes(mxid)) isTyping = true;
    if (
      r.last_ts &&
      r.last_ts > lastActivityTs &&
      r.members &&
      mxid in r.members
    ) {
      lastActivityTs = r.last_ts;
    }
  }
  return deriveWorkerSessionState({ heartbeat, isTyping, lastActivityTs, now });
}

/** 房间级：任一 Worker 正在该房间 typing → running；否则按房间最后活动。 */
export function roomWorkerState(
  room: SessionRoomLike,
  workerMxids: ReadonlySet<string>,
  now: number = Date.now(),
): WorkerSessionState {
  for (const m of room.typing || [])
    if (workerMxids.has(m)) return "running";
  if (room.last_ts && now - room.last_ts <= DONE_WINDOW_MS) return "done";
  return "idle";
}

/** 从团队树收集全部 Worker MXID（L2 / 未配 token 的 room-fallback 源同款）。 */
export function collectWorkerMxids(
  workerTree?: WorkerTreeTeam[] | null,
): Set<string> {
  const out = new Set<string>();
  for (const team of workerTree || [])
    for (const w of team.workers || [])
      if (w.mxid) out.add(w.mxid);
  return out;
}

export interface WorkerSessionStates {
  /** worker_name → 状态（WorkerManage 行用）。 */
  byName: Record<string, WorkerSessionState>;
  /** 房间 room_id → 状态（Worker 个人房间卡 / 1:1 聊天头用）。 */
  byRoom: Record<string, WorkerSessionState>;
  /** Worker MXID → 状态（聊天消息头像状态点用，#A17 9/18 落点）。 */
  byMxid: Record<string, WorkerSessionState>;
  /** 全部 Worker MXID（团队房间 running 判定用）。 */
  workerMxids: Set<string>;
}

/**
 * 统一派生 hook：三落点共用一份状态（卡片列表 / Worker 行 / 房间头 / 消息头像）。
 * 60s tick 驱动 done→idle 老化。纯派生，无网络请求。
 *
 * workers = fetchAdminData().workers（GET /workers 透传，含心跳字段；
 * 旧版 controller 无字段 → 派生自动降级 typing+last_ts）。
 *
 * React 惰性取宿主（window.QwenPaw.host.React）——与 useAvatar.ts 同款，
 * 但放在 hook 体内而非模块顶层，保持纯函数部分可在 node 下直接验证。
 */
export function useWorkerSessionStates(
  rooms: TeamRoom[] | undefined,
  workerTree: WorkerTreeTeam[] | undefined,
  workers?:
    | readonly {
        name: string;
        matrixUserID: string;
        agentStatus?: string;
        runningTaskCount?: number;
        lastRunAt?: string;
        lastFinishAt?: string;
      }[]
    | null,
): WorkerSessionStates {
  const React = window.QwenPaw.host.React;
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), TICK_MS);
    return () => window.clearInterval(id);
  }, []);
  return React.useMemo(() => {
    const rs = rooms || [];
    const byName: Record<string, WorkerSessionState> = {};
    const byRoom: Record<string, WorkerSessionState> = {};
    const byMxid: Record<string, WorkerSessionState> = {};
    // 心跳索引（name + mxid 双键——workerTree 与 /workers 的命名可能不完全一致）。
    const hbByName = new Map<string, WorkerHeartbeatInfo>();
    const hbByMxid = new Map<string, WorkerHeartbeatInfo>();
    for (const w of workers || []) {
      const hb: WorkerHeartbeatInfo = {
        agentStatus: w.agentStatus,
        runningTaskCount: w.runningTaskCount,
        lastRunAt: w.lastRunAt,
        lastFinishAt: w.lastFinishAt,
      };
      if (w.name) hbByName.set(w.name, hb);
      if (w.matrixUserID) hbByMxid.set(w.matrixUserID, hb);
    }
    for (const team of workerTree || []) {
      for (const w of team.workers || []) {
        if (!w.worker_name) continue;
        const hb =
          hbByName.get(w.worker_name) ??
          (w.mxid ? hbByMxid.get(w.mxid) : undefined);
        const st = workerSessionState(w.mxid, rs, hb);
        byName[w.worker_name] = st;
        if (w.mxid) byMxid[w.mxid] = st;
        if (w.room_id) byRoom[w.room_id] = st;
      }
    }
    return { byName, byRoom, byMxid, workerMxids: collectWorkerMxids(workerTree) };
  }, [rooms, workerTree, workers, tick]);
}
