// 工作流域（/projects-workflow、/workflow/events、controller /api/v1/projects/*）：DAG/事件/摘要/项目控制。

import { getCachedRooms, httpErrorDetail, httpErrorStatus, requestJson } from "../shared";
import { cachedRequest } from "../../requestCache";

/** 工作流 DAG 节点（树状拓扑数据源，workerflow nodes 字段）。 */
export interface WorkflowNode {
  id?: string;
  subagent?: string;
  task?: string;
  dependsOn?: string[];
  name?: string;
  status?: string;
  [k: string]: unknown;
}

/** Controller workflowInterrupt（上游已合并）：paused 项目带
 * action_request {action:'resume'} + config.allow_accept → 渲染恢复按钮。 */
export interface WorkflowInterrupt {
  id: string;
  value: string;
  action_request?: { action: string; args?: Record<string, unknown> };
  config?: {
    allow_ignore?: boolean;
    allow_respond?: boolean;
    allow_edit?: boolean;
    allow_accept?: boolean;
  };
  description?: string;
}

/** 任务状态转换审计单条（task meta history 数组，TeamHarness 转换引擎写入）。
 * 形状对齐 controller taskTransition（#1230 巡检契约）。 */
interface TaskTransition {
  ts: string;
  from?: string;
  to: string;
  action: string;
  actor?: string;
  note?: string;
  seq?: number;
}

/** 任务级明细（controller taskDetail，?includeTasks=true 的 tasks_detail 条目）。
 * #1230 任务巡检数据面：spec/摘要/验收/产物/转换审计。 */
export interface TaskDetail {
  task_id: string;
  project_id?: string;
  status?: string;
  spec_path?: string;
  assigned_to?: string;
  summary?: string;
  result_status?: string;
  deliverables?: unknown[];
  result_path?: string;
  cancel_reason?: string;
  submission_id?: string;
  history?: TaskTransition[];
}

export interface WorkflowEvent {
  runId: string;
  title: string;
  status: string;
  summary?: string;
  coordinator?: string;
  subagents?: unknown[];
  steps?: unknown[];
  /** 树状拓扑：DAG nodes（id/subagent/task/dependsOn）。 */
  nodes?: WorkflowNode[];
  /** 计划类型（workflowResponse.plan_type：dag/loop/""；replan 仅 dag）。
 * 声明（此前运行时已透传、类型未写——replan 门控需要）。 */
  plan_type?: string;
  /** 人工干预中断（paused 项目在此暴露 resume 动作）。 */
  interrupts?: WorkflowInterrupt[];
  /** 干预审计字段。 */
  pause_reason?: string;
  /** loop 计划（plan_type=loop 项目的迭代进度/停止条件/任务图）。 */
  loop?: {
    goal?: string;
    stop_condition?: string;
    iteration_template?: string;
    current_iteration?: number;
    max_iterations?: number;
    status?: string;
    tasks?: Array<{
      task_id?: string;
      title?: string;
      assigned_to?: string;
      depends_on?: string[];
      status?: string;
    }>;
    history?: unknown[];
  };
  room_id: string;
  room_name: string;
  sender: string;
  ts: number;
  /** 团队 id（正源列表条目 team_id；跨团队重名项目寻址 /events /history
 * 等裸 id 端点时 ?team= 的必填键——不带 = 409 ambiguous，同 workflow 契约）。 */
  team_id?: string;
  /** 任务级明细（正源 tasks_detail，#1230 巡检数据面；steps 的强类型副本——
 * steps 保留 unknown[] 兼容既有消费方（卡片降级轨），新代码用 taskDetails）。 */
  taskDetails?: TaskDetail[];
}

/** 转换引擎事件流单事件（Controller projectEvent，#1233 已合上游 main）。 */
export interface ProjectTransitionEvent {
  ts: string;
  task_id: string;
  from: string;
  to: string;
  actor?: string;
  action: string;
  note?: string;
  /** 写入端持久化单调序号（事件身份；legacy 无 seq 条目缺省）。 */
  seq?: number;
}

