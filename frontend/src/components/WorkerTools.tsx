/**
 * 🔧 内置工具（，消费上游 #1255，issue #1254）。
 *
 * 位置：「👷 团队管理」tab 内的子节（与频道接入同款，不独立顶层 tab）。
 * 数据面：Controller 内置工具端点（#1255 已合 main）——
 * GET /workers/{name}/tools
 * PATCH /workers/{name}/tools/{tool}（声明式 {enabled}/{asyncExecution}）
 * 走既有通用 Controller 代理（api/ 白名单，后端零新端点）。
 *
 * 版本门：Controller < 含 #1255 的版本 → 端点 404 → 整节占位说明
 *（与频道接入/L2 冲突检查版本门同模式）。
 * 只读门：PATCH 403（团队 Leader 只读 / L2 跨团队写）→ 整节转只读 + 提示。
 *
 * 纪律：requiresConfig 只做徽章——工具配置值可能含凭据，
 * Controller 代理边界已剔除，前端永不展示配置内容（fail-closed 不放松）。
 *
 * 16.29 呈现：表格 → 分类折叠卡片（窄屏下「工具/描述」两列互挤的
 * 修复）。分组/图标口径与 QwenPaw console settings/tools 页一致
 *（toolPresentation.ts 的 TOOL_GROUPS/TOOL_PRESENTATION 映射内联，
 * 不 import QwenPaw 代码）；表外工具名归「其他」。
 *
 * 16.31 图标：卡图标 = QwenPaw 同款 lucide（toolIcons.tsx 内联节点 +
 * 按运行时分层表 toolIconFor(runtime, name)）；未收录运行时/工具名
 * → 回退后端 tool.icon（emoji）→ 组兜底 emoji。
 */
import type * as ReactNS from "react";

import { useT } from "../i18n";
import { useThemeColors } from "../theme";
import { toolToggleMessage } from "../util";
import { toolIconFor, ToolTypeIcon } from "./toolIcons";
import {
  type WorkerInfo,
  type WorkerToolInfo,
  fetchWorkerTools,
  patchWorkerTool,
  httpErrorStatus,
} from "../api";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

type ToolField = "enabled" | "asyncExecution";

/** 工具分组（组顺序 + 中文名固定；口径 = QwenPaw console
 * toolPresentation.ts 的 TOOL_GROUPS，中文名为本插件呈现层文案）。 */
const TOOL_GROUPS = [
  ["files", "文件"],
  ["web", "网络"],
  ["media", "媒体"],
  ["agents", "智能体"],
  ["runtime", "运行时"],
  ["migration", "迁移"],
  ["other", "其他"],
] as const;

type ToolGroup = (typeof TOOL_GROUPS)[number][0];

const TOOL_GROUP_ZH: Record<ToolGroup, string> = {
  files: "文件",
  web: "网络",
  media: "媒体",
  agents: "智能体",
  runtime: "运行时",
  migration: "迁移",
  other: "其他",
};

/** 组兜底图标（后端未返回 tool.icon 时用）；other = 🔧。 */
const TOOL_GROUP_ICON: Record<ToolGroup, string> = {
  files: "📁",
  web: "🌐",
  media: "🖼️",
  agents: "🤖",
  runtime: "⚙️",
  migration: "📦",
  other: "🔧",
};

/** name → group 映射（照抄 toolPresentation.ts 的 TOOL_PRESENTATION；
 * 表里没有的名字归 "other"）。 */
const TOOL_GROUP_OF: Record<string, ToolGroup> = {
  read_file: "files",
  write_file: "files",
  edit_file: "files",
  append_file: "files",
  grep_search: "files",
  glob_search: "files",
  ast_search: "files",
  send_file_to_user: "files",
  web_search: "web",
  web_fetch: "web",
  browser: "web",
  desktop_screenshot: "media",
  view_image: "media",
  view_video: "media",
  enhance_and_generate_image: "media",
  list_agents: "agents",
  chat_with_agent: "agents",
  submit_to_agent: "agents",
  check_agent_task: "agents",
  spawn_subagent: "agents",
  delegate_external_agent: "agents",
  execute_shell_command: "runtime",
  get_current_time: "runtime",
  set_user_timezone: "runtime",
  get_token_usage: "runtime",
  materialize_skill: "runtime",
  run_tool_batch: "runtime",
  activate_f1_exploration_mode: "runtime",
  migration_compat_inspect: "migration",
  migration_compat_read_file: "migration",
  migration_compat_write_file: "migration",
  migration_compat_update: "migration",
  migration_compat_finalize: "migration",
};

