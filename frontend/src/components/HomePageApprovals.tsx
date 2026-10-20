/** HomePage 子模块——自 HomePage.tsx 纯搬移拆出
 * （行为零变化）。 */
import { CheckIcon, CloseIcon, ShieldIcon } from "./icons";
import type * as ReactNS from "react";
import { type RoomApproval } from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { formatTimeShort, sevColor as sevColorOf } from "../util";
import { CARD_RADIUS } from "./HomePageShared";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

      {/* 审批卡（房间审批源 /room-approvals=Worker Tool Guard 真实队列，
 30s 轮询；弃宿主 push-messages 死源） */}
export function ApprovalsCard({
  approvals,
  busy,
  onAction,
}: {
  approvals: RoomApproval[];
  busy: string;
  onAction: (action: "approve" | "deny", item: RoomApproval) => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  const cardStyle: ReactNS.CSSProperties = {
    borderRadius: CARD_RADIUS,
    background: t.cardBg,
    borderColor: t.border,
  };
  const cardBody: ReactNS.CSSProperties = { padding: 14 };
  return (
      <antd.Row gutter={[12, 12]}>
        <antd.Col span={24}>
          <antd.Card style={cardStyle} styles={{ body: cardBody }}>
            {/* 空态压缩为单行细条（此前空态也占整卡高度） */}
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: t.text }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><ShieldIcon size={14} /> {tr("待审批")}</span>
                {approvals.length > 0 && (
                  <span
                    style={{
                      display: "inline-block",
                      marginLeft: 8,
                      minWidth: 18,
                      textAlign: "center",
                      fontSize: 11,
                      color: "#fff",
                      background: "#fa8c16",
                      borderRadius: 9,
                      padding: "0 6px",
                      lineHeight: "18px",
                    }}
                  >
                    {approvals.length}
                  </span>
                )}
              </div>
              {approvals.length === 0 ? (
                <div style={{ fontSize: 11, color: t.textSecondary, flex: 1 }}>
                  {tr("暂无待审批请求")} · {tr("Worker 请求审批时会桌面通知提醒")}
                </div>
              ) : null}
            </div>
            {approvals.length === 0 ? null : (

              approvals.map((item) => {
                // 房间审批源是纯文本消息——severity/tool 从 body 解析
                // （RoomChat parseApproval 同款正则）。
                const sevMatch = /Severity\s*[:：]\s*(?:🔴|🟡|🟢|🟠)?\s*([A-Za-z]+)/i.exec(
                  item.body,
                );
                const toolMatch = /Tool\s*[:：]\s*`?([^`\n*]+?)`?[\s*]*(?:$|\n)/i.exec(
                  item.body,
                );
                const sev = sevMatch?.[1]?.toUpperCase() || "MEDIUM";
                const sevColor = sevColorOf(sev);
                const when = formatTimeShort(item.ts * 1000);
                const workerShort = (item.sender.split(":")[0] || "")
                  .replace(/^@/, "");
                const toolName = toolMatch?.[1]?.trim() || "";
                const summary = (item.body || "")
                  .replace(/\*\*/g, "")
                  .replace(/\s+/g, " ")
                  .trim();
                const key = item.event_id || item.room_id;
                return (
                  <div
                    key={key}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      flexWrap: "wrap",
                      padding: "8px 10px",
                      borderRadius: 8,
                      background: t.hoverBg,
                      marginTop: 8,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        color: sevColor,
                        flexShrink: 0,
                        width: 34,
                      }}
                    >
                      {sev}
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: t.text,
                        flexShrink: 0,
                        maxWidth: 180,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={toolName || item.room_name}
                    >
                      {toolName || item.room_name || item.room_id}
                    </span>
                    <span style={{ fontSize: 11, color: t.textSecondary, flexShrink: 0 }}>
                      @{workerShort} · {when}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        color: t.textSecondary,
                        flex: 1,
                        minWidth: 120,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={summary}
                    >
                      {summary.slice(0, 80)}
                    </span>
                    <antd.Button
                      size="small"
                      type="primary"
                      loading={busy === key}
                      onClick={() => void onAction("approve", item)}
                    >
                      <CheckIcon size={12} style={{ verticalAlign: "-1px", marginRight: 3 }} /> {tr("批准")}
                    </antd.Button>
                    <antd.Button
                      size="small"
                      danger
                      loading={busy === key}
                      onClick={() => void onAction("deny", item)}
                    >
                      <CloseIcon size={12} style={{ verticalAlign: "-1px", marginRight: 3 }} /> {tr("拒绝")}
                    </antd.Button>
                  </div>
                );
              })
            )}
          </antd.Card>
        </antd.Col>
      </antd.Row>
  );
}
