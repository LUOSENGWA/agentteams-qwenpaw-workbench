/**
 * SyncSettingsModal.tsx — 文件管理 v3（F-V3-1）同步设置弹窗（工具条「同步设置」
 * 按钮打开；替代原页内 SyncCard 长条——关闭后不占页面空间）。
 *
 * 内容（六块）：
 * - 同步状态：条目 / 墓碑 / 代数 / 最后写入者 / 更新时间（st 由容器 getSyncStatus
 *   取来共享；null = 「加载中…」）。state 未就绪（empty / denied /
 *   unsupported）= 弹窗内显原因（Alert）——「立即同步」按钮仍可点（服务端终裁）。
 * - 上次运行：GET /agentteams-proxy/sync/state 只读快照（lastRunAt 本地化 /
 *   运行中|空闲 / conflicts）。字段可能缺省——一律按可选处理；404（老控制器
 *   无此端点）/405/网络失败/非 JSON 体 → 整块隐藏（不报错、不空壳）。
 * - 立即同步：POST /agentteams-proxy/sync/run（无 body；引擎单写者锁
 *   .sync/lock——后台轮跑中 → {"locked": true} 诚实提示）。
 *   404（老控制器无此端点）/ 引擎 enabled:false（controller_without_manifest）
 *   = 「控制器未提供清单接口」+ 按钮禁用；locked = 「同步进行中（已有同步任务
 *   在跑）」；skipped=same-generation = 「已是最新（代数未变化）」；成功 =
 *   「同步完成：下载 {a} · 上传 {b} · 冲突 {c}」→ onSynced（容器刷新状态 +
 *   列表）+ 重取「上次运行」。
 * - 导出清单原文：getSyncManifest + downloadTextFile（与旧 SyncCard 同一逻辑）。
 * - 同步范围：静态说明（同步 workspace/<human>/files/**；不同步 memory/ /
 *   digest/ / .trash/ / .sync/；远端零 DELETE——本地删除不影响远端文档）。
 * - 路径说明：镜像目录 = MIRROR_DIR（任务书口径 <workspace>/.qwenpaw/agentteams）。
 *
 * 外壳走 DialogShell（F-V3-3：与回收站弹窗同一套 Modal 配置）；共享格式化
 * 函数（fmtTs）从 ./format 导入。
 */
import type * as ReactNS from "react";

import {
  downloadTextFile,
  fetchFile,
  getSyncManifest,
  resolvePluginUrl,
  type SyncStatus,
} from "../../api";
import type { ThemeColors } from "../../theme";
import { BTN_TOUCH, fmtTs } from "./format";
import DialogShell from "./DialogShell";
import SyncScopeDialog, { type SyncScope } from "./SyncScopeDialog";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

type Tr = (s: string, v?: Record<string, string | number>) => string;

/** 同步触发端点（契约：agentteams_connector/routers/sync_api.py POST /sync/run →
 * 引擎 run_once 直返；无请求体——身份 = 登录态 / 引擎按 token 归属）。 */
export const SYNC_RUN_PATH = "/agentteams-proxy/sync/run";
/** 镜像目录说明（任务书口径；引擎实际挂载根见 file_sync_engine WORKING_DIR——
 * 报告已标记口径分歧待对齐）。 */
export const MIRROR_DIR = "<workspace>/.qwenpaw/agentteams";
/** 只读状态端点（契约：agentteams_connector/routers/sync_api.py
 * GET /sync/state → 引擎 state() 展开 + root/human。字段可能缺省——老控制器
 * 无此端点（404/405）、首跑前 lastRunAt=null——一律按可选处理；请求失败 =
 * 「上次运行」整块隐藏，不报错）。 */
export const SYNC_STATE_PATH = "/agentteams-proxy/sync/state";
/** S1 同步范围（GET 读整份 + 当前 human 生效值；PUT 写 include/exclude）。 */
export const SYNC_CONFIG_PATH = "/agentteams-proxy/sync/config";
/** S2 取消同步（只删本地镜像，远端零 DELETE）。 */
export const SYNC_UNSYNC_PATH = "/agentteams-proxy/sync/unsync";
/** S5 冲突记录（conflicts.log 一行；字段按引擎 _log_conflict 写入形态）。 */
interface ConflictRec {
  ts?: string;
  path?: string;
  conflictCopy?: string;
}

