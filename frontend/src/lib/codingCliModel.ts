/**
 * codingCliModel.ts — CodingCLI 模型配置纯函数（node 可直测，无 React/window 依赖）。
 *
 * 上游契约（qwen-code 源码实锤）：`findModelConfig`（packages/cli/src/config/auth.ts）
 * 把 `model.name` 与 `model.baseUrl` **成对**解析——有 baseUrl 优先按 `id+baseUrl`
 * 精确命中；没有 baseUrl 取第一个同 id 的 provider 条目 → 多 provider 同模型名时
 * 选择被静默忽略。故模型设置 UI 的「选 Provider」= 把对应条目的 baseUrl 写进
 * `model.baseUrl`（消歧键，settingsSchema.ts 原文同义）。
 *
 * 数据形态：settings.modelProviders = { providerId: ModelConfig[] }（路由数组），
 * 每条目 {id, name?, envKey?, baseUrl?, wireApi?}——`id` 是它声明的 model id，
 * `baseUrl` 是路由目标。同一 provider 下多条目共用「取第一个非空 baseUrl」口径。
 *
 * 本模块只 `import type`（运行时零依赖）——node --experimental-strip-types
 * 可直测（api/domains 链含 extensionless 相对 import，node ESM 无法解析）。
 * 模型形态映射以 api/domains/codingcli.objectModel 为准；下方判定为刻意镜像
 * （保持本模块可 node 直 import，禁运行期反向依赖 api 域）。
 */

import type { CodingCliId, SettingsObject } from "../api/domains/codingcli";

/** 一条可选择的 Provider 条目（modelProviders 的 record 键 → 条目摘要）。 */
export interface CliModelEntry {
  /** providerId（modelProviders 的 record 键）。 */
  id: string;
  /** 该 provider 路由条目的 baseUrl（第一个非空值；全空 → ""）。 */
  baseUrl: string;
  /** 该 provider 声明的 model id 列表（按声明序去重；无 → []）。 */
  models: string[];
}

/** 从 settings.modelProviders 提取 provider 条目（形状非法一律跳过，不炸）。 */
export function cliModelEntries(
  settings: SettingsObject | null | undefined,
): CliModelEntry[] {
  const mp =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).modelProviders
      : undefined;
  if (!mp || typeof mp !== "object" || Array.isArray(mp)) return [];
  const out: CliModelEntry[] = [];
  for (const [providerId, routes] of Object.entries(
    mp as Record<string, unknown>,
  )) {
    if (!Array.isArray(routes)) continue; // 非法条目（非数组）→ 跳过
    const models: string[] = [];
    let baseUrl = "";
    for (const route of routes) {
      if (!route || typeof route !== "object" || Array.isArray(route)) continue;
      const r = route as Record<string, unknown>;
      if (typeof r.id === "string" && r.id !== "" && !models.includes(r.id)) {
        models.push(r.id);
      }
      if (baseUrl === "" && typeof r.baseUrl === "string" && r.baseUrl !== "") {
        baseUrl = r.baseUrl;
      }
    }
    out.push({ id: providerId, baseUrl, models });
  }
  return out;
}

/** settings 的当前模型（双向兼容：qwen-code 对象 {name,baseUrl} / 扁平字符串）。 */
export interface CliCurrentModel {
  name: string;
  baseUrl: string;
  /** 按 baseUrl 反查 provider 条目；无 baseUrl / 无匹配（孤儿 baseUrl）→ null。 */
  providerId: string | null;
}

export function cliCurrentModel(
  settings: SettingsObject | null | undefined,
): CliCurrentModel {
  const m =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).model
      : undefined;
  let name = "";
  let baseUrl = "";
  if (typeof m === "string") {
    name = m;
  } else if (m && typeof m === "object" && !Array.isArray(m)) {
    const mo = m as Record<string, unknown>;
    if (typeof mo.name === "string") name = mo.name;
    if (typeof mo.baseUrl === "string") baseUrl = mo.baseUrl;
  }
  let providerId: string | null = null;
  if (baseUrl !== "") {
    providerId =
      cliModelEntries(settings).find((e) => e.baseUrl === baseUrl)?.id ?? null;
  }
  return { name, baseUrl, providerId };
}

/**
 * 构造 settings 端点补丁（controller 对真树 deep-merge）：
 * - qwen-code（对象形态）→ `{ model: { ...existingModel, name, baseUrl } }`：
 *   保留原 model 对象其余键（如 envKey）；baseUrl 空 → 删除该键（不写空值）。
 * - opencode / qoder（扁平形态）→ `{ model: name }`（无 provider 维度）。
 */
export function buildCliModelPatch(
  cli: CodingCliId,
  existingModel: unknown,
  name: string,
  baseUrl: string,
): Record<string, unknown> {
  // 形态映射（与 codingcli.objectModel 一致：仅 qwen-code 为对象形态）。
  if (cli !== "qwen-code") return { model: name };
  const base =
    existingModel &&
    typeof existingModel === "object" &&
    !Array.isArray(existingModel)
      ? (existingModel as Record<string, unknown>)
      : {};
  const next: Record<string, unknown> = { ...base, name };
  if (baseUrl !== "") next.baseUrl = baseUrl;
  else delete next.baseUrl;
  return { model: next };
}
