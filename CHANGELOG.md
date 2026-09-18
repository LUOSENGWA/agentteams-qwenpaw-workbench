# 更新日志 Changelog

本文件记录 agentteams-qwenpaw-workbench 的各版本变更（公开 release 条目）。
English version: [CHANGELOG-en.md](CHANGELOG-en.md)

---

## 0.5.0-beta.12.8（2026-09-18）

**2D 知识图谱缩放/聚焦/簇分离 + 聊天内工作流卡 live 刷新（与 dashboard 对齐）**

- **2D 知识图谱缩放/平移**：滚轮以光标为锚点缩放（0.25×–8× 钳制，越界以视野中心为锚回缩）+ 拖拽平移 + ＋/－/⟳ 复位按钮；高倍（>2.5×）自动标签薄化（只留簇根 + 悬停标签，SVG 文字等比放大防糊）
- **2D 知识图谱簇聚焦**：单击 virtual 簇根（分类根/Worker 根）→ 视野动画收敛到该簇 bbox（320ms easeOutCubic）+ 簇外元素淡出 0.1 +「🎯 退出聚焦」chip；双击文件节点 → 邻域聚焦（节点 + 一度邻接）；无根图谱中双击伪根（度数最高文件）→ 其扇区聚焦（伪根单击仍开文件预览，语义不变）；Esc / 点背景 / chip / ⟳ 退出
- **2D 知识图谱簇分离**：扇区间留 GAP 空白楔（扇区数 R≤6: 0.38rad / >6: 0.24rad，2×半角+GAP=整圆恒等——修旧公式 R≥8 时相邻扇区弧带重叠）+ 虚线扇区边界弧（hub 色 14% 透明）；R=1 单扇区=整圆均布（废旧 0.92 系数空楔）
- **聊天内工作流卡 live 刷新**：项目工作流卡是一次性发布的快照，任务推进只发生在 Controller 侧 → 卡片恒旧。现聊天 tab（活动房间消息含 workflow 卡时）复用工作流 tab 的 15s 正源轮询（Controller projects/workflow 双轨）做 overlay：状态/步骤/参与 Worker 逐字段优先正源、回退快照，LIVE 徽标（绿点脉冲 + 事件时间戳）仅正源轨接通时显示；正源降级（无 Controller token，走已加入房间扫描轨）时传空=不 overlay 不显徽标（不误导）；workerflow 卡（子代理 fan-out）消息本体靠 m.replace 已实时 → 零额外请求
- **i18n**：1 新键登记（中英）

**Verification**: pytest 42/42 · tsc 0 · check-antd 交叉通过 · vite build 绿（440 模块，双守卫）· i18n ui↔dict 对账（新键登记）

---

## 0.5.0-beta.12.7（2026-09-18）

**2D/3D 知识图谱大幅优化 + 工作流页重构（卡片/拓扑 → 项目列表+详情）**

- **2D 知识图谱换分层径向布局**：以分类根（Wiki/个人/SOP）或 Worker（聚合模式）为扇区、hub 置中心、文件按 BFS 深度环 + 名称排序分布，单环过密自动外溢同心环，标签加描边 halo、视图按内容自适应——替代旧纯力导向布局（不同分类节点混叠、稠密边成毛球、标签互相压盖），与 dashboard 知识库 2D 图谱同算法同值
- **3D 知识图谱再收紧**：电荷 -60→-50、连线距离 44→38、连线强度 0.5→0.52（散点再聚合一档，双端同值）；标签标准与 dashboard 对齐（全节点标注，旧 count≤42 条件废弃）
- **工作流卡片视图重构为 master-detail**：左侧项目列表（时间/状态/名称排序、独立滚动、状态色条高亮），右侧选中项目详情（事件卡 + 任务卡网格，复用看板任务卡含取消/重试）；左侧选择与卡片/拓扑两视图共用
- **工作流拓扑视图重构为分层 DAG**：移植 dashboard 任务看板同源算法（dependsOn 建边 + 自上而下分层 + bezier 边箭头 + 就绪青虚线框/圆点 + 外部依赖注记），替代旧「缩进树」；成环/无根仍给诚实提示
- **空态更具体**：选中 planning 项目在卡片/拓扑视图下显示「项目可能还在 planning（Coordinator 起草计划中）」而非笼统空态

