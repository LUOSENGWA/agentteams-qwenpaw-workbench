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
import type { ModelAccessPair } from "../api/domains/modelAccess";
import type { ModelPickerProvider } from "./modelPickerModel";

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

// ── 模型选择器目录（单一来源）：CodingCLI 模型弹层的 Provider 候选 +
//    行状态/保存语义判定。原先散落在 ModelEditModal（pickerProviders
//    拼装 / workerOptions / modelOptionsFor / follow 哨兵判定）的重复
//    逻辑收口于此；组件只渲染——ModelPicker 仍是唯一选择器 UI，其模型
//    过滤/换 Provider 清空判定走 lib/modelPickerModel 的
//    modelOptionsForProvider / keepModelForProvider（本文件不重复实现）。
//    新增导出仍只 import type（运行时零依赖，node 可直测）。

/** 「跟随 Worker（不指定 baseUrl）」的 Provider 哨兵值（值不改，既有口径）。 */
export const CLI_FOLLOW_WORKER = "~follow~";
/** 「跟随子代理」的 Provider 哨兵值（= 不写 baseUrl，model 名指向子代理
 * 当前值；子代理未设 → 该选项禁用）。 */
export const CLI_FOLLOW_SPAWN = "~follow-spawn~";
/** Worker 模型目录候选的 Provider 值前缀（与 CLI modelProviders 条目 id
 * 区分；保存 = 仅模型 hint，不写 baseUrl，路由仍按 CLI/Worker 默认解析）。 */
export const CLI_WORKER_PROVIDER_PREFIX = "worker:";

/** 是否跟随哨兵（行状态/弹层初始/保存语义共用判定）。 */
export function isCliFollowProvider(provider: string): boolean {
  return provider === CLI_FOLLOW_WORKER || provider === CLI_FOLLOW_SPAWN;
}

/** 当前模型四态（行状态文案与弹层默认 Provider 的单一来源）：
 * none = 未配置；follow-worker = 无 baseUrl 且名 = Worker 主模型；
 * follow-spawn = 无 baseUrl 且名 = 子代理模型（且 ≠ 主模型）；
 * independent = 有 baseUrl（含孤儿）或名与两目标都不相等。 */
export type CliModelKind =
  | "none"
  | "follow-worker"
  | "follow-spawn"
  | "independent";

export function classifyCliModel(
  settings: SettingsObject | null | undefined,
  mainModel: string,
  subagentModel: string,
): CliModelKind {
  const cur = cliCurrentModel(settings);
  if (!cur.name) return "none";
  if (cur.baseUrl === "" && cur.name === mainModel) return "follow-worker";
  if (
    cur.baseUrl === "" &&
    subagentModel !== "" &&
    cur.name === subagentModel &&
    subagentModel !== mainModel
  ) {
    return "follow-spawn";
  }
  return "independent";
}

/** 弹层初始 Provider/Model（classifyCliModel 的弹层投影；独立态孤儿
 * baseUrl——反查不到条目——回落跟随 Worker，保持「孤儿值不回显」口径）。 */
export interface CliModelInitialSelection {
  provider: string;
  model: string;
}

export function cliModelInitialSelection(
  settings: SettingsObject | null | undefined,
  mainModel: string,
  subagentModel: string,
): CliModelInitialSelection {
  const kind = classifyCliModel(settings, mainModel, subagentModel);
  if (kind === "follow-spawn")
    return { provider: CLI_FOLLOW_SPAWN, model: subagentModel };
  if (kind === "independent") {
    const cur = cliCurrentModel(settings);
    if (cur.providerId) return { provider: cur.providerId, model: cur.name };
  }
  return { provider: CLI_FOLLOW_WORKER, model: mainModel };
}

/** 保存语义（单一来源）：跟随 = 写跟随目标模型名、不写 baseUrl；
 * 独立 = 所选/输入模型名（trim）+ 该 provider 条目的 baseUrl（worker:
 * 前缀 / 无匹配条目 → 不写 baseUrl）。 */
export interface CliModelSelection {
  name: string;
  baseUrl: string;
  isFollow: boolean;
}

export function resolveCliModelSelection(
  provider: string,
  selectedModel: string,
  mainModel: string,
  subagentModel: string,
  entries: CliModelEntry[],
): CliModelSelection {
  if (provider === CLI_FOLLOW_WORKER)
    return { name: mainModel, baseUrl: "", isFollow: true };
  if (provider === CLI_FOLLOW_SPAWN)
    return { name: subagentModel, baseUrl: "", isFollow: true };
  const chosen = entries.find((e) => e.id === provider) ?? null;
  return {
    name: selectedModel.trim(),
    baseUrl: chosen ? chosen.baseUrl : "",
    isFollow: false,
  };
}

