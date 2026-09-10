import type * as ReactNS from "react";

const host = window.QwenPaw.host;

/** 双语字典。key 用中文原文（zh 为源语言），en 为英文对照。 */
const DICT: Record<string, { en: string }> = {
  // ── 页面框架 ──
  "团队": { en: "Teams" },
  "工作流": { en: "Workflows" },
  "产物": { en: "Artifacts" },
  "聊天": { en: "Chat" },
  "团队管理": { en: "Team Management" },
  // ── 再版 13（远端团队知识库 / 群名搜索 / 通知跳转 / 首页快捷）──
  "远端团队知识库": { en: "Remote team KB" },
  "本机宿主 Agent": { en: "Local host agent" },
  "读自己团队 Leader/Worker 的远端知识库（只读）": { en: "Read your team leaders'/workers' remote KB (read-only)" },
  "读本机 QwenPaw Agent 的记忆库": { en: "Read this machine's QwenPaw agent memory" },
  "重新检测": { en: "Re-detect" },
  "远端团队知识库不可用，当前为本机宿主知识库": { en: "Remote team KB unavailable; showing local host KB" },
  "远端未找到 Worker 容器（Controller 未接入？）": { en: "No worker containers found (Controller not connected?)" },
  "团队 Agent": { en: "Team agents" },
  "聚合团队": { en: "Aggregate team" },
  "远端 · Controller Docker API 直读容器工作区（只读）": { en: "Remote · read-only via Controller Docker API" },
  "选择 Agent": { en: "Select agent" },
  "评审": { en: "Critic" },
  "容器": { en: "Container" },
  "知识文件": { en: "Knowledge files" },
  "最近更新": { en: "Last updated" },
  "工作区": { en: "Workspace" },
  "该 Agent 暂无知识文件（工作区可能未初始化）": { en: "No knowledge files for this agent (workspace not initialized?)" },
  // 8/29 re16：知识库四分类（对齐 QwenPaw 文件管理）
  "档案（工作区核心文件）": { en: "Profile (core workspace files)" },
  "日记 · {d}": { en: "Diary · {d}" },
  "知识库 · {s}": { en: "Knowledge base · {s}" },
  "文件（工作区其他）": { en: "Files (other workspace)" },
  "顶层": { en: "top-level" },
  "未找到该房间（可能尚未加入）——可先在聊天 tab 列表手动打开": { en: "Room not found (not joined yet?) — open it manually from the chat tab list" },
  // 8/29 re16：房间重命名 + 权限诊断
  "重命名房间": { en: "Rename room" },
  "新房间名": { en: "New room name" },
  "正在读取房间权限…": { en: "Reading room permissions…" },
  "权限不足：你 {a}/{b}（改名需 ≥ {b}）。需房间管理员（Manager）提权。": { en: "Insufficient permission: you have {a}/{b} (renaming needs ≥ {b}). Ask the room admin (Manager) to raise it." },
  "该房间没有有效的权限设置，按默认严格权限执行，无法改名（所有成员均被拒）。Element 的灰色输入框是同一根因，不是 Element 的问题。请管理员修复房间的权限设置后重试。": { en: "This room has no valid power-level settings, so default strict permissions apply and renaming is not possible (all members are rejected). Element's greyed-out input has the same root cause — it is not an Element bug. An admin must repair the room's power-level settings first." },
  "已重命名为「{n}」": { en: "Renamed to \u201c{n}\u201d" },
  "房间名不能为空": { en: "Room name cannot be empty" },
  "改名失败：权限不足": { en: "Rename failed: insufficient permission" },
  "你的权限 {a}/{b}（需 ≥ {b}）——找房间管理员（Manager）在房间内提权后重试。": { en: "Your level {a}/{b} (need ≥ {b}) — ask the room admin (Manager) to raise your power level, then retry." },
  "该房间没有有效的权限设置（平台侧已知问题）。请管理员修复房间的权限设置后重试。": { en: "This room has no valid power-level settings (known platform issue). An admin must repair the room's power-level settings, then retry." },
  "本机 QwenPaw 事件 · 与团队房间通知不同源，多数无房间可跳": { en: "Local QwenPaw events · different source from team room mentions; most have no room to jump to" },
  "点击跳转对应房间": { en: "Click to jump to the room" },
  "本机事件 · 无可跳转房间（点击展开/标记已读）": { en: "Local event · no room to jump to (click to expand / mark read)" },
  // 8/29 re16：Worker 工具执行安全
  "工具执行安全": { en: "Tool execution security" },
  "「{name}」工具执行安全已设为 {lv}（live 生效）": { en: "{name} tool execution security set to {lv} (live)" },
  "设置失败": { en: "Failed to set" },
  "应用": { en: "Apply" },
  "该 Worker 未读到 approval_level（容器布局差异）": { en: "Could not read approval_level for this worker (container layout difference)" },
  "QwenPaw 原生「工具执行安全」四模式（设置页同款）": { en: "QwenPaw native tool execution security — four modes (same as the settings page)" },
  "L2 账号无权限读取（需 L1 管理员凭据；上游 L2 写路径 PR 合并后自动开放）": { en: "L2 account has no read access (L1 admin credentials required; opens automatically once the upstream L2 write-path PR merges)" },
  "配置工具调用的审批策略，控制智能体执行工具时的安全级别": { en: "Configure tool call approval policy to control the security level when agents execute tools" },
  "严格模式": { en: "Strict Mode" },
  "所有工具调用都需要审批，最高安全级别": { en: "All tool calls require approval, highest security level" },
  "智能模式": { en: "Smart Mode" },
  "低风险工具自动放行，中高风险工具需要审批": { en: "Low-risk tools auto-approved, medium+ risk tools require approval" },
  "自动模式": { en: "Auto Mode" },
  "仅被明确标记为需要审批的工具才会要求审批（默认）": { en: "Only tools explicitly marked for approval require approval (default)" },
  "关闭模式": { en: "Off Mode" },
  "关闭所有工具审批，所有工具自动执行": { en: "Disable all tool approvals, all tools execute automatically" },
  "当前模式": { en: "Current mode" },
  "无变更": { en: "No changes" },
  "Worker 配置（审批模式）": { en: "Worker settings (approval mode)" },
  "改名失败": { en: "Rename failed" },
  "远端团队知识库需要 L1（管理员）凭据——配置页填写 Controller 管理员 token 后点「重新检测」。L2 用户没有该 token，此视图不可用（保持本机知识库，或向管理员申请 L1 凭据）": { en: "Remote team KB requires L1 (admin) credentials — fill the Controller admin token on the settings page, then re-detect. L2 users don't have that token; this view is unavailable (keep the local KB or request L1 credentials from the admin)" },
  "未分组": { en: "Ungrouped" },
  "本机宿主 QwenPaw": { en: "Local host QwenPaw" },
  "群 / 会话": { en: "Rooms / Chats" },
  "点击直达": { en: "Click to open" },
  "打开该房间": { en: "Open this room" },
  "搜索消息和群聊": { en: "Search messages & rooms" },
  "房间通知": { en: "Room mentions" },
  "团队房间 @提到你 · 点击跳转对应消息": { en: "Team rooms that @you · click to jump to the message" },
  "房间通知加载失败": { en: "Failed to load room mentions" },
  "暂无 @你 的房间消息": { en: "No room mentions of you yet" },
  "点击跳转对应消息": { en: "Click to jump to the message" },
  "宿主通知": { en: "Host notifications" },
  "全局搜索": { en: "Global search" },
  "搜消息和群聊": { en: "Search messages & rooms" },
  "有 {n} 条通知": { en: "{n} notifications" },
  "审批与房间 @你": { en: "Approvals & room @mentions" },
  "团队知识一屏览": { en: "Team knowledge at a glance" },
  // ── 知识库（W3①，再版 11）──
  "知识库": { en: "Knowledge" },
  "当前 Agent": { en: "Current Agent" },
  "重建索引": { en: "Reindex" },
  "正在重建索引…": { en: "Reindexing…" },
  "自动记忆": { en: "Auto-memory" },
  "开": { en: "on" },
  "关": { en: "off" },
  "每 N 轮": { en: "every N turns" },
  "记忆 worker": { en: "Memory worker" },
  "忙碌": { en: "busy" },
  "停止中": { en: "stopping" },
  "错误": { en: "error" },
  "进程内存": { en: "Process memory" },
  "最近错误": { en: "Last error" },
  "图谱/状态 API 需宿主 2.1.0+（当前 404），仅文件浏览可用": {
    en: "Graph/status API requires host 2.1.0+ (currently 404); file browsing only",
  },
  "知识图谱（wikilink 引用网络）": { en: "Knowledge graph (wikilink network)" },
  "N 节点 · M 边": { en: "N nodes · M edges" },
  "记忆文件": { en: "Memory files" },
  "个人偏好": { en: "Personal" },
  "操作流程": { en: "Procedures" },
  "Wiki 知识": { en: "Wiki" },
  "其他": { en: "Other" },
  "每日记忆": { en: "Daily memory" },
  "点击左侧文件查看内容": { en: "Click a file on the left to preview" },
  "该节点为虚拟根节点，不可打开": { en: "This is a virtual root node and cannot be opened" },
  "节点缺少文件路径，无法打开": { en: "Node has no file path to open" },
  "索引重建失败": { en: "Reindex failed" },
  "确认重建记忆索引？": { en: "Rebuild the memory index?" },
  "会重新扫描当前 Agent 的全部记忆文件（memory/ + digest/）。大库耗时数分钟，期间检索可能不完整。": {
    en: "Rescans all of this agent's memory files (memory/ + digest/). Large libraries take minutes; search may be incomplete meanwhile.",
  },
  "重建": { en: "Rebuild" },
  "索引重建完成": { en: "Reindex completed" },
  "暂无图谱数据": { en: "No graph data" },
  "宿主环境不可用（无法获取当前 Agent）": {
    en: "Host unavailable (cannot resolve current agent)",
  },
  "展开": { en: "Expand" },
  "拖动调整输入框高度": { en: "Drag to resize the input box" },
  "拖动调整产物树宽度": { en: "Drag to resize the artifacts tree" },
  "连通性测试": { en: "Connectivity test" },
  "连通性测试失败": { en: "Connectivity test failed" },
  "生效中": { en: "active" },
  "详情": { en: "Detail" },
  "测试目标": { en: "Target" },
  "分步过程": { en: "Steps" },
  "完整原始异常": { en: "Raw exception" },
  "客户端环境": { en: "Client env" },
  "测试时间": { en: "Tested at" },
  "全部成功（无异常）": { en: "All OK (no exception)" },
  "代理环境变量": { en: "Proxy env" },
  "（未设置）": { en: "(not set)" },
  "逐个地址测延迟（失败重试一次），识别外网/内网，测完自动切到最快；后台按状态自适应重测（稳定时低频、单地址不探测）": {
    en: "Measures latency per address (one retry on failure); auto-switches to the fastest after testing; background re-probes adaptively (low freq when stable, none for single address)",
  },
  "已自动切换到最快可达": { en: "Auto-switched to the fastest reachable" },
  "当前生效地址已是最快，无变化": {
    en: "Current effective address is already the fastest — no change",
  },
  "测的是未保存的地址——保存后自动按延迟切换生效": {
    en: "Tested unsaved addresses — auto-switching by latency takes effect after saving",
  },
  "最后消息": { en: "Last message" },
  "当前只显示你已加入房间的项目": { en: "Only showing projects in rooms you've joined" },
  "——Controller 正源未接通（token 未配置或无效）。配置页填入 controller_token（L1）后可查看全部项目（含 Leader 创建、你不在其房间内的）": {
    en: "— Controller primary source not connected (token missing or invalid). Set controller_token (L1) on the Settings page to see all projects (including Leader-created ones whose room you're not in)",
  },
  "——Controller 未升级到含 workflow API 的版本（404）": {
    en: "— Controller not upgraded to a version with the workflow API (404)",
  },
  "——Controller 正源不可用": { en: "— Controller primary source unavailable" },
  "项目产物（Controller 正源）未接通": {
    en: "Project artifacts (Controller primary source) not connected",
  },
  "——token 未配置或无效。配置页填入 controller_token（L1）后可见全部项目产物（含 Leader 创建、你不在其房间内的）": {
    en: "— token missing or invalid. Set controller_token (L1) on the Settings page to see all project artifacts (including Leader-created ones whose room you're not in)",
  },
  "——Controller 未升级到含项目产物的版本（404），当前只显示房间附件": {
    en: "— Controller not upgraded to a version with project artifacts (404); showing room attachments only",
  },
  "——Controller 请求失败，当前只显示房间附件": {
    en: "— Controller request failed; showing room attachments only",
  },
  "（Controller 的 MinIO 客户端 mc 别名异常——需在 Controller 宿主机重新注册 mc 别名，自检 L2 有指引）": {
    en: "(Controller's MinIO client (mc alias) is broken — re-register the mc alias on the Controller host; see self-check L2)",
  },
  "发起任务 · 选择 Leader": { en: "New Task · Pick a Leader" },
  "选 Leader 派发新任务": { en: "Pick a leader to dispatch a task" },
  "跨团队": { en: "Cross-team" },
  "跨团队入口": { en: "cross-team entry" },
  "未找到 Leader（团队结构未加载或 Controller 未接入）。请先到配置页检查 Controller 连接，再重新打开本弹窗。": {
    en: "No leaders found (team structure not loaded or Controller not connected). Check the Controller connection on the Settings page and reopen this dialog.",
  },
  "已创建私聊，等待对方接受邀请": {
    en: "DM created, waiting for the other side to accept the invite",
  },
  "房间创建返回成功但未出现在房间列表（homeserver 配置可能错位），请检查配置后重试": {
    en: "Room creation reported success but the room is missing from the room list (homeserver config may be misaligned). Check settings and retry.",
  },
  "自动刷新 30 秒": { en: "Auto-refresh 30s" },
  "自动刷新 1 秒": { en: "Auto-refresh 1s" },
  "点击展开": { en: "Click to expand" },
  "私聊 {name}": { en: "DM {name}" },
  "暂无活跃会话——接入 spawn 端点后显示": {
    en: "No active sessions — shown once the spawn endpoint is connected",
  },
  "管理数据加载中——团队/用户/Manager 全量状态": {
    en: "Loading admin data — teams/users/managers",
  },
  "自检": { en: "Self-check" },
  "运维": { en: "Operations" },
  "配置": { en: "Settings" },
  "登录": { en: "Sign in" },
  "刷新": { en: "Refresh" },
  "加载中…": { en: "Loading…" },
  "Worker 状态": { en: "Worker state" },
  "容器状态": { en: "Container state" },
  "团队群（{n}）": { en: "Group chat ({n})" },
  "下次打开插件时先看到哪里": { en: "What you see first when the plugin opens next time" },
  "暂无工作流事件": { en: "No workflow events" },
  "循环任务": { en: "Loop tasks" },
  "已发送 {n} 个文件": { en: "{n} file(s) sent" },
  "保存": { en: "Save" },
  "取消": { en: "Cancel" },
  "返回": { en: "Back" },
  "发送": { en: "Send" },
  "回复": { en: "Reply" },
  "复制": { en: "Copy" },
  "下载": { en: "Download" },
  "预览": { en: "Preview" },
  "收起": { en: "Collapse" },
  "条回复": { en: " replies" },
  "正在输入…": { en: " is typing…" },
  "人": { en: " members" },
  "全部": { en: "All" },
  "私聊": { en: "DMs" },
  "团队房间": { en: "Team Rooms" },
  "当前身份：": { en: "Signed in as: " },
  "还没有加入任何团队房间": { en: "No team rooms joined yet" },
  "点击成员插入 @点名": { en: "Click a member to @mention" },
  "输入消息，@名字 可以点名成员（Enter 发送，Shift+Enter 换行）": {
    en: "Type a message. @name mentions a member (Enter to send, Shift+Enter for newline)",
  },
  "发送回复…（Enter 发送，Shift+Enter 换行，Esc 取消回复）": {
    en: "Send a reply… (Enter to send, Shift+Enter for newline, Esc to cancel)",
  },
  "以下为新消息": { en: "New messages" },
  "加载更早的消息 ↑": { en: "Load earlier messages ↑" },
  "还没有消息，发一条打个招呼吧": { en: "No messages yet — say hi!" },
  "你没有在此房间发送消息的权限": {
    en: "You don't have permission to post to this room",
  },
  "尚未选择房间": { en: "No room selected" },
  "发送失败": { en: "Failed to send" },
  "发送中…": { en: "Sending…" },
  "保存配置": { en: "Save settings" },
  "配置已保存（已自动探测生效地址）": {
    en: "Settings saved (reachable address auto-detected)",
  },
  "保存失败": { en: "Save failed" },
  "登录成功": { en: "Signed in" },
  "登录失败": { en: "Sign-in failed" },
  "Matrix 账号（不含 @ 和域名）": { en: "Matrix username (without @ and domain)" },
  "Matrix 密码": { en: "Matrix password" },
  "内网：http://192.168.x.x:6867": { en: "LAN: http://10.0.0.x:6867" },
  "外网：https://你的域名:6867（可留空）": {
    en: "WAN: https://your-domain:6867 (optional)",
  },
  "内网：http://192.168.x.x:30000": { en: "LAN: http://192.168.x.x:30000" },
  "外网：https://你的域名:30000（可留空）": {
    en: "WAN: https://your-domain:30000 (optional)",
  },
  "Controller 认证（可选）": { en: "Controller auth (optional)" },
  "入职成功": { en: "Onboarded" },
  "暂无团队记录": { en: "No team records yet" },
  "权限管理": { en: "Permissions" },
  "关闭": { en: "Close" },
  "不存在": { en: "not found" },
  "生成命令": { en: "Generate command" },
  "复制命令": { en: "Copy command" },
  "复制失败——请手动全选复制": { en: "Copy failed — select all and copy manually" },
  // ── v0.4.97 再版 4：TruncatedId + 团队访问矩阵 ──
  "点击右侧按钮复制完整 {label}": { en: "Click the button to copy the full {label}" },
  "复制 {label}": { en: "Copy {label}" },
  "团队访问配置（员工 × 团队）": { en: "Team access (employee × team)" },
  "已改动": { en: "changed" },
  "级别": { en: "Level" },
  // ── v0.4.98：Worker Skill/MCP 展示 + 我的团队/权限卡 ──
  "Skill": { en: "Skills" },
  "当前账号": { en: "Current account" },
  // 「L1 管理员」（L457 既有）与「可访问团队」（L342 既有）复用，不重复定义
  "L2 团队成员": { en: "L2 team member" },
  "可访问 Worker": { en: "Accessible workers" },
  "未限定（本团队全部）": { en: "unrestricted (all in team)" },
  "上方团队 = Controller 按你的授权（accessibleTeams）过滤后的可见范围；Worker/权限明细需管理员（L1）视角。": {
    en: "Teams above = what the Controller filtered for your account (accessibleTeams). Worker/permission detail needs the admin (L1) view.",
  },
  "当前账号不在人员列表——尚未入职（onboard）或账号名不匹配": {
    en: "Account not found in the staff list — not onboarded yet, or name mismatch",
  },
  "当前为房间聚合视图（团队数据未接通）——接通后此处显示真实团队范围": {
    en: "Showing room-aggregated view (Controller not connected) — real team scope appears once connected",
  },
  "拓扑树（团队 → Worker → spawn）；点 Worker 行展开管理信息（Worker 状态[CRD] / 容器状态[docker，不一致时标红] / 模型 / 唤醒休眠）与检查点；底部团队/用户/Manager 全量表；自动刷新不闪页（静默+diff）": {
    en: "Topology tree (Team → Worker → spawn). Click a Worker row to expand management info (CRD status / container status [red on mismatch] / model / wake-sleep) and checkpoints; full team/user/Manager tables below; auto-refresh without page flash (silent + diff)",
  },
  "勾选要授予/取消的团队——改动先落本地，点「生成命令」后复制到 Controller 宿主机执行才真正生效（reconcile 约 5 分钟把员工拉入/移出团队房间）。上游 PR P-HUMANS-PUT 合并后此处升级为一键保存。": {
    en: "Check teams to grant/revoke. Changes stay local until you generate the command and run it on the Controller host (reconcile takes ~5 min to move the employee between team rooms). After upstream PR P-HUMANS-PUT merges, this becomes one-click save.",
  },
  "团队成员（workerMembers）——保存 = 全量替换成员列表": { en: "Team members (workerMembers) — saving replaces the whole list" },
  "可访问团队（决定此人被拉入哪些团队房间）": { en: "Accessible teams (decides which team rooms this person is invited to)" },
  "不选任何团队 = 清空列表": { en: "Selecting no teams = clears the list" },
  "不选任何 Worker = 清空列表": { en: "Selecting no workers = clears the list" },
  "在运行 Controller 的宿主机执行；空列表 = 清空。merge-patch 不改 status——初始密码不变。": {
    en: "Run on the host running the Controller; empty list = clear. merge-patch does not touch status — initial password unchanged.",
  },
  "上游 Controller 无 UpdateHuman API（dashboard 的 updateHuman 是死代码）——这里生成「内嵌 apiserver merge-patch」命令，复制到运行 Controller 的宿主机执行。执行完回本页点刷新即可核对生效。上游 PR 候选 P-HUMANS-PUT 合并后此处自动升级为一键 PUT。": {
    en: "The upstream Controller has no UpdateHuman API (the dashboard's updateHuman is dead code) — this generates an embedded-apiserver merge-patch command to run on the host running the Controller. After running it, come back and refresh to verify. Once upstream PR candidate P-HUMANS-PUT merges, this upgrades to one-click PUT automatically.",
  },
  "粘贴服务器端 /var/run/agentteams/cli-token 文件内容（一次性，保存后不再需要）": {
    en: "Paste the server /var/run/agentteams/cli-token file content (one-time, remembered after saving)",
  },
  "Matrix 登录（L2，默认）": { en: "Matrix login (L2, default)" },
  "管理员 token（L1 全量）": { en: "Admin token (L1 full)" },
  "使用当前登录的 Matrix 账号，无需 token。注意：Controller 的 Matrix 认证只接受权限等级 2（level 2）的 Human 账号——level 1 的 admin 账号会 401，请改用管理员 token 模式，或让部署管理员把该 Human 改为 level 2（权限自检可见当前账号等级）。": {
    en: "Uses the logged-in Matrix account, no token needed. Note: the Controller's Matrix auth only accepts Human accounts with permissionLevel=2 — a level-1 admin account gets 401. Use admin-token mode, or ask the deploy admin to set that Human to level 2 (the permission self-check shows the current level).",
  },
  "Controller 地址（可选——全量团队视图才需要）": {
    en: "Controller URL (optional — needed for full team view)",
  },
  // ── 0.4.99（首页身份行：Controller 视图级别）──
  "Controller L1 全量": { en: "Controller L1 full" },
  // ── 0.4.99（B3 房间收藏，客户端本地）──
  "收藏（{n}）": { en: "Favourites ({n})" },
  // ── 0.4.99（B1 知识库深化：聚合图谱 / 跨 Worker 搜索）──
  "当前 Agent 图谱": { en: "Current agent graph" },
  "团队聚合图谱": { en: "Team merged graph" },
  "搜索团队知识（跨 Worker）…": { en: "Search team knowledge (cross-worker)…" },
  "团队知识搜索": { en: "Team knowledge search" },
  "（匹配 {count} 条）": { en: "({count} matches)" },
  "收藏到顶部": { en: "Pin to top" },
  "取消收藏": { en: "Unpin" },
  "Controller L2 授权范围": { en: "Controller L2 (authorized scope)" },
  "Controller 未接入": { en: "Controller not connected" },
  "导出配置（脱敏）": { en: "Export config (redacted)" },
  "导入配置": { en: "Import config" },
  "导出诊断包": { en: "Export diagnostics" },
  "配置迁移与诊断": { en: "Config & diagnostics" },
  "配置已导入": { en: "Config imported" },
  "导入失败（JSON 格式错误？）": { en: "Import failed (invalid JSON?)" },
  "团队产物": { en: "Team Artifacts" },
  "房间附件": { en: "Room Attachments" },
  "全部房间": { en: "All rooms" },
  "搜索": { en: "Search" },
  "搜索消息": { en: "Search messages" },
  "当前房间": { en: "this room" },
  "输入关键词搜索当前房间历史消息": { en: "Search this room's history" },
  "搜索当前房间历史消息": { en: "Search room history" },
  "搜索失败": { en: "Search failed" },
  "无搜索结果": { en: "No results" },
  "匹配 {count} 条": { en: "{count} matches" },
  "加载更多": { en: "Load more" },
  "上下文预览": { en: "Context" },
  "定位到聊天": { en: "Jump to chat" },
  "打开房间并定位": { en: "Open room and jump" },
  "定位消息并查看上下文": { en: "Jump and view context" },
  "上下文不可用": { en: "Context unavailable" },
  "搜索定位": { en: "Search jump" },
  "目标消息不在已加载范围，显示前后文片段": {
    en: "Message not in loaded range — showing context snippet",
  },
  "通知中心": { en: "Notification Center" },
  "通知": { en: "Inbox" },
  "未读": { en: "Unread" },
  "全部已读": { en: "Mark all read" },
  "暂无通知": { en: "No notifications" },
  "没有未读通知": { en: "No unread notifications" },
  "有 {n} 条工具调用待审批": { en: "{n} tool calls pending approval" },
  "去首页审批": { en: "Review on home" },
  "删除": { en: "Delete" },
  "成员详情": { en: "Member details" },
  "最近消息": { en: "Recent messages" },
  "暂无消息": { en: "No messages" },
  "图片": { en: "Images" },
  "来源房间": { en: "Room" },
  "发送者": { en: "Sender" },
  "时间": { en: "Time" },
  "大小": { en: "Size" },
  "操作": { en: "Actions" },
  "集群状态": { en: "Cluster status" },
  "组件日志": { en: "Component logs" },
  "自动滚动": { en: "Auto-scroll" },
  "暂停": { en: "Pause" },
  "恢复": { en: "Resume" },
  "暂停项目": { en: "Pause project" },
  "确认暂停": { en: "Confirm pause" },
  "项目已暂停": { en: "Project paused" },
  "项目已恢复": { en: "Project resumed" },
  "暂停失败": { en: "Failed to pause" },
  "恢复失败": { en: "Failed to resume" },
  "时间线": { en: "Timeline" },
  "干预前快照": { en: "Pre-intervention snapshot" },
  "暂无干预记录": { en: "No interventions yet" },
  "时间线加载失败": { en: "Failed to load timeline" },
  "快照加载失败": { en: "Failed to load snapshot" },
  "标题": { en: "Title" },
  "操作人": { en: "By" },
  "操作时间": { en: "At" },
  "暂停原因": { en: "Pause reason" },
  "任务数": { en: "Tasks" },
  "检查点": { en: "Checkpoints" },
  "该 Worker 需 QwenPaw 2.1 才有检查点": {
    en: "This worker needs QwenPaw 2.1 for checkpoints",
  },
  "检查点加载失败": { en: "Failed to load checkpoints" },
  "自动打点开": { en: "Auto on" },
  "自动打点关": { en: "Auto off" },
  "暂无打点": { en: "No checkpoints yet" },
  "自动": { en: "Auto" },
  "快照": { en: "Snap" },
  "恢复点": { en: "Safety" },
  "Controller 升级后自动生效": {
    en: "Active after the Controller is upgraded",
  },
  "暂停原因（可选，将通知团队）": {
    en: "Pause reason (optional, notified to the team)",
  },
  "仅错误": { en: "Errors only" },
  "状态": { en: "Status" },
  "文件": { en: "File" },
  "来源": { en: "Source" },
  "类型": { en: "Type" },
  // ── 第二批：产物页 / 运维 / 管理 / 工作流 / 树 ──
  "项目产物": { en: "Project Artifacts" },
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
  "协调者": { en: "Coordinator" },
  "步骤": { en: "Steps" },
  "任务": { en: "Task" },
  "未命名任务": { en: "Untitled task" },
  "暂无工作流事件——Agent 执行任务时会在这里聚合": {
    en: "No workflow events — they aggregate here as Agents work",
  },
  "暂无拓扑数据——Agent 以 DAG 模式（workflow_run nodes）执行任务后这里会显示依赖树": {
    en: "No topology data — the dependency tree appears after Agents run DAG-mode tasks (workflow_run nodes)",
  },
  "已有 {n} 个项目，但任务图（nodes）全空——多为 planning 状态：项目刚建、任务在群聊 @mention 协调，未登记进 Controller 的任务 DAG": {
    en: "{n} project(s) listed but the task graph (nodes) is empty — usually planning state: tasks are coordinated via @mentions in the room, not yet registered in the Controller DAG",
  },
  "事件": { en: "Events" },
  "卡片": { en: "Cards" },
  "拓扑": { en: "Topology" },
  "节点依赖成环或无根节点，无法渲染树形（请检查 nodes dependsOn）": {
    en: "Circular dependencies or no root node — cannot render tree (check nodes dependsOn)",
  },
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
  // ── 第三批：线程面板 / 动画相关 ──
  "话题": { en: "Thread" },
  "回复此话题…（Enter 发送，Shift+Enter 换行）": {
    en: "Reply to thread… (Enter to send, Shift+Enter for newline)",
  },
  "暂无回复": { en: "No replies yet" },
  "关闭话题": { en: "Close thread" },
  "查看": { en: "View" },
  "查看中": { en: "Viewing" },
  "跳转到原消息": { en: "Jump to original message" },
  // ── 第四批：工具调用/审批/通知/日期/树 ──
  "今天": { en: "Today" },
  "昨天": { en: "Yesterday" },
  "周日": { en: "Sun" },
  "周一": { en: "Mon" },
  "周二": { en: "Tue" },
  "周三": { en: "Wed" },
  "周四": { en: "Thu" },
  "周五": { en: "Fri" },
  "周六": { en: "Sat" },
  "{y}年{m}月{d}日": { en: "{y}-{m}-{d}" },
  "工具调用": { en: "Tool call" },
  "工具调用审批": { en: "Tool approval" },
  "工具调用需要审批": { en: "Tool call needs approval" },
  "已批准": { en: "Approved" },
  "已拒绝": { en: "Denied" },
  "拒绝": { en: "Deny" },
  "已复制": { en: "Copied" },
  "提及": { en: "Mention" },
  "发送文件/图片": { en: "Send file/image" },
  "取消回复": { en: "Cancel reply" },
  "点击展开工具调用详情": { en: "Click to expand tool-call details" },
  "展开全文（{kb} KB）↓": { en: "Show full text ({kb} KB) ↓" },
  "领": { en: "L" },
  "工": { en: "W" },
  "审": { en: "C" },
  "待命": { en: "Idle" },
  "进行中": { en: "Running" },
  "已完成": { en: "Done" },
  "未获取到团队数据——检查 Controller 地址与 token": {
    en: "No team data — check the Controller address and token",
  },
  "暂未发现团队房间——加入团队房间后这里显示你的团队结构": {
    en: "No team rooms found — join a team room to see your team structure here",
  },
  // ── 第五批：WorkbenchPage 提示 / 设置 / 自检 ──
  "导出失败": { en: "Export failed" },
  "诊断包导出失败": { en: "Failed to export diagnostics" },
  "先填写 Matrix 账号和密码": { en: "Fill in Matrix username and password first" },
  "当前": { en: "Active" },
  "内网：http://192.168.x.x:8090（可留空）": { en: "LAN: http://10.0.0.x:8090 (optional)" },
  "外网：https://你的域名:8090（可留空）": { en: "WAN: https://your-domain:8090 (optional)" },
  "自检失败": { en: "Self-check failed" },
  "获取房间列表失败": { en: "Failed to fetch rooms" },
  "获取团队结构失败": { en: "Failed to fetch team structure" },
  "获取消息失败": { en: "Failed to fetch messages" },
  "加载更早消息失败": { en: "Failed to load earlier messages" },
  "反应发送失败": { en: "Failed to send reaction" },
  "打开已有私聊": { en: "Open existing DM" },
  "已创建与 {target} 的私聊": { en: "Created DM with {target}" },
  "打开私聊失败": { en: "Failed to open DM" },
  "获取工作流失败": { en: "Failed to fetch workflows" },
  "获取管理视图失败": { en: "Failed to fetch admin view" },
  "点击进入配置页": { en: "Click to open settings" },
  "无回复": { en: "No reply" },
  "该房间历史暂时无法加载——可能是房间已失效，也可能是权限或服务端问题。可返回聊天页换其他房间。": {
    en: "This room's history cannot be loaded right now — the room may be gone, or it may be a permission/server issue. Go back to the chat page and try another room.",
  },
  "L1 管理员": { en: "L1 Admin" },
  "唤醒 {name}": { en: "Wake {name}" },
  "休眠 {name}（释放算力）": { en: "Sleep {name} (free resources)" },
  "{name} 已唤醒": { en: "{name} woken" },
  "{name} 已休眠": { en: "{name} slept" },
  "团队（{n}）": { en: "Teams ({n})" },
  "用户（{n}）": { en: "Users ({n})" },
  // ── 第七批：审批卡 / 产物验收 ──
  "批准": { en: "Approve" },
  "拒绝原因（可选）": { en: "Reason to deny (optional)" },
  "审批请求": { en: "Approval request" },
  "接受": { en: "Accept" },
  "已接受": { en: "Accepted" },
  "修改意见": { en: "Revise" },
  "修改意见…": { en: "Revision notes…" },
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
  "暂无工作流数据": { en: "No workflow data" },
  "共 {n} 条工作流": { en: "{n} workflows" },
  "暂无 Worker 数据": { en: "No worker data" },
  "共 {n} 个团队": { en: "{n} teams" },
  "个产物": { en: "artifacts" },
  "最近动态": { en: "Recent Activity" },
  "暂无房间消息": { en: "No room messages" },
  "（非文本消息）": { en: "(non-text message)" },
  "运行 {a} · 排队 {b}": { en: "Running {a} · Queued {b}" },
  "启动页": { en: "Startup Page" },
  "上次打开的页面": { en: "Last opened page" },
  "待审批": { en: "Pending Approvals" },
  "暂无待审批请求": { en: "No pending approvals" },
  "空闲": { en: "Idle" },
  "排队": { en: "Queued" },
  "运行": { en: "Running" },
  "运行中": { en: "Active" },
  "吞吐": { en: "Throughput" },
  "暂无负载数据": { en: "No load data" },
  "显存：权重 {a}G · KV {b}G · 图 {c}G": { en: "VRAM: weights {a}G · KV {b}G · graph {c}G" },
  "更新于 {time}": { en: "Updated at {time}" },
  "SGLang {v} · 每 rank {n} 卡": { en: "SGLang {v} · {n} GPU(s) per rank" },
  "KV 占用": { en: "KV usage" },
  "自动刷新 15 秒": { en: "Auto-refresh 15s" },
  "{n} 行 · 更新于 {time}": { en: "{n} lines · updated at {time}" },
  "拖动调整宽度": { en: "Drag to resize" },
  // ── 看板视图（8/18 批次 1）──
  "看板": { en: "Board" },
  "待办": { en: "To Do" },
  "已派发": { en: "Assigned" },
  "失败": { en: "Failed" },
  "未知": { en: "Unknown" },
  "依赖 {n} 项": { en: "Depends on {n}" },
  "暂无看板数据——Agent 以 DAG 模式（workflow_run nodes）执行任务后这里会显示任务看板": {
    en: "No board data yet — shown once agents run tasks in DAG mode (workflow_run nodes)",
  },
  "事件/卡片/看板/树状拓扑四种视图；看板列映射与 dashboard 任务看板同源（workflow API）": {
    en: "Four views: events / cards / board / topo tree; board column mapping uses the same workflow API as the dashboard task board",
  },
  // ── workflow 卡片（8/18 批次 2）──
  "参与 Worker": { en: "Workers" },
  "执行步骤": { en: "Steps" },
  "等待中": { en: "Waiting" },
  "已暂停": { en: "Paused" },
  "当前推进": { en: "Current" },
  "步骤 {n}": { en: "Step {n}" },
  "点击查看工作流": { en: "Click to open workflow" },
  // ── 项目文件面板（8/18 批次 2，O19 版）──
  "项目文件": { en: "Project files" },
  "结果": { en: "Result" },
  "任务书": { en: "Spec" },
  "交付物": { en: "Deliverable" },
  "项目文件（任务结果/任务书/交付物，O19 产物端点）": {
    en: "Project files (task result/spec/deliverables via O19 artifact API)",
  },
  "该房间暂无关联项目——项目群里出现任务后，这里会显示任务文件（结果/任务书/交付物）": {
    en: "No linked project in this room yet — task files (result/spec/deliverables) appear once tasks show up",
  },
  "项目暂无已声明的文件（任务完成并产出结果后会显示）": {
    en: "No files declared yet — shown after tasks produce results",
  },
  "部分项目文件加载失败": { en: "Some project files failed to load" },
  // ── 已读回执（8/18 批次 1）──
  "未找到该消息的上下文——可手动加载更早消息后重试": {
    en: "No context found for this message — try loading earlier messages and retry",
  },
  "定位失败——原消息上下文拉取出错，可手动加载更早消息后重试": {
    en: "Locating failed — error fetching the original message context; try loading earlier messages and retry",
  },
  "去房间": { en: "Open room" },
  "一键全部已读（m.read + m.fully_read 双写，清 Element 侧未读）": {
    en: "Mark all rooms read (dual write m.read + m.fully_read, clears Element unread)",
  },
  // ── v0.4.97: CRD 管理（L1）+ L2 room-fallback 警示 ──
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
  // 9/3：团队配置内联编辑 Worker 模型
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
  // ── v0.4.98 再版 7：干预三件套（任务取消 / 项目完成 / 重规划）──
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
  // ── v0.4.98 再版 9：工作流排序 / Element 对齐四件 ──
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
  // ── v0.4.98 再版 8：邀请区（Element 同款接受/拒绝入群）──
  "邀请（{n}）": {
    en: "Invites ({n})",
  },
  "邀请人：": {
    en: "Invited by: ",
  },
  "已接受邀请，正在进入房间列表": {
    en: "Invite accepted, entering the room list",
  },
  "已拒绝邀请": {
    en: "Invite declined",
  },
  "接受邀请失败": {
    en: "Accept invite failed",
  },
  "拒绝邀请失败": {
    en: "Decline invite failed",
  },
  "拒绝邀请「{name}」？（系统团队房间可能被 Controller 调和器自动重新邀请）": {
    en: "Decline the invite to “{name}”? (System team rooms may be re-invited automatically by the Controller reconciler)",
  },
  // 8/30 re18：知识图谱对齐 QwenPaw 最新版（三级配色 + 详情面板）
  "分类根": { en: "Category root" },
  "根邻接": { en: "Root-adjacent" },
  "引用方向": { en: "Reference direction" },
  "点击节点查看详情；根=分类，大小=链接度": {
    en: "Click a node for details; root = category, size = degree",
  },
  // 5.0.0-beta.2：对齐 QwenPaw 知识图谱详情面板命名（开源移植，
  // 见 THIRD-PARTY-NOTICES.md）
  "已索引文件": { en: "Indexed file" },
  "未解析链接": { en: "Unresolved link" },
  "打开 Markdown": { en: "Open Markdown" },
  "出链 · {n}": { en: "Outbound · {n}" },
  "入链 · {n}": { en: "Incoming · {n}" },
  "未解析引用（对应文件不存在）": { en: "Unresolved reference (file not found)" },
  // 8/30 re18：技能 tab（宿主 Agent，参考 QwenPaw SkillPool）
  "管理当前 QwenPaw 宿主 Agent（你正在对话的本机助手）的技能，改动即时生效": {
    en: "Manage skills of the current QwenPaw host agent (the local assistant you chat with); changes apply immediately",
  },
  "远端团队 Worker 技能只读展示见「Worker 管理」tab；团队侧技能上传/应用 = M33 功能线（待上游 PR）": {
    en: "Remote team worker skills are read-only in the Team Management tab; team-side skill upload/apply = M33 feature line (upstream PR pending)",
  },
  "重新扫描": { en: "Rescan" },
  "上传技能（zip）": { en: "Upload skill (zip)" },
  "新建技能": { en: "New skill" },
  "共 {n} 个技能（{e} 个启用）": { en: "{n} skills ({e} enabled)" },
  "请先禁用技能再删除": { en: "Disable the skill before deleting" },
  "上传成功（导入 {n} 个技能）": { en: "Uploaded ({n} skill(s) imported)" },
  "存在命名冲突，已按建议名导入": {
    en: "Name conflict detected; imported under suggested name",
  },
  "上传失败": { en: "Upload failed" },
  "技能名与 SKILL.md 内容均必填": {
    en: "Skill name and SKILL.md content are both required",
  },
  "新建技能成功：{n}": { en: "Skill created: {n}" },
  "已重新扫描": { en: "Rescanned" },
  "暂无技能（可上传 zip 或新建）": {
    en: "No skills yet (upload a zip or create one)",
  },
  "（无描述）": { en: "(no description)" },
  "查看详情": { en: "Details" },
  "删除技能「{name}」？（仅已禁用可删）": {
    en: "Delete skill “{name}”? (only disabled skills can be deleted)",
  },
  "安装来源": { en: "Installed from" },
  "适用通道": { en: "Channels" },
  "更新时间": { en: "Updated" },
  "创建后立即启用": { en: "Enable immediately after creation" },
  "创建": { en: "Create" },
  "技能已删除": { en: "Skill deleted" },
  "技能名（= 目录名，小写字母/数字/连字符）": {
    en: "Skill name (= directory name, lowercase letters/digits/hyphens)",
  },
  "SKILL.md 全文（YAML frontmatter + 正文）": {
    en: "Full SKILL.md (YAML frontmatter + body)",
  },
  "SKILL.md": { en: "SKILL.md" },
  // 8/30 re18：DirNode 目录树（压缩前批次遗留补登记）
  "工作区目录（点文件夹展开）": {
    en: "Workspace directories (click a folder to expand)",
  },
  "空目录": { en: "Empty directory" },
  // 8/30 re18b：3D 知识图谱（3d-force-graph + three.js，MIT 引用见
  // THIRD-PARTY-NOTICES.md）
  "自动旋转": { en: "Auto-rotate" },
  "适配视图": { en: "Fit view" },
  "回到 2D": { en: "Back to 2D" },
  "3D 布局计算中…": { en: "Computing 3D layout…" },
  "拖拽旋转 · 滚轮缩放 · 右键平移 · 点节点选中（邻接高亮）· 点空白取消": {
    en: "Drag to rotate · Wheel to zoom · Right-drag to pan · Click node to select · Click empty to clear",
  },
  "引擎：{e}": { en: "Engine: {e}" },
  "当前浏览器/设备不支持 WebGL，3D 图谱不可用": {
    en: "WebGL not supported by this browser/device; 3D graph unavailable",
  },
  "已自动保留 2D 图谱视图": { en: "The 2D graph view is kept automatically" },
  "3D 图谱初始化失败，已回退 2D": {
    en: "3D graph initialization failed; fell back to 2D",
  },
  // ── v0.5.0-beta.10（建团事故 G1-G5 修复 + 邀请/审批主动通知）──
  // 模型写前校验（G2）
  "模型名不能是路径/URL 或含空格（如 /models——9/2 事故值）": {
    en: "Model name cannot be a path/URL or contain spaces (e.g. /models — the 9/2 incident value)",
  },
  "不在在服列表（可用：{list}）": {
    en: "Not in the serving list (available: {list})",
  },
  "在服模型列表不可用（SGLang 未启用且无在服 Worker）：未校验，创建后须人工确认": {
    en: "Serving model list unavailable (SGLang disabled and no in-service workers): unverified, confirm manually after creation",
  },
  "留空=不改 / 新建跟随集群默认": {
    en: "Empty = no change / new follows cluster default",
  },
  "命中在服模型": { en: "Matches a serving model" },
  "模型校验不通过：{list}": { en: "Model validation failed: {list}" },
  "部分模型未命中在服列表": { en: "Some models not in the serving list" },
  "模型未命中在服列表": { en: "Model not in the serving list" },
  "仍要继续创建吗？": { en: "Continue creating anyway?" },
  "继续创建": { en: "Continue creating" },
  "仍要保存吗？": { en: "Save anyway?" },
  "确认强写": { en: "Force write" },
  "返回修改": { en: "Go back" },
  "✗ 路径形态": { en: "✗ path-like" },
  "⚠ 未命中": { en: "⚠ not matched" },
  "选择 Worker（已有 CR）": { en: "Select worker (existing CR)" },
  "模型（留空=跟随集群默认；下拉=在服模型∪在用模型）": {
    en: "Model (empty = cluster default; dropdown = serving ∪ in-use)",
  },
  "模型（留空=不改；新建跟随集群默认；下拉=在服∪在用）": {
    en: "Model (empty = keep; new follows cluster default; dropdown = serving ∪ in-use)",
  },
  "模型（留空=不改；下拉=在服∪在用模型，provider 不变）": {
    en: "Model (empty = keep; dropdown = serving ∪ in-use, provider unchanged)",
  },
  // SOUL 富入口（G4）
  "SOUL（可选，多行；📎 可上传 .md/.txt，worker≤150 行）": {
    en: "SOUL (optional, multi-line; 📎 upload .md/.txt, worker ≤150 lines)",
  },
  "上传 SOUL 文件": { en: "Upload SOUL file" },
  "SOUL 文件过大（>200KB），已忽略": {
    en: "SOUL file too large (>200KB), ignored",
  },
  "SOUL {n} 行，超出预算 {b} 行（team_leader≤250 / worker≤150）——已填入，请自行裁剪": {
    en: "SOUL has {n} lines, over the {b}-line budget (team_leader ≤250 / worker ≤150) — filled in, trim it yourself",
  },
  "SOUL 文件读取失败": { en: "Failed to read SOUL file" },
  "SOUL（可选，多行/上传）": { en: "SOUL (optional, multi-line/upload)" },
  "SOUL 全文（写入 spec.soul；预算 team_leader≤250 / worker≤150 行）": {
    en: "SOUL full text (written to spec.soul; budget team_leader ≤250 / worker ≤150 lines)",
  },
  "Worker 已创建并加入团队成员——未配模型（跟随集群默认），请在创建自检页确认": {
    en: "Worker created and added — no model set (follows cluster default); confirm in the creation self-check",
  },
  // 创建自检（G3）
  "创建自检": { en: "Creation self-check" },
  "进行中（5s 轮询，最长 3 分钟）": {
    en: "Running (5s poll, up to 3 min)",
  },
  "重新检查": { en: "Re-check" },
  "无显式模型（跟随集群默认；若集群无默认，该 Worker 无模型）": {
    en: "No explicit model (follows cluster default; if the cluster has none, this worker has no model)",
  },
  "等待调和": { en: "pending reconcile" },
  "当前版本暂不支持（插件无网关 key 通道，待上游 API）": {
    en: "Not supported in this version (plugin has no gateway key channel; upstream API pending)",
  },
  "当前版本暂不支持（无容器通道；创建后请到团队房间发一条消息验证 Worker 应答）": {
    en: "Not supported in this version (no container channel; after creation, send a message in the team room to verify the worker responds)",
  },
  // MCP 展示说明（G5）
  "无用户自定义 MCP · 内置 teamharness/workerflow 由容器启动时自动注册，不在此列表": {
    en: "No user-defined MCP · built-in teamharness/workerflow auto-register at container boot and never appear in this list",
  },
  // 邀请主动通知（问题 2）
  "新房间邀请 · 点击到团队概览接受/拒绝": {
    en: "New room invite · click to accept/decline in Team Overview",
  },
  "点击处理邀请": { en: "Click to handle the invite" },
  "去处理": { en: "Handle" },
  // 审批主动通知（问题 3）
  "待审批请求（{n}）": { en: "Pending approval requests ({n})" },
  "Worker 受控工具调用 · 一键批准/拒绝或去房间": {
    en: "Guarded worker tool calls · one-click approve/deny or go to room",
  },
  "待审批请求加载失败": { en: "Failed to load pending approval requests" },
  "暂无待审批的工具调用": { en: "No pending tool approvals" },
  "已发送批准命令（Worker 继续执行）": {
    en: "Approve command sent (worker will continue)",
  },
  "已发送拒绝命令": { en: "Deny command sent" },
  // v0.5.0-beta.10 再版 2：审批命令带 @Worker
  "将发送 @{name} {cmd}": { en: "Will send @{name} {cmd}" },
  "审批消息缺少发送者，无法定向 @，请去房间手动处理": {
    en: "Approval message has no sender to @ — handle it in the room",
  },
  "Worker 请求审批时会桌面通知提醒": {
    en: "You'll get a desktop notification when a worker needs approval",
  },
  // ── v0.5.0-beta.11：技能中心 + 频道接入 + 宿主技能更名 ──
  "Controller 频道代理端点（PR #1219，review 中）尚未合并/Controller 尚未升级，当前版本无此 API。合并并升级后本节自动点亮（schema 驱动表单，零 per-channel 代码）。": { en: "The Controller channel proxy endpoints (PR #1219, in review) are not merged / the Controller is not upgraded yet, so this version has no such API. This section activates automatically after merge + upgrade (schema-driven forms, zero per-channel code)." },
  "Worker 列表加载失败：{m}": { en: "Failed to load worker list: {m}" },
  "name（必填）": { en: "name (required)" },
  "transport（http/sse）": { en: "transport (http/sse)" },
  "{w} 的 MCP 已保存": { en: "MCP of {w} saved" },
  "{w} 的技能已保存": { en: "Skills of {w} saved" },
  "① 技能目录（只读 · 上游 /api/v1/skills）": { en: "① Skill catalog (read-only · upstream /api/v1/skills)" },
  "② Worker 技能分配矩阵（L1 可写 · PUT 合并语义 · skills 整字段替换）": { en: "② Worker skill matrix (L1 writable · PUT merge semantics · skills full-field replace)" },
  "③ MCP Servers（L1 可写 · PUT 合并语义 · mcpServers 整字段替换）": { en: "③ MCP Servers (L1 writable · PUT merge semantics · mcpServers full-field replace)" },
  "二维码已失效，请重新生成": { en: "QR code expired, please regenerate" },
  "仍要保存": { en: "Save anyway" },
  "使用方 {n}": { en: "Used by {n}" },
  "保存（热加载）": { en: "Save (hot reload)" },
  "停用": { en: "Disable" },
  "健康": { en: "Healthy" },
  "健康检查": { en: "Health check" },
  "前缀：{p}": { en: "Prefix: {p}" },
  "加字段": { en: "Add field" },
  "加载失败": { en: "Failed to load" },
  "启用": { en: "Enable" },
  "团队技能/MCP 的统一管理面：技能目录（只读）+ Worker 技能分配矩阵 + MCP Servers。L1（admin）可写；L2/Leader 写操作被 Controller 拒绝（403/404）时明确提示。频道接入见「团队管理 → 频道」。": { en: "Unified management for team skills/MCP: skill catalog (read-only) + worker skill matrix + MCP Servers. L1 (admin) can write; L2/Leader writes rejected by Controller (403/404) with explicit notice. Channel access: Team Management → Channels." },
  "团队技能与 MCP 矩阵": { en: "Team skills & MCP matrix" },
  "字段值": { en: "Field value" },
  "字段名": { en: "Field name" },
  "宿主技能": { en: "Host Skills" },
  "已保存（热加载，立即生效）": { en: "Saved (hot-reloaded, effective immediately)" },
  "已保存，但读回校验不一致（push_loop 收敛中，稍后自动一致）": { en: "Saved, but read-back mismatch (push_loop converging, will match shortly)" },
  "已启用": { en: "Enabled" },
  "异常": { en: "Unhealthy" },
  "扫码授权成功，凭据已回填（保存后生效）": { en: "QR auth succeeded, credentials filled in (effective after save)" },
  "扫码授权（如支持）": { en: "QR auth (if supported)" },
  "技能中心": { en: "Skill Center" },
  // v0.5.0-beta.11 再版 2：技能中心防刷屏（空 Worker 行默认收起）
  "已隐藏 {n} 个未分配技能的 Worker": { en: "Hidden {n} worker(s) without skills" },
  "显示 {n} 个未分配技能的 Worker": { en: "Show {n} worker(s) without skills" },
  "已隐藏 {n} 个无 MCP 的 Worker": { en: "Hidden {n} worker(s) without MCP" },
  "显示 {n} 个无 MCP 的 Worker": { en: "Show {n} worker(s) without MCP" },
  "技能目录 API 待上游合并": { en: "Skill catalog API awaiting upstream merge" },
  "技能目录 API 待上游合并（PR #1211，draft）——合并并升级后本节自动点亮": { en: "Skill catalog API awaiting upstream merge (PR #1211, draft) — activates after merge + upgrade" },
  "技能目录加载失败：{m}": { en: "Failed to load skill catalog: {m}" },
  "搜索名称/描述": { en: "Search name/description" },
  "无 MCP": { en: "No MCP" },
  "无 Worker": { en: "No workers" },
  "无 Worker（admin token 未配置？）": { en: "No workers (admin token not configured?)" },
  "无匹配技能": { en: "No matching skills" },
  "无权限修改该 Worker 的 MCP（当前角色被 Controller 拒绝）": { en: "No permission to modify this worker's MCP (rejected by Controller for current role)" },
  "无权限修改该 Worker 的技能（当前角色被 Controller 拒绝；L2 自服务仅白名单字段，且 #1212 未合时 L2 全部拒绝）": { en: "No permission to modify this worker's skills (rejected by Controller for current role; L2 self-service is whitelist-only, and all L2 writes are denied until #1212 merges)" },
  "无频道配置": { en: "No channel config" },
  "未启用": { en: "Disabled" },
  "未配置": { en: "Not configured" },
  "检测到频道冲突": { en: "Channel conflict detected" },
  "消息前缀 bot_prefix": { en: "Message prefix bot_prefix" },
  "添加 MCP": { en: "Add MCP" },
  "用手机扫码授权，成功后凭据自动回填": { en: "Scan with phone to authorize; credentials auto-fill on success" },
  "相同凭据可能正被其他 Agent 使用（保存后对方可能被踢出，如 QQ 双 AppID）。仍要保存？": { en: "The same credentials may be used by another agent (saving may kick them out, e.g. QQ dual AppID). Save anyway?" },
  "编辑 MCP Servers：{w}": { en: "Edit MCP Servers: {w}" },
  "编辑频道": { en: "Edit channel" },
  "获取二维码失败": { en: "Failed to get QR code" },
  "该频道不支持二维码授权": { en: "This channel does not support QR auth" },
  "读回校验一致": { en: "Read-back verified" },
  "读回校验不一致": { en: "Read-back mismatch" },
  "读回校验不可用": { en: "Read-back unavailable" },
  "重启失败": { en: "Restart failed" },
  "重启频道": { en: "Restart channel" },
  "频道": { en: "Channels" },
  "频道已重启": { en: "Channel restarted" },
  "频道接入 API 待上游合并": { en: "Channel API awaiting upstream merge" },
  "（留空=不带前缀）": { en: "(leave empty = no prefix)" },

  // ── v0.5.0-beta.12：L1 二选一（admin 账号密码 / token）+ 网关 alias + 运行时 ──
  "L1 凭据两种方式（二选一）：": { en: "Two L1 credential methods (either/or):" },
  /* v0.5.0-beta.12（9/10 装验「检查还有没有 controller 和 Higress 混淆的」）：
     术语纠偏——「Controller 数据面」是 Higress 的平面词汇误用到 Controller 上
     （Controller 只有管理 API，没有数据面；数据面=Higress 6867）；「Console
     会话」补 Higress 前缀防与 QwenPaw console 混淆。 */
  "① Controller 管理员 token——Controller 管理 API 全量（CRD 管理/全量视图）；部署管理员提供，粘贴一次永久记住；": { en: "① Controller admin token — full Controller admin API (CRD management / full views); provided by the deployment admin, paste once and it is remembered forever;" },
  "② admin 账号+密码——验证身份并持有 Higress Console 会话（Higress 面模型 alias 可用）；Controller 管理 API 仍需①。": { en: "② admin account + password — verifies identity and holds a Higress Console session (Higress-side model aliases become available); the Controller admin API still needs ①." },
  "① Controller 管理员 token": { en: "① Controller admin token" },
  "② admin 账号+密码（Higress 面）": { en: "② Admin account + password (Higress side)" },
  "admin 账号（如 admin）": { en: "admin account (e.g. admin)" },
  "admin 密码（留空=保持现有）": { en: "admin password (empty = keep existing)" },
  "验证": { en: "Verify" },
  "验证通过（{mode}）": { en: "Verified ({mode})" },
  "admin 账号密码（Higress Console 会话已持有）": { en: "admin account + password (Higress Console session held)" },
  "管理员 token": { en: "admin token" },
  "验证失败：{err}": { en: "Verification failed: {err}" },
  "验证通过后自动保存（与 token 二选一，密码模式不替代 token）": { en: "Credentials are saved automatically once verification passes (either/or with token; password mode does not replace the token)" },
  "Matrix 登录（L2）：查看本账号可访问的团队 + 项目操作（启动/暂停/产物），日常够用。L1（二选一）：① Controller 管理员 token——额外获得 CRD 管理（入职/建队/改配/删除）、全部 Worker/Team 状态视图；② admin 账号+密码——验证身份 + 持有 Higress Console 会话，模型下拉的 Higress alias 可用。token 无接口可获取（上游安全设计），由部署管理员提供——粘贴一次永久记住；密码模式不替代 token（Controller 管理 API 仍需①）。": { en: "Matrix login (L2): view your accessible teams + project actions (start/pause/artifacts) — enough for daily use. L1 (either/or): ① Controller admin token — additionally CRD management (onboarding/team create/reconfigure/delete) and full Worker/Team views; ② admin account + password — identity check + Higress Console session, enabling Higress aliases in the model dropdown. The token has no API to fetch (upstream security design) — provided by the deployment admin, paste once and it is remembered forever. Password mode does not replace the token (Controller admin API still needs ①)." },
  "Higress alias（路由可解析）": { en: "Higress alias (route resolvable)" }, "Higress 内置 alias（需配路由映射）": { en: "Higress built-in alias (route mapping required)" },
  "在服+在用": { en: "Serving + in use" },
  "模型（留空=跟随集群默认；下拉=在服∪在用∪Higress alias）": { en: "Model (empty = cluster default; dropdown = serving ∪ in-use ∪ Higress alias)" },
  "模型（留空=不改；新建跟随集群默认；下拉=在服∪在用∪Higress alias）": { en: "Model (empty = unchanged; new = cluster default; dropdown = serving ∪ in-use ∪ Higress alias)" },
  "多运行时": { en: "Runtimes" },
  "AgentTeams 支持的 Worker 运行时类型 + 实时计数": { en: "Worker runtime types supported by AgentTeams, with live counts" },
  "Workers": { en: "Workers" },
  "运行时对比": { en: "Runtime comparison" },
  "运行时": { en: "Runtime" },
  "说明": { en: "Description" },
  "特点": { en: "Features" },
  "技术栈": { en: "Stack" },
  "适用场景": { en: "Use cases" },
  "标准 AI Agent 运行时。支持多模型、多技能、MCP Server 集成，适合通用 Agent 场景。": { en: "Standard AI Agent runtime. Multi-model, multi-skill, MCP Server integration — general agent scenarios." },
  "协作优先运行时，针对团队协作场景优化。内置协调协议和消息路由。": { en: "Collaboration-first runtime tuned for team scenarios. Built-in coordination protocol and message routing." },
  "高性能消息运行时，优化消息处理与实时通信，适合高频交互场景。": { en: "High-performance messaging runtime optimized for message processing and realtime communication — high-frequency interaction scenarios." },
  "人类交互运行时，为 Human-in-the-Loop 场景设计。支持审批、确认和人工介入。": { en: "Human-interaction runtime designed for Human-in-the-Loop scenarios. Approvals, confirmations, manual intervention." },
  "千问专用运行时，基于 Qwen 大模型的优化 Agent 框架。适合 Qwen 生态 Agent 场景。": { en: "Qwen-specialized runtime, an agent framework optimized around Qwen models — Qwen ecosystem agent scenarios." },
  "多模型 / 技能插件 / MCP Server / 容器化 / 状态管理": { en: "multi-model / skills / MCP / containerized / state" },
  "协作协议 / 消息路由 / 任务分解 / 结果合并 / 冲突解决": { en: "coordination protocol / routing / task split / merge / conflict resolution" },
  "消息队列 / 实时通信 / 流处理 / 低延迟 / 事件驱动": { en: "queue / realtime / streaming / low-latency / event-driven" },
  "人工审批 / 确认流程 / 权限控制 / 通知推送 / 审计日志": { en: "human approval / confirmation flow / access control / notifications / audit" },
  "千问优化 / 工具调用 / 流式推理 / 多轮对话": { en: "Qwen-tuned / tool calls / streaming inference / multi-turn" },
  "通用 Agent / 内容生成 / 代码助手 / 数据分析": { en: "general agent / content / coding / analytics" },
  "多 Agent 协作 / 代码审查 / 文档编写 / 项目管理": { en: "multi-agent / code review / docs / project mgmt" },
  "实时交互 / 流式处理 / 事件驱动 / IoT 网关": { en: "realtime / streaming / event-driven / IoT" },
  "审批流程 / 人工介入 / 安全审核 / 质量保证": { en: "approval flow / HITL / security audit / QA" },
  "千问 Agent / 工具集成 / 推理加速": { en: "Qwen agent / tool integration / inference" },
  "Worker 列表不可用（未配置 L1 管理员 token）——卡片计数显示为 –": { en: "Worker list unavailable (no L1 admin token configured) — card counts show –" },
  // ── v0.5.0-beta.12（token 文件 / 网关探测 / 运行时徽章 / 批次 0）──
  // v0.5.0-beta.12: token 文件路径路删除（9/10 装验「留个命令就行」）——
  // 获取命令 + 粘贴 + env。
  "获取命令（在 Controller 宿主机执行，复制输出粘贴到下方）：": { en: "Fetch command (run on the Controller host, copy the output and paste it below):" },
  "非 docker 部署：部署期给 QwenPaw 进程注入环境变量 AGENTTEAMS_CONTROLLER_TOKEN（注入值优先于粘贴值需重贴才覆盖）。": { en: "Non-docker deployments: inject the AGENTTEAMS_CONTROLLER_TOKEN env var into the QwenPaw process at deploy time (pasted values take precedence over env)." },
  "粘贴 token 内容（见上方获取命令；部署期注入 env 时留空即可）": { en: "Paste the token content (see the fetch command above; leave empty when env-injected)" },
  "✓ 当前使用 QwenPaw 宿主环境变量 AGENTTEAMS_CONTROLLER_TOKEN（手动粘贴的值优先。）": { en: "✓ Using the QwenPaw host env var AGENTTEAMS_CONTROLLER_TOKEN (a manually pasted value takes precedence.)" },
  "⚠ token 内容含非法字符（复制时混入不可见字符）——重新复制纯 ASCII 内容，或改用 env 注入。": { en: "⚠ Token contains invalid characters (invisible chars mixed in when copying) — re-copy pure ASCII content, or use env injection." },
  "Higress 地址（Console 管理面，必填；宿主端口部署时自选，默认 18001）": { en: "Higress URL (Console admin plane, required; host port chosen at deploy time, default 18001)" },
  /* v0.5.0-beta.12：L669 此前无 en 条目（en 界面显示中文）——补条目，
     并修「模型网关都依赖它」= Controller/Higress 混淆（模型网关=Higress
     数据面，与 Controller 地址无关）。 */
  "Controller 地址（L1/CRD 管理/Worker/Team 状态依赖；不填仅房间侧功能）": { en: "Controller URL (L1 / CRD management / Worker & Team status depend on it; without it only room-side features)" },
  "token 模式无 Higress Console 会话——Higress alias 层当前不可见。配置 admin 账号密码后，「Higress alias（路由可解析）」与「Higress 内置 alias」分组将出现在模型下拉中；或等待 P1-3 上游 PR（controller_token 直连 Higress Console）合入。": { en: "Token mode has no Higress Console session — the Higress alias layer is currently hidden. After configuring the admin account + password, the 'Higress alias (route resolvable)' and 'Higress built-in alias' groups will appear in the model dropdown; or wait for the P1-3 upstream PR (controller_token directly to Higress Console) to merge." },
  "token 模式无 Higress Console 会话——「Higress alias」分组当前不可见。配置 admin 账号密码后可读；或等待 P1-3 上游 PR（controller_token 直连 Higress Console）合入。": { en: "Token mode has no Higress Console session — the 'Higress alias' group is currently hidden. Configure the admin account + password to enable it; or wait for the P1-3 upstream PR (controller_token directly to Higress Console) to merge." },
  "已打开 {target} 的个人房间": { en: "Opened {target}'s personal room" },
  "个人房间打开失败（{e}），回退新建 DM": { en: "Failed to open the personal room ({e}); falling back to a new DM" },
  "镜像": { en: "Image" },
  "个人房间": { en: "Personal room" },
  "私聊（个人房间）": { en: "DM (personal room)" },
  "日志（最近 300 行）": { en: "Logs (last 300 lines)" },
  "Worker 状态（Controller CR phase）": { en: "Worker status (Controller CR phase)" },
  "Worker 运行时（Controller CR runtime）": { en: "Worker runtime (Controller CR runtime)" },
};

