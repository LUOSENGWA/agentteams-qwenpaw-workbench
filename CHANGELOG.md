# 更新日志 Changelog

本文件记录 agentteams-qwenpaw-workbench 的各版本变更（公开 release 条目）。
English version: [CHANGELOG-en.md](CHANGELOG-en.md)

---

## 0.5.0-beta.13.9（2026-09-22）

**运行配置六 tab 补齐 + QwenPaw Loop 模板移植 + 状态灯 session 正源 + 聊天气泡与 @mention 渲染 + 插件全宽自适应 + 知识库大工作区列取真根因修**

- **运行配置六 tab 补齐 + L1/L2 门控**：页签 = ReAct 智能体 / 智能体 Loop 设置 / LLM 自动重试 / LLM 并发限流 / 上下文管理 / 长期记忆 / 系统（只读），每域独立 Card + 表单项行（label + 悬停 ⓘ 说明左 / 控件右）；按 Controller PUT 白名单门控——L1 可编辑（除 approval_level 全可写），L2 只读 + 警示（9 键白名单实锤）；上下文管理嵌套合并 light_context_config（12 字段：token divisor / 压缩阈值比例 / 工具结果修剪 8 键）；长期记忆 reme 5 键可编辑 + 完整 JSON 查看；保存走 buildDiff 只发改动键
- **Loop 设置 QwenPaw 模板移植（开源礼仪：出处署名）**：4 模板（安全运行 / 预算研究 / 质量优先 / 空管道）+ 7 gate 定义含默认值，逐值移植自 QwenPaw console AgentLoopCard（注释保留上游源文件 + 行号、模板区标注「模板设计：QwenPaw 上游」）；选模板 →「按模板创建自定义模式」弹窗（模式名 / slash 命令 / 描述 / 管道预览）→ 自定义 loop CRUD
- **会话列表自适应宽度**（13.7 装验「依旧拥挤」续修）：通道列 64→56（短名 + 悬停 Tooltip，容器 <640 整列隐藏）、会话列唯一弹性列（min 120）、查看列 44 nowrap——「查看」按钮恒可见；per-session running 蓝点；**React #300 真 bug 修**：两 hook 落在详情视图早退 return 之后 → 点「查看」即崩（Rendered fewer hooks），移至全部早退之前（harness 实证）
- **插件全局宽度自适应 + 横竖屏误判修**：主容器 maxWidth:1160 → 100% 全宽（16:9 全屏两侧大留空根因）；宽屏判定去掉宽高比项改纯宽度 ≥800（定高容器/面板下宽高比误判「竖屏单栏」根因——16:9 全屏必双栏、手机 390 单栏、强制开关保留）
- **会话窗折叠更像 QwenPaw**：「N 步」pill 升级整行头（图标 + 文案 + 计数 + 右对齐旋转 chevron，浅底圆角行；懒渲染语义保持——收起时子行不渲染）
- **聊天页气泡 + @mention 渲染**（对标 dashboard/QwenPaw/Element）：自己/对方主题气泡；@mention 整 MXID Element 式 pill chip（localpart 显示 + 悬停 Tooltip 整 MXID + 点击跳转），短 @name 保留旧高亮
- **状态灯信息源升级**（13.7 装验「显示不准确」续修）：新 workerChatStatus 模块轮询 /chats per-session status（idle|running——qwenpaw app 自维护的正确 session 状态，30s tick / 仅页面可见时 / 并发 4 / 失败静默保旧值降级消息级启发式）；状态机优先序 = 心跳（若有）> chat.running > typing；chat.updated_at 不用于 done（user 消息也刷新它 → 假绿）
- **i18n 术语修正**：「令牌预算」→「词元预算」（LLM token = 词元，4 处）、「每故事重试」→「每个 Story 最大重试次数」（= QwenPaw zh 原文 maxRetriesPerStory）；约 70 新键登记（中英），全量对账 0 缺 0 重复
- **知识库大工作区列取 HTTP 413 真根因修**：旧通道把整个 workspace 打 tar 上传 Controller 列取（顶层超 20MB → 413；180MB 生产工作区恒报错）→ 双通道：容器内 `exec find` 为主（零下载、单请求返回全量文件列表）+ tarball 降为单文件读取/旧版本兼容回退；顶层与 memory/digest 子树同通道覆盖；+7 回归测试；实盘端到端验证：180MB / 176MB / 21MB 三个真实工作区列取 0.16–0.22s 全 200（修复前 413）

