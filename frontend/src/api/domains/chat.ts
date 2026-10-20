// 聊天/Matrix 域（/matrix/*、/artifacts）：房间消息取数与聚合、发送/编辑/撤回、搜索、已读、房间权限与静音。

import { requestJson } from "../shared";
import { cachedRequest, invalidateTags } from "../../requestCache";
import { FILE_REFS_CONTENT_KEY, parseFileRefs } from "../../lib/file-refs";
import type { FileRef } from "../../lib/file-refs";

export interface RoomMessage {
  event_id: string;
  sender: string;
  body: string;
  msgtype: string;
  origin_server_ts: number;
  url?: string;
  info?: unknown;
  mimetype?: string;
  filename?: string;
  /** m.file/m.image 字节数（content.info.size）——文件卡
 * 尺寸显示 + FilePreview 大小守卫（此前映射漏带 info，尺寸恒空）。 */
  size?: number;
  /** 乐观回显标记：本地插入尚未被服务器确认。 */
  pending?: boolean;
  /** 发送失败标记：pending 消息发送失败后置位，可重试。 */
  failed?: boolean;
  /** 被 m.replace 编辑过（Element 同款「已编辑」标记）。 */
  edited?: boolean;
  /** 被撤回（redaction，unsigned.redacted_because）。 */
  redacted?: boolean;
  /** 引用回复（m.in_reply_to）：被回复消息的 event_id 与 fallback 摘要。 */
  reply?: {
    event_id: string;
    /** "> <@sender> 原文" fallback 格式，解析后的发送者+摘要。 */
    sender?: string;
    body?: string;
  };
  /** 表情反应聚合（m.reaction m.annotation）：emoji → 计数。 */
  reactions?: Record<string, number>;
  /** 聊天内 workflow 卡片载荷（content.agentteams.workflow 自定义字段，
 * ；结构与 sync_watcher _track_workflow 消费同一事件）。 */
  workflow?: WorkflowCardPayload | null;
  /** 团队共享文件引用（#87，content.com.agentteams.file_refs）——
 * 收信侧渲染文件 chip，点击经 team-file 端点预览。 */
  file_refs?: FileRef[];
}

// ── 聊天内 workflow 卡片──────────────────────────────
// 事件解析与 dashboard 联合交叉验证基准：SC/agentteams-dashboard
// src/lib/a2ui/normalize.ts 规则 1（content['agentteams.workflow'] 键
// 命中 → workflow block，isWorkflowPayload = 非空对象）+ src/lib/
// a2ui/workflow.ts WorkflowPayload。字段名与 sync_watcher.py
// _track_workflow 一致（runId/run_id、title/name、status、steps[]）。

export interface WorkflowCardItem {
  id?: string;
  name?: string;
  title?: string;
  status?: string;
  [key: string]: unknown;
}

export interface WorkflowCardPayload {
  title?: string;
  name?: string;
  status?: string;
  runId?: string;
  run_id?: string;
  subagents?: WorkflowCardItem[];
  steps?: WorkflowCardItem[];
  [key: string]: unknown;
}

