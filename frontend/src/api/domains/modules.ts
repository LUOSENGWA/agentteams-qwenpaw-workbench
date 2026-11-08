// 模块更新（#1526 三平面）域：发布索引 + 团队/manager/worker 插件安装。
//
// 契约 = Controller（main 9322b04f9，#1526）——全部 /api/v1/... 路由，
// 经通用 Controller 代理（/agentteams-proxy/controller/api/v1/...）：
//   团队面    GET  /teams/{name}/modules
//             POST /teams/{name}/modules/{module}/install
//   manager  GET  /managers/{name}/plugins
//            POST /managers/{name}/plugins/install
//   worker   GET  /workers/{name}/plugins
//            POST /workers/{name}/plugins/install
//   索引      GET  /millforge/index?source=&repo=&ref=&channel=
//
// 降级语义（任务书裁定）：
// - 三个**读**端点 404 = 控制器无该路由（老版本 / #1525 未合）→
//   {supported:false, reason:"controller_too_old"}，不抛错（UI 显示
//   「控制器不支持」块，不报错弹窗）；非 404 错误原样上抛（保留 status+message）。
// - 索引 404 = 通道/仓库无发布（或路由缺失）——语义不同（空态而非
//   「不支持」），上抛给 UI 显「索引不可用」+ 重试。
// - 安装 = 写面（不包缓存）；读面 30s TTL（目录/已装状态类数据）。
//
// 索引模块条目的版本子字段名以 #1526 后端 handler 为准（任务书不确定点）——
// moduleEntryVersions() 做宽容解析（versions 数组 / 条目自身单版本两形态），
// 不硬断言单一形状。

import {
  fetchControllerJson,
  httpErrorStatus,
  postController,
} from "../shared";
import { cachedRequest, invalidateTags } from "../../requestCache";

export type ModuleSource = "github" | "gitcode";
export type ModuleChannel = "alpha" | "beta" | "stable";

/** 默认源仓库（owner/repo；允许用户填自有 Fork——11-04 决策）。 */
export const DEFAULT_MODULE_REPO = "LUOSENGWA/Millforge";

/** 索引缓存标签（安装写成功后统一失效——三平面已装态可能同变）。 */
export const MODULE_UPDATES_TAG = "module-updates";

// ── 索引 ──────────────────────────────────────────────────────────

/** 索引内的制品条目（上游 channels.json：一个版本可带多个制品——
 * qwenpaw zip + 运行时中立的 tar.gz；安装只认 zip）。 */
export interface IndexArtifact {
  name: string;
  sha256: string;
}

/** 索引内模块的版本条目（字段名以 #1526 后端 handler 为准；宽容解析见
 * moduleEntryVersions()）。 */
export interface IndexVersionEntry {
  version: string;
  /** zip 制品文件名（安装 payload 必填）。 */
  artifact?: string;
  /** 制品 sha256（安装 payload 必填；409 = 不匹配）。 */
  sha256?: string;
  /** 该版本的依赖要求（确认弹窗展示差异；key = 依赖名，value = 约束）。 */
  requires?: Record<string, string>;
  /** 上游原始制品清单（对象 map 形态规范化时用于补 artifact/sha256）。 */
  artifacts?: IndexArtifact[];
  commit?: string;
  published_at?: string;
  deprecated?: boolean;
}

/** 索引内模块条目。 */
export interface IndexModuleEntry {
  module: string;
  name?: string;
  /** runner = 不可安装（UI 按钮禁用）；bundle 必须 pluginId != module。 */
  kind?: string;
  /** 安装/匹配用插件 id（缺省 = 模块名）。 */
  pluginId?: string;
  /** 版本列表（主形态）。 */
  versions?: IndexVersionEntry[];
  /** 单版本形态兜底（条目自身即一个版本时；宽容解析）。 */
  version?: string;
  artifact?: string;
  sha256?: string;
  requires?: Record<string, string>;
  /** 该通道最新版本号（上游字段；UI 不依赖，仅为保留索引原貌）。 */
  latest?: string | null;
  note?: string;
}

