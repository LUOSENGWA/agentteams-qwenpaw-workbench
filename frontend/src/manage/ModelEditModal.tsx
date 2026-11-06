/**
 * ModelEditModal.tsx — 管理页 · 模型配置编辑弹窗（Manager/Worker 详情面板共用）。
 *
 * 子代理模型（QwenPaw >= 2.1.1 专用）：
 * - 开关"与主模型相同"= ON → subagent model 同步主模型 + 选择器 disabled；
 * - OFF → 独立 Model 选择器（同源列表，可选不同后端模型）。
 */
import type * as ReactNS from "react";

import {
  getCliSettings,
  listCodingCli,
  objectModel,
  putCliSettings,
} from "../api/domains/codingcli";
import type {
  CliSettingsResponse,
  CodingCliId,
  CodingCliProbeItem,
  SettingsObject,
} from "../api/domains/codingcli";
import {
  buildCliModelPatch,
  cliCurrentModel,
  cliModelEntries,
} from "../lib/codingCliModel";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import {
  filterModelOptionsByProvider,
  providerForModel,
  providerModelMismatch,
  useModelUnionOptions,
} from "../modelUnion";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

type UnionState = ReturnType<typeof useModelUnionOptions>;

export interface ModelEditModalProps {
  open: boolean;
  title: string;
  currentModel: string;
  currentProvider: string;
  /** runtime = qwenpaw 时显示子代理模型区。 */
  runtime?: string;
  /** 当前已保存子代理模型（""=未设/与主模型相同）。 */
  currentSubagentModel?: string;
  union: UnionState;
  saving: boolean;
  /** Worker 名（仅 Worker 详情面板传）→ 渲染「CodingCLI 模型」区块；Manager 不传=不渲染。 */
  workerName?: string;
  /** L1（有 controller token）——Coding CLI 数据面仅 L1 可用。 */
  l1?: boolean;
  onCancel: () => void;
  onSave: (model: string, provider: string, subagentModel: string | null) => Promise<boolean>;
}

