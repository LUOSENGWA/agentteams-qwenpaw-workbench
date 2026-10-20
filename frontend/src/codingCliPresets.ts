/**
 * Coding CLI 场景 preset（1.2.5 #1360 消费；数据从 dashboard
 * src/lib/coding-cli-presets/ 逐字段移植——两侧同源不漂移）。
 *
 * preset 语义（与 dashboard 一致）：
 * - settings_patch：一键 PUT 到该 CLI 的 settings（深合并；模型名等）。
 * - toolchain / mcp / artifacts：**仅建议清单**——动 CR（env）/绑 MCP
 *   是团队级决策，preset 不自动执行（human_confirm 门）。
 *
 * 15.32 新增：FIELD_CATALOG（字段目录）——三 CLI 官方 schema 全量字段的
 * 类型/双语文案登记，供面板渲染「完整表单」：目录内字段即使用户文件
 * 未设置也显示（未设置态可编辑），保存时空串自动剥离。字段来源（官方
 * schema 实证，2026-10-18 复核）：
 * - qwen-code：qwenlm.github.io/qwen-code-docs settings 全字段表
 *   （0.25.x「New Configuration Format」，含 Web Shell 浏览器内
 *   Settings 页可改的全部键）。
 * - opencode：opencode.ai/docs/config（opencode.json 全 schema）。
 * - qoder：docs.qoder.com/cli/settings（settings.json 常用配置项全表）。
 *
 * modelProviders（qwen-code）**不在目录内**：由 Higress 网关管理
 * （2026-10-18 定案：默认跟 Worker）——用户文件已有该键时仍结构化
 * 渲染（路由卡片）并附托管提示，但空态不预填、不建议配置。
 */

import type { SettingsObject } from "./api";

export const CODING_CLI_IDS = ["qwen-code", "opencode", "qoder"] as const;
export type CodingCliId = (typeof CODING_CLI_IDS)[number];

export type Redacted = { redacted: true; has_value: boolean };

// 值层不递归（嵌套对象/数组一律 unknown 化——settings 是任意 JSON，
// 深合并由 controller 执行，前端不需要值级类型）。
export function isRedacted(value: unknown): value is Redacted {
  return !!value && typeof value === "object" && (value as Redacted).redacted === true;
}

// ─────────────────────────────────────────────────────────────────────
// 字段目录（15.32：完整表单的数据源）
// ─────────────────────────────────────────────────────────────────────

/** 控件类型：bool=Switch / number=InputNumber / text=Input /
 * path=Input（路径占位）/ enum=AutoComplete（候选可自由输入）。 */
type FieldControl = "bool" | "number" | "text" | "path" | "enum";

export interface FieldSpec {
  /** 中文标签（zh 模式显示）。 */
  zh: string;
  /** 英文标签（en 模式显示；useLang 判定，不走 DICT——目录自带双语）。 */
  en: string;
  type: FieldControl;
  /** enum 候选值（AutoComplete 下拉；允许自由输入）。 */
  options?: string[];
  /** text/enum 输入框占位提示（zh）。 */
  hint?: string;
}

/**
 * 每 CLI 字段目录。key=点分全路径（仅叶子字段）；值=控件+双语文案。
 * 目录内字段在空态也渲染（未设置=空控件，保存时空串剥离不写文件）。
 * 未在目录内的键（用户自定义/未收录）=原样自由渲染（对象递归/
 * 数组 JSON 文本/字符串输入），目录不是白名单，只是「已知字段」表。
 */
