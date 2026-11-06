/**
 * ModuleUpdatesPanel.tsx — 模块更新（#1526 三平面：团队 / manager / worker）。
 *
 * 设计决策：「检查更新」的落点在前端——前端对比「已装 vs 服务器（发布
 * 索引）版本」，允许降级，允许用户填自己的 Fork（owner/repo）；1.2.6 只要
 * 骨架与流程。
 *
 * 数据面（契约 = Controller main 9322b04f9，api/domains/modules.ts）：
 * - 发布索引 GET /api/v1/millforge/index?source&repo&ref&channel
 *   （source/repo/ref/channel 变化即重拉；30s 缓存）。
 * - 团队面 GET /teams/{name}/modules（consistent 徽标 + 成员版本明细）；
 * - manager 面 GET /managers/{name}/plugins；worker 面 GET /workers/{name}/plugins
 *   （白名单投影；404 = 控制器无路由 → 诚实降级「控制器不支持」块）。
 * - 安装 = 同一端点 POST .../install，方向由 version 决定（更新/降级/首装）。
 *
 * 默认不发任何请求：面板默认收起，「载入」后才拉索引；三平面选中目标才拉
 * 已装态（设置页首屏零阻塞）。
 *
 * 纪律：React/antd 取宿主（window.QwenPaw.host）；i18n 全量注册 en 键；
 * 三平面独立取数/独立状态，不混卡。
 */
import type * as ReactNS from "react";

import {
  DEFAULT_MODULE_REPO,
  compareModuleVersions,
  entryPluginId,
  fetchAdminData,
  fetchL2AdminData,
  getManagerPlugins,
  getIndex,
  getTeamModules,
  getWorkerPlugins,
  httpErrorDetail,
  httpErrorStatus,
  installManagerPlugin,
  installTeamModule,
  installWorkerPlugin,
  isInstallableKind,
  moduleEntryVersions,
} from "../api";
import type {
  IndexModuleEntry,
  IndexVersionEntry,
  ModuleIndexQuery,
  ModuleIndexResponse,
  ModulePluginEntry,
  PluginInstallResult,
  PluginListResult,
  TeamInstallResult,
  TeamModuleMember,
  TeamModulesResult,
} from "../api";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";
import { useForceReload } from "../lib/useForceReload";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

type Tr = (text: string, vars?: Record<string, string | number>) => string;

// ── 安装状态机（全面板单安装：confirming → installing → done/failed）──

type PlaneKind = "team" | "manager" | "worker";

interface InstallTarget {
  kind: PlaneKind;
  target: string;
  module: string;
  version: string;
  entry: IndexVersionEntry;
  direction: "update" | "downgrade" | "install";
  currentVersion: string | null;
}

type InstallPhase =
  | { s: "confirming"; t: InstallTarget }
  | { s: "installing"; t: InstallTarget }
  | { s: "done"; t: InstallTarget; team?: TeamInstallResult; plugin?: PluginInstallResult; revealed: string[] }
  | { s: "failed"; t: InstallTarget; message: string };

/** 安装错误映射（任务书契约）：409 sha256 不匹配 / 502 worker 离线 /
 * 404 版本不存在 / 400 runner 或非 zip / 503 embedded 不支持；其余默认。 */
function mapInstallError(e: unknown, tr: Tr): string {
  const status = httpErrorStatus(e);
  const detail = httpErrorDetail(e);
  const base =
    status === 409
      ? tr("版本校验失败（sha256 不匹配）——索引与制品不一致，请刷新索引后重试")
      : status === 502
        ? tr("目标离线或不可达，稍后重试")
        : status === 404
          ? tr("版本在索引中不存在，请刷新索引")
          : status === 400
            ? tr("该模块不可安装（runner 类型或非 zip 制品）")
            : status === 503
              ? tr("当前运行时形态（embedded）不支持安装该模块")
              : tr("安装失败");
  return detail ? `${base}（${detail}）` : base;
}

/** 团队行当前版本：versions 直方图单键 → 该版本；多键（不一致）→ null。 */
function rowCurrentVersion(row: { versions?: Record<string, number> }): string | null {
  const keys = Object.keys(row.versions ?? {});
  return keys.length === 1 ? keys[0] : null;
}

