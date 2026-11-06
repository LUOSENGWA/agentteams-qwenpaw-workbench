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

  // ── 16.27 B：Worker 详情模型配置卡 ──
  // 注：「模型」「Provider」「保存」「保存失败」「模型 alias（留空=跟随集群默认）」等
  // 复用 workflow/worker/team 域既有键，不重复登记。
  "模型配置": { en: "Model Config" },
  "当前值": { en: "Current" },
  "修改模型配置需 L1 管理权限（Controller 管理员 token）": {
    en: "Editing model config requires L1 admin access (Controller admin token)",
  },

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

  // ── 16.30：集群域「运行时批量升级」入口卡（+ 面包屑/引导更新）──
  "概览": { en: "Overview" },
  "运行时批量升级": { en: "Runtime batch upgrade" },
  "查看运行时批量升级": { en: "View runtime batch upgrade" },
  "多选 Worker 批量就地升级 qwenpaw 运行时（L1 · 二次确认）": {
    en: "In-place QwenPaw runtime upgrade on multiple selected Workers (L1 · double confirm)",
  },
  "选择 日志 / 审计 / 批量升级": { en: "Pick logs / audit / batch upgrade" },
  "点左栏 组件日志 / 审计 / 批量升级 卡片查看详情": {
    en: "Pick the component-logs / audit / batch-upgrade card in the left column to view details",
  },
  "点中栏 组件日志 / 审计 / 批量升级 卡片查看详情（详情在右栏）": {
    en: "Pick the component-logs / audit / batch-upgrade card in the middle column to view details (shown in the right column)",
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

  // ── 16.30：四栏 toggle 改管最左域导航 ──
  "收起导航": { en: "Collapse navigation" },
  "展开导航": { en: "Expand navigation" },
  // ── 16.41 批次 1：独立 Worker 可见性（列表底部行 / 上下文卡 / 加入 Worker 卡）──
  "未归属团队的 Worker": { en: "Workers not in any team" },
  "独立 Worker——能运行、能被私聊，不参与团队任务；点名字看详情，在团队设置里可加进团队。": {
    en: "Standalone workers — they can run and receive DMs but take no part in team tasks. Pick a name for details; add to a team from team settings.",
  },
  "未归属团队": { en: "Not in any team" },
  "该 Worker 未归属任何团队（独立 Worker）：能运行、能被私聊，但不参与团队任务。": {
    en: "This worker is not in any team (standalone worker): it can run and receive DMs, but takes no part in team tasks.",
  },
  "加进团队：打开目标团队 → 团队设置 →「加入 Worker」一键加入。": {
    en: "To join a team: open the target team → team settings → “Add Worker” for a one-click join.",
  },
  "加入 Worker（未归属团队的）": { en: "Add worker (not in any team)" },
  "加入本团队": { en: "Add to this team" },
  "无未归属 Worker（未被任何 Team CR 引用的 Worker）——可到 CRD 管理 → 新建 Worker 创建。": {
    en: "No unassigned workers (workers referenced by no Team CR) — create one under CRD management → New Worker.",
  },
  "一键加入 = PUT 合并进当前团队成员（保留原有成员，角色 = worker）。": {
    en: "One-click join = PUT-merge into this team’s members (existing members kept, role = worker).",
  },
  "Worker CRD（名字 + 运行时 + 模型）；不指定团队 = 独立 Worker": {
    en: "Worker CRD (name + runtime + model); no team = standalone worker",
  },

  // ── 文件域（#1426 Human Files，nested API 版：humans/{name}/files/{path...}）──
  // 注：「加载中…」「加载失败」「重试」「刷新」「保存」「取消」「已保存」「下载」
  // 「下载失败」「删除」「操作失败」复用各域既有键，不重复登记。
  "文件管理": { en: "Files" },
  "我的文件": { en: "My Files" },
  "回收站": { en: "Trash" },
  "回收站为空": { en: "Trash is empty" },
  "共 {n} 个条目": { en: "{n} entrie(s)" },
  "目录": { en: "Directory" },
  "进入目录": { en: "Enter directory" },
  "上级目录": { en: "Up one level" },
  "大小 {a} · 删除于 {b}": { en: "Size {a} · Deleted {b}" },
  "恢复 / 彻底删除在中栏行操作": {
    en: "Trash entries are operated in the middle column rows",
  },
  "存储配额": { en: "Storage quota" },
  "已用 {a} / 共 {b}": { en: "Used {a} / of {b}" },
  "配额": { en: "Quota" },
  "无限制": { en: "Unlimited" },
  "已用 {a}": { en: "Used {a}" },
  "配额获取失败": { en: "Failed to fetch quota" },
  "上传文件": { en: "Upload file" },
  "上传成功": { en: "Uploaded" },
  "新建文件夹": { en: "New folder" },
  "请输入文件夹名": { en: "Enter a folder name" },
  "文件夹已创建": { en: "Folder created" },
  "设置配额": { en: "Set quota" },
  "设置人类文件存储上限（MB）。": {
    en: "Set the human-file storage limit (MB).",
  },
  "配额（MB）": { en: "Quota (MB)" },
  "请输入有效配额": { en: "Enter a valid quota" },
  "清除配额": { en: "Clear quota" },
  "清除配额？": { en: "Clear the quota?" },
  "清除后人类文件存储无限制。": { en: "After clearing, human-file storage is unlimited." },
  // #1669 删除确认（勾选「移入回收站（可恢复）」/彻底删除）
  "删除文件？": { en: "Delete this file?" },
  "移入回收站（可恢复）": { en: "Move to trash (recoverable)" },
  "将彻底删除，不可恢复": {
    en: "It will be permanently deleted and cannot be recovered",
  },
  "目录删除暂不支持（请逐个删除文件）": {
    en: "Deleting directories is not supported yet (delete the files one by one)",
  },
  "移入回收站？": { en: "Move this file to the trash?" },
  "已移入回收站": { en: "Moved to trash" },
  "恢复文件": { en: "Restore file" },
  "已恢复": { en: "Restored" },
  "彻底删除": { en: "Purge" },
  "彻底删除此项？": { en: "Purge this item?" },
  "已彻底删除": { en: "Purged" },
  "仅管理员": { en: "Admin only" },
  "目标路径已存在": { en: "Target path already exists" },
  "覆盖目标路径上的已有文件？（仅管理员）": {
    en: "Overwrite the existing file at the target path? (admin only)",
  },
  "覆盖": { en: "Overwrite" },
  "无权限或不存在": { en: "No access or not found" },
  "当前账号无法访问该 Human 的文件，或 Human 不存在。": {
    en: "The current account cannot access this human's files, or the human does not exist.",
  },
  "无法识别当前用户": { en: "Current user not identified" },
  "请通过 Matrix 登录后再使用文件管理。": {
    en: "Sign in with a Matrix account to use file management.",
  },
  "大小超限（单文件 ≤ 64MiB）": { en: "File exceeds the size limit (64MiB max per file)" },
  "配额已满": { en: "Storage quota is full" },
  "上传失败（大小超限或配额已满）": { en: "Upload failed (size limit or quota full)" },
  "内容冲突（etag 不匹配）——刷新后重试": {
    en: "Content conflict (etag mismatch) — refresh and retry",
  },
  "路径非法": { en: "Invalid path" },
  "此操作不可撤销": { en: "This action cannot be undone" },
  "清空": { en: "Purge" },
  "覆盖上传": { en: "Overwrite upload" },
  "所选文件已不在最新数据中": {
    en: "Selected file no longer in the latest data",
  },
  "选择文件": { en: "Select a file" },
  "点左侧列表中的文件查看操作": {
    en: "Pick a file in the left list to see its actions",
  },
  "点中栏文件行查看下载 / 覆盖 / 删除": {
    en: "Pick a file row in the middle column for download / overwrite / delete",
  },
  "暂无文件": { en: "No files" },
  "大小 {a} · 更新 {b}": { en: "Size {a} · Updated {b}" },
  // ── 文件域 16.67（排版 / 去重）──
  "上传一个文件": { en: "Upload a file" },
  "更新时间": { en: "Updated" },
  "删除时间": { en: "Deleted" },

  // ── 文件域 16.69（master-detail 断点：split / drawer / sheet）──
  "选择文件查看详情": { en: "Select a file to see details" },
  "点列表文件行查看下载 / 覆盖 / 删除": {
    en: "Pick a file row in the list for download / overwrite / delete",
  },
  "选择回收站条目": { en: "Select a trash entry" },
  "点列表行查看恢复 / 彻底删除": {
    en: "Pick a row in the list for restore / purge",
  },
  "此目录为空": { en: "This directory is empty" },
  "上传或新建文件夹后开始管理": {
    en: "Upload a file or create a folder to get started",
  },
  "文件详情": { en: "File details" },
  "回收站条目": { en: "Trash entry" },

  // ── 文件域 H1（#1518 游标列表 / #1519 预签名上传 / #1501 预签名下载 /
  // #1499 同步状态卡）──
  "递归": { en: "Recursive" },
  "当前控制器版本不支持递归列表": {
    en: "This controller version does not support recursive listing",
  },
  "文件超过预签名上传上限（最大 {a}）": {
    en: "File exceeds the presigned upload limit ({a} max)",
  },
  "上传校验失败（checksum 不匹配）——请重新上传": {
    en: "Upload rejected (checksum mismatch) — please re-upload",
  },
  "上传失败（对象不存在）——请重新上传": {
    en: "Upload failed (object missing) — please re-upload",
  },
  "同步状态": { en: "Sync status" },
  "尚未建立清单": { en: "No manifest yet" },
  "该人员未授予 file_sync 能力": {
    en: "This person has not been granted the file_sync capability",
  },
  "文件区 {n} 个文件，清单 {m} 条。清单由本地同步客户端维护，请在本地运行同步客户端对齐。": {
    en: "File area has {n} file(s) but the manifest lists {m}. The manifest is maintained by the local sync client — run it locally to reconcile.",
  },
  "条目": { en: "Entries" },
  "墓碑": { en: "Tombstones" },
  "代": { en: "Generation" },
  "更新于 {t}（{by}）": { en: "Updated {t} (by {by})" },
  "更新于 {t}": { en: "Updated {t}" },
  "导出清单原文": { en: "Export manifest" },
  "复制清单原文": { en: "Copy manifest" },
  "清单原文已导出": { en: "Manifest exported" },
  "已复制清单原文": { en: "Manifest copied" },
  "清单获取失败": { en: "Failed to fetch manifest" },
  // 「导出失败」复用 settings 域既有键（i18n 字典全局并集）。
  "复制失败（浏览器未授权剪贴板）": {
    en: "Copy failed (browser clipboard not authorized)",
  },

  // ── 危险区：CRD 删除（16.55）──
  "危险区": { en: "Danger zone" },
  "删除人员": { en: "Delete person" },
  "删除团队": { en: "Delete team" },
  "删除人员 {name}": { en: "Delete person {name}" },
  "删除团队 {name}": { en: "Delete team {name}" },
  "删除 Worker {name}": { en: "Delete worker {name}" },
  "删除失败：{msg}": { en: "Delete failed: {msg}" },
  "人员 {name} 已删除": { en: "Person {name} deleted" },
  "Worker {name} 已删除": { en: "Worker {name} deleted" },
  "删除 Human CR：Matrix 账号停用并离开全部房间；文件区保留。不可撤销。": {
    en: "Deleting the Human CR disables the Matrix account and leaves all rooms; the file area is kept. This cannot be undone.",
  },
  "删除 Human CR「{name}」？Matrix 账号将停用并离开全部房间；其文件区对象保留。此操作不可撤销。": {
    en: "Delete Human CR “{name}”? The Matrix account will be deactivated and leave all rooms; its file-area objects are kept. This cannot be undone.",
  },
  "输入 {name} 以确认删除": { en: "Type {name} to confirm deletion" },
  "团队房间与团队配置将删除；成员 Worker 保留（变为未分组）。": {
    en: "The team room and team configuration will be deleted; member workers are kept (they become ungrouped).",
  },
  "删除后 6 秒内可从提示条撤销（按快照重建；房间历史与容器状态不随之恢复）。": {
    en: "You can undo from the toast within 6 seconds (rebuilt from a snapshot; room history and container state are not restored).",
  },
  "成员 Worker 保留（变未分组）；6 秒内可从提示条撤销（按快照重建，房间历史不恢复）。": {
    en: "Member workers are kept (they become ungrouped); undo is available from the toast for 6 seconds (rebuilt from a snapshot; room history is not restored).",
  },
  "删除 Worker CR 及其容器。": {
    en: "Deletes the Worker CR and its container.",
  },
  "重试 / 限流 + 流式超时（流式组热生效）": {
    en: "Retry / rate-limit + stream timeout (stream group applies hot)",
  },
  // 存量漏键（TeamSection / WorkerDetailPane 既有 tr 字面量，本次顺手补齐）。
  "Manager not found": { en: "Manager not found" },
  "Managers": { en: "Managers" },
  "Worker 模型配置": { en: "Worker model configuration" },
  "点击编辑": { en: "Click to edit" },

  // ── 运行时配置面（P8c / G3）──
  "已写入，重启后生效：{keys}": { en: "Written; takes effect after restart: {keys}" },
  "已写入，尚未生效": { en: "Written; not effective yet" },
  "已保存": { en: "Saved" },
  "运行时不接受：{keys}": { en: "Runtime rejects: {keys}" },
  "配置已被他人修改，已重新读取": { en: "Config changed by someone else; reloaded" },
  "存在未知字段：{fields}（请刷新后重试）": { en: "Unknown fields: {fields} (refresh and retry)" },
  "JSON 格式不对": { en: "Invalid JSON" },
  "无改动": { en: "No changes" },
  "该运行时暂无配置面（已注册：{supported}）": { en: "This runtime has no config surface yet (registered: {supported})" },
  "读取配置失败": { en: "Failed to load config" },
  "只读：团队 Leader 或策略限制": { en: "Read-only: team leader or policy restriction" },
  "回滚到上次写入": { en: "Roll back previous write" },
  "已生效": { en: "Effective" },
  "待生效": { en: "Pending" },
  "该运行时的配置面（L1 可编辑）": { en: "This runtime's config surface (L1 editable)" },
  "流式超时（热生效，无需重启）": { en: "Stream timeouts (hot, no restart)" },
  "空 = 继承团队/默认": { en: "Empty = inherit team/default" },
  "保存（热生效）": { en: "Save (hot)" },
  "重新读取": { en: "Reload" },
  "已保存（流式超时热生效，无需重启）": { en: "Saved (stream timeouts applied hot, no restart)" },
  "core 技能已由 TeamHarness 提供（AgentTeams 1.2.6+），注入只写 SOUL": {
    en: "The core skill ships with TeamHarness (AgentTeams 1.2.6+); injection writes SOUL only",
  },
  "写入 SOUL（core 技能已由 TeamHarness 提供，无需注入）": {
    en: "Writes SOUL (the core skill is provided by TeamHarness, no injection needed)",
  },
  "无变化（已跳过）": { en: "Unchanged (skipped)" },
  "方式": { en: "Mode" },
  "跳过": { en: "Skipped" },
  "写入": { en: "Write" },
  "回滚": { en: "Roll back" },
  "操作": { en: "Action" },
  "已回滚 {name} 的 SOUL": { en: "Rolled back the SOUL of {name}" },
  "现有 SOUL 将被覆盖": { en: "Existing SOUL will be overwritten" },
  "覆盖并注入": { en: "Overwrite and inject" },
  "以下 Worker 已有内容不同的 SOUL。确认后将整体覆盖（覆盖前会留底，可在结果里回滚）：": {
    en: "These workers already have a different SOUL. Confirming replaces it entirely (a backup is kept and can be rolled back from the result table):",
  },
  "现有来源": { en: "Existing source" },
  "现有长度": { en: "Length" },
  "现有摘要": { en: "Excerpt" },
  "手工/未知": { en: "Manual/unknown" },
  "若该 Worker 属于某团队，Controller 会拒绝删除（请先从团队移除）。": {
    en: "If the worker belongs to a team, the controller rejects the deletion (remove it from the team first).",
  },

  // ── P8C 运行时 surface 表单（G2：SchemaField / SurfaceForm）──
  "下一轮生效": { en: "Applies next turn" },
  "需重启": { en: "Requires restart" },
  "已设置（不回显）": { en: "Set (not shown)" },
  "通用": { en: "General" },
  "{n} 个配置项": { en: "{n} field(s)" },

  // ── C2b：人员详情「模型授权」（Human CR spec.modelAccess，#1513 管理员面）──
  // 「Provider」「模型」「保存」「取消」「删除」「加载中…」「只读」「可编辑」
  // 「继承自 {x}」「未授权」「BYOK 不支持」「保存失败」复用各域既有键（不重登）。
  "模型授权": { en: "Model access" },
  "主模型 / spawn / Coding CLI（Human CR spec.modelAccess，L1）": {
    en: "Main / spawn / Coding CLI grants (Human CR spec.modelAccess, L1)",
  },
  "模型授权（{name}）": { en: "Model access ({name})" },
  "读取人 CR…": { en: "Reading the Human CR…" },
  "读取模型授权失败": { en: "Failed to load model access" },
  "未配置模型授权（fail-closed）：该人员名下的 Worker 默认全部模型锁定": {
    en: "No model access configured (fail-closed): workers under this person are locked from all models by default",
  },
  "添加作用域并授权 (provider, model) 对后保存；role 留空 = 默认作用域。无值 = fail-closed 全锁。": {
    en: "Add a scope and grant (provider, model) pairs, then save; an empty role means the default scope. No value = fail-closed (all locked).",
  },
  "只读：当前授权由上游继承或策略限制（各分区有原因提示）": {
    en: "Read-only: grants are inherited upstream or restricted by policy (see the per-surface hints for reasons)",
  },
  "修改模型授权需 L1 管理权限（Controller 管理员 token）": {
    en: "Editing model access requires L1 admin access (Controller admin token)",
  },
  "模型授权已保存": { en: "Model access saved" },
  "部分 entries 缺 provider 或 model——补全或删除后再保存": {
    en: "Some entries miss a provider or a model — complete or remove them before saving",
  },
  "写入路径：{via}": { en: "Write via: {via}" },
  "未配置作用域（无值 = fail-closed，全部模型锁定）": {
    en: "No scopes configured (no value = fail-closed, all models locked)",
  },
  "添加作用域": { en: "Add scope" },
  "删除作用域": { en: "Delete scope" },
  "作用域 {n}": { en: "Scope {n}" },
  "role（空 = 默认作用域）": { en: "role (empty = default scope)" },
  "共享表（可选）": { en: "Shared table (optional)" },
  "共享表与内联 entries 二选一，内联 entries 优先": {
    en: "Shared table and inline entries are either/or — inline entries win",
  },
  "已选共享表：{name}（内联 entries 优先）": {
    en: "Shared table selected: {name} (inline entries win)",
  },
  "共享表内容（只读）": { en: "Shared table contents (read-only)" },
  "表为空": { en: "Table is empty" },
  "主模型": { en: "Main model" },
  "spawn / 子代理": { en: "spawn / subagent" },
  "继承主模型（spawn 空值）": { en: "Inherit main model (when spawn is empty)" },
  "继承 spawn 模型（CLI 空值）": { en: "Inherit spawn model (when CLI is empty)" },
  "添加 CLI": { en: "Add CLI" },
  "删除 CLI": { en: "Delete CLI" },
  "CLI 名（如 qwen-code）": { en: "CLI name (e.g. qwen-code)" },
  "未配置 Coding CLI 授权": { en: "No Coding CLI grants" },
  "添加行": { en: "Add row" },
  "删除行": { en: "Delete row" },
  "Provider 与 model 必须成对填写": { en: "Provider and model must be filled as a pair" },
  "无 entries（空 = 不授权）": { en: "No entries (empty = no grant)" },

  // ── H2：人员详情「工作区访问」（Human CR spec.workspaceAccess，#1502 管理员面）──
  // 「保存」「取消」「团队」「只读」「读写」「保存失败」复用各域既有键（不重登）。
  "工作区访问": { en: "Workspace access" },
  "files/** 团队访问（grants/restrictions，L1）": {
    en: "files/** team access (grants/restrictions, L1)",
  },
  "工作区访问（{name}）": { en: "Workspace access ({name})" },
  "读取工作区访问…": { en: "Loading workspace access…" },
  "读取工作区访问失败": { en: "Failed to load workspace access" },
  "工作区访问已保存": { en: "Workspace access saved" },
  "工作区访问存在校验错误——先修正红色提示": {
    en: "Workspace access has validation issues — fix the red items first",
  },
  "当前控制器版本不支持工作区访问（保存未生效）": {
    en: "The current controller version does not support workspace access (save did not take effect)",
  },
  "修改工作区访问需 L1 管理权限（Controller 管理员 token）": {
    en: "Editing workspace access requires L1 admin access (Controller admin token)",
  },
  "团队列表不可用——团队名降级为自由输入": {
    en: "Team list unavailable — team name degrades to free text",
  },
  "默认访问": { en: "Default access" },
  "成员（accessibleTeams ∪ humanMembers）默认对 files/** 读写；grants 仅为非成员团队加授，restrictions 可收窄默认范围（同路径 restriction 优先）。": {
    en: "Member teams (accessibleTeams ∪ humanMembers) have readwrite on files/** by default; grants only raise access for non-member teams, restrictions can narrow the default scope (restrictions win on the same path).",
  },
  "读写 files/**": { en: "Read/Write files/**" },
  "无默认团队（无成员关系且未配置 accessibleTeams）": {
    en: "No default teams (no membership / no accessibleTeams)",
  },
  "默认访问由成员关系派生，不写字段": {
    en: "Default access is derived from membership (no field written)",
  },
  "授予规则": { en: "Grant rules" },
  "为非成员团队加授 files/** 访问（只能加，不能低于默认）": {
    en: "Raise files/** access for non-member teams (raise only, never below default)",
  },
  "限制规则": { en: "Restriction rules" },
  "收窄默认范围（none = 撤销 / read = 降级）": {
    en: "Narrow the default scope (none = revoke / read = cap)",
  },
  "未配置（继承默认）": { en: "Not configured (default inherited)" },
  "添加授予规则": { en: "Add grant rule" },
  "添加限制规则": { en: "Add restriction rule" },
  "删除规则": { en: "Delete rule" },
  "模式": { en: "Mode" },
  "无权限": { en: "No access" },
  "团队名（自由输入）": { en: "Team name (free text)" },
  "添加路径（支持 * 和 **）": { en: "Add path (* and ** supported)" },
  "路径非法：{p}": { en: "Invalid path: {p}" },
  "模式越界：{m}（此列表允许 {allowed}）": {
    en: "Mode out of range: {m} (allowed here: {allowed})",
  },
  "同一团队在列表中重复": { en: "The same team appears twice in this list" },
  "团队不存在：{team}": { en: "Unknown team: {team}" },
  "团队不可为空": { en: "Team must not be empty" },
  "至少需要一条路径": { en: "At least one path is required" },
  "每列表至多 32 条规则（当前 {m}）": { en: "At most 32 rules per list (got {m})" },
  "每规则至多 16 条路径（当前 {m}）": { en: "At most 16 paths per rule (got {m})" },
};
