/**
 * 💬 会话（v0.5.0-beta.13.1，消费上游 #1295，issue #1293）。
 *
 * 给 AgentTeams 里的无头 QwenPaw Worker「补头」：用户经 AgentTeams 即可
 * 看见 Worker 的 QwenPaw 会话（列表 → agent 上下文详情，只读）。
 *
 * 位置：「👷 团队管理」tab 内的子节（与频道接入/内置工具同款）。
 * 数据面：Controller 会话端点（#1295，room 级 L2 参与边界）——
 *   GET /workers/{name}/chats[/{id}[/status]]
 * 走既有通用 Controller 代理（后端零新端点）。
 *
 * 纪律（#1293 数据敏感性定案）：
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

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

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

function formatTs(ts?: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function WorkerChats({ workers }: { workers: WorkerInfo[] }) {
  const tr = useT();
  const [sel, setSel] = React.useState("");
  const [gate, setGate] = React.useState<"" | "404" | "err">("");
  const [gateMsg, setGateMsg] = React.useState("");
  const [chats, setChats] = React.useState<WorkerChatSpec[]>([]);
  const [loading, setLoading] = React.useState(false);

  const [openId, setOpenId] = React.useState<string | null>(null);
  const [msgs, setMsgs] = React.useState<WorkerChatMessage[]>([]);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailErr, setDetailErr] = React.useState("");
  const [status, setStatus] = React.useState<"" | "idle" | "running">("");

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
        setDetailErr(
          e instanceof Error ? e.message : tr("加载失败"),
        );
    } finally {
      setDetailLoading(false);
    }
  };

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

  const columns = [
    {
      title: tr("会话"),
      dataIndex: "name",
      key: "name",
      render: (_: unknown, c: WorkerChatSpec) => (
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span>{c.name || c.id.slice(0, 8)}</span>
          {c.pinned ? <antd.Tag>{tr("置顶")}</antd.Tag> : null}
          {c.archived ? <antd.Tag color="default">{tr("已归档")}</antd.Tag> : null}
        </span>
      ),
    },
    { title: tr("通道"), dataIndex: "channel", key: "channel", width: 100, render: (v?: string) => v ?? "-" },
    {
      title: tr("最后活动"),
      dataIndex: "updated_at",
      key: "updated_at",
      width: 170,
      render: (v?: string) => formatTs(v) || "-",
    },
    {
      title: "",
      key: "op",
      width: 60,
      render: (_: unknown, c: WorkerChatSpec) => (
        <antd.Button
          size="small"
          type={openId === c.id ? "primary" : "default"}
          onClick={() => void openChat(c.id)}
        >
          {tr("查看")}
        </antd.Button>
      ),
    },
  ];

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
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
        <div style={{ flex: 1 }} />
        <antd.Button size="small" onClick={() => void load()} loading={loading}>
          {tr("刷新")}
        </antd.Button>
      </div>

      <antd.Table
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={chats}
        pagination={false}
        locale={{ emptyText: tr("当前账号在此 Worker 的可见范围内没有会话（L2 仅自己所在房间）") }}
      />

      {openId ? (
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 600, fontFamily: "monospace" }}>{openId}</span>
            {status === "running" ? <antd.Tag color="blue">running</antd.Tag> : null}
            {status === "idle" ? <antd.Tag>idle</antd.Tag> : null}
            <div style={{ flex: 1 }} />
            <antd.Button size="small" onClick={() => setOpenId(null)}>
              {tr("关闭")}
            </antd.Button>
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
            <div style={{ maxHeight: 360, overflowY: "auto", display: "grid", gap: 6 }}>
              {detailLoading ? (
                <antd.Spin size="small" />
              ) : msgs.length === 0 ? (
                <antd.Alert type="info" showIcon message={tr("该会话暂无消息")} />
              ) : (
                msgs.map((m, i) => {
                  const blocks = Array.isArray(m.content)
                    ? m.content.map(renderContentBlock)
                    : [renderContentBlock(m.content)];
                  return (
                    <div
                      key={m.id ?? i}
                      style={{ border: "1px solid rgba(127,127,127,0.25)", borderRadius: 6, padding: "6px 8px" }}
                    >
                      <div
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          textTransform: "uppercase",
                          color: "rgba(127,127,127,0.9)",
                          marginBottom: 2,
                        }}
                      >
                        {m.role || m.type || "message"}
                      </div>
                      {blocks
                        .filter((b) => b.length > 0)
                        .map((b, j) => (
                          <div key={j} style={{ fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                            {b}
                          </div>
                        ))}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default WorkerChats;
