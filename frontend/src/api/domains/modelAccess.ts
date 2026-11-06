// Model Access 数据面域（#1513）：worker 级模型配置授权/继承/锁定展示。
//
// 契约（#1513 已合，正文逐字）：
//   GET /api/v1/model-access?worker=<name>
//   {
//     "capabilities": {
//       "main":   { "canEdit": bool, "writeVia"?: string, "inheritedFrom"?: string },
//       "spawn":  { "canEdit": bool, "inherit": bool, "writeVia"?: string, "inheritedFrom"?: string },
//       "codingCli": { "<cli>": { "canEdit": bool, "inherit": bool, "inheritedFrom"?: string,
//                                "writeVia"?: string, "status"?: "cli_not_granted"|"not_granted"|"byok_unsupported" } }
//     },
//     "surfaces": {
//       "main":   { "entries": [{"provider": "…", "model": "…"}] },
//       "spawn":  { "entries": [...] },
//       "codingCli": { "<cli>": { "entries": [...] } }
//     },
//     "current": { "model": "…", "modelProvider": "…", "subagentModel": "…" },
//     "locked": bool,
//     "catalogUnavailable"?: bool
//   }
// 语义：
// - 授权轴只有 role + coding CLI（无 team / 无 per-worker 列表）；
// - (provider, model) 是成对的；目录方向 = provider → models，不反向映射；
// - inherit 是授权：spawn 空 → 继承主模型；CLI 空 → 继承 worker 的 spawn 模型
//   （spawn 空再回落主模型）；继承中的 surface 只读；
// - 缺 modelAccess → fail-closed（locked: true）。
// 部署现状（实测）：集群 controller 仍是旧版 → 本端点 404 → 调用方降级为
// { access: null, unsupported: true } =「无授权信息」（= 现有行为，不显示授权 UI）。
import {
  controllerRequest,
  fetchControllerJson,
  httpErrorDetail,
  httpErrorStatus,
  requestJson,
} from "../shared";
import { invalidateTags } from "../../requestCache";
import { lruInvalidate } from "../../cache/memoryLru";

/** 一条授予的 (provider, model) 对（成对；目录方向 = provider → models）。 */
export interface ModelAccessPair {
  provider: string;
  model: string;
}

/** 单 surface 授权能力。main 无 inherit（主模型不继承上游）；
 * spawn / codingCli 有 inherit（空值 = 继承上游）；status 为 CLI surface 特有。 */
export interface ModelAccessCapability {
  canEdit: boolean;
  inherit?: boolean;
  /** 服务端为 string[]（model_access_handler.go writeVia []string），不是单值。 */
  writeVia?: string[];
  inheritedFrom?: string;
  /** 人类可读的拒绝/锁定原因（服务端 reason 字段）。 */
  reason?: string;
  status?: "cli_not_granted" | "not_granted" | "byok_unsupported";
}

export interface ModelAccessSurfaceEntries {
  entries?: ModelAccessPair[];
}

export interface ModelAccessSurfaces {
  main?: ModelAccessSurfaceEntries;
  spawn?: ModelAccessSurfaceEntries;
  codingCli?: Record<string, ModelAccessSurfaceEntries | undefined>;
}

export interface ModelAccessPayload {
  capabilities: {
    main?: ModelAccessCapability;
    spawn?: ModelAccessCapability;
    codingCli?: Record<string, ModelAccessCapability | undefined>;
  };
  surfaces: ModelAccessSurfaces;
  current?: {
    model?: string;
    modelProvider?: string;
    subagentModel?: string;
  };
  /** fail-closed：缺 modelAccess → controller 置 locked true（整弹窗只读）。 */
  locked: boolean;
  catalogUnavailable?: boolean;
}

/**
 * 取 worker 的 Model Access 授权信息。
 * 404（旧版 controller 无此端点）→ `{ access: null, unsupported: true }`
 *（不抛错；调用方降级为「无授权信息」= 现有行为）；其它错误照抛。
 */
