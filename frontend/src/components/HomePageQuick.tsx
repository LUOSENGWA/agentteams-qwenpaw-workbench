/** HomePage 子模块——自 HomePage.tsx 纯搬移拆出
 * （行为零变化）。 */
import type * as ReactNS from "react";
import { useThemeColors } from "../theme";
import { CARD_RADIUS } from "./HomePageShared";

const host = window.QwenPaw.host;
const React = host.React;

  // 快捷操作（文字+emoji，零 antdIcons 依赖）。
  // 快捷操作卡配色——accent 品牌浅底，底/边/字从主色派生
  // （原 #FFF3E8/#FFD9B3/#c2410c/#9a3412 是 accent 的固定橙衍生，
  // 宿主换主色时这层不跟）。color-mix 保证任意主色下派生。
  // 深色模式：浅底白 mix 在暗页=亮斑 →
  // 改 accent 对透明混色（黑底透出）+ 标签用亮向 accent（暗底可读）。
export function QuickBtn({
  icon,
  label,
  desc,
  onClick,
}: {
  icon: ReactNS.ReactNode;
  label: string;
  desc: string;
  onClick: () => void;
}): ReactNS.ReactElement {
  const t = useThemeColors();
  const dark = t.mode === "dark";
  const quickCard = {
    background: dark
      ? "color-mix(in srgb, var(--app-accent, #FF7F16) 13%, transparent)"
      : "color-mix(in srgb, var(--app-accent, #FF7F16) 10%, white)",
    border: `1px solid ${
      dark
        ? "color-mix(in srgb, var(--app-accent, #FF7F16) 32%, transparent)"
        : "color-mix(in srgb, var(--app-accent, #FF7F16) 28%, white)"
    }`,
  };
  return (
    <div
      onClick={onClick}
      style={{
        flex: 1,
        // border-box：content-box 时 min-width 140 + padding 28 + border 2
        // = 最小盒 170，窄屏 2 列 grid 的 1fr 轨被 item min 撑开整体溢出。
        boxSizing: "border-box",
        minWidth: 140,
        cursor: "pointer",
        borderRadius: CARD_RADIUS,
        ...quickCard,
        padding: "12px 14px",
        transition: "box-shadow .2s",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow =
          "0 2px 8px color-mix(in srgb, var(--app-accent, #FF7F16) 25%, transparent)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow = "none";
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: 24,
          // 图标=主色（浅色档用深向 accent 保对比；深色档用亮向=主色提亮）
          color: dark
            ? "color-mix(in srgb, var(--app-accent, #FF7F16) 70%, white)"
            : "var(--app-accent, #c2410c)",
        }}
      >
        {icon}
      </div>
      <div
        style={{
          fontSize: 13,
          fontWeight: 700,
          // 深色档：accent 70%+white=亮向主色（暗底可读）；浅色档原样
          color: dark
            ? "color-mix(in srgb, var(--app-accent, #FF7F16) 70%, white)"
            : "var(--app-accent, #c2410c)",
          marginTop: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 10.5,
          // 描述色：浅色档=主色 70% + 深棕（任意主色下足够深可读）；
          // 深色档=次级文字 token（t.textSecondary，暗页标准灰）
          color: dark ? t.textSecondary : "color-mix(in srgb, var(--app-accent, #9a3412) 70%, #3a2410)",
          marginTop: 2,
        }}
      >
        {desc}
      </div>
    </div>
  );
}