/** GET /api/v1/millforge/index 响应。 */
export interface ModuleIndexResponse {
  schema: number;
  channel: ModuleChannel;
  modules: IndexModuleEntry[];
  source?: ModuleSource;
  repo?: string;
  fetched_at?: string;
}

/** 索引查询参数（source 必填；repo 默认 LUOSENGWA/Millforge，允许自有 Fork）。 */
export interface ModuleIndexQuery {
  source: ModuleSource;
  repo: string;
  ref: string;
  channel: ModuleChannel;
}

// ── 安装请求体（三平面同构；type 别名 = 隐式索引签名，可直接进 postController）──

/** 团队面安装体（module 在路径里，不在 body）。 */
export type TeamInstallBody = {
  source: ModuleSource;
  repo: string;
  ref: string;
  /** 发布频道（与索引 channel 一致；11-08 bridge 栏按用户选择透传）。 */
  channel?: ModuleChannel;
  version: string;
  artifact: string;
  sha256: string;
};

/** manager/worker 面安装体（module 在 body 里）。 */
export type PluginInstallBody = TeamInstallBody & {
  module: string;
};

// ── 团队面 ────────────────────────────────────────────────────────

/** 团队模块的成员装载态。 */
export interface TeamModuleMember {
  worker: string;
  version?: string;
  loaded?: boolean;
}

/** 团队内单个模块的装载汇总（versions = 版本号→成员数 直方图）。 */
export interface TeamModuleRow {
  module: string;
  name?: string;
  kind?: string;
  members: TeamModuleMember[];
  versions: Record<string, number>;
  consistent: boolean;
}

export interface TeamModuleError {
  worker: string;
  error: string;
}

/** 团队模块读结果。supported=false = 控制器无该路由（老版本），reason 定位原因。 */
export interface TeamModulesResult {
  supported: boolean;
  team?: string;
  modules?: TeamModuleRow[];
  errors?: TeamModuleError[];
  reason?: string;
}

// ── manager/worker 面（白名单投影条目，无凭据无需脱敏）────────────

export interface ModulePluginEntry {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  enabled?: boolean | null;
  loaded?: boolean | null;
  plugin_type?: string;
  frontend_entry?: string;
}

/** manager/worker 插件列表读结果（supported=false = 控制器无该路由）。 */
export interface PluginListResult {
  supported: boolean;
  plugins?: ModulePluginEntry[];
  reason?: string;
}

// ── 安装响应 ──────────────────────────────────────────────────────

/** 团队面安装响应（逐成员分发结果）。 */
export interface TeamInstallResult {
  updated?: string[];
  failed?: { worker: string; error: string } | null;
  target_version?: string;
  module?: string;
  members?: TeamModuleMember[];
  versions?: Record<string, number>;
  consistent?: boolean;
  pluginId?: string;
}

/** manager/worker 面安装响应。 */
export interface PluginInstallResult {
  installed?: boolean;
  loaded?: boolean;
  previous_version?: string;
}

// ── HTTP 客户端 ───────────────────────────────────────────────────

/** GET /api/v1/millforge/index（发布索引；source/repo/ref/channel 四参）。
 * 30s 缓存（key 含全部查询参——源/通道变化即换键）；错误上抛（UI 显
 * 「索引不可用」空态 + 重试）。404 = 通道无发布/仓库不存在/路由缺失——
 * 三种情形 UI 处置一致（空态），不在此吞错。 */
export function getIndex(q: ModuleIndexQuery): Promise<ModuleIndexResponse> {
  const qs = new URLSearchParams({
    source: q.source,
    repo: q.repo.trim(),
    ref: q.ref.trim() || "main",
    channel: q.channel,
  }).toString();
  return cachedRequest(
    `millforge/index?${qs}`,
    30_000,
    async () =>
      normalizeIndexResponse(
        await fetchControllerJson<unknown>(`millforge/index?${qs}`),
      ),
    { tags: [MODULE_UPDATES_TAG] },
  );
}

/** GET /api/v1/teams/{name}/modules（团队面已装汇总）。
 * 404 → {supported:false}（老控制器无路由，诚实降级不抛错）；
 * 30s 缓存（key 含团队名）。 */
