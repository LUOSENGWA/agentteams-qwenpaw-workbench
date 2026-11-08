// OpenClaw 运行时图标——OpenClaw 官方 favicon（红色龙虾渐变 svg，0 0 120 120 viewBox）。
// 资产在 assets/openclaw.svg（vite 直接 import）；props 对齐 icons.tsx IconProps（size/style/className）。

import type * as ReactNS from "react";
import OpenClawSvg from "../assets/openclaw.svg";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

export function OpenClawIcon({
  size = 13,
  style,
  className,
}: {
  size?: number;
  style?: ReactNS.CSSProperties;
  className?: string;
}) {
  return (
    <img
      src={OpenClawSvg}
      width={size}
      height={size}
      style={style}
      className={className}
      alt="OpenClaw"
    />
  );
}
