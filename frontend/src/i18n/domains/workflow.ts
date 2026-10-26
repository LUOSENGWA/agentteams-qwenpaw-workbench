// workflow 域 i18n 字典（自 i18n.ts 按域拆分）：工作流与产物（看板/卡片/项目文件面板/干预/审批卡）。

export const workflowDict: Record<string, { en: string }> = {
  // ── 第二批：产物页 / 运维 / 管理 / 工作流 / 树 ──
  "项目产物": { en: "Project Artifacts" },
  "信号事件（SIG-*）": { en: "Signal events (SIG-*)" },
  "Controller 未部署信号事件读取端点（#1405 只写不读；需补只读端点后此处自动出现）": {
    en: "This Controller does not expose the signal-events read endpoint (#1405 writes only; the panel appears once the read endpoint ships).",
  },
  "暂无信号事件——读取端点已接通，SIG-* 事件写入后自动出现": {
    en: "No signal events yet — the read endpoint is live; SIG-* events appear here once written.",
  },
  "时间 新→旧": { en: "Time: newest first" },
  "时间 旧→新": { en: "Time: oldest first" },
  "名称 A→Z": { en: "Name A–Z" },
  "全部团队": { en: "All teams" },
  "暂无已登记项目——经 projectflow 登记的项目会显示在这里": {
    en: "No registered projects — projects registered via projectflow appear here",
  },
  "暂无项目产物——已登记项目的任务交付物会显示在这里（未登记项目只走下方房间附件扫描）": {
    en: "No project artifacts yet — deliverables of registered project tasks appear here (unregistered projects only via the room-attachment scan below)",
  },
  "该分类下还没有文件": { en: "No files in this category" },
  "任务": { en: "Task" },
  "已有 {n} 个项目，但任务图（nodes）全空——多为 planning 状态：项目刚建、任务在群聊 @mention 协调，未登记进 Controller 的任务 DAG": {
    en: "{n} project(s) listed but the task graph (nodes) is empty — usually planning state: tasks are coordinated via @mentions in the room, not yet registered in the Controller DAG",
  },
  "项目": { en: "Projects" },
  "事件": { en: "Events" },
  "卡片": { en: "Cards" },
  "任务巡检": { en: "Task inspection" },
  "无任务级明细——正源任务图有该任务，但 TaskMeta 未落盘（或 Matrix 降级轨无 tasks_detail）": {
    en: "No task-level detail — the project task graph has this task, but its TaskMeta is not on disk (or Matrix fallback track carries no tasks_detail)",
  },
  "摘要": { en: "Summary" },
  "验收结果": { en: "Result status" },
  "取消原因": { en: "Cancel reason" },
  "任务规格": { en: "Task spec" },
  "依赖任务": { en: "Depends on" },
  "状态转换（{n}，新→旧）": { en: "State transitions ({n}, newest first)" },
  "tracing 过滤提示": { en: "Tracing filter hint" },
  "值用于匹配 worker entry span 属性（tracing 后端为部署特定，不构造 URL）": {
    en: "Values match worker entry span attributes (tracing backend is deployment-specific; no URL is constructed)",
  },
  "下载失败": { en: "Download failed" },
  "房间列表": { en: "Room list" },
  "隐藏房间列表": { en: "Hide room list" },
  "显示房间列表": { en: "Show room list" },
  "拖动调整房间列表宽度": { en: "Drag to resize room list" },
  "选择左侧房间开始聊天": { en: "Pick a room on the left to start chatting" },
  "房间列表已隐藏——点左上角 ☰ 显示": {
    en: "Room list hidden — click ☰ at top-left to show",
  },
  "路由": { en: "Route" },
  "模型网关配置": { en: "Model gateway configuration" },
  "Higress Console（透传）": { en: "Higress Console (passthrough)" },
  "Controller 只读目录（#1242）": { en: "Controller read-only catalog (#1242)" },
  "数据不可用": { en: "Data unavailable" },
  "路由目录为空——检查 Higress 是否已配置 AI 路由": {
    en: "Route catalog is empty — check whether Higress has AI routes configured",
  },
  "仅 L1 管理员可查看只读路由目录（当前会话无权限）": {
    en: "Only L1 admins can view the read-only route catalog (current session lacks permission)",
  },
  "模型网关数据不可用——Console 会话未配置且 Controller 版本过旧（需含 #1242 路由目录端点）": {
    en: "Model gateway data unavailable — no Console session and the Controller predates the #1242 route catalog endpoint",
  },
  "AI 路由（{n}）": { en: "AI routes ({n})" },
  "上游提供商": { en: "Upstream provider" },
  "上游提供商（权重）": { en: "Upstream provider (weight)" },
  "授权 Consumer": { en: "Allowed consumers" },
  "请求模型（alias）": { en: "Request model (alias)" },
  // P7b：alias 全集聚合块 + 目录源标注
  "可请求模型（alias 全集，{n}）": { en: "Requestable models (alias union, {n})" },
  "—（目录源无 alias 数据）": { en: "— (catalog source has no alias data)" },
  "LLM Provider（{n}）": { en: "LLM providers ({n})" },
  "Provider": { en: "Provider" },
  "暂无 AI 路由": { en: "No AI routes" },
  "暂无 Provider": { en: "No providers" },
  "暂无模型网关数据": { en: "No model gateway data" },
  "拓扑": { en: "Topology" },
  "请选择左侧项目": { en: "Select a project on the left" },
  "暂无拓扑数据——本项目可能还在 planning（Coordinator 起草计划中），计划生成后请重试": {
    en: "No topology data yet — this project may still be planning; retry after the plan is generated",
  },
  "外部依赖（非本项目）：{list}": { en: "External dep(s) (outside this project): {list}" },
  "项目任务依赖图": { en: "Project task dependency graph" },
  "依赖已满足（就绪，待开始）": { en: "Ready (dependencies satisfied)" },
  // P2：拓扑详情三区（dashboard WorkflowDetail 同语义）
  "任务分布": { en: "Task distribution" },
  "任务详情（{n}）": { en: "Task details ({n})" },
  "节点（{n}）": { en: "Nodes ({n})" },
  "产物 {a} · 状态转换 {b}": { en: "Deliverables {a} · transitions {b}" },
  "验收": { en: "Acceptance" },
  "Worker": { en: "Worker" },
  "角色": { en: "Role" },
  "模型": { en: "Model" },
  "用户": { en: "User" },
  "显示名": { en: "Display name" },
  "权限": { en: "Permission" },
  "可访问团队": { en: "Accessible teams" },
  "Manager": { en: "Manager" },
  "版本": { en: "Version" },
  "唤醒": { en: "Wake" },
  "休眠": { en: "Sleep" },
  "操作失败": { en: "Action failed" },
  "日志拉取失败": { en: "Failed to fetch logs" },
  "集群状态获取失败": { en: "Failed to fetch cluster status" },
  "暂无状态数据": { en: "No status data" },
  "加载日志中…": { en: "Loading logs…" },
  "（无日志行）": { en: "(no log lines)" },
  "Controller /api/v1/status（L1 视图，dashboard cluster-status 同源）": {
    en: "Controller /api/v1/status (L1 view, same source as dashboard cluster-status)",
  },
  "经 Controller Docker API 代理拉容器日志（dashboard debug-log 同源；需要管理员 token）": {
    en: "Container logs via Controller Docker API proxy (same as dashboard debug-log; admin token required)",
  },
  "刷新日志": { en: "Refresh logs" },
  "成员": { en: "Members" },
  // P8b：房间卡成员列表折叠
  "隐藏成员": { en: "Hide members" },
  "显示成员": { en: "Show members" },
  "@ 提及": { en: "@ Mention" },
  "复制 MXID": { en: "Copy MXID" },
  "隐藏工具": { en: "Hide tools" },
  "显示工具": { en: "Show tools" },
  "隐藏/显示 Agent 工具调用消息（read_file 等）": {
    en: "Show/hide Agent tool-call messages (read_file etc.)",
  },
  "查看成员": { en: "View members" },
  "已滚出历史": { en: "scrolled out of history" },
  "点击定位原消息": { en: "Click to jump to original message" },
  "原消息不在当前加载范围内": { en: "Original message not in loaded range" },
  "发起任务": { en: "New Task" },
  "表情": { en: "Emoji" },
  "文件发送失败": { en: "Failed to send file" },
  "个文件": { en: " file(s)" },
  "附件": { en: "Attachment" },
  "点击预览": { en: "Click to preview" },
  "消息": { en: "Message" },
  // ── 第七批：审批卡 / 产物验收 ──
  "批准": { en: "Approve" },
  "拒绝原因（可选）": { en: "Reason to deny (optional)" },
  "审批请求": { en: "Approval request" },
  "接受": { en: "Accept" },
  "已接受": { en: "Accepted" },
  "修改意见": { en: "Revise" },
  "修改意见…": { en: "Revision notes…" },
  // ── 看板视图──
  "看板": { en: "Board" },
  "待办": { en: "To Do" },
  "已派发": { en: "Assigned" },
  "失败": { en: "Failed" },
  "未知": { en: "Unknown" },
  "依赖 {n} 项": { en: "Depends on {n}" },
  "暂无看板数据——Agent 以 DAG 模式（workflow_run nodes）执行任务后这里会显示任务看板": {
    en: "No board data yet — shown once agents run tasks in DAG mode (workflow_run nodes)",
  },
  // ── workflow 卡片──
  "参与 Worker": { en: "Workers" },
  "执行步骤": { en: "Steps" },
  "等待中": { en: "Waiting" },
  "已暂停": { en: "Paused" },
  "当前推进": { en: "Current" },
  "步骤 {n}": { en: "Step {n}" },
  "点击查看工作流": { en: "Click to open workflow" },
  "controller 正源，15s 轮询": { en: "controller source, 15s poll" },
  // ── 项目文件面板（）──
  "项目文件": { en: "Project files" },
  "结果": { en: "Result" },
  "结果产物": { en: "Result artifact" },
  "任务书": { en: "Spec" },
  "交付物": { en: "Deliverable" },
  "项目文件（任务结果/任务书/交付物，产物端点 产物端点）": {
    en: "Project files (task result/spec/deliverables via 产物端点 artifact API)",
  },
  "项目暂无已声明的文件（任务完成并产出结果后会显示）": {
    en: "No files declared yet — shown after tasks produce results",
  },
  // ── 干预三件套（任务取消 / 项目完成 / 重规划）──
  "完成": {
    en: "Complete",
  },
  "完成项目": {
    en: "Complete Project",
  },
  "确认完成": {
    en: "Confirm",
  },
  "确认将项目标记为已完成？所有任务须已终止（完成/失败/阻塞/取消），否则上游会拒绝。完成后会通知项目群。": {
    en: "Mark this project as completed? All tasks must be in a terminal state (completed/failed/blocked/cancelled), otherwise the Controller will reject it. The project room will be notified.",
  },
  "项目已标记完成": {
    en: "Project marked as completed",
  },
  "完成失败": {
    en: "Complete failed",
  },
  "重规划": {
    en: "Replan",
  },
  "重规划项目（编辑任务 DAG）": {
    en: "Replan Project (edit task DAG)",
  },
  "提交重规划": {
    en: "Submit Replan",
  },
  "已按当前任务预填（不含 status）：保留的 taskId 省略字段将继承旧值，新增任务只需 taskId（可选 title/assignedTo/dependsOn）。重规划后项目通知群内。": {
    en: "Pre-filled from current tasks (no status): kept taskIds inherit their old values for omitted fields; new tasks only need taskId (optional title/assignedTo/dependsOn). The project room will be notified after replanning.",
  },
  "项目已重规划": {
    en: "Project replanned",
  },
  "重规划失败": {
    en: "Replan failed",
  },
  "任务 JSON 解析失败，请检查格式": {
    en: "Task JSON parse failed, please check the format",
  },
  "任务必须是 JSON 数组（[{taskId, ...}]）": {
    en: "Tasks must be a JSON array ([{taskId, ...}])",
  },
  "第 {n} 项缺少 taskId": {
    en: "Item {n} is missing taskId",
  },
  "取消任务": {
    en: "Cancel Task",
  },
  "确认取消": {
    en: "Confirm Cancel",
  },
  "取消将写入项目任务图并通知项目群；依赖此任务的任务将保持阻塞。": {
    en: "The cancel will be written into the project task graph and the project room will be notified. Tasks depending on this one stay blocked.",
  },
  "取消原因（必填，将通知团队）": {
    en: "Cancel reason (required, team will be notified)",
  },
  "任务已取消": {
    en: "Task cancelled",
  },
  "取消任务失败": {
    en: "Cancel task failed",
  },
  "取消此任务（须填原因，不可恢复）": {
    en: "Cancel this task (reason required, not reversible)",
  },
  // ── 工作流排序 / Element 对齐四件 ──
  "按状态": {
    en: "By status",
  },
  "编辑": {
    en: "Edit",
  },
  "撤回": {
    en: "Redact",
  },
  "退出": {
    en: "Leave",
  },
  "退出房间": {
    en: "Leave room",
  },
  "已编辑": {
    en: "edited",
  },
  "已撤回": {
    en: "Redacted",
  },
  "撤回失败": {
    en: "Redact failed",
  },
  "撤回这条消息？其他成员将看到「已撤回」": {
    en: "Redact this message? Other members will see it as redacted",
  },
  "正在编辑这条消息": {
    en: "Editing this message",
  },
  "取消编辑": {
    en: "Cancel edit",
  },
  "编辑消息…（Enter 保存，Shift+Enter 换行，Esc 取消编辑）": {
    en: "Edit message… (Enter to save, Shift+Enter for newline, Esc to cancel)",
  },
  "这条消息已被撤回": {
    en: "This message was redacted",
  },
  "退出房间「{name}」？": {
    en: "Leave room “{name}”?",
  },
  "退出并删除": { en: "Leave & delete" },
  "退出并删除「{name}」？": { en: "Leave and delete \"{name}\"?" },
  "退出并忘记该房间：本地不再保留其历史，列表不再显示。此操作不可撤销。系统团队房间可能被 Controller 调和器自动重新邀请。": { en: "Leave and forget this room: local history is dropped and it no longer appears in the list. This cannot be undone. System team rooms may be re-invited automatically by the Controller reconciler." },
  "已退出并删除房间": { en: "Left and deleted the room" },
  "已退出房间": { en: "Left the room" },
  "退出后不再接收该房间消息。系统团队房间可能被 Controller 调和器自动重新邀请；非系统房间需再次被邀请才能进入。": {
    en: "You will no longer receive messages from this room. System team rooms may be re-invited automatically by the Controller reconciler; other rooms require a new invite to rejoin.",
  },
  "已退出「{name}」": {
    en: "Left “{name}”",
  },
  "退出房间失败": {
    en: "Leave room failed",
  },
  "静音此房间": {
    en: "Mute this room",
  },
  "取消静音": {
    en: "Unmute",
  },
  "已静音该房间（@/任务通知不再推送）": {
    en: "Room muted (no more @/task notifications)",
  },
  "已取消静音": {
    en: "Room unmuted",
  },
  "静音设置失败": {
    en: "Mute setting failed",
  },
};