export async function getTeamModules(
  team: string,
): Promise<TeamModulesResult> {
  try {
    const r = await cachedRequest(
      `teams/${team}/modules`,
      30_000,
      () =>
        fetchControllerJson<{
          team?: string;
          modules?: TeamModuleRow[];
          errors?: TeamModuleError[];
        }>(`teams/${encodeURIComponent(team)}/modules`),
      { tags: [MODULE_UPDATES_TAG] },
    );
    return {
      supported: true,
      team: r.team ?? team,
      modules: r.modules ?? [],
      errors: r.errors ?? [],
    };
  } catch (e) {
    if (httpErrorStatus(e) === 404)
      return { supported: false, reason: "controller_too_old" };
    throw e;
  }
}

/** POST /api/v1/teams/{name}/modules/{module}/install（团队面安装/更新/降级；
 * 同一端点，方向由 version 决定——允许降级）。写面不缓存；成功后失效
 * 索引缓存标签（三平面已装态可能同变）。 */
export async function installTeamModule(
  team: string,
  module: string,
  body: TeamInstallBody,
): Promise<TeamInstallResult> {
  const r = await postController(
    `teams/${encodeURIComponent(team)}/modules/${encodeURIComponent(module)}/install`,
    body,
  );
  invalidateTags([MODULE_UPDATES_TAG]);
  return r as TeamInstallResult;
}

/** 插件列表载荷宽容解析：契约形态 {"plugins":[...]}；老形态裸数组
 *（既有 worker plugins 代理的透传形态）同样接受。 */
function parsePluginList(payload: unknown): ModulePluginEntry[] {
  if (Array.isArray(payload)) {
    return payload.filter(
      (p): p is ModulePluginEntry =>
        !!p && typeof p === "object" && typeof (p as { id?: unknown }).id !== "number",
    ) as ModulePluginEntry[];
  }
  if (payload && typeof payload === "object") {
    const plugins = (payload as { plugins?: unknown }).plugins;
    if (Array.isArray(plugins))
      return plugins.filter(
        (p): p is ModulePluginEntry => !!p && typeof p === "object",
      ) as ModulePluginEntry[];
  }
  return [];
}

/** GET /api/v1/managers/{name}/plugins（manager 面已装列表，白名单投影）。
 * 404 → {supported:false}（老控制器）；30s 缓存。 */
export async function getManagerPlugins(
  manager: string,
): Promise<PluginListResult> {
  try {
    const r = await cachedRequest(
      `managers/${manager}/plugins`,
      30_000,
      () => fetchControllerJson<unknown>(`managers/${encodeURIComponent(manager)}/plugins`),
      { tags: [MODULE_UPDATES_TAG] },
    );
    return { supported: true, plugins: parsePluginList(r) };
  } catch (e) {
    if (httpErrorStatus(e) === 404)
      return { supported: false, reason: "controller_too_old" };
    throw e;
  }
}

/** POST /api/v1/managers/{name}/plugins/install（manager 面安装；body 含 module）。 */
export async function installManagerPlugin(
  manager: string,
  body: PluginInstallBody,
): Promise<PluginInstallResult> {
  const r = await postController(
    `managers/${encodeURIComponent(manager)}/plugins/install`,
    body,
  );
  invalidateTags([MODULE_UPDATES_TAG]);
  return r as PluginInstallResult;
}

/** GET /api/v1/workers/{name}/plugins（worker 面已装列表）。
 * 404 → {supported:false}（控制器只读路由未合，#1525——UI 显「控制器不支持」）；
 * 30s 缓存。 */
export async function getWorkerPlugins(
  worker: string,
): Promise<PluginListResult> {
  try {
    const r = await cachedRequest(
      `workers/${worker}/plugins`,
      30_000,
      () => fetchControllerJson<unknown>(`workers/${encodeURIComponent(worker)}/plugins`),
      { tags: [MODULE_UPDATES_TAG] },
    );
    return { supported: true, plugins: parsePluginList(r) };
  } catch (e) {
    if (httpErrorStatus(e) === 404)
      return { supported: false, reason: "controller_too_old" };
    throw e;
  }
}

