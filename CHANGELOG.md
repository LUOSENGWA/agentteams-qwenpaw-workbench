# 更新日志 Changelog

本文件记录 agentteams-qwenpaw-workbench 的各版本变更（公开 release 条目）。
English version: [CHANGELOG-en.md](CHANGELOG-en.md)

## 0.5.0-beta.16.23（2026-10-26 · 千锻注入修复）

**修复**
- **千锻注入全部失败（HTTP 301 / Controller 不可达）**：`_ctl_call` 的契约是只接收 path（base 由内部按 ordered 地址拼接），但注入链路的历史调用点传的是完整 URL（`f"{base}/api/v1/..."`），入口又拼一次 base → 双 base URL（`https://h:7113https://h:7113/api/v1/...`）→ 网关回 301 或挂到超时，SOUL 更新 / 新建 Worker / core 技能全部失败。现在入口统一归一化为 path+query，兼容完整 URL 与相对路径两种形态。
- **core 技能上传 400（`the zip must contain a single top-level skill directory`）**：core 技能 zip 把 `SKILL.md` / `references/` / `scripts/` 平铺在包根，而控制器要求「单个顶层技能目录」（目录名即技能名，根级条目直接 400）。现在全部条目包在 `millforge-core/` 下。
- **core 技能挂接报「无 skills 数据」**：挂接前用 `GET /api/v1/workers` 读各 Worker 的已分配技能，但控制器返回的键是 `"workers"`（附带 `total`），代码读的是 `"items"` → 名单为空 → 每个 Worker 都被判「无 skills 数据」。改为读 `"workers"`；同时修正单测假 controller（它此前返回 `"items"`，与真实不符，所以漏检）。
- 补回归测试 `test_ctl_call_normalizes_full_url_and_path_only`：无修复时断言复现双 base，有修复时两形态归一为同一单 base URL；I3 core-skill 测试补顶层目录断言。

## 0.5.0-beta.16.22（2026-10-26 · Provider 预填充）

**修复**
- **Provider 没有像 model 一样预填现值**：旧 Controller 的 `WorkerResponse` 不返回 `modelProvider`，导致弹窗里 provider 恒空。现在改为「Controller 的 `modelProvider` 优先；缺失时用所选 alias 的 `binding.providerName` 推导」——与 model 一样预填当前 provider（Controller 重建后仍以真实值为准）。

## 0.5.0-beta.16.21（2026-10-26 · 模型热生效 + Worker/Manager 重启）

**新增**
- **Worker / Manager 重启按钮**：Worker 详情面板与 Manager 表新增「重启」——不用再 SSH。Controller 侧新增 `POST /api/v1/workers/{name}/restart` 与 `POST /api/v1/managers/{name}/restart`（stop + start，容器重建后配置/模型重新加载）。

**修复**
- **改模型不能热生效**：`model` 被排除在容器重建 hash 外（config-only），但主模型只写运行时配置文件、没有触发 QwenPaw 的进程内 reload，所以看起来必须重启。现在主模型与 subagent 模型一样走 `PATCH /api/agents/default/model-settings`（`active_model`），改完立即触发 agent reload，无需重启。

## 0.5.0-beta.16.20（2026-10-26 · 模型编辑带 Provider（多 Higress Provider））

**修复**
- **多 Higress Provider 下选模型不生效**：Worker CR 的 `model` 只是请求 alias，真正转发由 `modelProvider`（APIG Model API 名）决定。此前模型编辑只发 `model`、provider 不动 → 换了 alias 仍走旧 provider，表现为「选了没用」。现在未分组 Worker 模型弹窗同时提供 **Provider** 选择：选 configured alias 会自动回填对应 Provider（来自 Higress alias→binding.providerName），也可手动选/清空；保存时只下发改动项（`model` + 视情况 `modelProvider`，PUT 合并语义）。

## 0.5.0-beta.16.19（2026-10-26 · 微信扫码直连 iLink，无需重建 Controller）

**修复**
- **微信扫码无需重建 Controller 即可用**：iLink 的 `get_qrcode_status` 是长轮询（服务端挂约 31 秒），Controller 频道代理固定 5s 会掐断。本版让**插件后端直连 iLink** 拉状态（45 秒超时），拿到 `bot_token` 后再走原有频道 `PUT` 落盘（快写，5s 足够）——即使 Controller 未升级，插件里的微信扫码也能完成授权。Controller 侧的 45s 长轮询修复（commit `290195f8`）仍建议下次发版带上，用于统一语义与其它长轮询场景。

## 0.5.0-beta.16.18（2026-10-26 · 频道扫码长轮询 + 未分组 Worker 改模型）

**修复**
- **微信扫码授权卡死**：QwenPaw 的微信扫码登录依赖 iLink `get_qrcode_status` 长轮询（服务端挂起约 30s）。插件后端代理读超时（6s）与 Controller 频道代理（5s）都会在长轮询返回前掐断 → 扫码后拿不到 `confirmed`，手机端提示「请在 OpenClaw 中升级 WeChat 接口版本后再试」。现在三层放行：插件后端 `…/qrcode/status` 读超时 45s、Controller 该路由专用 45s 长轮询客户端、QwenPaw 客户端保持 60s；连续轮询失败会在界面明确提示（不再静默）。
- **未分组（独立）Worker 改不了模型**：无 team 的 Worker 被归入伪团队「未分组」，点齿轮走团队配置入口、在 CRD 团队列表查无 → 弹「团队数据未加载或团队不存在」，而模型只能在该弹窗改。现在「未分组」齿轮打开独立的未分组 Worker 模型弹窗（`PUT /workers/{name}` 只传 `model`，合并语义，provider 等字段不动）。
- **微信频道字段与 QwenPaw Console 对齐**：隐藏 Console 微信抽屉不展示的框架内部字段（`base_url` / `dm_policy` / `group_policy` / `allow_from` / `deny_message` / `dm_disabled` / `group_disabled`），保存时也不再回写这些键。

**验证**：frontend tsc 0 · vite build 单文件 2,092.65 kB（gzip 590.63 kB）· Controller go build/vet 0 + server 包测试全绿（新增长轮询回归测试）· 插件后端 py_compile/import ok

## 0.5.0-beta.16（2026-10-22 · 正式号）

**15.1–15.41 子批合并 release（移动端/竖屏+触屏全适配 + 本地离线模式 + AgentTeams 1.2.5 能力全接入 + Coding CLI 管理全链 + LLM 调优与运行时批量升级 + 卡片化布局审计清零 + 回归修复；pytest 374→456、i18n 1,424→1,616 键）**

- **移动端/竖屏+触屏全适配**：深色模式全面适配（40 处硬编码颜色分档、黑透明文字与灰/黑透明底迁主题 token）+ 触屏信息全可达（58 处 Tooltip 点按可达、44px 触控目标、safe-area）+ 竖屏判定统一（横屏宽屏误判竖屏根修）+ 聊天紧凑头（6+ 控件收进 ⋯ 菜单）+ 竖屏 9 批逐页精修（聊天输入框重构 / 工作流集群重做 / 看板三档布局 / 技能详情弹窗 / 页签滑动根修 / 聊天文件引用 / 审批色收敛）+ 知识图谱触屏手势（双指捏合 / 单指拖动 / 双击聚焦 + 滚轮缩放）+ 首页版本号
- **本地离线模式 + 审计面板**：无 QwenPaw 服务端环境数据域零拨号（入口级不挂载，503 刷屏结构消除）+ 配置域本地留存（凭据脱敏、备份恢复导入）+ 连接测试真两步探测（可达性 / CORS 分层归因）+ 审计 tab（上游持久审计，L1 全量 / L2 本团队，三维过滤 + keyset 分页）
- **AgentTeams 1.2.5 接入 + 两轴宿主契约**：Worker 环境变量编辑 + 网关探测 / 编码执行记录查看器 / 运行时升级面板（预检四道门 + 两阶段就地升级）/ 逐 Worker 运行时版本（容器内实测）+ 两轴宿主契约（host.env.kind + caps，独立模式功能面一致）+ 三源版本一致性门
- **Coding CLI 管理全链**：三 CLI（qwen-code / opencode / qoder）安装 / 升级 / 卸载 + 检查更新（npm registry 宿主侧查询）+ settings 结构化表单（官方 schema 全字段、中英自适应、空态可设）+ 分区卡收放（当前值摘要 + 未保存改动点 + 自适应排列）+ 凭据迁移正位 + 三 CLI 已知坑前置告警
- **LLM 调优 + 运行时批量升级 + 集群版本卡**：LLM 调优面板（Worker + 团队默认双层、10 字段、热生效/重启标注）+ 运行时批量升级（团队分组选择 + 行内当前版本）+ 集群版本卡（AgentTeams + Higress 真实版本、拓扑对齐）+ 检查更新提速 7 倍
- **卡片化 + 布局审计清零**：CLI 卡卡片化手风琴 + 11 页签 × 6 宽度 = 72 格真溢出审计清零 + 44px 触控目标探针 51/51 + 111 条死文案清理 + 房间列表有界加载（76 房 21.9s→5.8~8.6s）+ 事件流即时连接（~15s→0.003s）+ 拖窗口卡顿根修
- **回归修复 + 成员详情卡会话入口**：打开会话详情整界面白屏（14.x 潜伏条件 hook 缺陷根修）/ 房间输入框消失误报「无权限」/ 看板卡片半行裁切 / 窄屏字段溢出 / Coding CLI 三个真实 bug（模型名保存恒禁用 / 数组腐蚀 / 空叶子不剥离）+ Worker 成员详情卡新增「查看会话」按钮（与头像入口同功能同门控）
- **安全硬化 + 技术债（零用户可见）**：完整配置导出/导入门密码（0600 独立存储、默认拒绝）+ 模型格式根因修 + 超时 180s 读回验证 + noUnused 死代码门 + 技术债专批（18 超大文件拆分 / 10 组重复逻辑收编 / 75 冗余导出收编，零用户可见）

**验证**：tsc 0 · vite build 单文件 2,009.70 kB（gzip 567.63 kB，0 import 语句）· pytest 456/456 · i18n 1,616 键 0 缺 0 重 0 空 · harness-cli 50/50 · 137 24/24 · 138 35/35 · 敏感扫 0（staged 新增行 + 全链 80b637d..HEAD message CJK 0 / MARK 0）

## 0.5.0-beta.15.41（2026-10-21 · 成员详情卡查看会话入口）

**新增**
- **成员详情卡「查看会话」按钮**：成员详情卡对 Worker 成员新增「查看会话」按钮——直接打开该 Worker 的完整会话，与聊天内点击头像的「查看会话」同一功能与显示条件。

## 0.5.0-beta.15.40（2026-10-21 · 会话详情白屏崩溃修复）

**修复**
- **打开会话详情整界面白屏**：从 Worker 的会话列表点开任一会话详情（点卡片或「查看」）时，整个插件界面白屏崩溃。此问题自 14.x 起存在，现已从根本上修复，会话详情可正常打开与返回。

## 0.5.0-beta.15.39（2026-10-21 · 聊天回归修复 + 消息流体验优化）

**修复**
- **房间输入框消失**：打开群/DM 房间时误显「你没有在此房间发送消息的权限」、输入框消失、无法发送。现已修复，输入框恢复，可正常输入与发送。

**改进**
- **「置底」按钮更易点按**：上翻消息流时出现的「↓」按钮，点按区域扩大并补上按压反馈，更易命中、按压有回应。
- **新消息徽章封顶**：长会话中「N 条新消息」徽章封顶显示 99，不再随新消息数量无限变长。

## 0.5.0-beta.15.38（2026-10-20 · 技术债专批：超大文件拆分 + 死代码清理 + 重复代码收编）

本批为纯内部代码结构重构（7 批共 20 个提交），UI 与行为与 15.37 完全一致，用户可见变化为零。目标：提升代码可维护性（全量审计发现 18 个 1,100–4,600 行超大文件、6 个死函数、75 处冗余导出、10 组重复代码，本批逐项处理）。

**改进**
- **死代码清理**：删除全仓零引用的函数 6 个与死类型 2 个；去掉 75 处冗余的 export 关键字（模块对外接口不变）；2 处 print 改 logger；2 处导出名与文件名不一致收编。
- **超大文件拆分**：18 个超大文件（1,100–4,599 行）拆为域子模块，全部通过「公共面恒等」验证——
  - 前端 API 层：4,583 行 → 22 行聚合层 + 14 个域模块，228 个公共导出拆前后逐一对齐
  - 多语言字典：2,669 行 → 73 行合并壳 + 10 个域字典，1,616 个键逐键恒等
  - 后端 4 个模块：68 条注册路由逐条恒等，456 个测试零改动
  - 13 个大组件文件：1,139–4,599 行 → 主壳 ≤1,400 行 + 域子文件（逻辑 hook / 渲染 / 常量按职责分离）
- **类型加固**：3D 图谱组件的 11 处 any 全部改为具体类型（0 残留）。
- **重复代码收编**：10 组重复代码收编 7 组为共享组件/helper（余 3 组经分析为「形似神不同」，保留不动避免过度设计）。

**验证**
- 每个拆分文件非空行守恒校验 + 公共面集合 diff 为空（前端 228 导出 / 后端 68 路由 / 1,616 字典键）
- 72 格 DOM 溢出全量扫描 ×11 轮：真溢出 0（与 15.37 基线一致）
- tsc 0 | vite build 593 modules（2,008.60 kB / gzip 567.32 kB）| pytest 456/456 | i18n 门 1,616 键缺 0 重 0 | diff 敏感扫描 0

## 0.5.0-beta.15.37（2026-10-20 · 全量审计修复批：窄屏溢出清零 + 触屏点按达标 + 房间列表提速）

本轮为全量审计（11 个页签 × 6 档宽度 × 深浅两套主题 × 触屏/窄屏截面）后的系统性修复，所有发现逐项定位根因后修复并复测清零。

**修复**
- **房间列表加载慢**：首页/聊天等依赖房间列表的界面，房间较多时（~76 房）加载需 20 秒以上，上游变慢时最坏挂起 2 分钟无响应。现改为有界加载：单次请求限时、并发拉取、最坏约 14 秒内返回（超时先给出已拿到的部分，不再整页卡死）。
- **事件流连接延迟**：首页「事件流：已连接」指示器在弱网/首次打开时最长要等 15 秒才建立，现连接即时建立（首个心跳不再阻塞响应头）。
- **窄屏/竖屏内容被横向裁切**：5 处实测溢出全部清零——首页 SGLang 状态卡与页头行（390/480px）、模型网关路由表（390px）、运维升级版本表（390/480/600px）、知识库 Agent 卡（390px）。路由表与版本表窄屏下可横向滑动查看全列；状态卡与页头行窄屏自动折行/截断，宽屏呈现不变。
- **运维组件日志行**（768px 中屏）：自动刷新开关在页面瞬时加载变宽时会被挤到贴右缘、刷新按钮折行。现该行对瞬时变宽免疫（提示文字可收缩），刷新按钮不再折行。

**新增**
- **触屏点按尺寸档**：在触屏设备（手机/平板）上，按钮、图标钮、输入框、下拉、分段切换、标签页、开关的命中区域统一提升到 ≥44px（业界标准点按目标，此前 24px 左右容易误点）。开关外观不变，仅上下命中区扩大；桌面端（鼠标悬停可用）完全不受影响。
- **复现审计页**：`dev-alltabs-overflow.html`（全页签 × 6 宽度横溢扫描，含触屏复现档 `?touch=1`）与 `dev-theme-input.html`（主题输入/44px 探针），供后续版本回归。

**改进**
- **触屏聊天时间可见**：触屏上聊天消息组的首行（头像+名字行）常显时间，不再需要点按才显示。
- **文案字典与代码收敛**：移除零引用的死文案 111 条（1727→1616）、死图标 1 个；4 处重复的消息发送代码收敛为单一实现（行为逐字节等价，界面无变化）。

**验证**
- **11 页签 × 6 宽度 = 72 格 DOM 全量溢出扫描：真溢出 0**（审计基线：15 格真溢出/50 源/最大 +76px）
- **触屏探针（390px + 触屏档）：9 按钮/19 分段/13 输入/4 下拉/5 开关 = 51/51 达标**，且无新增溢出
- **房间列表实测**：76 房 21.9s → 5.8~8.6s（有界）；事件流首响应 0.003s（此前 ~15s）
- tsc 0 | vite build 514 modules | pytest 456/456 | i18n 门 1616 键缺 0 重 0 | 暂存 diff 敏感扫描 0

## 0.5.0-beta.15.36（2026-10-19 · 团队管理竖屏管理入口行溢出修复——五按钮自动换行，竖屏零溢出）

回应使用反馈：团队管理 → 展开 Worker 后，「运行配置 / 环境变量与网关探测 / Coding CLI / LLM 调优 / 资源管理」这些管理入口在竖屏「没有排列好，会超出容器」。

**修复**
- **竖屏管理入口行超出容器**：竖屏模式下 Worker 管理信息区的五个入口（唤醒/休眠 + 运行配置 + 环境变量 + Coding CLI + LLM 调优）排在同一行 flex 容器里，按钮总宽 461px，390px 手机视口下容器可用宽仅 274px——「Coding CLI」按钮右缘超出容器 69px、「LLM 调优」超出 170px（DOM 实测）。现该行允许换行（390px 下自然折成 3+2 两行，每个按钮完整可见可点），宽屏单行呈现不变。
- **审计页恢复**：15.35 前的清理提交误删了 `dev-overflow.html` / `dev-split.html` 内联脚本的箭头函数空参数列表（`() => {}` 变 `=> {}`），两个溢出审计页无法编译。已恢复原样。

**新增**
- **展开区溢出审计页**（`dev-manage-overflow.html`）：此前审计页只渲染折叠态团队树，Worker 展开区（管理信息 + 五段卡/入口行）是盲区。新审计页双模式——竖屏紧凑按钮行 / 宽屏内联卡——逐入口探针（行 clientWidth vs scrollWidth vs 容器右缘）+ 全量越界元素扫描，多宽度一键量化。

**验证**
- **6 档视口（390/480/600/768/800/1024）DOM 溢出扫描：管理入口行全部归零**（修复前 390px 溢出 187px、480px 溢出 97px；修复后各档 row right ≤ 容器右缘，宽屏 800/1024 内联卡五段零回归）
- tsc 0 | vite build 514 modules | pytest 456/456 | 暂存 diff 敏感扫描 0

## 0.5.0-beta.15.35（2026-10-19 · Coding CLI settings 卡片布局/尺寸动态调整修复——窄屏内容溢出清零）

回应使用反馈：15.34 的分区卡「布局和大小和内容没有动态调整，部分内容超出容器，卡片总体不美观」。逐项修复，全部经 5 档视口（390/500/700/1000/1280）实测量化验证。

**修复**
- **窄屏字段控件溢出分区卡**：字段行是「固定标签宽 + 固定控件宽」的不换行布局，窄卡（竖屏 ~300px）里总宽超出容器——390px 下模型卡溢出 123px、工具卡 100px，控件被裁成窄条。现字段行允许换行 + 标签按内容自适应 + 控件弹性（`flex: 1 1 200px`）——**宽屏标签与控件同行、控件随卡拉伸；窄屏控件自动折到标签下全宽**（移动端表单标准行为）。长字段名（monospace 键名）允许任意断行，不再撑破行宽。
- **极窄容器下分区卡最小宽 300px 撑破**：390px 视口面板内容仅 ~280px，`minmax(300px, 1fr)` 的轨道下限 300px > 容器 → 卡整体溢出 20px。现 `minmax(min(300px, 100%), 1fr)`——容器不足 300px 时允许收缩（≥300px 行为不变）。
- **布局/尺寸链补全**：settings 编辑器根、对象容器、分区卡体、JSON 补丁容器全部轨道 `minmax(0,1fr)`（防 grid 项 min-width:auto 把内容推破容器）；字段行 `min-width:0` + `flex-wrap`。

**改进**
- **分区卡自然高度顶对齐**：`align-items:start`——高（9 字段）矮（1 字段）卡片不再被同行拉成等高，短卡下方留白消失，两列/三列排布更整齐。
- **表单尺寸随容器动态**：文本输入 200px 弹性基线（窄=折行全宽，宽=最多 460px）、枚举下拉 220px 弹性、数字框可缩——同一份代码在 390px 手机到 1280px 桌面都保持完整可用，无断点硬编码。

**验证**
- **5 档视口（390/500/700/1000/1280）DOM 全量溢出扫描 = 0**（修复前：390 +123/+100px、500 +33/+10px、1000 +12px、1280 +12px、390 CLI 卡 +8px）
- tsc 0（noUnused）| vite build | i18n 门 1727 键 | pytest 456/456
- ui-harness-cli **50/50**（S1–S12 全量回归：卡片收放/分区卡/当前值摘要/改动点/自适应/触屏均不受影响）

## 0.5.0-beta.15.34（2026-10-19 · Coding CLI settings 第二层卡片化：分区卡收放 + 当前值摘要 + 自适应排列）

Coding CLI 的 settings 表单从「一长条字段列表」升级为**分区卡**——每个顶层分组（模型/上下文/通用/工具/安全/…）一张可收放卡，与 15.33 的 CLI 卡同构。卡头 = 分组标题 + **当前值摘要**（配置文件/模板里的现有值一瞥可见，收起状态不丢信息）+ **未保存改动点**（该分区有未保存改动时亮起）；**有内容的分区默认展开、空分区默认收起**——现有配置一眼全见，目录空分区不再占屏。每张卡**独立收放**（非手风琴——settings 场景常需两组同看对照改）。

**新增**
- **分区卡收放**：settings 表单内每个顶层分组 = 一张卡。点卡头展开/收起（chevron 指示，`role=button` + `aria-expanded`，读屏可辨）；任意多卡可同时展开，互不影响。
- **卡头当前值摘要（预填当前值）**：卡头显示该分组的现有叶子值（至多 2 项 +「+N」，单行截断）——如 `useRipgrep=true`、`auth.apiKey=•••`（脱敏值显示为 •••）；空分区不显摘要。展开后表单字段值同样预填自当前配置文件。
- **分区未保存改动点**：改动某分区的任意字段（含模型专行）→ 该卡头亮橙色圆点，保存后熄灭——长表单里一眼定位改过哪里。
- **自适应排列**：分区卡网格 `repeat(auto-fit, minmax(300px, 1fr))`——宽屏多列、竖屏/窄屏自动单列，与 CLI 卡同款 auto-fit 无断点。
- **触屏/鼠标双适配**：分区卡头 ≥44px 触控目标 + `userSelect:none`；鼠标 cursor pointer + chevron，无 hover-only 信息。

**修复**
- **字段目录的分组整组漏渲染**：15.32 起顶层分组仅取「无点分的目录顶层键」，而 context/general/ui/modelFamily/goals/memory/agents/mcp/serve/advanced/experimental 等分组在目录里只有点分键（如 `context.autoCompactThreshold`）——**这些分组在文件未设置时整组不显示**。现顶层分组 = 目录键 ∪ 点分键前缀，全组补显（qwen-code 21 组、opencode/qoder 同款逻辑）。

**验证**
- tsc 0（noUnused）| vite build | i18n 门 1727 键 0 缺失 0 重复 | pytest 456/456
- ui-harness-cli **50/50**（新增 S12 分区卡 6 断言：有内容分区默认展开 / 空分区默认收起 / 卡头当前值摘要 / 点卡头展开 / 再点收起 / 字段改动 → 分区未保存改动点）

## 0.5.0-beta.15.33（2026-10-19 · Coding CLI 面板卡片化收放 + 自适应排列 + 触屏/鼠标双适配）

Coding CLI 面板（安装/升级/settings）从「三行列表 + 单 settings 区」重构为**卡片式收放**——每个 CLI 一张卡，点卡头展开即见该 CLI 的 actions（安装/升级/卸载）+ settings 结构化表单，再点收起；**手风琴**语义（同时至多一张卡展开，展开另一张自动收起前一张）。三 CLI 的 settings 字段**全覆盖确认**（qwen-code 107 / opencode 36 / qoder 21，官方 schema 驱动，15.31/15.32 已落，本批复核对齐）。

**新增**
- **卡片式收放**：每个 CLI = 一张卡。卡头 = CLI 名 + 安装状态/版本/更新/鉴权徽标（点=展开/收起，chevron 指示）；展开卡通栏显示该 CLI 的 actions 行 + settings 表单。原来独立的「编辑配置」按钮退役——**展开即见表单**（展开时自动按需拉 settings，已缓存则零请求）。
- **手风琴交互**：点某张卡头展开时，若另一张卡已展开则自动收起——任意时刻至多一张卡展开，长表单不叠罗汉。
- **自适应排列**：卡网格 `repeat(auto-fit, minmax(260px, 1fr))`——宽屏 3 列、中屏 2 列、窄屏 1 列，随容器宽度自动重排，无需断点硬编码。
- **触屏/鼠标双适配**：卡头 ≥44px 触控目标 + `userSelect:none`（防触屏双击选中文字）；actions 按钮 middle 尺寸 + `wb-touch-lg`（命中区扩到 ≥44，视觉尺寸不变）；竖屏 NarrowSheet 内 small 按钮高度底线 32px、去 tap 高亮灰闪。鼠标路径零变化（cursor pointer + chevron，无 hover-only 信息）。

**改进**
- **settings 归属防串卡**：展开卡显示的 settings 按响应自带 `cli` 字段归属判定，切卡 fetch 窗口期内不显示上一张卡的陈旧数据。
- **收起保留缓存**：收起卡只隐藏 DOM 不丢弃已拉取的 settings——重开同卡零请求。
- **三 CLI 覆盖确认**：qwen-code 107 字段 / opencode 36 / qoder 21（官方 schema 全量，目录驱动空态也显），与 dashboard 同源不漂移。

**验证**
- tsc 0（noUnused）| vite build 514 modules | i18n 门 1726 键 0 缺失 0 重复 | pytest 456/456（含版本三源对齐——修复 15.32 漏升 connector 的存量漂移）
- ui-harness-cli **44/44**（新增 S11 卡片化 6 断言：初始全收 / 卡头点击=展开+自动拉 / 手风琴切卡 / 再点收起 / 窄视口 390px 单列 / 宽视口 1280px 多列；mock 补 opencode settings 路由——真实 API 对任意 CLI 可读写，原 mock 只有 qwen-code）

## 0.5.0-beta.15.32（2026-10-18 · Coding CLI 设置表单完整化：字段目录驱动 + 中英自适应 + modelProviders 标注 Higress 托管）

三 CLI 的 settings 表单升级为**字段目录驱动**——官方文档字段清单（类型 + 中英双语文案）登记为目录，**未设置的字段也在表单里显示（空态）**，只有你实际改动并保存的项才写入配置文件；表单同时做**中英自适应**。

**新增**
- **完整设置表单（字段目录驱动）**：qwen-code 覆盖 Web Shell 浏览器内 Settings 页可改字段的主体（约 100 项——model 子字段、模型族、context、tools、memory、agents、mcp、security、serve、advanced、experimental 等）；opencode（server/shell/tools 逐项开关/图片附件/permission 逐项/compaction 等）；qoder（outputStyle/language/ui 全项/model 子字段/tools/security 全项/statusLine）。目录外的字段仍可用 JSON 补丁兜底。
- **表单中英自适应**：字段标签、分组标题、输入提示均带中英双语，随宿主语言自动切换。

**改进**
- **qwen-code `modelProviders` 标注「由 Higress 网关管理（默认跟 Worker）」**：空态表单不再预填路由卡片；文件已有 `modelProviders` 时显示托管提示，路由卡片保留可编辑（网关行为以实际部署为准）。
- **空态 seed 收缩为「有预填意义」的少数项**（模型请求超时 / 审批模式 / 压缩阈值 / 主题 / 自动更新），不再把 CLI 默认值全量写进配置文件。

## 0.5.0-beta.15.31（2026-10-18 · Coding CLI 三 CLI settings 表单按官方 schema 全量补齐 + 废弃凭据字段迁移 + 3 个真实 bug 修复 + UI harness 重做）

三个 CLI 的 settings 表单按**官方 schema 全量补齐**（字段来源全部实读官方文档，不猜），凭据迁到正位，并在过程中用重做的 UI harness 揪出 **3 个真实 bug**（2 个存量回归 + 1 个本批引入）。背景：此前 Qwen Code 的 settings 只显 security / auth / selectedType / JSON 补丁几个字段——15.30 的 seed 模板只有 3 个字段，且凭据字段 `security.auth.apiKey/baseUrl` **官方已标 Deprecated**（0.25.x「New Configuration Format」）。

**新增**
- **三 CLI 空态结构化表单按官方 schema 全量补齐**（`codingCliPresets.ts`，字段来源实证）：
  - **qwen-code**（qwenlm.github.io settings + model-providers 两页全字段表）：`model`（reasoningEffort/maxToolCalls/generationConfig）、`fastModel`、`modelProviders`（凭据正位）、`tools`（approvalMode/shell）、`permissions`（allow/ask/deny）、`context`（autoCompactThreshold）、`mcp`（allowed/excluded）、`mcpServers`、`security`（folderTrust/auth.selectedType）、`telemetry`、`general`、`ui`。
  - **opencode**（opencode.ai/docs/config）：`$schema`/`small_model`/`permission`（edit/bash/webfetch）/`tools`/`mcp`；provider 走 JSON 补丁（项目级才生效的坑保留告警）。
  - **qoder**（docs.qoder.com/cli/settings，qwen-code 同源三层配置）：`outputStyle`/`language`/`ui`（theme/autoThemeSwitching/maxTurns）/`tools`（useRipgrep/shell）/`security`（folderTrust/disableYoloMode）/`mcp`/`mcpServers`。
- **JSON 补丁占位按 CLI 定制**（`patchPlaceholder`）：qwen-code 给 `env` 块 + 模型生成参数示例，opencode 给 provider 示例，qoder 给 mcpServers 示例——把「这个 CLI 最常需要补丁的字段」前置到输入框。

**改进**
- **凭据从废弃字段迁到正位**：qwen-code 不再预填 `security.auth.apiKey`（Deprecated）。API Key 走 **`modelProviders[].envKey` + 顶层 `env` 块**（JSON 补丁写 `{"env":{"OPENAI_API_KEY":"sk-..."}}`）或容器 `~/.qwen/.env`——官方 Model Providers 文档定案。新增**废弃字段检测**：base 里出现非空 `security.auth.apiKey/baseUrl`（含读回的 redacted 形态）→ 红 Alert 提示迁移路径（脱敏值不误报、空串不误报）。
- **`modelProviders` 路由数组改结构化卡片**：原来是整数组 JSON 文本框（「只看到 security/auth」的直接原因之一）。现每 provider 下的模型路由 = 独立卡片（`id`/`name`/`envKey`/`baseUrl`/`wireApi` 表单 + 增删），`envKey` 按 provider 推荐默认值（openai/anthropic/gemini）——「添加路由」从手敲 JSON 变成点选填表。
- **qwen-code `model` 对象 `name` 子键归模型专行管**：树内跳过 `name`（留「← 由上方『模型』行管理」提示行），避免与模型专行双源；保存时 `{name}` 与树内子字段（reasoningEffort/generationConfig）**深合并**（原直覆会丢树里改的子字段）。
- **i18n 修复**：`{cli} settings（结构化表单…）`标题原是硬编码中文（英文模式显中文）→ 改模板键；3 条 CLI 告警文案与新源文本对齐；+7 键（1724 键 0 缺 0 重）。

**修复（3 个真实 bug，均由重做的 UI harness 实证）**
- **【回归，15.27 引入】只改模型名时保存钮恒 disabled**：15.27 加「模型专行」时，模型值只接进 `handleSave`、**漏接编辑器的 `dirty` 判定** → 只改模型名（树字段没动）时 `diffSettings` 为空 → 「无改动」+ 保存钮禁用，**改不动模型**。抽 `modelNameOf()` 助手（对象 `{name}`/扁平串双格式），让 `settingsModel`（读）/`dirty`（判定）/`handleSave`（base 比对）**三处同一口径**，`modelDirty` 并入 `dirty`。
- **【本批引入】`assignPath` 把数组腐蚀成对象**：15.31 路由卡的路径要**穿过数组**（`modelProviders.openai[i].field`），原 `assignPath` 遇 `child` 是 Array 判「非 object」→ `cursor[key]={}` **把整个路由数组覆盖成对象**（`openai:{"0":{...}}`，丢数组结构）。数组是合法容器：保留；仅当中间节点缺失/非法时按**下一键**创建（数字索引→数组、其余→对象）。
- **【本批引入】`stripEmptyLeavesNotInBase` 不递归数组元素**：原只处理「空数组/对象/空串」顶层形态，**数组元素内的对象不剥** → 空态保存时 seed 路由条目 `{id:"",name:"",baseUrl:""}` 原样写盘（脏字段）。现逐元素按对应 base 元素剥离（base 有值的字段主动清空 `""` 保留清除语义；全新条目剥空则移除；剥空成 `[]` 且 base 无此数组则连 key 丢——零脏字段）。

**验证**
- **UI harness `ui-harness-cli.mjs` 重做并转真**（此前 15.30 树编辑器重构后已陈旧、红着没人察觉）：mock GET 响应改真实 `{cli,path,exists,settings}` 形状（原裸 settings 对象被 `getCliSettings` 防御解包成空树 → S4 起全盲）；删 15.28 已退役的 S6 preset 断言；修选择器（保存钮「保存改动」/模型占位/版本占位/JSON 补丁 textarea 排除 antd 隐藏 textarea/模型行走 `input.ant-select-selection-search-input`+Playwright fill）；**+S9**（routes：路由卡片 ×2 + 添加 + model.name 专行提示 + 专行读对象 name + 改路由 → patch 含 modelProviders + redacted 哨兵）+**S10**（seed：预填可见于 input 值 + 保存零脏字段 + model 对象合并）= **36/36 绿、pageerror 0**。
- **纯函数门**（真源码提取执行，非复制）：strip 7 + strip 数组元素 4 + assignPath 4 = **15/15 全绿**。
- **真机 E2E**（本地生产 android-dev，唯一装 qwen-code 的 Worker）：空态 seed 全量保存 → 读回全字段零脏字段；路由完整 + env key 读回脱敏（在盘）；废弃字段检测函数对 redacted/干净/明文三态判定正确；最终态 = model `qwen3.6-27b-fp8` + 路由→本地 SGLang 7113 + `envKey`/`env`，废弃字段已清。
- tsc 0（含 noUnused 门）· vite build 1,977 kB（514 模块）· **pytest 456/456** · i18n 1724 键 0 缺 0 重 · 敏感扫 0 · 版本三源 15.31（`test_version_consistency` 门抓到漏 bump 的 `frontend/package.json`，已补）。

## 0.5.0-beta.15.30（2026-10-18 · 流式超时预填充读空重试 + Coding CLI settings 空态结构化表单真修（含 2 个存量渲染/合并 bug）+ 三 CLI 已知坑告警）

本批 = 15.29 使用反馈 3 件：① LLM 调优「首段输出超时 / 输出中断超时」**有的 Worker 预填充当前值、有的没有**；② Qwen Code settings **还是没法用**（没有结构化表单）；③ 另两个 coding CLI（opencode / qoder）配置**覆盖了吗**？三件全部按层归因、单点修复。

**修复**
- **流式超时「有的有有的没有」= 运行时 env 读 flaky（真根因，非配置差异）**：15.28 已把 stream 组预填链接到 `GET /workers/{name}/runtime-env` 实读容器 PID 1 实际值。但实测该端点**间歇性 flaky**——同镜像/同 runtime 的 29 个 Worker 里 5 个 `count=0`、24 个 `count=55`，同一 Worker 复测 55↔空抖动；深挖发现 flaky 形态是 **docker exec 挂起 ~20-30s 且成串突发**（连读 12 次 3 次挂 20s+、正常读 1.3s），不是简单的空读。空 env/挂起时预填退化为 QwenPaw 内置默认 30s（真实生效值却是 entrypoint 设的 300s），两种都错 → 用户见「有的有有的没有」。修（`runtime_env_api.py`，参考既有 `upgrade_api._probe_cache` 先例）：① **exec cap 8s**（正常 1.3s，挂起 8s 快速失败而非 30s）② **120s TTL 缓存**（env 值只在容器重建 / llm stream hot-apply 时变，首次成功后面板免疫 flaky）③ **stale 回退**（fresh 失败但有历史缓存 → 返旧值，永不返空/不挂——预填链永远拿到真值）④ **`?fresh=1` 绕过**（保存后确认 hot-applied 真值）。+4 回归测试（缓存命中零 re-exec / stale 回退 / 无缓存 502 / fresh 绕过）。**真机 E2E**：sysdev-lead 首次 fresh 1.65s→后续 11 次 ~0s 缓存命中；5 worker 实读最大延迟 8.01s（tech-writer 挂起被 8s cap 封顶 502，不 20-30s）。
- **Coding CLI settings「没法用 / 没结构化表单」——真根因是两个存量 bug，不是没字段**：① **树编辑器渲染自 `base` 而非 `draft`**：`SettingsTreeEditor` 的 `topEntries=Object.entries(base)`，而输入框 `onChange` 写 `draft` → 受控值绑 base、编辑态写 draft，**改了值输入框不更新**；更致命的是 `base` 为空（全新 CLI 常态，controller 契约 `exists:false, settings:{}`）时 `topEntries` 恒空 → **表单只剩一行「模型」，没有任何结构化字段**（15.26 换内容驱动树编辑器时丢了 dashboard 的「JSON 补丁」兜底）。修：**改从 `draft` 渲染**（结构+值都反映编辑，首帧与 base 一致、编辑后真实更新）。② **浅合并 clobber**：保存时 `Object.assign(patch, buildSecretPatch(...))` 浅合并——secret 与同层非 secret 字段（qwen-code `security.auth` 的 `apiKey` + `baseUrl`、opencode `provider` 的 `apiKey` + `baseUrl`）互相覆盖，**编辑同层字段时另一个字段的改动被丢**。改 `deepMergePatch`。③ **空态结构化表单（seed 模板）**：base 空时按 CLI 预填常用字段成起点（qwen-code=`security.auth{selectedType/apiKey/baseUrl}`；opencode/qoder 模板留空靠 JSON 补丁）——保存即 PUT merge 创建文件；**恢复 dashboard 的「JSON 补丁」逃逸口**（任意字段，同键以补丁为准，非法即阻止）；seed-secret 路径渲染为密码框、留空保存时**剥离不写空串**（`stripEmptyLeavesNotInBase`：base 该处非空主动清空=保留 ""、seed 预填留空=丢弃）；用户主动清空 base 非空字段仍保留 ""（清除语义）。
- **另两个 coding CLI 覆盖情况（对照 coding-cli-management SKILL.md 实证，非猜测）**：controller 写**全局** `~/.config/opencode/opencode.json`，但 **OpenCode 1.19.0 `run --dir` 只读项目级** `<workspace>/.config/opencode/opencode.json` → 全局配置对 headless 可能不生效；**Qoder 鉴权走 `QODER_PERSONAL_ACCESS_TOKEN` env（非 settings）**，表单只管 model/tools/mcp；**Qwen Code 0.25.1 默认模型 bug**（settings 的 model 可能仍请求 `qwen3.7-max`，自定义网关无此模型 → 403）。三坑以**选中 CLI 时顶部 warning Alert** 前置提示，不藏。

