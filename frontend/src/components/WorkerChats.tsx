/**
 * 💬 会话（v0.5.0-beta.13.1 消费上游 #1295，issue #1293；
 * v0.5.0-beta.13.4 查看窗口重做——QwenPaw 原始输出口径）。
 *
 * 给 AgentTeams 里的无头 QwenPaw Worker「补头」：用户经 AgentTeams 即可
 * 看见 Worker 的 QwenPaw 会话（列表 → 完整 session，只读）。
 *
 * 位置：群内 Worker 头像点击 → 抽屉（RoomChat）。
 * 数据面：Controller 会话端点（#1295，room 级 L2 参与边界）——
 *   GET /workers/{name}/chats[/{id}[/status]]
 * 走既有通用 Controller 代理（后端零新端点）。
 *
 * v0.5.0-beta.13.4 口径（装验反馈：「查看会话的窗口参考 QwenPaw，
 * 因为这是 QwenPaw 的原始输出」）——逐条对齐 QwenPaw console
 * Control/Sessions 页（session 数据模型=QwenPaw ChatSpec 同构）：
 * - 列表：Active/Archived 双 tab（带计数）+ QwenPaw 同语义列
 *   （Name/Channel 彩色 Tag/UserID/UpdatedAt 可排序默认倒序；
 *   SessionID 与 CreatedAt 移入详情头——抽屉 560px 宽度适配）；
 *   Channel 色板逐值抄 QwenPaw constants/channel.ts CHANNEL_COLORS。
 * - 详情：QwenPaw /chat/{id} 会话口径——user 右气泡、assistant 左
 *   markdown（插件 MdText 同款零依赖渲染）、工具块紧凑标签、system
 *   居中；元信息行 = QwenPaw session 卡 meta（ID/User/Created/Updated）。
 *
 * 纪律（#1293 数据敏感性定案，不变）：
 * - detail = **agent 上下文**——可能含压缩历史/未发送工具调用输出，
 *   与实发房间消息不同，详情头部恒显蓝色标注。
 * - L2 只见自己所在 Matrix 房间的会话（服务端强制）；越权统一 404
 *   （W8 不可探测）→ 整节占位说明，不渲染空列表。
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
import MdText from "./MdText";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

/** QwenPaw console constants/channel.ts CHANNEL_COLORS 逐值抄录
 *  （会话通道色板与 QwenPaw 原生会话页一致）。 */
const CHANNEL_COLORS: Record<string, string> = {
  imessage: "geekblue",
  discord: "blue",
  dingtalk: "green",
  feishu: "volcano",
  qq: "gold",
  telegram: "geekblue",
  slack: "purple",
  mattermost: "purple",
  mqtt: "orange",
  console: "green",
  matrix: "red",
  voice: "geekblue",
  sip: "cyan",
  wecom: "olive",
  xiaoyi: "cyan",
  yuanbao: "lime",
};

/** QwenPaw Control/Sessions formatTime 同款：无时区后缀按 UTC 归一化，
 *  zh-CN 数字日期格式。 */
function formatTime(ts?: string | number | null): string {
  if (ts === null || ts === undefined || ts === "") return "-";
  let normalized = ts;
  if (typeof ts === "string" && !/[Z+\-]\d{2}:?\d{2}$/.test(ts)) {
    normalized = ts + "Z";
  }
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return String(ts);
  try {
    return d.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return d.toLocaleString();
  }
}

/** content 块保守渲染（契约 extra=allow）：文本直出，工具块压成标签。 */
function renderContentBlock(block: unknown): string {
  if (typeof block === "string") return block;
  if (block && typeof block === "object") {
    const b = block as Record<string, unknown>;
    if (typeof b.text === "string") return b.text;
    const name =
      typeof b.name === "string"
        ? b.name
        : typeof b.tool_name === "string"
          ? b.tool_name
          : typeof b.type === "string" && String(b.type).startsWith("tool")
            ? String(b.type)
            : "";
    if (name) return `🔧 ${name}`;
    try {
      const s = JSON.stringify(b);
      return s.length > 200 ? `${s.slice(0, 200)}…` : s;
    } catch {
      return "[不可序列化的内容块]";
    }
  }
  return String(block ?? "");
}

/** 消息角色分类（QwenPaw 会话原始输出口径）：user 右气泡 /
 *  assistant 左 markdown / 工具块标签 / 其余（system 等）居中提示。 */
function classifyMessage(m: WorkerChatMessage): {
  kind: "user" | "assistant" | "system";
  textBlocks: string[];
  toolBlocks: string[];
} {
  const role = String(m.role || m.type || "").toLowerCase();
  const raw = Array.isArray(m.content)
    ? m.content.map(renderContentBlock)
    : [renderContentBlock(m.content)];
  const textBlocks: string[] = [];
  const toolBlocks: string[] = [];
  for (const b of raw) {
    if (!b) continue;
    if (b.startsWith("🔧 ")) toolBlocks.push(b);
    else textBlocks.push(b);
  }
  const kind: "user" | "assistant" | "system" =
    role === "user" ? "user" : role === "assistant" ? "assistant" : "system";
  return { kind, textBlocks, toolBlocks };
}

