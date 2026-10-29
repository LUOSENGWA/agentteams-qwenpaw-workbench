/**
 * WorkerMcpPanel.tsx — Worker MCP 面板（只读合并视图：CRD 声明 + worker
 * 自注册）。结构/风格同 WorkerEnvPanel（WorkerCollapseCard 折叠卡家族，
 * x=33 段头轨对齐；竖屏 sheet 模式去卡片外框进 NarrowSheet）。
 *
 * 两路数据：
 * - declared = worker detail `spec.mcpServers`（WorkerInfo.mcpServers，
 *   Controller /workers 透传，admin 30s 缓存轮询在树侧已刷新）。
 * - self-registered = 插件后端 GET /workers/{name}/mcp → Controller 只读
 *   代理 GET /api/v1/workers/{name}/mcp（worker 侧 QwenPaw mcp.clients
 *   注册表，内置插件 teamharness/workerflow 等自注册条目）。
 *
 * 诚实降级（Controller 端点是并行单，可能尚未合并）：404 → 后端返回
 * HTTP 200 {available:false, reason:"controller_too_old"} → 本面板一行
 * info 提示「需升级 controller」，不报错弹窗，declared 照常显示；
 * 无本地 controller token → reason:"no_token" 同款降级。
 *
 * 合并：按 name 对齐（自注册条目 name = 客户端 key，与 CRD 服务端名
 * 同源）；同一 name 一行 + 双来源徽标（declared / self-registered）；
 * 字段冲突自注册优先（运行时注册是真相）。
 *
 * 脱敏：env/headers **只显示键名、值恒 ***（后端已脱敏，前端再兜一层，
 * 防上游形态变化带出明文）；command/args 用户名段由后端换 ~；url 由
 * 后端剥 user:pass@。
 *
 * 纪律：React/antd 取宿主（window.QwenPaw.host）；i18n 全量注册 en 键。
 */
import type * as ReactNS from "react";

import {
  fetchWorkerMcp,
  httpErrorDetail,
  type McpServerInfo,
  type WorkerInfo,
  type WorkerMcpEntry,
  type WorkerMcpResult,
} from "../api";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";
import { PlugIcon } from "./icons";
import { WorkerCollapseCard } from "./WorkerPanelsShared";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

const SOURCE_DECLARED = "declared";
const SOURCE_SELF = "self-registered";

/** 合并行：两路按 name 对齐，各自条目原样保留（字段冲突展示时自注册优先）。 */
type MergedRow = {
  name: string;
  declared?: McpServerInfo;
  self?: WorkerMcpEntry;
};

