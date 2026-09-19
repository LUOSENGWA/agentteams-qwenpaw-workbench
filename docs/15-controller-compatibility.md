# Controller 版本兼容（为什么有些功能看不到）

工作台的数据来自 AgentTeams Controller。部分功能依赖**较新的 Controller 端点**：你的 Controller 版本没有该端点时，对应 UI **不渲染**或显示 **404 占位卡**——这是**预期行为，不是 bug**。本页列出全部数据依赖型功能与它们的 Controller 要求。

## 快速自查

1. 查你的 Controller 版本：`docker exec agentteams-controller cat /etc/agentteams/version`（或在 dashboard 关于页）
2. 对照下表：标「**v1.2.3 未含**」的功能**已全部合并入上游 main，将随 v1.2.4 发布**（上游 2026-09-20 前后发布；v1.2.4 的主体内容正是这批功能——升级 Node Controller 到 v1.2.4 后全部自动点亮，插件不用动）。

## 功能 × Controller 要求

| 功能（工作台 UI 位置） | 数据端点 | Controller 要求 | 缺失时的表现 |
|------|------|------|------|
| spawn 树（团队管理→团队，按项目 spawn 聚合） | projects `/spawns` 聚合端点 | **v1.2.3 未含 / v1.2.4 含**（`64a77b5f`） | spawn 树不渲染 |
| spawn 节点「工具/技能白名单」标签（v0.5.0-beta.13） | spawn 端点 `subagent_allowed_tools` / `subagent_skills` 透传 | **v1.2.3 未含 / v1.2.4 含**（同 `64a77b5f`） | 标签不显示（零噪音设计） |
| 频道子 tab（团队管理→频道） | worker 频道配置代理端点 | **v1.2.3 未含 / v1.2.4 含**（#1219） | 404 占位卡（预期行为） |
| Worker runtime 配置编辑 | worker runtime 配置端点 | **v1.2.3 未含 / v1.2.4 含**（#1231） | 入口隐藏 |
| Worker 内置工具设置 | worker tools settings 端点 | **v1.2.3 未含 / v1.2.4 含**（#1255） | 入口隐藏（消费侧待下批） |
| 团队范围 KB 文件读（L2 数据面） | team worker KB 文件端点 | **v1.2.3 未含 / v1.2.4 含**（#1208） | 该层不可用 |
| 审计事件查询 | audit events 端点 | **v1.2.3 未含 / v1.2.4 含**（#1270） | 自动隐藏 |
| 聊天 / 知识图谱 / 工作流 / 模型网关浏览 / CRD 管理 / 审批等 | v1.2.3 已含端点 | **v1.2.3 起** | 正常 |

## v1.2.4 内容（2026-09-19 于上游 main 核，v1.2.3 之后 58 个 commit）

- 上表全部端点 + 本批 PR 的主体：L2 权限体系（capability 基础 #1220/#1237、L2 写面 #1274/#1276、审批 #1216、技能 #1212/#1252）、技能中心扩展（#1238/#1211）、任务状态迁移引擎（#1233）、审计（#1270/#1278）、模型/心跳/MCP 目录端点（#1242/#1247/#1250）、Matrix 群发件人隔离（#1235）、项目工作流渲染+检查 API（#1230）等
- **运行时升级**：QwenPaw Worker runtime → 2.2.1（`4179b9df`）、Manager runtime → QwenPaw 2.2（`d6150f20`）——v1.2.4 的镜像自带新 runtime
- 全部已合并入 main（作者 = LUOSENGWA 为主）；tag 待发布生成

## 规则（工作台侧无版本门）

- 工作台**不做版本门**：一律「数据在才渲染，不在就不渲染」——旧 Controller 上新功能 = 不可见（不是报错），新 Controller 上老功能 = 全可见。
- 升级 Controller 不需要重装/升级工作台插件：端点出现后，对应 UI 自动点亮（频道子 tab 有内置 404 占位卡过渡）。
- 上表「上游 #号」= AgentTeams 上游 PR 号；commit 号 = 合并进 main 的引用点（2026-09-19 核）。