/**
 * v0.5.0-beta.13.1（9/19 入口迁移）：`fixedWorker` = 头像抽屉模式——
 * 锁定单个 Worker（跳过选择器）。
 */
function WorkerChats({
  workers,
  fixedWorker,
}: {
  workers: WorkerInfo[];
  fixedWorker?: string;
}) {
  const tr = useT();
  const [sel, setSel] = React.useState(fixedWorker ?? "");
  const [gate, setGate] = React.useState<"" | "404" | "err">("");
  const [gateMsg, setGateMsg] = React.useState("");
  const [chats, setChats] = React.useState<WorkerChatSpec[]>([]);
  const [loading, setLoading] = React.useState(false);

  // v0.5.0-beta.13.4：QwenPaw 会话页同款 Active/Archived 双 tab。
  const [tab, setTab] = React.useState<"active" | "archived">("active");

  const [openId, setOpenId] = React.useState<string | null>(null);
  const [msgs, setMsgs] = React.useState<WorkerChatMessage[]>([]);
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
    // 状态灯与详情并发拉取；404 = 旧 runtime，隐藏灯
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

  // 详情加载完滚到底（会话口径：最新在下）。
  React.useEffect(() => {
    if (!detailLoading && openId && detailListRef.current) {
      const el = detailListRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [detailLoading, openId, msgs]);

  if (workers.length === 0) {
    return <antd.Alert type="info" showIcon message={tr("无 Worker")} />;
  }

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
  const list = tab === "active" ? active : archived;
  const openChatSpec = openId
    ? chats.find((c) => c.id === openId)
    : undefined;

  // ── 详情视图（QwenPaw /chat/{id} 口径：列表让位，← 返回列表）──────
  if (openId) {
    return (
      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <antd.Button
            size="small"
            icon={<span>←</span>}
            onClick={() => setOpenId(null)}
          >
            {tr("会话列表")}
          </antd.Button>
          <span style={{ fontWeight: 600, fontSize: 13.5 }}>
            {openChatSpec?.name || openId.slice(0, 12)}
          </span>
          {status === "running" ? (
            <antd.Tag color="blue" style={{ marginInlineEnd: 0 }}>
              running
            </antd.Tag>
          ) : null}
          {status === "idle" ? (
            <antd.Tag style={{ marginInlineEnd: 0 }}>idle</antd.Tag>
          ) : null}
          {openChatSpec?.channel ? (
            <antd.Tag
              color={CHANNEL_COLORS[openChatSpec.channel] || "default"}
              style={{ marginInlineEnd: 0 }}
            >
              {openChatSpec.channel}
            </antd.Tag>
          ) : null}
        </div>
        {/* QwenPaw session 卡 meta 行：ID / User / Created / Updated */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "2px 14px",
            fontSize: 11,
            color: "rgba(127,127,127,0.95)",
          }}
        >
          <span style={{ fontFamily: "monospace" }}>
            ID: {openChatSpec?.session_id || openId}
          </span>
          {openChatSpec?.user_id ? <span>User: {openChatSpec.user_id}</span> : null}
          {openChatSpec?.created_at ? (
            <span>Created: {formatTime(openChatSpec.created_at)}</span>
          ) : null}
          {openChatSpec?.updated_at ? (
            <span>Updated: {formatTime(openChatSpec.updated_at)}</span>
          ) : null}
        </div>
        <antd.Alert
          type="info"
          showIcon
          message={tr(
            "Agent 上下文视图——可能含压缩历史与未发送的工具调用/输出，与实发房间消息不同。",
          )}
        />
        {detailErr ? (
          <antd.Alert type="error" showIcon message={detailErr} />
        ) : (
          <div
            ref={detailListRef}
            style={{
              border: "1px solid rgba(127,127,127,0.25)",
              borderRadius: 8,
              padding: 10,
              maxHeight: 420,
              overflowY: "auto",
              background: "rgba(127,127,127,0.05)",
              display: "grid",
              gap: 8,
              alignContent: "end",
            }}
          >
            {detailLoading ? (
              <antd.Spin size="small" />
            ) : msgs.length === 0 ? (
              <antd.Alert type="info" showIcon message={tr("该会话暂无消息")} />
            ) : (
              msgs.map((m, i) => {
                const c = classifyMessage(m);
                if (c.kind === "user") {
                  return (
                    <div key={m.id ?? i} style={{ display: "flex", justifyContent: "flex-end" }}>
                      <div
                        style={{
                          maxWidth: "86%",
                          background: "rgba(255,127,22,0.14)",
                          border: "1px solid rgba(255,127,22,0.35)",
                          borderRadius: "10px 2px 10px 10px",
                          padding: "6px 10px",
                          fontSize: 12.5,
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                        }}
                      >
                        {c.textBlocks.join("\n")}
                        {c.toolBlocks.length > 0 ? (
                          <div style={{ marginTop: 4, fontSize: 11, opacity: 0.75 }}>
                            {c.toolBlocks.join(" ")}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                }
                if (c.kind === "system") {
                  return (
                    <div
                      key={m.id ?? i}
                      style={{
                        textAlign: "center",
                        fontSize: 11,
                        color: "rgba(127,127,127,0.9)",
                      }}
                    >
                      {c.toolBlocks.join(" ") || c.textBlocks.join("\n") || m.role || m.type || "…"}
                    </div>
                  );
                }
                return (
                  <div key={m.id ?? i} style={{ display: "flex", justifyContent: "flex-start" }}>
                    <div
                      style={{
                        maxWidth: "92%",
                        background: "rgba(255,255,255,0.75)",
                        border: "1px solid rgba(127,127,127,0.22)",
                        borderRadius: "2px 10px 10px 10px",
                        padding: "6px 10px",
                      }}
                    >
                      {c.toolBlocks.length > 0 ? (
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: 4,
                            marginBottom: c.textBlocks.length > 0 ? 6 : 0,
                          }}
                        >
                          {c.toolBlocks.map((b, j) => (
                            <antd.Tag key={j} style={{ marginInlineEnd: 0, fontSize: 10.5 }}>
                              {b}
                            </antd.Tag>
                          ))}
                        </div>
                      ) : null}
                      {c.textBlocks.map((b, j) => (
                        // QwenPaw assistant 文本=markdown 渲染（原始输出原样）。
                        <MdText key={j} text={b} maxLength={4000} />
                      ))}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    );
  }

  // ── 列表视图（QwenPaw Control/Sessions 同语义列）────────────────
  const columns = [
    {
      title: tr("会话"),
      dataIndex: "name",
      key: "name",
      width: 150,
      render: (_: unknown, c: WorkerChatSpec) => (
        <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontWeight: 500,
            }}
            title={c.name || c.id}
          >
            {c.name || c.id.slice(0, 10)}
          </span>
          {c.pinned ? <antd.Tag color="gold" style={{ marginInlineEnd: 0 }}>{tr("置顶")}</antd.Tag> : null}
        </span>
      ),
    },
    {
      // QwenPaw Channel 列：彩色 Tag（CHANNEL_COLORS 逐值抄录）。
      title: tr("通道"),
      dataIndex: "channel",
      key: "channel",
      width: 90,
      render: (v?: string) =>
        v ? (
          <antd.Tag color={CHANNEL_COLORS[v] || "default"} style={{ marginInlineEnd: 0 }}>
            {v}
          </antd.Tag>
        ) : (
          "-"
        ),
    },
    {
      title: tr("用户"),
      dataIndex: "user_id",
      key: "user_id",
      width: 90,
      render: (v?: string) =>
        v ? (
          <span
            style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            title={v}
          >
            {v.split(":")[0].replace(/^@/, "")}
          </span>
        ) : (
          "-"
        ),
    },
    {
      // QwenPaw UpdatedAt 列：可排序、默认倒序。
      title: tr("最后活动"),
      dataIndex: "updated_at",
      key: "updated_at",
      width: 140,
      defaultSortOrder: "descend" as const,
      sorter: (a: WorkerChatSpec, b: WorkerChatSpec) =>
        String(a.updated_at || "").localeCompare(String(b.updated_at || "")),
      render: (v?: string) => (
        <span style={{ fontSize: 11 }}>{formatTime(v)}</span>
      ),
    },
    {
      title: "",
      key: "op",
      width: 58,
      render: (_: unknown, c: WorkerChatSpec) => (
        // QwenPaw Action 列 View=绿色 link 按钮（#52c41a）。
        <antd.Button
          size="small"
          type="link"
          style={{ padding: 0, color: "#52c41a", fontSize: 12 }}
          onClick={() => void openChat(c.id)}
        >
          {tr("查看")}
        </antd.Button>
      ),
    },
  ];

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
        <antd.Button size="small" onClick={() => void load()} loading={loading}>
          {tr("刷新")}
        </antd.Button>
      </div>

      <antd.Tabs
        size="small"
        activeKey={tab}
        onChange={(k: string) => {
          setTab(k === "archived" ? "archived" : "active");
          setOpenId(null);
        }}
        items={[
          { key: "active", label: `${tr("活跃")} (${active.length})` },
          { key: "archived", label: `${tr("已归档")} (${archived.length})` },
        ]}
      />

      <antd.Table
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={list}
        pagination={false}
        scroll={{ x: 500 }}
        locale={{
          emptyText:
            tab === "active"
              ? tr("当前账号在此 Worker 的可见范围内没有活跃会话（L2 仅自己所在房间）")
              : tr("没有已归档会话"),
        }}
      />
    </div>
  );
}

export default WorkerChats;
