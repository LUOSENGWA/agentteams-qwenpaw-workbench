# R4 — 工作台 a11y 自动化门（A11Y-REPORT）

分支：`feat/a11y`（base `a5799c4` build 16.121） · 工作树：`.worktrees/a11y`
日期：2026-11-07

## 0. 方法与选择（任务书分支判定）

任务书给了两条路：「axe-core 已在 devDeps 才用；没有则自研静态断言」。

**实际走的是第二条（自研静态断言）。证据：**

- `frontend/package.json` 的 `devDependencies` / `dependencies` 均无 `axe-core`（也无 `jsdom`/`@testing-library/*`）；`frontend/node_modules` 下无 `axe-core`、无 `vitest`（vitest 走 npx 缓存，版本 5.1.0）。
- 任务书要求「不新增依赖」→ 不引入 axe-core / jsdom / happy-dom，避免新增依赖面与渲染器桩。
- 因此门 = **源码级静态扫描**：纯函数 `frontend/src/lib/a11yStatic.ts`（零依赖 JSX 标签结构解析）+
  `frontend/tests/a11y-static.vitest.test.ts`（13 个用例，其中 13 条断言，实跑 174 passed 全量）。

## 1. 检查项（六条规则）

| 规则 | 判据 | 说明 |
| --- | --- | --- |
| `icon-button-name` | `antd.Button icon=…` / 原生 `<button>` 纯图标 → 必须有 `aria-label` 或 `title` | 读屏不能只念「按钮」 |
| `clickable-div-role` | `<div onClick>` 必须有交互 `role`（button/checkbox/switch/…） | 裸 div 键盘/读屏完全不可达 |
| `clickable-div-keyboard` | `role="button"` 的 div 还须 `tabIndex` + `onKeyDown` | 回车/空格可触发 |
| `checkbox-aria-checked` | `role="checkbox"` 的 `aria-checked` 必须存在，字面值 ∈ `true/false/mixed` | 三态合法 |
| `dialog-aria-modal` | 自绘 `role="dialog"` 必须 `aria-modal="true"` | antd.Modal 自带，不在本规则面 |
| `form-control-name` | `antd.Input/Password/TextArea/Select/Switch/Checkbox/Radio/Radio.Group/Segmented` 与原生 input/textarea/select 必须有 `aria-label`/`aria-labelledby`（Checkbox/Radio 的 children 文本算名字；`aria-hidden="true"` 的隐藏域豁免） | placeholder 不是名字，失焦即消失 |

扫描器实现要点：注释先掩码（长度不变 → 行号不漂），所以注释里贴的 `<button role="checkbox">` 示例不误报；
`a11y-static-exempt: <理由>` 是唯一豁免通道（测试断言理由非空）。

受检源码面（关键 5 页 + 页内共享组件，共 10 文件）：

- 文件页：`manage/FilesSection.tsx`、`manage/files/SyncSettingsModal.tsx`、`manage/files/SyncScopeDialog.tsx`
- 工作流看板：`components/WorkflowBoard.tsx`、`workflowboard/BoardView.tsx`、`workflowboard/blocks.tsx`、`workflowboard/panels.tsx`
- Worker 详情：`manage/WorkerDetailPane.tsx`
- 设置页：`components/SettingsTabView.tsx`、`components/SettingsTabShared.tsx`

## 2. 发现（首跑 45 条违规，9 个文件）

- 表单控件缺无障碍名字：**39 处**（设置页 26、设置页共享 AddrAuthEditor/启动页 4、文件页 2（网格排序 Select / 递归 Switch）、同步设置 1、看板 2（排序 Select / 视图 Segmented）、看板弹窗 4（取消原因、暂停原因、重规划 JSON、介入意见））。
- 图标按钮缺名字：**2 处**（看板刷新 `ReloadIcon`、看板卡任务取消 `CloseIcon`）。
- 可点 div 键盘不可达：**3 处**（看板卡标题、Worker 详情模型卡、设置页连通性测试行）。
- 已合规、无需改动：文件页批量选择 `button role="checkbox"`（`aria-checked` 三态 + `aria-label` + 44px 热区）、
  命令面板自绘弹窗（`role="dialog"` + `aria-modal="true"`）、同步范围弹窗全部 Switch 均带 `aria-label`、
  文件行/网格卡（`role="button"` + `tabIndex` + `onKeyDown` 三件套）。

规则校准（首跑后修正，非放宽）：

- `antd.Checkbox`/`antd.Radio` 的 children 就是可见字段名 → 计入名字，避免把「有文字标签的复选框」误判为缺名字（首跑误报 3 条）。
- 补入 `Radio.Group` / `Segmented`（分组/分段控件自身也需要名字）→ 新增 3 条真实缺口。

## 3. 修复清单（源码 9 文件，44 处行为/属性修复 + 1 处豁免说明）

