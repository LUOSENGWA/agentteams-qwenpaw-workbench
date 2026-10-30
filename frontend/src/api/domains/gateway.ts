// 网关域（/gateway/ai-* + controller /api/v1/gateway/ai-routes）：AI 路由/供应商读写 + 路由目录。

import { requestJson } from "../shared";
import { cachedRequest, invalidateTags } from "../../requestCache";

/** 网关面（Higress Console）列表响应——
 * available=false = 无 Console 会话/不可达（前端优雅降级，非错误）。 */
interface GatewayListResponse {
  available: boolean;
  data: Record<string, unknown> | unknown[] | null;
  reason?: string;
}

/** 网关 AI 路由列表（模型选择 alias 层：alias→route→provider 映射）。
 * 新增 force 形参（默认 false）+ cachedRequest 包裹
 * （gateway/ai-routes，30s，tags ["gateway"]）；写面变更后由调用方
 * invalidateTags(["gateway"]) + force 重取。 */
export async function fetchGatewayAiRoutes(
  force = false,
): Promise<GatewayListResponse> {
  return cachedRequest(
    "gateway/ai-routes",
    30000,
    async () =>
      (await requestJson(
        "/agentteams-proxy/gateway/ai-routes",
      )) as GatewayListResponse,
    { force, tags: ["gateway"] },
  );
}

/** 网关 LLM Provider 列表（alias 可解析性判定用）。
 * 新增 force 形参（默认 false）+ cachedRequest 包裹
 * （gateway/ai-providers，30s，tags ["gateway"]）。 */
export async function fetchGatewayAiProviders(
  force = false,
): Promise<GatewayListResponse> {
  return cachedRequest(
    "gateway/ai-providers",
    30000,
    async () =>
      (await requestJson(
        "/agentteams-proxy/gateway/ai-providers",
      )) as GatewayListResponse,
    { force, tags: ["gateway"] },
  );
}

// ── 网关写面（12.13 P7b）：创建提供商 / 创建路由（Console 会话透传）──
// 与 dashboard models-section 同款字段形状（serializeProviderForm /
// serializeRouteForm 语义），经后端 /gateway/* POST 透传到 Higress Console
// /v1/ai/providers、/v1/ai/routes。写失败时返回 {available:false, detail}。
interface GatewayMutationResponse {
  available: boolean;
  data: unknown;
  reason?: string;
  /** Console 侧错误信息（HTTP 4xx/5xx 时的 message/detail）。 */
  detail?: string;
}

export async function createGatewayAiProvider(
  body: Record<string, unknown>,
): Promise<GatewayMutationResponse> {
  const r = (await requestJson("/agentteams-proxy/gateway/ai-providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })) as GatewayMutationResponse;
  invalidateTags(["gateway"]);
  return r;
}

export async function createGatewayAiRoute(
  body: Record<string, unknown>,
): Promise<GatewayMutationResponse> {
  const r = (await requestJson("/agentteams-proxy/gateway/ai-routes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })) as GatewayMutationResponse;
  invalidateTags(["gateway"]);
  return r;
}

// ── 网关写面（14.4）：编辑/删除提供商 / 编辑/删除路由（Console 会话透传）──
// 与 dashboard higress BFF 同款 Console 端点（v1/ai/{providers,routes}/{name}
// 的 PUT/DELETE）。响应信封同 GatewayMutationResponse（available=false +
// reason/detail 供 UI 分诊；无 Console 会话 = no_console_session 降级提示）。

export async function updateGatewayAiProvider(
  name: string,
  body: Record<string, unknown>,
): Promise<GatewayMutationResponse> {
  const r = (await requestJson(
    `/agentteams-proxy/gateway/ai-providers/${encodeURIComponent(name)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  )) as GatewayMutationResponse;
  invalidateTags(["gateway"]);
  return r;
}

export async function deleteGatewayAiProvider(
  name: string,
): Promise<GatewayMutationResponse> {
  const r = (await requestJson(
    `/agentteams-proxy/gateway/ai-providers/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  )) as GatewayMutationResponse;
  invalidateTags(["gateway"]);
  return r;
}

export async function updateGatewayAiRoute(
  name: string,
  body: Record<string, unknown>,
): Promise<GatewayMutationResponse> {
  const r = (await requestJson(
    `/agentteams-proxy/gateway/ai-routes/${encodeURIComponent(name)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  )) as GatewayMutationResponse;
  invalidateTags(["gateway"]);
  return r;
}

export async function deleteGatewayAiRoute(
  name: string,
): Promise<GatewayMutationResponse> {
  const r = (await requestJson(
    `/agentteams-proxy/gateway/ai-routes/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  )) as GatewayMutationResponse;
  invalidateTags(["gateway"]);
  return r;
}

// ── 模型网关只读路由目录（上游 #1242，Controller 端点，token 鉴权）────
// 与上面的 fetchGatewayAiRoutes（Higress Console 透传，需 admin 会话）不同源：
// 本端点在 Controller 侧（api/v1/gateway/ai-routes），只凭 controller token
// 即可读，token 模式 L1 也能用（结构性数据面）。是「路由目录」非「模型目录」：
// name=网关 /v1 入口名（非模型 ID），一条路由可服务多个模型；upstreams=上游
// provider 及权重；allowedConsumers=被授权在该路由上的 consumer。
interface GatewayRouteUpstream {
  provider: string;
  weight?: number;
}

export interface GatewayRouteInfo {
  name: string;
  upstreams?: GatewayRouteUpstream[];
  allowedConsumers?: string[];
}

export interface GatewayRouteCatalog {
  routes: GatewayRouteInfo[];
  total?: number;
}

/** 模型网关只读路由目录（#1242；Controller 端点，controller token 鉴权，
 * L1-only——L2 调用返 403，调用方需处理权限提示）。60s 缓存（目录/配置类；
 * ModelsTab 挂载拉取 + Console 会话失效时的降级源，无轮询）；
 * 6 个网关写面成功后 invalidateTags(["gateway"]) 覆盖本条目。 */
export function fetchGatewayRouteCatalog(): Promise<GatewayRouteCatalog> {
  return cachedRequest(
    "gateway/route-catalog",
    60_000,
    () =>
      requestJson(
        "/agentteams-proxy/controller/api/v1/gateway/ai-routes",
      ) as Promise<GatewayRouteCatalog>,
    { tags: ["gateway"] },
  );
}