**验证**：pytest 42/42 · tsc 0 · vite build 绿（440 模块，双守卫）· i18n ui↔dict 对账（6 新键登记、孤儿键清零）

---

## 0.5.0-beta.12.6（2026-09-18）

**知识库 3D 图谱间距与 dashboard 定案值对齐**

- **知识库 3D 图谱力参数收紧**：电荷 -108→-60、连线距离 72→44、连线强度 0.46→0.5——与 dashboard 知识库 3D 图谱经装验定案的参数同款（原值下节点间距偏大、连线稀疏），2D/3D 图谱布局、点节点预览等交互不受影响

**Verification**: pytest 42/42 · tsc 0 · vite build 绿（dist/index.js 单文件）· check-antd 交叉通过

---

## 0.5.0-beta.12.5（2026-09-18）

**L2 权限面补全 + 模型网关可视 + 工作流自动刷新（对齐 dashboard 实时性）**

- **模型网关只读路由目录（运维 tab，L1）**：新增「模型网关路由」卡片——路由名（=网关 `/v1` 入口，非模型 ID）/ 上游 provider+权重 / 授权 consumer，数据来自 Controller 只读端点（token 鉴权，token 模式 L1 也可读）；Controller 低于该端点版本时 404 自动隐藏整卡，L2 调用显权限提示。token 模式下模型下拉仍只列内置 alias + 本地 SGLang（网关 alias 编辑需 Console 密码路径），本卡片提供网关路由配置的只读可视
- **知识库 L2 可读（Controller 数据面兜底）**：团队 scope 用户（L2）此前读 KB 恒 403（KB 走 Docker 代理，L1-only）。现 Docker 通道不可用时自动切 Controller workspace-files 端点：日记（memory/**）/ 知识库（digest/**）/ MEMORY.md（档案）三分类，本团队 scope；档案其它文件与「文件」分类仍 L1-only。L1 全四分类行为不变（Docker 优先）
- **审批 L2 可读写（Controller 数据面兜底）**：L2 此前读写 Worker 审批恒 403。现 Docker 不可用时切 Controller approval 端点：L2 可设 严格/智能/自动（关闭 OFF 需 L1）；team leader 只读；Manager 审批仍 L1-only（无对应端点）
- **工作流 tab 自动刷新（P1-7）**：tab 可见期 15 秒静默轮询（切走即停），对齐 dashboard 的 15s 轮询实时性——此前工作流看板只在挂载/手动刷新/登录时拉取，任务推进不自动更新
- **注释与文案精确化**：频道接入 / 技能目录两处的「上游未合并」措辞更新为「Controller 版本门控」（相关端点已合入上游主线，仅低于合并版本的 Controller 才 404 占位）

**验证**：pytest 42/42（+6 新：KB/审批 L2 兜底 ×6）· tsc 0 · vite build 绿（439 模块）· i18n ui↔dict 对账（新键全登记、孤儿键清零）

---

## 0.5.0-beta.12.4（2026-09-15）

**新功能：Worker session 运行指示（A17，零后端改动）**
- 聊天列表房间卡 / Worker 管理行 / 1:1 聊天头部三处新增 8px 状态圆点：**蓝（呼吸动画）= 运行中 / 绿 = 运行完成（近 10 分钟有活动）/ 灰 = 无任务**，悬停显示状态文案
- 数据全部来自既有 Matrix `/sync` 载荷（typing 事件 + 房间最后消息时间 + 成员表），纯前端派生，无新端点、无新请求；60 秒自动老化（done→idle 边界翻转不依赖新消息）
- 呼吸动画对齐 QwenPaw 控制台 `AgentStatusIndicator` 实现（1.2s 周期，opacity + 光晕扩散），`prefers-reduced-motion` 系统设置下自动关动画
- 团队群卡片/头部：任一 Worker 正在处理时显蓝点（群内无「最后发言者」数据，不显示绿/灰，避免人类消息误触）
- 已知限制：typing 信号硬上限 2 分钟（Worker 端 25 秒续期、超时置 false），长任务超过 2 分钟会暂时显示为绿/灰而非持续蓝

## 0.5.0-beta.12.3（2026-09-13）

**安全 / 对齐**
- 知识库文件过滤补齐敏感清单（产物部分对齐 dashboard）：对齐 dashboard ChatRoom 文件面板的 `SENSITIVE_PATTERNS`——`credentials/`（目录）、`openclaw.json`（runtime 配置，含 provider 信息）、`*.lock` 从知识库树/目录列表剔除，直读命中返 404（不泄露存在性）。隐藏文件（`.ssh/`、`.hermes/config.yaml`）各列取点此前已过滤，本轮补齐非隐藏部分并加直读守卫。+7 回归测试（guard 在任何数据通道调用前拦截 / 普通路径放行 / 既有格式校验不变）

---

## 0.5.0-beta.12.2（2026-09-13）

**新增**
- CRD 管理页新增「导出 JSON」按钮（参考 dashboard 团队页同款）：一键导出 teams/workers/humans/managers 四类 CRD 全量，文件名 `agentteams-crd-YYYY-MM-DD.json`
- 品牌 logo 全面替换 🏢 emoji：应用标题栏 / 首页欢迎条 / 侧边栏菜单图标 / App Center 卡片（`icon_url` 内嵌 data URI，desktop 模式直接显示 AgentTeams logo，与 dashboard 同一 logo 文件）

**修复 / 对齐**
- 「新建 Worker」从建队卡内折叠区独立成卡（用户反馈）：建队卡聚焦团队字段，Worker 卡始终可见；行为不变（创建成功仍自动加入建队表单成员行）
- 新建 Worker 运行时下拉修正：移除 CoPaw（已退役）、补上 DeepSeek Harness（上游近期新增运行时 `deepseek-harness`）、默认 QwenPaw（= 安装脚本默认值，此前默认 OpenClaw 有误）

---

## 0.5.0-beta.12.1（2026-09-13）

**新增**
- 新建 Worker 表单增加运行时选择（OpenClaw / CoPaw / Hermes / QwenPaw，默认 OpenClaw = 集群默认），随 Worker CR 的 `spec.runtime` 落库——与 dashboard 新建 Worker 对齐

---

## 0.5.0-beta.12（2026-09-10 · 正式号）

相对 beta.8 的新增与修复（按功能归类）：

**模型选择与网关**
- 模型下拉三层分组候选：Higress alias（路由可解析）/ Higress 内置 alias（需配路由映射）/ 在服 ∪ 在用并集；四个模型入口（建队卡 / 建 Worker 弹窗 / 配置团队行 / Manager 表）开屏即见 alias 组
- 建队表单 Worker 行模型选择器（在服候选 + 写前三重校验）+ 配置团队弹窗内联编辑现有 Worker 模型（`PUT /workers` 合并语义，diff 只发改动字段，provider 不动）
- L1 管理员凭据二选一：Higress Console admin 账号密码 / Controller admin token，各带「验证」按钮；验证即自检（按钮下常驻「N 条路由 / M 个可解析 alias」回报）
- Higress Console 原生 AI 路由（EQUAL 精确匹配写法）开箱即用
- Higress（Console）管理地址显式必填（固定端口盲探测移除；留空 = 可操作错误）
- Controller token 获取命令一键复制（`docker exec agentteams-controller cat /var/run/agentteams/cli-token`）+ 非 docker 部署 env 注入（`AGENTTEAMS_CONTROLLER_TOKEN`）
- Manager 表模型列可编辑（合并语义：只提交改动字段，provider 不动）

**团队管理与运行时**
- Worker 频道配置扩展：健康检查 / 重启 / 二维码扫码授权（凭据自动回填）/ 保存前冲突预检 / PUT 热加载 + 读回校验（等上游频道端点合并后自动点亮，未合并时 404 占位）
- 技能中心 3 节：技能目录（等上游技能端点合并后自动点亮）/ Worker × 技能分配矩阵（已分配反显 + 保存）/ MCP Servers 矩阵（name/url/transport 行内编辑）
- 宿主技能更名（= 本机 QwenPaw 实例的 SkillPool）+ 首页入口
- 逐 Worker 运行时彩色标签 + phase 状态点；Manager 详情面板（镜像 / 版本 / MXID / 个人房间 / 日志 / 私聊直跳）；Worker 私聊直跳个人房间
- 房间卡最后消息预览；工作流页 15s 自动刷新 + 视图 tab 记忆（事件/卡片/看板/拓扑 + 选中项目）
- 邀请 / 审批主动通知：新房间邀请桌面 toast + 通知中心入口（跳团队概览接受/拒绝）
- 邀请接受修复：`invite-accept` 改走 `/join` 路由——「邀请收不到 / 点接受没反应」修复
- QwenPaw 2.0 / 2.2 双版本兼容（`qwenpaw_version` 门 `[2.0.0, 3.0.0)`）

**审批**
- 宿主收件箱审批接入：Worker 工具审批请求进入宿主收件箱（导航自动抖动 + 红点 + 审批条目），一键批准/拒绝，决议自动发 Matrix 命令回房间（零轮询零 mock，三重 `@Worker`；宿主 <2.1 自动降级，插件内审批卡不受影响）
- 双路径审批闭环：插件卡批准后，宿主收件箱不再补发陈旧 deny
- 审批命令带 `@Worker`（两种形态均识别）；首轮 sync 补检离线期间审批

**知识图谱**
- 点文件节点直接开预览（2D/3D 双链路，请求竞态三层修复）；2D/3D 命中区放大（3D 自适应球 + 2D 命中圈）；3D「点不动」修复（自持点击层，拖拽/点击判定分离）
- 聚合图谱团队化（知识库聚合图谱按团队维度聚合）

**修复**
- 建团自检（CRD 回读 + 阶段轮询创建自检）
- 技能中心刷屏根因修 / 插件炸机修（裸 `import` 构建守卫六形态）/ 聊天「全部」单一时间序

**文档与术语**
- 中英产品文档 14 页（本仓库 `docs/`）
- Controller / Higress 术语全量分离（两个独立系统，各配各的地址）

**排版与可读性**
- 竖屏 / 手机排版系统（容器 = 视口宽、建队卡单列、模型列首屏可见度大幅提升）
- 表单字段标题全覆盖

**验证**
包内三处版本复核一致（plugin.json / 后端 / README）；tsc 0 / 构建绿 / 单测 29/29 / 包内敏感扫描清零

**已知限制**
- 技能目录节 / 频道节依赖上游端点（技能目录/频道）合并，未合并时为 404 占位卡（预期行为）
- 3D 图谱在浏览器不支持 WebGL 时自动回退 2D
- 宿主收件箱审批 tab 按 session 过滤时可能不显示 `agentteams` 合成会话记录（导航抖动 / 红点 / 插件页内审批卡不受影响）

---

## 0.5.0-beta.8（2026-08-30）

- 插件更名为 **agentteams-qwenpaw-workbench**（全量改名：插件 ID / entry_page / tool 前缀 / 显示名 / 路由 / localStorage 键，旧键自动迁移）
- **聊天页群 / DM 双 tab**（Element 式）：房间列表、DM 命名回退（`m.direct` → Worker 真名）、未读 / 蓝点
- **知识图谱 2D/3D 双引擎**：2D 力导向（自研 d3-free 物理模拟）+ 3D（three.js 渲染），节点 / 边 / 统计栏 / 文件预览联动
- **审批模式四档卡片选择器**（对齐官方安全级别）：STRICT / SMART / AUTO / OFF，Worker 级 + 团队级统一入口
- **Worker 通道配置**（团队管理 tab 内节）：QQ / 钉钉 / 企业微信 schema 驱动表单，启用 / 停用 / 重启 / 健康检查 / 凭据回填
- **消息全文搜索**：房间名三级模糊（子串 / 有序子序列 / Levenshtein）+ 消息关键字搜索
- **长 ID 截断组件**：>16 字符「前 8…后 4」+ 悬停完整值 + 一键复制
- **通知中心**：邀请 / 审批 / 系统事件聚合，toast + 桌面通知
- **自检 L0-L4**：宿主 / 凭据 / 网络 / 服务 / 行为五级分层诊断
- 构建硬守卫：裸 `import` 检查 + 敏感信息扫描入发版流程


---

## 安装

```
qwenpaw plugin install agentteams-qwenpaw-workbench-v0.5.0-beta.12.zip
```

（控制台「已安装」删除旧版后重装，或 CLI `--force` 覆盖；强刷 Ctrl+Shift+R）