**验证**：tsc 0（含 noUnused 门）· vite build 单文件 1,971 kB（514 模块）· **pytest 456/456**（452 基线 +4 新 runtime-env 测试：缓存命中零 re-exec / stale 回退 / 无缓存 502 / fresh 绕过）· i18n 门 1718 键 0 缺 0 重（含补 15.29 漏注册的 `导出` 键）· 敏感扫 0 · **保存流逻辑独立门 8/8**（qwen-code 空态 seed+apiKey+model 对象格式 + baseUrl 空串剥离 / opencode JSON 补丁 mcp 深合并 + model 扁平串 / 清空 base 非空字段保留 "" + secret 哨兵 `***` 保留）· **真机 E2E**（runtime-env 缓存免疫 + 8s cap 封顶 502；qwen-code 结构化补丁往返落盘 + 空串剥离）· 版本三源一致（15.30）。

## 0.5.0-beta.15.29（2026-10-18 · Coding CLI「设置了也没用」格式根因修 + 运行时升级选择改回团队分组下拉 + tsconfig 死代码门 + 全量屎山清理）

本批 = 15.28 使用反馈 2 件（选 Worker 升级的菜单要**放在下拉菜单里**按团队排列，在菜单里直接看见当前版本/可升级到最新版/是否可更新；Qwen Code settings **还是没法用**）+ 全量屎山交叉检查（对照 10-07 外部审计清单逐项复核）。

**修复**
- **【P0 安全】完整配置含凭据导出/导入加门密码**：宿主 QwenPaw 鉴权可关（本地自用常态）且 8088 绑 `0.0.0.0` → 「同源本地」前提不成立，匿名局域网请求可 `GET /config/export` 拿到整集群 controller_token 等**明文凭据**。完整备份通道（`/config/export` + `/config/import`）加独立门密码：`X-Export-Password` 头 + salted-SHA-256（`hmac.compare_digest` 常量时间）；**未设密码默认拒绝**（secure-by-default，真正关洞而非等补设）；密码只存独立 `export_key.json`（`0600`，**不在 config.json 内** → 导出输出不含密码材料、导入覆盖不清它）。新增设置/状态/清除三端点 + 前端设置/导出前弹窗/导入密码字段 UI。脱敏端点 `GET /config` 不受门影响。`docs/12-config.md` 增「完整备份的门密码」节。
- **Coding CLI「设置了也没用」——model 写入格式根因 + 超时误报失败**：① **model 格式根因**：qwen-code 现行 `~/.qwen/settings.json` 的 `model` 是**对象 `{name}`**（官方「New Configuration Format」文档实证；早期扁平字符串由 CLI 自动迁移），而 opencode/qoder 是**扁平字符串**（controller 测试夹具 `"model":"updated"` 实证）。原代码统一写 `{name}` 对象 → opencode/qoder 读不到（反之亦然），「保存成功但没生效」。改为**按 CLI 区分**：`qwen-code` 写 `{name}`、其余写扁平字符串；**读取双向兼容**（string / `{name}` 都认）。② **超时误报**：controller 的 settings 写入是同步链（exec 读 → merge → mkdir → archive 写 → exec mv → **同步审计落盘 MinIO**），慢盘/审计尾延迟下实测**响应 240s+**（文件本身数秒内已写完）。原前端 30s 超时先放弃 → 用户看到「失败」但文件其实已写（状态不一致）。现超时 30s→180s，且**超时≠失败**：捕获 `isTimeout` 后**读回验证**（逐顶层键比对是否已反映，secret 哨兵 `***` 跳过），已反映=按成功处理并回写基线，未反映=如实报错——不假装成功。
- **运行时升级「选 Worker」改回下拉菜单（撤销 15.28 平铺卡片列）**：15.28 把多选下拉改成了**按团队分组的平铺卡片列**（使用反馈：「要按团队排列，但还是放在下拉菜单里面，而不是就这么列出来」）。改回 **`antd.Select` 多选下拉 + 按团队分组（`options` 分组）**，**每个菜单项行内直接显示** Worker 名 + 当前 qwenpaw 运行时版 `→ 可升级到最新版` + 可升级/最新/未知版本/探测失败标记（「检查更新」探测结果合入菜单项）；`showSearch` + `optionFilterProp="label"` 可搜索，`maxTagCount="responsive"` 自适应。选一个 = 单独升级。

**改进**
- **tsconfig 开启 `noUnusedLocals` + `noUnusedParameters`（死代码门，不靠纪律靠门）**：此前「干净靠纪律」——新门首跑即抓出 **37 处真死变量/参数/局部**（import、state、函数、未用形参），逐一清理：真死删、签名语义保留的形参用 `_` 前缀。从此新增死代码 tsc 直接红。
- **全量屎山清理（对照 10-07 外部审计逐项复核，registry 优先于审计清单）**：① **7 个死脚手架文件**（`harness/entry-1322/1323/1324.tsx` + `page-*.html` + `archive/MermaidDagView-13.24.tsx`，零引用）`git rm`；② **13 个零调用假公共 API** 函数删除（memory 取数簇 5 件无 UI 承载 / upgrade 单探 3 件被 check-all 取代 / team-file 2 件被新端点取代 / controller-version / agent-id-list / channel-types）——**但 `fetchProjectsWorkflow` 被 api.ts 内部 `loadWorkflowProjectsRaw` 自引用，tsc 门当场抓回恢复**（零调用 grep 排除 api.ts 自身漏了内部自引用——门的价值实证）；③ **6 个孤儿导出类型**删除（Memory 系列 / ControllerVersion / Upgrade 单探 3 件 / UpgradeGate 系列），共享类型（`MemorySection`/`TeamsRoomsResponse`）保留；④ **15 个根目录旧 ZIP 归档**到 `archive/`；⑤ **`PREEMBED-EXEMPT.md` 豁免清单优先**——审计误标 `sendInboxNotify`(P1 预留) / `fetchTeamsRooms`(P2 历史替代) 为死码，**registry 在册绝不删**（外部审计没读豁免清单的疏漏）。
- **docs 同步 + 版本三源对齐**：`plugin.py` 模块 docstring 能力清单补全（注册了 4 组 startup/shutdown 背景钩子：地址自动重排 / 收件箱审批桥 / Matrix 代理保活 / 配置权限 600，原只列 3 个用户面能力）；**修复 15.28 漏 bump 的 Python 源**（plugin.json/package.json=15.28 但 `__init__.py` 还停 15.27，三源一致性门正确抓出）——三源统一 15.29。
- **181 审计性能项复核（结论：多为已解决/非真问题，不打地鼠）**：① 「4 处永活轮询」→ 已被统一 `usePoller` 门控体系解决（内置 `!document.hidden`，文档隐藏即停，注释自证「后台零负载」；剩余 always-on 都是合法根级件 index backstop / authPoller 会话保活）；② 「无虚拟滚动」→ 三个最长列表都已 bounded（RoomChat 服务端 `limit`+load-more 前插 / KB 文件 `limit=80`+`maxHeight` / 版本表 ≤30 行），上虚拟滚动库=高风险大改换零收益，**知道什么时候停**。

**验证**：tsc 0（含新 noUnused 门）· vite build 单文件 1,958 kB · **pytest 447/447**（零回归）· i18n 门 1692 键 · 敏感扫 0 · 版本三源一致（15.29）· 真机 E2E：qwen-code settings `model:{name}` 写入 → 读回 `{'name':...}` 一致（对象格式正确落盘），超时读回验证链成立。

## 0.5.0-beta.15.28（2026-10-18 · LLM 流式超时预填真值 + Coding CLI 空配置可设 + 运行时升级单模式退役（团队分组+当前版本+可升级标记）+ 场景模板撤除）

本批 = 15.27 使用反馈 6 件：LLM 调优两个流式超时字段没预填充当前值 / Coding CLI 配置为空时无法设置 / 目标版本菜单要默认收起 / 选 Worker 要按团队排列并显示当前版本和是否可升级 / 单独升级去掉（批量选一个=单独）/ 场景模板撤除（正式承载待 AgentCom 成熟后放团队管理）。

**修复**
- **LLM 调优「首段输出超时 / 输出中断超时」预填充真值（Worker 详情「LLM 调优」段）**：这两字段在 Worker 覆盖与团队默认都为空时由 worker-entrypoint 的 `AGENTTEAMS_LLM_STREAM_TIMEOUT_S` 兜底（实盘 300s，controller 覆写时 hot-apply 进容器 env），原预填链只有 Worker→团队→registry 三层、stream 组无 registry 固定默认 → 恒空。新增**第四层「运行时 env 实际生效值」**：展开面板时经 `GET /workers/{name}/runtime-env`（15.27 端点，只读脱敏）实读 `QWENPAW_LLM_STREAM_FIRST_CONTENT_TIMEOUT / _IDLE_TIMEOUT` 容器实际值并入预填链（worker 覆盖 → 团队 → env 实际值 → registry 兜底）；保存后自动重读 env（hot-apply 生效回读真值）。拉取失败（L2 只读 / 旧 Controller）优雅回退原三层。逻辑门 8 断言全绿（覆盖优先级 / diff 免冗余 / startup 组不受影响）。
- **Coding CLI 配置为空时也能设置（Worker 详情「编码 CLI」段）**：容器重建后 CLI 重装不生成 `~/.qwen/settings.json`（controller 契约 `exists:false, settings:{}`），原空态只有提示文案、模型行被隐藏 →「已经安装了也无法设置」。**空配置也渲染结构化编辑器**：模型行常显（列表选择 + 自由输入），**填模型名保存即 PUT merge 创建 settings 文件**（controller 端 read-modify-merge + 原子写，空文件可创建）；其他字段建后在表单自然出现。配套文案改为「尚无配置文件——填模型名并保存即创建」。

**改进**
- **运行时升级「目标版本」默认收起（运维页）**：版本表格不再挂载即展开 + 即发 PyPI 代理请求——首行只显示「目标版本」+ 已选版本 tag + 「版本表」按钮，点击展开选版本（首次展开才拉列表，「刷新」手动重拉）；收起态保留「刷新」入口。
- **选 Worker 升级按团队排列 + 行内显示当前版本与是否可升级**：多选下拉改为**按团队分组列表**（controller `/workers` 的 `team` 字段分组，空=未分组，组间按团队名排序）；每行 = 复选框 + Worker 名 + **当前 qwenpaw 运行时版**（「检查更新」探测结果直接合入行内，未探测前用缓存秒回）+ **可升级 / 最新 / 未知版本**标记（→ 目标版本提示）。勾选即参与批量升级——**选一个就是单独升级**。
- **单独升级模式退役**：「单 Worker / 批量」切换移除，统一为上述团队分组列表（单 Worker 的轻探/预检 gate 段随之退役——批量流的 check-all + 二次确认已覆盖其能力面；逐 worker job 跟踪卡片保留）。
- **Coding CLI 场景模板撤除**：六场景 preset 按钮 + 建议清单区移除（场景模板的正式承载在 AgentCom 团队管理成熟后）；`codingCliPresets.ts` 六场景数据与 applyPreset 链路一并删除（-250 行）。

**验证**：tsc 0 · vite build 单文件 1,956 kB · **pytest 447/447**（零回归）· i18n 门 1685 键 0 缺 0 重 0 空（清理 14 个模板死键 + 新增 3 键）· LLM env 层逻辑门 8/8（esbuild 真代码）· 敏感扫 0 · 版本三源一致（15.28）。

## 0.5.0-beta.15.27（2026-10-18 · 运行时环境变量预填充 + 检查更新 v3（批量+缓存）+ 目标版本表格 + Coding CLI 模型列表选择）

本批 = 15.26 使用反馈 4 件（QwenPaw 运行时环境变量没预填充 / 检查更新还是很慢 + 选版本应该有个表格 / Coding CLI 设置没接入 + 模型选择应该像 Worker 那样有列表）+ 全量交叉检查。

**新增**
- **运行时环境变量预填充（Worker 详情「环境变量」段）**：新增只读端点 `GET /workers/{name}/runtime-env`（L1 only），经 Controller Docker API 代理 `docker exec` 读**容器 PID 1 实际生效环境**（`/proc/1/environ`，命令固定常量零注入面）。**根因**：Controller `GET /workers/{name}` 详情响应**不回显 `env` 键**（实盘 v1.2.5 实测 detail keys 无 `env`，写路径 `PUT env` 可用）→ 原「自定义变量」区恒空，误判「没配置」。面板新增**「运行时环境」只读区**（懒加载：首次展开才拨号）：展示 QwenPaw_* / AGENTTEAMS_* / 镜像内置 + 已保存自定义变量的**实际生效值**（预填充正源），**敏感键默认脱敏**（`TOKEN/SECRET/GATEWAY_KEY/PASSWORD/…` → 前 4+…+后 4），勾选「显示明文」才 `?reveal=1` 拉明文；支持键名过滤 + 分组（QwenPaw / 平台注入 / 其他）+ 刷新。「自定义变量」区补注：Controller 当前不回显已保存值，保存后以运行时环境为准（容器重建生效）。
- **检查更新 v3（运维页「运行时升级」，一次调用全量本地匹配，冷 6s / 暖 8ms）**：新增 `GET /upgrade/check-all`（L1 only）——服务端对全部 Worker **`asyncio.gather` 真并行轻探**（semaphore 限并发 10）读容器内 qwenpaw 运行时版 + 拉 PyPI 最新稳定版，**逐 Worker 服务端 10 分钟缓存**（升级 run 启动后逐 Worker 失效）+ **worker 列表 60s 缓存**（29-worker 集群该端点实测 2–2.9s，缓存后重复点击三重全命中）。探测命令**廉价化**：主路径读 `qwenpaw-*.dist-info/METADATA` 的 `Version:`（**不起 Python venv**，真机 0.84s vs venv-importlib 2.37s；dist-info 缺失时回退 venv-python），glob 置于双引号外（引号内不展开）。**冷启动 41.6s → 5.9s（7×），暖态 0.008s（8ms）**。前端「检查更新」= **单次调用** + 本地 `compareVersions` 匹配（最新 / 可升级 / 未知 + 逐 Worker 探测失败降级不阻塞整体）；**二次点击 = 命中缓存零 exec（毫秒级）**。运维 tab 激活后**后台延迟 3s 预取**（让出首帧），让首次点击大概率也快。单 Worker 轻探（`/upgrade/check`）与 check-all **共享同一份探测缓存**。取代 15.26 的「N×前端逐 Worker 轻探」。
- **目标版本表格（版本选择，替代自由文本输入）**：新增 `GET /upgrade/versions`（L1 only）——PyPI `releases` 字典按上传时间倒序取前 30 条，每项 `{version, upload_time, size, prerelease, yanked, is_latest}`（预发布判定按版本段匹配 `a/alpha/b/beta/c/rc/dev/pre/preview`，post-release 不算），**与 `/upgrade/latest` 同一份 PyPI 缓存**（零额外网络往返）。前端 `VersionTablePicker`（antd.Table 单选行 + 版本/发布时间/大小/标记四列）替换两处目标版本自由输入；「自定义版本（高级）」保留为任意 tag 兜底。

**改进**
- **Coding CLI 模型列表选择（Worker 详情 Coding CLI 段）**：设置树编辑器新增**模型专行**——与 Worker 模型选择**同一正源** `useModelUnionOptions`（候选 = SGLang 在服 ∪ 当前在用 ∪ 网关 alias 分组）的 `AutoComplete`（列表点选 + 自由输入兜底），**写前校验** `validateModelValue`（路径/URL/空格=error 阻止保存，不在在服列表=warn 放行提示）。保存时按 diff 写入 `model.name`（留空=清除覆盖回退 CLI 默认），**保存摘要回读**（动了模型=明示新值 / 已清除）。CLI 卡片行内新增**模型徽标**（settings 加载后显示当前生效模型，与 Worker 模型列徽标语义一致）。**清理**：删除声明后从未使用的 `modelName` 死 state（15.26 遗留）。

**修正**
- **pytest 缓存隔离扩域**：`upgrade_api` 新增模块级 `_probe_cache`（轻探 10min 缓存）后，同 Worker 名的相邻测试会命中上一测缓存（如 `test_check_light` 后 `test_check_light_unsupported_image` 拿到旧 HAS/HAS）——`conftest._clear_module_caches` 从「仅 router 模块」扩到「router + 全部域模块」的 `*_cache` dict，自动纳入未来新增的模块级缓存。

**验证**：tsc 0 · vite build 单文件 1,978 kB · **pytest 447/447**（+13 新：check-all 200/缓存零 exec+worker 列表缓存/run 失效/PyPI 降级/versions 倒序+预发布+撤回/断网 502/runtime-env 200+脱敏+reveal+403+400/轻探共享缓存）· i18n 门 1696 键 0 缺 0 重 · 敏感扫 0 · 三源版本一致（15.27）· 真机 E2E（29 worker 集群）：check-all 冷 5.9s（原 41.6s）/暖 8ms，29/29 探测到版本；versions 10ms 返回 30 行（最新 2.2.2 + 预发布 2.2.2b6…）；runtime-env 真机脱敏+reveal。

---

## 0.5.0-beta.15.26（2026-10-17 · 检查更新简化 + Coding CLI 结构化设置表单 + 设置响应解包修正 + LLM 调优生效值预填）

本批 = 15.25 使用反馈 4 件（检查更新太慢 / Worker 不占整行 / LLM 调优要预填当前值 / Coding CLI 设置要结构化 + 守 L1/L2 分权）。

**改进**
- **检查更新简化（运维页「运行时升级」批量模式）**：原「检查更新」= 每次对每个 Worker 逐个 `docker exec` 轻探（N 个 = N×延迟，慢的根因）。现改为——**当前版本** = 各 Worker 容器内 qwenpaw 运行时版（首次探一次后**模块级缓存**，后续检查秒回，不再逐次 exec）；**最新稳定版** = 单次 PyPI 查询（**新端点 `GET /upgrade/latest`**，L1 only，服务端 10 分钟缓存，断网回退旧缓存并标 `stale`）。逐 Worker 本地版本比较（`compareVersions`）出「最新 / 可升级 / 未知」状态。**关键定案**：Worker 镜像 tag（如 `v1.2.5`）是 AgentTeams 镜像版，≠qwenpaw 运行时版（如 `2.2.1`），拿镜像 tag 比 PyPI qwenpaw latest 恒误判「可升级」——故当前版本正源是容器内 qwenpaw 版（`/upgrade/latest` 实测 PyPI 最新 `2.2.2`、集群容器内 `2.2.1`）。升级成功后自动清该 Worker 缓存（版本已变，下次重探真值）。
- **Coding CLI 结构化全设置表单（Worker 详情 Coding CLI 段）**：原设置编辑 = 模型名输入 + 密钥栏 + **自由 JSON 补丁**（松散式）。现新增**结构化树编辑器**——递归渲染 settings 树：脱敏密钥 → 密码框（留空=保留已存 / 输入=替换）、对象 → 分组下钻、数组 → JSON 文本、标量 → 类型化输入（布尔开关 / 数字 / 字符串）。**免硬编码各 CLI schema**（qwen-code / opencode / qoder 的 settings 是各自 CLI 自有 JSON，无固定 schema，动态渲染任意字段）。**网络传输减**：保存只发**叶子级 diff 补丁**（只发改动的字段）+ **PUT 响应直接复用**返回的合并后 settings（免再 GET 重拉一次全量）。只读态（L2）整表单禁用。

**修正**
- **Coding CLI settings 响应解包（wrapper-unwrap，真 bug）**：settings 端点真实响应是 **wrapper** `{cli, exists, path, settings}`（`settings` 子树才是配置文件的真树，脱敏哨兵在树内），而非裸树。旧代码把 wrapper 当树用 → ① 模型名恒读空（读 `wrapper.model` 而非 `wrapper.settings.model`）② 密钥字段路径多一层 `settings.` 前缀（会把密钥写到错误嵌套）。现 unwrap 到 `.settings` 作树，diff/密钥补丁按「配置文件相对路径」发（Controller 对真树 deep-merge）。GET/PUT 两端加防御（无 `settings` 键 → 空树，不炸）。

**LLM 调优**
- **生效值预填（Worker 详情「LLM 调优」卡）**：原只显示 Worker **显式覆盖**（未设 = 空 = 灰显 registry 默认）。现展开时拉该 Worker 所属团队 → **解析当前生效值**（Worker 覆盖 → 团队默认 → QwenPaw registry 兜底）预填进字段（看到的是实际生效值，非默认）。写语义改字段级：改值 = 写 Worker 覆盖；改回继承值 = 清除覆盖（不写冗余）；不动 = 无 diff。拉团队失败不阻塞（退化为 Worker → registry 两级）。

**分权（查 Controller 源码定案，无需改前端）**：Coding CLI 面由**服务端强制**——L1（admin/manager）全量 + 读写；L2（team leader）仅自己团队 scope + **只读**（settings PUT / install 返 403）；L3（human）同 L2 团队 scope。前端保持「假设可写 + 403 → 整面只读」既有模式（已正确）。

**验证**：tsc 0 · vite build 单文件 1,965 kB · pytest 434/434（含新增 `/upgrade/latest` 5 例：L1 门 / 成功 / 缓存命中不重复拨号 / 断网回退 stale / 无缓存断网 502）· i18n 门 1672 键 0 缺 0 重 · 敏感扫 0（源码 diff 0 个人标识 / 0 内网 IP；dist 0 内网 IP）· 三源版本一致（15.26）。

---

## 0.5.0-beta.15.25（2026-10-17 · 集群版本卡 + 逐 Worker 运行时升级重接 + LLM 调优面板 + 运行时批量升级 + Coding CLI 检查更新/升级 + 编码执行记录归 Worker 会话）

本批 = 消费 AgentTeams 1.2.5 三块新能力（集群版本可观测 / 运行时在线升级 / LLM 调优）的插件侧 + 编码 CLI 管理面增强。

**新增**
- **集群版本卡（运维页，新端点 `/cluster-info`，L1 only + 10 分钟缓存）**：运维页状态网格上方新增两张版本卡，显示集群两套系统的**真实版本**——「AgentTeams 版本」= agentteams-controller **镜像 tag**（发布版本；`/api/v1/version` 硬编码返回 `dev`，不可用，故走镜像 tag 正源）；「Higress 版本」= 三级探测（容器内 `/etc/higress_version` 文件 → `HIGRESS_VERSION` env → null），**绝不猜**——探测不到显示「—」（悬停看原因，不报错；Higress 无 console REST 版本端点，404 已核）。同时移除团队管理页头的版本徽章（单一信息源，避免两处漂移）。
- **逐 Worker 运行时升级重接（修 v1.2.5 打包缺口）**：原设计代理容器内 `agentteams-upgrade` 插件（127.0.0.1 回环），但 v1.2.5 的 `_prepare_default_plugins` 从未注册该插件（打包缺口，镜像内已核）→ 回环恒 404，结构性死路。现重接为**直接 `docker exec` 内置升级脚本**：「检查更新」= 轻探（当前运行时版本 + 检查脚本可用性，venv python 执行——系统 python 缺 `qwenpaw_worker` 包，已核）；「触发升级」= 分离执行 `upgrade_qwenpaw_runtime.sh --phase pre-restart`（显式绝对路径 `--state-file`/`--pending-file`——docker exec 的 env ≠ app 进程 env，默认路径会把 pending.json 弄成孤儿）；「状态」读磁盘 state 文件 + pending.json（真值，重启后仍存）。**QwenPaw-only 门控**：非 qwenpaw runtime 的 Worker 明确返回 400（带原因）。worker/version/job_id 在拼命令前正则校验（注入面收口）。17 单测（L1 门 / 轻探·全探 / 检查器缺失 404 / qwenpaw-only 400 / 注入 400 零拨号 / run 分离命令形状 / 状态解析 / job_not_found 404）。
- **LLM 调优面板（Worker 级 + 团队默认，双层，AgentTeams 1.2.5+）**：把 dashboard 的 LLM 调优搬进工作台，覆盖继承链全层（Worker 覆盖 → 团队默认 → QwenPaw registry 默认）。10 个 `llm*` 字段，字段级 diff PUT（省略 = 保留 / 空串 = 清除回落 / 值 = 覆盖）；**全字段 L1 only**（L2/L3 账号整段只读，不报错）；2 个 stream 字段热生效（不重建容器）、8 个 startup 字段投影进 env 需容器重建才生效（界面标注）。Worker 详情「LLM 调优」卡（宽屏内联 + 竖屏 sheet，**可折叠**——默认收起、首次展开才惰性加载省请求，与同轨「运行配置 / 环境变量与网关探测 / Coding CLI」段头 x=33 轨对齐）；团队管理 CRD 编辑弹窗「团队 LLM 调优」段（同款字段网格，字段级 diff 并入团队更新体，整组校验）。
- **运行时批量升级（运维页「运行时升级」面板新增「批量」模式）**：面板顶部加「单 Worker｜批量」切换（单 Worker 原流程不动）。批量模式可多选 qwenpaw Worker——点「检查更新」逐个轻探各 Worker 当前运行时版本与就地升级可用性（顺序执行，避免拨号风暴）；填目标版本后「批量升级」按**顺序**触发（一次一个 Worker，避免容器重启互扰），逐个跟踪 job 状态（阶段 / 起止 / 日志尾部），启动自检失败自动回滚——与单 Worker 同款两阶段语义，触发前二次确认。
- **Coding CLI 检查更新 + 升级（Worker 详情 Coding CLI 段）**：段头新增「检查更新」——由**插件后端（宿主）** server-side 查各 CLI 的 npm registry 最新版本（新端点 `/coding-cli/latest`，L1 only + clis 白名单 + 固定 npmjs base 防 SSRF + 5 分钟缓存），**不再让浏览器直连 registry**（操作机在内网可能连不上外网 registry；宿主也连不上时逐项优雅降级为「registry 不可达」，仍可手动填 tag 升级）。每个已装 CLI 的版本徽标旁显示「有更新 → X」/「已是最新」/「registry 最新 X」。已装 CLI 新增「升级」按钮（按所选版本 tag 重装，空 = latest）；版本输入框改为「版本 tag（安装/升级）」语义。**升级仍是发一条 install 指令（消费上游 1.2.5 #1360），无新机制。**
- **编码执行记录归入 Worker 会话区**：运维页移除「编码执行记录」段；Worker 会话抽屉新增第三个 tab「Coding CLI」——与 Active / Archived 会话并列，按当前 Worker 过滤其编码 CLI 执行记录（1.2.5+ 只读 transcript），30 秒可见门控静默轮询（切走即停），点开任意一条看完整日志。数据源与渲染件同运维页同源复用（不漂移）。

**验证**：tsc 0 · vite build 单文件 1,960 kB · pytest 429/429 · i18n 门 1661 键 0 缺 0 重 · 敏感扫 0 · 三源版本一致（15.25）· dist 校验（含 `coding-cli/latest`、`0.5.0-beta.15.25`×2、浏览器直连 registry URL 已删）· 新端点单测：`/cluster-info`（镜像 tag 正源 / 三级 Higress 探测 / L1 门 / 缓存）+ `/upgrade` 重接（17 例）+ `/coding-cli/latest`（8 例：L1 门 / 成功 / 白名单 400 / 缓存 / refresh / registry 500 降级 / 非 JSON 降级 / 子集）

---

## 0.5.0-beta.15.24（2026-10-17 · 逐节点运行时版本 + 设置页两套认证分家 + Coding CLI 管理）

**新增**
- **Worker「运行时版本」改为容器内实测（逐节点探测）**：团队管理页展开任意 Worker，「运行时版本」现在显示该 Worker 容器内实际运行的运行时版本（如 QwenPaw 2.2.1、OpenClaw x.y）——由 Controller 代理容器内执行 `--version` 探测（10 分钟缓存），覆盖 qwenpaw / openclaw 等 runtime 族。宿主上的 QwenPaw 版本与容器内可能不同（如宿主 2.2.2 vs 容器 2.2.1），所以必须逐节点探测而不是读宿主。原「运行时版本」标签显示的其实是 Worker 镜像 tag，语义不准——现在拆成两项：「AgentTeams 版本」= Worker 镜像 tag（CRD image 正源，悬停看完整镜像引用），「运行时版本」= 容器内运行时实测版本。Manager 表的「版本」列同步改名并显示 tag。旧版本 Controller 不提供探测时显示「—」（悬停看原因，不报错）。
- **Coding CLI 管理（Worker 详情新段，AgentTeams 1.2.5+）**：逐 Worker 管理 qwen-code / opencode / qoder 三个编码 CLI——安装（可钉版本，空=latest）、升级、卸载（二次确认），长任务在目标 Worker 容器内执行，面板自动轮询至完成（失败显示 stderr 尾部）。设置编辑：改模型名、填密钥（读回服务端脱敏永不回显，留空=保留已存值）、可选 JSON deep-merge 补丁。内置六个场景 preset（前端/后端/数据/iOS/嵌入式/最小形态）——套用只写模型名等 settings patch；工具链共享卷、环境变量、MCP 只生成「建议清单」需人工确认，绝不自动执行。L2 账号整段只读；旧版本 Controller 显示升级提示（不报错）。
- **设置页两套 L1 认证分家**：Controller 管理员 token（L1 管理面）与 Higress Console 账号+密码（模型面）是两个独立系统的凭证，原先 Higress 段嵌在「L1 管理面」单选模式里，切到 Matrix 登录（L2）就整段隐藏，看起来像一套体系。现在 Higress 段改为独立段——与 L1/L2 模式无关常显，标题与说明明确「即使某部署中两者恰好同值，它们仍是两个不同系统的凭证——不可互相替代」，验证失败回报各归各段（Controller 失败报 Controller 段、Higress 失败报 Higress 段）。

**改进**
- **Worker 详情五段段头对齐**：「运行配置 / 环境变量与网关探测 / Coding CLI / 资源管理 / 工具执行安全」五段图标-标题间距统一，折叠/展开两态标题 x 位置不漂移（段头 x=33 轨）。

**验证**：tsc 0 · vite build 单文件 1,927 kB · pytest 412/412 · i18n 门 1589 键 0 缺 0 重 · 敏感扫 0 · 节点版本端点 10 单测全绿（镜像 tag 正源 / exec 探测 / 缓存 / L1-only 403）

---

## 0.5.0-beta.15.23（2026-10-17 · Worker 详情版本显示 + 拓扑段对齐）

**新增**
- **Worker「运行时版本」**：团队管理展开任意 Worker，信息网格新增「运行时版本」项——显示该 Worker 运行镜像的版本 tag（如 v1.2.5），悬停可见完整镜像引用（registry 路径 + tag）。旧版本 Controller 不提供该字段时显示「—」（不报错）。
- **团队管理页「AgentTeams 版本」徽章**：页面右上显示 AgentTeams Controller 版本（/api/v1/version 端点值；源码构建显示 dev）与部署模式，悬停说明各节点实际发布版本在哪看（Worker 详情「运行时版本」/ Manager 表「版本」列）。

**改进**
- **Worker 详情拓扑段对齐**：「运行配置 / 环境变量与网关探测 / 资源管理 / 工具执行安全」四段统一为同款卡片行——左缘、边框圆角、图标 x 位置逐行对齐，折叠/展开段头标题字号一致，拓扑结构视觉上更严谨。

---

## 0.5.0-beta.15.22（2026-10-17 · 适配 AgentTeams 1.2.5 + 独立模式两轴宿主契约）

**本轮 = 适配 AgentTeams 1.2.5 新能力（三块此前只能从命令行侧看到的东西，现在在界面上直接可见可操作）：① 编码执行记录查看器——委托给编码 CLI 的每一次执行都有记录可回看；② 运行时升级面板——本宿主 QwenPaw 运行时的预检、升级与升级过程跟踪；③ Worker 环境变量与网关探测——每个 Worker 的自定义环境变量可编辑，模型/MCP 网关连通性可一键探测。**

**另含独立模式适配的插件侧（配套 QwenPaw 手机版本地插件宿主壳 v8）：宿主环境契约从 `isOffline` 单布尔升级为两轴模型——轴 A 宿主形态 `host.env.kind`（server/local/desktop，声明式，决定插件后端在不在）＋ 轴 B 能力位 `host.env.caps`（net/secureStore/notify，探测式，端侧桥提供什么）；同时 UI 与代码里的「离线」一律改称「独立」（离线只保留给连通性语义）。**

**新增**
- **Worker 环境变量与网关探测（Worker 管理页新段，1.2.5+）**：展开任意 Worker 可编辑其自定义环境变量——添加/删除键值行，键名规则与系统保留键服务端同款校验；保存为整块替换语义（删除一行=移除该键，清空全部需二次确认），保存后容器重建生效（进行中的任务可能中断，界面明示）。同段内还有「网关探测」：用该 Worker 已保存的模型/MCP 配置与其身份向网关发一次最小请求，验证 Consumer 授权、路由与上游连通，结果显示成功与否、延迟与消费者名——服务端只用已持久化配置拨号，不改动任何配置。仅管理员/Manager 账号可见（L2 账号与旧版本 Controller 自动隐藏该段，不报错）。
- **编码执行记录查看器（运维页新段）**：1.2.5 起，Worker 每次执行编码 CLI 任务（Claude Code / Codex 等）都会留一份执行记录与原始日志。现在在运维页直接看——列表按时间倒序，显示执行时间、所用 CLI、Worker、状态、退出码与日志大小；点开任意一条看详情：元数据网格、本次执行的输入（prompt，仅在记录可读时显示）、完整原始日志。无记录时显示空态；Controller 旧版本未开放该能力时显示提示（不报错）。
- **运行时升级面板（运维页新段）**：本宿主 QwenPaw 运行时的一键升级入口。先做只读预检——显示当前版本、可升级候选（含预发布标记与推荐标记）、每个候选的四道门控（C1 版本解析 / C2 依赖钉定 / C3 兼容补丁 / C4 可选依赖，悬停看证据）与预检告警；确认升级后进入两阶段就地执行（失败自动回滚到旧版本），面板实时跟踪 job 状态（阶段 / 起止时间 / 日志尾部）。触发升级会重启容器并可能中断在跑任务，所以有二次确认。宿主未内置升级服务的实例（旧镜像）显示提示（不报错）。
- **两轴宿主契约（hostEnv.ts）**：`hostKind()` / `hostCaps()` / `isLocalHost()`。旧 shell 无 env 字段时回退 `isOffline` 布尔（15.12 行为）；console 宿主两者皆无 → server，在线路径零改动。入口分流（index.tsx）与配置域模拟层（api.ts → localConfigBackend）统一改用该判定。

**重构（命名与结构，行为不变）**
- `offlineBackend.ts` → `localConfigBackend.ts`、`WorkbenchOfflinePage.tsx` → `StandaloneConfigPage.tsx`；页面标题「本地离线模式」→「独立模式（本机独立宿主）」，banner 文案同步。
- localStorage 持久化键值 `agentteams-qwenpaw-workbench:offline-config` 刻意不变（改键会丢已保存的连接配置），仅常量改名 `LOCAL_CONFIG_KEY`。

**修复**
- **版本号三源不一致**：本批初版包的后端 Python 版本常量漏随发布同步（宿主日志/selfcheck 打印旧版本而前端与安装目录已是新版本）。已同步，并新增三源一致性门（plugin.json / 前端 package.json / Python 版本常量恒等，漏同步即构建门红）。

