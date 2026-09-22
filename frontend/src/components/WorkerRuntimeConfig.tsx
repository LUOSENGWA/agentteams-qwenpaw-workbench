/**
 * WorkerRuntimeConfig.tsx — A2：Worker 运行配置（消费上游 #1231）。
 *
 * 9/6 顺序铁律「插件 A2 先做先验证，dashboard 后对齐」——插件侧本轮（
 * v0.5.0-beta.13.4）落地，dashboard B5（#103）为镜像语义；罗总 9/22
 * 反馈「runtime config 没有」= 本面板此前从未实现（grep 0 命中）。
 *
 * 契约（上游 75c1a7fa pinned qwenpaw running-config contract 实读 +
 * Node1 v1.2.4 实盘 GET 交叉验证）：
 * - GET/PUT /api/v1/workers/{name}/runtime-config = 透传 Worker 运行配置
 *   对象（qwenpaw 进程 :8088 端点）；PUT = read-merge-write，部分字段
 *   安全，未带字段不动，空 body = no-op。
 * - 仅 spec.runtime == "qwenpaw" 生效（其余 runtime → 400）。
 * - L1 全字段（除 approval_level）；L2 = 团队作用域（404 越权）+ 字段
 *   白名单（workbench 5-tab 字段），未知键 **拒绝**（不静默丢弃）→
 *   本面板可编辑键全部在 L2 白名单内，diff body 按构造 L2 安全。
 * - approval_level 由 #1216 /approval 端点管理——本面板只读展示。
 * - loop（iteration/doom_loop/rubric/goal/mission/custom_modes）改动
 *   成功后服务端自动通知团队 Leader。
 * - 409 = Worker 正在执行任务/配置锁定；404 = Controller 未含 #1231
 *   或 Worker 非团队作用域（L2）→ 占位横幅降级。
 *
 * ⚠️ 字段名勘误（交叉验证发现）：dashboard B5（#103）spec 用的
 * max_input_tokens / compaction_threshold / loop_config 与 pinned 契约
 * 不符（实盘键 = max_input_length / 嵌套 light_context_config.
 * context_compact_config.compact_threshold_ratio / 顶层 loop）——L2 发
 * 白名单外键 400、L1 发则写入垃圾键。本面板按实盘契约命名；dashboard
 * 侧需随动（9/13 override 记录「插件批次落地时 dashboard 随动」）。
 *
 * 纪律：React/antd 取宿主（window.QwenPaw.host）；只走
 * /agentteams-proxy/controller 通用代理（后端零新端点）。
 */
import type * as ReactNS from "react";

