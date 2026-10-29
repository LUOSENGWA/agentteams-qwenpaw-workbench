/**
 * WorkerPluginsPanel.tsx — Worker 插件面板（只读表格：id / name / version /
 * enabled / loaded / plugin_type）。结构/风格同 WorkerMcpPanel
 *（WorkerCollapseCard 折叠卡家族，x=33 段头轨对齐；竖屏 sheet 模式去
 * 卡片外框进 NarrowSheet）。
 *
 * 数据：插件后端 GET /workers/{name}/plugins → Controller 只读代理
 * GET /api/v1/workers/{name}/plugins（端点是并行单，可能尚未合并）。
 *
 * 诚实降级（Controller 端点未合）：404 → 后端返回 HTTP 200
 * {available:false, reason:"controller_too_old"} → 本面板一行 info 提示
 * 「需升级 controller」，不报错弹窗；无本地 controller token →
 * reason:"no_token" 同款降级。
 *
 * 字段直传：插件条目不含凭据（无 env/headers/command）——后端原样透传，
 * 前端直接展示，无脱敏。
 *
 * 纪律：React/antd 取宿主（window.QwenPaw.host）；i18n 全量注册 en 键。
 */
import type * as ReactNS from "react";

import {
  fetchWorkerPlugins,
  httpErrorDetail,
  type WorkerInfo,
  type WorkerPluginEntry,
  type WorkerPluginsResult,
} from "../api";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";
import { BrickIcon } from "./icons";
import { WorkerCollapseCard } from "./WorkerPanelsShared";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

const textOf = (v: unknown): string =>
  typeof v === "string" ? v.trim() : "";
const boolOf = (v: unknown): boolean | null =>
  typeof v === "boolean" ? v : null;

