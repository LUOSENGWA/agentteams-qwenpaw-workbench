/**
 * ClusterSection.tsx — 「管理」页集群管理域（原「运维」tab 内容迁移）。
 *
 * 栏职责（方案 §4.4）：
 * - mid:   集群概览（原 OpsPanel 概览：/api/v1/status、SGLang、容器、负载——
 *          **去掉运行时升级**，升级卡归 Worker 详情）
 * - full:  clusterView==="logs" → 组件日志（原 OpsPanel 日志区，Controller
 *          Docker API 代理）；"audit" → 审计（AuditLog，上游 GET /api/v1/audit）
 *          ——二级页覆盖中+右两栏（左栏保留），左上「←」返回，筛选保留
 * - right: 概览态右栏引导（「点中栏 日志/审计 查看详情」）
 *
 * P0 骨架：占位（验证布局）；P6 落概览拆分 + 日志/审计二级页
 *（注意：OpsPanel/AuditLog/RuntimeUpgradePanel/CodingRunsPanel 的
 * useTabActive("ops") 轮询门在 P6 随迁移改接管理页激活门控）。
 */
import type * as ReactNS from "react";

import { useThemeColors } from "../theme";
import type { ManageSectionProps } from "./types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

export default function ClusterSection({ nav, cols, data, variant }: ManageSectionProps) {
  const t = useThemeColors();
  const label =
    variant === "mid"
      ? "集群概览"
      : variant === "full"
        ? nav.clusterView === "audit"
          ? "审计"
          : "日志"
        : "选择 日志 / 审计";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 4 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: t.text }}>{label}</div>
      <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.8 }}>
        {`栏数 ${cols} · Worker ${data.admin?.workers.length ?? 0} 个`}
      </div>
    </div>
  );
}
