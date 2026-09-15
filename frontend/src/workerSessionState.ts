// v0.5.0-beta.12.4（A17）：Worker session 运行指示——纯前端派生，零后端改动。
//
// 数据源（既有 /sync 载荷，全部已下发）：
//   TeamRoom.typing   —— m.typing 事件（worker 处理消息时发送，25s 续期，
//                        硬上限 2min 后置 False——长任务 >2min 会掉出 typing，
//                        已知限制，UI 只表达「近 2 分钟内有活跃处理」）
//   TeamRoom.last_ts  —— 房间最后一条消息时间戳（/sync timeline limit=1）
//   TeamRoom.members  —— 房间成员 MXID 表
//
// 状态机（9/14 设计定稿，罗总色板：蓝=运行中（呼吸）/绿=运行完成/灰=无任务）：
//   running = 该 Worker 的 MXID 在房间 typing[] 内
//   done    = 非 running 且最近 10 分钟有活动（last_ts 距今 ≤ DONE_WINDOW_MS）
//   idle    = 其余
//
// done 语义边界（1:1 房间）：last_ts 不区分发送方——用户刚发出任务、
// Worker 尚未开始 typing 的短窗口内可能短暂显绿。Worker 端「收到即
// 立即 typing」（matrix_channel 实锤），窗口极短，接受。
// 团队房间无 per-user last-sender 数据（零后端约束）→ 团队房间只表达
// running（Worker 正在打字），不显 done/idle（避免人类消息误触绿）。

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

/** Per-Worker 三态：按 Worker MXID 跨全部房间派生。 */
export function workerSessionState(
  mxid: string | undefined,
  rooms: readonly SessionRoomLike[],
  now: number = Date.now(),
): WorkerSessionState {
  if (!mxid) return "idle";
  for (const r of rooms)
    if ((r.typing || []).includes(mxid)) return "running";
  for (const r of rooms)
    if (
      r.last_ts &&
      now - r.last_ts <= DONE_WINDOW_MS &&
      r.members &&
      mxid in r.members
    )
      return "done";
  return "idle";
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
  /** 全部 Worker MXID（团队房间 running 判定用）。 */
  workerMxids: Set<string>;
}

/**
 * 统一派生 hook：三落点共用一份状态（卡片列表 / Worker 行 / 房间头）。
 * 60s tick 驱动 done→idle 老化。纯派生，无网络请求。
 *
 * React 惰性取宿主（window.QwenPaw.host.React）——与 useAvatar.ts 同款，
 * 但放在 hook 体内而非模块顶层，保持纯函数部分可在 node 下直接验证。
 */
export function useWorkerSessionStates(
  rooms: TeamRoom[] | undefined,
  workerTree: WorkerTreeTeam[] | undefined,
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
    for (const team of workerTree || []) {
      for (const w of team.workers || []) {
        if (!w.worker_name) continue;
        const st = workerSessionState(w.mxid, rs);
        byName[w.worker_name] = st;
        if (w.room_id) byRoom[w.room_id] = st;
      }
    }
    return { byName, byRoom, workerMxids: collectWorkerMxids(workerTree) };
  }, [rooms, workerTree, tick]);
}
