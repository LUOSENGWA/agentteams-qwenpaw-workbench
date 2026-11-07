// 「加载原消息」定位决策（纯逻辑，node/vitest 可直测）——
// 取代「串行翻 20 页」作为首选路径：
//   ① 目标已在窗口 → 就地定位（零网络）；
//   ② 本地缓存命中（chatCache.getWindow）→ 目标 ±N 注入时间线（零网络）；
//   ③ 未命中 → GET /rooms/{id}/context/{eventId} 拉目标前后文 → 注入时间线；
//   ④ /context 不可用（404/501/网络错/空载荷）→ 回退既有显式分页循环
//      （originalJump.nextBackfillAction，上限 ORIGINAL_PAGE_CAP）。
// 结果语义沿用 R2：found | exhausted | cancelled；source 说明命中路径
// （测试与排障用，UI 不依赖）。
import type { RoomMessage } from "../api";

export type OriginalLocateOutcome = "found" | "exhausted" | "cancelled";
export type OriginalLocateSource = "window" | "cache" | "context" | "pagination";

export interface OriginalLocateDeps {
  /** 当前已加载窗口（升序）。 */
  window: readonly RoomMessage[];
  eventId: string;
  /** 切房/换目标/看门狗 → 立即作废（每个 await 之后都要复查）。 */
  cancelled: () => boolean;
  /** 本地缓存：缓存未命中返回 null。 */
  readCache: () => Promise<RoomMessage[] | null>;
  /** /context：不可用（404/501/空）→ null / 抛错。 */
  readContext: () => Promise<RoomMessage[] | null>;
  /** 分页回退（既有显式循环；自行处理取消）。 */
  paginate: () => Promise<OriginalLocateOutcome>;
}

export interface OriginalLocateResult {
  outcome: OriginalLocateOutcome;
  source: OriginalLocateSource;
  /** 需注入时间线的消息（cache/context 命中；window/pagination 为空）。 */
  inject: RoomMessage[];
}

export async function locateOriginalMessage(
  deps: OriginalLocateDeps,
): Promise<OriginalLocateResult> {
  if (deps.cancelled()) {
    return { outcome: "cancelled", source: "window", inject: [] };
  }
  if (deps.window.some((m) => m.event_id === deps.eventId)) {
    return { outcome: "found", source: "window", inject: [] };
  }

  const cached = await deps.readCache().catch(() => null);
  if (deps.cancelled()) {
    return { outcome: "cancelled", source: "cache", inject: [] };
  }
  if (cached && cached.some((m) => m.event_id === deps.eventId)) {
    return { outcome: "found", source: "cache", inject: cached };
  }

  const ctx = await deps.readContext().catch(() => null);
  if (deps.cancelled()) {
    return { outcome: "cancelled", source: "context", inject: [] };
  }
  if (ctx && ctx.some((m) => m.event_id === deps.eventId)) {
    return { outcome: "found", source: "context", inject: ctx };
  }

  const outcome = await deps.paginate();
  return { outcome, source: "pagination", inject: [] };
}