/** S6 进度快照（idle / scanning / syncing / done…）。 */
export const SYNC_PROGRESS_PATH = "/agentteams-proxy/sync/progress";

/** antd.Button 最小触控盒（唯一实现：files/format BTN_TOUCH）。 */
const btnTouch: ReactNS.CSSProperties = BTN_TOUCH;

interface RunMsg {
  kind: "ok" | "info" | "warn";
  text: string;
}

/** 人读字节（B/KB/MB/GB，一位小数）。 */
function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

/** 「上次运行」块数据（GET /sync/state 快照；state 为 null = 整块隐藏）。 */
interface LastRun {
  /** ISO 时间串；null = 缺省/非法 → 展示「未知」。 */
  lastRunAt: string | null;
  /** 运行中/空闲；null = `running` 与 `locked` 皆缺 → 展示「未知」。 */
  running: boolean | null;
  /** 冲突数；null 或 0 → 展示「无」。 */
  conflicts: number | null;
}

/** S6 进度快照（file_sync_engine._idle_progress 全字段；缺省按 0/null）。 */
interface ProgressSnap {
  state: string;
  files_total: number;
  files_done: number;
  bytes_total: number;
  bytes_done: number;
  speed_bps: number;
  eta_sec: number;
  current_path: string | null;
  queued: number;
  failed: number;
  deferred: number;
}

export interface SyncSettingsModalProps {
  t: ThemeColors;
  tr: Tr;
  humanName: string;
  open: boolean;
  /** 当前同步状态（容器取数共享；null = 加载中）。 */
  st: SyncStatus | null;
  /** st.state === "ok"（容器用 syncCardVisible 判定）。 */
  syncOk: boolean;
  onClose: () => void;
  /** 「立即同步」成功 / 已最新 → 容器刷新状态与文件列表。 */
  onSynced: () => void;
}

function labelStyle(t: ThemeColors): ReactNS.CSSProperties {
  return { fontSize: 12, fontWeight: 600, color: t.textSecondary };
}

function valueStyle(t: ThemeColors): ReactNS.CSSProperties {
  return { fontSize: 12, color: t.text, wordBreak: "break-all" };
}