function WorkerPluginsPanel({
  worker,
  sheet,
}: {
  worker: WorkerInfo;
  /** 竖屏弹窗模式（NarrowSheet 承载）：去卡片外框 + 头部隐藏收起抓手/
   * 图标/标题（与 WorkerMcpPanel sheet 同语义），内容零改动。 */
  sheet?: boolean;
}) {
  const tr = useT();
  const t = useThemeColors();
  const [open, setOpen] = React.useState(sheet === true);
  // 懒加载：首次展开才拉（有 controller 拨号成本）；刷新按钮手动重拉。
  const [data, setData] = React.useState<WorkerPluginsResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [fetchErr, setFetchErr] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    setFetchErr("");
    try {
      setData(await fetchWorkerPlugins(worker.name));
    } catch (e) {
      // 后端已把 404 降级成 200；到这里只剩硬错误（401/403/5xx/502/
      // 网络）——行内 warning，不弹窗（任务书口径）。
      setFetchErr(httpErrorDetail(e) || tr("获取失败"));
    } finally {
      setLoading(false);
    }
  }, [worker.name, tr]);

  React.useEffect(() => {
    if (open && !data && !loading) void load();
  }, [open, data, loading, load]);

  const plugins = data?.plugins ?? [];
  const enabledCount = plugins.filter((p) => boolOf(p?.enabled) === true).length;
  const available = data != null && data.available === true;
  const unavailable = data != null && data.available === false;

  const columns = React.useMemo(
    () => [
      {
        title: tr("id"),
        dataIndex: "id",
        key: "id",
        ellipsis: true,
        render: (v: unknown, row: WorkerPluginEntry) => (
          <span style={{ fontFamily: "monospace", fontSize: 11 }}>
            {textOf(v) || textOf(row.name) || "—"}
          </span>
        ),
      },
      {
        title: tr("name"),
        dataIndex: "name",
        key: "name",
        ellipsis: true,
        render: (v: unknown, row: WorkerPluginEntry) => (
          <span>{textOf(v) || textOf(row.id) || "—"}</span>
        ),
      },
      {
        title: tr("version"),
        dataIndex: "version",
        key: "version",
        width: 92,
        render: (v: unknown) =>
          textOf(v) ? (
            <span style={{ fontFamily: "monospace", fontSize: 11 }}>
              {textOf(v)}
            </span>
          ) : (
            <span style={{ color: t.textSecondary }}>—</span>
          ),
      },
      {
        title: tr("enabled"),
        dataIndex: "enabled",
        key: "enabled",
        width: 78,
        render: (v: unknown) => {
          const b = boolOf(v);
          return b == null ? (
            <span style={{ color: t.textSecondary }}>—</span>
          ) : (
            <antd.Tag
              color={b ? "green" : "default"}
              style={{ marginInlineEnd: 0, fontSize: 10 }}
            >
              {tr(b ? "enabled" : "disabled")}
            </antd.Tag>
          );
        },
      },
      {
        title: tr("loaded"),
        dataIndex: "loaded",
        key: "loaded",
        width: 82,
        render: (v: unknown) => {
          const b = boolOf(v);
          return b == null ? (
            <span style={{ color: t.textSecondary }}>—</span>
          ) : (
            <antd.Tag
              color={b ? "blue" : "default"}
              style={{ marginInlineEnd: 0, fontSize: 10 }}
            >
              {tr(b ? "loaded" : "未装载")}
            </antd.Tag>
          );
        },
      },
      {
        title: tr("plugin_type"),
        dataIndex: "plugin_type",
        key: "plugin_type",
        width: 104,
        render: (v: unknown) =>
          textOf(v) ? (
            <antd.Tag style={{ marginInlineEnd: 0, fontSize: 10 }}>
              {textOf(v)}
            </antd.Tag>
          ) : (
            <span style={{ color: t.textSecondary }}>—</span>
          ),
      },
    ],
    [tr, t],
  );

  return (
    <WorkerCollapseCard
      open={open}
      sheet={sheet}
      icon={<BrickIcon size={13} />}
      title={tr("Worker 插件")}
      titleExtra={
        available ? (
          <antd.Tag style={{ marginInlineEnd: 0, fontSize: 10 }}>
            {plugins.length}
          </antd.Tag>
        ) : undefined
      }
      onExpand={() => setOpen(true)}
      onCollapse={() => setOpen(false)}
      headerExtra={
        <>
          {/* 顶部计数（已装 N 个 / 已启用 M 个）——仅读成功后有意义。 */}
          {available ? (
            <span style={{ fontSize: 11, color: t.textSecondary }}>
              {tr("已装 {n} 个 · 已启用 {m} 个", {
                n: plugins.length,
                m: enabledCount,
              })}
            </span>
          ) : null}
          <div style={{ flex: 1 }} />
          <antd.Button
            size="small"
            type="text"
            loading={loading}
            onClick={() => void load()}
          >
            {tr("刷新")}
          </antd.Button>
        </>
      }
    >
      {/* 诚实降级：Controller 端点未合（404）/ 无 token → 一行提示，
          不报错弹窗。 */}
      {unavailable && data ? (
        <antd.Alert
          type={
            data.reason === "controller_too_old" || data.reason === "no_token"
              ? "info"
              : "warning"
          }
          showIcon
          message={
            data.reason === "controller_too_old"
              ? tr("当前 controller 不支持读取 worker 插件（需升级 controller）")
              : data.reason === "no_token"
                ? tr("未配置 controller 凭据，暂不能读取 worker 插件")
                : tr("worker 插件读取失败（{reason}）", {
                    reason: data.reason || "unknown",
                  })
          }
        />
      ) : null}
      {fetchErr ? <antd.Alert type="warning" showIcon message={fetchErr} /> : null}
      {loading && !data ? (
        <antd.Skeleton active title={false} paragraph={{ rows: 2 }} />
      ) : null}
      {/* 空态：读成功且列表为空 →「未报告任何插件」（区别于
          unavailable/取数失败——那是「读不到」而非「为空」）。 */}
      {!loading && available && plugins.length === 0 ? (
        <div style={{ fontSize: 12, color: t.textSecondary }}>
          {tr("该 worker 未报告任何插件")}
        </div>
      ) : null}
      {!loading && available && plugins.length > 0 ? (
        <antd.Table
          size="small"
          rowKey={(row: WorkerPluginEntry, index?: number) =>
            row.id || row.name || String(index ?? "")
          }
          columns={columns}
          dataSource={plugins}
          pagination={false}
          scroll={{ x: 560 }}
        />
      ) : null}
    </WorkerCollapseCard>
  );
}

export default WorkerPluginsPanel;