export type Lang = "zh" | "en";

/** 当前语言（host.useLocale；非 zh 一律 en）。 */
export function useLang(): Lang {
  let locale = "";
  try {
    if (typeof host.useLocale === "function") {
      locale = String(host.useLocale() || "");
    }
  } catch {
    locale = "";
  }
  return locale && !locale.toLowerCase().startsWith("zh") ? "en" : "zh";
}

/** 翻译函数（hooks 版）。t("发送") → "Send"（en 模式）。
 *  再版 4：必须记忆化（useMemo）——原实现每次 render 返回新函数，
 *  组件里 `useCallback(fn, [tr])` + `useEffect([...load])` 会无限循环
 *  fetch（用户报告：技能中心「一直刷 worker 名字」= 该循环 + 目录接口
 *  404 每轮重复；全库仅 SkillCenter 踩中此模式）。
 */
export function useT(): (text: string, vars?: Record<string, string | number>) => string {
  const lang = useLang();
  // 宿主 React 实例（blob-URL 执行环境禁裸 import——v0.4.85 事故铁律）。
  return host.React.useMemo(
    () =>
      (text: string, vars?: Record<string, string | number>) => {
        let out = text;
        if (lang === "en" && DICT[text]) {
          out = DICT[text].en;
        }
        if (vars) {
          for (const [k, v] of Object.entries(vars)) {
            out = out.split(`{${k}}`).join(String(v));
          }
        }
        return out;
      },
    [lang],
  );
}

export type { ReactNS };
