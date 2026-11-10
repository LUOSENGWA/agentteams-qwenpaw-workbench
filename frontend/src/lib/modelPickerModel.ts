// modelPickerModel — ModelPicker 的纯逻辑（可在 node/vitest 里直接 import，
// 不碰 window.QwenPaw.host）。组件只做渲染与事件。

export interface ModelPickerProvider {
  name: string;
  /** 展示名（缺省 = name）。name 仍是回传的稳定标识（如「跟随 Worker」哨兵值）。 */
  label?: string;
  models?: string[];
  /** 禁用该 Provider 选项（如「跟随子代理」在子代理模型未设置时）。 */
  disabled?: boolean;
  /** 可选分组标签（调用方 i18n 化后传入）。任一 Provider 带 group →
   * ModelPicker 渲染 Antd 分组 options；全不带 = 既有平铺选项。 */
  group?: string;
}

/** 一个 Provider 分组（ModelPicker 分组 options 的纯逻辑输入，渲染归组件）。 */
export interface ModelPickerProviderGroup {
  /** 分组标签（空串 = 无分组，平铺渲染）。 */
  label: string;
  providers: ModelPickerProvider[];
}

/** 所选 Provider 的模型；provider 为空或该 provider 未声明模型表 → 全量去重。 */
export function modelOptionsForProvider(
  providers: ModelPickerProvider[],
  provider: string,
): string[] {
  const all: string[] = [];
  const seen = new Set<string>();
  for (const p of providers) {
    for (const m of p.models ?? []) {
      if (!seen.has(m)) {
        seen.add(m);
        all.push(m);
      }
    }
  }
  if (!provider) return all;
  const hit = providers.find((p) => p.name === provider);
  if (!hit || !hit.models || hit.models.length === 0) return all;
  return hit.models;
}

/** 换 Provider 后应保留的模型：不属于新 Provider 的候选 → 清空。 */
export function keepModelForProvider(
  providers: ModelPickerProvider[],
  provider: string,
  model: string,
): string {
  if (!model) return "";
  return modelOptionsForProvider(providers, provider).includes(model) ? model : "";
}

/** Provider 有序分组（ModelPicker 分组 options 的单一来源）：
 * - 无任何 Provider 带 group → 返回单个未分组列表（label ""，平铺渲染，
 *   主选择器等既有调用方行为不变）；
 * - 任一带 group → 按首次出现顺序返回分组；未带 group 的 Provider 归入
 *   defaultGroupLabel 一个组（缺省 "" = 稳定空标签兜底，不并入其他组）。
 * 成员顺序 = 原列表顺序（组间、组内均保持）。 */
export function groupModelPickerProviders(
  providers: ModelPickerProvider[],
  defaultGroupLabel = "",
): ModelPickerProviderGroup[] {
  if (!providers.some((p) => p.group !== undefined)) {
    return [{ label: "", providers }];
  }
  const order: string[] = [];
  const byLabel = new Map<string, ModelPickerProvider[]>();
  for (const p of providers) {
    const label = p.group ?? defaultGroupLabel;
    const list = byLabel.get(label);
    if (list) list.push(p);
    else {
      byLabel.set(label, [p]);
      order.push(label);
    }
  }
  return order.map((label) => ({ label, providers: byLabel.get(label)! }));
}