/** 目标已装插件匹配（pluginId 缺省=模块名——契约缺省语义）。 */
function matchInstalled(
  plugins: ModulePluginEntry[],
  entry: IndexModuleEntry,
): ModulePluginEntry | null {
  const id = entryPluginId(entry);
  return (
    plugins.find(
      (p) => p.id === id || p.id === entry.module || p.name === entry.module,
    ) ?? null
  );
}

// ── 通用小组件 ─────────────────────────────────────────────────────

function TargetPick({
  label,
  options,
  value,
  onChange,
  manualPlaceholder,
}: {
  label: string;
  options: string[];
  value: string;
  onChange: (v: string) => void;
  manualPlaceholder: string;
}) {
  if (options.length > 0)
    return (
      <antd.Select
        size="small"
        style={{ minWidth: 180, maxWidth: 300 }}
        value={value || undefined}
        placeholder={label}
        showSearch
        allowClear
        onChange={(v: string | undefined) => onChange(v || "")}
        options={options.map((o) => ({ value: o, label: o }))}
      />
    );
  return (
    <antd.Input
      size="small"
      style={{ minWidth: 180, maxWidth: 300 }}
      placeholder={manualPlaceholder}
      value={value}
      onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
        onChange(e.target.value)
      }
    />
  );
}

/** 平面取数状态（loading/err/data）+ 手动刷新（useForceReload 统一穿透缓存）。 */
function usePlane<T>(
  tr: Tr,
  fetcher: (name: string) => Promise<T>,
  name: string,
) {
  const [data, setData] = React.useState<T | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState("");
  const load = React.useCallback(
    async (n?: string) => {
      const target = (n ?? name).trim();
      if (!target) return;
      setLoading(true);
      setErr("");
      try {
        setData(await fetcher(target));
      } catch (e) {
        setData(null);
        setErr(httpErrorDetail(e) || tr("获取失败"));
      } finally {
        setLoading(false);
      }
    },
    [name, fetcher, tr],
  );
  React.useEffect(() => {
    if (name) void load();
    else setData(null);
  }, [name, load]);
  const { reload, loading: refreshing } = useForceReload(
    () => load(),
    ["module-updates"],
  );
  return { data, loading: loading || refreshing, err, reload };
}