**验证**：tsc 0 · vite build（dist 1,885 kB）· pytest 402 · i18n 门 1530 键 0 缺失 0 重复 · 敏感扫描 0 · 编码执行记录/运行时升级两面板真机浏览器实证 39 断言全过（列表/详情/空态/404 降级/触发流/轮询推进）· 环境变量与网关探测面板 UI 实证 22 断言全过（键校验三态/整块替换保存/读回基线/清空二次确认/模型探测成功卡/L2 遮蔽/旧 Controller 隐藏）· dist 进包核验（两轴判定代码/独立模式文案/存储键在包内）· 本地实装后 45s 稳态 +21 拨号（判据 <50）

---

## 0.5.0-beta.15.21（2026-10-16 · 知识图谱触屏手势 + 窄屏高度/切换钮修复 + 拓扑滚轮缩放）

**本轮 = 知识图谱 2D 视图补齐手指操作（双指捏合缩放 / 单指拖动 / 点选 / 双击聚焦）+ 窄屏（手机）下知识图谱两处修复（3D/2D 切换钮被挤出屏外、图谱过高占满整屏无法滚动页面）+ 工作流拓扑依赖图补鼠标滚轮缩放。**

**新增**
- **2D 知识图谱手指操作**：2D 图谱此前只能用鼠标操作（滚轮缩放/拖拽/点击）。现在手指也能用——双指捏合缩放（捏合中点锚定）、单指拖动平移、点按选中节点（与鼠标点击同语义：邻接高亮/详情/开文件、点簇根聚焦、点空白取消）、双击聚焦节点邻域。
- **拓扑依赖图鼠标滚轮缩放**：工作流拓扑的依赖图此前只能点工具条 ± 按钮或双指捏合缩放。现在鼠标滚轮也能缩放（光标位置锚定、与捏合同一缩放区间），配合已有的拖动平移/双指捏合，桌面与触屏操作都齐了。

**修复**
- **窄屏知识图谱 3D/2D 切换钮消失**：手机等窄屏下，图谱卡头部的图例、节点数与 3D/2D 切换钮挤在一行放不下，切换钮被挤出屏外——从 3D 点「回到 2D」之后就再也切不回 3D。现在窄屏下图例与节点数移出卡头（图例改在 2D 图内展示），切换钮恒可见。
- **窄屏知识图谱过高占满整屏**：窄屏下图谱高度（3D 480px / 2D 420px）占掉手机屏幕大半，页面没法滚动。现在窄屏下图谱高度降低（3D 300px / 2D 280px），页面可正常滚动。

**验证**：tsc 0 · vite build · pytest 393 · i18n 0 缺失 · 敏感扫描 0 · 冒烟 8 组

---

## 0.5.0-beta.15.20（2026-10-16 · 看板宽屏三列两行 + 卡片高度随内容动态）

**本轮 = 看板布局再调（宽屏 ≥950px 改三列两行、中间宽度保持两列三行、竖屏保持一列六行）+ 看板卡片被纵向压缩遮挡的根因修复（卡片高度随内容动态，文字不再被半行裁切）。**

**修复**
- **看板卡片被纵向压缩遮挡（根因修复）**：卡片正文（项目名一行）原用「两行截断」样式，但该截断样式在现行浏览器里实际未生效——退化成「固定最大高度 + 溢出隐藏」，两行之后会多露出半行残字（截图里「…整e」那种半行裁切），看起来就是卡片被纵向压住、内容被遮挡。现已把截断样式修成真截断（全站 8 处受益，不再露半行残字）；并且看板卡的项目名改为全文展示——卡片高度随内容自动长，任何宽度下内容完整不遮挡，列内超过约 3 卡（宽屏约 2 卡）时列内纵向滚动兜底。竖屏一列六行模式的卡片同用此修复。
- **看板宽屏三列两行**：宽屏（窗口 ≥950px）原为两列三行，现改为**三列两行**——状态列按 3 列排布、每列卡区限高约 2 卡，列=容器 1/3 宽，卡片更宽、文字行数更少。中间宽度（500–949px）保持两列三行，竖屏（<500px）保持一列六行，三种形态的识别断点（500/950）均有单测护栏。

**验证**：tsc 0 · vite build · pytest 393 · i18n 0 缺失 · 敏感扫描 0 · 断点冒烟 18 宽度

---

## 0.5.0-beta.15.19（2026-10-16 · 看板宽屏回两列三行 + 左栏名字自动换行）

**本轮 = 看板布局调回（宽屏的六列一行横滚改回两列三行，解决右列被裁切、卡内文字被裁）+ 三页左栏名字自动换行（项目/房间名不再被省略号截断，卡片高度随内容动态）。**

**修复**
- **看板宽屏回两列三行**：宽屏（窗口 ≥950px）原为「六列一行」布局（每列固定 250px + 横向滚动），整板 8 列要 2000px 宽才放得全——窗口稍窄右侧列（如「已完成」）被裁出视野，且 250px 列内卡片文字换行 3 行以上、被裁切。现在宽屏与中间宽度同为「两列三行」布局（列=容器半宽、整板不横滑、每列约 3 卡限高、超出列内纵向滚动）——窗口越宽列越宽，卡片不再挤、整板不再被裁。两列三行与竖屏一列两种布局的识别与实现本就正常，未改动。
- **三页左栏名字自动换行**：聊天页（群卡片/DM 卡/邀请卡）、产物页（项目/房间）、工作流拓扑与卡片视图左栏的名字，原为单行省略号显示——左栏可拖宽，但拖到多宽都显示不全。现在这些名字自动换行，任何宽度下都显示全名，卡片高度随换行行数动态伸展（项目卡视图的项目名原本就自动换行，三页左栏改为同款换行）。消息预览行与文件名明细行保持原单行样式。

**验证**：tsc 0 · vite build · pytest 393 · i18n 0 缺失 · 敏感扫描 0

---

## 0.5.0-beta.15.18（2026-10-16 · 横屏误判修复 + 知识库/技能中心简化 + 看板巨石拆分）

**本轮 = 修「横屏宽屏被误判竖屏」根因（Desktop OS 窗口模式下 2412px 横屏判成竖屏单列、全页拉长）+ 产品简化（知识库纯远端 / 技能中心只留上传）+ WorkflowBoard 巨石拆分（N-07）。**

**修复**
- **横屏宽屏误判竖屏（根因修）**：QwenPaw 宿主控制台的插件挂载兼容层用了 `display:contents` CSS（不产生布局盒、宽度恒为 0），插件的横竖屏判定沿父容器链取最小宽度时，恒被这层 0 宽拉成 0 → 2412px 横屏被钉死判成竖屏单列（产物/工作流拓扑/聊天/团队管理等全部拉长）。修复：判定遍历父链时跳过 0 宽层（0 宽层本就不约束子元素布局），任意窗口尺寸都取到真实可见宽并随窗口缩放跟随；另加「切 tab 强制重测」+「窗口焦点恢复重测」双兜底。自检诊断卡新增父链逐层宽度输出（0 宽层标注「不计」）——若再复发，一屏定位是哪层把可见宽拉低。

**简化（产品定案）**
- **知识库纯远端**：删「本机宿主 Agent」降级视图与「重新检测」按钮，只留远端团队知识库（Controller 直读 Worker 容器工作区）；远端不可用（无 token / L2 用户 / 无 Worker）时顶部给配置指引，不再降级本机。
- **技能中心删「技能目录」卡**：目录列表/搜索/下载不再呈现（团队实操价值低），只保留「上传技能（zip）」「新建自定义技能」两个入口；Worker 技能分配矩阵不受影响（仍走目录数据层取来源标签）。

**屎山清理**
- **看板 WorkflowBoard 4449 → 759L**：拆 `workflowboard/` 7 模块（DagTopo 607 / BoardView 446 / blocks 418 / panels 359 / timeline 174 / rail 137 / helpers 232 / types 28）；对外契约不变（default export + 具名 WfView）；行为零变（纯搬移）。

**验证**：tsc 0 · vite build 503 模块 · 敏感扫描 0

---

## 0.5.0-beta.15.17（2026-10-15 · 15.x 优化批：聊天文件引用 + 三大巨石拆分 + 审批色值收敛）

**本轮 = beta 15.x 的 UI/性能/技术债收口批：1 个新功能（#87 聊天引用团队共享工作区文件）+ 三大前端巨石拆分（CrdManage/KB/看板 layout）+ 审批严重度色值单源收敛。**

**新增**
- **聊天引用团队共享工作区文件（#87）**：聊天输入框可 `@` 引用团队共享工作区里的文件（FileRefPicker 选择器 + 连接器 `/team-files` 端点），引用以文件徽标呈现、发送时附带文件引用，接收侧可点开查看——补齐「聊天里直接引用工作区文件」的协作闭环。

**屎山清理（三大巨石拆分，行为零变）**
- **团队管理 CrdManage 2540 → 353L**：拆成 `crdmanage/` 15 模块（纯叶子 types/helpers/FieldLabel ← 4 个 hooks ← 8 个渲染组件 ← 主装配层），依赖单向无环；纯搬移 + 锚点定位 + 全标识符审计（0 UNEXPLAINED），主文件瘦为「props → 4 hooks → JSX」装配层。
- **知识库 KB 3162 → 142L**：双栏 KB 容器化 + 拆 9 模块（useKbColHeight 等高容器化），冒烟 160 断言全绿。
- **看板 layout-mode 抽纯模块**：横屏/竖屏布局判定抽成纯函数模块 + 断点回归冒烟（15.15 横屏回归修复的防回归护栏，667<800 不再被卷进竖屏堆叠）。

**修复**
- **审批严重度色值单源收敛（P1-6）**：SEV_COLOR 此前在通知中心/审批卡各持一份、首页又内联 `#ff4d4f` 漂移（同为 CRITICAL/HIGH 两种红）→ 抽 `util.ts` 单源（CRITICAL/HIGH=`#f5222d` antd error 红 / MEDIUM 橙 / LOW 绿），三处审批严重度消费统一走 `sevColor()`（各消费方回退色保留：通知中心灰、审批卡/首页橙）。

**验证**：tsc 0 · vite build 1,860kB · i18n 键全量 · crdmanageHelpers 冒烟 SMOKE_OK（esbuild transform 修脚本缺陷）· kbLayout2d 冒烟 160 绿 · 双态（竖/横）×双输入（触摸/鼠标）抽查·团队管理+工作流页零回归

---

## 0.5.0-beta.15.16（2026-10-15 · 审计面板 A7：消费上游 #1270 持久审计）

**新增「审计」tab——消费 Controller 持久审计存储读侧（上游 #1270 `GET /api/v1/audit`，MinIO JSONL 追加式，覆盖全部入口：dashboard / CLI / API）**

- **审计 tab（新增）**：治理事件只读面板，与 dashboard B6（audit-section）语义对齐但数据路径不同——插件无 BFF 层，前端经连接器 catch-all 直透传 `/api/v1/audit`，作用域由 Controller 服务端强制（**L1 全量** / **L2 `?team=` 必填且跨团队 404 反探测** / worker 身份 403 默认拒绝）。
- **作用域自适应**：团队选项由 Controller 按调用者作用域返回可访问团队（L1=全部、L2=本团队）——「token 即作用域边界」，前端零额外判定。L1 默认「全部团队」可下钻单团队；L2 自动锁定本团队并显「视图限定本团队」徽标。
- **过滤**：类型（全部/能力授权/审批级别/频道/来源）× 时间范围（1 天/7 天/30 天/全部）× 团队三维过滤；keyset 分页「加载更多」（游标走 ref 不进依赖链，防加载更多后被重置回首页）。
- **严重度派生**：Controller 事件无 severity 字段——从 action 语义推导（失败/拒绝/撤销/删除=错误；授权/增改/凭据写入=警告；读取/回读=信息），与 dashboard B6 归一化同思路。
- **诚实降级**：404=旧 Controller 无端点→版本门信息提示（升级后自动可用）；403=身份无权→权限提示；30s 自动刷新（tab 激活门控，切走即停）。

**验证**：tsc 0 · i18n 1,457 键 0 缺 0 重 0 空 · 实盘 audit 端点 200 有真实事件（channel 类目抽样核对字段形状：targetTeam/before/after 可空、capability 前缀、cursor 页满才有）· 三载体 15.16 同步

---

## 0.5.0-beta.15.15（2026-10-15 · 看板横屏回归修复 + 首页版本号）

**横屏看板回归修复：横屏手机（容器宽 500–950）此前被误归入竖屏堆叠布局（横屏 667<800 恒为「窄」，15.13 改 Jira 横滚时把横屏带一并卷进了竖屏交互）——现按实测容器宽三档分流：竖屏（<500）保持 15.11 移动布局；横屏/中间宽度（500–950）恢复「两列定宽网格 + 每列最多 3 卡、超出列内纵向滚动」（看板列固定大小、不压缩、不横滑）；桌面宽屏（≥950）保持 250px Jira 横滚。布局模式由容器实测宽驱动（手机旋转不触发窄/宽判定翻转，快照过期由 ResizeObserver 回调纠偏）。首页欢迎条身份行追加插件版本号（页头版本行竖屏被隐藏，此前手机上无处可查版本）**

- **工作流 · 看板（横屏回归）**：布局判定从「窄(<800)/宽」二档改为按**实测容器宽**三档——`stacked`（W<500，竖屏手机：状态列纵向堆叠全宽 + 列内 165px 卡行横滚，15.11 布局不动）/ `grid2`（500≤W<950，横屏手机 667 / 平板竖屏 / 中间宽度：两列定宽网格 `minmax(0,1fr)`，列=容器半宽**永不压缩、整板不横滑**；每列卡区限高 `min(40vh,320px)`≈3 卡，**超出列内纵向滚动**）/ `jira`（W≥950，桌面：8 列固定 250px 横滚 + 列等高，不动）。回归根因：15.13 为修桌面中间宽度挤竖条把 ≥800 一律改 Jira 横滚，但横屏手机 667px<800 恒判「窄」→ 拿到的是竖屏堆叠布局（横屏被搞烂）。布局模式现由 wrapRef 实测宽 + ResizeObserver 驱动——手机旋转 376↔667 不触发窄/宽快照翻转（两值都 <800），实测宽才是唯一正源。
- **首页 · 版本号**：欢迎条身份行（当前账号 · Controller 级别）末尾追加 `· v0.5.0-beta.x`——页头版本行竖屏被 `!narrow` 隐藏（省竖向空间），此前竖屏手机上插件版本无处可查；现首页恒可见，构建期注入、与页头同源。

**验证**：tsc 0 · 三载体 15.15 同步（plugin.json / 连接器 `__version__` / package.json）

---

## 0.5.0-beta.15.14（2026-10-15 · 竖屏第 9 批 + 离线诊断真拨号：看板细条根修 / clamp 统一 / 发送钮常显 / 话题窗鬼影修 / tab 滚轮 / 配置长 URL 折行 / 离线两步探测）

**竖屏第 9 批 + 离线诊断根修：看板卡「细条」（标题/项目名塌 0 高、只剩 tag 行）根修自卡容器 overflow:hidden + Chromium 154 clamp 双根因；8 处内联文字截断统一为全局标准类（跨 Chromium 版本安全）；聊天输入框发送按钮常显（空时 disabled、不再消失）；窄屏「话题窗鬼影弹出」修复（仅用户在窄屏显式打开的话题才允许自动弹 Drawer）；插件内所有「纯横向滚动条」统一支持鼠标滚轮横滚（全局委托、不抢消息列表、边界放行）；配置页长地址不再撑破窄容器；离线「连接测试」改为真两步探测（可达性 + 是否启用 CORS），分层归因并指向真实开关**

- **工作流 · 看板**：宽屏 / 横屏看板卡「细条」根修——卡容器 `overflow:hidden + display:grid` 使 grid 项 `min-height:auto` 塌 0（Chromium 154 下实盘 20 卡列每卡塌 18px），标题 / 项目名行塌 0 高、只剩 tag 行（即「挤在一起」）。去掉容器级 overflow，标题 / 项目名各自的 clamp div 自带 `overflow:hidden` 限高、tag 行 flexWrap，容器不再兜底。
- **全局 · 文字截断**：8 处内联 `display:-webkit-box + -webkit-line-clamp`（看板卡 / 全局消息搜索 / 通知中心）统一为全局标准类 `wb-clamp-1/2/3`——用标准化 `line-clamp` 属性（Chromium 135+）+ `max-height` 兜底（旧版退化为「硬截断不夹中间」），跨 Chromium 版本行为一致。
- **聊天 · 输入框**：发送按钮**常显**——输入框为空时 disabled（不发），不再随 draft 有无整块消失（旧写法空态整块消失，移动端误以为「没有发送键」）。
- **聊天 · 话题窗**：修「话题窗鬼影弹出」——宽屏窗口收窄时，宽屏内联打开 / 持久化恢复的话题会自动转成 Drawer 弹出；现记住「该话题是否用户在窄屏下显式打开」，仅此种情况才允许 Drawer 自动开，收窄窗口不再弹宽屏打开的话题。
- **全局 · 页签条**：插件内所有「纯横向滚动条」（顶栏 tab 条 / 视图切换 / 技能 tab 条 / antd Tabs nav 等）统一支持**鼠标滚轮横滚**——capture 阶段在 document 委托（一次覆盖全部），不抢消息列表（消息列表仍走纵向滚），横滚到边界且滚轮继续往外时放行（不 preventDefault，页面可正常滚）。
- **配置 · 连接测试（离线）**：离线「连接测试」改为**真两步探测**——① no-cors 探测 = 纯网络可达性（DNS / 路由 / TCP / TLS，「到达服务器但跨域被拦」返回 opaque 不抛错）；② cors 探测 = 服务端是否启用 CORS。分层诚实归因：不可达 = 地址 / 网络问题；可达但未启用 CORS = 浏览器直拨被拦，修复 = 在远程服务端配置 `QWENPAW_CORS_ORIGINS`（上游开关已存在），或在该服务端前配同源反代。离线横幅诊断文案同步修正。
- **配置 · 长地址**：配置页长 URL / 地址不再撑破窄容器（320 / 340 实盘实证横溢）——inline-block + max-width 100% 钳制、URL 内 break-all 断行。

**验证**：tsc 0 · vite build 单文件 1,836.12kB（gzip 513.72kB）· pytest 374/374 · i18n 1436 键 0 缺 0 重 0 空 · 敏感扫 0

---

## 0.5.0-beta.15.13（2026-10-13 · 竖屏第 8 批：拓扑标题随滚 + 技能详情弹窗 + 看板标准列宽 + 页签滑动根修）

**376px 实测第 8 批：工作流拓扑详情标题栏改随内容滚动（不再常驻顶部吃掉纵向空间）；项目看板宽屏/横屏改标准看板布局（状态列固定 250px 不被压窄、放不下一屏横向滑动）——超过三张卡的列在横屏被挤成一条线的问题根修；技能中心（资源管理 + 技能中心两处）技能卡面去描述，改每个技能卡「详情」按钮点开完整信息弹窗；竖屏资源管理技能 tab 的上传/新建按钮移到搜索框下方（不再超宽）；MCP 编辑按钮不再超出容器；运行配置 / 资源管理页签条滑动卡顿根修；配置页认证与登录的 Matrix 登录 / L1 管理面两按钮竖屏改纵向排列**

- **工作流 · 拓扑**：项目拓扑详情（干预/中断/依赖图/事件流）的**标题栏不再常驻顶部**，改为与下方内容一起滚动——竖屏下省下常驻占用的纵向空间，可滚动内容区更大。
- **工作流 · 看板**：宽屏/横屏的看板改为**标准看板布局**（Jira/Trello 同款）——各状态列**固定 250px 宽、不再按屏幕比例压缩**，列高随屏幕高度自适应，一屏放不下的列**横向滑动**查看。此前横屏/中间宽度下超过三张卡的列会被挤成一条窄线；窄屏（手机竖屏）保持移动端看板布局（列纵向堆叠 + 卡横向滑动）。
- **团队管理 · 技能中心（资源管理 + 技能中心）**：技能卡面**去掉两行截断的描述**——每个技能卡（分配卡与展开的物化层行）新增「**详情**」按钮，点开弹窗展示完整描述、来源、版本、运行时 / 装载渠道、使用方。竖屏下资源管理「技能」tab 的**上传技能 / 新建自定义技能两按钮移到搜索框下方**（搜索占整行、两按钮等宽并排），不再超宽挤出弹窗。
- **团队管理 · MCP**：MCP 服务行**编辑按钮不再超出容器**——长服务名 / 地址自动换行收缩，按钮恒在容器内。
- **全局 · 页签滑动**：「运行配置 / 资源管理」等弹窗的**页签条横向滑动卡顿根修**——触屏横滑手势直接声明为横向（免方向采样延迟）并切断滚动链（页签滑到头不再把弹窗内容带着滚）。
- **配置 · 认证与登录**：竖屏下「Matrix 登录（L2，默认）/ L1 管理面」两个长标签**改纵向排列**（宽屏保持横排分段控件），不再超宽。

**验证**：376px / 850px / 1440px 三档视口真数据实测逐项确认 + 宽屏回归 · tsc 0 · vite build 单文件 · i18n 1428 键零重复 · 敏感扫 0 · 运行时冒烟零错误

---

## 0.5.0-beta.15.12（2026-10-13 · 本地离线模式：数据域零拨号 + 配置域本地留存）

**插件在本地环境运行（本地插件宿主、无 QwenPaw 服务端）时的行为根修：503 刷屏从结构上消除——数据域（会话 / 聊天 / 工作流 / 产物）入口级不挂载，无任何数据接口拨号；配置域完整可用——连接配置可先填写并保存（本地留存、凭据脱敏），服务端就绪后经 Web 控制台「备份与恢复 → 导入」应用此配置。console 宿主（在线路径）行为零变化**

- **离线识别**：本地插件宿主 shell 暴露静态离线信号（`QP.host.isOffline`）；插件入口按此信号在渲染时分流——本地宿主挂离线页，console 宿主照旧挂全量工作台。同一份产物两端通用，在线路径零改动。
- **数据域**：离线页不挂载任何数据页组件——无拨号、无 503 报错、无轮询；离线横幅明确说明数据接口不可用的原因与配置的去向。
- **配置域**：离线页内嵌原设置面板，配置读写（GET/PUT）、导出/导入、连接测试、管理员验证走 localStorage 模拟层——凭据脱敏（回显 `***`、不回读明文）、地址条目位置配对合并、保存前凭据缺口拦截、字段枚举降级等语义与服务端连接器逐条对齐；已保存配置在重开插件后仍在（浏览器本地存储）。
- **连接测试（离线）**：各地址行如实报不可达（本地宿主无网络路径），生效地址 / 固定地址的口径计算与线上一致；管理员验证返回明确说明——连接配置可先填写并保存，连上服务端后再验证应用。

**验证**：tsc 0 · vite build 单文件（守卫全过）· 敏感扫 0

---

## 0.5.0-beta.15.11（2026-10-13 · 竖屏第 7 批：看板移动布局 + 产物长名换行 + 弹窗精修 + 容器宽度对齐）

**376px 实测第 7 批：项目看板窄屏改移动端看板布局（状态列纵向堆叠全宽、列内任务卡横向滑动，不再被挤成竖条）；产物页项目长名自动换行完整显示（不再撑宽/截断丢名）；「运行配置 / 资源管理」弹窗 tab 条支持横向滑动、技能列表卡片在弹窗内完整显示不裁剪；知识库视口高度改动态值（手机地址栏伸缩时不再撑出页面）**

- **工作流**：项目看板窄屏（手机竖屏）改为**移动端看板布局**——各状态列（待办/已派发/进行中/…）**纵向堆叠、占满屏宽**，列内任务卡保持固定可读宽度**横向滑动查看**（一次可见两张半，滑动手感与原生列表一致）。此前超过 3 张卡的列会被挤成一条竖线。
- **产物**：项目产物列表的**长项目名自动换行完整显示**（此前超出部分被挤成竖排或撑宽行）；文件名的长串同样换行不截断；产物区**宽度固定为屏幕宽**，内容再多也不产生页面横向滚动。
- **团队管理**：「运行配置 / 资源管理」弹窗内**顶部页签条支持横向滑动**（窄屏放不下时不截断不丢失，末尾页签可从溢出菜单进入）；技能列表卡片在弹窗内**完整显示**——名称、来源标签、说明文字正常换行排布（此前说明文字被挤成单字竖排或超出弹窗被裁）。
- **全局**：各页面容器宽度统一对齐屏幕宽度（含内边距），内容超宽时页面**不再出现横向滚动**；知识库两栏高度改用动态视口值（手机地址栏展开/收起时高度跟手，不再顶出页面）。

**验证**：376px 手机视口真数据实测（看板 / 产物 / 两弹窗 / 页面零横向滚动）+ 1280px 宽屏回归零变化 · tsc 0 · vite build 单文件（468 模块）· 敏感扫 0

---

## 0.5.0-beta.15.10（2026-10-13 · 竖屏第 6 批：上一批 4 件复现问题源码级修复 + 主页工作流卡）

**376px 真机复测第 6 批：上一批报「已修」仍复现的 4 件全部源码级修复——团队管理「运行配置/资源管理」弹窗横向拖拽根因（表单行 150px 固定 label 列 + 140~220px 固定宽控件超弹窗内容宽）改为窄屏纵向布局 + 控件限宽到弹窗；工作流项目拓扑（依赖图）窄屏自动缩放到容器宽（整图一屏可见）+ 节点标题自动换 2 行；看板任务卡 worker 标签自动换行不撑破卡片；拓扑详情标题栏改不透明实底（旧「不透明」实际用的半透明色）滚动不再重叠；团队管理拓扑树 meta 行窄屏整组换行**

- **团队管理**：「运行配置 / 资源管理」弹窗窄屏**不再横向拖拽**——表单行（label + 控件）窄屏**自动转纵向**（label 上、控件下整宽），所有下拉/输入控件**宽度限制到弹窗内容宽**（此前 150px 固定 label 列 + 220px 固定控件合计超出 ~280px 弹窗内容宽，这是横向拖拽的根因）；弹窗内所有容器贴紧弹窗宽度。拓扑树 Worker 行的次要信息（模型/运行时/版本/MXID/spawns 徽标/私聊按钮）窄屏**整组换到第 2 行**，MXID 长串可断行。
- **工作流**：项目拓扑（依赖图）窄屏**自动适配容器宽**——DAG 布局宽（多列 × 200px 节点）超出屏幕时自动缩小到整图一屏可见，捏合/按钮可放大细看（复位 = 回到适配缩放）；DAG 节点标题**自动换 2 行**（此前 14 字硬截断）；拓扑详情**标题栏不透明实底**（上一批误用半透明卡片色，滚动内容仍透出重叠），滚动不再与内容重叠；工具栏**返回按钮恒在最左**、「项目 (xx)」在其右侧；看板任务卡 worker 标签**自动换行/断词**，不再超出卡片容器。
- **主页**：新增「工作流」快捷卡（一键进入项目进展与任务拓扑）。

**验证**：tsc 0 · vite build 单文件（468 模块）· 敏感扫 0

---

## 0.5.0-beta.15.9（2026-10-13 · 竖屏第 5 批：输入框重构 + 文件气泡重排 + 拖窗卡顿根修）

**376px 实测第 5 批：聊天输入框重构（附件/发送内联两侧、删表情、长文本自动增高到 5 行封顶）、文件气泡重排 376 不再挤、紧凑头再收窄 + 返回钮放大；工作流工具栏合并一行 + 看板卡自动换行 + 拓扑返回上提；产物项目拓扑固定屏宽；团队管理弹窗内容贴宽 + tab 条吸顶；主页 7 卡窄屏双列；拖窗口卡顿根因修复**

- **聊天**：输入框行重构——**附件按钮在左、发送按钮内联到输入框右侧**，**表情按钮删除**；输入框上方的小横条（原手动拖高把手）删除，长文本**随内容自动增高、最多 5 行封顶**（不再手动拖）。文件气泡重排为两行——名称行（图标 + 文件名完整换行 + 尺寸）与操作行（下载/查看右对齐），376px 宽度不再挤成一团。竖屏头部再收窄、内容**纵向居中**、**返回按钮放大适配触屏**（约 40px 触区）。
- **工作流**：工具栏合并为一行——「项目 (xx)」选择器与**排序、刷新**按钮同排；拓扑视图的「返回」按钮移到**排序按钮左侧**（旧位置占用一行标题的空间）；标题容器不再透明（向下滚动不再与内容重叠）；项目看板卡内 worker 标签**自动换行**，不再撑破项目卡片容器；任务详情的 worker 显示**短名**（如 @tech-writer，不再跟一长串地址）。
- **产物**：项目产物下的项目拓扑容器**固定为屏幕宽度**（此前每列过宽），超出的文字自动换行。
- **团队管理**：运行配置 / 资源管理做成**竖屏友好弹窗**——内部容器贴紧弹窗宽度，表单项窄屏自动变单列，**顶部标签条吸顶、下方设置内容独立滚动**且贴近弹窗宽度。
- **主页**：7 个快捷卡窄屏**双列等宽**排列（不再拉伸不均），屏幕侧左右外边距收窄。
- **性能**：**拖窗口卡顿根因修复**——此前拖动窗口每变化 1px 整页重算重渲，现在像素只记录不触发重渲、只在跨窄/宽屏阈值瞬间重渲一次，拖窗全程页面保持流畅。

**验证**：tsc 0 · vite build 单文件（468 模块）· 敏感扫 0

---

## 0.5.0-beta.15.8（2026-10-12 · 竖屏第 4 批：各页布局收窄 + 按钮内联 + 卡片不溢出）

**376px 实测第 4 批逐页精修——聊天输入框按钮内联/群名换行/置底按钮恒圆，工作流删标题/排序刷新贴两边/看板两列三卡/卡不溢出/拓扑返回并入标题/worker 短名，产物类型移图标下/操作列纵向，团队管理弹窗内容贴宽**

- **聊天**：输入框下方表情/附件/发送按钮**内联到输入框同一行**（发送紧贴输入框右侧、更矮，宽屏不变）；成员 @tag 栏删「点击成员插入 @点名」提示 + 防纵向拉长；置底按钮改纯圆形（窄屏不再被拉成竖条）；竖屏聊天头部再收窄 + 群名自动换行（长群名完整显示不截断）
- **工作流**：删「工作流」标题（顶部 tab 已有）；排序 + 刷新两按钮贴工具行左右两边；窄屏看板恢复两列 + 每列最多约 3 张卡、超出列内纵向滚动；看板卡不再撑破列宽（长串自动收缩换行）；拓扑图返回按钮并入下方标题栏（删上方重复标题，省纵向空间）；任务详情 worker 显示短名（如 @tech-writer，不再跟一长串地址）
- **产物**：窄屏文件列表把「类型」移到文件图标正下方（省横向，文件名换行更少）；「查看/下载」操作按钮窄屏纵向排列
- **团队管理**：运行配置 / 资源管理弹窗内部容器收紧贴弹窗宽度（两侧不再留大缝），顶部标签窄屏自动横向滚动
- **验证**：tsc 0 · vite build 单文件（468 模块）· 敏感扫 0 · 5 提交（8a6c850/b0b71ba/661d2d0/260e4d6）

---

## 0.5.0-beta.15.7（2026-10-12 · 竖屏工作流集群 + 小件精修 + 拖窗初修）

**竖屏下工作流整页重做（项目列表卡片化 + 看板两列 + 拓扑图手势缩放 + worker 详情弹窗）+ 一批竖屏小件精修 + 拖窗口布局响应初修**

- **竖屏工作流**：项目列表卡片化（窄屏可完整点选）；看板恢复两列布局；拓扑图支持**双指捏合缩放**，节点卡长文本自动换行；worker 详情改弹窗呈现（竖屏不再挤）。
- **竖屏小件**：顶部 tab 栏收窄；聊天输入框降高；@mention 候选弹层限高（长列表不再顶飞）；产物表格列宽收窄。
- **性能（初修）**：拖窗口时布局计算合并到每帧最多一次、子像素变化不再触发整页重渲——窗口拖动响应明显变跟手（彻底根修在 15.9）。

**验证**：tsc 0 · vite build 单文件（468 模块）· 敏感扫 0

---

## 0.5.0-beta.15.6（2026-10-12 · 竖屏触屏打磨：drill-in + 热区 + 防溢出）

**窄屏页面 drill-in 交互（列表→详情 + 返回条）+ 触屏热区扩大 + 竖屏溢出修复，宽屏零回归**

- **窄屏 drill-in**：窄屏下「列表 → 点选 → 详情 + 返回条」的逐层进入方式在更多页面落地，详情页整宽呈现、返回一步到位。
- **触屏热区**：小按钮的点击热区扩大（手指点得中）。
- **防溢出**：一批竖屏横向溢出修复（内容不再顶出屏幕边缘）；宽屏布局零变化。

**验证**：tsc 0 · vite build 单文件（468 模块）· 敏感扫 0

---

## 0.5.0-beta.15.5（2026-10-12 · 竖屏浮层防溢出 + 触屏复制可达）

**竖屏下弹窗/抽屉不再横向溢出屏外（固定像素宽的 Modal/Drawer 自动收进视口）+ 触屏下代码块与会话气泡的复制按钮可达（不再 hover 才显）**

- **竖屏浮层防溢出**：一批弹窗/抽屉（新建网关、团队配置、文件预览、工作流详情等）写死了 420~780px 的宽度——在 390px 手机上会横向溢出、右半截顶到屏幕外看不全。现在给弹窗/抽屉加了「有效宽 = 设定宽与视口宽取小」的约束：手机上一律收进屏幕内（抽屉占满全宽、弹窗留 8px 边距），桌面宽屏完全不变（宽视口下取设定宽 = 原样）。对所有弹窗/抽屉通用，以后新增的自动生效
- **触屏复制可达**：代码块右上角 + 会话气泡里的「复制」按钮，原来是鼠标悬停才浮现——手机上没有「悬停」这个动作，按钮永远看不见也点不到。现在在纯触屏设备上这两个复制按钮常显，随时能点

**验证**：tsc 0 · vite build 单文件（0 import 语句 = 宿主 blob 安全）· pytest 374/374 · i18n 0 新增键 · 5 smoke 全过 · 敏感扫 0

---

## 0.5.0-beta.15.4（2026-10-12 · 竖屏判定统一 + 聊天紧凑头 + 触屏提示按下即关）

**竖屏判定一套统一（聊天单栏 ⇔ 团队卡片化永远同步）+ 竖屏聊天头部压成 1 行（次要控件进「⋯」菜单，把空间还给消息）+ 触屏提示「按下即关」**

- **竖屏判定统一**：以前聊天判「单栏/双栏」用一套逻辑，团队表卡片化/表格横滚渐隐各用另一套（基准还不一致）——出现「聊天已是单栏、团队表却没卡片化」的错位。现在抽成**全插件唯一判定源**（与聊天同源的容器可见宽 < 800），团队表、表格右缘渐隐、聊天全部共用它：聊天切单栏的瞬间，团队表同步变卡片、表格同步显横滚渐隐。以后要调判定，只改这一处
- **竖屏聊天紧凑头**：竖屏聊天头部原来把 房间名+成员数+阶段徽章+项目文件+搜索+⋯菜单+工具开关+成员头像条+发起任务 一排 6+ 个控件挤在一行——390px 下换 3~4 行，把看消息的地方挤得只剩一点点。现在竖屏头部压成 **1 行**：`← 返回 | 房间名(超长省略) | 阶段 | ⋯`，其余次要控件（成员/项目文件/搜索/工具开关/发起任务/重命名/静音/退出）全收进 **⋯ 菜单**（一屏可达）。桌面宽屏头部零改动
- **触屏提示「按下即关」**：以前触屏弹出的提示要「点别处**松手**」才关；现在手指**按到**别处那一刻就关，不等松手——更跟手

**验证**：tsc 0 · vite build 单文件（0 import 语句 = 宿主 blob 安全）· pytest 374/374 · i18n 1,425 键 0 缺 · 5 smoke 全过 · 敏感扫 0

---

## 0.5.0-beta.15.3（2026-10-11 · P1 竖屏精修批）

**竖屏可发现性：tab 栏横滚边缘渐隐（11 tab 窄屏不再「隐形」）+ 团队表窄屏卡片化 + 7 张横滚表右缘渐隐 + 头像菜单唯一右键独有功能（复制 MXID）并入 tap 面板**

- **tab 栏横滚渐隐**：390px 竖屏 11 个 tab 只装 ~4 个——可横滚但无视觉提示。mask-image 四态渐隐（两侧/仅左/仅右/无）由 scroll 事件驱动（scroll-driven animation iOS Safari 支持太晚，用兼容版）；切 tab 自动把目标 tab 滚入可见区（否则高亮在屏外像没选中）；底边线移到渐隐容器外防被 mask 淡掉
- **团队表卡片化**（<576px）：5 列表格在 390px 挤压不可读 → 每队一张卡（名+状态 / Leader+Worker 就绪数 / 成员 Tag 换行），数据层零改动纯渲染分支。核过其余「三表」：Worker=树形、会话=抽屉列表、运维=卡片网格——竖屏本就适配，不动
- **横滚表右缘渐隐**（7 张）：产物/CRD×3/文件预览/人员×2 的 scroll.x 表格在窄屏恒可横滚 → 右缘 16px 灰透明渐变提示「还有更多」（宽屏内容装得下不挂，无假报）
- **头像菜单触屏可用性收尾**：复制 MXID 原只在右键菜单（触屏无右键）→ 并入 tap 可达的快捷面板；其余操作（查看会话/@提及/Worker 配置/私聊）本就在 tap 面板，右键菜单在触屏成为桌面专属增强
- **工作流看板核验**：无拖拽交互（可排序列表非拖拽看板）——WCAG 2.5.7 天然通过，无需替代路径

