/**
 * types.ts — 「管理」页共享类型（四域 section 组件契约）。
 *
 * ManageData = WorkbenchPage 经 ManagePage 下发给各 section 的数据/刷新链路
 * （旧 WorkerManage props 的拆分镜像）；ManageVariant = section 组件在
 * 三栏/二级页布局下的角色（mid=中栏、right=右栏、full=覆盖中+右的二级页）。
 */
import type { AdminData, TeamRoom, WorkerTreeTeam } from "../api";
import type { WorkerSessionState } from "../workerSessionState";
import type { ManageNav, ManageSection } from "./useManageNav";

/** section 组件在当前布局中渲染哪一栏。 */
export type ManageVariant = "mid" | "right" | "full";

/** 管理页数据/刷新链路（sections 按需消费；WorkbenchPage 透传原引用）。 */
export interface ManageData {
  /** 团队结构（/teams/structure：controller-workers 正源 / room-fallback 房间聚合）。 */
  teams: WorkerTreeTeam[];
  /** L1 管理全量（workers/teams/humans/managers；无 token 时 null）。 */
  admin: AdminData | null;
  treeLoading?: boolean;
  adminLoading?: boolean;
  /** admin 取数连续失败次数（≥2 且无数据时显 Alert+重试）。 */
  adminFailCount?: number;
  /** 团队结构数据来源（"controller-workers" / "room-fallback"）。 */
  treeSource?: string;
  /** 当前 Matrix 登录账号 MXID（L2 我的团队 scope）。 */
  myUserId?: string;
  /** L1 走 controller_token（无 Console 会话 → 网关 alias 层不可见提示）。 */
  l1TokenMode?: boolean;
  /** worker_name → session 状态（行内圆点）。 */
  workerSessionByName?: Record<string, WorkerSessionState>;
  /** Matrix 房间列表（成员头像源：team.room_id → room.members[mxid].avatar_url）。 */
  rooms?: TeamRoom[];
  /** room_id → 待决策条数（团队行待决策徽章；旧 controller 未部署 attention = undefined → 不显）。 */
  attentionPendingByRoom?: Map<string, number>;
  /** 是否已配置 Controller 管理员 token（决定 L1 管理面可用性）。 */
  hasToken?: boolean;
  /** 刷新拓扑树（silent=true 静默不闪页）。 */
  onRefreshTree?: (silent?: boolean) => void;
  /** 刷新管理数据（silent=true 静默不闪页）。 */
  onRefreshAdmin?: (silent?: boolean) => void;
  /** 点击 Worker「私聊」→ 优先直跳 Worker 个人房间。 */
  onDm?: (mxid: string, roomId?: string) => void;
  /** 运行配置 L1 只读 Alert 的「去设置」跳转。 */
  onOpenSettings?: () => void;
}

/** 四域 section 组件统一 props（nav 驱动栏内容，variant 决定角色）。 */
export interface ManageSectionProps {
  nav: ManageNav;
  /** 当前栏数（1/2/3）——section 内部布局微调用。 */
  cols: 1 | 2 | 3;
  data: ManageData;
  variant: ManageVariant;
}

/** ManagePage 的 section 深链请求类型（与 useManageNav 同域，避免循环引用）。 */
export type { ManageSection };