/** dashboard isWorkflowPayload 同款校验（规则 1 判定标准）。 */
export function isWorkflowPayload(value: unknown): value is WorkflowCardPayload {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

/** mxc://server/mediaId → 后端媒体代理 URL（auth-free 下载）。 */
export function mxcToMediaUrl(mxc: string): string {
  const match = /^mxc:\/\/([^/]+)\/(.+)$/.exec(mxc || "");
  if (!match) return "";
  return `/agentteams-proxy/media/${match[1]}/${encodeURIComponent(match[2])}`;
}

/**
 * 文件事件 url 统一解析（——「md 预览出 QwenPaw Console HTML」根治）：
 * mxc:// → 后端媒体代理；http(s):// → 直链原样（Worker 可能发非 mxc 链接）；
 * 其他 → ""。⚠️ 调用方必须处理 ""：fetch("") = 取当前页面自身（SPA 壳），
 * 此前的缺陷正是 mxcToMediaUrl 对非 mxc url 回 "" → fetch("") → 控制台 HTML。
 */
export function resolveFileUrl(raw: string | null | undefined): string {
  return resolveFileTarget(raw).url;
}

/**
 * 裸插件 API 路径 → 真实可请求 URL（宿主 getApiUrl 解析）。
 * 宿主把插件路由挂在 /api + prefix 下（plugin.py register_http_router）；
 * 浏览器直接请求裸 /agentteams-proxy/... 会落进 SPA 兜底返回 index.html
 *（HTML 壳，历史真机缺陷：某 md 文件预览「内容是网页」）。
 * 所有「浏览器直连」文件地址（fetch / img src / a href）必须经本函数
 * 或 host.fetch（见 fetchFile / downloadViaHost）。
 */
export function resolvePluginUrl(path: string): string {
  try {
    const host = window.QwenPaw?.host;
    if (host && typeof host.getApiUrl === "function") {
      return host.getApiUrl(path);
    }
  } catch {
    /* 无宿主环境（dev）→ 保持裸路径 */
  }
  return path;
}

/**
 * 带鉴权的文件 fetch。插件路径（apiPath）走 host.fetch
 *（自动注入 Authorization / X-Agent-Id）；http 直链或无宿主时裸 fetch。
 * 返回 Response，语义与 fetch 一致。
 */
export async function fetchFile(
  apiPath: string | null | undefined,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  try {
    if (apiPath) {
      const host = window.QwenPaw?.host;
      if (host && typeof host.fetch === "function") {
        return await host.fetch(apiPath, init);
      }
    }
  } catch {
    /* fall through to bare fetch */
  }
  return fetch(url, init);
}

/**
 * 文件地址统一解析——mxc → 插件媒体代理（apiPath + 解析后 URL）、
 * http(s) → 原样直链、其他 → ""。调用方必须处理 url=""（空地址守卫）。
 * apiPath = 裸插件路径，与 fetchFile / downloadViaHost 配套使用。
 */
export function resolveFileTarget(
  raw: string | null | undefined,
): { url: string; apiPath?: string; rawUrl?: string } {
  const s = String(raw || "");
  if (!s) return { url: "" };
  if (/^https?:\/\//i.test(s)) {
    // 直链常跨域（Worker 发内网 http 地址，浏览器 fetch
    // 被 CORS 拦、a[download] 跨域变导航）→ 附服务端代抓路径
    // （media/proxy?url=，后端与文件服务器同网段可达）；url 保留给
    // 「新窗口打开原链接」兜底（顶层导航不受 CORS 限制）。
    return {
      url: s,
      apiPath: `/media/proxy?url=${encodeURIComponent(s)}`,
      rawUrl: s,
    };
  }
  const path = mxcToMediaUrl(s);
  if (!path) {
    // file:// / 裸路径 / 畸形地址——不可 fetch；rawUrl 透传供预览错误态
    // 展示原值（「没有可用的文件地址」只有提示没有证据的补强）。
    return { url: "", rawUrl: s };
  }
  return { url: resolvePluginUrl(path), apiPath: path, rawUrl: s };
}

/**
 * 插件路径文件 blob 下载（host.fetch → a[download]）。
 * 裸链接 href 导航无法带鉴权头，直接开 /api/... 会 401。
 * 返回是否成功；用户提示由调用方负责。
 */
export async function downloadViaHost(
  apiPath: string,
  filename: string,
): Promise<boolean> {
  try {
    const resp = await fetchFile(apiPath, resolvePluginUrl(apiPath));
    if (!resp.ok) return false;
    const blob = await resp.blob();
    const obj = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = obj;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(obj), 5000);
    // 成功 toast
    // 显形去向——浏览器默认下载目录 + 文件名。单一落点（6 个调用方全
    // 覆盖），不逐处改。
    // （13.12 桌面版还是不知道下到哪——宿主桥只有
    // getApiUrl/getApiToken/fetch，无文件 API，web 内容无法拿实际落盘路径）：
    // Electron 桌面版单独明示——下载到操作系统默认「下载」文件夹（Windows:
    // C:\Users\<用户名>\Downloads；macOS: ~/Downloads），QwenPaw 桌面版不
    // 提供下载列表/进度条。
    try {
      const isElectron = /electron/i.test(navigator.userAgent || "");
      const where = isElectron
        ? "操作系统「下载」文件夹（桌面版不提供下载列表，如 Windows C:\\Users\\<用户名>\\Downloads）"
        : "浏览器默认下载目录";
      window.QwenPaw?.host?.antd?.message?.success?.(
        `已下载到${where}：${filename}`,
      );
    } catch {
      /* 宿主 antd 不可用时静默——下载本身已成功 */
    }
    return true;
  } catch {
    return false;
  }
}

