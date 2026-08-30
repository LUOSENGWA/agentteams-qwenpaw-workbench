# 致谢与引用（Acknowledgments）

agentteams-qwenpaw-workbench 的开发参考并复用了多个开源项目的成果。
按**借鉴深度**分三类登记，每一处都注明来源——对开源社区劳动的基本尊重。

## 一、代码移植（源码级复用，已逐处注明出处）

### QwenPaw（[agentscope-ai/QwenPaw](https://github.com/agentscope-ai/QwenPaw)，Apache-2.0）

| 移植内容 | 上游出处 | 落点 |
|----------|----------|------|
| 知识图谱节点详情面板（状态徽章「已索引文件/未解析链接/分类根」+ 出链·n / 入链·n 可跳转列表 + 打开 Markdown + 节点 description） | `console/src/features/files-workspace/MemoryGraphView.tsx` | 知识库图谱详情面板（2D/3D 共享） |
| 3D 图谱渲染配方（节点自绘结构、布局参数 charge -108 / link distance 72 / alpha decay 0.038、四灯组光照、FogExp2 雾效、相机 `fitGraphModel` 三时机适配、zoom 上下限、节点半径/标签规则） | 同上（MemoryGraphView 3D 分支） | `frontend/src/components/Graph3D.tsx`（文件头注明出处） |
| 工具执行安全四档卡片选择器（图标映射 STRICT=Ban / SMART=AlertTriangle / AUTO=Shield / OFF=CircleCheck + 整卡可点选择 + 官方 info 提示行） | 官方控制台 `ToolExecutionLevelCard` + 官方文档 `website/public/docs/security.zh.md` 执行级别章 | 审批组件 `ApprovalControl.tsx` |
| 审批模式官方描述内容（四档表官方原文 + 控制台截图热链 + 控制台管理功能清单） | 同上（官方文档安全章） | 审批组件「说明（官方）」 |
| 3D 组件版本基准（three 0.185.1 / 3d-force-graph 1.80.0 / three-spritetext 1.10.0） | `console/package.json` | 构建依赖 |
| README 安装说明格式 | QwenPaw 官方文档「插件系统」章 | 本仓库 README / README-en |

以上代码移植遵循 Apache-2.0 要求：源码文件头注释注明上游出处，
许可全文见 QwenPaw 仓库 LICENSE。

### agentteams-dashboard（[agentteams-group/agentteams-dashboard](https://github.com/agentteams-group/agentteams-dashboard)，许可证未声明）

| 移植内容 | 上游出处 | 落点 |
|----------|----------|------|
| TruncatedId 长标识符截断组件（>16 字符「前 8…后 4」+ 悬停完整值 + 一键复制） | `manager-card.tsx` | `frontend/src/components/TruncatedId.tsx`（文件头注明出处） |
| Docker 日志流解析算法（8 字节头 type+size+payload） | `parseDockerLogs` | `agentteams_connector/router.py::_parse_docker_stream`（TS → Python 独立重写，算法逐位对齐） |
| 任务看板状态映射（workflow 状态 → 看板列，14 case 逐条对齐） | `workflowToBoard`（#85） | `frontend/src/components/WorkflowBoard.tsx` |
| 组件名→容器名映射（`resolveContainerName`）、运维数据源端点选择 | 运维面板 | `router.py`、`OpsPanel.tsx` |
| 工作流状态色标 / 三视图布局设计 | 项目工作流页 | `WorkflowCard.tsx` / `WorkflowBoard.tsx` |

## 二、互操作协议与机制（API / 协议级对接，非代码复制）

### AgentTeams / HiClaw（[agentscope-ai/AgentTeams](https://github.com/agentscope-ai/AgentTeams)，Apache-2.0）

- `agentteams.workflow` 事件格式（workerflow `nodes` DAG：id / subagent /
  task / dependsOn）与项目级/任务级状态语义
- TeamHarness 工具消息显示格式（`🔧` / `✅` 前缀 renderer 约定）
- 长消息附件元数据（`com.agentteams.long_message`）
- 交付产物机制（artifact publish → Matrix `m.file`）
- 三级认证链设计（L1 admin token / L2 Matrix token + Human CR 范围过滤 /
  房间聚合降级）
- Controller REST API（teams / workers / humans / projects / workflow /
  checkpoints / artifacts / docker 代理）

### Matrix CS-API v3（开放标准，[spec.matrix.org](https://spec.matrix.org/v1.11/client-server-api/)）

聊天、话题（m.thread）、已读回执（m.read + m.fully_read）、邀请接受/拒绝、
房间静音（m.muted_room account data）、编辑（m.replace）/撤回、/sync
长轮询、m.direct DM 命名——全部按 CS-API 标准端点实现。

### SGLang

集群负载只读 `GET /v1/loads` REST 接口（字段语义按 SGLang
`load_snapshot.py` 源码核对），无代码参考。

## 三、交互设计参考（独立实现，未复制代码）

### Element Web / matrix-react-sdk（[element-hq/element-web](https://github.com/element-hq/element-web)，AGPL-3.0 / GPL-3.0 双许可）

聊天界面交互设计模式（UI 行为与布局思路）：消息线程折叠（「N 条回复」）、
引用回复形态（ReplyTile：左竖色条 + 小头像 + 着色名 + 单行预览）、hover
操作条、@mention 补全弹层（@ 触发 / 子串匹配 / ↑↓ 键盘导航）、时间分组
规则（>24h 或跨本地午夜）、时间戳 hover 降噪、乐观回显与三态徽标、输入框
草稿持久化、空态隐藏发送按钮、IME 组合输入守卫、房间列表单一时间序（群/DM
交错）、发送者分组、文件卡形态。

**AGPL 合规说明**：本插件未包含 Element 任何源文件或衍生代码，仅借鉴交互
设计模式（UI 交互模式不受版权约束），本插件整体许可不受 AGPL 传染。若
未来需要逐行移植 Element 代码，必须同时以 AGPL-3.0 发布——当前无此情况。

### 其他

- 2D 力导向知识图谱、md 渲染器（含表格）、CSV 解析、json 高亮 tokenizer、
  房间名三级模糊搜索（子串 / 有序子序列 / Levenshtein）均为自研，无第三方
  依赖。
- React 18 / antd 5 由 QwenPaw 宿主运行时提供（插件声明类型契约，不打包、
  不分发）。

## 相关文档

- 打包内第三方组件清单与许可全文：[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
- 设计文档《QwenPaw-工作台-设计方案.md》§引用与致谢、element-research/
  研究文档（逐条标注「Element 做法（文件:行号）+ 本插件借鉴」对照）