/** POST /api/v1/workers/{name}/plugins/install（worker 面安装；body 含 module）。 */
export async function installWorkerPlugin(
  worker: string,
  body: PluginInstallBody,
): Promise<PluginInstallResult> {
  const r = await postController(
    `workers/${encodeURIComponent(worker)}/plugins/install`,
    body,
  );
  invalidateTags([MODULE_UPDATES_TAG]);
  return r as PluginInstallResult;
}

// ── 宽容解析 / 版本比较（UI 与测试共用）───────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 单个版本条目规范化：保留原字段（artifacts/requires/commit/
 * published_at/deprecated…），补齐 version；上游只给 artifacts[] 时按控制器
 * indexArtifact 同款规则补 artifact/sha256（优先 zip——安装只认 zip），
 * 否则 UI 版本按钮会因「制品/校验字段缺失」全部禁用。
 * 返回副本，不改入参。 */
function normalizeVersionEntry(
  version: string,
  raw: Record<string, unknown>,
): IndexVersionEntry {
  const out = { ...raw, version } as IndexVersionEntry;
  const artifacts: IndexArtifact[] = Array.isArray(raw.artifacts)
    ? raw.artifacts
        .filter(isPlainObject)
        .filter(
          (a): a is { name: string; sha256: string } =>
            typeof a.name === "string" &&
            !!a.name &&
            typeof a.sha256 === "string" &&
            !!a.sha256,
        )
    : [];
  if (artifacts.length > 0 && (!out.artifact || !out.sha256)) {
    const pinned = out.artifact
      ? artifacts.find((a) => a.name === out.artifact)
      : undefined;
    const pick =
      pinned ?? artifacts.find((a) => a.name.endsWith(".zip")) ?? artifacts[0];
    if (!out.artifact) out.artifact = pick.name;
    if (!out.sha256) out.sha256 = pick.sha256;
  }
  return out;
}

/** 版本列表规范化：数组 → 过滤 version 为字符串的条目；对象 map
 *（上游形态，key=版本号）→ [{version, ...v}]；条目自身单 version 字符串 →
 * 单条目；缺失/null → []。 */
function normalizeVersionList(
  rawVersions: unknown,
  entry: Record<string, unknown>,
): IndexVersionEntry[] {
  if (Array.isArray(rawVersions)) {
    return rawVersions
      .filter(
        (v): v is Record<string, unknown> =>
          isPlainObject(v) && typeof v.version === "string" && !!v.version,
      )
      .map((v) => normalizeVersionEntry(v.version as string, v));
  }
  if (isPlainObject(rawVersions)) {
    return Object.entries(rawVersions)
      .filter(([, v]) => isPlainObject(v))
      .map(([version, v]) =>
        normalizeVersionEntry(version, v as Record<string, unknown>),
      );
  }
  if (typeof entry.version === "string" && entry.version) {
    // 单版本形态：条目自身即一个版本，只取版本字段（不把 module/kind 等
    // 条目字段带进版本条目）。
    return [
      {
        version: entry.version,
        artifact: typeof entry.artifact === "string" ? entry.artifact : undefined,
        sha256: typeof entry.sha256 === "string" ? entry.sha256 : undefined,
        requires: isPlainObject(entry.requires)
          ? (entry.requires as Record<string, string>)
          : undefined,
      },
    ];
  }
  return [];
}

/** 模块条目规范化：module 名由 key（对象 map）或条目自身（数组）给出，
 * 其余字段原样保留。 */
function normalizeModuleEntry(
  module: string,
  raw: Record<string, unknown>,
): IndexModuleEntry {
  return {
    ...raw,
    module,
    versions: normalizeVersionList(raw.versions, raw),
  } as IndexModuleEntry;
}