**验证**：tsc 0 · vite build 单文件 1,795.03kB（gzip 501.31kB，0 import 语句 = 宿主 blob 安全）· pytest 374/374 · i18n 门 ✓ · 5 smoke 全过 · 敏感扫 0

---

## 0.5.0-beta.15.2（2026-10-11 · P0 触屏可达性批）

**触屏信息全可达：58 处 Tooltip 统一走 WbTooltip（触屏 tap 弹出、桌面 hover 不变）+ 高频操作 44px 触控目标 + 消息操作条触屏 tap 化 + 置底钮 safe-area 抬升**

- **WbTooltip 共享包装**：默认 trigger = hover+focus+click——纯触屏（手机/平板/触控笔电）tap 弹出提示，桌面 hover 路径零改动；包**可点按钮**的 6 处自动降级 tap=false（只留 hover+focus）：click 触发会与按钮自身 onClick 同刻双发，触屏 tap 会「执行动作+弹提示」变误触噪音
- **58 处迁移**（17 文件）：状态点/截断 ID/图标钮/模型判定/错误详情等信息型 Tooltip 全部触屏可达（WCAG 1.4.13）
- **44px 触控目标**（.wb-touch-lg，coarse 指针下伪元素扩区、视觉尺寸不变）：聊天发送钮 + 审批应用钮；密集表格行操作保 24px（WCAG 2.5.8 行内+间距豁免，扩了会互相叠压）
- **消息 hover 操作条触屏化**：纯触屏设备（hover:none）tap 消息行切换操作条；桌面鼠标路径零改动
- **safe-area**：聊天两处「置底/N 条新消息」浮动钮 bottom 改 `max(Npx, env(safe-area-inset-bottom))`——notch/手势条设备不再被遮挡
- **触屏 CSS 基建核验**（存量 13.x 已备，本批确认生效）：touch-action: manipulation / tap-highlight 透明 / 嵌套滚动 overscroll-behavior: contain / hover:none 下 hover-only 操作常显

**验证**：tsc 0 · vite build 单文件 1,789.98kB（gzip 499.92kB，0 import 语句）· pytest 374/374 · i18n 1,424 键 0 缺 0 重 · 5 smoke 全过 · 敏感扫 0

---

## 0.5.0-beta.15.1（2026-10-11 · 深色模式适配批）

**深色模式全面适配：首页快捷操作卡透黑 + 卡片微透（深色透黑）+ 全仓硬编码颜色审计——40 处分档、12 处黑透明文字与 9 处灰/黑透明底迁移到主题 token**

- **首页快捷操作卡（用户点名）**：深色档底色从「accent 10% + white」（暗页亮斑）改为 accent 对透明混色（黑底透出）、边框/标签/描述同步改亮向 accent 与次级文字 token
- **卡片微透**：cardBg 浅色档 72% 白（宿主米白底微透）、深色档 5% 白（#141414 黑底透出）——层次靠亮度差而非实色块
- **深色硬伤全清**：亮黄警告条（CRD/Worker 管理）与深琥珀文字、错误横幅（深红字 + 浅红边）、`#333` 近黑文字、`#f5f5f5` 实色底——深色档全部换半透明语义底 + 亮向语义色
- **主题 token 迁移**：12 处 `rgba(0,0,0,x)` 黑透明文字（审批卡/运行时配置/会话步骤行/门控卡）→ `textSecondary`；9 处 `rgba(0,0,0,x)` / `rgba(127,127,127,x)` 底与边框（代码块/诊断卡/进度槽/自检卡）→ `toolBg`/`hoverBg`/`border`
- **语义浅色底加深**：循环 chip（等待用户/进行中）、工作流暂停卡、env 提示条——深色档底色浓度 0.06–0.12 → 0.14–0.16

**验证**：tsc 0 · vite build 单文件 1,790.00kB（gzip 499.72kB，0 import 语句）· pytest 374/374 · 敏感扫 0（注释只写行为/设计/约束）

---

## 0.5.0-beta.15（2026-10-09 · 正式号）

**14.1–14.34 子批合并 release（低带宽全链性能 + 配置/凭证安全硬化 + 部署韧性 + SGLang 可观测 + 技术债清理；pytest 71→374）**

- **低带宽全链性能**：消息实时三件套（断流自愈 / 后台 tab 消息丢失根因修复）+ 外网断连根因（代理 4xx 语义 + 直拨族地址 failover）+ WAN 通用认证（地址级 Basic / API Key 覆盖）；系统性性能批（事件循环阻塞 / 串行往返 / 轮询退避 / 阻塞 DNS / 请求面收敛 / 轮询调度器 / 拨号闸门 / 失效策略分层）；低带宽批（初始 sync 载荷 −65%、消息零回拉、逐路径 bytes 计量、KB 读压缩 + 服务端预热）；controller 请求扇出治理（状态灯 25 路→1、项目工作流 36 路→1）；实测驱动深修（3D 图谱休眠 / 扫描全面增量 / GPU 特效安抚）
- **配置与凭证安全硬化**：凭证记忆 + 外网全族 + 0600 权限 + 本地卷 + 掩码（方案定稿）；**配置钉死**（写审计环 + 409 乐观锁 + 默认值防覆盖守卫——堵默认表单覆盖磁盘的洞）+ 读状态隔离（fresh/read-error 细分：瞬时读失败走 503 重试链、永不呈现默认表单）+ 原子写 + 备份自愈 + 按错误类型判存在 + 凭据自证；Console 会话自动重登（持久账密 + 三闸）；**「401 逼重填密码」根治**：L2「Controller projects」401 = token 路径结构 401（上游仅放行 level-2/3 账号），显形为琥珀预期态 + 明示「无需重新填写密码」——Basic 账密不再被误判为错
- **部署韧性与弱形态**：主题实时跟随 + 首帧一致（跟随 QwenPaw 2.2.2+ 配色）、认证语义 + token 验证韧性、半连通提示（Controller 通 + Matrix 未登录 = 可关闭 info 横幅）、embedded 部署文档入包、群内项目产物同源同速
- **SGLang 可观测**：卡自适应节奏（活跃 1s / 稳定 5s）+ 活动信号 + 双节奏标注 + 首页双胞胎卡补平 +「快照 N 秒前」改脉冲点（每收一帧亮一次）+ 每 DP rank 状态标签 + 吞吐行
- **功能补齐**：模型配置编辑/删除（对齐 dashboard）、工作流渐进落地 + 后台让权、宿主原生顶部通知、运行时提醒 8 面板、行内按钮统一
- **技术债与工程**：技术债体检批（router 域拆分 / 时间格式化收敛 / 死码清理）、版本考古注释清理 1,646→0、测试套件隔离（真实路径写盘洞封口）；pytest 71→**374**，i18n 1,376→**1,424** 键

**验证**：tsc 0 · vite build 单文件 1,785.44kB（gzip 498.14kB，0 import 语句 = 宿主 blob 安全）· pytest 374/374 · i18n 1,424 键 0 缺 0 重 0 空 · 敏感扫 0（commit message + 内容 diff + 全树含 dist 解码）

---

## 0.5.0-beta.14.34（2026-10-09 · 「401 逼重填密码」根治批——预期态显形 + 刷新可感知）

**14.33 批三件修复：① 设置页显示「固定外网 + 已保存」，但 401 逼着重填密码，而 controller 测试明明能连上——排查确认：basic 密码本身是好的（外网 18:40 重存后 7 条 URL 全 200），根因是自检 L2「Controller projects (L2)」恒 401 红叉——该检查走 Matrix token 路径，上游只放行 level-2/3 账号，level-1 管理员恒 401（与外网 Basic 账密无关），而 L1 管理员 token 权威源同刻 200（「controller 能连上」）；旧实现 L1 在 L2 之后探测、无法判预期态，红 ❌「HTTP 401」被读成「密码错」→ 反复重填。② SGLang 刷新感知仍差。③ 「快照 0 秒前」标签要删。本批三件根治：L2 预期态显形（L1 可用时该 401 是设计使然 → ⚠️ 琥珀 + 明示「与 Basic 账密无关，无需重填」）/ config/test 同组交叉核对（同族另一地址 200 可达时 401 行明示「更可能是隧道瞬断，不一定是密码错」）/ SGLang 双卡删 age 文字改脉冲点（每帧亮一次）+ 首页卡补状态标签与吞吐**

### 修复

- **selfcheck L2「401 逼重填密码」根治——预期态显形**：L1 管理员 token 探测提前到 L2 之前；L2 401 且 L1 权威源 200 时判**预期态**（`ok=True, warn=True`，前端 ⚠️ 琥珀而非 ❌ 红叉），detail/hint 点明「本账号为 level-1 管理员，属上游权限设计，与外网/内网 Basic 账密无关，无需重新填写密码」；无 L1 token 或 L1 token 失效时仍按真失败显红（不误判）。L2 整体不再被结构性 401 拖成 ❌
- **config/test 同组交叉核对**：同族另一地址 200 可达（同凭据）时，401 行 detail 追加「同组另一地址 200 可达（同凭据）——更可能是隧道/网关瞬时故障，不一定是密码错」。外网隧道瞬断时边缘网关可能直接 401，旧文案一律「凭据被网关拒绝」→ 用户重填密码白干
- **SGLang 双卡删「快照 N 秒前」+ 改脉冲点**：age 文字在 1s 轮询下恒显 0、无可感知性（用户点名删）→ 绿点每收到一帧负载快照亮一次（remount 重放 `wbSgTick` 动画，空闲数值不变时也看得见在刷）
- **首页「集群负载」卡补感知**：每 DP rank 补状态标签（空闲绿/排队橙/运行蓝，对齐 OpsPanel 卡）+ 吞吐行（tok/s，请求数不变时推理仍在全速跑的第二重信号；0 显「—」）+ 副标「自动刷新（活跃 1s / 稳定 5s）」
- i18n：删孤儿键「快照 N 秒前」、OpsPanel tooltip 换新文案、新增脉冲点提示键（中英）

### 测试

- 新增 `test_14_34_401_perception.py` 5 回归：L1 200+L2 401→预期态（含探测顺序 L1 先 + 显示顺序不变）/ 无 token 仍真失败 / L1 失效仍真失败 / config/test 同组 200 时 401 行追加隧道提示 / 全 401 不追加
- pytest 374 全绿；tsc 0；i18n 门 0 缺 0 重；poller 冒烟过

---

## 0.5.0-beta.14.33（2026-10-09 · 「首页 SGLang 卡补平」批——14.26 修复漏修的双胞胎卡）

**14.26 批修「SGLang 卡刷新感知差」时只修了运维面板那张卡（慢档 15s→5s + 「快照 N 秒前」新鲜度自证），首页的「集群负载」卡是同款双胞胎但同批漏修——慢档仍是 15s，且 state 里根本没有快照时间：空闲时整卡零变化信号（运行/排队冻结 + 无 age 计数），感知就是「不刷」。本批补平：慢档 15s→5s（OpsPanel 同款，14.26 已实证该参数单位是 decode 迭代数非秒，快照忙态 ≥1Hz、陈旧度 <1s，慢档才是真凶）+ 移植快照年龄自证（每轮必刷，独立于 diff 门——空闲时数字不变但「快照 N 秒前」在跳=链路活的证明）**

### 修复

- **首页 SGLang 卡慢档 15000ms → 5000ms**：与 OpsPanel 同名卡对齐（负载在变 1s 快档 / 连续 2 周期不变 5s 慢档），清除 14.26 漏修
- **首页 SGLang 卡移植「快照 N 秒前」新鲜度自证**：per-rank `snapshot_ts` 多 rank 取最新，每轮轮询必刷（独立于 setSglang diff 门，空闲时 age 持续跳动）；i18n 复用既有键（零新增）
- 清除 3 处与当前自适应逻辑矛盾的残留注释（恒定 5s 死逻辑说明 / 1s-15s 档描述）

### 测试

- pytest 369 全绿（真实 config 零触碰——14.32 哨兵同批验证中）；tsc 0；i18n 全覆盖（0 新增键）；敏感扫描 0

---

## 0.5.0-beta.14.32（2026-10-09 · 「测试套件隔离」批——pytest 真实路径写盘洞永久封口）

**10/9 16:39:49 实际事故：全量 pytest 门内 `test_update_config_address_mode`（无隔离直调 `update_config`）对真实 config 连写三次（wan→auto→auto），把用户「固定外网」静默打回 auto。本事故一并解释了 10/8 以来全部「没人动过又变回自动」的磁盘翻转：该测试自 14.1 起每次全量跑（含各测试门跑）都重写真实 config，而 pytest 进程日志被捕获、审计环随进程消失，主日志因此零痕迹（此前多轮误判为「另一会话/外部写入」）。结构性修复：conftest autouse 全量重定向 `_CONFIG_PATH` 到 tmp（与既有 KB 缓存隔离同款）+ session 哨兵（真实 config 文件全运行期 mtime+sha256 零变化，否则全量跑失败并指名事故）+ 肇事测试显式隔离。运行时行为零变化——本批纯测试面**

### 修复

- **conftest autouse `_isolate_real_config`**：所有测试统一把 `_SECRET_DIR`/`_CONFIG_DIR`/`_CONFIG_PATH` 重定向到本测 tmp——直调 `update_config`/`save_config`/HTTP PUT 的任何测试都不可能再碰到真实 secret 目录（个别测试可再覆盖，LIFO 后设生效）
- **session 哨兵 `_real_config_sentinel`**：session 启动快照真实 config 的 mtime+sha256，收尾比对——任何测试再写真实路径 → 整轮失败并指名文件（与 autouse 双保险：一个按路径挡，一个按结果挡）
- **`test_update_config_address_mode` 显式隔离**：肇事测试补上 tmp 重定向 + 事故注释（双保险 + 自文档）

### 测试

- pytest 369 全绿；全量跑前后真实 config 文件 sha256+mtime 逐位一致（外部独立验证，哨兵同判）——本批的门本身就是验证：14.31 批的门跑（16:39:49）正是肇事现场，本批同条件复跑零触碰

---

## 0.5.0-beta.14.31（2026-10-09 · 「fresh 误判洞」修复——14.30 判别器自身的挂载层免疫）

**10/9 16:15 实际故障：DD 重启后冷挂载窗口内首开设置页，再次出现「内外网=自动 + basic 密码要重填」的可编辑表单。14.30 的 fresh/read-error 判别器自身站在同一块不稳的地基上——`Path.exists()` 对「stat 不出来」的路径（EMFILE/EIO）也返回 False，挂载层瞬时故障被误判成「文件从未存在」→ `fresh` → GET 200 + 默认值表单（与 10/8 wipe 同链，入口换成 fresh 假身份）。本批按错误类型重做判别：只有 `FileNotFoundError` = 真不存在（fresh，首启放行不变）；其他任何 OSError = 存在性未知 → 一律 `read-error`（GET 503 + 前端重试链，挂载恢复即自愈）。顺带给默认值兜底加了一条带 errno 的日志（此前这类事件零留痕，排查全靠猜）**

### 修复

- **fresh 判别按错误类型重做（根因）**：`exists()` 布尔吞掉 OSError（CPython 官方语义 "doesn't exist **or can't be accessed**" → False）→ 改为显式 `stat()` 三态判别：成功=present、`FileNotFoundError`=absent（fresh）、其他 OSError=unknown（read-error）。unknown 永不当 absent 处理——「不知道在不在」≠「不在」
- **默认值兜底留痕**：进入默认值兜底（fresh/read-error）时记 WARNING（state+presence+errno）——10/9 16:15 这种事件从此有精确时间戳和 errno 可查，不再靠 mtime 倒推

### 测试

- +5 用例（stat/read/bak 全 EMFILE → read-error 非 fresh / EMFILE 下 GET 503 / 真不存在仍 fresh 不受误伤 / stat 正常但 read EMFILE 无备份 → read-error / EMFILE 后挂载恢复 → 下一次 load 自愈 ok+真实数据）；pytest 369 全绿；tsc 0；敏感扫描 0 新增

---

## 0.5.0-beta.14.30（2026-10-09 · 「默认值假成功」语义堵链批——配置误覆盖根因链封口）

**10/8「内外网变回自动 + 凭据全丢」wipe 根因链的最后封口：加载失败态细分 `fresh`（首启合法可填可存）/ `read-error`（文件在但瞬时读失败=假状态）；`read-error` 下 GET /config 返回 503（默认值永远进不了用户决策面）、保存 409（force_persist 也不豁免）；废除「保存不带修订号=跳过校验」的向后兼容（那是默认表单/脚本直调 API 覆盖磁盘的放行后门，首启不受影响）；顺带修掉一个潜伏缺陷——`load_config` 尾部无条件标 `ok` 把「已从备份恢复」标记抹掉，恢复横幅因此从未显形过；前端加载窗口内整个表单只读显形（与保存按钮禁用、后端 409 三层互备）**

### 修复

- **加载态语义细分（根因）**：原 `defaults-fallback` 把「首启无文件（合法初始态）」和「文件在但读失败（假状态）」混成一个值，前端无法区分「该填」还是「别动」。现细分：`fresh`=主文件从未存在→200+可保存（首写=创建）；`read-error`=文件存在但读失败→GET 503 进重试链，表单不可保存
- **GET /config read-error → 503**：此前瞬时读失败也 200 返回全默认值（假成功）——前端把默认态当成「已保存配置」，用户看到「内外网=自动、密码空」误以为丢了，保存即把默认值盖回磁盘（10/8 wipe 链的起点）。现 503 强制走重试链，重试全败显「加载失败」横幅
- **PUT /config 无修订号保存 → 409（文件存在时）**：此前「不传 config_rev=跳过校验（向后兼容）」允许默认表单/脚本/旧标签页直接覆盖磁盘文件——10/8 wipe 的放行后门。首启（磁盘无文件）放行正常保存
- **read-error 保存 → 409（force_persist 不豁免）**：「显式恢复」的语义是重建缺失文件；read-error 的文件很可能完好，拿默认值盖=wipe 链最后一步。损坏文件的恢复通道=配置导入（显式粘贴，自带备份回滚点）
- **update_config 纵深防线**：read-error 态任何调用路径落盘 → IOError 拒绝（不依赖 HTTP 层拦截）
- **恢复横幅从未显形（潜伏缺陷修复）**：`load_config` 尾部无条件置 `ok` 抹掉了 `restored-from-backup` 标记——「配置已从备份自动恢复，请核对」横幅条件永远不成立。现仅正常磁盘读路径标 `ok`
- **前端加载窗口表单锁**：config 未加载（加载窗口/失败）时整个设置表单 45% 透明+不可交互（横幅保留可点重试）——默认态表单不再呈现「密码框空着像要填」的误导观感；三层防线（表单锁/保存按钮禁用/后端 409）互备，任何一层失效其余仍拦住

### 测试

- 后端 +10 用例（fresh/read-error 状态细分×3、GET 503/fresh 200×2、PUT 409×3（read-error force 不豁免/无 rev 有文件/首启无 rev 放行）、带 rev 正常保存回归、config.py 层纵深拒绝）；14.27 语义变更测试 7 处按新语义重写（含「无 rev 向后兼容」测试反转为 409 断言）；pytest 364 全绿；tsc 0；敏感扫描 0 新增

---

## 0.5.0-beta.14.29（2026-10-09 · 「basic 密码要重新填 / 内外网变回自动」根治批）

**基本认证密码「装新版后要重新填」「切换固定内外网后凭据又没了」的机制根治：配置读取瞬时失败重试（挂载层抖动不再误判文件损坏→跑默认值）+ 防 wipe 守卫（单字段补丁不得抹掉它没碰的磁盘数据，10/8 wipe 机制封锁）+ 凭据存在态自证（设置页逐条显形「已存 / 只存了用户名 / 无」，「要不要重新填」一眼可判）**

### 修复

- **配置读取瞬时失败重试（根因）**：装插件触发 workspace 重载风暴时，NFS/FUSE 挂载层会瞬时返回空/截断内容——原逻辑单次读失败即判「文件损坏」→ 回退默认值（地址模式跳回 auto、地址凭据显示全丢），页面把默认值当成已保存配置显示。现读失败重试一次（0.25s）再判损坏，瞬时抖动不再误触发默认值回退
- **防 wipe 守卫（机制封锁）**：内存基线被瞬时读失败污染（误判损坏→默认值）时，一个单字段补丁（切地址模式 / 登录写会话）落盘 = 把磁盘上的地址列表与凭据整个抹掉（10/8 生产环境：lan→auto 静默改写、密码地址全丢且零日志）。落盘前对照磁盘实况兜底拦截——补丁未触碰、磁盘有值、合并结果会丢的键 → 拒绝落盘并显形报错，磁盘数据原样保留。显式恢复（force_persist）只豁免「默认值盖损坏文件」，不豁免「丢未触碰数据」
- **凭据存在态自证（credential_state）**：GET /config 新增逐条凭据有无标记（redact 前对原始态计算，不泄露值）——地址条目三态 `saved` / `username-only`（只存了用户名、密码缺失）/ `none`；设置页对 `username-only` 显形橙色告警。空白密码框不再「猜是不是丢了」：`saved`=留空即保持不变、`username-only`=真缺要补

### 测试

- 后端 +6 用例（瞬时读失败重试/持续失败仍回退/污染基线防 wipe 拦截/显式携带 family 允许覆盖/credential_state 三态判定/GET 暴露 credential_state）；pytest 354 全绿；tsc 0；i18n 1311 键 0 缺；敏感扫描 0

---

## 0.5.0-beta.14.28（2026-10-09 · 低带宽性能 P0/P1 批 + 代码注释治理）

**全量审计 P0/P1 落地：包体 -25%（WebGPU 死路径剔除）/ 侧栏审批徽标改订阅制（4 拨/分→1）/ 三处空转重渲加值门 / 三处内存泄漏堵口；14.27 复审两缺口补修（SGLang 快照年龄字段取错 / 损坏态恢复路径被拦）；密码字段显示语义（「已保存·留空保持不变」）；代码内版本考古注释全量清理（1646→0）**

### 修复

- **SGLang「快照 N 秒前」取错字段（14.27 补修）**：原取请求处理时刻（≈链路延迟，恒显 0 秒），快照真陈旧时反而掩盖——改取各 rank 真实快照发布时刻（旧版无字段时隐藏年龄）
- **损坏态配置「重新填写后保存」实际被拦（14.27 补修）**：健康横幅的第二条恢复路径被防呆守卫拦下（200 响应但未写盘，误以为已保存）——显式恢复通道：横幅警示下保存携带 force_persist，按钮改「保存（将用当前表单值重建配置文件）」
- **Basic 认证密码「记忆没了」显示语义**：密码安全起见永不回显，空白框≠没记住——改占位符「admin 密码（已保存 · 留空保持不变）」+ 说明行，消除装新版后误以为丢失
- **内存泄漏堵口 ×3**：头像缓存补 300 上限（长会话单调爬坡）；媒体 objectURL 超上限者引用计数、卸载归零才 revoke（原先不可回收 blob）；FilePreview 卸载回收 blob

### 变更

- **包体 -25%**：three 的 2.1MB WebGPU 死路径（3d-force-graph 传递依赖静态 import，插件只走 WebGL 分支）alias 替身剔除——gzip 661.8→497.7KB
- **侧栏审批徽标改订阅制**：真实取数由活跃消费方驱动（SSE 审批事件事件驱动、零额外拨号），图标为纯订阅者 + 60s 兜底（仅页面可见时）——4 拨/分→1 拨/分
- **三处空转重渲加值门**：① 登录态轮询改统一调度器（页面隐藏自动停 + 回前台补刷）+ 字段级值门（原先每 30s 无条件强制重渲主组件）② Worker 状态灯仅 running/时刻真变才更新 ③ SSE 消息帧仅会话抽屉打开时驱动刷新
- **频度降档**：会话抽屉兜底轮询 4s→10s（SSE 是主路）、3D 图谱可见性兜底复查 2s→5s
- **light 特效档**：1.2s 无限呼吸动画暂停（状态点仍可见，语义由颜色/Tooltip 承载）
- **代码注释治理**：移除全部逐版本 changelog 式注释（版本号前缀 / 任务编号 / 验收叙事，1646 行→0），只保留代码本身的「为什么」；变更史统一在 CHANGELOG 与 git 历史

### 测试

- 后端 +2 用例（显式恢复端点/单测）；pytest 348 全绿；tsc 0；i18n 1419 键 0 缺 0 重；敏感扫描 0；bundle gzip 497.7KB

---

## 0.5.0-beta.14.27（2026-10-09 · 配置钉死 + 原生顶部通知 + SGLang 实时性修正）

**三件生产环境反馈 + 配置写路径全量排查：10/8 生产环境「内外网固定变回自动、basic 登录状态没」第三次复发的处置=不再猜观感，穷举全部写路径落观测（谁改的，日志说了算）+ 并发写保护 + 默认值覆盖防呆 + 加载态显形；工具开关改走 QwenPaw 宿主原生顶部 toast（与技能变更同机制）；SGLang 卡 15s「假冻结」证实根因是前端慢档（服务端快照实测 ≥1Hz），慢档 15s→5s + 快照年龄自证**

### 修复

- **配置被静默改写（第三次复发，彻底钉死）**：生产环境排查发现 config.json 在无人操作时被改写（address_mode lan→auto，写路径零日志无从追凶）。本批四道防线：
  1. **写盘审计环**——每次真实写盘（保存/登录/自动重登/导入/自愈恢复）记来源 + 关键字段形态变化（秘密值永不入日志），设置页 GET /config 可见最近 20 条；再犯一次，日志即定凶
  2. **并发写保护（乐观锁）**——页面打开后配置被外部改动（另一 tab/手工编辑/导入/自愈）时保存返回 409，页面显性提示刷新重存，不再静默覆盖新值
  3. **默认值覆盖防呆**——配置主文件损坏且无备份时（后端在跑默认值），任何补丁写不再把全默认值落盘盖掉损坏现场
  4. **加载态显形**——设置页顶部横幅明示「主配置缺失/损坏，当前是默认值/已从备份恢复」，默认值与已保存配置不再混淆
- **Worker 工具开关 → QwenPaw 宿主原生顶部通知**：改工具/异步执行的成功与失败提示，从页面内横幅改为宿主级顶部 toast（与技能安装的「顶部弹窗」同一机制——同页挂载直接复用宿主 antd 通知上下文），失败文案与终态一致
- **SGLang 卡「~15s 才一帧」纠正**：上游源码分析 + 生产实测证明服务端负载快照忙态每秒多帧（空闲也持续保鲜，参数单位是 decode 迭代数而非秒）；「15s 一帧」的根因是插件空闲慢档 15s 本身。慢档 15s→5s（负载恢复最迟 5s 回 1s 实时档），卡片副标改「活跃 1s / 稳定 5s + 快照 N 秒前」——数字不变但秒数在跳 = 数据新鲜只是没变化，断流一眼可辨

### 变更

- 设置页保存请求携带配置修订号（旧版本插件向后兼容）
- GET /config 新增 `config_rev` / `config_health` 字段（诊断 + 前端横幅数据源）

### 测试

- 后端 +13 用例（写盘审计/防呆/乐观锁/健康态）；pytest 345 全绿；tsc 0；i18n 1416 键 0 缺；5 套前端 smoke 全过

---

## 0.5.0-beta.14.26（2026-10-09 · 生产反馈四件批：群内项目产物同源同速 + Console 会话自动重登 + 工具横幅终态一致 + SGLang 卡节奏标注）

**四件生产反馈，每件先归因再修（不逐个打补丁）：同端点不同策略 → 统一缓存层；会话只判死不重登 → 自动重登 + 透明重放；文案只按字段不按值 → 四分支纯函数；标注误导 → 双节奏标注**

- **群内项目文件面板与产物 tab 同源同速**——两处同一 `workflow?includeTasks` 端点，旧版策略分叉：产物 tab 懒加载 + 组件内缓存（点过的不再拉），群内面板却是每次开 Drawer 对当前房间全部项目逐个裸拉（零缓存层，关再开全量重拉）。修：`api.ts` 新增 `fetchProjectWorkflow`（`cachedRequest` 30s TTL + tag `project:{pid}`），两面板同用，30s 内零重复回源、在飞去重合并；手动刷新走 `invalidateTags` 显式失效必穿透。局部 `TaskDetail`/`WorkflowResponse` 提升为共享 `WorkflowTaskDetail`/`WorkflowDetailResponse`（组件渲染代码经别名零改动）。
- **Console 会话自动重登**——根因：Console 管理会话 cookie 有服务端 TTL，过期后旧版**只被动判死、无任何自动重登**，每次插件重载/会话过期必须手动重验证一次；而 admin 账密本就持久化在 `config.json`（600 权限）却从未用于自动恢复。修：`router.console_try_relogin`（持久账密 → Console `/session/login`，与 `/config/verify` 路径 A 同端点同语义）；gateway 透传 401 → 自动重登 + **透明重放本次请求**（调用方看到正常数据，无感）。防风暴三闸：60s 冷却窗 / asyncio.Lock 并发合并 / 400-401-403 凭据错即停（地址无关不逐地址空转）。新会话落盘 + 过期旗清零。「内外网固定变回自动」实查磁盘与 API 均完好（前端首载失败窗由 14.16 起的加载态三态 + 保存门控兜底）。
- **工具开关横幅与终态一致**——根因：toggle 成功文案只按 field 分支、不看 value——关工具仍显示「已启用」，开异步执行显示「已停用」（两字段文案还互相张冠李戴）。修：四分支纯函数 `toolToggleMessage`（`util.ts`，smoke 可测）+ 2 新 i18n 键。
- **SGLang 卡刷新观感**——链路实证无 bug（`/sglang/loads` 无前后端缓存、1s/15s 自适应档工作）；根因=**标注误导**：卡片标「自动刷新 1 秒」但数据源是 SGLang 侧负载快照发布（服务端默认 15s 一帧），数字冻结 14s 被误判卡死，手动刷新读的又是同一快照。修：副标改双节奏「自动刷新（1s/15s 自适应）· 数据快照 ~15s」+ tooltip 讲清数据节奏与调参入口（sglang 容器 `--load-snapshot-publish-interval`）。

**门**：pytest 332/332（+F2 5 例：透明重试/凭据错判死/无凭据不尝试/冷却窗抑制/并发合并）/ tsc 0 / i18n 1,411 键 0 缺 0 重 / 4 套 smoke 全绿（+toolToggle 4 断言）/ 敏感扫描 0。

## 0.5.0-beta.14.25（2026-10-09 · 技术债批：router 域拆分 + 时间格式化收敛 + 测试补齐）

**P0 技术债闭环——6833 行 router 单函数拆为 9 个域路由，行为零变更；时间格式化收敛到 5 个纯函数；两个零测试模块补 42 用例**

## ① build_router 按域拆分（router.py 6833 → 997 行）

背景：全量代码审计（P0）指出 `build_router` 是 5719 行单函数（~50 个嵌套 handler 捕获函数局部状态），任何修改都要在巨型函数内导航，是后续所有后端改动的主要成本。

修：按域拆为 9 个子路由模块（`agentteams_connector/routers/`）——status / teams / config / gateway / matrix / kb / live / approval（含 catch-all 代理尾段，装配最后）。`build_router` 退化为纯装配；可变共享状态（3 个 KB 缓存）由装配方创建、显式传参，不引入模块级可变全局。

零行为变更保证：handler 函数体逐字搬移（仅闭包引用改显式参数）；路由注册序与拆前完全一致（53 条路由表逐条 diff 零差异，含顺序）；全量测试 285 → 327 全绿（+42 新增）。

## ② 时间格式化收敛（10 处 → 5 个纯函数）

`util.ts` 新增 `formatTimeOfDay` / `formatDateTime` / `formatTimeOfDayNo12` / `formatDateShort` / `formatTimeShort` 五个纯函数，10 处散落的手写 `toLocale*`（6 个组件、6 种互不相同的 locale/options 组合）逐处收敛——各调用点 locale 与 options 精确保留，显示输出逐字节不变。WorkerChats 的 `formatTime`（含 Z 后缀 UTC 归一化 + 两级兜底）超出纯函数表达面，按约定保留原样。

## ③ 零测试模块补齐（+42 用例）

- `spawn_tree`（4 个纯函数，此前文件头声称「unit-tested」但无任何测试文件）：38 个表驱动用例——归一化 14 / 会话映射 6（含幂等）/ 角色推断 14（lead 优先于 critic 等优先级链）/ 场景 4。
- `bg_aggregator`（projects_workflow 与 worker_status 共用的后台 tick 调度器，零直连测试）：4 个并发语义用例——单飞不重入 / TTL 去重 + force 穿透 / 无循环静默跳过 / 单轮异常吞掉且复位。

## 门

pytest 327/327（285 基线 + 42 新）/ tsc 0 / i18n 1409 键 0 缺 0 重 0 空 / 敏感扫描 0 / 路由表 53/53 零 diff。

## 0.5.0-beta.14.24（2026-10-08 · 弱部署形态批：半连通提示 + embedded 部署文档）

**在 embedded all-in-one 独立节点（无宿主端口映射、无 Matrix 登录）实测暴露的「静默半连通」盲点——Controller 数据正常而聊天/通知/任务状态受限，此前首页零提示**

## ① 半连通 info 横幅（产品盲点修复）

现象（弱部署形态实测）：Controller 已连通（团队/工作流/Worker 数据全部正常）但 Matrix 未登录（聊天、通知、@提醒、任务状态同步不可用）——首页「Teams 0 rooms 0 unread + Worker 1 teams」混合显示，用户无从得知聊天侧为什么是空的。

修：首页顶部新增可关闭的 info 横幅（条件 = `/auth-status` 的 `matrix_token === "none"` 且 controller 可达），文案区分「数据正常」与「受限项」，附「登录」直达配置页。与既有的「Matrix 登录已失效（error）」「Higress 会话过期（warning）」两条横幅并列、互斥不冲突。关闭态持久化到 localStorage（登录态轮询会重拉数据，不持久化会每次重开打扰）。

## ② embedded all-in-one 部署形态文档（Controller 地址填法）

实测发现：`agentteams-embedded` all-in-one 镜像的 Controller API（容器 8090）**不映射宿主端口**——与生产形态（映射到宿主自选端口，如 6866）不同，插件无从「探测」，此前文档只覆盖生产形态。

修：`docs/12-config` 新增「Embedded all-in-one 部署形态」小节（中英）——同宿主机时取 controller 容器桥网 IP（`docker inspect` 一条命令）填 `http://<桥网IP>:8090`（IP 稳定、重启不丢）；跨主机则需部署侧加端口映射。token 获取路径与生产一致（容器内 `docker exec`，与端口无关）。

## 0.5.0-beta.14.23（2026-10-07 · 14.22 验收反馈批：凭证验证分离 + PATCH 代理透传 + KB 低带宽批量读压缩 + 服务端预热）

**14.22 验收反馈的系统修复——Higress 验证误报 token 错、工具写链路「修改失败：HTTP 405」、KB 外网冷路径慢**

## ① Higress / Controller 凭证验证分离（N1）

根因（源码级）：`verify-admin` 在分支前**无条件**解析 Controller token——
config 里 token 含非法字符时，点 Higress 验证（纯账密链路，路径 A）会被
token 错拦截，两套验证互相牵连。

修：token 解析移入路径 B 内部；路径 A 只验 Console 账密、路径 B 只验
Controller token。两验证器各自独立，一侧凭据错误不再误报另一侧。

## ② 工具写链路 405（N3，beta.12.3 潜伏）

根因（实证）：插件 catch-all 代理的 `methods` 漏了 **PATCH**——
Controller tools 端点恰为 `PATCH /workers/{name}/tools/{tool}`，两个写
入口（WorkerManage 工具 tab + 资源管理面板）全部 `Method Not Allowed`。
WAN 直连 Controller 实测 PUT 200 / PATCH 200，Caddy 与上游清白。

修：catch-all methods 增 PATCH（body 与 POST/PUT 同语义读取）；写路径
（POST/PUT/PATCH/DELETE）非 2xx 记 warning 留痕（方法 + 路径 + 上游状态
+ body 头 200B）——上游方法表不符从此一眼可辨。

## ③ KB 外网冷路径：批量读压缩 + 服务端预热（N2，K1/K2）

根因（实证）：WAN 冷路径 = 1 次 graph 批量读 ≤1.8MB 原文
（5M 带宽 ≈ 3–5s）；暖路径 SWR 8ms 已优。

修：
- **K1 批量读 gzip 信封**：批量读脚本输出升级为 `===GZB1===`
  gzip+base64 信封，1.8MB 原文过链路体积降约 5×；旧协议响应（无 magic
  前缀）原样透传、信封损坏安全回退逐文件路径；帧协议零改动。
- **K2 服务端预热**：`/kb/agents` 响应后后台预热 last-agent 的
  tree+graph（缺失/不在清单/异常均静默跳过，单飞保护）——外网打开
  知识库时缓存大概率已暖。
- 与既有客户端预热（探测成功后并行发，14.18）+ SWR 缓存叠加，
  外网冷路径收敛到秒级内。

## ④ 安全网扩展（13 覆盖点）

- **D4 运行时透传 A1–A7**：docker 主路径与 ctl 兜底路径的
  `runtime`/`runtimeDeprecated` 字段写语义（非空才写键/真值才写键/
  旧 Controller 键缺失而非 null/畸形条目安全跳过）、磁盘缓存命中原样
  透传、401 文案、兜底路径端点级透传。
