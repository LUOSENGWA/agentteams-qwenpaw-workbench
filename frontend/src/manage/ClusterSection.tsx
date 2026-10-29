/**
 * ClusterSection.tsx — 「管理」页集群管理域（P6；原「运维」「审计」顶层 tab
 * 内容迁移，10/29 下线）。
 *
 * 栏职责（方案 §4.4）：
 * - mid:   集群概览（OpsOverview：集群状态/版本 + SGLang 负载——**不含运行时
 *          升级**，升级卡归 Worker 详情）+ 两张入口卡：日志 / 审计
 * - full:  clusterView==="logs" → OpsLogPane（组件日志，Controller Docker API
 *          代理）；"audit" → AuditLog（上游 GET /api/v1/audit）——二级页覆盖
 *          中+右两栏（左栏保留），左上「←」返回（ManagePage L2 分支），
 *          筛选保留（组件 / 全部·仅错误 / 时间范围 / 类型 / 团队）
 * - right: 概览态右栏引导（竖屏 1 栏下日志/审计直接铺满全屏二级页）
 *
 * 轮询门：OpsOverview/OpsLogPane/AuditLog 均走 active 显式 prop（与
 * RuntimeUpgradePanel P3 同款模式）——顶层 tab 下线后旧 useTabActive 门
 * 恒 false。竖屏下点日志/审计，中栏概览卸载 → 其轮询天然停（二级页
 * 重新挂载取数）；横屏 2/3 栏进二级页同理（full 替换中+右）。
 */
import type * as ReactNS from "react";

import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { OpsOverview, OpsLogPane } from "../components/OpsPanel";
import AuditLog from "../components/AuditLog";
import { MonitorIcon, NotesIcon } from "../components/icons";
import type { ManageSectionProps } from "./types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

export default function ClusterSection({ nav, data, variant }: ManageSectionProps) {
  const t = useThemeColors();
  const tr = useT();
  const view = nav.clusterView;

  // 二级页（日志/审计）——覆盖中+右两栏；左栏保留，「←」返回由
  // ManagePage L2 分支统一处理（onL2Back → setClusterView("overview")）。
  if (variant === "full") {
    if (view === "audit") return <AuditLog hasToken={!!data.hasToken} active />;
    return <OpsLogPane active />;
  }

  if (variant === "mid") {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        <OpsOverview active />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <button
            type="button"
            aria-label={tr("查看组件日志")}
            onClick={() => nav.setClusterView("logs")}
            style={{
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
            }}
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
            style={{
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
            }}
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
      </div>
    );
  }

  // right：概览态引导（竖屏无右栏——日志/审计直接全屏二级页）。
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
        {tr("选择 日志 / 审计")}
      </span>
      <span style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.7 }}>
        {tr("点中栏 组件日志 / 审计 卡片查看详情（二级页覆盖本栏）")}
      </span>
    </div>
  );
}
