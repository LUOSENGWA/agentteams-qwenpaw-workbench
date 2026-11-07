// modelDraft.ts — 模型设置草稿纯函数层（C1 统一模型弹窗，视图无关）。
//
// 定位：manage/ModelSettingsModal.tsx 只负责视图；草稿语义（runtime 形态
// 适配 / 回退链去重 / 校验 / 字段开关 / provider 过滤）全部下沉到本纯
// 模块。本文件**零 import、顶层无浏览器全局**，因此可被
// `node --experimental-strip-types` 直接 import 单测（见
// tests/c1-model-modal.test.ts），无需 esbuild bundle / window shim。
//
// 三种 runtime 的 model 存储形态（任务书口径）：
// - qwenpaw  = { provider, model }
// - openclaw = { provider, model }（与 qwenpaw 同形）
// - hermes   = object { name, provider }（name 即模型名）
// 适配层在弹窗内部完成，入口不感知（toModelValue / fromModelValue）。

/** runtime 形态。 */
export type ModelRuntime = "qwenpaw" | "openclaw" | "hermes";

/** 归一化模型值（canonical，弹窗内部编辑形态）。 */
export interface ModelValue {
  provider: string;
  model: string;
}

/** runtime 落盘形态：qwenpaw/openclaw = {provider,model}；hermes = {name,provider}。 */
export type ModelStorage =
  | { provider: string; model: string }
  | { name: string; provider: string };

/** Provider 选项（name + 该 provider 下的模型清单）。 */
export interface ProviderOption {
  name: string;
  models: string[];
}

/** 模型设置草稿（弹窗编辑对象；onSave(patch) 回传同一形状）。 */
export interface ModelDraft {
  provider: string;
  model: string;
  /** 回退模型链（上限 3；未启用回退区时入口可传 [] / 省略）。 */
  fallbacks?: string[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

/** 特性开关（入口各自 opt-in；缺省全关 = 不改变入口现状）。 */
export interface ModelFeatures {
  advanced?: boolean;
  fallbacks?: boolean;
}

/** 回退链硬上限（任务书：最多 3 条）。 */
export const MAX_FALLBACKS = 3;

/** 模型名硬规则：路径 / URL / 含空格 = 不可能是模型名（与 modelUnion 同口径）。 */
export function isPathLikeModelName(v: string): boolean {
  return v.startsWith("/") || v.includes("://") || /\s/.test(v);
}

// ── runtime 形态适配（纯函数，入口不感知）──────────────────────────
/**
 * 落盘/存储值 → 归一 {provider, model}（canonical）。
 * 兼容 {provider,model}（qwenpaw/openclaw）、{name,provider}（hermes）、
 * 纯字符串（= 仅模型名，provider 空）。空 / 缺字段 → null（不抛）。
 * runtime 仅决定 name/model 字段优先级，跨形兜底（形态漂移仍解析得动）。
 */
export function fromModelValue(
  value: unknown,
  runtime: ModelRuntime = "qwenpaw",
): ModelValue | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const model = value.trim();
    return model ? { provider: "", model } : null;
  }
  if (typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const provider = typeof o.provider === "string" ? o.provider.trim() : "";
  const order: string[] = runtime === "hermes" ? ["name", "model"] : ["model", "name"];
  let model = "";
  for (const key of order) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) {
      model = v.trim();
      break;
    }
  }
  if (!provider && !model) return null;
  return { provider, model };
}

/**
 * 归一值（或任意 fromModelValue 可解析的值）→ runtime 落盘形态。
 * qwenpaw/openclaw → {provider,model}；hermes → {name,provider}。
 * 空 / 缺字段 → null（不抛）。与 fromModelValue 往返一致（见单测）。
 */
export function toModelValue(
  value: unknown,
  runtime: ModelRuntime = "qwenpaw",
): ModelStorage | null {
  const norm = fromModelValue(value);
  if (!norm) return null;
  if (runtime === "hermes") return { name: norm.model, provider: norm.provider };
  return { provider: norm.provider, model: norm.model };
}

// ── 回退链（去重 + 上限，纯函数——可测）────────────────────────────
/** 去重（trim 后按出现序保序）+ 截断到 MAX_FALLBACKS；非字符串项忽略。 */
export function dedupeFallbacks(items: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const s = typeof it === "string" ? it.trim() : "";
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_FALLBACKS) break;
  }
  return out;
}

// ── 校验（纯函数——可测；错误就地展示，入口不 alert）────────────────
export type ModelDraftErrorCode =
  | "missing-main"
  | "invalid-model-name"
  | "fallback-duplicate"
  | "too-many-fallbacks"
  | "fallback-duplicates-main";