export interface CliModelPickerInput {
  /** CLI modelProviders 条目（cliModelEntries 输出）。 */
  entries: CliModelEntry[];
  /** Worker 主模型 Provider 目录（ModelEditModal.pickerProviders 原样透传；
   * name/models 空候选在此统一剔除，调用方不再 .filter）。 */
  workerProviders: ModelPickerProvider[];
  /** Worker 主模型（「跟随 Worker」目标；空 → 该选项禁用）。 */
  mainModel: string;
  /** Worker 已保存子代理模型（"" → 「跟随子代理」禁用）。 */
  subagentModel: string;
  /** L2 授予 (provider, model) 对（缺省/空 = 无授予集 → 无限制；非空 =
   * 授予对是独立 Provider 的唯一候选源，不列 Worker 候选）。 */
  grantedPairs?: ModelAccessPair[];
  /** 展示标签与分组名（调用方 i18n 化后传入；本模块保持纯函数不碰
   * window）。分组经 ModelPickerProvider.group 下发，ModelPicker 统一
   * 渲染（groupModelPickerProviders），本模块不渲染。 */
  labels: {
    followWorker: string;
    followSpawn: string;
    /** 「跟随 Worker / 跟随子代理」两选项的分组标签。 */
    followGroup: string;
    /** CLI modelProviders 条目 + Worker 目录候选（+L2 授予对）的分组标签。 */
    providerGroup: string;
  };
}

/** CodingCLI 模型弹层的唯一 Provider 目录。顺序 = 跟随 Worker / 跟随
 * 子代理（group = labels.followGroup）/ CLI 条目（label `id · baseUrl`）/
 * Worker 候选（`worker:<name>`，label `wp.label ?? wp.name`，无后缀；与 CLI
 * 条目同 id 时 CLI 条目优先，不重复列；name/models 空者剔除），后两者
 * group = labels.providerGroup。grantedPairs 非空时独立 Provider 只取授予对
 * （方向 provider → models，模型去重，group 同上；不列 Worker 候选）。每个
 * provider 的 models 即 ModelPicker 候选源（分组渲染/过滤/清空由 ModelPicker
 * 统一执行，本模块只下发 group 元数据）。 */
export function buildCliModelPickerProviders(
  input: CliModelPickerInput,
): ModelPickerProvider[] {
  const { entries, workerProviders, mainModel, subagentModel, labels } = input;
  const grantedPairs = input.grantedPairs ?? [];
  const out: ModelPickerProvider[] = [
    {
      name: CLI_FOLLOW_WORKER,
      label: labels.followWorker,
      models: mainModel ? [mainModel] : [],
      disabled: mainModel === "",
      group: labels.followGroup,
    },
    {
      name: CLI_FOLLOW_SPAWN,
      label: labels.followSpawn,
      models: subagentModel ? [subagentModel] : [],
      disabled: subagentModel === "",
      group: labels.followGroup,
    },
  ];
  if (grantedPairs.length > 0) {
    // L2：授予对是唯一候选源（方向 provider → models，模型去重）。
    const byProvider = new Map<string, string[]>();
    for (const p of grantedPairs) {
      if (!p.provider) continue;
      const list = byProvider.get(p.provider) ?? [];
      if (!list.includes(p.model)) list.push(p.model);
      byProvider.set(p.provider, list);
    }
    for (const [id, models] of byProvider) {
      const e = entries.find((x) => x.id === id);
      out.push({
        name: id,
        label: e?.baseUrl ? `${id} · ${e.baseUrl}` : id,
        models,
        group: labels.providerGroup,
      });
    }
    return out;
  }
  for (const e of entries) {
    out.push({
      name: e.id,
      label: e.baseUrl ? `${e.id} · ${e.baseUrl}` : e.id,
      models: e.models,
      group: labels.providerGroup,
    });
  }
  for (const wp of workerProviders) {
    const models = wp.models ?? [];
    if (!wp.name || models.length === 0) continue;
    if (entries.some((e) => e.id === wp.name)) continue;
    out.push({
      name: `${CLI_WORKER_PROVIDER_PREFIX}${wp.name}`,
      label: wp.label ?? wp.name,
      models,
      group: labels.providerGroup,
    });
  }
  return out;
}
