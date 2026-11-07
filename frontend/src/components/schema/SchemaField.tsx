// SchemaField — 通用单字段控件（surface 字段声明驱动）。
// 受控组件：value/onChange/disabled/error 由调用方传入；仅 array/record/
// object 编辑器持有本地行/文本缓冲（行编辑、JSON 校验），内容合法才写回
// 草稿（外部草稿重置时按 committed 标记同步回来）。
// 敏感字段红线（对齐后端 #1493）：sensitive 字段整体一个值写入——
// 回显脱敏为 "***"（或 undefined 哨兵）→ 控件置空 + placeholder「已设置，
// 未修改时保持原值」；用户输入原样透传 onChange（整体一个值）；
// sensitive object 用 TextArea 粘贴整段 JSON（保存期 surfacePatch 解析）。
// 不渲染子键、不拆 JSON 写。
// 只读字段（双星模板 isReadOnlyField / 调用方 readOnly 指定）：不渲染
// 控件，显示 formatFieldValue 值 + 「复合结构，暂不支持编辑」Tag。
// type 分支：新契约成员（number/boolean/secret/array/record/object/
// string+enum）为运行期主路径（fetchRuntimeSurface 已 normalizeSurface）；
// 旧别名 case（int/float/bool/enum/string-list）保留不动，不删不收窄。
import type * as ReactNS from "react";

import { type SurfaceField } from "../../api/domains/memberConfig";
import { formatFieldValue, isReadOnlyField } from "../../lib/surfaceForm";
import { useT } from "../../i18n";
import { useThemeColors } from "../../theme";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export interface SchemaFieldProps {
  field: SurfaceField;
  /** 草稿值（sensitive 脱敏为 "***" 或 undefined 哨兵）。只读通配字段可
   * 传 collectConcreteValues 收集到的全部 concrete 值数组。 */
  value: unknown;
  /** 整体值回写（sensitive 原样透传，不拆子键）。 */
  onChange: (v: unknown) => void;
  disabled?: boolean;
  /** 逐字段错误文案（调用方传入）。 */
  error?: string;
  /** 强制只读展示（SurfaceForm 双星 group 对组内全部字段传 true）。 */
  readOnly?: boolean;
}

type Tr = (text: string, vars?: Record<string, string | number>) => string;

/** 脱敏态：sensitive 回显 "***" 或 undefined 哨兵 → 置空 + 不回显占位。 */
function isMasked(field: SurfaceField, value: unknown): boolean {
  return field.sensitive === true && (value === "***" || value === undefined);
}

/** object → 展示文本（null/undefined → "—"；object → 缩进 JSON；其余原样）。 */
function objectText(value: unknown): string {
  if (value === undefined || value === null) return "—";
  return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
}

/** record 值文本 → 值：true/false → boolean；合法数字串 → number；
 * 其余 → string（自动识别，任务书裁定）。 */
function coerceValueText(text: string): unknown {
  if (text === "true") return true;
  if (text === "false") return false;
  if (text !== "" && Number.isFinite(Number(text)) && String(Number(text)) === text) {
    return Number(text);
  }
  return text;
}

/** array → 动态行编辑器：每行一个 Input/InputNumber/Switch（按首行值或
 * default 推元素类型，推不出按 string）；「添加一行」；行尾 × 删除
 *（少一个元素，整体替换语义——后端 deepMerge 数组整体替换）。 */
function ArrayEditor({
  field,
  value,
  onChange,
  disabled,
  tr,
}: {
  field: SurfaceField;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  tr: Tr;
}) {
  const firstElem =
    Array.isArray(value) && value.length > 0
      ? value[0]
      : field.default != null && Array.isArray(field.default) && field.default.length > 0
        ? field.default[0]
        : field.default;
  const elemType: "number" | "boolean" | "string" =
    typeof firstElem === "number"
      ? "number"
      : typeof firstElem === "boolean"
        ? "boolean"
        : "string";

  const [rows, setRows] = React.useState<unknown[]>(() =>
    Array.isArray(value) ? value.slice() : [],
  );
  const committed = React.useRef(JSON.stringify(Array.isArray(value) ? value : []));
  React.useEffect(() => {
    const cur = Array.isArray(value) ? value : [];
    const j = JSON.stringify(cur);
    if (j !== committed.current) {
      committed.current = j;
      setRows(cur.slice());
    }
  }, [value]);

  const commit = (next: unknown[]) => {
    setRows(next);
    committed.current = JSON.stringify(next);
    onChange(next);
  };
  const setRow = (i: number, v: unknown) => commit(rows.map((r, j) => (j === i ? v : r)));

  return (
    <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {elemType === "number" ? (
            <antd.InputNumber
              size="small"
              style={{ flex: 1, minWidth: 0 }}
              disabled={disabled}
              value={typeof r === "number" ? r : null}
              onChange={(v: number | null) => setRow(i, v)}
            />
          ) : elemType === "boolean" ? (
            <antd.Switch
              size="small"
              disabled={disabled}
              checked={r === true}
              onChange={(c: boolean) => setRow(i, c)}
            />
          ) : (
            <antd.Input
              size="small"
              disabled={disabled}
              value={r === undefined || r === null ? "" : String(r)}
              onChange={(ev: ReactNS.ChangeEvent<HTMLInputElement>) => setRow(i, ev.target.value)}
            />
          )}
          <antd.Button
            size="small"
            type="text"
            disabled={disabled}
            onClick={() => commit(rows.filter((_, j) => j !== i))}
          >
            ×
          </antd.Button>
        </div>
      ))}
      <antd.Button
        size="small"
        type="dashed"
        block
        disabled={disabled}
        onClick={() =>
          commit([...rows, elemType === "number" ? null : elemType === "boolean" ? false : ""])
        }
      >
        {tr("添加一行")}
      </antd.Button>
    </div>
  );
}