/** 产物条目（跨房间 m.file/m.image 聚合，产物页数据源）。 */
export interface Artifact {
  event_id: string;
  room_id: string;
  room_name: string;
  sender: string;
  ts: number;
  msgtype: "m.file" | "m.image";
  url: string;
  filename: string;
  body: string;
  mimetype: string;
  size: number | null;
}

/** cachedRequest 包裹（artifacts，30s）——已有 force
 * 参数透传（force 同样参与在飞去重，完成后覆盖写缓存）。 */
export async function fetchArtifacts(force = false): Promise<Artifact[]> {
  return cachedRequest("artifacts", 30000, async () => {
    const data = (await requestJson(
      `/agentteams-proxy/artifacts${force ? "?force=true" : ""}`,
    )) as { items?: Artifact[] };
    return data.items || [];
  });
}

export interface RoomMessagesPage {
  messages: RoomMessage[];
  end: string; // Matrix /messages end token（dir=b 向上翻页用）
  start: string; // dir=f 向下翻页用
  error?: string; // "not_found" = 房间已不存在（升级清理后僵尸房间）
}

/** 消息搜索结果：后端已映射房间名 + 截断正文。 */
export interface SearchResultItem {
  room_id: string;
  room_name: string;
  event_id: string;
  sender: string;
  body: string;
  origin_server_ts: number;
}

interface SearchPage {
  ok: boolean;
  count: number;
  next_batch: string;
  results: SearchResultItem[];
}

