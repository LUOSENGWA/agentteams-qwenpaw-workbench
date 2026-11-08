// CheckpointCard.tsx — 「管理」页团队域 · Worker 详情·检查点卡（旧拓扑
// components/WorkerManageTree.tsx CheckpointCard 迁入，只读）。
//
// 懒加载：折叠态零请求（与旧拓扑一致）；展开才并行拨
// status + graph(limit=100)。四态：
// - loading：加载中…
// - notSupported：控制器无 checkpoints/{graph,status} 路由（404/405，旧版
//   控制器）→ 能力缺口，隐藏入口换一行灰字，不报错；
// - unavailable：Worker 运行时 < QwenPaw 2.1（Controller 502 降级）；
// - ok：数量 / 最新时间 / graph 列表（最多 100，240px 内滚动）；空 = 暂无打点。
// 错误只落在本卡内（state 化），不抛给详情其它面板。
//
// 另有运行时门（旧卡同款）：非 qwenpaw 运行时禁用入口并说明，不发起无谓拨号。
// 数据源 = api/domains/checkpoints（Controller {sub} 白名单代理，域文件直取）。
// 只读——不提供删除（旧卡亦无）。

import type * as ReactNS from "react";

import {
  CheckpointNotSupportedError,
  CheckpointUnavailableError,
  fetchWorkerCheckpointGraph,
  fetchWorkerCheckpointStatus,
  type CheckpointGraphResponse,
  type CheckpointStatusResponse,
} from "../api/domains/checkpoints";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { isQwenpawOnlyDisabled } from "../runtimeGuard";
import { BookmarkIcon } from "../components/icons";
import { fmtTime } from "../components/WorkerManageShared";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