/** 单工具卡片：上 logo + 名（+ 需配置徽章）/ 中描述（两行截断）/
 * 下两个开关行（启用 / 异步执行）。模块级组件——定义在 WorkerTools
 * 内部会每次 render 换身份，子树反复卸载重装（开关动画/焦点丢失）。 */
function ToolCard({
  tool,
  group,
  runtime,
  readOnly,
  busy,
  onToggle,
}: {
  tool: WorkerToolInfo;
  group: ToolGroup;
  /** Worker 运行时——驱动工具图标表选择（toolIcons.RUNTIME_TOOL_ICONS）。 */
  runtime?: string;
  readOnly: boolean;
  busy: string;
  onToggle: (tool: string, field: ToolField) => void;
}) {
  const tr = useT();
  const t = useThemeColors();
  const desc = tool.description?.trim();
  // 16.31 图标优先级：运行时图标表（lucide，QwenPaw 同款）→
  // 后端 tool.icon（emoji）→ 组兜底 emoji。
  const iconName = toolIconFor(runtime, tool.name);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        minWidth: 0,
        padding: "10px 12px",
        border: `1px solid ${t.border}`,
        borderRadius: 8,
        background: t.cardBg,
      }}
    >
      {/* 上：logo（运行时图标表 lucide 优先，回退后端 emoji → 组兜底）
      + 工具名（monospace，窄屏可换行）+ 需配置徽章。 */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {iconName ? (
          <span
            aria-hidden
            style={{ color: t.textSecondary, display: "inline-flex", flexShrink: 0 }}
          >
            <ToolTypeIcon iconName={iconName} size={16} />
          </span>
        ) : (
          <span aria-hidden style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>
            {tool.icon || TOOL_GROUP_ICON[group]}
          </span>
        )}
        <span
          style={{
            fontFamily: "monospace",
            fontSize: 12.5,
            fontWeight: 600,
            wordBreak: "break-all",
            minWidth: 0,
          }}
        >
          {tool.name}
        </span>
        {tool.requiresConfig ? (
          <antd.Tag color="orange" style={{ marginInlineEnd: 0, fontSize: 10.5 }}>
            {tr("需配置")}
          </antd.Tag>
        ) : null}
      </div>
      {/* 中：描述小字（最多两行截断；无描述显 -）。 */}
      <span
        style={{
          fontSize: 11,
          color: t.textSecondary,
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {desc || "-"}
      </span>
      {/* 下：两个开关行（12px 标签 + Switch；disabled = 只读门或 busy）。 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12 }}>{tr("启用")}</span>
        <div style={{ flex: 1 }} />
        <antd.Switch
          size="small"
          checked={tool.enabled}
          disabled={readOnly || busy !== ""}
          onChange={() => onToggle(tool.name, "enabled")}
        />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12 }}>{tr("异步执行")}</span>
        <div style={{ flex: 1 }} />
        <antd.Switch
          size="small"
          checked={tool.asyncExecution ?? false}
          disabled={readOnly || busy !== ""}
          onChange={() => onToggle(tool.name, "asyncExecution")}
        />
      </div>
    </div>
  );
}

function WorkerTools({ workers }: { workers: WorkerInfo[] }) {
  const tr = useT();
  const t = useThemeColors();
  // 工具开关走宿主原生顶部 toast（与技能变更的交互对齐：
  // 「像改技能那样」的顶部通知）。宿主技能变更的
  // 「顶部弹窗」= antd App.useApp().message（顶部居中 toast，portal 到
  // document.body）；插件同页挂载（无 iframe）跑在宿主 <AntdApp> 之内，
  // 调同一个 API 即与技能 toast 逐像素同源。旧版页内 antd Alert 横幅
  // （transient ok/err）退役；403 只读门/加载失败 gate 等**持久状态**
  // 仍用 Alert（toast 3s 自消失，不适合持久提示）。
  const { message: toast } = antd.App.useApp();
  const [sel, setSel] = React.useState("");
  // 版本门：404 = Controller 无工具端点（#1255 未合并 / Controller 未升级）
  // 或 L2 跨团队 W8 防探测隐藏——两者不可区分，占位文案覆盖两种情况。
  const [gate, setGate] = React.useState<"" | "404" | "err">("");
  const [gateMsg, setGateMsg] = React.useState("");
  const [tools, setTools] = React.useState<WorkerToolInfo[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [readOnly, setReadOnly] = React.useState(false);
  const [busy, setBusy] = React.useState<"" | "enabled" | "asyncExecution">("");

  const load = React.useCallback(async () => {
    if (!sel) return;
    setLoading(true);
    setGate("");
    setGateMsg("");
    try {
      const data = await fetchWorkerTools(sel);
      setTools(Array.isArray(data?.tools) ? data.tools : []);
      setReadOnly(false);
    } catch (e) {
      const st = httpErrorStatus(e);
      if (st === 404) {
        setGate("404");
        setTools([]);
      } else {
        setGate("err");
        setGateMsg(e instanceof Error ? e.message : tr("加载失败"));
        setTools([]);
      }
    } finally {
      setLoading(false);
    }
  }, [sel, tr]);

  // // 单 Worker 场景（拓扑资源管理嵌入 = workers=[w]）自动选中，无需手动选。
  React.useEffect(() => {
    if (!sel && workers.length === 1) setSel(workers[0].name);
  }, [workers, sel]);

  React.useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  // 按固定组序聚合；空组不渲染；表外名字归 other。
  // （hook 须在下方早退 return 之前——gate 状态变化会改渲染路径，
  // 顺序不稳 = 「Rendered fewer hooks」崩溃。）
  const grouped = React.useMemo(() => {
    const buckets = new Map<ToolGroup, WorkerToolInfo[]>();
    for (const [g] of TOOL_GROUPS) buckets.set(g, []);
    for (const tool of tools) {
      const g = TOOL_GROUP_OF[tool.name] ?? "other";
      buckets.get(g)!.push(tool);
    }
    return TOOL_GROUPS.map(([g]) => [g, buckets.get(g)!] as const).filter(
      ([, list]) => list.length > 0,
    );
  }, [tools]);

  // 16.31：当前选中 Worker 的运行时——驱动工具图标表选择
  // （toolIcons.RUNTIME_TOOL_ICONS；单 Worker 嵌入态 sel 自动置位）。
  const selRuntime = React.useMemo(
    () => workers.find((w) => w.name === sel)?.runtime,
    [workers, sel],
  );

  const toggle = async (tool: string, field: ToolField) => {
    if (!sel || busy || readOnly) return;
    const current = tools.find((t2) => t2.name === tool);
    if (!current) return;
    const value = field === "enabled" ? !current.enabled : !(current.asyncExecution ?? false);
    setBusy(field);
    // 乐观更新 + 失败回滚
    setTools((prev) =>
      prev.map((x) => (x.name === tool ? { ...x, [field]: value } : x)),
    );
    try {
      const updated = await patchWorkerTool(sel, tool, { [field]: value });
      if (updated && typeof updated === "object" && "name" in updated) {
        setTools((prev) =>
          prev.map((x) => (x.name === updated.name ? { ...x, ...updated } : x)),
        );
      }
      // // 成功文案四分支纯函数（util.toolToggleMessage）必须与开关终态一致。
      // PATCH 确认后走宿主原生顶部 toast
      // （不做乐观 toast——「toast 说成功、实际回滚」的错位不允许）。
      toast.success(toolToggleMessage(tr, field, tool, value));
    } catch (e) {
      setTools((prev) =>
        prev.map((x) => (x.name === tool ? { ...x, [field]: !value } : x)),
      );
      const st = httpErrorStatus(e);
      if (st === 403) {
        setReadOnly(true);
        toast.error(
          tr("当前角色仅可查看工具设置，不能修改（Controller 拒绝）"),
        );
      } else {
        toast.error(
          tr("修改失败：{m}", {
            m: e instanceof Error ? e.message : String(st ?? e),
          }),
        );
      }
    } finally {
      setBusy("");
    }
  };

  if (workers.length === 0) {
    return <antd.Alert type="info" showIcon message={tr("无 Worker")} />;
  }

  if (gate === "404") {
    return (
      <antd.Alert
        type="info"
        showIcon
        message={tr("内置工具 API 不可用（Controller 版本较低或无该 Worker 访问权）")}
        description={tr(
          "当前 Controller 版本（未合并 #1255 的版本）无此 API，或当前账号无该 Worker 的访问权。升级 Controller 后本节自动点亮。",
        )}
      />
    );
  }

  if (gate === "err") {
    return (
      <antd.Alert
        type="error"
        showIcon
        message={tr("内置工具加载失败")}
        description={gateMsg}
        action={
          <antd.Button size="small" onClick={() => void load()}>
            {tr("重试")}
          </antd.Button>
        }
      />
    );
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600 }}>{tr("Worker")}</span>
        {/* 单 Worker（拓扑资源管理嵌入）→ 定显名字，
 不再给只有一个选项的选择器。多 Worker 场景保持下拉。 */}
        {workers.length === 1 ? (
          <antd.Tag style={{ marginInlineEnd: 0, fontSize: 11.5 }}>
            {workers[0].name}
            {workers[0].role === "leader" ? "（Leader）" : ""}
          </antd.Tag>
        ) : (
          <antd.Select
            size="small"
            style={{ width: 220 }}
            value={sel || undefined}
            onChange={(v: string) => {
              setSel(v);
              setReadOnly(false);
            }}
            options={workers.map((w) => ({
              value: w.name,
              label: `${w.name}${w.role === "leader" ? "（Leader）" : ""}`,
            }))}
            placeholder={tr("选择 Worker")}
          />
        )}
        <div style={{ flex: 1 }} />
        <antd.Button size="small" onClick={() => void load()} loading={loading}>
          {tr("刷新")}
        </antd.Button>
      </div>

      {readOnly ? (
        <antd.Alert
          type="warning"
          showIcon
          message={tr("当前角色仅可查看工具设置，不能修改（团队 Leader 只读 / L2 限本团队）")}
        />
      ) : null}

      {loading && tools.length === 0 ? (
        <antd.Spin size="small" style={{ margin: "12px 0" }} />
      ) : grouped.length === 0 ? (
        <antd.Alert type="info" showIcon message={tr("无内置工具")} />
      ) : (
        // 分类折叠卡片：组默认全展开（defaultActiveKey = 全部组）；
        // 卡网格 auto-fill——窄屏单列、宽屏多列，禁横向滚动
        // （min(220px, 100%) 兜住 <220px 容器，名字/徽章换行而非溢出）。
        <antd.Collapse
          ghost
          size="small"
          defaultActiveKey={grouped.map(([g]) => g)}
          items={grouped.map(([g, list]) => ({
            key: g,
            label: (
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>
                {tr(TOOL_GROUP_ZH[g])}
                <span style={{ fontWeight: 400, color: t.textSecondary }}>
                  {" "}
                  ({list.length})
                </span>
              </span>
            ),
            children: (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(min(220px, 100%), 1fr))",
                  gap: 8,
                  paddingBottom: 4,
                }}
              >
                {list.map((tool) => (
                  <ToolCard
                    key={tool.name}
                    tool={tool}
                    group={g}
                    runtime={selRuntime}
                    readOnly={readOnly}
                    busy={busy}
                    onToggle={(toolName, field) => void toggle(toolName, field)}
                  />
                ))}
              </div>
            ),
          }))}
        />
      )}
    </div>
  );
}

export default WorkerTools;
