// 通知收件箱域（/console/inbox/*、/notify、/room-mentions）：事件流 + 宿主通知推送 + 房间 @ 提及。

import { requestJson } from "../shared";

// ── 宿主通知收件箱（通知中心）：/console/inbox 事件流 ─────
// 与 OS 通知/MenuBar 铃铛同一事件源（useOsNotifyPoller 同款端点）。

export interface InboxEvent {
  id: string;
  agent_id: string;
  source_type: string;
  source_id: string;
  event_type: string;
  status: string;
  severity: string;
  title: string;
  body: string;
  payload?: Record<string, unknown>;
  read: boolean;
  created_at: number;
}

interface InboxPage {
  events: InboxEvent[];
  total?: number;
  unread_count?: number;
}

export async function fetchInboxEvents(params: {
  limit?: number;
  offset?: number;
  unread_only?: boolean;
} = {}): Promise<InboxPage> {
  const query = new URLSearchParams();
  if (params.limit) query.set("limit", String(params.limit));
  if (params.offset) query.set("offset", String(params.offset));
  if (params.unread_only) query.set("unread_only", "true");
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return (await requestJson(`/console/inbox/events${suffix}`)) as InboxPage;
}

export async function markInboxRead(payload: {
  event_ids?: string[];
  all?: boolean;
}): Promise<{ updated: number }> {
  return (await requestJson("/console/inbox/read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })) as { updated: number };
}

export async function deleteInboxEvent(eventId: string): Promise<unknown> {
  return requestJson(`/console/inbox/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
  });
}

/** 【预埋，勿删·预埋清单 P1】插件通知 → 宿主收件箱（后端
 * inbox_store.append_event 内部通道）。曾为 @提到我活链路；
 * sync_watcher 接管 @mention 事件流后本函数待命——保留为 UI 主动推送通知
 * 的通用入口（产物完成通知等未来触发点，方案 v5.29「产物通知待评估」）。
 * os_notify=true 映射 OS 通知白名单 source_type → 桌面 toast + 铃铛。
 * 死码审计豁免：见 PREEMBED-EXEMPT.md。 */
export async function sendInboxNotify(opts: {
  title: string;
  body?: string;
  severity?: string;
  source_type?: string;
  os_notify?: boolean;
}): Promise<{ ok: boolean; event_id: string }> {
  try {
    return (await requestJson("/agentteams-proxy/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    })) as { ok: boolean; event_id: string };
  } catch {
    // 宿主收件箱不可用（非 QwenPaw 宿主/旧版）→ 静默降级，不影响功能。
    return { ok: false, event_id: "" };
  }
}

// ── 房间通知（通知中心 → 跳房间+定位消息）────────────────

export interface RoomMention {
  room_id: string;
  room_name: string;
  event_id: string;
  sender: string;
  body: string;
  ts: number;
}

/** 各房间最近 @提到我 的消息（后端扫 joined rooms 近期 timeline）。 */
export async function fetchRoomMentions(limit = 30): Promise<RoomMention[]> {
  const raw = (await requestJson(
    `/agentteams-proxy/room-mentions?limit=${limit}`,
  )) as Record<string, unknown>;
  return (Array.isArray(raw.mentions) ? raw.mentions : []) as RoomMention[];
}
