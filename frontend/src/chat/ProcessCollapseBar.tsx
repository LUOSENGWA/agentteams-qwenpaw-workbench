/**
 * 过程折叠条（批次 3）：一个 turn 的工具调用聚合为一行。
 *
 * 默认折叠：`WrenchIcon N 次工具调用 · X.Xs` + 展开箭头；
 * 展开：逐次调用（工具名 + 参数摘要 + 耗时 + 状态），
 * 行内再点开看完整参数/结果（原 ToolBubble 展开能力保留）。
 * 高度过渡 150ms（grid-template-rows 0fr→1fr，Chromium 原生支持）。
 *
 * 数据源：buildTurns 吸收的 turn.toolCalls（SSE 帧 → RoomMessage
 * 工具帧，口径不变）；经 aggregateToolCalls 配对 call/result。
 *
 * 思考过程：turn 内的 m.notice 推理帧（isThinkingNotice 启发式）由调用方
 * 抽取为 thoughts 传入——并入同一条折叠（`BrainIcon 思考过程 · WrenchIcon
 * N 次工具调用`），展开区先思考段、再工具行；不再作为红色/斜体正文气泡刷屏。
 *
 * 交互：只有折叠头（标题行）切换展开；子项（参数/结果）点击只切自己的
 * 展开态并 stopPropagation，选中文本/点击展开区空白不会收起整个过程条。
 *
 * 流式进行中（active）：默认展开 + 转圈（wb-process-spin，reduced-motion
 * 关闭）+ 折叠头「· 进行中」；turn 结束后自动折叠，用户手动点过则以其
 * 选择为准（不强制折叠）。
 */
import type { AggregatedCall, ToolCall } from "./ChatIR";
import { aggregateToolCalls } from "./ChatIR";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { BrainIcon, CheckIcon, CloseIcon, WrenchIcon } from "../components/icons";

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
    <div
      onClick={(e) => {
        // 子项（参数/结果）点击不冒泡到父条：展开/选择文本不得收起整个过程条。
        e.stopPropagation();
        if (call.detail) setOpen((v) => !v);
      }}
      style={{ cursor: call.detail ? "pointer" : "default" }}
    >
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
          onClick={(e) => e.stopPropagation()}
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

export function ProcessCollapseBar({
  calls,
  thoughts,
  active = false,
}: {
  calls: ToolCall[];
  /** 本 turn 的思考段（已去前缀；调用方 sort 保持原序）。 */
  thoughts?: string[];
  /** 流式进行中（turn.status === "active"）：默认展开 + 转圈 + 「进行中」。 */
  active?: boolean;
}) {
  const t = useThemeColors();
  const tr = useT();
  // 展开态：未手动操作时跟随 active（进行中自动展开，结束自动折叠）；
  // 用户点过就以用户选择为准（结束后不强制折叠）。
  const [userOpen, setUserOpen] = React.useState<boolean | null>(null);
  const open = userOpen === null ? active : userOpen;
  const agg = React.useMemo(() => aggregateToolCalls(calls), [calls]);
  const span = React.useMemo(() => barSpanSec(agg), [agg]);
  const notes = thoughts ?? [];
  const hasThoughts = notes.length > 0;
  const hasCalls = agg.length > 0;
  const callsLabel =
    span != null
      ? tr("{n} 次工具调用 · {x}s", { n: agg.length, x: span.toFixed(1) })
      : tr("{n} 次工具调用", { n: agg.length });
  const title = active
    ? tr("进行中…")
    : hasThoughts
      ? hasCalls
        ? tr("点击展开思考过程与工具调用详情")
        : tr("点击展开思考过程")
      : open
        ? tr("收起")
        : tr("点击展开工具调用详情");
  return (
    <div
      className={active ? "wb-process-bar is-active" : "wb-process-bar"}
      style={{
        padding: "4px 10px",
        borderRadius: 10,
        background: t.toolBg,
        border: `1px solid ${t.border}`,
        fontSize: 12.5,
        maxWidth: 560,
        color: t.textSecondary,
        userSelect: "none",
      }}
      title={title}
    >
      {/* 只有头部（chevron/标题行）切换折叠；展开区空白与子项点击不收起。 */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setUserOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setUserOpen(!open);
          }
        }}
        style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
      >
        {hasThoughts ? (
          <>
            <span data-icon="brain" style={{ display: "inline-flex", flexShrink: 0 }}>
              <BrainIcon size={12} />
            </span>
            <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
              {tr("思考过程")}
            </span>
          </>
        ) : null}
        {hasThoughts && hasCalls ? (
          <span style={{ color: "#bbb", flexShrink: 0 }}>·</span>
        ) : null}
        {hasCalls ? (
          <>
            <span data-icon="wrench" style={{ display: "inline-flex", flexShrink: 0 }}>
              <WrenchIcon size={12} />
            </span>
            <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
              {callsLabel}
            </span>
          </>
        ) : null}
        {active ? (
          <>
            {hasThoughts || hasCalls ? (
              <span style={{ color: "#bbb", flexShrink: 0 }}>·</span>
            ) : null}
            <span className="wb-process-spin" aria-hidden="true" />
            <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
              {tr("进行中")}
            </span>
          </>
        ) : null}
        <span style={{ flex: 1 }} />
        <span style={{ color: "#bbb", fontSize: 11, flexShrink: 0 }}>{open ? "▲" : "▼"}</span>
      </div>
      {/* 150ms 高度过渡：grid 行 0fr→1fr（内容隐藏不卸载，展开态保留）。 */}
      <div
        data-process-body=""
        onClick={(e) => e.stopPropagation()}
        style={{
          display: "grid",
          gridTemplateRows: open ? "1fr" : "0fr",
          transition: "grid-template-rows 150ms ease",
        }}
      >
        <div style={{ overflow: "hidden", minHeight: 0 }}>
          <div style={{ padding: "4px 0 2px" }}>
            {/* 思考段在前：每段一个 pre（中性底/边框，非红非斜体）；
                点击不冒泡到折叠头——选中文本/滚动不该收起整个过程条。 */}
            {hasThoughts ? (
              <div
                style={{
                  display: "grid",
                  gap: 6,
                  paddingBottom: hasCalls ? 4 : 0,
                }}
              >
                {notes.map((note, i) => (
                  <pre
                    key={`thought-${i}`}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      margin: 0,
                      padding: "8px 10px",
                      background: t.toolBg,
                      border: `1px solid ${t.border}`,
                      borderRadius: 6,
                      color: t.textSecondary,
                      fontSize: 12,
                      fontStyle: "normal",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      maxHeight: 240,
                      overflow: "auto",
                    }}
                  >
                    {note}
                  </pre>
                ))}
              </div>
            ) : null}
            {agg.map((call) => (
              <CallRow key={call.key} call={call} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
