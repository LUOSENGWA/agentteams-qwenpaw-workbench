// 审批域（/approval/*、controller /workers/*/approval、/room-approvals）：QwenPaw approval_level + 房间审批队列。

import { requestJson } from "../shared";
import { cachedRequest } from "../../requestCache";
import { publishApprovalCount } from "../../approvalsStore";

// 原「宿主审批队列」段（PendingApproval /
// fetchPendingApprovals / sendApprovalAction，GET /console/push-messages）
// 已删除——集群 Worker 的 Tool Guard 审批发生在 Worker 所在进程，本机宿主队列
// 恒 0（查证 + 真机「首页没有」实锤）。房间审批源 =
// GET /room-approvals（下方 RoomApproval/fetchRoomApprovals）+ 批准/拒绝
// 走 sendApprovalCommand（带 @Worker 的房间命令）。

// ── Worker 工具执行安全（QwenPaw 原生 approval_level 四模式）────
interface ApprovalItem {
  agent: string;
  container: string;
  kind: string;
  state: string;
  approval_level: string | null;
  error: string;
}

interface ApprovalListResponse {
  items: ApprovalItem[];
  levels: string[];
}

export async function fetchApprovalList(
  agent?: string,
): Promise<ApprovalListResponse> {
  const q = agent ? `?agent=${encodeURIComponent(agent)}` : "";
  return (await requestJson(
    `/agentteams-proxy/approval/list${q}`,
  )) as ApprovalListResponse;
}

interface ApprovalSetResult {
  ok: boolean;
  agent: string;
  level: string;
  verified: string | null;
  note: string;
}

export async function setApprovalLevel(
  agent: string,
  level: string,
): Promise<ApprovalSetResult> {
  return (await requestJson(`/agentteams-proxy/approval/set`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent, level }),
  })) as ApprovalSetResult;
}

// ── #1216 Controller 审批端点（L1/L2 统一主路径）────
// 走 catch-all 透传（agentteams-proxy/controller/api/v1/...）：admin
// token 在 → Bearer admin token（L1）；空 → Matrix access_token（L2
// team-scoped 可读写本团队 Worker；OFF 需 approval_policy capability
// #1273→403 透传；team leader 只读→PUT 403；跨团队→404）。
// 旧 Controller（< 含 #1216 版本）→ 404 = 版本门控，调用方回退旧
// /approval/list|set（docker 直读/PUT running-config，L1-only）。
export async function fetchWorkerApproval(
  name: string,
): Promise<{ approval_level: string }> {
  return (await requestJson(
    `/agentteams-proxy/controller/api/v1/workers/${encodeURIComponent(
      name,
    )}/approval`,
  )) as { approval_level: string };
}

export async function setWorkerApproval(
  name: string,
  level: string,
): Promise<{ approval_level: string }> {
  return (await requestJson(
    `/agentteams-proxy/controller/api/v1/workers/${encodeURIComponent(
      name,
    )}/approval`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approval_level: level }),
    },
  )) as { approval_level: string };
}

// ── 待工具审批请求（Worker Tool Guard HITL 主动通知）────
// 数据源 = sync_watcher /sync 事件流实时缓冲 + 全量扫描 bootstrap（10s
// 缓存）。approve/deny 走 sendRoomMessage 发房间命令（RoomChat 审批卡
// 同款语义），非宿主原生审批队列。

export interface RoomApproval {
  room_id: string;
  room_name: string;
  event_id: string;
  sender: string;
  body: string;
  ts: number;
  /** approval=🛡️ Approval Required（新版）；legacy=⏳ Waiting for approval。 */
  kind: string;
  approve_cmd: string;
  deny_cmd: string;
}

/** 房间审批队列（/room-approvals）。
 * 15s 读缓存 + 在飞去重：首页/通知面板/聊天页三组件多触发源合流——
 * 任一 15s 窗内已取过即零拨号，同刻并发共享同一 Promise。
 * force=true 绕过缓存（审批动作后由 sendApprovalCommand 统一失效
 * "room-approvals" 标签，无需调用方逐个 force）。 */
export async function fetchRoomApprovals(
  limit = 30,
  force = false,
): Promise<RoomApproval[]> {
  return cachedRequest(
    `room-approvals:${limit}`,
    15000,
    async () => {
      const raw = (await requestJson(
        `/agentteams-proxy/room-approvals?limit=${limit}`,
      )) as Record<string, unknown>;
      const list = (Array.isArray(raw.approvals)
        ? raw.approvals
        : []) as RoomApproval[];
      // 真实取数（缓存未命中/loader 执行）→ 发布共享计数：侧栏徽标
      // 等被动订阅者零拨号跟随（见 approvalsStore 模块头注释）。
      publishApprovalCount(list.length);
      return list;
    },
    { force, tags: ["room-approvals"] },
  );
}