**Verification**: tsc 0 · pytest 57/57 · vite build 2,128.77kB · 浏览器 harness 13.7 24/24 + 13.8 35/35（真实 React+antd 挂载：七 tab / L2 只读门 / L1 全值 / 模板 4 tag + 4 gate 勾选 + 弹窗预览 / 术语 / 无 pageerror）· i18n 1241 字典键 / 1137 用键 0 缺 0 重复 · antd 引用交叉 38 · dist 锚点 14/14 + 旧术语 0 + ant-slider=0 · 敏感扫 0 · 实盘端到端（180MB 工作区 0.22s 200）

---

## 0.5.0-beta.13.7（2026-09-22）

**会话窗 QwenPaw 消息折叠 + 会话列表悬浮展开 + Loop 设置对齐 QwenPaw gate 管道 + 聊天渲染对标**

- **会话窗消息改 QwenPaw result-only 折叠**：每个回答轮只显示最后一条文本（assistant 气泡），中间的工具调用/思考步收进「N 步」pill（懒渲染——收起时子行完全不渲染，点开才渲染）；工具块退化成 RAW JSON 输出的真根因修复（工具名读错层级——实际在 data 块嵌套层）；错误消息恒可见（QwenPaw 口径：result-only 下错误也不折叠）
- **会话列表悬浮 + 点击展开**：长会话名弹性列缩短省略；悬浮显示全名；点击行内展开（全名换行 + session ID 全值），再点收起；通道/最后活动/操作三列各收窄让位
- **Loop 设置对齐 QwenPaw（滑杆废弃）**：迭代上限从基本 tab 滑杆改为 Agent Loop → 迭代限制门（启用开关 + 数字输入 1..500——QwenPaw 配置面无滑杆），保存时自动同步 legacy 字段；补齐重复保护门（检测窗口/相似度阈值/干预规则增删改）与完成质量检查门（Rubric 提示词/最大干预次数）；补齐 Goal/Mission 内置参数（最大迭代/令牌预算/每故事重试/验证说明/验证命令）；重复检测窗口字段名修正（window_size）
- **运行配置面全量对账**：记忆后端改可编辑（L2 白名单键纠正误标只读）；系统 tab 补齐 LLM 并发/QPM/限速等待/限速抖动/槽位获取超时/最大输入长度/历史消息长度只读行（QwenPaw 限速器卡口径）
- **聊天页消息渲染对标**：工具消息状态着色（调用/成功/失败，失败名红色）+ 展开分区（参数/结果/错误，失败红色调）；markdown 代码块对齐 dashboard 口径（浅底卡片 + 边框 + 复制按钮悬停才出现）
- **i18n**：约 60 新键登记（中英）

**Verification**: tsc 0 · pytest 50/50 · vite build 绿 · 浏览器 harness 24/24（真实 React+antd 挂载：列表展开收起 / result-only 折叠与懒渲染 / 基本 tab 无滑杆 / gate 门值域 / window_size 正源 / diff 点亮保存 / 失败状态色 / 悬停复制钮）

---

## 0.5.0-beta.13.6（2026-09-22）

**聊天页 Element 化重构 + 会话窗滚动真根因修 + 运行配置面板对标 QwenPaw console**

