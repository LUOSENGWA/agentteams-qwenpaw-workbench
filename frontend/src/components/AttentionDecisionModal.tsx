// attention 决策弹窗（全局，一次一条、可上/下条）。
// 字段 = NMH §8 对齐：问题/kind 标签/任务标题状态/Worker/请求时间/期限
// 倒计时（expires_at，过期置灰）；有 options → 按钮组（suggested 加
// 「推荐」徽章，仅提示——绝不自动选中/提交）；无 options → A/B/C 快捷
// + 自定义文本（≤500）+ 可选依据。提交 = 以人类身份发 DECISION 行回任务
// 房间（后端去重 → 重复 409）。键盘：Enter 提交、Esc 关闭（发送中不关）。
// 成功标记 answered（本会话防重复提交）并关闭；失败展示错误不关。

import type * as ReactNS from "react";

import {
  answerAttention,
  resolveAttentionRoom,
  type AttentionItem,
} from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { statusVariant } from "./CodingRunsPanel";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
const icons = (host.antdIcons || {}) as Record<string, ReactNS.ComponentType>;
const EmptyIcon = (() => null) as unknown as ReactNS.FC<Record<string, unknown>>;
const pick = (name: string): ReactNS.FC<Record<string, unknown>> =>
  (icons[name] as ReactNS.FC<Record<string, unknown>>) || EmptyIcon;
const ClockIcon = pick("ClockCircleOutlined");

/** kind → 标签（复用既有 i18n 键：升级/其他）+ 保守 Tag 色。 */
const KIND_META: Record<string, { label: string; color: string }> = {
  approval: { label: "审批", color: "orange" },
  decision: { label: "决策", color: "blue" },
  escalation: { label: "升级", color: "red" },
  other: { label: "其他", color: "default" },
};

/** ISO(UTC) → 本地 "YYYY-MM-DD HH:MM:SS"；解析失败原样返回。 */
function fmtTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours(),
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 期限倒计时（expires_at → 剩余标签；过期 → expired=true）。 */
function countdown(
  expiresAt: string,
  now: number,
): { label: string; expired: boolean } {
  const ts = new Date(expiresAt).getTime();
  if (isNaN(ts)) return { label: "", expired: false };
  const diff = ts - now;
  if (diff <= 0) return { label: "", expired: true };
  const s = Math.floor(diff / 1000);
  if (s < 60) return { label: `${s}s`, expired: false };
  const m = Math.floor(s / 60);
  if (m < 60) return { label: `${m}m ${s % 60}s`, expired: false };
  const h = Math.floor(m / 60);
  return { label: `${h}h ${m % 60}m`, expired: false };
}

/** 本会话已答 key 集合（task_id:kind:attempt）——成功提交后即使聚合数据
 * 尚未刷新，重复打开同一项也不会二次发送（后端 409 是最后一道闸）。 */
const answeredKeys = new Set<string>();
const itemKey = (it: AttentionItem): string =>
  `${it.task_id}:${it.kind || "other"}:${it.attempt}`;

function Meta({ k, v, mono }: { k: string; v: ReactNS.ReactNode; mono?: boolean }) {
  const t = useThemeColors();
  return (
    <div
      style={{
        background: t.cardBg,
        border: `1px solid ${t.border}`,
        borderRadius: 8,
        padding: "6px 10px",
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: 11, color: t.textSecondary }}>{k}</div>
      <div
        style={{
          fontSize: 13,
          color: t.text,
          wordBreak: "break-all",
          fontFamily: mono ? "ui-monospace, monospace" : undefined,
        }}
      >
        {v}
      </div>
    </div>
  );
}