export async function fetchModelAccess(
  worker: string,
): Promise<{ access: ModelAccessPayload | null; unsupported: boolean }> {
  try {
    const body = (await requestJson(
      `/agentteams-proxy/controller/api/v1/model-access?worker=${encodeURIComponent(
        worker,
      )}`,
      undefined,
      30000,
    )) as ModelAccessPayload | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      // 空 body / 形状非法 → 同按「无授权信息」降级（不炸 UI）。
      return { access: null, unsupported: true };
    }
    return { access: body, unsupported: false };
  } catch (e) {
    if (httpErrorStatus(e) === 404) return { access: null, unsupported: true };
    throw e;
  }
}

// ────────────────────────────────────────────────────────────────────
// C2b（#1513 管理员面）：Human CR spec.modelAccess——人员详情「模型授权」编辑区。
//
// 契约（main 9322b04f9，model_access_handler.go + v1beta1 types.go）：
//   GET  /api/v1/humans/{name}            → 人 CR（含 spec.modelAccess）
//   GET  /api/v1/humans/{name}?resolve=1  → （若支持）生效值 + modelAccess.capabilities
//   PUT  /api/v1/humans/{name}            → 保存（读-改-写；404/405 → PATCH 兜底）
//   GET  /api/v1/model-access-tables      → 共享表清单（404 = 不支持）
//   GET  /api/v1/model-access-tables/{n}  → 表内容（只读展示）
// 语义（与 worker 级同一套）：
// - 授权轴只有 role + coding CLI（无 team / 无 per-worker 列表）；
// - (provider, model) 必须成对；role 可空 = 默认作用域；
// - table = 共享表引用（与内联 entries 二选一，内联优先）；
// - 无值 = fail-closed（全锁）——UI 必须提示；
// - 服务端 writeVia/reason 是只读信息：UI 回显，绝不写回。
// 写面（任务书强约束）：先读人 CR，只改 spec.modelAccess 一个字段，
// 其余字段原样带回（整体 CR PUT；PUT 404/405 → PATCH merge-patch 兜底）。
// ────────────────────────────────────────────────────────────────────

/** Human spec.modelAccess 的一个 scope（授权轴：role + coding CLI）。 */
export interface HumanModelAccessScope {
  /** role 空/省略 = 默认作用域；"*" = 全部 role。 */
  role?: string;
  /** 共享表引用（与内联 entries 二选一，内联优先）。 */
  table?: string;
  main?: { entries?: ModelAccessPair[] };
  spawn?: { entries?: ModelAccessPair[]; inherit?: boolean };
  codingCli?: Record<string, { entries?: ModelAccessPair[]; inherit?: boolean } | undefined>;
}

/** Human CR spec.modelAccess。 */
export interface HumanModelAccess {
  scopes?: HumanModelAccessScope[];
}

/** 单 surface 生效值授权（?resolve=1；与 worker 级 ModelAccessCapability 同形）。 */
export type HumanModelAccessCapability = ModelAccessCapability;

export interface HumanModelAccessCapabilities {
  main?: HumanModelAccessCapability;
  spawn?: HumanModelAccessCapability;
  codingCli?: Record<string, HumanModelAccessCapability | undefined>;
}

function asRecord(x: unknown): Record<string, unknown> | null {
  return x !== null && typeof x === "object" && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : null;
}

/** 成对校验：provider/model 都是非空字符串（(provider, model) 成对契约）。 */
export function isCompletePair(p: unknown): p is ModelAccessPair {
  const o = asRecord(p);
  return (
    !!o &&
    typeof o.provider === "string" &&
    o.provider.trim() !== "" &&
    typeof o.model === "string" &&
    o.model.trim() !== ""
  );
}

/** 不完整对行（UI 行内红字提示 + 保存门）。 */
export interface PairIssue {
  surface: "main" | "spawn" | "codingCli";
  /** codingCli 专有：CLI 名。 */
  cli?: string;
  /** 该 surface entries 内的行号。 */
  index: number;
}