/** 任务状态转换事件流（Controller GET /api/v1/projects/{id}/events，#1233）。
 * 游标分页：limit 1..200（默认 50），next_cursor 不透明；
 * cursor_expired=true → 游标锚点已被截断/失效，调用方必须弃游标从头取。
 * 事件按时间升序（页1=最旧）。跨团队重名项目必须带 teamId（裸 id 409，
 * 与 fetchWorkflowProjects 同契约）。
 * 返回 null = Controller 未部署该端点（404）→ UI 诚实占位，不当错误。 */
export async function fetchProjectTransitionEvents(
  projectId: string,
  teamId?: string,
  opts?: { limit?: number; cursor?: string },
): Promise<{
  events: ProjectTransitionEvent[];
  nextCursor?: string;
  cursorExpired: boolean;
} | null> {
  const params: string[] = [];
  if (teamId) params.push(`team=${encodeURIComponent(teamId)}`);
  if (opts?.limit) params.push(`limit=${opts.limit}`);
  if (opts?.cursor) params.push(`cursor=${encodeURIComponent(opts.cursor)}`);
  const q = params.length ? `?${params.join("&")}` : "";
  try {
    const raw = (await requestJson(
      `/agentteams-proxy/controller/api/v1/projects/${encodeURIComponent(projectId)}/events${q}`,
    )) as Record<string, unknown>;
    return {
      events: (Array.isArray(raw.events)
        ? raw.events
        : []) as ProjectTransitionEvent[],
      nextCursor:
        typeof raw.next_cursor === "string" && raw.next_cursor
          ? raw.next_cursor
          : undefined,
      cursorExpired: raw.cursor_expired === true,
    };
  } catch (e) {
    if (httpErrorStatus(e) === 404) return null;
    throw e;
  }
}

/** cachedRequest 包裹（workflow/events，15s）——
 * 已有 force 参数透传（仅 force 一参且不影响结果内容 → key 固定）。 */
export async function fetchWorkflowEvents(
  force = false,
): Promise<{ ok: boolean; events: WorkflowEvent[]; elapsed?: number }> {
  return cachedRequest(
    "workflow/events",
    15000,
    async () =>
      (await requestJson(
        `/agentteams-proxy/workflow/events${force ? "?force=true" : ""}`,
      )) as { ok: boolean; events: WorkflowEvent[]; elapsed?: number },
  );
}

/** 正源项目列表（Controller /api/v1/projects，上游已合并）。
 * 响应是**信封** `{projects: [...], total}`（Controller project_handler.go
 * ListProjects L593 源码实锤），兼容裸数组。
 * 统一入口：此前 Artifacts.tsx 内联请求且**只认裸数组**→信封对象
 * 被误判空列表（项目产物树恒空、且 o19Fail=null 连降级横幅都没有）；本文件
 * fetchWorkflowProjects/fetchWorkerSpawns 两份内联解包虽对，但三处副本
 * 迟早漂移——从此所有消费者走此函数，信封解包单一真相源。 */
/** cachedRequest 包裹（projects/list，30s）——已有
 * force 参数透传；fetchWorkflowProjects/fetchWorkerSpawns 内部无参调用命中
 * 同一 key，多消费者合并为一次回源。 */
export async function fetchProjectSummaries(
  force = false,
): Promise<Record<string, unknown>[]> {
  return cachedRequest("projects/list", 30000, async () => {
    const raw = (await requestJson(
      `/agentteams-proxy/controller/api/v1/projects${force ? "?force=true" : ""}`,
    )) as unknown;
    const list = (Array.isArray(raw)
      ? raw
      : ((raw as { projects?: unknown[] })?.projects || [])) as Record<
      string,
      unknown
    >[];
    // 按 project_id 去重——Controller ListProjects 按 (team, id) 去重
    // （project_handler.go：「two teams may hold the same id... both appear」），
    // 同一 id 在团队目录与全局 shared/projects/ 各有一份 meta.json 时两条都返回
    // （实测存在重复条目）。而
    // workflow/artifact 端点只能裸 id 寻址 → 重复 id 裸调 = 409 ambiguous，
    // 两行指向同一可寻址对象。前端每 id 留一条：优先带 team_id 的记录
    // （它是 ?team= 寻址的有效键）。根因在数据侧重复注册（环境清理 + 上游
    // 候选 PR，见 memory 2026-08-22 笔记）。
    const byId = new Map<string, Record<string, unknown>>();
    for (const p of list) {
      const pid = String(p.project_id || "");
      if (!pid) continue;
      const cur = byId.get(pid);
      if (!cur) {
        byId.set(pid, p);
        continue;
      }
      if (!String(cur.team_id || "") && String(p.team_id || "")) {
        byId.set(pid, p);
      }
    }
    return Array.from(byId.values());
  });
}

