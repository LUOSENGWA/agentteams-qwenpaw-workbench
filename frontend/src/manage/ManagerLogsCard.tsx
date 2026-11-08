/**
 * ManagerLogsCard.tsx — 「管理」页 Manager 详情 · 容器日志折叠卡（旧拓扑
 * components/WorkerManageTables.tsx ManagerDetail 日志入口迁入）。
 *
 * 端点 = GET /agentteams-proxy/docker-logs/{managerName}?tail=300（Controller
 * Docker API 代理；需管理员 token → 面板侧 hasToken 门控）。点击才加载（不
 * 自动轮询）；手动刷新。404 = 端点缺失（老控制器）/ 403 = 无权 → 可读文案；
 * 其余失败 = 卡内「加载失败 · 重试」，不白屏。
 */
import type * as ReactNS from "react";

import { requestJson } from "../api/shared";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { ReloadIcon } from "../components/WorkerManageShared";
import { BoxIcon } from "../components/icons";
import {
  classifyManagerLogError,
  managerLogPath,
  parseDockerLogLines,
  type ManagerLogErrorKind,
} from "./managerLogs";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export type ManagerLogState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; lines: string[] }
  | { kind: "missing" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

/** 拉容器日志（永不 reject；错误即状态）。 */
export async function loadManagerLogs(
  managerName: string,
): Promise<ManagerLogState> {
  try {
    const data = await requestJson(managerLogPath(managerName));
    return { kind: "ok", lines: parseDockerLogLines(data) };
  } catch (e) {
    const cls: ManagerLogErrorKind = classifyManagerLogError(e);
    if (cls === "missing") return { kind: "missing" };
    if (cls === "forbidden") return { kind: "forbidden" };
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
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

/** 折叠卡体（纯展示：给定状态渲染，不拨号——重试由父级回调）。 */
export function ManagerLogsBody({
  state,
  onRetry,
}: {
  state: ManagerLogState;
  onRetry?: () => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  if (state.kind === "idle" || state.kind === "loading") {
    return <Hint>{tr("加载中…")}</Hint>;
  }
  if (state.kind === "missing") {
    return <Hint>{tr("该 Manager 无容器日志端点（Controller 未提供）")}</Hint>;
  }
  if (state.kind === "forbidden") {
    return (
      <Hint>
        <span style={{ color: t.mode === "dark" ? "#ff7875" : "#cf1322" }}>
          {tr("无权限查看日志")}
        </span>
      </Hint>
    );
  }
  if (state.kind === "error") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <antd.Button
          size="small"
          danger
          style={{ minHeight: 44 }}
          onClick={onRetry}
        >
          {tr("加载失败")} · {tr("重试")}
        </antd.Button>
        <span style={{ color: t.textSecondary, fontSize: 11 }}>{state.message}</span>
      </div>
    );
  }
  if (state.lines.length === 0) return <Hint>{tr("（无日志行）")}</Hint>;
  return (
    <pre
      style={{
        margin: 0,
        padding: 8,
        background: t.toolBg,
        border: `1px solid ${t.border}`,
        borderRadius: 6,
        fontFamily: MONO,
        fontSize: 11,
        lineHeight: 1.5,
        maxHeight: 320,
        overflow: "auto",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        minWidth: 0,
      }}
    >
      {state.lines.join("\n")}
    </pre>
  );
}

export default function ManagerLogsCard({
  managerName,
  enabled = true,
}: {
  managerName: string;
  /** hasToken 门控（日志端点需管理员 token）；false = 整卡不显。 */
  enabled?: boolean;
}) {
  const t = useThemeColors();
  const tr = useT();
  const [open, setOpen] = React.useState(false);
  const [tick, setTick] = React.useState(0);
  const [state, setState] = React.useState<ManagerLogState>({ kind: "idle" });

  React.useEffect(() => {
    // 点击才加载（默认收起零拨号）；重试/刷新 = tick 变化。
    if (!open || !enabled) return;
    let alive = true;
    setState({ kind: "loading" });
    void loadManagerLogs(managerName).then((next) => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
    };
  }, [open, enabled, managerName, tick]);

  // 切 Manager 复位（本卡按 key 挂载，双保险）。
  React.useEffect(() => {
    setOpen(false);
    setTick(0);
    setState({ kind: "idle" });
  }, [managerName]);

  if (!enabled) return null;

  const subtitle =
    state.kind === "loading"
      ? tr("加载中…")
      : state.kind === "missing"
        ? tr("该 Manager 无容器日志端点（Controller 未提供）")
        : state.kind === "forbidden"
          ? tr("无权限查看日志")
          : state.kind === "error"
            ? tr("加载失败")
            : tr("日志（最近 300 行）");

  return (
    <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "stretch", gap: 8, minWidth: 0 }}>
        <button
          type="button"
          aria-expanded={open}
          aria-label={tr("容器日志")}
          onClick={() => setOpen((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flex: 1,
            minWidth: 0,
            minHeight: 44,
            padding: "8px 12px",
            textAlign: "left",
            border: `1px solid ${t.border}`,
            borderRadius: 8,
            background: open ? t.hoverBg : t.cardBg,
            color: "inherit",
            cursor: "pointer",
            font: "inherit",
          }}
        >
          <BoxIcon size={15} style={{ color: t.textSecondary, flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0, display: "grid", gap: 1 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: t.text }}>
              {tr("容器日志")}
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
            {open ? "▾" : "›"}
          </span>
        </button>
        <button
          type="button"
          title={tr("刷新")}
          aria-label={tr("刷新")}
          onClick={() => {
            setOpen(true);
            setTick((v) => v + 1);
          }}
          style={{
            width: 44,
            minHeight: 44,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            border: `1px solid ${t.border}`,
            borderRadius: 8,
            background: t.cardBg,
            color: t.textSecondary,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <ReloadIcon />
        </button>
      </div>
      {open ? <ManagerLogsBody state={state} onRetry={() => setTick((v) => v + 1)} /> : null}
    </div>
  );
}