- **聊天页消息时间线 Element 化**：纯文本消息去气泡框（扁平时间线 + 悬停行浅底圆角 pill）——旧版每条消息一个色块框，观感「消息框难看」；日期分隔改 Element 同款居中胶囊
- **历史消息滚动修复（真根因）**：加载更早消息（前插 50 条）后视口被顶到最顶部、上翻历史「跳走」——现前插时保持滚动锚（useLayoutEffect paint 前恢复，不可见跳变）；滚到顶部 40px 内自动加载更早历史（Element 式无限滚动，保留显式按钮）；翻到头显示「已到最早的消息」标记；上翻加载历史不再被误计为「新消息」
- **会话窗滚动修复（真根因·浏览器 harness 实证）**：13.5 详情视图的 grid + alignContent:end 在内容超容器时顶部溢出进入不可滚动区（scrollTop 恒 0）——上半截会话永远看不到；改普通块级流 + JS 滚底（harness 实测 scrollable=true）
- **会话列表去「用户」列**：五列改四列（会话 / 通道 / 最后活动 / 操作）——「用户」列信息不可读且对 Worker 视角会话无意义，删列后空间回归会话名列
- **运行配置面板对标 QwenPaw console 重构**：单行挤排改 Tabs 四域（基本 / Agent Loop / LLM 重试 / 系统只读）——每域独立 Card + 表单项行（label + 悬停 ⓘ 说明左 / 控件右）；最大迭代改滑杆 + 数值显示；LLM 重试开关关闭时重试参数自动禁用；数据范围不变（白名单键 + diff 只发改动键），只改呈现
- **会话级 loop 状态显示位置定案（正源=QwenPaw console LoopModeSelector）**：从会话详情头迁至**聊天页输入区**（1:1 Worker 房间，轮询该房间激活 loop，running 蓝呼吸 / 等待输入琥珀 + 模式名 + 悬停描述；旧 runtime 404 恒不显）
- **「房间列表」按钮与返回键重叠修复**：宽屏收起列表后「☰ 房间列表」按钮经顶栏前置位注入（Element 汉堡位），不再 absolute 浮在聊天区左上角压住返回键
- **下载去向显形**：所有下载（产物预览 / 项目文件 / 工作流产物）成功时 toast 提示「已下载到浏览器默认下载目录：文件名」
- **i18n**：25 新键登记（中英）

**Verification**: tsc 0 · pytest 50/50 · vite build 绿 · 浏览器 harness 2 案实证（grid-alignEnd 不可滚 → block 流可滚）

---


## 0.5.0-beta.13.5（2026-09-22）

**会话窗布局两修 + 产物「查看」行为修 + 运行配置面板接口全量对账（#1231 端点族 7/7 接通）**

- **会话列表横向溢出修复**：会话列表表列此前为五列固定宽（合计 528px）+ 500px 最小滚动宽——抽屉宽度受窗口限制时表格出现横向滚动条，「查看」按钮被挤到最右（需拖到底部滚动条才可见）。现改为固定布局 + 容器相对列宽（不定宽列均分剩余空间、长值单元格内省略），任意抽屉宽度下无横向滚动、「查看」恒可见
- **会话上下文视图滚动修复**：会话详情（Agent 上下文视图）消息区此前为 420px 魔法数上限——窗口矮时内容被抽屉底裁切且不可滚。现改容器相对高度链（详情区 = 抽屉剩余全高，消息区 flex 自滚，零魔法数），任意窗口尺寸可滚
- **产物「查看」不再收起面板**：拓扑任务详情行的展开开关此前挂在整卡上——点「查看」的点击冒泡触发收起，预览 Modal 随组件卸载消失（「点击查看却收回了菜单」）。现开关只挂头部行，展开区内按钮点击不再触发收起
- **运行配置面板接口全量对账**：面板此前只消费了 #1231 端点族的 1/7（runtime-config）。本次按上游契约逐端点补齐——
  - **Loop 模式目录**（GET /loops）：内置/自定义/插件三源模式以彩色标签展示（名称 + slash 命令 + 悬停描述）
  - **自定义 Loop CRUD**（GET/POST/PUT/DELETE /loops/custom）：列表行 = 启用开关（整块替换回写）+ id/名称/slash 命令/门禁计数 + 删除（确认框）；新建 = 完整 JSON 表单（409 重名 / 422 管道校验失败原因透传）
  - **会话级 Loop 状态**（GET /loops/status）：接入会话详情头——该会话激活的 loop 模式以标签显示（running 蓝 / 其余默认色）；旧 runtime 404 自动隐藏
  - **记忆配置显形**：reme 轻量记忆 / adbpg 记忆两字段（契约 5-tab 字段）只读展示已配置/未配置 + 配置 JSON 折叠查看
- **UI 文案清理**：运行配置面板移除内部 PR 编号字样（面板/横幅不再出现 #1231）
- **i18n**：23 新键登记（中英双语）
- **质量门**：tsc 0 / build 2054.71 kB / pytest 50/50 / window-shell-harness 4/4 / i18n 0 缺 / dist 锚点 9/9

## 0.5.0-beta.13.4（2026-09-22）

**容器相对高度链（滚动根因修复）+ QwenPaw 式会话窗 + 结果产物统一显形 + A2 运行配置面板**