/** Matrix /search 全文检索：房间内传 roomId，跨房间不传。 */
export async function searchMessages(
  term: string,
  opts: { roomId?: string; nextBatch?: string; limit?: number } = {},
): Promise<SearchPage> {
  const body: Record<string, unknown> = { term: term.trim() };
  if (opts.roomId) body.roomId = opts.roomId;
  if (opts.nextBatch) body.nextBatch = opts.nextBatch;
  if (opts.limit) body.limit = opts.limit;
  return (await requestJson("/agentteams-proxy/matrix/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })) as SearchPage;
}

/** 单事件上下文（context）：前后各 limit 条 + 目标事件。 */
export interface EventContextPage {
  events_before: RoomMessage[];
  event: RoomMessage | null;
  events_after: RoomMessage[];
}

/** 轻量事件映射（搜索上下文预览用，不聚合 reply/reaction）。 */
function mapContextEvent(ev: unknown): RoomMessage | null {
  if (typeof ev !== "object" || ev === null) return null;
  const e = ev as Record<string, unknown>;
  if (e.type !== "m.room.message") return null;
  const content = (e.content as Record<string, unknown>) || {};
  return {
    event_id: String(e.event_id || ""),
    sender: String(e.sender || ""),
    body: String(content.body || ""),
    msgtype: String(content.msgtype || "m.text"),
    origin_server_ts: Number(e.origin_server_ts || 0),
  };
}

/** 拉取消息上下文：点搜索结果后预览前后文 + 定位跳转。 */
export async function fetchEventContext(
  roomId: string,
  eventId: string,
  limit = 5,
): Promise<EventContextPage> {
  const params = new URLSearchParams({ limit: String(limit) });
  const payload = (await requestJson(
    `/agentteams-proxy/matrix/rooms/${encodeURIComponent(roomId)}/context/${encodeURIComponent(eventId)}?${params.toString()}`,
  )) as { events_before?: unknown[]; event?: unknown; events_after?: unknown[] };
  return {
    events_before: (payload.events_before || [])
      .map(mapContextEvent)
      .filter((m): m is RoomMessage => m !== null),
    event: mapContextEvent(payload.event),
    events_after: (payload.events_after || [])
      .map(mapContextEvent)
      .filter((m): m is RoomMessage => m !== null),
  };
}

interface MarkReadResult {
  ok: boolean;
  marked: number;
  skipped: number;
  errors: string[];
}

/** 单房间已读（m.read + m.fully_read 双写，经插件后端发 Matrix receipt）。
 * eventId 缺省时后端取房间最新消息。失败不抛（best-effort 已读）。 */
export async function markRoomRead(
  roomId: string,
  eventId?: string,
): Promise<MarkReadResult | null> {
  try {
    return (await requestJson("/agentteams-proxy/matrix/mark-read", {
      method: "POST",
      body: JSON.stringify({ room_id: roomId, event_id: eventId || "" }),
    })) as MarkReadResult;
  } catch {
    return null;
  }
}

/** 一键全部已读：逐房间双写（后端逐房间取最新消息）。 */
export async function markAllRoomsRead(
  roomIds: string[],
): Promise<MarkReadResult | null> {
  try {
    return (await requestJson("/agentteams-proxy/matrix/mark-read", {
      method: "POST",
      body: JSON.stringify({ room_ids: roomIds }),
    })) as MarkReadResult;
  } catch {
    return null;
  }
}

export async function fetchRoomMessages(
  roomId: string,
  limit = 50,
  from?: string,
): Promise<RoomMessagesPage> {
  const params = new URLSearchParams({ dir: "b", limit: String(limit) });
  if (from) params.set("from", from);
  let payload: { chunk?: unknown[]; end?: string; start?: string };
  try {
    payload = (await requestJson(
      `/agentteams-proxy/matrix/rooms/${encodeURIComponent(roomId)}/messages?${params.toString()}`,
    )) as { chunk?: unknown[]; end?: string; start?: string };
  } catch (e) {
    // 404 = 房间数据已被清理（升级后僵尸房间）——返回空页 + 标记，不报错阻塞。
    if (e instanceof Error && e.message.includes("HTTP 404")) {
      return { messages: [], end: "", start: "", error: "not_found" };
    }
    throw e;
  }
  // m.replace 编辑事件聚合（Element 同款——替换事件不独立
  // 显示，m.new_content 写回原消息 + edited 标记）。预扫一轮建映射。
  const replaceMap = new Map<
    string,
    { body: string; msgtype: string }
  >();
  const isReplaceEvent = (ev: Record<string, unknown>): boolean => {
    const c = (ev.content as Record<string, unknown>) || {};
    const rel = c["m.relates_to"] as
      | Record<string, unknown>
      | undefined;
    return !!(rel && rel.rel_type === "m.replace" && rel.event_id);
  };
  for (const raw of payload.chunk || []) {
    if (typeof raw !== "object" || raw === null) continue;
    const ev = raw as Record<string, unknown>;
    if (ev.type !== "m.room.message" || !isReplaceEvent(ev)) continue;
    const c = (ev.content as Record<string, unknown>) || {};
    const rel = (c["m.relates_to"] as Record<string, unknown>) || {};
    const nc = (c["m.new_content"] as Record<string, unknown>) || {};
    // 非标注客户端 fallback body 带 "[edit] " 前缀——聚合时剥掉。
    replaceMap.set(String(rel.event_id), {
      body: String(nc.body ?? "").replace(/^\[edit\]\s*/, ""),
      msgtype: String(nc.msgtype || "m.text"),
    });
  }
  const messages: RoomMessage[] = (payload.chunk || [])
    .filter(
      (ev): ev is Record<string, unknown> =>
        typeof ev === "object" && ev !== null,
    )
    .filter((ev) => ev.type === "m.room.message" && !isReplaceEvent(ev))
    .map((ev) => {
      const content = (ev.content as Record<string, unknown>) || {};
      const info = (content.info as Record<string, unknown>) || {};
      const eventId0 = String(ev.event_id || "");
      // 撤回（redaction）：unsigned.redacted_because 存在 = 事件被红条。
      const unsigned = (ev.unsigned as Record<string, unknown>) || {};
      const redacted = Boolean(unsigned.redacted_because);
      const editedBy = redacted ? undefined : replaceMap.get(eventId0);
      // 引用/线程回复解析：m.in_reply_to（用户引用回复）+ m.thread（Agent 线程协议，
      // agentteams-matrix-channel L3618 实锤：rel_type "m.thread" + event_id=thread root）。
      let reply: RoomMessage["reply"];
      const relates = content["m.relates_to"] as
        | Record<string, unknown>
        | undefined;
      if (
        relates &&
        (relates.rel_type === "m.in_reply_to" ||
          relates.rel_type === "m.thread")
      ) {
        const replyEventId = String(
          (relates as Record<string, unknown>).event_id ||
            ev.event_id ||
            "",
        );
        // Matrix fallback 格式：" > <@sender> 原文摘要"（m.in_reply_to 才有；
        // m.thread 无 fallback，线程摘要靠历史里的原消息渲染）。
        const fallback = String(relates["m.in_reply_to"] || "");
        const senderMatch = />\s*<(@[^>]+)>/.exec(fallback);
        let body = "";
        if (fallback) {
          body = fallback
            .split("\n")
            .filter((l) => l.startsWith(">"))
            .map((l) => l.replace(/^>\s*/, ""))
            .join("\n");
          body = body.replace(/^<@[^>]+>\s*/, "").trim();
        }
        reply = {
          event_id: replyEventId,
          sender: senderMatch ? senderMatch[1] : undefined,
          body: body || undefined,
        };
      }
      // workflow 卡片载荷透传（规则 1：content 键存在且为对象）。
      const rawWorkflow = content["agentteams.workflow"];
      // 团队共享文件引用（#87）——容错解析（信封/裸数组/畸形丢弃）。
      const refs = parseFileRefs(content[FILE_REFS_CONTENT_KEY]);
      return {
        event_id: eventId0,
        sender: String(ev.sender || ""),
        // 撤回消息正文置空（UI 渲染固定提示）；编辑消息用 m.new_content 正文。
        body: redacted ? "" : editedBy ? editedBy.body : String(content.body || ""),
        msgtype: redacted ? "m.text" : editedBy ? editedBy.msgtype : String(content.msgtype || "m.text"),
        origin_server_ts: Number(ev.origin_server_ts || 0),
        url: redacted ? undefined : (content.url as string | undefined),
        mimetype: redacted ? undefined : (info.mimetype as string | undefined),
        filename: redacted ? "" : String(content.filename || info.filename || ""),
        // info.size（字节）——文件卡尺寸显示 + 预览大小
        // 守卫（此前映射漏带，聊天文件卡尺寸恒空）。
        size:
          redacted || typeof info.size !== "number" ? undefined : info.size,
        reply: redacted ? undefined : reply,
        workflow: redacted ? null : (isWorkflowPayload(rawWorkflow) ? rawWorkflow : null),
        file_refs: redacted || refs.length === 0 ? undefined : refs,
        ...(editedBy ? { edited: true } : {}),
        ...(redacted ? { redacted: true } : {}),
      };
    });
  // m.reaction 聚合（Element 同款交互，独立实现）：m.annotation rel_type
  // 的独立事件，按 event_id 聚合 emoji → 计数附加到对应消息。
  const reactionsMap = new Map<string, Record<string, number>>();
  for (const ev of payload.chunk || []) {
    if (typeof ev !== "object" || ev === null) continue;
    const e = ev as Record<string, unknown>;
    if (e.type !== "m.reaction") continue;
    const content = (e.content as Record<string, unknown>) || {};
    const relates = content["m.relates_to"] as
      | Record<string, unknown>
      | undefined;
    if (!relates || relates.rel_type !== "m.annotation") continue;
    const targetId = String(relates.event_id || "");
    const key = String(relates.key || "");
    if (!targetId || !key) continue;
    if (!reactionsMap.has(targetId)) reactionsMap.set(targetId, {});
    const counts = reactionsMap.get(targetId)!;
    counts[key] = (counts[key] || 0) + 1;
  }
  for (const m of messages) {
    const r = reactionsMap.get(m.event_id);
    if (r && Object.keys(r).length > 0) m.reactions = r;
  }
  // 显式按时间升序——此前顺序完全依赖 Matrix /messages chunk 的
  // 原始返回序，话题面板（replies 是 visibleMessages 子集）出现"从上到下
  // 不是从旧到新"（反馈）。JS sort 稳定：同 ts 保持 chunk 相对序。
  messages.sort((a, b) => a.origin_server_ts - b.origin_server_ts);
  return {
    messages,
    end: String(payload.end || ""),
    start: String(payload.start || ""),
  };
}

/** 上传文件到 Matrix media → 返回 mxc:// content_uri。 */
export async function uploadMedia(file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  // 裸路径 POST 会落 SPA 兜底（200 + index.html 壳）→ resp.json()
  // 抛错 = 反向交付（文件发送）静默失败。必须 getApiUrl + token
  //（与 WorkbenchPage SSE /events 同款正确模式）。
  const host = window.QwenPaw?.host;
  const url = host && typeof host.getApiUrl === "function"
    ? host.getApiUrl("/agentteams-proxy/matrix/upload")
    : "/agentteams-proxy/matrix/upload";
  const headers: Record<string, string> = {};
  const token = host && typeof host.getApiToken === "function"
    ? host.getApiToken()
    : "";
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: form,
  });
  const data = (await resp.json()) as { content_uri?: string; detail?: string };
  if (!resp.ok || !data.content_uri) {
    throw new Error(data.detail || `上传失败 HTTP ${resp.status}`);
  }
  return data.content_uri;
}