/** 模块卡（三平面共用）：索引条目 × 已装态交叉 + 版本动作 + 安装内联状态。 */
function ModuleCard(props: {
  tr: Tr;
  entry: IndexModuleEntry;
  versions: IndexVersionEntry[];
  currentVersion: string | null;
  consistent?: boolean | null;
  members?: TeamModuleMember[];
  installed?: ModulePluginEntry | null;
  phase: InstallPhase | null;
  /** 卡片只给模块级意图（kind/target 由所属平面调用方补齐）。 */
  onStart: (t: Omit<InstallTarget, "kind" | "target">) => void;
}) {
  const { tr } = props;
  const { entry, versions } = props;
  const installable = isInstallableKind(entry);
  const mine =
    props.phase && props.phase.t.module === entry.module ? props.phase : null;
  const busy = mine != null && (mine.s === "installing" || mine.s === "confirming");

  const versionButtons = versions.map((v) => {
    const cmp = props.currentVersion
      ? compareModuleVersions(v.version, props.currentVersion)
      : null;
    const isCurrent = cmp === 0;
    const disabledReason = !installable
      ? tr("runner（不可安装）")
      : !v.artifact || !v.sha256
        ? tr("制品/校验字段缺失（索引条目不完整），暂不可安装")
        : null;
    return (
      <antd.Button
        key={v.version}
        size="small"
        type={isCurrent ? "default" : cmp == null || cmp > 0 ? "primary" : "default"}
        disabled={isCurrent || busy || !v.artifact || !v.sha256}
        title={disabledReason ?? undefined}
        onClick={() =>
          props.onStart({
            module: entry.module,
            version: v.version,
            entry: v,
            direction: cmp == null ? "install" : cmp > 0 ? "update" : "downgrade",
            currentVersion: props.currentVersion,
          })
        }
      >
        {isCurrent
          ? tr("当前")
          : cmp == null
            ? tr("安装 {v}", { v: v.version })
            : cmp > 0
              ? tr("更新到 {v}", { v: v.version })
              : tr("降级到 {v}", { v: v.version })}
      </antd.Button>
    );
  });

  return (
    <div
      style={{
        border: "1px solid rgba(128,128,128,0.25)",
        borderRadius: 6,
        padding: 8,
        display: "grid",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600 }}>{entry.name || entry.module}</span>
        <span style={{ fontFamily: "monospace", fontSize: 11, color: "#888" }}>
          {entry.module}
        </span>
        {entry.kind ? (
          <antd.Tag color={installable ? "blue" : "default"}>
            {installable ? entry.kind : tr("runner（不可安装）")}
          </antd.Tag>
        ) : (
          installable && <antd.Tag color="green">{tr("可装")}</antd.Tag>
        )}
        {props.consistent !== null && props.consistent !== undefined ? (
          <antd.Tag color={props.consistent ? "green" : "orange"}>
            {props.consistent ? tr("一致") : tr("不一致")}
          </antd.Tag>
        ) : null}
        <span style={{ flex: 1 }} />
        {props.currentVersion ? (
          <antd.Tag color="geekblue">
            {tr("已装 {v}", { v: props.currentVersion })}
          </antd.Tag>
        ) : (
          <antd.Tag>{tr("未装")}</antd.Tag>
        )}
      </div>

      {versions.length === 0 && (
        <div style={{ fontSize: 12, color: "#999" }}>{tr("索引中无版本条目")}</div>
      )}

      {(props.members?.length ?? 0) > 0 && (
        <div style={{ fontSize: 12, display: "grid", gap: 2 }}>
          <div style={{ color: "#888" }}>{tr("成员版本明细")}</div>
          {(props.members ?? []).map((m) => (
            <div key={m.worker} style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: m.loaded ? "#52c41a" : "#d9d9d9",
                  flex: "none",
                }}
              />
              <span style={{ fontFamily: "monospace", fontSize: 11 }}>{m.worker}</span>
              <span style={{ fontFamily: "monospace", fontSize: 11, color: "#888" }}>
                {m.version || "—"}
              </span>
            </div>
          ))}
        </div>
      )}

      {installable && versions.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{versionButtons}</div>
      )}

      {/* 安装内联状态（与面板级 phase 联动；逐成员滚动进度见 done 分支） */}
      {mine?.s === "installing" && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
          <antd.Spin size="small" />
          <span>
            {tr("正在安装 {module} {v}（逐成员分发中）…", {
              module: mine.t.module,
              v: mine.t.version,
            })}
          </span>
        </div>
      )}
      {mine?.s === "done" && (
        <div style={{ fontSize: 12, display: "grid", gap: 2 }}>
          {mine.team ? (
            <>
              {mine.revealed.length >= (mine.team.updated ?? []).length && (
                <div style={{ color: "#52c41a" }}>
                  {tr("完成：{n} 个成员已更新到 {v}", {
                    n: mine.team.updated?.length ?? 0,
                    v: mine.t.version,
                  })}
                </div>
              )}
              {mine.revealed.map((w) => (
                <div key={w} style={{ fontFamily: "monospace", fontSize: 11 }}>
                  ✓ {w}
                </div>
              ))}
              {mine.team.failed && (
                <div style={{ color: "#fa8c16" }}>
                  {tr("部分成员失败：{worker} — {error}", {
                    worker: mine.team.failed.worker,
                    error: mine.team.failed.error,
                  })}
                </div>
              )}
              {mine.revealed.length >= (mine.team.updated ?? []).length &&
                mine.team.consistent !== undefined && (
                  <div style={{ color: "#888" }}>
                    {mine.team.consistent ? tr("一致") : tr("不一致")}
                  </div>
                )}
            </>
          ) : (
            <>
              <div style={{ color: "#52c41a" }}>
                {tr("已安装 {module} {v}", { module: mine.t.module, v: mine.t.version })}
                {mine.plugin?.previous_version
                  ? ` ${tr("（原版本 {prev}）", { prev: mine.plugin.previous_version })}`
                  : ""}
              </div>
              <div style={{ color: "#888" }}>
                {mine.plugin?.loaded ? tr("已装载") : tr("未装载")}
              </div>
            </>
          )}
        </div>
      )}
      {mine?.s === "failed" && (
        <div style={{ fontSize: 12, color: "#ff4d4f" }}>⚠ {mine.message}</div>
      )}
    </div>
  );
}