- **聊天主列表滚动根因修复（13.2/13.3 整页滚动的真根因）**：壳高度此前用 `100vh − topBar` 魔法数推算——插件容器外层高度由宿主（QwenPaw 面板/浏览器窗口）定高，而 `100vh` 跟 OS 窗口走，两者错位：窗口拉大时壳撑出容器（实测窗口 1389px 时壳溢出 125px = 底部控制区被挤出视口高度）→ 整页被迫滚动、输入区被裁。整链重构为**容器相对高度**（Element 模型：flex 容器链 + `min-height: 0`，零魔法数，`100vh`/`100svh` 从插件代码彻底移除），壳高度跟随宿主容器、任意窗口尺寸成立。jsdom harness `window-shell-harness.mjs` 复现验证（旧链溢出 125px → 新链 0，列表内滚、输入区贴底完整可见）
- **会话窗重写为 QwenPaw Sessions 口径**：点开会话 → 会话详情右侧现为该 worker 的 QwenPaw 完整会话列表（会话状态/轮次/token 统计/最后活跃时间），点选会话看消息详情 + 会话内产出文件列表（点开预览或下载）；会话/消息/文件三层全版本门，端点缺失时降级提示
- **结果产物显形统一**：结果产物的「查看/下载」此前只有团队任务列表（dashboard 口径）有——现拓扑节点任务行与插件工作流卡片任务均有（`ArtifactLines` 共享组件，三处同口径）
- **Worker 管理第三面板「运行配置」（A2，消费上游 #1231 契约）**：`spec.runtime = qwenpaw` 的 Worker 显示并编辑与 QwenPaw 配置面板同名字段的运行时配置——`loop.max_iters`（表单编辑 + 整块 JSON 高级编辑 + 校验）、`approval_level`（审批级别）/`memory_manager_backend`（长期记忆）/`context_manager_backend`（上下文后端）/`shell_timeout`（Shell 超时）/模型段只读展示；loop 变更保存时提示将通知团队 Leader；409（Worker 运行中）/403（L2 范围）友好横幅；非 qwenpaw runtime 显示不支持说明
- **i18n**：25 新键登记（中英双语）
- **质量门**：tsc 0 / build 2046.26 kB / pytest 50/50 / window-shell-harness 4/4

## 0.5.0-beta.13.3（2026-09-22）

**聊天高度链回归修复 + 工作流任务级取消/结果产物对齐 dashboard**

- **聊天主列表滚动回归修复（beta.13.2 引入）**：一键置底引入的 relative wrapper 漏配 `min-height: 0`——overflow 可见的 flex 中间层自动最小高度 = 内容最小高度，列表的 `overflow: auto` 钳制无法穿透传递，wrapper 被全部消息撑高（实测 7500+px），列表失去独立滚动：滚轮冒泡成**整页滚动**、回看时旧消息滚出视野（Element/dashboard 均为定高内部滚动）。A/B 浏览器实测证实（13.2 列表高 7532px/不可滚 → 修复后 367px/内部可滚 7165px，与 13.1 逐项一致）
- **工作流：任务级取消进入任务巡检 Drawer**：此前取消只在看板卡上有入口，拓扑/卡片视图点开任务详情后取消「消失」（dashboard 任务行任何上下文都可取消）。现看板卡与 Drawer 共用同一取消 Modal（原因必填、非终态门控、409 幂等收敛），取消后自动刷新
- **工作流：结果产物（result_path）显形**：dashboard 任务行有结果产物链接，插件类型里有字段但 UI 不渲染——现 Drawer 补「结果产物」查看/下载（与 spec/交付物同款），拓扑任务详情行补 result_path 提示行
- **i18n**：1 新键登记（结果产物 / Result artifact）

**Verification**: tsc 0 · check-antd 38 · i18n 0 missing（934 用 / 1020 定）· vite build 绿 · pytest 50/50

## 0.5.0-beta.13.2（2026-09-21）

**聊天大改进：灯源修正（不再误绿）+ 话题头像灯 + 一键置底**

