// 消息线程分组 + 渲染窗封顶的纯逻辑（无宿主依赖，node 可直测——
// RoomChat.tsx 只做 React 接线；这里的分组/窗口语义确定性、可独立冒烟）。
//
// 窗口封顶动机：长房间/长滚动会话的 DOM 与重渲成本随消息总数无上界
// 增长（每次组件重渲 tops.map 全量重建行 JSX）。封顶后只渲染最近
// windowLimit 条顶层消息，更早的由「显示更早」入口/驻顶接力逐步揭示
// （本地放出，无网络往返；与历史分页「从服务端拉」独立）。

/** 最小消息形状（结构子集；泛型 T 保留调用方具体类型）。 */
export interface ThreadMsg {
  event_id: string;
  reply?: { event_id?: string } | null;
}

/** 线程分组（Element/Discord 式）：回复消息归入被回复消息的线程，
 * 不再顶层重复显示。O(n)：先建 id Set 再单次遍历归属
 * （target 在已载窗口内即归线程，否则降级顶层）。 */
export function groupThreads<T extends ThreadMsg>(
  messages: T[],
): { tops: T[]; repliesOf: Map<string, T[]> } {
  const tops: T[] = [];
  const repliesOf = new Map<string, T[]>();
  const idSet = new Set(messages.map((m) => m.event_id));
  for (const m of messages) {
    const targetId = m.reply?.event_id || "";
    if (targetId && idSet.has(targetId)) {
      const arr = repliesOf.get(targetId);
      if (arr) arr.push(m);
      else repliesOf.set(targetId, [m]);
    } else {
      tops.push(m);
    }
  }
  return { tops, repliesOf };
}

/** 窗口封顶：只保留最近 windowLimit 条顶层消息，返回被藏起数。
 * pendingOriginal 真时旁路（「加载原消息」定位要求目标消息必在 DOM）。
 * 目标消息被藏起窗口的回复降级为顶层、置于渲染窗首——与被回复方
 * 「不在已载窗口」时的既有降级行为一致，消息序保持连续。
 * 注意：会就地删除 repliesOf 中被藏起顶层的条目（调用方每次传
 * groupThreads 的新鲜结果，无共享）。 */
export function applyWindow<T extends ThreadMsg>(
  tops: T[],
  repliesOf: Map<string, T[]>,
  windowLimit: number,
  pendingOriginal?: string | null,
): { tops: T[]; hiddenCount: number; repliesOf: Map<string, T[]> } {
  if (pendingOriginal || tops.length <= windowLimit) {
    return { tops, hiddenCount: 0, repliesOf };
  }
  const hiddenCount = tops.length - windowLimit;
  const rendered = tops.slice(hiddenCount);
  const orphaned: T[] = [];
  for (const t of tops.slice(0, hiddenCount)) {
    const rs = repliesOf.get(t.event_id);
    if (rs) {
      orphaned.push(...rs);
      repliesOf.delete(t.event_id);
    }
  }
  return {
    tops: orphaned.length > 0 ? [...orphaned, ...rendered] : rendered,
    hiddenCount,
    repliesOf,
  };
}