/** 项目 workflow 正源（Controller API，双轨 adapter 的正源侧）。
 *
 * GET /api/v1/projects → 每项目 GET /{id}/workflow?includeTasks=true →
 * 映射为 WorkflowEvent[]（UI 接口不变）。Controller 未升级（404/网络失败）
 * 时返回 apiOk=false，调用方降级到 Matrix 事件聚合。
 * 附带 failReason（auth=token 未配置/无效，not_deployed=404，
 * error=其他）——降级横幅按原因给出可操作提示（此前静默降级，用户
 * 「只有 Manager 的」= 正源 401 静默回退、只剩自己已加入房间的扫描）。
 * 附带 failDetail（error 分支的真实上游错误，如 Controller 500 的
 * mc 报错）——此前真实原因被通用横幅「Controller 不可用」掩盖。
 * 外层 cachedRequest 包裹（workflow/projects，30s）
 * ——整包聚合（projects/list + 逐项目 workflow）是重接口，多调用点（workflow
 * tab 15s 轮询、聊天 📁 面板）合并为一次回源；内部 fetchProjectSummaries()
 * 无参调用命中 projects/list 缓存。
 * force=true → 绕过 30s 读缓存（cachedRequest
 * opts.force）+ 端点带 ?refresh=1（连接器无视 TTL 触发后台补扫，）——
 * 手动刷新必穿透；无参调用行为不变（既有调用者兼容）。 */
interface WorkflowProjectsResult {
  events: WorkflowEvent[];
  apiOk: boolean;
  failReason?: "auth" | "not_deployed" | "error";
  failDetail?: string;
}

async function loadWorkflowProjectsRaw(
  force = false,
): Promise<WorkflowProjectsResult> {
  // 改走连接器聚合（1 请求）；装配仍在本地。
  // 聚合端点异常（网络/未部署）→ 回退旧直连路径（loadWorkflowProjectsLegacy）。
  // force → 端点带 ?refresh=1（连接器触发
  // 后台补扫，）；仅手动刷新路径使用。
  try {
    const snap = await fetchProjectsWorkflow(force);
    // 上游 /projects 的非 200（401/403/404/5xx）→ 与前版本一致的横幅分类。
    if (snap.projectsStatus && snap.projectsStatus !== 200) {
      if (snap.projectsStatus === 401 || snap.projectsStatus === 403)
        return { events: [], apiOk: false, failReason: "auth" };
      if (snap.projectsStatus === 404)
        return { events: [], apiOk: false, failReason: "not_deployed" };
      return {
        events: [],
        apiOk: false,
        failReason: "error",
        failDetail: snap.projectsError || undefined,
      };
    }
    const list = snap.projects;
    if (!Array.isArray(list) || list.length === 0)
      return { events: [], apiOk: true };
    const mapped = list.slice(0, 100).map((proj) => {
      const pid = String(proj.project_id || "");
      if (!pid) return null;
      const wf = snap.workflows[pid];
      if (!wf || typeof wf !== "object") return null; // 单项目失败不拖垮
      return mapProjectWorkflow(proj, wf);
    });
    return {
      events: mapped.filter((e): e is WorkflowEvent => e !== null),
      apiOk: true,
    };
  } catch {
    return loadWorkflowProjectsLegacy();
  }
}

/** 旧逐项目直连实现原样保留，仅作兜底
 * （聚合端点异常——网络/未部署——时走这里）。 */
