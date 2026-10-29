/**
 * TeamSection.tsx — 「管理」页团队管理域。
 *
 * 栏职责（方案 §4.1）：
 * - mid:   teamView==="list" → 团队列表（搜索人/团队、按人排序、未分组置底）；
 *          否则 → 团队拓扑（名字+头像+状态灯 + 团队设置齿轮 + 千锻注入卡）
 * - right: teamView==="worker" → Worker 详情（头部+状态卡+资源卡）；
 *          teamView==="settings" → 团队设置（CrdCfgModal 内容内联）；
 *          列表态右栏留空（用户明确要求）
 * - full:  团队域不用（集群域专属覆盖栏）
 *
 * P0 骨架：占位（验证布局/数据链路）；P1 落列表+拓扑，P2/P3 落 Worker 详情+团队设置。
 */
import type * as ReactNS from "react";

import { useThemeColors } from "../theme";
import type { ManageSectionProps } from "./types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

export default function TeamSection({ nav, cols, data, variant }: ManageSectionProps) {
  const t = useThemeColors();
  // 团队列表态右栏留空（用户明确要求——不显引导）。
  if (variant === "right" && nav.teamView === "list") return null;
  const label =
    variant === "mid"
      ? nav.teamView === "list"
        ? "团队列表"
        : "团队拓扑"
      : variant === "right"
        ? nav.teamView === "worker"
          ? "Worker 详情"
          : nav.teamView === "settings"
            ? "团队设置"
            : "选择 Worker / 团队"
        : "团队管理";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 4 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: t.text }}>{label}</div>
      <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.8 }}>
        {`栏数 ${cols} · 团队 ${data.teams.length} 个`}
        {data.admin ? ` · Worker ${data.admin.workers.length} 个` : " · 管理数据未接入"}
      </div>
    </div>
  );
}
