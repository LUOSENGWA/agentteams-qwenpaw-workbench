// v0.5.0-beta.12: 模型选择目录（自 dashboard model-catalog / model-bindings 移植）。
//
// 语义对照（dashboard 同源，已对 AgentTeams v1.2.0 generator.go 校验）：
// - configured = 经现有 Higress AI route + provider 可解析的请求模型 alias；
// - builtin = 官方内置 alias（16 个），选择后仍需对应路由映射才能真正转发；
// - 自由输入走通配路由（保留 9/2 写前校验：拒路径/URL/空格）。
//
// 数据源 = 插件 Higress 面代理（/gateway/ai-routes + /gateway/ai-providers，消费
// admin 密码模式持有的 Console 会话）；无会话/不可达 → available=false →
// 调用方隐藏 alias 层（SGLang 在服列表 + Worker 现值 + 自由输入不受影响）。

/** Higress AI Route（插件只读消费的最小子集，形状同 dashboard AiRoute）。 */
export interface AiRouteLite {
  name: string;
  upstreams: {
    provider: string;
    weight?: number;
    modelMapping?: Record<string, string>;
  }[];
  modelPredicates?: { matchType: string; matchValue: string }[];
}

/** Higress LLM Provider（最小子集：name + rawConfigs.modelMapping）。 */
export interface LlmProviderLite {
  name: string;
  rawConfigs?: Record<string, unknown>;
}

export interface ModelBindingLite {
  requestModelAlias: string;
  routeName: string;
  providerName: string;
  targetModel: string;
  available: boolean;
  conflict?: boolean;
  passthrough?: boolean;
}

export interface ModelSelectionOption {
  alias: string;
  kind: "builtin" | "configured";
  binding?: ModelBindingLite;
}

/** AgentTeams v1.2.0 内置请求模型 alias（16 个，对齐 controller generator.go）。
 *  选择一个内置 alias 只是命名请求模型；实际转发仍需匹配的路由映射。 */
export const BUILTIN_MODEL_ALIASES: readonly string[] = [
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5-mini",
  "gpt-5-nano",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "qwen3.6-plus",
  "qwen3.5-plus",
  "deepseek-chat",
  "deepseek-reasoner",
  "kimi-k2.5",
  "glm-5",
  "MiniMax-M2.7",
  "MiniMax-M2.7-highspeed",
  "MiniMax-M2.5",
];

/** v0.5.0-beta.12（9/10 装验实报：Higress Console 建的 deepseek-v4-pro 自定义
 *  模型不见）：精确匹配 predicate 的 matchType 有**两种写法**——dashboard 建
 *  路由写 `EXACT`（models-section.tsx 下拉），Higress Console 原生建路由写
 *  `EQUAL`（活体数据三条路由全是 EQUAL）。此前只收 EXACT → Console 建
 *  的路由 alias 全部漏收 → alias 层空。两种都收（严格放宽，PRE=前缀另路）。 */
function isExactMatchType(matchType: string | undefined): boolean {
  return matchType === "EXACT" || matchType === "EQUAL";
}

function matchesPattern(value: string, pattern: string): boolean {
  if (!pattern.includes("*")) return value === pattern;
  const expression = `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")}$`;
  return new RegExp(expression).test(value);
}

function routeMatchesAlias(route: AiRouteLite, alias: string): boolean {
  const predicates = route.modelPredicates ?? [];
  if (predicates.length === 0) return true;
  return predicates.some((predicate) => {
    const raw = predicate.matchValue;
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) return false;
    if (predicate.matchType === "PRE") {
      const prefix = value.replace(/\*+$/, "");
      return Boolean(prefix) && alias.startsWith(prefix);
    }
    return matchesPattern(alias, value);
  });
}

// Higress ai-proxy / model-mapper 语义：
//   - 精确 key 优先于通配 key；
//   - `*` 是兜底通配（`gpt-3-*` 式前缀也匹配）；
//   - 目标为 "" = 保留原请求模型名（passthrough）；
//   - 完全无映射 = 原样转发请求模型名；
//   - 有映射但无匹配 key = 请求失败。
function resolveTargetModel(
  mapping: Record<string, string> | undefined,
  alias: string,
): { target: string; passthrough: boolean } {
  if (!mapping) return { target: alias, passthrough: true };
  const exact = mapping[alias];
  if (typeof exact === "string") {
    const trimmed = exact.trim();
    return trimmed ? { target: trimmed, passthrough: false } : { target: alias, passthrough: true };
  }
  const matchedPattern = Object.keys(mapping).find((p) => matchesPattern(alias, p));
  if (matchedPattern !== undefined) {
    const value = mapping[matchedPattern];
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed ? { target: trimmed, passthrough: false } : { target: alias, passthrough: true };
  }
  return { target: "", passthrough: false };
}

