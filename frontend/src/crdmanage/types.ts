// CrdManage 拆分（QC-196 方案 §5.2）· 纯叶子共享层：类型与常量。
// 逐字自 components/CrdManage.tsx 搬移（仅加 `export`；表单/状态内联类型
// 提升为具名 interface——纯类型层，运行时零变化）。

import type { AdminData } from "../api";
import type { LlmTuningRecord } from "../lib/llm-tuning";

/** 翻译函数（useT() 返回签名）。 */
export type TrFn = (s: string, vars?: Record<string, string | number>) => string;

export interface CrdManageProps {
  /** 管理数据（humans/teams/workers）——与 WorkerManage 底部三表同一数据源。 */
  admin: AdminData;
  /** 写操作成功后静默刷新管理数据。 */
  onRefresh?: (silent?: boolean) => void;
  /** L1 走 controller_token（无 admin 账号密码 → 无 Higress Console 会话
 * → 网关 alias 层不可见）——为 true 且网关拉取完成仍无会话时显示提示。 */
  l1TokenMode?: boolean;
  /** 注册式 handle——拓扑 TeamNode「N人」右侧齿轮要
 * 打开本组件的「配置团队」弹窗（与团队表「配置」按钮同一入口）。
 * 用注册回调而非 forwardRef：本组件 2200+ 行，forwardRef 会把整个
 * 函数体缩进 +2，diff 噪音远大于收益（本仓已有 refreshRef 同款
 * 注册式镜像惯例）。 */
  registerHandle?: (h: CrdManageHandle) => void;
}

/** 注册式 handle 类型（WorkerManage 拓扑齿轮消费）。 */
export interface CrdManageHandle {
  /** 按 CR 名打开配置团队弹窗；团队未加载/不存在时 toast 提示，不静默。 */
  openConfig: (teamName: string) => void;
}

export const LEVEL_META: Record<number, { label: string; color: string }> = {
  1: { label: "管理员 (L1)", color: "#ff4d4f" },
  2: { label: "团队 (L2)", color: "#52c41a" },
  3: { label: "Worker", color: "#1677ff" },
};

export const PHASE_COLOR: Record<string, string> = {
  Active: "#52c41a",
  Ready: "#52c41a",
  Running: "#52c41a",
  Pending: "#fa8c16",
  Starting: "#1677ff",
  Error: "#ff4d4f",
  Failed: "#ff4d4f",
};

export interface WorkerRow {
  name: string;
  role: string;
  /** 团队配置内联编辑 Worker 模型（PUT /workers/{name} 合并语义，provider 不动）。 */
  model?: string;
  /** 打开弹窗时的原值——保存时 diff，未改动不发请求。 */
  modelOrig?: string;
  /** ：SOUL 富文本（多行/上传 → spec.soul 内联）。 */
  soul?: string;
  /** SOUL 编辑器展开状态（行级折叠，默认收起保持表单紧凑）。 */
  soulOpen?: boolean;
  /** 建队表单行模式：existing=选已存在 Worker（默认，原 WorkerRowSelects）；
   * new=现场新建（名字+运行时+模型，提交时先 POST /workers）。 */
  mode?: "existing" | "new";
  /** mode=new 时的运行时（POST /workers 的 spec.runtime；缺省 qwenpaw）。 */
  runtime?: string;
}

/** 创建自检行（CRD 回读 + 阶段轮询 5s×3min）。 */
export interface CheckRow {
  name: string;
  sentModel: string;
  crdModel: string;
  phase: string;
  container: string;
  message: string;
  modelOk: boolean;
  ready: boolean;
}

/** 创建自检状态（null=未开始）。 */
export interface TCheckState {
  rows: CheckRow[];
  running: boolean;
  startedAt: number;
  deadline: number;
  done: boolean;
}

export interface HumanForm {
  name: string;
  displayName: string;
  email: string;
  permissionLevel: number;
  accessibleTeams: string[];
  accessibleWorkers: string[];
  note: string;
}

export const EMPTY_HUMAN_FORM: HumanForm = {
  name: "",
  displayName: "",
  email: "",
  permissionLevel: 2,
  accessibleTeams: [],
  accessibleWorkers: [],
  note: "",
};

export interface TeamForm {
  name: string;
  teamName: string;
  description: string;
  humanMembers: string[];
  heartbeatEvery: string;
  peerMentions: boolean;
}

export const EMPTY_TEAM_FORM: TeamForm = {
  name: "",
  teamName: "",
  description: "",
  humanMembers: [],
  heartbeatEvery: "",
  peerMentions: true,
};

/** 建队时新建 Worker 表单（POST /api/v1/workers）。 */
export interface NwForm {
  name: string;
  runtime: string;
  model: string;
  soul: string;
  busy: boolean;
}

/** 配置团队弹窗的团队字段表单（PUT 部分更新：空字段不覆盖）。 */
export interface TeamCfgForm {
  description: string;
  heartbeatEvery: string;
  peerMentions: boolean;
  subagentModel: string;
  /** 团队级 LLM 调优 draft（10 字段，留空=继承 registry；保存=字段级 diff，
   * ""=清除覆盖。基线 llmBase 在 useTeamCrd 独立持有）。 */
  llm: LlmTuningRecord;
}

/** 批量模型画笔（两把独立画笔：Leader 批 / Workers 批）。 */
export interface CfgBatchModel {
  leader: string;
  workers: string;
}

/** 权限管理表单（Human CRD spec 编辑）。 */
export interface PermForm {
  permissionLevel: number;
  accessibleTeams: string[];
  accessibleWorkers: string[];
}
