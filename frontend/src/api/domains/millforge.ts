// 千锻（Millforge）编译/注入域（/agentteams-proxy/millforge*）：
// 源配置 → 导入 → 编译 → 注入 → LLM 二次生成。数据契约 =
// agentteams_connector/millforge_api.py（勿改契约，前端只消费）。
// 嵌入建队表单/团队管理行操作——无独立页面。

import { requestJson } from "../shared";
import { cachedRequest, invalidateTags } from "../../requestCache";

const BASE = "/agentteams-proxy/millforge";

// ── 源配置 ────────────────────────────────────────────────────────

/** GET /millforge/source 响应（custom_url 空 = 按 kind+repo 派生 URL）。 */
export interface MillforgeSource {
  kind: "github" | "gitcode";
  repo: string;
  custom_url: string;
  resolved_url: string;
  updated_at?: string;
}

/** PUT /millforge/source 请求（空字段 = 沿用服务端现值；custom_url 空 = 清空回到派生）。 */
export interface MillforgeSourcePatch {
  kind?: string;
  repo?: string;
  custom_url?: string;
}

/** POST /millforge/import 响应（整包覆盖导入；has_compiler/has_core 决定可用性）。 */
export interface MillforgeImportResult {
  ok: boolean;
  pack: string;
  url: string;
  ref: string;
  commit: string;
  files: number;
  has_compiler: boolean;
  has_core: boolean;
}

// ── pack / INDEX ─────────────────────────────────────────────────

/** INDEX.yaml 四组条目（skeletons/industry/domain/fragments 同构）。 */
export interface MillforgeIndexEntry {
  id: string;
  file: string;
  source?: string;
  applies_to?: string;
  /** domain 条目 → 所属行业（行业→领域级联过滤；旧包 INDEX 无此字段 = 空/缺省 → 回退全显）。 */
  industry?: string;
  budget?: string;
}

/** INDEX 整队组合（teams 段条目；选中后自动填 members 比例/domains）。 */
export interface MillforgeTeamCombo {
  id: string;
  name: string;
  industry: string;
  members: { leader: string; workers: string; critic: string };
  domains: string;
  source: string;
  experimental: string;
}

/** 解析后的 INDEX（teams 段为整队组合列表；null = 该包 INDEX 解析失败）。 */
export interface MillforgeIndex {
  skeletons: MillforgeIndexEntry[];
  industry: MillforgeIndexEntry[];
  domain: MillforgeIndexEntry[];
  fragments: MillforgeIndexEntry[];
  teams: MillforgeTeamCombo[];
}

/** 单个模板包（pack 名 = 仓库 slug；meta=null = 诚实降级仍列出）。 */
export interface MillforgePack {
  pack: string;
  meta: {
    url: string;
    ref: string;
    commit: string;
    imported_at: string;
    files?: string[];
  } | null;
  index: MillforgeIndex | null;
  parse_error?: string | null;
}

/** GET /millforge/packs 响应。 */
export interface MillforgePacksResponse {
  packs: MillforgePack[];
}

/** GET /millforge/packs/{pack}/file 响应（.md/.yaml/.json/.py/.sh/.txt 只读预览）。 */
export interface MillforgePackFile {
  pack: string;
  path: string;
  size: number;
  content: string;
}

// ── 编译 ─────────────────────────────────────────────────────────

/** 模板路径输入（INDEX 整队组合或 industry+domains+members 确定性组装）。 */
export interface MillforgeTemplateSpec {
  team_combo?: string;
  industry?: string;
  domains?: string[];
  members?: { leader?: number; workers?: number; critic?: number };
}

/** 编译请求：template（模板路径）与 team_json（LLM 二次生成）恰好给一个。 */
export interface MillforgeCompileRequest {
  pack: string;
  team: string;
  lang: "zh" | "en";
  template?: MillforgeTemplateSpec;
  team_json?: Record<string, unknown>;
}

/** 编译产出的单角色 SOUL（soul 仅在编译响应内；build.json 落盘不含全文）。 */
export interface MillforgeRoleOut {
  role: string;
  kind: "coordinator" | "leader" | "worker" | "critic";
  lines: number;
  budget: number;
  budget_ok: boolean;
  soul_sha256: string;
  soul: string;
}

/** POST /millforge/compile 成功响应（build 落盘 + 全量 SOUL 预览）。 */
export interface MillforgeBuildResult {
  ok: boolean;
  build_id: string;
  pack: string;
  team: string;
  lang: string;
  source: "template" | "custom";
  roles: MillforgeRoleOut[];
  fragments: string[];
  spawn_specs: string[];
  provenance: Record<string, unknown>;
}