export const FIELD_CATALOG: Record<CodingCliId, Record<string, FieldSpec>> = {
  "qwen-code": {
    // ── model 对象子字段（name 由模型专行管，不在此）
    "model.reasoningEffort": { zh: "推理强度", en: "Reasoning effort", type: "enum", options: ["low", "medium", "high", "xhigh", "max"] },
    "model.baseUrl": { zh: "模型端点 Base URL", en: "Model base URL", type: "text" },
    "model.sessionTokenLimit": { zh: "会话 token 上限", en: "Session token limit", type: "number" },
    "model.maxSessionTurns": { zh: "最大会话轮数", en: "Max session turns", type: "number" },
    "model.maxWallTimeSeconds": { zh: "单次挂钟预算（秒）", en: "Wall-clock budget (s)", type: "number" },
    "model.goalTokenBudget": { zh: "目标 token 预算", en: "Goal token budget", type: "number" },
    "model.goalCheckpointTimeoutSeconds": { zh: "目标检查点超时（秒，已废弃）", en: "Goal checkpoint timeout (s, deprecated)", type: "number" },
    "model.goalMaxTurns": { zh: "目标最大轮数", en: "Goal max turns", type: "number" },
    "model.goalMaxActiveMinutes": { zh: "目标活跃上限（分钟）", en: "Goal max active minutes", type: "number" },
    "model.maxToolCalls": { zh: "最大工具调用（-1=不限）", en: "Max tool calls (-1=unlimited)", type: "number" },
    "model.maxSubagentDepth": { zh: "子代理深度", en: "Max subagent depth", type: "number" },
    "model.generationConfig.timeout": { zh: "请求超时（ms，0=禁用）", en: "Request timeout (ms, 0=off)", type: "number" },
    "model.generationConfig.contextWindowSize": { zh: "上下文窗口大小", en: "Context window size", type: "number" },
    "model.chatCompression.contextPercentageThreshold": { zh: "压缩触发阈值（0-1）", en: "Compression threshold (0-1)", type: "number" },
    "model.chatCompression.maxRecentFilesToRetain": { zh: "保留最近文件数", en: "Max recent files to retain", type: "number" },
    "model.chatCompression.maxRecentImagesToRetain": { zh: "保留最近图片数", en: "Max recent images to retain", type: "number" },
    "model.chatCompression.enableScreenshotTrigger": { zh: "截图触发压缩", en: "Screenshot-triggered compression", type: "bool" },
    "model.chatCompression.screenshotTriggerThreshold": { zh: "截图触发阈值", en: "Screenshot trigger threshold", type: "number" },
    "model.skipNextSpeakerCheck": { zh: "跳过说话人检查", en: "Skip next-speaker check", type: "bool" },
    "model.skipLoopDetection": { zh: "跳过循环检测", en: "Skip loop detection", type: "bool" },
    "model.maxToolCallsPerTurn": { zh: "每轮工具调用上限", en: "Max tool calls per turn", type: "number" },
    "model.skipStartupContext": { zh: "跳过启动上下文", en: "Skip startup context", type: "bool" },
    "model.enableOpenAILogging": { zh: "OpenAI 兼容请求日志", en: "OpenAI-compatible request logging", type: "bool" },
    "model.openAILoggingDir": { zh: "OpenAI 日志目录", en: "OpenAI logging dir", type: "path" },
    "model.openAILogRetentionDays": { zh: "OpenAI 日志保留（天）", en: "OpenAI log retention (days)", type: "number" },
    // ── 模型族顶层
    "fastModel": { zh: "轻量任务模型", en: "Lightweight task model", type: "text" },
    "advisorModel": { zh: "顾问模型", en: "Advisor model", type: "text" },
    "visionModel": { zh: "视觉模型", en: "Vision model", type: "text" },
    "compactionModel": { zh: "压缩模型", en: "Compaction model", type: "text" },
    "imageModel": { zh: "图像模型", en: "Image model", type: "text" },
    "visionBridgeTimeoutMs": { zh: "视觉桥超时（ms）", en: "Vision bridge timeout (ms)", type: "number" },
    "voiceModel": { zh: "语音模型", en: "Voice model", type: "text" },
    // ── context
    "context.fileName": { zh: "上下文文件名", en: "Context file name", type: "text" },
    "context.autoCompactThreshold": { zh: "自动压缩阈值（0-1）", en: "Auto-compact threshold (0-1)", type: "number" },
    "context.importFormat": { zh: "导入格式", en: "Import format", type: "text" },
    "context.loadFromIncludeDirectories": { zh: "从包含目录加载", en: "Load from include directories", type: "bool" },
    "context.fileFiltering.respectGitIgnore": { zh: "遵循 .gitignore", en: "Respect .gitignore", type: "bool" },
    "context.fileFiltering.respectQwenIgnore": { zh: "遵循 .qwenignore", en: "Respect .qwenignore", type: "bool" },
    "context.fileFiltering.enableRecursiveFileSearch": { zh: "递归文件搜索", en: "Recursive file search", type: "bool" },
    "context.fileFiltering.enableFuzzySearch": { zh: "模糊搜索", en: "Fuzzy search", type: "bool" },
    "context.clearContextOnIdle.toolResultsThresholdMinutes": { zh: "空闲清理阈值（分钟）", en: "Idle clear threshold (min)", type: "number" },
    "context.clearContextOnIdle.toolResultsNumToKeep": { zh: "保留工具结果条数", en: "Tool results to keep", type: "number" },
    "context.clearContextOnIdle.toolResultsTotalCharsThreshold": { zh: "工具结果总字符阈值", en: "Tool results total chars threshold", type: "number" },
    // ── tools
    "tools.sandboxImage": { zh: "沙箱镜像", en: "Sandbox image", type: "text" },
    "tools.shell.enableInteractiveShell": { zh: "交互式 shell", en: "Interactive shell", type: "bool" },
    "tools.shell.defaultTimeoutMs": { zh: "Shell 默认超时（ms）", en: "Shell default timeout (ms)", type: "number" },
    "tools.shell.heartbeatIntervalMs": { zh: "Shell 心跳间隔（ms）", en: "Shell heartbeat interval (ms)", type: "number" },
    "tools.approvalMode": { zh: "审批模式", en: "Approval mode", type: "enum", options: ["plan", "default", "auto-edit", "auto", "yolo"] },
    // ── general
    "general.language": { zh: "界面语言（需重启）", en: "UI language (restart)", type: "text", hint: "auto / zh-CN / fr …" },
    "general.outputLanguage": { zh: "模型输出语言（需重启）", en: "Model output language (restart)", type: "text", hint: "auto / 具体语言" },
    "general.outputStyle": { zh: "输出风格", en: "Output style", type: "text", hint: "Concise / Proactive / Explanatory / Learning / default" },
    "general.enableAutoUpdate": { zh: "自动更新（需重启）", en: "Auto-update (restart)", type: "bool" },
    "general.chatRecording": { zh: "聊天记录落盘（关闭后 --continue/--resume 失效）", en: "Persist chat history (off disables resume)", type: "bool" },
    "general.vimMode": { zh: "Vim 键位", en: "Vim keybindings", type: "bool" },
    "general.cleanupPeriodDays": { zh: "会话备份保留（天）", en: "Session backup retention (days)", type: "number" },
    // ── ui 常用
    "ui.theme": { zh: "主题", en: "Theme", type: "text", hint: "Qwen Dark / Qwen Light …" },
    "ui.renderMode": { zh: "Markdown 渲染模式", en: "Markdown render mode", type: "enum", options: ["render", "raw"] },
    "ui.showLineNumbers": { zh: "代码块行号", en: "Code block line numbers", type: "bool" },
    "ui.hideBanner": { zh: "隐藏启动 banner", en: "Hide startup banner", type: "bool" },
    "ui.hideTips": { zh: "隐藏提示", en: "Hide tips", type: "bool" },
    "ui.showToolCallDetails": { zh: "工具调用详情内联", en: "Inline tool call details", type: "bool" },
    "ui.shellOutputMaxLines": { zh: "Shell 输出最大行数（0=不限）", en: "Shell output max lines (0=off)", type: "number" },
    "ui.enableFollowupSuggestions": { zh: "后续建议", en: "Followup suggestions", type: "bool" },
    "ui.showResponseTokensPerSecond": { zh: "显示 tokens/s 估计", en: "Show tokens/s estimate", type: "bool" },
    "tools.discoveryCommand": { zh: "工具发现命令", en: "Tool discovery command", type: "text" },
    "tools.callCommand": { zh: "工具调用命令", en: "Tool call command", type: "text" },
    "tools.useRipgrep": { zh: "使用 ripgrep", en: "Use ripgrep", type: "bool" },
    "tools.useBuiltinRipgrep": { zh: "使用内置 ripgrep", en: "Use builtin ripgrep", type: "bool" },
    "tools.workflowsEnabled": { zh: "启用工作流", en: "Enable workflows", type: "bool" },
    "tools.workflowSizeGuideline": { zh: "工作流规模指引", en: "Workflow size guideline", type: "number" },
    "tools.workflowNameOnly": { zh: "工作流仅按名匹配", en: "Workflow name-only matching", type: "bool" },
    "tools.truncateToolOutputThreshold": { zh: "工具输出截断字符阈值", en: "Tool output truncate threshold", type: "number" },
    "tools.truncateToolOutputLines": { zh: "工具输出截断行数", en: "Tool output truncate lines", type: "number" },
    "tools.toolSearch.enabled": { zh: "工具搜索", en: "Tool search", type: "bool" },
    "tools.toolSearch.threshold": { zh: "工具搜索阈值", en: "Tool search threshold", type: "number" },
    "tools.listDirectory.enabled": { zh: "目录列表工具", en: "List-directory tool", type: "bool" },
    "tools.todoWrite.enabled": { zh: "待办工具", en: "Todo-write tool", type: "bool" },
    "goals.modelProposed": { zh: "目标由模型提议", en: "Goal model-proposed", type: "bool" },
    // ── memory
    "memory.enableManagedAutoMemory": { zh: "托管自动记忆", en: "Managed auto memory", type: "bool" },
    "memory.enableManagedAutoDream": { zh: "托管自动整理", en: "Managed auto dream", type: "bool" },
    "memory.enableAutoSkill": { zh: "自动技能", en: "Auto skill", type: "bool" },
    "memory.autoSkillConfirm": { zh: "自动技能需确认", en: "Auto skill requires confirm", type: "bool" },
    "memory.enableTeamMemory": { zh: "团队记忆", en: "Team memory", type: "bool" },
    "memory.enableTeamMemorySync": { zh: "团队记忆同步", en: "Team memory sync", type: "bool" },
    "memory.enableStructuredRecall": { zh: "结构化召回", en: "Structured recall", type: "bool" },
    "memory.agentTimeoutMinutes": { zh: "记忆代理超时（分钟）", en: "Memory agent timeout (min)", type: "number" },
    "memory.agentMaxTurns": { zh: "记忆代理最大轮数", en: "Memory agent max turns", type: "number" },
    // ── agents
    "agents.builtin.exploreModel": { zh: "内置 explore 模型", en: "Builtin explore model", type: "text" },
    "agents.crossSessionMessaging": { zh: "跨会话消息", en: "Cross-session messaging", type: "bool" },
    "agents.crossSessionInbound": { zh: "跨会话入站", en: "Cross-session inbound", type: "bool" },
    // ── mcp
    "mcp.serverCommand": { zh: "MCP 服务器命令", en: "MCP server command", type: "text" },
    "mcp.toolIdleTimeoutMs": { zh: "MCP 工具空闲超时（ms）", en: "MCP tool idle timeout (ms)", type: "number" },
    // ── security
    "security.folderTrust.enabled": { zh: "文件夹信任", en: "Folder trust", type: "bool" },
    // security.auth.*（已废弃）不入目录——空态不推荐；文件已有残留由
    // qwenDeprecatedAuthFields 告警提示迁移（15.31 机制保留）。
    // ── serve / advanced / 顶层
    "serve.maxConcurrentSubSessionsPerCaller": { zh: "每调用方并发子会话", en: "Max concurrent sub-sessions per caller", type: "number" },
    "serve.maxConcurrentSubSessionsTotal": { zh: "并发子会话总数", en: "Max concurrent sub-sessions total", type: "number" },
    "advanced.autoConfigureMemory": { zh: "自动配置内存", en: "Auto-configure memory", type: "bool" },
    "advanced.dnsResolutionOrder": { zh: "DNS 解析顺序", en: "DNS resolution order", type: "text" },
    "advanced.bugCommand": { zh: "bug 反馈命令", en: "Bug report command", type: "text" },
    "plansDirectory": { zh: "plans 目录", en: "Plans directory", type: "path" },
    // ── experimental
    "experimental.sessionWorkflow": { zh: "会话工作流", en: "Session workflow", type: "bool" },
    "experimental.cron": { zh: "定时任务", en: "Cron", type: "bool" },
    "experimental.todoStopGuard": { zh: "待办停止保护", en: "Todo stop guard", type: "bool" },
    "experimental.sessionWriterLease": { zh: "会话写租约", en: "Session writer lease", type: "bool" },
    "experimental.cronRecurringMaxAgeDays": { zh: "周期任务最大存活（天）", en: "Cron recurring max age (days)", type: "number" },
    "experimental.agentTeam": { zh: "Agent 团队", en: "Agent team", type: "bool" },
    "experimental.artifact": { zh: "产物管理", en: "Artifact", type: "bool" },
    "experimental.emitToolUseSummaries": { zh: "工具使用摘要", en: "Emit tool-use summaries", type: "bool" },
  },
  opencode: {
    "small_model": { zh: "轻量任务模型（标题/摘要）", en: "Small model (titles/summaries)", type: "text" },
    "autoupdate": { zh: "自动更新（true / false / notify）", en: "Auto-update (true / false / notify)", type: "text", hint: "true / false / notify" },
    "server.port": { zh: "服务端口", en: "Server port", type: "number" },
    "server.hostname": { zh: "监听主机名", en: "Hostname", type: "text" },
    "server.mdns": { zh: "mDNS 服务发现", en: "mDNS discovery", type: "bool" },
    "server.mdnsDomain": { zh: "mDNS 域名", en: "mDNS domain", type: "text" },
    "shell": { zh: "Shell（短名或绝对路径）", en: "Shell (short name or absolute path)", type: "text" },
    "tools.read": { zh: "工具：读取文件", en: "Tool: read file", type: "bool" },
    "tools.write": { zh: "工具：写入文件", en: "Tool: write file", type: "bool" },
    "tools.edit": { zh: "工具：编辑文件", en: "Tool: edit file", type: "bool" },
    "tools.glob": { zh: "工具：文件匹配", en: "Tool: glob files", type: "bool" },
    "tools.grep": { zh: "工具：内容搜索", en: "Tool: search content", type: "bool" },
    "tools.bash": { zh: "工具：Shell 命令", en: "Tool: shell command", type: "bool" },
    "tools.webfetch": { zh: "工具：网页抓取", en: "Tool: fetch web page", type: "bool" },
    "tools.websearch": { zh: "工具：网络搜索", en: "Tool: web search", type: "bool" },
    "tools.task": { zh: "工具：子任务", en: "Tool: sub-task", type: "bool" },
    "tools.todowrite": { zh: "工具：待办清单", en: "Tool: todo list", type: "bool" },
    "tools.ls": { zh: "工具：目录列表", en: "Tool: list directory", type: "bool" },
    "tools.patch": { zh: "工具：补丁", en: "Tool: patch", type: "bool" },
    "attachment.image.auto_resize": { zh: "图片自动缩放", en: "Auto-resize images", type: "bool" },
    "attachment.image.max_width": { zh: "最大宽度（px）", en: "Max width (px)", type: "number" },
    "attachment.image.max_height": { zh: "最大高度（px）", en: "Max height (px)", type: "number" },
    "attachment.image.max_base64_bytes": { zh: "最大 base64 体积（字节）", en: "Max base64 payload (bytes)", type: "number" },
    "default_agent": { zh: "默认 Agent", en: "Default agent", type: "text" },
    "subagent_depth": { zh: "子代理嵌套深度（0=禁，1=一层，2=两层）", en: "Subagent nesting depth (0/1/2)", type: "number" },
    "snapshot": { zh: "文件快照（关闭后不可回滚）", en: "Snapshot (off = no rollback)", type: "bool" },
    "compaction.auto": { zh: "上下文满时自动压缩", en: "Auto-compact when full", type: "bool" },
    "compaction.prune": { zh: "清理旧工具输出", en: "Prune old tool outputs", type: "bool" },
    "compaction.reserved": { zh: "压缩保留 token 数", en: "Reserved tokens for compaction", type: "number" },
    "permission.edit": { zh: "权限：编辑文件", en: "Permission: edit", type: "enum", options: ["allow", "ask", "deny"] },
    "permission.bash": { zh: "权限：Shell 命令（模式对象走 JSON 补丁）", en: "Permission: bash (pattern object via JSON patch)", type: "enum", options: ["allow", "ask", "deny"] },
    "permission.webfetch": { zh: "权限：网页抓取", en: "Permission: webfetch", type: "enum", options: ["allow", "ask", "deny"] },
    "permission.websearch": { zh: "权限：网络搜索", en: "Permission: websearch", type: "enum", options: ["allow", "ask", "deny"] },
    "permission.task": { zh: "权限：子任务", en: "Permission: task", type: "enum", options: ["allow", "ask", "deny"] },
    "permission.todowrite": { zh: "权限：待办清单", en: "Permission: todowrite", type: "enum", options: ["allow", "ask", "deny"] },
    "permission.lsp": { zh: "权限：LSP", en: "Permission: lsp", type: "enum", options: ["allow", "ask", "deny"] },
  },
  qoder: {
    "outputStyle": { zh: "输出风格", en: "Output style", type: "enum", options: ["concise", "proactive", "explanatory", "learning"] },
    "language": { zh: "AI 响应语言（需重启）", en: "Response language (restart)", type: "enum", options: ["auto", "zh-CN", "en"] },
    "agent": { zh: "主线程 Agent（需重启）", en: "Main-thread agent (restart)", type: "text" },
    "ui.language": { zh: "界面语言（立即生效）", en: "UI language (instant)", type: "enum", options: ["auto", "zh-CN", "en"] },
    "ui.theme": { zh: "主题", en: "Theme", type: "text" },
    "ui.autoThemeSwitching": { zh: "跟随终端背景自动切换明暗", en: "Auto light/dark by terminal background", type: "bool" },
    "ui.maxTurns": { zh: "单条 prompt 最大轮数（1000/2000/3000/unlimited）", en: "Max turns per prompt (1000/2000/3000/unlimited)", type: "text", hint: "1000 / 2000 / 3000 / unlimited" },
    "ui.hideBanner": { zh: "隐藏启动 banner", en: "Hide startup banner", type: "bool" },
    "ui.showLineNumbers": { zh: "代码块行号", en: "Code block line numbers", type: "bool" },
    "ui.loadingPhrases": { zh: "加载时显示内容", en: "Loading phrases", type: "enum", options: ["tips", "witty", "all", "off"] },
    "ui.accessibility.screenReader": { zh: "读屏模式（需重启）", en: "Screen reader mode (restart)", type: "bool" },
    "model.reasoningEffort": { zh: "推理强度", en: "Reasoning effort", type: "enum", options: ["low", "medium", "high"] },
    "tools.useRipgrep": { zh: "使用 ripgrep 搜索", en: "Use ripgrep for search", type: "bool" },
    "tools.shell.inactivityTimeout": { zh: "Shell 无输出超时（秒）", en: "Shell inactivity timeout (s)", type: "number" },
    "security.folderTrust.enabled": { zh: "文件夹信任（需重启）", en: "Folder trust (restart)", type: "bool" },
    "security.disableYoloMode": { zh: "禁用 YOLO（bypass_permissions）模式", en: "Disable YOLO mode", type: "bool" },
    "security.blockGitExtensions": { zh: "阻止从 Git 安装扩展（需重启）", en: "Block git extensions (restart)", type: "bool" },
    "security.environmentVariableRedaction.enabled": { zh: "环境变量脱敏（需重启）", en: "Env var redaction (restart)", type: "bool" },
    "statusLine.type": { zh: "状态栏类型（当前仅 command）", en: "Status bar type (command only)", type: "text" },
    "statusLine.command": { zh: "状态栏 Shell 命令（stdin 收会话 JSON）", en: "Status bar shell command (stdin = session JSON)", type: "text" },
    "statusLine.padding": { zh: "状态栏水平边距（字符）", en: "Status bar padding (chars)", type: "number" },
  },
};

