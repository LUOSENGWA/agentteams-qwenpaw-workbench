# AgentTeams QwenPaw Workbench（AgentTeams 团队工作台）

**版本 Version**：0.5.0-beta.8 ｜ **作者 Author**：AgentTeamGuide
**依赖要求 Requirements**：QwenPaw ≥ 2.1.0（`qwenpaw_version: >=2.1.0, <2.2.0`）+ AgentTeams Controller（HiClaw 集群）

## 简介

通过 QwenPaw 接入你的 AgentTeams（HiClaw）集群：查看与管理团队、工作流、项目、产物交付、Worker 成员与 3D 知识图谱，并支持在房间里直接 @成员、审批 Worker 工具执行安全级别。插件同时以控制台内联页面与桌面独立窗口（PawApp）两种形态自动生效，无需修改宿主代码。

A team workbench for AgentTeams (HiClaw) clusters through QwenPaw: manage teams, workflows, projects, deliverables, workers and a 3D knowledge graph. Works both as an in-console page and a desktop app window (PawApp) — no host code changes.

## 功能 Features

| Tab | 能力 |
| --- | --- |
| 🏠 首页 | 团队/任务/Worker/产物/最近动态/集群负载概览 + 待审批卡片（批准/拒绝直走宿主原生审批链路）+ 快捷操作 |
| 💬 聊天 | 团队房间聊天（Matrix 直连）、话题面板、成员详情卡、房间收藏/静音/退出/删除（Element 同款）、消息搜索、@提及 |
| 🔔 通知 | 通知中心（@提及/任务进展聚合收件箱，点击跳房间并定位消息） |
| 🔀 工作流 | 三视图（列表/卡片/看板）+ 项目任务图（暂停/继续/重规划） |
| 📦 产物 | 项目产物文件树 + 在线预览 + 下载 |
| 👷 团队管理 | Worker 层级树、审批模式（工具执行安全四档：严格/智能/自动/关闭）、团队/Worker/员工（Human CR）CRD 管理与团队访问矩阵（L1），建团队时可直接新建 Worker |
| 📚 知识库 | 远端 Worker KB 与本地记忆浏览、预览、下载、2D/3D 知识图谱 |
| 🎯 技能 | 宿主 Agent 技能管理（SkillPool） |
| 🔍 自检 | L0-L4 连通性自检（Matrix/Controller/MinIO/Worker/KB） |
| 🛠️ 运维 | 集群负载、容器日志（L1） |
| ⚙️ 配置 | Controller 地址/凭据、Matrix 登录、深色主题、启动页开关 |

## 安装 Installation

> 与 QwenPaw 官方插件文档一致（QwenPaw 官方文档「插件系统」章）：插件操作只能在 QwenPaw **离线**时执行。
> Same as the official QwenPaw plugin docs: plugin operations can only be performed while QwenPaw is **offline**.

**方式一：控制台界面（推荐）** / **Option 1: Console UI (recommended)**

1. 打开 QwenPaw 控制台 → **设置 → 插件管理**（Settings → Plugin Manager）
2. 点击 **安装**（Install），选择本 ZIP 文件（`agentteams-qwenpaw-workbench-v0.5.0-beta.8.zip`）
3. 安装完成后刷新控制台，侧边栏出现 **🏢 AgentTeams QwenPaw Workbench**

**方式二：CLI** / **Option 2: CLI**

```bash
# 从本地安装（先停 QwenPaw）/ install from local path (stop QwenPaw first)
qwenpaw plugin install /path/to/agentteams-qwenpaw-workbench-v0.5.0-beta.8.zip

# 从 URL 安装（支持 ZIP）/ install from URL (ZIP supported)
qwenpaw plugin install https://example.com/agentteams-qwenpaw-workbench-v0.5.0-beta.8.zip

# 强制重新安装（覆盖升级）/ force reinstall (upgrade in place)
qwenpaw plugin install /path/to/agentteams-qwenpaw-workbench-v0.5.0-beta.8.zip --force
```

**方式三：GitHub Release URL** / **Option 3: GitHub Release URL**

```bash
qwenpaw plugin install https://github.com/LUOSENGWA/agentteams-qwenpaw-workbench/releases/download/v0.5.0-beta.8/agentteams-qwenpaw-workbench-v0.5.0-beta.8.zip
```

（控制台「安装」弹窗同样支持粘贴 URL 安装。/ The Console install dialog also accepts a URL.）

**升级提示 Upgrade**：
- 控制台：先在「已安装」列表**删除旧版**，再安装新版 ZIP（宿主对已安装插件的直接重复上传返回 409「Uninstall it first before reinstalling」，不支持 UI 原位覆盖）
- CLI：`--force` 可原位覆盖（见上）

配置（Controller 地址/凭据）保留在插件配置中、收藏等偏好保留在浏览器 localStorage 中，升级不丢失。
To upgrade: in the Console, **remove the old version first**, then install the new ZIP (the host rejects re-uploading an installed plugin with 409 "Uninstall it first"); the CLI supports in-place overwrite via `--force`. Your configuration and favorites survive the upgrade.

## 配置 Configuration

安装后打开工作台 → **⚙️ 配置**：

1. **Controller 地址**：AgentTeams Controller 的 API 地址（如 `http://<node>:6866`，支持多地址故障转移）
2. **凭据**（二选一）：
   - **L1 管理员**：粘贴 Controller admin token（`docker exec agentteams-controller cat /var/run/agentteams/cli-token`）
   - **L2 普通成员**：选「Matrix 登录」，填自己的 Matrix 账号（用户名 + 密码，入职时交付）。L2 仅能读写自己 `accessibleTeams` 范围内的数据（上游 A2 认证 + 范围过滤）
3. **Matrix 地址**：默认与 Controller 同机（`http://<node>:6867`），一般无需改
4. 点 **保存并自检**——🔍 自检 tab 会逐项验证 L0-L4 连通性

## 卸载 Uninstall

- 控制台：设置 → 插件管理 → 已安装 → 删除
- CLI：

```bash
qwenpaw plugin uninstall agentteams-qwenpaw-workbench
```

## 常见问题 FAQ

| 现象 | 处理 |
| --- | --- |
| 控制台重复上传 ZIP 报 409 | 先在「已安装」删除旧版再装（或 CLI `--force` 覆盖） |
| 自检 L1 失败（Controller 不可达） | 核对 Controller 地址与网络；多节点部署填全部地址 |
| L2 提示「无权限」 | 正常——L2 只能访问自己团队的数据；Worker 配置修改等管理操作需 L1 |
| 3D 图谱不可用 | 浏览器不支持 WebGL 时自动回退 2D 图谱 |
| 房间看不到/进不去 | 需先被邀请（团队 scope 房间由平台自动邀请；被邀请后在「邀请」区接受） |

## 许可与第三方组件 License

本插件依赖的第三方组件清单（含许可与用途）见包内 `THIRD-PARTY-NOTICES.md`。

See `THIRD-PARTY-NOTICES.md` in this package for the full third-party component list with licenses.

> **仓库 Repo**：[LUOSENGWA/agentteams-qwenpaw-workbench](https://github.com/LUOSENGWA/agentteams-qwenpaw-workbench)（文档 + Release 安装包；插件注册 ID 为 `agentteams-qwenpaw-workbench`）