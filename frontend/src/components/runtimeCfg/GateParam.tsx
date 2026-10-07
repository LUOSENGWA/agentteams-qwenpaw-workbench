/** WorkerRuntimeConfig 子组件——自 WorkerRuntimeConfig.tsx 纯移动拆出
 * （任务书 183 S3，行为零变化）。 */
import type * as ReactNS from "react";

const host = window.QwenPaw.host;
const React = host.React;

/** 参数行（gate 卡内：label 左 / 控件右，紧凑）。 */
function GateParam({
  label,
  children,
}: {
  label: string;
  children: ReactNS.ReactNode;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 8, alignItems: "center" }}>
      <span style={{ fontSize: 11.5, color: "rgba(127,127,127,0.95)" }}>{label}</span>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

export default GateParam;
