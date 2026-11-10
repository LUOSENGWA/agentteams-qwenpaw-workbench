// 团队拓扑中栏的「千锻」入口卡（2026-11-07）——整卡即按钮：原 antd.Card
// + 内嵌「打开千锻注入」按钮合并为单个 <button>，右侧 › 提示进入
// 「注入 / 自定义团队 / 模块更新 / 注入历史」四 tab 弹窗。
import type * as ReactNS from "react";

import type { ThemeColors } from "../theme";
import type { TrFn } from "../crdmanage/types";
import MillforgeLogo from "../assets/millforge-logo.svg?inline";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

interface Props {
  t: ThemeColors;
  tr: TrFn;
  /** 不可用原因（空串/未传 = 可用）；有值时 disabled 且作 title。 */
  disabledReason?: string;
  onClick: () => void;
}

export default function MillforgeEntryCard({ t, tr, disabledReason, onClick }: Props) {
  const disabled = !!disabledReason;
  return (
    <button
      type="button"
      disabled={disabled}
      title={disabledReason || undefined}
      aria-label={tr("千锻")}
      onClick={onClick}
      style={{
        width: "100%",
        minHeight: 56,
        padding: "10px 12px",
        border: `1px solid ${t.border}`,
        borderRadius: 10,
        background: t.cardBg,
        display: "flex",
        alignItems: "center",
        gap: 10,
        textAlign: "left",
        cursor: disabled ? "not-allowed" : "pointer",
        color: "inherit",
        transition: "background .15s",
        opacity: disabled ? 0.6 : 1,
      }}
      onMouseEnter={(e: ReactNS.MouseEvent<HTMLButtonElement>) => {
        if (!disabled) e.currentTarget.style.background = t.hoverBg;
      }}
      onMouseLeave={(e: ReactNS.MouseEvent<HTMLButtonElement>) => {
        e.currentTarget.style.background = t.cardBg;
      }}
      onFocus={(e: ReactNS.FocusEvent<HTMLButtonElement>) => {
        e.currentTarget.style.outline = "2px solid var(--app-accent, #FF7F16)";
        e.currentTarget.style.outlineOffset = "2px";
      }}
      onBlur={(e: ReactNS.FocusEvent<HTMLButtonElement>) => {
        e.currentTarget.style.outline = "none";
        e.currentTarget.style.outlineOffset = "";
      }}
    >
      <img
        src={MillforgeLogo}
        alt=""
        style={{
          height: 30,
          width: "auto",
          maxWidth: 56,
          display: "block",
          flex: "none",
        }}
      />
      <span style={{ minWidth: 0, flex: 1, display: "grid", gap: 2 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: t.text }}>{tr("千锻")}</span>
        <span style={{ fontSize: 11, color: t.textSecondary }}>
          {tr("注入 / 模块更新 / 历史")}
        </span>
      </span>
      <span aria-hidden style={{ fontSize: 18, color: t.textSecondary, flex: "none" }}>
        ›
      </span>
    </button>
  );
}
