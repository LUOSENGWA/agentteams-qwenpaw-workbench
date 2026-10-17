import type * as ReactNS from "react";

import {
  fetchUpgradeCheck,
  fetchUpgradeStatus,
  httpErrorStatus,
  runUpgrade,
  UPGRADE_TERMINAL_STATES,
  type UpgradeCandidate,
  type UpgradeCheckResult,
  type UpgradeGate,
  type UpgradeJob,
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
const CloudSyncIcon = pick("CloudSyncOutlined");

/** 门控状态 → Tag 色（六态保守映射）。 */
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

/** 门控短标签（tr 参数化——模块级常量在 EN 模式会泄漏中文）。 */
function gateLabel(tr: (k: string) => string, k: string): string {
  switch (k) {
    case "C1":
      return tr("C1 版本解析");
    case "C2":
      return tr("C2 依赖钉定");
    case "C3":
      return tr("C3 兼容补丁");
    case "C4":
      return tr("C4 可选依赖");
    default:
      return k;
  }
}

function fmtTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours(),
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 候选行：版本 + 四门控 + 推荐/可升级 标记。 */
function CandidateRow({
  c,
  t,
  tr,
  onUpgrade,
  running,
}: {
  c: UpgradeCandidate;
  t: ReturnType<typeof useThemeColors>;
  tr: (k: string) => string;
  onUpgrade: (v: string) => void;
  running: boolean;
}) {
  return (
    <div
      style={{
        padding: "10px 12px",
        borderRadius: 8,
        background: t.cardBg,
        border: `1px solid ${t.border}`,
        display: "grid",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 13,
            fontWeight: 600,
            color: t.text,
          }}
        >
          {c.version}
        </span>
        {c.prerelease && <antd.Tag color="orange">{tr("预发布")}</antd.Tag>}
        {c.recommended && <antd.Tag color="blue">{tr("推荐")}</antd.Tag>}
        <div style={{ flex: 1 }} />
        {c.published_at && (
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {fmtTime(c.published_at)}
          </span>
        )}
        <antd.Button
          size="small"
          type={c.recommended ? "primary" : "default"}
          disabled={!c.upgradeable || running}
          icon={<CloudSyncIcon />}
          onClick={() => onUpgrade(c.version)}
        >
          {tr("升级到此版本")}
        </antd.Button>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {(["C1", "C2", "C3", "C4"] as const).map((k) => {
          const g = c.gates?.[k];
          if (!g) return null;
          return (
            <WbTooltip
              key={k}
              title={`${gateLabel(tr, k)}：${g.evidence || "—"}`}
            >
              <antd.Tag color={gateVariant(g)} style={{ cursor: "help" }}>
                {gateLabel(tr, k)} {g.status}
              </antd.Tag>
            </WbTooltip>
          );
        })}
      </div>
    </div>
  );
}

/** 运行时升级段（运维页内）。预检只读 + 手动触发（二次确认）+ job 跟踪。
 * 无升级服务的实例（旧镜像/非 worker 宿主）404 → 优雅空态，不报错。 */
function RuntimeUpgradePanel({ refreshTick = 0 }: { refreshTick?: number }) {
  const t = useThemeColors();
  const tr = useT();
  const opsActive = useTabActive("ops");
  const [check, setCheck] = React.useState<UpgradeCheckResult | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [notDeployed, setNotDeployed] = React.useState(false);
  const [loadError, setLoadError] = React.useState("");
  const [confirmVersion, setConfirmVersion] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);
  const [job, setJob] = React.useState<UpgradeJob | null>(null);

  const refreshCheck = React.useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const data = await fetchUpgradeCheck();
        setCheck(data);
        setLoadError("");
        setNotDeployed(false);
      } catch (e) {
        if (httpErrorStatus(e) === 404) {
          setNotDeployed(true);
        } else if (!silent) {
          setLoadError(e instanceof Error ? e.message : tr("加载失败"));
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  React.useEffect(() => {
    void refreshCheck(false);
  }, [refreshCheck]);

  // 切 Tab 回来（rc-tabs 保活不重跑挂载 effect）→ 静默刷新。
  React.useEffect(() => {
    if (!refreshTick) return;
    void refreshCheck(true);
  }, [refreshTick, refreshCheck]);

  // job 进行中 → 5s 轮询状态（终态即停，由 active 门控）。
  const jobActive =
    !!job && !UPGRADE_TERMINAL_STATES.includes(job.state as never);
  usePoller({
    fn: async () => {
      try {
        setJob(await fetchUpgradeStatus(job?.job_id));
      } catch {
        /* 瞬态失败保留上次状态，下一轮再试 */
      }
    },
    intervalMs: 5000,
    active: opsActive && jobActive,
    minPokeMs: 3000,
  });

  const doUpgrade = React.useCallback(async (version: string) => {
    setConfirmVersion(null);
    setRunning(true);
    try {
      const j = await runUpgrade(version);
      setJob(j);
    } catch (e) {
      antd.message.error(
        e instanceof Error ? e.message : tr("触发升级失败"),
      );
    } finally {
      setRunning(false);
    }
  }, [tr]);

  const jobStateVariant = (s?: string): "processing" | "success" | "error" | "warning" | "default" => {
    switch (s) {
      case "success":
        return "success";
      case "rolled_back":
      case "rollback_failed":
      case "precheck_failed":
        return "error";
      case "recovering":
        return "warning";
      case "running":
      case "boot-check-passed":
        return "processing";
      default:
        return "default";
    }
  };

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
            "本宿主 QwenPaw 运行时的预检与就地升级（两阶段编排、失败自动回滚）。预检只读；触发升级会重启容器并可能中断在跑任务，需二次确认。",
          )}
        >
          <span style={{ color: t.textSecondary, cursor: "help", fontSize: 12 }}>
            ⓘ
          </span>
        </WbTooltip>
        {check && !notDeployed && (
          <span
            style={{
              fontSize: 12,
              fontFamily: "ui-monospace, monospace",
              color: t.textSecondary,
            }}
          >
            {tr("当前")} {check.current}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <WbTooltip title={tr("刷新")}>
          <antd.Button
            type="text"
            size="small"
            icon={<ReloadIcon />}
            loading={loading}
            onClick={() => void refreshCheck(false)}
          />
        </WbTooltip>
      </div>

      {/* 态：未部署 / 错误 / 内容 */}
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
          {tr("当前宿主未提供运行时升级服务（需 1.2.5+ worker 镜像内置升级插件）。")}
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
      ) : loading && !check ? (
        <div style={{ padding: 16 }}>
          <antd.Skeleton active title={false} paragraph={{ rows: 3 }} />
        </div>
      ) : check ? (
        <div style={{ display: "grid", gap: 10 }}>
          {/* 预检告警（网络/索引问题，check 恒 200 落 errors[]） */}
          {check.errors?.length > 0 && (
            <antd.Alert
              type="warning"
              showIcon
              message={tr("预检存在告警（不影响已有结论）")}
              description={
                <div style={{ display: "grid", gap: 2 }}>
                  {check.errors.map((e, i) => (
                    <span key={i} style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
                      {e}
                    </span>
                  ))}
                </div>
              }
            />
          )}
          {/* job 跟踪（触发后出现） */}
          {job && (
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
                <antd.Badge status={jobStateVariant(job.state)} text={
                  <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }}>
                    {job.job_id}
                  </span>
                } />
                <antd.Tag color={jobStateVariant(job.state)}>{job.state}</antd.Tag>
                {job.phase && <antd.Tag color="default">{tr("阶段")}: {job.phase}</antd.Tag>}
                {job.current && (
                  <span style={{ fontSize: 12, color: t.textSecondary }}>
                    {job.current} → <b style={{ color: t.text }}>{job.target}</b>
                  </span>
                )}
                <div style={{ flex: 1 }} />
                {job.started_at && (
                  <span style={{ fontSize: 11, color: t.textSecondary }}>
                    {fmtTime(job.started_at)}
                  </span>
                )}
              </div>
              {job.log_tail?.length ? (
                <pre
                  style={{
                    margin: 0,
                    padding: 8,
                    borderRadius: 6,
                    background: "#0d1117",
                    color: "#c9d1d9",
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 11,
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    maxHeight: 160,
                    overflowY: "auto",
                  }}
                >
                  {job.log_tail.join("\n")}
                </pre>
              ) : (
                !jobActive && (
                  <span style={{ fontSize: 12, color: t.textSecondary }}>
                    {tr("（无日志内容）")}
                  </span>
                )
              )}
            </div>
          )}
          {/* 候选列表 */}
          {check.candidates.length === 0 ? (
            <antd.Empty
              description={tr("暂无可升级版本")}
              image={antd.Empty.PRESENTED_IMAGE_SIMPLE}
            />
          ) : (
            check.candidates.map((c) => (
              <CandidateRow
                key={c.version}
                c={c}
                t={t}
                tr={tr}
                running={running || jobActive}
                onUpgrade={(v) => setConfirmVersion(v)}
              />
            ))
          )}
        </div>
      ) : null}

      {/* 破坏性二次确认 */}
      <antd.Modal
        open={!!confirmVersion}
        title={tr("确认触发运行时升级？")}
        onCancel={() => setConfirmVersion(null)}
        onOk={() => {
          if (confirmVersion) void doUpgrade(confirmVersion);
        }}
        okText={tr("确认升级")}
        okButtonProps={{ danger: true, loading: running }}
        cancelText={tr("取消")}
      >
        <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
          <span>
            {tr("目标版本")}：
            <b style={{ fontFamily: "ui-monospace, monospace" }}>{confirmVersion}</b>
          </span>
          <antd.Alert
            type="warning"
            showIcon
            message={tr(
              "升级将两阶段就地执行并重启容器，期间在跑任务会被中断；启动自检失败会自动回滚到旧版本。",
            )}
          />
        </div>
      </antd.Modal>
    </div>
  );
}

export default React.memo(RuntimeUpgradePanel);
