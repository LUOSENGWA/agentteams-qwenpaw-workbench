// admin 域 i18n 字典（自 i18n.ts 按域拆分）：运维（审计/CRD 管理/集群负载）。

export const adminDict: Record<string, { en: string }> = {
  // ── 审计（A7，#1270 GET /api/v1/audit 消费）──
  "审计": { en: "Audit" },
  "审计日志": { en: "Audit Log" },
  "视图限定本团队": { en: "Scoped to your team" },
  "全部类型": { en: "All types" },
  "能力授权": { en: "Capability" },
  "最近 1 天": { en: "Last 1 day" },
  "最近 7 天": { en: "Last 7 days" },
  "最近 30 天": { en: "Last 30 days" },
  "全部时间": { en: "All time" },
  "操作者": { en: "Actor" },
  "对象": { en: "Target" },
  "动作": { en: "Action" },
  "变更": { en: "Change" },
  "信息": { en: "Info" },
  "警告": { en: "Warning" },
  "暂无审计事件": { en: "No audit events" },
  "视图已限定为本团队范围内的治理事件": {
    en: "View restricted to governance events within your team",
  },
  "当前 Controller 版本暂无审计端点": {
    en: "This Controller version has no audit endpoint yet",
  },
  "审计读取依赖上游 GET /api/v1/audit（#1270，MinIO 持久审计存储）。升级 Controller 后本页自动可用，无需插件改动。": {
    en: "Audit reading relies on the upstream GET /api/v1/audit (#1270, durable MinIO audit store). After upgrading the Controller this page becomes available automatically — no plugin change needed.",
  },
  "当前身份无权读取审计事件": {
    en: "Current identity cannot read audit events",
  },
  "审计读取要求 L1（admin/manager）或 L2（团队负责人/本团队 human）。worker 身份被 Controller 默认拒绝。": {
    en: "Reading audit requires L1 (admin/manager) or L2 (team leader / human of this team). Worker identities are denied by the Controller by default.",
  },
  // ── 第八批：集群负载（可选模块）──
  "集群负载": { en: "Cluster Load" },
  "首页": { en: "Home" },
  "AgentTeams 工作台": { en: "AgentTeams QwenPaw Workbench" },
  "团队协作总览": { en: "Team Overview" },
  "打开群聊": { en: "Open Chat" },
  "有 {n} 条未读": { en: "{n} unread" },
  "进入团队群聊": { en: "Go to team chat" },
  "快速配置": { en: "Quick Setup" },
  "检查连接与自检": { en: "Check connections & self-test" },
  "个房间": { en: "rooms" },
  "条未读": { en: "unread" },
  "提到我": { en: "mentions" },
  "任务进展": { en: "Tasks" },
  "阻塞": { en: "Blocked" },
  // ── CRD 管理（L1）+ L2 room-fallback 警示 ──
  "CRD 管理（L1 管理员）": { en: "CRD management (L1 admin)" },
  "员工入职（Human CRD）": { en: "Onboard human (Human CRD)" },
  "创建团队（Team CRD）": { en: "Create team (Team CRD)" },
  "账号名（Matrix localpart，如 alice）": {
    en: "Account name (Matrix localpart, e.g. alice)",
  },
  "显示名（如 张三）": { en: "Display name (e.g. Zhang San)" },
  "邮箱（可选）": { en: "Email (optional)" },
  "2 = 团队成员（Matrix 登录 → L2，可看本团队）": {
    en: "2 = Team member (Matrix sign-in → L2, sees own team)",
  },
  "1 = 管理员（L1；Matrix 登录拿不到 L1，需用管理员 token）": {
    en: "1 = Admin (L1; Matrix sign-in can't get L1 — use the admin token)",
  },
  "3 = Worker": { en: "3 = Worker" },
  "可访问团队（可选）": { en: "Accessible teams (optional)" },
  "可访问 Worker（可选）": { en: "Accessible workers (optional)" },
  "备注（可选）": { en: "Note (optional)" },
  "确认入职": { en: "Confirm onboarding" },
  "账号名不能为空，且不能含 @、冒号、空格": {
    en: "Account name is required and must not contain @, colon or spaces",
  },
  "入职成功——初始密码": { en: "Onboarded — initial password" },
  "此密码只显示一次，关闭后无法找回。请让用户首次 Matrix 登录后立即修改。": {
    en: "This password is shown only once and cannot be recovered. Ask the user to change it after first Matrix sign-in.",
  },
  "我已保存": { en: "I've saved it" },
  "账号": { en: "Account" },
  "级别 1 管理员不能经 Matrix 登录获得 L2（上游设计）——团队/团队配置页需用 Controller 管理员 token": {
    en: "Level-1 admins can't get L2 via Matrix sign-in (upstream design) — team pages need the Controller admin token",
  },
  "确认删除该员工？（不可恢复）": {
    en: "Delete this human? (irreversible)",
  },
  "暂无人员记录": { en: "No human records yet" },
  "团队 ID（唯一，小写字母/数字/-）": {
    en: "Team ID (unique, lowercase alphanumerics and -)",
  },
  "团队显示名（可选）": { en: "Team display name (optional)" },
  "描述（可选）": { en: "Description (optional)" },
  "人类成员（可选，仅创建时可设）": {
    en: "Human members (optional, settable only at creation)",
  },
  "Worker 名不能为空": { en: "Worker name is required" },
  "新建 Worker（Worker CRD）": { en: "Create Worker (Worker CRD)" },
  "Worker 名（唯一，小写字母/数字/-）": { en: "Worker name (unique, lowercase/digits/-)" },
  "创建并加入团队": { en: "Create and add to team" },
  "创建后由 Controller 调和器拉镜像起容器（数分钟就绪）；可先保存团队，Worker 就绪后自动生效。": { en: "The Controller reconciler pulls the image and starts the container after creation (ready in minutes); save the team first — it takes effect automatically once the worker is ready." },
  "Worker 已创建并加入团队成员（容器数分钟就绪）": { en: "Worker created and added to team members (container ready in minutes)" },
  "该 Worker 已在团队成员行中": { en: "This worker is already in a team member row" },
  "Worker 成员（必填，至少 1 个 team_leader）": {
    en: "Worker members (required, at least 1 team_leader)",
  },
  "选择 Worker": { en: "Pick worker" },
  // 团队配置内联编辑 Worker 模型
  "模型已改动": { en: "Model changed" },
  "已保存，已更新 {n} 个 Worker 模型": { en: "Saved; updated model of {n} worker(s)" },
  "模型更新失败": { en: "Failed to update model" },
  "添加 Worker": { en: "Add worker" },
  "心跳间隔（可选，如 10m）": { en: "Heartbeat interval (optional, e.g. 10m)" },
  "peerMentions（团队成员可互 @）": {
    en: "peerMentions (team members can @ each other)",
  },
  "确认创建": { en: "Confirm creation" },
  "团队 ID 不能为空": { en: "Team ID is required" },
  "至少需要 1 个 Worker（且至少 1 个 team_leader）": {
    en: "At least 1 worker is required (with 1 team_leader)",
  },
  "Worker 不能重复": { en: "Workers must not repeat" },
  "至少需要 1 个 team_leader": { en: "At least 1 team_leader is required" },
  "创建成功": { en: "Created" },
  "已删除": { en: "Deleted" },
  "人员列表": { en: "People" },
  "团队列表": { en: "Teams list" },
  "阶段": { en: "Phase" },
  "Leader": { en: "Leader" },
  "就绪": { en: "Ready" },
  "心跳": { en: "Heartbeat" },
  "配置团队": { en: "Configure team" },
  "确认删除该团队？（不可恢复）": {
    en: "Delete this team? (irreversible)",
  },
  "已保存": { en: "Saved" },
  "描述（留空 = 保持不变）": { en: "Description (blank = unchanged)" },
  "心跳间隔（留空 = 保持不变，如 10m）": {
    en: "Heartbeat interval (blank = unchanged, e.g. 10m)",
  },
  "人类成员（humanMembers）仅创建团队时可设——上游 PUT 不应用该字段，如需变更请删除重建。": {
    en: "humanMembers is settable only at team creation — upstream PUT ignores it; delete & recreate to change.",
  },
  "团队数据未接通——以下为房间聚合（群聊），不是真实团队结构": {
    en: "Controller not connected — below is a room aggregation (group chats), not the real team structure",
  },
  "到配置页填 Controller 地址 + 管理员 token（L1），或用 Human permissionLevel=2 的账号 Matrix 登录（L2），即可看到真实团队结构。": {
    en: "Set the Controller URL + admin token (L1) on Settings, or sign in with a Human permissionLevel=2 account (L2), to see the real team structure.",
  },
  "团队 Leader 列表不可用（Controller 未接入）——以下为 Manager 入口（跨团队）": {
    en: "Team Leader list unavailable (Controller not connected) — only the Manager entry (cross-team) is available",
  },
  // ── 15.35 访问与权限 chips（HumanAccessModal 单模态）──
  "访问与权限": { en: "Access & Permissions" },
  "权限档位": { en: "Permission level" },
  "级别 / 可访问团队 / 可访问 Worker 一次保存；旧版 Controller（无 PUT /humans）自动回落「生成命令」。": {
    en: "Level / accessible teams / accessible workers are saved in one call; on older Controllers (no PUT /humans) it falls back to command generation.",
  },
  "权限档位 / 可访问团队 / 可访问 Worker，一次保存；旧版 Controller 回落生成命令": {
    en: "Permission level / accessible teams / accessible workers — saved in one call; older Controllers fall back to command generation",
  },
  "添加团队…": { en: "Add team…" },
  "未加入任何团队": { en: "Not in any team" },
  "添加独立 Worker…": { en: "Add standalone worker…" },
  "无独立 Worker（全部已入团队）": { en: "No standalone workers (all in teams)" },
  "未关联 Worker（可选）": { en: "No linked workers (optional)" },
  // ── 15.36 D：权限档位 Select 短 label（完整语义进 HelpDot tooltip）──
  "L1 · 管理员": { en: "L1 · Admin" },
  "L2 · 团队成员": { en: "L2 · Team member" },
  // ── 16.41 批次 1：建队表单行内新建 Worker（mode=new）+ 独立 Worker 显式化 ──
  "选已有": { en: "Existing" },
  "Worker 名（新建，唯一）": { en: "Worker name (new, unique)" },
  "同名 Worker 已存在——请改名，或切回「选已有」（新建不自动复用）": {
    en: "A worker with this name already exists — rename it, or switch to “Existing” (new rows are never auto-reused)",
  },
  "以下 Worker 名已存在，请改名（新建行不自动复用）：{list}": {
    en: "These worker names already exist — rename them (new rows are never auto-reused): {list}",
  },
  "已加入团队：{name}": { en: "Added to team: {name}" },
  "该 Worker 已是团队现有成员": { en: "This worker is already a member of the team" },
  "不指定团队创建的 Worker 是独立 Worker：它能运行、能被私聊，但不参与任何团队任务。建好后可在团队设置里把它加进团队。": {
    en: "A worker created without a team is a standalone worker: it can run and receive DMs, but takes no part in any team’s tasks. You can add it to a team from team settings afterwards.",
  },
};
