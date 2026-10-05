// v0.5.0-beta.13.8（13.7 装验「状态灯显示不准确，看整个信息源是不是正确
// session 状态」）：Worker session 级状态轮询——状态灯正源升级。
//
// 背景（实盘证据链）：
//   - 验证实盘 v1.2.4 GET /workers **无心跳字段**（agentStatus/runningTaskCount/
//     lastFinishAt 均为空，controller ≥#1247 才有）→ 旧灯源 = typing +
//     per-sender 消息启发式：任务执行中但 Worker 未发言时灯恒灰（应蓝）。
//   - qwenpaw ChatSpec.status 源码实锤（app/chats/models.py:136）=
//     "Conversation status: idle or running"——app 在 agent 启动/结束时
//     自己维护，是 per-session 的**正确 session 状态**。
//   - GET /workers/{name}/chats（上游 #1295 端点族，v1.2.4 已带）单次返回
//     该 Worker 全部 session（含 status/updated_at）→ 一个请求聚合出
//     per-Worker 状态，无需逐 session 查 /loops/status。
//
// 状态机位置（workerSessionState.ts 合并）：
//   running：心跳（若有）> **chat.running（本文件）** > typing
//   done   ：心跳 lastFinishAt > per-sender 最后发言（≤10min 衰减）
//   —— chat.updated_at **不**用于 done（user 消息也刷新它 → 假绿）。
//
// 轮询策略：30s tick；仅 document 可见时发（后台零负载）；
// 失败静默保旧值（不闪灰、不报错——数据面降级回消息级启发式）。
// v0.5.0-beta.14.9（UIPERF-T9）：旧「逐 worker /chats 扇出（并发 4，~25 路，
// 尾延迟 6-9s，每个浏览器窗口各打一份）」退役——改单端点 /workers-status
// （后端连接器侧 30s 后台单点扫描 + 聚合缓存，多窗口共享），每 tick 仅 1 请求。

import { fetchWorkerChats, fetchWorkersStatus } from "./api";
import { usePoller } from "./usePoller";

/** Per-Worker session 状态聚合（/chats 全量 session 归约）。 */
export interface WorkerChatStatusAgg {
  /** 任一 session status === "running"（qwenpaw app 自维护）。 */
  running: boolean;
  /** 最新 session updated_at（epoch ms；0 = 无/不可解析）。 */
  lastUpdated: number;
}

/** 单 Worker 的 /chats → 聚合。502/404/网络错误 → null（调用方保旧值）。 */
export async function fetchWorkerChatStatusAgg(
  name: string,
): Promise<WorkerChatStatusAgg | null> {
  let chats;
  try {
    chats = await fetchWorkerChats(name);
  } catch {
    return null;
  }
  if (!Array.isArray(chats)) return null;
  let running = false;
  let lastUpdated = 0;
  for (const c of chats) {
    if (c && typeof c === "object") {
      if (c.status === "running") running = true;
      const ts = c.updated_at ? Date.parse(c.updated_at) : NaN;
      if (Number.isFinite(ts) && ts > lastUpdated) lastUpdated = ts;
    }
  }
  return { running, lastUpdated };
}

const POLL_MS = 30_000;

// v0.5.0-beta.14.9（UIPERF-T9）退役说明：旧 pollAll 逐 worker 扇出
// （并发 4，~25 路，尾延迟 6-9s，每窗口各打一份）已替换为单端点
// /workers-status（后端后台单点扫描 + 聚合缓存）。fetchWorkerChatStatusAgg
// 保留（export 契约不变，供其他调用方）。

/**
 * 轮询 hook：names（worker 名集合，随团队树变化）→ name → 聚合状态。
 * 仅 document 可见时轮询；卸载停表。React 惰性取宿主。
 * v0.5.0-beta.14.6（R2）：旧定时器 → usePoller（30s；!document.hidden
 * 内置；隐藏恢复后的补跑走 poller catch-up 语义=闲置>2×间隔立即补）。
 * out 累积表移入 ref（跨 fn 重建存活）；namesKey 变化清表（旧 effect 重建
 * = 新表同款语义）；enabled 假→真由 usePoller 的 poke 覆盖立即拉。
 */
export function useWorkerChatStatuses(
  names: readonly string[],
  enabled: boolean,
): Record<string, WorkerChatStatusAgg> {
  const React = window.QwenPaw.host.React;
  const [statuses, setStatuses] = React.useState<
    Record<string, WorkerChatStatusAgg>
  >({});
  const namesKey = names.join("\u0000");
  // 累积表（跨 fn 重建存活；namesKey 变化时清空）。
  const outRef = React.useRef<Record<string, WorkerChatStatusAgg>>({});
  // enabled 快照（即时拉 effect 里读最新值，避免进 deps 与 poke 双发）。
  const enabledRef = React.useRef(enabled);
  enabledRef.current = enabled;

  // namesKey 变化 → 清旧表（worker 集合变了，旧聚合作废）。
  React.useEffect(() => {
    outRef.current = {};
  }, [namesKey]);

  // v0.5.0-beta.14.9（UIPERF-T9）：单端点拉取——每 tick 仅 1 个
  // /workers-status 请求（后端聚合表已含逐 worker 保旧值，映射为同旧形状
  // 合并进累积表）；请求失败/形状不符 → 保留旧值（不闪灯、不报错——与旧
  // 语义一致）。
  const run = React.useCallback(async () => {
    // 仅 document 可见时发（后台零负载；poller 亦内置 !document.hidden）。
    if (document.visibilityState !== "visible") return;
    let res: Awaited<ReturnType<typeof fetchWorkersStatus>> | null = null;
    try {
      res = await fetchWorkersStatus();
    } catch {
      return; // 失败保旧值（不闪灯、不报错——与旧语义一致）。
    }
    if (!res || !res.workers || typeof res.workers !== "object") return; // 形状不符保旧值
    let changed = false;
    for (const [name, agg] of Object.entries(res.workers)) {
      if (agg && typeof agg === "object") {
        outRef.current[name] = {
          running: Boolean(agg.running),
          lastUpdated:
            typeof agg.lastUpdated === "number" &&
            Number.isFinite(agg.lastUpdated)
              ? agg.lastUpdated
              : 0,
        };
        changed = true;
      }
    }
    if (changed) setStatuses({ ...outRef.current });
  }, [namesKey]);

  // 首拉 / namesKey 变化后重拉（enabled 门走 ref，刻意不进 deps——
  // 假→真切换由 usePoller 的 poke 覆盖，避免同刻双发）。
  React.useEffect(() => {
    if (enabledRef.current) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  usePoller({ fn: run, intervalMs: POLL_MS, active: enabled });

  return statuses;
}
