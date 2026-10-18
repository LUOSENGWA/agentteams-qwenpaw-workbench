/**
 * WorkerEnvPanel.tsx — Worker 环境变量 + 网关探测（消费上游 AgentTeams 1.2.5 #1306）。
 *
 * 契约（上游 v1.2.5 源码实读：agentteams-controller internal/server/
 * worker_env.go / worker_gateway_probe.go / types.go，2026-10-17 对账）：
 * - env 读：GET /workers[/{name}] 回 `env` + `envEditable`。L2 账号被遮蔽
 *   （env=nil、envEditable=false）；旧 Controller 无字段（undefined）——
 *   两者一律不渲染本段（优雅降级，不显空占位）。
 *   ⚠️ 实盘勘误（10/17 实测 v1.2.5）：detail GET 响应实际**不回显 env**
 *   （keys 无 env，写路径 PUT 可用）→ 自定义变量区读到空≠未配置；
 *   「实际生效值」正源 = 本面板「运行时环境」区（容器 PID 1 /proc/1/
 *   environ，插件端点 /workers/{name}/runtime-env，只读 L1）。
 * - env 写：PUT /workers/{name} 带 `env` = **整块替换**（不发该键=不动；
 *   `{}` = 清空全部）。键须匹配 ^[A-Za-z_][A-Za-z0-9_]*$；系统保留键
 *   （AGENTTEAMS_WORKER_CR_NAME / AGENTTEAMS_WORKER_ROLE /
 *   AGENTTEAMS_AUTH_TOKEN / AGENTTEAMS_AUTH_TOKEN_FILE /
 *   AGENTTEAMS_CONTROLLER_URL + 全部系统注入 env）→ 400；L2 → 403。
 * - env 生效语义：spec 变更 → reconciler specHash 失配 → **容器重建**
 *   （worker_controller.go specChanged 路径）——保存后任务可能中断，
 *   UI 二次确认 + 明示。
 * - 网关探测：POST /workers/{name}/gateway-probe {kind: "model"|"mcp",
 *   server?}。服务端只用 CRD 已持久化的模型/MCP 端点 + worker 持久身份
 *   拨号（不接受调用方 URL/token——无提权面）。正常恒 HTTP 200 +
 *   {success, message, latencyMs, consumer, kind}；403 无权限 /
 *   409 worker 未设模型或身份不可用 / 501 provider-specific 探测不支持 /
 *   503 gateway 未配置 = 显式错误码，前端照实呈现。
 * - 零后端新端点：走 /agentteams-proxy/controller catch-all 透传。
 *
 * 纪律：React/antd 取宿主（window.QwenPaw.host）；i18n 全量注册 en 键。
 */
import type * as ReactNS from "react";

import {
  updateWorker,
  probeWorkerGateway,
  fetchWorkerRuntimeEnv,
  httpErrorStatus,
  httpErrorDetail,
  type WorkerInfo,
  type WorkerRuntimeEnv,
} from "../api";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";
import { SettingsIcon } from "./icons";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

/** 键名规则——镜像服务端 workerEnvName（worker_env.go:14）。 */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** 系统保留键——镜像服务端 validateWorkerEnvRequest 拒绝列表
 * （worker_env.go:32-36；另有全系统注入 env 动态集，服务端兜底）。 */
const RESERVED_KEYS = new Set([
  "AGENTTEAMS_WORKER_CR_NAME",
  "AGENTTEAMS_WORKER_ROLE",
  "AGENTTEAMS_AUTH_TOKEN",
  "AGENTTEAMS_AUTH_TOKEN_FILE",
  "AGENTTEAMS_CONTROLLER_URL",
]);

interface EnvRow {
  key: string;
  value: string;
}

const rowsFromEnv = (env?: Record<string, string>): EnvRow[] =>
  env ? Object.entries(env).map(([key, value]) => ({ key, value: String(value) })) : [];

const mapFromRows = (rows: EnvRow[]): Record<string, string> => {
  const m: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (k) m[k] = r.value;
  }
  return m;
};

const sameMap = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (String(a[ka[i]] ?? "") !== String(b[kb[i]] ?? "")) return false;
  }
  return true;
};

