import type * as ReactNS from "react";

import {
  fetchCodingRunDetail,
  httpErrorStatus,
  listCodingRuns,
  type CodingRun,
  type CodingRunDetail,
} from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { usePoller } from "../usePoller";
import { useTabActive } from "../tabActivity";
import { WbTooltip } from "./WbTooltip";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
const icons = (host.antdIcons || {}) as Record<string, ReactNS.ComponentType>;
const EmptyIcon = (() => null) as unknown as ReactNS.FC<Record<string, unknown>>;
const pick = (name: string): ReactNS.FC<Record<string, unknown>> =>
  (icons[name] as ReactNS.FC<Record<string, unknown>>) || EmptyIcon;
const ReloadIcon = pick("ReloadOutlined");
const FileTextIcon = pick("FileTextOutlined");

/** run-YYYYMMDD-HHMMSS.log → "YYYY-MM-DD HH:MM:SS"。文件名是容器本地钟，
 * 时区不可知——上游设计原则「时间未知则不伪造」，此处原样展示文件名时间。 */
const RUN_FILE = /^run-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.log$/;
function timeFromRunFile(run: string): string {
  const m = RUN_FILE.exec(run);
  if (!m) return run;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

/** ISO(UTC) → 本地 "YYYY-MM-DD HH:MM:SS"；解析失败原样返回。 */
function timeFromIso(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours(),
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 列表行时间：优先 started_at（记录里的 UTC，可转本地）；无则文件名时间。 */
export function displayTime(r: CodingRun): string {
  return r.started_at ? timeFromIso(r.started_at) : timeFromRunFile(r.run);
}

/** 状态 → antd Tag 色（保守映射，未知值回退 default，不臆造）。 */
export function statusVariant(status?: string): "success" | "error" | "warning" | "default" {
  if (!status) return "default";
  const s = status.toLowerCase();
  if (s === "ok" || s === "success" || s === "done" || s === "completed") return "success";
  if (s === "error" || s === "failed" || s === "fail" || s === "execution_denied") return "error";
  if (s === "timeout" || s === "timed_out" || s === "cancelled" || s === "canceled") return "warning";
  return "default";
}

/** exit_code 指针语义：0 合法须显示；null/undefined 显示占位。 */
export function showExit(code?: number | null): string {
  return code == null ? "—" : String(code);
}

function fmtBytes(n?: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** 详情抽屉（Modal）：打开即按 run 拉 json 封装（meta + prompt + transcript）。
 * export 供 WorkerChats 的 Coding CLI tab 复用（同一数据源同一渲染）。 */
export function CodingRunDetailModal({
  run,
  onClose,
}: {
  run: CodingRun;
  onClose: () => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  const [detail, setDetail] = React.useState<CodingRunDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    let on = true;
    setLoading(true);
    setError("");
    setDetail(null);
    fetchCodingRunDetail(run.task_id, run.run, run.team)
      .then((d) => {
        if (on) setDetail(d);
      })
      .catch((e) => {
        if (on) setError(e instanceof Error ? e.message : "");
      })
      .finally(() => {
        if (on) setLoading(false);
      });
    return () => {
      on = false;
    };
  }, [run.task_id, run.run, run.team]);

  const m = detail?.meta;
  const metaRows: [string, string][] = [
    [tr("任务"), run.task_id],
    [tr("团队"), run.team || "—"],
    [tr("CLI"), m?.cli || run.cli || "—"],
    [tr("Worker"), m?.worker || run.worker || "—"],
    [tr("Runner"), m?.runner || "—"],
    [tr("状态"), m?.status || run.status || "—"],
    [tr("退出码"), showExit(m?.exit_code ?? run.exit_code)],
    [tr("开始"), m?.started_at ? timeFromIso(m.started_at) : "—"],
    [tr("结束"), m?.ended_at ? timeFromIso(m.ended_at) : "—"],
    [tr("日志"), fmtBytes(m?.log_bytes ?? run.log_bytes)],
  ];
  if (m?.reason) metaRows.push([tr("原因"), m.reason]);

  return (
    <antd.Modal
      open
      title={
        <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }}>
          {run.run}
        </span>
      }
      footer={null}
      onCancel={onClose}
      width={780}
      styles={{ body: { maxHeight: "72vh", overflow: "auto", padding: 12 } }}
    >
      {loading ? (
        <div style={{ padding: 24, textAlign: "center", color: t.textSecondary }}>
          <antd.Spin />
          <div style={{ marginTop: 10, fontSize: 13 }}>{tr("读取执行记录…")}</div>
        </div>
      ) : error ? (
        <div
          style={{
            padding: "14px 16px",
            borderRadius: 8,
            border: `1px solid ${t.border}`,
            color: "#e5484d",
            fontSize: 13,
          }}
        >
          {tr("读取失败")}: {error}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          {/* 元数据 */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
              gap: 8,
            }}
          >
            {metaRows.map(([k, v]) => (
              <div
                key={k}
                style={{
                  background: t.cardBg,
                  border: `1px solid ${t.border}`,
                  borderRadius: 8,
                  padding: "8px 10px",
                  minWidth: 0,
                }}
              >
                <div style={{ fontSize: 11, color: t.textSecondary }}>{k}</div>
                <div
                  style={{
                    fontSize: 13,
                    color: t.text,
                    wordBreak: "break-all",
                    fontFamily:
                      k === tr("任务") || k === tr("Worker") || k === tr("Runner")
                        ? "ui-monospace, monospace"
                        : undefined,
                  }}
                >
                  {k === tr("状态") && v !== "—" ? (
                    <antd.Tag color={statusVariant(v)} style={{ marginTop: 2 }}>
                      {v}
                    </antd.Tag>
                  ) : (
                    v
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* 输入（prompt）——仅在镜像使其可读时显示，否则明确提示不可用 */}
          <div>
            <div
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: t.textSecondary,
                marginBottom: 6,
              }}
            >
              {tr("输入（prompt）")}
            </div>
            {detail && detail.input.prompt_available && detail.input.prompt ? (
              <pre
                style={{
                  margin: 0,
                  padding: 10,
                  borderRadius: 8,
                  background: "#0d1117",
                  color: "#c9d1d9",
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 12,
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  maxHeight: 180,
                  overflowY: "auto",
                }}
              >
                {detail.input.prompt}
              </pre>
            ) : (
              <div style={{ fontSize: 12, color: t.textSecondary }}>
                {detail?.input.prompt_summary
                  ? detail.input.prompt_summary
                  : tr("（本次执行未记录输入）")}
              </div>
            )}
          </div>

          {/* 输出（transcript）——原始日志 */}
          <div>
            <div
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: t.textSecondary,
                marginBottom: 6,
              }}
            >
              {tr("输出（原始日志）")}
            </div>
            {detail && detail.output.transcript ? (
              <pre
                style={{
                  margin: 0,
                  padding: 10,
                  borderRadius: 8,
                  background: "#0d1117",
                  color: "#c9d1d9",
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 12,
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  maxHeight: "46vh",
                  overflowY: "auto",
                }}
              >
                {detail.output.transcript}
              </pre>
            ) : (
              <div style={{ fontSize: 12, color: t.textSecondary }}>
                {tr("（无日志内容）")}
              </div>
            )}
          </div>
        </div>
      )}
    </antd.Modal>
  );
}

