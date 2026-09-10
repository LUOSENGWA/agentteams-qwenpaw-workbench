# AgentTeams Workbench 文档

AgentTeams QwenPaw Workbench（`agentteams-qwenpaw-workbench`）是 AgentTeams（HiClaw）集群在 QwenPaw 里的**一站式团队协作工作台**：团队管理、工作流跟踪、项目产物、团队知识库与知识图谱、团队聊天、审批与通知、技能与 MCP 管理，全部在一个控制台页面（或独立桌面窗口）里完成——不改宿主一行代码。

- 英文文档：[README-en.md](./README-en.md)
- 版本：v0.5.0-beta.11.1（支持 QwenPaw 2.0 – 2.2）

## 快速开始（3 步）

1. **安装**：`qwenpaw plugin install agentteams-qwenpaw-workbench-v0.5.0-beta.11.1.zip`（详见 [安装与升级](./01-install.md)）
2. **配置**：打开插件页 → 配置 tab → 默认 Matrix 登录模式（L2，无需 token）；需要全量管理权再填管理员 token（L1）（详见 [5 分钟上手](./02-quickstart.md)）
3. **开工**：首页看全局概览，发起任务 / 进团队群聊 / 处理审批

## 功能文档

| # | 文档 | 内容 |
|---|------|------|
| 01 | [安装与升级](./01-install.md) | 前置条件、安装 / 升级 / 卸载、双版本兼容 |
| 02 | [5 分钟上手](./02-quickstart.md) | 首次配置、L1/L2 权限选择 |
| 03 | [首页](./03-home.md) | 协作总览、发起任务、概览卡、待审批 |
| 04 | [团队管理](./04-teams.md) | 团队 / 用户 / Manager / 频道 / 技能中心五个子页 |
| 05 | [工作流](./05-workflows.md) | 事件 / 卡片 / 看板 / 拓扑四视图 |
| 06 | [产物与项目](./06-artifacts.md) | 项目产物（Controller 正源）+ 房间附件 |
| 07 | [知识库](./07-knowledge.md) | 四分类浏览、跨 Agent 搜索、2D/3D 知识图谱 |
| 08 | [团队聊天](./08-chat.md) | 全部时间序、线程、房间管理、消息搜索 |
| 09 | [审批](./09-approvals.md) | 插件内审批 + 宿主收件箱审批桥（@ 机制详解） |
| 10 | [通知](./10-notifications.md) | 通知中心、房间邀请、桌面提醒 |
| 11 | [技能中心与 MCP](./11-skills.md) | 技能目录、Worker×技能矩阵、MCP 矩阵 |
| 12 | [配置参考](./12-config.md) | 地址自动探测、双模式认证、L1/L2 权限矩阵 |
| 13 | [自检与运维](./13-selfcheck-ops.md) | L0-L3 分层自检、集群负载 |
| 14 | [架构与安全](./14-architecture.md) | 进程内代理、零凭据原则、已知限制 |

## 环境要求

| 组件 | 要求 |
|------|------|
| QwenPaw 宿主 | 2.0 – 2.2.x（2.0 下 2.1+ 新功能自动降级） |
| AgentTeams 集群 | Controller（API 正源）+ Matrix homeserver（房间/聊天） |
| 浏览器 | 现代 Chromium 系（3D 图谱需 WebGL，缺失自动回退 2D） |

## 许可

[Apache-2.0](../LICENSE)
