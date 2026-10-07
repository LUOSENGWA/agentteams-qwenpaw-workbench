/** WorkerRuntimeConfig 子组件——自 WorkerRuntimeConfig.tsx 纯移动拆出
 * （任务书 183 S3，行为零变化）。 */
import type * as ReactNS from "react";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

/** QwenPaw console Form.Item 行等价物（label + ⓘ tooltip 左 / 控件右，
 * 垂直堆叠行——Agent Config 页的呈现语言）。 */
function CfgRow({
  label,
  tip,
  children,
}: {
  label: string;
  tip?: string;
  children: ReactNS.ReactNode;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "150px 1fr",
        gap: 10,
        alignItems: "center",
        padding: "7px 0",
        borderBottom: "1px solid rgba(127,127,127,0.12)",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          fontSize: 13,
          color: "rgba(127,127,127,0.95)",
        }}
      >
        {label}
        {tip ? (
          <antd.Tooltip title={tip}>
            <span
              style={{
                fontSize: 11,
                color: "rgba(127,127,127,0.55)",
                cursor: "help",
                lineHeight: 1,
              }}
            >
              ⓘ
            </span>
          </antd.Tooltip>
        ) : null}
      </span>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

export default CfgRow;
