/**
 * 模型并集共享逻辑（，/）。
 *
 * 纯函数（校验/合并/分组）从 CrdManage 抽出，供 CrdManage 三入口
 * （建 Worker 弹窗/建队行/团队配置内联）与 WorkerManage ManagerTable
 * （Manager 模型选择）共用——同一套候选与校验，行为零分叉。
 *
 * 候选 = SGLang 在服 ∪ 在用模型（Worker/Manager 已用）∪ 网关 alias
 * （configured+builtin；仅 admin 密码模式持有 Higress Console 会话时可用），
 * 剔除路径形态值（「/models」历史缺陷硬规则：候选列表自身被污染时
 * 也必须拦得住）。
 *
 * 注意：React 一律经 host.React（插件零裸 import 教训）。
 */
import type * as ReactNS from "react";
import {
  fetchGatewayAiProviders,
  fetchGatewayAiRoutes,
  fetchSglangModels,
} from "./api";
import {
  buildModelSelectionOptions,
  type AiRouteLite,
  type LlmProviderLite,
  type ModelSelectionOption,
} from "./modelCatalog";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

type ModelVerdict = {
  level: "ok" | "warn" | "error";
  /** warn 细分：list=不在在服列表；nocands=候选列表不可用（未校验）。 */
  reason?: "list" | "nocands";
};

/** 路径/URL/带空格形态 = 模型名不可能是的（models 历史缺陷硬规则，恒生效）。 */
export function isPathLikeModel(v: string): boolean {
  return v.startsWith("/") || v.includes("://") || /\s/.test(v);
}

/** model 字段写前校验（各入口共用）。留空=显式「跟随集群默认」（ok）。 */
export function validateModelValue(
  raw: string,
  candidates: string[],
): ModelVerdict {
  const v = (raw || "").trim();
  if (!v) return { level: "ok" };
  if (isPathLikeModel(v)) return { level: "error" };
  if (candidates.length > 0 && !candidates.includes(v)) {
    return { level: "warn", reason: "list" };
  }
  if (candidates.length === 0) {
    return { level: "warn", reason: "nocands" };
  }
  return { level: "ok" };
}

/** 校验文案（tr 可及范围内调用）。 */
export function modelVerdictText(
  tr: (s: string, vars?: Record<string, string | number>) => string,
  v: ModelVerdict,
  value: string,
  candidates: string[],
): string {
  if (v.level === "error") {
    return tr("模型名不能是路径/URL 或含空格（如 /models——历史缺陷值）");
  }
  if (v.level === "warn" && v.reason === "list") {
    return tr("不在在服列表（可用：{list}）", {
      list: `${candidates.slice(0, 8).join(", ")}${candidates.length > 8 ? "…" : ""}`,
    });
  }
  if (v.level === "warn" && v.reason === "nocands") {
    return tr("在服模型列表不可用（SGLang 未启用且无在服 Worker）：未校验，创建后须人工确认");
  }
  if (!(value || "").trim()) {
    return tr("留空=不改 / 新建跟随集群默认");
  }
  return tr("命中在服模型");
}

/** 合并候选（纯函数——可测）：SGLang ∪ 在用 ∪ 网关 alias，去重 + 剔除路径形态。 */
function mergeModelCandidates(
  sglangModels: string[],
  usedModels: string[],
  gatewayOpts: ModelSelectionOption[] | null,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (m: string) => {
    const v = (m || "").trim();
    if (!v || isPathLikeModel(v)) return;
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  };
  sglangModels.forEach(push);
  usedModels.forEach(push);
  // 网关 alias（configured+builtin）同为合法 model 值（经网关路由转发）——
  // 入候选，写前校验不误报「不在在服列表」。
  gatewayOpts?.forEach((o) => push(o.alias));
  return out;
}

type ModelGroupOption = { value: string; label?: string };
type ModelOptionGroup = {
  value: string;
  label: string;
  options: ModelGroupOption[];
};

/** AutoComplete 下拉（纯函数——可测）：Higress Console 会话可用时三组（Higress alias 可
 * 解析 / 内置 alias / 在服+在用）；不可用=平铺列表。value 恒为 alias 本身。
 * export：crdmanage/useModelCatalog 同款三组构建复用同一实现（不漂移）。 */
