// modelPickerModel — ModelPicker 的纯逻辑（可在 node/vitest 里直接 import，
// 不碰 window.QwenPaw.host）。组件只做渲染与事件。

export interface ModelPickerProvider {
  name: string;
  /** 展示名（缺省 = name）。name 仍是回传的稳定标识（如「跟随 Worker」哨兵值）。 */
  label?: string;
  models?: string[];
  /** 禁用该 Provider 选项（如「跟随子代理」在子代理模型未设置时）。 */
  disabled?: boolean;
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