| 文件 | 处数 | 修复 |
| --- | --- | --- |
| `manage/FilesSection.tsx` | 2 + 1 | 网格排序 Select `aria-label="排序方式"`；递归 Switch `aria-label="递归"`；树行 `role=button tabIndex=-1` 注明 roving tabindex 豁免（键盘由容器 `tabIndex=0 + onKeyDown` 接管，不改行为） |
| `manage/files/SyncSettingsModal.tsx` | 1 | 「取消同步」路径输入框 `aria-label`（原仅 placeholder） |
| `components/WorkflowBoard.tsx` | 4 | 排序 Select `aria-label`；刷新图标按钮 `aria-label="刷新"`；视图 Segmented `aria-label="视图切换"`；左栏拖拽分隔条改 `role="separator"` + `tabIndex=0` + `←/→`（Shift 大步）键盘调宽 + `aria-valuenow/min/max` |
| `workflowboard/BoardView.tsx` | 2 | 看板卡标题 **div onClick → 真 `<button type="button">`**（样式复位：透明底/无边框/无内边距/`textAlign:start`，`display` 仍由 `.wb-clamp-2` 接管，布局不变；无详情入口时 `disabled`）；任务取消图标按钮 `aria-label` |
| `workflowboard/blocks.tsx` | 3 | 暂停原因、重规划 JSON、介入意见三个输入 `aria-label` |
| `workflowboard/panels.tsx` | 1 | 任务取消原因 `aria-label` |
| `manage/WorkerDetailPane.tsx` | 1 | 模型配置卡：可点时补 `role="button"` + `tabIndex=0` + 回车/空格打开弹窗（不可点时整组属性不挂，不谎报可交互） |
| `components/SettingsTabView.tsx` | 26 | Matrix/Controller/Higress/SGLang 内网+外网地址、地址模式 Select、特效档 Select、Controller 认证 Radio.Group/Segmented、token、Higress 管理员账号/密码、Matrix 登录账号/密码、SGLang 开关、导出/设置/导入备份密码（3）、导出/导入 JSON TextArea、聊天强制分栏 Switch 全部补 `aria-label`；隐藏 file input 标 `aria-hidden="true"` |
| `components/SettingsTabShared.tsx` | 6 | 地址认证方式 Select、用户名/密码/API Key 三输入 `aria-label`；启动页 Segmented `aria-label`；连通性测试行可点 div 补 `role="button"` + `tabIndex` + `aria-expanded` + 回车/空格切换 |
| `i18n/domains/missing.ts` | 12 键 | 上述 aria-label 新增中文键的 en 对照（i18n 覆盖测试全绿；`scripts/i18n-gate.mjs` 见 §5） |

布局影响：全部为属性/语义增补；唯一结构变化是看板卡标题 `div→button`，已做按钮样式复位（透明、无边框、无 padding、左对齐、宽度 100%，
`display` 由既有 `.wb-clamp-2` 类控制），未改任何尺寸/间距 token。

## 4. 未修（低优先，超出本次范围）

1. **文件树展开/收起 `<span role="button">`**（`FilesSection.tsx` 树行内）：嵌套在 `role="button"` 的行内 → 嵌套交互元素属结构问题，
   需重做树控件（行改 `treeitem` + `aria-expanded`）；本次仅保留容器方向键导航，不改变结构。
2. **地址字段的校验/必填提示未与控件 `aria-describedby` 关联**（设置页）：提示文本目前是视觉兄弟节点，
   读屏在聚焦时读不到；涉及提示节点 id 化，改动面较宽。
3. **设置页部分区块标题是裸中文文本（未经 `tr()`）**：本次只补控件名字，未改标题渲染（属 i18n 债，非 a11y 债）。
4. **`title` 仅作兜底**：图标按钮保留原有 `WbTooltip`（悬停/触屏长按），`aria-label` 与之同文案，不做重复播报清理。
5. **WCAG 对比度/焦点环**：静态源码不可判，未纳入门（需真实渲染 + 颜色计算；无 axe-core 时不做假阳性断言）。

## 5. 门（全部在本工作树实跑）

| 门 | 命令（cwd=`frontend/`） | 结果 |
| --- | --- | --- |
| tsc | `npx --no-install tsc -p tsconfig.json --noEmit` | **0 错误**（exit 0） |
| vitest | `npx --no-install vitest run` | **16 文件 / 174 用例全绿**（基线 161 + 新增 13） |
| build | `npx --no-install vite build` | **✓ built in 7.57s**，700 modules，`../dist/index.js` 2,589.29 kB（守卫插件 `no-module-imports-guard` / `full-minify-guard` 均通过） |
| i18n 覆盖（vitest 内） | `tests/i18n-coverage.vitest.test.ts` | 绿（新增 12 键均有 en，占位符不变） |

补充说明：

- **`dist/` 未纳入本次提交**：build 门只验证「能构建」，产物按仓既定流程由 `build: 16.xxx` 提单独重建
  （本分支基于 16.121，且 16.122 已在他处产出，避免把旧版本号的产物混进 chore 提交）。构建后已 `git checkout -- dist/` 还原。
- **`scripts/i18n-gate.mjs` 预存在红（非本次引入）**：本树 `DICT=2664 缺=8 重=9`；在 16.122 工作树
  （`.worktrees/release-1669`，含本次全部改动之外的基线）实跑同为 `缺=8 重=9`，缺键集合完全一致
  （`API Key（Bearer）`、`Image`、`L3 · Worker`、`Phase`、`Runtime`、`State`、`Temperature`、`Version`）。
  该脚本与仓内 vitest i18n 覆盖测试口径不同（脚本未跟随域拆分后的动态 key），本次不动。