/**
 * 顶层段（section）双语文案——顶层键的标题。叶子字段的文案在
 * FIELD_CATALOG 内；此处仅顶层分组名（modelProviders 不在此：
 * 它渲染时自带 Higress 托管提示）。
 */
export const SECTION_LABELS: Record<string, { zh: string; en: string }> = {
  model: { zh: "模型（Model）", en: "Model" },
  fastModel: { zh: "快速模型", en: "Fast model" },
  advisorModel: { zh: "顾问模型", en: "Advisor model" },
  visionModel: { zh: "视觉模型", en: "Vision model" },
  compactionModel: { zh: "压缩模型", en: "Compaction model" },
  imageModel: { zh: "图像模型", en: "Image model" },
  voiceModel: { zh: "语音模型", en: "Voice model" },
  context: { zh: "上下文（Context）", en: "Context" },
  tools: { zh: "工具（Tools）", en: "Tools" },
  goals: { zh: "目标（Goals）", en: "Goals" },
  memory: { zh: "记忆（Memory）", en: "Memory" },
  agents: { zh: "子代理（Agents）", en: "Agents" },
  permissions: { zh: "权限（Permissions）", en: "Permissions" },
  slashCommands: { zh: "斜杠命令", en: "Slash commands" },
  skills: { zh: "技能（Skills）", en: "Skills" },
  mcp: { zh: "MCP 允许列表", en: "MCP allowlist" },
  mcpServers: { zh: "MCP 服务器", en: "MCP servers" },
  security: { zh: "安全（Security）", en: "Security" },
  serve: { zh: "服务模式", en: "Serve" },
  advanced: { zh: "高级（Advanced）", en: "Advanced" },
  experimental: { zh: "实验性", en: "Experimental" },
  general: { zh: "通用（General）", en: "General" },
  output: { zh: "输出（Output）", en: "Output" },
  review: { zh: "代码评审", en: "Review" },
  ui: { zh: "界面（UI）", en: "Interface" },
  ide: { zh: "IDE 集成", en: "IDE integration" },
  privacy: { zh: "隐私", en: "Privacy" },
  telemetry: { zh: "遥测（Telemetry）", en: "Telemetry" },
  outboundCorrelation: { zh: "出站关联", en: "Outbound correlation" },
  modelFallbacks: { zh: "模型回退", en: "Model fallbacks" },
  modelPricing: { zh: "模型计价", en: "Model pricing" },
  plansDirectory: { zh: "plans 目录", en: "Plans directory" },
  // opencode
  small_model: { zh: "轻量任务模型", en: "Small model" },
  server: { zh: "服务器（serve/web）", en: "Server" },
  shell: { zh: "Shell", en: "Shell" },
  attachment: { zh: "图片附件", en: "Image attachments" },
  compaction: { zh: "上下文压缩", en: "Compaction" },
  permission: { zh: "权限（Permission）", en: "Permission" },
  watcher: { zh: "文件监听", en: "File watcher" },
  plugin: { zh: "插件", en: "Plugins" },
  instructions: { zh: "指令文件", en: "Instruction files" },
  disabled_providers: { zh: "禁用提供商", en: "Disabled providers" },
  enabled_providers: { zh: "启用提供商（白名单）", en: "Enabled providers" },
  provider: { zh: "提供商（Provider）", en: "Provider" },
  agent: { zh: "自定义 Agent", en: "Custom agents" },
  command: { zh: "自定义命令", en: "Custom commands" },
  default_agent: { zh: "默认 Agent", en: "Default agent" },
  subagent_depth: { zh: "子代理深度", en: "Subagent depth" },
  snapshot: { zh: "文件快照（可回滚）", en: "Snapshot" },
  autoupdate: { zh: "自动更新", en: "Auto-update" },
  formatter: { zh: "代码格式化", en: "Formatter" },
  lsp: { zh: "LSP 服务器", en: "LSP servers" },
  // qoder
  outputStyle: { zh: "输出风格", en: "Output style" },
  language: { zh: "响应语言", en: "Response language" },
  statusLine: { zh: "状态栏", en: "Status bar" },
};