/** GET /api/v1/millforge/index 载荷规范化（API 边界）。
 *
 * 上游 channels.json 的 `modules` 是**对象 map**（key = 模块名），每个模块的
 * `versions` 也是**对象 map**（key = 版本号）——控制器是 re-wrap 代理，原样
 * 透传该形状（millforge_index.go 只校验 modules 是 JSON 对象）。早期的类型/
 * UI 假设两者都是数组，于是 `modules.find is not a function` 崩溃、版本列表
 * 为空。此处统一成数组（UI 按数组消费），数组形态原样兼容。 */
export function normalizeIndexResponse(raw: unknown): ModuleIndexResponse {
  const obj = isPlainObject(raw) ? raw : {};
  const modules: IndexModuleEntry[] = [];
  if (Array.isArray(obj.modules)) {
    for (const m of obj.modules) {
      if (!isPlainObject(m) || typeof m.module !== "string" || !m.module)
        continue;
      modules.push(normalizeModuleEntry(m.module, m));
    }
  } else if (isPlainObject(obj.modules)) {
    for (const [module, m] of Object.entries(obj.modules)) {
      if (!isPlainObject(m)) continue;
      modules.push(normalizeModuleEntry(module, m));
    }
  }
  return {
    schema: typeof obj.schema === "number" ? obj.schema : 1,
    channel:
      typeof obj.channel === "string" ? (obj.channel as ModuleChannel) : "beta",
    modules,
    source:
      obj.source === "github" || obj.source === "gitcode"
        ? obj.source
        : undefined,
    repo: typeof obj.repo === "string" ? obj.repo : undefined,
    fetched_at: typeof obj.fetched_at === "string" ? obj.fetched_at : undefined,
  };
}

/** 模块条目版本列表宽容解析：
 * ① entry.versions 为数组 → 取其中 version 为字符串的条目（主形态）；
 * ② entry.versions 为对象 map（上游形态）→ [{version, ...v}]（兜底，
 *    防绕过 getIndex 规范化直接消费原始载荷）；
 * ③ 否则条目自身带 version 字符串 → 包成单条目（单版本形态兜底）；
 * ④ 都没有 → []（UI 显「索引无版本条目」）。
 * 字段名以 #1526 后端 handler 为准——此处不硬断言单一形状。 */
export function moduleEntryVersions(
  entry: IndexModuleEntry | null | undefined,
): IndexVersionEntry[] {
  if (!entry || typeof entry !== "object") return [];
  const raw: unknown = entry.versions;
  if (Array.isArray(raw)) {
    return raw.filter(
      (v): v is IndexVersionEntry =>
        !!v &&
        typeof v === "object" &&
        typeof (v as { version?: unknown }).version === "string",
    );
  }
  if (isPlainObject(raw)) {
    return Object.entries(raw)
      .filter(([, v]) => isPlainObject(v))
      .map(([version, v]) =>
        normalizeVersionEntry(version, v as Record<string, unknown>),
      );
  }
  if (typeof entry.version === "string" && entry.version) {
    return [
      {
        version: entry.version,
        artifact: entry.artifact,
        sha256: entry.sha256,
        requires: entry.requires,
      },
    ];
  }
  return [];
}

/** 条目安装/匹配用的插件 id（缺省 = 模块名——契约缺省语义）。 */
export function entryPluginId(entry: IndexModuleEntry): string {
  return entry.pluginId && entry.pluginId.trim() ? entry.pluginId : entry.module;
}

/** semver-lite 版本比较：逐段数字比较，非数字段按字符串比。
 * 返回 -1/0/1（a<b / a==b / a>b）。非 semver 形态（如 git sha）同样
 * 有确定序（同形态下字典序），够用。 */
export function compareModuleVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/).filter(Boolean);
  const pb = b.split(/[.\-+]/).filter(Boolean);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const xa = pa[i];
    const xb = pb[i];
    if (xa === undefined) return -1;
    if (xb === undefined) return 1;
    const na = Number(xa);
    const nb = Number(xb);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na < nb ? -1 : 1;
      continue;
    }
    if (xa !== xb) return xa < xb ? -1 : 1;
  }
  return 0;
}

/** 索引条目是否可安装（runner 不可装——契约；其余可装）。 */
export function isInstallableKind(entry: IndexModuleEntry): boolean {
  return (entry.kind || "").toLowerCase() !== "runner";
}
