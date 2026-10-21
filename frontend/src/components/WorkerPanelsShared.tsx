// Worker 抽屉折叠段卡片共享壳（域：面板壳视觉家族）。
// 「环境变量与网关探测」卡（WorkerEnvPanel）与「Coding CLI」卡
// （WorkerCodingCliPanel）为同款视觉家族（折叠态 ▸ 单行 / 展开态 ▾ 头行
// + 内容，margin/border/radius 同族且 sheet-aware，展开头行 gap 6 与
// 折叠态对齐防图标 x 漂移），抽此收敛，防两卡样式漂移。
// 消费方传 icon/title（各自 tr）/titleExtra/headerExtra slot/children；
// 共享壳零业务逻辑，slot 内容渲染输出与各自原实现逐字节一致。
import type * as ReactNS from "react";
import { useT } from "../i18n";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

export function WorkerCollapseCard({
  open,
  sheet,
  icon,
  title,
  titleExtra,
  headerExtra,
  onExpand,
  onCollapse,
  children,
}: {
  open: boolean;
  sheet?: boolean;
  icon: ReactNS.ReactNode;
  /** 段标题（消费方已 tr 的字符串）。 */
  title: string;
  /** 折叠态头部附加（如计数 Tag）。 */
  titleExtra?: ReactNS.ReactNode;
  /** 展开态头行右侧附加（按钮等）。 */
  headerExtra?: ReactNS.ReactNode;
  onExpand: () => void;
  onCollapse: () => void;
  children?: ReactNS.ReactNode;
}) {
  const tr = useT();

  if (!open) {
    return (
      <div
        style={{
          margin: sheet ? 0 : "4px 0 4px 22px",
          border: sheet ? "none" : "1px solid rgba(127,127,127,0.25)",
          borderRadius: sheet ? 0 : 8,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 10px",
            cursor: "pointer",
          }}
          onClick={onExpand}
        >
          <span style={{ width: 12, fontSize: 10, color: "#888" }}>▸</span>
          {icon}
          <span style={{ fontWeight: 600, fontSize: 12 }}>{title}</span>
          {titleExtra}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        margin: sheet ? 0 : "4px 0 4px 22px",
        border: sheet ? "none" : "1px solid rgba(127,127,127,0.25)",
        borderRadius: sheet ? 0 : 8,
        padding: sheet ? 0 : 10,
        display: "grid",
        gap: 8,
      }}
    >
      {/* gap 6 = 折叠态同款（段头对齐：折叠/展开两态图标 x 不漂移）。 */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {sheet ? null : (
          <span
            style={{ width: 12, fontSize: 10, color: "#888", cursor: "pointer" }}
            onClick={onCollapse}
            title={tr("收起")}
          >
            ▾
          </span>
        )}
        {sheet ? null : icon}
        {/* 段头标题字号恒 12（折叠/展开一致，与运行配置/资源管理段头同款）。 */}
        {sheet ? null : <span style={{ fontWeight: 600, fontSize: 12 }}>{title}</span>}
        {headerExtra}
      </div>
      {children}
    </div>
  );
}
