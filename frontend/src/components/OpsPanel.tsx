import type * as ReactNS from "react";

import {
  fetchSglangLoads,
  requestJson,
  type SglangLoads,
} from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { usePoller } from "../usePoller";
import { useTabActive } from "../tabActivity";


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
 此前 slice(11,19) 显示 UTC 裸时分秒（比本地慢 8 小时且无日期）——
 「日志时间看不清是哪天」，加日期+转本地。解析失败回退原 slice。 */
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

function OpsPanel({
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

  // v0.5.0-beta.14.18：模型网关路由目录卡已移除（重复视图——模型页
  // ModelsTab 已有「模型网关配置」功能超集），关联 state/fetch 一并清理。

  // v0.5.0-beta.14.6（补）：活跃 tab 单源（rc-tabs 保活，切走仍需显式
  // 门控——ops 的 1s 集群负载轮询此前切走常驻）。
  // v0.5.0-beta.14.14：布尔快照——非 ops tab 互切不再重渲
  // 本面板（连点 Tab 固定成本）。
  const opsActive = useTabActive("ops");
  const [logsUpdatedAt, setLogsUpdatedAt] = React.useState<number>(0);
  // v0.5.0-beta.14.6（补）：轮询已并入 usePoller（ops tab 激活门控 +
  // 失败退避内置：×2 至 120s 封顶、成功复位；静默失败保留上次内容）。
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
      if (!silent) {
        // 手动刷新失败：显式报错并清屏（用户主动动作，需明确反馈）。
        antd.message.error(e instanceof Error ? e.message : tr("日志拉取失败"));
        setLogs([]);
      }
      // 静默失败：保留上次成功内容（不 setLogs([])）。
    } finally {
      if (!silent) setLogsLoading(false);
    }
    // tr 每次 render 都是新函数但行为稳定（纯查表），不入 deps——否则轮询 timer 被反复重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // v0.5.0-beta.14.6（补）：组件日志轮询 → usePoller（ops tab 激活；
  // !document.hidden 由 hook 内置；失败退避由 hook 内置）。
  usePoller({
    fn: () => void refreshLogs(component, true),
    intervalMs: 15000,
    active: opsActive,
  });

  // 可选模块：集群负载（L1 专属）。未启用时后端 404 → sglangOff=true 不渲染卡片。
  const [sglang, setSglang] = React.useState<SglangLoads | null>(null);
  const [sglangOff, setSglangOff] = React.useState(false);
  const [sglangLoading, setSglangLoading] = React.useState(false);
  const [sglangError, setSglangError] = React.useState("");

  // silent=true：后台轮询不闪 loading（手动刷新按钮走非 silent）。
  const [sglangLocalAt, setSglangLocalAt] = React.useState<number>(0);
  // v0.5.0-beta.14.19（diff 门修正 + 自适应节奏）：稳定快照（refreshSglang
  // deps=[]，不能直接读 state；ref 每次渲染同步最新值）。
  const sglangRef = React.useRef(sglang);
  sglangRef.current = sglang;
  // ── 自适应节奏（SGLang 卡片刷新回归的系统修复）──────────────────
  // 业界监控采集通式（Prometheus scrape tuning / nvidia-smi dmon）：
  // 活跃采样快、空闲采样稀。14.17 一刀切 1s→5s 导致验收实测回归「刷新
  // 很慢几乎不刷」——改两档：数据指纹变（推理中）=1s 快档（恢复 1s 时代
  // 实时感）；连续 2 周期不变（空闲）=15s 慢档（5M 行低带宽省拨号，
  // 空闲负载数据本无信息量）。指纹=归一化 JSON（服务端 timestamp 每帧
  // 变但不携带信息，参与比较会永远判"变"）。
  const SG_FAST_MS = 1000;
  const SG_SLOW_MS = 15000;
  const sgCadenceRef = React.useRef(SG_FAST_MS);
  const sgStableRef = React.useRef(0);
  const sgFingerprint = (d: SglangLoads | null): string =>
    d ? JSON.stringify({ ...d, timestamp: "" }) : "";
  // ── v0.5.0-beta.14.22：KV 活信号（自采样）──────────────────────
  // gen_throughput 是 SGLang 侧「decode 窗口采样」：只在 decode-stats
  // tick 计算，连续 30s 无 decode（长 prefill/采样稀疏）即归零导出——
  // 推理在跑（KV 仍在变化）时卡片也可能显示 0.0 tok/s。活信号改由
  // 前端自采样：相邻两次 poll 的 num_used_tokens 变化 = KV 在动。
  // 两信号并显（吞吐=采样窗速率 / 活动=实时占用变化），不再单值误导。
  const sgKvPrevRef = React.useRef<Map<number, number>>(new Map());
  const sgKvMovingRef = React.useRef<Set<number>>(new Set());
  const refreshSglang = React.useCallback(async (silent = false) => {
    if (!silent) setSglangLoading(true);
    try {
      const data = await fetchSglangLoads();
      // 活信号采样：占用变化必然改指纹 → 本轮 setSglang 重渲染，
      // 渲染时读 sgKvMovingRef 即最新值（idle 轮 moved=空，无渲染亦无感）。
      const prevMap = sgKvPrevRef.current;
      const moved = sgKvMovingRef.current;
      moved.clear();
      for (const r of data.ranks) {
        const prev = prevMap.get(r.dp_rank);
        if (prev !== undefined && r.num_used_tokens !== prev) moved.add(r.dp_rank);
        prevMap.set(r.dp_rank, r.num_used_tokens);
      }
      const changed =
        sgFingerprint(sglangRef.current) !== sgFingerprint(data);
      if (changed) {
        setSglang(data);
        sgStableRef.current = 0;
        sgCadenceRef.current = SG_FAST_MS;
      } else {
        // 连续 2 周期不变才降速（一周期确认，防快变场景误判空闲）。
        sgStableRef.current += 1;
        if (sgStableRef.current >= 2) sgCadenceRef.current = SG_SLOW_MS;
      }
      // 「更新于」=最后检查时间（监控卡活性证明，每检查必跳）——
      // 14.19 初版 diff 门把它绑成"最后变化时间"，空闲时停摆=假死观感
      // （回归反馈真根因之一）。
      setSglangLocalAt(Date.now());
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

  // 集群负载静默轮询（v1/loads 读 SHM 快照）。
  // v0.5.0-beta.14.6（补）：→ usePoller（ops tab 激活；切走即停 + 可见性
  // 内置——原「rc-tabs 保活切走也续」的每 1s 常驻开销由此消除）。
  // v0.5.0-beta.14.17：一刀切 1s→5s（省 5M 行拨号）。
  // v0.5.0-beta.14.19：改自适应节奏（getter 档）——14.17 的 5s 恒定档
  // 被验收实测打回「刷新很慢几乎不刷」：负载仪表要的是活性，省拨号
  // 靠空闲降档而非恒定降速。活跃 1s / 空闲 15s（refreshSglang 内
  // sgCadenceRef 按数据指纹切档）。
  usePoller({
    fn: () => void refreshSglang(true),
    intervalMs: () => sgCadenceRef.current,
    active: opsActive,
    minPokeMs: 800,
  });

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

  // v0.5.0-beta.14.18：旧版展示改「最新在上」(14.10) 但跟随逻辑留了
  // scrollTop=scrollHeight（滚到最底=最旧）——语义打架，轮询把用户视口拽走。
  // 现按业界标准（kubectl/docker --follow/Grafana logs 同款语义，适配最新在上）：
  // ① 跟随 = 顶部跟随（autoScroll 时 scrollTop=0，最新行永远贴顶可见）；
  // ② 用户向下翻（看旧日志，>60px）→ 自动暂停跟随（不打断阅读）；
  // ③ 暂停且不在顶 → 浮动「↑ 回到最新」钮 → 点击 = 回顶 + 恢复跟随。
  const [awayFromTop, setAwayFromTop] = React.useState(false);
  const onLogScroll = React.useCallback(() => {
    const el = logBoxRef.current;
    if (!el) return;
    const away = el.scrollTop > 60;
    setAwayFromTop(away);
    if (away) setAutoScroll(false); // 翻旧日志 = 自动暂停跟随（不打断阅读）
  }, []);
  const jumpToLatest = React.useCallback(() => {
    const el = logBoxRef.current;
    if (el) el.scrollTop = 0;
    setAwayFromTop(false);
    setAutoScroll(true);
  }, []);
  React.useEffect(() => {
    const el = logBoxRef.current;
    if (autoScroll && el) {
      el.scrollTop = 0;
      setAwayFromTop(false);
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
      {/* v0.5.0-beta.12（设计）：多运行时卡从运维页移除——静态 runtime
 清单硬编码不全 + 位置错。运行时管理归团队管理：每个 Worker/Manager 卡
 直接显示自己的 runtime·version（Worker 卡 / Manager 表本轮加列）。 */}
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
          <span style={{ fontWeight: 700, fontSize: 15 }}>集群状态</span>
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

 {/* v0.5.0-beta.14.18（14.17 「运维页面不需要放模型网关路由，
 把模型页面做好就可以」）：路由目录卡整块移除——模型页（ModelsTab）
 已有同款「模型网关配置」（提供商/路由/alias 表，功能超集），运维页
 重复视图删除。 */}

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
              集群负载
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
                        {/* v0.5.0-beta.14.22：吞吐 0 值语义显形——
 上游 decode 窗口采样，0 ≠ 空闲（KV 仍在动时推理在跑）。
 0 显示「—」+ 悬停说明；活动判定交给下方 KV 绿点（自采样）。 */}
                        <span style={{ cursor: "help" }}
                          title={tr("Decode 窗口采样：上游 30s 无 decode 报 0。0 不代表空闲——看下方 KV 绿点（最近一次轮询 KV 有变化 = 推理在跑）")}
                        >
                          {tr("吞吐")}{" "}
                          <b>
                            {r.gen_throughput > 0
                              ? `${r.gen_throughput.toFixed(1)} tok/s`
                              : "—"}
                          </b>
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: t.textSecondary }}>
                        {sgKvMovingRef.current.has(r.dp_rank) ? (
                          <span
                            style={{ color: "#52c41a", cursor: "help" }}
                            title={tr("最近一次轮询 KV 占用有变化——推理在跑")}
                          >
                            ●{" "}
                          </span>
                        ) : null}
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
 用户真机问「54% 是什么的 54%」：进度条无标签，补 "KV" 前缀 */}
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
          <span style={{ fontWeight: 700, fontSize: 15 }}>组件日志</span>
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
        <div style={{ position: "relative" }}>
          <div
            ref={logBoxRef}
            onScroll={onLogScroll}
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
 /* v0.5.0-beta.14.10：最新在最上——展示倒序（不
 改动状态数组本身；过滤/计数语义不变）。 */
            [...visibleLogs].reverse().map((l, i) => (
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
          {/* 暂停跟随且用户在翻旧日志 → 浮动「回到最新」钮（业界日志跟随
 标准件；点击=回顶+恢复跟随）。 */}
          {!autoScroll && awayFromTop ? (
            <antd.Button
              size="small"
              type="primary"
              style={{
                position: "absolute",
                top: 14,
                right: 14,
                boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
                zIndex: 1,
              }}
              onClick={jumpToLatest}
            >
              {tr("↑ 回到最新")}
            </antd.Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// v0.5.0-beta.14.10：面板级 memo——父级（WorkbenchPage）重渲染
// 且 props 无变化时跳过（修复前全仓零 memo，切 tab 帧断 183-200ms）。
export default React.memo(OpsPanel);