function normalizeMapping(mapping: unknown): Record<string, string> | undefined {
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(mapping as Record<string, unknown>)) {
    if (typeof value === "string") result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function providerModelMapping(
  provider: LlmProviderLite | undefined,
): Record<string, string> | undefined {
  return normalizeMapping(provider?.rawConfigs?.modelMapping);
}

function collectAllAliases(
  instanceAliases: string[],
  routes: AiRouteLite[],
  providers: LlmProviderLite[],
): Set<string> {
  const aliases = new Set<string>();
  for (const alias of instanceAliases) {
    if (typeof alias === "string" && alias.trim()) aliases.add(alias.trim());
  }
  for (const route of routes) {
    for (const upstream of route.upstreams) {
      const mapping = normalizeMapping(upstream.modelMapping);
      if (mapping) {
        for (const key of Object.keys(mapping)) {
          if (key && !key.includes("*") && !key.startsWith("~")) aliases.add(key);
        }
      }
    }
    for (const predicate of route.modelPredicates ?? []) {
      if (isExactMatchType(predicate.matchType)) {
        const alias = typeof predicate.matchValue === "string" ? predicate.matchValue.trim() : "";
        if (alias && !alias.includes("*") && !alias.startsWith("~")) aliases.add(alias);
      }
    }
  }
  for (const provider of providers) {
    const mapping = providerModelMapping(provider);
    if (mapping) {
      for (const key of Object.keys(mapping)) {
        if (key && !key.includes("*") && !key.startsWith("~")) aliases.add(key);
      }
    }
  }
  return aliases;
}

export function buildModelBindings(
  aliases: string[],
  routes: AiRouteLite[],
  providers: LlmProviderLite[],
): ModelBindingLite[] {
  const providersByName = new Map(providers.map((p) => [p.name, p]));
  const requestedAliases = new Set(
    aliases
      .filter((a): a is string => typeof a === "string")
      .map((a) => a.trim())
      .filter(Boolean),
  );
  const allAliases = collectAllAliases(aliases, routes, providers);
  const seen = new Set<string>();
  let bindings: ModelBindingLite[] = [];
  for (const route of routes) {
    const routeAliases = [...allAliases].filter((a) => routeMatchesAlias(route, a));
    for (const upstream of route.upstreams) {
      const provider = providersByName.get(upstream.provider);
      const providerMapping = providerModelMapping(provider);
      for (const requestModelAlias of routeAliases) {
        const routeMapping = normalizeMapping(upstream.modelMapping);
        const mapping = routeMapping ?? providerMapping;
        const resolved = resolveTargetModel(mapping, requestModelAlias);
        const targetModel = resolved.passthrough ? requestModelAlias : resolved.target;
        const isPassthrough =
          resolved.passthrough &&
          (!routeMapping || Object.keys(routeMapping).length === 0) &&
          (!route.modelPredicates || route.modelPredicates.length === 0);
        const binding: ModelBindingLite = {
          requestModelAlias,
          routeName: route.name,
          providerName: upstream.provider,
          targetModel,
          available: !isPassthrough && Boolean(provider && targetModel),
          passthrough: isPassthrough,
        };
        const key = `${binding.requestModelAlias}\u0000${binding.routeName}\u0000${binding.providerName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        bindings.push(binding);
      }
    }
  }
  // 同一 alias 已有可用绑定时，丢掉不可解析行（onboarding 默认路由兜底匹配）。
  const availableAliases = new Set(
    bindings.filter((b) => b.available).map((b) => b.requestModelAlias),
  );
  bindings = bindings.filter((b) => b.available || !availableAliases.has(b.requestModelAlias));
  // 冲突检测：同一 alias 绑到多个不同 route。
  const aliasRouteCount = new Map<string, number>();
  for (const b of bindings) {
    if (!b.conflict) {
      aliasRouteCount.set(b.requestModelAlias, (aliasRouteCount.get(b.requestModelAlias) ?? 0) + 1);
    }
  }
  for (const b of bindings) {
    const count = aliasRouteCount.get(b.requestModelAlias) ?? 0;
    b.conflict = count > 1;
  }
  for (const requestModelAlias of requestedAliases) {
    if (!bindings.some((b) => b.requestModelAlias === requestModelAlias)) {
      bindings.push({
        requestModelAlias,
        routeName: "",
        providerName: "",
        targetModel: "",
        available: false,
      });
    }
  }
  return bindings.sort(
    (l, r) =>
      l.requestModelAlias.localeCompare(r.requestModelAlias) ||
      l.routeName.localeCompare(r.routeName) ||
      l.providerName.localeCompare(r.providerName),
  );
}

/** 可解析的请求模型 alias 列表（EXACT predicate + 精确 mapping key，含 provider 级
 *  mapping——ai-proxy 用请求模型名做 key，provider-only mapping 也必须可选）。 */
export function listAvailableRequestModelAliases(
  routes: AiRouteLite[],
  providers: LlmProviderLite[],
): ModelBindingLite[] {
  const aliases = new Set<string>();
  for (const route of routes) {
    for (const predicate of route.modelPredicates ?? []) {
      const alias = typeof predicate.matchValue === "string" ? predicate.matchValue.trim() : "";
      if (isExactMatchType(predicate.matchType) && alias && !alias.includes("*") && !alias.startsWith("~")) {
        aliases.add(alias);
      }
    }
    for (const upstream of route.upstreams) {
      for (const alias of Object.keys(upstream.modelMapping ?? {})) {
        if (alias && !alias.includes("*") && !alias.startsWith("~")) aliases.add(alias);
      }
    }
  }
  for (const provider of providers) {
    const mapping = providerModelMapping(provider);
    if (!mapping) continue;
    for (const alias of Object.keys(mapping)) {
      if (alias && !alias.includes("*") && !alias.startsWith("~")) aliases.add(alias);
    }
  }
  return buildModelBindings([...aliases], routes, providers).filter((b) => b.available);
}

/** 选择器选项 = configured（route 可解析，带绑定详情）∪ builtin（官方 16，去重）。 */
export function buildModelSelectionOptions(
  routes: AiRouteLite[],
  providers: LlmProviderLite[],
): ModelSelectionOption[] {
  const available = listAvailableRequestModelAliases(routes, providers);
  const configuredAliases = new Set(available.map((b) => b.requestModelAlias));
  const options: ModelSelectionOption[] = [
    ...available.map((b) => ({ alias: b.requestModelAlias, kind: "configured" as const, binding: b })),
    ...BUILTIN_MODEL_ALIASES.filter((alias) => !configuredAliases.has(alias)).map((alias) => ({
      alias,
      kind: "builtin" as const,
    })),
  ];
  return options.sort((l, r) => l.alias.localeCompare(r.alias));
}