/** 发送表情反应（m.reaction，m.annotation rel_type，Element 同款协议）。 */
export async function sendReaction(
  roomId: string,
  eventId: string,
  emoji: string,
): Promise<{ event_id: string }> {
  const txn = `wb-r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return (await requestJson(
    `/agentteams-proxy/matrix/rooms/${encodeURIComponent(roomId)}/send/m.reaction/${txn}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        "m.relates_to": {
          rel_type: "m.annotation",
          event_id: eventId,
          key: emoji,
        },
      }),
    },
  )) as { event_id: string };
}

/** Matrix 消息发送公共样板（本文件 4 条 m.room.message 路径共用）：
 * PUT /rooms/{roomId}/send/m.room.message/{txn} + 成功后失效审批队列缓存。
 * txnPrefix 保留原各调用点前缀（wb / wb-apr / wb-edit）供日志辨识。 */
async function sendMatrixMessage(
  roomId: string,
  content: Record<string, unknown>,
  opts: { txnPrefix?: string } = {},
): Promise<{ event_id: string }> {
  const txn = `${opts.txnPrefix ?? "wb"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = (await requestJson(
    `/agentteams-proxy/matrix/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(content),
    },
  )) as { event_id: string };
  // 审批命令已发出 → 队列缓存即刻失效（各面板下次取数即回源；后端
  // 缓冲的异步 resolve 窗口由各面板既有的「立即+延迟」重拉覆盖）。
  invalidateTags(["room-approvals"]);
  return res;
}