/** 编码执行记录段（运维页内，只读）。404/空 = 优雅空态，不报错。 */
function CodingRunsPanel({ refreshTick = 0 }: { refreshTick?: number }) {
  const t = useThemeColors();
  const tr = useT();
  const opsActive = useTabActive("ops");
  const [runs, setRuns] = React.useState<CodingRun[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [notDeployed, setNotDeployed] = React.useState(false);
  const [loadError, setLoadError] = React.useState("");
  const [selected, setSelected] = React.useState<CodingRun | null>(null);

  const refresh = React.useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const data = await listCodingRuns();
        setRuns(data);
        setLoadError("");
        setNotDeployed(false);
      } catch (e) {
        if (httpErrorStatus(e) === 404) {
          setNotDeployed(true);
          setRuns([]);
        } else if (!silent) {
          setLoadError(e instanceof Error ? e.message : tr("加载失败"));
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    // tr 为纯查表函数，行为稳定，不入 deps（否则回调被反复重建）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  React.useEffect(() => {
    void refresh(false);
  }, [refresh]);

  // 切 Tab 回来（rc-tabs 保活不重跑挂载 effect）→ 静默刷新。
  React.useEffect(() => {
    if (!refreshTick) return;
    void refresh(true);
  }, [refreshTick, refresh]);

  // 30s 静默轮询（ops tab 激活门控；切走即停；失败退避内置）。
  usePoller({
    fn: () => void refresh(true),
    intervalMs: 30000,
    active: opsActive,
    minPokeMs: 15000,
  });

  const sorted = React.useMemo(() => {
    if (!runs) return [];
    return [...runs].sort((a, b) => displayTime(b).localeCompare(displayTime(a)));
  }, [runs]);

  return (
    <div>
      {/* 段头 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 10,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 15 }}>{tr("编码执行记录")}</span>
        <WbTooltip
          title={tr(
            "编码 CLI 一次性执行记录与原始日志（只读，Controller /api/v1/coding-runs）。与聊天区的会话上下文不是同一数据源。",
          )}
        >
          <span style={{ color: t.textSecondary, cursor: "help", fontSize: 12 }}>
            ⓘ
          </span>
        </WbTooltip>
        {runs && !notDeployed && (
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("{n} 条", { n: runs.length })}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <WbTooltip title={tr("刷新")}>
          <antd.Button
            type="text"
            size="small"
            icon={<ReloadIcon />}
            loading={loading}
            onClick={() => void refresh(false)}
          />
        </WbTooltip>
      </div>

      {/* 态：未部署 / 错误 / 空 / 列表 */}
      {notDeployed ? (
        <div
          style={{
            padding: "14px 16px",
            borderRadius: 8,
            border: `1px solid ${t.border}`,
            color: t.textSecondary,
            fontSize: 13,
          }}
        >
          {tr("当前 Controller 版本未提供编码执行记录（升级后自动开放）。")}
        </div>
      ) : loadError ? (
        <div
          style={{
            padding: "14px 16px",
            borderRadius: 8,
            border: `1px solid ${t.border}`,
            color: "#e5484d",
            fontSize: 13,
          }}
        >
          {tr("加载失败")}: {loadError}
        </div>
      ) : loading && !runs ? (
        <div style={{ padding: 16 }}>
          <antd.Skeleton active title={false} paragraph={{ rows: 3 }} />
        </div>
      ) : sorted.length === 0 ? (
        <antd.Empty description={tr("暂无编码执行记录")} image={antd.Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          {sorted.map((r) => (
            <div
              key={`${r.task_id}/${r.run}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 12px",
                borderRadius: 8,
                background: t.cardBg,
                border: `1px solid ${t.border}`,
                flexWrap: "wrap",
              }}
            >
              <FileTextIcon
                style={{ color: t.textSecondary, fontSize: 14 }}
              />
              <span
                style={{
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 12,
                  color: t.text,
                }}
              >
                {displayTime(r)}
              </span>
              <span style={{ flex: 1 }} />
              {r.cli && <antd.Tag color="geekblue">{r.cli}</antd.Tag>}
              {r.worker && (
                <antd.Tag color="cyan" style={{ fontFamily: "ui-monospace, monospace" }}>
                  {r.worker}
                </antd.Tag>
              )}
              {r.status && (
                <antd.Tag color={statusVariant(r.status)}>{r.status}</antd.Tag>
              )}
              <span style={{ fontSize: 11, color: t.textSecondary }}>
                {tr("退出 {code}", { code: showExit(r.exit_code) })}
              </span>
              {r.team && <antd.Tag color="default">{r.team}</antd.Tag>}
              <antd.Button
                size="small"
                type="link"
                onClick={() => setSelected(r)}
              >
                {tr("查看")}
              </antd.Button>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <CodingRunDetailModal run={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

export default React.memo(CodingRunsPanel);
