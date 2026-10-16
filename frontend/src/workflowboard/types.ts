// WorkflowBoard 巨石拆分 · 纯叶子共享层：类型（WfView / WorkflowBoardProps）。
// 逐字自 components/WorkflowBoard.tsx 搬移（仅加 `export`）。

import type { WorkflowEvent } from "../api";

export interface WorkflowBoardProps {
  events: WorkflowEvent[]; // 由父组件通过 api.ts fetchWorkflowEvents 获取
  loading?: boolean;
  onRefresh?: () => void;
  /** 聊天 workflow 卡片点击跳转：高亮/滚动到该项目。 */
  highlightRunId?: string;
  /** 正源状态——rooms=已降级到「只扫已加入房间」。 */
  source?: "controller" | "rooms";
  failReason?: "auth" | "not_deployed" | "error";
  /** error 分支的真实上游错误（如 Controller 500 的 mc 报错）。 */
  failDetail?: string;
  /** 视图 tab 受控（父组件记忆到大 tab 同款 ui-state）。 */
  view?: WfView;
  onViewChange?: (v: WfView) => void;
  /** 拓扑视图选中的 runId 受控（父组件记忆）。 */
  topoRun?: string;
  onTopoRunChange?: (runId: string) => void;
}

/** ：13.21 曾加第 5 项「mermaid」独立
 * 视图——与拓扑依赖图同结构（并入拓扑：「不需要新开第 5 项，把
 * 拓扑的依赖图优化就好」）→ mermaid 退役为拓扑视图内的图样式切换。 */
export type WfView = "list" | "card" | "board" | "topo";
