/**
 * WorkerRuntimeConfig.tsx — A2：Worker 运行配置（消费上游 #1231 端点族）。
 *
 * 9/6 顺序铁律「插件 A2 先做先验证，dashboard 后对齐」——插件侧本轮落地，
 * dashboard B5（#103）为镜像语义。
 *
 * 契约（上游 pinned qwenpaw running-config + loops router 实读 +
 * Node1 v1.2.4 实盘 GET 交叉验证；#13.5 按 pr-body 字段清单全量对账）：
 * - GET/PUT /api/v1/workers/{name}/runtime-config = 5-tab 运行配置
 *   （max_iters / loop / llm_retry_enabled / llm_max_retries /
 *   llm_backoff_base / llm_backoff_cap / memory_manager_backend /
 *   reme_light_memory_config / adbpg_memory_config）；PUT = read-merge-
 *   write，只发改动顶层键，未带键不动，空 body = no-op。
 * - GET /loops = 模式目录（builtin/custom/plugin 三源）。
 * - GET /loops/status = 单会话激活 loop（chat_id/session_id 二参，
 *   消费点=WorkerChats 会话详情头，非本面板）。
 * - GET/POST/PUT/DELETE /loops/custom[/{id}] = 自定义 loop CRUD
 *   （PUT 整块替换，body.id 必须等于路径 id；409 重名 / 422 管道校验）。
 * - 仅 spec.runtime == "qwenpaw" 生效（其余 runtime → 400）。
 * - L1 全字段（除 approval_level）；L2 = 5-tab 字段白名单，未知键拒绝
 *   不静默丢弃 → 本面板可编辑键全部在 L2 白名单内，diff 按构造 L2 安全。
 * - approval_level 由审批端点（#1216）管理——本面板只读展示，PUT 发送
 *   会被服务端 400 拒绝。
 * - loop（含 custom_modes）改动成功后服务端自动通知团队 Leader。
 * - 409 = Worker 正在执行任务/配置锁定；404 = Controller 未含该端点
 *   或 L2 越权 → 占位横幅降级。
 *
 * ⚠️ 字段名勘误（交叉验证发现）：dashboard B5（#103）spec 用的
 * max_input_tokens / compaction_threshold / loop_config 与 pinned 契约
 * 不符（实盘键 = max_input_length / 嵌套 light_context_config.
 * context_compact_config.compact_threshold_ratio / 顶层 loop）——L2 发
 * 白名单外键 400、L1 发则写入垃圾键。本面板按实盘契约命名；dashboard
 * 侧需随动。
 *
 * 纪律：React/antd 取宿主（window.QwenPaw.host）；只走
 * /agentteams-proxy/controller 通用代理（后端零新端点）。
 */
import type * as ReactNS from "react";

import {
  requestJson,
  httpErrorStatus,
  httpErrorDetail,
  fetchWorkerLoops,
  fetchWorkerLoopCustoms,
  createWorkerLoopCustom,
  updateWorkerLoopCustom,
  deleteWorkerLoopCustom,
  type WorkerLoopModeInfo,
  type WorkerLoopCustomMode,
} from "../api";
import { useT } from "../i18n";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

type Rc = Record<string, unknown>;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 正整数字符串校验（max_iters / llm_max_retries）。 */
function isPosInt(s: string): boolean {
  return /^\d+$/.test(s.trim()) && Number(s.trim()) > 0;
}

/** 正数字符串校验（backoff 秒数）。 */
function isPosNum(s: string): boolean {
  const n = Number(s.trim());
  return s.trim() !== "" && Number.isFinite(n) && n > 0;
}

/**
 * v0.5.0-beta.13.7 Loop 全 gate 模型（13.6 装验「Loop 设置抄 QwenPaw 没抄完」
 * 正源 = qwenpaw/config/config.py LoopConfig 数据模型 + QwenPaw console
 * AgentLoopCard 控件逐一对账）：
 * - 迭代上限在 **Agent Loop → Default → iteration 门**（QwenPaw
 *   IterationSection：enable Switch + **InputNumber** min=1 max=500——
 *   QwenPaw 配置面**没有滑杆**，13.6 的 Slider 是插件自创，废弃）；
 * - doom_loop 键名 = **window_size**（13.6 parseLoop 误读 `window`，
 *   恒 null，速览 tag 缺值）；
 * - rubric/goal/mission 参数 13.6 完全未做，本轮补齐。
 */