async function loadWorkflowProjectsLegacy(): Promise<WorkflowProjectsResult> {
  try {
    const list = await fetchProjectSummaries();
    if (list.length === 0) return { events: [], apiOk: true };
    // // 旧版 slice(0, 20) 只拉前 20 个项目的工作流，而列表端点无排序参数
    // （实盘 2026-09-23 = 45 个项目，字母序前 20 全是老项目）→ 新房间绑定的
    // 项目整体缺席 workflowEvents → 聊天 📁 面板与 live overlay 全空。
    // 控制器端点本地可达、单项目 JSON 小 → 全量拉（100 为安全上限）。
    const mapped = await Promise.all(
      list.slice(0, 100).map(async (proj) => {
        const pid = String(proj.project_id || "");
        if (!pid) return null;
        try {
          // 带上 ?team= 限定——同一 project_id 可能跨团队重名，
          // 不带 team 时 Controller 回 409（ambiguous across teams），
          // 此前 catch 静默吞掉 → 重名项目从列表整体消失。
          // 列表条目自带 team_id（独立项目 team_id 为空 → 不带参数）。
          const teamQ =
            typeof proj.team_id === "string" && proj.team_id
              ? `&team=${encodeURIComponent(proj.team_id)}`
              : "";
          const wf = (await requestJson(
            `/agentteams-proxy/controller/api/v1/projects/${encodeURIComponent(pid)}/workflow?includeTasks=true${teamQ}`,
          )) as Record<string, unknown>;
          return mapProjectWorkflow(proj, wf);
        } catch {
          return null; // 单项目失败不拖垮全列表
        }
      }),
    );
    return {
      events: mapped.filter((e): e is WorkflowEvent => e !== null),
      apiOk: true,
    };
  } catch (e) {
    // 按真实状态码分类（此前字符串匹配 msg.includes("401")——
    // "HTTP 500: list projects: mc ls ..." 这类上游错误不含 401/403/404
    // 字样，一律落 error 分支，真实原因被通用横幅掩盖）。
    const status = httpErrorStatus(e);
    const detail = httpErrorDetail(e);
    if (status === 401 || status === 403)
      return { events: [], apiOk: false, failReason: "auth" };
    if (status === 404)
      return { events: [], apiOk: false, failReason: "not_deployed" };
    return {
      events: [],
      apiOk: false,
      failReason: "error",
      failDetail: detail || undefined, // 端点未部署/网络失败/5xx → 调用方降级 + 横幅暴露原因
    };
  }
}

/** 任务级明细（?includeTasks=true 的 tasks_detail 条目）——字段全集 =
 * 群内项目文件面板（result/spec/deliverables 声明）+ 产物 tab（状态/摘要）
 * 两消费方实际读取的并集。从 Artifacts.tsx 局部
 * interface 提升为共享类型（两面板同源同型）。 */
export interface WorkflowTaskDetail {
  task_id: string;
  status?: string;
  assigned_to?: string;
  result_status?: string;
  summary?: string;
  deliverables?: string[];
  result_path?: string;
  spec_path?: string;
}

/** 单项目 workflow 明细响应（tasks_detail + 时间多源元数据；
 * index signature 保留——旧消费者按 [k: string]: unknown 读取扩展字段）。 */
interface WorkflowDetailResponse {
  tasks_detail?: WorkflowTaskDetail[];
  source_room_id?: string;
  updated_at?: string;
  [k: string]: unknown;
}

/** 单项目 workflow 明细（?includeTasks=true）。群内项目文件面板
 * （ProjectFiles）与产物 tab（Artifacts）共用——
 * 旧版
 * ProjectFiles 挂载即逐项目裸拉且 Drawer 重开全量重拉（零缓存层）；
 * 统一走本函数后 30s TTL 内两面板零重复回源，手动刷新走
 * invalidateTags 显式失效。team 参数同 fetchWorkflowProjects 契约
 * （跨团队重名 project_id 防 409）。 */