/**
 * 空态起点模板（15.30 初版；15.31 官方 schema 补齐；15.32 收缩回
 * 「少量预填」——完整字段清单由 FIELD_CATALOG 驱动渲染，模板只放
 * 有实际预填意义的值，避免把 CLI 默认值全量显式写死进文件）。
 *
 * qwen-code 的 model 是对象 {name, ...}：name 由模型专行管（树内跳过），
 * 其余子字段此处预填起点值。opencode 的 model 是扁平串（专行管）。
 *
 * secretPaths=模板里的密钥路径（渲染为密码框，保存时若仍为空则丢弃，
 * 不写空密钥）。**15.31**：qwen-code 凭据已迁到 modelProviders[].envKey
 * + 顶层 env 块（官方 Model Providers 文档）；**15.32**：modelProviders
 * 由 Higress 网关管理（默认跟 Worker）——模板不再含该段，凭据由
 * 网关侧管；容器内直连场景用 env 块（JSON 补丁）或 ~/.qwen/.env。
 */
interface CodingCliSeed {
  /** 空态模板。渲染为结构化表单起点（完整字段由 FIELD_CATALOG 驱动）。 */
  template: SettingsObject;
  /** 模板中的密钥路径（渲染为密码框 + 空值保存时丢弃）。 */
  secretPaths: string[];
  /** JSON 补丁占位示例（每 CLI 最高频的补丁需求）。 */
  patchPlaceholder: string;
}

