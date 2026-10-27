// 「搜索跳转定位区」上下文片段的折叠窗纯逻辑（无宿主依赖，node 可直测——
// RoomChat.tsx 只做 React 接线；这里的切片语义确定性、可独立冒烟）。
//
// 折叠窗动机：「加载原消息」→ 目标不在已加载窗口 → /context 前后文片段
// 条数无上界，定位区直接铺满整个聊天区（霸屏），把正常消息列表挤出屏幕。
// 默认只渲染目标 ±pad 条（容器另限高 40vh 自滚），其余由「展开全部上下文」
// 切换放出；展开态恒为全量（含 hiddenCount=0 供 UI 判定按钮显隐）。

/** 最小消息形状（结构子集；泛型 T 保留调用方具体类型）。 */
interface JumpContextMsg {
  event_id: string;
}

/** 上下文片段窗口：expanded 真 → 全量；否则目标 ±pad（两端 clamp 到边界）。
 * 目标缺失（/context 未带回目标 event 时）→ 取前 2*pad+1 条，
 * 窗口大小恒有界、不退化成全量。 */
export function applyContextWindow<T extends JumpContextMsg>(
  events: T[],
  highlightId: string,
  expanded: boolean,
  pad = 2,
): { events: T[]; hiddenCount: number } {
  if (expanded || events.length <= pad * 2 + 1) {
    return { events, hiddenCount: 0 };
  }
  const idx = events.findIndex((m) => m.event_id === highlightId);
  if (idx < 0) {
    const visible = events.slice(0, pad * 2 + 1);
    return { events: visible, hiddenCount: events.length - visible.length };
  }
  const start = Math.max(0, idx - pad);
  const end = Math.min(events.length, idx + pad + 1);
  const visible = events.slice(start, end);
  return { events: visible, hiddenCount: events.length - visible.length };
}
