// 房间详情 Drawer（Element 同款房间详情面板）：房间 ID/主题/成员角色/设置。
// 数据源 = GET /agentteams-proxy/matrix/rooms/{roomId}/info（matrix_api
// 聚合 7 个 state 事件 + joined_members；角色映射后端完成，前端只渲染）。
// 退出房间复用现有 leave 链路（onLeaveRoom → handleLeaveRoom → setActiveRoom
// (null) → RoomChat 整体卸载，本 Drawer 随条件渲染自动关闭）。

import { InfoIcon, WarnIcon } from "./icons";
import { fetchRoomInfo, type RoomInfo, type RoomInfoMember } from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { copyText } from "../util";
import { MxcAvatar } from "../MxcAvatar";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const ROLE_LABEL: Record<RoomInfoMember["role"], string> = {
  owner: "Owner",
  moderator: "Moderator",
  member: "Member",
};
const ROLE_COLOR: Record<RoomInfoMember["role"], string> = {
  owner: "#fa8c16",
  moderator: "#1677ff",
  member: "#999",
};

interface RoomInfoDrawerProps {
  open: boolean;
  roomId: string;
  /** 房间列表名（info 未回时的名称兜底）。 */
  roomName: string;
  onClose: () => void;
  /** 退出房间（二次确认后触发；复用 /matrix/rooms/{id}/leave 链路）。 */
  onLeaveRoom?: () => void;
}

