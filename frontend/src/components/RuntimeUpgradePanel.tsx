import type * as ReactNS from "react";

import {
  fetchNodeVersion,
  fetchUpgradeCheckAll,
  fetchUpgradeStatus,
  fetchUpgradeVersions,
  httpErrorStatus,
  requestJson,
  runUpgrade,
  UPGRADE_TERMINAL_STATES,
  type NodeVersion,
  type UpgradeCheckAll,
  type UpgradeRunHandle,
  type UpgradeStatusResult,
  type UpgradeVersionRow,
} from "../api";
import VersionTablePicker from "./VersionTablePicker";
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
  /** 所属团队（controller /workers 列表回显；空=未分组）。 */
  team?: string;
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
  error?: string; // 探测失败原因（worker 级降级，不阻塞整体）
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

/** 大版本号（第一个数字段；非法→0）。 */
function majorOf(v: string): number {
  const n = parseInt(v.replace(/^[v=]+/, "").split(/[.+-]/)[0], 10);
  return isNaN(n) ? 0 : n;
}

/** 升级兼容性本地判断（15.36 B，单 worker + 批量共用）：
 * same=目标与当前同版（禁升）；downgrade=目标低于当前（红警告+确认带警告）；
 * cross-major=目标更高但大版本号不同（黄警告）；upgrade=常规升级；
 * unknown=当前版未知（不判断）。 */
function assessUpgradeCompat(
  current: string | null,
  target: string,
): {
  kind: "same" | "downgrade" | "cross-major" | "upgrade" | "unknown";
  fromMajor?: number;
  toMajor?: number;
} {
  const tg = target.trim();
  if (!current || !tg) return { kind: "unknown" };
  const c = compareVersions(current, tg);
  if (c === 0) return { kind: "same" };
  if (c > 0) return { kind: "downgrade" };
  const fm = majorOf(current);
  const tm = majorOf(tg);
  if (fm !== tm) return { kind: "cross-major", fromMajor: fm, toMajor: tm };
  return { kind: "upgrade" };
}

/** job state-file 的 note 字段（runner._mark_failed 写入：预检详情 /
 * 回滚原因 / 健康门等待）——无 note 返回空串。 */
function jobNoteOf(st?: Record<string, unknown> | null): string {
  const n = st?.note;
  return typeof n === "string" && n.trim() ? n : "";
}

/** 运行时升级段（双模态，15.35 单 worker 化）：
 * - 单 worker 紧凑模式（workerName 给定——Worker 详情「运行时升级」卡）：
 *   头部=该 worker 名 + 当前 runtime 版本（fetchNodeVersion，Worker 详情
 *   同款 L1 拨号）；[检查更新]=check-all 取该行本地匹配（可升级/已是最新）；
 *   [升级]=仅可升级时启用 → 二次确认（破坏性·容器重启·在跑任务中断·失败
 *   自动回滚）→ runUpgrade → 5s 轮询 fetchUpgradeStatus 至终态。
 *   无 worker 列表/勾选/批量顺序执行/多版本选择。
 * - 批量模式（workerName 缺省——保留 BatchBody 原行为）。
 * 非 qwenpaw 运行时（runtime 给定且 ≠qwenpaw）→ 只读提示，无升级按钮。 */
