/**
 * ModelSettingsModal.tsx — C1 统一模型设置弹窗（视图层，只含视图）。
 *
 * 草稿语义（runtime 形态适配 / 回退链去重 / 校验 / 字段开关 / patch 构建）
 * 全部下沉 src/lib/modelDraft.ts（纯函数，单测直跑）；本文件只负责布局
 * 与交互，**不直接调任何后端 api**（保存只调调用方提供的 onSave(patch)，
 * 各入口自己的 API 调用 / 字段映射 / 请求路径在接线单逐入口处理）。
 *
 * 区块（按 features 开关，缺省全关 = 不改变入口现状）：
 * - 主模型：Provider → Model 两级 Select（模型清单随所选 Provider 过滤）；
 * - 回退链（features.fallbacks）：增删、去重、上限 3；
 * - 高级（features.advanced）：temperature / maxTokens / stream。
 *
 * 保存语义：保存中禁用（saving / 内部 savingNow）；onSave 失败 → 回滚
 * 草稿 + 就地显错（不 alert）；成功 → onClose()（open 由入口持有）。
 *
 * Modal 外壳复用 manage/files/DialogShell（统一 Modal 配置，禁两份）。
 */
import type * as ReactNS from "react";

import DialogShell from "./files/DialogShell";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import {
  buildModelPatch,
  fieldsFor,
  isDraftDirty,
  MAX_FALLBACKS,
  modelsForProvider,
  validateModelDraft,
} from "../lib/modelDraft";
import type {
  ModelDraft,
  ModelDraftErrorCode,
  ModelFeatures,
  ModelRuntime,
  ProviderOption,
} from "../lib/modelDraft";

// 纯函数再导出（入口接线 / 测试统一从本组件入口 import）。
export { toModelValue, fromModelValue } from "../lib/modelDraft";
export { validateModelDraft } from "../lib/modelDraft";
export type {
  ModelDraft,
  ModelDraftErrorCode,
  ModelFeatures,
  ModelRuntime,
  ProviderOption,
} from "../lib/modelDraft";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export interface ModelSettingsModalProps {
  open: boolean;
  /** 标题（传已 tr() 的字符串；缺省「模型设置」）。 */
  title?: string;
  /** runtime 形态（适配层语义；视图仅以副标题提示落盘形态）。 */
  runtime?: ModelRuntime;
  /** 当前值（归一草稿）。 */
  value: ModelDraft;
  /** 特性开关：advanced = 温度/最大 tokens/流式；fallbacks = 回退链。 */
  features?: ModelFeatures;
  /** Provider 目录（name + 该 provider 下模型清单）。 */
  providers: ProviderOption[];
  onClose: () => void;
  /** 提交（入口自己的 API 调用 + 字段映射）；reject = 失败回滚 + 就地显错。 */
  onSave: (patch: ModelDraft) => Promise<void>;
  /** 入口侧保存中（外部 saving 状态；内部另有 savingNow）。 */
  saving?: boolean;
  /** 允许主模型留空（入口语义「留空 = 继承 / 不改」）：缺省 missing-main
   * 阻断保存；置 true 后清空主模型可保存（invalid-model-name 等其余
   * 校验不变）。缺省 false = 各既有入口行为不变。 */
  allowEmptyMain?: boolean;
}

