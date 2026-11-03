# 任务 C：聊天页优化 + 性能 + 屎山清理

## 工作区
/app/working/workspaces/AgentTeamGuide/.worktrees/manage-page

## 目标
1. 聊天页（RoomChat / RoomChatCore / TurnTimeline）优化和重构
2. 性能优化（渲染/内存/重渲染）
3. 屎山清理（死代码/unused imports/重复逻辑）
4. 图标替换（emoji → SVG/Harmony 图标）

## 1. 聊天页优化

### 1.1 RoomChat.tsx / RoomChatCore.tsx
- 当前有 QC 批次 3 的改动（renderWindow / TurnTimeline tick marks / loadmore fix）—— 先确认这些改动是否完整可用
- 检查消息列表虚拟化：长列表（>100 条消息）是否卡顿
- 如果没虚拟化：用 `react-window` 或自实现 windowing（不新增依赖则用 CSS `content-visibility: auto`）
- 消息渲染：`React.memo` 每条消息（避免全量重渲染）

### 1.2 TurnTimeline.tsx
- 确认刻度轨（tick marks）渲染正确
- 动画性能：CSS transform（不触发 reflow）

### 1.3 ProcessCollapseBar / TaskEventCard
- 确认折叠/展开交互流畅
- 大列表（>50 条事件）不卡顿

## 2. 性能优化

### 2.1 重渲染
- `React.memo` 包装高频渲染组件（消息气泡/事件卡）
- `useCallback` 稳定回调引用（避免子组件无效重渲）
- `useMemo` 缓存计算（消息列表/时间线数据）

### 2.2 内存
- 检查 EventListener 是否泄漏（add 无 remove）
- 检查大数组/对象是否在 useMemo 外创建
- 图片/头像：lazy load + 合适尺寸

### 2.3 Bundle
- 检查是否有未 tree-shake 的大依赖
- 动态 import 重模块（如 Monaco/编辑器）

## 3. 屎山清理

### 3.1 全仓扫描
```bash
# unused imports
npx tsc --noEmit 2>&1 | grep "TS6133"
# dead code（未被引用的 export）
# 重复逻辑（grep 相同模式 >3 处）
```

### 3.2 具体检查
- `frontend/src/` 下所有 `.tsx` / `.ts` 文件
- 删掉注释掉的代码块（>5 行）
- 删掉未使用的 CSS 类
- 合并重复的工具函数
- 检查 `as any` 滥用（>20 处需修复）

### 3.3 i18n
- `frontend/src/i18n/domains/*.ts`：未使用的翻译 key
- 硬编码中文/英文字符串（应该走 `tr()`）

## 4. 图标替换

### 4.1 扫描 emoji
```bash
grep -rn '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' frontend/src/ --include="*.tsx" --include="*.ts"
```

### 4.2 替换策略
- 用 antd icon（`@ant-design/icons`，已在依赖中）
- 或用 Harmony 图标库（如果 `frontend/src/` 下有 SVG 组件）
- 或内联 SVG（<20 行的简单图标）
- **不用 emoji 字符**

### 4.3 特殊注意
- 状态图标（Running/Sleeping/Stopped）→ 用 CSS 圆点（`<span style={{background: color, borderRadius: '50%'}}>`）
- 角色图标（Manager/Worker/Leader）→ 用 antd UserOutlined / TeamOutlined / CrownOutlined
- 操作图标（编辑/删除/保存）→ 用 antd EditOutlined / DeleteOutlined / SaveOutlined

## 验收标准
- [ ] tsc 0 errors
- [ ] vite build 成功
- [ ] `grep -rn '[\x{1F300}-\x{1FAFF}]' frontend/src/` 结果为空（无 emoji）
- [ ] 无 unused import（tsc TS6133 为 0）
- [ ] 消息列表 100+ 条不卡顿（`content-visibility` 或虚拟化）
- [ ] 不新增 npm 依赖

## 约束
- 不改 ManagerDetailPane.tsx / TeamSection.tsx（那是任务 A 的文件）
- 不改 useManageNav.ts（任务 A 的文件）
- 深浅色：用 `useThemeColors()` 的 `t.*` 变量
- 所有图标不用 emoji
