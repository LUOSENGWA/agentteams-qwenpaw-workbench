# 安装与升级

## 前置条件

| 项 | 说明 |
|----|------|
| QwenPaw 宿主 | 2.0 – 2.2.x（插件版本门 `>=2.0.0, <3.0.0`） |
| AgentTeams 集群 | 已部署的 Controller + Matrix homeserver（插件通过宿主进程内代理访问，凭据在服务器端，浏览器零凭据） |
| 安装介质 | Release 页的 ZIP（`agentteams-qwenpaw-workbench-v0.5.0-beta.11.1.zip`） |

## 安装

**方式一：CLI（推荐）**

```
qwenpaw plugin install agentteams-qwenpaw-workbench-v0.5.0-beta.11.1.zip
```

**方式二：控制台**

QwenPaw 控制台 → 插件管理 → 上传 ZIP。

装完后在控制台首页会出现 **AgentTeams Workbench 入口**；点击即进插件页。它也能作为 PawApp 独立桌面窗口打开（两种形态功能一致）。

## 升级

1. 先卸载 / 移除旧版本（控制台插件管理 → 删除；或 CLI 卸载）
2. 安装新版 ZIP（CLI 可 `--force` 原地覆盖）
3. 浏览器强刷：`Ctrl+Shift+R`

升级不丢配置：Controller 地址与认证配置保存在本机（浏览器 localStorage + 插件后端配置），升级后仍在。

## 卸载

控制台插件管理 → 删除插件。服务端无残留状态（房间消息、审批记录都在 Matrix/Controller 侧，与插件生命周期无关）。

## 双版本兼容说明

| 宿主版本 | 行为 |
|----------|------|
| 2.2.x | 全功能 |
| 2.0 | 核心功能可用；依赖 2.1+ API 的功能（如宿主收件箱审批桥）自动降级——插件不炸机、相关入口静默不可用 |
| <2.0 / ≥3.0 | 版本门拒绝注册（预期行为） |

## 装完验证

打开插件页 → **自检 tab**：L0（后端存活）应绿；再点 L1/L2 看连通与认证状态。详见 [自检与运维](./13-selfcheck-ops.md)。