export default function ModelSettingsModal({
  open,
  title,
  runtime = "qwenpaw",
  value,
  features,
  providers,
  onClose,
  onSave,
  saving = false,
  allowEmptyMain = false,
}: ModelSettingsModalProps) {
  const t = useThemeColors();
  const tr = useT();
  const fields = React.useMemo(() => fieldsFor(features), [features]);
  const showFallbacks = fields.includes("fallbacks");
  const showAdvanced = fields.includes("temperature");

  const [draft, setDraft] = React.useState<ModelDraft>(value);
  const [savingNow, setSavingNow] = React.useState(false);
  const [saveErr, setSaveErr] = React.useState("");

  // 打开（再）→ 重置本地草稿（value 可能已随上次保存变化）。
  // 仅随 open 翻转重置，不随 value 引用变——避免编辑中被外部覆盖。
  React.useEffect(() => {
    if (open) {
      setDraft({
        provider: value.provider ?? "",
        model: value.model ?? "",
        fallbacks: [...(value.fallbacks ?? [])],
        temperature: value.temperature,
        maxTokens: value.maxTokens,
        stream: value.stream,
      });
      setSaveErr("");
      setSavingNow(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const validation = React.useMemo(() => {
    const v = validateModelDraft(draft);
    if (!allowEmptyMain) return v;
    // 留空 = 继承 / 不改的入口：missing-main 不阻断（其余错误码保留）。
    const errors = v.errors.filter((c) => c !== "missing-main");
    return { ok: errors.length === 0, errors };
  }, [draft, allowEmptyMain]);
  const dirty = React.useMemo(
    () => isDraftDirty(draft, value, features),
    [draft, value, features],
  );

  const providerOptions = React.useMemo(
    () => providers.map((p) => ({ value: p.name, label: p.name })),
    [providers],
  );
  // 二级 Select 候选 = 所选 Provider 的模型清单（未选 / 未知 → 空）。
  const modelOptions = React.useMemo(
    () =>
      modelsForProvider(providers, draft.provider).map((m) => ({
        value: m,
        label: m,
      })),
    [providers, draft.provider],
  );
  // 回退候选 = 全部 provider 模型并集（去重，保序）。
  const fallbackOptions = React.useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const p of providers) {
      for (const m of p.models) {
        const v = m.trim();
        if (v && !seen.has(v)) {
          seen.add(v);
          out.push(v);
        }
      }
    }
    return out.map((m) => ({ value: m, label: m }));
  }, [providers]);

  const setMain = (patch: Partial<ModelDraft>) =>
    setDraft((d) => ({ ...d, ...patch }));
  const fallbacks = draft.fallbacks ?? [];
  const updateFallback = (i: number, v: string) =>
    setDraft((d) => ({
      ...d,
      fallbacks: (d.fallbacks ?? []).map((x, j) => (j === i ? v : x)),
    }));
  const removeFallback = (i: number) =>
    setDraft((d) => ({
      ...d,
      fallbacks: (d.fallbacks ?? []).filter((_x, j) => j !== i),
    }));
  const addFallback = () =>
    setDraft((d) => {
      const cur = d.fallbacks ?? [];
      if (cur.length >= MAX_FALLBACKS) return d;
      return { ...d, fallbacks: [...cur, ""] };
    });

  const busy = saving || savingNow;
  const saveDisabled = !dirty || !validation.ok || busy;

  const handleSave = async () => {
    if (saveDisabled) return;
    const before = draft; // 失败回滚快照
    setSavingNow(true);
    setSaveErr("");
    try {
      await onSave(buildModelPatch(draft, value, features));
      // 成功 → 关闭（open 由入口持有；入口也可在 onSave 内自行关）。
      onClose();
    } catch (e) {
      // 失败 → 回滚草稿 + 就地显错（不 alert）。
      setDraft(before);
      setSaveErr(e instanceof Error ? e.message : tr("保存失败"));
    } finally {
      setSavingNow(false);
    }
  };

  const mainErrors = validation.errors.filter((c) =>
    c === "missing-main" || c === "invalid-model-name",
  );
  const fallbackErrors = validation.errors.filter((c) =>
    c === "fallback-duplicate" ||
    c === "too-many-fallbacks" ||
    c === "fallback-duplicates-main",
  );

  const footer = (
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
      <antd.Button onClick={onClose}>{tr("取消")}</antd.Button>
      <antd.Button
        type="primary"
        loading={busy}
        disabled={saveDisabled}
        onClick={handleSave}
      >
        {tr("保存")}
      </antd.Button>
    </div>
  );

  const labelStyle = {
    fontSize: 13,
    color: t.textSecondary,
    marginBottom: 6,
  } as const;
  const sectionStyle = {
    display: "grid",
    gap: 10,
    padding: "12px 14px",
    borderRadius: 8,
    border: `1px solid ${t.border}`,
    background: t.cardBg,
  } as const;
  const errStyle = { fontSize: 11, color: "#ff4d4f", marginTop: 4 } as const;
  const searchable = {
    showSearch: true,
    filterOption: (input: string, option: unknown) =>
      String(
        (option as { label?: unknown; value?: unknown } | null | undefined)
          ?.label ??
          (option as { label?: unknown; value?: unknown } | null | undefined)
            ?.value ??
          "",
      ).toLowerCase().includes(input.toLowerCase()),
  } as const;

  return (
    <DialogShell
      open={open}
      title={title ?? tr("模型设置")}
      subtitle={
        runtime === "hermes"
          ? tr("落盘形态：{x}", { x: "{name, provider}" })
          : tr("落盘形态：{x}", { x: "{provider, model}" })
      }
      width={860}
      onClose={onClose}
      footer={footer}
    >
      <div style={{ display: "grid", gap: 14, padding: "4px 0" }}>
        {/* 保存失败 → 就地显错（不 alert）。 */}
        {saveErr ? (
          <div
            style={{
              fontSize: 12,
              color: "#cf1322",
              background: "#fff2f0",
              border: "1px solid #ffccc7",
              borderRadius: 4,
              padding: "6px 10px",
            }}
          >
            {tr("保存失败：")} {saveErr}
          </div>
        ) : null}

        {/* 主模型：Provider → Model 两级 Select（模型随所选 Provider 过滤）。 */}
        <div style={{ display: "grid", gap: 12 }}>
          <div>
            <div style={labelStyle}>{tr("Provider")}</div>
            <antd.Select
              style={{ width: "100%" }}
              size="large"
              allowClear
              placeholder={tr("选择 Provider")}
              value={draft.provider || undefined}
              onChange={(v: string) => setMain({ provider: v ?? "" })}
              options={providerOptions}
              {...searchable}
            />
          </div>
          <div>
            <div style={labelStyle}>{tr("模型")}</div>
            <antd.Select
              style={{ width: "100%" }}
              size="large"
              allowClear
              placeholder={tr("选择模型")}
              value={draft.model || undefined}
              onChange={(v: string) => setMain({ model: v ?? "" })}
              options={modelOptions}
              {...searchable}
            />
            {mainErrors.length > 0 ? (
              <div style={errStyle}>
                {mainErrors.map((c) => (
                  <div key={c}>{errorText(c, tr)}</div>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        {/* 回退链（features.fallbacks）：增删、去重、上限 3。 */}
        {showFallbacks ? (
          <div style={sectionStyle}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: t.text }}>
                {tr("回退模型链")}
              </span>
              <span style={{ fontSize: 11, color: t.textSecondary }}>
                {tr("主模型不可用时按序尝试（最多 3 条）")}
              </span>
            </div>
            {fallbacks.map((f, i) => (
              <div
                key={`${i}-${f}`}
                style={{ display: "flex", alignItems: "center", gap: 8 }}
              >
                <antd.Select
                  style={{ flex: 1, width: "100%" }}
                  allowClear
                  placeholder={tr("选择回退模型")}
                  value={f || undefined}
                  onChange={(v: string) => updateFallback(i, v ?? "")}
                  options={fallbackOptions}
                  {...searchable}
                />
                <antd.Button
                  size="small"
                  danger
                  disabled={busy}
                  onClick={() => removeFallback(i)}
                >
                  {tr("删除")}
                </antd.Button>
              </div>
            ))}
            <div>
              <antd.Button
                size="small"
                disabled={fallbacks.length >= MAX_FALLBACKS || busy}
                onClick={addFallback}
              >
                {tr("添加回退")}
              </antd.Button>
            </div>
            {fallbackErrors.length > 0 ? (
              <div style={{ fontSize: 11, color: "#ff4d4f" }}>
                {fallbackErrors.map((c) => (
                  <div key={c}>{errorText(c, tr)}</div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* 高级（features.advanced）：temperature / maxTokens / stream。 */}
        {showAdvanced ? (
          <div style={sectionStyle}>
            <span style={{ fontSize: 13, fontWeight: 600, color: t.text }}>
              {tr("高级")}
            </span>
            <div>
              <div style={labelStyle}>{tr("Temperature")}</div>
              <antd.InputNumber
                style={{ width: "100%" }}
                min={0}
                max={2}
                step={0.1}
                placeholder={tr("跟随默认")}
                value={draft.temperature}
                onChange={(v: number | string | null) =>
                  setMain({ temperature: v == null ? undefined : Number(v) })
                }
              />
            </div>
            <div>
              <div style={labelStyle}>{tr("最大 tokens")}</div>
              <antd.InputNumber
                style={{ width: "100%" }}
                min={1}
                step={1}
                placeholder={tr("跟随默认")}
                value={draft.maxTokens}
                onChange={(v: number | string | null) =>
                  setMain({
                    maxTokens: v == null ? undefined : Math.floor(Number(v)),
                  })
                }
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <antd.Switch
                size="small"
                checked={draft.stream ?? false}
                onChange={(v: boolean) => setMain({ stream: v })}
              />
              <span style={{ fontSize: 13, color: t.textSecondary }}>
                {tr("流式输出")}
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </DialogShell>
  );
}

/** 错误码 → 就地文案（zh 键走 tr()）。 */
function errorText(
  c: ModelDraftErrorCode,
  tr: (text: string, vars?: Record<string, string | number>) => string,
): string {
  switch (c) {
    case "missing-main":
      return tr("主模型不能为空");
    case "invalid-model-name":
      return tr("模型名不能是路径 / URL，且不能含空格");
    case "fallback-duplicate":
      return tr("回退链存在重复（保存时自动去重）");
    case "too-many-fallbacks":
      return tr("回退链超过上限（最多 3 条）");
    case "fallback-duplicates-main":
      return tr("回退链不能包含主模型");
  }
}