- **凭据护栏 B1–B6**：`PUT /config` 保存前 400 拦截（类型不匹配=
  同缺口/显式清除 200 + 落盘降级/整单拒不落盘）、`credential_check`
  逐位置形态（str/basic/bearer）。
- 全部测试拨号点由假客户端拦截，零真实 HTTP。

---

## 0.5.0-beta.14.22（2026-10-07 · 14.21 验收反馈批：SGLang 活动信号 + 配置/凭据韧性 + KB 低带宽自适应 + 运行时提醒 8 面板 + 按钮对齐）

**14.21 验收反馈的系统修复——SGLang 吞吐 0 值误导、配置/凭据「已保存但未生效」、KB 外网加载慢、非 QwenPaw 运行时功能糊涂态、按钮观感不对齐**

## ① SGLang 吞吐 0 值语义 + 实时活动信号（F1）

根因（SGLang 源码确认）：`gen_throughput` 是上游 decode 窗口采样
（`metrics_reporter`：连续 30s 无 decode 即归零导出）——推理在跑（KV 仍
在变化）时卡片也可能显示 `0.0 tok/s`，单值误导。

修（OpsPanel SGLang 卡，前端自采样不依赖上游新字段）：
- **KV 活动信号**：前端相邻两次轮询比对 `num_used_tokens`，变化=推理在
  跑 → KV 行前置绿点 `●`（悬停说明「最近一次轮询 KV 占用有变化」）；
- **吞吐 0 值显形**：`0` 显示 `—` + 悬停说明「Decode 窗口采样：上游
  30s 无 decode 报 0，0 不代表空闲——看下方 KV 绿点」；有值照常
  `N tok/s`。
  两信号并显（吞吐=采样窗速率 / 活动=实时占用变化），不再单值误导。

## ② 配置「装完变自动」+ 凭据「已保存仍 401」（F2/F3 同源修复）

根因（安装层排除 + 代码侧两缺口确认）：
- 安装不碰 secret 目录、ZIP 无 config 模板、config 路径固定 → 安装层无
  覆盖；
- **缺口 A = 凭据静默降级**：`merge_address_entries` 在「用户选了覆盖
  凭据（basic/bearer）但凭据为空、且旧条目无同类型可继承凭据」时，落盘
  降级为**无凭据字符串条目**（网关恒 401）而保存响应仍报成功 →
  「显示已保存、实际没凭据」无痕；
- **缺口 B = 配置冷窗**：换容器/重装长窗 >15.5s 重试链 → 配置拉取失败
  → 前端整页落在**默认态**（模式=auto、密码空），用户把默认值当已保存值。

修（后端拦截 + 前端门控/回读校验，双向显形）：
- **保存前凭据意图检查**（`config.credential_gaps`）：选覆盖凭据但凭据空
  且无同类型旧凭据可继承 → `PUT /config` 直接 **400** 点名地址位置
  （「Controller 第 2 个地址选了 Basic 认证（用户名 testuser）但凭据为空…」），
  杜绝静默降级；类型不同（basic↔bearer）= 无字段可继承，同判缺口；
- **保存后回读校验**（`credential_check`）：保存响应带四类地址逐位置落盘
  形态（`str`=无凭据 / `basic` / `bearer`），前端与表单意图逐位置对表，
  不一致=当场警告列出异常位置（成功 toast 后紧跟）；
- **配置冷窗自恢复**：首载重试链失败后转低频后台自恢复（10s 间隔、至多
  6 次=60s），成功即落地回填；
- **未就绪禁止落盘**：配置未加载完成时，地址模式/特效三档的「变更即
  落盘」一键 PUT 全部门控（默认态的 `auto` 不再覆盖已保存模式）。

## ③ KB 外网加载慢——SWR TTL 随网路自适应（F4）

根因：KB 数据量本就小（全量 ~1MB），慢 = 外网 RTT × round-trips
（冷取多次）+ SWR TTL 固定 60s 不适配外网。

修（`kb_swr_ttl_for(address_mode)` 单点，5 处 SWR 消费点统一）：
- 外网（`address_mode=wan`）= **180s** 窗口内重复进知识库零后台拨号；
- 内网/自动档 = **60s**（14.11 基线，数据新鲜度优先）；
- 配置读 `load_config` 读缓存（零磁盘），异常回退内网值（TTL 非安全
  边界，降级无害）。

## ④ 运行时提醒配套（D4）——8 面板矩阵全落（F6）

非 QwenPaw 运行时对 QwenPaw 独有功能「提前禁用/隐藏 + 说清楚」，杜绝
「拨号失败 → 400/502/空白」糊涂态。新增共享判定 `isQwenpawOnlyDisabled`
（空值/qwenpaw 放行不误伤老 worker）+ 统一 `RuntimeNotice` 组件。8 面板：
| # | 面 | 行为 |
|---|---|---|
| 1 | 运行配置 | 既有 `spec.runtime=="qwenpaw"` 门 + 统一说明 |
| 2 | 审批四档 | 禁用卡 + 说明（对齐后端 400 语义，不拨号） |
| 3 | 频道配置 | 禁用页签 + 说明 |
| 4 | 技能 preload | 禁用开关 + 说明（分配层 CRD 视图照读） |
| 5 | 知识库文件 | 降级空态 + 说明（不发起文件/图谱拨号） |
| 6 | 会话窗（worker chats） | 隐藏入口 |
| 7 | 执行时间线（checkpoints） | 禁用入口 + 说明（不拨号） |
| 8 | legacy 实例（`runtimeDeprecated`） | 统一角标「Legacy · 建议升级 QwenPaw」 |

判据唯一来源 = controller API `spec.runtime` + `runtimeDeprecated`
（旧 controller 无字段 = undefined，降级为仅按 runtime 判定）。qwenpaw
路径零行为变化（回归门槛）。

## ⑤ 按钮对齐 QwenPaw 风格（F5）

宿主主题色已随 `ConfigProvider` 落到所有 antd Button（主色 #2563eb 等）；
不对齐的是 3 处手写 native `<button>`（重试/搜索×2，pill 圆角 16 + 自绘
hover 与宿主方形按钮不一致）。切换为 antd Button（继承主题 token，结构
与宿主同款）。

## ⑥ 工程规范

- 代码注释规范化：技术债（technical debt）相关表述统一为正式术语（4 处）；
- 提交正式化 + 脱敏（本批起严格执行；commit 不含内部标识/凭据）。

---

## 0.5.0-beta.14.21（2026-10-07 · 14.20 验收反馈批：工作流渐进落地 + 后台让权 + token 验证韧性 + 行内按钮统一）

**14.20 验收反馈的系统修复——工作流加载慢/与聊天争抢、Controller token 验证 500、行内按钮观感**

## ① 工作流「加载慢」+「加载时聊天也慢」（外网低带宽架构级修复）

根因（源码 + 实测确认）：
1. **整批落地空窗**：`projects-workflow` 聚合器一轮扫 36+ 项目，旧版
   `asyncio.gather` 等**全部**项目完成才一次性写快照——外网（5M WAN）首扫
   1-3 分钟，前端首载状态机在此期间 Spin 空转；
2. **执行中抢占**：后台扫描只在一轮**开始时**检查一次前台负载（inflight>12
   让权）；一轮可持续数十秒，期间用户切去聊天（房间消息单条 0.8-2.5MB），
   后台扇出与前台**共用同一个全局拨号闸（cap 24）+ 同一条 WAN 上行** →
   聊天明显变慢。

修（`projects_workflow.py` 单点）：
- **渐进落地**：项目名单一成功立即写快照（前端首屏只等 1 次 `/projects`
  往返，不再等全量 workflow）；逐项目 `/workflow` 完成即写，谁先完成谁先
  落地，前端 15s 轮询逐步看见（首屏秒级、渐进填满）；单项目失败保旧值、
  收尾清理消失项目——保旧/单飞语义不变；
- **执行中持续让权**：每项拨号前检查全局 async inflight，前台忙（>8）则
  每 0.5s 复检退避、单项最多让 10s（前台闲下来立即继续，预算耗尽不饿死）
  ——后台扫描礼让前台交互成为常态语义。

## ② Controller token 验证 HTTP 500（外网网关瞬时错的误诊 + 韧性）

实测：LAN 活地址 `GET /api/v1/teams`（Bearer JWT）= 200 <1s；外网路径
（Higress 网关 → Controller）偶发 500 = 网关/上游瞬时错（**非 token 问题**）。
旧版把任何非 200 一律报「token 无效」且 3s 超时（5M WAN 偏紧）→ 真 500 被
误诊为凭据错、慢验证「一直转圈要刷新」。

修（`verify-admin` 路径 B）：
- 5xx = 网关/上游瞬时 → 退避 1s **重试一次**（同一活地址再探）；
- 4xx = 凭据/权限（地址无关）→ 立即报「token 无效或凭据错误」，不重试；
- 超时/连接错 = 地址级 → 换下一地址，不重试；
- 超时 3s→5s（WAN 活地址 <1s，给瞬时抖动留余量）；
- **透出 5xx body**：报「外网/网关异常（HTTP 500）：<真实 body>——瞬时的
  网关或上游错误，非 token 问题，请稍后重试或检查外网路径」。

## ③ 行内动作按钮统一（下载/查看等「糊弄感」治理）

根因：产物/消息文件卡/项目文件的「下载」「查看」等行内动作按钮是
`type="text" size="small"` **纯图标**（几乎不可见、无文字），各组件各写
各的（字号 11/padding 各异）。

修：新增统一组件 `ActionBtn`（图标 + 文字标签 + small 可见边框，href/
download/onClick/直链鉴权 blob 下载全支持）；产物表（查看+下载）、消息
文件卡（下载+查看）、项目文件（下载）切换统一规格；操作列宽随文字
自适应。**刷新类（Reload）纯图标按钮保留**（通用交互约定 + Tooltip，
观感合理）。

---

## 0.5.0-beta.14.20（2026-10-07 · 14.19 验收反馈批：主题首帧一致 + 聚合图谱竞态 + 慢路径系统提速 + L2 门控）

**14.19 验收 8 项反馈的系统修复——每项先归因后落点，无点补丁**

## ① 顶部版本号未更新（14.19 验收显示 14.18）

根因：14.19 release 提交（`208d36c`）漏了 `frontend/package.json` 的 bump——dist 构建时
`__PLUGIN_VERSION__` 注入读的是 package.json，于是 14.19 包里显示 14.18。
修：bump 补提交（`8aa2ff4`）+ 本版本 14.20 双载体（plugin.json + package.json）同 bump。

## ② 知识库「团队聚合图谱」首载出非所选团队 worker（问题已久的竞态，三连环）

根因（源码级，与 14.18 修「agent 下拉错列全集群」同族、不同调用点）：
1. `loadMerged` 在团队结构（kbTeams）未落地时若被触发，`team=undefined → agents=""`
   → 后端 `agents` 缺省语义=**全集群**（router.py `kb_graph_merged`：空→`_kb_all_agents`）
   → 返回任意 8 个 agent 的图谱；
2. 触发点=refreshTick（SSE 事件）effect **无 teams 就绪门**——集群活跃时 SSE 秒级到达，
   与慢速 teams 拉取（5M 外网）形成竞态窗口；
3. 错误响应落地后，`!mergedGraph` 守卫**永久挡住**正确范围的重拉——只有切 tab 重挂
   组件复位（=用户看到的「切 tab 才正常」）。

修（单点语义：显示范围恒=所选团队；宁空勿错，与 14.18 scopedAgents 同款语义）：
- `loadMerged`：agents 为空 → 不落请求（清空态返回）——无参拉取从根上不可达；
- 新增 `mergedForRef`（已落地范围）+ `mergedGenRef`（单飞代际）：范围不一致即自愈重拉；
  切团队秒切时旧请求晚到被代际丢弃；
- refreshTick effect 补 teams 就绪门 + **30s 节流**（聚合图后端有 30s SWR 门，
  旧版逐 SSE tick 重拉=新对象引用→GraphCanvas 全量重布局——「加载慢」的持续观感之一）。

**加载慢的边界（诚实说明）**：聚合图谱首载=所选团队各 worker KB 图谱的本地冷计算
（14.19 起 to_thread 并发，semaphore 4）；此后 30s SWR + 磁盘缓存命中即快。
冷计算是本地 CPU/IO 成本，非网络往返——本批消除了「错图重拉」与「逐 tick 重布局」
两个可修因素，冷计算基线保留。

## ③ 保存配置 / 连通性测试又慢（5M 外网线）

归因（实测预算）：探测 timeout 4s × 失败重试 1 次 = **死地址单程 8s**（外网线拨
LAN 死地址=必然超时）。可达地址 <1s 不受影响——慢的全部成本在死地址上。

修（单点 `_probe_with_retry`，四族地址同收）：
- **超时烧满（≥80% 预算）= 确定性死地址 → 不重试**（后台自适应重测负责捡回恢复；
  快失败——拒连/DNS——仍重试，14.12「连通失败重试」的瞬断语义保留）；
- 默认 timeout 4→3s。
死地址单程成本 8s→3s（-63%）；连通性测试最坏墙钟 8.3s→~3s。
回归测试 6 条（tests/test_probe_retry_14_20.py）。

## ④ Controller token 验证「一直转圈圈」

归因：verify-admin 路径 B 按**配置序** [LAN, WAN] 逐地址 8s 超时——外网场景先拨
必死的 LAN（8s）再拨活的 WAN（<1s）= 常态 ~8s+ 空转。

修：
- 新增 `_ordered_ctl_urls`：**working-cache（最后已知可达）前置**，其余原序；
  常态首槽即活地址 <1s 返回；
- 单地址超时 8→3s（最坏 2×8s→2×3s，且死地址不重试）。
回归测试 3 条（working-cache 前置 / 无缓存保序 / 缓存地址已删不注入幽灵）。

## ⑤ 内外网固定「每次打开就是自动模式」+ basic 账密重填

排查确认（本机全链实证）：持久化链 PUT→落盘→回读**完整可用**
（含掩码凭据的位置合并语义：空串/`****` 回传=继承旧值，config.py
`merge_address_entries` L137）——插件层无丢失路径。
用户机器上的症状（模式+账密**一起**回退=整个 PUT 结果丢失）指向插件外因素
（桌面版容器/卷生命周期、或保存静默失败）。插件层无法代查宿主卷，故做
**自验证 UI**：保存钮旁新增持久化自检行——「上次落盘 HH:MM:SS」（config 文件
mtime，后端 14.12 已返回、前端此前从未消费）+ 目录可写性（不可写=橙色告警）+
hover 显示 config 绝对路径。另：完整配置「导出/导入」（14.14）可一键备份/还原。
**用户判读指引**：保存后看自检行时间是否更新 → 重开插件再看模式是否仍在 →
若回退且时间未变=没保存成功（看橙色告警）；时间变了但重开回退=宿主卷被重建
（非插件问题，用导出/导入恢复）。

## ⑥ 主题色贯彻不彻底（「每个组件加载主题色的逻辑和时间不一样」）

根因（架构级）：宿主主题有两条供给链——CSS 变量（宿主 App.tsx 页面加载时写 :root，
**首帧即有**）与 `/config/theme` 网络端点（**要等往返**）。CSS 变量组件首帧即宿主色，
antd token 组件先闪默认橙（#FF7F16）再变宿主色——同屏组件上色时刻不同。

修（单一事实源优先）：`hostTheme.ts` 新增 `syncHostTheme()`——首渲染**同步读**
:root CSS 变量（模块级快照，宿主整页刷新才变）构造 antd token 主题；
`useHostTheme()` 初始态=同步主题（**首帧即宿主色，零闪动**），网络 fetch 降级为
补全（radius 等细节）与旧宿主（无变量）兜底。CSS 变量 accent 优先、fetch 细节合并。
theme.ts 气泡色等既有消费方零改动（自动吃到首帧同步值）。

## ⑦ 连通性测试 Higress 503 橙色提示撑破行

根因：`ConnRow` detail 文案 span `flexShrink: 0` + 无溢出控制——长诊断文案
（503 + 网关说明）把行撑出容器。修：detail span 改可收缩 + 省略号，全文走
hover title（与同 URL span 同款处理，单点一致）。

## ⑧ 模型页不应向 L2 提供

L2（无 Controller token）用户「模型」页全部请求注定失败——入口不该存在。
修：侧栏 tab 按钮 + rc-tabs items 双端按 `hasCtlToken` 过滤；兜底 effect——
记忆 tab=models 的 L2 用户在 config 落地后回首页（config ready 前不判，
避免 L1 用户 config 异步窗口内被误踢；hasCtlToken false→true 翻转语义
14.13 决定不变）。

## 机械收敛批（同包交付）

- 时间格式化 3 副本 → `util.formatChatTime`（7 调用点）；
- 字节 humanize 3 副本 → `util.formatSize`（KB 无空格形态为准）；
- 剪贴板片段 5 处 → `util.copyText`（回调形态，i18n 零新条目）；
- WorkerChats 4s poller 补 tab-active 门（切走即停）；
- 净 -43 行。TS 5.9.3 TS2774 编译器假阳性（函数引用真值判断+分支内普通调用）
  → `typeof` 守卫（最小复现矩阵在验证报告）。

## 门

tsc 0 / poller 冒烟 8 断言 / i18n 1395 键 0 缺 0 重 / pytest 211（+6 新回归）

## 0.5.0-beta.14.19（2026-10-07 · 登录态可观测 + 凭据存储方案定稿 + SGLang 卡自适应节奏 + 前后端深优批）

**14.18 验收反馈批：登录态/凭据生命周期可观测与定稿 + SGLang 负载卡刷新回归的系统修复（自适应节奏）+ 消息/审批/工作流 P0 批 + 前后端性能深优 + 死码治理完成**

## 登录态可观测：401/过期 token 检测 + 状态横幅 + `/auth-status`

行业对标（浏览器 401 重提示 / Matrix token 失效重认证流）：凭据失效不该静默——用户必须能看见「哪条腿断了」并重登。

- **token 过期/401 检测**：轮询/请求层捕获 401 → 登录态横幅（顶部，可关闭）+ 一键跳登录；不再「点了没反应」的静默失效
- **`/api/agentteams-proxy/auth-status`** 公开诊断端点：`{authenticated, mode, detail}`——验收/排障一 curl 确认登录态
- 会话与凭据分离语义固化：**会话**（Higress console_session，进程内/cookie，重启即失效）与**凭据**（basic 账密，持久化）两层分开显示、分开失效——对齐业界 session/credential 分离惯例

## 凭据存储方案（对齐业界成熟做法，深度调研后确定）

调研结论（浏览器 Basic Auth 惯例 / Matrix 访问令牌生命周期 / OS keystore 与 CLI 凭据存储实践）：

| 业界层 | 成熟做法 | 本插件落点 |
|---|---|---|
| 存储首选 | OS 原生 keystore（macOS Keychain / Windows Credential Manager / Linux Secret Service） | **不可达**：插件是宿主壳内 web 前端，宿主 API 面（React/antd/fetch/getApiToken 等）无 keystore 桥——已源码证实 |
| 存储 fallback | 配置文件 + **严格 0600 权限**（业界明确认可的次选标准） | **现行即此**：config.json 600（T5a 已落地 + 回归测试）；卷为本地容器卷，不同步出机 |
| 作用域 | 按地址（origin）隔离凭据 | 每地址条目独立账密（内网/外网各配各的） |
| 显示 | 永不明文回显（掩码 + 「留空=保持不变」） | 掩码显示 + 留空保留（保存不覆盖缺口已修） |
| 失效 | 401 → 重新认证提示 | 本次新增：检测 + 横幅 + 重登入口 |
| 传输 | Basic=Base64 非加密，必须 TLS | 外网走 Higress TLS；内网 LAN 明文（已文档标注取舍） |

**决定**：不引入 WebCrypto 加密（密钥无处安放——同文件=白加密，用户口令=运维插件 UX 反模式）；0600 + 本地卷 + 掩码 + 失效检测 = 无 keystore 桥条件下业界认可的最优组合。若宿主未来暴露 secret 存储 API，迁移成本=一处 read/write 修改点。

## SGLang 负载卡刷新回归的系统修复（自适应节奏）

反馈「SGLang 卡片刷新很慢几乎没有刷新」——根因两重：① 14.17 一刀切 1s→5s 恒定档（为省 5M 行拨号牺牲了仪表活性）② 14.19 初版 diff 门把「更新于」绑成「最后变化时间」，空闲时停摆=假死观感。

系统修复（业界监控采集通式——Prometheus 自适应 scrape / nvidia-smi 活跃采样）：

- **自适应节奏**：数据指纹变化（推理中）→ **1s 快档**（恢复 1s 时代实时感）；连续 2 周期不变（空闲）→ **15s 慢档**（空闲负载本无信息量，省 5M 行拨号）。指纹=归一化 JSON（剥离每帧服务端时钟）
- **「更新于」=最后检查时间**（监控卡活性证明，每检查必跳）——值没变时卡片照样证明自己在看
- **机制**：`createPoller` 新增动态 interval（getter 档，每轮实时读档位），冒烟 P8 覆盖切档语义；首页/OpsPanel 双卡同案
- 实测（本机实拨 `/sglang/loads`）：0.44s/次、负载值逐帧变化（推理中快档触发）、空闲稳定（慢档触发）

## 消息/审批/工作流 P0 批

- **消息渲染窗封顶 150**：长会话 DOM 重渲成本封顶（滚动加载补旧，视口感知不变）
- **审批队列单点缓存**：多面板共享一份轮询结果（原各拉各的）
- **工作流双 poller 合并**：同端点双轮询合一
- **凭据覆盖**：保存凭据的空值覆盖语义统一（留空=保持不变，全表单一致）

## 前端性能深优批

- **裸 `setInterval` 归 `usePoller`**（WorkerChannels 等最后一处）：全前端轮询统一门控体系（切走即停 + 可见性暂停 + 恢复补跑 + 失败退避 + 抖动）
- **theme 对象 memoize**（每渲染新建 → 复用）+ **逐字段比对复用**（全等不重渲）
- **groupTurns 重分组 memo**（result-only 轮次不再每轮 O(n) 重算）
- **合并窗/可见性门**：refreshTick 300ms 合并窗（全集群刷新去抖）、SSE 5 类事件 500ms 合并窗、重连调度可见性感知
- **WorkerRuntimeConfig 拆分 `runtimeCfg/`**（CfgRow/GateParam/GateSection/helpers，单体 -325 行）

## 后端性能批

- **KB tar 解析 `to_thread` 化**（大 KB 不再卡事件循环）
- **`load_config` 读缓存**（高频读路径去重 IO）
- **双聚合器骨架去克隆**（`BgTicker` 骨架 projects_workflow 切换完成，tick 生命周期统一）

## 死码治理 + 豁免治理

- 死码清理批：净删 327 行 + 67 处 export 剥离；预埋接口误删两起事故 → **`PREEMBED-EXEMPT.md` 机器可查豁免清单**落仓（死码审计派单前置检查项；【预埋，勿删】标记与清单双写）

---

## 0.5.0-beta.14.18（2026-10-06 · 主题实时跟随 + 外网凭据全族补齐 + 认证语义 + 首渲竞态）

**14.17 反馈批：主题色与宿主对齐（~99 处 accent 硬编码 CSS 变量化，刷新即一致）+ 外网路径 401 全族补齐（运行日志 502 根因）+ 认证语义拆分 + 知识库首渲竞态修复**

## 主题色与宿主对齐（反馈「插件不少东西没有跟着 QwenPaw 的主题色」）

根因（源码级）：全插件 ~99 处 accent 硬编码（hex/渐变/浅底）——宿主换主题色后，即使刷新页面这层也不变色（这才是「不少东西没跟着」的真身）。

- **accent 全面 CSS 变量化**：`var(--app-accent, #FF7F16)`（fallback 原值，旧宿主无变量时行为不变）；透明浅底 → `color-mix(in srgb, …)`（原 `${PRIMARY}14` hex-alpha 拼接在 var 下会产生非法 CSS，全部改 color-mix）
- **刷新对齐**（宿主实际行为「QwenPaw 好像没有自动刷新，是刷新页面才更新」）：插件与宿主对齐 = **页面加载读一次**，不做实时跟随/轮询——宿主仅刷新生效时（宿主部署行为），跟随逻辑会让插件先于宿主变色造成失配（比不跟随更糟）。宿主刷新时 App.tsx 把生效主题写 `:root` 变量（2.2.2b4 源码实证 `--app-accent` 等），插件页面重挂载自动继承新色——零 JS 重渲染、零轮询
- 保留不动：语义色（成功/错误/警告/灰）、状态灯、分类色板（角色/Agent/类别——换主色会撞色）、canvas/3D 与 SVG attribute 语境（var() 不支持）、antd Tag preset
- 效果：宿主换色后**刷新一次** → 全插件（含此前不跟的 ~99 处）与宿主一致；同页生命周期内与宿主行为完全同步

## 外网路径凭据全族补齐（反馈「运行日志 HTTP 502: Docker API 401」）

根因：`docker-logs` / 审批 exec / 房间列表三处拨号点漏在 14.3「地址覆盖凭据」修复面外——外网固定档（address_mode=wan）只发 Bearer，公网网关 Basic 门拒收 → 401 → 透传 502。

- 全仓 18+ controller/matrix/sglang/gateway 拨号点 **100% 统一走 `_headers_for`**（该地址配了覆盖凭据则替换 Authorization，未配则原样 Bearer）
- 实测：外网 controller 路径 basic-only → 200（修复前 401）；内网 Bearer 路径行为不变
- Higress 连通性测试 5xx 提示加方向：外网 console 多为隧道暴露，503 = 隧道活着但后端瞬断（内网建议地址模式 auto/内网）

## 配置页认证语义拆分（反馈「Higress 的认证和 controller token 认证应该分开吧」/「Matrix 登录和认证卡片是不是重复或者冲突」/「SGLang 要什么凭据」）

- 「认证与登录」卡内两块凭据拆成**视觉独立区**：① Controller 认证（管理面：CRD/全量视图/日志）② Higress Console 认证（模型面：alias/提供商/路由）——各带系统归属与"互不相关"说明
- Matrix 登录加一行关系说明：= AgentTeams 消息系统账号（与 Matrix 地址同一账号，L2 只读），与 QwenPaw 页面自身登录两回事、不冲突
- SGLang 凭据行加悬停说明：本地推理服务通常无认证，仅公网网关 Basic 门才填，默认留空
- 运维页「模型网关路由」卡移除——模型页已有同款「模型网关配置」（功能超集），重复视图删除

## 知识库首渲竞态（反馈「知识库是 sysdev-team，可一开始显示 daily-* 等本机 agent，切 tab 才正常」）

根因：初始探测（远端 worker 列表）在飞期间默认渲染"本机宿主 Agent"视图——首帧闪本机列表。现改：探测中一律 loading，探测结束才落远端/本机视图（手动切本机不受影响）。提示文案与实际权限对齐（L1 管理员见全部团队，L2 见自己团队）。

## 性能/调度全量测试（14.18 批）

- 45s 空闲稳态：**+8 拨号 / +8.4KB**（14.17 基线 +44 拨号；判据 <50/<50KB ✅）
- 并发闸 inflight 峰值 13/cap 24；审批扫 joined_rooms 30s TTL 缓存稳态零增量
- `/workers/*/chats` 4s = 会话面板打开时的主动刷新（关面板即停）——非泄漏
- 门：pytest 194/194、tsc 0、i18n 1384 键 0 缺 0 重、敏感 0、dist 2,372.58kB

## 0.5.0-beta.14.17（2026-10-06 · 凭据记忆 + Higress 连通性 + KB 冷时根治 + 低带宽性能批 4）

**凭据记忆重做（每个系统认证独立记忆）+ 连通性测试覆盖 Higress + 知识库冷加载根治（冷时实测 -64%~-78%）+  全量审计性能落码（稳态拨号再降，45s 基线 <50）**

## 凭据记忆重做（—— 反馈「输完 Higress 账号密码，控制器的 basic 认证又要重新输入」）

根因（源码级）：①脱敏 `***` 字面量回显进密码框——用户不清空直接输入 = 拼接串覆盖真凭据 ②回填 effect 依赖 config 引用，任意一次验证/保存/登录触发 config 刷新 → 未保存的表单草稿整体冲掉 ③controller_token 同款字面量回显。

- **空框=保持不变**：秘密字段永不预填（stored 标记 + 提交发 `***` 占位，后端 merge 继承旧值）；占位提示「已保存 · 留空保持不变」
- **显式清除=类型切回「服务自身认证」**（旧「选了类型但密码空=纯 URL」会把已存凭据误清除，已废）
- **回填冻结**：首载/换账号后初始化一次，之后 config 引用变化不再重置表单
- **六系统凭据状态总览卡**：Matrix 登录 / Controller token / Controller 地址凭据 / Higress 账号（Console 会话）/ Higress 地址凭据 / SGLang 地址凭据——绿/灰一眼可见
- 后端零改动（既有 merge 语义自洽，浏览器实测主保存不冲 auth）

## 连通性测试覆盖 Higress（—— 反馈「连通性测试也要测试 Higress」）

- `_probe_gateway`：可达性（GET /）+ **会话三态**（GET /v1/ai/routes：200=有效 / 401|403=已过期需重验 / 404=该版本不支持）
- 四地址族（matrix/controller/sglang/**gateway**）同层全并行——总时长=最慢单地址
- 前端：Higress 行（ok 时也显示 detail=会话态）+ **Higress 双地址各挂凭据编辑器**（四地址族凭据同构，公网入口挂 Basic/key 门时用，随保存落盘）
- 诊断面语义：不参与自动重排（Higress 生效地址由 verify 选定），后台 refresh 不传=零额外开销

## 知识库冷加载根治（K 批 —— 反馈「知识库加载能不能快一点」）

根因（实测）：冷时 tree 13.8–15.1s / graph 12.1s / merged 40.7s——**HTTP 往返次数**（非带宽；KB 数据本地，payload 几 KB~几十 KB）：graph compute 逐 md 文件单独请求（N 次）、tree 4–10 次探测、merged 零缓存。

- **K1 批量读**：`GET /kb/{agent}/files-batch`——单次 exec 分帧批量读（`===FRAME:<size>:<path>` 确定性边界，内容含标记串不串帧）
- **K2 tree 合并探测**：顶层/memory/digest/档案六文件 → 一次 exec `###SECTION:` 分段（原双通道逻辑保留为通道挂 fallback）
- **K3 merged 缓存**：30s TTL + 单飞（键=agent 集合）
- **K5 file 缓存**：30s TTL（文本类；二进制分支不缓存防放大）
- **冷时实测**（部署后 mv 清 kb-cache 首调）：tree 13.8–15.1s→**4.9–5.2s（-64%）**、graph 12.1s→**2.64s（-78%）**；二调 tree 5.8ms（磁盘缓存）/ graph 11.5ms / merged 8.3ms（内存命中，K3 实证）

## 低带宽性能批 4（P 批 ——  全量只读审计落码，逐个修补防护版）

 审计（15 发现，四面：端点缓存/组件渲染/45s 拨号预算/死代码）后按「先查证再动手」终审——3 项 P0 中 2 项被查证降级/改判（见「审计改判记录」），落码全为已实证根因：

- **/v1/loads 轮询 1s→5s**（HomePage+OpsPanel，快慢档合并）：前端最大可控频次，45s 稳态拨号主项（120×/36min→~30×）；5s 刷新对负载曲线仍属"活"
- **审批/＠ bootstrap 扫描缓存 10s→30s**（`_BOOTSTRAP_SCAN_TTL`）：10s TTL vs 15s 轮询=每轮必 miss 全房扫描；30s=半数命中（稳态全房扫描 4.5→~1.5 拨/45s）。**实时性零损失**——新审批/新 @ 走 sync_watcher 事件缓冲（零延迟），TTL 只管插件关闭期间的历史捞回粒度
- **messagesCache FIFO→真 LRU**：读命中刷新次序，热房不再因"插入早"被逐（13.10 全量历史语义不动）
- **媒体 objectURL 模块级缓存+去重**（同头像模式）：切房/滚动重挂不再逐条重拉 blob（300 条上限后只取不缓存）
- **member messages 页上限 10→5**：limit≤20 散在 500 条外=成员近乎沉默，省最坏 5×~250KB 上游拨号
- **i18n 门固化**（`scripts/i18n-gate.mjs`）：0 缺 0 重，排除 setStr 后缀误匹配（此前每批手打内联）

### 审计改判记录（判定 vs 查证终判——不逐个修补证据）

|  判定 | 查证终判 | 依据 |
|---|---|---|
| 「member/messages payload 无瘦身（全历史+全 content）」 | **改判：响应早已投影**（event_id/sender/body[:600]/ts 四字段），27.3MB 实为上游 /messages 翻页拨号（用户触发非常态）；仅落 maxPages 10→5 | router.py 端点体逐行查证 |
| 「后端 1s 单飞缓存」 | **降级 P2 不做**：前端 5s 后并发冷取场景基本消失，单飞机制收益≈0 | 频次推演 |
| 长房列表「P1 渲染面（虚拟化缺失）」 | **P2 暂缓**：实测 30 页（~550-1550 条）snapshot 1.2→1.8s 线性无拐点；真实使用上限≈1000 条；虚拟化与 loadMore 锚定/nearBottom/线程展开（13.14–13.19 五轮回归雷区）冲突 | 浏览器探针实测（TASK:jev-agentteams-research 36.5MB 房） |
| 死代码「fetchTeamsRooms / sendInboxNotify」 | **保留零删除**：两者均带【勿删/预埋】代码标注（排查工具/产物通知预埋），审计"候选"不覆盖显式 | 代码标注 + 方案 v5.29 |

## Verification

- pytest **194/194**（188 既有 +  KBBATCH 6 新）· tsc 0 · i18n 1378 键 0缺0重（固化门）
- 45s 拨号基线 +47（判据 <50 ✓；14.6 =+127）
- 敏感扫描 0
- KB 冷时对照表：已回填（tree -64% / graph -78% / merged 内存 ms 级）

---

## 0.5.0-beta.14.16（2026-10-06 · 反馈批 4 + 深度体检批 · 六修）

**配置记忆根治 / 设置页清理 / L2 门控 / 连通性提速 / 轮询调度修 bug / god-file 瘦身**

- **配置记忆根治（反馈）**：设置页「地址模式/凭据没有记忆」根因
  双修——① 首个 GET /config 失败被静默吞且零重试（装插件重载窗口/WAN 抖动
  命中）→ 3 次退避重试（1.5/4/10s）+ 进行锁；② 首载（null→payload）走高优先
  级落地，低优先 transition 只留静默刷新（修复被高优更新波抢占导致 state 不
  回填）。config 加载态三态化（loading/ready/failed）：加载中/失败横幅
  （含「显示的是默认值，勿直接保存以免覆盖」警示 + 重试钮），config 未就绪时
  保存钮禁用。E2E：真实配置回填全对；不改任何值直接保存 → 磁盘值不被覆盖。
- **设置页宿主 Agent 技能管理区块移除**：SkillsTab 组件（468 行）
  整块移除 + 16 个专属 i18n 键清理；旧「技能」tab 持久化态迁移落首页。
  SkillCenter 团队技能池不受影响。
- **L2 登录模式隐藏 L1 专属区**：Higress Console 地址卡与 SGLang
  「集群负载」卡（原注释标 L1-only 却恒渲染）按登录模式门控；L2 隐藏、
  已配置值持久化不丢。
- **连通性测试提速**：三类地址（matrix/controller/sglang）原三段
  串行 await（WAN 上每段吃满超时+重试≈12.5s，合计≈37.5s）→ 全并行
  （总时长=最慢单地址，≈8.3s）；timeout 默认 6→4s。逐地址语义/凭据/
  重试不变；3 条回归测试。
- **usePoller catch-up 失活门控（深度体检真 bug）**：窗口隐藏期间切走 tab
  → 恢复可见时失活 poller 仍补跑多余 fetch；onVisibility 加 isActive
  前置门（失活只恢复调度链不执行 fn）+ 冒烟断言 P7。
- **god-file 瘦身第一步（深度体检）**：SettingsTab 从 WorkbenchPage.tsx
  抽离独立模块（4813→3200 行；1430 行主体块与父提交逐字一致）；
  i18n DICT 孤立键 −57（全树字面量出现法，动态 tr 场景全保留）。
  纯结构动作，行为零变化。
- **全量自装自测**：11 tab 走查全绿（无 UI 错误）；45s 拨号增量 **+47**
  （14.6 峰值基线 +466/45s，−90%）；响应性 n=89 中位 5ms / max 20ms；
  配置权限 600；pytest 183/183。

## 0.5.0-beta.14.15（2026-10-06 · 全量自验 + 技术债体检批 · 两修）

**PawApp 入口死链修 / 死代码清扫 / 全量自装自测验证**

- **PawApp 入口死链修复**：web console 的 PawApp 加载器按 `plugin_type` 门控
  （`expectedType="app"`），本插件 manifest 含 `meta.tools` → 类型推断为 TOOL →
  直接打开 `/apps/agentteams-qwenpaw-workbench` 报 "PawApp frontend plugin not found"
  （2.2.2b4 实测复现，重试无效）。`meta.pawapp.entry_page` 改为指向全模式可用的
  `/plugin/agentteams-qwenpaw-workbench` 路由；`/apps/` 路由保留给 desktop PawApp
  宿主场景。index.tsx 入口文档同步标注该行为差异。
