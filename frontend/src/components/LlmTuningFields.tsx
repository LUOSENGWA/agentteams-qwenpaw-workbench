/**
 * LlmTuningFields.tsx — LLM 调优 10 字段网格（antd 双列，按 startup/stream
 * 分组）。Worker 面板（WorkerLlmTuningPanel）与团队配置弹窗（CrdCfgModal）
 * 共用，保证两处字段顺序/单位/默认提示/校验一致（移植 dashboard
 * llm-tuning-fields.tsx 的 antd 等价物）。
 *
 * 纯展示组件：值/变更/禁用由调用方持有；lib/llm-tuning.ts 提供字段元数据
 * 与校验。i18n：label/unit/group-label 均为中文源文本=tr() 键。
 */
import type * as ReactNS from "react";

import {
  LLM_TUNING_FIELDS,
  LLM_TUNING_GROUP_LABELS,
  validateLlmTuningValue,
  type LlmTuningGroup,
  type LlmTuningKey,
  type LlmTuningRecord,
} from "../lib/llm-tuning";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

const GROUP_ORDER: readonly LlmTuningGroup[] = ["startup", "stream"];

export default function LlmTuningFields({
  values,
  onChange,
  disabled,
}: {
  values: LlmTuningRecord;
  onChange: (key: LlmTuningKey, value: string) => void;
  disabled?: boolean;
}) {
  const tr = useT();
  const t = useThemeColors();
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {GROUP_ORDER.map((group) => (
        <div key={group} style={{ display: "grid", gap: 6 }}>
          <div style={{ fontSize: 11, color: t.textSecondary }}>
            {tr(LLM_TUNING_GROUP_LABELS[group])}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: 8,
            }}
          >
            {LLM_TUNING_FIELDS.filter((f) => f.group === group).map((field) => {
              const value = values[field.key];
              const invalid = validateLlmTuningValue(value) !== null;
              return (
                <label key={field.key} style={{ display: "grid", gap: 3 }}>
                  <span style={{ fontSize: 11, color: t.textSecondary }}>
                    {tr(field.label)}
                    {field.unit ? `（${tr(field.unit)}）` : ""}
                  </span>
                  <antd.Input
                    size="small"
                    type="number"
                    min={0}
                    step="any"
                    disabled={disabled}
                    status={invalid ? "error" : undefined}
                    placeholder={
                      field.registryDefault
                        ? tr("默认 {v}", { v: field.registryDefault })
                        : tr("默认")
                    }
                    value={value}
                    onChange={(e: { target: { value: string } }) =>
                      onChange(field.key, e.target.value)
                    }
                    style={{ fontFamily: "ui-monospace, monospace" }}
                  />
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
