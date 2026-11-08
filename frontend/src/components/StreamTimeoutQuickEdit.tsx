// 流式超时快捷编辑（热生效）——只针对 QwenPaw 的两个流式 env：
//   QWENPAW_LLM_STREAM_FIRST_CONTENT_TIMEOUT / QWENPAW_LLM_STREAM_IDLE_TIMEOUT
//
// 数据源 = 容器 PID 1 实际生效 env（runtime-env 实读，脱敏不覆盖）；
// 保存 = 写 Worker spec 的 llmStream* 覆盖 → Controller 对 qwenpaw 容器
// PATCH /api/envs 热生效（无需重启；QwenPaw >= 2.2.1）。清空 = 清除覆盖（回继承）。
// 复用 lib/llm-tuning 的字段元数据与校验，不另造一份字段表。
import type * as ReactNS from "react";

import { updateWorker } from "../api/domains/crd";
import { fetchWorkerRuntimeEnv } from "../api/domains/upgrade";
import {
  LLM_TUNING_FIELDS,
  validateLlmTuningValue,
  type LlmTuningKey,
} from "../lib/llm-tuning";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

/** 只有这两个字段走 envs 热生效；表驱动，避免硬编码键名。 */
const HOT_FIELDS = LLM_TUNING_FIELDS.filter((f) => f.group === "stream" && f.envKey);

export default function StreamTimeoutQuickEdit(props: {
  name: string;
  /** 仅 L1 可写；非 L1 不渲染（由调用方决定，但此处再兜一层）。 */
  l1?: boolean;
  /** qwenpaw 专有面：调用方应只在 qwenpaw 运行时渲染。 */
  onChanged?: () => void;
}) {
  const { name, l1, onChanged } = props;
  const tr = useT();
  const t = useThemeColors();
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [baseline, setBaseline] = React.useState<Record<string, string>>({});
  const [loaded, setLoaded] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  const load = React.useCallback(async () => {
    try {
      const res = await fetchWorkerRuntimeEnv(name);
      const next: Record<string, string> = {};
      for (const f of HOT_FIELDS) {
        const e = res?.env?.find((x) => x.key === f.envKey);
        next[f.key] = e && e.value && !e.masked ? String(e.value) : "";
      }
      setValues(next);
      setBaseline(next);
    } catch {
      setValues({});
      setBaseline({});
    } finally {
      setLoaded(true);
    }
  }, [name]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const dirty = HOT_FIELDS.some((f) => (values[f.key] ?? "") !== (baseline[f.key] ?? ""));
  const invalid = HOT_FIELDS.map((f) => validateLlmTuningValue(values[f.key] ?? "")).find((e) => e !== null);

  const save = React.useCallback(async () => {
    if (!l1 || saving) return;
    const patch: Record<string, unknown> = {};
    for (const f of HOT_FIELDS) patch[f.key] = (values[f.key] ?? "").trim();
    setSaving(true);
    setMsg(null);
    try {
      await updateWorker(name, patch);
      // 保存后实读一次真值（fresh=true 绕 120s 缓存），确认 hot-apply 生效。
      const res = await fetchWorkerRuntimeEnv(name, false, true);
      const next: Record<string, string> = {};
      for (const f of HOT_FIELDS) {
        const e = res?.env?.find((x) => x.key === f.envKey);
        next[f.key] = e && e.value && !e.masked ? String(e.value) : "";
      }
      setValues(next);
      setMsg({ ok: true, text: tr("已保存（流式超时热生效，无需重启）") });
      onChanged?.();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : tr("保存失败") });
    } finally {
      setSaving(false);
    }
  }, [l1, saving, values, name, tr, onChanged]);

  if (!l1 || HOT_FIELDS.length === 0) return null;

  return (
    <div style={{ display: "grid", gap: 6, border: `1px solid ${t.border}`, borderRadius: 6, padding: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600 }}>{tr("流式超时（热生效，无需重启）")}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
        {HOT_FIELDS.map((f) => {
          const key = f.key as LlmTuningKey;
          const err = validateLlmTuningValue(values[key] ?? "");
          return (
            <label key={key} style={{ display: "grid", gap: 3 }}>
              <span style={{ fontSize: 11, color: t.textSecondary }}>
                {tr(f.label)}
                {f.unit ? `（${tr(f.unit)}）` : ""}
              </span>
              <antd.Input
                size="small"
                type="number"
                min={0}
                step="any"
                disabled={saving || !loaded}
                status={err ? "error" : undefined}
                placeholder={tr("空 = 继承团队/默认")}
                value={values[key] ?? ""}
                onChange={(e: { target: { value: string } }) =>
                  setValues((prev) => ({ ...prev, [key]: e.target.value }))
                }
                style={{ fontFamily: "ui-monospace, monospace" }}
              />
              <span style={{ fontSize: 10, color: t.textSecondary }}>{f.envKey}</span>
            </label>
          );
        })}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <antd.Button size="small" type="primary" loading={saving} disabled={!loaded || !dirty || !!invalid} onClick={() => void save()}>
          {tr("保存（热生效）")}
        </antd.Button>
        <antd.Button size="small" disabled={saving} onClick={() => void load()}>
          {tr("重新读取")}
        </antd.Button>
        {invalid ? <span style={{ fontSize: 11, color: "#e5484d" }}>{tr(invalid)}</span> : null}
        {msg ? (
          <span style={{ fontSize: 11, color: msg.ok ? "#2e9e5b" : "#e5484d" }}>{msg.text}</span>
        ) : null}
      </div>
    </div>
  );
}
