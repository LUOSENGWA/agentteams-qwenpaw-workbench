// 「管理」页域 i18n 字典（10/29 管理页重构 P8）：原「团队管理 + 运维 + 审计」
// 三顶层 tab 合并为「管理」页后的新增文案（P0–P6 引入；旧 tab 既有键留在
// 原域字典，此处只收本重构新增、且全库字典无键的中文字符串）。

export const manageDict: Record<string, { en: string }> = {
  // ── 页壳 / 导航（P0）──
  "管理": { en: "Manage" },
  "管理导航": { en: "Manage navigation" },
  "收起左栏": { en: "Collapse rail" },
  "展开左栏": { en: "Expand rail" },
  "人员管理": { en: "People" },

  // ── 团队域（P1/P3）──
  "搜索团队 / 成员…": { en: "Search teams / members…" },
  "搜索团队 / 成员": { en: "Search teams / members" },
  "匹配成员": { en: "Matching members" },
  "暂无团队": { en: "No teams yet" },
  "去 CRD 管理创建团队": { en: "Create a team in CRD management" },
  "加入团队房间后这里显示你的团队结构": {
    en: "Join a team room and your team structure appears here",
  },
  "无匹配团队 / 成员": { en: "No matching teams / members" },
  "管理数据未就绪": { en: "Admin data not ready" },
  "千锻注入需 L1 管理 token": { en: "Millforge injection requires an L1 admin token" },
  "该团队不是 Team CR（如「未分组」），千锻注入需要团队目标": {
    en: "This team is not a Team CR (e.g. “Ungrouped”); Millforge injection needs a team target",
  },
  "千锻": { en: "Millforge" },
  "选模板 / 自定义 → 编译预览 → 注入 Worker": {
    en: "Template / custom → compile preview → inject into workers",
  },
  "打开千锻注入": { en: "Open Millforge injection" },
  "团队设置": { en: "Team Settings" },
  "所选团队已不在最新数据中": { en: "Selected team no longer in the latest data" },
  "回团队列表": { en: "Back to team list" },
  "所选 Worker 已不在最新数据中": { en: "Selected worker no longer in the latest data" },
  "回团队拓扑": { en: "Back to team topology" },
  "选择 Worker / 团队": { en: "Select a worker / team" },
  "点中栏 Worker 节点后这里显示详情": {
    en: "Pick a worker node in the middle column to show details here",
  },
  "团队设置加载中…": { en: "Loading team settings…" },
  "Worker 级模型可单独改：当前 {n} 个 Worker 未分组。": {
    en: "Worker-level models can be changed individually: {n} worker(s) are ungrouped now.",
  },
  "打开 Worker 模型设置": { en: "Open worker model settings" },
  "未分组是后端为无 team 的 Worker 造的伪团队（不是 Team CR）——没有团队级设置（描述 / 心跳 / LLM 调优 / 团队技能等）。": {
    en: "“Ungrouped” is a pseudo-team the backend creates for workers without a team (not a Team CR) — no team-level settings (description / heartbeat / LLM tuning / team skills, etc.).",
  },

  // ── Worker 详情（P2/P3）──
  "容器态": { en: "Container state" },
  "legacy": { en: "legacy" },
  "AgentTeams": { en: "AgentTeams" },
  "版本探测失败": { en: "Version probe failed" },
  "重启中": { en: "Restarting" },
  "是": { en: "Yes" },
  "否": { en: "No" },
  "loop 预算": { en: "loop budget" },

  // ── 资源卡（P3/fd26b75）──
  "并发 / 上下文 / shell 组（L1 可编辑）": {
    en: "Concurrency / context / shell group (editable at L1)",
  },
  "环境变量与网关": { en: "Env vars & gateway" },
  "安装 / 升级 / 配置（1.2.5+）": { en: "Install / upgrade / configure (1.2.5+)" },
  "{n} 个变量 · 模型 / MCP 网关探测": {
    en: "{n} env var(s) · model / MCP gateway probe",
  },
  "spec.env · 模型 / MCP 网关探测": { en: "spec.env · model / MCP gateway probe" },
  "{n} 个 server（CRD 声明 + 自注册合并视图）": {
    en: "{n} server(s) (CRD declarations + self-registrations merged)",
  },
  "CRD 声明 + Worker 自注册合并视图": {
    en: "CRD declarations + worker self-registrations (merged view)",
  },
  "id / 名称 / 版本 / 启用（只读表）": { en: "id / name / version / enabled (read-only table)" },
  "已配 {n} 项 · 目录 / 分配矩阵": { en: "{n} configured · catalog / assignment matrix" },
  "目录 / 分配矩阵（MCP 独立卡）": {
    en: "Catalog / assignment matrix (MCP is a separate card)",
  },
  "内置工具启用列表": { en: "Built-in tool enable list" },
  "频道配置 + 二维码授权": { en: "Channel config + QR-code auth" },
  "审批模式": { en: "Approval mode" },
  "审批档位（QwenPaw 独有）": { en: "Approval levels (QwenPaw-only)" },
  "QwenPaw 运行时就地升级（L1 · 二次确认）": {
    en: "In-place QwenPaw runtime upgrade (L1 · double confirm)",
  },

  // ── CRD 域（P4）──
  "创建团队": { en: "Create Team" },
  "员工入职": { en: "Onboard Human" },
  "CRD 管理需要 Controller 管理员 token（L1）": {
    en: "CRD management requires the Controller admin token (L1)",
  },
  "到设置页填 Controller 地址 + 管理员 token 后可创建/配置 Human / Team / Worker CRD。": {
    en: "Fill in the Controller address + admin token on the Settings page to create/configure Human / Team / Worker CRDs.",
  },
  "管理数据加载中…": { en: "Loading admin data…" },
  "Human CRD 入职（名字 / 团队 / 权限档位）；初始密码只显示一次": {
    en: "Human CRD onboarding (name / team / permission level); the initial password is shown once",
  },
  "Team CRD（Leader + Worker 行 + 模型）+ 创建自检": {
    en: "Team CRD (Leader + worker rows + models) + creation self-check",
  },
  "Worker CRD（名字 + 模型 + SOUL）": { en: "Worker CRD (name + model + SOUL)" },
  "{n} 条记录": { en: "{n} record(s)" },
  "选择 CRD 入口": { en: "Pick a CRD entry" },
  "点中栏入口卡后这里显示对应表单": {
    en: "Pick an entry card in the middle column to show its form here",
  },

  // ── 人员域（P5）──
  "人员管理需要 Controller 管理员 token（L1）": {
    en: "People management requires the Controller admin token (L1)",
  },
  "到设置页填 Controller 地址 + 管理员 token 后可查看人员列表、配置团队访问与权限。": {
    en: "Fill in the Controller address + admin token on the Settings page to view people, configure team access & permissions.",
  },
  "搜索人员 / MXID…": { en: "Search people / MXID…" },
  "搜索人员 / MXID": { en: "Search people / MXID" },
  "共 {n} 人": { en: "{n} person(s)" },
  "可访问 {n} 团队": { en: "{n} team(s) accessible" },
  "无匹配人员": { en: "No matching people" },
  "选择人员": { en: "Select a person" },
  "所选人员已不在最新数据中——回中栏人员列表重选": {
    en: "Selected person no longer in the latest data — reselect from the middle column",
  },
  "点中栏人员行后，这里可配置团队访问与权限": {
    en: "Pick a person row in the middle column to configure team access & permissions",
  },
  "团队访问配置": { en: "Team access" },
  "勾选该员工可访问的团队（保存到 Controller 或生成命令）": {
    en: "Tick the teams this human can access (save to Controller or generate a command)",
  },
  "权限设置": { en: "Permissions" },
  "权限档位 / 可访问团队 / 可访问 Worker（生成命令）": {
    en: "Permission level / accessible teams / accessible workers (generates a command)",
  },
  "搜索账号 / 显示名…": { en: "Search account / display name…" },
  "搜索账号 / 显示名": { en: "Search account / display name" },

  // ── 集群域（P6）──
  "查看组件日志": { en: "View component logs" },
  "Controller 容器日志（Docker API 代理）": { en: "Controller container logs (Docker API proxy)" },
  "查看审计": { en: "View audit" },
  "Controller 操作审计（GET /api/v1/audit）": {
    en: "Controller operation audit (GET /api/v1/audit)",
  },
  "选择 日志 / 审计": { en: "Pick logs / audit" },
  "点中栏 组件日志 / 审计 卡片查看详情（二级页覆盖本栏）": {
    en: "Pick the component-logs / audit card in the middle column — the detail page covers this pane",
  },

  // ── 15.36 xwide 四栏 + 可点面包屑（A 段）──
  // 注：「团队列表」「人员列表」「选择团队」复用 admin/worker 域既有键，不重复登记。
  "入口列表": { en: "Entries" },
  "收起 L1 列表": { en: "Collapse L1 list" },
  "展开 L1 列表": { en: "Expand L1 list" },
  "点列表中的团队查看其拓扑": {
    en: "Pick a team in the list to view its topology",
  },
  "点左侧列表入口显示对应表单": {
    en: "Pick an entry in the left list to show its form",
  },
  "无更深一层": { en: "No deeper level" },
  "CRD 表单在中栏": { en: "The CRD form lives in the middle column" },
  "点左侧列表中的人员配置团队访问与权限": {
    en: "Pick a person in the left list to configure team access & permissions",
  },
  "人员详情在中栏（访问与权限弹窗打开）": {
    en: "Person details live in the middle column (access & permissions open in a modal)",
  },
  "点左栏 组件日志 / 审计 卡片查看详情": {
    en: "Pick the component-logs / audit card in the left column to view details",
  },
};
