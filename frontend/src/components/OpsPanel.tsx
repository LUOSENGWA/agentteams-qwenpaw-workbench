import type * as ReactNS from "react";

import { fetchSglangLoads, requestJson, type SglangLoads } from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";


const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
const icons = (host.antdIcons || {}) as Record<string, ReactNS.ComponentType>;
const EmptyIcon = (() => null) as unknown as ReactNS.FC<Record<string, unknown>>;
const pick = (name: string): ReactNS.FC<Record<string, unknown>> =>
  (icons[name] as ReactNS.FC<Record<string, unknown>>) || EmptyIcon;
const ReloadIcon = pick("ReloadOutlined");

/** 集群状态（Controller /api/v1/status，L1 admin token）。 */
interface ClusterStatus {
  [k: string]: unknown;
}

interface LogLine {
  timestamp: string;
  level: "info" | "error";
  component: string;
  message: string;
}

/** Docker 日志时间戳（UTC ISO，如 2026-08-14T03:22:11.123Z）→ 本地 MM-DD HH:MM:SS。
    此前 slice(11,19) 显示 UTC 裸时分秒（比本地慢 8 小时且无日期）——用户 8/19
    「日志停留在 8/14」看不清是哪天的日志，加日期+转本地。解析失败回退原 slice。 */