function WorkerEnvPanel({
  worker,
  sheet,
  onChanged,
}: {
  worker: WorkerInfo;
  /** 竖屏弹窗模式（NarrowSheet 承载）：去卡片外框 + 头部隐藏收起抓手/
   * 图标/标题（与 WorkerRuntimeConfig sheet 同语义），内容零改动。 */
  sheet?: boolean;
  /** 保存成功后回调（失效 admin 缓存，让列表侧同步刷新）。 */
  onChanged?: () => void;
}) {
  const tr = useT();
  const t = useThemeColors();
  const [open, setOpen] = React.useState(sheet === true);
  /** 本地基准 env——初始=worker.env；空闲时跟随数据源（admin 30s 轮询/
   * onChanged 刷新）；保存后=PUT 读回权威值（admin 缓存有 ≤30s 滞后，
   * 不跟数据源会让 dirty 误挂 + 「重置」回退到保存前旧值）。 */
  const [baseEnv, setBaseEnv] = React.useState<Record<string, string> | undefined>(
    () => worker.env,
  );
  const [rows, setRows] = React.useState<EnvRow[]>(() => rowsFromEnv(worker.env));
  const [newKey, setNewKey] = React.useState("");
  const [newValue, setNewValue] = React.useState("");
  const [addErr, setAddErr] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  // 网关探测（model / mcp 两路各自独立状态）。
  const [probeBusy, setProbeBusy] = React.useState<"" | "model" | "mcp">("");
  const [probeMcpSel, setProbeMcpSel] = React.useState<string>(
    () => worker.mcpServers?.[0]?.name ?? "",
  );
  const [probeRes, setProbeRes] = React.useState<{
    kind: "model" | "mcp";
    ok: boolean;
    text: string;
    sub?: string;
  } | null>(null);

  // 运行时环境（容器 PID 1 实际生效 env，只读；15.27「QwenPaw 运行时
  // 环境变量预填充」正源——Controller detail GET 不回显 spec.env，此处
  // 读容器真实环境）。懒加载：首次展开才拉（有 exec 成本）。
  const [rteOpen, setRteOpen] = React.useState(false);
  const [rte, setRte] = React.useState<WorkerRuntimeEnv | null>(null);
  const [rteLoading, setRteLoading] = React.useState(false);
  const [rteError, setRteError] = React.useState("");
  const [rteReveal, setRteReveal] = React.useState(false);
  const [rteQuery, setRteQuery] = React.useState("");
  const [rteGroup, setRteGroup] = React.useState<
    "all" | "qwenpaw" | "platform" | "other"
  >("all");

  const loadRte = React.useCallback(
    async (reveal: boolean) => {
      setRteLoading(true);
      setRteError("");
      try {
        const d = await fetchWorkerRuntimeEnv(worker.name, reveal);
        setRte(d);
        setRteReveal(d.reveal);
      } catch (e) {
        setRteError(httpErrorDetail(e) || tr("读取运行时环境失败"));
      } finally {
        setRteLoading(false);
      }
    },
    [worker.name, tr],
  );

  // 首次展开 → 懒拉（reveal 默认 false=脱敏）。
  React.useEffect(() => {
    if (rteOpen && !rte && !rteLoading) void loadRte(false);
  }, [rteOpen, rte, rteLoading, loadRte]);

  // 空闲（无本地编辑）时数据源更新 → 跟随 re-baseline（他人改过 env 时
  // 视图同步；有本地编辑时不动，防覆盖未保存输入）。
  React.useEffect(() => {
    const idle = sameMap(mapFromRows(rows), baseEnv ?? {});
    if (idle && !sameMap(baseEnv ?? {}, worker.env ?? {})) {
      setBaseEnv(worker.env);
      setRows(rowsFromEnv(worker.env));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worker.env]);

  const original = baseEnv ?? {};
  const current = React.useMemo(() => mapFromRows(rows), [rows]);
  const dirty = !sameMap(original, current);

  const resetEdits = () => {
    setRows(rowsFromEnv(baseEnv));
    setNewKey("");
    setNewValue("");
    setAddErr("");
    setMsg(null);
  };

  const addRow = () => {
    const k = newKey.trim();
    if (!k) {
      setAddErr(tr("键名不可为空"));
      return;
    }
    if (!ENV_KEY_RE.test(k)) {
      setAddErr(tr("键名须匹配 [A-Za-z_][A-Za-z0-9_]*"));
      return;
    }
    if (RESERVED_KEYS.has(k)) {
      setAddErr(tr("系统保留键，不可编辑：{k}", { k }));
      return;
    }
    if (rows.some((r) => r.key === k)) {
      setAddErr(tr("键名重复：{k}", { k }));
      return;
    }
    setRows((p) => [...p, { key: k, value: newValue }]);
    setNewKey("");
    setNewValue("");
    setAddErr("");
  };

  const save = async () => {
    if (!dirty) return;
    const run = async () => {
      setSaving(true);
      setMsg(null);
      try {
        const resp = (await updateWorker(worker.name, { env: current })) as {
          env?: Record<string, string>;
        } & Record<string, unknown>;
        // 读回（PUT 后的权威值）——服务端已落盘的 env 为准；
        // baseEnv 同步推进（否则 admin 缓存滞后窗口内 dirty 误挂）。
        const saved = resp.env ?? current;
        setBaseEnv(saved);
        setRows(rowsFromEnv(saved));
        setNewKey("");
        setNewValue("");
        setAddErr("");
        setMsg({
          ok: true,
          text: tr("已保存——Worker 容器将重建以应用新环境变量（进行中的任务可能中断）"),
        });
        onChanged?.();
      } catch (e) {
        const st = httpErrorStatus(e);
        setMsg({
          ok: false,
          text:
            st === 403
              ? tr("环境变量需要管理员或 Manager 权限")
              : httpErrorDetail(e) || tr("保存失败"),
        });
      } finally {
        setSaving(false);
      }
    };
    // 清空全部 = 明示二次确认（整块替换语义下这是删除操作）。
    if (Object.keys(original).length > 0 && Object.keys(current).length === 0) {
      antd.Modal.confirm({
        title: tr("清空全部环境变量？"),
        content: tr(
          "保存后该 Worker 的全部自定义环境变量将被清除，容器将重建（进行中的任务可能中断）。",
        ),
        okText: tr("确认清空"),
        cancelText: tr("取消"),
        onOk: () => void run(),
      });
      return;
    }
    void run();
  };

  const probe = async (kind: "model" | "mcp") => {
    const server = kind === "mcp" ? probeMcpSel : undefined;
    if (kind === "mcp" && !server) {
      setProbeRes({ kind, ok: false, text: tr("请先选择要探测的 MCP 端点") });
      return;
    }
    setProbeBusy(kind);
    setProbeRes(null);
    try {
      const r = await probeWorkerGateway(worker.name, kind, server);
      setProbeRes({
        kind: r.kind as "model" | "mcp",
        ok: r.success === true,
        text: r.message || (r.success ? tr("探测成功") : tr("探测失败")),
        sub: tr("{consumer} · {ms} ms", {
          consumer: r.consumer || "—",
          ms: String(r.latencyMs ?? "—"),
        }),
      });
    } catch (e) {
      setProbeRes({
        kind,
        ok: false,
        text: httpErrorDetail(e) || tr("探测失败"),
      });
    } finally {
      setProbeBusy("");
    }
  };

  if (worker.envEditable !== true) return null;

  // 折叠头（与「运行配置」卡片同款视觉家族）。
  if (!open) {
    return (
      <div
        style={{
          margin: sheet ? 0 : "4px 0 4px 22px",
          border: sheet ? "none" : "1px solid rgba(127,127,127,0.25)",
          borderRadius: sheet ? 0 : 8,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 10px",
            cursor: "pointer",
          }}
          onClick={() => setOpen(true)}
        >
          <span style={{ width: 12, fontSize: 10, color: "#888" }}>▸</span>
          <SettingsIcon size={13} />
          <span style={{ fontWeight: 600, fontSize: 12 }}>
            {tr("环境变量与网关探测")}
          </span>
          <antd.Tag style={{ marginInlineEnd: 0, fontSize: 10 }}>
            {Object.keys(original).length}
          </antd.Tag>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        margin: sheet ? 0 : "4px 0 4px 22px",
        border: sheet ? "none" : "1px solid rgba(127,127,127,0.25)",
        borderRadius: sheet ? 0 : 8,
        padding: sheet ? 0 : 10,
        display: "grid",
        gap: 8,
      }}
    >
      {/* gap 6 = 折叠态同款（段头对齐：折叠/展开两态图标 x 不漂移）。 */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {sheet ? null : (
          <span
            style={{ width: 12, fontSize: 10, color: "#888", cursor: "pointer" }}
            onClick={() => setOpen(false)}
            title={tr("收起")}
          >
            ▾
          </span>
        )}
        {sheet ? null : <SettingsIcon size={13} />}
        {sheet ? null : (
          // 段头标题字号恒 12（折叠/展开一致，与运行配置/资源管理段头同款）。
          <span style={{ fontWeight: 600, fontSize: 12 }}>
            {tr("环境变量与网关探测")}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <antd.Button size="small" type="text" onClick={resetEdits} disabled={!dirty}>
          {tr("重置")}
        </antd.Button>
        <antd.Button
          size="small"
          type="primary"
          disabled={!dirty}
          loading={saving}
          onClick={() => void save()}
        >
          {tr("保存")}
        </antd.Button>
      </div>

      {msg ? (
        <antd.Alert
          type={msg.ok ? "success" : "error"}
          showIcon
          message={msg.text}
          closable
          onClose={() => setMsg(null)}
        />
      ) : null}

      {/* env 编辑器 */}
      <div style={{ display: "grid", gap: 6 }}>
        <div style={{ fontSize: 11, color: t.textSecondary }}>
          {tr(
            "自定义环境变量（整块替换语义：删除=从新 map 移除；保存后容器重建生效，进行中的任务可能中断）。系统保留键不可编辑。",
          )}
        </div>
        {rows.length === 0 ? (
          <div style={{ fontSize: 12, color: t.textSecondary }}>
            {tr("当前无自定义环境变量")}
            <div style={{ fontSize: 11 }}>
              {tr(
                "注意：Controller 当前不回显已保存的自定义变量（保存=整块替换写 CRD）——已保存值以下方「运行时环境」为准（容器重建后生效）。",
              )}
            </div>
          </div>
        ) : (
          rows.map((r, i) => (
            <div
              key={`${r.key}-${i}`}
              style={{
                display: "flex",
                gap: 6,
                alignItems: "center",
                border: `1px solid ${t.border}`,
                borderRadius: 6,
                padding: "4px 8px",
              }}
            >
              <span
                style={{
                  fontFamily: "monospace",
                  fontSize: 12,
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                {r.key}
              </span>
              <span
                style={{
                  fontFamily: "monospace",
                  fontSize: 12,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1,
                  minWidth: 0,
                }}
                title={r.value}
              >
                {r.value || tr("（空值）")}
              </span>
              <antd.Button
                size="small"
                type="text"
                danger
                onClick={() => setRows((p) => p.filter((_, j) => j !== i))}
              >
                ×
              </antd.Button>
            </div>
          ))
        )}
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <antd.Input
            size="small"
            style={{ width: 190, fontFamily: "monospace" }}
            placeholder={tr("键名（如 MY_VAR）")}
            value={newKey}
            onChange={(ev: ReactNS.ChangeEvent<HTMLInputElement>) => {
              setNewKey(ev.target.value);
              setAddErr("");
            }}
          />
          <antd.Input
            size="small"
            style={{ flex: 1, minWidth: 120, fontFamily: "monospace" }}
            placeholder={tr("值（可空）")}
            value={newValue}
            onChange={(ev: ReactNS.ChangeEvent<HTMLInputElement>) => {
              setNewValue(ev.target.value);
              setAddErr("");
            }}
            onPressEnter={addRow}
          />
          <antd.Button size="small" onClick={addRow}>
            ＋ {tr("添加")}
          </antd.Button>
        </div>
        {addErr ? (
          <div style={{ fontSize: 11, color: "#cf1322" }}>{addErr}</div>
        ) : null}
      </div>

      {/* 运行时环境（容器 PID 1 实际生效 env，只读；预填充正源）。
          Controller detail GET 不回显 spec.env——自定义区读到空≠未配置，
          实际生效值以此区为准（QwenPaw_* / AGENTTEAMS_* / 镜像内置 + 自定义）。 */}
      <antd.Divider style={{ margin: "4px 0" }}>{tr("运行时环境")}</antd.Divider>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
          cursor: "pointer",
        }}
        onClick={() => setRteOpen((v) => !v)}
      >
        <span style={{ width: 12, fontSize: 10, color: "#888" }}>
          {rteOpen ? "▾" : "▸"}
        </span>
        <span style={{ fontSize: 12, fontWeight: 600 }}>
          {tr("容器实际生效环境变量（只读预填充）")}
        </span>
        {rte ? (
          <antd.Tag style={{ marginInlineEnd: 0, fontSize: 10 }}>
            {rte.count}
          </antd.Tag>
        ) : null}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: t.textSecondary }}>
          {tr("点击展开 / 收起")}
        </span>
      </div>
      {rteOpen ? (
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ fontSize: 11, color: t.textSecondary }}>
            {tr(
              "容器 PID 1 实际生效环境（含 QwenPaw_* / AGENTTEAMS_* / 镜像内置 + 已保存自定义变量）。敏感键默认脱敏；自定义变量保存并容器重建后在此生效。",
            )}
          </div>
          <div
            style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}
          >
            <antd.Input
              size="small"
              style={{ width: 190, fontFamily: "monospace" }}
              placeholder={tr("过滤键名…")}
              value={rteQuery}
              allowClear
              onChange={(ev: ReactNS.ChangeEvent<HTMLInputElement>) =>
                setRteQuery(ev.target.value)}
            />
            <antd.Select
              size="small"
              style={{ width: 130 }}
              value={rteGroup}
              onChange={(v: "all" | "qwenpaw" | "platform" | "other") =>
                setRteGroup(v)}
              options={[
                { value: "all", label: tr("全部") },
                { value: "qwenpaw", label: tr("QwenPaw") },
                { value: "platform", label: tr("平台注入") },
                { value: "other", label: tr("其他") },
              ]}
            />
            <antd.Button
              size="small"
              type="text"
              loading={rteLoading}
              onClick={() => void loadRte(rteReveal)}
            >
              {tr("刷新")}
            </antd.Button>
            {rte && rte.env.some((e) => e.sensitive) ? (
              <antd.Checkbox
                checked={rteReveal}
                onClick={(ev: { stopPropagation: () => void }) =>
                  ev.stopPropagation()}
                onChange={(ev: ReactNS.ChangeEvent<HTMLInputElement>) =>
                  void loadRte(!!ev.target.checked)}
              >
                {tr("显示明文（敏感键）")}
              </antd.Checkbox>
            ) : null}
          </div>
          {rteError ? (
            <antd.Alert type="error" showIcon message={rteError} />
          ) : null}
          {rteLoading && !rte ? (
            <antd.Skeleton active title={false} paragraph={{ rows: 4 }} />
          ) : null}
          {rte && !rteLoading ? (
            <div
              style={{
                display: "grid",
                gap: 3,
                maxHeight: 320,
                overflowY: "auto",
                border: `1px solid ${t.border}`,
                borderRadius: 6,
                padding: 6,
              }}
            >
              {(() => {
                const q = rteQuery.trim().toLowerCase();
                const filtered = rte.env.filter((e) => {
                  if (rteGroup !== "all" && e.group !== rteGroup) return false;
                  if (q && !e.key.toLowerCase().includes(q)) return false;
                  return true;
                });
                if (filtered.length === 0) {
                  return (
                    <div style={{ fontSize: 11, color: t.textSecondary }}>
                      {tr("无匹配项")}
                    </div>
                  );
                }
                return filtered.map((e) => (
                  <div
                    key={e.key}
                    style={{
                      display: "flex",
                      gap: 6,
                      fontFamily: "monospace",
                      fontSize: 11,
                      lineHeight: 1.6,
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 600,
                        flexShrink: 0,
                        maxWidth: "45%",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={e.key}
                    >
                      {e.key}
                    </span>
                    <span style={{ color: t.textSecondary }}>=</span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        color: e.masked ? "#cf1322" : t.text,
                      }}
                      title={e.value}
                    >
                      {e.value === "" ? tr("（空值）") : e.value}
                    </span>
                  </div>
                ));
              })()}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 网关探测 */}
      <antd.Divider style={{ margin: "4px 0" }}>{tr("网关探测")}</antd.Divider>
      <div style={{ fontSize: 11, color: t.textSecondary }}>
        {tr(
          "用该 Worker 已保存的模型/MCP 配置与身份向网关发一次最小请求，验证 Consumer 授权、路由与上游连通。不改动任何配置。",
        )}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <antd.Button
          size="small"
          loading={probeBusy === "model"}
          disabled={!worker.model || (probeBusy !== "" && probeBusy !== "model")}
          onClick={() => void probe("model")}
        >
          {tr("探测模型网关")}
        </antd.Button>
        {worker.model ? null : (
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("（该 Worker 未设置模型）")}
          </span>
        )}
        {worker.mcpServers?.length ? (
          <React.Fragment>
            <antd.Select
              size="small"
              style={{ width: 180 }}
              value={probeMcpSel || undefined}
              placeholder={tr("选择 MCP 端点")}
              onChange={(v: string) => setProbeMcpSel(v)}
              options={worker.mcpServers.map((m) => ({
                value: m.name,
                label: m.name + (m.transport ? ` · ${m.transport}` : ""),
              }))}
            />
            <antd.Button
              size="small"
              loading={probeBusy === "mcp"}
              disabled={probeBusy !== "" && probeBusy !== "mcp"}
              onClick={() => void probe("mcp")}
            >
              {tr("探测 MCP")}
            </antd.Button>
          </React.Fragment>
        ) : (
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("该 Worker 无用户自定义 MCP")}
          </span>
        )}
      </div>
      {probeRes ? (
        <antd.Alert
          type={probeRes.ok ? "success" : "error"}
          showIcon
          message={probeRes.text}
          description={probeRes.sub}
          closable
          onClose={() => setProbeRes(null)}
        />
      ) : null}
    </div>
  );
}

export default WorkerEnvPanel;
