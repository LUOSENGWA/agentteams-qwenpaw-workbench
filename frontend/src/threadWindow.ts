// 消息线程分组 + 渲染窗封顶的纯逻辑（无宿主依赖，node 可直测——
// RoomChat.tsx 只做 React 接线；这里的分组/窗口语义确定性、可独立冒烟）。
//
// 窗口封顶动机：长房间/长滚动会话的 DOM 与重渲成本随消息总数无上界
// 增长（每次组件重渲 tops.map 全量重建行 JSX）。封顶后只渲染最近
// windowLimit 条顶层消息，更早的由「显示更早」入口/驻顶接力逐步揭示
// （本地放出，无网络往返；与历史分页「从服务端拉」独立）。

/** 最小消息形状（结构子集；泛型 T 保留调用方具体类型）。 */
interface ThreadMsg {
  event_id: string;
  reply?: { event_id?: string } | null;
  /** 线程根（m.thread）——分组目标优先于 reply（§4.1 读模型）。 */
  threadRoot?: string;
  /** 发送者（worker-run 判定需要；结构子集可选）。 */
  sender?: string;
  /** 发送时间（worker-run 内联块排序 fallback）。 */
  origin_server_ts?: number;
  /** 编辑时间（最终编辑根排序口径）。 */
  editedAt?: number;
}

/** 线程分组（Element/Discord 式）：回复消息归入被回复消息的线程，
 * 不再顶层重复显示。O(n)：先建 id Set 再单次遍历归属
 * （target 在已载窗口内即归线程，否则降级顶层）。
 * 分组目标 = threadRoot（m.thread，Agent 线程协议）?? reply.event_id
 * （m.in_reply_to，用户引用回复）——两协议各自成线，互不干扰。 */
export function groupThreads<T extends ThreadMsg>(
  messages: T[],
): { tops: T[]; repliesOf: Map<string, T[]> } {
  const tops: T[] = [];
  const repliesOf = new Map<string, T[]>();
  const idSet = new Set(messages.map((m) => m.event_id));
  for (const m of messages) {
    const targetId = m.threadRoot || m.reply?.event_id || "";
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

/** worker-run 内联折叠（§4.2）：纯 worker 线程（root 发送者是 worker
 * 且全部回复发送者都是 worker）=「一次运行」——root + 全部回复逐条
 * 内联进 tops（每条按自身 editedAt ?? origin_server_ts 落位，Dashboard
 * 连续 turn 语义：run 中途的人类消息原位保留；最终编辑过的根后移到
 * 修订时刻，作为独立 turn 渲染在过程之后），不再保留在 repliesOf
 * （不进话题列表）；根上的 ThreadIcon 摘要与线程面板读取
 * 由渲染层按 threadRoot 反查承载，不依赖 repliesOf。
 * 人类线程 / 混合线程（有人类回复）原样保留（root 顶层 + 回复在线程
 * 分组）——一旦有人参与，整条线程按人类话题处理，不内联。
 * 纯函数：不修改入参；repliesOf 重建（人类线程键原样保留）。
 * 调用序：groupThreads → applyWindow → inlineWorkerRuns（窗口先于内联——
 * 被藏起 root 的孤儿回复已在 applyWindow 降级置顶，保持既有行为）。 */
export function inlineWorkerRuns<T extends ThreadMsg>(
  tops: T[],
  repliesOf: Map<string, T[]>,
  isWorker: (mxid: string) => boolean,
): { tops: T[]; repliesOf: Map<string, T[]> } {
  const tsOf = (m: T): number => m.origin_server_ts ?? 0;
  // 排序/锚定键：最终编辑过的消息按修订时间（editedAt）——Dashboard
  // revision collapse（agent ts = max(root, edit)）；未编辑 = 发送时间。
  // 人类编辑保持原位的口径由调用方 isWorker 门控体现（本函数只重排
  // 纯 worker run 的消息；人类消息 key=origin_server_ts，tops 已按它
  // 有序，稳定排序下原位不动）。
  const keyOf = (m: T): number => m.editedAt ?? m.origin_server_ts ?? 0;
  // 渲染单元：普通顶层=自身（键=发送时间）；纯 worker run 的 root 与
  // 每条回复各自成单元（键=该条的修订键）——逐条落位后同发送者的
  // 过程消息仍连续成 turn（Dashboard AgentTurnGrouper 语义），且
  // run 中途的人类消息原位保留，最终编辑过的根单独后移到修订时刻。
  const units: { key: number; items: T[] }[] = [];
  const repliesOut = new Map<string, T[]>();
  // 已消费键（tops 对应的线程键）：run 键被有意删除（内联），
  // 兜底透传不得恢复它。
  const consumed = new Set<string>();
  for (const m of tops) {
    const rs = repliesOf.get(m.event_id);
    if (rs) consumed.add(m.event_id);
    const pureWorkerRun =
      !!rs &&
      rs.length > 0 &&
      !!m.sender &&
      isWorker(m.sender) &&
      rs.every((r) => !!r.sender && isWorker(r.sender));
    if (pureWorkerRun) {
      // 逐条成单元：[root, ...replies] 原序，各按自身修订键参与稳定
      // 合并（同键保持原相对序；未编辑时键=发送时间，原位不动）。
      for (const item of [m, ...rs]) {
        units.push({ key: keyOf(item), items: [item] });
      }
    } else {
      units.push({ key: tsOf(m), items: [m] });
      if (rs) repliesOut.set(m.event_id, rs);
    }
  }
  // 稳定合并：单元按锚定键落位（同键保持原相对序）——未编辑消息键=
  // 发送时间且 tops 已按发送时间有序 → 原位不动；只有编辑过的
  // 纯 worker run 消息会各自后移到修订时刻。
  const out: T[] = [];
  units
    .map((u, i) => ({ u, i }))
    .sort((a, b) => a.u.key - b.u.key || a.i - b.i)
    .forEach(({ u }) => out.push(...u.items));
  // 兜底透传：不对应任何被扫描 tops 的线程键（防御；如嵌套线程——
  // target 本身也是回复）。run 键已消费（有意删除）→ 不透传恢复。
  for (const [k, v] of repliesOf) {
    if (!consumed.has(k)) repliesOut.set(k, v);
  }
  return { tops: out, repliesOf: repliesOut };
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
