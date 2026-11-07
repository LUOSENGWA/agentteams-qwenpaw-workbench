// modelPanelWiring.ts — 团队设置 × 统一模型弹窗接线纯函数层
// （CrdCfgForm 行值 ↔ ModelSettingsModal 草稿的映射，视图无关）。
//
// 本文件**零运行时 import**（仅 import type，strip-types 下擦除）→
// 可被 `node --experimental-strip-types` 直接 import 单测（见
// tests/team-model-panel.test.ts），无需 esbuild bundle / window shim。
//
// 语义（与改造前行内 AutoComplete 数据源同源，零新请求路径）：
// - Provider 目录 = 真实 Higress provider（modelMapping 键 + 路由绑定
//   alias，通配键 "*" / "~" 前缀与 modelCatalog 同口径剔除）+
//   「无 Provider（在服+在用）」哨兵组（哨兵组数据源 = 原 AutoComplete
//   候选并集，保住原入口对在服模型 / builtin alias 的自由选择能力）；
// - 预填（draftFromRow）：provider 空 → alias 绑定回填（modelUnion
//   providerForModel 同口径）→ 哨兵（在服模型 / builtin alias 不归属
//   任何 Provider）；
// - 写回（rowFromDraft）：哨兵 → 所选模型的 alias 绑定（无绑定 = ""
//   = 不发 provider，PUT 合并语义不变）；真实 provider 原样透传。
//
// providerOfAlias 为 modelUnion.providerForModel 的同口径副本（该模块
// 顶层 import React 宿主，无法被单测直接引入；口径变更时须同步：
// alias → binding.providerName，未命中 = ""）。
import type { LlmProviderLite, ModelSelectionOption } from "../modelCatalog";
import type { ModelDraft, ProviderOption } from "../lib/modelDraft";

/** 「无 Provider（在服+在用）」哨兵组名（同时是下拉展示文案；
 * 写回时映射为 alias 绑定 / 空）。不与真实 Higress provider 名冲突。 */
export const LOCAL_PROVIDER = "无 Provider（在服 + 在用）";

/** alias → Higress providerName（仅 configured binding；builtin/local → ""）。 */
export function providerOfAlias(
  gateway: ModelSelectionOption[],
  model: string,
): string {
  const hit = gateway.find((o) => o.alias === (model || "").trim());
  return hit?.binding?.providerName || "";
}

/** 行 / 批量当前值 → 弹窗预填草稿。
 * provider 解析序：已刷 provider（画笔值）> alias 绑定 > 哨兵。 */
export function draftFromRow(
  model: string | undefined,
  provider: string | undefined,
  gateway: ModelSelectionOption[],
): ModelDraft {
  const m = (model || "").trim();
  const p = (provider || "").trim();
  return {
    provider: p || providerOfAlias(gateway, m) || LOCAL_PROVIDER,
    model: m,
  };
}

/** 弹窗保存 patch → 行 / 批量写回值。
 * 哨兵 → 所选模型 alias 绑定（无绑定 = ""，PUT 合并语义：provider
 * 不下发 = 不改）；真实 provider 原样透传（成对刷写，C1a-1 同语义）。 */
export function rowFromDraft(
  patch: Pick<ModelDraft, "model" | "provider">,
  gateway: ModelSelectionOption[],
): { model: string; provider: string } {
  const model = (patch.model || "").trim();
  const p = (patch.provider || "").trim();
  return {
    model,
    provider: p === LOCAL_PROVIDER ? providerOfAlias(gateway, model) : p,
  };
}

/** 弹窗 Provider 目录：真实 provider（modelMapping 键 + 路由绑定 alias）
 * + 哨兵组（localModels = 原 AutoComplete 候选并集，保原入口自由选能力）。 */
export function buildLocalProviderOptions(
  providers: LlmProviderLite[],
  gateway: ModelSelectionOption[],
  localModels: string[],
): ProviderOption[] {
  const byName = new Map<string, string[]>();
  const push = (p: string, m: string): void => {
    const v = (m || "").trim();
    if (!p || !v) return;
    const arr = byName.get(p) ?? [];
    if (!arr.includes(v)) arr.push(v);
    byName.set(p, arr);
  };
  for (const p of providers) {
    const mapping = p.rawConfigs?.modelMapping;
    if (mapping && typeof mapping === "object" && !Array.isArray(mapping)) {
      for (const k of Object.keys(mapping as Record<string, unknown>)) {
        // 通配 / passthrough 键不是具体模型名（与 modelCatalog 同口径）。
        if (k.includes("*") || k.startsWith("~")) continue;
        push(p.name, k);
      }
    }
  }
  for (const o of gateway) {
    if (o.binding?.providerName) push(o.binding.providerName, o.alias);
  }
  const local: string[] = [];
  for (const m of localModels) {
    const v = (m || "").trim();
    if (v && !local.includes(v)) local.push(v);
  }
  const out: ProviderOption[] = [
    { name: LOCAL_PROVIDER, models: local },
  ];
  for (const [name, models] of byName) out.push({ name, models });
  return out;
}
