// LLM 调优参数（移植自 dashboard #146 缺口 3，SC/agentteams-dashboard
// src/lib/llm-tuning.ts——纯逻辑，零 UI 依赖，可单测）。
//
// 数据面：AgentTeams Controller WorkerSpec / TeamSpec 的 llm* 字段
// （agentteams-controller/api/v1beta1/types.go；响应顶层 camelCase，
// workerToResponse 回显，omitempty=未设置不显）。插件经
// GET /agents/proxy…/workers/{name} 读、PUT /workers/{name} 写。
//
// 归属层级：Worker 覆盖 → 团队默认 → 运行时 env 实际生效值 → registry 兜底。
// env 层（15.28）：stream 组两字段无 registry 固定默认，实际值由
// worker-entrypoint 的 AGENTTEAMS_LLM_STREAM_TIMEOUT_S 兜底（controller
// 覆写时 hot-apply 进容器 env）——预填正源 = runtime-env 端点实读。
// 两组语义（1.2.5 源码实读 resource_handler.go / types.go）：
//   · startup：QwenPaw 启动期读取，改后需重建容器才生效（spec-hash 驱动）。
//   · stream ：热更新，运行时每次流式请求重读，无需重启（QwenPaw >= 2.2.1）。
//
// 值语义（对齐上游指针语义）：PUT 请求 llm* 为 *string——
//   不传（nil）= 不动；""（空串）= 清除（回退团队/registry 默认）；
//   非空 = 覆盖。数值须为非负整数或小数。
//
// 权限：llm* 全字段 L1-only（checkScopedWorkerUpdate 明确 forbidden
// 「LLM tuning is a decision-layer field」；L2/L3 → 403）。
//
// label/unit/group-label 为中文源文本=tr() 键，组件渲染时 tr() 包裹
// （i18n.ts 全量注册 en 键）；lib 本身保持纯逻辑不引 React/i18n。

export type LlmTuningGroup = "startup" | "stream";

export type LlmTuningKey =
  | "llmMaxRetries"
  | "llmBackoffBase"
  | "llmBackoffCap"
  | "llmMaxConcurrent"
  | "llmMaxQpm"
  | "llmRateLimitPause"
  | "llmRateLimitJitter"
  | "llmAcquireTimeout"
  | "llmStreamFirstContentTimeout"
  | "llmStreamIdleTimeout";

interface LlmTuningField {
  key: LlmTuningKey;
  /** 中文源文本（tr() 键），组件渲染时 tr(label)。 */
  label: string;
  group: LlmTuningGroup;
  /** 单位（tr() 键，可选）。 */
  unit?: string;
  /** QwenPaw registry 默认值（来自上游字段注释；stream 组上游未给固定默认）。 */
  registryDefault?: string;
  /** 运行时 env 变量名（可选）：worker/team 均无值时，以容器 PID 1 env
   * 实际值兜底预填（entrypoint 默认 300s；controller hot-apply 覆写）。 */
  envKey?: string;
}

/** 组标题（tr() 键）。 */
export const LLM_TUNING_GROUP_LABELS: Record<LlmTuningGroup, string> = {
  startup: "重试与限流（启动期生效，保存后需重建容器）",
  stream: "流式超时（热更新，保存后立即生效）",
};

export const LLM_TUNING_FIELDS: readonly LlmTuningField[] = [
  { key: "llmMaxRetries", label: "最大重试次数", group: "startup", registryDefault: "3" },
  { key: "llmBackoffBase", label: "退避基数", group: "startup", unit: "秒", registryDefault: "1" },
  { key: "llmBackoffCap", label: "退避上限", group: "startup", unit: "秒", registryDefault: "10" },
  { key: "llmMaxConcurrent", label: "最大并发请求数", group: "startup", registryDefault: "10" },
  { key: "llmMaxQpm", label: "每分钟最大请求数", group: "startup", registryDefault: "600" },
  { key: "llmRateLimitPause", label: "限流暂停", group: "startup", unit: "秒", registryDefault: "5" },
  { key: "llmRateLimitJitter", label: "限流抖动", group: "startup", unit: "秒", registryDefault: "1" },
  { key: "llmAcquireTimeout", label: "获取许可超时", group: "startup", unit: "秒", registryDefault: "300" },
  { key: "llmStreamFirstContentTimeout", label: "首段输出超时", group: "stream", unit: "秒", envKey: "QWENPAW_LLM_STREAM_FIRST_CONTENT_TIMEOUT" },
  { key: "llmStreamIdleTimeout", label: "输出中断超时", group: "stream", unit: "秒", envKey: "QWENPAW_LLM_STREAM_IDLE_TIMEOUT" },
] as const;