function mergeRows(
  declared?: McpServerInfo[],
  self?: WorkerMcpEntry[],
): MergedRow[] {
  const map = new Map<string, MergedRow>();
  for (const d of declared ?? []) {
    if (!d || !d.name) continue;
    map.set(d.name, { name: d.name, declared: d });
  }
  for (const s of self ?? []) {
    if (!s || !s.name) continue;
    const cur = map.get(s.name);
    if (cur) cur.self = s;
    else map.set(s.name, { name: s.name, self: s });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** env/headers 脱敏：只留键名（值恒 ***，不信任上游已脱敏）。 */
const maskedKeys = (m?: Record<string, string>): string[] =>
  m ? Object.keys(m) : [];

/** 端点展示：url 优先；stdio 走 command + args（后端已脱敏/tilde）。 */
const endpointOf = (row: MergedRow): string => {
  const url = row.self?.url || row.declared?.url || "";
  const command = row.self?.command || "";
  const args = row.self?.args ?? [];
  return url || [command, ...args].join(" ").trim();
};

function WorkerMcpPanel({
  worker,
  sheet,
}: {
  worker: WorkerInfo;
  /** 竖屏弹窗模式（NarrowSheet 承载）：去卡片外框 + 头部隐藏收起抓手/
   * 图标/标题（与 WorkerEnvPanel sheet 同语义），内容零改动。 */
  sheet?: boolean;
}) {
  const tr = useT();
  const t = useThemeColors();
  const [open, setOpen] = React.useState(sheet === true);
  // 自注册读路径——懒加载：首次展开才拉（有 controller 拨号成本）；
  // 刷新按钮手动重拉。declared 不依赖本请求（admin 缓存轮询正源）。
  const [self, setSelf] = React.useState<WorkerMcpResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [fetchErr, setFetchErr] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    setFetchErr("");
    try {
      setSelf(await fetchWorkerMcp(worker.name));
    } catch (e) {
      // 后端已把 404 降级成 200；到这里只剩硬错误（401/403/5xx/502/
      // 网络）——行内 warning，不弹窗（任务书口径）。
      setFetchErr(httpErrorDetail(e) || tr("获取失败"));
    } finally {
      setLoading(false);
    }
  }, [worker.name, tr]);

  React.useEffect(() => {
    if (open && !self && !loading) void load();
  }, [open, self, loading, load]);

  const rows = React.useMemo(
    () => mergeRows(worker.mcpServers, self?.mcpServers),
    [worker.mcpServers, self],
  );
  const unavailable = self != null && self.available === false;

  return (
    <WorkerCollapseCard
      open={open}
      sheet={sheet}
      icon={<PlugIcon size={13} />}
      title={tr("Worker MCP")}
      titleExtra={
        <antd.Tag style={{ marginInlineEnd: 0, fontSize: 10 }}>{rows.length}</antd.Tag>
      }
      onExpand={() => setOpen(true)}
      onCollapse={() => setOpen(false)}
      headerExtra={
        <>
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
      <div style={{ fontSize: 11, color: t.textSecondary }}>
        {tr(
          "MCP 合并视图：CRD 声明（spec.mcpServers）+ worker 自注册（容器启动时注册进 QwenPaw 的内置插件 MCP）。env/headers 值已脱敏。",
        )}
      </div>
      {/* 诚实降级：Controller 端点未合（404）/ 无 token → 一行提示，
          不报错弹窗；declared 列表照常展示（下方不受影响）。 */}
      {unavailable && self ? (
        <antd.Alert
          type={
            self.reason === "controller_too_old" || self.reason === "no_token"
              ? "info"
              : "warning"
          }
          showIcon
          message={
            self.reason === "controller_too_old"
              ? tr("当前 controller 不支持读取 worker 自注册 MCP（需升级 controller）")
              : self.reason === "no_token"
                ? tr("未配置 controller 凭据，暂不能读取 worker 自注册 MCP")
                : tr("自注册 MCP 读取失败（{reason}）——仅显示 CRD 声明。", {
                    reason: self.reason || "unknown",
                  })
          }
        />
      ) : null}
      {fetchErr ? <antd.Alert type="warning" showIcon message={fetchErr} /> : null}
      {loading && !self ? (
        <antd.Skeleton active title={false} paragraph={{ rows: 2 }} />
      ) : null}
      {/* 空态：两路都空才说「未配置任何 MCP」——unavailable/取数失败时
          自注册路是「读不到」而非「为空」，不宣称未配置。 */}
      {!loading && !unavailable && !fetchErr && rows.length === 0 ? (
        <div style={{ fontSize: 12, color: t.textSecondary }}>
          {tr("该 worker 未配置任何 MCP")}
        </div>
      ) : null}
      {rows.length > 0 ? (
        <div style={{ display: "grid", gap: 3 }}>
          {rows.map((row) => {
            const endpoint = endpointOf(row);
            const transport = row.self?.transport || row.declared?.transport || "";
            const envKeys = maskedKeys(row.self?.env);
            const headerKeys = maskedKeys(row.self?.headers);
            return (
              <div
                key={row.name}
                style={{
                  display: "grid",
                  gap: 3,
                  padding: "4px 8px",
                  border: `1px solid ${t.border}`,
                  borderRadius: 6,
                  minWidth: 0,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    flexWrap: "wrap",
                    minWidth: 0,
                  }}
                >
                  <span
                    style={{
                      fontWeight: 600,
                      fontSize: 12,
                      fontFamily: "monospace",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: "100%",
                    }}
                    title={row.name}
                  >
                    {row.self?.displayName || row.name}
                  </span>
                  {row.declared ? (
                    <antd.Tag color="blue" style={{ marginInlineEnd: 0, fontSize: 10 }}>
                      {tr(SOURCE_DECLARED)}
                    </antd.Tag>
                  ) : null}
                  {row.self ? (
                    <antd.Tag color="green" style={{ marginInlineEnd: 0, fontSize: 10 }}>
                      {tr(SOURCE_SELF)}
                    </antd.Tag>
                  ) : null}
                  {row.self?.enabled != null ? (
                    <antd.Tag
                      color={row.self.enabled ? "green" : "default"}
                      style={{ marginInlineEnd: 0, fontSize: 10 }}
                    >
                      {tr(row.self.enabled ? "enabled" : "disabled")}
                    </antd.Tag>
                  ) : null}
                  {transport ? (
                    <antd.Tag style={{ marginInlineEnd: 0, fontSize: 10 }}>
                      {transport}
                    </antd.Tag>
                  ) : null}
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontFamily: "monospace",
                      fontSize: 11,
                      color: t.textSecondary,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={endpoint}
                  >
                    {endpoint || tr("（无端点）")}
                  </span>
                </div>
                {envKeys.length ? (
                  <div
                    style={{
                      fontFamily: "monospace",
                      fontSize: 11,
                      color: t.textSecondary,
                    }}
                  >
                    {tr("env")}: {envKeys.map((k) => `${k}=***`).join("  ")}
                  </div>
                ) : null}
                {headerKeys.length ? (
                  <div
                    style={{
                      fontFamily: "monospace",
                      fontSize: 11,
                      color: t.textSecondary,
                    }}
                  >
                    {tr("headers")}:{" "}
                    {headerKeys.map((k) => `${k}=***`).join("  ")}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </WorkerCollapseCard>
  );
}

export default WorkerMcpPanel;
