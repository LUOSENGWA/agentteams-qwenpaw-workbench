// v0.5.0-beta.12.4（A17）：Worker session 运行指示圆点。
//
// 视觉照搬 QwenPaw console AgentStatusIndicator（实读）：8px 圆点 +
// statusPulse 1.2s 呼吸（opacity 1↔0.35 + box-shadow 扩散）+ Tooltip +
// prefers-reduced-motion 降级关动画。色板按罗总定案：
//   蓝 #3b82f6 = 运行中（呼吸）/ 绿 #52c41a = 运行完成（常亮）/ 灰 = 无任务（常亮）
// 呼吸动画走 CSS class（wb-session-dot.running）而非内联 animation——
// 内联样式无法被 @media (prefers-reduced-motion) 覆盖，class 可以。

import type * as ReactNS from "react";

import type { WorkerSessionState } from "../workerSessionState";
import { useT } from "../i18n";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

const STATE_COLOR: Record<WorkerSessionState, string> = {
  running: "#3b82f6",
  done: "#52c41a",
  idle: "#c0c4cc",
};

const STATE_TEXT: Record<WorkerSessionState, string> = {
  running: "运行中",
  done: "运行完成",
  idle: "无任务",
};

export default function WorkerSessionDot({
  state,
  size = 8,
}: {
  state: WorkerSessionState;
  size?: number;
}) {
  const tr = useT();
  // key={state} 强制重挂载：状态切换时 Tooltip 重新定位/刷新文案。
  return (
    <antd.Tooltip key={state} title={tr(STATE_TEXT[state])}>
      <span
        className={state === "running" ? "wb-session-dot running" : "wb-session-dot"}
        style={{
          display: "inline-block",
          width: size,
          height: size,
          borderRadius: "50%",
          background: STATE_COLOR[state],
          flexShrink: 0,
          marginLeft: 6,
          verticalAlign: "middle",
        }}
      />
    </antd.Tooltip>
  );
}