/** 找出 scope 内所有不成对的 entries 行。 */
export function findPairIssues(
  scope: HumanModelAccessScope | null | undefined,
): PairIssue[] {
  if (!scope || typeof scope !== "object") return [];
  const out: PairIssue[] = [];
  const check = (
    entries: ModelAccessPair[] | null | undefined,
    surface: PairIssue["surface"],
    cli?: string,
  ) => {
    if (!Array.isArray(entries)) return;
    entries.forEach((e, i) => {
      if (!isCompletePair(e)) out.push({ surface, ...(cli ? { cli } : {}), index: i });
    });
  };
  check(scope.main?.entries, "main");
  check(scope.spawn?.entries, "spawn");
  for (const [cli, v] of Object.entries(scope.codingCli ?? {})) {
    check(v?.entries, "codingCli", cli);
  }
  return out;
}

function cleanPairs(entries: ModelAccessPair[] | null | undefined): ModelAccessPair[] {
  if (!Array.isArray(entries)) return [];
  const out: ModelAccessPair[] = [];
  for (const e of entries) if (isCompletePair(e)) out.push({ provider: e.provider, model: e.model });
  return out;
}

/**
 * 一个 scope → wire 载荷：
 * - role/table：trim，空则省略键（role 空 = 默认作用域）；
 * - entries：只留完整对（不完整的行在 UI 被门住，这里是二道防线，静默丢弃）；
 * - spawn/CLI：inherit === true → { inherit: true }（丢 entries——继承优先）；
 * - main：无 inherit 概念，无 entries → 省略；
 * - 整个 scope 无有效内容 → null（调用方过滤；无值 = fail-closed）。
 */
export function serializeScope(
  scope: HumanModelAccessScope | null | undefined,
): Record<string, unknown> | null {
  if (!scope || typeof scope !== "object") return null;
  const out: Record<string, unknown> = {};
  const role = typeof scope.role === "string" ? scope.role.trim() : "";
  if (role) out.role = role;
  const table = typeof scope.table === "string" ? scope.table.trim() : "";
  if (table) out.table = table;
  const mainEntries = cleanPairs(scope.main?.entries);
  if (mainEntries.length) out.main = { entries: mainEntries };
  const sp = scope.spawn;
  if (sp && typeof sp === "object") {
    const spOut: Record<string, unknown> = {};
    if (sp.inherit === true) spOut.inherit = true;
    else {
      const es = cleanPairs(sp.entries);
      if (es.length) spOut.entries = es;
    }
    if (Object.keys(spOut).length) out.spawn = spOut;
  }
  const cliOut: Record<string, unknown> = {};
  for (const [cli, v] of Object.entries(scope.codingCli ?? {})) {
    const key = cli.trim();
    if (!key || !v || typeof v !== "object") continue;
    const one: Record<string, unknown> = {};
    if (v.inherit === true) one.inherit = true;
    else {
      const es = cleanPairs(v.entries);
      if (es.length) one.entries = es;
    }
    if (Object.keys(one).length) cliOut[key] = one;
  }
  if (Object.keys(cliOut).length) out.codingCli = cliOut;
  return Object.keys(out).length ? out : null;
}

/** 编辑器值 → wire 载荷。null = 清除（字段移除 → fail-closed 全锁）。 */
export function buildModelAccessPayload(
  value: HumanModelAccess | null | undefined,
): Record<string, unknown> | null {
  const scopes = value?.scopes;
  const out: Record<string, unknown>[] = [];
  if (Array.isArray(scopes)) {
    for (const s of scopes) {
      const w = serializeScope(s);
      if (w) out.push(w);
    }
  }
  return out.length ? { scopes: out } : null;
}

/** 所有 surface 均显式 canEdit=false → 整体只读（保存禁用）。 */
export function allSurfacesLocked(
  caps: HumanModelAccessCapabilities | null | undefined,
): boolean {
  if (!caps) return false;
  if (caps.main?.canEdit !== false) return false;
  if (caps.spawn?.canEdit !== false) return false;
  const cli = caps.codingCli;
  if (cli && Object.keys(cli).length) {
    return Object.values(cli).every((c) => !!c && c.canEdit === false);
  }
  return true;
}

