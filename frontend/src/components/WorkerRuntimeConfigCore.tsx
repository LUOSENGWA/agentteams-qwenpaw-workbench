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
import { useThemeColors } from "../theme";
import {
  num,
  isPosInt,
  isPosNum,
  LOOP_TEMPLATES,
  LOOP_GATE_DEFS,
  type Rc,
  type DoomStageV,
} from "./runtimeCfg/helpers";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

/** 六 tab 补齐——新字段组草稿（key=字段路径，
 * null/undefined=未改动；buildDiff 时与当前值比对决定是否入 diff）。 */
type EditVal = string | boolean | null;
type EditMap = Record<string, EditVal>;

export function useWorkerRuntimeConfigCore({
  name,
  l1,
  sheet,
}: {
  name: string;
  /** 当前账号 L1（controller token）——L1-only 字段（并发限流/上下文管理/
 * shell 组/auto_title）可编辑；L2 只读（PUT 非 L2 白名单键被服务端 403）。 */
  l1?: boolean;
  /** ：跳「设置」页
 * 配 Controller token 的入口（L1 账号密码登录只落 Higress Console
 * 会话 ≠ Controller 管理 token——两套凭证，Alert 给明确指引）。 */
  onOpenSettings?: () => void;
  /** 竖屏弹窗模式（WorkerManage NarrowSheet 底部抽屉承载）：初始即展开
 * （懒加载时点 = 弹窗打开，语义不变）+ 去卡片外框（margin/边框，弹窗
 * 即容器）+ 头部隐藏收起抓手/图标/标题（Modal 头已带标题，仅留 qwenpaw
 * 标签与 刷新/重置/保存 动作钮）。表单内容零改动。 */
  sheet?: boolean;
}) {
  const tr = useT();
  const t = useThemeColors();
  const [open, setOpen] = React.useState(sheet === true);
  const [cfg, setCfg] = React.useState<Rc | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [gate, setGate] = React.useState<"" | "404" | "400">("");
  const [gateMsg, setGateMsg] = React.useState("");

  // 编辑值（null = 未改动）。
  // （13.6 「基本 tab 的拖动条有问题，QwenPaw 是输入
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
  // （13.7 「ReAct 智能体/LLM 并发限流/上下文管理/
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
 * 对象）。值域全部按 qwenpaw LoopConfig 数据模型校验（GE/LE 逐条对账）。
 * 返回 [merged, changed, invalidMsg]。 */
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
 * 返回 [diff, invalidMsg]。 */
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
    // ── 六 tab 补齐 ───────────────────────────────
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
      // 实盘结构（验证实盘 v1.2.4 GET 全字段）：
      // light_context_config{strategy, dialog_path, token_count_estimate_divisor,
      // context_compact_config{enabled, compact_threshold_ratio, reserve_threshold_ratio},
      // tool_result_pruning_config{enabled, pruning_recent_n,
      // pruning_old_msg_max_bytes, pruning_recent_msg_max_bytes,
      // offload_retention_days, tool_results_cache,
      // exempt_file_extensions[], exempt_tool_names[]},
      // scroll_config{...}}
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

  /** 模板创建自定义 loop 模式（QwenPaw buildCustomLoopMode
 * 同语义：模板 gate 序列 → makeGate（id=`${type}-${nonce}` + 默认参数））。 */
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
  return {
    tr,
    t,
    open,
    setOpen,
    cfg,
    setCfg,
    loading,
    setLoading,
    gate,
    setGate,
    gateMsg,
    setGateMsg,
    iterEnabled,
    setIterEnabled,
    iterValue,
    setIterValue,
    doomEnabled,
    setDoomEnabled,
    doomWindow,
    setDoomWindow,
    doomThreshold,
    setDoomThreshold,
    doomStages,
    setDoomStages,
    rubricEnabled,
    setRubricEnabled,
    rubricPrompt,
    setRubricPrompt,
    rubricInterventions,
    setRubricInterventions,
    goalIters,
    setGoalIters,
    goalTokens,
    setGoalTokens,
    missionIters,
    setMissionIters,
    missionRetries,
    setMissionRetries,
    missionInstr,
    setMissionInstr,
    missionCmd,
    setMissionCmd,
    memBackend,
    setMemBackend,
    retryOn,
    setRetryOn,
    maxRetries,
    setMaxRetries,
    backoffBase,
    setBackoffBase,
    backoffCap,
    setBackoffCap,
    shellEdits,
    setShellEdits,
    rateEdits,
    setRateEdits,
    ctxEdits,
    setCtxEdits,
    remeEdits,
    setRemeEdits,
    mkSet,
    shellSet,
    rateSet,
    ctxSet,
    remeSet,
    tmplOpen,
    setTmplOpen,
    tmplName,
    setTmplName,
    tmplCmd,
    setTmplCmd,
    tmplDesc,
    setTmplDesc,
    tmplSel,
    setTmplSel,
    tmplGates,
    setTmplGates,
    tmplBusy,
    setTmplBusy,
    loopText,
    setLoopText,
    loopOpen,
    setLoopOpen,
    loops,
    setLoops,
    customs,
    setCustoms,
    loopsErr,
    setLoopsErr,
    loopsLoading,
    setLoopsLoading,
    creating,
    setCreating,
    newJson,
    setNewJson,
    busyId,
    setBusyId,
    loopMsg,
    setLoopMsg,
    memOpen,
    setMemOpen,
    saving,
    setSaving,
    msg,
    setMsg,
    base,
    url,
    loadLoops,
    load,
    resetEdits,
    mergeLoopGates,
    buildDiff,
    dirty,
    save,
    createCustom,
    createViaTemplate,
    toggleCustom,
    removeCustom,
  };
}
