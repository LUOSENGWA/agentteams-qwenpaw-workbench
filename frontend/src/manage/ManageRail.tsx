/**
 * ManageRail.tsx — 「管理」页左栏四域导航（L0）。
 *
 * 四域（现有 icons 图标）：团队管理 / CRD 管理 / 人员管理 / 集群管理。
 * 呈现（ManagePage 决定）：wide 内联 200 栏 / 四栏恒内联 160（收起 56
 * icon-only，collapsed=true，16.30）/ medium·narrow 抽屉覆盖。
 * 行高 ≥44 触控命中（.wb-touch 全局档只管 antd 控件，自写 button 在此自保）；
 * hover 高亮走 t.hoverBg（鼠标增强，触屏不依赖）。
 */
import type * as ReactNS from "react";

import { PRIMARY } from "../WorkbenchPageShared";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { NotesIcon, TeamIcon, UsersIcon, WrenchIcon } from "../components/icons";
import type { ManageSection } from "./useManageNav";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

const RAIL_ITEMS: {
  key: ManageSection;
  label: string;
  Icon: ReactNS.ComponentType<{
    size?: number;
    style?: ReactNS.CSSProperties;
    className?: string;
  }>;
}[] = [
  { key: "team", label: "团队管理", Icon: TeamIcon },
  { key: "crd", label: "CRD 管理", Icon: NotesIcon },
  { key: "people", label: "人员管理", Icon: UsersIcon },
  { key: "cluster", label: "集群管理", Icon: WrenchIcon },
];

export default function ManageRail({
  section,
  onSelect,
  collapsed = false,
}: {
  section: ManageSection;
  onSelect: (s: ManageSection) => void;
  /** 四栏收起态（16.30）：icon-only，按钮居中（56px 栏），
   * title/aria-label 承载标签；非收起态行为完全不变。 */
  collapsed?: boolean;
}) {
  const t = useThemeColors();
  const tr = useT();
  return (
    <nav
      aria-label={tr("管理导航")}
      style={{ display: "flex", flexDirection: "column", gap: 4, width: "100%" }}
    >
      {RAIL_ITEMS.map(({ key, label, Icon }) => {
        const active = section === key;
        return (
          <button
            key={key}
            type="button"
            aria-current={active ? "page" : undefined}
            title={collapsed ? tr(label) : undefined}
            aria-label={collapsed ? tr(label) : undefined}
            onClick={() => onSelect(key)}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: collapsed ? "center" : undefined,
              gap: 10,
              minHeight: 44,
              padding: collapsed ? 0 : "0 12px",
              border: "none",
              borderRadius: 8,
              cursor: "pointer",
              width: "100%",
              textAlign: "left",
              fontSize: 13.5,
              fontWeight: active ? 700 : 400,
              color: active ? PRIMARY : t.textSecondary,
              background: active ? t.accentBg : "transparent",
            }}
            onMouseEnter={(e) => {
              if (!active) e.currentTarget.style.background = t.hoverBg;
            }}
            onMouseLeave={(e) => {
              if (!active) e.currentTarget.style.background = "transparent";
            }}
          >
            <Icon size={16} />
            {!collapsed ? tr(label) : null}
          </button>
        );
      })}
    </nav>
  );
}
