import type * as ReactNS from "react";

import {
  fetchUpgradeCheck,
  fetchUpgradeLightCheck,
  fetchUpgradeStatus,
  httpErrorStatus,
  requestJson,
  runUpgrade,
  UPGRADE_TERMINAL_STATES,
  type UpgradeFullCheck,
  type UpgradeGate,
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
        setStatus(await fetchUpgradeStatus(job.worker, job.job_id));
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
        {light?.current && (
          <span
            style={{
              fontSize: 12,
              fontFamily: "ui-monospace, monospace",
              color: t.textSecondary,
            }}
          >
            {tr("当前")} {light.current}
          </span>
        )}
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
    </div>
  );
}

export default React.memo(RuntimeUpgradePanel);