export function AttentionDecisionModal({
  open,
  items,
  index,
  onIndexChange,
  onClose,
  onAnswered,
}: {
  open: boolean;
  items: AttentionItem[];
  index: number;
  onIndexChange: (i: number) => void;
  onClose: () => void;
  /** 成功提交后回调（父级静默刷新聚合 → badge/列表即时更新）。 */
  onAnswered: () => void;
}) {
  const t = useThemeColors();
  const tr = useT();

  const clamped = items.length === 0 ? 0 : Math.min(Math.max(index, 0), items.length - 1);
  const item = items[clamped] || null;
  const key = item ? itemKey(item) : "";

  // 逐项独立状态——切项即重置。**selectedOption 初始恒 null**
  // （suggested 仅徽章提示，绝不自动选中/自动提交）。
  const [selectedOption, setSelectedOption] = React.useState<string | null>(null);
  const [freeText, setFreeText] = React.useState("");
  const [basis, setBasis] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState("");
  const [now, setNow] = React.useState(() => Date.now());
  const submitInFlightRef = React.useRef(false);

  React.useEffect(() => {
    setSelectedOption(null);
    setFreeText("");
    setBasis("");
    setError("");
  }, [key]);

  // 期限倒计时：open 期间 1s tick（单组件，成本可忽略）。
  React.useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  const options = item?.options || [];
  const hasOptions = options.length > 0;
  const alreadyAnswered = Boolean(item && answeredKeys.has(itemKey(item)));
  const cd = item?.expires_at ? countdown(item.expires_at, now) : null;
  const expired = Boolean(cd?.expired);
  const roomId = item ? item.room_id || resolveAttentionRoom(item) : "";
  const roomMissing = Boolean(item) && !roomId;

  const answerText = hasOptions ? selectedOption || "" : freeText.trim();
  const locked = alreadyAnswered || expired || sending;
  const canSubmit =
    Boolean(item) && !locked && !roomMissing && answerText.length > 0;

  const labelStyle: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 700,
    color: t.textSecondary,
    marginBottom: 6,
  };
  const errorStyle: React.CSSProperties = {
    padding: "10px 12px",
    borderRadius: 8,
    border: `1px solid ${t.border}`,
    color: "#e5484d",
    fontSize: 13,
  };

  async function trySubmit() {
    if (!item || submitInFlightRef.current || locked || roomMissing) return;
    const answer = hasOptions ? selectedOption : freeText.trim();
    if (!answer) return;
    submitInFlightRef.current = true;
    setSending(true);
    setError("");
    try {
      await answerAttention({
        room_id: item.room_id || resolveAttentionRoom(item),
        task_id: item.task_id,
        kind: item.kind,
        attempt: item.attempt,
        answer,
        basis: basis.trim() || undefined,
      });
      answeredKeys.add(itemKey(item));
      onAnswered();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("发送失败"));
    } finally {
      submitInFlightRef.current = false;
      setSending(false);
    }
  }

  // 键盘：Enter 提交（preventDefault 防焦点按钮二次触发）；
  // Esc 由 antd Modal 走 onCancel（发送中不关）。
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void trySubmit();
    }
  };

  const meta = item ? KIND_META[item.kind] || KIND_META.other : KIND_META.other;

  return (
    <antd.Modal
      open={open}
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {tr("待决策")}
          {item ? (
            <antd.Tag color={meta.color} style={{ marginRight: 0 }}>
              {tr(meta.label)}
            </antd.Tag>
          ) : null}
          {items.length > 0 ? (
            <span style={{ fontSize: 12, color: t.textSecondary, fontWeight: 400 }}>
              {clamped + 1}/{items.length}
            </span>
          ) : null}
        </span>
      }
      footer={null}
      onCancel={() => {
        if (!sending) onClose();
      }}
      width={640}
      styles={{ body: { maxHeight: "72vh", overflow: "auto", padding: 12 } }}
    >
      {!item ? (
        <antd.Empty
          description={tr("暂无待决策")}
          image={antd.Empty.PRESENTED_IMAGE_SIMPLE}
        />
      ) : (
        <div style={{ display: "grid", gap: 14 }} onKeyDown={onKeyDown}>
          {/* 问题 */}
          <div>
            <div style={labelStyle}>{tr("问题")}</div>
            <div
              style={{
                fontSize: 14,
                color: t.text,
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {item.question}
            </div>
          </div>

          {/* 任务/状态/Worker/请求时间（payload 有才显示，不伪造） */}
          {(item.task_title || item.task_status || item.worker || item.requested_at) && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))",
                gap: 8,
              }}
            >
              {item.task_title ? (
                <Meta k={tr("任务")} v={item.task_title} mono />
              ) : null}
              {item.task_status ? (
                <Meta
                  k={tr("状态")}
                  v={
                    <antd.Tag color={statusVariant(item.task_status)}>
                      {item.task_status}
                    </antd.Tag>
                  }
                />
              ) : null}
              {item.worker ? <Meta k="Worker" v={item.worker} mono /> : null}
              {item.requested_at ? (
                <Meta k={tr("请求时间")} v={fmtTime(item.requested_at)} />
              ) : null}
            </div>
          )}

          {/* 期限倒计时（expires_at；过期置灰） */}
          {item.expires_at ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 13,
                color: expired ? t.textSecondary : "#e88b00",
              }}
            >
              <ClockIcon style={{ fontSize: 13 }} />
              <span>
                {tr("期限")}：
                {expired ? tr("已过期") : cd?.label || ""}
              </span>
            </div>
          ) : null}

          {/* 答案面：有 options → 按钮组（推荐仅徽章）；无 → A/B/C + 自定义 */}
          {hasOptions ? (
            <div>
              <div style={labelStyle}>{tr("快捷回答")}</div>
              <div style={{ display: "grid", gap: 8 }}>
                {options.map((o) => {
                  const selected = selectedOption === o.id;
                  return (
                    <button
                      key={o.id}
                      type="button"
                      disabled={locked}
                      onClick={() => setSelectedOption(o.id)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "10px 12px",
                        borderRadius: 8,
                        cursor: locked ? "not-allowed" : "pointer",
                        border: selected
                          ? "2px solid #1677ff"
                          : `1px solid ${t.border}`,
                        background: selected
                          ? "rgba(22,119,255,0.08)"
                          : t.cardBg,
                        opacity: locked ? 0.5 : 1,
                        textAlign: "left",
                        color: t.text,
                        fontSize: 13,
                      }}
                    >
                      <span style={{ flex: 1 }}>{o.label || o.id}</span>
                      {item.suggested === o.id ? (
                        <antd.Tag color="gold" style={{ marginRight: 0 }}>
                          {tr("推荐")}
                        </antd.Tag>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div>
              <div style={labelStyle}>{tr("快捷回答")}</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                {["A", "B", "C"].map((c) => (
                  <antd.Button
                    key={c}
                    size="small"
                    type={freeText === c ? "primary" : "default"}
                    disabled={locked}
                    onClick={() => setFreeText(c)}
                  >
                    {c}
                  </antd.Button>
                ))}
              </div>
              <antd.Input.TextArea
                value={freeText}
                maxLength={500}
                autoSize={{ minRows: 2, maxRows: 5 }}
                disabled={locked}
                placeholder={tr("自定义回答")}
                onChange={(e: { target: { value: string } }) => setFreeText(e.target.value)}
              />
            </div>
          )}

          {/* 依据（可选）——写入答案消息 basis: 行 */}
          <div>
            <div style={labelStyle}>{tr("依据（可选）")}</div>
            <antd.Input
              value={basis}
              disabled={locked}
              placeholder={tr("依据（可选）")}
              onChange={(e: { target: { value: string } }) => setBasis(e.target.value)}
            />
          </div>

          {/* 状态提示：已答（本会话）/ 房间未定位 / 发送失败 */}
          {alreadyAnswered ? (
            <div
              style={{
                padding: "10px 12px",
                borderRadius: 8,
                border: `1px solid ${t.border}`,
                color: t.textSecondary,
                fontSize: 13,
              }}
            >
              ✓ {tr("已回答")}
            </div>
          ) : roomMissing ? (
            <div style={errorStyle}>{tr("未定位到任务房间（无法发送）")}</div>
          ) : null}
          {error ? (
            <div style={errorStyle}>
              {tr("发送失败")}: {error}
            </div>
          ) : null}

          {/* 底栏：上/下条 + 身份说明 + 提交（Enter 提交 / Esc 关闭） */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <antd.Button
              size="small"
              disabled={clamped <= 0}
              onClick={() => onIndexChange(clamped - 1)}
            >
              {tr("上一条")}
            </antd.Button>
            <antd.Button
              size="small"
              disabled={clamped >= items.length - 1}
              onClick={() => onIndexChange(clamped + 1)}
            >
              {tr("下一条")}
            </antd.Button>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: t.textSecondary }}>
              {tr("答案将以当前登录身份（人类）发回任务房间")}
            </span>
            <antd.Button
              type="primary"
              disabled={!canSubmit}
              loading={sending}
              onClick={() => void trySubmit()}
            >
              {sending ? tr("发送中") : tr("提交")}
            </antd.Button>
          </div>
        </div>
      )}
    </antd.Modal>
  );
}