interface DoomStageV {
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

function parseLoop(v: unknown): LoopGates {
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

const SOURCE_COLOR: Record<string, string> = {
  builtin: "blue",
  custom: "orange",
  plugin: "purple",
};


/** QwenPaw console Form.Item 行等价物（label + ⓘ tooltip 左 / 控件右，
 *  垂直堆叠行——Agent Config 页的呈现语言）。 */
function CfgRow({
  label,
  tip,
  children,
}: {
  label: string;
  tip?: string;
  children: ReactNS.ReactNode;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "150px 1fr",
        gap: 10,
        alignItems: "center",
        padding: "7px 0",
        borderBottom: "1px solid rgba(127,127,127,0.12)",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          fontSize: 13,
          color: "rgba(127,127,127,0.95)",
        }}
      >
        {label}
        {tip ? (
          <antd.Tooltip title={tip}>
            <span
              style={{
                fontSize: 11,
                color: "rgba(127,127,127,0.55)",
                cursor: "help",
                lineHeight: 1,
              }}
            >
              ⓘ
            </span>
          </antd.Tooltip>
        ) : null}
      </span>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

/** QwenPaw AgentLoopCard gate 卡（LockedGateCard 同款语义：Switch 启停 +
 *  点开参数区；未启用时收起无参数）。 */
function GateSection({
  title,
  tip,
  enabled,
  onEnabled,
  children,
}: {
  title: string;
  tip?: string;
  enabled: boolean;
  onEnabled?: (v: boolean) => void;
  children?: ReactNS.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <div style={{ border: "1px solid rgba(127,127,127,0.2)", borderRadius: 8, marginBottom: 8 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          cursor: enabled ? "pointer" : "default",
          background: "rgba(127,127,127,0.05)",
          borderRadius: 8,
        }}
        onClick={() => {
          if (enabled) setOpen((v) => !v);
        }}
      >
        <antd.Switch
          size="small"
          checked={enabled}
          onChange={(v: boolean) => onEnabled?.(v)}
          onClick={(_c: boolean, e: ReactNS.MouseEvent) => e.stopPropagation()}
        />
        <span style={{ fontWeight: 600, fontSize: 12.5 }}>{title}</span>
        {tip ? (
          <antd.Tooltip title={tip}>
            <span style={{ fontSize: 11, color: "rgba(127,127,127,0.55)", cursor: "help", lineHeight: 1 }}>ⓘ</span>
          </antd.Tooltip>
        ) : null}
        <div style={{ flex: 1 }} />
        {enabled ? (
          <span style={{ fontSize: 9, color: "rgba(0,0,0,0.45)" }}>{open ? "▲" : "▼"}</span>
        ) : (
          <span style={{ fontSize: 10.5, color: "rgba(0,0,0,0.35)" }}>off</span>
        )}
      </div>
      {enabled && open ? (
        <div style={{ padding: "8px 10px", display: "grid", gap: 6 }}>{children}</div>
      ) : null}
    </div>
  );
}

/** 参数行（gate 卡内：label 左 / 控件右，紧凑）。 */
function GateParam({
  label,
  children,
}: {
  label: string;
  children: ReactNS.ReactNode;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 8, alignItems: "center" }}>
      <span style={{ fontSize: 11.5, color: "rgba(127,127,127,0.95)" }}>{label}</span>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

/** v0.5.0-beta.13.8 六 tab 补齐——新字段组草稿（key=字段路径，
 *  null/undefined=未改动；buildDiff 时与当前值比对决定是否入 diff）。 */
type EditVal = string | boolean | null;
type EditMap = Record<string, EditVal>;

/** v0.5.0-beta.13.8（13.7 装验「QwenPaw 有模板的，你可以抄过来——别忘
 *  开源项目的礼仪」）：Loop 模板 + gate 定义移植自 QwenPaw console
 *  AgentLoopCard.tsx（agentscope-ai/QwenPaw，开源项目）。礼仪处理：
 *  ① 模板名/gate 定义/默认值逐值保留原作者设计 ② 代码注释保留出处 ③
 *  插件 THIRD-PARTY-NOTICES/README 登记（收口时同步）。
 *  上游源：SC/QwenPaw/console/src/pages/Agent/Config/components/AgentLoopCard.tsx
 *  （GATE_DEFINITIONS L716-814 / TEMPLATES L1418 / makeGate L428 /
 *  buildCustomLoopMode L445，@c8eb9fd2 实读）。 */
type LoopGateType =
  | "iteration"
  | "doom_loop"
  | "token_budget"
  | "timeout"
  | "tool_call_budget"
  | "qualitative_rubric"
  | "completion_rubric";

const LOOP_TEMPLATES: Record<string, LoopGateType[]> = {
  safe: ["iteration", "token_budget", "doom_loop", "qualitative_rubric"],
  research: ["iteration", "timeout", "tool_call_budget", "doom_loop"],
  quality: ["iteration", "token_budget", "doom_loop", "completion_rubric"],
  blank: [],
};

const LOOP_GATE_DEFS: Record<
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

function WorkerRuntimeConfig({
  name,
  l1,
  onOpenSettings,
}: {
  name: string;
  /** 当前账号 L1（controller token）——L1-only 字段（并发限流/上下文管理/
   *  shell 组/auto_title）可编辑；L2 只读（PUT 非 L2 白名单键被服务端 403）。 */
  l1?: boolean;
  /** v0.5.0-beta.13.10（B1：L1 登录仍见「只读」Alert）：跳「设置」页
   *  配 Controller token 的入口（L1 账号密码登录只落 Higress Console
   *  会话 ≠ Controller 管理 token——两套凭证，Alert 给明确指引）。 */
  onOpenSettings?: () => void;
}) {
  const tr = useT();
  const [open, setOpen] = React.useState(false);
  const [cfg, setCfg] = React.useState<Rc | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [gate, setGate] = React.useState<"" | "404" | "400">("");
  const [gateMsg, setGateMsg] = React.useState("");

  // 编辑值（null = 未改动）。
  // v0.5.0-beta.13.7（13.6 装验「基本 tab 的拖动条有问题，QwenPaw 是输入
  // 数字的」）：maxIters Slider 废弃——QwenPaw 正源配置面**无滑杆**，迭代
  // 上限 = Agent Loop → Default → iteration 门（enable Switch + InputNumber
  // 1..500）；保存时按 useAgentConfig L183-185 语义镜像 legacy max_iters。
  const [iterEnabled, setIterEnabled] = React.useState<boolean | null>(null);
  const [iterValue, setIterValue] = React.useState<string | null>(null);
  const [doomEnabled, setDoomEnabled] = React.useState<boolean | null>(null);
  const [doomWindow, setDoomWindow] = React.useState<string | null>(null);
  const [doomThreshold, setDoomThreshold] = React.useState<string | null>(null);
  const [doomStages, setDoomStages] = React.useState<DoomStageV[] | null>(null);
  const [rubricEnabled, setRubricEnabled] = React.useState<boolean | null>(null);
  const [rubricPrompt, setRubricPrompt] = React.useState<string | null>(null);
  const [rubricInterventions, setRubricInterventions] = React.useState<string | null>(null);
  const [goalIters, setGoalIters] = React.useState<string | null>(null);
  const [goalTokens, setGoalTokens] = React.useState<string | null>(null);
  const [missionIters, setMissionIters] = React.useState<string | null>(null);
  const [missionRetries, setMissionRetries] = React.useState<string | null>(null);
  const [missionInstr, setMissionInstr] = React.useState<string | null>(null);
  const [missionCmd, setMissionCmd] = React.useState<string | null>(null);
  // 记忆后端 = L2 白名单键（13.6 误标「L1 只读」，实盘契约纠正）。
  const [memBackend, setMemBackend] = React.useState<string | null>(null);
  const [retryOn, setRetryOn] = React.useState<boolean | null>(null);
  const [maxRetries, setMaxRetries] = React.useState<string | null>(null);
  const [backoffBase, setBackoffBase] = React.useState<string | null>(null);
  const [backoffCap, setBackoffCap] = React.useState<string | null>(null);
  // v0.5.0-beta.13.8（13.7 装验「ReAct 智能体/LLM 并发限流/上下文管理/
  // 长期记忆 都做进去了吗——接口实盘全在」）：六 tab 补齐的新字段组。
  // ReAct 智能体（shell_*/auto_title，L1）+ LLM 并发限流（5 键，L1）+
  // 上下文管理（light_context_config 嵌套，L1）+ 长期记忆（reme，L2 白名单）。
  const [shellEdits, setShellEdits] = React.useState<EditMap>({});
  const [rateEdits, setRateEdits] = React.useState<EditMap>({});
  const [ctxEdits, setCtxEdits] = React.useState<EditMap>({});
  const [remeEdits, setRemeEdits] = React.useState<EditMap>({});
  const mkSet =
    (setter: React.Dispatch<React.SetStateAction<EditMap>>) =>
    (k: string, v: EditVal) =>
      setter((p) => ({ ...p, [k]: v }));
  const shellSet = React.useCallback(mkSet(setShellEdits), []);
  const rateSet = React.useCallback(mkSet(setRateEdits), []);
  const ctxSet = React.useCallback(mkSet(setCtxEdits), []);
  const remeSet = React.useCallback(mkSet(setRemeEdits), []);
  // Loop 模板（QwenPaw AgentLoopCard 移植——见 LOOP_TEMPLATES 注释的署名）。
  const [tmplOpen, setTmplOpen] = React.useState(false);
  const [tmplName, setTmplName] = React.useState("");
  const [tmplCmd, setTmplCmd] = React.useState("");
  const [tmplDesc, setTmplDesc] = React.useState("");
  const [tmplSel, setTmplSel] = React.useState("safe");
  const [tmplGates, setTmplGates] = React.useState<Record<string, boolean>>({});
  const [tmplBusy, setTmplBusy] = React.useState(false);
  const [loopText, setLoopText] = React.useState<string | null>(null);
  const [loopOpen, setLoopOpen] = React.useState(false);

  // loop 模式节（#1231 端点族：目录 + 自定义 CRUD）。
  const [loops, setLoops] = React.useState<WorkerLoopModeInfo[] | null>(null);
  const [customs, setCustoms] = React.useState<WorkerLoopCustomMode[] | null>(null);
  const [loopsErr, setLoopsErr] = React.useState("");
  const [loopsLoading, setLoopsLoading] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [newJson, setNewJson] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState("");
  const [loopMsg, setLoopMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [memOpen, setMemOpen] = React.useState(false);

  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  const base = `/agentteams-proxy/controller/api/v1/workers/${encodeURIComponent(name)}`;
  const url = `${base}/runtime-config`;

  const loadLoops = React.useCallback(async () => {
    setLoopsLoading(true);
    setLoopsErr("");
    try {
      const [l, c] = await Promise.all([
        fetchWorkerLoops(name),
        fetchWorkerLoopCustoms(name),
      ]);
      setLoops(Array.isArray(l) ? l : []);
      setCustoms(Array.isArray(c) ? c : []);
    } catch (e) {
      setLoops(null);
      setCustoms(null);
      setLoopsErr(httpErrorDetail(e) || (e instanceof Error ? e.message : tr("加载失败")));
    } finally {
      setLoopsLoading(false);
    }
  }, [name, tr]);

  const load = React.useCallback(async () => {
    setLoading(true);
    setGate("");
    setGateMsg("");
    try {
      const d = (await requestJson(url)) as Rc;
      setCfg(d && typeof d === "object" ? d : null);
      void loadLoops();
    } catch (e) {
      const st = httpErrorStatus(e);
      if (st === 404) {
        setGate("404");
        setCfg(null);
      } else if (st === 400) {
        setGate("400");
        setGateMsg(httpErrorDetail(e));
        setCfg(null);
      } else {
        setGate("400");
        setGateMsg(e instanceof Error ? e.message : tr("加载失败"));
        setCfg(null);
      }
    } finally {
      setLoading(false);
    }
  }, [url, tr, loadLoops]);

  React.useEffect(() => {
    if (open && !cfg && !loading) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const resetEdits = () => {
    setIterEnabled(null);
    setIterValue(null);
    setDoomEnabled(null);
    setDoomWindow(null);
    setDoomThreshold(null);
    setDoomStages(null);
    setRubricEnabled(null);
    setRubricPrompt(null);
    setRubricInterventions(null);
    setGoalIters(null);
    setGoalTokens(null);
    setMissionIters(null);
    setMissionRetries(null);
    setMissionInstr(null);
    setMissionCmd(null);
    setMemBackend(null);
    setRetryOn(null);
    setMaxRetries(null);
    setBackoffBase(null);
    setBackoffCap(null);
    setLoopText(null);
    setShellEdits({});
    setRateEdits({});
    setCtxEdits({});
    setRemeEdits({});
    setMsg(null);
  };

  /** gate 编辑合并进当前 loop 对象（PUT loop=整块替换语义，必须发完整合并
   *  对象）。值域全部按 qwenpaw LoopConfig 数据模型校验（GE/LE 逐条对账）。
   *  返回 [merged, changed, invalidMsg]。 */
  const mergeLoopGates = (): {
    merged: Rc;
    changed: boolean;
    invalid: string;
  } => {
    const cur =
      cfg && typeof cfg.loop === "object" && cfg.loop ? (cfg.loop as Rc) : {};
    const merged = JSON.parse(JSON.stringify(cur)) as Rc;
    let changed = false;
    const sub = (k: string): Rc => {
      if (!merged[k] || typeof merged[k] !== "object") merged[k] = {};
      return merged[k] as Rc;
    };
    const checkInt = (
      s: string,
      lo: number,
      hi: number,
    ): number | null => {
      if (!/^\d+$/.test(s.trim())) return null;
      const n = Number(s.trim());
      return n >= lo && n <= hi ? n : null;
    };
    // ── iteration（Default 模式·迭代限制门）──
    const it = sub("iteration");
    if (iterEnabled !== null) {
      it.enabled = iterEnabled;
      changed = true;
    }
    if (iterValue !== null) {
      const n = checkInt(iterValue, 1, 500);
      if (n === null)
        return { merged, changed, invalid: tr("迭代上限须为 1..500 的整数") };
      if (n !== num(it.max_iterations)) {
        it.max_iterations = n;
        changed = true;
      }
    }
    // ── doom_loop（Default 模式·重复保护门）──
    const dl = sub("doom_loop");
    if (doomEnabled !== null) {
      dl.enabled = doomEnabled;
      changed = true;
    }
    if (doomWindow !== null) {
      const n = checkInt(doomWindow, 2, 100);
      if (n === null)
        return { merged, changed, invalid: tr("重复检测窗口须为 ≥2 的整数") };
      if (n !== num(dl.window_size)) {
        dl.window_size = n;
        changed = true;
      }
    }
    if (doomThreshold !== null) {
      const s = doomThreshold.trim();
      const n = Number(s);
      if (s === "" || !Number.isFinite(n) || n < 0 || n > 1)
        return {
          merged,
          changed,
          invalid: tr("相似度阈值须为 0..1 的数"),
        };
      if (n !== num(dl.similarity_threshold)) {
        dl.similarity_threshold = n;
        changed = true;
      }
    }
    if (doomStages !== null) {
      for (const st of doomStages) {
        if (st.after === null || !Number.isInteger(st.after) || st.after < 1)
          return {
            merged,
            changed,
            invalid: tr("重复规则：重复次数须为 ≥1 的整数"),
          };
      }
      const arr = doomStages.map((st) => ({
        after: st.after,
        action: st.action,
        prompt: st.prompt,
      }));
      if (JSON.stringify(arr) !== JSON.stringify(dl.stages ?? [])) {
        dl.stages = arr;
        changed = true;
      }
    }
    // ── rubric（Default 模式·完成质量检查门）──
    const rb = sub("rubric");
    if (rubricEnabled !== null) {
      rb.enabled = rubricEnabled;
      changed = true;
    }
    if (rubricPrompt !== null) {
      if (rubricPrompt.length > 4000)
        return { merged, changed, invalid: tr("Rubric 提示词过长（上限 4000 字）") };
      if (rubricPrompt !== String(rb.prompt ?? "")) {
        rb.prompt = rubricPrompt;
        changed = true;
      }
    }
    if (rubricInterventions !== null) {
      const n = checkInt(rubricInterventions, 1, 10);
      if (n === null)
        return { merged, changed, invalid: tr("Rubric 最大干预次数须为 1..10 的整数") };
      if (n !== num(rb.max_interventions)) {
        rb.max_interventions = n;
        changed = true;
      }
    }
    // ── goal（Goal 内置模式参数）──
    const gl = sub("goal");
    if (goalIters !== null) {
      const n = checkInt(goalIters, 1, 500);
      if (n === null)
        return { merged, changed, invalid: tr("Goal 最大迭代须为 1..500 的整数") };
      if (n !== num(gl.max_iterations)) {
        gl.max_iterations = n;
        changed = true;
      }
    }
    if (goalTokens !== null) {
      const n = checkInt(goalTokens, 1, 10000000);
      if (n === null)
        return { merged, changed, invalid: tr("Goal 词元预算须为正整数") };
      if (n !== num(gl.max_tokens)) {
        gl.max_tokens = n;
        changed = true;
      }
    }
    // ── mission（Mission 内置模式参数）──
    const ms = sub("mission");
    if (missionIters !== null) {
      const n = checkInt(missionIters, 1, 100);
      if (n === null)
        return { merged, changed, invalid: tr("Mission 最大迭代须为 1..100 的整数") };
      if (n !== num(ms.max_iterations)) {
        ms.max_iterations = n;
        changed = true;
      }
    }
    if (missionRetries !== null) {
      const n = checkInt(missionRetries, 0, 10);
      if (n === null)
        return { merged, changed, invalid: tr("Mission 每个 Story 最大重试次数须为 0..10 的整数") };
      if (n !== num(ms.max_retries_per_story)) {
        ms.max_retries_per_story = n;
        changed = true;
      }
    }
    if (missionInstr !== null) {
      if (missionInstr.length > 4000)
        return { merged, changed, invalid: tr("Mission 验证说明过长（上限 4000 字）") };
      if (missionInstr !== String(ms.default_verification_instructions ?? "")) {
        ms.default_verification_instructions = missionInstr;
        changed = true;
      }
    }
    if (missionCmd !== null) {
      if (missionCmd.length > 2000)
        return { merged, changed, invalid: tr("Mission 验证命令过长（上限 2000 字）") };
      if (missionCmd !== String(ms.default_verify_command ?? "")) {
        ms.default_verify_command = missionCmd;
        changed = true;
      }
    }
    return { merged, changed, invalid: "" };
  };

  /** 字段级 diff——只发改动的顶层键（read-merge-write 契约）。
   *  返回 [diff, invalidMsg]。 */
  const buildDiff = (): { diff: Rc; invalid: string } => {
    const diff: Rc = {};
    if (!cfg) return { diff, invalid: "" };
    if (retryOn !== null && retryOn !== (cfg.llm_retry_enabled === true)) {
      diff.llm_retry_enabled = retryOn;
    }
    if (maxRetries !== null) {
      if (!isPosInt(maxRetries))
        return { diff, invalid: tr("最大重试次数须为正整数") };
      const n = Number(maxRetries);
      if (n !== num(cfg.llm_max_retries)) diff.llm_max_retries = n;
    }
    if (backoffBase !== null) {
      if (!isPosNum(backoffBase))
        return { diff, invalid: tr("退避基数须为正数（秒）") };
      const n = Number(backoffBase);
      if (n !== num(cfg.llm_backoff_base)) diff.llm_backoff_base = n;
    }
    if (backoffCap !== null) {
      if (!isPosNum(backoffCap))
        return { diff, invalid: tr("退避上限须为正数（秒）") };
      const n = Number(backoffCap);
      if (n !== num(cfg.llm_backoff_cap)) diff.llm_backoff_cap = n;
    }
    // 记忆后端（L2 白名单键）。
    if (memBackend !== null) {
      const v = memBackend.trim();
      if (!v) return { diff, invalid: tr("记忆后端不可为空") };
      if (v !== String(cfg.memory_manager_backend ?? ""))
        diff.memory_manager_backend = v;
    }
    // loop：整块 JSON 优先（显式全量替换）；否则 gate 编辑合并。
    // legacy max_iters 镜像 = QwenPaw console useAgentConfig L183-185 语义：
    // 迭代上限是唯一 UI 入口，保存时 max_iters 跟随（不跟随则旧值仍生效，
    // 因为 loop.iteration.max_iterations 未设时回退读 max_iters）。
    let mirrorVal: number | null = null;
    if (loopText !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(loopText);
      } catch {
        return { diff, invalid: tr("loop 不是合法 JSON") };
      }
      if (JSON.stringify(parsed) !== JSON.stringify(cfg.loop ?? null)) {
        diff.loop = parsed;
        const pl = parsed as Rc;
        const pi = pl?.iteration as Rc | undefined;
        if (
          pi &&
          typeof pi.max_iterations === "number" &&
          Number.isFinite(pi.max_iterations)
        ) {
          mirrorVal = pi.max_iterations;
        }
      }
    } else {
      const { merged, changed, invalid } = mergeLoopGates();
      if (invalid) return { diff, invalid };
      if (changed && JSON.stringify(merged) !== JSON.stringify(cfg.loop ?? null)) {
        diff.loop = merged;
      }
      if (iterValue !== null && /^\d+$/.test(iterValue.trim())) {
        const n = Number(iterValue.trim());
        if (n >= 1 && n <= 500) mirrorVal = n;
      }
    }
    if (mirrorVal !== null && mirrorVal !== num(cfg.max_iters)) {
      diff.max_iters = mirrorVal;
    }
    // ── v0.5.0-beta.13.8 六 tab 补齐 ───────────────────────────────
    // ReAct 智能体（L1-only 键；L2 面板侧已只读，双保险）。
    if (l1) {
      const st = shellEdits.shell_command_timeout;
      if (st !== null && st !== undefined) {
        const s = String(st).trim();
        if (!/^\d+$/.test(s))
          return { diff, invalid: tr("Shell 命令超时须为正整数（秒）") };
        const n = Number(s);
        if (n !== num(cfg.shell_command_timeout))
          diff.shell_command_timeout = n;
      }
      const se = shellEdits.shell_command_executable;
      if (se !== null && se !== undefined) {
        const v = String(se).trim();
        if (!v) return { diff, invalid: tr("Shell 可执行文件不可为空") };
        if (v !== String(cfg.shell_command_executable ?? ""))
          diff.shell_command_executable = v;
      }
      if (typeof shellEdits.auto_title === "boolean") {
        const cur =
          cfg.auto_title_config && typeof cfg.auto_title_config === "object"
            ? { ...(cfg.auto_title_config as Rc) }
            : {};
        if (shellEdits.auto_title !== (cur.enabled === true)) {
          diff.auto_title_config = { ...cur, enabled: shellEdits.auto_title };
        }
      }
      // LLM 并发限流（L1-only 5 键，QwenPaw LlmRateLimiterCard 同款字段）。
      const rateInts: [string, number, number][] = [
        ["llm_max_concurrent", 1, 10000],
        ["llm_max_qpm", 0, 1000000],
        ["llm_rate_limit_pause", 0, 3600],
        ["llm_rate_limit_jitter", 0, 3600],
        ["llm_acquire_timeout", 1, 3600],
      ];
      for (const [k, lo, hi] of rateInts) {
        const v = rateEdits[k];
        if (v === null || v === undefined) continue;
        const s = String(v).trim();
        if (!/^\d+$/.test(s) || Number(s) < lo || Number(s) > hi)
          return {
            diff,
            invalid: tr("{k} 须为 {lo}..{hi} 的整数", { k, lo, hi }),
          };
        const n = Number(s);
        if (n !== num(cfg[k as keyof Rc])) diff[k] = n;
      }
      // 上下文管理（L1-only）：context_manager_backend + light_context_config
      // 嵌套合并（read-merge-write：未改键保持现值，PUT 整块回写）。
      // 实盘结构（Node1 v1.2.4 GET 全字段）：
      //   light_context_config{strategy, dialog_path, token_count_estimate_divisor,
      //     context_compact_config{enabled, compact_threshold_ratio, reserve_threshold_ratio},
      //     tool_result_pruning_config{enabled, pruning_recent_n,
      //       pruning_old_msg_max_bytes, pruning_recent_msg_max_bytes,
      //       offload_retention_days, tool_results_cache,
      //       exempt_file_extensions[], exempt_tool_names[]},
      //     scroll_config{...}}
      const cb = ctxEdits.context_manager_backend;
      if (cb !== null && cb !== undefined) {
        const v = String(cb).trim();
        if (!v) return { diff, invalid: tr("上下文后端不可为空") };
        if (v !== String(cfg.context_manager_backend ?? ""))
          diff.context_manager_backend = v;
      }
      const curLc =
        cfg.light_context_config && typeof cfg.light_context_config === "object"
          ? (JSON.parse(JSON.stringify(cfg.light_context_config)) as Rc)
          : {};
      const compact =
        curLc.context_compact_config &&
        typeof curLc.context_compact_config === "object"
          ? (curLc.context_compact_config as Rc)
          : {};
      const pruning =
        curLc.tool_result_pruning_config &&
        typeof curLc.tool_result_pruning_config === "object"
          ? (curLc.tool_result_pruning_config as Rc)
          : {};
      let lcChanged = false;
      const lcErr = (m: string): { diff: Rc; invalid: string } => ({
        diff,
        invalid: m,
      });
      const put = (obj: Rc, k: string, n: unknown) => {
        if (obj[k] !== n) {
          obj[k] = n;
          lcChanged = true;
        }
      };
      const e = (k: string): EditVal | undefined =>
        ctxEdits[k] === null || ctxEdits[k] === undefined ? undefined : ctxEdits[k];
      let bad: string | null = null;
      // 词元估算除数（实盘 4.0——可为小数，正数即可）。
      {
        const v = e("token_count_estimate_divisor");
        if (v !== undefined) {
          const s = String(v).trim();
          const n = Number(s);
          if (s === "" || !Number.isFinite(n) || n <= 0 || n > 10000)
            return lcErr(tr("上下文管理：词元估算除数须为正数"));
          put(curLc, "token_count_estimate_divisor", n);
        }
      }
      {
        const v = e("dialog_path");
        if (v !== undefined) put(curLc, "dialog_path", String(v).trim());
      }
      if (typeof ctxEdits.context_compact_enabled === "boolean")
        put(compact, "enabled", ctxEdits.context_compact_enabled);
      for (const k of [
        "compact_threshold_ratio",
        "reserve_threshold_ratio",
      ] as const) {
        const v = e(k);
        if (v === undefined) continue;
        const s = String(v).trim();
        const n = Number(s);
        if (s === "" || !Number.isFinite(n) || n <= 0 || n >= 1)
          return lcErr(tr("上下文管理：比例须为 (0,1) 的数"));
        put(compact, k, n);
      }
      if (typeof ctxEdits.pruning_enabled === "boolean")
        put(pruning, "enabled", ctxEdits.pruning_enabled);
      const pruneInts: [string, number, number][] = [
        ["pruning_recent_n", 0, 100000],
        ["pruning_old_msg_max_bytes", 0, 1000000000],
        ["pruning_recent_msg_max_bytes", 0, 1000000000],
        ["offload_retention_days", 1, 3650],
      ];
      for (const [k, lo, hi] of pruneInts) {
        const v = e(k);
        if (v === undefined) continue;
        const s = String(v).trim();
        if (!/^\d+$/.test(s) || Number(s) < lo || Number(s) > hi)
          return lcErr(tr("上下文管理：须为 {lo}..{hi} 的整数", { lo, hi }));
        put(pruning, k, Number(s));
      }
      for (const k of ["exempt_file_extensions", "exempt_tool_names"] as const) {
        const v = e(k);
        if (v === undefined) continue;
        const arr = String(v)
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
        if (JSON.stringify(arr) !== JSON.stringify(pruning[k] ?? []))
          put(pruning, k, arr);
      }
      if (lcChanged) {
        curLc.context_compact_config = compact;
        curLc.tool_result_pruning_config = pruning;
        diff.light_context_config = curLc;
      }
    }
    // 长期记忆（reme_light_memory_config = L2 白名单键，L1/L2 均可编辑）。
    {
      const curReme =
        cfg.reme_light_memory_config &&
        typeof cfg.reme_light_memory_config === "object"
          ? (JSON.parse(JSON.stringify(cfg.reme_light_memory_config)) as Rc)
          : {};
      let rmChanged = false;
      const setBool = (k: string, v: EditVal) => {
        if (typeof v !== "boolean") return null as string | null;
        if (v !== (curReme[k] === true)) {
          curReme[k] = v;
          rmChanged = true;
        }
        return null;
      };
      const setInt = (k: string, v: EditVal, lo: number, hi: number) => {
        if (v === null || v === undefined) return null as string | null;
        const s = String(v).trim();
        if (!/^\d+$/.test(s) || Number(s) < lo || Number(s) > hi)
          return tr("长期记忆：须为 {lo}..{hi} 的整数", { lo, hi });
        const n = Number(s);
        if (n !== num(curReme[k])) {
          curReme[k] = n;
          rmChanged = true;
        }
        return null;
      };
      const setStr = (k: string, v: EditVal, max: number) => {
        if (v === null || v === undefined) return null as string | null;
        const s = String(v).trim();
        if (s.length > max) return tr("长期记忆：内容过长（上限 {n} 字）", { n: max });
        if (s !== String(curReme[k] ?? "")) {
          curReme[k] = s;
          rmChanged = true;
        }
        return null;
      };
      let badR: string | null = null;
      if ((badR = setBool("summarize_when_compact", remeEdits.summarize_when_compact)))
        return { diff, invalid: badR };
      if ((badR = setBool("inbox_push_enabled", remeEdits.inbox_push_enabled)))
        return { diff, invalid: badR };
      if ((badR = setInt("auto_memory_interval", remeEdits.auto_memory_interval, 1, 1440)))
        return { diff, invalid: badR };
      if ((badR = setBool("dream_cron_enabled", remeEdits.dream_cron_enabled)))
        return { diff, invalid: badR };
      if ((badR = setStr("dream_cron", remeEdits.dream_cron, 200)))
        return { diff, invalid: badR };
      if (rmChanged) diff.reme_light_memory_config = curReme;
    }
    return { diff, invalid: "" };
  };

  const dirty = React.useMemo(() => Object.keys(buildDiff().diff).length > 0, [
    // eslint-disable-next-line react-hooks/exhaustive-deps
    cfg,
    iterEnabled,
    iterValue,
    doomEnabled,
    doomWindow,
    doomThreshold,
    doomStages,
    rubricEnabled,
    rubricPrompt,
    rubricInterventions,
    goalIters,
    goalTokens,
    missionIters,
    missionRetries,
    missionInstr,
    missionCmd,
    memBackend,
    retryOn,
    maxRetries,
    backoffBase,
    backoffCap,
    loopText,
    shellEdits,
    rateEdits,
    ctxEdits,
    remeEdits,
    l1,
  ]);

  const save = async () => {
    const { diff, invalid } = buildDiff();
    if (invalid) {
      setMsg({ ok: false, text: invalid });
      return;
    }
    if (Object.keys(diff).length === 0) return;
    setSaving(true);
    setMsg(null);
    try {
      await requestJson(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(diff),
      });
      setMsg({
        ok: true,
        text: diff.loop
          ? tr("已保存——loop 配置变更将通知团队 Leader")
          : tr("已保存"),
      });
      // 读回（read-merge-write 后的权威值）
      const d = (await requestJson(url)) as Rc;
      setCfg(d && typeof d === "object" ? d : null);
      resetEdits();
    } catch (e) {
      const st = httpErrorStatus(e);
      if (st === 409) {
        setMsg({ ok: false, text: tr("配置被锁定（Worker 正在执行任务），稍后重试") });
      } else {
        setMsg({ ok: false, text: httpErrorDetail(e) || tr("保存失败") });
      }
    } finally {
      setSaving(false);
    }
  };

  // ── 自定义 loop CRUD ─────────────────────────────────────────────
  const createCustom = async () => {
    if (newJson === null) return;
    let parsed: WorkerLoopCustomMode;
    try {
      const o = JSON.parse(newJson);
      if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("not an object");
      parsed = o as WorkerLoopCustomMode;
    } catch {
      setLoopMsg({ ok: false, text: tr("loop 不是合法 JSON") });
      return;
    }
    setBusyId("__create__");
    setLoopMsg(null);
    try {
      await createWorkerLoopCustom(name, parsed);
      setNewJson(null);
      setCreating(false);
      setLoopMsg({ ok: true, text: tr("已创建") });
      void loadLoops();
    } catch (e) {
      setLoopMsg({ ok: false, text: httpErrorDetail(e) || tr("保存失败") });
    } finally {
      setBusyId("");
    }
  };

  /** v0.5.0-beta.13.8：模板创建自定义 loop 模式（QwenPaw buildCustomLoopMode
   *  同语义：模板 gate 序列 → makeGate（id=`${type}-${nonce}` + 默认参数））。 */
  const createViaTemplate = async () => {
    const nm = tmplName.trim();
    if (!nm) {
      setLoopMsg({ ok: false, text: tr("模式名不可为空") });
      return;
    }
    const cmd = (tmplCmd.trim() || nm).replace(/^\/+/, "");
    const existing = customs || [];
    const taken = new Set(existing.map((m) => m.slash_command));
    if (taken.has(cmd)) {
      setLoopMsg({ ok: false, text: tr("slash 命令已被占用") });
      return;
    }
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const gates = (LOOP_TEMPLATES[tmplSel] || [])
      .filter((t) => tmplGates[t] !== false)
      .map((t) => ({
        id: `${t}-${nonce}`,
        type: t,
        enabled: true,
        params: JSON.parse(JSON.stringify(LOOP_GATE_DEFS[t].defaults)),
      }));
    setTmplBusy(true);
    setLoopMsg(null);
    try {
      await createWorkerLoopCustom(name, {
        id: nm,
        name: nm,
        description: tmplDesc.trim() || tr("自定义 gate 管道（模板创建）"),
        slash_command: cmd,
        enabled: true,
        gates,
      });
      setTmplOpen(false);
      setTmplName("");
      setTmplCmd("");
      setTmplDesc("");
      setLoopMsg({ ok: true, text: tr("已按模板创建自定义模式") });
      void loadLoops();
    } catch (e) {
      setLoopMsg({ ok: false, text: httpErrorDetail(e) || tr("保存失败") });
    } finally {
      setTmplBusy(false);
    }
  };

  const toggleCustom = async (m: WorkerLoopCustomMode, enabled: boolean) => {
    setBusyId(m.id);
    setLoopMsg(null);
    try {
      // PUT = 整块替换（我们持有 GET 全量对象，改 enabled 后整体回写）。
      await updateWorkerLoopCustom(name, m.id, { ...m, enabled });
      setLoopMsg({ ok: true, text: tr("已更新") });
      void loadLoops();
    } catch (e) {
      setLoopMsg({ ok: false, text: httpErrorDetail(e) || tr("保存失败") });
    } finally {
      setBusyId("");
    }
  };

  const removeCustom = async (m: WorkerLoopCustomMode) => {
    setBusyId(m.id);
    setLoopMsg(null);
    try {
      await deleteWorkerLoopCustom(name, m.id);
      setLoopMsg({ ok: true, text: tr("已删除") });
      void loadLoops();
    } catch (e) {
      setLoopMsg({ ok: false, text: httpErrorDetail(e) || tr("保存失败") });
    } finally {
      setBusyId("");
    }
  };

  // 折叠头（Worker 管理展开区内的可折叠段）。
  if (!open) {
    return (
      <div style={{ marginTop: 6 }}>
        <antd.Button
          size="small"
          type="link"
          style={{ padding: 0, fontSize: 12 }}
          onClick={() => setOpen(true)}
        >
          {tr("运行配置")}（qwenpaw）▾
        </antd.Button>
      </div>
    );
  }

  const lv = cfg ? parseLoop(cfg.loop) : null;
  const labelStyle: ReactNS.CSSProperties = {
    fontSize: 12,
    color: "rgba(127,127,127,0.95)",
  };
  const remeCfg = cfg?.reme_light_memory_config;
  const adbpgCfg = cfg?.adbpg_memory_config;
  const hasMem =
    (remeCfg && typeof remeCfg === "object" && Object.keys(remeCfg as Rc).length > 0) ||
    (adbpgCfg && typeof adbpgCfg === "object" && Object.keys(adbpgCfg as Rc).length > 0);

  return (
    <div
      style={{
        marginTop: 8,
        border: "1px solid rgba(127,127,127,0.25)",
        borderRadius: 8,
        padding: 10,
        display: "grid",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 12.5 }}>{tr("运行配置")}</span>
        <antd.Tag color="orange" style={{ marginInlineEnd: 0, fontSize: 10.5 }}>
          qwenpaw
        </antd.Tag>
        <div style={{ flex: 1 }} />
        <antd.Button size="small" onClick={() => void load()} loading={loading}>
          {tr("刷新")}
        </antd.Button>
        <antd.Button size="small" type="text" onClick={resetEdits}>
          {tr("重置")}
        </antd.Button>
        <antd.Button
          size="small"
          type="primary"
          disabled={!dirty}
          loading={saving}
          onClick={() => void save()}
        >
          {tr("保存")}
        </antd.Button>
      </div>

      {msg ? (
        <antd.Alert
          type={msg.ok ? "success" : "error"}
          showIcon
          message={msg.text}
          closable
          onClose={() => setMsg(null)}
        />
      ) : null}

      {gate === "404" ? (
        <antd.Alert
          type="info"
          showIcon
          message={tr("运行配置不可用")}
          description={tr(
            "Controller 版本未含运行配置端点，或当前账号无该 Worker 访问权（L2 仅限自己团队）。",
          )}
        />
      ) : gate === "400" ? (
        <antd.Alert
          type="warning"
          showIcon
          message={tr("该 Worker 不支持运行配置")}
          description={gateMsg || tr("仅 spec.runtime = qwenpaw 的 Worker 支持。")}
        />
      ) : null}

      {/* v0.5.0-beta.13.6（装验反馈「太简陋太不直观」）：按 QwenPaw console
          Agent Config 页正源重构呈现——Tabs 分域 + 每域 Card + 表单项行
          （label + tooltip 左 / 控件右）+ 滑杆带数值显示。旧版把所有字段
          挤进一行 flex-wrap：窄容器换行错乱、语义分组不可见。
          数据范围不变（L2 白名单键 + diff 只发改动键），只改呈现层。 */}
      {cfg && !gate ? (
        <antd.Tabs
          size="small"
          items={[
            {
              key: "basic",
              label: tr("ReAct 智能体"),
              children: (
                <antd.Card size="small" title={tr("ReAct 智能体")} style={{ marginTop: 4 }}>
                  {/* v0.5.0-beta.13.8 六 tab 补齐：按 QwenPaw ReactAgentCard
                      行序对齐（语言/时区/项目目录/代码能力 = QwenPaw 本机
                      字段，Controller running-config 不暴露，不做）。
                      13.8：shell 组与 auto_title 在 L1 下可编辑（接口实盘
                      全在，L2 白名单外 → L2 只读）。 */}
                  <CfgRow
                    label={tr("最大迭代")}
                    tip={tr("单次任务最大 LLM 迭代轮数。唯一编辑入口在 智能体 Loop 设置 → iteration 门（与 QwenPaw console 一致）；此处只读展示。")}
                  >
                    <span style={{ fontSize: 13 }}>
                      {String(
                        lv && lv.iterationMax != null
                          ? lv.iterationMax
                          : num(cfg.max_iters) ?? "-",
                      )}
                    </span>
                  </CfgRow>
                  <CfgRow
                    label={tr("Shell 超时")}
                    tip={tr("单次 shell 命令超时（秒）。L1-only 键。")}
                  >
                    {l1 ? (
                      <antd.InputNumber
                        min={1}
                        max={86400}
                        style={{ width: 140 }}
                        addonAfter={tr("秒")}
                        disabled={!l1}
                        value={shellEdits.shell_command_timeout != null ? Number(shellEdits.shell_command_timeout) : num(cfg.shell_command_timeout) ?? undefined}
                        onChange={(v: number | null) =>
                          shellSet(
                            "shell_command_timeout",
                            v == null ? null : String(v),
                          )
                        }
                      />
                    ) : (
                      <span style={{ fontSize: 13 }}>
                        {tr("{n} 秒", { n: String(num(cfg.shell_command_timeout) ?? "-") })}
                      </span>
                    )}
                  </CfgRow>
                  <CfgRow
                    label={tr("Shell 可执行文件")}
                    tip={tr("shell 命令使用的可执行文件（shell_command_executable）。L1-only 键。")}
                  >
                    {l1 ? (
                      <antd.Input
                        style={{ width: 220, fontFamily: "monospace" }}
                        value={shellEdits.shell_command_executable != null ? String(shellEdits.shell_command_executable) : String(cfg.shell_command_executable ?? "")}
                        placeholder={tr("默认（/bin/sh）")}
                        onChange={(ev: ReactNS.ChangeEvent<HTMLInputElement>) =>
                          shellSet("shell_command_executable", ev.target.value)
                        }
                      />
                    ) : (
                      <span style={{ fontSize: 13, fontFamily: "monospace" }}>
                        {String(cfg.shell_command_executable || tr("默认"))}
                      </span>
                    )}
                  </CfgRow>
                  <CfgRow
                    label={tr("自动标题")}
                    tip={tr("会话自动标题（auto_title_config.enabled）。L1-only 键。")}
                  >
                    {(() => {
                      const at = (cfg.auto_title_config && typeof cfg.auto_title_config === "object" ? cfg.auto_title_config : {}) as Rc;
                      const cur = shellEdits.auto_title === undefined || shellEdits.auto_title === null ? at.enabled === true : shellEdits.auto_title === true;
                      return (
                        <antd.Switch
                          checked={cur}
                          disabled={!l1}
                          onChange={(v: boolean) => shellSet("auto_title", v)}
                        />
                      );
                    })()}
                  </CfgRow>
                  <CfgRow
                    label={tr("记忆后端")}
                    tip={tr("长期记忆后端（memory_manager_backend）。remelight=轻量本地记忆，adbpg=AnalyticDB PG 向量记忆。L2 白名单键，可编辑。详见 长期记忆 tab。")}
                  >
                    <antd.Select
                      style={{ width: 200 }}
                      value={memBackend ?? String(cfg.memory_manager_backend || "remelight")}
                      onChange={(v: string) => setMemBackend(v)}
                      options={[
                        { value: "remelight", label: "remelight（轻量本地）" },
                        { value: "adbpg", label: "adbpg（AnalyticDB PG）" },
                        { value: String(cfg.memory_manager_backend || "remelight"), label: String(cfg.memory_manager_backend || "remelight") },
                      ].filter((o, i, a) => a.findIndex((x) => x.value === o.value) === i)}
                    />
                  </CfgRow>
                </antd.Card>
              ),
            },
            {
              key: "loop",
              label: tr("智能体 Loop 设置"),
              children: (
                <antd.Card size="small" title={tr("智能体 Loop 设置")} style={{ marginTop: 4 }}>
                  {/* v0.5.0-beta.13.7（13.6 装验「Loop 设置抄 QwenPaw 没抄
                      完」）：按 QwenPaw AgentLoopCard 补齐——Default 模式 gate
                      管道（iteration/doom_loop/rubric）+ Goal/Mission 内置
                      参数，全部 InputNumber（QwenPaw 配置面无滑杆）；13.6
                      tag 速览废弃（goal/mission 数据模型无 enabled 字段，
                      tag 恒 off 误导）；整块 JSON 保留为高级兜底。值域逐条
                      对账 qwenpaw LoopConfig（iteration 1..500 / doom
                      window≥2 / threshold 0..1 / stages after≥1 / rubric
                      1..10 / goal 1..500 / mission 1..100·retry 0..10）。 */}
                  {/* v0.5.0-beta.13.8（13.7 装验「QwenPaw 有模板的，你可以抄
                      过来——别忘了开源项目的礼仪」）：Loop 模板——QwenPaw
                      AgentLoopCard 的「Loop 模板」区移植（出处/署名见文件
                      顶部 LOOP_TEMPLATES 注释；模板/gate 默认值逐值保留
                      原设计，属 QwenPaw 上游，插件仅做呈现与调用）。 */}
                  <div style={{ marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid rgba(127,127,127,0.15)" }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>
                      {tr("Loop 模板")}
                    </div>
                    <div style={{ fontSize: 11.5, color: "rgba(0,0,0,0.45)", marginBottom: 6 }}>
                      {tr("选择内置模板，或添加自己的（按模板生成自定义模式）。模板设计：QwenPaw 上游。")}
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                      {Object.entries(
                        {
                          safe: "安全运行",
                          research: "预算研究",
                          quality: "质量优先",
                          blank: "空管道",
                        } as Record<string, string>,
                      ).map(([id, label]) => (
                        <antd.Tag
                          key={id}
                          color={tmplSel === id ? "orange" : "default"}
                          style={{ cursor: "pointer", marginInlineEnd: 0 }}
                          onClick={() => {
                            setTmplSel(id);
                            const gs: Record<string, boolean> = {};
                            for (const g of LOOP_TEMPLATES[id] || []) gs[g] = true;
                            setTmplGates(gs);
                          }}
                        >
                          {label}
                          <span style={{ opacity: 0.6, marginLeft: 4 }}>
                            {id}
                          </span>
                        </antd.Tag>
                      ))}
                    </div>
                    {(LOOP_TEMPLATES[tmplSel] || []).length ? (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
                        {(LOOP_TEMPLATES[tmplSel] || []).map((g) => (
                          <antd.Checkbox
                            key={g}
                            checked={tmplGates[g] !== false}
                            onChange={(ev: ReactNS.ChangeEvent<HTMLInputElement>) =>
                              setTmplGates((p) => ({ ...p, [g]: ev.target.checked }))
                            }
                          >
                            {/* id 与标题同 span：harness exact 断言按整串匹配，
                                不与下方 GateSection 标题（纯中文）撞名。 */}
                            <span style={{ fontSize: 11.5 }}>
                              {LOOP_GATE_DEFS[g].title}
                              <span style={{ fontSize: 10.5, color: "rgba(0,0,0,0.35)", marginLeft: 4 }}>{g}</span>
                            </span>
                          </antd.Checkbox>
                        ))}
                      </div>
                    ) : (
                      <div style={{ fontSize: 11.5, color: "rgba(0,0,0,0.45)", marginBottom: 8 }}>
                        {tr("空管道——创建后再逐个添加 gate（高级 JSON）。")}
                      </div>
                    )}
                    <antd.Button size="small" onClick={() => setTmplOpen(true)}>
                      {tr("按模板创建自定义模式")}
                    </antd.Button>
                  </div>
                  <antd.Modal
                    title={tr("按模板创建自定义 Loop 模式")}
                    open={tmplOpen}
                    onOk={() => void createViaTemplate()}
                    okButtonProps={{ loading: tmplBusy }}
                    onCancel={() => setTmplOpen(false)}
                    destroyOnClose
                  >
                    <div style={{ display: "grid", gap: 8, paddingTop: 8 }}>
                      <CfgRow label={tr("模式名")}>
                        <antd.Input
                          value={tmplName}
                          placeholder="my-mode"
                          onChange={(ev: ReactNS.ChangeEvent<HTMLInputElement>) => setTmplName(ev.target.value)}
                        />
                      </CfgRow>
                      <CfgRow label={tr("slash 命令")}>
                        <antd.Input
                          value={tmplCmd}
                          placeholder={tmplName.trim() || "custom-mode"}
                          onChange={(ev: ReactNS.ChangeEvent<HTMLInputElement>) => setTmplCmd(ev.target.value)}
                        />
                      </CfgRow>
                      <CfgRow label={tr("描述")}>
                        <antd.Input
                          value={tmplDesc}
                          placeholder={tr("自定义 gate 管道（模板创建）")}
                          onChange={(ev: ReactNS.ChangeEvent<HTMLInputElement>) => setTmplDesc(ev.target.value)}
                        />
                      </CfgRow>
                      <CfgRow label={tr("起始模板")}>
                        <antd.Select
                          style={{ width: 220 }}
                          value={tmplSel}
                          onChange={(v: string) => {
                            setTmplSel(v);
                            const gs: Record<string, boolean> = {};
                            for (const g of LOOP_TEMPLATES[v] || []) gs[g] = true;
                            setTmplGates(gs);
                          }}
                          options={Object.keys(LOOP_TEMPLATES).map((id) => ({
                            value: id,
                            label: `${id}（${(LOOP_TEMPLATES[id] || []).length} gate）`,
                          }))}
                        />
                      </CfgRow>
                      <CfgRow label={tr("管道预览")}>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {(LOOP_TEMPLATES[tmplSel] || [])
                            .filter((g) => tmplGates[g] !== false)
                            .map((g) => (
                              <antd.Tag key={g} color="blue" style={{ marginInlineEnd: 0 }}>
                                {LOOP_GATE_DEFS[g].title} {g}
                              </antd.Tag>
                            ))}
                          {(LOOP_TEMPLATES[tmplSel] || []).filter((g) => tmplGates[g] !== false).length === 0
                            ? tr("（空管道）")
                            : null}
                        </div>
                      </CfgRow>
                    </div>
                  </antd.Modal>
                  {lv ? (
                    <div style={{ display: "grid", gap: 4, marginBottom: 10 }}>
                      <div style={{ fontSize: 11, color: "rgba(127,127,127,0.8)", marginBottom: 2 }}>
                        {tr("Default 模式 · gate 管道")}
                      </div>
                      <GateSection
                        title={tr("迭代限制")}
                        tip={tr("单任务最大 LLM 迭代轮数（loop.iteration），超限终止。QwenPaw console 同款：启用开关 + 数字输入 1..500；保存时同步 legacy max_iters。")}
                        enabled={iterEnabled !== null ? iterEnabled : lv.iterationEnabled}
                        onEnabled={(v) => setIterEnabled(v)}
                      >
                        <GateParam label={tr("最大迭代")}>
                          <antd.InputNumber
                            style={{ width: 200 }}
                            min={1}
                            max={500}
                            value={
                              iterValue !== null && isPosInt(iterValue)
                                ? Number(iterValue)
                                : // v0.5.0-beta.13.10（B1b：「最大迭代等窗口应该
                                  // 被自动填入当前值，而不是空的框」）：实盘
                                  // max_iterations=None（未显式配置）时预填
                                  // 运行时默认 40（QwenPaw LOOP 正源默认）——
                                  // 显示的即运行时真实生效值，保存才落库。
                                  lv.iterationMax ?? 40
                            }
                            onChange={(v: number | null) =>
                              setIterValue(v === null || v === undefined ? null : String(v))
                            }
                          />
                          {lv.iterationMax == null ? (
                            <div
                              style={{
                                fontSize: 10.5,
                                color: "rgba(127,127,127,0.75)",
                                marginTop: 2,
                              }}
                            >
                              {tr("未显式配置——显示运行时默认 40，保存后落库")}
                            </div>
                          ) : null}
                        </GateParam>
                      </GateSection>
                      <GateSection
                        title={tr("重复保护")}
                        tip={tr("检测滑动窗口内重复的工具调用并干预：注入提示或终止任务（loop.doom_loop）。窗口≥2，相似度 0..1。")}
                        enabled={doomEnabled !== null ? doomEnabled : lv.doomEnabled}
                        onEnabled={(v) => setDoomEnabled(v)}
                      >
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                          <GateParam label={tr("检测窗口")}>
                            <antd.InputNumber
                              style={{ width: "100%" }}
                              min={2}
                              value={
                                doomWindow !== null && isPosInt(doomWindow)
                                  ? Number(doomWindow)
                                  : lv.doomWindow ?? undefined
                              }
                              onChange={(v: number | null) =>
                                setDoomWindow(v === null || v === undefined ? null : String(v))
                              }
                            />
                          </GateParam>
                          <GateParam label={tr("相似度阈值")}>
                            <antd.InputNumber
                              style={{ width: "100%" }}
                              min={0}
                              max={1}
                              step={0.05}
                              value={
                                doomThreshold !== null && doomThreshold.trim() !== "" && Number.isFinite(Number(doomThreshold))
                                  ? Number(doomThreshold)
                                  : lv.doomThreshold ?? undefined
                              }
                              onChange={(v: number | null) =>
                                setDoomThreshold(v === null || v === undefined ? null : String(v))
                              }
                            />
                          </GateParam>
                        </div>
                        <GateParam label={tr("干预规则")}>
                          <div style={{ display: "grid", gap: 4 }}>
                            {(doomStages !== null ? doomStages : lv.doomStages).map((st, idx) => (
                              <div key={idx} style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                                <antd.InputNumber
                                  size="small"
                                  style={{ width: 72 }}
                                  min={1}
                                  value={st.after ?? undefined}
                                  onChange={(v: number | null) =>
                                    setDoomStages((prev) =>
                                      (prev ?? lv.doomStages).map((x, j) =>
                                        j === idx ? { ...x, after: v === null ? null : Number(v) } : x,
                                      ),
                                    )
                                  }
                                />
                                <antd.Select
                                  size="small"
                                  style={{ width: 112 }}
                                  value={st.action}
                                  options={[
                                    { value: "modify_prompt", label: tr("注入提醒") },
                                    { value: "stop", label: tr("终止任务") },
                                  ]}
                                  onChange={(v: "modify_prompt" | "stop") =>
                                    setDoomStages((prev) =>
                                      (prev ?? lv.doomStages).map((x, j) =>
                                        j === idx ? { ...x, action: v } : x,
                                      ),
                                    )
                                  }
                                />
                                <antd.Input
                                  size="small"
                                  style={{ flex: 1, minWidth: 120 }}
                                  placeholder={tr("提示词（注入提醒必填）")}
                                  value={st.prompt}
                                  onChange={(e: { target: { value: string } }) =>
                                    setDoomStages((prev) =>
                                      (prev ?? lv.doomStages).map((x, j) =>
                                        j === idx ? { ...x, prompt: e.target.value } : x,
                                      ),
                                    )
                                  }
                                />
                                <antd.Button
                                  size="small"
                                  type="text"
                                  danger
                                  onClick={() =>
                                    setDoomStages((prev) =>
                                      (prev ?? lv.doomStages).filter((_, j) => j !== idx),
                                    )
                                  }
                                >
                                  {tr("移除")}
                                </antd.Button>
                              </div>
                            ))}
                            <antd.Button
                              size="small"
                              type="dashed"
                              block
                              onClick={() =>
                                setDoomStages((prev) => [
                                  ...(prev ?? lv.doomStages),
                                  { after: 3, action: "modify_prompt", prompt: "" },
                                ])
                              }
                            >
                              {tr("添加规则")}
                            </antd.Button>
                          </div>
                        </GateParam>
                      </GateSection>
                      <GateSection
                        title={tr("完成质量检查")}
                        tip={tr("完成前用 Rubric 提示词评估任务是否真正达成，未过则注入评估继续（loop.rubric，仅 in-loop 模式），最多干预 1..10 次。")}
                        enabled={rubricEnabled !== null ? rubricEnabled : lv.rubricEnabled}
                        onEnabled={(v) => setRubricEnabled(v)}
                      >
                        <GateParam label={tr("Rubric 提示词")}>
                          <antd.Input.TextArea
                            rows={2}
                            style={{ width: "100%", fontSize: 11.5 }}
                            value={rubricPrompt !== null ? rubricPrompt : lv.rubricPrompt}
                            onChange={(e: { target: { value: string } }) => setRubricPrompt(e.target.value)}
                          />
                        </GateParam>
                        <GateParam label={tr("最大干预次数")}>
                          <antd.InputNumber
                            style={{ width: 120 }}
                            min={1}
                            max={10}
                            value={
                              rubricInterventions !== null && isPosInt(rubricInterventions)
                                ? Number(rubricInterventions)
                                : lv.rubricInterventions ?? undefined
                            }
                            onChange={(v: number | null) =>
                              setRubricInterventions(v === null || v === undefined ? null : String(v))
                            }
                          />
                        </GateParam>
                      </GateSection>

                      <div style={{ fontSize: 11, color: "rgba(127,127,127,0.8)", margin: "4px 0 2px" }}>
                        {tr("Goal 模式 · 内置参数")}
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                        <GateParam label={tr("最大迭代")}>
                          <antd.InputNumber
                            style={{ width: "100%" }}
                            min={1}
                            max={500}
                            value={
                              goalIters !== null && isPosInt(goalIters)
                                ? Number(goalIters)
                                : lv.goalMaxIters ?? undefined
                            }
                            onChange={(v: number | null) =>
                              setGoalIters(v === null || v === undefined ? null : String(v))
                            }
                          />
                        </GateParam>
                        <GateParam label={tr("词元预算")}>
                          <antd.InputNumber
                            style={{ width: "100%" }}
                            min={1}
                            value={
                              goalTokens !== null && isPosInt(goalTokens)
                                ? Number(goalTokens)
                                : lv.goalMaxTokens ?? undefined
                            }
                            onChange={(v: number | null) =>
                              setGoalTokens(v === null || v === undefined ? null : String(v))
                            }
                          />
                        </GateParam>
                      </div>

                      <div style={{ fontSize: 11, color: "rgba(127,127,127,0.8)", margin: "4px 0 2px" }}>
                        {tr("Mission 模式 · 内置参数")}
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                        <GateParam label={tr("最大迭代")}>
                          <antd.InputNumber
                            style={{ width: "100%" }}
                            min={1}
                            max={100}
                            value={
                              missionIters !== null && isPosInt(missionIters)
                                ? Number(missionIters)
                                : lv.missionMaxIters ?? undefined
                            }
                            onChange={(v: number | null) =>
                              setMissionIters(v === null || v === undefined ? null : String(v))
                            }
                          />
                        </GateParam>
                        <GateParam label={tr("每个 Story 最大重试次数")}>
                          <antd.InputNumber
                            style={{ width: "100%" }}
                            min={0}
                            max={10}
                            value={
                              missionRetries !== null && /^\d+$/.test(missionRetries)
                                ? Number(missionRetries)
                                : lv.missionMaxRetries ?? undefined
                            }
                            onChange={(v: number | null) =>
                              setMissionRetries(v === null || v === undefined ? null : String(v))
                            }
                          />
                        </GateParam>
                      </div>
                      <GateParam label={tr("验证说明")}>
                        <antd.Input
                          style={{ fontSize: 11.5 }}
                          value={missionInstr !== null ? missionInstr : lv.missionVerifyInstructions}
                          onChange={(e: { target: { value: string } }) => setMissionInstr(e.target.value)}
                        />
                      </GateParam>
                      <GateParam label={tr("验证命令")}>
                        <antd.Input
                          style={{ fontSize: 11.5, fontFamily: "monospace" }}
                          value={missionCmd !== null ? missionCmd : lv.missionVerifyCommand}
                          onChange={(e: { target: { value: string } }) => setMissionCmd(e.target.value)}
                        />
                      </GateParam>

                      {/* 整块 JSON = 高级兜底（显式全量替换，覆盖上方 gate 编辑）。 */}
                      <div style={{ borderTop: "1px dashed rgba(127,127,127,0.25)", paddingTop: 6, marginTop: 4 }}>
                        <antd.Button
                          size="small"
                          type="link"
                          style={{ padding: 0, fontSize: 12 }}
                          onClick={() => {
                            if (loopText === null) {
                              setLoopText(
                                JSON.stringify(cfg.loop ?? null, null, 2),
                              );
                            }
                            setLoopOpen(true);
                          }}
                        >
                          {tr("高级：编辑整块 JSON")}
                        </antd.Button>
                        {loopOpen ? (
                          <div>
                            <antd.Input.TextArea
                              rows={10}
                              style={{
                                fontFamily: "monospace",
                                fontSize: 11.5,
                                width: "100%",
                              }}
                              value={loopText ?? ""}
                              onChange={(e: { target: { value: string } }) => setLoopText(e.target.value)}
                            />
                            <div style={{ fontSize: 11, color: "rgba(127,127,127,0.8)", marginTop: 2 }}>
                              {tr("loop 为整块替换语义——保存后整个 loop 对象以此 JSON 为准（覆盖上方 gate 编辑）；loop 变更将通知团队 Leader。")}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}

                  {/* Loop 模式节：目录（GET /loops）+ 自定义 CRUD（/loops/custom）。 */}
                  <div
                    style={{
                      borderTop: "1px dashed rgba(127,127,127,0.25)",
                      paddingTop: 8,
                      display: "grid",
                      gap: 6,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={labelStyle}>{tr("Loop 模式")}</span>
                      <antd.Button size="small" type="link" style={{ padding: 0, fontSize: 11.5 }} onClick={() => void loadLoops()} loading={loopsLoading}>
                        {tr("刷新")}
                      </antd.Button>
                      <div style={{ flex: 1 }} />
                      <antd.Button size="small" onClick={() => setCreating((v) => !v)}>
                        {tr("新建自定义 Loop")}
                      </antd.Button>
                    </div>
                    {loopMsg ? (
                      <antd.Alert
                        type={loopMsg.ok ? "success" : "error"}
                        showIcon
                        message={loopMsg.text}
                        closable
                        onClose={() => setLoopMsg(null)}
                      />
                    ) : null}
                    {loopsErr ? (
                      <antd.Alert
                        type="info"
                        showIcon
                        message={tr("loop 模式不可用")}
                        description={loopsErr}
                      />
                    ) : (
                      <>
                        {loops ? (
                          <div>
                            <div style={{ fontSize: 11, color: "rgba(127,127,127,0.8)", marginBottom: 3 }}>
                              {tr("模式目录")}
                            </div>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                              {loops.map((m) => (
                                <antd.Tag
                                  key={m.id}
                                  color={SOURCE_COLOR[m.source || "builtin"] || "default"}
                                  style={{ marginInlineEnd: 0, fontSize: 10.5 }}
                                  title={m.description || m.name}
                                >
                                  {m.name}
                                  {m.slash_command ? ` /${m.slash_command}` : ""}
                                </antd.Tag>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        <div>
                          <div style={{ fontSize: 11, color: "rgba(127,127,127,0.8)", margin: "4px 0 3px" }}>
                            {tr("自定义 Loop")}
                          </div>
                          {customs && customs.length === 0 ? (
                            <div style={{ fontSize: 11, color: "rgba(127,127,127,0.6)" }}>
                              {tr("该 Worker 暂无自定义 loop")}
                            </div>
                          ) : null}
                          {customs?.map((m) => {
                            const gates = Array.isArray(m.gates) ? m.gates : [];
                            const on = gates.filter((g) => g.enabled).length;
                            return (
                              <div
                                key={m.id}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 8,
                                  padding: "3px 0",
                                  fontSize: 11.5,
                                  flexWrap: "wrap",
                                }}
                              >
                                <antd.Switch
                                  size="small"
                                  checked={m.enabled === true}
                                  disabled={busyId === m.id}
                                  onChange={(v: boolean) => void toggleCustom(m, v)}
                                />
                                <span style={{ fontFamily: "monospace", fontWeight: 500 }}>{m.id}</span>
                                <span style={{ color: "rgba(127,127,127,0.85)" }}>{m.name}</span>
                                <antd.Tag style={{ marginInlineEnd: 0, fontSize: 10 }}>
                                  /{m.slash_command}
                                </antd.Tag>
                                <span style={{ fontSize: 10.5, color: "rgba(127,127,127,0.7)" }}>
                                  {tr("门禁 {a} 个（启用 {b}）", { a: gates.length, b: on })}
                                </span>
                                <div style={{ flex: 1 }} />
                                <antd.Popconfirm
                                  title={tr("删除该自定义 loop？")}
                                  okText={tr("确认删除")}
                                  cancelText={tr("取消")}
                                  onConfirm={() => void removeCustom(m)}
                                >
                                  <antd.Button size="small" danger disabled={busyId === m.id} loading={busyId === m.id}>
                                    {tr("删除")}
                                  </antd.Button>
                                </antd.Popconfirm>
                              </div>
                            );
                          })}
                        </div>
                        {creating ? (
                          <div>
                            <antd.Input.TextArea
                              rows={8}
                              style={{ fontFamily: "monospace", fontSize: 11.5 }}
                              placeholder={tr("新自定义 loop 完整 JSON（字段：id / name / slash_command / enabled / gates）")}
                              value={newJson ?? ""}
                              onChange={(e: { target: { value: string } }) => setNewJson(e.target.value)}
                            />
                            <div style={{ fontSize: 10.5, color: "rgba(127,127,127,0.75)", margin: "2px 0 4px" }}>
                              {tr("id 与 slash_command 须小写字母/数字/_/-；gates 为 {id,type,enabled,params} 数组（可空）；重名或 slash 冲突 409，管道校验失败 422。")}
                            </div>
                            <antd.Button
                              size="small"
                              type="primary"
                              loading={busyId === "__create__"}
                              onClick={() => void createCustom()}
                            >
                              {tr("创建")}
                            </antd.Button>
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                </antd.Card>
              ),
            },
            {
              key: "retry",
              label: tr("LLM 自动重试"),
              children: (
                <antd.Card size="small" title={tr("LLM 自动重试")} style={{ marginTop: 4 }}>
                  <CfgRow
                    label={tr("启用自动重试")}
                    tip={tr("LLM 调用失败（限流/超时/5xx）时自动重试。关闭后失败立即上抛。")}
                  >
                    <antd.Switch
                      checked={
                        retryOn !== null
                          ? retryOn
                          : (cfg.llm_retry_enabled === true)
                      }
                      onChange={(v: boolean) => setRetryOn(v)}
                    />
                  </CfgRow>
                  <CfgRow
                    label={tr("最大重试次数")}
                    tip={tr("连续失败最多重试几次（llm_max_retries）。")}
                  >
                    <antd.InputNumber
                      style={{ width: 160 }}
                      min={1}
                      disabled={retryOn === false}
                      value={
                        maxRetries !== null && isPosInt(maxRetries)
                          ? Number(maxRetries)
                          : (num(cfg.llm_max_retries) ?? undefined)
                      }
                      onChange={(v: number | null) =>
                        setMaxRetries(v === null || v === undefined ? null : String(v))
                      }
                    />
                  </CfgRow>
                  <CfgRow
                    label={tr("退避基数（秒）")}
                    tip={tr("指数退避基数（llm_backoff_base）：第 n 次重试前等待 ≈ 基数 × 2^(n-1)。")}
                  >
                    <antd.InputNumber
                      style={{ width: 160 }}
                      min={0}
                      step={0.5}
                      addonAfter="s"
                      disabled={retryOn === false}
                      value={
                        backoffBase !== null && isPosNum(backoffBase)
                          ? Number(backoffBase)
                          : (num(cfg.llm_backoff_base) ?? undefined)
                      }
                      onChange={(v: number | null) =>
                        setBackoffBase(v === null || v === undefined ? null : String(v))
                      }
                    />
                  </CfgRow>
                  <CfgRow
                    label={tr("退避上限（秒）")}
                    tip={tr("指数退避上限（llm_backoff_cap），须 ≥ 退避基数。")}
                  >
                    <antd.InputNumber
                      style={{ width: 160 }}
                      min={0}
                      step={0.5}
                      addonAfter="s"
                      disabled={retryOn === false}
                      value={
                        backoffCap !== null && isPosNum(backoffCap)
                          ? Number(backoffCap)
                          : (num(cfg.llm_backoff_cap) ?? undefined)
                      }
                      onChange={(v: number | null) =>
                        setBackoffCap(v === null || v === undefined ? null : String(v))
                      }
                    />
                  </CfgRow>
                </antd.Card>
              ),
            },
            // v0.5.0-beta.13.8 六 tab 补齐：LLM 并发限流（QwenPaw
            // LlmRateLimiterCard 同款 5 键，L1 可编辑 / L2 只读）。
            {
              key: "rate",
              label: tr("LLM 并发限流"),
              children: (
                <antd.Card size="small" title={tr("LLM 并发限流")} style={{ marginTop: 4 }}>
                  {!l1 ? (
                    <antd.Alert
                      type="info"
                      showIcon
                      style={{ marginBottom: 8 }}
                      message={tr(
                        "L1-only 字段——当前账号没有 Controller 管理 token：L1 账号/密码登录只建立网关 Console 会话（与 Controller token 是两套凭证），无 token 时 L1 字段不可写（PUT 403）。获取 token 与配置方法见「设置」页。",
                      )}
                      action={
                        onOpenSettings ? (
                          <antd.Button size="small" onClick={onOpenSettings}>
                            {tr("去设置")}
                          </antd.Button>
                        ) : undefined
                      }
                    />
                  ) : null}
                  <CfgRow
                    label={tr("LLM 并发上限")}
                    tip={tr("LLM 同时运行数（llm_max_concurrent）。1..10000。")}
                  >
                    <antd.InputNumber
                      min={1}
                      max={10000}
                      style={{ width: 160 }}
                      disabled={!l1}
                      value={rateEdits.llm_max_concurrent != null ? Number(rateEdits.llm_max_concurrent) : num(cfg.llm_max_concurrent) ?? undefined}
                      onChange={(v: number | null) => rateSet("llm_max_concurrent", v == null ? null : String(v))}
                    />
                  </CfgRow>
                  <CfgRow
                    label={tr("LLM QPM")}
                    tip={tr("LLM 每分钟请求上限（llm_max_qpm）。0=不限制。")}
                  >
                    <antd.InputNumber
                      min={0}
                      max={1000000}
                      style={{ width: 160 }}
                      disabled={!l1}
                      value={rateEdits.llm_max_qpm != null ? Number(rateEdits.llm_max_qpm) : num(cfg.llm_max_qpm) ?? undefined}
                      onChange={(v: number | null) => rateSet("llm_max_qpm", v == null ? null : String(v))}
                    />
                  </CfgRow>
                  <CfgRow
                    label={tr("限速等待")}
                    tip={tr("触发限速时等待秒数（llm_rate_limit_pause）。")}
                  >
                    <antd.InputNumber
                      min={0}
                      max={3600}
                      style={{ width: 160 }}
                      addonAfter={tr("秒")}
                      disabled={!l1}
                      value={rateEdits.llm_rate_limit_pause != null ? Number(rateEdits.llm_rate_limit_pause) : num(cfg.llm_rate_limit_pause) ?? undefined}
                      onChange={(v: number | null) => rateSet("llm_rate_limit_pause", v == null ? null : String(v))}
                    />
                  </CfgRow>
                  <CfgRow
                    label={tr("限速抖动")}
                    tip={tr("限速等待的随机抖动秒数（llm_rate_limit_jitter）。")}
                  >
                    <antd.InputNumber
                      min={0}
                      max={3600}
                      style={{ width: 160 }}
                      addonAfter={tr("秒")}
                      disabled={!l1}
                      value={rateEdits.llm_rate_limit_jitter != null ? Number(rateEdits.llm_rate_limit_jitter) : num(cfg.llm_rate_limit_jitter) ?? undefined}
                      onChange={(v: number | null) => rateSet("llm_rate_limit_jitter", v == null ? null : String(v))}
                    />
                  </CfgRow>
                  <CfgRow
                    label={tr("槽位获取超时")}
                    tip={tr("获取并发槽位的超时秒数（llm_acquire_timeout）。")}
                  >
                    <antd.InputNumber
                      min={1}
                      max={3600}
                      style={{ width: 160 }}
                      addonAfter={tr("秒")}
                      disabled={!l1}
                      value={rateEdits.llm_acquire_timeout != null ? Number(rateEdits.llm_acquire_timeout) : num(cfg.llm_acquire_timeout) ?? undefined}
                      onChange={(v: number | null) => rateSet("llm_acquire_timeout", v == null ? null : String(v))}
                    />
                  </CfgRow>
                </antd.Card>
              ),
            },
            // v0.5.0-beta.13.8：上下文管理（light_context_config 嵌套合并，
            // L1 可编辑 / L2 只读）——字段名逐字对账实盘 GET。
            {
              key: "ctx",
              label: tr("上下文管理"),
              children: (
                <antd.Card size="small" title={tr("上下文管理")} style={{ marginTop: 4 }}>
                  {!l1 ? (
                    <antd.Alert
                      type="info"
                      showIcon
                      style={{ marginBottom: 8 }}
                      message={tr(
                        "L1-only 字段——当前账号没有 Controller 管理 token：L1 账号/密码登录只建立网关 Console 会话（与 Controller token 是两套凭证），无 token 时 L1 字段不可写（PUT 403）。获取 token 与配置方法见「设置」页。",
                      )}
                      action={
                        onOpenSettings ? (
                          <antd.Button size="small" onClick={onOpenSettings}>
                            {tr("去设置")}
                          </antd.Button>
                        ) : undefined
                      }
                    />
                  ) : null}
                  <CfgRow
                    label={tr("上下文后端")}
                    tip={tr("context_manager_backend——light=滚动上下文。L1-only 键。")}
                  >
                    <antd.Select
                      style={{ width: 200 }}
                      disabled={!l1}
                      value={ctxEdits.context_manager_backend != null ? String(ctxEdits.context_manager_backend) : String(cfg.context_manager_backend || "light")}
                      onChange={(v: string) => ctxSet("context_manager_backend", v)}
                      options={[
                        { value: "light", label: "light（滚动上下文）" },
                        { value: String(cfg.context_manager_backend || "light"), label: String(cfg.context_manager_backend || "light") },
                      ].filter((o, i, a) => a.findIndex((x) => x.value === o.value) === i)}
                    />
                  </CfgRow>
                  <CfgRow
                    label={tr("词元估算除数")}
                    tip={tr("词元数估算 = 字符数 ÷ 该值（token_count_estimate_divisor）。")}
                  >
                    <antd.InputNumber
                      min={0.5}
                      max={10000}
                      step={0.5}
                      style={{ width: 140 }}
                      disabled={!l1}
                      value={ctxEdits.token_count_estimate_divisor != null ? Number(ctxEdits.token_count_estimate_divisor) : num(cfg.light_context_config && (cfg.light_context_config as Rc).token_count_estimate_divisor) ?? undefined}
                      onChange={(v: number | null) => ctxSet("token_count_estimate_divisor", v == null ? null : String(v))}
                    />
                  </CfgRow>
                  <CfgRow
                    label={tr("压缩启用")}
                    tip={tr("上下文超阈值时自动压缩（context_compact_config.enabled）。")}
                  >
                    <antd.Switch
                      disabled={!l1}
                      checked={
                        ctxEdits.context_compact_enabled === undefined || ctxEdits.context_compact_enabled === null
                          ? ((cfg.light_context_config as Rc | undefined)?.context_compact_config as Rc | undefined)?.enabled === true
                          : ctxEdits.context_compact_enabled === true
                      }
                      onChange={(v: boolean) => ctxSet("context_compact_enabled", v)}
                    />
                  </CfgRow>
                  <CfgRow
                    label={tr("压缩阈值比例")}
                    tip={tr("上下文占用达到窗口该比例时触发压缩（compact_threshold_ratio，(0,1)）。")}
                  >
                    <antd.InputNumber
                      min={0.05}
                      max={0.99}
                      step={0.05}
                      style={{ width: 140 }}
                      disabled={!l1}
                      value={ctxEdits.compact_threshold_ratio != null ? Number(ctxEdits.compact_threshold_ratio) : num(((cfg.light_context_config as Rc | undefined)?.context_compact_config as Rc | undefined)?.compact_threshold_ratio) ?? undefined}
                      onChange={(v: number | null) => ctxSet("compact_threshold_ratio", v == null ? null : String(v))}
                    />
                  </CfgRow>
                  <CfgRow
                    label={tr("保留阈值比例")}
                    tip={tr("压缩后保留的上下文比例（reserve_threshold_ratio，(0,1)）。")}
                  >
                    <antd.InputNumber
                      min={0.05}
                      max={0.99}
                      step={0.05}
                      style={{ width: 140 }}
                      disabled={!l1}
                      value={ctxEdits.reserve_threshold_ratio != null ? Number(ctxEdits.reserve_threshold_ratio) : num(((cfg.light_context_config as Rc | undefined)?.context_compact_config as Rc | undefined)?.reserve_threshold_ratio) ?? undefined}
                      onChange={(v: number | null) => ctxSet("reserve_threshold_ratio", v == null ? null : String(v))}
                    />
                  </CfgRow>
                  <CfgRow
                    label={tr("工具结果裁剪")}
                    tip={tr("超长工具结果 offload 到磁盘、上下文留摘要（tool_result_pruning_config.enabled）。")}
                  >
                    <antd.Switch
                      disabled={!l1}
                      checked={
                        ctxEdits.pruning_enabled === undefined || ctxEdits.pruning_enabled === null
                          ? ((cfg.light_context_config as Rc | undefined)?.tool_result_pruning_config as Rc | undefined)?.enabled === true
                          : ctxEdits.pruning_enabled === true
                      }
                      onChange={(v: boolean) => ctxSet("pruning_enabled", v)}
                    />
                  </CfgRow>
                  <CfgRow
                    label={tr("近期保留条数")}
                    tip={tr("最近 N 条消息不裁剪（pruning_recent_n）。")}
                  >
                    <antd.InputNumber
                      min={0}
                      max={100000}
                      style={{ width: 140 }}
                      disabled={!l1}
                      value={ctxEdits.pruning_recent_n != null ? Number(ctxEdits.pruning_recent_n) : num(((cfg.light_context_config as Rc | undefined)?.tool_result_pruning_config as Rc | undefined)?.pruning_recent_n) ?? undefined}
                      onChange={(v: number | null) => ctxSet("pruning_recent_n", v == null ? null : String(v))}
                    />
                  </CfgRow>
                  <CfgRow
                    label={tr("旧消息上限（字节）")}
                    tip={tr("历史工具结果超过该大小即裁剪（pruning_old_msg_max_bytes）。")}
                  >
                    <antd.InputNumber
                      min={0}
                      max={1000000000}
                      style={{ width: 160 }}
                      disabled={!l1}
                      value={ctxEdits.pruning_old_msg_max_bytes != null ? Number(ctxEdits.pruning_old_msg_max_bytes) : num(((cfg.light_context_config as Rc | undefined)?.tool_result_pruning_config as Rc | undefined)?.pruning_old_msg_max_bytes) ?? undefined}
                      onChange={(v: number | null) => ctxSet("pruning_old_msg_max_bytes", v == null ? null : String(v))}
                    />
                  </CfgRow>
                  <CfgRow
                    label={tr("近期消息上限（字节）")}
                    tip={tr("近期工具结果超过该大小即裁剪（pruning_recent_msg_max_bytes）。")}
                  >
                    <antd.InputNumber
                      min={0}
                      max={1000000000}
                      style={{ width: 160 }}
                      disabled={!l1}
                      value={ctxEdits.pruning_recent_msg_max_bytes != null ? Number(ctxEdits.pruning_recent_msg_max_bytes) : num(((cfg.light_context_config as Rc | undefined)?.tool_result_pruning_config as Rc | undefined)?.pruning_recent_msg_max_bytes) ?? undefined}
                      onChange={(v: number | null) => ctxSet("pruning_recent_msg_max_bytes", v == null ? null : String(v))}
                    />
                  </CfgRow>
                  <CfgRow
                    label={tr("offload 保留天数")}
                    tip={tr("裁剪 offload 到磁盘的结果保留天数（offload_retention_days）。")}
                  >
                    <antd.InputNumber
                      min={1}
                      max={3650}
                      style={{ width: 140 }}
                      addonAfter={tr("天")}
                      disabled={!l1}
                      value={ctxEdits.offload_retention_days != null ? Number(ctxEdits.offload_retention_days) : num(((cfg.light_context_config as Rc | undefined)?.tool_result_pruning_config as Rc | undefined)?.offload_retention_days) ?? undefined}
                      onChange={(v: number | null) => ctxSet("offload_retention_days", v == null ? null : String(v))}
                    />
                  </CfgRow>
                  <CfgRow
                    label={tr("裁剪豁免扩展名")}
                    tip={tr("这些扩展名的文件读取结果不裁剪（exempt_file_extensions，逗号分隔，如 .md）。")}
                  >
                    <antd.Input
                      style={{ width: 220 }}
                      disabled={!l1}
                      value={ctxEdits.exempt_file_extensions != null ? String(ctxEdits.exempt_file_extensions) : String(((cfg.light_context_config as Rc | undefined)?.tool_result_pruning_config as unknown as { exempt_file_extensions?: string[] })?.exempt_file_extensions?.join(", ") ?? "")}
                      placeholder=".md, .json"
                      onChange={(ev: ReactNS.ChangeEvent<HTMLInputElement>) => ctxSet("exempt_file_extensions", ev.target.value)}
                    />
                  </CfgRow>
                  <CfgRow
                    label={tr("裁剪豁免工具")}
                    tip={tr("这些工具的结果不裁剪（exempt_tool_names，逗号分隔）。")}
                  >
                    <antd.Input
                      style={{ width: 220 }}
                      disabled={!l1}
                      value={ctxEdits.exempt_tool_names != null ? String(ctxEdits.exempt_tool_names) : String(((cfg.light_context_config as Rc | undefined)?.tool_result_pruning_config as unknown as { exempt_tool_names?: string[] })?.exempt_tool_names?.join(", ") ?? "")}
                      placeholder="chat_with_agent"
                      onChange={(ev: ReactNS.ChangeEvent<HTMLInputElement>) => ctxSet("exempt_tool_names", ev.target.value)}
                    />
                  </CfgRow>
                </antd.Card>
              ),
            },
            // v0.5.0-beta.13.8：长期记忆（reme_light_memory_config——
            // L2 白名单键，全角色可编辑核心项；embedding/目录只读展示）。
            {
              key: "mem",
              label: tr("长期记忆"),
              children: (
                <antd.Card size="small" title={tr("长期记忆")} style={{ marginTop: 4 }}>
                  <CfgRow
                    label={tr("记忆后端")}
                    tip={tr("memory_manager_backend——remelight=轻量本地记忆，adbpg=AnalyticDB PG 向量记忆。")}
                  >
                    <antd.Select
                      style={{ width: 200 }}
                      value={memBackend ?? String(cfg.memory_manager_backend || "remelight")}
                      onChange={(v: string) => setMemBackend(v)}
                      options={[
                        { value: "remelight", label: "remelight（轻量本地）" },
                        { value: "adbpg", label: "adbpg（AnalyticDB PG）" },
                        { value: String(cfg.memory_manager_backend || "remelight"), label: String(cfg.memory_manager_backend || "remelight") },
                      ].filter((o, i, a) => a.findIndex((x) => x.value === o.value) === i)}
                    />
                  </CfgRow>
                  <CfgRow
                    label={tr("压缩时摘要")}
                    tip={tr("上下文压缩时把被压缩内容写入长期记忆（summarize_when_compact）。")}
                  >
                    <antd.Switch
                      checked={remeEdits.summarize_when_compact === undefined || remeEdits.summarize_when_compact === null ? (remeCfg as Rc | undefined)?.summarize_when_compact === true : remeEdits.summarize_when_compact === true}
                      onChange={(v: boolean) => remeSet("summarize_when_compact", v)}
                    />
                  </CfgRow>
                  <CfgRow
                    label={tr("收件箱推送")}
                    tip={tr("新记忆写入时推送到收件箱（inbox_push_enabled）。")}
                  >
                    <antd.Switch
                      checked={remeEdits.inbox_push_enabled === undefined || remeEdits.inbox_push_enabled === null ? (remeCfg as Rc | undefined)?.inbox_push_enabled === true : remeEdits.inbox_push_enabled === true}
                      onChange={(v: boolean) => remeSet("inbox_push_enabled", v)}
                    />
                  </CfgRow>
                  <CfgRow
                    label={tr("自动记忆间隔（分钟）")}
                    tip={tr("每 N 分钟把对话增量写入长期记忆（auto_memory_interval，1..1440）。")}
                  >
                    <antd.InputNumber
                      min={1}
                      max={1440}
                      style={{ width: 140 }}
                      addonAfter={tr("分钟")}
                      value={remeEdits.auto_memory_interval != null ? Number(remeEdits.auto_memory_interval) : num((remeCfg as Rc | undefined)?.auto_memory_interval) ?? undefined}
                      onChange={(v: number | null) => remeSet("auto_memory_interval", v == null ? null : String(v))}
                    />
                  </CfgRow>
                  <CfgRow
                    label={tr("Dream 定时任务")}
                    tip={tr("定时记忆整合（dream_cron_enabled + dream_cron，cron 表达式）。")}
                  >
                    <antd.Space size={6}>
                      <antd.Switch
                        checked={remeEdits.dream_cron_enabled === undefined || remeEdits.dream_cron_enabled === null ? (remeCfg as Rc | undefined)?.dream_cron_enabled === true : remeEdits.dream_cron_enabled === true}
                        onChange={(v: boolean) => remeSet("dream_cron_enabled", v)}
                      />
                      <antd.Input
                        style={{ width: 150, fontFamily: "monospace" }}
                        value={remeEdits.dream_cron != null ? String(remeEdits.dream_cron) : String((remeCfg as Rc | undefined)?.dream_cron ?? "")}
                        placeholder="0 23 * * *"
                        onChange={(ev: ReactNS.ChangeEvent<HTMLInputElement>) => remeSet("dream_cron", ev.target.value)}
                      />
                    </antd.Space>
                  </CfgRow>
                  <div style={{ marginTop: 6 }}>
                    <antd.Button
                      size="small"
                      type="link"
                      style={{ padding: 0, fontSize: 11.5 }}
                      onClick={() => setMemOpen((v) => !v)}
                    >
                      {memOpen ? tr("隐藏配置 JSON") : tr("查看配置 JSON")}
                    </antd.Button>
                    {memOpen ? (
                      <pre
                        style={{
                          margin: "6px 0 0",
                          padding: 8,
                          fontSize: 10.5,
                          fontFamily: "monospace",
                          background: "rgba(127,127,127,0.06)",
                          border: "1px solid rgba(127,127,127,0.2)",
                          borderRadius: 6,
                          maxHeight: 180,
                          overflow: "auto",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-all",
                        }}
                      >
                        {JSON.stringify(
                          {
                            reme_light_memory_config: remeCfg ?? null,
                            adbpg_memory_config: adbpgCfg ?? null,
                          },
                          null,
                          2,
                        )}
                      </pre>
                    ) : null}
                  </div>
                </antd.Card>
              ),
            },
            {
              key: "system",
              label: tr("系统（只读）"),
              children: (
                <antd.Card size="small" title={tr("系统（只读）")} style={{ marginTop: 4 }}>
                  <CfgRow
                    label={tr("审批级别")}
                    tip={tr("approval_level——由审批端点（#1216）管理，本面板只读（PUT 会被服务端 400 拒绝）。")}
                  >
                    <b>{String(cfg.approval_level ?? "-")}</b>
                  </CfgRow>
                </antd.Card>
              ),
            },
          ]}
        />
      ) : null}
    </div>
  );
}

export default WorkerRuntimeConfig;
