// CrdManage 拆分（QC-196 方案 §5.2）· G 簇 hook：在服模型候选 / 网关
// alias / SOUL 上传——三入口（建 Worker 弹窗/建队行/配置团队行）共享的
// 模型数据源。函数体逐字自 components/CrdManage.tsx 搬移（零改写）。

import type * as ReactNS from "react";

import {
  fetchGatewayAiProviders,
  fetchGatewayAiRoutes,
  type AdminData,
} from "../api";
import {
  buildModelSelectionOptions,
  type ModelSelectionOption,
} from "../modelCatalog";
import { extractGatewayLists, isPathLikeModel } from "../modelUnion";
import { soulBudget, soulLines } from "./helpers";
import type { TrFn } from "./types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

interface UseModelCatalogArgs {
  /** 在服 Workers（候选「在用」层 = 其已用模型）。 */
  workers: AdminData["workers"];
  tr: TrFn;
}

export function useModelCatalog({ workers, tr }: UseModelCatalogArgs) {
  /** 在服模型候选（SGLang /v1/models 代理；空=模块未启用→自由输入）。 */
  const [modelOpts, setModelOpts] = React.useState<string[]>([]);
  /** Higress 面 alias 候选（configured+builtin，Higress Console 经
 * admin 密码模式会话取）；null=无会话/不可用→alias 层隐藏（SGLang∪在用
 * +自由输入不受影响）。 */
  const [gatewayOpts, setGatewayOpts] = React.useState<
    ModelSelectionOption[] | null
  >(null);
  const [gatewayLoaded, setGatewayLoaded] = React.useState(false);
  /** 网关 alias 拉取（一次性；available=false=无 Console
 * 会话，属正常降级非错误）。 */
  const loadGatewayAliases = React.useCallback(async () => {
    try {
      const [routes, providers] = await Promise.all([
        fetchGatewayAiRoutes(),
        fetchGatewayAiProviders(),
      ]);
      if (!routes.available || !providers.available) {
        setGatewayOpts(null);
        return;
      }
      // 起解包逻辑（{code,data} 信封 + providers 键名，
      // 对齐 dashboard unwrapData 实证）；提升为 modelUnion
      // extractGatewayLists 共享（ManagerTable hook 原 ad-hoc 副本漏信封
      // + 错键=alias 恒空根因，同源零分叉）。
      const { routesList, providersList } = extractGatewayLists(
        routes.data,
        providers.data,
      );
      setGatewayOpts(buildModelSelectionOptions(routesList, providersList));
    } catch {
      setGatewayOpts(null); // 不可达/网络错误 → 与无会话同路径
    } finally {
      setGatewayLoaded(true);
    }
  }, []);
  /** 最终候选 = SGLang ∪ 在服 Worker 已用模型，剔除路径形态
 * （实锤：SGLang 在服列表本身可被污染出 "/models"——下拉项必须过滤，
 * 否则候选列表成为毒源，成员校验形同虚设）。 */
  const modelCandidates = React.useMemo(() => {
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
    modelOpts.forEach(push);
    workers.forEach((w) => push(w.model));
    // 网关 alias（configured+builtin）同为合法 model 值
    // （经网关路由转发）——入候选，写前校验不误报「不在在服列表」。
    gatewayOpts?.forEach((o) => push(o.alias));
    return out;
  }, [modelOpts, workers, gatewayOpts]);
  /** AutoComplete 下拉——Higress Console 会话可用时三组（Higress alias
 * 可解析 / 内置 alias / 在服+在用）；不可用=原平铺列表。value 恒为 alias 本身。 */
  const modelOptions = React.useMemo(() => {
    if (!gatewayOpts || gatewayOpts.length === 0) {
      return modelCandidates.map((m) => ({ value: m }));
    }
    const aliasSet = new Set(gatewayOpts.map((o) => o.alias));
    const rest = modelCandidates
      .filter((m) => !aliasSet.has(m))
      .map((m) => ({ value: m }));
    const groups: {
      value: string;
      label: string;
      options: { value: string; label?: string }[];
    }[] = [];
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
  }, [gatewayOpts, modelCandidates, tr]);
  /** 现有 Worker CR 的现值（行选中预填 / 保存 diff 用）。 */
  const modelOf = React.useCallback(
    (n: string) => workers.find((w) => w.name === n)?.model || "",
    [workers],
  );
  /** SOUL 文件上传：异步读文本 → onLoaded 回调填入，行数超预算告警不阻断。 */
  const loadSoulFile = React.useCallback(
    (
      file: File | null | undefined,
      role: string,
      onLoaded: (text: string) => void,
    ) => {
      if (!file) return;
      if (file.size > 200 * 1024) {
        antd.message.warning(tr("SOUL 文件过大（>200KB），已忽略"));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || "");
        const lines = soulLines(text);
        if (lines > soulBudget(role)) {
          antd.message.warning(
            tr("SOUL {n} 行，超出预算 {b} 行（team_leader≤250 / worker≤150）——已填入，请自行裁剪", {
              n: lines,
              b: soulBudget(role),
            }),
          );
        }
        onLoaded(text);
      };
      reader.onerror = () => antd.message.error(tr("SOUL 文件读取失败"));
      reader.readAsText(file);
    },
    [tr],
  );

  /** ：gateway alias 此前只在打开配置团队/新建 Worker 弹窗时拉
 * → 建队卡（常驻视图）模型下拉首开必平铺、无 alias 组。挂载即拉一次，
 * 三入口（建队卡行/新建 Worker 弹窗/配置团队行）开屏即有 alias 组。 */
  React.useEffect(() => {
    if (!gatewayLoaded) void loadGatewayAliases();
  }, [gatewayLoaded, loadGatewayAliases]);
  return {
    modelOpts,
    setModelOpts,
    gatewayOpts,
    gatewayLoaded,
    modelCandidates,
    modelOptions,
    modelOf,
    loadGatewayAliases,
    loadSoulFile,
  };
}
