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

interface LoopView {
  iterationEnabled: boolean;
  iterationMax: number | null;
  doomEnabled: boolean;
  doomWindow: number | null;
  rubricEnabled: boolean;
  goalEnabled: boolean;
  goalMaxIters: number | null;
  missionEnabled: boolean;
}

function parseLoop(v: unknown): LoopView {
  const o = (v && typeof v === "object" ? v : {}) as Rc;
  const it = (o.iteration && typeof o.iteration === "object" ? o.iteration : {}) as Rc;
  const doom = (o.doom_loop && typeof o.doom_loop === "object" ? o.doom_loop : {}) as Rc;
  const rub = (o.rubric && typeof o.rubric === "object" ? o.rubric : {}) as Rc;
  const goal = (o.goal && typeof o.goal === "object" ? o.goal : {}) as Rc;
  const mis = (o.mission && typeof o.mission === "object" ? o.mission : {}) as Rc;
  return {
    iterationEnabled: it.enabled === true,
    iterationMax: num(it.max_iterations),
    doomEnabled: doom.enabled === true,
    doomWindow: num(doom.window),
    rubricEnabled: rub.enabled === true,
    goalEnabled: goal.enabled === true,
    goalMaxIters: num(goal.max_iterations),
    missionEnabled: mis.enabled === true,
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

function WorkerRuntimeConfig({ name }: { name: string }) {
  const tr = useT();
  const [open, setOpen] = React.useState(false);
  const [cfg, setCfg] = React.useState<Rc | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [gate, setGate] = React.useState<"" | "404" | "400">("");
  const [gateMsg, setGateMsg] = React.useState("");

  // 编辑值（null = 未改动）。
  const [maxIters, setMaxIters] = React.useState<string | null>(null);
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
    setMaxIters(null);
    setRetryOn(null);
    setMaxRetries(null);
    setBackoffBase(null);
    setBackoffCap(null);
    setLoopText(null);
    setMsg(null);
  };

  /** 字段级 diff——只发改动的顶层键（read-merge-write 契约）。
   *  返回 [diff, invalidMsg]。 */
  const buildDiff = (): { diff: Rc; invalid: string } => {
    const diff: Rc = {};
    if (!cfg) return { diff, invalid: "" };
    if (maxIters !== null) {
      if (!isPosInt(maxIters)) return { diff, invalid: tr("max_iters 须为正整数") };
      const n = Number(maxIters);
      if (n !== num(cfg.max_iters)) diff.max_iters = n;
    }
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
    if (loopText !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(loopText);
      } catch {
        return { diff, invalid: tr("loop 不是合法 JSON") };
      }
      if (
        JSON.stringify(parsed) !== JSON.stringify(cfg.loop ?? null)
      ) {
        diff.loop = parsed;
      }
    }
    return { diff, invalid: "" };
  };

  const dirty = React.useMemo(() => Object.keys(buildDiff().diff).length > 0, [
    // eslint-disable-next-line react-hooks/exhaustive-deps
    cfg, maxIters, retryOn, maxRetries, backoffBase, backoffCap, loopText,
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
                  <CfgRow
                    label={tr("最大迭代")}
                    tip={tr("单次任务允许的最大 LLM 迭代轮数（max_iters）。越大越能啃硬任务，越慢越贵。")}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                      <antd.Slider
                        style={{ flex: 1, minWidth: 0, margin: "0 4px" }}
                        min={1}
                        max={Math.max(100, num(cfg.max_iters) ?? 100)}
                        value={
                          maxIters !== null && isPosInt(maxIters)
                            ? Number(maxIters)
                            : (num(cfg.max_iters) ?? 0)
                        }
                        onChange={(v: number) => setMaxIters(String(v))}
                      />
                      <span style={{ minWidth: 40, textAlign: "right", fontSize: 13, fontWeight: 500 }}>
                        {maxIters !== null && isPosInt(maxIters)
                          ? maxIters
                          : String(num(cfg.max_iters) ?? "-")}
                      </span>
                    </div>
                  </CfgRow>
                  <CfgRow
                    label={tr("Shell 超时")}
                    tip={tr("单次 shell 命令超时（秒）。L1-only 键，本面板只读。")}
                  >
                    <span style={{ fontSize: 13 }}>
                      {tr("{n} 秒", { n: String(num(cfg.shell_command_timeout) ?? "-") })}
                    </span>
                  </CfgRow>
                </antd.Card>
              ),
            },
            {
              key: "loop",
              label: tr("Agent Loop"),
              children: (
                <antd.Card size="small" title={tr("Agent Loop")} style={{ marginTop: 4 }}>
                  {/* loop 配置：结构化速览 + 整块 JSON 替换（键名=契约顶层 loop）。 */}
                  {lv ? (
                    <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                        <antd.Tag color={lv.iterationEnabled ? "green" : "default"} style={{ marginInlineEnd: 0, fontSize: 11 }}>
                          iteration {lv.iterationEnabled ? "on" : "off"}
                          {lv.iterationMax != null ? ` max=${lv.iterationMax}` : ""}
                        </antd.Tag>
                        <antd.Tag color={lv.doomEnabled ? "green" : "default"} style={{ marginInlineEnd: 0, fontSize: 11 }}>
                          doom-loop {lv.doomEnabled ? "on" : "off"}
                          {lv.doomWindow != null ? ` w=${lv.doomWindow}` : ""}
                        </antd.Tag>
                        <antd.Tag color={lv.rubricEnabled ? "green" : "default"} style={{ marginInlineEnd: 0, fontSize: 11 }}>
                          rubric {lv.rubricEnabled ? "on" : "off"}
                        </antd.Tag>
                        <antd.Tag color={lv.goalEnabled ? "green" : "default"} style={{ marginInlineEnd: 0, fontSize: 11 }}>
                          goal {lv.goalEnabled ? "on" : "off"}
                          {lv.goalMaxIters != null ? ` max=${lv.goalMaxIters}` : ""}
                        </antd.Tag>
                        <antd.Tag color={lv.missionEnabled ? "green" : "default"} style={{ marginInlineEnd: 0, fontSize: 11 }}>
                          mission {lv.missionEnabled ? "on" : "off"}
                        </antd.Tag>
                      </div>
                      <div>
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
                          {tr("编辑整块 JSON")}
                        </antd.Button>
                      </div>
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
                            {tr("loop 为整块替换语义——保存后整个 loop 对象以此 JSON 为准；loop 变更将通知团队 Leader。")}
                          </div>
                        </div>
                      ) : null}
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
                    tip={tr("memory_manager_backend——L1 键，本面板只读展示。")}
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