export interface ModelDraftValidation {
  ok: boolean;
  errors: ModelDraftErrorCode[];
}

/**
 * 统一校验：主模型必填（missing-main）+ 模型名硬规则（invalid-model-name）+
 * 回退链去重（fallback-duplicate）/ 上限（too-many-fallbacks）/ 不得含主模型
 * （fallback-duplicates-main）。
 */
export function validateModelDraft(
  draft: Partial<ModelDraft> | null | undefined,
): ModelDraftValidation {
  const errors: ModelDraftErrorCode[] = [];
  const model = (draft && typeof draft.model === "string" ? draft.model : "").trim();
  const rawFallbacks = draft && Array.isArray(draft.fallbacks) ? draft.fallbacks : [];

  if (!model) {
    errors.push("missing-main");
  } else if (isPathLikeModelName(model)) {
    errors.push("invalid-model-name");
  }

  const nonEmpty = rawFallbacks
    .map((f) => (typeof f === "string" ? f.trim() : ""))
    .filter(Boolean);
  const uniqueNonEmpty = Array.from(new Set(nonEmpty));
  if (uniqueNonEmpty.length !== nonEmpty.length) errors.push("fallback-duplicate");
  if (uniqueNonEmpty.length > MAX_FALLBACKS) errors.push("too-many-fallbacks");
  if (model && nonEmpty.includes(model)) errors.push("fallback-duplicates-main");

  return { ok: errors.length === 0, errors };
}

// ── 字段开关（features → 可见区块，纯函数——可测）──────────────────
/**
 * features → 可见字段键。主模型恒显；fallbacks / advanced（temperature /
 * maxTokens / stream）按开关。缺省全关（入口未 opt-in 的区块不显示，
 * 不改变入口现状）。
 */
export function fieldsFor(features: ModelFeatures = {}): string[] {
  const fields: string[] = ["main"];
  if (features.fallbacks) fields.push("fallbacks");
  if (features.advanced) fields.push("temperature", "maxTokens", "stream");
  return fields;
}

// ── provider 过滤（纯函数——可测）──────────────────────────────────
/** 按名字（大小写不敏感子串）过滤 provider 列表；空查询 = 原样返回（同一引用）。 */
export function filterProviders(
  providers: ProviderOption[],
  query: string,
): ProviderOption[] {
  const q = (query || "").trim().toLowerCase();
  if (!q) return providers;
  return providers.filter((p) => p.name.toLowerCase().includes(q));
}

/** 所选 provider 的模型清单（二级 Select 候选）；未选 / 未知 provider → []。 */
export function modelsForProvider(
  providers: ProviderOption[],
  providerName: string,
): string[] {
  const p = (providerName || "").trim();
  if (!p) return [];
  const hit = providers.find((x) => x.name === p);
  return hit ? hit.models : [];
}

// ── patch 构建（纯函数——可测）─────────────────────────────────────
/**
 * 构建回传 onSave 的 patch：主模型 trim、回退链去重；**未启用**的区块
 * （features 未开 = 弹窗没渲染该区块）保留 value 原值——不用弹窗默认值
 * 冲掉入口既有字段（不改变各入口原有行为）。
 */
export function buildModelPatch(
  draft: ModelDraft,
  value: ModelDraft,
  features: ModelFeatures = {},
): ModelDraft {
  const patch: ModelDraft = {
    provider: (draft.provider ?? "").trim(),
    model: (draft.model ?? "").trim(),
  };
  if (features.fallbacks) {
    patch.fallbacks = dedupeFallbacks(draft.fallbacks ?? []);
  } else if (value.fallbacks && value.fallbacks.length > 0) {
    patch.fallbacks = dedupeFallbacks(value.fallbacks);
  }
  if (features.advanced) {
    if (draft.temperature !== undefined) patch.temperature = draft.temperature;
    if (draft.maxTokens !== undefined) patch.maxTokens = draft.maxTokens;
    if (draft.stream !== undefined) patch.stream = draft.stream;
  } else {
    if (value.temperature !== undefined) patch.temperature = value.temperature;
    if (value.maxTokens !== undefined) patch.maxTokens = value.maxTokens;
    if (value.stream !== undefined) patch.stream = value.stream;
  }
  return patch;
}

/** 草稿相对原值是否有实质变化（两侧同形归一后比较，trim/去重不产生假脏）。 */
export function isDraftDirty(
  draft: ModelDraft,
  value: ModelDraft,
  features: ModelFeatures = {},
): boolean {
  const a = JSON.stringify(buildModelPatch(draft, value, features));
  const b = JSON.stringify(buildModelPatch(value, value, features));
  return a !== b;
}
