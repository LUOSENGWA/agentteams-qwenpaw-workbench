# 团队管理

五个子 tab：**团队（n） / 用户（n） / Manager（n） / 频道 / 技能中心**。团队结构数据源 = 真实 Team/Worker CRD（L1 全量 / L2 可访问范围）。

## 团队（n）

- **团队列表 + Worker 树**：每个团队下挂真实 Worker 结构（spawn 树按正源填充），Worker 卡显示运行状态/阶段
- **Worker 模型内联编辑**（v0.5.0-beta.9 起）：Worker 卡上直接改模型（provider 不动、diff 只发改动、保存走 `PUT /workers` 合并语义、保存后回读校验）；换绑 Worker 会重新拉基线
- **模型候选下拉 = 并集**（v0.5.0-beta.12 起，beta.12 扩到 Manager 表）：建 Worker 弹窗/建队行/团队配置内联三入口 + Manager 表模型列（beta.12）共用同一候选并集（`../modelUnion` 共享模块，同一写前校验）= ① 网关 alias（路由可解析，经 L1 密码模式的 Console 会话从 Higress AI routes + providers 实时取）② 内置 alias（AgentTeams 官方 16 别名）③ 在服 SGLang ∪ 在用模型；无 Console 会话时 alias 层隐藏，**token 模式下显式提示**（beta.12：CRD 面板顶 + Manager 表上方黄条——配 admin 账号密码可读，或等 P1-3），自由输入照旧
- **建队 / 入职 / 改配 / 删除**（L1）：CRD 管理入口。创建流程内置防线：建队行级 model/SOUL 先落 Worker CR 再建 Team、写前三入口校验（路径形态硬拒）、创建自检（CRD 回读 + 阶段轮询）
- **房间基线警示**：刚配置完成、房间基线未建立时，页顶显示警示横幅（此时首页「发起任务」只有 Manager 入口）
- **Worker 行 phase/runtime 徽章**（v0.5.0-beta.12 起，A8b）：Worker 行显示 `phase` 状态点 + `runtime`（+版本），数据 = Worker CR 字段，admin 数据未加载时回退 team-structure 透传，零新请求；**1:1 Worker 房间的聊天头**同样有 phase/runtime 双徽章
- **私聊直跳个人房间**（v0.5.0-beta.12 起，A8a-fix）：点 Worker「私聊」优先直跳该 Worker 的个人房间（CR `roomID`）——Worker 容器无法接受 Matrix 邀请，新建 DM 房间 Worker 进不来（死路）；无 `roomID` 才回退新建 DM

## 用户（n）

Human CRD 列表：Matrix 人类账号 + 权限等级（level 1 admin / level 2 普通成员）。Controller 的 Matrix 认证只放行 level 2——等级不对的账号用 L2 模式会 401（见 [配置参考](./12-config.md)）。

## Manager（n）

Manager 实例列表与状态。Manager 是团队内的协调者（收发消息、房间管理、Worker 状态巡检），不是人类账号。

- **模型列可编辑**（v0.5.0-beta.12 起，对齐 dashboard Manager 编辑弹窗）：同一模型并集下拉 + 写前校验；保存走 `PUT /managers/{name} {model}`（Controller 合并语义——只写非空字段，provider 保持原值）；改完由 Controller 调和重启 Manager 容器生效（分钟级）
- **运行时列**（v0.5.0-beta.12 起）：每个 Manager 显示自己的 `runtime`（Manager CR 字段，零新端点）——运行时管理归团队管理，运维页不再放多运行时卡
- **详情面板（行展开）**（v0.5.0-beta.12 起，A6）：展开行显示 镜像/版本/MXID/个人房间 + **私聊（直跳个人房间）** + **日志**（L1，最近 300 行，走既有 docker-logs 代理，零新端点）

## 频道

**Worker 频道配置**（上游 AgentTeams PR #1219 合并后自动点亮；未合并时为 404 占位卡——预期行为）：

- **schema 驱动表单 / JSON 双模式**：每个 Worker 的频道（QQ/钉钉等）配置卡，表单与 JSON 同源互转
- **启用 / 停用、健康检查、重启**：对单个 Worker 的频道通道操作
- **二维码扫码授权**：扫码后凭据自动回填到配置（人不需要手抄 token）
- **保存前冲突预检**：与 Worker 现有配置比对，冲突先提示
- **PUT 热加载回读校验**：保存后回读确认生效
- 2.0 宿主下 worker 级 404 自动跳过（不报错）

## 技能中心

三节：技能目录 / Worker×技能矩阵 / MCP 矩阵。详见 [技能中心与 MCP](./11-skills.md)。

## 权限

| 操作 | L2 | L1 |
|------|:---:|:---:|
| 查看团队/Worker（可访问范围） | ✅ | ✅ |
| 模型编辑（CRD 三入口 + Manager 表） | ❌（Worker 卡只读展示） | ✅ |
| 建队/入职/改配/删除（CRD） | ❌ | ✅ |
| 频道配置写操作 | 限本团队 | ✅ |
| 技能矩阵 / MCP 矩阵写 | 限本团队 | ✅ |
