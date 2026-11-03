/**
 * 过程折叠条（批次 3）：一个 turn 的工具调用聚合为一行。
 *
 * 默认折叠：`🔧 N 次工具调用 · X.Xs` + 展开箭头；
 * 展开：逐次调用（工具名 + 参数摘要 + 耗时 + 状态），
 * 行内再点开看完整参数/结果（原 ToolBubble 展开能力保留）。
 * 高度过渡 150ms（grid-template-rows 0fr→1fr，Chromium 原生支持）。
 *
 * 数据源：buildTurns 吸收的 turn.toolCalls（SSE 帧 → RoomMessage
 * 工具帧，口径不变）；经 aggregateToolCalls 配对 call/result。
 */
import type { AggregatedCall, ToolCall } from "./ChatIR";
import { aggregateToolCalls } from "./ChatIR";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { CheckIcon, CloseIcon, WrenchIcon } from "../components/icons";

const host = window.QwenPaw.host;
const React = host.React;

function statusIcon(status: AggregatedCall["status"]) {
  if (status === "ok") return <CheckIcon size={12} style={{ color: "#30a46c" }} />;
  if (status === "fail") return <CloseIcon size={12} style={{ color: "#e5484d" }} />;
  return <WrenchIcon size={12} />;
}

function CallRow({ call }: { call: AggregatedCall }) {
  const t = useThemeColors();
  const tr = useT();
  const [open, setOpen] = React.useState(false);
  const nameColor =
    call.status === "fail"
      ? "#e5484d"
      : call.status === "ok"
        ? "#30a46c"
        : t.textSecondary;
  return (
    <div onClick={() => call.detail && setOpen((v) => !v)} style={{ cursor: call.detail ? "pointer" : "default" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "2px 0",
        }}
      >
        <span style={{ flexShrink: 0, fontSize: 12 }}>{statusIcon(call.status)}</span>
        <span
          style={{
            fontFamily: "monospace",
            fontSize: 12,
            fontWeight: 600,
            color: nameColor,
            flexShrink: 0,
          }}
        >
          {call.name}
        </span>
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: t.textSecondary,
            fontSize: 12,
          }}
        >
          {call.argsSummary}
        </span>
        <span style={{ color: "#bbb", fontSize: 11, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
          {call.status === "call"
            ? "…"
            : call.durationSec != null
              ? tr("{x}s", { x: call.durationSec.toFixed(1) })
              : ""}
        </span>
        {call.detail ? (
          <span style={{ color: "#bbb", fontSize: 10, flexShrink: 0 }}>{open ? "▲" : "▼"}</span>
        ) : null}
      </div>
      {open && call.detail ? (
        <pre
          style={{
            margin: "4px 0 4px 18px",
            padding: "8px 10px",
            background:
              call.status === "fail" ? "rgba(229,72,77,0.06)" : "rgba(127,127,127,0.08)",
            border: `1px solid ${
              call.status === "fail" ? "rgba(229,72,77,0.3)" : "rgba(127,127,127,0.2)"
            }`,
            color: call.status === "fail" ? "#a13336" : t.textSecondary,
            borderRadius: 6,
            fontSize: 12,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            maxHeight: 320,
            overflow: "auto",
          }}
        >
          {call.detail}
        </pre>
      ) : null}
    </div>
  );
}

/** 过程条总耗时（秒）：首帧 → 末帧 ts 跨度；无 ts 返回 null。 */
function barSpanSec(agg: AggregatedCall[]): number | null {
  const first = agg.length > 0 ? agg[0].startTs : null;
  let last: number | null = null;
  for (const a of agg) {
    const t = a.endTs ?? a.startTs;
    if (t != null && (last == null || t > last)) last = t;
  }
  if (first == null || last == null) return null;
  return Math.max(0, (last - first) / 1000);
}

export function ProcessCollapseBar({ calls }: { calls: ToolCall[] }) {
  const t = useThemeColors();
  const tr = useT();
  const [open, setOpen] = React.useState(false);
  const agg = React.useMemo(() => aggregateToolCalls(calls), [calls]);
  const span = React.useMemo(() => barSpanSec(agg), [agg]);
  return (
    <div
      onClick={() => setOpen((v) => !v)}
      style={{
        cursor: "pointer",
        padding: "4px 10px",
        borderRadius: 10,
        background: t.toolBg,
        border: `1px solid ${t.border}`,
        fontSize: 12.5,
        maxWidth: 560,
        color: t.textSecondary,
        userSelect: "none",
      }}
      title={open ? tr("收起") : tr("点击展开工具调用详情")}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 12, flexShrink: 0 }}>🔧</span>
        <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
          {span != null
            ? tr("{n} 次工具调用 · {x}s", { n: agg.length, x: span.toFixed(1) })
            : tr("{n} 次工具调用", { n: agg.length })}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ color: "#bbb", fontSize: 11, flexShrink: 0 }}>{open ? "▲" : "▼"}</span>
      </div>
      {/* 150ms 高度过渡：grid 行 0fr→1fr（内容隐藏不卸载，展开态保留）。 */}
      <div
        style={{
          display: "grid",
          gridTemplateRows: open ? "1fr" : "0fr",
          transition: "grid-template-rows 150ms ease",
        }}
      >
        <div style={{ overflow: "hidden", minHeight: 0 }}>
          <div style={{ padding: "4px 0 2px" }}>
            {agg.map((call) => (
              <CallRow key={call.key} call={call} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
