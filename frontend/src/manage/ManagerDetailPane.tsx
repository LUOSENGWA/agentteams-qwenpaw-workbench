/**
 * ManagerDetailPane.tsx — 管理页 · Manager 详情面板（mid 栏 / 竖屏 L2）。
 *
 * 和 WorkerDetailPane 平级但调 Manager API（GET/PUT /managers/{name}）。
 *
 * 任务 A 完整配置面板——每卡独立保存（PUT 合并语义：只发被改字段）：
 * - 状态卡：唤醒 / 休眠状态操作（PUT {state}——Controller 对 Manager 无
 *   wake/sleep 端点，desired-state 语义：Running / Sleeping）
 * - 模型配置：ModelEditModal 弹窗（响应式，与 Worker 详情面板共用）
 * - SOUL.md / AGENTS.md：全屏 Modal + 等宽 textarea（min-height 300px）
 * - Skills（Select tags）/ MCP Servers（行编辑）/ Env（key-value 行）
 * - Manager 独有 Config：心跳间隔 / Worker 空闲超时 / 通知频道
 *
 * 数据：列表视图 ManagerResponse 不带 spec 字段（Controller 只映射标量列）
 * → 挂载时 fetchManagerFull 取完整 spec；旧 Controller 不返回 → 各卡诚实
 * 降级显"未配置"。编辑门控 L1-only（hasToken；L2 只读摘要）。
 */
import type * as ReactNS from "react";

import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import {
  fetchManagerFull,
  updateManager,
  updateManagerModel,
  type ManagerInfo,
  type McpServerInfo,
} from "../api";
import {
  providerForModel,
  useModelUnionOptions,
  validateModelValue,
  modelVerdictText,
} from "../modelUnion";
import {
  RUNTIME_LABELS,
  WakeIcon,
  SleepIcon,
  phaseMeta,
} from "../components/WorkerManageShared";
import {
  BoltIcon,
  BoxIcon,
  BrainIcon,
  BulbIcon,
  CodeIcon,
  PlugIcon,
  WrenchIcon,
} from "../components/icons";
import ModelEditModal from "./ModelEditModal";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;
const antdIcons = (host.antdIcons || {}) as Record<string, ReactNS.ComponentType<any> | undefined>;
const PlusIcon = antdIcons.PlusOutlined ?? null;
const CloseIcon = antdIcons.CloseOutlined ?? null;
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** 配置摘要卡（图标 + 标题 + 只读摘要；L1 可点击进编辑）。 */
function ConfigCard({
  icon,
  title,
  summary,
  clickable,
  onClick,
}: {
  icon: ReactNS.ReactNode;
  title: string;
  summary: ReactNS.ReactNode;
  clickable: boolean;
  onClick?: () => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  return (
    <div
      style={{
        padding: "10px 14px",
        borderRadius: 8,
        background: t.cardBg,
        border: `1px solid ${t.border}`,
        cursor: clickable ? "pointer" : "default",
        transition: "border 0.2s",
      }}
      onClick={clickable ? onClick : undefined}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ display: "inline-flex", color: t.textSecondary, flexShrink: 0 }}>{icon}</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: t.text }}>{title}</span>
        <div style={{ flex: 1 }} />
        {clickable ? (
          <span style={{ fontSize: 10, color: t.textSecondary }}>{tr("点击编辑")}</span>
        ) : null}
      </div>
      <div
        style={{
          marginTop: 6,
          fontSize: 11,
          color: t.textSecondary,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {summary}
      </div>
    </div>
  );
}

/** 状态卡行（标签 72px 定宽 + 值）。 */
function Row({ label, value }: { label: string; value: ReactNS.ReactNode }) {
  const t = useThemeColors();
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, minHeight: 20 }}>
      <span style={{ width: 72, flexShrink: 0, fontSize: 11, color: t.textSecondary }}>{label}</span>
      <span
        style={{
          flex: 1,
          fontSize: 12,
          color: t.text,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {value}
      </span>
    </div>
  );
}

/** Config 单字段（label + 说明 + 等宽输入）。 */
function CfgField({
  label,
  hint,
  placeholder,
  value,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  placeholder: string;
  value: string;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  const t = useThemeColors();
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 500, color: t.text, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 10, color: t.textSecondary, marginBottom: 6, lineHeight: 1.5 }}>{hint}</div>
      <antd.Input
        size="small"
        style={{ width: "100%", fontFamily: MONO }}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      />
    </div>
  );
}

