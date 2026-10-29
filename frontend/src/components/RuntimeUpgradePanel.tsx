import type * as ReactNS from "react";

import {
  fetchUpgradeCheckAll,
  fetchUpgradeStatus,
  httpErrorStatus,
  requestJson,
  runUpgrade,
  UPGRADE_TERMINAL_STATES,
  type UpgradeCheckAll,
  type UpgradeRunHandle,
  type UpgradeStatusResult,
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

/** 运行时升级段（运维页内，15.25 per-worker 重接；15.28 单模式退役）。
 * 流程：Worker 列表按团队分组（行内当前版本+可否升级）→ 检查更新
 * （check-all 批量轻探）→ 勾选（选一个=单独升级）→ 选目标版本
 * → 二次确认触发（破坏性：容器重启）→ 顺序执行 + 逐 worker job 跟踪。 */
function RuntimeUpgradePanel({
  refreshTick = 0,
  active = false,
}: {
  refreshTick?: number;
  /** 宿主显式激活（管理页二级页/弹窗场景——原 useTabActive("ops")
   * 门在顶层运维 tab 移除后恒 false，改由宿主传入）。 */
  active?: boolean;
}) {
  const t = useThemeColors();
  const tr = useT();

  const [workers, setWorkers] = React.useState<WorkerItem[]>([]);
  const [workersError, setWorkersError] = React.useState("");

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
            onClick={() => void loadWorkers(false)}
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

        <BatchBody workers={workers} active={active} />
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