/** 发送文件/图片消息（m.file / m.image）。 */
export async function sendRoomFile(
  roomId: string,
  opts: {
    mxcUri: string;
    filename: string;
    msgtype: "m.file" | "m.image";
    mimetype?: string;
    size?: number;
  },
): Promise<{ event_id: string }> {
  const content: Record<string, unknown> = {
    msgtype: opts.msgtype,
    body: opts.filename,
    url: opts.mxcUri,
    filename: opts.filename,
    info: {
      mimetype: opts.mimetype || "application/octet-stream",
      size: opts.size || 0,
    },
  };
  return sendMatrixMessage(roomId, content);
}

/** ：
 * composer 记录的 mention 目标——发送时构造 Element 同款三重标记
 * （m.mentions 结构化 + formatted_body matrix.to 链接 + body 纯文本
 * @localpart），缺任何一层都可能被群房间 _require_mention 静默丢弃
 * （Worker 收不到）。命名 SendMention——与旧 RoomMention（@提及通知
 * feed，fetchRoomMentions）区分，同文件重名会接口合并成超集。 */
interface SendMention {
  mxid: string;
  /** MXID localpart（@ 后的可读名，body 里实际出现的文本）。 */
  localpart: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Element MessageComposer 同款：body 里每处 @localpart → matrix.to
 * 链接（已 HTML 转义后替换，负向 lookahead 防更长 localpart 双包）。 */
function buildMentionHtml(body: string, mentions: SendMention[]): string {
  let html = escapeHtml(body);
  for (const m of mentions) {
    if (!m.localpart) continue;
    const esc = m.localpart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`@${esc}(?![\\w.])`, "g");
    const link = `<a href="https://matrix.to/#/${encodeURIComponent(
      m.mxid,
    )}" class="mx-Mention">@${escapeHtml(m.localpart)}</a>`;
    html = html.replace(re, link);
  }
  return html;
}

