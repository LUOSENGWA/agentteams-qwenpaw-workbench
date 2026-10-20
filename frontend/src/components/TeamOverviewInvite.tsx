/** TeamOverview 子模块——自 TeamOverview.tsx 纯搬移拆出
 * （行为零变化）。 */
import { MailIcon } from "./icons";
import { acceptInvite, rejectInvite, type InviteRoom } from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { formatChatTime } from "../util";
import { CARD_RADIUS, memberShortName } from "./TeamOverviewShared";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

/** 邀请区（Element 同款邀请交互）。
 * 数据=/sync rooms.invite 段（后端 _parse_sync_rooms 解析）；
 * 接受=POST /rooms/{id}/invite/{userId}/accept，拒绝=POST /rooms/{id}/leave
 * （CS-API v3 标准端点，走通用代理零新后端；Element matrix-js-sdk
 * joinRoom 对 invite 房间内部走同一条 accept 路径）。
 * 操作成功后 onInviteSettled（父组件 force 重同步——绕过 60s 缓存，
 * 接受的房间立即进团队群/私聊列表）。 */
export function InviteSection(props: {
  invites: InviteRoom[];
  onSettled?: () => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  const { invites, onSettled } = props;
  const [busy, setBusy] = React.useState<
    Record<string, "accept" | "reject">
  >({});

  const run = async (
    room: InviteRoom,
    kind: "accept" | "reject",
  ) => {
    setBusy((prev) => ({ ...prev, [room.room_id]: kind }));
    try {
      if (kind === "accept") {
        // 修复：homeserver（Tuwunel 系）不识别 /invite/{uid}/accept，
        // 按 spec 受邀者 join = 接受邀请（join 端点已实锤可用）。
        await acceptInvite(room.room_id);
        antd.message.success(tr("已接受邀请，正在进入房间列表"));
      } else {
        await rejectInvite(room.room_id);
        antd.message.success(tr("已拒绝邀请"));
      }
      onSettled?.();
    } catch (e) {
      antd.message.error(
        `${kind === "accept" ? tr("接受邀请失败") : tr("拒绝邀请失败")}${
          e instanceof Error ? `：${e.message}` : ""
        }`,
      );
    } finally {
      setBusy((prev) => {
        const next = { ...prev };
        delete next[room.room_id];
        return next;
      });
    }
  };

  return (
    <div
      style={{
        display: "grid",
        gap: 8,
        padding: 12,
        borderRadius: CARD_RADIUS,
        border: `1px solid color-mix(in srgb, var(--app-accent, #FF7F16) 40%, transparent)`,
        background: "color-mix(in srgb, var(--app-accent, #FF7F16) 5%, transparent)",
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 13 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><MailIcon size={13} /> {tr("邀请（{n}）", { n: invites.length })}</span>
      </div>
      {invites.map((inv) => {
        const state = busy[inv.room_id];
        const inviterName = inv.inviter
          ? memberShortName(inv.inviter)
          : "—";
        return (
          <div
            key={inv.room_id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 12px",
              borderRadius: 8,
              border: `1px solid ${t.border}`,
              background: t.popoverBg,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontWeight: 600,
                  fontSize: 14,
                  // 邀请房间名自动换行防省略号丢信息。
                  whiteSpace: "normal",
                  wordBreak: "break-word",
                }}
              >
                {inv.name}
              </div>
              <div style={{ fontSize: 12, color: t.textSecondary, whiteSpace: "normal", wordBreak: "break-word" }}>
                {tr("邀请人：")} {inviterName}
                {inv.inviter_ts ? ` · ${formatChatTime(inv.inviter_ts)}` : ""}
              </div>
            </div>
            <antd.Popconfirm
              title={tr("拒绝邀请「{name}」？（系统团队房间可能被 Controller 调和器自动重新邀请）", {
                name: inv.name,
              })}
              okText={tr("拒绝")}
              cancelText={tr("返回")}
              onConfirm={() => void run(inv, "reject")}
              disabled={state !== undefined}
            >
              <antd.Button
                size="small"
                danger
                type="text"
                loading={state === "reject"}
                disabled={state === "accept"}
              >
                {tr("拒绝")}
              </antd.Button>
            </antd.Popconfirm>
            <antd.Button
              size="small"
              type="primary"
              loading={state === "accept"}
              disabled={state === "reject"}
              onClick={() => void run(inv, "accept")}
            >
              {tr("接受")}
            </antd.Button>
          </div>
        );
      })}
    </div>
  );
}
