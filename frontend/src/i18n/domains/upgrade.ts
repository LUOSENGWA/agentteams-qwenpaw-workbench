// upgrade 域 i18n 字典（自 i18n.ts 按域拆分）：编码执行记录/运行时升级/版本语义/Coding CLI 面板。

export const upgradeDict: Record<string, { en: string }> = {
  // ── 编码执行记录（Coding Runs，1.2.5 #1365/#1381 只读端点消费）──
  "编码执行记录": { en: "Coding Runs" },
  "编码 CLI 一次性执行记录与原始日志（只读，Controller /api/v1/coding-runs）。与聊天区的会话上下文不是同一数据源。": {
    en: "One-shot coding CLI runs and their raw logs (read-only, Controller /api/v1/coding-runs). Not the same data source as the chat session context.",
  },
  "{n} 条": { en: "{n} run(s)" },
  "当前 Controller 版本未提供编码执行记录（升级后自动开放）。": {
    en: "This Controller version does not expose coding runs (available after upgrade).",
  },
  "暂无编码执行记录": { en: "No coding runs" },
  "退出 {code}": { en: "exit {code}" },
  "读取执行记录…": { en: "Loading run…" },
  "读取失败": { en: "Failed to read" },
  "退出码": { en: "Exit code" },
  "开始": { en: "Started" },
  "结束": { en: "Ended" },
  "日志": { en: "Log" },
  "原因": { en: "Reason" },
  "输入（prompt）": { en: "Input (prompt)" },
  "（本次执行未记录输入）": { en: "(No input recorded for this run)" },
  "输出（原始日志）": { en: "Output (raw log)" },
  "（无日志内容）": { en: "(No log content)" },
  "CLI": { en: "CLI" },
  "Runner": { en: "Runner" },
  "持续": { en: "Duration" },
  "Tokens": { en: "Tokens" },
  "凭证": { en: "Receipt" },
  "工作树": { en: "Worktree" },
  "分支": { en: "Branch" },
  // ── 运行时升级（1.2.5 #1364/#1343 消费）──
  "运行时升级": { en: "Runtime Upgrade" },
  "目标": { en: "target" },
  "Worker 容器内 QwenPaw 运行时就地升级（两阶段编排、失败自动回滚）。当前仅支持 qwenpaw 运行时。触发升级会重启目标容器并中断在跑任务，需二次确认。": {
    en: "In-container QwenPaw runtime in-place upgrade (two-phase orchestration, auto rollback on failure). Currently supports the qwenpaw runtime only. Triggering an upgrade restarts the target container and interrupts running tasks; a second confirmation is required.",
  },
  "就地升级当前仅支持 qwenpaw 运行时（其他运行时请走镜像重建升级）。": {
    en: "In-place upgrade currently supports the qwenpaw runtime only (other runtimes: upgrade via image rebuild).",
  },
  "需要 Controller 管理员 token（L1）才能执行运行时升级": {
    en: "A Controller admin token (L1) is required to run runtime upgrades",
  },
  "选择要升级的 Worker": { en: "Select the Worker to upgrade" },
  "预检": { en: "Pre-check" },
  "目标版本": { en: "Target version" },
  "确认升级": { en: "Upgrade" },
  // ── 运行时升级·批量（多选 qwenpaw worker + 检查更新 + 顺序触发）──
  "单 Worker": { en: "Single Worker" },
  "批量": { en: "Batch" },
  "检查更新": { en: "Check for updates" },
  "可升级": { en: "Update available" },
  "最新": { en: "Latest" },
  "未知版本": { en: "Unknown version" },
  "（缓存）": { en: " (cached)" },
  "批量升级（{n}）": { en: "Batch upgrade ({n})" },
  "顺序执行（一次一个 worker，避免容器重启互扰）。": {
    en: "Runs sequentially (one worker at a time, to avoid container-restart interference).",
  },
  "触发中": { en: "Triggering" },
  "触发失败": { en: "Trigger failed" },
  "确认触发批量运行时升级？": { en: "Confirm batch runtime upgrade?" },
  "Worker（{n} 个）": { en: "Workers ({n})" },
  "将按顺序对每个 Worker 两阶段就地升级并重启容器，期间在跑任务会被中断；启动自检失败会自动回滚到旧版本。": {
    en: "Each Worker is upgraded in-place in two phases in sequence and its container is restarted; running tasks are interrupted in the meantime. A failed boot self-check rolls back to the previous version automatically.",
  },
  "预发布": { en: "Prerelease" },
  "推荐": { en: "Recommended" },
  // ── AgentTeams 版本语义（15.24 T2：镜像 tag 正源）──
  "AgentTeams 版本": { en: "AgentTeams version" },
  // ── Coding CLI 面板（1.2.5 #1360 消费）──
  "Coding CLI": { en: "Coding CLI" },
  "Coding CLI（安装/升级/settings）": { en: "Coding CLI (install / upgrade / settings)" },
  "加载失败：{e}": { en: "Load failed: {e}" },
  "加载 settings 失败": { en: "Failed to load settings" },
  "加载 settings…": { en: "Loading settings…" },
  "{cli} 任务完成": { en: "{cli} task finished" },
  // ── Coding CLI 面板（1.2.5 #1360 消费，续）──
  "编码 CLI 探测中（容器内逐 CLI 跑 --version，有 exec 成本）…": {
    en: "Probing coding CLIs (runs --version inside the container per CLI — has exec cost)…",
  },
  "探测于 {t}（缓存 5 分钟）": {
    en: "Probed at {t} (cached for 5 min)",
  },
  "重新探测": { en: "Probe again" },
  "该 Worker 的编码 CLI 管理暂不可用，升级 AgentTeams 后自动生效。": {
    en: "Coding CLI management for this Worker is not available yet; it activates automatically after upgrading AgentTeams.",
  },
  "当前角色仅可查看，不能修改编码 CLI": { en: "Your role can only view coding CLIs, not modify them" },
  "当前角色仅可查看，不能修改编码 CLI。": { en: "Your role can only view coding CLIs, not modify them." },
  "已安装": { en: "Installed" },
  "未安装": { en: "Not installed" },
  "鉴权已配置": { en: "Auth configured" },
  "容器重建后需重新安装；已保存的鉴权可保留": {
    en: "Reinstallation required after container rebuild; saved auth is retained",
  },
  "卸载": { en: "Uninstall" },
  "安装": { en: "Install" },
  "升级": { en: "Upgrade" },
  "版本 tag（安装/升级）": { en: "Version tag (install/upgrade)" },
  "如 0.25.0；空=latest": { en: "e.g. 0.25.0; blank = latest" },
  "检查更新中…": { en: "Checking for updates…" },
  "registry 不可达（手动填 tag 仍可升级）": {
    en: "Registry unreachable (you can still upgrade by entering a tag manually)",
  },
  "有更新 → {v}": { en: "Update available → {v}" },
  "已是最新": { en: "Up to date" },
  "registry 最新 {v}": { en: "Registry latest {v}" },
  "模型名": { en: "Model name" },
  "{cli} settings（结构化表单 · 只保存改动）": { en: "{cli} settings (structured form · saves only changes)" },
  "已保存，留空保留；输入=替换": { en: "Saved — leave empty to keep; enter to replace" },
  "未设置；输入=设置": { en: "Not set; enter to set" },
  "有未保存改动": { en: "Unsaved changes" },
  "无改动": { en: "No changes" },
  "此分区有未保存改动": { en: "Unsaved changes in this section" },
  "尚无配置文件——填模型名并保存即创建；高级字段用下方 JSON 补丁补充。": {
    en: "No config file yet — enter a model name and save to create it; add advanced fields via the JSON patch below.",
  },
  "JSON 补丁（可选，任意字段；同键以补丁为准，如 mcp / tools）": {
    en: "JSON patch (optional, any field; patch wins on same key, e.g. mcp / tools)",
  },
  "JSON 补丁格式非法（未应用）": { en: "Invalid JSON patch format (not applied)" },
  "JSON 补丁须为对象（未应用）": { en: "JSON patch must be an object (not applied)" },
  "Qoder 账号登录走 QODER_PERSONAL_ACCESS_TOKEN env（非 settings）；BYOK 自定义模型走 /model 向导。本表单管 model / tools / mcp / permissions。": {
    en: "Qoder account login goes through the QODER_PERSONAL_ACCESS_TOKEN env var (not settings); BYOK custom models go through the /model wizard. This form manages model / tools / mcp / permissions.",
  },
  // ── 15.31（三 CLI 结构化表单按官方 schema 全量补齐）──
  "尚无模型路由——点下方「添加模型路由」。": {
    en: "No model routes yet — click \"Add model route\" below.",
  },
  "{provider} · {n} 号路由": { en: "{provider} · route #{n}" },
  "（非法条目——用下方 JSON 补丁修正）": {
    en: "(invalid entry — fix via the JSON patch below)",
  },
  "＋ 添加模型路由": { en: "+ Add model route" },
  "← 由上方「模型」行管理": { en: "← managed by the Model row above" },
  "检测到已废弃字段 {fields}——Qwen Code 已弃用 security.auth.apiKey/baseUrl，请改用 modelProviders（envKey）+ env 块（JSON 补丁）或容器 ~/.qwen/.env，然后删除这些字段。": {
    en: "Deprecated field detected: {fields}. Qwen Code has deprecated security.auth.apiKey/baseUrl — use modelProviders (envKey) + the env block (JSON patch) or the container's ~/.qwen/.env, then remove these fields.",
  },
  "确认卸载": { en: "Confirm uninstall" },
  "将从该 Worker 容器卸载 {cli}。安装状态会丢失，已保存的鉴权可保留。": {
    en: "This uninstalls {cli} from the Worker container. Install state is lost; saved auth is retained.",
  },
  "网络错误": { en: "Network error" },
  "退出码 {c}": { en: "Exit code {c}" },
  "安装失败": { en: "Install failed" },
  "查询任务失败": { en: "Failed to query the task" },
  "安装仍在进行，请稍后刷新": { en: "Install still in progress — refresh later" },
  "安装请求未返回任务 ID": { en: "Install request returned no task ID" },
  "该 CLI 已有安装任务进行中": { en: "An install task for this CLI is already running" },
  "当前部署模式不支持容器内安装与配置（embedded 才可执行）": {
    en: "This deployment mode does not support in-container install/config (embedded only)",
  },
  "无法在该 Worker 容器内执行管理命令": {
    en: "Cannot run management commands inside this Worker container",
  },
  "安装请求失败": { en: "Install request failed" },
  "获取（在部署宿主机执行后复制，切到上方「L1 管理面」模式粘进 ① Controller 认证字段）：": {
    en: "Obtain (run on the deployment host, copy the output, switch to the \"L1 admin plane\" mode above and paste into the ① Controller auth field):",
  },
  // ── WorkerChats Coding CLI tab（coding CLI 会话归 worker 会话区）──
  "该 Worker 的编码 CLI 一次性执行记录与原始日志（只读）": {
    en: "One-shot coding CLI runs and raw logs for this Worker (read-only)",
  },
  "该 Worker 暂无编码执行记录": { en: "No coding runs for this Worker yet" },
  "选择 Worker 后显示其 Coding CLI 执行记录": {
    en: "Select a Worker to show its Coding CLI runs",
  },
  // 15.27 批（运行时 env 预填 + 版本表格 + Coding CLI 模型选择 + check-all）：
  "QwenPaw": { en: "QwenPaw" },
  "发布时间": { en: "Released" },
  "如 2.3.0（表格未列出的 tag）": {
    en: "e.g. 2.3.0 (a tag not listed in the table)",
  },
  "容器 PID 1 实际生效环境（含 QwenPaw_* / AGENTTEAMS_* / 镜像内置 + 已保存自定义变量）。敏感键默认脱敏；自定义变量保存并容器重建后在此生效。": {
    en: "Environment actually in effect in the container (PID 1) — includes QwenPaw_* / AGENTTEAMS_* / image defaults + saved custom variables. Sensitive keys are masked by default; saved custom variables appear here after the container is recreated.",
  },
  "容器实际生效环境变量（只读预填充）": {
    en: "Effective container environment (read-only)",
  },
  "已保存（模型={m}）": { en: "Saved (model={m})" },
  "已保存（模型覆盖已清除，回退 CLI 默认）": {
    en: "Saved (model override cleared — falls back to CLI default)",
  },
  "平台注入": { en: "Platform-injected" },
  "当前=各 Worker 容器内 QwenPaw 运行时版（服务端 10min 缓存 + tab 激活后台预取），最新=PyPI（缓存），逐 Worker 本地匹配——二次点击毫秒级。": {
    en: "Current = QwenPaw runtime version inside each Worker container (server-side 10-min cache + background prefetch on tab activation); latest = PyPI (cached); matched per Worker locally — a second click is instant.",
  },
  "无匹配项": { en: "No matches" },
  "显示明文（敏感键）": { en: "Show plaintext (sensitive keys)" },
  "暂无版本列表（PyPI 不可达且无缓存）": {
    en: "No version list available (PyPI unreachable and no cache)",
  },
  "未选择（建议 {v}）": { en: "Not selected (suggested: {v})" },
  "标记": { en: "Flags" },
  "尚无配置文件——填模型名并保存即创建。": {
    en: "No config file yet — fill in the model name and save to create it.",
  },
  "无 qwenpaw 运行时 Worker（就地升级仅支持 qwenpaw）": {
    en: "No qwenpaw-runtime workers (in-place upgrade only supports qwenpaw)",
  },
  "选择要升级的 Worker（按团队分组；选一个=单独升级）": {
    en: "Select workers to upgrade (grouped by team; one = single upgrade)",
  },
  "写入慢，读回验证是否已生效…": {
    en: "Slow write — reading back to verify it took effect…",
  },
  "已生效（写入慢，读回确认模型={m}）": {
    en: "Applied (slow write, read-back confirms model={m})",
  },
  "已生效（写入慢，读回确认）": { en: "Applied (slow write, read-back confirms)" },
  "保存超时且读回未见生效——请刷新重试": {
    en: "Save timed out and read-back shows no effect — refresh and retry",
  },
  "保存超时，读回失败——请重试": {
    en: "Save timed out and read-back failed — retry",
  },
  "检查更新失败": { en: "Update check failed" },
  "注意：Controller 当前不回显已保存的自定义变量（保存=整块替换写 CRD）——已保存值以下方「运行时环境」为准（容器重建后生效）。": {
    en: "Note: the Controller currently does not echo back saved custom variables (save = whole-map replace on the CRD) — consult the “Runtime environment” section below for saved values (effective after container recreation).",
  },
  "点击展开 / 收起": { en: "Click to expand / collapse" },
  "版本列表加载失败": { en: "Failed to load version list" },
  "版本表": { en: "Version table" },
  "留空=清除覆盖（跟随 CLI 默认）": {
    en: "Empty = clear override (follow CLI default)",
  },
  "自定义版本（高级）": { en: "Custom version (advanced)" },
  "设为目标": { en: "Set as target" },
  "读取运行时环境失败": { en: "Failed to read runtime environment" },
  "过滤键名…": { en: "Filter key name…" },
  "运行时环境": { en: "Runtime environment" },
  "modelProviders 由 Higress 网关管理，默认跟 Worker——一般无需在此配置；已有路由仍可在下方查看/调整。": {
    en: "modelProviders is managed by the Higress gateway (defaults to the Worker) — usually no configuration needed here; existing routes can still be viewed/adjusted below.",
  },
  "以下为该 CLI 完整设置表单（字段目录驱动）——未设置项显示为空态，只有你改动并保存的项才写入配置文件；未列出的高级字段用下方 JSON 补丁补充。": {
    en: "Full settings form for this CLI (field-catalog driven) — unset fields show as empty states; only fields you change and save are written to the config file; use the JSON patch below for advanced fields not listed.",
  },
};