export default function RoomInfoDrawer(props: RoomInfoDrawerProps) {
  const { open, roomId, roomName, onClose, onLeaveRoom } = props;
  const t = useThemeColors();
  const tr = useT();
  const [info, setInfo] = React.useState<RoomInfo | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [reloadKey, setReloadKey] = React.useState(0);

  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setError("");
    fetchRoomInfo(roomId)
      .then((res) => {
        if (alive) setInfo(res);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, roomId, reloadKey]);

  const roleLabel = (r: RoomInfoMember["role"]) => tr(ROLE_LABEL[r]);
  const confirmLeave = () => {
    antd.Modal.confirm({
      title: tr("退出房间「{name}」？", { name: roomName }),
      content:
        tr("退出后不再接收该房间消息。系统团队房间可能被 Controller 调和器自动重新邀请；非系统房间需再次被邀请才能进入。"),
      okText: tr("退出"),
      okButtonProps: { danger: true },
      cancelText: tr("返回"),
      onOk: () => onLeaveRoom?.(),
    });
  };

  const name = info?.name || roomName || tr("未命名房间");

  return (
    <antd.Drawer
      open={open}
      onClose={onClose}
      width={380}
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <InfoIcon size={15} /> {tr("房间详情")}
        </span>
      }
      styles={{ body: { padding: 14 } }}
      footer={
        <div style={{ display: "flex", gap: 8 }}>
          <antd.Button
            size="small"
            onClick={() => setReloadKey((k) => k + 1)}
            disabled={loading}
          >
            {tr("刷新")}
          </antd.Button>
          {onLeaveRoom ? (
            <antd.Button size="small" danger onClick={confirmLeave}>
              {tr("退出房间")}
            </antd.Button>
          ) : null}
        </div>
      }
    >
      {loading && !info ? (
        <antd.Skeleton active paragraph={{ rows: 6 }} />
      ) : !info ? (
        // 空/错误态：加载失败（无数据可显）。
        <div style={{ display: "grid", gap: 8 }}>
          <div
            style={{
              color: "#ff4d4f",
              fontSize: 13,
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontWeight: 600,
            }}
          >
            <WarnIcon size={13} /> {tr("房间信息加载失败")}
          </div>
          <div style={{ color: t.textSecondary, fontSize: 12, wordBreak: "break-all" }}>
            {error}
          </div>
          <antd.Button size="small" onClick={() => setReloadKey((k) => k + 1)}>
            {tr("重试")}
          </antd.Button>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          {error ? (
            // 有旧数据 + 刷新失败：提示条（数据仍可视）。
            <div
              style={{
                background: "rgba(255,77,79,0.08)",
                border: "1px solid rgba(255,77,79,0.3)",
                borderRadius: 6,
                padding: "6px 10px",
                fontSize: 12,
                color: "#ff4d4f",
              }}
            >
              {tr("刷新失败")}：{error}
            </div>
          ) : null}

          {/* 名称 + 房间 ID（等宽小字 + 复制，排查「消息发到哪个房间」的核心）。 */}
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, color: t.text, wordBreak: "break-word" }}>
              {name}
            </div>
            <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 12, color: t.textSecondary, flexShrink: 0 }}>
                {tr("房间 ID")}
              </span>
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 12,
                  color: t.text,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1,
                  minWidth: 0,
                }}
                title={roomId}
              >
                {roomId}
              </span>
              <antd.Button
                size="small"
                type="text"
                title={tr("复制房间 ID")}
                onClick={() =>
                  copyText(roomId, (ok) => {
                    if (ok) {
                      antd.message.success(tr("已复制到剪贴板"));
                    } else {
                      antd.message.error(tr("复制失败"));
                    }
                  })
                }
              >
                {tr("复制")}
              </antd.Button>
            </div>
          </div>

          {/* 主题（空显 —）。 */}
          <div style={{ display: "flex", gap: 8 }}>
            <span style={{ fontSize: 12, color: t.textSecondary, flexShrink: 0 }}>
              {tr("主题")}
            </span>
            <span style={{ fontSize: 12.5, color: t.text, wordBreak: "break-word" }}>
              {info.topic || "—"}
            </span>
          </div>

          {/* 成员（头像/名字/角色标签/MXID；空 = 暂无成员）。 */}
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: t.textSecondary, margin: "0 0 6px" }}>
              {tr("成员")}（{info.member_count} {tr("人")}）
            </div>
            {info.members.length === 0 ? (
              <div style={{ color: t.textSecondary, fontSize: 12.5 }}>
                {tr("暂无成员")}
              </div>
            ) : (
              <div style={{ display: "grid", gap: 6 }}>
                {info.members.map((m) => {
                  const label = m.display_name || m.user_id;
                  return (
                    <div
                      key={m.user_id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "4px 6px",
                        borderRadius: 8,
                      }}
                    >
                      <MxcAvatar url={m.avatar_url} size={30}>
                        {label.slice(0, 1).toUpperCase()}
                      </MxcAvatar>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            fontWeight: 600,
                            fontSize: 13,
                            color: t.text,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {label}
                          {m.role !== "member" ? (
                            <antd.Tag color={ROLE_COLOR[m.role]} style={{ margin: 0 }}>
                              {roleLabel(m.role)}
                            </antd.Tag>
                          ) : null}
                        </div>
                        <div
                          style={{
                            fontFamily: MONO,
                            fontSize: 11,
                            color: t.textSecondary,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {m.user_id}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 设置（join rule / 加密 / 创建者——创建者有才显）。 */}
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: t.textSecondary, margin: "0 0 6px" }}>
              {tr("设置")}
            </div>
            <div style={{ display: "grid", gap: 4 }}>
              <div style={{ display: "flex", gap: 8 }}>
                <span style={{ fontSize: 12, color: t.textSecondary, flexShrink: 0 }}>
                  {tr("加入规则")}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 12.5, color: t.text }}>
                  {info.join_rule}
                </span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <span style={{ fontSize: 12, color: t.textSecondary, flexShrink: 0 }}>
                  {tr("加密")}
                </span>
                <span style={{ fontSize: 12.5, color: t.text }}>
                  {info.encrypted ? tr("已加密") : tr("未加密")}
                </span>
              </div>
              {info.creator ? (
                <div style={{ display: "flex", gap: 8 }}>
                  <span style={{ fontSize: 12, color: t.textSecondary, flexShrink: 0 }}>
                    {tr("创建者")}
                  </span>
                  <span
                    style={{
                      fontFamily: MONO,
                      fontSize: 12.5,
                      color: t.text,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {info.creator}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </antd.Drawer>
  );
}
