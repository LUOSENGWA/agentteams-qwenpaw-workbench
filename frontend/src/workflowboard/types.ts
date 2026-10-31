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
  /** P0 人工介入闭环：干预操作「去房间」深链（父组件=聊天 tab 开房间）。 */
  onGotoRoom?: (roomId: string, eventId?: string) => void;
}

/** 10/26：工作流只留看板/拓扑两视图——list/card 退役；
 * 旧持久化值（list/card/mermaid）由 WorkbenchPageUi 的 wfMem 初始化
 * 兼容回退（list/card→board，mermaid→topo）。 */
export type WfView = "board" | "topo";
