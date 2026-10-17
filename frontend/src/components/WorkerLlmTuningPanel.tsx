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
  updateWorker,
  httpErrorStatus,
  httpErrorDetail,
  type WorkerInfo,
} from "../api";
import {
  diffLlmTuning,
  findLlmTuningError,
  pickLlmTuning,
  type LlmTuningKey,
  type LlmTuningRecord,
  type LlmTuningValues,
} from "../lib/llm-tuning";
import LlmTuningFields from "./LlmTuningFields";
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
  const [loading, setLoading] = React.useState(true);
  const [loadErr, setLoadErr] = React.useState("");
  const [current, setCurrent] = React.useState<LlmTuningRecord | null>(null);
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
      setCurrent(picked);
      setDraft(picked);
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

  // 延迟一个宏任务调用 load（避开 effect 同步阶段 setState 链，同 dashboard）。
  React.useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const onField = React.useCallback((key: LlmTuningKey, value: string) => {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
    setMsg(null);
  }, []);

  const handleSave = React.useCallback(async () => {
    if (!current || !draft || saving || !l1) return;
    if (findLlmTuningError(draft)) return;
    const diff = diffLlmTuning(current, draft);
    if (Object.keys(diff).length === 0) return;
    setSaving(true);
    setMsg(null);
    try {
      await updateWorker(name, diff);
      setCurrent((prev) => (prev ? { ...prev, ...diff } : prev));
      setDraft((prev) => (prev ? { ...prev, ...diff } : prev));
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
  }, [current, draft, saving, l1, name, tr, onChanged]);

  // 卡片外框（宽屏内联）；sheet 模式去外框（NarrowSheet 自带标题）。
  const body = (
    <div style={{ display: "grid", gap: 10 }}>
      {loading ? (
        <antd.Skeleton active title={false} paragraph={{ rows: 4 }} />
      ) : loadErr || !current || !draft ? (
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
              "留空表示不设置：先继承团队默认，再回退 QwenPaw 默认。「重试与限流」改动需重建容器生效；「流式超时」即时生效。",
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
                  Object.keys(diffLlmTuning(current, draft)).length === 0
                }
                onClick={() => void handleSave()}
              >
                {tr("保存改动")}
              </antd.Button>
            ) : null}
            <antd.Button
              size="small"
              disabled={
                saving || Object.keys(diffLlmTuning(current, draft)).length === 0
              }
              onClick={() => {
                setDraft(current);
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

  return (
    <div
      style={{
        border: `1px solid ${t.border}`,
        borderRadius: 8,
        background: t.cardBg,
        padding: 12,
        display: "grid",
        gap: 10,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 13 }}>{tr("LLM 调优")}</div>
      {body}
    </div>
  );
}

export default React.memo(WorkerLlmTuningPanel);
