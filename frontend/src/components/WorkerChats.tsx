/**
 * 💬 会话（消费上游 #1295，issue #1293；
 * 查看窗口重做——QwenPaw 原始输出口径）。
 *
 * 给 AgentTeams 里的无头 QwenPaw Worker「补头」：用户经 AgentTeams 即可
 * 看见 Worker 的 QwenPaw 会话（列表 → 完整 session，只读）。
 *
 * 位置：群内 Worker 头像点击 → 抽屉（RoomChat）。
 * 数据面：Controller 会话端点（#1295，room 级 L2 参与边界）——
 * GET /workers/{name}/chats[/{id}[/status]]
 * 走既有通用 Controller 代理（后端零新端点）。
 *
 * 口径（「查看会话的窗口参考 QwenPaw，
 * 因为这是 QwenPaw 的原始输出」）——逐条对齐 QwenPaw console
 * Control/Sessions 页（session 数据模型=QwenPaw ChatSpec 同构）：
 * - 列表：Active/Archived 双 tab（带计数）+ QwenPaw 同语义列
 * （Name/Channel 彩色 Tag/UserID/UpdatedAt 可排序默认倒序；
 * SessionID 与 CreatedAt 移入详情头——抽屉 560px 宽度适配）；
 * Channel 色板逐值抄 QwenPaw constants/channel.ts CHANNEL_COLORS。
 * - 详情：QwenPaw /chat/{id} 会话口径——user 右气泡、assistant 左
 * markdown（插件 MdText 同款零依赖渲染）、工具块紧凑标签、system
 * 居中；元信息行 = QwenPaw session 卡 meta（ID/User/Created/Updated）。
 *
 * 纪律（#1293 数据敏感性，不变）：
 * - detail = **agent 上下文**——可能含压缩历史/未发送工具调用输出，
 * 与实发房间消息不同，详情头部恒显蓝色标注。
 * - L2 只见自己所在 Matrix 房间的会话（服务端强制）；越权统一 404
 * （W8 不可探测）→ 整节占位说明，不渲染空列表。
 * - /status 仅 QwenPaw ≥2.2.1：旧 runtime 404 → 隐藏状态灯（版本无关门）。
 * - 只读：无发送/编辑面。
 */

import type * as ReactNS from "react";
import { useT } from "../i18n";
import {
  type WorkerInfo,
  type WorkerChatSpec,
  type WorkerChatMessage,
  fetchWorkerChats,
  fetchWorkerChat,
  fetchWorkerChatStatus,
  httpErrorStatus,
} from "../api";
import WorkerSessionDot from "./WorkerSessionDot";
import WorkerCodingRuns from "./WorkerCodingRuns";
import { copyText } from "../util";
import { CHANNEL_LABELS, CHANNEL_COLORS, formatTime, groupTurns } from "./WorkerChatsShared";
import type { MsgPart } from "./WorkerChatsShared";
import { ChatDetail } from "./WorkerChatsDetail";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

/**
 * `fixedWorker` = 头像抽屉模式——
 * 锁定单个 Worker（跳过选择器）。
 * 列表
 * antd.Table → 卡片列表（参照 dashboard worker-chats-panel 口径：整卡
 * 点击进详情、全名/全 session_id 换行不裁切、窄容器不挤压）；
 * `refreshTick` = SSE room_message 事件驱动刷新（Element 式主路——
 * 房间来消息即刷当前会话；4s 轮询降为断连兜底）。
 */
