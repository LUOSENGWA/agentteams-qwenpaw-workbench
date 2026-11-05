/**
 * ModelEditModal.tsx — 管理页 · 模型配置编辑弹窗（Manager/Worker 详情面板共用）。
 *
 * 子代理模型（QwenPaw >= 2.1.1 专用）：
 * - 开关"与主模型相同"= ON → subagent model 同步主模型 + 选择器 disabled；
 * - OFF → 独立 Model 选择器（同源列表，可选不同后端模型）。
 */
import type * as ReactNS from "react";

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
