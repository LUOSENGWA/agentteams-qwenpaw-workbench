/**
 * 🔧 内置工具（v0.5.0-beta.13.1，消费上游 #1255，issue #1254）。
 *
 * 位置：「👷 团队管理」tab 内的子节（与频道接入同款，不独立顶层 tab）。
 * 数据面：Controller 内置工具端点（#1255 已合 main）——
 *   GET   /workers/{name}/tools
 *   PATCH /workers/{name}/tools/{tool}（声明式 {enabled}/{asyncExecution}）
 * 走既有通用 Controller 代理（/api/ 白名单，后端零新端点）。
 *
 * 版本门：Controller < 含 #1255 的版本 → 端点 404 → 整节占位说明
 *（与频道接入/L2 冲突检查版本门同模式）。
 * 只读门：PATCH 403（团队 Leader 只读 / L2 跨团队写）→ 整节转只读 + 提示。
 *
 * 纪律：requiresConfig 只做徽章——工具配置值可能含凭据，
 * Controller 代理边界已剔除，前端永不展示配置内容（fail-closed 不放松）。
 */
import { WrenchIcon } from "./icons";
import type * as ReactNS from "react";

import { useT } from "../i18n";
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

function WorkerTools({ workers }: { workers: WorkerInfo[] }) {
  const tr = useT();
  const [sel, setSel] = React.useState("");
  // 版本门：404 = Controller 无工具端点（#1255 未合并 / Controller 未升级）
  // 或 L2 跨团队 W8 防探测隐藏——两者不可区分，占位文案覆盖两种情况。
  const [gate, setGate] = React.useState<"" | "404" | "err">("");
  const [gateMsg, setGateMsg] = React.useState("");
  const [tools, setTools] = React.useState<WorkerToolInfo[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [readOnly, setReadOnly] = React.useState(false);
  const [busy, setBusy] = React.useState<"" | "enabled" | "asyncExecution">("");
  const [msg, setMsg] = React.useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

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

  // v0.5.0-beta.13.16（13.15 装验「点开工具的管理不应该要我再选 worker」）：
  // 单 Worker 场景（拓扑资源管理嵌入 = workers=[w]）自动选中，无需手动选。
  React.useEffect(() => {
    if (!sel && workers.length === 1) setSel(workers[0].name);
  }, [workers, sel]);

  React.useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  const toggle = async (tool: string, field: ToolField) => {
    if (!sel || busy || readOnly) return;
    const current = tools.find((t) => t.name === tool);
    if (!current) return;
    const value = field === "enabled" ? !current.enabled : !(current.asyncExecution ?? false);
    setBusy(field);
    setMsg(null);
    // 乐观更新 + 失败回滚
    setTools((prev) =>
      prev.map((t) => (t.name === tool ? { ...t, [field]: value } : t)),
    );
    try {
      const updated = await patchWorkerTool(sel, tool, { [field]: value });
      if (updated && typeof updated === "object" && "name" in updated) {
        setTools((prev) =>
          prev.map((t) => (t.name === updated.name ? { ...t, ...updated } : t)),
        );
      }
      setMsg({
        kind: "ok",
        text:
          field === "enabled"
            ? tr("{w} 已启用", { w: tool })
            : tr("{w} 已停用", { w: tool }),
      });
    } catch (e) {
      setTools((prev) =>
        prev.map((t) => (t.name === tool ? { ...t, [field]: !value } : t)),
      );
      const st = httpErrorStatus(e);
      if (st === 403) {
        setReadOnly(true);
        setMsg({
          kind: "err",
          text: tr("当前角色仅可查看工具设置，不能修改（Controller 拒绝）"),
        });
      } else {
        setMsg({
          kind: "err",
          text: tr("修改失败：{m}", {
            m: e instanceof Error ? e.message : String(st ?? e),
          }),
        });
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

  const columns = [
    {
      title: tr("工具"),
      dataIndex: "name",
      key: "name",
      render: (_: unknown, t: WorkerToolInfo) => (
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span aria-hidden style={{ display: "inline-flex" }}>{t.icon || <WrenchIcon size={12} />}</span>
          <span style={{ fontFamily: "monospace" }}>{t.name}</span>
          {t.requiresConfig ? (
            <antd.Tag color="orange">{tr("需配置")}</antd.Tag>
          ) : null}
        </span>
      ),
    },
    {
      title: tr("描述"),
      dataIndex: "description",
      key: "description",
      ellipsis: true,
      render: (v?: string) => v ?? "-",
    },
    {
      title: tr("启用"),
      dataIndex: "enabled",
      key: "enabled",
      width: 80,
      render: (_: unknown, t: WorkerToolInfo) => (
        <antd.Switch
          size="small"
          checked={t.enabled}
          disabled={readOnly || busy !== ""}
          onChange={() => void toggle(t.name, "enabled")}
        />
      ),
    },
    {
      title: tr("异步执行"),
      dataIndex: "asyncExecution",
      key: "asyncExecution",
      width: 90,
      render: (_: unknown, t: WorkerToolInfo) => (
        <antd.Switch
          size="small"
          checked={t.asyncExecution ?? false}
          disabled={readOnly || busy !== ""}
          onChange={() => void toggle(t.name, "asyncExecution")}
        />
      ),
    },
  ];

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600 }}>{tr("Worker")}</span>
        {/* v0.5.0-beta.13.16：单 Worker（拓扑资源管理嵌入）→ 定显名字，
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
              setMsg(null);
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

      {msg ? (
        <antd.Alert
          type={msg.kind === "ok" ? "success" : "error"}
          showIcon
          closable
          message={msg.text}
          onClose={() => setMsg(null)}
        />
      ) : null}

      <antd.Table
        rowKey="name"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={tools}
        pagination={false}
      />
    </div>
  );
}

export default WorkerTools;