/** 卡状态（含能力缺口两态；error 只在本卡内呈现，不向上抛）。 */
export type CheckpointCardState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; status: CheckpointStatusResponse; graph: CheckpointGraphResponse }
  | { kind: "notSupported" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

/** 错误 → 状态（纯映射）。能力缺口不视为错误：旧控制器 404/405 早在
 * 域层转成 CheckpointNotSupportedError，QwenPaw <2.1 转 CheckpointUnavailableError。 */
export function checkpointStateFromError(e: unknown): CheckpointCardState {
  if (e instanceof CheckpointNotSupportedError) return { kind: "notSupported" };
  if (e instanceof CheckpointUnavailableError) return { kind: "unavailable" };
  return { kind: "error", message: e instanceof Error ? e.message : String(e) };
}

/** 拉取 status + graph(100) 并映射成卡状态——永不 reject（错误即状态）。 */
export async function loadWorkerCheckpoints(
  workerName: string,
): Promise<CheckpointCardState> {
  try {
    const [status, graph] = await Promise.all([
      fetchWorkerCheckpointStatus(workerName),
      fetchWorkerCheckpointGraph(workerName, 100),
    ]);
    return { kind: "ok", status, graph };
  } catch (e) {
    return checkpointStateFromError(e);
  }
}

function Hint({ children }: { children: ReactNS.ReactNode }) {
  const t = useThemeColors();
  return (
    <div style={{ fontSize: 11.5, color: t.textSecondary, padding: "2px 2px 4px" }}>
      {children}
    </div>
  );
}

/** 展开后的卡体（纯展示：给定状态渲染，不拨号）。 */
export function CheckpointCardBody({ state }: { state: CheckpointCardState }) {
  const t = useThemeColors();
  const tr = useT();
  // idle = 刚展开、effect 尚未置 loading（同一帧），按加载中呈现不闪空白。
  if (state.kind === "idle" || state.kind === "loading") {
    return <Hint>{tr("加载中…")}</Hint>;
  }
  if (state.kind === "notSupported") return <Hint>{tr("该控制器不支持检查点图")}</Hint>;
  if (state.kind === "unavailable") {
    return <Hint>{tr("该 Worker 需 QwenPaw 2.1 才有检查点")}</Hint>;
  }
  if (state.kind === "error") {
    return (
      <Hint>
        {/HTTP 404/.test(state.message)
          ? tr("Controller 升级后自动生效")
          : `${tr("检查点加载失败")}：${state.message}`}
      </Hint>
    );
  }

  const { status, graph } = state;
  // limit=100 已由请求侧约束；再兜一层防止上游超发糊满 DOM。
  const nodes = graph.nodes.slice(0, 100);
  const latest = nodes.reduce((m, n) => Math.max(m, n.timestamp_ms || 0), 0);

  return (
    <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <antd.Tag
          style={{ margin: 0, fontSize: 11 }}
          color={status.auto_enabled ? "green" : "default"}
        >
          {status.auto_enabled ? tr("自动打点开") : tr("自动打点关")}
        </antd.Tag>
        <span style={{ fontSize: 11.5, color: t.textSecondary }}>
          {tr("检查点数量")} {graph.summary.total}
        </span>
        {latest ? (
          <span style={{ fontSize: 11.5, color: t.textSecondary }}>
            {tr("最新")} {fmtTime(latest)}
          </span>
        ) : null}
        {graph.truncated ? (
          <span style={{ fontSize: 11.5, color: t.textSecondary }}>
            {tr("仅显示最近 100 条")}
          </span>
        ) : null}
      </div>
      {nodes.length === 0 ? (
        <Hint>{tr("暂无打点")}</Hint>
      ) : (
        <div
          style={{
            display: "grid",
            gap: 0,
            // 100 条上限时列表固定 240px 内滚动（移动端同宽，不撑页）。
            maxHeight: 240,
            overflowY: "auto",
            border: `1px solid ${t.border}`,
            borderRadius: 6,
            background: t.toolBg,
            minWidth: 0,
          }}
        >
          {nodes.map((n) => (
            <div
              key={n.ref || `${n.sha}:${n.timestamp_ms}`}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 8,
                padding: "5px 8px",
                minWidth: 0,
                borderTop: `1px solid ${t.border}`,
              }}
            >
              <antd.Tag
                style={{ margin: 0, fontSize: 10.5, flexShrink: 0 }}
                color={
                  n.kind === "auto" ? "blue" : n.kind === "snap" ? "green" : "orange"
                }
              >
                {n.kind || "—"}
              </antd.Tag>
              <span
                title={n.subject || n.query || n.name || n.ref}
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 11.5,
                  color: t.text,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {n.name || n.ref || (n.sha ? n.sha.slice(0, 10) : "—")}
              </span>
              {n.is_head ? (
                <span
                  title={tr("当前 HEAD")}
                  style={{ color: "var(--app-accent, #FF7F16)", flexShrink: 0 }}
                >
                  ●
                </span>
              ) : null}
              <span style={{ fontSize: 11, color: t.textSecondary, flexShrink: 0 }}>
                {fmtTime(n.timestamp_ms) || "—"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function CheckpointCard({
  workerName,
  runtime,
}: {
  workerName: string;
  runtime?: string;
}) {
  const t = useThemeColors();
  const tr = useT();
  // 非 qwenpaw 运行时禁用入口 + 不发起拨号（旧卡 D4 #7 同款）。
  const gated = isQwenpawOnlyDisabled(runtime);
  const [open, setOpen] = React.useState(false);
  const [state, setState] = React.useState<CheckpointCardState>({ kind: "idle" });

  React.useEffect(() => {
    if (!open || gated) return;
    let alive = true;
    setState({ kind: "loading" });
    void loadWorkerCheckpoints(workerName).then((next) => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
    };
  }, [open, workerName, gated]);

  const expanded = open && !gated;
  const subtitle = gated
    ? tr("仅 QwenPaw 运行时可用")
    : state.kind === "idle"
      ? tr("展开后加载")
      : state.kind === "loading"
        ? tr("加载中…")
        : state.kind === "notSupported"
          ? tr("该控制器不支持检查点图")
          : state.kind === "unavailable"
            ? tr("该 Worker 需 QwenPaw 2.1 才有检查点")
            : state.kind === "error"
              ? tr("加载失败")
              : state.graph.summary.total > 0
                ? tr("{n} 个检查点", { n: state.graph.summary.total })
                : tr("暂无打点");

  return (
    <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
      <button
        type="button"
        disabled={gated}
        aria-expanded={expanded}
        aria-label={tr("检查点")}
        onClick={() => {
          if (!gated) setOpen((v) => !v);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          width: "100%",
          // 移动端全宽 + 触控目标 ≥44px（与 ResourceCards 入口同规格）。
          minHeight: 44,
          padding: "8px 12px",
          textAlign: "left",
          border: `1px solid ${t.border}`,
          borderRadius: 8,
          background: expanded ? t.hoverBg : t.cardBg,
          color: "inherit",
          cursor: gated ? "not-allowed" : "pointer",
          font: "inherit",
          opacity: gated ? 0.65 : 1,
        }}
      >
        <BookmarkIcon size={15} style={{ color: t.textSecondary, flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, display: "grid", gap: 1 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: t.text }}>
            {tr("检查点")}
          </span>
          <span
            style={{
              fontSize: 11,
              color: t.textSecondary,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {subtitle}
          </span>
        </span>
        <span style={{ color: t.textSecondary, fontSize: 15, flexShrink: 0 }}>
          {expanded ? "▾" : "›"}
        </span>
      </button>
      {expanded ? <CheckpointCardBody state={state} /> : null}
    </div>
  );
}
