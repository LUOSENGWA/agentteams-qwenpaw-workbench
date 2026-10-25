// P2「待决策」聚合页——与顶栏 badge/全局弹窗同一数据源（attention 聚合
// payload），列表 + 单条详情 + 历史已回答。诚实降级：payload 未就绪 =
// 骨架；deployed=false（旧 controller）= 明确空态（不报错）。

import type * as ReactNS from "react";

import {
  type AttentionItem,
  type AttentionPayload,
} from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { usePoller } from "../usePoller";
import { useTabActive } from "../tabActivity";
import { WbTooltip } from "./WbTooltip";
import { statusVariant } from "./CodingRunsPanel";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
const icons = (host.antdIcons || {}) as Record<string, ReactNS.ComponentType>;
const EmptyIcon = (() => null) as unknown as ReactNS.FC<Record<string, unknown>>;
const pick = (name: string): ReactNS.FC<Record<string, unknown>> =>
  (icons[name] as ReactNS.FC<Record<string, unknown>>) || EmptyIcon;
const ReloadIcon = pick("ReloadOutlined");

const KIND_META: Record<string, { label: string; color: string }> = {
  approval: { label: "审批", color: "orange" },
  decision: { label: "决策", color: "blue" },
  escalation: { label: "升级", color: "red" },
  other: { label: "其他", color: "default" },
};

function fmtTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours(),
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function AttentionBoard({
  payload,
  onOpenItem,
  onRefresh,
}: {
  payload: AttentionPayload | null;
  /** 打开全局决策弹窗并定位到该条。 */
  onOpenItem: (item: AttentionItem) => void;
  /** 手动刷新（绕过 30s 服务端缓存）。 */
  onRefresh: () => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  const attentionActive = useTabActive("attention");
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);

  // 本 tab 激活期再补一层 30s 静默刷新（父级全局轮询之外；rc-tabs 保活
  // 下切回来立即有新数据——与 CodingRunsPanel 同约定）。
  usePoller({
    fn: () => onRefresh(),
    intervalMs: 30000,
    active: attentionActive,
    minPokeMs: 15000,
  });

  const items = payload?.items || [];
  const pending = React.useMemo(
    () => items.filter((it) => !it.answered_locally && !it.resolved),
    [items],
  );
  const history = payload?.answered_history || [];

  // 选中项定位（key=task_id:kind:attempt；列表变化后夹紧）。
  const selIdx = React.useMemo(() => {
    if (!selectedKey) return pending.length > 0 ? 0 : -1;
    const i = pending.findIndex(
      (it) => `${it.task_id}:${it.kind || "other"}:${it.attempt}` === selectedKey,
    );
    return i >= 0 ? i : 0;
  }, [pending, selectedKey]);
  const selected = selIdx >= 0 ? pending[selIdx] : null;

  // ── 降级/加载态 ──
  if (!payload) {
    return (
      <div>
        <BoardHeader tr={tr} onRefresh={onRefresh} countText={null} />
        <div style={{ padding: 16 }}>
          <antd.Skeleton active title={false} paragraph={{ rows: 3 }} />
        </div>
      </div>
    );
  }
  if (!payload.deployed) {
    return (
      <div>
        <BoardHeader tr={tr} onRefresh={onRefresh} countText={null} />
        <div
          style={{
            padding: "14px 16px",
            borderRadius: 8,
            border: `1px solid ${t.border}`,
            color: t.textSecondary,
            fontSize: 13,
          }}
        >
          {tr("决策数据不可用（controller 端点未部署或未连接）")}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <BoardHeader
        tr={tr}
        onRefresh={onRefresh}
        countText={tr("{n} 条", { n: pending.length })}
      />

      {/* 列表 + 详情（单列窄屏自动堆叠） */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(280px, 1.1fr) minmax(260px, 1fr)",
          gap: 12,
          alignItems: "start",
        }}
      >
        {/* 左：待答列表 */}
        <div style={{ display: "grid", gap: 6 }}>
          {pending.length === 0 ? (
            <antd.Empty
              description={tr("暂无待决策")}
              image={antd.Empty.PRESENTED_IMAGE_SIMPLE}
            />
          ) : (
            pending.map((it) => {
              const k = `${it.task_id}:${it.kind || "other"}:${it.attempt}`;
              const active = k === selectedKey || (selIdx === 0 && !selectedKey);
              const meta = KIND_META[it.kind] || KIND_META.other;
              const expired =
                !!it.expires_at && !isNaN(new Date(it.expires_at).getTime()) &&
                new Date(it.expires_at).getTime() <= Date.now();
              return (
                <div
                  key={k}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedKey(k)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      setSelectedKey(k);
                    }
                  }}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 8,
                    cursor: "pointer",
                    background: active ? "rgba(22,119,255,0.08)" : t.cardBg,
                    border: active
                      ? "1px solid #1677ff"
                      : `1px solid ${t.border}`,
                    opacity: it.answered_locally ? 0.55 : 1,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <antd.Tag color={meta.color} style={{ marginRight: 0 }}>
                      {tr(meta.label)}
                    </antd.Tag>
                    {it.task_title ? (
                      <span
                        style={{
                          fontSize: 12,
                          color: t.textSecondary,
                          flex: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {it.task_title}
                      </span>
                    ) : (
                      <span style={{ flex: 1 }} />
                    )}
                    {it.answered_locally ? (
                      <antd.Tag color="green" style={{ marginRight: 0 }}>
                        {tr("已回答")}
                      </antd.Tag>
                    ) : null}
                    {expired ? (
                      <antd.Tag color="default" style={{ marginRight: 0 }}>
                        {tr("已过期")}
                      </antd.Tag>
                    ) : null}
                  </div>
                  <div
                    style={{
                      fontSize: 13,
                      color: t.text,
                      marginTop: 4,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {it.question || it.task_id}
                  </div>
                  {it.requested_at ? (
                    <div style={{ fontSize: 11, color: t.textSecondary, marginTop: 2 }}>
                      {tr("请求时间")} {fmtTime(it.requested_at)}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>

        {/* 右：单条详情 */}
        <div
          style={{
            padding: 12,
            borderRadius: 8,
            background: t.cardBg,
            border: `1px solid ${t.border}`,
            display: "grid",
            gap: 10,
          }}
        >
          {!selected ? (
            <antd.Empty
              description={tr("暂无待决策")}
              image={antd.Empty.PRESENTED_IMAGE_SIMPLE}
            />
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <antd.Tag
                  color={(KIND_META[selected.kind] || KIND_META.other).color}
                  style={{ marginRight: 0 }}
                >
                  {tr((KIND_META[selected.kind] || KIND_META.other).label)}
                </antd.Tag>
                <span
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 12,
                    color: t.textSecondary,
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {selected.task_id}
                </span>
              </div>
              <div style={{ fontSize: 13, color: t.text, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                {selected.question}
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 8,
                  fontSize: 12,
                }}
              >
                {selected.task_title ? (
                  <Field k={tr("任务")} v={selected.task_title} />
                ) : null}
                {selected.task_status ? (
                  <Field
                    k={tr("状态")}
                    v={
                      <antd.Tag color={statusVariant(selected.task_status)}>
                        {selected.task_status}
                      </antd.Tag>
                    }
                  />
                ) : null}
                {selected.worker ? <Field k="Worker" v={selected.worker} /> : null}
                {selected.project_id ? (
                  <Field k={tr("项目")} v={selected.project_id} />
                ) : null}
                {selected.requested_at ? (
                  <Field k={tr("请求时间")} v={fmtTime(selected.requested_at)} />
                ) : null}
                {selected.expires_at ? (
                  <Field k={tr("期限")} v={fmtTime(selected.expires_at)} />
                ) : null}
              </div>
              <antd.Button
                type="primary"
                block
                onClick={() => onOpenItem(selected)}
              >
                {tr("回答")}
              </antd.Button>
            </>
          )}
        </div>
      </div>

      {/* 历史已回答（本地去重记录，answered_at 倒序） */}
      <div>
        <div
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: t.textSecondary,
            marginBottom: 6,
          }}
        >
          {tr("已回答历史")}
        </div>
        {history.length === 0 ? (
          <div style={{ fontSize: 12, color: t.textSecondary }}>
            {tr("暂无已回答记录")}
          </div>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {history.map((rec) => {
              const meta = KIND_META[rec.kind] || KIND_META.other;
              return (
                <div
                  key={rec.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 12px",
                    borderRadius: 8,
                    background: t.cardBg,
                    border: `1px solid ${t.border}`,
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    style={{
                      fontFamily: "ui-monospace, monospace",
                      fontSize: 12,
                      color: t.textSecondary,
                    }}
                  >
                    {fmtTime(rec.answered_at)}
                  </span>
                  <antd.Tag color={meta.color} style={{ marginRight: 0 }}>
                    {tr(meta.label)}
                  </antd.Tag>
                  <span
                    style={{
                      fontFamily: "ui-monospace, monospace",
                      fontSize: 12,
                      color: t.text,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: 260,
                    }}
                  >
                    {rec.task_id}
                  </span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 12, color: t.text }}>
                    {rec.answer}
                  </span>
                  {rec.basis ? (
                    <span
                      style={{
                        fontSize: 11,
                        color: t.textSecondary,
                        maxWidth: 320,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      basis: {rec.basis}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ k, v }: { k: string; v: ReactNS.ReactNode }) {
  const t = useThemeColors();
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, color: t.textSecondary }}>{k}</div>
      <div style={{ color: t.text, wordBreak: "break-all" }}>{v}</div>
    </div>
  );
}

function BoardHeader({
  tr,
  onRefresh,
  countText,
}: {
  tr: ReturnType<typeof useT>;
  onRefresh: () => void;
  countText: string | null;
}) {
  const t = useThemeColors();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
      }}
    >
      <span style={{ fontWeight: 700, fontSize: 15 }}>{tr("待决策")}</span>
      <WbTooltip
        title={tr(
          "需要人工决策的 attention 请求（读 controller 聚合；回答以当前登录身份发回任务房间）。",
        )}
      >
        <span style={{ color: t.textSecondary, cursor: "help", fontSize: 12 }}>
          ⓘ
        </span>
      </WbTooltip>
      {countText ? (
        <span style={{ fontSize: 11, color: t.textSecondary }}>{countText}</span>
      ) : null}
      <div style={{ flex: 1 }} />
      <WbTooltip title={tr("刷新")}>
        <antd.Button
          type="text"
          size="small"
          icon={<ReloadIcon />}
          onClick={onRefresh}
        />
      </WbTooltip>
    </div>
  );
}