export function buildModelOptionGroups(
  candidates: string[],
  gatewayOpts: ModelSelectionOption[] | null,
  tr: (s: string, vars?: Record<string, string | number>) => string,
): (ModelGroupOption[] | ModelOptionGroup[]) {
  if (!gatewayOpts || gatewayOpts.length === 0) {
    return candidates.map((m) => ({ value: m }));
  }
  const aliasSet = new Set(gatewayOpts.map((o) => o.alias));
  const rest = candidates
    .filter((m) => !aliasSet.has(m))
    .map((m) => ({ value: m }));
  const groups: ModelOptionGroup[] = [];
  const configured = gatewayOpts.filter((o) => o.kind === "configured");
  const builtin = gatewayOpts.filter((o) => o.kind === "builtin");
  if (configured.length > 0) {
    groups.push({
      value: "gateway-configured",
      label: tr("Higress alias（路由可解析）"),
      options: configured.map((o) => ({
        value: o.alias,
        label: o.binding?.routeName
          ? `${o.alias} → ${o.binding.routeName}/${o.binding.targetModel}`
          : o.alias,
      })),
    });
  }
  if (builtin.length > 0) {
    groups.push({
      value: "gateway-builtin",
      label: tr("Higress 内置 alias（需配路由映射）"),
      options: builtin.map((o) => ({ value: o.alias })),
    });
  }
  if (rest.length > 0) {
    groups.push({ value: "local", label: tr("在服+在用"), options: rest });
  }
  return groups;
}

interface ModelUnionState {
  /** 平铺候选（路径形态已剔除）——validateModelValue 用。 */
  candidates: string[];
  /** AutoComplete options（三组或平铺）。 */
  options: ModelGroupOption[] | ModelOptionGroup[];
  /** 网关 alias 层可用（Higress Console 会话持有）。 */
  gatewayAvailable: boolean;
  /** 网关 alias 拉取是否完成（false=仍在加载，提示不显示）。 */
  gatewayLoaded: boolean;
  /** 网关原始选项（含 alias→binding.providerName）——选 alias 时回填 provider。 */
  gatewayOptions: ModelSelectionOption[];
  /** Higress LLM Provider 列表（provider 下拉；无会话=空）。 */
  providers: LlmProviderLite[];
  /** 重新拉取 SGLang 在服列表（弹窗打开时刷新用）。 */
  refetchSglang: () => void;
}

/** alias → Higress providerName（仅 configured binding；builtin/local → ""）。
 *
 * Worker/Manager CR 的 model 是请求 alias，真正转发由 modelProvider（APIG
 * Model API 名）决定。多 provider 部署下只改 model 不改 provider = 仍走旧
 * provider（用户「选了没用」的根因）。 */
export function providerForModel(
  options: ModelSelectionOption[],
  model: string,
): string {
  const hit = options.find((o) => o.alias === model.trim());
  return hit?.binding?.providerName || "";
}

/** C1a-1 provider-first：按所选 Provider 过滤模型候选列表（纯函数——可测）。
 *
 * - provider 为空 → 原样返回（跟随默认，不过滤）；
 * - provider 非空 → Higress alias 组只保留 gatewayOptions 中
 *   binding.providerName 为该 provider 的 alias（可路由 alias 组 / 该
 *   provider 的 builtin alias 组，保持原分组格式与标签）；「在服+在用」
 *   组（local，不属于任何网关 Provider）恒原样保留。
 * - 平铺列表（无 alias 组，纯在服+在用层）→ 保留非网关 alias 条目 +
 *   命中该 provider 的条目。
 * builtin alias 无 binding（不属于任何 Provider）→ 其所在组在过滤结果中
 * 默认整组落空（AutoComplete 不限于下拉，仍可自由输入）。 */
export function filterModelOptionsByProvider(
  allOptions: ModelGroupOption[] | ModelOptionGroup[],
  gatewayOptions: ModelSelectionOption[],
  provider: string,
): ModelGroupOption[] | ModelOptionGroup[] {
  const p = (provider || "").trim();
  if (!p) return allOptions;
  const allowed = new Set(
    gatewayOptions
      .filter((o) => o.binding?.providerName === p)
      .map((o) => o.alias),
  );
  const gatewayAliases = new Set(gatewayOptions.map((o) => o.alias));
  const isGrouped = (
    a: ModelGroupOption | ModelOptionGroup,
  ): a is ModelOptionGroup => Array.isArray((a as ModelOptionGroup).options);
  if (allOptions.some((o) => isGrouped(o))) {
    const out: ModelOptionGroup[] = [];
    for (const g of allOptions as ModelOptionGroup[]) {
      if (!Array.isArray(g.options)) continue;
      // 在服+在用：不属于任何网关 Provider → 恒保留。
      if (g.value === "local") {
        out.push(g);
        continue;
      }
      // Higress alias 组：只保留 binding 指向该 provider 的 alias。
      const kept = g.options.filter((o) => allowed.has(o.value));
      if (kept.length > 0) out.push({ ...g, options: kept });
    }
    return out;
  }
  return (allOptions as ModelGroupOption[]).filter(
    (o) => allowed.has(o.value) || !gatewayAliases.has(o.value),
  );
}

/** C1a-1 provider-first：模型 / Provider 失配判定（纯函数——可测）。
 * model 是 configured alias 且其 binding 的 Provider ≠ 所选 provider → true
 * （UI 仅提示、不阻塞保存——按现状保存，实际转发以 Provider 为准）；
 * 在服模型 / builtin alias 不属于任何网关 Provider → false；
 * 任一为空 → false（未选 Provider 时不做失配判定）。 */