// ── 注入 ─────────────────────────────────────────────────────────

/** create_workers 行（工作台 CR 角色 team_leader/worker；role 空=按 kind 派生）。 */
export interface MillforgeCreateWorker {
  name: string;
  role_id: string;
  role?: string;
  model?: string;
  runtime?: string;
}

/** POST /millforge/inject 请求（mapping=现有 Worker 选 SOUL；create_workers=新建带 SOUL）。 */
export interface MillforgeInjectRequest {
  build_id: string;
  team: string;
  mapping: Record<string, string>;
  create_workers: MillforgeCreateWorker[];
  core_skill: boolean;
  apply_soul: boolean;
}

/** 注入单项结果（souls 现有 Worker / created 新建 Worker 同构）。 */
export interface MillforgeInjectEntry {
  worker?: string;
  name?: string;
  role_id: string;
  status: "ok" | "error";
  error?: string;
  verified?: boolean;
}

/** POST /millforge/inject 响应（HTTP 恒 200 + partial 如实回报逐项成败）。 */
export interface MillforgeInjectResult {
  ok: boolean;
  partial: boolean;
  build_id: string;
  team: string;
  souls: MillforgeInjectEntry[];
  created: MillforgeInjectEntry[];
  core_skill: {
    status: "ok" | "partial" | "error" | "skipped";
    skill?: string;
    assigned?: string[];
    detail?: string;
  };
}

/** GET /millforge/injections 历史条目（留 50，最新在前）。 */
export interface MillforgeInjectionRec {
  id: string;
  at: string;
  build_id: string;
  team: string;
  partial: boolean;
  souls: MillforgeInjectEntry[];
  created: MillforgeInjectEntry[];
  core_skill: MillforgeInjectResult["core_skill"];
}

/** GET /millforge/injections 响应。 */
export interface MillforgeInjectionsResponse {
  injections: MillforgeInjectionRec[];
}

// ── LLM 二次生成 ─────────────────────────────────────────────────

/** POST /millforge/prompt 表单（空字段 = 提示词标注「未提供」）。 */
export interface MillforgePromptForm {
  members: string;
  task_types: string;
  runtime: string;
  pains: string;
  team_name: string;
}

/** POST /millforge/prompt 响应（PHILOSOPHY 全文 + schema + §十已填充骨架 + 输出约束）。 */
export interface MillforgePromptResult {
  ok: boolean;
  pack: string;
  prompt: string;
}

/** 字段级校验错误（jsonschema 路径 + 消息）。 */
export interface MillforgeParseError {
  path: string;
  message: string;
}

/** POST /millforge/parse-team-json 响应（ok=true 时 team = 校验后的完整 team.json）。 */
export interface MillforgeParseResult {
  ok: boolean;
  team?: Record<string, unknown>;
  errors?: MillforgeParseError[];
}

// ── HTTP 客户端 ──────────────────────────────────────────────────

/** GET /millforge/source（源配置现值 + 派生 URL）。
 * 60s 缓存（目录/配置类；putMillforgeSource 成功后失效）。 */
export function fetchMillforgeSource(): Promise<MillforgeSource> {
  return cachedRequest(
    "millforge/source",
    60_000,
    () => requestJson(`${BASE}/source`, undefined, 30000) as Promise<MillforgeSource>,
    { tags: ["millforge"] },
  );
}

/** PUT /millforge/source（持久化；400 = repo/custom_url 校验失败）。 */
export async function putMillforgeSource(
  patch: MillforgeSourcePatch,
): Promise<MillforgeSource> {
  const r = (await requestJson(`${BASE}/source`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }, 30000)) as MillforgeSource;
  // 源配置变更 → 源配置缓存失效。
  invalidateTags(["millforge"]);
  return r;
}

