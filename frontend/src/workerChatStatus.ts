// （13.7 「状态灯显示不准确，看整个信息源是不是正确
// session 状态」）：Worker session 级状态轮询——状态灯正源升级。
//
// 背景（实盘证据链）：
// - 验证实盘 v1.2.4 GET /workers **无心跳字段**（agentStatus/runningTaskCount/
// lastFinishAt 均为空，controller ≥#1247 才有）→ 旧灯源 = typing +
// per-sender 消息启发式：任务执行中但 Worker 未发言时灯恒灰（应蓝）。
// - qwenpaw ChatSpec.status 源码实锤（app/chats/models.py:136）=
// "Conversation status: idle or running"——app 在 agent 启动/结束时
// 自己维护，是 per-session 的**正确 session 状态**。
// - GET /workers/{name}/chats（上游 #1295 端点族，v1.2.4 已带）单次返回
// 该 Worker 全部 session（含 status/updated_at）→ 一个请求聚合出
// per-Worker 状态，无需逐 session 查 /loops/status。
//
// 状态机位置（workerSessionState.ts 合并）：
// running：心跳（若有）> **chat.running（本文件）** > typing
// done ：心跳 lastFinishAt > per-sender 最后发言（≤10min 衰减）
// —— chat.updated_at **不**用于 done（user 消息也刷新它 → 假绿）。
//
// 轮询策略：30s tick；仅 document 可见时发（后台零负载）；
// 失败静默保旧值（不闪灰、不报错——数据面降级回消息级启发式）。
// 旧「逐 worker /chats 扇出（并发 4，~25 路，
// 尾延迟 6-9s，每个浏览器窗口各打一份）」退役——改单端点 /workers-status
// （后端连接器侧 30s 后台单点扫描 + 聚合缓存，多窗口共享），每 tick 仅 1 请求。

import { fetchWorkersStatus } from "./api";
import { useCachedPolling } from "./hooks/useCachedPolling";

/** Per-Worker session 状态聚合（chats 全量 session 归约）。 */
interface WorkerChatStatusAgg {
  /** 任一 session status === "running"（qwenpaw app 自维护）。 */
  running: boolean;
  /** 最新 session updated_at（epoch ms；0 = 无/不可解析）。 */
  lastUpdated: number;
}

const POLL_MS = 30_000;

// 退役说明：旧 pollAll 逐 worker 扇出
// （并发 4，~25 路，尾延迟 6-9s，每窗口各打一份）已替换为单端点
// /workers-status（后端后台单点扫描 + 聚合缓存）。逐 worker 的
// fetchWorkerChatStatusAgg 已随之删除（无调用方）。

/**
 * 轮询 hook：names（worker 名集合，随团队树变化）→ name → 聚合状态。
 * 批次 4 改造：useCachedPolling（快照 diff 门控——后端聚合表保旧值，
 * 静集群一拍数据几乎不变 → 不变则不重渲；gateOnVisibility 仅 document
 * 可见时发；resetKey=namesKey worker 集合变化 → 清表 + 重拉；
 * active 假→真由 usePoller poke 覆盖，与旧语义一致）。
 * 行为差（诚实标注）：某 worker 从 /workers-status 响应中消失时
 * 立即从状态表消失（旧版留陈旧聚合值至 namesKey 变化）。
 */
export function useWorkerChatStatuses(
  names: readonly string[],
  enabled: boolean,
): Record<string, WorkerChatStatusAgg> {
  const namesKey = names.join("\u0000");

  // 单端点拉取——每 tick 仅 1 个 /workers-status 请求（后端聚合表已含
  // 逐 worker 保旧值）。失败/形状不符 → null → 保留旧值（不闪灯、
  // 不报错——与旧语义一致）。
  const fetchAgg = async (): Promise<
    Record<string, WorkerChatStatusAgg> | null
  > => {
    let res: Awaited<ReturnType<typeof fetchWorkersStatus>> | null = null;
    try {
      res = await fetchWorkersStatus();
    } catch {
      return null; // 失败保旧值（不闪灯、不报错——与旧语义一致）。
    }
    if (!res || !res.workers || typeof res.workers !== "object") return null; // 形状不符保旧值
    const out: Record<string, WorkerChatStatusAgg> = {};
    for (const [name, agg] of Object.entries(res.workers)) {
      if (agg && typeof agg === "object") {
        out[name] = {
          running: Boolean(agg.running),
          lastUpdated:
            typeof agg.lastUpdated === "number" &&
            Number.isFinite(agg.lastUpdated)
              ? agg.lastUpdated
              : 0,
        };
      }
    }
    return out;
  };

  const { data } = useCachedPolling<Record<string, WorkerChatStatusAgg>>({
    fetcher: fetchAgg,
    intervalMs: POLL_MS,
    active: enabled,
    gateOnVisibility: true,
    resetKey: namesKey,
    initialData: {},
  });

  return data;
}