/** 读取视图（CR 原样 + 配置的 modelAccess + resolve 生效值授权）。 */
export interface HumanModelAccessView {
  /** 人 CR 原样（含 metadata/spec 的完整 CR 形状或 flat 形状——写面按此定 body）。 */
  cr: Record<string, unknown> | null;
  /** 配置的 spec.modelAccess（null = 未配置 → fail-closed）。 */
  modelAccess: HumanModelAccess | null;
  /** ?resolve=1 生效值授权（null = 端点不支持/未返回）。 */
  capabilities: HumanModelAccessCapabilities | null;
}

function extractModelAccess(cr: Record<string, unknown> | null): HumanModelAccess | null {
  if (!cr) return null;
  const holder = asRecord(cr.spec) ?? cr;
  const ma = asRecord(holder.modelAccess);
  if (!ma || !Array.isArray(ma.scopes)) return null;
  const scopes = ma.scopes.filter((s) => asRecord(s) !== null) as HumanModelAccessScope[];
  return { scopes };
}

function isCapabilityLike(x: unknown): x is HumanModelAccessCapability {
  const o = asRecord(x);
  return !!o && typeof o.canEdit === "boolean";
}

function extractCapabilities(cr: unknown): HumanModelAccessCapabilities | null {
  const rec = asRecord(cr);
  if (!rec) return null;
  const holder = asRecord(asRecord(rec.spec)?.modelAccess) ?? asRecord(rec.modelAccess);
  if (!holder) return null;
  const caps = asRecord(holder.capabilities);
  if (!caps) return null;
  const out: HumanModelAccessCapabilities = {};
  if (isCapabilityLike(caps.main)) out.main = caps.main;
  if (isCapabilityLike(caps.spawn)) out.spawn = caps.spawn;
  const cli = asRecord(caps.codingCli);
  if (cli) {
    const o: Record<string, HumanModelAccessCapability> = {};
    for (const [k, v] of Object.entries(cli)) if (isCapabilityLike(v)) o[k] = v;
    if (Object.keys(o).length) out.codingCli = o;
  }
  return out.main || out.spawn || out.codingCli ? out : null;
}

/**
 * 读人员的模型授权：GET /humans/{name} + 可选 ?resolve=1。
 * resolve=1 404/失败（旧控制器无参数）→ capabilities = null 降级（主读不炸，
 * 编辑面照常可用，写后由服务端裁决）；主读错误照抛（调用方 toast）。
 */
export async function getHumanModelAccess(
  name: string,
): Promise<HumanModelAccessView> {
  const cr = asRecord(
    await fetchControllerJson<unknown>(`humans/${encodeURIComponent(name)}`),
  );
  let capabilities: HumanModelAccessCapabilities | null = null;
  try {
    capabilities = extractCapabilities(
      await fetchControllerJson<unknown>(
        `humans/${encodeURIComponent(name)}?resolve=1`,
      ),
    );
  } catch {
    // resolve=1 不支持或瞬断 → 「无生效值授权」降级。
  }
  return { cr, modelAccess: extractModelAccess(cr), capabilities };
}

/**
 * 保存 spec.modelAccess（读-改-写，任务书强约束）：
 * ① GET /humans/{name} 读现状（CR 原样形状）；
 * ② 只改 modelAccess 一个字段（payload = null → 移除字段 = 回到 fail-closed），
 *    其余字段（metadata / spec 兄弟字段）原样带回——防整体覆盖丢字段；
 * ③ 完整 CR 形状（有 spec 键）→ PUT 整体 CR；flat 形状（本控制器 /humans
 *    惯例，updateHumanAccess 同源）→ PUT spec-direct body；
 *    PUT 404/405（控制器无 PUT /humans 端点）→ PATCH merge-patch 兜底
 *    （只发 modelAccess，null 移除）。
 * 成功 → 写面失效（与 crd.ts 各写函数同源）。返回实际使用的 method。
 */