export const CODING_CLI_SEEDS: Record<CodingCliId, CodingCliSeed> = {
  "qwen-code": {
    template: {
      // model.name 由模型专行管（树内跳过）；其余子字段预填起点。
      model: {
        generationConfig: {
          timeout: 120000,
        },
      },
      tools: {
        approvalMode: "auto",
      },
      context: {
        autoCompactThreshold: 0.85,
      },
      ui: {
        theme: "Qwen Dark",
      },
      general: {
        enableAutoUpdate: false,
      },
      // modelProviders 不预填（Higress 托管，默认跟 Worker）。
    },
    secretPaths: [],
    patchPlaceholder:
      '{"env": {"OPENAI_API_KEY": "sk-..."}, "model": {"generationConfig": {"contextWindowSize": 131072}}}',
  },
  opencode: {
    template: {
      $schema: "https://opencode.ai/config.json",
      permission: {
        edit: "ask",
        bash: "ask",
        webfetch: "ask",
      },
    },
    secretPaths: [],
    patchPlaceholder:
      '{"provider": {"local": {"npm": "@ai-sdk/openai-compatible", "options": {"baseURL": "http://host:30000/v1", "apiKey": "not-needed"}}}}',
  },
  qoder: {
    template: {
      // qoder 默认值显式预填（与官方默认一致，保存无行为变化）。
      ui: {
        autoThemeSwitching: true,
        maxTurns: 1000,
      },
      tools: {
        useRipgrep: true,
        shell: {
          inactivityTimeout: 300,
        },
      },
      security: {
        folderTrust: {
          enabled: true,
        },
        disableYoloMode: false,
      },
    },
    secretPaths: [],
    patchPlaceholder:
      '{"mcpServers": {"demo": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"]}}}',
  },
};