function RuntimeUpgradePanel({
  refreshTick = 0,
  active = false,
  workerName,
  runtime,
}: {
  refreshTick?: number;
  /** 宿主显式激活（管理页二级页/弹窗场景——原 useTabActive("ops")
   * 门在顶层运维 tab 移除后恒 false，改由宿主传入）。 */
  active?: boolean;
  /** 给定 = 单 worker 紧凑模式（worker 详情卡）；缺省 = 批量模式。 */
  workerName?: string;
  /** Worker 运行时（worker 详情上下文透传）——非 qwenpaw 的确定性
   * 只读提示判定，免拨号。 */
  runtime?: string;
}) {
  const t = useThemeColors();
  const tr = useT();
  const single = !!workerName;

  const [workers, setWorkers] = React.useState<WorkerItem[]>([]);
  const [workersError, setWorkersError] = React.useState("");
  // 单模态「刷新」= 重新拨号 node-version（refresh=1 绕过 10min 缓存）。
  const [singleTick, setSingleTick] = React.useState(0);

  // workers 目录（L1；403=未配 token → 引导空态）。批量模式专用。
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
    if (single) return;
    void loadWorkers(false);
  }, [loadWorkers, single]);

  // 切 Tab 回来（rc-tabs 保活不重跑挂载 effect）→ 静默刷新。批量模式专用。
  React.useEffect(() => {
    if (!refreshTick || single) return;
    void loadWorkers(true);
  }, [refreshTick, loadWorkers, single]);

  const onRefresh = React.useCallback(() => {
    if (single) {
      setSingleTick((v) => v + 1);
    } else {
      void loadWorkers(false);
    }
  }, [single, loadWorkers]);

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
        <div style={{ flex: 1 }} />
        <WbTooltip title={tr("刷新")}>
          <antd.Button
            type="text"
            size="small"
            icon={<ReloadIcon />}
            onClick={onRefresh}
          />
        </WbTooltip>
      </div>

      {single ? (
        <SingleWorkerBody
          workerName={workerName as string}
          runtime={runtime}
          active={active}
          refreshKey={singleTick}
        />
      ) : (
        <>
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

          <BatchBody workers={workers} active={active} />
        </>
      )}
    </div>
  );
}

/** 单 worker 紧凑模式（15.35）：Worker 详情「运行时升级」卡内嵌。
 * 只显该 worker：当前 runtime 版本 + [检查更新] + [升级]（仅可升级时
 * 启用）+ job 跟踪卡（轮询至终态）。列表/勾选/批量 UI 一概不出。
 * 自包含 state（懒挂载=弹窗打开才拨号，与卡语义一致）。 */
