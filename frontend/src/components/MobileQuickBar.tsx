// MobileQuickBar.tsx — ≤600px 底部固定快捷条（R2）。
//
// 四项固定 文件/工作流/消息/设置（tab key 与 WorkbenchPage 顶层一致），
// 44px 高 + safe-area 内边距；桌面（宽 >600px）不渲染。父级按
// useQuickBarVisible 给内容区补底部内边距，避免遮住最后一行。

import type * as ReactNS from "react";
import { BoxIcon, MessageIcon, SettingsIcon, TopologyIcon } from "./icons";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";
import { QUICK_BAR_ITEMS, shouldShowQuickBar } from "../lib/mobileQuickBar";

const host = window.QwenPaw.host;
const React = host.React;

const ICONS: Record<string, ReactNS.ComponentType<{ size?: number }>> = {
  artifacts: BoxIcon,
  workflow: TopologyIcon,
  chat: MessageIcon,
  settings: SettingsIcon,
};

export function useQuickBarVisible(): boolean {
  const [visible, setVisible] = React.useState<boolean>(() =>
    shouldShowQuickBar(
      typeof window !== "undefined" ? window.innerWidth : 1024,
    ),
  );
  React.useEffect(() => {
    const onResize = () => setVisible(shouldShowQuickBar(window.innerWidth));
    window.addEventListener("resize", onResize);
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return visible;
}

export function MobileQuickBar(props: {
  visible: boolean;
  tab: string;
  onSelect: (key: string) => void;
}) {
  const tr = useT();
  const t = useThemeColors();
  const { visible, tab, onSelect } = props;
  if (!visible) return null;
  return (
    <nav
      aria-label={tr("移动端快捷入口")}
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 900,
        display: "flex",
        height: 44,
        boxSizing: "content-box",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
        background: t.bg,
        borderTop: `1px solid ${t.border}`,
      }}
    >
      {QUICK_BAR_ITEMS.map((item) => {
        const Icon = ICONS[item.key];
        const active = tab === item.key;
        return (
          <button
            key={item.key}
            type="button"
            data-quickbar={item.key}
            onClick={() => onSelect(item.key)}
            style={{
              flex: 1,
              border: "none",
              background: "transparent",
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 1,
              fontSize: 10.5,
              lineHeight: 1.1,
              color: active ? "var(--app-accent, #FF7F16)" : t.textSecondary,
              fontWeight: active ? 700 : 400,
            }}
          >
            {Icon ? <Icon size={17} /> : null}
            <span>{tr(item.label)}</span>
          </button>
        );
      })}
    </nav>
  );
}