- **会话状态灯来源修正（「灯一直绿」根因修复）**：done 回退原用**房间级 last_ts**——用户自己在房间里发一条消息也会刷新 last_ts，把该房间所有 Worker 全部点绿（10 分钟内持续）。现改为 **per-sender**（与 dashboard 9a9cc8d 同源）：后端 `/teams/sync` 房间条目新增 `last_sender`（最后一条消息的发送者 MXID），前端 done 回退只认**该 Worker 自己**的最后一条消息（≤10min，过后衰减灰）。心跳字段在场时（Controller ≥ worker-agent-status 契约）done 只由 `lastFinishAt`（任务级完成）驱动，回退根本不触发；团队房间里人类消息不再点绿任何 Worker，Worker A 发言只点绿 A
- **话题（Thread）头像状态灯**：线程面板根消息头像、回复列表头像、主列表线程摘要「最后回复人」头像三处补齐同款角落灯（6px 圆点 + 白描边环 + Tooltip；Worker 才有映射，人类不显）
- **一键置底（Element JumpToLatestButton 同款交互）**：主消息列表 + 话题面板——上翻回看历史时右下角悬浮「↓」圆钮；非本人新消息到达且不在底部时累加「N 条新消息」徽章；点击平滑滚回底部并清零；120px 近底阈值与自动跟随共用（不抢用户的回看）；换房间重置状态并贴底；自己发送不受计数（发送路径已主动置底，防竞态误计）
- **done→idle 衰减 tick 60s → 15s**（对齐 dashboard `useSessionTick` 方向，纯派生零网络成本）
- **a11y**：状态灯 dot 补 `role="img"` + `aria-label`（屏幕阅读器读出状态；dashboard #127 合并时维护者 a11y 修复同款）
- **i18n**：2 新键登记（中英）

**Verification**: pytest 50/50（含 4 条 last_sender 回归）· tsc 0 · 派生逻辑实跑 11/11（含「用户消息不点绿」回归）· vite build 绿

---

## 0.5.0-beta.13.1（2026-09-19）

**Worker 内置工具设置 + 会话只读面板（给无头 QwenPaw Worker「补头」）**

- **内置工具 tab（团队管理）**：消费上游 #1255（已合 main）Controller 端点——逐 Worker「启用 / 异步执行」双开关（乐观更新 + 失败回滚）、`requiresConfig` 只做徽章（工具配置值在 Controller 代理边界已剔除，任何客户端永不可见）、404 版本门占位（旧 Controller / L2 跨团队隐藏，统一中性文案不暴露原因）、PATCH 403（团队 Leader 只读 / L2 越权写）整面板转只读
- **Worker 会话（入口=群内点头像，9/19 定案）**：消费上游 #1295 会话端点（ready 等 review）——**入口不在团队管理**（原「会话」tab 已撤，9/19 定案：会话属于聊天上下文，且目的是从 Worker 角度看完整 session，不是看最后活动列表）；群聊/DM 里点 Worker 头像 → 弹层/右键「💬 查看会话」→ 抽屉内会话列表（名称 / 通道 / 最后活动，置顶·已归档徽章）→ 详情视图恒显**「Agent 上下文」标注**（agent 工作上下文可能含压缩历史与未发送的工具调用/输出，与实发房间消息不同）、内容块保守渲染（文本直出、工具块压成标签、未知形态截断 JSON）、idle/running 状态灯（404 隐藏 = QwenPaw <2.2.1 版本无关门）、列表 404 = 占位横幅（旧 Controller / L2 房间边界外，设计上不可区分）
- **Worker 会话状态灯上头像角落（9/19 定案）**：蓝（运行中·1.2s 呼吸）/ 绿（近 10 分钟完成）/ 灰（无任务），从「发送者名字旁」挪到**群内每条消息 Worker 头像右下角**（7px 圆点 + 白描边环 + Tooltip；心跳优先派生，人类发送者无映射不显）——与 dashboard 330257e 同款落点
- **成员头像条（9/19 定案：模仿 dashboard 成员列表）**：房间标题栏右侧的成员头像条——Worker 头像右下角带同款会话状态灯；成员多时收成 **+N，点击展开全部/再点收起**（窄屏由标题栏换行自然落到标题栏下面）；点头像打开成员面板（既有 Drawer，全量成员 + @ 提及 + 详情，其头像行也带状态灯）——零新增请求（房间成员=既有 /sync，状态=既有派生）
- **数据面**：两者均复用既有通用 Controller 代理（`/api/agentteams/*` 透传），后端零新端点；只读端点无审计（上游一致先例）
- **i18n**：27 新键登记（中英）