/**
 * 每 CLI 已知坑告警（tr 源文本=zh，组件 tr() 包裹，i18n 注册 en 键）。
 * 空态/常态都显示（选中 CLI 时）——把「配置写了但不生效」的坑前置。
 */
export const CODING_CLI_WARNINGS: Record<CodingCliId, string> = {
  "qwen-code":
    "modelProviders 由 Higress 网关管理（默认跟 Worker）——一般无需在此配置。Qwen Code 0.25.x 已知行为：settings 的 model 可能仍请求默认模型（qwen3.7-max），自定义网关无此模型时报 403——headless 建议 per-run -m <model> 指定。API Key 由网关侧管理；容器内直连场景写 env 块（JSON 补丁）或 ~/.qwen/.env，不要写已废弃的 security.auth.apiKey。",
  opencode:
    "OpenCode 1.19.x 只读项目级 <workspace>/.config/opencode/opencode.json；本面板写全局 ~/.config/opencode/，对 opencode run --dir 可能不生效——provider 配置需放项目级（JSON 补丁）。",
  qoder:
    "Qoder 账号登录走 QODER_PERSONAL_ACCESS_TOKEN env（非 settings）；BYOK 自定义模型走 /model 向导。本表单管 model / tools / mcp / permissions。",
};

/**
 * 15.31：qwen-code 废弃字段检测——base 里出现非空的
 * security.auth.apiKey / baseUrl（旧格式残留，官方标 Deprecated）→
 * 面板告警提示迁移到 modelProviders + env。
 */
export function qwenDeprecatedAuthFields(
  settings: SettingsObject | null | undefined,
): string[] {
  if (!settings) return [];
  const auth = (settings.security as SettingsObject | undefined)?.auth as
    | SettingsObject
    | undefined;
  if (!auth || typeof auth !== "object") return [];
  const hit: string[] = [];
  for (const k of ["apiKey", "baseUrl"]) {
    const v = auth[k];
    if (typeof v === "string" && v !== "") hit.push(`security.auth.${k}`);
    else if (v && typeof v === "object" && (v as { redacted?: boolean }).redacted)
      hit.push(`security.auth.${k}`);
  }
  return hit;
}