- **死代码清扫（二体检）**：删 `api.ts` 零引用导出 `fetchWorkerLoopStatus`
  （chat_id 变体——v13.6 起消费点已切 `fetchWorkerLoopStatusBySession`）；
  `sendInboxNotify` 经复查为**有意保留**（注释明示「预埋，勿删」，未来通知触发点入口）不删。
- **14.14 全量自装自测（ZIP 全新安装，生产部署）**：11 tab 走查全绿（首页/聊天/通知/
  工作流/产物/团队管理/知识库/自检/运维/模型/配置，无 console error）；45s 拨号增量
  稳态 +15 / UI 开启 +42（判据 <50 ✓，余量=worker-chats 头像灯 30s 轮询 + sync）；
  响应 max 16ms；KB SWR 缓存 6ms 命中；聚合端点 29 workers/36 projects 出数；
  持久化回读 + 600 权限 + 安装窗零插件 ERROR；pytest 180/180；已装 dist 与仓内逐字节一致。
- 门：tsc 0 · build ✓ · pytest 180/180 · i18n 1442 键 0缺0重。

## 0.5.0-beta.14.14（2026-10-06 · 反馈批 3 · 五修）

**特效跨页生效 / 配置备份导出导入 / KB 首访拖动顺滑 / 连点 Tab CPU −83% / 流式渲染 memo**

- **特效档位跨页生效**：此前档位同步只挂在工作台页——其他 console 页恒为 light（配置=off 也照跑），这是"控制没效果"的真身。现插件启动即拉取配置并**全页生效**（实测：off 档在 /chat 与插件页 动画 0/模糊 0；light 档保留动画+6px 模糊）。
- **配置备份 + 自愈 + 导出/导入**：保存自动写 config.bak.json；主配置缺失/损坏自动恢复；设置页新增「备份与恢复」——导出含凭据完整配置（复制保存）、导入粘贴恢复（先自动备份、拒收脱敏误贴）。一次导出=永别重填。
- **KB 首访拖动卡根治**：dist 级根因=3d-force-graph 引擎在装载后**逐帧 tick 160 帧**（约 2.7s，物理与拖拽同帧竞争）——"一开始卡、过一会/切走回来就顺"的精确机制。修=首帧前预收敛（warmup+alphaMin 调优）：实测引擎停时刻 3390→875ms、拖拽窗物理活动度 0.7→0.00； 暂停/恢复语义全保。
- **连点 Tab 边际 CPU −83%**：`useTabActive` 布尔快照（非本 tab 切换不再全量重渲）×4 面板 + `minPokeMs` poke 节流（半周期内不重复拉）+ 两面板 memo。实测边际 259→45ms/click（重序列）；并拆分证实剩余 ~50% 为宿主 app 底噪（上游议题）。
- **流式渲染 memo**：MdText/InlineMd/workerSessionState 值比较/RoomChat 子件 memo——流式期间已完成行不再逐 token 重解析重渲。
- 门：tsc 0 · build ✓ · pytest 180/180 · i18n 1442 键 0缺0重。

## 0.5.0-beta.14.13（2026-10-05 · 技术债治理批）

**插件全量技术债体检 + 治理：追踪面收敛 / 客户端去重 / 量化留档**

- **知识库切出卡顿根治**：3D 图「切走即停、显示即恢复」+ 修复恢复竞态（回访首帧 1.2-2s → 128-438ms）；团队页轮询加激活门控；6 处刷新 setState 进 startTransition。实测：KB→首页帧断 **66.7→16.8ms 恒定**、切走 GL 绘制 **2983→0/s**、切换窗 CPU 忙占比 71%→29%；工作流「双影」归因+两处样式修复。

- **追踪面**：误追踪的 harness 构建产物（bundle-1323/1324.js，可 esbuild 复现）已 untrack + 忽略（ZIP −~1MB）；
  `.gitignore` 策略补齐；根 ZIP/归档/版本残留扫描全净；零 `console.log/FIXME` 残留。
- **代码面**：`router._ctl_json` 与 `worker_status._ctl_get` 双份「ordered failover」合并为
  **`ctl_client.ctl_json` 单实现**（两处旧名保留薄包装——注入点/调用点零改动）。
- **留档**：`state/plugin-audit-20261005.md`（发现清单 + 处置 + 存量债量化：router.py 5,892 行/133 def、
  god 组件、下轮候选）。
- 门：pytest **170/170** · tsc 0 · i18n 1430。

## 0.5.0-beta.14.12（2026-10-05 · 可用性批）

**保存提速 / 后台让权 / 工作流首载修复 / 特效三档（轻量默认）/ 持久化硬化与诊断**

- **保存配置提速**：`PUT /config` 由「同步跑全地址探测」改为**后台探测**——实测 **4829ms → 百毫秒级**；保存失败明确报错（500 详情）；连通性测试仍为真实探测耗时（但不再卡保存）。
- **后台让权（bg_slot）**：worker 状态/项目工作流/KB 刷新共用后台通道（单飞 + 前台忙时跳过 + 90s 超时放弃）——周期扫描不再打满拨号闸门抢前台（dial-stats 曾实测 peak=cap=24）。
- **工作流首载状态机**：冷启动快照为空 → 「首次聚合中（自动刷新）…」+ 每 3s 自动重拉（≤180s，超时提示手动重试）；手动刷新带 `?refresh=1` 穿透缓存并触发后台补扫——修复「要过很久/刷新才正常」。
- **控制台特效三档（新，默认 light）**：**轻量＝动画全保留（旋转光环照转）+ 玻璃模糊半径封顶 6px（成本∝半径²，约降一个量级）+ 环境光钉静态**；关闭＝全停（最省电）；完整＝上游原样。设置页下拉、切换即自动保存。实测：light=光环运行+模糊 6px / off=全停 / full=原样。
- **持久化硬化 + 诊断**：配置写盘后**回读验证**（不一致即报错——"保存成功"以磁盘为准）；GET /config 增 `configPath/configSavedAt/configWritable`（「设置跳回默认」当场确诊）；新增 `/debug/tasks`（asyncio 任务清单，CPU 循环类定位）。
- 另：修复并发协作中一处 CSS 档位半迁移（fxMode 回填/保存补完）。
- 门：pytest **168/168** · tsc 0 · build ✓ · i18n 1430 键 0缺0重。

## 0.5.0-beta.14.11（2026-10-05 · 反馈批 2）

**模式自动保存 / KB 团队收敛 / KB 变才刷 / 玻璃模糊安抚 / RunningGlow 回归修复**

- **地址模式自动保存**：切换「固定内网/固定外网/自动」即落盘（此前只在点保存时持久化——用户看到"跳回自动"）。实测：UI 切「固定外网」→ 未点保存 → 配置即为 wan。
- **KB 变才刷（conditional revalidation）**：60s 后台刷新前先跑**轻探针**（只列目录条目元数据 name/mtime/size，不读文件内容）——签名一致 → 只重置时钟（**零深扫**）；变了才深扫。稳态 = 变才刷：实时性不变，容器读大降。
- **KB 团队收敛**：「聚合团队」选中后，Agent 下拉只列**该团队成员**（不再 mixed 全量）；当前 Agent 超出范围自动收敛到该团队 Leader/首个。
- **控制台玻璃模糊安抚（calm 扩展）**：sidebar sticky 分组头/浮动侧栏/头部等 17 处 `backdrop-filter` 模糊层在 calm 下停用——实测 console 页 blur 元素 **17+ → 0**。
- **回归修复**： 重写 calm 块时丢了 `[class*="RunningGlow-module"] *` 的 `*` 后代选择器（动画实际挂在无 class 的 span 上）——已恢复并实测每页动画复归 **0**。
- 门：pytest **155/155** · tsc 0 · i18n 1423 键 0缺0重。

## 0.5.0-beta.14.10（2026-10-05 · 反馈批）

**五反馈修复：地址凭据记忆 / KB 秒开（SWR）/ 组件日志倒序 / Tab 卡顿（memo+过渡）/ calm 生效确认**

- **地址凭据记忆**：配置回填此前只恢复 URL——basic/bearer 选择与账号密码丢失（被要求"再选一次再重填"）；现用 `entryToAuthDraft` 全量回填（密码以 *** 掩码回显，保存=保持不变）。
- **KB 秒开（SWR）**：冷读容器 3-17s → 磁盘持久缓存 + stale-while-revalidate：实测 **8ms 秒回**（cached/age 标记）+ 后台单飞刷新 + 启动预热上次 agent；重启/换页同样秒开。
- **组件日志**：最新在最上。
- **Tab 卡顿**：全仓面板 `React.memo`（此前零 memo，任何更新全量 reconcile 36K 行）+ 切换 `startTransition`（实测基线帧断 183-200ms 的目标）。
- **控制台特效节能**：用户确认有效（保留）。

## 0.5.0-beta.14.9（2026-10-05 · 扇出收敛批）

**controller 请求扇出治理（T9/）：状态灯 25 路/30s → 1 路；项目工作流 36 路 → 1 路**

- **Worker 状态聚合（T9）**：连接器侧后台 30s 单点扫描（29 worker 聚合缓存 + 单飞 + 保旧值），前端状态灯改单端点 `/workers-status`（原来每 30s 对全部 worker 逐一打 /chats、每窗口各一份）。实测：浏览器端 chats 请求 **25→0**。
- **项目工作流取数聚合**：连接器侧聚合 `/projects-workflow`（36 项目 workflow + 项目列表，缓存/后台刷/闸门；装配逻辑仍在前端、旧路径兜底）。实测：浏览器端逐项目 workflow 请求 **36→0**（单端点 1 路）。
- **首页产物延迟微调**：4s + 隐藏页不拉。
- （14.8 内容并入：控制台特效安抚、3D 图谱休眠、扫描增量、Tab 优雅化、Higress 归位——见下节。）

## 0.5.0-beta.14.8（2026-10-05 · 性能深修批）

**实测驱动全链深修：控制台特效安抚（GPU）/ 3D 图谱休眠 / 扫描全面增量 / Tab 优雅化 / Higress 地址归位**

- **控制台特效安抚（新设置项，默认开）**：上游 RunningGlow 光环（437×744 conic-gradient、4s 无限旋转——采样到连续旋转矩阵）与呼吸层停为静态动画，保留静态光效；设置页可切换。实测：控制台页面常驻动画 **2 → 0**。
- **3D 知识图谱休眠**：切换/隐藏时暂停渲染（`pauseAnimation` 门控 + IntersectionObserver/可见性兜底），实测隐藏态绘制调用 **2340 → 0 /s**、复返自动恢复。
- **扫描全量 → 增量**：@我/审批/工作流/产物四类扫描改「sync 事件探针 + 无变化零重扫」（600s 兜底全扫）；产物深扫实测 冷 ~37s → **增量 3.9s（-95%）**；首页产物卡改惰性拉取（不再卡装载窗口）。
- **Tab 切换优雅化**：切页轻过渡（仅 transform/opacity，170ms）；回访不闪骨架；知识库切换 **~2.1s → ~1.2s**。
- **Higress 地址归位**：Console 双址输入并入「地址配置」区（与 Matrix/Controller/SGLang 同处、带「当前」徽标）；地址模式固定档（固定内网/固定外网）覆盖 Higress。
- 另含 14.7 线全部内容（地址/凭据落盘 600、初始 sync -65%、消息零回拉、房间名缓存等，见下节）。

## 0.5.0-beta.14.7（2026-10-04/05 · 夜班批）

**低带宽性能批 3 + 安全硬化 + Higress 双地址——消息零回拉 / sync 载荷 -65% / 逐路径 bytes 计量 / 凭证落盘收紧**

- **消息面零回拉（T3+T4b）**：①「最近动态」改零拉取派生（直接消费服务端房间摘要 last_body/last_sender/last_ts，删除逐房全量重拉 effect——实测曾 45s +466 拨号 ≈10/s）②SSE room_message 帧携带最小载荷——**普通文本消息直接合并（活跃房零回拉）**，复杂消息保留 600ms 事件合并兜底 ③发送乐观回声（既有，保持）
- **传输层带宽瘦身（T4）**：①sync 载荷：timeline 10→2 + types 白名单——**初始 sync 实测 1426KB → 505KB（-65%）** ②`/messages` 过滤：代理层系统注入 + 连接器内部位点——**每页 5.2KB → 1KB** ③KB tree/graph 服务端 TTL 缓存（30s/60s）——重复访问**零容器读**（单次图谱构建曾逐文件 381 次 archive 读）
- **观测（.1）**：拨号计数新增 **bytes 计量**（总量 + 每路径字节，Top 100）
- **安全（T5a）**：config.json 含明文凭据且为 644 → **落盘 600 + 目录 700**；地址模式/地址级凭据持久化回归测试入档
- **Higress 内外网双地址（T5b）**：`gateway_admin_urls` 双址（legacy 单值迁移+镜像兼容）；verify/透传按序 failover；设置页双输入
- **测试工程**：conftest 通用清缓存；夜测工具 `tools/plugin-selftest.py`

**Verification**: pytest 135/135 · tsc 0 · node 冒烟 15 断言 · 初始 sync 实测 505KB · 45s 增量对表（14.6 闲时: +127 → 14.7: 夜测回填）

## 0.5.0-beta.14.6（2026-10-04 · 子批）

**性能批 2（系统性修复）——请求面收敛 / 轮询调度 / 拨号闸门 / 失效策略分层，全链路防回退**

- ** 统一请求缓存层**（`frontend/src/requestCache.ts`）：TTL + 在飞去重（同键并发合并为一次）+ tag 失效 + LRU（300 上限）+ force 旁路；15 个只读慢变端点接线（teams/structure、admin、workflow、projects、gateway、skills、kb、sglang、artifacts、spawns）；写路径（CRD/网关/技能/生命周期）后按 tag 失效
- ** 轮询统一调度器**（`usePoller`/`createPoller` + `tabActivity` 单源）：**17 处轮询迁移**——仅「活跃 tab + 页面可见」时触发（切走即停）、失败指数退避、恢复即补跑、防同步抖动；含 ops 页 1s 集群负载与组件日志轮询（WorkerChannels 原有门控件保留）
- ** 全局拨号闸门**（`agentteams_connector/dial_gate.py`）：**27 个异步拨号点全走 `GatedAsyncClient`**（含 `_h.` 别名形态）+ 7 个同步拨号点过 `sync_dial_slot`——「点开全部 tab」的并发不再叠乘（上限可配：异步默认 24 / 同步默认 8）
- ** 地址失效策略分层**：仅地址相关/瞬时错误（401/403/408/429/5xx/传输）换下一地址；**确定性 4xx（404/409…）不再跨址重试**——消除 spawns 409 类白跑
- ** spawns 修复**：`fetchWorkerSpawns` 带 `?team=`（跨团队歧义消歧，不再 409）+ 60s 缓存去重（多处调用合并一次）
- ** 频度治理**：team tab 强制刷新改 stale-first（30s 内免 force）；集群负载 1s 轮询改「可见+活跃」门控 + 慢响应自适应降频
- ** 拨号计数**（`GET /debug/dial-stats`）：总次数/在飞/峰值/路径 Top-20——修复验收与排障对账
- **防回退**：2 条静态护栏测试（禁止裸 `httpx.AsyncClient(`、同步位点必须带闸门）

**Verification**: pytest 124/124 · tsc 0 · node 冒烟 7+5 全绿 · build 2,359.90kB（gzip 657.78kB） · setInterval 残留=1（既有门控件） · 敏感扫 0 · 代码提交 `a449c2c`（后端）+ `ee3d9f7`（前端）

## 0.5.0-beta.14.5（2026-10-04 · 子批）

**性能批（事件循环阻塞 +  串行往返 +  轮询退避 +  阻塞 DNS）——插件不再冻结宿主；慢端点提速 5–7 倍**

- ** 五处裸同步调用全部 to_thread 化**（"点 tab 整页冻结"根因）：`/teams/rooms` 的 `joined_rooms`、`/dm` 的 `create_dm`、`/login`、selfcheck `run_l2` 两处调用点、L3/L4 五处（含 **45s 长轮询**）——实测事件循环最大停顿 **695ms → 21–49ms**
- ** 串行往返改并发 + TTL 缓存**：`approval/list` 全量串行遍历 ~31 容器 → `asyncio.gather`（并发上限 12）+ 20s TTL 缓存（`approval_set` 三处写路径主动失效）；实测 **23.5s → 4.21s（冷扫）/ 秒回（缓存命中）**。`teams/rooms` 单房两往返（成员+房名）并发：**11.3s → 3.56s**
- ** docker-logs 轮询退避**：连续失败 ≥3 次退避到 120s（恢复自动回 15s）；静默失败不再清屏（保留上次成功内容 + "更新于"看陈旧度）
- ** selfcheck 阻塞 DNS 修复**：`_resolve_ip_hint` 60s TTL 缓存 + `_attach`/`diagnose_target` to_thread 化（DNS 慢不再冻结）
- ** 核查（无改动）**：user_id 反推 homeserver 陷阱=无违规（18 处全走 `_pick_address/_ordered_addresses`）

**Verification**: pytest 116/116（113 基线 + 3 新护栏：并发生效/缓存命中/容错）· tsc 0 · vite build 单文件 ~2,356kB（gzip ~656kB，0 import）· i18n 1,417 键 0 缺 0 重 0 空 · 敏感扫 0 · 独立 AST 全扫「async 内直调阻塞」=0 残留 · standalone 实测（真配置 WAN、31 容器）：approval/list 4.21s/缓存 0.00s、teams/rooms 3.56s、冻结探针 21–49ms

## 0.5.0-beta.14.4（2026-10-04 · 子批）

**配色跟随 QwenPaw 主题色（2.2.2+ 新特性）/ 模型配置编辑与删除（对齐 dashboard）/ Controller 5xx 优雅降级 / 设置页 UI 整理**

- **配色跟随 QwenPaw（QwenPaw ≥2.2.2）**：
  ① **主色不再硬编码橙色**——插件 antd 主色（按钮/链接/选中态等全部 token）改从宿主生效主题读取（`GET /config/theme` 经宿主桥，自动带认证）：宿主用默认主题时表现与旧版一致（默认主色即橙 `#FF7F16`）；宿主主题色被自定义后插件整体跟随（accent / accent_hover / accent_bg / 圆角 radius 全映射）
  ② **深色模式独立跟随**——宿主深色主题色（`dark.accent` / `dark.accent_bg`）在插件深色模式下优先生效；聊天「自己的气泡」底色 = 主色浅底派生（浅色 8% / 深色 18% 透明度），同样跟随
  ③ **旧宿主零变化**——无 `/config/theme` 端点的旧版本（<2.2.2）静默回退内置默认，行为与旧版逐像素一致
- **模型配置编辑/删除（模型网关配置页，对齐 dashboard 模型管理面）**：
  ① **AI 路由 / LLM Provider 行内「编辑」**——Console 数据源下每行新增编辑按钮，弹窗按 Console 原始记录全字段预填（上游+权重+模型映射 / 请求模型匹配 / 认证与授权 consumer / 类型协议地址映射等），保存走 Higress Console `PUT /v1/ai/{routes,providers}/{name}`（与 dashboard 模型管理面同款端点与语义）
  ② **行内「删除」**——Popconfirm 二次确认，走同款 `DELETE` 端点；删除/保存成功自动刷新
  ③ **凭据保护（与 dashboard 同款）**——编辑提供商时令牌留空 = 保持现有凭据（不预填，避免把脱敏回显值写回）；编辑模式名称锁定（名称在 URL 路径上，不支持改名）
  ④ **提示文案按数据源区分**——Console 源 = 「添加/编辑/删除经 Console 会话透传（与 dashboard 同款端点）」；Controller 只读目录源 = 黄色提示「当前为只读——编辑/删除需管理员账号密码验证（Console 会话）后开放」（替换旧版「请用 Higress Console 或 dashboard」的墙式文案）
- **Controller 5xx 优雅降级（外网「日志 501」的插件侧体验修）**：模型网关配置页与运维页网关目录卡，Controller 返回 5xx（501=网关后端未配置 / 502=Console 不可达等）时不再显示原始错误噪音，改为可操作提示（「请检查 Controller 的网关后端配置（Higress Console 可达性与凭据），稍后重试」）。服务端 501 根因排查另行跟进（见上游 issue）
- **设置页 UI 整理**：长单栏改**分节卡片**——「聊天页面」（分栏开关+事件流连接态）/「访问地址」（Matrix/Controller 双地址+凭据+地址模式+连通性测试）/「认证与登录」（Controller 认证双模式+启动偏好）/「集群负载」（SGLang 模块）/「配置迁移与诊断」/「Matrix 登录」各自成卡，卡片底色与边框跟随宿主主题；说明文案收编 i18n（双语）；保存按钮独立一行

**Verification**: tsc 0 · vite build 单文件 ~2,354kB（gzip ~656kB）· pytest 113/113 · i18n 1,417 键 0 缺 0 重 0 空 · 敏感扫 0（源码与 dist 双查）

## 0.5.0-beta.14.3（2026-10-04 · 子批）

**WAN 通用认证（外网公网入口 401 根因的插件侧修复）：地址级覆盖凭据（Basic 门 / API key 门）+ 诊断五档 + 错误四档 + SGLang 外网接线**

- **地址级覆盖凭据（通用设计，内网零配置零行为变化）**：
  ① **地址条目 = URL 或 {url, auth?}**——设置页每条地址（Matrix 内/外、Controller 内/外、SGLang 内/外）下方新增「公网凭据」选择器：不使用（默认，服务自身认证）/ Basic 认证（公网网关 Basic 门，如 Caddy）/ API Key（Bearer，公网网关 key 门，如 Higress）。内网地址不填=纯 URL 字符串，配置形态与旧版逐字节兼容
  ② **首拨即用，无重试环**——有覆盖凭据的地址第一次请求就带对应 Authorization（Basic base64 / Bearer），不依赖 401 质询触发（确定性）；凭据只落本机 config.json，脱敏回显（***）、不进日志、不进前端明文
  ③ **单一出处拨号解析**——全部 20 处拨号点（代理 /sync / workers 族 / 知识库容器族 / SGLang / L1·L2 自检 / 管理员验证 / 宿主桥 / Matrix 用户态 API）统一走「地址 → 覆盖凭据 → headers」helper，新增拨号点不可能漏（逐个修补防护）
  ④ **凭据合并语义**——保存时按位置合并：留空/脱敏 *** = 保持已存值（改 URL 不清凭据、改 URL 类型不误清）；纯字符串提交 = 显式清除；类型选了但凭据缺 = 降级纯 URL（诚实不装）
- **诊断五档 + 错误四档（外网断连一眼定位）**：连通性测试 / 自检逐地址探测时——① 带该地址覆盖凭据探测（WAN 门地址带凭据才可能 200，自动重排才选得上，旧版不带凭据探测 → WAN 地址恒 401 永远轮不上生效）② 401/403 三看分诊：`WWW-Authenticate: Basic` = 网关 Basic 门（提示「设置页该地址填公网凭据」）/ 无质询 + 空 body = 网关 API key 门（提示填 API Key）/ 无质询 + JSON body = 服务层 token 被拒（检查 token）/ 403 = 权限不足；已配凭据仍被拒 → 直接点破「凭据不符」
- **SGLang 外网接线（Q4 入批）**：SGLang 双地址外网入口可配 API Key 覆盖（如 `https://higress.sat...:7113` 带 key）——创建 Worker 的在服模型列表 / 首页集群负载卡外网同样可拉；内网地址无凭据裸拨不变
- **行为变化说明**：`config.json` 的 `matrix_homeservers` / `controller_urls` / `sglang.urls` 条目升级为 `str | {url, auth?}`（旧纯字符串配置自动兼容，零迁移成本）；`/config/test` 请求条目同形态（草稿凭据未保存也能当场验证公网门）

**Verification**: tsc 0 · vite build 单文件 ~2,343kB（gzip ~653kB）· pytest 113/113（含新增 23 例：条目解析/凭据匹配/合并语义/脱敏/质询分诊/PUT 全链路）· i18n 1,393 键 0 缺 0 重 0 空 · 敏感扫 0（源码与 dist 双查）

## 0.5.0-beta.14.2（2026-10-03 · 子批）

**14.1 反馈四件：外网断连根因修复（代理 4xx 语义 + 直拨族地址 failover）/ 分栏判定计入话题面板 / 底部跟随 DOM 增高不丢 / 陈旧审批通知不再弹**

- **外网「controller 401、知识图谱 500、连不上」三根因全修**：
  ① **代理 4xx 不再污染生效地址**——catch-all 代理此前对任何 HTTP 响应（含 401）都标记「生效地址」，一次 401 即把死地址钉在 failover 链首位，切回内网后恒 401；现仅成功（<400）才标记
  ② **代理 GET/HEAD 遇 4xx/5xx 换下一地址**——外网入口若是网关代理（401=要会话）、直连控制器健康时，旧版永不 failover；现自动换地址，全败时返回首个非 2xx 响应（上游 401 诊断 body 保留）；写请求（POST/PUT/DELETE）遇 4xx 不试下一地址（不在另一地址重放写操作）
  ③ **直拨族全改 ordered 地址 failover**——知识库容器通道 / Controller JSON 通用调用 / 团队结构 workers 查询：旧版只拨单一地址（生效缓存或列表首个），4xx 立即返回；切网窗口恒 401 或卡满超时；现 200 即止、4xx/5xx/传输错换下一地址
  ④ **知识库 500 潜伏 bug 修复**——`/kb/agents` 的 Docker 降级路径误调审批兜底函数（引用了不存在的变量 → NameError → 500，Docker 通道 401/403/502 即触发，切外网后 WAN 链路首现），且返回形状与前端契约不符；改为控制器 workers 权威源 + KB 契约形状
- **分栏判定计入话题面板**：单/双栏判定此前不含话题（线程）面板占宽——开着话题把窗口拖窄，聊天区早已局促但判定不触发，要继续收窄才切单栏；现话题面板打开时其占宽（280–560，随拖拽实时）计入判定，可用宽 <800 即切单栏，关话题恢复
- **底部跟随不再丢**：跟随此前只在消息数变化时执行；图片加载 / 卡片 / 产物渲染后撑高时不触发，贴底用户看着内容把视口顶离底部；现滚动内容尺寸变化（ResizeObserver 观察内容行）+ 处于贴底态即自动跟随，上翻回看历史不受影响
- **陈旧审批通知不再弹**：审批已批完 / 超时结束后，打开聊天页仍会弹浏览器审批通知（通知对应的审批已不存在）——根因是「已见审批」记录只活在组件实例里，重开插件 / 换房间时历史审批全被当新到达；双保险修复：① 打开房间的首批历史只登记不通知 ② 真正新到达的审批，弹前查待审批权威源（实时缓冲 + 历史扫描），event 在列才弹，查询失败宁漏弹不弹陈旧；页内审批卡与通知中心不受影响

**Verification**: tsc 0 · vite build 单文件 ~2,337kB（gzip ~651kB）· pytest 90/90 · i18n 0 新增 · 敏感扫 0

## 0.5.0-beta.14.1（2026-10-03 · 子批）

**S1 聊天实时性三件套（「断流不自愈 / 后台 tab 新消息不出现」根因修复）+ 地址手动固定档（address_mode）**

- **聊天实时性（S1）**：三个根因全修：① **SSE 重连状态机**——退避封顶 60s 后不再永停（宿主重启/换容器/网络恢复即自愈，持续断连时 60s 轮询兜底并行）；401/403 会话失效不再永停，60s 周期继续探（重登后宿主 token 刷新，下次 connect 自动恢复）② **流看门狗**——后端每 15s 发「: keepalive」注释帧，45s 无任何字节（含 keepalive）判定 TCP 半死挂（NAT 超时/代理 idle-kill 未发 FIN）→ abort 走重连路径 ③ **可见性追平**——后台 tab 的 setInterval 被浏览器节流至 ≥60s，回前台/窗口聚焦立即拉一次消息 + 房间列表（3s 防抖防事件风暴）④ **重连追平**——watcher /sync 不回放断连期事件，断连 >5s 恢复瞬间立即拉活动房间消息 + 房间列表全量 ⑤ **设置页事件流连接态可见**——绿「已连接」/黄「已断开——自动重连中（上次断开 HH:MM:SS）」，S1 类排障一眼定位
- **地址手动固定档（address_mode）**：设置页新增三选一（自动=默认 / 固定内网 / 固定外网；列表顺序约定=[内网, 外网]；保存后不重启即生效）。固定档下请求只用固定地址（failover 链退化为单元素），失败明确报错「地址模式=固定内网/外网：失败不自动切换——请检查该链路或切回自动」，不静默 failover；后台探测循环照跑（连通性测试仍显示另一条路径的延迟，固定地址带蓝色「固定」徽标）；auto 档语义零变化（存量行为回归护栏）
- **行为变化说明**：`GET /config` 的 `effective` 回报三类地址由「cache 空=空串」改为「cache 优先、miss 回退首个地址」（auto 档更诚实；固定档回报固定值）

## 0.5.0-beta.14（2026-09-25 · 正式号）

**13.2–13.24 批次合并 release（聊天 / 会话 / 团队 / Worker / 工作流 / 技能 / 知识库全面改造 + 构建瘦身 −5.3MB）**

- **聊天 Element 化**：@mention 双向 Element 格式（发送 body 短名 + formatted_body matrix.to + m.mentions；接收整 MXID 与短名统一 pill——`_require_mention` 下 Worker 不再漏消息）；「加载原消息」Element 式滚顶自动续拉（链式分页无硬上限 + 锚保持 + 终止四条件）；历史预取管线（开房即后台预取下一页、命中零等待、加载提示几乎不可见）；消息跨房间修复；置底 Element 式锁定；ToolBubble 状态色 + 分区展开 + 代码块 hover 复制
- **会话与状态灯**：会话列表卡片化（整卡点开、状态点恒显）；会话窗 /sync→SSE 事件驱动实时（4s 降兜底）；**状态灯三落点**（idle 灰 / running 蓝呼吸 / done 绿：群内每条消息 Worker 头像右下角 + 成员头像条 + 团队管理成员列表）
- **团队管理**：首屏一次性就绪 + **首刷三层冷窗口根治**（structure 多地址 per-request failover + 探针 3s + connect 超时 3s + 首帧拆分——结构先到先渲染，子任务异步补齐）；房间列表 Element 化（SSE 增量，不再全量刷新）；侧栏角色筛选 chips（Leader/Worker/Manager，列表不分割）；**配置团队弹窗完整化**：subagentModel（留空=继承 Worker 主模型）+ 内嵌团队技能节（搜索/上传/新建/下载 + 分配矩阵 + MCP 卡）+ **批量设置模型（Leader / Workers 两批，单团队 scope，复用逐行 diff 保存链路）**
- **Worker**：per-worker 技能一等公民（物化层全字段 + 预加载小开关，热加载）；**工具执行安全四档卡**（审批数据面统一到 #1216 Controller 主路径，旧 Controller 404 自动回退、502-unparsable 回退，OFF capability 显形）；**运行配置六 tab，系统 tab 审批级别可编辑**（同源四档卡）；资源管理集成拓扑（技能两层/MCP/频道/工具一站式，单 Worker 免选）；spawn 树工具/技能白名单显示（#7004 消费侧）；心跳态显形（#1247）
- **工作流与看板**：看板 8 列等高（宽 4×2 / 窄 2×4，全实测高度）；拓扑优化（统计条 + 缩放 0.4–2.0 + 节点 subagent 行 + 点节点→任务巡检 + 左栏拖宽 220–520 持久化）；**DAG 与 Mermaid 合并为单一 DAG 视图**（层行水平居中 + 节点 hover 高亮；mermaid 依赖整体退役，单文件构建 7,624→**2,332kB**）；删团队撤销（快照重建，6s 撤销窗）
- **技能中心**：L2 双模式（Matrix 身份 team-scoped 可写本团队技能矩阵，L1 零变化）；上传（zip multipart 透传）/ 自定义新建（SKILL.md 在线打包）/ 下载（版本门 + 上游端点）；技能两层显示（分配层 / 物化层，绿/黄/灰）
- **知识库**：413 根因修复（整 workspace tar 上传列取→双通道 exec find 主 + tarball 回退，180/176 文件工作区 0.16–0.22s 全 200）；符号链接跟随；两栏等高 + 树独立滚动；2D 知识图谱高亮稳定（点节点看连接不再闪断）；**项目群↔项目三源关联**（workflow 权威源 ∪ `Project:` 命名 ∪ `TASK：<projectId>` 任务房）
- **其他**：Loop 设置 QwenPaw 对齐（4 模板 + doom loop 参数 + 记忆后端可编辑）；AgentActivityTrack 任务轨（项目名 + 状态 + done/total + 等待人工介入）；未读气泡自绘（数字居中 + 99+ + 白描边环）；图标库 70 枚全 SVG 化（UI emoji 清零，6 类保留）；宽窄屏双基准（窗口 ∩ 容器实测，ResizeObserver 跟随）
- **技术面**：群消息加载逻辑收敛进 `roomHistory.ts` 纯 TS 状态机（I1–I6 不变量成文）；UI harness 五套 25+ 例回归锚点；i18n 1,376 键中英镜像；单文件构建约束（0 import 语句，宿主 blob 安全）

**Verification**: tsc 0 · vite build 单文件 2,332kB（gzip 650kB）· pytest 71/71 · i18n 1,376 键 0 缺 0 重 0 空 · ui-harness-1324 20/20 · 敏感扫 0（全包全部文本条目）

---

- **文档 emoji → 纯文本（发后修）**：README + docs/ 的界面图标 emoji（🏠💬🔔🔀📦👷📚🧩🎯🔍🛠⚙✉ 等）全部移除、改纯文本标签——13.13 起图标库已全量 SVG 化（icons.tsx 71 枚），文档 emoji 与实际 UI 不符；CHANGELOG 历史条目保留 emoji→SVG 替换记录原文（那是历史陈述，不是当前描述）

## 0.5.0-beta.13.24（2026-09-25）

**13.23 反馈 6 件：团队管理首刷/手动刷新慢（根因=双地址冷窗口，全链修）/ 工具执行安全 502（上游缺 /api 前缀，插件回退缓解 + 上游修复支）/ 审批级别改可编辑（运行配置「系统」tab 内嵌审批控制）/ 未读气泡数字居中且永不含住外 / DAG 与 Mermaid 合并（撤 mermaid 依赖 −5.3MB，DAG 居中+hover 优化）/ 配置团队窗口批量改模型（Leader/Workers 两批）**

- **团队管理首刷不出 + 手动刷新也不行，要等一会（第三次复发的根因）**：
  连接器双地址（LAN IP 优先 + 公网域名）冷启动窗口——进程内存 `_working_cache` 每次容器重启（即每次装新 beta）清零，前 15s 探针延迟内请求全按配置顺序拨 LAN IP；非 LAN 网络下 LAN IP 的 SYN 被丢弃 → 每请求 +12.3s（6s 超时×2 重试）才 failover 公网；`/teams/structure` 更是**无 per-request failover**（单地址 10s 超时）。
  全链修：① structure 端点 controller 拨号改多地址 failover 循环（同 catch-all 代理语义）+ 成功即标记 working 地址 ② structure 的 matrix 回退同样多地址 failover + 30s 上限 ③ 全部 connect 超时 6s→3s（坏地址快速识破）④ 探针延迟 15s→3s（会话启动即收敛）⑤ 前端 `refreshTree` 拆分——structure 先到先渲染树，spawns（多项目扇出）异步合并不拖累首帧 ⑥ `requestJson` 支持 AbortController 超时，structure/admin 取数 30s 封顶。
- **工具执行安全「HTTP 502: worker returned an unparsable running config」（上游 bug  + 双端修）**：
  上游 Controller `worker_approval.go`（#1216）拨 QwenPaw 上游配置**漏 `/api` 前缀** → 命中 SPA catch-all 返回 200 + index.html → JSON 解析失败 → 502 unparsable（GET/PUT 同中）。
  插件侧：读/写回退条件 404 → **404 ∪ 502-unparsable**（旧端点继续可用，不阻塞）；L2 回退 401 时给精确提示。
  上游侧：`SC/AgentTeams` 新支 `fix/worker-approval-api-prefix`（2 行修复 + 单测，go 门绿）——重建 Controller（官方镜像）后主路径转正。
- **运行配置「审批级别」不再只读**：
  运行配置卡新增「系统」tab，内嵌与 Worker 管理/房间成员卡**同源的审批控制**（四档卡选择器 + 读/写双路径回退 + L1/L2 权限语义 + OFF capability 提示，全复用零新链路）；approval_level 经 WRC PUT 会被服务端 400 拒绝，改走审批端点，无双写。
- **未读消息气泡：数字居中 + 永不含住外**：
  团队总览群卡/私聊卡的 antd Badge 替换为自绘 `UnreadBubble`——flex 双轴居中、min-width 16/height 16/内边距 0 4、`>99` 显示 `99+`、1.5px 白描边环（卡片底色上对比清晰）。任何位数数字都完整可见且居中。
- **工作流拓扑 DAG 与 Mermaid 合并（「是差不多的东西，没必要分两个」）**：
  两图同构（Mermaid 视图=上游 `?format=mermaid` 快照渲染，**无交互**；DAG=自绘分层 SVG，**可点节点巡检**）→ 撤 Mermaid 视图与其依赖（mermaid 库，构建 **−5.3MB**，单文件 7,624→2,332kB），保 DAG 并优化：层行**水平居中**（原左对齐）、节点 **hover 高亮**（描边加粗）、节点 190×40→200×44。