/** record → KV 行编辑器：key 输入 + value 输入（string/number/boolean
 * 自动识别）；空 key 行不进草稿。 */
function RecordEditor({
  value,
  onChange,
  disabled,
  tr,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  tr: Tr;
}) {
  const [rows, setRows] = React.useState<Array<{ key: string; text: string }>>(() =>
    toKvRows(value),
  );
  const committed = React.useRef(JSON.stringify(normRecord(value)));
  React.useEffect(() => {
    const j = JSON.stringify(normRecord(value));
    if (j !== committed.current) {
      committed.current = j;
      setRows(toKvRows(value));
    }
  }, [value]);

  const commit = (next: Array<{ key: string; text: string }>) => {
    setRows(next);
    const rec: Record<string, unknown> = {};
    for (const r of next) {
      const k = r.key.trim();
      if (!k) continue; // 空 key 行不进草稿
      rec[k] = coerceValueText(r.text);
    }
    committed.current = JSON.stringify(rec);
    onChange(rec);
  };

  return (
    <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <antd.Input
            size="small"
            style={{ flex: "0 1 45%", minWidth: 0 }}
            disabled={disabled}
            placeholder={tr("键")}
            value={r.key}
            onChange={(ev: ReactNS.ChangeEvent<HTMLInputElement>) =>
              commit(rows.map((x, j) => (j === i ? { ...x, key: ev.target.value } : x)))
            }
          />
          <antd.Input
            size="small"
            style={{ flex: 1, minWidth: 0 }}
            disabled={disabled}
            placeholder={tr("值")}
            value={r.text}
            onChange={(ev: ReactNS.ChangeEvent<HTMLInputElement>) =>
              commit(rows.map((x, j) => (j === i ? { ...x, text: ev.target.value } : x)))
            }
          />
          <antd.Button
            size="small"
            type="text"
            disabled={disabled}
            onClick={() => commit(rows.filter((_, j) => j !== i))}
          >
            ×
          </antd.Button>
        </div>
      ))}
      <antd.Button
        size="small"
        type="dashed"
        block
        disabled={disabled}
        onClick={() => commit([...rows, { key: "", text: "" }])}
      >
        {tr("添加一行")}
      </antd.Button>
    </div>
  );
}

function toKvRows(v: unknown): Array<{ key: string; text: string }> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return [];
  return Object.entries(v as Record<string, unknown>).map(([k, x]) => ({
    key: k,
    text: x === undefined || x === null ? "" : typeof x === "object" ? JSON.stringify(x) : String(x),
  }));
}

function normRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** object（非 sensitive）→ TextArea + JSON.parse 校验：合法才写回草稿
 *（解析后的对象）；非法 JSON 显红字提示、不进草稿；placeholder 为当前
 * 值 JSON（缩进 2）。 */
function ObjectJsonEditor({
  value,
  onChange,
  disabled,
  error,
  tr,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  error?: string;
  tr: Tr;
}) {
  const pretty = (v: unknown): string =>
    v === undefined || v === null ? "" : JSON.stringify(v, null, 2);
  const [text, setText] = React.useState(() => pretty(value));
  const [invalid, setInvalid] = React.useState(false);
  const committed = React.useRef(
    JSON.stringify(value === undefined || value === null ? null : value),
  );
  React.useEffect(() => {
    const j = JSON.stringify(value === undefined || value === null ? null : value);
    if (j !== committed.current) {
      committed.current = j;
      setText(pretty(value));
      setInvalid(false);
    }
  }, [value]);

  const handle = (raw: string) => {
    setText(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      setInvalid(true);
      return; // 非法 JSON 不进草稿
    }
    setInvalid(false);
    committed.current = JSON.stringify(parsed);
    onChange(parsed);
  };

  return (
    <div style={{ display: "grid", gap: 3, minWidth: 0 }}>
      <antd.Input.TextArea
        size="small"
        autoSize={{ minRows: 2, maxRows: 8 }}
        disabled={disabled}
        status={error || invalid ? "error" : undefined}
        placeholder={pretty(value)}
        value={text}
        onChange={(ev: ReactNS.ChangeEvent<HTMLTextAreaElement>) => handle(ev.target.value)}
        style={{ fontFamily: "ui-monospace, monospace" }}
      />
      {invalid ? (
        <div style={{ fontSize: 11, color: "#cf1322" }}>{tr("JSON 格式不对")}</div>
      ) : null}
    </div>
  );
}