export default function SyncSettingsModal({
  t,
  tr,
  humanName,
  open,
  st,
  syncOk,
  onClose,
  onSynced,
}: SyncSettingsModalProps) {
  const [runBusy, setRunBusy] = React.useState(false);
  /** 404 / 引擎 disabled → 按钮禁用（「控制器未提供清单接口」，不再重试）。 */
  const [runUnsupported, setRunUnsupported] = React.useState(false);
  const [runMsg, setRunMsg] = React.useState<RunMsg | null>(null);
  const [exportBusy, setExportBusy] = React.useState(false);
  const [lastRun, setLastRun] = React.useState<LastRun | null>(null);
  /** S1 生效范围（null = 未取到 → 范围块降级为静态说明）。 */
  const [scope, setScope] = React.useState<
    { include: string[]; exclude: string[]; recursive: boolean; selection: Record<string, boolean> } | null
  >(null);
  const [scopeOpen, setScopeOpen] = React.useState(false);
  const [scopeBusy, setScopeBusy] = React.useState(false);
  /** S6 进度（null = 未取到；state=idle 时只显示「空闲」）。 */
  const [prog, setProg] = React.useState<ProgressSnap | null>(null);
  /** S2 待取消同步的镜像路径（相对 files/）。 */
  const [unsyncPath, setUnsyncPath] = React.useState("");
  /** S5 冲突记录（新→旧；null = 端点缺失/未取到 → 整块隐藏）。 */
  const [conflicts, setConflicts] = React.useState<ConflictRec[] | null>(null);

  const num = (v: unknown): number => (typeof v === "number" ? v : 0);

  /** 拉取只读同步状态（GET /sync/state）。404（老控制器无端点）/405/5xx/
   * 网络失败/非 JSON 体（SPA 兜底 HTML）→ null = 整块隐藏（不报错、不空壳）。 */
  const loadLastRun = React.useCallback(async () => {
    try {
      const resp = await fetchFile(
        SYNC_STATE_PATH,
        resolvePluginUrl(SYNC_STATE_PATH),
      );
      if (!resp.ok) {
        setLastRun(null);
        return;
      }
      const j = (await resp.json().catch(() => null)) as
        | Record<string, unknown>
        | null;
      if (j === null || typeof j !== "object") {
        setLastRun(null);
        return;
      }
      setLastRun({
        lastRunAt: typeof j.lastRunAt === "string" ? j.lastRunAt : null,
        // 任务书口径 `running`；引擎实际字段 `locked`（单写者锁持有 = 有同步
        // 在跑）——前者缺省时回退后者。
        running:
          typeof j.running === "boolean"
            ? j.running
            : typeof j.locked === "boolean"
              ? j.locked
              : null,
        conflicts:
          typeof j.conflicts === "number" && Number.isFinite(j.conflicts)
            ? j.conflicts
            : null,
      });
    } catch {
      setLastRun(null);
    }
  }, []);

  React.useEffect(() => {
    // 弹窗打开（DialogShell destroyOnClose → 内容挂载）时取一次；「立即同步」
    // 成功后由 doRun 再取，刷新 lastRunAt。
    if (open) void loadLastRun();
  }, [open, loadLastRun]);

  /** 立即同步（POST /sync/run；响应形态见 sync_api.py / file_sync_engine.run_once）。 */
  const doRun = async () => {
    setRunBusy(true);
    setRunMsg(null);
    try {
      const resp = await fetchFile(SYNC_RUN_PATH, resolvePluginUrl(SYNC_RUN_PATH), {
        method: "POST",
      });
      if (resp.status === 404) {
        setRunUnsupported(true);
        setRunMsg({ kind: "warn", text: tr("控制器未提供清单接口") });
        return;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const j = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
      if (j.locked === true) {
        setRunMsg({ kind: "info", text: tr("同步进行中（已有同步任务在跑）") });
        return;
      }
      if (j.enabled === false) {
        // 引擎：控制器无清单接口（404/405/501），disabled 不再重试。
        setRunUnsupported(true);
        setRunMsg({ kind: "warn", text: tr("控制器未提供清单接口") });
        return;
      }
      if (j.skipped === "same-generation") {
        setRunMsg({ kind: "ok", text: tr("已是最新（代数未变化）") });
        onSynced();
        void loadLastRun();
        return;
      }
      if (typeof j.error === "string" && j.error) {
        setRunMsg({ kind: "warn", text: `${tr("同步失败")}: ${j.error}` });
        return;
      }
      setRunMsg({
        kind: "ok",
        text: tr("同步完成：下载 {a} · 上传 {b} · 冲突 {c}", {
          a: num(j.downloaded),
          b: num(j.uploaded),
          c: num(j.conflicts),
        }),
      });
      onSynced();
      void loadLastRun();
    } catch {
      setRunMsg({ kind: "warn", text: tr("同步失败") });
    } finally {
      setRunBusy(false);
    }
  };

  /** 导出清单原文（getSyncManifest + downloadTextFile；与旧 SyncCard 同一逻辑）。 */
  const doExport = async () => {
    setExportBusy(true);
    try {
      const r = await getSyncManifest(humanName);
      if (r.ok && r.text != null) {
        if (downloadTextFile(r.text, `files-manifest-${humanName}.json`)) {
          antd.message.success(tr("清单原文已导出"));
        } else {
          antd.message.error(tr("导出失败"));
        }
      } else {
        antd.message.error(tr("清单获取失败"));
      }
    } finally {
      setExportBusy(false);
    }
  };

  /** S1 读生效范围（端点缺失/失败 → null，块内降级为静态说明）。 */
  const loadScope = React.useCallback(async () => {
    try {
      const resp = await fetchFile(SYNC_CONFIG_PATH, resolvePluginUrl(SYNC_CONFIG_PATH));
      if (!resp.ok) {
        setScope(null);
        return;
      }
      const j = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
      const eff = (j?.effective ?? null) as
        | { include?: unknown; exclude?: unknown; recursive?: unknown; selection?: unknown }
        | null;
      if (!eff) {
        setScope(null);
        return;
      }
      const asArr = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
      const sel =
        eff.selection && typeof eff.selection === "object" && !Array.isArray(eff.selection)
          ? Object.fromEntries(
              Object.entries(eff.selection as Record<string, unknown>).filter(
                ([k, v]) => typeof k === "string" && typeof v === "boolean",
              ),
            ) as Record<string, boolean>
          : {};
      setScope({
        include: asArr(eff.include),
        exclude: asArr(eff.exclude),
        recursive: typeof eff.recursive === "boolean" ? eff.recursive : true,
        selection: sel,
      });
    } catch {
      setScope(null);
    }
  }, []);

  /** S6 轮询（打开时 1s 一次；关闭即停，避免后台空转）。 */
  React.useEffect(() => {
    if (!open) {
      setProg(null);
      return undefined;
    }
    let live = true;
    const tick = async () => {
      try {
        const resp = await fetchFile(SYNC_PROGRESS_PATH, resolvePluginUrl(SYNC_PROGRESS_PATH));
        if (!resp.ok) return;
        const j = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
        if (!live || !j) return;
        const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
        setProg({
          state: typeof j.state === "string" ? j.state : "idle",
          files_total: n(j.files_total),
          files_done: n(j.files_done),
          bytes_total: n(j.bytes_total),
          bytes_done: n(j.bytes_done),
          speed_bps: n(j.speed_bps),
          eta_sec: n(j.eta_sec),
          current_path: typeof j.current_path === "string" ? j.current_path : null,
          queued: n(j.queued),
          failed: n(j.failed),
          deferred: n(j.deferred),
        });
      } catch {
        /* 端点缺失/网络抖动 → 保留上一次快照 */
      }
    };
    void tick();
    const h = window.setInterval(() => void tick(), 1000);
    return () => {
      live = false;
      window.clearInterval(h);
    };
  }, [open]);

  React.useEffect(() => {
    if (open) void loadScope();
  }, [open, loadScope]);

  /** S5 冲突列表（端点缺失/失败 → null = 整块隐藏，不空壳报错）。 */
  const loadConflicts = React.useCallback(async () => {
    try {
      const resp = await fetchFile(
        "/agentteams-proxy/sync/conflicts?limit=50",
        resolvePluginUrl("/agentteams-proxy/sync/conflicts?limit=50"),
      );
      if (!resp.ok) {
        setConflicts(null);
        return;
      }
      const j = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
      const arr = Array.isArray(j?.conflicts) ? (j?.conflicts as ConflictRec[]) : [];
      setConflicts(arr);
    } catch {
      setConflicts(null);
    }
  }, []);

  React.useEffect(() => {
    if (open) void loadConflicts();
  }, [open, loadConflicts]);

  /** S5 删本地冲突副本（远端不动）；成功后重取列表。 */
  const removeConflict = async (rel: string) => {
    try {
      const resp = await fetchFile(
        "/agentteams-proxy/sync/conflicts/remove",
        resolvePluginUrl("/agentteams-proxy/sync/conflicts/remove"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: rel }),
        },
      );
      const j = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
      if (!resp.ok || j.removed !== true) {
        antd.message.warning(tr("未删除（{r}）", { r: String(j.reason ?? resp.status) }));
        return;
      }
      antd.message.success(tr("已删除本地冲突副本"));
      void loadConflicts();
      onSynced();
    } catch {
      antd.message.error(tr("操作失败"));
    }
  };

  /** S2 取消同步：只删本地镜像；远端证据不足后端拒绝（refused 原样展示）。 */
  const doUnsync = () => {
    const p = unsyncPath.trim();
    if (!p) return;
    antd.Modal.confirm({
      title: tr("取消同步并删除本地副本？"),
      content: tr("仅删除本地镜像 {p}；远端文件不会被删除。", { p }),
      okText: tr("取消同步"),
      cancelText: tr("不动"),
      onOk: async () => {
        try {
          const resp = await fetchFile(SYNC_UNSYNC_PATH, resolvePluginUrl(SYNC_UNSYNC_PATH), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ human: humanName, paths: [p] }),
          });
          if (!resp.ok) {
            antd.message.error(`HTTP ${resp.status}`);
            return;
          }
          const j = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
          const removed = Array.isArray(j.removed) ? j.removed.length : 0;
          const refused = Array.isArray(j.refused) ? j.refused.length : 0;
          if (removed > 0) {
            setUnsyncPath("");
            antd.message.success(tr("已删除本地副本 {n} 项（远端未动）", { n: removed }));
            onSynced();
          } else {
            antd.message.warning(
              tr("未删除：远端证据不足（{n} 项被拒）；远端未动", { n: refused }),
            );
          }
        } catch {
          antd.message.error(tr("操作失败"));
        }
      },
    });
  };

  /** 稳定的初始值对象（避免每次父渲染都新建 identity 触发子组件重置）。 */
  const scopeInitial = React.useMemo(
    () => ({
      selection: scope?.selection ?? {},
      recursive: scope?.recursive ?? true,
    }),
    [scope],
  );

  /** 范围摘要文案（全选 / n 个文件夹 + 递归态）。 */
  const scopeSummary = (): string => {
    if (!scope) return tr("默认同步 files/**（全部文件）");
    const inc = scope.include;
    if (inc.length === 0) return tr("不同步任何文件");
    if (inc.length === 1 && (inc[0] === "files/**" || inc[0] === "files/*")) {
      return scope.recursive
        ? tr("全部文件（含子文件夹）")
        : tr("仅根目录直接文件");
    }
    const folders = Object.entries(scope.selection).filter(([, on]) => on).length;
    const label = folders > 0 ? tr("{n} 个文件夹", { n: folders }) : tr("{n} 条规则", { n: inc.length });
    return scope.recursive ? tr("{l}（含子文件夹）", { l: label }) : tr("{l}（不含子文件夹）", { l: label });
  };

  /** 保存目录选择（selection/recursive → include glob 由弹窗导出）。 */
  const saveScopeSelection = async (
    next: SyncScope & { include: string[] },
  ) => {
    setScopeBusy(true);
    try {
      const resp = await fetchFile(SYNC_CONFIG_PATH, resolvePluginUrl(SYNC_CONFIG_PATH), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          human: humanName,
          include: next.include,
          // 全关（include 空）→ 用 exclude files/** 表达「一个都不同步」；
          // 引擎 include 为空会回退默认 files/**，不能靠空 include 表达。
          exclude: next.include.length === 0 ? ["files/**"] : [],
          recursive: next.recursive,
          selection: next.selection,
        }),
      });
      if (resp.status === 404) {
        antd.message.warning(tr("控制器未提供同步范围配置接口"));
        return;
      }
      if (!resp.ok) {
        antd.message.error(`HTTP ${resp.status}`);
        return;
      }
      setScope({
        include: next.include,
        exclude: next.include.length === 0 ? ["files/**"] : [],
        recursive: next.recursive,
        selection: next.selection,
      });
      setScopeOpen(false);
      antd.message.success(tr("同步范围已保存"));
    } catch {
      antd.message.error(tr("保存失败"));
    } finally {
      setScopeBusy(false);
    }
  };

  /** state 未就绪的原因（empty / denied / unsupported；ok 走计数行）。 */
  const statusReason =
    st?.state === "empty"
      ? tr("尚无清单（本地同步客户端未写入）")
      : st?.state === "denied"
        ? tr("未授予 file_sync 权限")
        : tr("控制器未提供清单接口");

  return (
    <>
    <DialogShell
      open={open}
      title={tr("同步设置")}
      onClose={onClose}
      footer={
        <antd.Button style={btnTouch} onClick={onClose}>
          {tr("关闭")}
        </antd.Button>
      }
    >
      <div style={{ display: "grid", gap: 14, padding: "4px 0" }}>
        {/* 同步状态（条目 / 墓碑 / 代数 / 最后写入者 / 更新时间）。 */}
        <div style={{ display: "grid", gap: 4 }}>
          <span style={labelStyle(t)}>{tr("同步状态")}</span>
          {st === null ? (
            <span style={valueStyle(t)}>{tr("加载中…")}</span>
          ) : syncOk ? (
            <>
              <span style={valueStyle(t)}>
                {tr("条目")} {st.entries ?? 0} · {tr("墓碑")} {st.tombstones ?? 0} ·{" "}
                {tr("代")} {st.generation ?? "—"}
              </span>
              <span style={valueStyle(t)}>{tr("最后写入者")} {st.updatedBy ?? "—"}</span>
              <span style={valueStyle(t)}>
                {st.updatedBy
                  ? tr("更新于 {t}（{by}）", { t: fmtTs(st.updatedAt), by: st.updatedBy })
                  : tr("更新于 {t}", { t: fmtTs(st.updatedAt) })}
              </span>
            </>
          ) : (
            <antd.Alert type="info" showIcon message={statusReason} />
          )}
        </div>
        {/* 上次运行（GET /sync/state 只读快照；端点不可用 → 整块隐藏）。 */}
        {lastRun ? (
          <div style={{ display: "grid", gap: 4 }}>
            <span style={labelStyle(t)}>{tr("上次运行")}</span>
            <span style={valueStyle(t)}>
              {tr("时间")}{" "}
              {fmtTs(lastRun.lastRunAt) || tr("未知")}
            </span>
            <span style={valueStyle(t)}>
              {tr("状态")}{" "}
              {lastRun.running === true
                ? tr("运行中")
                : lastRun.running === false
                  ? tr("空闲")
                  : tr("未知")}
            </span>
            <span style={valueStyle(t)}>
              {tr("冲突")}{" "}
              {lastRun.conflicts != null && lastRun.conflicts > 0
                ? lastRun.conflicts
                : tr("无")}
            </span>
          </div>
        ) : null}
        {/* S6 进度（GET /sync/progress 1s 轮询；idle 只显示空闲）。 */}
        {prog ? (
          <div style={{ display: "grid", gap: 4 }}>
            <span style={labelStyle(t)}>{tr("同步进度")}</span>
            {prog.state === "idle" ? (
              <span style={valueStyle(t)}>{tr("空闲")}</span>
            ) : (
              <>
                <antd.Progress
                  percent={
                    prog.files_total > 0
                      ? Math.min(100, Math.round((prog.files_done / prog.files_total) * 100))
                      : 0
                  }
                  size="small"
                  status={prog.state === "error" ? "exception" : "active"}
                />
                <span style={valueStyle(t)}>
                  {tr("文件 {a}/{b}", { a: prog.files_done, b: prog.files_total })} ·{" "}
                  {fmtBytes(prog.bytes_done)}/{fmtBytes(prog.bytes_total)}
                </span>
                <span style={valueStyle(t)}>
                  {tr("速度 {s}/s", { s: fmtBytes(prog.speed_bps) })} ·{" "}
                  {prog.eta_sec > 0 ? tr("剩余 {n}s", { n: prog.eta_sec }) : tr("剩余 —")}
                  {prog.failed > 0 ? ` · ${tr("失败")} ${prog.failed}` : ""}
                  {prog.deferred > 0 ? ` · ${tr("延后")} ${prog.deferred}` : ""}
                </span>
                {prog.current_path ? (
                  <span style={{ ...valueStyle(t), wordBreak: "break-all" }}>
                    {prog.current_path}
                  </span>
                ) : null}
              </>
            )}
          </div>
        ) : null}
        {/* 立即同步（未就绪仍可点——服务端终裁；404/disabled 后禁用）。 */}
        <div style={{ display: "grid", gap: 6 }}>
          <antd.Button
            type="primary"
            loading={runBusy}
            disabled={runUnsupported}
            style={btnTouch}
            onClick={() => void doRun()}
          >
            {tr("立即同步")}
          </antd.Button>
          {runUnsupported ? (
            <span style={{ fontSize: 12, color: t.textSecondary }}>
              {tr("控制器未提供清单接口")}
            </span>
          ) : null}
          {runMsg ? (
            <antd.Alert
              type={runMsg.kind === "ok" ? "success" : runMsg.kind === "warn" ? "warning" : "info"}
              showIcon
              message={runMsg.text}
            />
          ) : null}
        </div>
        {/* 导出清单原文（仅 ok 有意义；未就绪时点击 = 诚实失败提示）。 */}
        <div style={{ display: "grid", gap: 6 }}>
          <antd.Button loading={exportBusy} style={btnTouch} onClick={() => void doExport()}>
            {tr("导出清单原文")}
          </antd.Button>
        </div>
        {/* S1 同步范围：目录开关（对齐 Dropbox/OneDrive「Choose folders」） */}
        <div style={{ display: "grid", gap: 6 }}>
          <span style={labelStyle(t)}>{tr("同步范围")}</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ ...valueStyle(t), flex: 1, minWidth: 0 }}>{scopeSummary()}</span>
            <antd.Button
              size="small"
              style={{ minHeight: 40 }}
              loading={scopeBusy}
              disabled={!scope}
              onClick={() => setScopeOpen(true)}
            >
              {tr("选择文件夹…")}
            </antd.Button>
          </div>
          <span style={{ fontSize: 12, color: t.textSecondary }}>
            {tr("只同步选中的文件夹；关闭某个文件夹只停止本机同步，云端文件保留。")}
          </span>
          <span style={{ fontSize: 12, color: t.textSecondary }}>
            {tr("不同步 memory/、digest/、.trash/、.sync/")}
          </span>
        </div>
        {/* S2 取消同步（只删本地镜像；远端零 DELETE）。 */}
        <div style={{ display: "grid", gap: 6 }}>
          <span style={labelStyle(t)}>{tr("取消同步（仅删本地副本）")}</span>
          <div style={{ display: "flex", gap: 6 }}>
            <antd.Input
              size="small"
              value={unsyncPath}
              placeholder={tr("镜像内相对路径，如 文档/旧稿.docx")}
              onChange={(e: { target: { value: string } }) => setUnsyncPath(e.target.value)}
            />
            <antd.Button size="small" disabled={!unsyncPath.trim()} onClick={doUnsync}>
              {tr("取消同步")}
            </antd.Button>
          </div>
          <span style={{ fontSize: 12, color: t.textSecondary }}>
            {tr("远端证据不足时会被拒绝（远端始终不动）")}
          </span>
        </div>
        {/* S5 冲突（conflicts.log；每条 = 本地副本 + 远端主文件） */}
        {conflicts && conflicts.length > 0 ? (
          <div style={{ display: "grid", gap: 6 }}>
            <span style={labelStyle(t)}>{tr("冲突（{n}）", { n: conflicts.length })}</span>
            {conflicts.slice(0, 10).map((c, i) => (
              <div
                key={`${c.conflictCopy ?? c.path ?? "c"}-${i}`}
                style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}
              >
                <span style={{ ...valueStyle(t), flex: 1, minWidth: 0, wordBreak: "break-all" }}>
                  {c.path ?? "—"}
                  {c.ts ? ` · ${fmtTs(c.ts)}` : ""}
                </span>
                <antd.Button
                  size="small"
                  disabled={!c.conflictCopy}
                  onClick={() => c.conflictCopy && void removeConflict(c.conflictCopy)}
                >
                  {tr("删除本地副本")}
                </antd.Button>
              </div>
            ))}
            <span style={{ fontSize: 12, color: t.textSecondary }}>
              {tr("主文件以远端为准；冲突副本仅存本地，删除不影响远端")}
            </span>
          </div>
        ) : null}
        {/* 路径说明（镜像目录）。 */}
        <div style={{ display: "grid", gap: 4 }}>
          <span style={labelStyle(t)}>{tr("镜像目录")}</span>
          <span
            style={{
              fontSize: 12,
              color: t.text,
              fontFamily: "monospace",
              wordBreak: "break-all",
            }}
          >
            {MIRROR_DIR}
          </span>
        </div>
      </div>
    </DialogShell>
            <SyncScopeDialog
          open={scopeOpen}
          t={t}
          tr={tr}
          humanName={humanName}
          initial={scopeInitial}
          saving={scopeBusy}
          onClose={() => setScopeOpen(false)}
          onSave={(next) => void saveScopeSelection(next)}
        />
    </>
  );
}