function WorkerChats({
  workers,
  fixedWorker,
  refreshTick,
}: {
  workers: WorkerInfo[];
  fixedWorker?: string;
  refreshTick?: number;
}) {
  const tr = useT();
  const [sel, setSel] = React.useState(fixedWorker ?? "");
  const [gate, setGate] = React.useState<"" | "404" | "err" | "notoken">("");
  const [gateMsg, setGateMsg] = React.useState("");
  const [chats, setChats] = React.useState<WorkerChatSpec[]>([]);
  const [loading, setLoading] = React.useState(false);

  // QwenPaw 会话页同款 Active/Archived 双 tab + Coding CLI tab。
  // coding CLI 会话归 worker 会话区——同抽屉第三 tab，
  // 数据源 = Controller /coding-runs 按 worker 过滤，只读。
  const [tab, setTab] = React.useState<"active" | "archived" | "coding">("active");

  // 卡片列表排序（Table sorter 的卡片等价物；
  // 默认最后活动倒序 = QwenPaw 会话页默认）。
  const [sortKey, setSortKey] = React.useState<"updated" | "created" | "name">(
    "updated",
  );

  const [openId, setOpenId] = React.useState<string | null>(null);
  const [msgs, setMsgs] = React.useState<WorkerChatMessage[]>([]);
  // groupTurns 是 O(n) 重分组（每轮 result-only
  // 折叠），此前在渲染路径每次重算——被 RoomChat 重渲连带放大。memo 到
  // msgs 引用（4s 轮询已有 length+末行 diff 门，msgs 引用不变=不重算）。
  const turns = React.useMemo(() => groupTurns(msgs), [msgs]);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailErr, setDetailErr] = React.useState("");
  const [status, setStatus] = React.useState<"" | "idle" | "running">("");
  const detailListRef = React.useRef<HTMLDivElement | null>(null);

  const load = React.useCallback(async () => {
    if (!sel) return;
    setLoading(true);
    setGate("");
    setGateMsg("");
    try {
      const data = await fetchWorkerChats(sel);
      setChats(Array.isArray(data) ? data : []);
    } catch (e) {
      const st = httpErrorStatus(e);
      if (st === 404) {
        setGate("404");
        setChats([]);
      } else if (st === 401 || st === 502) {
        // 凭证缺失（L1 账号密码登录不带 Controller
        // token / L2 无数据面 / controller 不可达）→ 明确指引，不笼统
        // 「加载失败」（13.9 经常显示无worker的根因面之一）。
        setGate("notoken");
        setChats([]);
      } else if (st === 403) {
        // W8 防探测：跨团队/无该 Worker 访问权（有 token 但 scope 不够）。
        setGate("err");
        setGateMsg(tr("无该 Worker 访问权（跨团队或当前账号 scope 不含该 Worker）"));
        setChats([]);
      } else {
        setGate("err");
        setGateMsg(e instanceof Error ? e.message : tr("加载失败"));
        setChats([]);
      }
    } finally {
      setLoading(false);
    }
  }, [sel, tr]);

  React.useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  const openChat = async (chatId: string) => {
    if (!sel) return;
    setOpenId(chatId);
    setMsgs([]);
    setDetailErr("");
    setStatus("");
    setDetailLoading(true);
    // 打开即视为贴底（首屏滚底 + 后续跟随基准）。
    nearBottomRef.current = true;
    // 状态灯与详情并发拉取；404 = 旧 runtime，隐藏灯
    // （会话级 loop 状态显示点迁至聊天页输入区——RoomChat composer chip，
 // ，本视图不再查 /loops/status。）
    void fetchWorkerChatStatus(sel, chatId)
      .then((r) => setStatus(r?.status === "running" ? "running" : "idle"))
      .catch(() => setStatus(""));
    try {
      const d = await fetchWorkerChat(sel, chatId);
      setMsgs(Array.isArray(d?.messages) ? d.messages : []);
    } catch (e) {
      const st = httpErrorStatus(e);
      if (st === 404) setDetailErr(tr("会话不存在或无访问权（404）"));
      else
        setDetailErr(e instanceof Error ? e.message : tr("加载失败"));
    } finally {
      setDetailLoading(false);
    }
  };

  // →
  // // 实时主路 = **事件驱动**（Element /sync 同款语义）——后端 sync watcher
  // 收到房间消息 → SSE room_message → WorkbenchPage 递增 refreshTick →
  // 下方 effect 立即拉详情/状态（延迟≈网络 RTT，非周期轮询）；4s 轮询
  // 降为 SSE 断连/事件丢失兜底（RoomChat P6 同构语义）。消息列表按
  // 「长度+末条」轻量判变（避免无变化时重渲染），状态灯同步刷。
  const selRef = React.useRef(sel);
  selRef.current = sel;
  const openIdRef = React.useRef(openId);
  openIdRef.current = openId;
  const refreshOpenChat = React.useCallback(async () => {
    const s = selRef.current;
    const oid = openIdRef.current;
    if (!s || !oid) return;
    // 两独立端点并行（原串行=状态灯延迟
    // 叠加全量消息 RTT；allSettled=单端点失败不影响另一个，原语义）。
    const [chatRes, statusRes] = await Promise.allSettled([
      fetchWorkerChat(s, oid),
      fetchWorkerChatStatus(s, oid),
    ]);
    if (chatRes.status === "fulfilled") {
      const next = Array.isArray(chatRes.value?.messages) ? chatRes.value.messages : null;
      if (next)
        setMsgs((prev) =>
          prev.length === next.length &&
          (next.length === 0 ||
            JSON.stringify(prev[prev.length - 1]) ===
              JSON.stringify(next[next.length - 1]))
            ? prev
            : next,
        );
    }
    if (statusRes.status === "fulfilled") {
      const st = statusRes.value?.status;
      if (st === "running" || st === "idle") setStatus(st);
    }
  }, []);
  // R4（16.23）：10s 兜底轮询退役——会话刷新已有 SSE 主路（room_message →
  // refreshTick → 300ms 合并窗），steady-state 不再轮询；SSE 断连期的兜底
  // 由 WorkbenchPage 的 60s bootFallback 统一承担（断连才启动）。
  // SSE 事件驱动主路：refreshTick 变化（room_message 等）→ 刷新。
  // 加 300ms 合并窗——refreshTick 是全集群
  // room_message 事件驱动（与打开的会话房间无关），burst 消息此前每条
  // 立即 2 GET（fetchWorkerChat 全量 + status）。单条消息仍是 ~即时
  // （300ms 窗尾触发），burst 10 条 = 1 次而非 10 次。
  const tickRef = React.useRef(refreshTick);
  const sseDebounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshOpenChatRef = React.useRef(refreshOpenChat);
  refreshOpenChatRef.current = refreshOpenChat;
  React.useEffect(() => {
    if (refreshTick === undefined) return;
    if (refreshTick !== tickRef.current) {
      tickRef.current = refreshTick;
      if (sseDebounceRef.current) return;
      sseDebounceRef.current = setTimeout(() => {
        sseDebounceRef.current = null;
        void refreshOpenChatRef.current();
      }, 300);
    }
  }, [refreshTick]);
  // 卸载清窗（openId 关闭/切走 tab → 组件卸载，pending 刷新丢弃）。
  React.useEffect(
    () => () => {
      if (sseDebounceRef.current) clearTimeout(sseDebounceRef.current);
    },
    [],
  );

  // 底部跟随（QwenPaw 对话框口径）：消息变化时——用户已在底部（近底
  // 100px 内）= 自动贴底；用户上翻看历史 = 不动（不打断阅读）。
  const nearBottomRef = React.useRef(true);
  const handleDetailScroll = React.useCallback(() => {
    const el = detailListRef.current;
    if (!el) return;
    nearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  }, []);
  React.useEffect(() => {
    if (detailLoading || !openId || !detailListRef.current) return;
    if (nearBottomRef.current) {
      detailListRef.current.scrollTop = detailListRef.current.scrollHeight;
    }
  }, [detailLoading, openId, msgs]);

  // 容器宽测量——**必须在所有早退 return 之前**（列表/详情/空态/gate 各
  // 视图 hook 数必须一致，否则 React #300 崩）。13.11 卡片列表后宽度
  // 阈值逻辑移除，ref 保留（hook 顺序 + 列表容器锚点）。
  const cwrapRef = React.useRef<HTMLDivElement | null>(null);

  // （13.9 从点开会话之后，经常显示无worker
  // 根因）：workers 列表来自 adminData（需要 Controller token）——
  // L1 账号密码登录只带 Higress Console 会话、不带 Controller token 时
  // adminData=null → workers=[] → 旧门恒「无 Worker」。fixedWorker 模式
  // （头像抽屉锁定单 Worker）不依赖列表，直接按名拉取，门只看列表
  // 选择器是否可用。
  if (workers.length === 0 && !fixedWorker) {
    return <antd.Alert type="info" showIcon message={tr("无 Worker")} />;
  }
  // fixedWorker 模式 + 列表为空：**不硬阻断**——adminData 是异步的，
  // 首次打开点头像可能早于管理数据加载完成（token 实际可用）。直接
  // 按 fixedWorker 拉取；真无 token 时 401/502 落到 gate=err 分支，
  // 由那里给出 token 明确指引（见下）。

  if (gate === "404") {
    return (
      <antd.Alert
        type="info"
        showIcon
        message={tr("无可见会话（Controller 版本较低或无该 Worker 访问权）")}
        description={tr(
          "L2 仅可查看自己所在 Matrix 房间内的会话；Controller 版本未含会话端点或当前账号无该 Worker 访问权时同样显示此提示。升级 Controller 后本节自动点亮。",
        )}
      />
    );
  }

  if (gate === "notoken") {
    // Controller token 缺失的明确指引（L1 账号密码
    // 登录只带 Higress Console 会话 ≠ Controller 管理 token）。
    return (
      <antd.Alert
        type="warning"
        showIcon
        message={tr("会话列表需要 Controller 管理员 token（当前账号未配置或不可达）")}
        description={tr(
          "L1 账号密码登录只带 Higress Console 会话（网关面），不含 Controller 管理 token（CRD/数据面）。请在 设置 → ① Controller 管理员 token 字段粘贴（部署宿主机取法：docker exec agentteams-controller cat /var/run/agentteams/cli-token）。",
        )}
        action={
          <antd.Button size="small" onClick={() => void load()}>
            {tr("重试")}
          </antd.Button>
        }
      />
    );
  }

  if (gate === "err") {
    return (
      <antd.Alert
        type="error"
        showIcon
        message={tr("会话加载失败")}
        description={gateMsg}
        action={
          <antd.Button size="small" onClick={() => void load()}>
            {tr("重试")}
          </antd.Button>
        }
      />
    );
  }

  const active = chats.filter((c) => !c.archived);
  const archived = chats.filter((c) => !!c.archived);
  const list = React.useMemo(() => {
    const arr = [...(tab === "active" ? active : archived)];
    arr.sort((a, b) => {
      if (sortKey === "name")
        return String(a.name || a.id).localeCompare(String(b.name || b.id));
      const key = sortKey === "created" ? "created_at" : "updated_at";
      return String(b[key] || "").localeCompare(String(a[key] || ""));
    });
    return arr;
  }, [tab, active, archived, sortKey]);
  const openChatSpec = openId
    ? chats.find((c) => c.id === openId)
    : undefined;

  // （QwenPaw 化：ResponseActions 同款复制——气泡
  // hover 显 ⧉，复制该条全部文本部分）。
  const copyParts = React.useCallback(
    (parts: MsgPart[]) => {
      const txt = parts
        .filter((p) => p.kind === "text" || p.kind === "thinking")
        .map((p) => p.label)
        .join("\n");
      copyText(txt, (ok) => {
        if (ok) antd.message.success(tr("已复制"));
        else antd.message.error(tr("复制失败"));
      });
    },
    [tr],
  );

  // ── 详情视图（QwenPaw /chat/{id} 口径：列表让位，← 返回列表）──────
  // 高度链改容器相对（#629 家规）——抽屉 body 是定高
  // flex 项，消息区 flex:1 + minHeight:0 自滚，不再写 420 魔法数（窗口
  // 矮时旧写法内容被抽屉底裁切且不可滚）。
  if (openId) {
    return (
      <ChatDetail
        openId={openId}
        openChatSpec={openChatSpec}
        status={status}
        detailErr={detailErr}
        detailLoading={detailLoading}
        msgsLen={msgs.length}
        turns={turns}
        copyParts={copyParts}
        listRef={detailListRef}
        onScroll={handleDetailScroll}
        onBack={() => setOpenId(null)}
      />
    );
  }

  // ── 列表视图（QwenPaw Control/Sessions 同语义列）────────────────
 // （13.7 「会话列表拥挤依旧，自适应宽度，查看按钮
  // 不被挤压」）：① 通道列 64→56 + 短名（agentteams_matrix 全名 Tag 是
  // 挤爆主因）+ <640px 容器整列隐藏（宽度让给会话列）② 查看列 48→44
  // + 按钮 nowrap + padding 收窄，任何容器宽恒整词可见 ③ 会话列 =
  // 唯一弹性列（min 120）+ 每会话 status 点（running 蓝呼吸，/chats
  // 自带字段，零新请求）。
 // // antd.Table → 卡片列表——Table fixed 布局在窄容器被挤压（查看列
 // 裁切，13.8 已三次压列宽逐个修补）。卡片口径参照 dashboard
  // worker-chats-panel：整卡可点进详情、全名/全 session_id 换行
  // 不裁切、窄容器抗挤压；Table sorter 能力保留为排序下拉。
  const emptyText =
    tab === "active"
      ? tr("当前账号在此 Worker 的可见范围内没有活跃会话（L2 仅自己所在房间）")
      : tr("没有已归档会话");

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {fixedWorker ? (
          <span style={{ fontWeight: 600 }}>
            {tr("Worker")}：{fixedWorker}
          </span>
        ) : (
          <>
            <span style={{ fontWeight: 600 }}>{tr("Worker")}</span>
            <antd.Select
              size="small"
              style={{ width: 220 }}
              value={sel || undefined}
              onChange={(v: string) => {
                setSel(v);
                setOpenId(null);
                setMsgs([]);
                setStatus("");
              }}
              options={workers.map((w) => ({
                value: w.name,
                label: `${w.name}${w.role === "leader" ? "（Leader）" : ""}`,
              }))}
              placeholder={tr("选择 Worker")}
            />
          </>
        )}
        <div style={{ flex: 1 }} />
        {/* 排序/刷新只对聊天会话 tab 有意义（Coding CLI tab 自带刷新）。 */}
        {tab !== "coding" ? (
          <antd.Select
            size="small"
            style={{ width: 128 }}
            value={sortKey}
            onChange={(v: "updated" | "created" | "name") => setSortKey(v)}
            options={[
              { value: "updated", label: tr("最后活动 ↓") },
              { value: "created", label: tr("创建 ↓") },
              { value: "name", label: tr("名称 A-Z") },
            ]}
          />
        ) : null}
        {tab !== "coding" ? (
          <antd.Button size="small" onClick={() => void load()} loading={loading}>
            {tr("刷新")}
          </antd.Button>
        ) : null}
      </div>

      <antd.Tabs
        size="small"
        activeKey={tab}
        onChange={(k: string) => {
          setTab(k === "archived" ? "archived" : k === "coding" ? "coding" : "active");
          setOpenId(null);
        }}
        items={[
          { key: "active", label: `${tr("活跃")} (${active.length})` },
          { key: "archived", label: `${tr("已归档")} (${archived.length})` },
          { key: "coding", label: tr("Coding CLI") },
        ]}
      />

      {/* Coding CLI tab：该 worker 的执行记录（与聊天会话同一抽屉，10/17）。 */}
      {tab === "coding" ? (
        <WorkerCodingRuns worker={sel} />
      ) : (
      <div ref={cwrapRef} style={{ minWidth: 0 }}>
        {loading && chats.length === 0 ? (
          <antd.Spin size="small" />
        ) : list.length === 0 ? (
          <antd.Alert type="info" showIcon message={emptyText} />
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {list.map((c) => {
              const full = c.name || c.id.slice(0, 10);
 // 此前灯只在
              // running 时渲染（idle/done 无点）——盘上会话多为 idle → 恒不见。
              // 改恒显 WorkerSessionDot（与详情头/成员头像角灯同一正源：
              // idle 灰常亮 / running 蓝呼吸，含 Tooltip；/chats 的
              // status 二值 idle|running 直接映射）。
              const dotState: "running" | "idle" =
                c.status === "running" ? "running" : "idle";
              return (
                <div
                  key={c.id}
                  onClick={() => void openChat(c.id)}
                  style={{
                    border: "1px solid rgba(127,127,127,0.25)",
                    borderRadius: 8,
                    padding: "8px 10px",
                    cursor: "pointer",
                    background: "rgba(127,127,127,0.03)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      minWidth: 0,
                    }}
                  >
                    <WorkerSessionDot state={dotState} size={8} />
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: 12.5,
                        wordBreak: "break-word",
                        whiteSpace: "normal",
                        flex: "1 1 auto",
                        minWidth: 0,
                      }}
                    >
                      {full}
                    </span>
                    {c.pinned ? (
                      <antd.Tag
                        color="gold"
                        style={{ marginInlineEnd: 0, flexShrink: 0 }}
                      >
                        {tr("置顶")}
                      </antd.Tag>
                    ) : null}
                    {c.archived ? (
                      <antd.Tag style={{ marginInlineEnd: 0, flexShrink: 0 }}>
                        {tr("已归档")}
                      </antd.Tag>
                    ) : null}
                    <antd.Button
                      size="small"
                      type="link"
                      style={{
                        padding: "0 2px",
                        color: "#52c41a",
                        fontSize: 12,
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                      }}
                      onClick={(e: ReactNS.MouseEvent) => {
                        e.stopPropagation();
                        void openChat(c.id);
                      }}
                    >
                      {tr("查看")}
                    </antd.Button>
                  </div>
                  <div
                    style={{
                      fontSize: 10.5,
                      fontFamily:
                        "ui-monospace, SFMono-Regular, Consolas, monospace",
                      color: "rgba(127,127,127,0.85)",
                      wordBreak: "break-all",
                      marginTop: 3,
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      gap: "2px 10px",
                    }}
                  >
                    <span>{c.session_id || c.id}</span>
                    {c.channel ? (
                      <antd.Tag
                        color={CHANNEL_COLORS[c.channel] || "default"}
                        style={{ marginInlineEnd: 0, fontFamily: "inherit" }}
                      >
                        {CHANNEL_LABELS[c.channel] || c.channel}
                      </antd.Tag>
                    ) : null}
                    {c.updated_at ? (
                      <span style={{ fontFamily: "inherit" }}>
                        {formatTime(c.updated_at)}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      )}
    </div>
  );
}

// WorkerChats 是十一面板中唯一未包 memo 的
// ——被 RoomChat 重渲连带放大（抽屉开着时 groupTurns 重分组+会话卡
// 全重渲）。props 已稳定（workers=useMemo、回调 useCallback）→ memo 生效。
export default React.memo(WorkerChats);
