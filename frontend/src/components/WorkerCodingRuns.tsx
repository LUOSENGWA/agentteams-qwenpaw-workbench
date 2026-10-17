/**
 * WorkerCodingRuns.tsx — WorkerChats 抽屉「Coding CLI」tab 的内容
 *（该 Worker 的 coding CLI 执行记录，1.2.5+；10/17：coding CLI
 * 会话归 worker 会话区——与聊天会话同一抽屉，第三个 tab）。
 *
 * 数据源 = Controller /api/v1/coding-runs（与运维面板「编码执行记录」
 * 同一源，客户端按 worker 过滤）；列表行/详情 modal 复用
 * CodingRunsPanel 导出的渲染件（同一数据源同一渲染，不漂移）。
 * 404 = 旧 Controller → 「升级后自动开放」空态；空列表 = 空态不报错。
 * 30s 静默轮询（tab 可见门控，切走即停）。
 */
import type * as ReactNS from "react";

import {
  listCodingRunsByWorker,
  httpErrorStatus,
  type CodingRun,
} from "../api";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";
import { usePoller } from "../usePoller";
import {
  CodingRunDetailModal,
  displayTime,
  showExit,
  statusVariant,
} from "./CodingRunsPanel";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

function WorkerCodingRuns({ worker }: { worker: string }) {
  const tr = useT();
  const t = useThemeColors();
  const [runs, setRuns] = React.useState<CodingRun[] | null>(null);
  const [notDeployed, setNotDeployed] = React.useState(false);
  const [loadError, setLoadError] = React.useState("");
  const [selected, setSelected] = React.useState<CodingRun | null>(null);
  // 可见门控：父 tab 切走时卸载本组件 → 轮询随卸载停（同 ops 面板语义）。
  const [visible, setVisible] = React.useState(true);
  React.useEffect(() => {
    setVisible(true);
    return () => setVisible(false);
  }, []);

  const refresh = React.useCallback(
    async (silent = false) => {
      if (!worker) return;
      try {
        const data = await listCodingRunsByWorker(worker);
        setRuns(data);
        setLoadError("");
        setNotDeployed(false);
      } catch (e) {
        if (httpErrorStatus(e) === 404) {
          setNotDeployed(true);
          setRuns([]);
        } else if (!silent) {
          setLoadError(e instanceof Error ? e.message : tr("加载失败"));
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [worker],
  );

  React.useEffect(() => {
    setRuns(null);
    setNotDeployed(false);
    setLoadError("");
    void refresh(false);
  }, [refresh]);

  usePoller({
    fn: () => void refresh(true),
    intervalMs: 30000,
    active: visible,
    minPokeMs: 15000,
  });

  const sorted = React.useMemo(() => {
    if (!runs) return [];
    return [...runs].sort((a, b) => displayTime(b).localeCompare(displayTime(a)));
  }, [runs]);

  if (!worker) {
    return (
      <antd.Alert type="info" showIcon message={tr("选择 Worker 后显示其 Coding CLI 执行记录")} />
    );
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, color: t.textSecondary }}>
          {tr("该 Worker 的编码 CLI 一次性执行记录与原始日志（只读）")}
        </span>
        <div style={{ flex: 1 }} />
        {runs && !notDeployed ? (
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("{n} 条", { n: runs.length })}
          </span>
        ) : null}
        <antd.Button size="small" type="text" onClick={() => void refresh(false)}>
          {tr("刷新")}
        </antd.Button>
      </div>

      {notDeployed ? (
        <div
          style={{
            padding: "12px 14px",
            borderRadius: 8,
            border: `1px solid ${t.border}`,
            color: t.textSecondary,
            fontSize: 12,
          }}
        >
          {tr("当前 Controller 版本未提供编码执行记录（升级后自动开放）。")}
        </div>
      ) : loadError ? (
        <antd.Alert type="error" showIcon message={tr("加载失败：{e}", { e: loadError })} />
      ) : runs === null ? (
        <div style={{ padding: 12 }}>
          <antd.Skeleton active title={false} paragraph={{ rows: 2 }} />
        </div>
      ) : sorted.length === 0 ? (
        <antd.Empty
          description={tr("该 Worker 暂无编码执行记录")}
          image={antd.Empty.PRESENTED_IMAGE_SIMPLE}
        />
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          {sorted.map((r) => (
            <div
              key={`${r.task_id}/${r.run}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 12px",
                borderRadius: 8,
                background: t.cardBg,
                border: `1px solid ${t.border}`,
                flexWrap: "wrap",
              }}
            >
              <span
                style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color: t.text }}
              >
                {displayTime(r)}
              </span>
              <span style={{ flex: 1 }} />
              {r.cli ? <antd.Tag color="geekblue">{r.cli}</antd.Tag> : null}
              {r.status ? (
                <antd.Tag color={statusVariant(r.status)}>{r.status}</antd.Tag>
              ) : null}
              <span style={{ fontSize: 11, color: t.textSecondary }}>
                {tr("退出 {code}", { code: showExit(r.exit_code) })}
              </span>
              <antd.Button size="small" type="link" onClick={() => setSelected(r)}>
                {tr("查看")}
              </antd.Button>
            </div>
          ))}
        </div>
      )}

      {selected ? (
        <CodingRunDetailModal run={selected} onClose={() => setSelected(null)} />
      ) : null}
    </div>
  );
}

export default React.memo(WorkerCodingRuns);
