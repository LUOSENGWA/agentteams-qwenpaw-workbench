/** HomePage 子模块——自 HomePage.tsx 纯搬移拆出
 * （行为零变化）。 */
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { PRIMARY, type NewTaskTarget } from "./HomePageShared";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

      {/* 发起任务 · 选择 Leader（入口 B Leader 默认 / 入口 A Manager 跨团队） */}
export function NewTaskModal({
  open,
  targets,
  sel,
  treeSource,
  onSel,
  onClose,
  onConfirm,
}: {
  open: boolean;
  targets: NewTaskTarget[];
  sel: string;
  treeSource: string;
  onSel: (v: string) => void;
  onClose: () => void;
  /** 确认发起：tgt + 房间显示名。异步（等 /dm 落地）——loading 期间
   * 按钮禁用，防双击建双房；成败由调用方 toast（失败不静默），
   * 结束后关窗。 */
  onConfirm: (tgt: NewTaskTarget, dmName: string) => Promise<void> | void;
}) {
  const t = useThemeColors();
  const tr = useT();
  const [confirming, setConfirming] = React.useState(false);
  return (
      <antd.Modal
        open={open}
        title={tr("发起任务 · 选择 Leader")}
        onCancel={() => {
          if (!confirming) onClose();
        }}
        footer={
          <antd.Space>
            <antd.Button
              onClick={onClose}
              disabled={confirming}
            >
              {tr("取消")}
            </antd.Button>
            <antd.Button
              type="primary"
              disabled={!sel}
              loading={confirming}
              onClick={async () => {
                const tgt = targets.find((x) => x.key === sel);
                if (!tgt || confirming) return;
                // DM 房间显示名（后端建房写入 m.room.name——无名空房间
                // 根因修复）：发起任务上下文 = 团队 + Worker 名；
                // 拿不到 team 就只带 Worker 名。
                const dmName = tgt.team
                  ? tr("私聊 · {team} · {name}", { team: tgt.team, name: tgt.label })
                  : tr("私聊 · {name}", { name: tgt.label });
                setConfirming(true);
                try {
                  await onConfirm(tgt, dmName);
                } finally {
                  setConfirming(false);
                }
              }}
            >
              {tr("发起任务")}
            </antd.Button>
          </antd.Space>
        }
      >
        {treeSource === "room-fallback" ? (
          <antd.Alert
            type="info"
            showIcon
            style={{ marginBottom: 10 }}
            message={tr(
              "团队 Leader 列表不可用（Controller 未接入）——以下为 Manager 入口（跨团队）",
            )}
          />
        ) : null}
        {targets.length === 0 ? (
          <div style={{ fontSize: 12, color: t.textSecondary, padding: "8px 0" }}>
            {tr("未找到 Leader（团队结构未加载或 Controller 未接入）。请先到配置页检查 Controller 连接，再重新打开本弹窗。")}
          </div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {targets.map((tgt) => {
              const isSel = sel === tgt.key;
              return (
                <div
                  key={tgt.key}
                  onClick={() => onSel(tgt.key)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    border: `1px solid ${isSel ? PRIMARY : t.border}`,
                    background: isSel ? `color-mix(in srgb, ${PRIMARY} 8%, transparent)` : "transparent",
                    borderRadius: 8,
                    padding: "10px 12px",
                    cursor: "pointer",
                  }}
                >
                  <span
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: "50%",
                      border: `2px solid ${isSel ? PRIMARY : t.border}`,
                      background: isSel ? PRIMARY : "transparent",
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: t.text }}>
                      {tgt.label}
                      {tgt.crossTeam ? (
                        <span style={{ fontSize: 10, color: PRIMARY, marginLeft: 8 }}>
                          {tr("跨团队入口")}
                        </span>
                      ) : null}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: t.textSecondary,
                        marginTop: 2,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {tgt.team} · {tgt.mxid}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </antd.Modal>
  );
}