function fmtLogTime(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts.slice(11, 19);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`;
}

const COMPONENTS = [
  { value: "controller", label: "Controller" },
  { value: "manager", label: "Manager" },
  { value: "matrix", label: "Matrix（控制器内）" },
  { value: "higress", label: "Higress（控制器内）" },
  { value: "minio", label: "MinIO（控制器内）" },
];

export default function OpsPanel({
  refreshTick = 0,
}: {
  refreshTick?: number;
}) {
  const t = useThemeColors();
  const tr = useT();
  const [status, setStatus] = React.useState<ClusterStatus | null>(null);
  const [statusLoading, setStatusLoading] = React.useState(false);
  const [component, setComponent] = React.useState("controller");
  const [logs, setLogs] = React.useState<LogLine[]>([]);
  const [logsLoading, setLogsLoading] = React.useState(false);
  const [levelFilter, setLevelFilter] = React.useState<"all" | "error">("all");
  const [autoScroll, setAutoScroll] = React.useState(true);
  const logBoxRef = React.useRef<HTMLDivElement | null>(null);

  const refreshStatus = React.useCallback(async () => {
    setStatusLoading(true);
    try {
      const data = (await requestJson(
        "/agentteams-proxy/controller/api/v1/status",
      )) as ClusterStatus;
      setStatus(data);
    } catch (e) {
      antd.message.error(
        e instanceof Error ? e.message : tr("集群状态获取失败"),
      );
    } finally {
      setStatusLoading(false);
    }
  }, []);

  const [logsUpdatedAt, setLogsUpdatedAt] = React.useState<number>(0);
  // silent=true：后台轮询不闪 loading（手动刷新按钮走非 silent）。
  const refreshLogs = React.useCallback(async (comp: string, silent = false) => {
    if (!silent) setLogsLoading(true);
    try {
      const data = (await requestJson(
        `/agentteams-proxy/docker-logs/${encodeURIComponent(comp)}?tail=300`,
      )) as { lines?: LogLine[] };
      setLogs(data.lines || []);
      setLogsUpdatedAt(Date.now());
    } catch (e) {
      if (!silent)
        antd.message.error(e instanceof Error ? e.message : tr("日志拉取失败"));
      setLogs([]);
    } finally {
      if (!silent) setLogsLoading(false);
    }
    // tr 每次 render 都是新函数但行为稳定（纯查表），不入 deps——否则 15s 轮询 timer 被反复重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 组件日志 15s 静默轮询（用户 8/19：日志「停留在 8/14」——此前开页取一次不刷新；
  // 容器本身无新日志时轮询也拉回同样内容，配合「N 行·更新于」提示区分两种情况）。
  React.useEffect(() => {
    const timer = window.setInterval(
      () => void refreshLogs(component, true),
      15000,
    );
    return () => window.clearInterval(timer);
  }, [refreshLogs, component]);

  // 可选模块：集群负载（L1 专属）。未启用时后端 404 → sglangOff=true 不渲染卡片。
  const [sglang, setSglang] = React.useState<SglangLoads | null>(null);
  const [sglangOff, setSglangOff] = React.useState(false);
  const [sglangLoading, setSglangLoading] = React.useState(false);
  const [sglangError, setSglangError] = React.useState("");

  // silent=true：后台轮询不闪 loading（手动刷新按钮走非 silent）。
  const [sglangLocalAt, setSglangLocalAt] = React.useState<number>(0);
  const refreshSglang = React.useCallback(async (silent = false) => {
    if (!silent) setSglangLoading(true);
    try {
      const data = await fetchSglangLoads();
      setSglang(data);
      setSglangLocalAt(Date.now()); // 本地到达时间——用户 8/19 问「高延迟」：
      // 此前显示服务器端时间戳，本地与服务器时钟漂移会显得滞后
      setSglangOff(false);
      setSglangError("");
    } catch (e) {
      if (e instanceof Error && e.message.includes("HTTP 404")) {
        setSglangOff(true); // 模块未启用——不显示卡片
      } else {
        setSglangError(e instanceof Error ? e.message : "");
        setSglangOff(false);
      }
    } finally {
      if (!silent) setSglangLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refreshStatus();
    void refreshLogs(component);
    void refreshSglang(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 集群负载 1s 静默轮询（用户 8/19：实时刷新——/v1/loads 读 SHM 快照，
  // 专为高频轮询设计，1 QPS 零负担）——rc-tabs 保活，切走也续。
  React.useEffect(() => {
    const timer = window.setInterval(() => void refreshSglang(true), 1000);
    return () => window.clearInterval(timer);
  }, [refreshSglang]);

  // 切 Tab 回来时（refreshTick 变化）重取——rc-tabs 保活不会重跑挂载 effect。
  React.useEffect(() => {
    if (!refreshTick) return;
    void refreshStatus();
    void refreshLogs(component);
    void refreshSglang(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  const visibleLogs = React.useMemo(
    () => (levelFilter === "all" ? logs : logs.filter((l) => l.level === "error")),
    [logs, levelFilter],
  );

  React.useEffect(() => {
    if (autoScroll && logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [visibleLogs, autoScroll]);

  const statusEntries = React.useMemo(
    () =>
      status && typeof status === "object"
        ? Object.entries(status as Record<string, unknown>)
        : [],
    [status],
  );

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* v0.5.0-beta.12（9/10 装验定案）：多运行时卡从运维页移除——静态 runtime
          清单硬编码不全 + 位置错。运行时管理归团队管理：每个 Worker/Manager 卡
          直接显示自己的 runtime·version（Worker 卡 fa8e36c / Manager 表本轮加列）。 */}
      {/* 集群状态 */}
      <div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 10,
          }}
        >
          <span style={{ fontWeight: 700, fontSize: 15 }}>📡 {tr("集群状态")}</span>
          <antd.Tooltip title={tr("Controller /api/v1/status（L1 视图，dashboard cluster-status 同源）")}>
            <span style={{ color: t.textSecondary, cursor: "help", fontSize: 12 }}>ⓘ</span>
          </antd.Tooltip>
          <div style={{ flex: 1 }} />
          <antd.Tooltip title="刷新">
            <antd.Button
              type="text"
              size="small"
              icon={<ReloadIcon />}
              loading={statusLoading}
              onClick={() => void refreshStatus()}
            />
          </antd.Tooltip>
        </div>
        {statusEntries.length === 0 ? (
          <antd.Empty
            description={statusLoading ? tr("加载中…") : tr("暂无状态数据")}
            image={antd.Empty.PRESENTED_IMAGE_SIMPLE}
          />
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              gap: 10,
            }}
          >
            {statusEntries.map(([key, value]) => {
              const display =
                value === null || value === undefined
                  ? "—"
                  : typeof value === "object"
                    ? JSON.stringify(value)
                    : String(value);
              return (
                <div
                  key={key}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 8,
                    border: `1px solid ${t.border}`,
                    background: t.cardBg,
                  }}
                >
                  <div style={{ fontSize: 11, color: t.textSecondary }}>
                    {key}
                  </div>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={display}
                  >
                    {display}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 集群负载（可选模块，L1 专属——未启用时后端 404，不渲染） */}
      {!sglangOff ? (
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 10,
              flexWrap: "wrap",
            }}
          >
            <span style={{ fontWeight: 700, fontSize: 15 }}>
              ⚡ {tr("集群负载")}
            </span>
            <span style={{ fontSize: 11, color: t.textSecondary }}>
              {tr("自动刷新 1 秒")}
            </span>
            <antd.Tooltip title="SGLang /v1/loads 每 DP rank 排队/运行/显存（可选模块——配置页开启并填 SGLang 地址）">
              <span style={{ color: t.textSecondary, cursor: "help", fontSize: 12 }}>
                ⓘ
              </span>
            </antd.Tooltip>
            <div style={{ flex: 1 }} />
            <antd.Tooltip title="刷新">
              <antd.Button
                type="text"
                size="small"
                icon={<ReloadIcon />}
                loading={sglangLoading}
                onClick={() => void refreshSglang()}
              />
            </antd.Tooltip>
          </div>
          {sglangError ? (
            <antd.Alert
              type="error"
              showIcon
              message={sglangError}
              style={{ fontSize: 12 }}
            />
          ) : sglang ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
                gap: 10,
              }}
            >
              {sglang.ranks.length === 0 ? (
                <antd.Empty
                  description={tr("暂无负载数据")}
                  image={antd.Empty.PRESENTED_IMAGE_SIMPLE}
                />
              ) : (
                sglang.ranks.map((r) => {
                  const busy = r.num_running_reqs + r.num_waiting_reqs;
                  const usagePct = Math.round(r.token_usage * 100);
                  return (
                    <div
                      key={r.dp_rank}
                      style={{
                        padding: "10px 12px",
                        borderRadius: 8,
                        border: `1px solid ${t.border}`,
                        background: t.cardBg,
                        display: "grid",
                        gap: 4,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                        }}
                      >
                        <span style={{ fontSize: 12, fontWeight: 600 }}>
                          {sglang.accelerator || "GPU"} · DP {r.dp_rank}
                        </span>
                        <antd.Tag
                          color={busy === 0 ? "green" : r.num_waiting_reqs > 0 ? "orange" : "blue"}
                          style={{ margin: 0, fontSize: 11 }}
                        >
                          {busy === 0
                            ? tr("空闲")
                            : r.num_waiting_reqs > 0
                              ? `${r.num_waiting_reqs} ${tr("排队")}`
                              : `${r.num_running_reqs} ${tr("运行中")}`}
                        </antd.Tag>
                      </div>
                      <div style={{ display: "flex", gap: 12, fontSize: 12 }}>
                        <span>
                          {tr("运行")}{" "}
                          <b>
                            {r.num_running_reqs}
                            {r.max_running_requests > 0
                              ? `/${r.max_running_requests}`
                              : ""}
                          </b>
                        </span>
                        <span>
                          {tr("排队")} <b>{r.num_waiting_reqs}</b>
                        </span>
                        <span>
                          {tr("吞吐")}{" "}
                          <b>{r.gen_throughput.toFixed(1)} tok/s</b>
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: t.textSecondary }}>
                        KV {r.num_used_tokens.toLocaleString()}
                        {r.pool_total_tokens > 0
                          ? `/${r.pool_total_tokens.toLocaleString()}`
                          : ""}{" "}
                        tokens · 命中 {Math.round(r.cache_hit_rate * 100)}%
                      </div>
                      {(r.mem_weight_gb > 0 || r.mem_kv_gb > 0) && (
                        <div style={{ fontSize: 11, color: t.textSecondary }}>
                          {tr("显存：权重 {a}G · KV {b}G · 图 {c}G", {
                            a: r.mem_weight_gb.toFixed(1),
                            b: r.mem_kv_gb.toFixed(1),
                            c: r.mem_graph_gb.toFixed(1),
                          })}
                        </div>
                      )}
                      {/* KV 池占用率 = token_usage（上面 KV used/pool 的百分比）——
                          用户 8/19 真机问「54% 是什么的 54%」：进度条无标签，补 "KV" 前缀 */}
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span
                          style={{
                            fontSize: 11,
                            color: t.textSecondary,
                            flexShrink: 0,
                          }}
                        >
                          {tr("KV 占用")}
                        </span>
                        <antd.Progress
                          percent={usagePct}
                          size="small"
                          status={usagePct > 85 ? "exception" : "normal"}
                          format={() => `${usagePct}%`}
                        />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          ) : (
            <antd.Skeleton active title={false} paragraph={{ rows: 2 }} />
          )}
          {sglang && sglang.ranks.length > 0 && (
            <div
              style={{
                fontSize: 11,
                color: t.textSecondary,
                marginTop: 8,
                display: "flex",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              {sglang.version && (
                <span>
                  {tr("SGLang {v} · 每 rank {n} 卡", {
                    v: sglang.version,
                    n: sglang.num_accelerators > 0 ? sglang.num_accelerators : "?",
                  })}
                </span>
              )}
              {sglangLocalAt > 0 && (
                <span>
                  {tr("更新于 {time}", {
                    time: new Date(sglangLocalAt).toLocaleTimeString(),
                  })}
                </span>
              )}
            </div>
          )}
        </div>
      ) : null}

      {/* 组件日志 */}
      <div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 10,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontWeight: 700, fontSize: 15 }}>📜 {tr("组件日志")}</span>
          <antd.Tooltip title={tr("经 Controller Docker API 代理拉容器日志（dashboard debug-log 同源；需要管理员 token）")}>
            <span style={{ color: t.textSecondary, cursor: "help", fontSize: 12 }}>ⓘ</span>
          </antd.Tooltip>
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("自动刷新 15 秒")}
            {logsUpdatedAt > 0 &&
              ` · ${tr("{n} 行 · 更新于 {time}", {
                n: logs.length,
                time: new Date(logsUpdatedAt).toLocaleTimeString(),
              })}`}
          </span>
          <div style={{ flex: 1 }} />
          <antd.Select
            size="small"
            style={{ width: 200 }}
            value={component}
            onChange={(v: string) => {
              setComponent(v);
              void refreshLogs(v);
            }}
            options={COMPONENTS}
          />
          <antd.Segmented
            size="small"
            value={levelFilter}
            onChange={(v: ReactNS.Key | number) =>
              setLevelFilter(v as "all" | "error")
            }
            options={[
              { value: "all", label: tr("全部") },
              { value: "error", label: tr("仅错误") },
            ]}
          />
          <antd.Switch
            size="small"
            checked={autoScroll}
            onChange={setAutoScroll}
            checkedChildren={tr("自动滚动")}
            unCheckedChildren={tr("暂停")}
          />
          <antd.Tooltip title={tr("刷新日志")}>
            <antd.Button
              type="text"
              size="small"
              icon={<ReloadIcon />}
              loading={logsLoading}
              onClick={() => void refreshLogs(component)}
            />
          </antd.Tooltip>
        </div>
        <div
          ref={logBoxRef}
          style={{
            height: 420,
            overflowY: "auto",
            borderRadius: 8,
            background: "#0d1117",
            padding: 10,
            fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
            fontSize: 12,
            lineHeight: 1.6,
          }}
        >
          {logsLoading && visibleLogs.length === 0 ? (
            <div style={{ color: "#8b949e" }}>{tr("加载日志中…")}</div>
          ) : visibleLogs.length === 0 ? (
            <div style={{ color: "#8b949e" }}>{tr("（无日志行）")}</div>
          ) : (
            visibleLogs.map((l, i) => (
              <div key={i} style={{ color: l.level === "error" ? "#ff7b72" : "#c9d1d9" }}>
                {l.timestamp ? (
                  <span style={{ color: "#8b949e" }}>
                    {fmtLogTime(l.timestamp)}{" "}
                  </span>
                ) : null}
                {l.message}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
