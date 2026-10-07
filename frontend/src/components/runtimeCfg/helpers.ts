/** WorkerRuntimeConfig 纯 helper 与常量——自 WorkerRuntimeConfig.tsx 纯移动拆出
 * （任务书 183 S3，行为零变化）。 */

export type Rc = Record<string, unknown>;

export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 正整数字符串校验（max_iters / llm_max_retries）。 */
export function isPosInt(s: string): boolean {
  return /^\d+$/.test(s.trim()) && Number(s.trim()) > 0;
}

/** 正数字符串校验（backoff 秒数）。 */
export function isPosNum(s: string): boolean {
  const n = Number(s.trim());
  return s.trim() !== "" && Number.isFinite(n) && n > 0;
}

/**
 * v0.5.0-beta.13.7 Loop 全 gate 模型（13.6 Loop 设置抄 QwenPaw 没抄完
 * 正源 = qwenpaw/config/config.py LoopConfig 数据模型 + QwenPaw console
 * AgentLoopCard 控件逐一对账）：
 * - 迭代上限在 **Agent Loop → Default → iteration 门**（QwenPaw
 * IterationSection：enable Switch + **InputNumber** min=1 max=500——
 * QwenPaw 配置面**没有滑杆**，13.6 的 Slider 是插件自创，废弃）；
 * - doom_loop 键名 = **window_size**（13.6 parseLoop 误读 `window`，
 * 恒 null，速览 tag 缺值）；
 * - rubric/goal/mission 参数 13.6 完全未做，本轮补齐。
 */
export interface DoomStageV {
  after: number | null;
  action: "modify_prompt" | "stop";
  prompt: string;
}
interface LoopGates {
  iterationEnabled: boolean;
  iterationMax: number | null;
  doomEnabled: boolean;
  doomWindow: number | null;
  doomThreshold: number | null;
  doomStages: DoomStageV[];
  rubricEnabled: boolean;
  rubricPrompt: string;
  rubricInterventions: number | null;
  goalMaxIters: number | null;
  goalMaxTokens: number | null;
  missionMaxIters: number | null;
  missionMaxRetries: number | null;
  missionVerifyInstructions: string;
  missionVerifyCommand: string;
}

export function parseLoop(v: unknown): LoopGates {
  const o = (v && typeof v === "object" ? v : {}) as Rc;
  const it = (o.iteration && typeof o.iteration === "object" ? o.iteration : {}) as Rc;
  const doom = (o.doom_loop && typeof o.doom_loop === "object" ? o.doom_loop : {}) as Rc;
  const rub = (o.rubric && typeof o.rubric === "object" ? o.rubric : {}) as Rc;
  const goal = (o.goal && typeof o.goal === "object" ? o.goal : {}) as Rc;
  const mis = (o.mission && typeof o.mission === "object" ? o.mission : {}) as Rc;
  const stagesRaw = Array.isArray(doom.stages) ? doom.stages : [];
  return {
    iterationEnabled: it.enabled === true,
    iterationMax: num(it.max_iterations),
    doomEnabled: doom.enabled === true,
    doomWindow: num(doom.window_size),
    doomThreshold: num(doom.similarity_threshold),
    doomStages: stagesRaw
      .filter((s): s is Rc => s && typeof s === "object")
      .map((s) => ({
        after: num(s.after),
        action: s.action === "stop" ? "stop" : "modify_prompt",
        prompt: typeof s.prompt === "string" ? s.prompt : "",
      })),
    rubricEnabled: rub.enabled === true,
    rubricPrompt: typeof rub.prompt === "string" ? rub.prompt : "",
    rubricInterventions: num(rub.max_interventions),
    goalMaxIters: num(goal.max_iterations),
    goalMaxTokens: num(goal.max_tokens),
    missionMaxIters: num(mis.max_iterations),
    missionMaxRetries: num(mis.max_retries_per_story),
    missionVerifyInstructions:
      typeof mis.default_verification_instructions === "string"
        ? (mis.default_verification_instructions as string)
        : "",
    missionVerifyCommand:
      typeof mis.default_verify_command === "string"
        ? (mis.default_verify_command as string)
        : "",
  };
}

export const SOURCE_COLOR: Record<string, string> = {
  builtin: "blue",
  custom: "orange",
  plugin: "purple",
};

/** v0.5.0-beta.13.8（13.7 「QwenPaw 有模板的，你可以抄过来——别忘
 * 开源项目的礼仪」）：Loop 模板 + gate 定义移植自 QwenPaw console
 * AgentLoopCard.tsx（agentscope-ai/QwenPaw，开源项目）。礼仪处理：
 * ① 模板名/gate 定义/默认值逐值保留原作者设计 ② 代码注释保留出处 ③
 * 插件 THIRD-PARTY-NOTICES/README 登记（时同步）。
 * 上游源：SC/QwenPaw/console/src/pages/Agent/Config/components/AgentLoopCard.tsx
 * （GATE_DEFINITIONS L716-814 / TEMPLATES L1418 / makeGate L428 /
 * buildCustomLoopMode L445，@c8eb9fd2 实读）。 */
type LoopGateType =
  | "iteration"
  | "doom_loop"
  | "token_budget"
  | "timeout"
  | "tool_call_budget"
  | "qualitative_rubric"
  | "completion_rubric";

export const LOOP_TEMPLATES: Record<string, LoopGateType[]> = {
  safe: ["iteration", "token_budget", "doom_loop", "qualitative_rubric"],
  research: ["iteration", "timeout", "tool_call_budget", "doom_loop"],
  quality: ["iteration", "token_budget", "doom_loop", "completion_rubric"],
  blank: [],
};

export const LOOP_GATE_DEFS: Record<
  LoopGateType,
  { title: string; desc: string; defaults: Record<string, unknown> }
> = {
  iteration: {
    title: "迭代限制",
    desc: "固定迭代次数后停止。",
    defaults: { max_iterations: 40 },
  },
  doom_loop: {
    title: "重复保护",
    desc: "检测重复工具调用并改变策略。",
    defaults: {
      window_size: 3,
      similarity_threshold: 1,
      stages: [
        {
          after: 3,
          action: "modify_prompt",
          prompt: "Change strategy instead of repeating the same action.",
        },
        {
          after: 5,
          action: "stop",
          prompt: "Stopped after repeated actions did not make progress.",
        },
      ],
    },
  },
  token_budget: {
    title: "词元预算",
    desc: "限制提示与生成词元用量。",
    defaults: { max_total_tokens: 120000 },
  },
  timeout: {
    title: "循环时限",
    desc: "超过耗时后在下一个循环边界停止。",
    defaults: { max_seconds: 1800 },
  },
  tool_call_budget: {
    title: "工具调用预算",
    desc: "限制全部调用与指定工具。",
    defaults: { max_calls: 30, per_tool: {} },
  },
  qualitative_rubric: {
    title: "定性完成检查",
    desc: "结束前检查无工具调用的文本回复。",
    defaults: {
      rubric: "Every explicit user requirement must be addressed.",
      max_evaluations: 1,
    },
  },
  completion_rubric: {
    title: "完成信号检查",
    desc: "检查文本回复中的完成信号。",
    defaults: {
      prompt:
        "Treat the task as complete only when every explicit user requirement has been addressed. If any requirement remains, the task is incomplete and work must continue until it is addressed.",
      completion_signal: "COMPLETED",
      max_evaluations: 3,
    },
  },
};