**Verification**: pytest 46/46 · tsc 0 · i18n ui↔dict 对账 0 缺 · check-antd 38 引用全合法 · vite build 绿

---

## 0.5.0-beta.13（2026-09-19 · 正式号）

相对 beta.12（上一正式号）的新增与修复（按功能归类）：

**聊天**
- **左右分栏 + 左右独立滚动**（真根因版）：分栏下房间列表与聊天框各自滚动；宽窄判定**长宽比优先**（横屏且 ≥600px 分栏、竖屏一律单列）；设置页「聊天页面强制左右分栏」开关；自检页「聊天布局诊断」一键读数（宽高/长宽比/左栏滚动数据）；适配 QwenPaw 宿主自研前缀（ant-/qwenpaw- 类名双写），宿主内嵌面板下分栏真实可用
- **Worker 会话状态灯**：蓝（运行中·呼吸）/ 绿（近 10 分钟完成）/ 灰（空闲），房间卡 / Worker 行 / 1:1 聊天头三处显示（心跳优先，typing 实时回退）
- 消息刷新改 **/sync 事件驱动**（替代粗轮询）
- 房间卡：最后消息预览 + 成员列表折叠（「N 人」展开/收起）

**知识图谱**
- **2D v4 簇块布局**；滚轮缩放（光标锚点 0.25×–8×）/拖拽平移/簇聚焦/簇分离/复位
- **簇重叠真根因修复**（行堆叠累计 + CJK 字宽加权）+ 空白拖拽平移接线（此前拖拽无效）
- 3D 力参数与 dashboard 定案值对齐；敏感文件规则扩展（credentials.yaml/yml 等直读 404）

**工作流**
- 卡片/拓扑视图 **master-detail 重构** + 自上而下分层 DAG（就绪高亮 / 外部依赖注记）
- tab 可见期 **15 秒自动刷新**（切走即停）；任务巡检抽屉（当前 Worker / 最新产物 / 状态时间线 / 耗时）
- **聊天内工作流卡 live 刷新**（正源 15s overlay + LIVE 徽标；降级轨不显徽标）
- 拓扑/看板任务详情：产物**「查看」**（内联预览：md/图片/文本，与「下载」并列；装验 9/19 对齐 dashboard）

**模型网关**
- **「添加提供商 / 添加路由」写操作**（Console 会话透传；失败时 Console 错误信息直显）
- 只读模型网关配置 tab（Provider / AI Routes / 模型映射）+ 可请求模型 alias 全集聚合
- 模型网关只读路由目录（运维 tab，L1；Controller 版本门控 404 自动隐藏）

**团队管理与权限**
- L2 数据面兜底：本团队知识库只读（日记 / 知识库 / MEMORY.md）+ Worker 审批读写（OFF 档仍 L1）
- 新建 Worker：行情更新（移除 CoPaw、补 DeepSeek Harness、默认 QwenPaw）+ 从建队卡独立成卡
- CRD 管理：导出 JSON（四类全量）+ 卡片紧凑化 + 品牌 logo 替换 🏢
- 快捷操作三卡（员工入职 / 创建团队 / 新建 Worker）**同排一行 + 可折叠**（装验 9/19）
- **spawn 工具/技能白名单显示**：spawn 树节点在数据具备时展示「工具白名单 / 技能白名单」标签——子 Agent 派发时的工具收窄会持久化，并经 Controller spawn 端点透传到工作台；无该数据的 Worker 不显示、零噪音

**验证**
tsc 0 · check-antd 交叉通过 · vite build 绿 · pytest 46/46 · 包内三处版本复核一致

**已知限制**（沿用 beta.12）
- 技能目录节 / 频道节依赖上游端点合并，未合并时 404 占位（预期行为）
- 3D 图谱在浏览器不支持 WebGL 时自动回退 2D

---

## 0.5.0-beta.12.16（2026-09-19）

**宽窄判定改「长宽比优先」（竖屏语义）**

- 宽窄判定不再只看宽度：**横屏（容器宽 ≥ 高）且 ≥600px 才用分栏；竖屏（高 > 宽）一律单列**——竖屏手机/竖窗语义，与 Element 等客户端一致。
- 强制分栏开关保留（覆盖上述判定）；自检「聊天布局诊断」新增**长宽比读数**（横屏/竖屏）。

