// ModelPicker — 「先 Provider，再 Model」的唯一实现（模型选择器标准）。
//
// 所有编辑模型的地方都用它，保证：
//   1. 顺序恒为 Provider → Model，模型候选按所选 Provider 过滤；
//   2. 两个框都可搜索；Provider 允许清空时表示「跟随默认」；
//   3. 只读态渲染为文本 + 「只读」徽标，而不是禁用输入框（截图标准）；
//   4. 换 Provider 时，若旧 Model 不属于新 Provider → 由调用方的
//      onChange(provider, "") 收到清空（本组件负责判定，不悄悄保留）。
//
// 不变量：provider 为空时模型候选 = 全量（跟随默认/自由选择场景）。
import type * as ReactNS from "react";

import {
  keepModelForProvider,
  modelOptionsForProvider,
  type ModelPickerProvider,
} from "../lib/modelPickerModel";

export type { ModelPickerProvider } from "../lib/modelPickerModel";

export interface ModelPickerProps {
  providers: ModelPickerProvider[];
  provider: string;
  model: string;
  onChange: (provider: string, model: string) => void;
  /** 允许 Provider/模型留空（跟随默认）。 */
  allowEmpty?: boolean;
  readOnly?: boolean;
  disabled?: boolean;
  size?: "small" | "middle" | "large";
  providerPlaceholder?: string;
  modelPlaceholder?: string;
  /** 只读态文案（未设置时显示占位文案）。 */
  emptyText?: string;
  tr: (s: string) => string;
}

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export default function ModelPicker(props: ModelPickerProps): JSX.Element {
  const {
    providers,
    provider,
    model,
    onChange,
    allowEmpty = false,
    readOnly = false,
    disabled = false,
    size = "large",
    providerPlaceholder,
    modelPlaceholder,
    emptyText,
    tr,
  } = props;

  const providerOptions = providers.map((p) => ({ value: p.name, label: p.name }));
  const modelOptions = modelOptionsForProvider(providers, provider).map((m) => ({
    value: m,
    label: m,
  }));
  const searchable = { showSearch: true, optionFilterProp: "label" as const };

  if (readOnly) {
    const empty = emptyText ?? tr("未设置");
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: "#8c8c8c", minWidth: 64 }}>{tr("Provider")}</span>
          <span style={{ fontSize: 14 }}>{provider || empty}</span>
          <antd.Tag style={{ marginInlineEnd: 0, fontSize: 11 }}>{tr("只读")}</antd.Tag>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: "#8c8c8c", minWidth: 64 }}>{tr("模型")}</span>
          <span style={{ fontSize: 14 }}>{model || empty}</span>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
      <antd.Select
        style={{ width: "100%" }}
        size={size}
        allowClear={allowEmpty}
        disabled={disabled}
        placeholder={providerPlaceholder ?? tr("选择 Provider")}
        value={provider || undefined}
        onChange={(v: string) => {
          const next = v ?? "";
          // 换 Provider → 旧模型若不属于新 Provider 必须清空（成对不变量）。
          onChange(next, keepModelForProvider(providers, next, model));
        }}
        options={providerOptions}
        {...searchable}
      />
      <antd.Select
        style={{ width: "100%" }}
        size={size}
        allowClear={allowEmpty}
        disabled={disabled}
        placeholder={modelPlaceholder ?? tr("选择模型")}
        value={model || undefined}
        onChange={(v: string) => onChange(provider, v ?? "")}
        options={modelOptions}
        {...searchable}
      />
    </div>
  );
}