export async function fetchProjectWorkflow(
  projectId: string,
  teamId?: string,
): Promise<WorkflowDetailResponse> {
  const teamQ = teamId ? `&team=${encodeURIComponent(teamId)}` : "";
  return cachedRequest(
    `project/wf:${projectId}`,
    30000,
    async () =>
      (await requestJson(
        `/agentteams-proxy/controller/api/v1/projects/${encodeURIComponent(projectId)}/workflow?includeTasks=true${teamQ}`,
      )) as WorkflowDetailResponse,
    { tags: [`project:${projectId}`] },
  );
}

/** 对外缓存包装（workflow/projects，30s）。
 * force=true → opts.force 绕过 30s 读缓存
 * （手动刷新必穿透）+ fetcher 带 ?refresh=1 触发连接器后台补扫；
 * 无参调用 = 原行为（30s 缓存 + 在飞去重，调用者不变）。 */
export async function fetchWorkflowProjects(
  force = false,
): Promise<WorkflowProjectsResult> {
  return cachedRequest(
    "workflow/projects",
    30000,
    () => loadWorkflowProjectsRaw(force),
    { force },
  );
}

/** 项目+工作流取数聚合（连接器侧缓存/
 * 后台刷；前端 1 请求取原始件，装配仍在本地）。
 * force=true → 带 ?refresh=1，
 * 连接器无视 TTL 触发后台补扫（仍零等待返回当前快照，响应字段不变）。
 * 内部消费方：loadWorkflowProjectsRaw（工作流板取数正源）。 */
async function fetchProjectsWorkflow(
  force = false,
): Promise<{
  projects: Record<string, unknown>[];
  workflows: Record<string, Record<string, unknown>>;
  projectsStatus: number;
  projectsError: string;
}> {
  return (await requestJson(
    `/agentteams-proxy/projects-workflow${force ? "?refresh=1" : ""}`,
  )) as {
    projects: Record<string, unknown>[];
    workflows: Record<string, Record<string, unknown>>;
    projectsStatus: number;
    projectsError: string;
  };
}

// // fetchWorkflowMermaid（13.21 引入）与 MermaidDagView 一并退役——
// 两图同结构、快照非交互，自绘 DAG 保留（交互）且撤 mermaid 内联依赖
// 主包 −5.1MB。上游 `?format=mermaid` 端点仍在（#1230），插件不再消费。

/** RFC3339（controller updated_at）→ epoch ms；缺省/非法 → 0（fmtTime(0) 渲染空）。 */
function isoToMs(v: unknown): number {
  if (typeof v !== "string" || !v) return 0;
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}

/** /13.16（B3 关联判定——两轮根因）：项目↔房间。
 * 实盘根因（源码 + 部署真值双证）：
 * ① 项目群真 ID 写在 meta.json 的 `project_room_id`，Controller 的 Go
 * projectMeta 结构体只挑 source_room_id 透传 → API 从不暴露项目群 ID；
 * ② workflow.room_id（= meta.source_room_id）只是「发起房间」——QQ 发起
 * 为 `qq:...`、DM 发起为 DM 房间 → 与项目群 room_id 严格相等恒 miss；
 * ③ 13.15 只补了 `Project: <title>` 名称源，但**新项目（按 create_task_room 约定建的）根本
 * 没有 `Project:` 房**——teamharness MCP create_task_room 建的**任务房
 * 命名 `TASK：<projectId>`**（server.py L245/L249 契约；实盘 76 房间
 * 对表：6 个 TASK 房全部漏配）→ 13.16 补第三源。
 * 三源判定（任一命中即关联）：
 * ① source_room_id 严格匹配（`matrix:` 前缀归一后比较）；
 * ② 旧约定项目房：房间名/话题 = `Project: <项目名>`（create-project.sh，
 * 引号容错——兼容手工改名/带引号变体）；
 * ③ 新约定任务房：房间名 = `TASK：<projectId>`（全/半角冒号容错）→ 与
 * `ev.runId`（= project_id）精确相等——房间名内嵌项目 ID，直连正源。
 * 上游若日后暴露 project_room_id（待提 PR），本函数优先其为准源。 */
