/**
 * ClusterSection.tsx — 「管理」页集群管理域（P6；原「运维」「审计」顶层 tab
 * 内容迁移，10/29 下线；15.36 C：详情统一归 right/mid 栏 + 新增
 * 「运行时批量升级」入口）。
 *
 * 栏职责（15.36 C 起；A 段「详情覆盖中+右」模型废弃）：
 * - l1（四栏 L1 列）/ mid（2/3 栏）：集群概览（OpsOverview：集群状态/版本 +
 *   SGLang 负载）+ 三张入口卡：日志 / 审计 / 运行时批量升级（点卡
 *   setClusterView，详情渲染在 right 栏（2/3 栏）或 mid 栏（四栏））
 * - mid（四栏）：详情态渲染详情；概览态引导
 * - right（2/3 栏）：按 clusterView 渲染详情 / 概览态引导
 * - right（四栏）：无更深一层引导（详情在中栏）
 * - full：仅 narrow（1 栏）L2 二级页全屏渲染（ManagePage L2 分支，左上
 *   「←」返回，筛选保留）
 *
 * 轮询门：OpsOverview/OpsLogPane/AuditLog/RuntimeUpgradePanel 均走
 * active 显式 prop（与 RuntimeUpgradePanel P3 同款模式）——顶层 tab 下线
 * 后旧 useTabActive 门恒 false。概览态切走/卸载 → 其轮询天然停。
 */
import type * as ReactNS from "react";

import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { OpsOverview, OpsLogPane } from "../components/OpsPanel";
import AuditLog from "../components/AuditLog";
import RuntimeUpgradePanel from "../components/RuntimeUpgradePanel";
import { MonitorIcon, NotesIcon, RefreshIcon } from "../components/icons";
import type { ManageSectionProps } from "./types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

/** 入口卡按钮样式（日志/审计/批量升级共用；≥44px 命中区）。 */
function cardStyle(t: ReturnType<typeof useThemeColors>): ReactNS.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 10,
    minHeight: 44,
    padding: "10px 12px",
    borderRadius: 8,
    border: `1px solid ${t.border}`,
    background: t.cardBg,
    color: t.text,
    cursor: "pointer",
    textAlign: "left",
    width: "100%",
  };
}

export default function ClusterSection({ nav, cols, data, variant }: ManageSectionProps) {
  const t = useThemeColors();
  const tr = useT();
  const view = nav.clusterView;
  const isDetail = view === "logs" || view === "audit" || view === "upgrade";

  // 详情内容（2/3 栏 right / 四栏 mid / narrow full 共用；
  // 无 workerName = 批量模式 BatchBody；轮询门走 active）。
  const renderDetail = () => {
    if (view === "upgrade") return <RuntimeUpgradePanel active />;
    if (view === "audit") return <AuditLog hasToken={!!data.hasToken} active />;
    return <OpsLogPane active />;
  };

  // 概览 + 三张入口卡（2/3 栏 mid；四栏 L1 列）。
  const renderOverviewCards = () => (
    <div style={{ display: "grid", gap: 12 }}>
      <OpsOverview active />
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 8 }}>
        <button
          type="button"
          aria-label={tr("查看组件日志")}
          onClick={() => nav.setClusterView("logs")}
          style={cardStyle(t)}
        >
          <MonitorIcon size={16} style={{ flexShrink: 0, color: t.textSecondary }} />
          <span style={{ minWidth: 0, flex: 1 }}>
            <span style={{ display: "block", fontSize: 13, fontWeight: 600 }}>
              {tr("组件日志")}
            </span>
            <span
              style={{
                display: "block",
                fontSize: 11,
                color: t.textSecondary,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {tr("Controller 容器日志（Docker API 代理）")}
            </span>
          </span>
          <span style={{ fontSize: 14, color: t.textSecondary }}>›</span>
        </button>
        <button
          type="button"
          aria-label={tr("查看审计")}
          onClick={() => nav.setClusterView("audit")}
          style={cardStyle(t)}
        >
          <NotesIcon size={16} style={{ flexShrink: 0, color: t.textSecondary }} />
          <span style={{ minWidth: 0, flex: 1 }}>
            <span style={{ display: "block", fontSize: 13, fontWeight: 600 }}>
              {tr("审计")}
            </span>
            <span
              style={{
                display: "block",
                fontSize: 11,
                color: t.textSecondary,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {tr("Controller 操作审计（GET /api/v1/audit）")}
            </span>
          </span>
          <span style={{ fontSize: 14, color: t.textSecondary }}>›</span>
        </button>
      </div>
      <button
        type="button"
        aria-label={tr("查看运行时批量升级")}
        onClick={() => nav.setClusterView("upgrade")}
        style={cardStyle(t)}
      >
        <RefreshIcon
          size={16}
          style={{ flexShrink: 0, color: t.textSecondary }}
        />
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ display: "block", fontSize: 13, fontWeight: 600 }}>
            {tr("运行时批量升级")}
          </span>
          <span
            style={{
              display: "block",
              fontSize: 11,
              color: t.textSecondary,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {tr("多选 Worker 批量就地升级 qwenpaw 运行时（L1 · 二次确认）")}
          </span>
        </span>
        <span style={{ fontSize: 14, color: t.textSecondary }}>›</span>
      </button>
    </div>
  );

  // 概览态引导（竖屏无详情栏——直接全屏二级页；其余栏位详情在另一栏）。
  const renderGuide = (hint: string) => (
    <div
      style={{
        display: "grid",
        gap: 8,
        placeItems: "center",
        textAlign: "center",
        padding: 16,
      }}
    >
      <MonitorIcon size={20} style={{ color: t.textSecondary }} />
      <span style={{ fontSize: 13, fontWeight: 600, color: t.text }}>
        {tr("选择 日志 / 审计 / 批量升级")}
      </span>
      <span style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.7 }}>
        {hint}
      </span>
    </div>
  );

  // full：仅 narrow（1 栏）L2 二级页（横屏详情已归 right/mid 栏）。
  if (variant === "full") {
    if (view === "overview") return renderOverviewCards();
    return renderDetail();
  }

  // l1（四栏）与 2/3 栏 mid：概览 + 入口卡。
  if (variant === "l1") return renderOverviewCards();
  if (variant === "mid") {
    if (cols === 4) {
      // 四栏 mid：详情态渲染详情；概览态引导（入口卡在 L1 列）。
      return isDetail
        ? renderDetail()
        : renderGuide(tr("点左栏 组件日志 / 审计 / 批量升级 卡片查看详情"));
    }
    return renderOverviewCards();
  }

  // right：2/3 栏按 clusterView 渲染详情/引导；四栏无更深一层。
  if (cols === 4) {
    return (
      <div
        style={{
          display: "grid",
          gap: 8,
          placeItems: "center",
          textAlign: "center",
          padding: 16,
        }}
      >
        <MonitorIcon size={20} style={{ color: t.textSecondary }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: t.text }}>
          {tr("无更深一层")}
        </span>
        <span style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.7 }}>
          {tr("集群详情在中栏（日志 / 审计 / 批量升级）")}
        </span>
      </div>
    );
  }
  return isDetail
    ? renderDetail()
    : renderGuide(tr("点中栏 组件日志 / 审计 / 批量升级 卡片查看详情（详情在右栏）"));
}