**Verification**: tsc 0 · check-antd 38 · vite build 绿 · pytest 46/46

---

## 0.5.0-beta.12.15（2026-09-19）

**分栏真根因（宿主前缀）：qwenpaw-tabs-* 高度链补齐**

- **真机复现台确认**（真实宿主实测）：宿主是 **自家前缀的 antd 分支**——`.ant-tabs-*` 类名在真宿主一个都不存在（实际为 `qwenpaw-tabs-content-holder/content/tabpane-active`）→ 12.10/12.11 的整条高度链 CSS 在真机从未命中：左栏被 74 个房间撑到 **8193px**、外层容器滚动（「整页滚动」）、左栏自身无滚动（「滚轮放上去不动」）——4 轮复报的确证根因。
- 修复：高度链 + 防撑链 + 575px 单列规则全部**双前缀双写**（ant- 与 qwenpaw-）；真机复测：左栏 300×488 有界、末卡 8208→504px 内部滚动、容器盒不动。
- 保留 12.14 的阈值/强制开关/自检诊断（宽度判定另有其功：宿主容器 990px）。

**Verification**: tsc 0 · check-antd 38 · vite build 绿 · pytest 46/46 · **本机真宿主实测（QwenPaw 2.2.1 console）**

---

## 0.5.0-beta.12.14（2026-09-19）

**聊天分栏三件套：阈值 600 + 强制开关 + 自检诊断**

- **分栏阈值 1024→600**（按容器实际宽度）：装验多轮「无分栏」= 宿主面板/窄窗下 1024 判定恒为窄屏；600 以下 = 手机竖屏语义，之上 = 左右分栏。
- **配置页新增「聊天页面强制左右分栏」**：忽略宽度判定，任何宽度都分栏（窄面板可拖宽/⟨ 收列表）。
- **自检页新增「聊天布局诊断（客户端）」**：window/容器宽高、模式+阈值+是否强制、左栏可视高/内容高/overflowY —— 分栏/滚动问题的数字现场，一键复测。
- 真机复现台实测：900px → 分栏；500px → 窄屏；强制开关 → 500px 也分栏；诊断数字准确。

**Verification**: tsc 0 · check-antd 38 · vite build 绿 · pytest 46/46

---

## 0.5.0-beta.12.13（2026-09-19）

**模型页写面（添加提供商/添加路由）+ 分栏判定容器化**

- **「添加提供商 / 添加路由」（P7b）**：模型页新增两个写操作，字段与 dashboard models-section 同款（provider = name/type/protocol/tokens/rawConfigs{openaiCustomUrl,pathPrefix,modelMapping}/tokenFailoverConfig；route = name/pathPredicate(PRE)/upstreams[]/modelPredicates[]/authConfig）；经连接器 `/gateway/*` POST 透传到 Higress Console（console_session），Console 错误信息（如 409 冲突）直接透到界面。
- **分栏判定改「容器实际宽度」**（装验复报排查）：宽屏/窄屏判定从 `window.innerWidth` 改为 ResizeObserver 监听容器——宿主内嵌面板窄于窗口时不再误判宽屏；另经真机复现台（真实前端 × fixture 数据）验证左栏独立滚动成立（末位房间 5210→542px，左栏盒不动）。
- 连接器写面新增 4 条回归测试（POST 透传/无会话守卫/name 守卫/Console 详情透出）。

**Verification**: tsc 0 · check-antd 38 · vite build 绿 · pytest 46/46 · 真机复现台 UI 冒烟（创建链路成功消息 + 列表刷新）

---

## 0.5.0-beta.12.12（2026-09-19）

**「簇重叠」真根因修复（双端同款）+ 鼠标拖拽接线**

- **2D 图谱簇块行堆叠（真根因）**：原 `yTop = ri *（本行最大高 + 间距）` 在行高不等时跨行重叠（数值复现：块重叠 588×104px；30 数据集 fuzz：旧公式 1027 对 chip 重叠 → 新公式 0）——改为累计行高，行行相扣。
- **鼠标拖拽平移接线**：`onSvgPanMove` 原定义未挂到 SVG（mousedown 后 move 空转，「空白处拖动画板」失效）——接线 + 拖拽中悬停停更。
- dashboard 侧同步修复（同款行堆叠 + CJK 字宽移植），双端 2D 观感一致。

