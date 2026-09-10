import { fetchMemberMessages, type MemberMessage } from "../api";
import { useAvatarUrl } from "../useAvatar";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import ApprovalControl from "./ApprovalControl";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

const PRIMARY = "#FF7F16";

const ROLE_LABEL: Record<string, string> = {
  leader: "领",
  worker: "工",
  critic: "审",
  unknown: "成员",
};

const ROLE_COLOR: Record<string, string> = {
  leader: "#fa8c16",
  worker: "#1677ff",
  critic: "#52c41a",
  unknown: "#999",
};

function formatWhen(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hh}:${mm}`;
}

export interface MemberDetailProps {
  mxid: string;
  displayName: string;
  avatarUrl?: string;
  /** 角色（领/工/审/成员）：从 Worker 树推断，未知时不显示。 */
  role?: string;
  /**
   * Worker 容器名（Worker 树正源映射）：提供时显示「工具执行安全」
   * 审批卡（5.0.0-beta.3：聊天房间页也可改审批模式）。人类成员无此映射。
   */
  workerName?: string;
  /** 所在房间（最近消息扫描范围）。 */
  roomId?: string;
  roomName?: string;
  /** 打开/创建与该成员的私聊。 */
  onDm?: (mxid: string) => void;
  /** 在当前房间输入框插入 @提及（5.0.0-beta.4）。 */
  onMention?: (mxid: string) => void;
  onClose: () => void;
}

/** 成员详情卡（B4，§6.6）：头像/身份/角色 + 房间内最近消息 + DM。 */
export default function MemberDetail(props: MemberDetailProps) {
  const {
    mxid,
    displayName,
    avatarUrl,
    role,
    workerName,
    roomId,
    roomName,
    onDm,
    onMention,
    onClose,
  } = props;
  const t = useThemeColors();
  const tr = useT();
  const [messages, setMessages] = React.useState<MemberMessage[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  // v0.4.98 再版 11: mxc 头像走 blob objectURL（裂图修，8 处之一）。
  const avatarSrc = useAvatarUrl(avatarUrl);

  React.useEffect(() => {
    if (!roomId) return;
    let alive = true;
    setLoading(true);
    setError("");
    fetchMemberMessages(roomId, mxid, 5)
      .then((res) => {
        if (alive) setMessages(res.messages || []);
      })
      .catch((e) => {
        if (alive)
          setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [roomId, mxid]);

  const roleLabel = role ? tr(ROLE_LABEL[role] || role) : null;
  const roleColor = role ? ROLE_COLOR[role] || "#999" : "#999";

  return (
    <antd.Drawer
      open
      onClose={onClose}
      width={360}
      title={tr("成员详情")}
      styles={{ body: { padding: 14, background: t.bg } }}
    >
      {/* 身份区 */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <antd.Avatar
          size={48}
          src={avatarSrc}
          style={{ backgroundColor: PRIMARY, fontSize: 20 }}
        >
          {displayName.slice(0, 1).toUpperCase()}
        </antd.Avatar>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, fontSize: 15, color: t.text }}>
              {displayName}
            </span>
            {roleLabel ? (
              <antd.Tag color={roleColor} style={{ margin: 0 }}>
                {roleLabel}
              </antd.Tag>
            ) : null}
          </div>
          <div
            style={{
              color: t.textSecondary,
              fontSize: 12,
              wordBreak: "break-all",
              marginTop: 2,
            }}
          >
            {mxid}
          </div>
        </div>
      </div>

      {/* 操作 */}
      <div style={{ display: "flex", gap: 8, margin: "12px 0", flexWrap: "wrap" }}>
        {onDm ? (
          <antd.Button
            size="small"
            type="primary"
            style={{ backgroundColor: PRIMARY, borderColor: PRIMARY }}
            onClick={() => {
              onDm(mxid);
              onClose();
            }}
          >
            💬 {tr("私聊")}
          </antd.Button>
        ) : null}
        {onMention ? (
          <antd.Button
            size="small"
            onClick={() => {
              onMention(mxid);
              onClose();
            }}
          >
            @{tr("提及")}
          </antd.Button>
        ) : null}
      </div>

      {/* 工具执行安全（5.0.0-beta.3：房间页成员卡也可改审批模式） */}
      {workerName ? (
        <div style={{ margin: "12px 0" }}>
          <ApprovalControl workerName={workerName} />
        </div>
      ) : null}

      {/* 最近消息 */}
      <div
        style={{
          fontSize: 12.5,
          fontWeight: 700,
          color: t.textSecondary,
          margin: "10px 0 6px",
        }}
      >
        {tr("最近消息")}
        {roomName ? (
          <span style={{ fontWeight: 400, marginLeft: 6 }}>
            · {roomName}
          </span>
        ) : null}
      </div>
      {loading ? (
        <antd.Skeleton active paragraph={{ rows: 3 }} />
      ) : error ? (
        <div style={{ color: "#ff4d4f", fontSize: 12.5 }}>⚠️ {error}</div>
      ) : messages.length === 0 ? (
        <div style={{ color: t.textSecondary, fontSize: 12.5 }}>
          {tr("暂无消息")}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          {messages.map((m) => (
            <div
              key={m.event_id}
              style={{
                background: t.bubbleOther,
                borderRadius: 8,
                padding: "6px 10px",
                fontSize: 12.5,
                color: t.text,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              <div style={{ color: t.textSecondary, fontSize: 11, marginBottom: 2 }}>
                {formatWhen(m.origin_server_ts)}
              </div>
              {m.body.slice(0, 300)}
            </div>
          ))}
        </div>
      )}
    </antd.Drawer>
  );
}
