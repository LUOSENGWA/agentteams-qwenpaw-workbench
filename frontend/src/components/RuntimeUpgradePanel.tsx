import type * as ReactNS from "react";

import {
  fetchUpgradeCheck,
  fetchUpgradeLatest,
  fetchUpgradeLightCheck,
  fetchUpgradeStatus,
  httpErrorStatus,
  requestJson,
  runUpgrade,
  UPGRADE_TERMINAL_STATES,
  type UpgradeFullCheck,
  type UpgradeGate,
  type UpgradeLatest,
  type UpgradeLightCheck,
  type UpgradeRunHandle,
  type UpgradeStatusResult,
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
const pick = (name: string): ReactNS.ComponentType =>
  (icons[name] as ReactNS.ComponentType) || EmptyIcon;
const ReloadIcon = pick("ReloadOutlined");
const CloudSyncIcon = pick("CloudSyncOutlined");

interface WorkerItem {
  name: string;
  runtime?: string;
  state?: string;
  phase?: string;
}

/** 当前 qwenpaw 运行时版（容器内 importlib.metadata 读）→ 模块级缓存。
 * image tag（如 v1.2.5）是 AgentTeams 镜像版，≠qwenpaw 运行时版（如
 * 2.2.1），不能拿它比 PyPI qwenpaw latest（恒误判「可升级」）。升级目标
 * =qwenpaw 版，故 current 正源=容器内 qwenpaw 版（探测一次缓存，后续秒回）。 */
const qwenpawVersionCache = new Map<string, string>();

/** 「检查更新」单 worker 匹配结果（当前 qwenpaw 运行时版 vs 最新稳定版）。 */
interface UpgradeCheckResult {
  current: string | null; // 容器内 qwenpaw 版；未探测到=null
  latest: string;
  status: "up-to-date" | "available" | "unknown";
}

/** PEP440 简式版本比较（数字段逐位；预发布后缀视为低于同号正式版）。
 * 返回 -1/0/1（a<b/a==b/a>b）。非数字段按 0 处理。 */
function compareVersions(a: string, b: string): number {
  const norm = (v: string): number[] =>
    v
      .replace(/^[v=]+/, "")
      .split(/[.+-]/)
      .slice(0, 4)
      .map((s) => {
        const n = parseInt(s, 10);
        return isNaN(n) ? 0 : n;
      });
  const A = norm(a);
  const B = norm(b);
  const len = Math.max(A.length, B.length);
  for (let i = 0; i < len; i++) {
    const x = A[i] ?? 0;
    const y = B[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  // 同号：带预发布后缀（含字母）的视为较低。
  const pre = (v: string) => /[A-Za-z]/.test(v);
  if (pre(a) !== pre(b)) return pre(a) ? -1 : 1;
  return 0;
}

/** 门控状态 → Tag 色（checker 六态保守映射）。 */
function gateVariant(g: UpgradeGate): "success" | "error" | "warning" | "default" {
  switch (g.status) {
    case "PASS":
      return "success";
    case "FAIL":
    case "ERROR":
      return "error";
    case "WARN":
      return "warning";
    case "SKIP":
    case "NOT_RUN":
    default:
      return "default";
  }
}

function fmtTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours(),
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** job 状态变体（state-file state 字段；未知值→default）。 */
function jobStateVariant(s?: string): "processing" | "success" | "error" | "warning" | "default" {
  switch (s) {
    case "success":
      return "success";
    case "rolled_back":
    case "rollback_failed":
    case "precheck_failed":
    case "failed":
      return "error";
    case "recovering":
      return "warning";
    case "running":
    case "installing":
    case "boot-check-passed":
      return "processing";
    default:
      return "default";
  }
}

/** 运行时升级段（运维页内，15.25 per-worker 重接）。
 * 流程：选 Worker（QwenPaw only 提示）→ 轻探当前版本 → 填目标版本
 * 预检（checker gates）→ 二次确认触发（破坏性：容器重启）→ job 跟踪。 */
function RuntimeUpgradePanel({ refreshTick = 0 }: { refreshTick?: number }) {
  const t = useThemeColors();
  const tr = useT();
  const opsActive = useTabActive("ops");

  const [workers, setWorkers] = React.useState<WorkerItem[]>([]);
  const [workersError, setWorkersError] = React.useState("");
  const [selected, setSelected] = React.useState<string>("");
  const [light, setLight] = React.useState<UpgradeLightCheck | null>(null);
  const [lightLoading, setLightLoading] = React.useState(false);
  const [version, setVersion] = React.useState("");
  const [verify, setVerify] = React.useState(false);
  const [full, setFull] = React.useState<UpgradeFullCheck | null>(null);
  const [fullLoading, setFullLoading] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [job, setJob] = React.useState<UpgradeRunHandle | null>(null);
  const [status, setStatus] = React.useState<UpgradeStatusResult | null>(null);
  // 模式：单 Worker（原流程）｜ 批量（多选 + 检查更新 + 顺序触发）。
  const [mode, setMode] = React.useState<"single" | "batch">("single");

  // workers 目录（L1；403=未配 token → 引导空态）。
  const loadWorkers = React.useCallback(async (silent = false) => {
    if (!silent) setWorkersError("");
    try {
      const d = (await requestJson(
        "/agentteams-proxy/controller/api/v1/workers?limit=200",
      )) as { workers?: WorkerItem[] };
      setWorkers((d?.workers || []).filter((w) => w && w.name));
    } catch (e) {
      if (!silent) {
        if (httpErrorStatus(e) === 403) {
          setWorkersError(tr("需要 Controller 管理员 token（L1）才能执行运行时升级"));
        } else {
          setWorkersError(e instanceof Error ? e.message : tr("加载失败"));
        }
      }
    }
  }, [tr]);

  React.useEffect(() => {
    void loadWorkers(false);
  }, [loadWorkers]);

  // 切 Tab 回来（rc-tabs 保活不重跑挂载 effect）→ 静默刷新。
  React.useEffect(() => {
    if (!refreshTick) return;
    void loadWorkers(true);
  }, [refreshTick, loadWorkers]);

  // 选中 worker → 轻探（当前版本 + 脚本可用性），重置下游状态。
  const onPickWorker = React.useCallback((name: string) => {
    setSelected(name);
    setLight(null);
    setFull(null);
    setVersion("");
    setJob(null);
    setStatus(null);
    setLightLoading(true);
    fetchUpgradeLightCheck(name)
      .then((d) => {
        setLight(d);
      })
      .catch((e) => {
        setLight({
          worker: name,
          container: `agentteams-worker-${name}`,
          current: null,
          supported: false,
        });
        if (e instanceof Error && e.message) {
          setWorkersError(e.message);
        }
      })
      .finally(() => setLightLoading(false));
  }, []);

  // 预检（完整 gate 检查）。
  const doCheck = React.useCallback(async () => {
    if (!selected || !version.trim()) return;
    setFullLoading(true);
    try {
      const d = await fetchUpgradeCheck(selected, version.trim(), verify);
      setFull(d);
    } catch (e) {
      antd.message.error(e instanceof Error ? e.message : tr("预检失败"));
    } finally {
      setFullLoading(false);
    }
  }, [selected, version, verify, tr]);

  // 触发升级（破坏性）。
  const doUpgrade = React.useCallback(async () => {
    if (!selected || !version.trim()) return;
    setConfirming(false);
    setRunning(true);
    try {
      const j = await runUpgrade(selected, version.trim());
      setJob(j);
      setStatus(null);
    } catch (e) {
      antd.message.error(e instanceof Error ? e.message : tr("触发升级失败"));
    } finally {
      setRunning(false);
    }
  }, [selected, version, tr]);

  // job 状态轮询（5s；终态即停；容器重启窗口内 404/超时静默重试）。
  const jobStateStr =
    (status?.state as Record<string, unknown> | undefined)?.state as
      | string
      | undefined;
  const jobActive = !!job && (jobStateStr === undefined ||
    !UPGRADE_TERMINAL_STATES.includes(jobStateStr));
  usePoller({
    fn: async () => {
      if (!job) return;
      try {
        const s = await fetchUpgradeStatus(job.worker, job.job_id);
        setStatus(s);
        const st = (s.state as Record<string, unknown> | undefined)?.state as
          | string
          | undefined;
        if (st === "success") qwenpawVersionCache.delete(job.worker);
      } catch {
        /* 瞬态失败（容器重启中）保留上次状态，下一轮再试 */
      }
    },
    intervalMs: 5000,
    active: opsActive && jobActive,
    minPokeMs: 3000,
  });

  const gates = full?.check?.checks || [];
  const overall = full?.check?.overall || "";
  const precheckFailed = overall === "FAIL";
  const canRun =
    !!light?.supported && version.trim().length > 0 && !running;

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
        <span style={{ fontWeight: 700, fontSize: 15 }}>{tr("运行时升级")}</span>
        <WbTooltip
          title={tr(
            "Worker 容器内 QwenPaw 运行时就地升级（两阶段编排、失败自动回滚）。当前仅支持 qwenpaw 运行时。触发升级会重启目标容器并中断在跑任务，需二次确认。",
          )}
        >
          <span style={{ color: t.textSecondary, cursor: "help", fontSize: 12 }}>
            ⓘ
          </span>
        </WbTooltip>
        <antd.Segmented
          size="small"
          value={mode}
          onChange={(v: string | number) => setMode(v as "single" | "batch")}
          options={[
            { label: tr("单 Worker"), value: "single" },
            { label: tr("批量"), value: "batch" },
          ]}
        />
        {mode === "single" && light?.current ? (
          <span
            style={{
              fontSize: 12,
              fontFamily: "ui-monospace, monospace",
              color: t.textSecondary,
            }}
          >
            {tr("当前")} {light.current}
          </span>
        ) : null}
        <div style={{ flex: 1 }} />
        <WbTooltip title={tr("刷新")}>
          <antd.Button
            type="text"
            size="small"
            icon={<ReloadIcon />}
            onClick={() => {
              void loadWorkers(false);
              if (selected) onPickWorker(selected);
            }}
          />
        </WbTooltip>
      </div>

      {/* QwenPaw only 提示（用户点名） */}
      <div
        style={{
          fontSize: 12,
          color: t.textSecondary,
          marginBottom: 10,
        }}
      >
        {tr("就地升级当前仅支持 qwenpaw 运行时（其他运行时请走镜像重建升级）。")}
      </div>

      {workersError ? (
        <antd.Alert
          type="warning"
          showIcon
          message={workersError}
          style={{ marginBottom: 10 }}
        />
      ) : null}

      {mode === "single" ? (
      <>
      {/* Worker 选择 */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <antd.Select
          style={{ minWidth: 260 }}
          placeholder={tr("选择要升级的 Worker")}
          value={selected || undefined}
          onChange={onPickWorker}
          showSearch
          optionFilterProp="label"
          options={workers.map((w) => ({
            value: w.name,
            label: w.name,
            disabled: w.runtime !== "qwenpaw",
          }))}
          optionRender={(opt: { value?: string; label?: ReactNS.ReactNode }) => {
            const w = workers.find((x) => x.name === opt.value);
            if (!w) return opt.label as ReactNS.ReactNode;
            return (
              <span>
                {w.name}
                <span
                  style={{
                    marginLeft: 8,
                    fontSize: 11,
                    color: w.runtime === "qwenpaw"
                      ? t.textSecondary
                      : "#e5484d",
                  }}
                >
                  {w.runtime === "qwenpaw"
                    ? w.runtime
                    : `${w.runtime || "unknown"}（${tr("仅 qwenpaw 可就地升级")}）`}
                </span>
              </span>
            );
          }}
        />
        {light ? (
          light.supported ? (
            <span style={{ fontSize: 12, color: t.textSecondary, alignSelf: "center" }}>
              {tr("当前")}：
              <b style={{ fontFamily: "ui-monospace, monospace", color: t.text }}>
                {light.current || "—"}
              </b>
            </span>
          ) : (
            <antd.Alert
              type="warning"
              showIcon
              message={tr(
                "该 Worker 镜像不支持就地升级（需 1.2.5+ 镜像，含内置升级脚本）。",
              )}
              style={{ alignSelf: "center" }}
            />
          )
        ) : lightLoading ? (
          <antd.Skeleton active title={false} paragraph={false} style={{ width: 120 }} />
        ) : null}
      </div>

      {/* 目标版本 + 预检 */}
      {selected && light?.supported ? (
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <antd.Input
              style={{ width: 200, fontFamily: "ui-monospace, monospace" }}
              placeholder={tr("目标版本，如 2.3.0")}
              value={version}
              onChange={(e: { target: { value: string } }) => {
                setVersion(String(e.target.value || ""));
                setFull(null);
              }}
              allowClear
            />
            <antd.Checkbox
              checked={verify}
              onChange={(e: { target: { checked: boolean } }) =>
                setVerify(!!e.target.checked)}
            >
              <WbTooltip title={tr("附加 wheel 可达性检查（从 PyPI 下载，耗时更长）")}>
                <span>{tr("验证 wheel 可达")}</span>
              </WbTooltip>
            </antd.Checkbox>
            <antd.Button
              onClick={() => void doCheck()}
              loading={fullLoading}
              disabled={!version.trim()}
            >
              {tr("预检")}
            </antd.Button>
            <antd.Button
              type="primary"
              danger
              icon={<CloudSyncIcon />}
              disabled={!canRun}
              loading={running}
              onClick={() => setConfirming(true)}
            >
              {tr("升级到此版本")}
            </antd.Button>
          </div>

          {/* 预检 gate 结果 */}
          {full ? (
            full.check ? (
              <div
                style={{
                  padding: 12,
                  borderRadius: 8,
                  border: `1px solid ${t.border}`,
                  background: t.cardBg,
                  display: "grid",
                  gap: 8,
                }}
              >
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <antd.Tag
                    color={
                      full.check.overall === "PASS"
                        ? "success"
                        : full.check.overall === "FAIL"
                          ? "error"
                          : "warning"
                    }
                  >
                    {full.check.overall}
                  </antd.Tag>
                  <span style={{ fontSize: 12, color: t.textSecondary }}>
                    {full.check.target || version}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {gates.map((g) => (
                    <WbTooltip
                      key={g.id}
                      title={`${g.name}：${g.evidence || "—"}${g.advice ? `\n${g.advice}` : ""}`}
                    >
                      <antd.Tag color={gateVariant(g)} style={{ cursor: "help" }}>
                        {g.id} {g.status}
                      </antd.Tag>
                    </WbTooltip>
                  ))}
                </div>
              </div>
            ) : (
              <antd.Alert
                type="warning"
                showIcon
                message={tr("预检输出解析失败，原始输出：")}
                description={
                  <pre style={{ margin: 0, fontSize: 11, whiteSpace: "pre-wrap" }}>
                    {full.raw || "—"}
                  </pre>
                }
              />
            )
          ) : null}

          {/* job 跟踪 */}
          {job ? (
            <div
              style={{
                padding: 12,
                borderRadius: 8,
                border: `1px solid ${t.border}`,
                background: t.cardBg,
                display: "grid",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <antd.Badge
                  status={jobStateVariant(jobStateStr)}
                  text={
                    <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }}>
                      {job.job_id}
                    </span>
                  }
                />
                {jobStateStr && (
                  <antd.Tag color={jobStateVariant(jobStateStr)}>{jobStateStr}</antd.Tag>
                )}
                <span style={{ fontSize: 12, color: t.textSecondary }}>
                  {tr("目标")}：
                  <b style={{ color: t.text }}>{job.version}</b>
                </span>
                {!!(status?.state as Record<string, unknown> | undefined)?.updated_at && (
                  <span style={{ fontSize: 11, color: t.textSecondary }}>
                    {fmtTime(String((status?.state as Record<string, unknown>).updated_at))}
                  </span>
                )}
                <div style={{ flex: 1 }} />
                {!jobActive && (
                  <antd.Tag color={jobStateVariant(jobStateStr)}>
                    {tr("已停止跟踪")}
                  </antd.Tag>
                )}
              </div>
              {/* state-file 全量（runner 任意字段，折叠 JSON 展示） */}
              {status?.state ? (
                <details>
                  <summary style={{ fontSize: 12, cursor: "pointer", color: t.textSecondary }}>
                    {tr("状态详情（state-file）")}
                  </summary>
                  <pre
                    style={{
                      margin: "6px 0 0",
                      padding: 8,
                      borderRadius: 6,
                      background: "#0d1117",
                      color: "#c9d1d9",
                      fontFamily: "ui-monospace, monospace",
                      fontSize: 11,
                      lineHeight: 1.5,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      maxHeight: 200,
                      overflowY: "auto",
                    }}
                  >
                    {JSON.stringify(
                      { state: status.state, pending: status.pending },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              ) : null}
              {!status && jobActive && (
                <span style={{ fontSize: 12, color: t.textSecondary }}>
                  {tr("等待状态文件（容器升级/重启中…）")}
                </span>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 破坏性二次确认 */}
      <antd.Modal
        open={confirming}
        title={tr("确认触发运行时升级？")}
        onCancel={() => setConfirming(false)}
        onOk={() => void doUpgrade()}
        okText={tr("确认升级")}
        okButtonProps={{ danger: true, loading: running }}
        cancelText={tr("取消")}
      >
        <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
          <span>
            {tr("Worker")}：<b>{selected}</b>
          </span>
          <span>
            {tr("目标版本")}：
            <b style={{ fontFamily: "ui-monospace, monospace" }}>{version.trim()}</b>
          </span>
          {precheckFailed ? (
            <antd.Alert
              type="error"
              showIcon
              message={tr("预检未通过（FAIL），不建议继续。")}
            />
          ) : null}
          <antd.Alert
            type="warning"
            showIcon
            message={tr(
              "升级将两阶段就地执行并重启该 Worker 容器，期间在跑任务会被中断；启动自检失败会自动回滚到旧版本。",
            )}
          />
        </div>
      </antd.Modal>
      </>
      ) : (
        <BatchBody workers={workers} />
      )}
    </div>
  );
}

/** 批量运行时升级（多选 qwenpaw worker）：
 *  检查更新（批量轻探→每 worker 当前版本+可否就地升级）
 *  + 顺序触发升级（一次一个，避容器重启互扰）+ 逐 worker job 跟踪。
 *  自包含 state，与单 Worker 流程隔离。 */
function BatchBody({ workers }: { workers: WorkerItem[] }) {
  const t = useThemeColors();
  const tr = useT();
  const opsActive = useTabActive("ops");

  const [selected, setSelected] = React.useState<string[]>([]);
  const [lightMap, setLightMap] = React.useState<
    Record<string, UpgradeCheckResult | null>
  >({});
  const [latestInfo, setLatestInfo] = React.useState<UpgradeLatest | null>(null);
  const [checkErr, setCheckErr] = React.useState<string | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [checkDone, setCheckDone] = React.useState(false);
  const [version, setVersion] = React.useState("");
  const [confirming, setConfirming] = React.useState(false);
  const [triggering, setTriggering] = React.useState(false);
  const [jobs, setJobs] = React.useState<Record<string, UpgradeRunHandle>>({});
  const [jobStatus, setJobStatus] = React.useState<
    Record<string, UpgradeStatusResult | null>
  >({});
  const [seqIdx, setSeqIdx] = React.useState(-1);

  const qwenpawWorkers = React.useMemo(
    () => workers.filter((w) => w.runtime === "qwenpaw"),
    [workers],
  );

  // 检查更新（15.26 简化）：最新=单次 PyPI 查询（后端 10min 缓存）；
  // 当前=各 worker 容器内 qwenpaw 运行时版（探测一次后模块级缓存，后续秒回）。
  // 取代旧「每次全量 N×docker exec」——只有未缓存的 worker 才探一次。
  const doCheckAll = React.useCallback(async () => {
    if (qwenpawWorkers.length === 0) return;
    setChecking(true);
    setCheckDone(false);
    setCheckErr(null);
    let latest = "";
    try {
      const info = await fetchUpgradeLatest();
      latest = info.latest || "";
      setLatestInfo(info);
      if (info.stale) setCheckErr(info.error || null);
    } catch (e) {
      setCheckErr(
        e instanceof Error ? `查询最新版本失败：${e.message}` : "查询最新版本失败",
      );
    }
    // 未缓存的 worker 探一次当前 qwenpaw 版（限并发 5 并行，一次性）。
    const missing = qwenpawWorkers.filter((w) => !qwenpawVersionCache.has(w.name));
    const CONC = 5;
    for (let i = 0; i < missing.length; i += CONC) {
      const batch = missing.slice(i, i + CONC);
      await Promise.all(
        batch.map(async (w) => {
          try {
            const lc = await fetchUpgradeLightCheck(w.name);
            if (lc.current) qwenpawVersionCache.set(w.name, lc.current);
          } catch {
            /* 探测失败→该 worker 当前版未知（不阻塞其他） */
          }
        }),
      );
    }
    const results: Record<string, UpgradeCheckResult | null> = {};
    for (const w of qwenpawWorkers) {
      const current = qwenpawVersionCache.get(w.name) || null;
      if (!current || !latest) {
        results[w.name] = { current, latest: latest || "", status: "unknown" };
      } else {
        const c = compareVersions(current, latest);
        results[w.name] = {
          current,
          latest,
          status: c < 0 ? "available" : "up-to-date",
        };
      }
    }
    setLightMap(results);
    setChecking(false);
    setCheckDone(true);
  }, [qwenpawWorkers]);

  // 顺序批量升级：一次触发一个，某 worker 触发失败即停（不继续）。
  const doBatchUpgrade = React.useCallback(async () => {
    if (selected.length === 0 || !version.trim()) return;
    setConfirming(false);
    setTriggering(true);
    for (let i = 0; i < selected.length; i++) {
      const w = selected[i];
      setSeqIdx(i);
      try {
        const j = await runUpgrade(w, version.trim());
        setJobs((prev) => ({ ...prev, [w]: j }));
      } catch (e) {
        antd.message.error(
          `${w}：${e instanceof Error ? e.message : tr("触发失败")}`,
        );
        break;
      }
    }
    setTriggering(false);
    setSeqIdx(-1);
  }, [selected, version, tr]);

  const jobEntries = Object.entries(jobs);
  const anyJobActive = jobEntries.some(([, j]) => {
    const st = (jobStatus[j.worker]?.state as Record<string, unknown> | undefined)
      ?.state as string | undefined;
    return st === undefined || !UPGRADE_TERMINAL_STATES.includes(st);
  });

  usePoller({
    fn: async () => {
      for (const j of Object.values(jobs)) {
        try {
          const s = await fetchUpgradeStatus(j.worker, j.job_id);
          setJobStatus((prev) => ({ ...prev, [j.worker]: s }));
          // 升级成功→当前 qwenpaw 版已变，清缓存（下次检查重新探测真值）。
          const st = (s.state as Record<string, unknown> | undefined)?.state as
            | string
            | undefined;
          if (st === "success") qwenpawVersionCache.delete(j.worker);
        } catch {
          /* 瞬态失败（容器重启中）保留上次状态，下一轮再试 */
        }
      }
    },
    intervalMs: 5000,
    active: opsActive && jobEntries.length > 0 && anyJobActive,
    minPokeMs: 3000,
  });

  return (
    <div style={{ display: "grid", gap: 10 }}>
      {/* 检查更新 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <antd.Button
          onClick={() => void doCheckAll()}
          loading={checking}
          disabled={qwenpawWorkers.length === 0}
        >
          {tr("检查更新")}
        </antd.Button>
        <span style={{ fontSize: 12, color: t.textSecondary }}>
          {tr(
            "当前=各 Worker 容器内 QwenPaw 运行时版（首查探一次后缓存），最新=单次查询，逐 Worker 匹配。",
          )}
        </span>
        {latestInfo?.latest ? (
          <antd.Tag color="processing">
            {tr("最新")} {latestInfo.latest}
            {latestInfo.cached ? tr("（缓存）") : ""}
          </antd.Tag>
        ) : null}
        {checkErr ? (
          <antd.Tag color="warning">{checkErr}</antd.Tag>
        ) : null}
      </div>

      {/* Worker 多选（qwenpaw 可选，其他运行时禁用） */}
      <antd.Select
        mode="multiple"
        style={{ width: "100%", maxWidth: 520 }}
        placeholder={tr("选择要升级的 Worker（仅 qwenpaw 可就地升级）")}
        value={selected}
        onChange={(v: string[]) => setSelected(v)}
        showSearch
        optionFilterProp="label"
        options={workers.map((w) => ({
          value: w.name,
          label: w.name,
          disabled: w.runtime !== "qwenpaw",
        }))}
        optionRender={(opt: { value?: string; label?: ReactNS.ReactNode }) => {
          const w = workers.find((x) => x.name === opt.value);
          if (!w) return opt.label as ReactNS.ReactNode;
          return (
            <span>
              {w.name}
              <span
                style={{
                  marginLeft: 8,
                  fontSize: 11,
                  color: w.runtime === "qwenpaw" ? t.textSecondary : "#e5484d",
                }}
              >
                {w.runtime === "qwenpaw"
                  ? w.runtime
                  : `${w.runtime || "unknown"}（${tr("仅 qwenpaw 可就地升级")}）`}
              </span>
            </span>
          );
        }}
      />

      {/* 检查更新结果（响应式卡片网格：卡片随屏宽自动换行排列，不整行占位） */}
      {checking || checkDone ? (
        <div
          style={{
            display: "grid",
            gap: 8,
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          }}
        >
          {qwenpawWorkers.map((w) => {
            const lc = lightMap[w.name];
            return (
              <div
                key={w.name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "6px 10px",
                  borderRadius: 8,
                  border: `1px solid ${t.border}`,
                  background: t.cardBg,
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 12,
                    flex: "1 1 auto",
                    minWidth: 0,
                  }}
                >
                  {w.name}
                </span>
                {checking && !lc ? (
                  <antd.Skeleton
                    active
                    title={false}
                    paragraph={false}
                    style={{ width: 120 }}
                  />
                ) : lc ? (
                  <>
                    <span
                      style={{
                        fontSize: 12,
                        fontFamily: "ui-monospace, monospace",
                        color: t.text,
                      }}
                    >
                      {lc.current || tr("未知")}
                      {lc.status === "available" && lc.latest
                        ? ` → ${lc.latest}`
                        : ""}
                    </span>
                    {lc.status === "available" ? (
                      <antd.Tag color="error">{tr("可升级")}</antd.Tag>
                    ) : lc.status === "up-to-date" ? (
                      <antd.Tag color="success">{tr("最新")}</antd.Tag>
                    ) : (
                      <antd.Tag color="warning">{tr("未知版本")}</antd.Tag>
                    )}
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {/* 目标版本 + 批量升级 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <antd.Input
          style={{ width: 200, fontFamily: "ui-monospace, monospace" }}
          placeholder={tr("目标版本，如 2.3.0")}
          value={version}
          onChange={(e: { target: { value: string } }) =>
            setVersion(String(e.target.value || ""))}
          allowClear
        />
        <antd.Button
          type="primary"
          danger
          icon={<CloudSyncIcon />}
          disabled={selected.length === 0 || !version.trim() || triggering}
          loading={triggering}
          onClick={() => setConfirming(true)}
        >
          {tr("批量升级（{n}）", { n: selected.length })}
        </antd.Button>
        <span style={{ fontSize: 12, color: t.textSecondary }}>
          {tr("顺序执行（一次一个 worker，避免容器重启互扰）。")}
        </span>
      </div>

      {/* 逐 worker job 跟踪（响应式卡片网格，随屏宽排列） */}
      {jobEntries.length > 0 ? (
        <div
          style={{
            display: "grid",
            gap: 8,
            gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
          }}
        >
          {jobEntries.map(([w, j], idx) => {
            const st = (jobStatus[j.worker]?.state as
              | Record<string, unknown>
              | undefined)?.state as string | undefined;
            return (
              <div
                key={w}
                style={{
                  padding: 10,
                  borderRadius: 8,
                  border: `1px solid ${t.border}`,
                  background: t.cardBg,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  {w}
                </span>
                <antd.Badge
                  status={jobStateVariant(st)}
                  text={
                    <span
                      style={{
                        fontFamily: "ui-monospace, monospace",
                        fontSize: 11,
                      }}
                    >
                      {j.job_id}
                    </span>
                  }
                />
                {st ? <antd.Tag color={jobStateVariant(st)}>{st}</antd.Tag> : null}
                <span style={{ fontSize: 12, color: t.textSecondary }}>
                  {tr("目标")} <b style={{ color: t.text }}>{j.version}</b>
                </span>
                {idx === seqIdx && triggering ? (
                  <antd.Tag color="processing">{tr("触发中")}</antd.Tag>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {/* 破坏性二次确认 */}
      <antd.Modal
        open={confirming}
        title={tr("确认触发批量运行时升级？")}
        onCancel={() => setConfirming(false)}
        onOk={() => void doBatchUpgrade()}
        okText={tr("确认升级")}
        okButtonProps={{ danger: true, loading: triggering }}
        cancelText={tr("取消")}
      >
        <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
          <span>
            {tr("Worker（{n} 个）", { n: selected.length })}：
            {selected.join("、")}
          </span>
          <span>
            {tr("目标版本")}：
            <b style={{ fontFamily: "ui-monospace, monospace" }}>
              {version.trim()}
            </b>
          </span>
          <antd.Alert
            type="warning"
            showIcon
            message={tr(
              "将按顺序对每个 Worker 两阶段就地升级并重启容器，期间在跑任务会被中断；启动自检失败会自动回滚到旧版本。",
            )}
          />
        </div>
      </antd.Modal>
    </div>
  );
}

export default React.memo(RuntimeUpgradePanel);
