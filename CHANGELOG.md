# 更新日志 Changelog

本文件记录 agentteams-qwenpaw-workbench 的各版本变更（公开 release 条目）。
English version: [CHANGELOG-en.md](CHANGELOG-en.md)

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
- Worker 频道配置扩展：健康检查 / 重启 / 二维码扫码授权（凭据自动回填）/ 保存前冲突预检 / PUT 热加载 + 读回校验（等上游 PR #1219 合并后自动点亮，未合并时 404 占位）
- 技能中心 3 节：技能目录（等上游 PR #1211 合并后自动点亮）/ Worker × 技能分配矩阵（已分配反显 + 保存）/ MCP Servers 矩阵（name/url/transport 行内编辑）
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
- 建团事故 G1-G5（CRD 回读 + 阶段轮询创建自检）
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
- 技能目录节 / 频道节依赖上游 PR（#1211 / #1219）合并，未合并时为 404 占位卡（预期行为）
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
