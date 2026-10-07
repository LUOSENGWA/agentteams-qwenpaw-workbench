/** WorkerRuntimeConfig 子组件——自 WorkerRuntimeConfig.tsx 纯移动拆出
 * （任务书 183 S3，行为零变化）。 */
import type * as ReactNS from "react";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

/** QwenPaw AgentLoopCard gate 卡（LockedGateCard 同款语义：Switch 启停 +
 * 点开参数区；未启用时收起无参数）。 */
function GateSection({
  title,
  tip,
  enabled,
  onEnabled,
  children,
}: {
  title: string;
  tip?: string;
  enabled: boolean;
  onEnabled?: (v: boolean) => void;
  children?: ReactNS.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <div style={{ border: "1px solid rgba(127,127,127,0.2)", borderRadius: 8, marginBottom: 8 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          cursor: enabled ? "pointer" : "default",
          background: "rgba(127,127,127,0.05)",
          borderRadius: 8,
        }}
        onClick={() => {
          if (enabled) setOpen((v) => !v);
        }}
      >
        <antd.Switch
          size="small"
          checked={enabled}
          onChange={(v: boolean) => onEnabled?.(v)}
          onClick={(_c: boolean, e: ReactNS.MouseEvent) => e.stopPropagation()}
        />
        <span style={{ fontWeight: 600, fontSize: 12.5 }}>{title}</span>
        {tip ? (
          <antd.Tooltip title={tip}>
            <span style={{ fontSize: 11, color: "rgba(127,127,127,0.55)", cursor: "help", lineHeight: 1 }}>ⓘ</span>
          </antd.Tooltip>
        ) : null}
        <div style={{ flex: 1 }} />
        {enabled ? (
          <span style={{ fontSize: 9, color: "rgba(0,0,0,0.45)" }}>{open ? "▲" : "▼"}</span>
        ) : (
          <span style={{ fontSize: 10.5, color: "rgba(0,0,0,0.35)" }}>off</span>
        )}
      </div>
      {enabled && open ? (
        <div style={{ padding: "8px 10px", display: "grid", gap: 6 }}>{children}</div>
      ) : null}
    </div>
  );
}

export default GateSection;