export async function sendRoomMessage(
  roomId: string,
  body: string,
  replyTo?: { event_id: string; sender: string; body: string },
  threadRoot?: string,
  mentions?: SendMention[],
  extraContent?: Record<string, unknown>,
): Promise<{ event_id: string }> {
  const content: Record<string, unknown> = { msgtype: "m.text", body };
  // 自定义 content 键并入（#87 file_refs 信封）——独立于 mentions/线程
  // 分支，互不覆盖。
  if (extraContent) {
    for (const [k, v] of Object.entries(extraContent)) content[k] = v;
  }
  if (mentions && mentions.length > 0) {
    content["format"] = "org.matrix.custom.html";
    content["formatted_body"] = buildMentionHtml(body, mentions);
    content["m.mentions"] = {
      user_ids: [...new Set(mentions.map((m) => m.mxid))],
    };
  }
  if (threadRoot) {
    // 线程回复：m.thread rel_type（Agent 线程协议，agentteams-matrix-channel
    // L3618 同款——比 m.in_reply_to 更适合 Agent 场景，Element 也支持）。
    content["m.relates_to"] = {
      rel_type: "m.thread",
      event_id: threadRoot,
    };
  } else if (replyTo?.event_id) {
    const fallback =
      replyTo.body || replyTo.sender
        ? `> <${replyTo.sender || "@unknown"}> ${(replyTo.body || "").slice(0, 200)}`
        : "";
    content["m.relates_to"] = {
      "m.in_reply_to": {
        event_id: replyTo.event_id,
        ...(fallback ? { fallback } : {}),
      },
    };
  }
  return sendMatrixMessage(roomId, content);
}

/** 审批命令带 @Worker（真机反馈：无 @ 的
 * `/approval approve` 群内没反应）。QwenPaw Matrix 通道群房间
 * _require_mention 默认 True——无 mention 消息只进历史缓冲不进消费队列，
 * Worker 根本看不到裸命令。按 Element 三重惯例发：m.mentions（结构化，
 * _was_mentioned 检查 1）+ formatted_body matrix.to 链接（检查 2）+ body
 * 纯文本 @localpart（可读性）；Worker 侧 _strip_mention_prefix 剥前导 @
 * 暴露斜杠命令。 */
export async function sendApprovalCommand(
  roomId: string,
  targetMxid: string,
  cmd: string,
  replyTo?: { event_id: string; sender: string; body: string },
): Promise<{ event_id: string }> {
  const local = (targetMxid.split(":")[0] || targetMxid).replace(/^@/, "");
  const content: Record<string, unknown> = {
    msgtype: "m.text",
    body: `@${local} ${cmd}`,
    format: "org.matrix.custom.html",
    formatted_body: `<a href="https://matrix.to/#/${targetMxid}">@${local}</a> ${cmd}`,
    "m.mentions": { user_ids: [targetMxid] },
  };
  if (replyTo?.event_id) {
    const fallback =
      replyTo.body || replyTo.sender
        ? `> <${replyTo.sender || "@unknown"}> ${(replyTo.body || "").slice(0, 200)}`
        : "";
    content["m.relates_to"] = {
      "m.in_reply_to": {
        event_id: replyTo.event_id,
        ...(fallback ? { fallback } : {}),
      },
    };
  }
  return sendMatrixMessage(roomId, content, { txnPrefix: "wb-apr" });
}

/** 编辑自己的消息（Element 同款标注编辑，CS-API m.replace）：
 * 新事件 content 带 m.new_content + m.relates_to{rel_type:"m.replace",
 * event_id:原事件}；非标注客户端看到 body 的 "[edit] " fallback 前缀。
 * 原事件保留（Matrix 事件不可变），fetchRoomMessages 聚合时替换显示。 */
export async function sendRoomMessageEdit(
  roomId: string,
  originalEventId: string,
  body: string,
): Promise<{ event_id: string }> {
  const content: Record<string, unknown> = {
    msgtype: "m.text",
    body: `[edit] ${body}`,
    "m.new_content": { msgtype: "m.text", body },
    "m.relates_to": { rel_type: "m.replace", event_id: originalEventId },
  };
  return sendMatrixMessage(roomId, content, { txnPrefix: "wb-edit" });
}