export function roomMatchesProject(
  roomId: string,
  roomName: string | undefined,
  roomTopic: string | undefined,
  ev: WorkflowEvent,
): boolean {
  if (!roomId) return false;
  const stripQ = (s: string) => s.trim().replace(/^['"“”‘’\s]+|['"“”‘’\s]+$/g, "");
  const norm = (s: string) => s.trim().replace(/^matrix:/i, "");
  // ① 源房间（Controller 轨 = wf.source_room_id；连接器轨 = 物理房间）。
  const src = typeof ev.room_id === "string" ? ev.room_id.trim() : "";
  if (src && norm(src) === norm(roomId)) return true;
  const title = typeof ev.title === "string" ? ev.title.trim() : "";
  const runId = typeof ev.runId === "string" ? ev.runId.trim() : "";
  for (const v of [roomName, roomTopic]) {
    const s = typeof v === "string" ? stripQ(v) : "";
    if (!s) continue;
    // ② 旧约定：项目房命名 `Project: <标题>`（create-project.sh 建）。
    if (title && s === `Project: ${title}`.trim()) return true;
    // ③ 新约定：任务房命名 `TASK：<projectId>`（teamharness create_task_room，
    // server.py「Project task rooms are named TASK：<projectId>」；全角/半角
    // 冒号容错）——房间名内嵌项目 ID = 直连正源（13.15 实盘
    // 证明新项目只有任务房、无 `Project:` 房）。
    const m = /^TASK[:：]\s*(.+)$/.exec(s);
    if (m) {
      const pid = stripQ(m[1]);
      if (pid && runId && pid === runId) return true;
    }
  }
  return false;
}

/** project + workflow → WorkflowEvent（UI 契约映射）。edges 反推 dependsOn。 */function mapProjectWorkflow(
  proj: Record<string, unknown>,
  wf: Record<string, unknown>,
): WorkflowEvent {
  const rawNodes = (Array.isArray(wf.nodes) ? wf.nodes : []) as Record<
    string,
    unknown
  >[];
  const depOf = new Map<string, string[]>();
  for (const e of Array.isArray(wf.edges) ? wf.edges : []) {
    const edge = e as Record<string, unknown>;
    const target = String(edge.target || "");
    const source = String(edge.source || "");
    if (!target || !source) continue;
    if (!depOf.has(target)) depOf.set(target, []);
    depOf.get(target)!.push(source);
  }
  const nodes: WorkflowNode[] = rawNodes.map((n) => ({
    id: String(n.id || ""),
    name: String(n.name || ""),
    status: String(n.status || ""),
    subagent: n.assignee ? String(n.assignee) : undefined,
    dependsOn: depOf.get(String(n.id || "")) || [],
  }));
  const rawInterrupts = (Array.isArray(wf.interrupts) ? wf.interrupts : []) as Record<
    string,
    unknown
  >[];
  const interrupts: WorkflowInterrupt[] = rawInterrupts.map((it) => {
    const ar = (it.action_request ?? {}) as Record<string, unknown>;
    const cfg = (it.config ?? {}) as Record<string, unknown>;
    return {
      id: String(it.id || ""),
      value: String(it.value || ""),
      ...(ar && typeof ar === "object" && ar.action
        ? {
            action_request: {
              action: String(ar.action),
              ...(ar.args && typeof ar.args === "object"
                ? { args: ar.args as Record<string, unknown> }
                : {}),
            },
          }
        : {}),
      ...(cfg && typeof cfg === "object"
        ? {
            config: {
              ...(typeof cfg.allow_ignore === "boolean" ? { allow_ignore: cfg.allow_ignore } : {}),
              ...(typeof cfg.allow_respond === "boolean" ? { allow_respond: cfg.allow_respond } : {}),
              ...(typeof cfg.allow_edit === "boolean" ? { allow_edit: cfg.allow_edit } : {}),
              ...(typeof cfg.allow_accept === "boolean" ? { allow_accept: cfg.allow_accept } : {}),
            },
          }
        : {}),
      ...(typeof it.description === "string"
        ? { description: it.description }
        : {}),
    };
  });
  const wfTitle = typeof wf.title === "string" ? wf.title : "";
  const rawLoop = (wf.loop ?? {}) as Record<string, unknown>;
  return {
    runId: String(proj.project_id || ""),
    title: wfTitle || String(proj.title || "未命名任务"),
    status: String(wf.status || proj.status || "unknown"),
    summary: typeof wf.summary === "string" ? wf.summary : "",
    steps: (Array.isArray(wf.tasks_detail) ? wf.tasks_detail : []) as unknown[],
    // #1230 任务巡检：tasks_detail 强类型副本（与 steps 同源；降级轨事件无 tasks_detail → 空）。
    taskDetails: (Array.isArray(wf.tasks_detail) ? wf.tasks_detail : []) as TaskDetail[],
    nodes,
    interrupts,
    pause_reason: typeof wf.pause_reason === "string" ? wf.pause_reason : undefined,
    ...(rawLoop && Object.keys(rawLoop).length > 0
      ? {
          loop: {
            ...(typeof rawLoop.goal === "string" ? { goal: rawLoop.goal } : {}),
            ...(typeof rawLoop.stop_condition === "string"
              ? { stop_condition: rawLoop.stop_condition }
              : {}),
            ...(typeof rawLoop.iteration_template === "string"
              ? { iteration_template: rawLoop.iteration_template }
              : {}),
            ...(typeof rawLoop.current_iteration === "number"
              ? { current_iteration: rawLoop.current_iteration }
              : {}),
            ...(typeof rawLoop.max_iterations === "number"
              ? { max_iterations: rawLoop.max_iterations }
              : {}),
            ...(typeof rawLoop.status === "string"
              ? { status: rawLoop.status }
              : {}),
            ...(Array.isArray(rawLoop.tasks)
              ? {
                  tasks: (rawLoop.tasks as Record<string, unknown>[]).map(
                    (t) => ({
                      ...(typeof t.task_id === "string"
                        ? { task_id: t.task_id }
                        : {}),
                      ...(typeof t.title === "string" ? { title: t.title } : {}),
                      ...(typeof t.assigned_to === "string"
                        ? { assigned_to: t.assigned_to }
                        : {}),
                      ...(Array.isArray(t.depends_on)
                        ? { depends_on: t.depends_on as string[] }
                        : {}),
                      ...(typeof t.status === "string"
                        ? { status: t.status }
                        : {}),
                    }),
                  ),
                }
              : {}),
            ...(Array.isArray(rawLoop.history)
              ? { history: rawLoop.history as unknown[] }
              : {}),
          },
        }
      : {}),
    room_id: typeof wf.source_room_id === "string" ? wf.source_room_id : "",
    room_name: "",
    sender: "",
    team_id:
      typeof proj.team_id === "string" && proj.team_id ? proj.team_id : undefined,
    // 正源映射补全（）：此前 coordinator/ts 从未映射，
    // 协调者/时间列恒空（即使 CreateProject API 建的项目 meta 里有值）。
    // 老项目 meta 无 requester/updated_at（v1.2.2 脚本模板不写）→ 仍为空，
    // 属数据缺字段，非映射 bug。
    coordinator: typeof wf.requester === "string" && wf.requester ? wf.requester : undefined,
    ts: isoToMs(wf.updated_at),
  };
}

/** 项目活动时间多源（用户「显示不了时间」根因修）。
 * 上游 projectSummary（列表端点）6 字段无时间戳（v1.2.3 最新 223ddc2b 实锤，
 * meta.json 有 created_at 但 projectMeta 结构体不暴露——上游 PR「列表补
 * updated_at」合并前插件拿不到真值），时间多源兜底：
 * ① realTs=真实字段（workflow meta.updated_at，omitempty 仅生命周期写 API
 * 写过才有；上游补字段后自动生效）
 * ② 项目房间最后消息（roomsCache 零额外请求——项目群=项目专用房，
 * 最后一条消息≈项目最后活动，覆盖面最广）
 * ③ project_id 内嵌 YYYYMMDD 近似（创建日期；create-project.sh --id 是
 * Manager 自由文本，带日期的 id 才命中）
 * ④ 0（UI 显空，排序垫底） */
export function projectActivityTs(
  realTs: number,
  roomId: string,
  projectId: string,
): number {
  let best = realTs > 0 ? realTs : 0;
  const room = roomId
    ? getCachedRooms()?.rooms?.find((r) => r.room_id === roomId)
    : undefined;
  if (room?.last_ts && room.last_ts > best) best = room.last_ts;
  const m = String(projectId || "").match(/(20\d{6})/);
  if (m) {
    const approx = new Date(
      Number(m[1].slice(0, 4)),
      Number(m[1].slice(4, 6)) - 1,
      Number(m[1].slice(6, 8)),
    ).getTime();
    if (approx > best) best = approx;
  }
  return best;
}

/** 来源房间名富化：用已同步的房间缓存把 room_id → room_name（零额外请求）。
 * 缓存未命中（用户未加入该房间）保持空，UI 回退显示 room_id。
 * 顺带富化 ts（projectActivityTs 多源——此前
 * ts=isoToMs(wf.updated_at) 恒 0，用户「工作流/产物显示不了时间」）。 */
export function enrichWorkflowRoomNames(events: WorkflowEvent[]): WorkflowEvent[] {
  const cache = getCachedRooms();
  const nameById = new Map<string, string>();
  if (cache?.rooms?.length) {
    for (const r of cache.rooms) if (r.room_id && r.name) nameById.set(r.room_id, r.name);
  }
  return events.map((ev) => {
    const cachedName = ev.room_id ? nameById.get(ev.room_id) : undefined;
    const nextName = ev.room_name || cachedName || "";
    const nextTs = projectActivityTs(ev.ts || 0, ev.room_id || "", ev.runId);
    if (nextName === ev.room_name && nextTs === (ev.ts || 0)) return ev;
    return { ...ev, room_name: nextName, ts: nextTs };
  });
}

/** 项目写操作（上游已合并：pause/resume/replan/complete + 任务级 cancel，
 * 走后端 controller 代理）。成功后 Controller 返回刷新后的 workflow JSON。 */
export async function pauseProject(
  projectId: string,
  reason?: string,
): Promise<Record<string, unknown>> {
  return (await requestJson(
    `/agentteams-proxy/controller/api/v1/projects/${encodeURIComponent(projectId)}/pause`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: reason ?? "" }),
    },
  )) as Record<string, unknown>;
}

