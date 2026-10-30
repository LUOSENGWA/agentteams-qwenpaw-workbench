// HelpDot — 自绘 ? 帮助图标（15.36 D）：WbTooltip 悬停显完整说明。
// host.antdIcons 里 QuestionCircleOutlined 零先例（存在性未验证）——不赌，
// 自绘 16px 圆圈「?」；样式走 useThemeColors（禁硬编码色）。
// 统一替代「说明塞进 Select 选项 label」的旧模式：label 精简，说明进 tooltip。
import type * as ReactNS from "react";

import { useThemeColors } from "../theme";
import { WbTooltip } from "./WbTooltip";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

export default function HelpDot({ title }: { title: string }) {
  const t = useThemeColors();
  return (
    <WbTooltip title={title}>
      <span
        role="img"
        aria-label={title}
        style={{
          width: 16,
          height: 16,
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          border: `1px solid ${t.textSecondary}`,
          borderRadius: "50%",
          color: t.textSecondary,
          fontSize: 11,
          lineHeight: 1,
          cursor: "help",
        }}
      >
        ?
      </span>
    </WbTooltip>
  );
}