export default function ModelEditModal({
  open,
  title,
  currentModel,
  currentProvider,
  runtime,
  currentSubagentModel = "",
  union,
  saving,
  workerName,
  l1,
  onCancel,
  onSave,
}: ModelEditModalProps) {
  const t = useThemeColors();
  const tr = useT();
  const [model, setModel] = React.useState("");
  const [provider, setProvider] = React.useState("");
  const [subagentSame, setSubagentSame] = React.useState(true);
  const [subagentModel, setSubagentModel] = React.useState("");

  const showSubagent = runtime === "qwenpaw";

  React.useEffect(() => {
    if (open) {
      setModel(currentModel);
      setProvider(currentProvider);
      if (!currentSubagentModel) {
        setSubagentSame(true);
        setSubagentModel("");
      } else {
        setSubagentSame(false);
        setSubagentModel(currentSubagentModel);
      }
    }
  }, [open, currentModel, currentProvider, currentSubagentModel]);

  // 开关 ON → 同步主模型值
  React.useEffect(() => {
    if (subagentSame) setSubagentModel(model);
  }, [subagentSame, model]);

  React.useEffect(() => {
    if (open) union.refetchSglang();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const isNarrow = typeof window !== "undefined" && window.innerWidth < 640;
  const fieldsLayout = { display: "grid", gap: 14 } as const;
  const fieldStyle = { width: "100%" } as const;
  const labelStyle = {
    fontSize: isNarrow ? 12 : 14,
    color: t.textSecondary,
    marginBottom: 6,
  };

  const subagentEffective = subagentSame ? "" : subagentModel;
  const dirty =
    model !== currentModel ||
    provider !== currentProvider ||
    subagentEffective !== currentSubagentModel;

  const handleOk = async () => {
    // subagentSame=true → ""（显式清除覆盖=回到主模型）
    // subagentSame=false → 选中的模型名（或 null 保持）
    // 非 qwenpaw → null（不传=不影响）
    const sub = showSubagent ? (subagentSame ? "" : (subagentModel || null)) : null;
    await onSave(model, provider, sub);
  };

  return (
    <antd.Modal
      title={title}
      open={open}
      onCancel={onCancel}
      onOk={handleOk}
      okText={tr("保存")}
      cancelText={tr("取消")}
      confirmLoading={saving}
      okButtonProps={{ disabled: !dirty }}
      width={Math.min(560, window.innerWidth - 48)}
      destroyOnClose
    >
      <div style={{ display: "grid", gap: 14, padding: "8px 0" }}>
        {/* C1a-1 provider-first：先选 Provider 再选模型——目录方向恒
         * provider → models，且实际转发由 Provider 决定（仅模型 alias
         * 不够）。模型下拉按所选 Provider 过滤（在服+在用恒保留）。 */}
        <div style={fieldsLayout}>
          <div style={fieldStyle}>
            <div style={labelStyle}>{tr("Provider")}</div>
            <antd.Select
              style={{ width: "100%" }}
              size="large"
              showSearch
              allowClear
              placeholder={tr("自动（跟随默认）")}
              value={provider || undefined}
              onChange={(v: string) => setProvider(v ?? "")}
              options={union.providers.map((p) => ({ value: p.name, label: p.name }))}
            />
          </div>
          <div style={fieldStyle}>
            <div style={labelStyle}>{tr("模型")}</div>
            <antd.AutoComplete
              style={{ width: "100%" }}
              size="large"
              allowClear
              placeholder={tr("模型 alias（留空=跟随集群默认）")}
              value={model}
              options={filterModelOptionsByProvider(
                union.options,
                union.gatewayOptions,
                provider,
              )}
              onChange={(v: string) => {
                setModel(v ?? "");
                // C1a-1：configured alias → binding.providerName 仅当
                // Provider 当前为空才回填（显式 Provider 是用户意图，
                // 不覆盖）。
                const auto = providerForModel(union.gatewayOptions, v ?? "");
                if (auto && !provider) setProvider(auto);
              }}
            />
            {providerModelMismatch(union.gatewayOptions, model, provider) ? (
              <div style={{ fontSize: 11, color: "#faad14", marginTop: 4 }}>
                {tr("该模型不属于所选 Provider（可直接保存，以 Provider 为准）")}
              </div>
            ) : null}
          </div>
        </div>

        {showSubagent ? (
          <div
            style={{
              display: "grid",
              gap: 10,
              padding: "12px 14px",
              borderRadius: 8,
              border: `1px solid ${t.border}`,
              background: t.cardBg,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: t.text }}>
                {tr("子代理模型")}
              </span>
              <antd.Switch size="small" checked={subagentSame} onChange={(v: boolean) => setSubagentSame(v)} />
              <span style={{ fontSize: 12, color: t.textSecondary }}>{tr("与主模型相同")}</span>
            </div>
            <div>
              <div style={labelStyle}>{tr("子代理模型（留空=跟随主模型）")}</div>
              <antd.Select
                style={{ width: "100%" }}
                size="large"
                showSearch
                allowClear
                disabled={subagentSame}
                placeholder={subagentSame ? tr("（与主模型相同）") : tr("选择子代理专用模型")}
                value={subagentSame ? undefined : subagentModel || undefined}
                onChange={(v: string) => setSubagentModel(v ?? "")}
                options={union.options as any[]}
                filterOption={(input: string, option: any) =>
                  String(option?.label ?? option?.value ?? "").toLowerCase().includes(input.toLowerCase())
                }
              />
            </div>
          </div>
        ) : null}

        {/* C1a-2：CodingCLI 模型区块——仅 Worker（workerName）+ L1 渲染；
         * Manager 详情不传 workerName → 不渲染（自检①）。 */}
        {workerName && l1 ? (
          <CodingCliModelSection workerName={workerName} mainModel={currentModel} />
        ) : null}

        <div
          style={{
            fontSize: 11,
            color: t.textSecondary,
            padding: "6px 10px",
            borderRadius: 4,
            background: t.cardBg,
          }}
        >
          {tr("Provider 决定实际转发目标（仅模型 alias 不够）")}
        </div>
      </div>
    </antd.Modal>
  );
}

/** 「跟随 Worker（不指定 baseUrl）」的 Provider 哨兵值（Select option 之一）。 */
const FOLLOW_PROVIDER = "~follow~";

// ── C1a-2：CodingCLI 模型区块（仅 Worker 详情 + L1）────────────────
// 「选 Provider」= 写 model.baseUrl（qwen-code 按 name+baseUrl 成对解析；
// 多 provider 同模型名时 baseUrl 是消歧键，见 lib/codingCliModel 头注）。
// 数据：listCodingCli（探针，只列 installed）→ 逐个 getCliSettings；
// 保存 = putCliSettings(buildCliModelPatch(...)) + 重拉该 CLI 设置。
// provider 定义键（新增 modelProviders 条目）不在本单 → Coding CLI 面板维护（L1）。

function CodingCliModelSection({
  workerName,
  mainModel,
}: {
  workerName: string;
  mainModel: string;
}) {
  const t = useThemeColors();
  const tr = useT();
  const [list, setList] = React.useState<CodingCliProbeItem[] | null>(null);
  const [listErr, setListErr] = React.useState("");
  const [settings, setSettings] = React.useState<
    Record<string, CliSettingsResponse | undefined>
  >({});
  const [settingsErr, setSettingsErr] = React.useState<Record<string, string>>({});
  const [editing, setEditing] = React.useState<CodingCliId | null>(null);
  const [reload, setReload] = React.useState(0);

  // 挂载（=弹窗打开）拉取；重试/保存后重拉经 reload 触发同一逻辑。
  React.useEffect(() => {
    let alive = true;
    setList(null);
    setListErr("");
    setSettings({});
    setSettingsErr({});
    listCodingCli(workerName)
      .then((items) => {
        if (!alive) return;
        setList(items);
        for (const p of items) {
          if (!p.installed) continue;
          getCliSettings(workerName, p.cli)
            .then((r) => {
              if (alive) setSettings((prev) => ({ ...prev, [p.cli]: r }));
            })
            .catch((e) => {
              if (alive)
                setSettingsErr((prev) => ({
                  ...prev,
                  [p.cli]: e instanceof Error ? e.message : String(e),
                }));
            });
        }
      })
      .catch((e) => {
        if (alive) setListErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [workerName, reload]);

  const retryCli = (cli: CodingCliId) => {
    setSettingsErr((prev) => ({ ...prev, [cli]: "" }));
    getCliSettings(workerName, cli)
      .then((r) => setSettings((prev) => ({ ...prev, [cli]: r })))
      .catch((e) =>
        setSettingsErr((prev) => ({
          ...prev,
          [cli]: e instanceof Error ? e.message : String(e),
        })),
      );
  };

  // 保存成功后重拉该 CLI 设置（putCliSettings 已失效 coding-cli 缓存 → 回源）。
  const refreshCli = (cli: CodingCliId) => {
    getCliSettings(workerName, cli)
      .then((r) => setSettings((prev) => ({ ...prev, [cli]: r })))
      .catch(() => setReload((n) => n + 1));
  };

  const installed = (list ?? []).filter((p) => p.installed);

  // 未装任何 CLI → 不渲染本区块（任务书）。
  if (list !== null && installed.length === 0) return null;

  const sectionStyle = {
    display: "grid",
    gap: 10,
    padding: "12px 14px",
    borderRadius: 8,
    border: `1px solid ${t.border}`,
    background: t.cardBg,
  } as const;

  return (
    <div style={sectionStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: t.text }}>
          {tr("CodingCLI 模型")}
        </span>
        <div style={{ flex: 1 }} />
        <antd.Button size="small" type="text" onClick={() => setReload((n) => n + 1)}>
          {tr("刷新")}
        </antd.Button>
      </div>

      {list === null ? (
        listErr ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: "red", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={listErr}>
              {listErr}
            </span>
            <antd.Button size="small" onClick={() => setReload((n) => n + 1)}>
              {tr("重试")}
            </antd.Button>
          </div>
        ) : (
          <antd.Spin size="small" />
        )
      ) : (
        installed.map((p) => {
          const err = settingsErr[p.cli] ?? "";
          const s = settings[p.cli];
          const cur = s ? cliCurrentModel(s.settings) : null;
          const modelText = err ? "" : cur && cur.name ? cur.name : tr("未配置");
          const status =
            !cur || !cur.name ? "none" : cur.name === mainModel ? "follow" : "indep";
          return (
            <div
              key={p.cli}
              style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
            >
              <span style={{ fontSize: 12.5, fontWeight: 600, color: t.text, minWidth: 84 }}>
                {p.cli}
              </span>
              <span
                style={{
                  fontSize: 12,
                  color: t.textSecondary,
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={err || `${modelText} · ${cur?.providerId ?? tr("跟随 Worker")}`}
              >
                {err ? (
                  <span style={{ color: "red" }}>{err}</span>
                ) : s ? (
                  `${modelText} · ${cur?.providerId ?? tr("跟随 Worker")}`
                ) : (
                  tr("加载中…")
                )}
              </span>
              <antd.Tag
                color={status === "follow" ? "blue" : status === "indep" ? "orange" : "default"}
                style={{ margin: 0, flexShrink: 0 }}
              >
                {status === "follow"
                  ? tr("跟随主模型")
                  : status === "indep"
                    ? tr("独立")
                    : tr("未配置")}
              </antd.Tag>
              {err ? (
                <antd.Button size="small" onClick={() => retryCli(p.cli)}>
                  {tr("重试")}
                </antd.Button>
              ) : (
                <antd.Button size="small" disabled={!s} onClick={() => setEditing(p.cli)}>
                  {tr("修改")}
                </antd.Button>
              )}
            </div>
          );
        })
      )}

      {editing && settings[editing] ? (
        <CliModelEditDialog
          workerName={workerName}
          cli={editing}
          settings={settings[editing] as CliSettingsResponse}
          onClose={() => setEditing(null)}
          onSaved={() => refreshCli(editing)}
        />
      ) : null}
    </div>
  );
}

// 修改弹层（先 Provider 后模型）：Provider 选项 = cliModelEntries() 条目
// （显示 id · baseUrl）+「跟随 Worker」；模型选项 = 所选 Provider 声明的
// models + 自由输入（AutoComplete）。「跟随 Worker」= 不指定 baseUrl（候选
// 取全部 provider 声明并集——无 baseUrl 时按第一个同 id 条目解析，任何
// provider 的模型名都合法）。
function CliModelEditDialog({
  workerName,
  cli,
  settings,
  onClose,
  onSaved,
}: {
  workerName: string;
  cli: CodingCliId;
  settings: CliSettingsResponse;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  const isObject = objectModel(cli);
  const entries = cliModelEntries(settings.settings);
  const cur = cliCurrentModel(settings.settings);
  const [provider, setProvider] = React.useState<string>(cur.providerId ?? FOLLOW_PROVIDER);
  const [model, setModel] = React.useState(cur.name);
  const [saving, setSaving] = React.useState(false);

  // 孤儿 baseUrl：有值但反查不到任何 provider 条目（手工改过）→ 只能自由
  // 输入模型（等价“不指定 baseUrl”），行内提示 provider 条目由面板维护。
  const orphaned = cur.baseUrl !== "" && cur.providerId === null;
  const chosen =
    provider === FOLLOW_PROVIDER
      ? null
      : (entries.find((e) => e.id === provider) ?? null);
  const allModels = Array.from(new Set(entries.flatMap((e) => e.models)));
  const modelOptions = (chosen ? chosen.models : allModels).map((m) => ({
    value: m,
    label: m,
  }));
  const labelStyle = { fontSize: 13, color: t.textSecondary, marginBottom: 6 } as const;

  const handleSave = async () => {
    const name = model.trim();
    if (!name) return;
    setSaving(true);
    try {
      const patch = buildCliModelPatch(
        cli,
        (settings.settings as Record<string, unknown>).model,
        name,
        chosen ? chosen.baseUrl : "",
      );
      // buildCliModelPatch 返回 Record<string, unknown>（纯函数宽口）；此处
      // 补丁只含 model 键（string | 纯 JSON 对象）= 合法 SettingsObject。
      await putCliSettings(workerName, cli, patch as SettingsObject);
      antd.message.success(tr("已保存"));
      onSaved();
      onClose();
    } catch (e) {
      // 失败原样提示（不吞错）。
      antd.message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <antd.Modal
      title={`${cli} · ${tr("CodingCLI 模型")}`}
      open
      onCancel={onClose}
      onOk={handleSave}
      okText={tr("保存")}
      cancelText={tr("取消")}
      confirmLoading={saving}
      okButtonProps={{ disabled: saving || model.trim() === "" }}
      destroyOnClose
      width={Math.min(480, window.innerWidth - 48)}
    >
      <div style={{ display: "grid", gap: 14, padding: "8px 0" }}>
        {isObject ? (
          <div>
            <div style={labelStyle}>{tr("Provider")}</div>
            <antd.Select
              style={{ width: "100%" }}
              size="large"
              showSearch
              value={provider}
              options={[
                { value: FOLLOW_PROVIDER, label: tr("跟随 Worker") },
                ...entries.map((e) => ({
                  value: e.id,
                  label: e.baseUrl ? `${e.id} · ${e.baseUrl}` : e.id,
                })),
              ]}
              onChange={(v: string) => setProvider(v)}
            />
          </div>
        ) : (
          <div style={{ fontSize: 11, color: "#faad14" }}>
            {tr("该 CLI 不支持 Provider 维度（扁平模型名）")}
          </div>
        )}
        {isObject && (entries.length === 0 || orphaned) ? (
          <div style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("Provider 条目由 Coding CLI 面板维护（L1）")}
          </div>
        ) : null}
        <div>
          <div style={labelStyle}>{tr("模型")}</div>
          <antd.AutoComplete
            style={{ width: "100%" }}
            size="large"
            allowClear
            placeholder={tr("模型")}
            value={model}
            options={modelOptions}
            onChange={(v: string) => setModel(v ?? "")}
          />
        </div>
      </div>
    </antd.Modal>
  );
}