export function providerModelMismatch(
  gatewayOptions: ModelSelectionOption[],
  model: string,
  provider: string,
): boolean {
  const m = (model || "").trim();
  const p = (provider || "").trim();
  if (!m || !p) return false;
  const boundProviders = gatewayOptions
    .filter((o) => o.alias === m && o.kind === "configured")
    .map((o) => o.binding?.providerName ?? "");
  if (boundProviders.length === 0) return false;
  return !boundProviders.includes(p);
}

/** ：
 * Higress Console {code, data: ...} 信封解包 + listKey 提取——CrdManage
 * 旧版 inline 副本提升为共享（同源零分叉教训）。ManagerTable hook
 * 原 ad-hoc 提取漏信封层 + providers 取错键（.data 应为 .providers）
 * → routes/providers 恒空 → alias 组恒缺失=「Manager alias 没解决」根因。
 * 诊断可见性：会话在但提取 0 路由/0 alias 时打日志（形状变更秒定位）。 */
export function extractGatewayLists(
  routesData: unknown,
  providersData: unknown,
): { routesList: AiRouteLite[]; providersList: LlmProviderLite[] } {
  const unwrap = (
    data: unknown,
    listKey: "routes" | "providers",
  ): unknown[] => {
    const d =
      data && typeof data === "object" && "data" in data
        ? (data as { data?: unknown }).data
        : data;
    if (Array.isArray(d)) return d;
    if (d && typeof d === "object") {
      const list = (d as Record<string, unknown>)[listKey];
      if (Array.isArray(list)) return list;
    }
    return [];
  };
  const routesList = unwrap(routesData, "routes") as AiRouteLite[];
  const providersList = unwrap(
    providersData,
    "providers",
  ) as LlmProviderLite[];
  if (routesList.length === 0 || providersList.length === 0) {
    console.warn(
      "[agentteams] gateway alias: routes=",
      routesList.length,
      "providers=",
      providersList.length,
      "raw routes.data keys=",
      routesData && typeof routesData === "object"
        ? Object.keys(routesData as object)
        : typeof routesData,
    );
  }
  return { routesList, providersList };
}

/**
 * 模型并集 hook（起 ManagerTable 与 CrdManage 同源）。
 * @param usedModels 在用模型（Worker/Manager 已用值——「在用」层数据源）
 */
export function useModelUnionOptions(
  usedModels: string[],
  tr: (s: string, vars?: Record<string, string | number>) => string,
): ModelUnionState {
  const [sglangModels, setSglangModels] = React.useState<string[]>([]);
  const [gatewayOpts, setGatewayOpts] = React.useState<
    ModelSelectionOption[] | null
  >(null);
  const [providers, setProviders] = React.useState<LlmProviderLite[]>([]);
  const [gatewayLoaded, setGatewayLoaded] = React.useState(false);

  const loadSglang = React.useCallback(() => {
    void fetchSglangModels()
      .then(setSglangModels)
      .catch(() => setSglangModels([])); // 模块未启用 → 空列表（自由输入降级）
  }, []);

  const loadGateway = React.useCallback(() => {
    void (async () => {
      try {
        const [routes, providers] = await Promise.all([
          fetchGatewayAiRoutes(),
          fetchGatewayAiProviders(),
        ]);
        if (!routes.available || !providers.available) {
          setGatewayOpts(null); // 无 Higress Console 会话=正常降级（token 模式）
          setProviders([]);
          return;
        }
        // 共享解包（原 ad-hoc 提取漏信封+错键=alias 恒空根因）。
        const { routesList, providersList } = extractGatewayLists(
          routes.data,
          providers.data,
        );
        setGatewayOpts(buildModelSelectionOptions(routesList, providersList));
        setProviders(providersList);
      } catch {
        setGatewayOpts(null); // 不可达/网络错误 → 与无会话同路径
        setProviders([]);
      } finally {
        setGatewayLoaded(true);
      }
    })();
  }, []);

  React.useEffect(() => {
    loadSglang();
    loadGateway();
  }, [loadSglang, loadGateway]);

  const candidates = React.useMemo(
    () => mergeModelCandidates(sglangModels, usedModels, gatewayOpts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sglangModels, JSON.stringify(usedModels), gatewayOpts],
  );

  const options = React.useMemo(
    () => buildModelOptionGroups(candidates, gatewayOpts, tr),
    [candidates, gatewayOpts, tr],
  );

  return {
    candidates,
    options,
    gatewayOptions: gatewayOpts || [],
    providers,
    gatewayAvailable: Boolean(gatewayOpts && gatewayOpts.length > 0),
    gatewayLoaded,
    refetchSglang: loadSglang,
  };
}