// ── 主面板 ─────────────────────────────────────────────────────────

export function ModuleUpdatesPanel({
  cardBox,
}: {
  cardBox?: ReactNS.CSSProperties;
}) {
  const tr = useT();
  const t = useThemeColors();
  const box: ReactNS.CSSProperties = cardBox ?? {
    border: `1px solid ${t.border}`,
    borderRadius: 8,
    padding: 12,
    background: t.cardBg,
  };

  const [open, setOpen] = React.useState(false);

  // 管理列表（三平面目标下拉；不可用降级手动输入）
  const [admin, setAdmin] = React.useState<{
    teams?: { name?: string }[];
    managers?: { name?: string }[];
    workers?: { name?: string }[];
  } | null>(null);
  const [adminErr, setAdminErr] = React.useState("");
  const loadAdmin = React.useCallback(async () => {
    try {
      setAdmin(await fetchAdminData({ lru: true }));
      setAdminErr("");
    } catch {
      try {
        setAdmin(await fetchL2AdminData());
        setAdminErr("");
      } catch (e2) {
        setAdminErr(httpErrorDetail(e2) || tr("获取管理列表失败"));
      }
    }
  }, [tr]);
  React.useEffect(() => {
    if (open) void loadAdmin();
  }, [open, loadAdmin]);

  // 发布索引（源/仓库/ref/通道 变化即重拉；30s 缓存）
  const [q, setQ] = React.useState<ModuleIndexQuery>({
    source: "github",
    repo: DEFAULT_MODULE_REPO,
    ref: "main",
    channel: "stable",
  });
  const [draftRepo, setDraftRepo] = React.useState(DEFAULT_MODULE_REPO);
  const [draftRef, setDraftRef] = React.useState("main");
  const [index, setIndex] = React.useState<ModuleIndexResponse | null>(null);
  const [indexErr, setIndexErr] = React.useState("");
  const [indexLoading, setIndexLoading] = React.useState(false);

  const loadIndex = React.useCallback(
    async (query?: ModuleIndexQuery) => {
      const next = query ?? q;
      if (!next.repo.trim()) {
        setIndexErr(tr("请填写仓库（owner/repo）"));
        return;
      }
      setIndexLoading(true);
      setIndexErr("");
      try {
        setIndex(await getIndex(next));
      } catch (e) {
        setIndex(null);
        setIndexErr(httpErrorDetail(e) || tr("索引获取失败"));
      } finally {
        setIndexLoading(false);
      }
    },
    [q, tr],
  );

  // 展开才首拉索引（默认收起 = 零请求；再展开不重拉——状态保留 + 30s 缓存）
  const [indexLoadedOnce, setIndexLoadedOnce] = React.useState(false);
  React.useEffect(() => {
    if (open && !indexLoadedOnce) {
      setIndexLoadedOnce(true);
      void loadIndex();
    }
  }, [open, indexLoadedOnce, loadIndex]);
  const { reload: reloadIndex, loading: indexRefreshing } = useForceReload(
    () => loadIndex(),
    ["module-updates"],
  );

  const changeQuery = (patch: Partial<ModuleIndexQuery>) => {
    const next = { ...q, ...patch };
    setQ(next);
    if ("repo" in patch) setDraftRepo(next.repo);
    if ("ref" in patch) setDraftRef(next.ref);
    void loadIndex(next);
  };
  const commitRepo = () => {
    const v = draftRepo.trim();
    if (v && v !== q.repo) changeQuery({ repo: v });
    else setDraftRepo(q.repo);
  };
  const commitRef = () => {
    const v = draftRef.trim() || "main";
    if (v !== q.ref) changeQuery({ ref: v });
    else setDraftRef(q.ref);
  };

  // 三平面（各自独立取数/独立状态——不混卡）
  const [teamName, setTeamName] = React.useState("");
  const teamPlane = usePlane<TeamModulesResult>(tr, getTeamModules, teamName);
  const [mgrName, setMgrName] = React.useState("");
  const mgrPlane = usePlane<PluginListResult>(tr, getManagerPlugins, mgrName);
  const [wrkName, setWrkName] = React.useState("");
  const wrkPlane = usePlane<PluginListResult>(tr, getWorkerPlugins, wrkName);

  const teamOptions = (admin?.teams ?? [])
    .map((x) => x.name)
    .filter((n): n is string => !!n);
  const mgrOptions = (admin?.managers ?? [])
    .map((x) => x.name)
    .filter((n): n is string => !!n);
  const wrkOptions = (admin?.workers ?? [])
    .map((x) => x.name)
    .filter((n): n is string => !!n);

  // 安装状态机（全面板单安装；写面不缓存，成功后 invalidateTags 已含在 api 层）
  const [phase, setPhase] = React.useState<InstallPhase | null>(null);
  const startInstall = (t: InstallTarget) => setPhase({ s: "confirming", t });

  const doInstall = async () => {
    const p = phase;
    if (!p || p.s !== "confirming") return;
    const tg = p.t;
    setPhase({ s: "installing", t: tg });
    const base = {
      source: q.source,
      repo: q.repo.trim(),
      ref: q.ref.trim() || "main",
      version: tg.version,
      artifact: tg.entry.artifact ?? "",
      sha256: tg.entry.sha256 ?? "",
    };
    try {
      if (tg.kind === "team") {
        const r = await installTeamModule(tg.target, tg.module, base);
        setPhase({ s: "done", t: tg, team: r, revealed: [] });
      } else if (tg.kind === "manager") {
        const r = await installManagerPlugin(tg.target, {
          ...base,
          module: tg.module,
        });
        setPhase({ s: "done", t: tg, plugin: r, revealed: [] });
      } else {
        const r = await installWorkerPlugin(tg.target, { ...base, module: tg.module });
        setPhase({ s: "done", t: tg, plugin: r, revealed: [] });
      }
    } catch (e) {
      setPhase({ s: "failed", t: tg, message: mapInstallError(e, tr) });
    }
  };

  // done 态逐成员滚动进度：revealed[] 每 180ms 追加一条（updated[] 逐个追加）
  React.useEffect(() => {
    if (!phase || phase.s !== "done") return;
    const updated = phase.team?.updated ?? [];
    if (phase.revealed.length >= updated.length) return;
    const next = updated[phase.revealed.length];
    const timer = setTimeout(() => {
      setPhase((p) =>
        p && p.s === "done" && next !== undefined
          ? { ...p, revealed: [...p.revealed, next] }
          : p,
      );
    }, 180);
    return () => clearTimeout(timer);
  }, [phase]);

  const idxModules = index?.modules ?? [];

  const sectionBox: ReactNS.CSSProperties = {
    border: "1px solid rgba(128,128,128,0.25)",
    borderRadius: 6,
    padding: 10,
    display: "grid",
    gap: 8,
  };
  const hint: ReactNS.CSSProperties = { fontSize: 12, color: "#999" };
  const warnRow: ReactNS.CSSProperties = {
    fontSize: 12,
    color: "#fa8c16",
    fontFamily: "monospace",
  };

  const unsupportedAlert = (text: string) => (
    <antd.Alert
      type="info"
      showIcon
      message={text}
      style={{ fontSize: 12 }}
    />
  );

  const indexStatus = () => {
    if (indexLoading) return <div style={hint}>{tr("索引加载中…")}</div>;
    if (indexErr)
      return (
        <antd.Alert
          type="warning"
          showIcon
          message={tr("索引获取失败")}
          description={indexErr}
          action={
            <antd.Button
              size="small"
              onClick={() => void reloadIndex()}
              loading={indexRefreshing}
            >
              {tr("重试")}
            </antd.Button>
          }
          style={{ fontSize: 12 }}
        />
      );
    if (!index) return null;
    return (
      <div style={{ ...hint, fontFamily: "monospace", fontSize: 11 }}>
        {tr("索引：{source} {repo} @ {ref} · {channel} · {n} 个模块", {
          source: index.source ?? q.source,
          repo: index.repo ?? q.repo,
          ref: q.ref,
          channel: index.channel,
          n: index.modules?.length ?? 0,
        })}
        {index.fetched_at ? (
          <span style={{ marginLeft: 8 }}>
            {tr("拉取于 {time}", { time: index.fetched_at })}
          </span>
        ) : null}
      </div>
    );
  };

  // 团队面 body
  const teamBody = () => {
    if (!teamName.trim()) return <div style={hint}>{tr("请选择或输入名称后查看")}</div>;
    if (teamPlane.loading) return <antd.Spin size="small" />;
    if (teamPlane.err)
      return (
        <antd.Alert
          type="warning"
          showIcon
          message={teamPlane.err}
          action={
            <antd.Button size="small" onClick={() => void teamPlane.reload()}>
              {tr("重试")}
            </antd.Button>
          }
          style={{ fontSize: 12 }}
        />
      );
    const r = teamPlane.data;
    if (!r) return null;
    if (!r.supported)
      return unsupportedAlert(tr("控制器不支持该读端点（需 controller 版本支持）"));
    const rows = r.modules ?? [];
    if (rows.length === 0)
      return <div style={hint}>{tr("该团队尚未安装任何模块")}</div>;
    return (
      <div style={{ display: "grid", gap: 8 }}>
        {rows.map((row) => {
          const entry = idxModules.find(
            (m) => m.module === row.module || entryPluginId(m) === row.module,
          );
          const current = rowCurrentVersion(row);
          if (!entry)
            return (
              <div
                key={row.module}
                style={{
                  border: "1px dashed rgba(128,128,128,0.35)",
                  borderRadius: 6,
                  padding: 8,
                  display: "grid",
                  gap: 6,
                }}
              >
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 600 }}>{row.name || row.module}</span>
                  <span style={{ fontFamily: "monospace", fontSize: 11, color: "#888" }}>
                    {row.module}
                  </span>
                  <antd.Tag color={row.consistent ? "green" : "orange"}>
                    {row.consistent ? tr("一致") : tr("不一致")}
                  </antd.Tag>
                  <span style={{ flex: 1 }} />
                  <antd.Tag color="geekblue">
                    {current ? tr("已装 {v}", { v: current }) : tr("未装")}
                  </antd.Tag>
                </div>
                <div style={hint}>{tr("索引外（本源无此模块，不可更新）")}</div>
                {(row.members?.length ?? 0) > 0 && (
                  <div style={{ fontSize: 12, display: "grid", gap: 2 }}>
                    <div style={{ color: "#888" }}>{tr("成员版本明细")}</div>
                    {(row.members ?? []).map((m) => (
                      <div key={m.worker} style={{ display: "flex", gap: 6 }}>
                        <span style={{ fontFamily: "monospace", fontSize: 11 }}>{m.worker}</span>
                        <span style={{ fontFamily: "monospace", fontSize: 11, color: "#888" }}>
                          {m.version || "—"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          return (
            <ModuleCard
              key={row.module}
              tr={tr}
              entry={entry}
              versions={moduleEntryVersions(entry)}
              currentVersion={current}
              consistent={row.consistent}
              members={row.members}
              phase={phase}
              onStart={(tg) => startInstall({ ...tg, kind: "team", target: teamName })}
            />
          );
        })}
        {(r.errors ?? []).length > 0 && (
          <div style={{ display: "grid", gap: 2 }}>
            <div style={{ fontSize: 12, color: "#fa8c16" }}>
              {tr("该团队上报了成员错误：")}
            </div>
            {(r.errors ?? []).map((e) => (
              <div key={e.worker} style={warnRow}>
                {tr("{worker}：{error}", { worker: e.worker, error: e.error })}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  // manager/worker 面 body（同构；仅「不支持」文案与平面类型不同）
  const pluginBody = (
    plane: { loading: boolean; err: string; reload: () => void; data: PluginListResult | null },
    name: string,
    unsupportedText: string,
    kind: PlaneKind,
  ) => {
    if (!name.trim()) return <div style={hint}>{tr("请选择或输入名称后查看")}</div>;
    if (plane.loading) return <antd.Spin size="small" />;
    if (plane.err)
      return (
        <antd.Alert
          type="warning"
          showIcon
          message={plane.err}
          action={
            <antd.Button size="small" onClick={() => void plane.reload()}>
              {tr("重试")}
            </antd.Button>
          }
          style={{ fontSize: 12 }}
        />
      );
    const r = plane.data;
    if (!r) return null;
    if (!r.supported) return unsupportedAlert(unsupportedText);
    const plugins = r.plugins ?? [];
    if (idxModules.length === 0 && plugins.length === 0)
      return <div style={hint}>{tr("无索引模块或已装插件")}</div>;
    return (
      <div style={{ display: "grid", gap: 8 }}>
        {idxModules.map((m) => {
          const installed = matchInstalled(plugins, m);
          return (
            <ModuleCard
              key={m.module}
              tr={tr}
              entry={m}
              versions={moduleEntryVersions(m)}
              currentVersion={installed?.version ?? null}
              installed={installed}
              phase={phase}
              onStart={(tg) => startInstall({ ...tg, kind, target: name })}
            />
          );
        })}
        {plugins
          .filter(
            (p) =>
              !idxModules.some(
                (m) => p.id === entryPluginId(m) || p.id === m.module || p.name === m.module,
              ),
          )
          .map((p, i) => (
            <div key={p.id ?? `x${i}`} style={hint}>
              {tr("索引外已装：{name} {v}", {
                name: p.name || p.id || "—",
                v: p.version || "—",
              })}
            </div>
          ))}
      </div>
    );
  };

  return (
    <div style={{ ...box, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: 700 }}>{tr("模块更新")}</div>
          <div style={{ fontSize: 12, color: t.textSecondary }}>
            {tr("发布索引 vs 已装版本（团队 / manager / worker 三平面）——检查更新、允许降级，可指向自有 Fork。")}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <antd.Button
          size="small"
          type="primary"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? tr("关闭") : tr("载入")}
        </antd.Button>
      </div>

      {!open ? (
        <div style={hint}>{tr("未载入——未发任何请求。点「载入」获取发布索引与三平面已装状态。")}</div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {/* 源/仓库/ref/通道 栏（变化即重拉索引） */}
          <div
            style={{
              display: "grid",
              gap: 8,
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              alignItems: "end",
            }}
          >
            <div>
              <div style={{ fontSize: 12, color: t.textSecondary, marginBottom: 4 }}>{tr("源")}</div>
              <antd.Select
                size="small"
                style={{ width: "100%" }}
                value={q.source}
                onChange={(v: unknown) =>
                  v === "github" || v === "gitcode"
                    ? changeQuery({ source: v })
                    : undefined
                }
                options={[
                  { value: "github", label: "GitHub" },
                  { value: "gitcode", label: "GitCode" },
                ]}
              />
            </div>
            <div style={{ gridColumn: "span 2" }}>
              <div style={{ fontSize: 12, color: t.textSecondary, marginBottom: 4 }}>
                {tr("仓库（owner/repo，支持自有 Fork）")}
              </div>
              <antd.Input
                size="small"
                value={draftRepo}
                placeholder={DEFAULT_MODULE_REPO}
                onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                  setDraftRepo(e.target.value)
                }
                onBlur={commitRepo}
                onPressEnter={commitRepo}
              />
            </div>
            <div>
              <div style={{ fontSize: 12, color: t.textSecondary, marginBottom: 4 }}>
                {tr("分支/标签（ref）")}
              </div>
              <antd.Input
                size="small"
                value={draftRef}
                placeholder="main"
                onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                  setDraftRef(e.target.value)
                }
                onBlur={commitRef}
                onPressEnter={commitRef}
              />
            </div>
            <div>
              <div style={{ fontSize: 12, color: t.textSecondary, marginBottom: 4 }}>{tr("通道")}</div>
              <antd.Select
                size="small"
                style={{ width: "100%" }}
                value={q.channel}
                onChange={(v: unknown) =>
                  v === "alpha" || v === "beta" || v === "stable"
                    ? changeQuery({ channel: v })
                    : undefined
                }
                options={[
                  { value: "alpha", label: "alpha" },
                  { value: "beta", label: "beta" },
                  { value: "stable", label: "stable" },
                ]}
              />
            </div>
            <div>
              <antd.Button
                size="small"
                loading={indexRefreshing || indexLoading}
                onClick={() => void reloadIndex()}
              >
                {tr("刷新")}
              </antd.Button>
            </div>
          </div>

          {indexStatus()}
          {!indexErr && index && (index.modules?.length ?? 0) === 0 && (
            <div style={hint}>
              {tr("该通道暂无发布（{repo} @ {ref}）", { repo: q.repo, ref: q.ref })}
            </div>
          )}

          {adminErr && (
            <div style={hint}>
              {tr("管理列表不可用：{err}", { err: adminErr })}
            </div>
          )}

          {/* 团队面 */}
          <div style={sectionBox}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700 }}>{tr("团队面")}</span>
              <span style={{ flex: 1 }} />
              {/* 列表不可用（adminErr）或为空时 TargetPick 自动落回手动输入框 */}
              <TargetPick
                label={tr("选择团队")}
                options={teamOptions}
                value={teamName}
                onChange={setTeamName}
                manualPlaceholder={tr("手动输入 {name}", { name: tr("团队") })}
              />
              <antd.Button size="small" onClick={() => void teamPlane.reload()}>
                {tr("刷新")}
              </antd.Button>
            </div>
            {teamOptions.length === 0 && !adminErr && (
              <div style={hint}>{tr("暂无团队")}</div>
            )}
            {teamBody()}
          </div>

          {/* manager 面 */}
          <div style={sectionBox}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700 }}>{tr("manager 面")}</span>
              <span style={{ flex: 1 }} />
              <TargetPick
                label={tr("选择 manager")}
                options={mgrOptions}
                value={mgrName}
                onChange={setMgrName}
                manualPlaceholder={tr("手动输入 {name}", { name: "manager" })}
              />
              <antd.Button size="small" onClick={() => void mgrPlane.reload()}>
                {tr("刷新")}
              </antd.Button>
            </div>
            {mgrOptions.length === 0 && !adminErr && (
              <div style={hint}>{tr("暂无 manager")}</div>
            )}
            {pluginBody(
              mgrPlane,
              mgrName,
              tr("控制器不支持该读端点（需 controller 版本支持）"),
              "manager",
            )}
          </div>

          {/* worker 面（单独一块，不并入 manager） */}
          <div style={sectionBox}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700 }}>{tr("worker 面")}</span>
              <span style={{ flex: 1 }} />
              <TargetPick
                label={tr("选择 worker")}
                options={wrkOptions}
                value={wrkName}
                onChange={setWrkName}
                manualPlaceholder={tr("手动输入 {name}", { name: "worker" })}
              />
              <antd.Button size="small" onClick={() => void wrkPlane.reload()}>
                {tr("刷新")}
              </antd.Button>
            </div>
            {wrkOptions.length === 0 && !adminErr && (
              <div style={hint}>{tr("暂无 worker")}</div>
            )}
            {pluginBody(
              wrkPlane,
              wrkName,
              tr("worker 只读端点未合（#1525）——控制器不支持"),
              "worker",
            )}
          </div>
        </div>
      )}

      {/* 安装确认弹窗（confirming 态；方向由 version 比较决定） */}
      {phase?.s === "confirming" && (
        <antd.Modal
          title={
            phase.t.direction === "install"
              ? tr("安装 {module} {v}", { module: phase.t.module, v: phase.t.version })
              : phase.t.direction === "update"
                ? tr("更新 {module} 到 {v}", { module: phase.t.module, v: phase.t.version })
                : tr("降级 {module} 到 {v}", { module: phase.t.module, v: phase.t.version })
          }
          open
          onOk={() => void doInstall()}
          onCancel={() => setPhase(null)}
          okText={tr("确认")}
          cancelText={tr("取消")}
        >
          <div style={{ display: "grid", gap: 8, fontSize: 12 }}>
            <div>
              {phase.t.currentVersion
                ? tr("版本：{from} → {to}", { from: phase.t.currentVersion, to: phase.t.version })
                : tr("版本：{to}", { to: phase.t.version })}
              {"　"}
              <span style={{ fontFamily: "monospace" }}>
                {tr("制品：{a}", { a: phase.t.entry.artifact ?? "—" })}
              </span>
            </div>
            {phase.t.direction === "downgrade" && (
              <div style={{ color: "#fa8c16" }}>
                {tr("降级提示：其他成员可能仍在高版本；降级后该团队版本将不一致。")}
              </div>
            )}
            {phase.t.entry.requires &&
              Object.keys(phase.t.entry.requires).length > 0 && (
                <div>
                  <div style={{ color: "#888" }}>
                    {tr("requires（目标 {v}）：", { v: phase.t.version })}
                  </div>
                  {Object.entries(phase.t.entry.requires).map(([k, v]) => (
                    <div key={k} style={{ fontFamily: "monospace" }}>
                      {k}: {v}
                    </div>
                  ))}
                </div>
              )}
          </div>
        </antd.Modal>
      )}
    </div>
  );
}