export async function saveHumanModelAccess(
  name: string,
  payload: Record<string, unknown> | null,
): Promise<{ method: "PUT" | "PATCH" }> {
  const path = `humans/${encodeURIComponent(name)}`;
  const cr = asRecord(await fetchControllerJson<unknown>(path));
  if (!cr) throw new Error("人 CR 读取结果非法（期望对象）");
  const spec = asRecord(cr.spec);
  let method: "PUT" | "PATCH" = "PUT";
  let body: Record<string, unknown>;
  if (spec) {
    // 完整 CR 形状：PUT 整体 CR（契约 body {"spec":{...}}）。
    const nextSpec: Record<string, unknown> = { ...spec };
    if (payload) nextSpec.modelAccess = payload;
    else delete nextSpec.modelAccess;
    body = { ...cr, spec: nextSpec };
  } else {
    // flat 形状：spec-direct body（省略键 = 不变，merge 语义）。
    body = { ...cr };
    if (payload) body.modelAccess = payload;
    else delete body.modelAccess;
  }
  try {
    await controllerRequest("PUT", path, body);
  } catch (e) {
    const st = httpErrorStatus(e);
    if (st !== 404 && st !== 405) throw e;
    // 旧控制器无 PUT /humans → PATCH（merge-patch：null 移除字段）。
    method = "PATCH";
    body = spec
      ? { spec: { modelAccess: payload ?? null } }
      : { modelAccess: payload ?? null };
    await controllerRequest("PATCH", path, body);
  }
  invalidateTags(["teams", "admin"]);
  lruInvalidate("crd:");
  return { method };
}

/** 共享表清单结果（404 → supported=false → 调用方隐藏表选择器，只留内联 entries）。 */
export interface ModelAccessTablesResult {
  supported: boolean;
  /** 表名列表。 */
  tables: string[];
}

export async function listModelAccessTables(): Promise<ModelAccessTablesResult> {
  try {
    const body = await fetchControllerJson<unknown>("model-access-tables");
    const rec = asRecord(body);
    const list: unknown = Array.isArray(body)
      ? body
      : (rec?.items ?? rec?.tables ?? rec?.names);
    const tables: string[] = [];
    if (Array.isArray(list)) {
      for (const it of list) {
        const o = asRecord(it);
        const nm =
          typeof it === "string"
            ? it
            : ((asRecord(o?.metadata)?.name ?? o?.name) as unknown);
        if (typeof nm === "string" && nm.trim() !== "" && !tables.includes(nm)) {
          tables.push(nm);
        }
      }
    }
    return { supported: true, tables };
  } catch (e) {
    if (httpErrorStatus(e) === 404) return { supported: false, tables: [] };
    // A build that carries the handler but no CRD answers 500 with "no
    // matches for kind ModelAccessTable": that is a missing capability, not a
    // transient failure — degrade like a 404 instead of surfacing an error.
    if (missingModelAccessCRD(e)) return { supported: false, tables: [] };
    throw e;
  }
}

/** 共享表内容（只读展示）。 */
export interface ModelAccessTableDetail {
  supported: boolean;
  /** (provider, model) 对列表（形状非法的条目已过滤）。 */
  entries: ModelAccessPair[];
  /** 原始响应（形状未知时兜底展示）。 */
  raw: unknown;
}

export async function getModelAccessTable(name: string): Promise<ModelAccessTableDetail> {
  try {
    const body = await fetchControllerJson<unknown>(
      `model-access-tables/${encodeURIComponent(name)}`,
    );
    const rec = asRecord(body);
    const spec = asRecord(rec?.spec);
    const arr: unknown[] | null = Array.isArray(body)
      ? body
      : Array.isArray(rec?.entries)
        ? (rec.entries as unknown[])
        : Array.isArray(rec?.items)
          ? (rec.items as unknown[])
          : Array.isArray(spec?.entries)
            ? (spec.entries as unknown[])
            : null;
    const entries: ModelAccessPair[] = [];
    for (const it of arr ?? []) {
      if (isCompletePair(it)) entries.push({ provider: it.provider, model: it.model });
    }
    return { supported: true, entries, raw: body };
  } catch (e) {
    if (httpErrorStatus(e) === 404) return { supported: false, entries: [], raw: null };
    throw e;
  }
}

/** True when the controller has the handler but the ModelAccessTable CRD is
 *  not installed (kubectl-style "no matches for kind" 500). */
function missingModelAccessCRD(e: unknown): boolean {
  if (httpErrorStatus(e) !== 500) return false;
  const detail = httpErrorDetail(e).toLowerCase();
  return detail.includes("no matches for kind") && detail.includes("modelaccesstable");
}
