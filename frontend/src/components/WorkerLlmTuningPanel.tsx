/**
 * WorkerLlmTuningPanel.tsx — Worker LLM 调优面板（移植 dashboard #146 缺口 3，
 * 消费 AgentTeams 1.2.5 WorkerSpec llm* 字段；逻辑正源 lib/llm-tuning.ts，
 * 字段网格复用 LlmTuningFields）。
 *
 * 契约（上游 v1.2.5 源码实读，2026-10-17 对账）：
 * - 读：GET /workers/{name} 顶层回显 10 个 llm* 字段（workerToResponse，
 *   omitempty=未设置不显 → pickLlmTuning 归一为空串）。
 * - 写：PUT /workers/{name} 只发 diff 键（字段级）；llm* 为 *string 指针
 *   语义——不发=不动、""=清除、非空=覆盖。
 * - 归属层级：Worker 覆盖 → 团队默认 → QwenPaw registry 默认（留空=继承）。
 * - 生效：startup 组改后需重建容器（spec-hash 驱动）；stream 组热更新。
 * - 权限：llm* 全字段 L1-only（checkScopedWorkerUpdate forbidden；
 *   L2/L3 → 403）。非 L1 → 只读降级（输入禁用 + 保存隐藏 + 提示）。
 * - 零后端新端点：走 /agentteams-proxy/controller catch-all 透传。
 *
 * 纪律：React/antd 取宿主（window.QwenPaw.host）；i18n 全量注册 en 键；
 * 挂载以 key={worker.name} 重挂载（编辑态随卸载清零，同 dashboard）。
 */
import type * as ReactNS from "react";

import {
  fetchControllerJson,
  fetchWorkerRuntimeEnv,
  updateWorker,
  httpErrorStatus,
  httpErrorDetail,
  type WorkerInfo,
  type TeamInfo,
} from "../api";
import {
  LLM_TUNING_FIELDS,
  emptyLlmTuning,
  findLlmTuningError,
  pickLlmTuning,
  resolveEffectiveLlmTuning,
  diffLlmTuningToOverride,
  type LlmTuningKey,
  type LlmTuningRecord,
  type LlmTuningValues,
} from "../lib/llm-tuning";
import LlmTuningFields from "./LlmTuningFields";
import { BrainIcon } from "./icons";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