**Verification**: tsc 0 · check-antd 38 · vite build 绿 · pytest 42/42 · 布局 fuzz 30 数据集零重叠

---

## 0.5.0-beta.12.11（2026-09-19）

**分栏独立滚动真修复（补 12.10 高度链最后一跳）**

- **聊天分栏左右独立滚动补强**：12.10 只锁了 antd Tabs 的 CSS 高度链；但内容区容器未 flex 化 → Tabs `flex:1` 空转、整链塌陷，左栏独立滚动仍失效（装验复报）。本版补齐：内容区容器 `display:flex` + 面板 `overflow-y:auto` 回退滚动，高度链真正接通。
- 其余内容与 12.10 一致。

**Verification**: tsc 0 · check-antd 交叉通过 · vite build 绿 · pytest 42/42

---

## 0.5.0-beta.12.10（2026-09-19）

**装验反馈批：聊天分栏独立滚动 + 拓扑详情三区 + 2D 图谱字宽修复 + 模型页全套展示**

- **聊天分栏左右独立滚动**：修复 antd Tabs content 高度链塌陷导致房间列表被裁剪/无法滚动——Tabs 容器 flex 占满 + content-holder/content/tabpane 高度锁定 + 左栏 overflow-y 独立滚动（overscroll-contain 防传播）
- **房间卡成员列表默认隐藏**：成员多的房间 chips 不再撑高卡片，点「N 人」tag 展开/收起（展开后点成员 DM 入口不变）
- **工作流拓扑详情三区**（与 dashboard 任务详情页对齐）：任务分布（状态计数）+ 任务详情(N)（可展开行：spec/摘要/产物/转换审计）+ 节点(N) 双列网格
- **工作流视图 tab 计数取消**：页头「项目 (N)」保留，看板/拓扑 tab 冗余计数移除
- **2D 图谱 CJK 字宽加权**：修复中文文件名 chip 宽度低估导致的横向压盖（「簇重叠」根因），标签截断同口径
- **模型网关页全套展示**：可请求模型 alias 全集聚合块；请求模型(alias) 与授权 Consumer 分列（修复目录源把 consumers 填进 alias 列的语义错位）；修复 alias 逐字拆开显示 bug（字符串 spread）
- **KB 敏感文件规则扩展**：credentials.yaml/yml 独立凭证文件纳入过滤（与 dashboard 侧 B1 修复对齐）
- **CRD 管理卡片紧凑化**：padding/gap/gutter 密度压缩
- **i18n**：新键登记（中英）

**Verification**: pytest 42/42 · tsc 0 · check-antd 交叉通过 · vite build 绿 · i18n ui↔dict 对账

---

## 0.5.0-beta.12.9（2026-09-19）

**2D 知识图谱 v4 簇块布局 + 工作流页/聊天 UX 一批（与 dashboard 对齐）**

- **2D 知识图谱 v4 簇块网格布局**：簇矩形块 + chip 节点恒显标签 + 跨簇边块级收敛（对齐 dashboard v4，替代分层径向的簇内混叠）
- **工作流 tab 接入事件流**：任务状态转换时间线（created→running→finished/failed，上游 task-transition 事件流对接，legacy 游标兼容零回填）+ i18n 存量缺键清零
- **工作流页头部项目计数**：页头只显「项目(num)」总数，各视图去掉冗余 per-view 计数（视图标签保留）
- **任务巡检抽屉**：看板/卡片任务点击 → 抽屉显示任务级巡检（当前 Worker/运行时、最新产物、状态迁移时间线、耗时）
- **A17 worker 会话状态灯（heartbeat-first）**：三态（蓝 running 呼吸/绿 done/灰 idle）显示在群聊消息发送者头像 + 宽屏分栏布局；数据源 = worker 心跳 agentStatus 权威（无 120s typing 上限）→ typing 实时回退 → 10 分钟 done→idle 衰减
- **聊天 /sync 事件驱动刷新**：消息刷新由 Matrix /sync 长轮询驱动（替代粗轮询），分栏宽度/折叠参数化
- **模型网关配置 tab（只读）**：与 dashboard 同源的 AI 网关模型配置视图（Provider/AI Routes/模型映射，只读）

**Verification**: union 四步门全绿（pytest 全过 · tsc 0 · check-antd 交叉 · vite build 绿 · i18n 对账）

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
