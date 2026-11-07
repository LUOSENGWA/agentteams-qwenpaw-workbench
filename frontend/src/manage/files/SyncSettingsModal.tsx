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
import { fmtTs } from "./format";
import DialogShell from "./DialogShell";

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

/** antd.Button 最小触控盒（与 FilesSection.btnTouch 同源）。 */
const btnTouch: ReactNS.CSSProperties = { minHeight: "var(--hf-btn-min, 40px)" };

interface RunMsg {
  kind: "ok" | "info" | "warn";
  text: string;
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

  /** state 未就绪的原因（empty / denied / unsupported；ok 走计数行）。 */
  const statusReason =
    st?.state === "empty"
      ? tr("尚无清单（本地同步客户端未写入）")
      : st?.state === "denied"
        ? tr("未授予 file_sync 权限")
        : tr("控制器未提供清单接口");

  return (
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
        {/* 同步范围（静态说明：引擎只同步 files/**，远端零 DELETE）。 */}
        <div style={{ display: "grid", gap: 4 }}>
          <span style={labelStyle(t)}>{tr("同步范围")}</span>
          <span style={valueStyle(t)}>
            {tr("同步 workspace/{h}/files/**", { h: humanName })}
          </span>
          <span style={valueStyle(t)}>{tr("不同步 memory/、digest/、.trash/、.sync/")}</span>
          <span style={valueStyle(t)}>{tr("远端文档不会被本地删除影响")}</span>
        </div>
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
  );
}