export async function resumeProject(
  projectId: string,
): Promise<Record<string, unknown>> {
  return (await requestJson(
    `/agentteams-proxy/controller/api/v1/projects/${encodeURIComponent(projectId)}/resume`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  )) as Record<string, unknown>;
}

/** 任务级取消（接按钮）：reason 必填（400），
 * 终态任务 409（completed/revision/blocked/cancelled；重复 cancel 幂等收敛）。
 * 成功后 Controller 返回刷新后的 workflow JSON。 */
export async function cancelTask(
  projectId: string,
  taskId: string,
  reason: string,
): Promise<Record<string, unknown>> {
  return (await requestJson(
    `/agentteams-proxy/controller/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/cancel`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    },
  )) as Record<string, unknown>;
}

/** 项目级完成（接按钮）：空 body；
 * 已 completed 或有非终态任务（planned/assigned/in_progress/submitted）→ 409。
 * 完成后 Controller 通知团队「✅ 项目 X 已完成」。 */
export async function completeProject(
  projectId: string,
): Promise<Record<string, unknown>> {
  return (await requestJson(
    `/agentteams-proxy/controller/api/v1/projects/${encodeURIComponent(projectId)}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  )) as Record<string, unknown>;
}


/** Replan（接按钮——此前预埋勿删，现已落地）：
 * body {tasks:[{taskId, title?, assignedTo?, dependsOn?, status?}]}——
 * 已存在的 taskId 省略字段继承旧值（status 省略=保留旧状态）；
 * 仅 active 项目 + dag 计划 + 无 in_progress/submitted 任务（否则 409）。 */
export async function replanProject(
  projectId: string,
  tasks: unknown[],
): Promise<Record<string, unknown>> {
  return (await requestJson(
    `/agentteams-proxy/controller/api/v1/projects/${encodeURIComponent(projectId)}/replan`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tasks }),
    },
  )) as Record<string, unknown>;
}