export function SchemaField({
  field,
  value,
  onChange,
  disabled,
  error,
  readOnly,
}: SchemaFieldProps) {
  const tr = useT();
  const t = useThemeColors();
  const masked = isMasked(field, value);
  const ph = masked ? tr("已设置，未修改时保持原值") : undefined;

  // 规则 1：applies 徽标（next-turn=灰 / restart=红 / hot=无）。
  const badge =
    field.applies === "next-turn" ? (
      <antd.Tag style={{ marginInlineEnd: 0, fontSize: 10 }}>{tr("下一轮生效")}</antd.Tag>
    ) : field.applies === "restart" ? (
      <antd.Tag color="red" style={{ marginInlineEnd: 0, fontSize: 10 }}>{tr("需重启")}</antd.Tag>
    ) : null;

  // 只读字段（双星 / 组级指定）：不渲染控件，显示值 + 只读 Tag。
  if (readOnly || isReadOnlyField(field)) {
    const text = Array.isArray(value)
      ? value.map((v) => formatFieldValue(field, v)).join(", ")
      : formatFieldValue(field, value);
    return (
      <label style={{ display: "grid", gap: 3, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {tr(field.label || field.key)}
            {field.unit ? `（${tr(field.unit)}）` : ""}
          </span>
          {badge}
          <antd.Tag style={{ marginInlineEnd: 0, fontSize: 10 }}>
            {tr("复合结构，暂不支持编辑")}
          </antd.Tag>
        </div>
        <div
          style={{
            fontSize: 11,
            color: t.text,
            fontFamily: "ui-monospace, monospace",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {text}
        </div>
      </label>
    );
  }

  // 规则 2+3：按 type 选控件；敏感红线（脱敏 → 置空 + 不回显占位，输入原样透传）。
  const control = (() => {
    switch (field.type) {
      case "string":
        if (field.enum) {
          // string + enum 属性（旧 "enum" type 归一后形态）：Select。
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
        }
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
      case "number":
        // 无 precision/step 限制；field.default 已由 buildDraft 带入草稿。
        return (
          <antd.InputNumber
            size="small"
            style={{ width: "100%" }}
            disabled={disabled}
            status={error ? "error" : undefined}
            placeholder={ph}
            value={masked || typeof value !== "number" ? null : value}
            onChange={(v: number | null) => onChange(v)}
          />
        );
      case "boolean":
        // 网格子项默认 stretch：Switch 作为直接网格子项会被拉满整行。
        // 用 flex 容器把它固定在左侧、保持开关自身宽度。
        return (
          <div style={{ display: "flex", justifyContent: "flex-start" }}>
            <antd.Switch
              size="small"
              disabled={disabled}
              checked={value === true}
              onChange={(c: boolean) => onChange(c)}
            />
          </div>
        );
      case "secret":
        // 脱敏哨兵 → 置空 + 「已设置，未修改时保持原值」占位，不改草稿；
        // 用户输入原样透传（整体一个值）。
        return (
          <antd.Input.Password
            size="small"
            disabled={disabled}
            status={error ? "error" : undefined}
            placeholder={ph}
            value={masked || value === undefined || value === null ? "" : String(value)}
            onChange={(ev: ReactNS.ChangeEvent<HTMLInputElement>) => onChange(ev.target.value)}
          />
        );
      case "array":
        return (
          <ArrayEditor
            field={field}
            value={value}
            onChange={onChange}
            disabled={disabled}
            tr={tr}
          />
        );
      case "record":
        return <RecordEditor value={value} onChange={onChange} disabled={disabled} tr={tr} />;
      case "object":
        // sensitive object：TextArea 整段 JSON 原样回传（保存期解析，红线不变）。
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
          <ObjectJsonEditor
            value={value}
            onChange={onChange}
            disabled={disabled}
            error={error}
            tr={tr}
          />
        );
      // ── 旧别名 case（归一前声明兜底），保留不动 ──
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
            onChange={(v: number | null) => onChange(v)}
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
        // 未知 type 防御：只读展示（归一后不应到达）。
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
