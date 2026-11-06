/**
 * SyncSettingsModal.tsx — 文件管理 v3（F-V3-1）同步设置弹窗（工具条「同步设置」
 * 按钮打开；替代原页内 SyncCard 长条——关闭后不占页面空间）。
 *
 * 内容（四块）：
 * - 同步状态：条目 / 墓碑 / 代数 / 最后写入者 / 更新时间（st 由容器 getSyncStatus
 *   取来共享；null = 「加载中…」）。state 未就绪（empty / denied /
 *   unsupported）= 弹窗内显原因（Alert）——「立即同步」按钮仍可点（服务端终裁）。
 * - 立即同步：POST /agentteams-proxy/sync/run（无 body；引擎单写者锁
 *   .sync/lock——后台轮跑中 → {"locked": true} 诚实提示）。
 *   404（老控制器无此端点）/ 引擎 enabled:false（controller_without_manifest）
 *   = 「控制器未提供清单接口」+ 按钮禁用；locked = 「同步进行中（已有同步任务
 *   在跑）」；skipped=same-generation = 「已是最新（代数未变化）」；成功 =
 *   「同步完成：下载 {a} · 上传 {b} · 冲突 {c}」→ onSynced（容器刷新状态 + 列表）。
 * - 导出清单原文：getSyncManifest + downloadTextFile（与旧 SyncCard 同一逻辑）。
 * - 路径说明：镜像目录 = MIRROR_DIR（任务书口径 <workspace>/.qwenpaw/agentteams）。
 *
 * 共享帮助函数（fmtTs）从 ./TrashPanel 导入（files/ 内部依赖，无循环）。
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
import { fmtTs } from "./TrashPanel";

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

/** antd.Button 最小触控盒（与 FilesSection.btnTouch 同源）。 */
const btnTouch: ReactNS.CSSProperties = { minHeight: "var(--hf-btn-min, 40px)" };

interface RunMsg {
  kind: "ok" | "info" | "warn";
  text: string;
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

  const num = (v: unknown): number => (typeof v === "number" ? v : 0);

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
    <antd.Modal
      open={open}
      title={tr("同步设置")}
      onCancel={onClose}
      destroyOnClose
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
    </antd.Modal>
  );
}
