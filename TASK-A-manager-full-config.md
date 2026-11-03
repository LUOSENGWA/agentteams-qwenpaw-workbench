# 任务 A：ManagerDetailPane 完整配置 + Worker 模型弹窗 + 响应式

## 工作区
/app/working/workspaces/AgentTeamGuide/.worktrees/manage-page

## 目标
1. ManagerDetailPane 从"只有模型编辑"扩展为**完整配置面板**（和 WorkerDetailPane 的 ResourceCards 对齐）
2. WorkerDetailPane 的模型配置从内联卡改为**弹窗**（和 ManagerDetailPane 一致）
3. 模型配置弹窗**响应式**（窄屏上下/宽屏左右）

## 1. ManagerDetailPane 完整配置

文件：`frontend/src/manage/ManagerDetailPane.tsx`

当前只有：头部 + 状态卡 + 模型配置卡（弹窗编辑）。

**需要加**（参考 `frontend/src/manage/ResourceCards.tsx` 的结构，但用 Manager API）：

### 1.1 SOUL.md / AGENTS.md
- 显示当前值（从 Manager API GET /managers/{name} 的 `soul`/`agents` 字段）
- 编辑：点击→全屏 Modal（textarea，等宽字体，最小高度 300px）
- 保存：PUT /managers/{name} body={soul: "..."} 或 {agents: "..."}

### 1.2 Skills
- 列表展示（从 Manager API 的 `skills` 字段，string[]）
- 编辑：antd.Select mode="tags"（自由输入 + 已有项展示）
- 保存：PUT /managers/{name} body={skills: [...]}

### 1.3 MCP Servers
- 列表展示（从 Manager API 的 `mcpServers` 字段，[]MCPServer = [{name, url, transport?}]）
- 编辑：每行 name/url/transport + 删除按钮 + "添加"按钮
- 保存：PUT /managers/{name} body={mcpServers: [...]}

### 1.4 环境变量 (Env)
- 表格展示（key-value 对）
- 编辑：antd.Input key + antd.Input value + 删除
- 保存：PUT /managers/{name} body={env: {k: v, ...}}

### 1.5 Manager 独有 Config
- heartbeatInterval（string，如 "15m"）
- workerIdleTimeout（string，如 "720m"）
- notifyChannel（string，如 "admin-dm"）
- 用 antd.Input + 说明文字
- 保存：PUT /managers/{name} body={config: {heartbeatInterval, workerIdleTimeout, notifyChannel}}

### 1.6 状态操作
- 唤醒（Sleeping→Running）/ 休眠（Running→Sleeping）
- 调 POST /managers/{name}/restart（已存在）或 PUT state 字段
- 参考 WorkerDetailPane 的唤醒/休眠按钮

### 1.7 API 扩展
文件：`frontend/src/api/domains/crd.ts`

需要加/扩展：
```ts
/** 获取 Manager 完整 spec（含 soul/agents/skills/mcpServers/env/config）。 */
export async function fetchManagerFull(name: string): Promise<any> {
  return controllerRequest("GET", `/managers/${encodeURIComponent(name)}`);
}

/** 更新 Manager 任意字段（合并语义，只传要改的）。 */
export async function updateManager(name: string, body: Record<string, unknown>): Promise<unknown> {
  const r = await controllerRequest("PUT", `/managers/${encodeURIComponent(name)}`, body);
  invalidateTags(["teams", "admin"]);
  lruInvalidate("crd:");
  return r;
}
```

## 2. WorkerDetailPane 模型配置弹窗化

文件：`frontend/src/manage/WorkerDetailPane.tsx`

当前：模型配置是**内联卡**（在头部下方，直接显示 Select + 保存按钮）。

改为：
- 内联卡改为**只读摘要 + "点击编辑"提示**（和 ManagerDetailPane 的模型卡一致）
- 点击→`antd.Modal`（宽度 `Math.min(560, window.innerWidth - 48)`）
- Modal 内容：模型 Select（全宽 showSearch）+ Provider Select（全宽）+ 当前值摘要
- 保存逻辑不变（`updateWorkerModel`）

## 3. 模型弹窗响应式

**两个弹窗**（Manager + Worker 的模型配置弹窗）都用：
```tsx
const isNarrow = typeof window !== "undefined" && window.innerWidth < 640;
```

- **宽屏（≥640px）**：模型和 Provider **左右排列**（`display: flex; gap: 12px`，各 50%）
- **窄屏（<640px）**：**上下排列**（`display: grid; gap: 14px`，全宽）
- 标题字号：宽屏 14px / 窄屏 12px
- Modal 宽度：`Math.min(560, window.innerWidth - 48)`

## 验收标准
- [ ] tsc 0 errors
- [ ] vite build 成功
- [ ] ManagerDetailPane 有：头部 / 状态卡 / 模型弹窗 / SOUL 编辑 / AGENTS 编辑 / Skills / MCP / Env / Config / 状态操作
- [ ] WorkerDetailPane 模型改为弹窗（非内联）
- [ ] 弹窗在 375px / 768px / 1280px 宽度下布局正确
- [ ] 不引入新 npm 依赖

## 约束
- 不新增 npm 依赖
- 深浅色：用 `useThemeColors()` 的 `t.*` 变量（不硬编码颜色）
- 图标：用 antd icon 或 SVG（不用 emoji）
- 保存后 `onRefreshAdmin?.(true)` 刷新
- 每个配置卡独立保存（改 SOUL 不影响 Skills）
