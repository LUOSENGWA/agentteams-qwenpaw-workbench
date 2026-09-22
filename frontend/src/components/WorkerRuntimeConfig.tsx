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

function WorkerRuntimeConfig({ name }: { name: string }) {
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
        return { merged, changed, invalid: tr("Goal 令牌预算须为正整数") };
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
        return { merged, changed, invalid: tr("Mission 每故事重试须为 0..10 的整数") };
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
              label: tr("基本"),
              children: (
                <antd.Card size="small" title={tr("基本")} style={{ marginTop: 4 }}>
                  {/* v0.5.0-beta.13.7（13.6 装验「基本的拖动条有问题，看看
                      QwenPaw 怎么做的，是像上一个版本输入数字的」）：
                      ① 滑杆废弃——QwenPaw 配置面没有滑杆，迭代上限在
                      Agent Loop → iteration 门（InputNumber，见 Loop tab）；
                      ② 本 tab 按 QwenPaw ReactAgentCard 行对齐（可编辑=
                      记忆后端【L2 白名单键，13.6 误标只读】；其余=L1 只读）。 */}
                  <CfgRow
                    label={tr("记忆后端")}
                    tip={tr("长期记忆后端（memory_manager_backend）。remelight=轻量本地记忆，adbpg=AnalyticDB PG 向量记忆。L2 白名单键，可编辑。")}
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
                    label={tr("最大迭代")}
                    tip={tr("单次任务最大 LLM 迭代轮数。唯一编辑入口在 Agent Loop → iteration 门（与 QwenPaw console 一致）；此处只读展示。")}
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
                    tip={tr("单次 shell 命令超时（秒）。L1-only 键，本面板只读。")}
                  >
                    <span style={{ fontSize: 13 }}>
                      {tr("{n} 秒", { n: String(num(cfg.shell_command_timeout) ?? "-") })}
                    </span>
                  </CfgRow>
                  <CfgRow
                    label={tr("Shell 可执行文件")}
                    tip={tr("shell 命令使用的可执行文件（shell_command_executable）。L1-only 键，本面板只读。")}
                  >
                    <span style={{ fontSize: 13, fontFamily: "monospace" }}>
                      {String(cfg.shell_command_executable || tr("默认"))}
                    </span>
                  </CfgRow>
                  <CfgRow
                    label={tr("自动标题")}
                    tip={tr("会话自动标题（auto_title_config）。L1-only 键，本面板只读。")}
                  >
                    {(() => {
                      const at = (cfg.auto_title_config && typeof cfg.auto_title_config === "object" ? cfg.auto_title_config : {}) as Rc;
                      return (
                        <antd.Tag color={at.enabled === true ? "green" : "default"} style={{ marginInlineEnd: 0 }}>
                          {at.enabled === true ? tr("已启用") : tr("未启用")}
                          {num(at.timeout_seconds) != null ? `（${num(at.timeout_seconds)}s）` : ""}
                        </antd.Tag>
                      );
                    })()}
                  </CfgRow>
                </antd.Card>
              ),
            },
            {
              key: "loop",
              label: tr("Agent Loop"),
              children: (
                <antd.Card size="small" title={tr("Agent Loop")} style={{ marginTop: 4 }}>
                  {/* v0.5.0-beta.13.7（13.6 装验「Loop 设置抄 QwenPaw 没抄
                      完」）：按 QwenPaw AgentLoopCard 补齐——Default 模式 gate
                      管道（iteration/doom_loop/rubric）+ Goal/Mission 内置
                      参数，全部 InputNumber（QwenPaw 配置面无滑杆）；13.6
                      tag 速览废弃（goal/mission 数据模型无 enabled 字段，
                      tag 恒 off 误导）；整块 JSON 保留为高级兜底。值域逐条
                      对账 qwenpaw LoopConfig（iteration 1..500 / doom
                      window≥2 / threshold 0..1 / stages after≥1 / rubric
                      1..10 / goal 1..500 / mission 1..100·retry 0..10）。 */}
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
                                : lv.iterationMax ?? undefined
                            }
                            onChange={(v: number | null) =>
                              setIterValue(v === null || v === undefined ? null : String(v))
                            }
                          />
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
                        <GateParam label={tr("令牌预算")}>
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
                        <GateParam label={tr("每故事重试")}>
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
              label: tr("LLM 重试"),
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
                  <CfgRow
                    label={tr("长期记忆后端")}
                    tip={tr("memory_manager_backend——基本 tab 可编辑（L2 白名单键）。")}
                  >
                    <span style={{ fontFamily: "monospace", fontSize: 12.5 }}>
                      {String(cfg.memory_manager_backend ?? "-")}
                    </span>
                  </CfgRow>
                  <CfgRow
                    label={tr("上下文后端")}
                    tip={tr("context_manager_backend——L1 键，本面板只读展示。")}
                  >
                    <span style={{ fontFamily: "monospace", fontSize: 12.5 }}>
                      {String(cfg.context_manager_backend ?? "-")}
                    </span>
                  </CfgRow>
                  {/* v0.5.0-beta.13.7（「配置方面还有什么没有对齐」——QwenPaw
                      LlmRateLimiterCard + 长度类字段，L1-only 只读展示）： */}
                  <CfgRow
                    label={tr("LLM 并发上限")}
                    tip={tr("LLM 同时运行数（llm_max_concurrent）。L1-only，本面板只读。")}
                  >
                    <span style={{ fontSize: 12.5 }}>
                      {String(cfg.llm_max_concurrent ?? "-")}
                    </span>
                  </CfgRow>
                  <CfgRow
                    label={tr("LLM QPM")}
                    tip={tr("LLM 每分钟请求上限（llm_max_qpm）。L1-only，本面板只读。")}
                  >
                    <span style={{ fontSize: 12.5 }}>
                      {String(cfg.llm_max_qpm ?? "-")}
                    </span>
                  </CfgRow>
                  <CfgRow
                    label={tr("限速等待")}
                    tip={tr("触发限速时等待秒数（llm_rate_limit_pause）。L1-only，本面板只读。")}
                  >
                    <span style={{ fontSize: 12.5 }}>
                      {tr("{n} 秒", { n: String(num(cfg.llm_rate_limit_pause) ?? "-") })}
                    </span>
                  </CfgRow>
                  <CfgRow
                    label={tr("限速抖动")}
                    tip={tr("限速等待的随机抖动秒数（llm_rate_limit_jitter）。L1-only，本面板只读。")}
                  >
                    <span style={{ fontSize: 12.5 }}>
                      {tr("{n} 秒", { n: String(num(cfg.llm_rate_limit_jitter) ?? "-") })}
                    </span>
                  </CfgRow>
                  <CfgRow
                    label={tr("槽位获取超时")}
                    tip={tr("获取并发槽位的超时秒数（llm_acquire_timeout）。L1-only，本面板只读。")}
                  >
                    <span style={{ fontSize: 12.5 }}>
                      {tr("{n} 秒", { n: String(num(cfg.llm_acquire_timeout) ?? "-") })}
                    </span>
                  </CfgRow>
                  <CfgRow
                    label={tr("最大输入长度")}
                    tip={tr("单次请求最大输入字符数（max_input_length）。L1-only，本面板只读。")}
                  >
                    <span style={{ fontSize: 12.5 }}>
                      {String(cfg.max_input_length ?? "-")}
                    </span>
                  </CfgRow>
                  <CfgRow
                    label={tr("历史消息长度")}
                    tip={tr("上下文保留的历史消息数（history_max_length）。L1-only，本面板只读。")}
                  >
                    <span style={{ fontSize: 12.5 }}>
                      {String(cfg.history_max_length ?? "-")}
                    </span>
                  </CfgRow>
                  <CfgRow
                    label={tr("reme 轻量记忆")}
                    tip={tr("reme_light_memory_config——记忆参数高风险，仅展示不开放编辑。")}
                  >
                    <antd.Tag color={hasMem && remeCfg ? "blue" : "default"} style={{ marginInlineEnd: 0 }}>
                      {hasMem && remeCfg ? tr("已配置") : tr("未配置")}
                    </antd.Tag>
                  </CfgRow>
                  <CfgRow
                    label={tr("adbpg 记忆")}
                    tip={tr("adbpg_memory_config——记忆参数高风险，仅展示不开放编辑。")}
                  >
                    <antd.Tag
                      color={
                        adbpgCfg && typeof adbpgCfg === "object" && Object.keys(adbpgCfg as Rc).length > 0
                          ? "blue"
                          : "default"
                      }
                      style={{ marginInlineEnd: 0 }}
                    >
                      {adbpgCfg && typeof adbpgCfg === "object" && Object.keys(adbpgCfg as Rc).length > 0
                        ? tr("已配置")
                        : tr("未配置")}
                    </antd.Tag>
                  </CfgRow>
                  {hasMem ? (
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
                  ) : null}
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