export default function ManagerDetailPane({
  manager,
  hasToken,
  onRefreshAdmin,
}: {
  manager: ManagerInfo;
  /** L1 门控：编辑入口需 Controller 管理员 token（L2 只读摘要）。 */
  hasToken?: boolean;
  onRefreshAdmin?: (silent?: boolean, strong?: boolean) => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  const l1 = !!hasToken;
  const isNarrow = typeof window !== "undefined" && window.innerWidth < 640;
  const pm = phaseMeta(manager.phase);
  const sleeping = manager.state === "Sleeping" || manager.state === "Stopped";

  // ── 完整 spec（列表视图无字段 → 挂载取；失败/旧版 → 诚实降级）──
  const [full, setFull] = React.useState<ManagerInfo | null>(null);
  const [fullLoading, setFullLoading] = React.useState(false);
  const loadFull = React.useCallback(() => {
    let alive = true;
    setFullLoading(true);
    fetchManagerFull(manager.name)
      .then((d) => {
        if (alive) setFull(d && d.name ? d : null);
      })
      .catch(() => {
        if (alive) setFull(null);
      })
      .finally(() => {
        if (alive) setFullLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [manager.name]);
  React.useEffect(loadFull, [loadFull]);

  // ── 模型配置弹窗（共享 ModelEditModal，与 Worker 详情面板同源）──
  const union = useModelUnionOptions([manager.model ?? ""], tr);
  const baselineProv =
    manager.modelProvider ||
    providerForModel(union.gatewayOptions, manager.model || "");
  const [modelModal, setModelModal] = React.useState(false);
  const [modelSaving, setModelSaving] = React.useState(false);
  const handleModelSave = React.useCallback(
    async (m: string, p: string, subIn: string | null): Promise<boolean> => {
      const v = validateModelValue(m, union.candidates);
      if (v.level === "error") {
        antd.message.error(modelVerdictText(tr, v, m, union.candidates));
        return false;
      }
      setModelSaving(true);
      try {
        await updateManagerModel(manager.name, m, p || undefined, subIn);
        antd.message.success(
          v.level === "warn"
            ? tr("已保存（提示：{t}）", {
                t: modelVerdictText(tr, v, m, union.candidates),
              })
            : tr("已保存"),
        );
        void onRefreshAdmin?.(true);
        loadFull();
        return true;
      } catch (e) {
        antd.message.error(e instanceof Error ? e.message : tr("保存失败"));
        return false;
      } finally {
        setModelSaving(false);
      }
    },
    [manager.name, union.candidates, onRefreshAdmin, tr, loadFull],
  );

  // ── 状态操作（唤醒/休眠：PUT {state} desired-state 语义）──
  const [acting, setActing] = React.useState<"wake" | "sleep" | null>(null);
  const handleState = React.useCallback(
    async (target: "Running" | "Sleeping") => {
      setActing(target === "Running" ? "wake" : "sleep");
      try {
        await updateManager(manager.name, { state: target });
        antd.message.success(
          target === "Running" ? tr("已发送唤醒指令") : tr("已发送休眠指令"),
        );
        void onRefreshAdmin?.(true);
        loadFull();
      } catch (e) {
        antd.message.error(e instanceof Error ? e.message : tr("操作失败"));
      } finally {
        setActing(null);
      }
    },
    [manager.name, onRefreshAdmin, tr, loadFull],
  );

  // ── SOUL.md / AGENTS.md（全屏等宽编辑）──
  const [docKind, setDocKind] = React.useState<null | "soul" | "agents">(null);
  const [docDraft, setDocDraft] = React.useState("");
  const [docSaving, setDocSaving] = React.useState(false);
  const openDoc = (kind: "soul" | "agents") => {
    setDocDraft(kind === "soul" ? full?.soul ?? "" : full?.agents ?? "");
    setDocKind(kind);
  };
  const saveDoc = React.useCallback(async (): Promise<boolean> => {
    if (!docKind) return false;
    const base = docKind === "soul" ? full?.soul ?? "" : full?.agents ?? "";
    // Controller 仅非空才应用（UpdateManager：req.Soul != "" 才写）——
    // 空内容无法 clear 既有值，拦下避免"已保存但没变"错觉。
    if (docDraft.trim() === "" && base.trim() !== "") {
      antd.message.warning(tr("空内容无法清除既有值（Controller 仅应用非空值），已保留原值"));
      return false;
    }
    setDocSaving(true);
    try {
      await updateManager(manager.name, { [docKind]: docDraft });
      antd.message.success(tr("已保存"));
      setDocKind(null);
      void onRefreshAdmin?.(true);
      loadFull();
      return true;
    } catch (e) {
      antd.message.error(e instanceof Error ? e.message : tr("保存失败"));
      return false;
    } finally {
      setDocSaving(false);
    }
  }, [docKind, docDraft, full, manager.name, onRefreshAdmin, tr, loadFull]);

  // ── Skills（tags 自由输入）──
  const [skillsModal, setSkillsModal] = React.useState(false);
  const [skillsDraft, setSkillsDraft] = React.useState<string[]>([]);
  const [skillsSaving, setSkillsSaving] = React.useState(false);
  const openSkills = () => {
    setSkillsDraft(full?.skills ? [...full.skills] : []);
    setSkillsModal(true);
  };
  const saveSkills = React.useCallback(async (): Promise<boolean> => {
    setSkillsSaving(true);
    try {
      const list = skillsDraft.map((s) => s.trim()).filter(Boolean);
      await updateManager(manager.name, { skills: list });
      antd.message.success(tr("已保存"));
      setSkillsModal(false);
      void onRefreshAdmin?.(true);
      loadFull();
      return true;
    } catch (e) {
      antd.message.error(e instanceof Error ? e.message : tr("保存失败"));
      return false;
    } finally {
      setSkillsSaving(false);
    }
  }, [manager.name, skillsDraft, onRefreshAdmin, tr, loadFull]);

  // ── MCP Servers（行编辑：name/url/transport）──
  const [mcpModal, setMcpModal] = React.useState(false);
  const [mcpDraft, setMcpDraft] = React.useState<McpServerInfo[]>([]);
  const [mcpSaving, setMcpSaving] = React.useState(false);
  const openMcp = () => {
    setMcpDraft(full?.mcpServers ? full.mcpServers.map((s) => ({ ...s })) : []);
    setMcpModal(true);
  };
  const setMcpRow = (i: number, patch: Partial<McpServerInfo>) =>
    setMcpDraft((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const saveMcp = React.useCallback(async (): Promise<boolean> => {
    // 半空行拦截：name/url 只填了一个（两个都空 = 整行未填，保存时丢弃）。
    const incomplete = mcpDraft.some((s) => (s.name.trim() !== "") !== (s.url.trim() !== ""));
    if (incomplete) {
      antd.message.error(tr("存在未完成行（name 与 url 必填）"));
      return false;
    }
    setMcpSaving(true);
    try {
      // 整表替换语义：空表 = 清空全部。
      const servers: McpServerInfo[] = mcpDraft
        .filter((s) => s.name.trim() && s.url.trim())
        .map((s) => {
          const o: McpServerInfo = { name: s.name.trim(), url: s.url.trim() };
          if (s.transport && s.transport.trim()) o.transport = s.transport.trim();
          return o;
        });
      await updateManager(manager.name, { mcpServers: servers });
      antd.message.success(tr("已保存"));
      setMcpModal(false);
      void onRefreshAdmin?.(true);
      loadFull();
      return true;
    } catch (e) {
      antd.message.error(e instanceof Error ? e.message : tr("保存失败"));
      return false;
    } finally {
      setMcpSaving(false);
    }
  }, [manager.name, mcpDraft, onRefreshAdmin, tr, loadFull]);

  // ── Env（key-value 行）──
  const [envModal, setEnvModal] = React.useState(false);
  const [envDraft, setEnvDraft] = React.useState<{ key: string; value: string }[]>([]);
  const [envSaving, setEnvSaving] = React.useState(false);
  const openEnv = () => {
    const entries = full?.env ? Object.entries(full.env) : [];
    setEnvDraft(entries.map(([key, value]) => ({ key, value })));
    setEnvModal(true);
  };
  const setEnvRow = (i: number, patch: Partial<{ key: string; value: string }>) =>
    setEnvDraft((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const saveEnv = React.useCallback(async (): Promise<boolean> => {
    const incomplete = envDraft.some((r) => r.key.trim() === "" && r.value.trim() !== "");
    if (incomplete) {
      antd.message.error(tr("存在未完成行（key 必填）"));
      return false;
    }
    setEnvSaving(true);
    try {
      // 整表替换语义：空表 = 清空全部。
      // 注：当前 UpdateManagerRequest 无 env 字段（旧 Controller 静默忽略）——
      // controller 补齐后自动生效（crd.ts updateManager 注释）。
      const env: Record<string, string> = {};
      for (const r of envDraft) {
        const k = r.key.trim();
        if (k) env[k] = r.value;
      }
      await updateManager(manager.name, { env });
      antd.message.success(tr("已保存"));
      setEnvModal(false);
      void onRefreshAdmin?.(true);
      loadFull();
      return true;
    } catch (e) {
      antd.message.error(e instanceof Error ? e.message : tr("保存失败"));
      return false;
    } finally {
      setEnvSaving(false);
    }
  }, [manager.name, envDraft, onRefreshAdmin, tr, loadFull]);

  // ── Manager 独有 Config（整对象替换；空值 = 回退默认）──
  const cfgBase = {
    heartbeatInterval: full?.config?.heartbeatInterval ?? "",
    workerIdleTimeout: full?.config?.workerIdleTimeout ?? "",
    notifyChannel: full?.config?.notifyChannel ?? "",
  };
  const [cfg, setCfg] = React.useState(cfgBase);
  React.useEffect(() => {
    setCfg(cfgBase);
    // cfgBase 随 full 派生——full/name 变化时重置草稿到当前值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full, manager.name]);
  const cfgDirty =
    cfg.heartbeatInterval !== cfgBase.heartbeatInterval ||
    cfg.workerIdleTimeout !== cfgBase.workerIdleTimeout ||
    cfg.notifyChannel !== cfgBase.notifyChannel;
  const [cfgSaving, setCfgSaving] = React.useState(false);
  const saveCfg = React.useCallback(async () => {
    setCfgSaving(true);
    try {
      await updateManager(manager.name, {
        config: {
          heartbeatInterval: cfg.heartbeatInterval.trim(),
          workerIdleTimeout: cfg.workerIdleTimeout.trim(),
          notifyChannel: cfg.notifyChannel.trim(),
        },
      });
      antd.message.success(tr("已保存"));
      void onRefreshAdmin?.(true);
      loadFull();
    } catch (e) {
      antd.message.error(e instanceof Error ? e.message : tr("保存失败"));
    } finally {
      setCfgSaving(false);
    }
  }, [manager.name, cfg, onRefreshAdmin, tr, loadFull]);

  // 切 manager 不复用旧 spec / 草稿 / 弹窗态（置于此=所有 state 已声明）。
  React.useEffect(() => {
    setFull(null);
    setModelModal(false);
    setDocKind(null);
    setDocDraft("");
    setSkillsModal(false);
    setMcpModal(false);
    setEnvModal(false);
  }, [manager.name]);

  // ── 摘要派生（full 未就绪/旧版无字段 → 诚实降级）──
  const loadingText = fullLoading ? tr("加载中…") : tr("未配置");
  const soulSummary = full?.soul ? tr("{n} 字符", { n: full.soul.length }) : loadingText;
  const agentsSummary = full?.agents ? tr("{n} 字符", { n: full.agents.length }) : loadingText;
  const skillsSummary = full?.skills?.length
    ? full.skills.slice(0, 4).join(", ") +
      (full.skills.length > 4 ? ` +${full.skills.length - 4}` : "")
    : loadingText;
  const mcpSummary = full?.mcpServers?.length
    ? full.mcpServers.map((s) => s.name).join(", ")
    : loadingText;
  const envKeys = full?.env ? Object.keys(full.env) : [];
  const envSummary = envKeys.length ? tr("{n} 项", { n: envKeys.length }) : loadingText;

  return (
    <div style={{ display: "grid", gap: 12, padding: 12 }}>
      {/* 头部 */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 8,
            background: "linear-gradient(135deg, #722ed1, #9254de)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            fontWeight: 700,
            fontSize: 18,
            flexShrink: 0,
          }}
        >
          {"M"}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                fontSize: 16,
                fontWeight: 700,
                color: t.text,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {manager.name}
            </span>
            <antd.Tag color="purple" style={{ margin: 0, fontSize: 10, lineHeight: "18px" }}>
              {tr("Manager")}
            </antd.Tag>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: t.textSecondary }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background:
                  manager.state === "Running" ? "#52c41a" : manager.state === "Sleeping" ? "#faad14" : "#999",
                display: "inline-block",
              }}
            />
            <span>{manager.state || "—"}</span>
            <span>·</span>
            <span>{RUNTIME_LABELS[manager.runtime ?? ""] ?? manager.runtime ?? "qwenpaw"}</span>
          </div>
        </div>
      </div>

      {!l1 ? (
        <antd.Alert
          type="warning"
          showIcon
          message={tr("编辑 Manager 配置需 L1 管理权限（Controller 管理员 token）")}
          style={{ borderRadius: 8 }}
        />
      ) : null}

      {/* 状态卡（含唤醒/休眠操作，L1-only） */}
      <div
        style={{
          display: "grid",
          gap: 6,
          padding: "10px 14px",
          borderRadius: 8,
          background: t.cardBg,
          border: `1px solid ${t.border}`,
        }}
      >
        <Row label={tr("Phase")} value={<span style={{ color: pm.color, fontWeight: 600 }}>{pm.label}</span>} />
        <Row label={tr("State")} value={manager.state || "—"} />
        <Row
          label={tr("Runtime")}
          value={RUNTIME_LABELS[manager.runtime ?? ""] ?? manager.runtime ?? "qwenpaw"}
        />
        {manager.image && (
          <Row
            label={tr("Image")}
            value={
              <code style={{ fontSize: 10, wordBreak: "break-all" }}>
                {manager.image.split("/").pop()?.split(":").pop() ?? manager.image}
              </code>
            }
          />
        )}
        {manager.matrixUserID && (
          <Row label="Matrix" value={<code style={{ fontSize: 10 }}>{manager.matrixUserID}</code>} />
        )}
        <Row label={tr("Version")} value={manager.version || "—"} />
        {l1 ? (
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            {sleeping ? (
              <antd.Button
                size="large"
                type="primary"
                icon={<WakeIcon />}
                loading={acting === "wake"}
                disabled={acting != null}
                style={{ minHeight: 44 }}
                onClick={() => void handleState("Running")}
              >
                {tr("唤醒")}
              </antd.Button>
            ) : (
              <antd.Button
                size="large"
                icon={<SleepIcon />}
                loading={acting === "sleep"}
                disabled={acting != null}
                style={{ minHeight: 44 }}
                onClick={() => void handleState("Sleeping")}
              >
                {tr("休眠")}
              </antd.Button>
            )}
          </div>
        ) : null}
      </div>

      {/* 模型配置（弹窗编辑，与 Worker 详情面板共用 ModelEditModal） */}
      <ConfigCard
        icon={<BulbIcon size={14} />}
        title={tr("模型配置")}
        summary={
          <>
            {manager.model || tr("未配置")}
            {manager.modelProvider ? ` · ${manager.modelProvider}` : ""}
          </>
        }
        clickable={l1}
        onClick={() => setModelModal(true)}
      />

      {/* SOUL.md（全屏等宽编辑） */}
      <ConfigCard
        icon={<BrainIcon size={14} />}
        title="SOUL.md"
        summary={soulSummary}
        clickable={l1}
        onClick={() => openDoc("soul")}
      />

      {/* AGENTS.md（全屏等宽编辑） */}
      <ConfigCard
        icon={<CodeIcon size={14} />}
        title="AGENTS.md"
        summary={agentsSummary}
        clickable={l1}
        onClick={() => openDoc("agents")}
      />

      {/* Skills */}
      <ConfigCard
        icon={<BoltIcon size={14} />}
        title="Skills"
        summary={skillsSummary}
        clickable={l1}
        onClick={openSkills}
      />

      {/* MCP Servers */}
      <ConfigCard
        icon={<PlugIcon size={14} />}
        title="MCP Servers"
        summary={mcpSummary}
        clickable={l1}
        onClick={openMcp}
      />

      {/* Env */}
      <ConfigCard
        icon={<BoxIcon size={14} />}
        title="Env"
        summary={envSummary}
        clickable={l1}
        onClick={openEnv}
      />

      {/* Manager 独有 Config（内联编辑：心跳 / 空闲超时 / 通知频道） */}
      <div style={{ padding: "10px 14px", borderRadius: 8, background: t.cardBg, border: `1px solid ${t.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <WrenchIcon size={14} style={{ color: t.textSecondary, flexShrink: 0 }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: t.text }}>{tr("Manager 配置")}</span>
        </div>
        <div
          style={{
            marginTop: 10,
            display: "grid",
            gap: 12,
            gridTemplateColumns: isNarrow ? "1fr" : "repeat(3, minmax(0, 1fr))",
          }}
        >
          <CfgField
            label={tr("心跳间隔")}
            hint={tr("Manager 向团队房间心跳的间隔；留空=默认 15m")}
            placeholder="15m"
            value={cfg.heartbeatInterval}
            disabled={!l1 || cfgSaving}
            onChange={(v) => setCfg((c) => ({ ...c, heartbeatInterval: v }))}
          />
          <CfgField
            label={tr("Worker 空闲超时")}
            hint={tr("空闲 Worker 超过该时长后回收；留空=默认 720m")}
            placeholder="720m"
            value={cfg.workerIdleTimeout}
            disabled={!l1 || cfgSaving}
            onChange={(v) => setCfg((c) => ({ ...c, workerIdleTimeout: v }))}
          />
          <CfgField
            label={tr("通知频道")}
            hint={tr("决策/通知投递频道；留空=默认 admin-dm")}
            placeholder="admin-dm"
            value={cfg.notifyChannel}
            disabled={!l1 || cfgSaving}
            onChange={(v) => setCfg((c) => ({ ...c, notifyChannel: v }))}
          />
        </div>
        {l1 ? (
          <antd.Button
            type="primary"
            size="small"
            loading={cfgSaving}
            disabled={!cfgDirty}
            style={{ marginTop: 12 }}
            onClick={() => void saveCfg()}
          >
            {tr("保存")}
          </antd.Button>
        ) : null}
      </div>

      {/* ── 模型编辑弹窗（共享组件：响应式 + 同源候选）── */}
      <ModelEditModal
        open={modelModal}
        title={tr("Manager 模型配置")}
        currentModel={manager.model ?? ""}
        currentProvider={baselineProv}
        runtime={manager.runtime}
        currentSubagentModel={(manager as any).subagentModel ?? ""}
        union={union}
        saving={modelSaving}
        onCancel={() => setModelModal(false)}
        onSave={handleModelSave}
      />

      {/* SOUL.md / AGENTS.md 全屏编辑弹窗 */}
      <antd.Modal
        title={docKind === "agents" ? tr("编辑 AGENTS.md") : tr("编辑 SOUL.md")}
        open={docKind !== null}
        onCancel={() => setDocKind(null)}
        onOk={saveDoc}
        okText={tr("保存")}
        cancelText={tr("取消")}
        confirmLoading={docSaving}
        width="100vw"
        style={{ top: 0, maxWidth: "100vw", padding: 0 }}
        styles={{ body: { height: "calc(100vh - 110px)", padding: 16, display: "flex" } }}
        destroyOnClose
      >
        <antd.Input.TextArea
          value={docDraft}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDocDraft(e.target.value)}
          autoSize={false}
          placeholder={
            docKind === "agents"
              ? tr("AGENTS.md 内容（操作规则 / 纪律）")
              : tr("SOUL.md 内容（人格 / 身份定义）")
          }
          style={{
            flex: 1,
            height: "100%",
            minHeight: 300,
            fontFamily: MONO,
            fontSize: 12,
            lineHeight: 1.7,
            resize: "none",
          }}
        />
      </antd.Modal>

      {/* Skills 弹窗（tags 自由输入） */}
      <antd.Modal
        title={tr("Skills 配置")}
        open={skillsModal}
        onCancel={() => setSkillsModal(false)}
        onOk={saveSkills}
        okText={tr("保存")}
        cancelText={tr("取消")}
        confirmLoading={skillsSaving}
        width={Math.min(560, window.innerWidth - 48)}
        destroyOnClose
      >
        <div style={{ display: "grid", gap: 10, padding: "8px 0" }}>
          <div style={{ fontSize: 11, color: t.textSecondary, lineHeight: 1.6 }}>
            {tr("输入技能名后回车添加；已有条目可点标签 × 移除。")}
          </div>
          <antd.Select
            mode="tags"
            style={{ width: "100%" }}
            size="large"
            value={skillsDraft}
            onChange={(v: string[]) => setSkillsDraft(v)}
            placeholder={tr("输入技能名后回车（如 nacos://team/skills 或本地技能名）")}
          />
        </div>
      </antd.Modal>

      {/* MCP Servers 弹窗（行编辑） */}
      <antd.Modal
        title={tr("MCP Servers 配置")}
        open={mcpModal}
        onCancel={() => setMcpModal(false)}
        onOk={saveMcp}
        okText={tr("保存")}
        cancelText={tr("取消")}
        confirmLoading={mcpSaving}
        width={Math.min(680, window.innerWidth - 48)}
        destroyOnClose
      >
        <div style={{ display: "grid", gap: 10, padding: "8px 0" }}>
          <div style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("每行一个 MCP server；保存为整表替换（清空全部=保存空表）。")}
          </div>
          {mcpDraft.length === 0 ? (
            <div style={{ fontSize: 11, color: t.textSecondary }}>{tr("暂无 MCP server。")}</div>
          ) : null}
          {mcpDraft.map((s, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <antd.Input
                size="small"
                style={{ width: 130, flexShrink: 0 }}
                placeholder="name"
                value={s.name}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMcpRow(i, { name: e.target.value })}
              />
              <antd.Input
                size="small"
                style={{ flex: 1, minWidth: 120, fontFamily: MONO, fontSize: 11 }}
                placeholder="http://host/mcp"
                value={s.url}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMcpRow(i, { url: e.target.value })}
              />
              <antd.Input
                size="small"
                style={{ width: 110, flexShrink: 0, fontFamily: MONO, fontSize: 11 }}
                placeholder={tr("transport（可选）")}
                value={s.transport ?? ""}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMcpRow(i, { transport: e.target.value })}
              />
              <antd.Button
                size="small"
                type="text"
                danger
                aria-label={tr("删除")}
                icon={CloseIcon ? <CloseIcon /> : undefined}
                onClick={() => setMcpDraft((rows) => rows.filter((_, j) => j !== i))}
              />
            </div>
          ))}
          <antd.Button
            size="small"
            dashed
            icon={PlusIcon ? <PlusIcon /> : undefined}
            onClick={() => setMcpDraft((rows) => [...rows, { name: "", url: "" }])}
          >
            {tr("添加")}
          </antd.Button>
        </div>
      </antd.Modal>

      {/* Env 弹窗（key-value 行编辑） */}
      <antd.Modal
        title={tr("Env 配置")}
        open={envModal}
        onCancel={() => setEnvModal(false)}
        onOk={saveEnv}
        okText={tr("保存")}
        cancelText={tr("取消")}
        confirmLoading={envSaving}
        width={Math.min(680, window.innerWidth - 48)}
        destroyOnClose
      >
        <div style={{ display: "grid", gap: 10, padding: "8px 0" }}>
          <div style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("每行一个环境变量；保存为整表替换（清空全部=保存空表）。")}
          </div>
          {envDraft.length === 0 ? (
            <div style={{ fontSize: 11, color: t.textSecondary }}>{tr("暂无环境变量。")}</div>
          ) : null}
          {envDraft.map((r, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <antd.Input
                size="small"
                style={{ width: 150, flexShrink: 0, fontFamily: MONO, fontSize: 11 }}
                placeholder="KEY"
                value={r.key}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEnvRow(i, { key: e.target.value })}
              />
              <antd.Input
                size="small"
                style={{ flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 11 }}
                placeholder="value"
                value={r.value}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEnvRow(i, { value: e.target.value })}
              />
              <antd.Button
                size="small"
                type="text"
                danger
                aria-label={tr("删除")}
                icon={CloseIcon ? <CloseIcon /> : undefined}
                onClick={() => setEnvDraft((rows) => rows.filter((_, j) => j !== i))}
              />
            </div>
          ))}
          <antd.Button
            size="small"
            dashed
            icon={PlusIcon ? <PlusIcon /> : undefined}
            onClick={() => setEnvDraft((rows) => [...rows, { key: "", value: "" }])}
          >
            {tr("添加")}
          </antd.Button>
        </div>
      </antd.Modal>
    </div>
  );
}
