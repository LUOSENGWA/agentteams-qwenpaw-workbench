# 架构与安全

## 产品形态

- **不改宿主一行代码**：纯插件（QwenPaw plugin 规范），装进任何 2.0–2.2 QwenPaw 实例即可
- 两种打开方式功能一致：控制台内嵌页 / PawApp 独立桌面窗口
- 前端 = React 单页（构建产物 dist，零裸 import，宿主 blob 环境兼容）；后端 = `agentteams_connector` 包（进程内 Python 模块）

## 进程内代理与零凭据原则

```
浏览器页面 JS ──(仅本机宿主 API)──> /agentteams-proxy/* 路由（宿主进程内）
                                          │
                              agentteams_connector 后端
                                          │ 服务器端凭据（本机存储）
                              ┌───────────┴───────────┐
                          Matrix homeserver      AgentTeams Controller
```

- **浏览器零凭据**：页面 JS 永远不直接持有 Matrix/Controller token 直连外部——一切外部调用经宿主进程内代理，凭据只存在本机（浏览器 localStorage + 后端本机配置）
- 代理层统一处理：多地址自动探测/切换、错误归一化、权限门（L1/L2 路由级拦截）

## 数据正源

| 数据 | 正源 | 说明 |
|------|------|------|
| 团队/Worker CRD、项目、技能、集群状态 | Controller API | 结构化数据的唯一事实源 |
| 房间消息、审批、附件、`` | Matrix | 房间侧事实（Controller 没有的视图） |
| 工作流执行树 | Controller（spawn 正源填充） | 拓扑视图据此渲染 |

## 权限模型

L1（admin token）/ L2（Matrix level-2 Human）两级，路由级权限门——能力矩阵见 [配置参考](./12-config.md)。L2 的边界 = 该 Matrix 账号在集群里的可访问范围（房间成员 + 项目权限），不是插件放宽出来的。

## 双版本兼容策略

- 版本门 `>=2.0.0, <3.0.0`（注册期拒绝不兼容宿主）
- 依赖 2.1+ 宿主 API 的功能（宿主收件箱审批桥）**运行时探测**——宿主无该 API 整桥静默禁用，其余功能不受影响（宿主 2.0 上审批仍有插件内三面：toast/通知中心/首页卡）

## 已知限制

| 限制 | 状态 |
|------|------|
| 技能目录节 / 频道节 404 占位 | 等上游 PR #1211 / #1219 合并后自动点亮（无需升级插件） |
| 3D 图谱 WebGL 缺失回退 2D | 浏览器能力边界，自动降级 |
| 宿主收件箱审批 tab 按 session 过滤时可能不显示 `agentteams` 合成会话记录 | 导航抖动/红点/插件页内审批卡不受影响（记录本身可经宿主全量接口查到） |
| Worker 容器无法自行接受 Matrix 房间邀请（镜像无 Matrix CLI） | 上游平台限制——Manager 可代 join；项目群邀请经团队管理页人工接受 |
| 群房间中未 @ 的消息不进 Worker 消费队列 | Matrix/Worker 协议行为（非插件缺陷）——插件所有发命令路径都带三重 @ 规避 |

## 安全承诺

- 凭据只存本机、不出网（除必要的 Matrix/Controller API 调用）
- 无遥测、无第三方上报
- 开源许可：Apache-2.0；第三方组件见 [THIRD-PARTY-NOTICES](../THIRD-PARTY-NOTICES.md)