/** POST /millforge/import（按源配置导入；90s 后端 clone 超时 → 前端 300s 宽限）。 */
export async function millforgeImport(ref = "main"): Promise<MillforgeImportResult> {
  const r = (await requestJson(`${BASE}/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref }),
  }, 300000)) as MillforgeImportResult;
  // 整包覆盖导入 → pack/INDEX/源数据面全部失效。
  invalidateTags(["millforge"]);
  return r;
}

/** GET /millforge/packs（全量 pack + 解析后 INDEX + meta；HTTP 恒 200）。
 * 300s 缓存（近似静态：pack 集合仅在 import 时整体替换，已失效）。 */
export function fetchMillforgePacks(): Promise<MillforgePacksResponse> {
  return cachedRequest(
    "millforge/packs",
    300_000,
    () => requestJson(`${BASE}/packs`, undefined, 30000) as Promise<MillforgePacksResponse>,
    { tags: ["millforge"] },
  );
}

/** GET /millforge/packs/{pack}/file（单文件只读预览；防穿越由后端保证）。
 * 不缓存：pack 内单文件只读预览（大载荷 + 无轮询消费方）。 */
export async function fetchMillforgePackFile(
  pack: string,
  path: string,
): Promise<MillforgePackFile> {
  const q = new URLSearchParams({ path });
  return (await requestJson(
    `${BASE}/packs/${encodeURIComponent(pack)}/file?${q.toString()}`,
    undefined,
    30000,
  )) as MillforgePackFile;
}

/** POST /millforge/compile（120s 编译器超时 → 前端 180s 宽限）。
 * 422 = 编译器非 0 退出（detail 为 {exit_code, stage, error, stderr_tail, ...} 对象）；
 * 400 = 输入校验（team 名/industry/domain/成员数等）。 */
export async function millforgeCompile(
  req: MillforgeCompileRequest,
): Promise<MillforgeBuildResult> {
  const r = (await requestJson(`${BASE}/compile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  }, 180000)) as MillforgeBuildResult;
  // 新 build 落盘 → build 历史缓存失效。
  invalidateTags(["millforge"]);
  return r;
}

/** POST /millforge/inject（逐项 Controller 调用链 + 读回验证——300s 宽限）。 */
export async function millforgeInject(
  req: MillforgeInjectRequest,
): Promise<MillforgeInjectResult> {
  const r = (await requestJson(`${BASE}/inject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  }, 300000)) as MillforgeInjectResult;
  // 注入 = 建 worker + 写 SOUL + 核心技能分配 → 注入历史/CRD 管理面/
  // 团队结构/技能数据面全部失效（partial 也失效：逐项成败不一，
  // 失效面宁宽勿窄）。
  invalidateTags(["millforge", "admin", "teams", "skills"]);
  return r;
}

/** POST /millforge/prompt（提示词 = PHILOSOPHY + schema + §十已填充骨架）。 */
export async function millforgePrompt(
  pack: string,
  form: MillforgePromptForm,
): Promise<MillforgePromptResult> {
  return (await requestJson(`${BASE}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pack, form }),
  }, 60000)) as MillforgePromptResult;
}

/** POST /millforge/parse-team-json（LLM 文本 → 提取 JSON → jsonschema 字段级校验）。 */
export async function millforgeParseTeamJson(
  pack: string,
  text: string,
): Promise<MillforgeParseResult> {
  return (await requestJson(`${BASE}/parse-team-json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pack, text }),
  }, 60000)) as MillforgeParseResult;
}

/** GET /millforge/builds（build 历史，最新在前；build.json 元数据列表）。
 * 30s 缓存（列表类；millforgeCompile 成功后失效）。 */
export function fetchMillforgeBuilds(): Promise<{ builds: unknown[] }> {
  return cachedRequest(
    "millforge/builds",
    30_000,
    () =>
      requestJson(`${BASE}/builds`, undefined, 30000) as Promise<{ builds: unknown[] }>,
    { tags: ["millforge"] },
  );
}

/** GET /millforge/builds/{id}/file（.md/.json；SOUL 全文 = path {role}.soul.md）。 */
export async function fetchMillforgeBuildFile(
  buildId: string,
  path: string,
): Promise<{ build_id: string; path: string; size: number; content: string }> {
  const q = new URLSearchParams({ path });
  return (await requestJson(
    `${BASE}/builds/${encodeURIComponent(buildId)}/file?${q.toString()}`,
    undefined,
    30000,
  )) as { build_id: string; path: string; size: number; content: string };
}

/** GET /millforge/injections（注入历史，留 50，最新在前）。
 * 30s 缓存（列表类；millforgeInject 成功后失效）。 */
export function fetchMillforgeInjections(): Promise<MillforgeInjectionsResponse> {
  return cachedRequest(
    "millforge/injections",
    30_000,
    () =>
      requestJson(`${BASE}/injections`, undefined, 30000) as Promise<MillforgeInjectionsResponse>,
    { tags: ["millforge"] },
  );
}
