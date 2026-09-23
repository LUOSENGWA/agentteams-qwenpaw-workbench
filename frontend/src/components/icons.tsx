// v0.5.0-beta.13.12（13.11 装验 F5）：tab/按钮 emoji → 语义 SVG。
// ① 拓扑按钮「🌳一棵树」→ DAG 拓扑图标（节点+连线，表「依赖拓扑」而非树）
// ② 团队管理 tab「👷工人」→ 两个简笔画小人部分重叠（表「团队/协作」）
// 纯内联 SVG（无 @ant-design/icons 依赖——插件不装该包），currentColor
// 随 label 文字色（tab 激活态自动变色），14×14 与 12px 文字基线对齐。

import type * as ReactNS from "react";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

interface IconProps {
  size?: number;
}

/** 拓扑（DAG）：1 根节点 → 2 子节点，连线 + 圆点（非层级树——
 *  子节点之间无连线，留「可汇合」语义）。 */
export function TopologyIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      style={{ verticalAlign: "-2px", flexShrink: 0 }}
      aria-hidden
    >
      <path
        d="M8 3.2 3.6 11M8 3.2 12.4 11"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="8" cy="2.6" r="1.9" fill="currentColor" />
      <circle cx="3.4" cy="12.2" r="1.9" fill="currentColor" />
      <circle cx="12.6" cy="12.2" r="1.9" fill="currentColor" />
    </svg>
  );
}

/** 团队（双人重叠）：左人实心 + 右人后移半透明重叠（"两人一组"）。 */
export function TeamIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      style={{ verticalAlign: "-2px", flexShrink: 0 }}
      aria-hidden
    >
      {/* 后侧人（右，半透明） */}
      <circle cx="10.6" cy="5" r="2.1" fill="currentColor" opacity="0.45" />
      <path
        d="M13.8 13.4c0-2.2-1.4-3.6-3.2-3.6-.5 0-1 .1-1.4.3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        opacity="0.45"
      />
      {/* 前侧人（左，实心） */}
      <circle cx="6" cy="5.4" r="2.5" fill="currentColor" />
      <path
        d="M2.2 13.8c0-2.7 1.7-4.4 3.8-4.4s3.8 1.7 3.8 4.4"
        fill="currentColor"
      />
    </svg>
  );
}
