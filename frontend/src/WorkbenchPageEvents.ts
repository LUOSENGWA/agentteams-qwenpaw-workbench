// WorkbenchPage 拆分模块——SSE 事件流与追平。
// 自 WorkbenchPage 单体原样搬移（技术债批次 D3b）；逻辑零改动，
// 壳持有的 React state 经 ctx 传入，标识符保持原名。

import {
  appendCachedMessage,
  type RoomMessage,
  type TeamRoom,
} from "./api";
import { mergeForward } from "./roomHistory";
import { createPoller, type Poller } from "./usePoller";

const host = window.QwenPaw.host;
const React = host.React;

export interface WorkbenchPageEventsCtx {
  tab: string;
  activeRoom: TeamRoom | null;
  pollMessages: () => Promise<void>;
  markCurrentRead: (roomId: string, latestEventId?: string) => Promise<void>;
  refreshRooms: (silent?: boolean, force?: boolean) => Promise<void>;
  refreshWorkflow: (silent?: boolean) => Promise<void>;
  setRooms: React.Dispatch<React.SetStateAction<TeamRoom[]>>;
  messagesRef: React.MutableRefObject<RoomMessage[]>;
  setMessages: React.Dispatch<React.SetStateAction<RoomMessage[]>>;
}

export function useWorkbenchEvents(ctx: WorkbenchPageEventsCtx) {
  const { tab, activeRoom, pollMessages, markCurrentRead, refreshRooms, refreshWorkflow, setRooms, messagesRef, setMessages } = ctx;

 // P6（⑨「自动刷新有点蠢，即时信息」）：/sync 事件驱动主路。
  // ref 镜像——SSE effect deps 为空（一次连接），闭包必须走 ref 取最新。
  const activeRoomRef = React.useRef<TeamRoom | null>(null);
  React.useEffect(() => {
    activeRoomRef.current = activeRoom;
  }, [activeRoom]);
  const pollMessagesRef = React.useRef<() => Promise<void>>(async () => {});
  React.useEffect(() => {
    pollMessagesRef.current = pollMessages;
  }, [pollMessages]);

  // 事件合并——600ms 窗口内的多个 room_message 只拉一次；
  // 拉取在飞时置脏位，完成后补拉一次（防丢失、防风暴；实测活跃房曾达 ~2 次/秒）。
  const pollSoonRef = React.useRef<{
    timer?: number;
    dirty?: boolean;
    inflight?: boolean;
  }>({});
  const pollSoon = React.useCallback(() => {
    const s = pollSoonRef.current;
    if (s.inflight) {
      s.dirty = true;
      return;
    }
    if (s.timer) return;
    s.timer = window.setTimeout(() => {
      s.timer = undefined;
      s.inflight = true;
      void pollMessagesRef.current().finally(() => {
        s.inflight = false;
        if (s.dirty) {
          s.dirty = false;
          pollSoon();
        }
      });
    }, 600);
  }, []);
  // (S1-1)：同上 ref 镜像——SSE 重连追平要拉房间列表全量
  // （effect deps=[]，闭包必须走 ref 取最新）。
  const refreshRoomsRef = React.useRef<() => Promise<void>>(async () => {});
  React.useEffect(() => {
    refreshRoomsRef.current = refreshRooms;
  }, [refreshRooms]);
  // 房间列表预览/未读的 10s 节流全量刷新退役——改由
  // room_list_update 增量 SSE 就地合并（Element 式；全量 /teams/sync 降为
  // 60s 兜底 + 邀请/手动）。

  // (S1-4)：事件流连接态（设置页可见——「断开自动重连」
  // 从黑箱变可见，排障一眼定位 S1 类问题）。
  const [sseState, setSseState] = React.useState<{
    status: "connected" | "reconnecting";
    since: number;
  }>({ status: "reconnecting", since: Date.now() });

 // ── IM 式事件触发（30s 轮询太笨）────────────────────
  // 后端 sync watcher：Matrix /sync 长轮询检测 @提到我 / 任务状态变化 →
  // 写宿主收件箱 + SSE 广播（GET /agentteams-proxy/events）。前端订阅：
  // 收到 mention → 刷新房间 + 通知 tab；task_status → 刷新工作流。
  // EventSource 不支持自定义 auth header（宿主启用 auth 时 401）——
  // 用 fetch + ReadableStream 手动解析 SSE（宿主 PawApp SDK 同款方案，
  // console/src/plugins/pawapp-sdk/task.ts），带 Bearer token。
  const [notifyTick, setNotifyTick] = React.useState(0);
  const [opsTick, setOpsTick] = React.useState(0);
  const [knowledgeTick, setKnowledgeTick] = React.useState(0);
 // 任意房间来消息 → 递增 →
  // WorkerChats 打开的会话窗立即刷新（事件驱动主路；4s 轮询降兜底）。
  // tick 只喂 WorkerChats 抽屉（兄弟视图）——不进 RoomChat props，
  // 避免每条消息击穿 4200 行聊天组件的 memo 整树重渲。
  const [chatsTick, setChatsTick] = React.useState(0);
  const [chatsWorker, setChatsWorker] = React.useState<string | null>(null);
  // SSE 帧回调闭包里的抽屉开合镜像（75 房集群下 room_message 高频到达，
  // 抽屉没开时递增 tick=纯浪费；抽屉自带 4s poller 会补齐期间增量）。
  const chatsDrawerOpenRef = React.useRef(false);
  chatsDrawerOpenRef.current = tab === "chat" && chatsWorker !== null;
  const handleOpenWorkerChats = React.useCallback(
    (w: string) => setChatsWorker(w),
    [],
  );

  React.useEffect(() => {
    let abort: AbortController | null = null;
 // 旧定时器 → 命令式 createPoller（60s SSE 断连
    // 兜底；!document.hidden——后台不拉；closure 捕获首渲染 refreshRooms，
    // 与原行为一致）。
    let fallback: Poller | null = null;
    let closed = false;
    let retryDelay = 1000;
    let lastDownSince = 0; // (S1-1)：最近一次断连开始时刻（0=当前连着）

    const bootFallback = () => {
      if (!fallback) {
        fallback = createPoller({
          fn: () => {
            // R4（16.23）：SSE 断连期唯一的数据兜底轮询——覆盖全部
            // SSE 驱动类型：房间列表（room_list_update）+ 活动房间消息
            // （room_message，原 RoomChat 12s 轮询退役后断连期的接替者）
            // + 工作流（task_status，原 15s 轮询退役后的接替者）
            // + 通知中心（mention/invite/approval）。SSE 在线时本 poller
            // 不存在（steady-state 零轮询，全事件驱动）。
            void refreshRooms();
            void pollMessagesRef.current();
            void refreshWorkflow();
            setNotifyTick((t) => t + 1);
          },
          intervalMs: 60000,
          isActive: () => !document.hidden,
        });
        fallback.start();
      }
    };
    const clearFallback = () => {
      if (fallback) {
        fallback.stop();
        fallback = null;
      }
    };
    // 重连调度统一加可见性感知——token 失效态/
    // 断连态 + 后台 tab 此前每 60s 一次 SSE 空拨（浏览器节流下定时器仍
    // 会跑，只是降频）。后台期间不拨；回前台立即重拨（visibility 追平
    // 路径已覆盖数据新鲜度，SSE 恢复只需在可见时进行）。
    let pendingVisListener: (() => void) | null = null;
    const clearPendingVis = () => {
      if (pendingVisListener) {
        document.removeEventListener("visibilitychange", pendingVisListener);
        pendingVisListener = null;
      }
    };
    const scheduleReconnect = (delay: number) => {
      window.setTimeout(() => {
        if (closed) return;
        if (document.hidden) {
          if (pendingVisListener) return; // 已有待回前台的重拨
          const onVis = () => {
            if (closed) return;
            clearPendingVis();
            if (document.visibilityState !== "visible") return;
            void connect();
          };
          pendingVisListener = onVis;
          document.addEventListener("visibilitychange", onVis);
        } else {
          void connect();
        }
      }, delay);
    };

    const connect = async () => {
      // (S1-2)：watchdog 句柄 hoist 到 connect() 顶部——
      // 清理统一走 catch 后的唯一收敛点（done/abort/网络异常全路径覆盖，
      // 防 interval 泄漏周期性杀下一次重连）。
 // number → Poller（createPoller，语义不变）。
      let watchdog: Poller | null = null;
      if (closed) return;
      if (!lastDownSince) lastDownSince = Date.now();
      try {
        abort = new AbortController();
        const url = window.QwenPaw.host.getApiUrl
          ? window.QwenPaw.host.getApiUrl("/agentteams-proxy/events")
          : "/api/agentteams-proxy/events";
        const token = window.QwenPaw.host.getApiToken
          ? window.QwenPaw.host.getApiToken()
          : "";
        const headers: Record<string, string> = {
          Accept: "text/event-stream",
        };
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(url, { headers, signal: abort.signal });
        if (!res.ok || !res.body) {
          if (res.status === 401 || res.status === 403) {
            // (S1-1/H6)：会话失效不再永停——60s 周期继续探
            // （重登后宿主 token 刷新，下次 connect 自动恢复）；轮询兜底并行。
            bootFallback();
            setSseState({ status: "reconnecting", since: lastDownSince });
            scheduleReconnect(60000);
            return;
          }
          throw new Error(`SSE ${res.status}`);
        }
        clearFallback();
        retryDelay = 1000;
        // (S1-1/H3)：重连追平——watcher /sync 不回放断连期
        // 事件，断开 >5s 恢复时立即拉一次：活动房间消息 + 房间列表全量。
        const downMs = lastDownSince ? Date.now() - lastDownSince : 0;
        lastDownSince = 0;
        setSseState({ status: "connected", since: Date.now() });
        if (downMs > 5000) {
          void pollMessagesRef.current();
          void refreshRoomsRef.current();
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        // (S1-2)：流看门狗——后端每 15s 发 ": keepalive"
        // 注释帧；45s（3 周期+裕量）无任何字节（含 keepalive）= TCP 半死挂
        // （NAT 超时/代理 idle-kill 未发 FIN）→ abort 读 → 走重连路径。
        let lastFrameAt = Date.now();
 // 旧定时器 → createPoller（5s；语义不变——
        // 45s 无帧 abort；!document.hidden——后台暂停，恢复后首 tick 即判定）。
        watchdog = createPoller({
          fn: () => {
            if (Date.now() - lastFrameAt > 45000) {
              lastFrameAt = Date.now(); // 防重复触发
              abort?.abort();
            }
          },
          intervalMs: 5000,
          isActive: () => !document.hidden,
        });
        watchdog.start();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          lastFrameAt = Date.now(); // 任何字节=帧到达（data 或 keepalive 注释）
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const data = JSON.parse(line.slice(6)) as {
                type?: string;
              };
              if (data.type === "mention") {
                // 房间列表元数据由
                // room_list_update 增量覆盖（未读/预览/排序），不再全量重拉。
                setNotifyTick((t) => t + 1);
              } else if (data.type === "task_status") {
                // 任务状态变化 → 刷新工作流三视图 + 通知中心。
                void refreshWorkflow();
                setNotifyTick((t) => t + 1);
              } else if (
                // 新邀请 / 审批请求 / 审批解决 → 通知中心立即
                // 更新（IM 式）。邀请=members 变化仍走全量（邀请区数据源=
                // /teams/sync）；审批不产房间元数据变化（13.21 起不再全量）。
                data.type === "invite" ||
                data.type === "approval_request" ||
                data.type === "approval_resolved"
              ) {
                if (data.type === "invite") void refreshRooms();
                setNotifyTick((t) => t + 1);
              } else if (data.type === "room_list_update") {
                // watcher 每轮 /sync
                // 的元数据增量 diff——就地合并（更新/插入新房间/移除 leave），
                // 不做全量 /teams/sync（那是一次带全房间 state 的 Matrix 全量
 // /sync，房间列表「慢而笨」的根因）。
                const upd = ((data as { rooms?: TeamRoom[] }).rooms || []) as Array<
                  Partial<TeamRoom> & { room_id: string; new?: boolean }
                >;
                const left: string[] = (data as { left?: string[] }).left || [];
                setRooms((prev) => {
                  let next = left.length
                    ? prev.filter((r) => !left.includes(r.room_id))
                    : prev;
                  for (const it of upd) {
                    if (!it || !it.room_id) continue;
                    const idx = next.findIndex((r) => r.room_id === it.room_id);
                    if (idx >= 0) {
                      const cur = next[idx];
                      // 逐字段比对——全等则复用
                      // 原 item 与原数组引用（此前每帧产新对象+新数组 →
                      // openRoom deps [rooms] 连锁 → HomePage/TeamOverview
                      // memo 失效 + 全消费方重渲）。首个变化字段才克隆。
                      let m: TeamRoom = cur;
                      const touch = (patch: Partial<TeamRoom>) => {
                        if (m === cur) m = { ...cur };
                        Object.assign(m, patch);
                      };
                      if (typeof it.name === "string" && it.name !== cur.name) touch({ name: it.name });
                      if (typeof it.member_count === "number" && it.member_count !== cur.member_count) touch({ member_count: it.member_count });
                      if (typeof it.unread === "number" && it.unread !== cur.unread) touch({ unread: it.unread });
                      if (typeof it.unread_highlight === "number" && it.unread_highlight !== cur.unread_highlight) touch({ unread_highlight: it.unread_highlight });
                      if (typeof it.last_ts === "number" && it.last_ts !== cur.last_ts) touch({ last_ts: it.last_ts });
                      if (typeof it.last_sender === "string" && it.last_sender !== cur.last_sender) touch({ last_sender: it.last_sender });
                      if (typeof it.last_body === "string" && it.last_body !== cur.last_body) touch({ last_body: it.last_body });
                      if (Array.isArray(it.typing)) {
                        const curTyping = cur.typing || [];
                        if (it.typing.length !== curTyping.length || it.typing.some((u, i) => curTyping[i] !== u)) {
                          touch({ typing: it.typing });
                        }
                      }
                      if (m !== cur) {
                        next = [...next.slice(0, idx), m, ...next.slice(idx + 1)];
                      }
                    } else if (it.new) {
                      next = [
                        ...next,
                        {
                          room_id: it.room_id,
                          name: it.name || it.room_id,
                          name_fallback: !it.name,
                          member_count: it.member_count || 0,
                          members: {},
                          unread: it.unread || 0,
                          unread_highlight: it.unread_highlight || 0,
                          last_ts: it.last_ts || 0,
                          last_sender: it.last_sender || undefined,
                          last_body: it.last_body || undefined,
                        },
                      ];
                    }
                  }
                  return next;
                });
              } else if (data.type === "room_message") {
                // P6：/sync 事件驱动消息刷新（IM 式主路；RoomChat 12s 轮询
                // 降为断连兜底）。当前房间 → 立即拉新（内容源=拉取，附件/
                // 工作流渲染路径零改动）。房间列表预览/未读由 room_list_update
                // 增量覆盖（13.21：10s 节流全量刷新退役）。
                const rid = String((data as { room_id?: string }).room_id || "");
                // 载荷解析提到房间判定外——活跃房直合与非活动房
                // 缓存追加共用同一最小载荷（event: id/sender/ts/body/
                // msgtype/relates_to）。
                const evp = (data as {
                  event?: {
                    event_id?: string;
                    sender?: string;
                    ts?: number;
                    body?: string;
                    msgtype?: string;
                    relates_to?: unknown;
                  };
                }).event;
                const evId = String(evp?.event_id || "");
                if (rid && rid === activeRoomRef.current?.room_id) {
                  // 载荷直合——watcher 已附解析后的最小载荷。
                  // 普通文本消息直接合并（零回拉——5Mbps 链路上活跃房回拉
                  // 的大头）；非文本/带关系（回复/编辑/附件）仍走 600ms
                  // 事件合并兜底拉取（行为与旧版一致）。
                  if (evp && evId && evp.msgtype === "m.text" && !evp.relates_to) {
                    const known = new Set(
                      messagesRef.current.map((m) => m.event_id),
                    );
                    if (!known.has(evId)) {
                      const incoming: RoomMessage = {
                        event_id: evId,
                        sender: String(evp.sender || ""),
                        body: String(evp.body || ""),
                        msgtype: "m.text",
                        origin_server_ts: Number(evp.ts || Date.now()),
                      };
                      setMessages((prev) => mergeForward(prev, [incoming]));
                    }
                    // 正在看的房间来了新消息 → 回执（与 pollMessages 同款）。
                    void markCurrentRead(rid, evId);
                  } else {
                    // 非文本/复杂消息：兜底拉取（14.7 前的既有行为）。
                    pollSoon();
                  }
                } else if (rid) {
                  // R1（16.23）：非活动房间 → 单条新消息直接追加进该房间的
                  // 消息缓存（切回时首帧即含新消息，不必等回拉完成）。
                  // 门控与活跃房直合同款：仅简单 m.text 且无 relates_to；
                  // 复杂消息（附件/回复/编辑）的真相源 = 打开时的全量拉取，
                  // 列表预览/未读由 room_list_update 增量覆盖。
                  // 只更新打开过的房间（appendCachedMessage 内部门控）。
                  if (evp && evId && evp.msgtype === "m.text" && !evp.relates_to) {
                    appendCachedMessage(rid, {
                      event_id: evId,
                      sender: String(evp.sender || ""),
                      body: String(evp.body || ""),
                      msgtype: "m.text",
                      origin_server_ts: Number(evp.ts || Date.now()),
                    });
                  }
                }
 // 任意房间来消息 → 递增 chatsTick → 打开的头像会话窗立即刷新
                // （事件驱动主路，Element 式延迟≈0）。门控：仅抽屉打开
                // 时递增（75 房集群下任意房消息=全页重渲染源）；抽屉
                // 关闭期间由 4s poller 兜底，打开瞬间立即补齐。
                if (chatsDrawerOpenRef.current) setChatsTick((v) => v + 1);
              }
            } catch {
              /* 忽略非法帧 */
            }
          }
        }
      } catch {
        /* 网络抖动 → 重连 */
      }
      // (S1-2)：watchdog 唯一清理收敛点——覆盖 for 循环
      // 全部退出路径（done 正常结束 / 看门狗或卸载 abort / 网络异常）。
 // clearInterval → poller.stop()。
      if (watchdog) {
        watchdog.stop();
        watchdog = null;
      }
      // 流结束（连接被断开）→ 指数退避重连；**退避封顶 60s 后不再永停**
      // （S1-1：宿主重启/换容器/网络恢复即自愈），持续断连
      // 时 60s 轮询兜底并行。
      if (closed) return;
      if (retryDelay >= 60000) bootFallback(); // 幂等
      setSseState({ status: "reconnecting", since: lastDownSince });
      scheduleReconnect(retryDelay);
      retryDelay = Math.min(retryDelay * 2, 60000);
    };

    void connect();
    return () => {
      closed = true;
      clearPendingVis();
      abort?.abort();
      clearFallback();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // (S1-3)：可见性追平——后台 tab 的定时器被浏览器
  // 节流至 ≥60s（SSE 也可能已死），回到前台/窗口聚焦时立即拉一次（3s 防抖
  // 防事件风暴）——不等下一个 tick。
  React.useEffect(() => {
    let lastCatch = 0;
    const catchUp = () => {
      const now = Date.now();
      if (now - lastCatch < 3000) return;
      lastCatch = now;
      void pollMessagesRef.current();
      void refreshRoomsRef.current();
    };
    const onVis = () => {
      if (document.visibilityState === "visible") catchUp();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", catchUp);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", catchUp);
    };
  }, []);
  return {
    sseState,
    notifyTick,
    setNotifyTick,
    opsTick,
    setOpsTick,
    knowledgeTick,
    setKnowledgeTick,
    chatsTick,
    setChatsTick,
    chatsWorker,
    setChatsWorker,
    handleOpenWorkerChats,
  };
}
