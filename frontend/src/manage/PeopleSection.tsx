/**
 * PeopleSection.tsx — 「管理」页人员管理域。
 *
 * 栏职责（方案 §4.3）：
 * - mid:   人员列表（搜索：名字/MXID；行 = 头像+名字+可访问团队数）
 * - right: 选中人员 → 团队访问配置（弹窗：CrdAccessMatrix 列表+搜索+多选团队）
 *          / 权限设置（原 CrdPermModal；L2 隐藏权限入口）
 * - full:  本域不用
 *
 * P0 骨架：占位（验证布局/数据链路）；P5 落人员列表 + 两弹窗入口。
 */
import type * as ReactNS from "react";

import { useThemeColors } from "../theme";
import type { ManageSectionProps } from "./types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

export default function PeopleSection({ nav, cols, data, variant }: ManageSectionProps) {
  const t = useThemeColors();
  const label =
    variant === "mid"
      ? "人员列表"
      : variant === "right"
        ? nav.selectedHuman
          ? `${nav.selectedHuman} · ${
              nav.peopleView === "perm" ? "权限设置" : "团队访问配置"
            }`
          : "选择人员"
        : "人员管理";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 4 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: t.text }}>{label}</div>
      <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.8 }}>
        {`栏数 ${cols} · 人员 ${data.admin?.humans.length ?? 0} 个`}
      </div>
    </div>
  );
}