function SingleWorkerBody({
  workerName,
  runtime,
  active = false,
  refreshKey = 0,
}: {
  workerName: string;
  runtime?: string;
  active?: boolean;
  /** 段头「刷新」bump——>0 时 node-version 带 refresh=1 绕过缓存实读。 */
  refreshKey?: number;
}) {
  const t = useThemeColors();
  const tr = useT();

  const nonQwenpaw = !!runtime && runtime !== "qwenpaw";

  // 当前 runtime 版本（L1 拨号，服务端 10min 缓存；Worker 详情同款模式）。
  const [nodeVer, setNodeVer] = React.useState<NodeVersion | null>(null);
  const [nodeVerErr, setNodeVerErr] = React.useState("");
  const [l1Denied, setL1Denied] = React.useState(false);
  React.useEffect(() => {
    if (nonQwenpaw) return; // 非 qwenpaw → 只读提示，不拨号
    let alive = true;
    setNodeVer(null);
    setNodeVerErr("");
    setL1Denied(false);
    fetchNodeVersion(workerName, refreshKey > 0)
      .then((d) => {
        if (alive) setNodeVer(d);
      })
      .catch((e) => {
        if (!alive) return;
        if (httpErrorStatus(e) === 403) {
          setL1Denied(true);
        } else {
          setNodeVerErr(e instanceof Error ? e.message : tr("探测失败"));
        }
      });
    return () => {
      alive = false;
    };
  }, [workerName, nonQwenpaw, refreshKey, tr]);

  // 检查更新：check-all（服务端 10min 缓存）取本 worker 行 → 本地匹配。
  const [check, setCheck] = React.useState<UpgradeCheckResult | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [checkErr, setCheckErr] = React.useState<string | null>(null);
  const doCheck = React.useCallback(async () => {
    setChecking(true);
    setCheck(null);
    setCheckErr(null);
    try {
      const d = await fetchUpgradeCheckAll();
      const row = d.workers.find((x) => x.name === workerName);
      const latest = d.latest || "";
      const current = row?.current ?? null;
      if (current) qwenpawVersionCache.set(workerName, current);
      if (!current || !latest || row?.error) {
        setCheck({
          current,
          latest,
          status: "unknown",
          error: row?.error || (!latest ? d.error : undefined) || tr("无匹配项"),
        });
      } else {
        const c = compareVersions(current, latest);
        setCheck({
          current,
          latest,
          status: c < 0 ? "available" : "up-to-date",
        });
      }
    } catch (e) {
      setCheckErr(e instanceof Error ? e.message : tr("检查更新失败"));
    } finally {
      setChecking(false);
    }
  }, [workerName]);

  // 目标版本下拉（15.36 B）：检查出 latest 后出现，默认 latest；
  // 选项=release 列表排除 yanked，拉取失败降级=仅 latest 一项。
  const [versionSel, setVersionSel] = React.useState("");
  const [versions, setVersions] = React.useState<UpgradeVersionRow[]>([]);
  React.useEffect(() => {
    if (!check?.latest) return;
    let alive = true;
    setVersionSel(check.latest);
    setVersions([]);
    fetchUpgradeVersions()
      .then((d) => {
        if (alive) setVersions((d.versions || []).filter((v) => !v.yanked));
      })
      .catch(() => {
        /* 拉取失败 → versions 保持空 → 选项降级仅 latest */
      });
    return () => {
      alive = false;
    };
    // check 身份每次 doCheck 变化但 latest 同串时不重置用户选择。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [check?.latest]);

  const canPick = !!check?.latest;
  const versionOptions = React.useMemo(() => {
    const rows: UpgradeVersionRow[] = versions.length
      ? versions
      : check?.latest
        ? [
            {
              version: check.latest,
              upload_time: "",
              size: 0,
              prerelease: false,
              yanked: false,
              is_latest: true,
            },
          ]
        : [];
    return rows.map((r) => ({
      value: r.version,
      label:
        r.version +
        (r.prerelease ? " " + tr("预发布") : "") +
        (r.is_latest ? " " + tr("最新") : ""),
    }));
  }, [versions, check?.latest, tr]);

  // 升级：目标=选中版本（默认 latest）；同版禁升；二次确认 → runUpgrade
  // → 5s 轮询至终态。
  const [confirming, setConfirming] = React.useState(false);
  const [job, setJob] = React.useState<UpgradeRunHandle | null>(null);
  const [jobStatus, setJobStatus] = React.useState<UpgradeStatusResult | null>(null);
  const [triggering, setTriggering] = React.useState(false);

  const jobState = (jobStatus?.state as Record<string, unknown> | undefined)
    ?.state as string | undefined;
  const jobTerminal =
    !!jobState && UPGRADE_TERMINAL_STATES.includes(jobState);
  const jobNote = jobNoteOf(jobStatus?.state);

  const doUpgrade = React.useCallback(async () => {
    const target = (versionSel || check?.latest || "").trim();
    if (!target) return;
    setConfirming(false);
    setTriggering(true);
    try {
      const j = await runUpgrade(workerName, target);
      setJob(j);
      setJobStatus(null);
    } catch (e) {
      antd.message.error(
        `${workerName}：${e instanceof Error ? e.message : tr("触发失败")}`,
      );
    } finally {
      setTriggering(false);
    }
  }, [workerName, check, versionSel, tr]);

  usePoller({
    fn: async () => {
      if (!job) return;
      try {
        const s = await fetchUpgradeStatus(job.worker, job.job_id);
        setJobStatus(s);
        // 升级成功→当前 qwenpaw 版已变，清缓存 + 重拨真值（绕过 10min 缓存）。
        const st = (s.state as Record<string, unknown> | undefined)?.state as
          | string
          | undefined;
        if (st === "success") {
          qwenpawVersionCache.delete(job.worker);
          fetchNodeVersion(job.worker, true)
            .then(setNodeVer)
            .catch(() => {
              /* 重拨失败保留旧值，点「刷新」兜底 */
            });
        }
      } catch {
        /* 瞬态失败（容器重启中）保留上次状态，下一轮再试 */
      }
    },
    intervalMs: 5000,
    active: active && !!job && !jobTerminal,
    minPokeMs: 3000,
  });

  // 非 qwenpaw 运行时 → 只读提示（无升级按钮）。
  if (nonQwenpaw) {
    return (
      <div style={{ display: "grid", gap: 10 }}>
        <div
          style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
        >
          <span
            style={{
              fontFamily: "ui-monospace, monospace",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {workerName}
          </span>
          <antd.Tag>{runtime}</antd.Tag>
        </div>
        <antd.Alert
          type="info"
          showIcon
          message={tr(
            "就地升级当前仅支持 qwenpaw 运行时（其他运行时请走镜像重建升级）。",
          )}
        />
      </div>
    );
  }

  const current =
    nodeVer?.runtime_version || qwenpawVersionCache.get(workerName) || null;

  // 兼容性本地判断（15.36 B）：目标=选中版本（默认 latest）vs 当前版。
  const targetVersion = (versionSel || check?.latest || "").trim();
  const compat = targetVersion
    ? assessUpgradeCompat(current, targetVersion)
    : null;
  const selPrerelease =
    versions.find((v) => v.version === targetVersion)?.prerelease === true;

  return (
    <div style={{ display: "grid", gap: 10 }}>
      {/* worker 名 + 当前 runtime 版本 */}
      <div
        style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
      >
        <span
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {workerName}
        </span>
        {current ? (
          <antd.Tag color="processing" style={{ marginInlineEnd: 0 }}>
            {tr("运行时版本")} {current}
          </antd.Tag>
        ) : nodeVerErr ? (
          <WbTooltip title={nodeVerErr}>
            <antd.Tag color="warning" style={{ marginInlineEnd: 0 }}>
              {tr("探测失败")}
            </antd.Tag>
          </WbTooltip>
        ) : null}
      </div>

      {l1Denied ? (
        <antd.Alert
          type="warning"
          showIcon
          message={tr("需要 Controller 管理员 token（L1）才能执行运行时升级")}
        />
      ) : null}

      {/* 检查更新 + 结果 */}
      <div
        style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
      >
        <antd.Button
          onClick={() => void doCheck()}
          loading={checking}
          disabled={l1Denied}
        >
          {tr("检查更新")}
        </antd.Button>
        <span style={{ fontSize: 12, color: t.textSecondary }}>
          {tr(
            "当前=该 Worker 容器内 QwenPaw 运行时版（服务端 10min 缓存），最新=PyPI（缓存）。",
          )}
        </span>
        {check?.status === "available" && check.latest ? (
          <antd.Tag color="error" style={{ marginInlineEnd: 0 }}>
            {tr("可升级")} → {check.latest}
          </antd.Tag>
        ) : check?.status === "up-to-date" ? (
          <antd.Tag color="success" style={{ marginInlineEnd: 0 }}>
            {tr("已是最新")}
          </antd.Tag>
        ) : null}
        {checkErr ? <antd.Tag color="warning">{checkErr}</antd.Tag> : null}
      </div>

      {/* 目标版本下拉 + 兼容性提示（15.36 B：检查后出现；
       * 降级红 / 跨大版本黄 / 预发布灰 Tag / 同版禁用升级钮） */}
      {canPick ? (
        <div style={{ display: "grid", gap: 6 }}>
          <div
            style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
          >
            <span style={{ fontSize: 12, color: t.textSecondary }}>
              {tr("目标版本")}
            </span>
            <antd.Select
              style={{ width: 240 }}
              value={versionSel || undefined}
              onChange={(v: string) => setVersionSel(v)}
              options={versionOptions}
              placeholder={tr("选择目标版本")}
              aria-label={tr("目标版本")}
            />
            {selPrerelease ? (
              <antd.Tag style={{ marginInlineEnd: 0 }}>
                {tr("预发布")}
              </antd.Tag>
            ) : null}
            {compat?.kind === "same" ? (
              <antd.Tag color="success" style={{ marginInlineEnd: 0 }}>
                {tr("已是当前版本")}
              </antd.Tag>
            ) : null}
          </div>
          {compat?.kind === "downgrade" ? (
            <antd.Alert
              type="error"
              showIcon
              message={tr(
                "⚠️ 目标版本 {target} 低于当前版 {current}——降级可能不兼容",
                { target: targetVersion, current: current ?? "" },
              )}
            />
          ) : null}
          {compat?.kind === "cross-major" ? (
            <antd.Alert
              type="warning"
              showIcon
              message={tr(
                "跨大版本升级（{from} → {to}）——跨大版本变更可能不向后兼容",
                {
                  from: String(compat.fromMajor),
                  to: String(compat.toMajor),
                },
              )}
            />
          ) : null}
        </div>
      ) : null}

      {/* 升级（检查后可用；同版禁升；job 进行中不重复触发） */}
      <div>
        <antd.Button
          type="primary"
          danger
          icon={<CloudSyncIcon />}
          disabled={
            !canPick ||
            check?.status === "unknown" ||
            compat?.kind === "same" ||
            triggering ||
            (!!job && !jobTerminal)
          }
          loading={triggering}
          onClick={() => setConfirming(true)}
        >
          {tr("升级")}
        </antd.Button>
      </div>

      {/* job 跟踪卡（轮询至终态） */}
      {job ? (
        <div
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
          <antd.Badge
            status={jobStateVariant(jobState)}
            text={
              <span
                style={{
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 11,
                }}
              >
                {job.job_id}
              </span>
            }
          />
          {jobState ? (
            <antd.Tag color={jobStateVariant(jobState)} style={{ marginInlineEnd: 0 }}>
              {jobState}
            </antd.Tag>
          ) : null}
          {jobState === "success" ? (
            <antd.Tag color="success" style={{ marginInlineEnd: 0 }}>
              {tr("升级成功")}
            </antd.Tag>
          ) : null}
          <span style={{ fontSize: 12, color: t.textSecondary }}>
            {tr("目标")} <b style={{ color: t.text }}>{job.version}</b>
          </span>
          {jobState === "precheck_failed" ? (
            <antd.Alert
              type="error"
              showIcon
              style={{ flexBasis: "100%", margin: 0 }}
              message={tr("兼容性检查失败：{detail}", {
                detail: jobNote || "—",
              })}
            />
          ) : null}
          {jobNote && jobState !== "precheck_failed" ? (
            <span
              style={{
                flexBasis: "100%",
                fontSize: 11,
                color: t.textSecondary,
                wordBreak: "break-all",
              }}
            >
              {jobNote}
            </span>
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
        okButtonProps={{ danger: true, loading: triggering }}
        cancelText={tr("取消")}
      >
        <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
          <span>
            {tr("目标版本")}：
            <b style={{ fontFamily: "ui-monospace, monospace" }}>
              {targetVersion}
            </b>
          </span>
          {compat?.kind === "downgrade" ? (
            <antd.Alert
              type="error"
              showIcon
              message={tr(
                "⚠️ 目标版本 {target} 低于当前版 {current}——降级可能不兼容",
                { target: targetVersion, current: current ?? "" },
              )}
            />
          ) : null}
          {compat?.kind === "cross-major" ? (
            <antd.Alert
              type="warning"
              showIcon
              message={tr(
                "跨大版本升级（{from} → {to}）——跨大版本变更可能不向后兼容",
                {
                  from: String(compat.fromMajor),
                  to: String(compat.toMajor),
                },
              )}
            />
          ) : null}
          <antd.Alert
            type="warning"
            showIcon
            message={tr(
              "破坏性操作：将重启 {name} 容器并中断在跑任务；两阶段就地升级，启动自检失败会自动回滚到旧版本。",
              { name: workerName },
            )}
          />
        </div>
      </antd.Modal>
    </div>
  );
}

/** 批量运行时升级（多选 qwenpaw worker）：
 *  检查更新（批量轻探→每 worker 当前版本+可否就地升级）
 *  + 顺序触发升级（一次一个，避容器重启互扰）+ 逐 worker job 跟踪。
 *  自包含 state，与单 Worker 流程隔离。 */
function BatchBody({
  workers,
  active = false,
}: {
  workers: WorkerItem[];
  active?: boolean;
}) {
  const t = useThemeColors();
  const tr = useT();
  // 原 tab 门保留（hook 恒调用），宿主显式激活 OR 入。
  const opsActive = useTabActive("ops") || active;

  const [selected, setSelected] = React.useState<string[]>([]);
  const [lightMap, setLightMap] = React.useState<
    Record<string, UpgradeCheckResult | null>
  >({});
  const [latestInfo, setLatestInfo] = React.useState<UpgradeCheckAll | null>(null);
  const [checkErr, setCheckErr] = React.useState<string | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [, setCheckDone] = React.useState(false);
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

  // 团队分组（15.28：按 team 字段分组，空=未分组），
  // 组间按团队名、组内保持目录序。
  const teamGroups = React.useMemo(() => {
    const m = new Map<string, WorkerItem[]>();
    for (const w of qwenpawWorkers) {
      const g = w.team || tr("未分组");
      const arr = m.get(g) || [];
      arr.push(w);
      m.set(g, arr);
    }
    return Array.from(m.entries()).sort((a, b) =>
      a[0].localeCompare(b[0], "zh"),
    );
  }, [qwenpawWorkers, tr]);

  // 检查更新（15.27 定案「读到现在版本→本机匹配」）：单次
  // check-all = 服务端批量轻探（10min 缓存）+ latest（PyPI 10min 缓存）
  // → 逐 worker 本地匹配。二次点击=命中缓存零 exec（毫秒级）；tab 激活
  // 后台预取（下方 effect）让首次点击大概率也快。
  const doCheckAll = React.useCallback(async () => {
    if (qwenpawWorkers.length === 0) return;
    setChecking(true);
    setCheckDone(false);
    setCheckErr(null);
    try {
      const d = await fetchUpgradeCheckAll();
      setLatestInfo(d);
      if (d.stale) setCheckErr(d.error || null);
      const latest = d.latest || "";
      const results: Record<string, UpgradeCheckResult | null> = {};
      for (const w of qwenpawWorkers) {
        const row = d.workers.find((x) => x.name === w.name);
        const current = row?.current ?? null;
        if (current) qwenpawVersionCache.set(w.name, current);
        if (!current || !latest || row?.error) {
          results[w.name] = {
            current,
            latest,
            status: "unknown",
            error: row?.error || (!latest ? d.error : undefined),
          };
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
    } catch (e) {
      setCheckErr(e instanceof Error ? e.message : tr("检查更新失败"));
    } finally {
      setChecking(false);
      setCheckDone(true);
    }
  }, [qwenpawWorkers, tr]);

  // 15.27 后台预取：ops tab 激活且模块缓存未全覆盖 → 延迟 3s 预取一次
  // check-all（让出 tab 切换首帧；命中=服务端 10min 缓存零 exec）。
  // 「检查更新」点击=读缓存本地匹配，不再 N×拨号。
  React.useEffect(() => {
    if (!opsActive || qwenpawWorkers.length === 0) return;
    const covered = qwenpawWorkers.filter((w) =>
      qwenpawVersionCache.has(w.name),
    ).length;
    if (covered === qwenpawWorkers.length) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void fetchUpgradeCheckAll()
        .then((d) => {
          if (cancelled) return;
          for (const row of d.workers) {
            if (row.current) qwenpawVersionCache.set(row.name, row.current);
          }
        })
        .catch(() => {
          /* 预取失败静默——点击「检查更新」时真实调用兜底 */
        });
    }, 3000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [opsActive, qwenpawWorkers]);

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

  // 15.36 B：已选 worker vs 目标版本本地兼容性判断（同源 assessUpgradeCompat）——
  // 降级/跨大版本在选单下方红/黄提示 + 二次确认内复现。
  const batchWarn = React.useMemo(() => {
    const v = version.trim();
    if (!v || selected.length === 0) return null;
    const down: string[] = [];
    const cross: string[] = [];
    for (const w of selected) {
      const cur = lightMap[w]?.current ?? qwenpawVersionCache.get(w) ?? null;
      if (!cur) continue;
      const c = assessUpgradeCompat(cur, v);
      if (c.kind === "downgrade") down.push(w);
      else if (c.kind === "cross-major") cross.push(w);
    }
    return down.length || cross.length ? { down, cross } : null;
  }, [selected, version, lightMap]);

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
            "当前=各 Worker 容器内 QwenPaw 运行时版（服务端 10min 缓存 + tab 激活后台预取），最新=PyPI（缓存），逐 Worker 本地匹配——二次点击毫秒级。",
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

      {/* Worker 选择（15.29：回到下拉菜单——菜单项按团队分组，行内显示
       * 当前版本 → 可升级到最新版 + 是否可更新；「检查更新」探测结果
       * 合入菜单项，选一个=单独升级）。 */}
      {teamGroups.length > 0 ? (
        <antd.Select
          mode="multiple"
          style={{ width: "100%", maxWidth: 640 }}
          placeholder={tr("选择要升级的 Worker（按团队分组；选一个=单独升级）")}
          value={selected}
          onChange={(v: string[]) => setSelected(v)}
          showSearch
          optionFilterProp="label"
          maxTagCount="responsive"
          options={teamGroups.map(([teamName, list]) => ({
            label: teamName,
            options: list.map((w) => {
              const lc = lightMap[w.name];
              const current =
                lc?.current ?? qwenpawVersionCache.get(w.name) ?? null;
              let label = w.name;
              if (current) label += `  ${current}`;
              if (lc?.status === "available" && lc.latest)
                label += ` → ${lc.latest}`;
              return { value: w.name, label };
            }),
          }))}
          optionRender={(opt: { value?: string | number; label?: React.ReactNode }) => {
            const w = qwenpawWorkers.find((x) => x.name === opt.value);
            if (!w) return <span>{String(opt.label ?? "")}</span>;
            const lc = lightMap[w.name];
            const current =
              lc?.current ?? qwenpawVersionCache.get(w.name) ?? null;
            return (
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
                  {w.name}
                </span>
                {checking && !current ? (
                  <antd.Skeleton
                    active
                    title={false}
                    paragraph={false}
                    style={{ width: 110 }}
                  />
                ) : (
                  <>
                    <span
                      style={{
                        fontSize: 12,
                        fontFamily: "ui-monospace, monospace",
                        color: t.text,
                      }}
                    >
                      {current || tr("未知")}
                      {lc && lc.status === "available" && lc.latest
                        ? ` → ${lc.latest}`
                        : ""}
                    </span>
                    {lc ? (
                      lc.status === "available" ? (
                        <antd.Tag color="error" style={{ marginInlineEnd: 0 }}>
                          {tr("可升级")}
                        </antd.Tag>
                      ) : lc.status === "up-to-date" ? (
                        <antd.Tag color="success" style={{ marginInlineEnd: 0 }}>
                          {tr("最新")}
                        </antd.Tag>
                      ) : (
                        <antd.Tag color="warning" style={{ marginInlineEnd: 0 }}>
                          {tr("未知版本")}
                        </antd.Tag>
                      )
                    ) : null}
                    {lc?.error ? (
                      <WbTooltip title={lc.error}>
                        <antd.Tag color="warning" style={{ marginInlineEnd: 0 }}>
                          {tr("探测失败")}
                        </antd.Tag>
                      </WbTooltip>
                    ) : null}
                  </>
                )}
              </span>
            );
          }}
        />
      ) : (
        <div style={{ fontSize: 12, color: t.textSecondary }}>
          {tr("无 qwenpaw 运行时 Worker（就地升级仅支持 qwenpaw）")}
        </div>
      )}

      {/* 目标版本（表格选择，15.27）+ 批量升级 */}
      <VersionTablePicker value={version} onChange={setVersion} />

      {/* 降级/跨大版本警告（15.36 B：选中 worker 当前版 vs 目标版本） */}
      {batchWarn ? (
        <div style={{ display: "grid", gap: 6 }}>
          {batchWarn.down.length ? (
            <antd.Alert
              type="error"
              showIcon
              message={tr("目标版本低于当前版（降级可能不兼容）：{names}", {
                names: batchWarn.down.join("、"),
              })}
            />
          ) : null}
          {batchWarn.cross.length ? (
            <antd.Alert
              type="warning"
              showIcon
              message={tr("跨大版本升级（可能不向后兼容）：{names}", {
                names: batchWarn.cross.join("、"),
              })}
            />
          ) : null}
        </div>
      ) : null}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
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
                {st === "precheck_failed" ? (
                  <antd.Alert
                    type="error"
                    showIcon
                    style={{ flexBasis: "100%", margin: 0 }}
                    message={tr("兼容性检查失败：{detail}", {
                      detail: jobNoteOf(jobStatus[j.worker]?.state) || "—",
                    })}
                  />
                ) : null}
                {jobNoteOf(jobStatus[j.worker]?.state) &&
                st !== "precheck_failed" ? (
                  <span
                    style={{
                      flexBasis: "100%",
                      fontSize: 11,
                      color: t.textSecondary,
                      wordBreak: "break-all",
                    }}
                  >
                    {jobNoteOf(jobStatus[j.worker]?.state)}
                  </span>
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
          {batchWarn?.down.length ? (
            <antd.Alert
              type="error"
              showIcon
              message={tr("目标版本低于当前版（降级可能不兼容）：{names}", {
                names: batchWarn.down.join("、"),
              })}
            />
          ) : null}
          {batchWarn?.cross.length ? (
            <antd.Alert
              type="warning"
              showIcon
              message={tr("跨大版本升级（可能不向后兼容）：{names}", {
                names: batchWarn.cross.join("、"),
              })}
            />
          ) : null}
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