export type LlmTuningValues = Partial<Record<LlmTuningKey, string>>;
export type LlmTuningRecord = Record<LlmTuningKey, string>;

const NON_NEGATIVE_NUMBER = /^\d+(\.\d+)?$/;

/** 空串合法（= 回退默认）；否则须为非负整数或小数。返回错误文案（tr 键）或 null。 */
export function validateLlmTuningValue(value: string): string | null {
  const v = value.trim();
  if (v === "") return null;
  if (!NON_NEGATIVE_NUMBER.test(v)) return "须为非负数字（整数或小数）";
  return null;
}

/** 从 Worker/Team 记录提取全部字段（缺省 / 非字符串 → 空串）。 */
export function pickLlmTuning(
  record: LlmTuningValues | null | undefined,
): LlmTuningRecord {
  const out = {} as LlmTuningRecord;
  for (const field of LLM_TUNING_FIELDS) {
    const value = record?.[field.key];
    out[field.key] = typeof value === "string" ? value : "";
  }
  return out;
}

/** 字段级 diff：仅收集发生变化的键；清空（→ ''）同样计入（= 清除覆盖）。 */
export function diffLlmTuning(
  current: LlmTuningRecord,
  draft: LlmTuningRecord,
): LlmTuningValues {
  const diff: LlmTuningValues = {};
  for (const field of LLM_TUNING_FIELDS) {
    if (draft[field.key] !== current[field.key]) diff[field.key] = draft[field.key];
  }
  return diff;
}

/** 空记录（全字段空串）。 */
export function emptyLlmTuning(): LlmTuningRecord {
  const out = {} as LlmTuningRecord;
  for (const field of LLM_TUNING_FIELDS) out[field.key] = "";
  return out;
}

/** 继承值（团队默认 → 运行时 env 实际值 → registry 兜底）：worker 无覆盖
 * 时逐级继承到的值。envEffective=按字段 key 映射的容器 env 实际值
 * （runtime-env 端点实读；可选，拉取失败=走原三层链）。 */
function inheritedLlmTuning(
  team: LlmTuningRecord,
  envEffective?: LlmTuningValues,
): LlmTuningRecord {
  const out = {} as LlmTuningRecord;
  for (const field of LLM_TUNING_FIELDS) {
    out[field.key] =
      team[field.key] || envEffective?.[field.key] || field.registryDefault || "";
  }
  return out;
}

/** 当前生效值（Worker 覆盖 → 团队默认 → env 实际值 → registry 兜底）：
 * worker 此刻实际在用。 */
export function resolveEffectiveLlmTuning(
  override: LlmTuningRecord,
  team: LlmTuningRecord,
  envEffective?: LlmTuningValues,
): LlmTuningRecord {
  const inherited = inheritedLlmTuning(team, envEffective);
  const out = {} as LlmTuningRecord;
  for (const field of LLM_TUNING_FIELDS) {
    out[field.key] = override[field.key] || inherited[field.key];
  }
  return out;
}

/** 字段级写 diff（生效值预填 + override 语义）：
 *  desired=用户编辑后的显示值；newOverride=(desired===继承值 ? "" : desired)
 *  （改回继承值=清除覆盖，不写冗余）；仅收集 newOverride≠当前 worker 覆盖的键。
 *  envEffective 同 inheritedLlmTuning（stream 组 env 实际值层）。 */
export function diffLlmTuningToOverride(
  draft: LlmTuningRecord,
  team: LlmTuningRecord,
  override: LlmTuningRecord,
  envEffective?: LlmTuningValues,
): LlmTuningValues {
  const inherited = inheritedLlmTuning(team, envEffective);
  const diff: LlmTuningValues = {};
  for (const field of LLM_TUNING_FIELDS) {
    const desired = draft[field.key];
    const newOverride = desired === inherited[field.key] ? "" : desired;
    if (newOverride !== override[field.key]) diff[field.key] = newOverride;
  }
  return diff;
}

/** 校验整组，返回第一个非法字段（按字段顺序）。 */
export function findLlmTuningError(
  draft: LlmTuningRecord,
): { key: LlmTuningKey; label: string; message: string } | null {
  for (const field of LLM_TUNING_FIELDS) {
    const message = validateLlmTuningValue(draft[field.key]);
    if (message) return { key: field.key, label: field.label, message };
  }
  return null;
}