- **配置团队窗口批量改模型（「leader/workers 两批，按团队改不是全改」）**：
  配置团队弹窗新增「批量设置模型」区（成员行上方）：Leader 批（team_leader 行）+ Workers 批（其余行），各一个模型选择框——刷值即同步到对应角色每一行，走**既有逐行 diff 保存链路**（PUT /workers 合并语义，只发改动，provider 不动，留空=不改）；打开弹窗时重置。
- **i18n**：1,376 键 0 缺 0 重 0 空

**验证**：tsc 0 · vite 单文件 2,332kB（gzip 650kB；0 import 语句=宿主 blob 安全）· pytest 71/71 · ui-harness-1324 20/20（气泡居中/零溢出/99+ · 无 Mermaid 残留 · 层行居中 · 节点 hover 加粗 · 批量刷值行内同步+diff 标+Workers 批独立 · 系统 tab 四档卡可编辑）· i18n 1,376 键 · 敏感扫 0（源码+dist 解码）

---

## 0.5.0-beta.13.23（2026-09-25）

**审批数据面统一到上游 #1216：L2 账号开放团队内读写 / OFF 权限（#1273）显形 / 编辑入口指引**

- **「工具执行安全」读写主路径切换（#1216，上游 9/16 已合并）**：
  审批级别读/写此前只走旧端点（docker 直读 agent.json / PUT running-config，需 L1 管理员 token，L2 恒 401）；现优先走 **Controller 审批端点**（`GET/PUT /api/v1/workers/{name}/approval`，catch-all 透传：admin token 在 = L1，空 = Matrix 凭据 = **L2 team-scoped 可读写本团队 Worker**）；旧 Controller（无 #1216）404 → 自动回退旧端点（L1-only），行为兼容。
- **删除过期权限文案**：旧提示「L2 账号无权限读取（需 L1 管理员凭据；上游 L2 写路径 PR 合并后自动开放）」的前提已不成立（#1216 已合并）→ 改为凭据/范围问题的准确提示。
- **OFF 权限显形（上游 #1273：approval_level=OFF 门控 approval_policy capability）**：
  四档卡下方新增静态提示——OFF 需 approval_policy 权限（L1 管理员固有；L2 需显式授权，无权限提交返回 403，错误详情透传显示）。
- **运行配置「系统（只读）」tab 指引**：approval_level 悬停提示补「编辑入口：Worker 管理展开行 / 房间成员卡的『工具执行安全』卡」。
- **i18n**：1,373 键 0 缺 0 重 0 空（+3 新增、1 过期键替换）

**验证**：tsc 0 · vite 单文件 7,624kB（gzip ~2,151kB；0 import 语句=宿主 blob 安全）· pytest 71/71 · ui-harness-1323 14/14（主路径读/回退读/权限文案/主路径写/回退写/OFF 403 透传/旧文案回归防）· i18n 1,373 键 · 敏感扫 0（源码+dist 解码）· 版本载体 10 文件

---

## 0.5.0-beta.13.22（2026-09-24）

**13.21 反馈（7 件）：团队技能团队隔离（目录/分配矩阵/MCP 只管本团队）/ Mermaid 并入拓扑依赖图（第 5 视图退役）/ 团队配置弹窗收起动画 / 2D 知识图谱选点持久 / 未读徽章挂卡片头像右上角 / 子代理默认模型同款选择框 / 私聊角色改下方筛选 chips**

- **团队技能节团队隔离（「团队技能（目录/分配矩阵/MCP）就只管这个团队的」）**：
  团队配置弹窗内嵌技能节的**分配矩阵**此前误用全量 Worker 列表——跨团队 Worker 泄漏进本团队矩阵；改为只渲染 `onlyTeam` 的 Worker（目录/上传/MCP 卡 13.21 已按团队 scope，本轮补矩阵最后一处泄漏）。
- **Mermaid 并入拓扑依赖图（「不需要新开第 5 项，把拓扑的依赖图优化就好」）**：
  13.21 的第五视图「Mermaid」退役——拓扑依赖图内加**图样式切换**：DAG（交互，节点点看任务详情）/ Mermaid（上游 `?format=mermaid` 快照直渲染，观感更优）；选择本地持久化；已持久化 `wfView="mermaid"` 的旧用户自动迁移到「拓扑」（体验不丢）。
- **团队配置弹窗收起动画**：此前只有弹出动画、收起瞬间消失；现收起走 antd 退出过渡（`afterClose` 才卸载，动画期间内容保持不闪空）。
- **2D 知识图谱选点持久（「点节点看连接只闪一下箭头」）**：
  根因=聚合（merged）模式传给图谱的 graph 对象每次 render 新建引用 → 选中态 effect 每次重渲染即清除（高亮闪一帧）；改为**仅当选中节点在新图中不存在时才清除**（切 Agent/重拉才清）；聚合 graph/图例同步 memo 化（毛球布局不再反复重算）。
- **未读徽章挂卡片头像右上角（「改到卡片左上角，或者房间卡片加个头像，放在头像的右上角」）**：
  群卡片新增头像，徽章挂头像右上角（Element 同款）；私聊卡片徽章同移；红=@我/提及、灰=普通未读；名称行内旧灰色胶囊退役（不再挤名字）。
- **子代理默认模型=与 Worker 选模型同款选择框（「来源一样」）**：
  裸 Input → AutoComplete——同一数据源（SGLang 在服 ∪ 在用模型 ∪ 网关 alias）+ 同一写前校验（路径形态=error、未命中=warning + 悬停提示），与建 Worker/团队配置成员模型行为零分叉。
- **私聊角色分区改下方筛选 chips（「应该在下面加个按对象角色分区显示，而不是直接在列表分割」）**：
  13.21 的实现直接在列表里切成角色段+组头；改为私聊区顶部**筛选 chips**（全部 / Leader / Worker / Manager / 其他，带计数；空桶不显）——默认「全部」=单一扁平列表（原有时间/名称序），选某角色=只看该角色的私聊；所选角色桶消失（刷新后无数据）自动回「全部」。
- **i18n**：1,371 键 0 缺 0 重 0 空（+3）

**验证**：tsc 0 · vite 单文件 7,622kB（gzip ~2,150kB；0 import 语句=宿主 blob 安全）· pytest 71/71 · ui-harness-1322 22/22（矩阵隔离 /  图样式切换 /  选点跨重渲染持久 /  徽章挂头像 /  chips 筛选）· i18n 1,371 键 · 敏感扫 0（源码+dist 解码）· 版本载体 10 文件

---

## 0.5.0-beta.13.21（2026-09-24）

**13.20 反馈 + 残余盘点全批：团队管理首屏一次性就绪 / 房间列表 Element 化增量刷新 / 团队配置弹窗完整化（含团队技能节）/ Worker 配置集成拓扑 / 侧栏角色分组 / composer 上方活动轨 / Mermaid DAG 视图 / 删团队撤销 / 心跳态显形**

- **团队管理首屏数据一次性就绪（「一开始只能看见拓扑，要等一会点刷新才能看见其他」）**：
  五个结构性缺口全修——① mount effect 补 admin 拉取；② 管理 token `false→true` 翻转补重触发（此前 token 后到首屏恒空）；③ tab 切换 effect 首访早退修（持久化首开团队 tab 不刷新）；④ `fetchAdminData` 改分键容错（humans/managers 任一 404 不再拖垮 workers/teams）；⑤ 失败显形（连续失败计数 + 警示条，不再静默）。
- **房间列表 Element 化（「刷新是不是有点慢有点笨，看看 Element」）**：
  ① 后端 watcher 新增 `room_list_update` SSE 增量事件——房间 name/topic/unread/last_ts/member_count 的 delta + 新房间 summary + leave 事件（基于 /sync 事件流就地 diff，不再每次全量 `/teams/sync`）；
  ② 前端收到增量**就地合并重排**（不整表重拉）；mention/approval 类更新不再触发房间全量刷新（仅真·全量场景：首次同步/登录/显式刷新/接受邀请）；
  ③ +7 增量 diff 回归测试。
- **未读气泡 → 左上角**（侧栏图标角标从右上移到左上）。
- **团队配置弹窗完整化（「团队的技能等团队配置也要放在团队配置里面」）**：
  ① 补 **subagentModel**（团队级 spawn 子代理默认模型，留空=继承 Worker 主模型）字段 + 保存（PUT 同 heartbeatEvery 语义）；
  ② 弹窗内嵌**团队技能节**=技能中心同款组件 onlyTeam 模式（目录搜索/上传/自定义新建/下载 + 成员分配矩阵 + MCP 卡；保存走技能中心原端点，与弹窗「保存」按钮互不干扰；高度封顶 460 内滚动）；
  ③ **L1/L2 分权保留**：L1 可管理任意团队；L2 用户走「技能中心（我的团队）」入口，同能力、服务端限本团队。
- **Worker 配置集成拓扑（「worker 也是，都集成在拓扑里面」）**：Worker 拓扑「资源管理」技能页签补**目录节**（搜索/上传/自定义/下载，scope=该 Worker 所属团队）+ 原可编辑分配矩阵，一屏看全。
- **侧栏角色分组**：私聊视图按对象角色分区（Leader / Worker / Manager / 其他，组内仍按时间/名称序）；无 L1 管理数据时自动退回扁平列表（L2 无感）。
- **AgentActivityTrack 活动轨（composer 上方任务进度 + HITL）**：当前房间匹配项目活跃时，输入框上方显内联轨——项目名+状态+任务 done/total+迭代进度+「等待人工介入」琥珀 chip+在办任务 chip（≤5，状态色点+执行者）；点轨=打开该项目工作流；项目终态/无匹配自隐。数据=既有 workflow API（零新请求）。
- **Mermaid DAG 视图（，第五视图）**：工作流页新增「Mermaid」视图——上游 `GET /projects/{id}/workflow?format=mermaid`（已合 main）快照直渲染（节点色=任务状态，ready 高亮）；mermaid 12.0.0（MIT）随包单文件内联（宿主 blob 环境禁动态 import，`inlineDynamicImports` 全内联；主包 2,308→7,620kB，离线可用零网络依赖）；Controller 未含该端点（404）诚实占位，拓扑视图不受影响。
- **删团队撤销（undo）**：删团队前快照 → 删除成功 6s「撤销（按快照重建）」toast → 按快照 `createTeam` 回写（teamName/description/workerMembers/heartbeat/peerMentions/subagentModel）。诚实语义=**重建非恢复**（房间历史/容器状态不随 CRD 回来，toast 明示）。
- **#1247 心跳态显形**：Worker 详情面板补心跳任务运行态四字段（agentStatus / runningTaskCount / lastRunAt / lastFinishAt；旧版 Controller 无字段整行隐藏）。
- **MCP L2 写权限**：上游 capability-foundation 在途（仅地基：CRD capabilities + audit client）；消费支待其合并后排期——L2 的 MCP 写目前仍阻塞（非插件侧问题）。
- **i18n**：1368 键 0 缺 0 重 0 空（+25）

**验证**：tsc 0 · vite 单文件 7,620kB（gzip 2,150kB；0 import 语句=宿主 blob 安全）· pytest 71/71 · i18n 1368 键 · 敏感扫 0（源码+dist 解码）· 版本载体 25 处

---

## 0.5.0-beta.13.20（2026-09-24）

**13.19 反馈：per-worker 技能一等公民（物化层字段补全 + 预加载开关）/ 团队配置入口上移（拓扑「N人」右侧齿轮）/ 群消息加载逻辑收敛（roomHistory 单一权威 + 开房路径深历史修复）**

- **per-worker 技能（「技能好像不仅有团队技能，还有每 worker 技能」）**：
  ① 物化层（Worker 运行时实际装载）字段补全——`GET /workers/{name}/skills` 的 description / source / emoji / version / tags 此前未取，UI 上只剩光杆技能名；
  ② 技能矩阵展开区从光杆 Tag 升级为**逐技能行**：启用态点（绿/灰）/ 来源 Tag / 描述（省略+悬停全文）/ 分配态 Tag（已分配=蓝·仅物化=青）；
  ③ **预加载开关**（per-worker × per-skill）：`PUT /workers/{name}/skills/{skill}/preload`——技能全文常驻该 Worker 每个会话的 system prompt（QwenPaw ≥ 2.2.1；Worker 侧验证+持久化+**热加载**，无需重启）；权限= L1 任意 Worker / L2 本团队 / 团队 Leader 只读；失败三档诚实提示（403=只读身份 / 404=版本门或技能缺失 / 502=Worker 不可达）。
- **团队配置入口上移（「团队配置移动到拓扑的团队 x人 右边，加个齿轮图标」）**：
  拓扑树 TeamNode「N人」右侧新增 ⚙ 齿轮（仅 L1 且有管理数据时渲染）→ 打开「配置团队」弹窗（名称/描述/心跳间隔/成员模型）——**与团队表「配置」按钮同一入口**（注册式 handle，不复制第二套弹窗；L1 退出自动失效）。
- **群消息加载逻辑收敛（反馈：群消息加载逻辑需要系统性优化，不靠补丁堆叠）**：
  ① 五轮修复（13.10 合并 / 13.16 并发闸 / 13.17 驻顶接力 / 13.18 预取管线 / 13.19 游标单调）的窗口游标 / 预取槽 / 在飞闸 / 空页走查，收敛进新模块 `roomHistory.ts`——**编号不变量 I1–I6 成文**（游标单调 / 合并非替换 / 预取单槽双键控 / 空页走查 ≤8 / 在飞单发 / 落盘=全窗口+游标），配套 node 冒烟脚本 8 案全绿；
  ② **实存 bug 修（开房路径）**：切房后消息 ref 已归零，旧合并逻辑以空基底取最新页 → **浅页覆盖缓存里的深历史**（13.10「切页历史不蒸发」在开房路径上破洞）；现基底=在屏全量与缓存窗口的较长者，切房回来翻过的历史仍在；
  ③ 状态恢复内联块（第 4 条窗口建立路径：无合并 / 无窗口游标 / 浅页覆盖缓存）退役，窗口建立**单一权威**=刷新路径；4 个散落 ref 与 1 个死镜像退役；
  ④ 聊天显示侧（锚保持 / 0.6 视口预载余量 / 驻顶接力 / 「加载原消息」自动后翻）零改动，13.17–13.19 验收语义逐条保留。
- **i18n**：1343 键 0 缺 0 重 0 空（+16）

**验证**：tsc 0 · vite 2,308.18kB · pytest 64/64 · i18n 1343 键 · roomHistory 冒烟 8/8 · 敏感扫 0（含 dist 解码）· 版本载体 10 文件 25 处

---

## 0.5.0-beta.13.19（2026-09-23）

**13.18 反馈：「加载原消息」全链路修复（游标回退根因 + 空页走查 + 数据推进即解锁 + 点后自动后翻）/ 技能中心补齐「上传 / 自定义新建 / 下载（版本门）」**

- **「加载原消息加载不出来 / 可能太多请求」全链路修复（根因）**：
  ① **游标回退**（主根因）：刷新（开房恢复/动作后）每次把分页游标重置成「最新 50 的游标」，而窗口里已有更深历史 → 此后 `loadMore` 拉回的整页全是已加载内容：去重零新增 → 不落盘 → 无前插 → 接力锁 6s → **逐页空转**（每页一次多余请求）→ 30s 看门狗取消 = 看起来「加载不出来」。现=**游标只在首窗建立**，刷新只合并新消息不动游标（缓存写入与预取均用窗口游标，不回退）。
  ② **空页走查**：单页零新增且还有更早 → **立即续走下一页**（上限 8 页、游标不前进即停）——假死一次走完。
  ③ **数据推进即解锁**：接力防重从「仅前插检测解锁」改为「messages 变化即解锁」，6s 定时器降为失败路径兜底。
  ④ **点后自动后翻**（Element 同款）：点「加载原消息」后**不再依赖滚动位置**，自动逐页前翻直到原消息进窗口；新增「净增 >3000 条仍未命中」超量上限（原有 30s 停滞看门狗 / 触底 / 切房终止保留）。
  ⑤ 前插检测改用**原始** messages 首条 id（整页均为折叠/隐藏消息时锚恢复不再失效）。
- **技能中心：技能包上传 / 自定义新建 / 下载**（「自定义技能和技能上传和下载呢」）：
  ① **上传技能（zip）**：目录卡动作 → `POST /api/v1/skills`（multipart：scope=team + file）——**连接器新增 multipart 原样透传**（旧版一律按 JSON 解析 → 上游收空体、上传必 400）；扫描结果（pass/warn/skipped、422 拦截原因）随提示。
  ② **新建自定义技能**：名称/描述/正文 → 前端打包 `SKILL.md`（fflate）→ 同一上传端点；名称按服务端正则前置校验。
  ③ **下载**：目录行「下载」（team/shared 源，团队层自动带 `?team=`）→ `GET /api/v1/skills/{name}/download[?team=]`；**版本门**：当前 Controller 无该端点时 404 → 诚实提示「上游端点待合并」。**上游端点已实现并实测**（分支 `feat/skills-download`，`go test ./...` 全绿，PR 稿在 `PR/skills-download-endpoint/`）——Controller 升级即自动可用，插件侧零改动。
- **i18n**：1328 键 0 缺 0 重 0 空（+16）

**验证**：tsc 0 · vite 2,301.88kB · pytest 64/64 · i18n 1328 键 · 控制器 `go test ./...` 全绿 · 8 版本载体

---

## 0.5.0-beta.13.18（2026-09-23）

**13.17 反馈：聊天历史改「预取管线 + 提前余量」——加载跟着窗口走，触发即零等待（不再「被触发才追、慢」）**

- **预取管线（「现在应该有自动加载的了，但是慢，触发『加载更多』才加载，而不是跟着窗口预加载」真修）**：① **开房即后台预取下一页**——按（房间 + 游标）双键控，不匹配/切房即作废（绝不跨房取页）；预取失败静默不打扰 ② **每次落盘后立即预取再下一页**——管道常驻，用户滚到边界时通常**已备好（零网络等待）** ③ 顶部触发点提前：余量 0.25 → **0.6 视口（下限 400px）** ④ 触发→落盘同链路：命中预取 = 立即上屏 + 锚保持（不闪跳）；**预取若已失败 → 该页自动直拉兜底**（历史加载不搭在早先失败上）⑤ 载入中的「正在加载更早的消息…」保留（多数情况下你已看不到它——页面已备好）
- 效果：往上滚动时加载**跟着窗口进行**（在你到达之前就已加载好），不再出现「滚到边界 → 触发 → 等一次网络往返 → 才出内容」的节奏

**验证**：tsc 0 · vite build 2,286.90kB · pytest 64/64 · i18n 1312 键 0 缺 0 重 0 空 · 8 版本载体

---

## 0.5.0-beta.13.17（2026-09-23）

**13.16 反馈 3 组：项目看板高度全实测（消除整体滚动条）/ 聊天历史改「接近顶部即预载 + 驻顶接力分页 + 预载态显形 + 并发防重」/ 顶部版本号改构建期注入（恒等于实际安装版本）**

- **看板高度全实测（「还是有点高导致整体滚动条」）**：旧版用「视口高 − 240px（估页面头高）」估算可用高 → 系统性偏大 → 8 列总和超出容器 → 整页滚动。现 = 「看板**实测**顶边 → 最近可滚动祖先容器底（无则视口底）」计可用高，按行数均分并扣除列内固定开销（头部/内边距/行 gap）→ 精确贴合容器，不再出现整体滚动条；keep-alive 隐藏 tab（0 宽）不测量，再可见时 ResizeObserver 自动重算
- **聊天消息预加载（「不能滚到哪加载到哪、没有预加载」）**：① 触顶余量 40px → **列表视口高 25%（下限 160px）**——接近顶部就开始拉；② **驻顶接力**：每次渲染后（每页落地/加载态变化）重查顶部位置，仍在余量内就续拉下一页——普通聊天与「加载原消息」共用同一链路，滚离即停；③ **预载显形**：加载中顶部显「正在加载更早的消息…」；④ **并发防重**：父侧 in-flight 闸（滚动预载与手动按钮同窗口双触发会以同一游标重复前插）；⑤ 复位改双路：前插检测（快）+ 6s 兜底（失败路径），替代旧 4s 固定锁
- **顶部版本号（「版本号显示不对」）**：主显示改**构建期注入**（vite define `__PLUGIN_VERSION__`，来源 package.json，随 dist 打包）——**恒等于你实际安装的 dist 版本**；旧版取后端 `/health`：后端进程未随安装重启时显示旧版本、请求失败则恒显占位「…」。连接器运行版本仍查 /health，仅入 tooltip（不一致时显示「前端 x · 连接器 y」）
- **i18n**：1312 键 0 缺 0 空（+3）

**验证**：tsc 0 · vite build 2,286.39kB · pytest 64/64 · i18n 1312 键 0 缺 0 重 0 空 · 8 版本载体

---

## 0.5.0-beta.13.16（2026-09-23）

**13.15 反馈 4 组：项目群↔项目关联第三源（生产 76 房间 × 35 项目真值对表定位——新项目只有任务房 `TASK：<projectId>`（6 个此类房全漏配））/ 拓扑资源区 UX 重做（「资源治理」更名「资源管理」；技能与 MCP 改技能中心同款可编辑卡就地嵌入；单 Worker 不再重复选 Worker）/「运行配置」折叠头统一为资源管理同款卡片式 / 项目看板 8 列等高 + 宽屏 4×2 / 窄屏 2×4 + 高度随屏幕按比例**

- **项目群↔项目关联第三源（「依旧显示『当前房间无直接关联项目』」根因）**：13.15 双源（source_room_id ∪ `Project: <标题>`）对 15/22 项目房有效，但**新项目（按 create_task_room 约定建的）根本没有 `Project:` 房**——teamharness MCP `create_task_room` 建的**任务房命名 `TASK：<projectId>`**（上游 server.py 契约，房间名内嵌项目 ID）。现三源判定：① source_room_id 严格匹配 ② `Project: <标题>`（引号容错）③ **`TASK：<projectId>`（全/半角冒号容错）→ ev.runId 精确相等**。**验证方式=真源码函数 × 生产真值直跑**（本地插件代理拉真实 76 房间 + 35 项目/工作流，esbuild 编译后 node 执行）：21/28 命中（15 个 Project 房 + **6 个 TASK 房全部命中**）；余 7 个为孤儿房（项目已不在 Controller / 标题历史分叉，无可用关联源）。项目文件抽屉、房间卡项目名、团队管理房间卡三处同步受益
- **拓扑资源区 UX 重做（「资源治理的名字很奇怪 + 技能中心和 MCP 完全和 worker 拓扑合并 + 点开工具不应该再选 worker」）**：① 「资源治理」更名**「资源管理」**；② 技能页签从「只读概览 + 去技能中心编辑跳转」改为**技能中心同款可编辑矩阵就地嵌入**（`SkillCenter onlyWorker+sections` 复用同一组件/同一保存链路——分配层+物化层双层语义原样保留，就地勾选/保存）；③ MCP 页签从只读列表改为**MCP 卡嵌入**（L1 就地编辑 mcpServers，L2 只读=上游契约）；④ 撤「去技能中心编辑（全量矩阵）」跳转（编辑已就地；底部折叠区保留为跨 Worker 全量视图）；⑤ **单 Worker 不再重复选**：工具/频道面板单 Worker 自动选中且选择器隐去（以标签定显名字）
- **「运行配置」折叠头统一卡片式（「做好看一点，和资源管理的按钮做一样」）**：text link → 与「资源管理」同款卡片折叠头（▸/▾ + 齿轮图标 + 标题 + qwenpaw 标签 + 边框卡片）；展开态补「收起」抓手（此前展开后无法收起）
- **项目看板 8 列等高 + 响应式（「每个看板要等高，随着屏幕高度动态调整，按比例；宽屏 4×2，窄屏 2×4」）**：列数按容器宽判定——宽 ≥950px → 4 列 × 2 行；窄 → 2 列 × 4 行；卡区高度 = 视口可用高 ÷ 行数（200–460px 区间，按比例伸缩，`ResizeObserver`+`resize` 双源监听）→ **8 列恒等高**；内容超出列内滚动
- **i18n**：1309 键 0 缺 0 空（撤 1 死键）

**验证**：tsc 0 · vite build 2,285.52kB · pytest 64/64 · i18n 1309 键 0 缺 0 重复 0 空 · **关联第三源生产直跑 21/28**（真源码 × 真实 76 房间/35 项目）· 8 版本载体

---

## 0.5.0-beta.13.15（2026-09-23）

**13.14 反馈 8 件：对勾图标转正 / 「加载原消息」Element 式滚到哪自动加载 / 项目文件与房间卡片的项目关联双源修复（项目群↔项目）/ 房间列表卡片项目名（关联修好后可见）/ Worker 拓扑集成「资源治理」（技能+MCP+频道+工具一站式）/ 技能两层显示（分配层 vs 物化层——解释「没分配也能调」）/ 项目看板 4×2 每列 3 卡滚动 + 时间排序 / 群聊 sender 隔离开关（接入上游 #1235 接口，默认隔离）**

- **对勾图标转正（「√的SVG被你逆时针旋转90°了」）**：`CheckIcon` 旧路径渲染出的对勾逆时针偏了 90°——换 Material 标准实心对勾路径，聊天页/审批等所有引用点同步转正
- **「加载原消息」Element 式「滚动到哪里就自动加载」**：此前点了「加载原消息」后要手动反复点/回卷；现改为——加载原消息进行中，你**停在列表顶部它就自动续拉下一页**（锚定不闪跳），滚离顶部即停（40px 触顶触发与 13.6 锚机制共用防重入）。终止条件沿用 13.14 四条件（原消息进窗口自动定位高亮 / 触底 / 无新数据 / 切房作废），不再需要任何手动点击
- **项目群↔项目关联双源修复（「聊天页项目文件读取不正确 / 房间卡片没项目名」根因）**：此前房间→项目只按 `workflow.room_id` 单源建索引——标准项目群（`create-project.sh` 建、命名 `Project: <标题>`）的 workflow 事件 `room_id` 指向**发起房间**（QQ/DM），项目群卡片与项目文件抽屉恒空。现双源：① workflow 权威源 `room_id`/`source_room_id` 命中 ② 标准项目群命名 `Project: <项目标题>` 与项目标题匹配（两者都过 = 防误配）。聊天页项目文件抽屉、房间列表卡片项目名、团队管理房间卡同步受益
- **Worker 拓扑集成「资源治理」（技能 / MCP / 频道 / 工具一站式）**：团队拓扑里每个 Worker 行展开后新增「资源治理」区块——技能（两层显示，见下）、MCP Server 挂载、频道（复用频道编辑器，首次打开懒加载）、内置工具（复用工具面板，首次打开懒加载）四件同屏；「技能」区提供去技能中心编辑入口（全量矩阵）。原来要切到技能中心/频道/工具三个独立入口的操作，现在拓扑展开一次看全
- **技能两层显示——解释「为什么看见没分配、实际能正常调用」（「你查一下」结论）**：Worker 技能有**两层**——**分配层**（CRD `spec.skills`，显式分配，L2 可写）与**物化层**（运行时实际装载）。分配层为空而物化层非空 = 技能由**团队层自动物化 / 内置恢复 / 镜像自带**——没显式分配但可正常调用，属预期行为。技能中心矩阵与 Worker 拓扑资源治理现在分两层显示：「已分配 + 已物化」（绿）/「仅物化」（黄，未显式分配）/「运行时未装载」，行尾附解释；物化层取运行时 `GET /api/workers/{name}/skills`（Controller 无该端点或当前身份无权限时降级——分配层不受影响）
- **项目看板 4×2 + 每列 3 卡滚动 + 时间排序（「两行四列，每个看板显示三个卡片，再多滚动col，时间排序要做好」）**：看板从 8 列横排（挤）改 4 列 × 2 行；每列最多显 3 张卡片，超出列内滚动；列内任务按更新时间倒序（`ts` 降序，空时间垫底），跨列同任务不重复
- **群聊 sender 隔离开关（「上游我做了接口的」）**：接入上游 `share_session_in_group`（#1235 已合）——Worker 频道面板新增「群聊会话共享」开关：**关（默认）= sender 隔离**（群内每人独立会话，互不串上下文）；开 = 全群共享一个会话（协作模式，但所有人上下文混在一起）。走既有 L2 白名单写路径，改完即时生效（下次消息起）
- **i18n**：1310 键 0 缺 0 空 en（新键 24：滚动自动加载提示 / 资源治理四件套 / 技能两层语义全套 / sender 隔离说明等）

**验证**：tsc 0 · vite build 2,286.71kB · pytest 64/64 · i18n 1310 键 0 缺 0 空 · 图标库 70 0 悬空 · 敏感扫（源 diff + 全树 + dist 解码）0（192.168.x.x 占位形态为既有允许项）· 8 版本载体

---

## 0.5.0-beta.13.14（2026-09-23）

**13.13 反馈 7 件 + 技能中心 L2 双模式：「加载原消息」去 15 页上限 / 聊天项目文件只显本群 / 房间卡片带项目名 / 项目文件标题+弹窗内预览+下载 / 图标四件更正（产物=箱子、事件流=波形、技能=闪电、Worker=机器人）/ Worker 技能分配矩阵按 Worker 行重构 / 技能中心 L2 双模式（我的团队 scope · skills 可写 · MCP 只读）**

- **「加载原消息」去掉 15 页×50 条硬上限（「能不能多点」）**：此前最多回卷 15 页（750 条）找不到就报「不在可加载历史」。现由四个真实终止条件兜底——① 原消息进窗口 ② 触底（`!end`）③ 分页无新数据（防服务端异常死循环）④ 切房（代际号作废进行中的链）；500 页（2.5 万条）仅为理论回退护栏。正常房间永远走不到护栏
- **聊天页项目文件只显本群（「能不能只显示本群的？」）**：项目文件抽屉此前列全量项目——现只显**当前房间所属项目**（房间→项目映射由 workflow 权威源推导），别的房间项目不再混入
- **房间卡片带项目名（「房间名字下面要加上项目名字」）**：房间列表卡片在房间名下面加小字项目名（一个房间多个项目时全列）
- **项目文件弹窗：标题加文件夹图标 + 去重复副标题 + 弹窗内预览 + 下载按钮**：① 标题「项目文件」前加文件夹 SVG，标题下面重复的「项目文件」字样删除 ② 文件预览不再跳转外部应用——改与「产物」tab 同款**弹窗内预览**（文本/Markdown 直接看）③ 每个文件加**下载**按钮（与产物 tab 同源 downloadViaHost 单点 toast）
- **图标四件更正（「产物的图标应该换成箱子……技能和事件流和 worker 的图标也要换」）**：① 产物 = 立体纸箱（旧路径实为**购物袋**造型——非箱子，换真箱子）② 事件流 = 活动波形（旧雷达→波形，语义=事件脉冲）③ 技能 = 闪电（技能中心与首页技能入口，旧拼图→闪电）④ Worker = 机器人（旧组织树→机器人）
- **Worker 技能分配矩阵 UI 重构（「矩阵太占地方太不直观太不好用」）**：旧版 = 全 Worker × 全技能大网格（横竖双轴滚动、勾一格一状态、看不出"这个 Worker 改没改"）。新版**按 Worker 行**：一行 = 一个 Worker（行内显当前技能标签 + 计数），点行展开该 Worker 的技能编辑面板（一次只展开一个，面板恒紧凑）；**服务端基线脏检测**——只有相对基线有改动的行才显「保存」，保存成功后基线推进、脏标记消失；失败不推进可重试
- **技能中心 L2 双模式（L2 员工视角技能/MCP 自服务）**：按上游设计文档（`docs/design/l2-worker-scoped-write.md` #1274 已合 + `team-skills.md` + `skill-catalog-api.md` 已合 main）+ 9/11 调研 P0 ——Matrix 身份登录（无 admin token）的团队管理现出「**技能中心（我的团队）**」：① 技能目录 = `GET /skills?team=<本团队>`（accessibleTeams 单团队自动选中；多团队显选择器；cross-team 404 反探测）② Worker 技能分配 = L2 scoped workers（standalone 隐藏）+ `PUT {skills}` 可写（上游 L2 白名单唯一字段）③ MCP = **只读**（mcpServers 对默认 L2 关闭——网关 bearer key 注入每条条目，L2 可控 URL 会外泄它；写权限待上游 elevated capability 设计）。**铁律**：L2 路径不走 admin token（代理链 admin token 空 → Matrix access_token，router.py catch-all 已实现）；团队/用户/Manager/频道/工具等 L1 管理面 L2 不显示
- **i18n**：1286 键 0 缺 0 空 en（新键：L2 技能中心全套——我的团队/选择团队/团队目录不可用/L2 矩阵与 MCP 标题/无 Worker（L2 可见范围）等；矩阵行重构键——点行展开/暂无技能分配/未保存/编辑技能/重置为当前值等）

**Verification**: tsc 0 · vite build 2,271.85kB · pytest 64/64 · i18n 1286 键 0 缺 0 空 · 图标库 70 枚（71−拼图/雷达/组织树+波形/机器人）0 悬空引用 · 敏感扫描（源码 diff）0 · 版本载体 12 处

---

## 0.5.0-beta.13.13（2026-09-23）

**13.12 反馈 10 件：工作流 blocked 横幅带信息 / 工作流 tab 打开即刷新 / 聊天群项目文件读取修复 / 「已滚出历史」Element 式 / 下载去向明示（桌面版）/ 知识库等高+树独立滚动 / 全 emoji → SVG（全仓 27 文件，71 图标库）**

- **工作流 blocked 横幅带信息（「只显示 ⚠ blocked 有点突兀」）**：每个中断任务横幅（此前多条只显 "⚠ 阻塞" 纯词）现带任务短编号 + 任务状态 + 分配 Worker + 原因内联显形（任务中断描述 / 项目暂停原因），可直接定位到具体任务
- **工作流 tab 打开即刷新（「一点开应先自动刷新」）**：此前只有 15s 轮询 + 手动刷新——切到工作流 tab（或聊天出现工作流卡）立即拉一次权威源，2s 去抖防快速切 tab 连环拉取
- **聊天群项目文件读取修复（「读取不到」）**：三修——① 项目列表上限 20→100（此前项目超 20 个且当前项目不在字母序前 20 时文件恒不加载）② 匹配模型重构：按项目 ID 分组（此前按项目名，跨团队同名串档/漏档）+ 按项目懒加载（当前房间项目自动加载，其余展开才拉，逐项目错误显形+刷新）③ 下载 URL 补 &team= 限定防跨团队同名串档
- **「已滚出历史」Element 式（「Element 里信息都在」）**：原消息不在已加载窗口时不再标死「已滚出历史」——改 Element 口径「加载原消息」动作（自已加载窗口向前链式分页回卷，最多 15 页 × 50 条；命中即原位插入引用条，遍尽仍未见则明示「原消息不在可加载历史」+ 提供跳转定位），死文案消除
- **下载去向明示（桌面版还是不知道下到哪）**：downloadViaHost 单点 toast（6 个调用方全覆盖）——浏览器 =「默认下载目录 + 文件名」；Electron 桌面版明示操作系统「下载」文件夹（如 C:\Users\<用户名>\Downloads）并告知不提供下载列表
- **知识库等高 + 树列独立滚动**：知识文件列与预览列等高（stretch），文件树列独立滚动、滚轮不再冒泡成整页滚动
- **全 emoji → SVG（T7– + 全量清扫）**：新建 icons.tsx 图标库（71 枚：HarmonyOS ic_public_* fill 路径 43 枚直接内联 + 手写 stroke 28 枚——脑/雷达/盾牌/砖块等无系统对应件）；27 个文件全仓替换 UI emoji（顶部 4 tab 图标 + 各面板按钮/标签/空态/判定符号/菜单项/下载钮/状态标记）。**保留清单（文档化）**：消息协议正则（🔧✅❌ 解析与 Approval Required 探测）/ emoji 选择器与快捷反应（Matrix emoji 内容本身）/ 外发验收评语文本 / 浏览器通知标题（平台字符串）/ 宿主字符串 API 限制（侧栏 icon 回退 🏢）/ 单字符文本字形（✓✗○▶☰↻）/ 代码注释
- **i18n**：1277 键 0 缺 0 空 en（新键：Matrix 未配置提示 / 路径形态·未命中·期望 / SOUL 上传占位去 📎 等；「✗ 路径形态」「⚠ 未命中」旧键重构为纯文本键 + SVG 前缀）

**Verification**: tsc 0 · vite build 2,268.12kB · pytest 64/64 · i18n 1277 键 0 缺 0 空 · 全仓 emoji 终扫=仅剩文档化保留清单 · 版本载体 12 处（4 载体 + README×2 + docs×4 + CHANGELOG×2）

---

## 0.5.0-beta.13.12（2026-09-23）

**13.11 反馈 7 项：会话状态点恒显 / 会话窗置底 Element 式锁定 / 宽窄屏实测可见宽 / 房间列表提及区+排序 / 拓扑·团队图标 SVG 化 / 团队管理 tab 手动刷新即时完整（负缓存根因）/ 事件流空态文案 + cancelled 独立态**

