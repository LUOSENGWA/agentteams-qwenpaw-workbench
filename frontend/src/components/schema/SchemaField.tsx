// SchemaField — 通用单字段控件（surface 字段声明驱动）。
// 纯受控组件：value/onChange/disabled/error 全部由调用方传入，无内部状态。
// 敏感字段红线（对齐后端 #1493）：sensitive 字段整体一个值写入——
// 回显脱敏为 "***"（或 undefined 哨兵）→ 控件置空 + placeholder「已设置（不回显）」；
// 用户输入原样透传 onChange（整体一个值）；object 用 TextArea 粘贴整段 JSON。
// 不渲染子键、不拆 JSON 写。
import type * as ReactNS from "react";

import { type SurfaceField } from "../../api/domains/memberConfig";
import { useT } from "../../i18n";
import { useThemeColors } from "../../theme";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export interface SchemaFieldProps {
  field: SurfaceField;
  /** 草稿值（sensitive 脱敏为 "***" 或 undefined 哨兵）。 */
  value: unknown;
  /** 整体值回写（sensitive 原样透传，不拆子键）。 */
  onChange: (v: unknown) => void;
  disabled?: boolean;
  /** 逐字段错误文案（调用方传入）。 */
  error?: string;
}

/** 脱敏态：sensitive 回显 "***" 或 undefined 哨兵 → 置空 + 不回显占位。 */
function isMasked(field: SurfaceField, value: unknown): boolean {
  return field.sensitive === true && (value === "***" || value === undefined);
}

/** object → 展示文本（null/undefined → "—"；object → 缩进 JSON；其余原样）。 */
function objectText(value: unknown): string {
  if (value === undefined || value === null) return "—";
  return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
}

export function SchemaField({ field, value, onChange, disabled, error }: SchemaFieldProps) {
  const tr = useT();
  const t = useThemeColors();
  const masked = isMasked(field, value);
  const ph = masked ? tr("已设置（不回显）") : undefined;

  // 规则 1：applies 徽标（next-turn=灰 / restart=红 / hot=无）。
  const badge =
    field.applies === "next-turn" ? (
      <antd.Tag style={{ marginInlineEnd: 0, fontSize: 10 }}>{tr("下一轮生效")}</antd.Tag>
    ) : field.applies === "restart" ? (
      <antd.Tag color="red" style={{ marginInlineEnd: 0, fontSize: 10 }}>{tr("需重启")}</antd.Tag>
    ) : null;

  // 规则 2+3：按 type 选控件；敏感红线（脱敏 → 置空 + 不回显占位，输入原样透传）。
  const control = (() => {
    switch (field.type) {
      case "string":
        return (
          <antd.Input
            size="small"
            disabled={disabled}
            status={error ? "error" : undefined}
            placeholder={ph}
            value={masked ? "" : value === undefined || value === null ? "" : String(value)}
            onChange={(ev: ReactNS.ChangeEvent<HTMLInputElement>) => onChange(ev.target.value)}
          />
        );
      case "int":
      case "float":
        return (
          <antd.InputNumber
            size="small"
            style={{ width: "100%" }}
            disabled={disabled}
            status={error ? "error" : undefined}
            placeholder={ph}
            value={masked || typeof value !== "number" ? null : value}
            onChange={(v) => onChange(v)}
            precision={field.type === "int" ? 0 : undefined}
            step={field.type === "float" ? 0.1 : undefined}
          />
        );
      case "bool":
        return (
          <antd.Switch
            size="small"
            disabled={disabled}
            checked={value === true}
            onChange={(c: boolean) => onChange(c)}
          />
        );
      case "enum":
        return (
          <antd.Select
            size="small"
            style={{ width: "100%" }}
            disabled={disabled}
            status={error ? "error" : undefined}
            placeholder={ph}
            value={masked || typeof value !== "string" ? undefined : value}
            onChange={(v: string) => onChange(v)}
            options={(field.enum ?? []).map((o) => ({ value: o, label: o }))}
          />
        );
      case "string-list":
        return (
          <antd.Select
            size="small"
            mode="tags"
            style={{ width: "100%" }}
            disabled={disabled}
            status={error ? "error" : undefined}
            placeholder={ph}
            value={masked || !Array.isArray(value) ? [] : value.map((x) => String(x))}
            onChange={(v: string[]) => onChange(v)}
          />
        );
      default:
        // object：sensitive → TextArea 整段 JSON（原样回传）；非 sensitive → 只读展示。
        if (field.sensitive === true) {
          return (
            <antd.Input.TextArea
              size="small"
              autoSize={{ minRows: 2, maxRows: 8 }}
              disabled={disabled}
              status={error ? "error" : undefined}
              placeholder={ph}
              value={
                masked || value === undefined || value === null
                  ? ""
                  : objectText(value)
              }
              onChange={(ev: ReactNS.ChangeEvent<HTMLTextAreaElement>) =>
                onChange(ev.target.value)
              }
              style={{ fontFamily: "ui-monospace, monospace" }}
            />
          );
        }
        return (
          <pre
            style={{
              margin: 0,
              padding: "4px 8px",
              fontSize: 11,
              fontFamily: "ui-monospace, monospace",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              border: `1px solid ${t.border}`,
              borderRadius: 6,
              background: t.bubbleOther,
              color: t.text,
              maxHeight: 160,
              overflow: "auto",
              minWidth: 0,
            }}
          >
            {objectText(value)}
          </pre>
        );
    }
  })();

  return (
    <label style={{ display: "grid", gap: 3, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: t.textSecondary }}>
          {tr(field.label || field.key)}
          {field.unit ? `（${tr(field.unit)}）` : ""}
        </span>
        {badge}
      </div>
      {control}
      {error ? <div style={{ fontSize: 11, color: "#cf1322" }}>{error}</div> : null}
    </label>
  );
}

export default SchemaField;