/** 撤回自己的消息（redaction，CS-API 标准端点）：
 * DELETE /rooms/{roomId}/send/{eventId}——仅本人事件可撤回（他人 403）。
 * 撤回后原事件带 unsigned.redacted_because，聚合层渲染「已撤回」。 */
export async function redactRoomMessage(
  roomId: string,
  eventId: string,
  reason?: string,
): Promise<void> {
  await requestJson(
    `/agentteams-proxy/matrix/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(eventId)}`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: reason || "" }),
    },
  );
}

/** 5.0.0 release：忘记房间（CS-API：leave 之后清除本地状态；
 * joined 状态直接 forget 会被 403，所以「退出并删除」= 先 leave 再 forget）。 */
export async function forgetRoom(roomId: string): Promise<void> {
  await requestJson(
    `/agentteams-proxy/matrix/rooms/${encodeURIComponent(roomId)}/forget`,
    { method: "POST" },
  );
}

/** 退出房间（CS-API：leave=joined 状态退出；invite 状态
 * 的 leave=拒绝邀请，两个语义同一端点）。注意：L2 scope 房间退出后
 * Controller human 调和器下轮会重新邀请（确认文案已提示）。 */
export async function leaveRoom(roomId: string): Promise<void> {
  await requestJson(
    `/agentteams-proxy/matrix/rooms/${encodeURIComponent(roomId)}/leave`,
    { method: "POST", body: "{}" },
  );
}

/** 房间重命名（m.room.name state 事件；需房间权限表授权
 * 当前用户写 m.room.name——团队房间普遍权限异常（null 权限表），
 * 403 时配合 fetchRoomPowerInfo 展示诊断）。 */
export async function renameRoom(
  roomId: string,
  name: string,
): Promise<void> {
  await requestJson(
    `/agentteams-proxy/matrix/rooms/${encodeURIComponent(
      roomId,
    )}/state/m.room.name/`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    },
  );
}

/** 房间权限诊断（改名 403 根因展示）。
 * 实测：Controller/Manager 创建的房间 m.room.power_levels 状态
 * 内容为 null（上游 power_level_content_override 在 Tuwunel 落库异常）→
 * Tuwunel 按默认严格表（m.room.name 需 50）→ L2/普通成员恒 403，
 * Element 同名输入框也是灰色（非 Element 问题）。 */
export interface RoomPowerInfo {
  /** null = 权限表内容缺失（平台侧已知问题） */
  content: Record<string, unknown> | null;
  myLevel: number;
  nameRequired: number;
  canRename: boolean;
}

export async function fetchRoomPowerInfo(
  roomId: string,
  userId: string,
): Promise<RoomPowerInfo> {
  const raw = (await requestJson(
    `/agentteams-proxy/matrix/rooms/${encodeURIComponent(
      roomId,
    )}/state/m.room.power_levels`,
  )) as Record<string, unknown>;
  const c = (raw.content ?? null) as Record<string, unknown> | null;
  if (!c) {
    return { content: null, myLevel: 0, nameRequired: 50, canRename: false };
  }
  const users = (c.users as Record<string, number> | undefined) ?? {};
  const events = (c.events as Record<string, number> | undefined) ?? {};
  const myLevel = users[userId] ?? Number(c.users_default ?? 0);
  const nameRequired =
    events["m.room.name"] ?? Number(c.events_default ?? 0);
  return {
    content: c,
    myLevel,
    nameRequired,
    canRename: myLevel >= nameRequired,
  };
}

/** 房间静音（Element 同款 m.muted_room account data——
 * 跨客户端状态源；插件侧通知引擎 sync_watcher 同端点消费，静音房间
 * 不再触发 @通知/任务状态通知。服务端 push rule 由 Element 侧管理，
 * 插件不重复写）。 */
export async function setRoomMuted(
  roomId: string,
  userId: string,
  muted: boolean,
): Promise<void> {
  await requestJson(
    `/agentteams-proxy/matrix/user/${encodeURIComponent(userId)}/account_data/m.muted_room`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room_id: roomId, muted }),
    },
  );
}

// 静音房间集合：随 /teams/sync 载荷的 muted_rooms 字段下发（后端解析
// /sync account_data m.muted_room，零额外请求），前端 getCachedRooms()
// 读取——见 TeamsRoomsResponse.muted_rooms。