- **会话列表状态点恒显（「状态点没看见」）**：卡片灯此前只在 running 渲染（idle/done 无点，盘上多为 idle 故恒不见）→ 改恒显 WorkerSessionDot（idle 灰常亮 / running 蓝呼吸，含 Tooltip，与详情头/成员头像角灯同一权威源）
- **会话窗置底 Element 式锁定（「点置底不灵，像滚动位置记忆问题」）**：根因 = 点 ↓ 触发 smooth 滚动途中，新消息 effect 现算 nearBottom=false → 按钮重弹 + 计数清零前又被加 1。改显式 atBottom 状态 + 点击 800ms pinned 锁（窗口内新消息持续贴底、不重弹按钮）+ instant 跟随（弃 smooth——目标随新消息 scrollHeight 漂移）；上翻看历史不打扰，换房贴底
- **宽窄屏实测可见宽（「聊天页自动单栏没做到」）**：cont 此前只量插件 `<main>` 的直接父级，宿主真实约束层（Desktop OS 窗口 frame）在更上层祖先 → 窗口拖窄 main 不跟。改从 main 沿父链到 body 逐层 clientWidth 取 min ∩ 视口宽，ResizeObserver 观察整链——OS 窗口/经典页/iframe 三宿主形态统一生效
- **房间列表排序优化**：① 新增「@ 提及」置顶分区（Element X 语义：@我/高亮未读独立置顶，无则隐藏）② 排序切换（时间↓默认 / 名称 A-Z，客户端本地持久化）③ 三区（提及/收藏/主列表）渲染收敛为单一 helper 消除重复
- **图标 emoji → SVG**：工作流「拓扑」钮 🌳 → DAG 拓扑图标（节点+连线）；团队管理 tab 👷 → 双人部分重叠图标（横排 tab + 顶部 Tabs 双处）。纯内联 SVG（无 icon 包依赖），随激活态变色
- **团队管理 tab 手动刷新即时完整（「刷不出完整信息，手动刷新不行，要等 30s」根因·双端）**：后端 /teams/structure 60s TTL 缓存此前把**首次失败/空树也缓存 60s（负缓存）**——token 未就绪首拉得空树后 60s 内手动刷新全命中空缓存，30s tick 恰在 TTL 过期后 miss 才"活"。修 = 失败/降级/空树只负缓存 5s、成功（controller-workers 非空）才 60s（ttl 随条目存）；前端手动刷新/切 tab/登录一律 force=true 绕缓存，仅 30s 后台 tick 走缓存；+4 条 TTL 回归测试
- **事件流空态文案（平台侧缺口）**：Controller 事件摄取未接通（端点只读 POST→405、存量项目 events 恒空、runtime 无上报—— 9/23 全链路调查）→ 空态明示"数据源未接通，此面板恒空，任务状态看拓扑/看板"，不再暗示"Agent 执行后会聚合"；文案剔除当前 runtime 不存在的 report_progress
- **cancelled 升独立态（「cancelled 显示成 blocked」状态映射缺陷·全量扫描）**：拓扑节点深红独立色（不再折入 blocked 橙）；看板新增「已取消」列（7→8 列）；卡片/任务巡检 Drawer 显「已取消」（深红 #cf1322，与 failed #ff4d4f 区分：失败=执行出错，取消=人为终止）；终态判定加 cancelled；已取消节点不再误画「就绪」青框
- **i18n**：+5 新键（中英镜像：已取消/时间↓/提及(n)/事件流空态长句）

**Verification**: tsc 0 · vite build 2,149.65kB · pytest 64/64（+4 负缓存 TTL 回归）· i18n 字典 0 缺 0 重复 · 包内版本核验 3 载体一致 · 13.12 比 13.11 文件集仅 +icons.tsx

---

## 0.5.0-beta.13.11（2026-09-22）

**13.10 反馈 12 件：会话列表卡片化（E1 真对象）/ 会话窗 Element 式事件驱动 / 消息历史跨房间根因 / 宽窄屏双基准+容器铺满 / 审批通知面板同步 / Tab 震动 / 话题旗 SVG / 工作流拓扑放大+执行者 / 会话窗 QwenPaw 头像复制**

- **会话列表卡片化（E1 真对象——是「会话列表做卡片」，13.10 误改产物行）**：Worker 会话列表 antd.Table → 卡片列表（参照 dashboard worker-chats-panel 口径）——整卡点击进详情、全名/全 session_id 换行不裁切、窄容器抗挤压；Table sorter 保留为排序下拉（最后活动↓/创建↓/名称A-Z）；Active/Archived 双 tab 与 Worker 选择不变
- **会话窗 Element 式事件驱动（「4s 一轮有点蠢」）**：主路 = 后端 /sync watcher 收到房间消息 → SSE → 打开的会话窗**立即**刷新（延迟≈网络 RTT）；4s 轮询降为 SSE 断连兜底（RoomChat P6 同构语义）。状态灯（running/idle）随事件同刷
- **消息跨房间根因（「消息滚出历史」仍未修的根因）**：换房间时 messages/messagesEnd/pagination token 残留**上一房间**数据 → 合并逻辑把两房消息混进同一窗口（「乱了」）+ 混合体写进新房缓存（切回「没了」）。修 = per-room timeline 状态整体归零（Element 口径：timeline 状态是 per-room 的）
- **宽窄屏双基准 + 容器横向铺满**：分栏判定 = **min(窗口宽, 插件容器实测宽) ≥ 800**——窗口满宽时容器随宿主铺满即分栏；宿主给窄容器（半窗面板/留白）或真窄窗口 = 聊天页自动单栏（不硬塞双栏）；容器宽 ResizeObserver 跟随（宿主布局变化不触发 window resize 也切换）
- **审批通知面板同步（「点了批准，通知面板还见未批准卡片」）**：根因 = 后端 /sync watcher 收到审批命令消息后才清未决缓冲（异步 1-2s）——乐观删除后的 30s 轮询若在 resolve 窗口前拉取，未清项被拉回=卡片复活。修 = 发送成功后立即重拉 + 3s 再拉，状态与后端缓冲强制对齐
- **QwenPaw 同款 Tab 震动（新审批）**：侧栏 logo 出现待审批 → 晃一次（bell shake 1.2s，reduced-motion 可关）+ 红点计数（15s 轮询 /room-approvals，与通知中心同源；未登录静默降级）
- **话题图标 → 消息旗气泡 SVG（替换 🧵 emoji）**：消息行「N 条回复」徽章 / 话题面板标题 / 窄屏 Drawer 标题三处统一
- **工作流拓扑优化（参照 dashboard + 改进）**：① 统计条（N 任务·M 依赖·K 外部依赖）② 缩放工具条（−/百分比/+，0.4–2.0）——宽图不裁、细节可读 ③ 节点补 **subagent 执行者行**（Controller nodes 自带字段，此前投影丢弃）④ 节点点击 → 任务巡检 Drawer（看板任务卡同款入口）
- **拓扑左侧项目列表可拖宽度**：220–520px（默认 320，持久化），卡片/拓扑双视图共享同一左栏宽
- **会话窗 QwenPaw 化（「还不够像」）**：user 右气泡 + 头像、assistant 左气泡 + 头像（HostBubbles 同款分侧）；气泡 hover 复制钮（ResponseActions 同款语义，复制全部文本部分）
- **@mention 全量复查**：主聊/引用/线程/审批命令四发送点全部 Element 三元组（body 短名 + formatted_body matrix.to + m.mentions.user_ids）确认无遗漏
- **i18n**：+11 新键（中英镜像），全量对账 0 缺 0 重复

**Verification**: tsc 0 · vite build 2,146.06kB · pytest 60/60 · i18n 字典 0 缺 0 重复 · 敏感扫 src 0 实名

---

## 0.5.0-beta.13.10（2026-09-22）

** 12 件全：@mention 双向 Element 格式 / 消息不再滚出历史 / 会话窗实时+底部跟随 / 过度折叠修 / L1 凭证两套指引 / 知识库符号链接+非文本全量列取 / 宽窄屏窗口基准 / 产物行卡片化**

- **@mention 双向 Element 格式（「单纯字符串」根因修）**：发送端——文本内 @成员（localpart/displayname 精确匹配，与 @ 弹层同口径）→ Element 三件套：body 保留可读短名、formatted_body 用 matrix.to 链接、`m.mentions.user_ids` 三元组负责通知（此前只发裸 body——群房间 `_require_mention` 下 Worker 根本收不到）；接收端——完整 MXID 与短 @名统一 Element 式 pill（此前短名仅橙色加粗）
- **消息不再滚出历史/乱序（根因修）**：messagesCache 从「最新 50 条页」升级为「全量已加载历史」（含 loadMore 前插的更早消息）；refreshMessages 从全量替换改 event_id 去重合并——切页/切房间回来翻过的历史不再蒸发，滚动锚不漂移
- **会话窗实时 + 底部跟随（QwenPaw 对话框口径）**：会话详情打开后 4s 轮询（「长度+末条」轻量判变，无变化零重渲染）+ 状态灯同步（running→idle 实时切）；底部跟随 = 近底 100px 内自动贴底、上翻看历史不打断阅读
- **过度折叠修（「太多消息被收进回复里」）**：每条带文本的 assistant 消息 = 独立气泡（QwenPaw 对话框口径），仅 tool/thinking/无文本步折叠成「N 步」pill（收起时不渲染子内容，点开懒渲染）
- **L1 凭证两套指引（B1 根因）**：根因 = l1 prop 在 TeamNode→WorkerRow 层丢失（运行配置面板恒只读，有 token 也无效）——全链透传修复；L1 只读 Alert 文案精确化（Console 会话 ≠ Controller token 两套凭证）+「去设置」跳转；L1 密码验证通过且 token 未配 → 设置页常驻指引（含取 token 命令）；「最大迭代」未显式配置时预填运行时默认 40（所见=生效值，保存才落库）
- **知识库全量列取（符号链接 + 非文本）**：顶层/ls 跟随符号链接分类展示（🔗 标注）；非文本文件也列出但灰显不可点开（「非文本」标注）；隐藏/敏感过滤与文件上限不变；+回归测试
- **宽窄屏窗口基准**：分栏判定基准 = 窗口宽（window.innerWidth + resize 跟随）——容器测量被宿主左右留空压窄误判竖屏消除；「强制分栏」开关与「收起列表」逃生口保留
- **产物行卡片化（「查看」被挤压裁切修）**：spec/结果产物/交付物行改卡片——路径完整换行无截断，查看/下载按钮独立一行恒不被裁（任务巡检 Drawer 与拓扑行共享组件双处生效）
- **会话列表凭证门明示**：401/502 → 明示「Controller token 未配置/不可达」+ 取法命令（此前笼统「加载失败」=「经常显示无 worker」的真实身份）；403 → 「无该 Worker 访问权」
- **i18n**：+8 新键（中英镜像），全量对账 0 缺 0 重复

**Verification**: tsc 0 · vite build 2,137.68kB · pytest 60/60 · 浏览器 harness 13.7 24/24 + 13.8 35/35 + window-shell 全过 · i18n 1249 字典键 0 缺 0 重复 · 敏感扫 dist 0 / src 0 实名

---

## 0.5.0-beta.13.9（2026-09-22）

**运行配置六 tab 补齐 + QwenPaw Loop 模板移植 + 状态灯 session 权威源 + 聊天气泡与 @mention 渲染 + 插件全宽自适应 + 知识库大工作区列取根因修**

- **运行配置六 tab 补齐 + L1/L2 门控**：页签 = ReAct 智能体 / 智能体 Loop 设置 / LLM 自动重试 / LLM 并发限流 / 上下文管理 / 长期记忆 / 系统（只读），每域独立 Card + 表单项行（label + 悬停 ⓘ 说明左 / 控件右）；按 Controller PUT 白名单门控——L1 可编辑（除 approval_level 全可写），L2 只读 + 警示（9 键白名单已验证）；上下文管理嵌套合并 light_context_config（12 字段：token divisor / 压缩阈值比例 / 工具结果修剪 8 键）；长期记忆 reme 5 键可编辑 + 完整 JSON 查看；保存走 buildDiff 只发改动键
- **Loop 设置 QwenPaw 模板移植（开源礼仪：出处署名）**：4 模板（安全运行 / 预算研究 / 质量优先 / 空管道）+ 7 gate 定义含默认值，逐值移植自 QwenPaw console AgentLoopCard（注释保留上游源文件 + 行号、模板区标注「模板设计：QwenPaw 上游」）；选模板 →「按模板创建自定义模式」弹窗（模式名 / slash 命令 / 描述 / 管道预览）→ 自定义 loop CRUD
- **会话列表自适应宽度**（13.7 「依旧拥挤」续修）：通道列 64→56（短名 + 悬停 Tooltip，容器 <640 整列隐藏）、会话列唯一弹性列（min 120）、查看列 44 nowrap——「查看」按钮恒可见；per-session running 蓝点；**React #300 真 bug 修**：两 hook 落在详情视图早退 return 之后 → 点「查看」即崩（Rendered fewer hooks），移至全部早退之前（harness 实证）
- **插件全局宽度自适应 + 横竖屏误判修**：主容器 maxWidth:1160 → 100% 全宽（16:9 全屏两侧大留空根因）；宽屏判定去掉宽高比项改纯宽度 ≥800（定高容器/面板下宽高比误判「竖屏单栏」根因——16:9 全屏必双栏、手机 390 单栏、强制开关保留）
- **会话窗折叠更像 QwenPaw**：「N 步」pill 升级整行头（图标 + 文案 + 计数 + 右对齐旋转 chevron，浅底圆角行；懒渲染语义保持——收起时子行不渲染）
- **聊天页气泡 + @mention 渲染**（对标 dashboard/QwenPaw/Element）：自己/对方主题气泡；@mention 整 MXID Element 式 pill chip（localpart 显示 + 悬停 Tooltip 整 MXID + 点击跳转），短 @name 保留旧高亮
- **状态灯信息源升级**（13.7 「显示不准确」续修）：新 workerChatStatus 模块轮询 /chats per-session status（idle|running——qwenpaw app 自维护的正确 session 状态，30s tick / 仅页面可见时 / 并发 4 / 失败静默保旧值降级消息级启发式）；状态机优先序 = 心跳（若有）> chat.running > typing；chat.updated_at 不用于 done（user 消息也刷新它 → 假绿）
- **i18n 术语修正**：「令牌预算」→「词元预算」（LLM token = 词元，4 处）、「每故事重试」→「每个 Story 最大重试次数」（= QwenPaw zh 原文 maxRetriesPerStory）；约 70 新键登记（中英），全量对账 0 缺 0 重复
- **知识库大工作区列取 HTTP 413 根因修**：旧通道把整个 workspace 打 tar 上传 Controller 列取（顶层超 20MB → 413；180MB 生产工作区恒报错）→ 双通道：容器内 `exec find` 为主（零下载、单请求返回全量文件列表）+ tarball 降为单文件读取/旧版本兼容回退；顶层与 memory/digest 子树同通道覆盖；+7 回归测试；生产端到端验证：180MB / 176MB / 21MB 三个真实工作区列取 0.16–0.22s 全 200（修复前 413）

**Verification**: tsc 0 · pytest 57/57 · vite build 2,128.77kB · 浏览器 harness 13.7 24/24 + 13.8 35/35（真实 React+antd 挂载：七 tab / L2 只读门 / L1 全值 / 模板 4 tag + 4 gate 勾选 + 弹窗预览 / 术语 / 无 pageerror）· i18n 1241 字典键 / 1137 用键 0 缺 0 重复 · antd 引用交叉 38 · dist 锚点 14/14 + 旧术语 0 + ant-slider=0 · 敏感扫 0 · 生产端到端（180MB 工作区 0.22s 200）

---

## 0.5.0-beta.13.7（2026-09-22）

**会话窗 QwenPaw 消息折叠 + 会话列表悬浮展开 + Loop 设置对齐 QwenPaw gate 管道 + 聊天渲染对标**

- **会话窗消息改 QwenPaw result-only 折叠**：每个回答轮只显示最后一条文本（assistant 气泡），中间的工具调用/思考步收进「N 步」pill（懒渲染——收起时子行完全不渲染，点开才渲染）；工具块退化成 RAW JSON 输出的根因修复（工具名读错层级——实际在 data 块嵌套层）；错误消息恒可见（QwenPaw 口径：result-only 下错误也不折叠）
- **会话列表悬浮 + 点击展开**：长会话名弹性列缩短省略；悬浮显示全名；点击行内展开（全名换行 + session ID 全值），再点收起；通道/最后活动/操作三列各收窄让位
- **Loop 设置对齐 QwenPaw（滑杆废弃）**：迭代上限从基本 tab 滑杆改为 Agent Loop → 迭代限制门（启用开关 + 数字输入 1..500——QwenPaw 配置面无滑杆），保存时自动同步 legacy 字段；补齐重复保护门（检测窗口/相似度阈值/干预规则增删改）与完成质量检查门（Rubric 提示词/最大干预次数）；补齐 Goal/Mission 内置参数（最大迭代/令牌预算/每故事重试/验证说明/验证命令）；重复检测窗口字段名修正（window_size）
- **运行配置面全量对账**：记忆后端改可编辑（L2 白名单键纠正误标只读）；系统 tab 补齐 LLM 并发/QPM/限速等待/限速抖动/槽位获取超时/最大输入长度/历史消息长度只读行（QwenPaw 限速器卡口径）
- **聊天页消息渲染对标**：工具消息状态着色（调用/成功/失败，失败名红色）+ 展开分区（参数/结果/错误，失败红色调）；markdown 代码块对齐 dashboard 口径（浅底卡片 + 边框 + 复制按钮悬停才出现）
- **i18n**：约 60 新键登记（中英）

**Verification**: tsc 0 · pytest 50/50 · vite build 绿 · 浏览器 harness 24/24（真实 React+antd 挂载：列表展开收起 / result-only 折叠与懒渲染 / 基本 tab 无滑杆 / gate 门值域 / window_size 权威源 / diff 点亮保存 / 失败状态色 / 悬停复制钮）

---

## 0.5.0-beta.13.6（2026-09-22）

**聊天页 Element 化重构 + 会话窗滚动根因修 + 运行配置面板对标 QwenPaw console**

- **聊天页消息时间线 Element 化**：纯文本消息去气泡框（扁平时间线 + 悬停行浅底圆角 pill）——旧版每条消息一个色块框，观感「消息框难看」；日期分隔改 Element 同款居中胶囊
- **历史消息滚动修复（根因）**：加载更早消息（前插 50 条）后视口被顶到最顶部、上翻历史「跳走」——现前插时保持滚动锚（useLayoutEffect paint 前恢复，不可见跳变）；滚到顶部 40px 内自动加载更早历史（Element 式无限滚动，保留显式按钮）；翻到头显示「已到最早的消息」标记；上翻加载历史不再被误计为「新消息」
- **会话窗滚动修复（根因·浏览器 harness 实证）**：13.5 详情视图的 grid + alignContent:end 在内容超容器时顶部溢出进入不可滚动区（scrollTop 恒 0）——上半截会话永远看不到；改普通块级流 + JS 滚底（harness 实测 scrollable=true）
- **会话列表去「用户」列**：五列改四列（会话 / 通道 / 最后活动 / 操作）——「用户」列信息不可读且对 Worker 视角会话无意义，删列后空间回归会话名列
- **运行配置面板对标 QwenPaw console 重构**：单行挤排改 Tabs 四域（基本 / Agent Loop / LLM 重试 / 系统只读）——每域独立 Card + 表单项行（label + 悬停 ⓘ 说明左 / 控件右）；最大迭代改滑杆 + 数值显示；LLM 重试开关关闭时重试参数自动禁用；数据范围不变（白名单键 + diff 只发改动键），只改呈现
- **会话级 loop 状态显示位置（权威源=QwenPaw console LoopModeSelector）**：从会话详情头迁至**聊天页输入区**（1:1 Worker 房间，轮询该房间激活 loop，running 蓝呼吸 / 等待输入琥珀 + 模式名 + 悬停描述；旧 runtime 404 恒不显）
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

**容器相对高度链（滚动根因修复）+ QwenPaw 式会话窗 + 结果产物统一显形 +  运行配置面板**

- **聊天主列表滚动根因修复（13.2/13.3 整页滚动的根因）**：壳高度此前用 `100vh − topBar` 魔法数推算——插件容器外层高度由宿主（QwenPaw 面板/浏览器窗口）定高，而 `100vh` 跟 OS 窗口走，两者错位：窗口拉大时壳撑出容器（实测窗口 1389px 时壳溢出 125px = 底部控制区被挤出视口高度）→ 整页被迫滚动、输入区被裁。整链重构为**容器相对高度**（Element 模型：flex 容器链 + `min-height: 0`，零魔法数，`100vh`/`100svh` 从插件代码彻底移除），壳高度跟随宿主容器、任意窗口尺寸成立。jsdom harness `window-shell-harness.mjs` 复现验证（旧链溢出 125px → 新链 0，列表内滚、输入区贴底完整可见）
- **会话窗重写为 QwenPaw Sessions 口径**：点开会话 → 会话详情右侧现为该 worker 的 QwenPaw 完整会话列表（会话状态/轮次/token 统计/最后活跃时间），点选会话看消息详情 + 会话内产出文件列表（点开预览或下载）；会话/消息/文件三层全版本门，端点缺失时降级提示
- **结果产物显形统一**：结果产物的「查看/下载」此前只有团队任务列表（dashboard 口径）有——现拓扑节点任务行与插件工作流卡片任务均有（`ArtifactLines` 共享组件，三处同口径）
- **Worker 管理第三面板「运行配置」（，消费上游 #1231 契约）**：`spec.runtime = qwenpaw` 的 Worker 显示并编辑与 QwenPaw 配置面板同名字段的运行时配置——`loop.max_iters`（表单编辑 + 整块 JSON 高级编辑 + 校验）、`approval_level`（审批级别）/`memory_manager_backend`（长期记忆）/`context_manager_backend`（上下文后端）/`shell_timeout`（Shell 超时）/模型段只读展示；loop 变更保存时提示将通知团队 Leader；409（Worker 运行中）/403（L2 范围）友好横幅；非 qwenpaw runtime 显示不支持说明
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
- **Worker 会话（入口=群内点头像，9/19）**：消费上游 #1295 会话端点（ready 等 review）——**入口不在团队管理**（原「会话」tab 已撤，9/19 ：会话属于聊天上下文，且目的是从 Worker 角度看完整 session，不是看最后活动列表）；群聊/DM 里点 Worker 头像 → 弹层/右键「💬 查看会话」→ 抽屉内会话列表（名称 / 通道 / 最后活动，置顶·已归档徽章）→ 详情视图恒显**「Agent 上下文」标注**（agent 工作上下文可能含压缩历史与未发送的工具调用/输出，与实发房间消息不同）、内容块保守渲染（文本直出、工具块压成标签、未知形态截断 JSON）、idle/running 状态灯（404 隐藏 = QwenPaw <2.2.1 版本无关门）、列表 404 = 占位横幅（旧 Controller / L2 房间边界外，设计上不可区分）
- **Worker 会话状态灯上头像角落（9/19）**：蓝（运行中·1.2s 呼吸）/ 绿（近 10 分钟完成）/ 灰（无任务），从「发送者名字旁」挪到**群内每条消息 Worker 头像右下角**（7px 圆点 + 白描边环 + Tooltip；心跳优先派生，人类发送者无映射不显）——与 dashboard 330257e 同款落点
- **成员头像条（9/19 ：模仿 dashboard 成员列表）**：房间标题栏右侧的成员头像条——Worker 头像右下角带同款会话状态灯；成员多时收成 **+N，点击展开全部/再点收起**（窄屏由标题栏换行自然落到标题栏下面）；点头像打开成员面板（既有 Drawer，全量成员 + @ 提及 + 详情，其头像行也带状态灯）——零新增请求（房间成员=既有 /sync，状态=既有派生）
- **数据面**：两者均复用既有通用 Controller 代理（`/api/agentteams/*` 透传），后端零新端点；只读端点无审计（上游一致先例）
- **i18n**：27 新键登记（中英）

**Verification**: pytest 46/46 · tsc 0 · i18n ui↔dict 对账 0 缺 · check-antd 38 引用全合法 · vite build 绿

---

## 0.5.0-beta.13（2026-09-19 · 正式号）

相对 beta.12（上一正式号）的新增与修复（按功能归类）：

**聊天**
- **左右分栏 + 左右独立滚动**（根因版）：分栏下房间列表与聊天框各自滚动；宽窄判定**长宽比优先**（横屏且 ≥600px 分栏、竖屏一律单列）；设置页「聊天页面强制左右分栏」开关；自检页「聊天布局诊断」一键读数（宽高/长宽比/左栏滚动数据）；适配 QwenPaw 宿主自研前缀（ant-/qwenpaw- 类名双写），宿主内嵌面板下分栏真实可用
- **Worker 会话状态灯**：蓝（运行中·呼吸）/ 绿（近 10 分钟完成）/ 灰（空闲），房间卡 / Worker 行 / 1:1 聊天头三处显示（心跳优先，typing 实时回退）
- 消息刷新改 **/sync 事件驱动**（替代粗轮询）
- 房间卡：最后消息预览 + 成员列表折叠（「N 人」展开/收起）

**知识图谱**
- **2D v4 簇块布局**；滚轮缩放（光标锚点 0.25×–8×）/拖拽平移/簇聚焦/簇分离/复位
- **簇重叠根因修复**（行堆叠累计 + CJK 字宽加权）+ 空白拖拽平移接线（此前拖拽无效）
- 3D 力参数与 dashboard 定值对齐；敏感文件规则扩展（credentials.yaml/yml 等直读 404）

**工作流**
- 卡片/拓扑视图 **master-detail 重构** + 自上而下分层 DAG（就绪高亮 / 外部依赖注记）
- tab 可见期 **15 秒自动刷新**（切走即停）；任务巡检抽屉（当前 Worker / 最新产物 / 状态时间线 / 耗时）
- **聊天内工作流卡 live 刷新**（权威源 15s overlay + LIVE 徽标；降级轨不显徽标）
- 拓扑/看板任务详情：产物**「查看」**（内联预览：md/图片/文本，与「下载」并列； 9/19 对齐 dashboard）

**模型网关**
- **「添加提供商 / 添加路由」写操作**（Console 会话透传；失败时 Console 错误信息直显）
- 只读模型网关配置 tab（Provider / AI Routes / 模型映射）+ 可请求模型 alias 全集聚合
- 模型网关只读路由目录（运维 tab，L1；Controller 版本门控 404 自动隐藏）

**团队管理与权限**
- L2 数据面兜底：本团队知识库只读（日记 / 知识库 / MEMORY.md）+ Worker 审批读写（OFF 档仍 L1）
- 新建 Worker：行情更新（移除 CoPaw、补 DeepSeek Harness、默认 QwenPaw）+ 从建队卡独立成卡
- CRD 管理：导出 JSON（四类全量）+ 卡片紧凑化 + 品牌 logo 替换 🏢
- 快捷操作三卡（员工入职 / 创建团队 / 新建 Worker）**同排一行 + 可折叠**（9/19）
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

**分栏根因（宿主前缀）：qwenpaw-tabs-* 高度链补齐**

- **真机复现台确认**（宿主实测）：宿主是 **自家前缀的 antd 分支**——`.ant-tabs-*` 类名在真宿主一个都不存在（实际为 `qwenpaw-tabs-content-holder/content/tabpane-active`）→ 12.10/12.11 的整条高度链 CSS 在真机从未命中：左栏被 74 个房间撑到 **8193px**、外层容器滚动（「整页滚动」）、左栏自身无滚动（「滚轮放上去不动」）——4 轮复报的确证根因。
- 修复：高度链 + 防撑链 + 575px 单列规则全部**双前缀双写**（ant- 与 qwenpaw-）；真机复测：左栏 300×488 有界、末卡 8208→504px 内部滚动、容器盒不动。
- 保留 12.14 的阈值/强制开关/自检诊断（宽度判定另有其功：宿主容器 990px）。

**Verification**: tsc 0 · check-antd 38 · vite build 绿 · pytest 46/46 · **本机真宿主实测（QwenPaw 2.2.1 console）**

---

## 0.5.0-beta.12.14（2026-09-19）

**聊天分栏三件套：阈值 600 + 强制开关 + 自检诊断**

- **分栏阈值 1024→600**（按容器实际宽度）：多轮「无分栏」= 宿主面板/窄窗下 1024 判定恒为窄屏；600 以下 = 手机竖屏语义，之上 = 左右分栏。
- **配置页新增「聊天页面强制左右分栏」**：忽略宽度判定，任何宽度都分栏（窄面板可拖宽/⟨ 收列表）。
- **自检页新增「聊天布局诊断（客户端）」**：window/容器宽高、模式+阈值+是否强制、左栏可视高/内容高/overflowY —— 分栏/滚动问题的数字，一键复测。
- 真机复现台实测：900px → 分栏；500px → 窄屏；强制开关 → 500px 也分栏；诊断数字准确。

**Verification**: tsc 0 · check-antd 38 · vite build 绿 · pytest 46/46

---

## 0.5.0-beta.12.13（2026-09-19）

**模型页写面（添加提供商/添加路由）+ 分栏判定容器化**

- **「添加提供商 / 添加路由」（P7b）**：模型页新增两个写操作，字段与 dashboard models-section 同款（provider = name/type/protocol/tokens/rawConfigs{openaiCustomUrl,pathPrefix,modelMapping}/tokenFailoverConfig；route = name/pathPredicate(PRE)/upstreams[]/modelPredicates[]/authConfig）；经连接器 `/gateway/*` POST 透传到 Higress Console（console_session），Console 错误信息（如 409 冲突）直接透到界面。
- **分栏判定改「容器实际宽度」**（复报排查）：宽屏/窄屏判定从 `window.innerWidth` 改为 ResizeObserver 监听容器——宿主内嵌面板窄于窗口时不再误判宽屏；另经真机复现台（真实前端 × fixture 数据）验证左栏独立滚动成立（末位房间 5210→542px，左栏盒不动）。
- 连接器写面新增 4 条回归测试（POST 透传/无会话守卫/name 守卫/Console 详情透出）。

**Verification**: tsc 0 · check-antd 38 · vite build 绿 · pytest 46/46 · 真机复现台 UI 冒烟（创建链路成功消息 + 列表刷新）

---

## 0.5.0-beta.12.12（2026-09-19）

**「簇重叠」根因修复（双端同款）+ 鼠标拖拽接线**

- **2D 图谱簇块行堆叠（根因）**：原 `yTop = ri *（本行最大高 + 间距）` 在行高不等时跨行重叠（数值复现：块重叠 588×104px；30 数据集 fuzz：旧公式 1027 对 chip 重叠 → 新公式 0）——改为累计行高，行行相扣。
- **鼠标拖拽平移接线**：`onSvgPanMove` 原定义未挂到 SVG（mousedown 后 move 空转，「空白处拖动画板」失效）——接线 + 拖拽中悬停停更。
- dashboard 侧同步修复（同款行堆叠 + CJK 字宽移植），双端 2D 观感一致。

**Verification**: tsc 0 · check-antd 38 · vite build 绿 · pytest 42/42 · 布局 fuzz 30 数据集零重叠

---

## 0.5.0-beta.12.11（2026-09-19）

**分栏独立滚动真修复（补 12.10 高度链最后一跳）**

- **聊天分栏左右独立滚动补强**：12.10 只锁了 antd Tabs 的 CSS 高度链；但内容区容器未 flex 化 → Tabs `flex:1` 空转、整链塌陷，左栏独立滚动仍失效（复报）。本版补齐：内容区容器 `display:flex` + 面板 `overflow-y:auto` 回退滚动，高度链真正接通。
- 其余内容与 12.10 一致。

**Verification**: tsc 0 · check-antd 交叉通过 · vite build 绿 · pytest 42/42

---

## 0.5.0-beta.12.10（2026-09-19）

**反馈批：聊天分栏独立滚动 + 拓扑详情三区 + 2D 图谱字宽修复 + 模型页全套展示**

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
- **Worker 会话状态灯（heartbeat-first）**：三态（蓝 running 呼吸/绿 done/灰 idle）显示在群聊消息发送者头像 + 宽屏分栏布局；数据源 = worker 心跳 agentStatus 权威（无 120s typing 上限）→ typing 实时回退 → 10 分钟 done→idle 衰减
- **聊天 /sync 事件驱动刷新**：消息刷新由 Matrix /sync 长轮询驱动（替代粗轮询），分栏宽度/折叠参数化
- **模型网关配置 tab（只读）**：与 dashboard 同源的 AI 网关模型配置视图（Provider/AI Routes/模型映射，只读）

**Verification**: union 四步门全绿（pytest 全过 · tsc 0 · check-antd 交叉 · vite build 绿 · i18n 对账）

---

## 0.5.0-beta.12.8（2026-09-18）

**2D 知识图谱缩放/聚焦/簇分离 + 聊天内工作流卡 live 刷新（与 dashboard 对齐）**

- **2D 知识图谱缩放/平移**：滚轮以光标为锚点缩放（0.25×–8× 钳制，越界以视野中心为锚回缩）+ 拖拽平移 + ＋/－/⟳ 复位按钮；高倍（>2.5×）自动标签薄化（只留簇根 + 悬停标签，SVG 文字等比放大防糊）
- **2D 知识图谱簇聚焦**：单击 virtual 簇根（分类根/Worker 根）→ 视野动画收敛到该簇 bbox（320ms easeOutCubic）+ 簇外元素淡出 0.1 +「🎯 退出聚焦」chip；双击文件节点 → 邻域聚焦（节点 + 一度邻接）；无根图谱中双击伪根（度数最高文件）→ 其扇区聚焦（伪根单击仍开文件预览，语义不变）；Esc / 点背景 / chip / ⟳ 退出
- **2D 知识图谱簇分离**：扇区间留 GAP 空白楔（扇区数 R≤6: 0.38rad / >6: 0.24rad，2×半角+GAP=整圆恒等——修旧公式 R≥8 时相邻扇区弧带重叠）+ 虚线扇区边界弧（hub 色 14% 透明）；R=1 单扇区=整圆均布（废旧 0.92 系数空楔）
- **聊天内工作流卡 live 刷新**：项目工作流卡是一次性发布的快照，任务推进只发生在 Controller 侧 → 卡片恒旧。现聊天 tab（活动房间消息含 workflow 卡时）复用工作流 tab 的 15s 权威源轮询（Controller projects/workflow 双轨）做 overlay：状态/步骤/参与 Worker 逐字段优先权威源、回退快照，LIVE 徽标（绿点脉冲 + 事件时间戳）仅权威源轨接通时显示；权威源降级（无 Controller token，走已加入房间扫描轨）时传空=不 overlay 不显徽标（不误导）；workerflow 卡（子代理 fan-out）消息本体靠 m.replace 已实时 → 零额外请求
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

**知识库 3D 图谱间距与 dashboard 定值对齐**

- **知识库 3D 图谱力参数收紧**：电荷 -108→-60、连线距离 72→44、连线强度 0.46→0.5——与 dashboard 知识库 3D 图谱经的参数同款（原值下节点间距偏大、连线稀疏），2D/3D 图谱布局、点节点预览等交互不受影响

**Verification**: pytest 42/42 · tsc 0 · vite build 绿（dist/index.js 单文件）· check-antd 交叉通过

---

## 0.5.0-beta.12.5（2026-09-18）

**L2 权限面补全 + 模型网关可视 + 工作流自动刷新（对齐 dashboard 实时性）**

- **模型网关只读路由目录（运维 tab，L1）**：新增「模型网关路由」卡片——路由名（=网关 `/v1` 入口，非模型 ID）/ 上游 provider+权重 / 授权 consumer，数据来自 Controller 只读端点（token 鉴权，token 模式 L1 也可读）；Controller 低于该端点版本时 404 自动隐藏整卡，L2 调用显权限提示。token 模式下模型下拉仍只列内置 alias + 本地 SGLang（网关 alias 编辑需 Console 密码路径），本卡片提供网关路由配置的只读可视
- **知识库 L2 可读（Controller 数据面兜底）**：团队 scope 用户（L2）此前读 KB 恒 403（KB 走 Docker 代理，L1-only）。现 Docker 通道不可用时自动切 Controller workspace-files 端点：日记（memory/**）/ 知识库（digest/**）/ MEMORY.md（档案）三分类，本团队 scope；档案其它文件与「文件」分类仍 L1-only。L1 全四分类行为不变（Docker 优先）
- **审批 L2 可读写（Controller 数据面兜底）**：L2 此前读写 Worker 审批恒 403。现 Docker 不可用时切 Controller approval 端点：L2 可设 严格/智能/自动（关闭 OFF 需 L1）；team leader 只读；Manager 审批仍 L1-only（无对应端点）
- **工作流 tab 自动刷新**：tab 可见期 15 秒静默轮询（切走即停），对齐 dashboard 的 15s 轮询实时性——此前工作流看板只在挂载/手动刷新/登录时拉取，任务推进不自动更新
- **注释与文案精确化**：频道接入 / 技能目录两处的「上游未合并」措辞更新为「Controller 版本门控」（相关端点已合入上游主线，仅低于合并版本的 Controller 才 404 占位）

**验证**：pytest 42/42（+6 新：KB/审批 L2 兜底 ×6）· tsc 0 · vite build 绿（439 模块）· i18n ui↔dict 对账（新键全登记、孤儿键清零）

---

## 0.5.0-beta.12.4（2026-09-15）

**新功能：Worker session 运行指示（零后端改动）**
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
- 「新建 Worker」从建队卡内折叠区独立成卡：建队卡聚焦团队字段，Worker 卡始终可见；行为不变（创建成功仍自动加入建队表单成员行）
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