import { requestJson, httpErrorStatus, httpErrorDetail } from "../api";
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

  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  const url = `/agentteams-proxy/controller/api/v1/workers/${encodeURIComponent(name)}/runtime-config`;

  const load = React.useCallback(async () => {
    setLoading(true);
    setGate("");
    setGateMsg("");
    try {
      const d = (await requestJson(url)) as Rc;
      setCfg(d && typeof d === "object" ? d : null);
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
  }, [url, tr]);

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
          {tr("运行配置")}（#1231 · qwenpaw）▾
        </antd.Button>
      </div>
    );
  }

  const lv = cfg ? parseLoop(cfg.loop) : null;
  const inputStyle: ReactNS.CSSProperties = { width: 110 };
  const labelStyle: ReactNS.CSSProperties = {
    fontSize: 12,
    color: "rgba(127,127,127,0.95)",
  };

  return (
    <div
      style={{
        marginTop: 8,
        border: "1px solid rgba(127,127,127,0.25)",
        borderRadius: 8,
        padding: 10,
        display: "grid",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 12.5 }}>{tr("运行配置")}</span>
        <antd.Tag style={{ marginInlineEnd: 0, fontSize: 10.5 }}>#1231</antd.Tag>
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
            "Controller 版本未含运行配置端点（#1231），或当前账号无该 Worker 访问权（L2 仅限自己团队）。",
          )}
        />
      ) : gate === "400" ? (
        <antd.Alert
          type="warning"
          showIcon
          message={tr("该 Worker 不支持运行配置")}
          description={gateMsg || tr("仅 spec.runtime = qwenpaw 的 Worker 支持（上游 #1231 契约）。")}
        />
      ) : null}

      {cfg && !gate ? (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", alignItems: "center" }}>
            <span style={labelStyle}>{tr("最大迭代")}</span>
            <antd.InputNumber
              size="small"
              style={inputStyle}
              min={1}
              defaultValue={num(cfg.max_iters) ?? undefined}
              onChange={(v: number | null) =>
                setMaxIters(v === null || v === undefined ? null : String(v))
              }
            />
            <span style={labelStyle}>{tr("LLM 自动重试")}</span>
            <antd.Switch
              size="small"
              defaultChecked={cfg.llm_retry_enabled === true}
              onChange={(v: boolean) => setRetryOn(v)}
            />
            <antd.InputNumber
              size="small"
              style={{ width: 84 }}
              min={0}
              defaultValue={num(cfg.llm_max_retries) ?? undefined}
              onChange={(v: number | null) =>
                setMaxRetries(v === null || v === undefined ? null : String(v))
              }
            />
            <span style={labelStyle}>{tr("退避")}</span>
            <antd.InputNumber
              size="small"
              style={{ width: 84 }}
              min={0}
              defaultValue={num(cfg.llm_backoff_base) ?? undefined}
              addonAfter="s"
              onChange={(v: number | null) =>
                setBackoffBase(v === null || v === undefined ? null : String(v))
              }
            />
            <antd.InputNumber
              size="small"
              style={{ width: 84 }}
              min={0}
              defaultValue={num(cfg.llm_backoff_cap) ?? undefined}
              addonAfter="s"
              onChange={(v: number | null) =>
                setBackoffCap(v === null || v === undefined ? null : String(v))
              }
            />
          </div>

          {/* loop 配置：结构化速览 + 整块 JSON 替换（dashboard B5 同款入口，键名修正为 pinned 契约的顶层 loop）。 */}
          {lv ? (
            <div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", alignItems: "center" }}>
                <span style={labelStyle}>{tr("loop")}</span>
                <antd.Tag style={{ marginInlineEnd: 0, fontSize: 10.5 }}>
                  iteration {lv.iterationEnabled ? "on" : "off"}
                  {lv.iterationMax != null ? ` max=${lv.iterationMax}` : ""}
                </antd.Tag>
                <antd.Tag style={{ marginInlineEnd: 0, fontSize: 10.5 }}>
                  doom-loop {lv.doomEnabled ? "on" : "off"}
                  {lv.doomWindow != null ? ` w=${lv.doomWindow}` : ""}
                </antd.Tag>
                <antd.Tag style={{ marginInlineEnd: 0, fontSize: 10.5 }}>
                  rubric {lv.rubricEnabled ? "on" : "off"}
                </antd.Tag>
                <antd.Tag style={{ marginInlineEnd: 0, fontSize: 10.5 }}>
                  goal {lv.goalEnabled ? "on" : "off"}
                  {lv.goalMaxIters != null ? ` max=${lv.goalMaxIters}` : ""}
                </antd.Tag>
                <antd.Tag style={{ marginInlineEnd: 0, fontSize: 10.5 }}>
                  mission {lv.missionEnabled ? "on" : "off"}
                </antd.Tag>
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
                <div style={{ marginTop: 6 }}>
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

          {/* 只读区：不在面板可编辑范围（L1-only 键 / 审批端点专属 / 高风险记忆配置）。 */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", fontSize: 11, color: "rgba(127,127,127,0.85)" }}>
            <span>
              {tr("审批级别")}:{" "}
              <b style={{ color: undefined }}>{String(cfg.approval_level ?? "-")}</b>
              （{tr("由审批端点管理")}）
            </span>
            <span>
              {tr("长期记忆")}: {String(cfg.memory_manager_backend ?? "-")}
            </span>
            <span>
              {tr("上下文后端")}: {String(cfg.context_manager_backend ?? "-")}
            </span>
            <span>
              {tr("Shell 超时")}: {String(num(cfg.shell_command_timeout) ?? "-")}s
            </span>
          </div>
        </>
      ) : null}
    </div>
  );
}

export default WorkerRuntimeConfig;
