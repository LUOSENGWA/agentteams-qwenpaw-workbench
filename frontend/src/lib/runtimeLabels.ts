// runtimeLabels — 运行时 face 标题的中文映射（F-CFG-I18N）。
//
// 来源与限制（2026-11-07 核实）：
// - OpenClaw 的 `ui/src/i18n/locales/zh-CN.ts` 只是 `virtual:` 模块再导出，
//   仓库内没有实际中文串；Hermes 的 `locales/zh.yaml` 是 CLI/审批提示词，
//   不含配置分区标题。所以这里没有可原样搬用的上游词条。
// - 本表是我们自己的中文命名词典：覆盖两个运行时的全部**面向用户**的 face；
//   纯技术阈值类 face 保持英文原 id（翻译反而误导）。
// - 字段标题仍用 surface 下发的 `label`（上游英文），这里只处理 face 级。

export type RuntimeName = "openclaw" | "hermes" | string;

const OPENCLAW: Record<string, string> = {
  gateway: "网关",
  models: "模型",
  agents: "Agent",
  tools: "工具",
  channels: "频道",
  messaging: "消息",
  voice: "语音",
  session: "会话",
  automation: "自动化",
  "skills-plugins": "技能与插件",
  mcp: "MCP",
  browser: "浏览器",
  security: "安全",
  observability: "可观测",
  ui: "界面",
  workspace: "工作区",
};

const HERMES: Record<string, string> = {
  model: "模型",
  providers: "提供方",
  fallback_providers: "备用提供方",
  fallback: "回退策略",
  credential_pool_strategies: "凭据池策略",
  toolsets: "工具集",
  database: "数据库",
  runtime: "运行时",
  session: "会话",
  sessions: "会话",
  attachments: "附件",
  agent: "Agent",
  terminal: "终端",
  web: "Web",
  browser: "浏览器",
  worktrees: "工作树",
  checkpoints: "检查点",
  context: "上下文",
  memory: "记忆",
  compression: "压缩",
  prompt_caching: "提示缓存",
  mcp: "MCP",
  mcp_servers: "MCP 服务",
  mcp_discovery_timeout: "MCP 发现超时",
  mcp_single_query_discovery_timeout: "MCP 单次查询超时",
  tool_output: "工具输出",
  tool_loop_guardrails: "工具循环护栏",
  tools: "工具",
  skills: "技能",
  plugins: "插件",
  hooks: "钩子",
  hooks_auto_accept: "钩子自动接受",
  approvals: "审批",
  command_allowlist: "命令白名单",
  quick_commands: "快捷命令",
  security: "安全",
  auth: "认证",
  vault: "密钥库",
  secrets: "密钥",
  privacy: "隐私",
  telemetry: "遥测",
  monitoring: "监控",
  logging: "日志",
  network: "网络",
  proxy: "代理",
  gateway: "网关",
  streaming: "流式",
  model_catalog: "模型目录",
  model_overrides: "模型覆盖",
  models_dev: "模型（开发）",
  auxiliary: "辅助模型",
  delegation: "委派",
  goals: "目标",
  loops: "循环",
  moa: "MoA",
  curator: "策展",
  honcho: "Honcho",
  timezone: "时区",
  slack: "Slack",
  discord: "Discord",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  mattermost: "Mattermost",
  matrix: "Matrix",
  platforms: "平台",
  display: "显示",
  dashboard: "仪表盘",
  voice: "语音",
  tts: "语音合成",
  stt: "语音识别",
  vision: "视觉",
  wake_word: "唤醒词",
  human_delay: "拟人延迟",
  bot_mode: "机器人模式",
  code_execution: "代码执行",
  computer_use: "电脑操作",
  desktop: "桌面",
  local_runtime: "本地运行时",
  updates: "更新",
  doctor: "诊断",
  onboarding: "引导",
  lsp: "语言服务",
  kanban: "看板",
  cron: "定时任务",
  personalities: "人格",
  platform_hints: "平台提示",
  x_search: "X 搜索",
  nous: "Nous",
  vertex: "Vertex",
  openrouter: "OpenRouter",
  bedrock: "Bedrock",
};

const BY_RUNTIME: Record<string, Record<string, string>> = {
  openclaw: OPENCLAW,
  hermes: HERMES,
};

/** face 标题：我们的词典优先，其次上游 label，最后原 id。 */
export function labelFor(runtime: RuntimeName, faceId: string, fallback?: string): string {
  const table = BY_RUNTIME[runtime || ""] ?? {};
  return table[faceId] ?? (fallback && fallback.trim() ? fallback : faceId);
}

/** 字段标题：surface 的 label 优先（上游英文），否则 key 尾段。 */
export function fieldLabel(_runtime: RuntimeName, key: string, fallback?: string): string {
  if (fallback && fallback.trim()) return fallback;
  const tail = key.split(".").pop() ?? key;
  return tail.replace(/[_-]+/g, " ");
}