function WorkerLlmTuningPanel({
  worker,
  l1,
  sheet,
  onChanged,
}: {
  worker: WorkerInfo;
  /** L1 账号（controller token）→ 可编辑；L2/旧 Controller=只读降级。 */
  l1?: boolean;
  /** 竖屏弹窗模式（NarrowSheet 承载）：去卡片外框 + 标题行（同 env 面板）。 */
  sheet?: boolean;
  /** 保存成功后回调（失效 admin 缓存，列表侧同步刷新）。 */
  onChanged?: () => void;
}) {
  const tr = useT();
  const t = useThemeColors();
  const name = worker.name;
  // 可收起/展开菜单（对齐 Coding CLI 段头家族）：宽屏默认收起，
  // sheet（竖屏弹窗）默认展开（sheet 由 NarrowSheet 承载，无折叠头）。
  const [open, setOpen] = React.useState(sheet === true);
  const [loading, setLoading] = React.useState(true);
  const [loadErr, setLoadErr] = React.useState("");
  // override=worker 显式覆盖（写基线）；team=团队 llm* 默认；
  // envEffective=容器 env 实际值（stream 组预填层，runtime-env 实读）；
  // draft=用户编辑（预填=生效值 override→team→env→registry）。
  const [override, setOverride] = React.useState<LlmTuningRecord | null>(null);
  const [team, setTeam] = React.useState<LlmTuningRecord | null>(null);
  const [envEffective, setEnvEffective] = React.useState<LlmTuningValues | null>(null);
  const [draft, setDraft] = React.useState<LlmTuningRecord | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadErr("");
    try {
      const w = await fetchControllerJson<WorkerInfo>(
        `workers/${encodeURIComponent(name)}`,
      );
      const picked = pickLlmTuning(w as LlmTuningValues | null);
      // 团队默认（AgentTeams 1.2.5+；无团队/旧 Controller/读失败 → 空，回退
      // registry 默认）。读团队失败不阻塞面板——生效值退化为 worker→registry。
      let teamRec = emptyLlmTuning();
      const teamName = w.team;
      // stream 组预填层（15.28）：容器 PID 1 env 实际值（entrypoint 默认
      // 300s / controller hot-apply 覆写）。与团队读并行；失败不阻塞
      // （403=L2 只读 / 旧 Controller 404 → 走原三层链）。
      const envPromise = fetchWorkerRuntimeEnv(name).catch(() => null);
      if (teamName) {
        try {
          const tm = await fetchControllerJson<TeamInfo>(
            `teams/${encodeURIComponent(teamName)}`,
          );
          teamRec = pickLlmTuning(tm as LlmTuningValues | null);
        } catch {
          /* 团队读取失败 → 回退 registry 默认 */
        }
      }
      const envRes = await envPromise;
      const envEff: LlmTuningValues = {};
      if (envRes?.env) {
        for (const f of LLM_TUNING_FIELDS) {
          if (!f.envKey) continue;
          const e = envRes.env.find((x) => x.key === f.envKey);
          if (e && e.value && !e.masked) envEff[f.key] = e.value;
        }
      }
      setOverride(picked);
      setTeam(teamRec);
      setEnvEffective(envEff);
      setDraft(resolveEffectiveLlmTuning(picked, teamRec, envEff));
    } catch (e) {
      setLoadErr(
        e instanceof Error
          ? httpErrorStatus(e) === 403
            ? tr("当前账号无权限读取该 Worker（需 L1）")
            : e.message
          : tr("加载失败"),
      );
    } finally {
      setLoading(false);
    }
  }, [name, tr]);

  // 惰性加载：首次展开才拉（折叠态不发起 GET /workers/{name}；多 worker 卡
  // 聚合时省无谓请求）。加载一次后折叠/展开不重拉（保留编辑态）。
  const loadedRef = React.useRef(false);
  React.useEffect(() => {
    if (!open || loadedRef.current) return;
    loadedRef.current = true;
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [open, load]);

  const onField = React.useCallback((key: LlmTuningKey, value: string) => {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
    setMsg(null);
  }, []);

  const handleSave = React.useCallback(async () => {
    if (!override || !team || !draft || saving || !l1) return;
    if (findLlmTuningError(draft)) return;
    const diff = diffLlmTuningToOverride(draft, team, override, envEffective ?? undefined);
    if (Object.keys(diff).length === 0) return;
    setSaving(true);
    setMsg(null);
    try {
      await updateWorker(name, diff);
      const nextOverride = { ...override, ...diff };
      setOverride(nextOverride);
      // 保存后生效值 = 新 override → 继承；同步 draft（字段回到新生效值）。
      // stream 组保存后 env 会 hot-apply → 同步刷新 env 层（读回真值）。
      setDraft(resolveEffectiveLlmTuning(nextOverride, team, envEffective ?? undefined));
      // 15.30：fresh=true 绕 120s 缓存实读 hot-applied 真值（首次加载走缓存）。
      void fetchWorkerRuntimeEnv(name, false, true)
        .then((envRes) => {
          const envEff: LlmTuningValues = {};
          if (envRes?.env) {
            for (const f of LLM_TUNING_FIELDS) {
              if (!f.envKey) continue;
              const e = envRes.env.find((x) => x.key === f.envKey);
              if (e && e.value && !e.masked) envEff[f.key] = e.value;
            }
          }
          setEnvEffective(envEff);
        })
        .catch(() => undefined);
      setMsg({ ok: true, text: tr("已保存（启动期参数需重建容器生效）") });
      onChanged?.();
    } catch (e) {
      setMsg({
        ok: false,
        text: e instanceof Error ? httpErrorDetail(e) || e.message : tr("保存失败"),
      });
    } finally {
      setSaving(false);
    }
  }, [override, team, draft, saving, l1, name, tr, onChanged, envEffective]);

  // 卡片外框（宽屏内联）；sheet 模式去外框（NarrowSheet 自带标题）。
  const body = (
    <div style={{ display: "grid", gap: 10 }}>
      {loading ? (
        <antd.Skeleton active title={false} paragraph={{ rows: 4 }} />
      ) : loadErr || !override || !team || !draft ? (
        <antd.Alert
          type="warning"
          showIcon
          message={tr("LLM 调优参数")}
          description={
            <span>
              {loadErr || tr("未读到该 Worker 的 LLM 调优参数（Controller 升级后自动开放）")}
              <antd.Button
                type="link"
                size="small"
                onClick={() => void load()}
                style={{ padding: 0, marginLeft: 8 }}
              >
                {tr("重试")}
              </antd.Button>
            </span>
          }
        />
      ) : (
        <>
          {!l1 ? (
            <antd.Alert
              type="info"
              showIcon
              message={tr("只读：LLM 调优为 L1（管理员）操作，当前账号不可编辑")}
              style={{ padding: "4px 10px" }}
            />
          ) : null}
          <div style={{ fontSize: 12, color: t.textSecondary }}>
            {tr("LLM 调优参数（Worker 覆盖团队默认）")}
          </div>
          <LlmTuningFields
            values={draft}
            onChange={onField}
            disabled={saving || !l1}
          />
          <div style={{ fontSize: 10, color: t.textSecondary }}>
            {tr(
              "已预填当前生效值（Worker 覆盖 → 团队默认 → QwenPaw 默认）。修改即写入该 Worker 覆盖；改回继承值则清除覆盖。「重试与限流」改动需重建容器生效；「流式超时」即时生效。",
            )}
          </div>
          {(() => {
            const err = findLlmTuningError(draft);
            return err ? (
              <div style={{ fontSize: 11, color: "#e5484d" }}>
                {tr("{label}：{message}", { label: err.label, message: err.message })}
              </div>
            ) : null;
          })()}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {l1 ? (
              <antd.Button
                type="primary"
                size="small"
                loading={saving}
                disabled={
                  !!findLlmTuningError(draft) ||
                  Object.keys(diffLlmTuningToOverride(draft, team, override, envEffective ?? undefined)).length === 0
                }
                onClick={() => void handleSave()}
              >
                {tr("保存改动")}
              </antd.Button>
            ) : null}
            <antd.Button
              size="small"
              disabled={
                saving ||
                Object.keys(diffLlmTuningToOverride(draft, team, override, envEffective ?? undefined)).length === 0
              }
              onClick={() => {
                setDraft(
                  resolveEffectiveLlmTuning(override, team, envEffective ?? undefined),
                );
                setMsg(null);
              }}
            >
              {tr("撤销")}
            </antd.Button>
            {msg ? (
              <span
                style={{
                  fontSize: 11,
                  color: msg.ok ? "#2e9e5b" : "#e5484d",
                }}
              >
                {msg.text}
              </span>
            ) : null}
          </div>
        </>
      )}
    </div>
  );

  if (sheet) return <>{body}</>;

  // 收起态：紧凑段头（▸ + 图标 + 标题），点击展开（x=33 段头轨对齐 Coding CLI）。
  if (!open) {
    return (
      <div
        style={{
          margin: "4px 0 4px 22px",
          border: `1px solid ${t.border}`,
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 10px",
            cursor: "pointer",
          }}
          onClick={() => setOpen(true)}
        >
          <span style={{ width: 12, fontSize: 10, color: "#888" }}>▸</span>
          <BrainIcon size={13} />
          <span style={{ fontWeight: 600, fontSize: 12 }}>{tr("LLM 调优")}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        margin: "4px 0 4px 22px",
        border: `1px solid ${t.border}`,
        borderRadius: 8,
        background: t.cardBg,
        padding: 10,
        display: "grid",
        gap: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          cursor: "pointer",
        }}
        onClick={() => setOpen(false)}
        title={tr("收起")}
      >
        <span style={{ width: 12, fontSize: 10, color: "#888" }}>▾</span>
        <BrainIcon size={13} />
        <span style={{ fontWeight: 600, fontSize: 12 }}>{tr("LLM 调优")}</span>
      </div>
      {body}
    </div>
  );
}

export default React.memo(WorkerLlmTuningPanel);
