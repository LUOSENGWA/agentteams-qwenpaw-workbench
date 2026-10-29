/**
 * CrdSection.tsx — 「管理」页 CRD 管理域。
 *
 * 栏职责（方案 §4.2）：
 * - mid:   三个入口卡（员工入职 Human CRD / 创建团队 Team CRD / 新建 Worker）
 * - right: crdView 对应的原 CRD 卡片/表单（CrdHumanTableCard+CrdHumanForm /
 *          CrdTeamTableCard+CrdTeamForm / CrdWorkerForm；保留导出 JSON）
 * - full:  本域不用
 *
 * P0 骨架：占位（验证布局/数据链路）；P4 落三入口 + 原表单迁移。
 */
import type * as ReactNS from "react";

import { useThemeColors } from "../theme";
import type { ManageSectionProps } from "./types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

const CRD_ENTRY_LABEL: Record<string, string> = {
  human: "员工入职（Human CRD）",
  team: "创建团队（Team CRD）",
  worker: "新建 Worker",
};

export default function CrdSection({ nav, cols, data, variant }: ManageSectionProps) {
  const t = useThemeColors();
  const label =
    variant === "mid"
      ? "CRD 入口"
      : variant === "right"
        ? nav.crdView !== "list"
          ? CRD_ENTRY_LABEL[nav.crdView] ?? "CRD"
          : "选择入口"
        : "CRD 管理";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 4 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: t.text }}>{label}</div>
      <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.8 }}>
        {`栏数 ${cols} · 团队 ${data.admin?.teams.length ?? 0} 个 · 人员 ${
          data.admin?.humans.length ?? 0
        } 个`}
      </div>
    </div>
  );
}
