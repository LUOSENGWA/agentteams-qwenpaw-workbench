// creds 域 i18n 字典（自 i18n.ts 按域拆分）：凭据网关（地址凭据/Controller/Higress/Matrix 认证/L1-L2 双轨）。

export const credsDict: Record<string, { en: string }> = {
  // ── 地址手动固定档（address_mode）+ 事件流连接态（S1-4）──
  "地址模式（内网/外网切换策略）": { en: "Address mode (LAN/WAN switching)" },
 // 控制台特效安抚开关。
 // 特效三档（取代旧 console_calm 开关键）。
  "控制台特效质量": { en: "Console effects quality" },
  "轻量（默认：动画保留，模糊半径封顶，省 GPU）": { en: "Light (default: animations kept, blur radius capped, GPU-friendly)" },
  "关闭特效（最省电：动画与模糊全停）": { en: "Off (most power-saving: all animations and blur stopped)" },
  "完整特效（上游原样，最费 GPU）": { en: "Full (upstream as-is, heaviest GPU)" },
  "特效档已保存并即时生效": { en: "Effects tier saved and applied immediately" },
  "特效档保存失败，请重试": { en: "Failed to save effects tier; please retry" },
 // Higress 地址并入地址配置区——新增分节标题键。
  "Higress Console 地址（模型管理面；内网/外网按序降级）": { en: "Higress Console addresses (model admin plane; LAN/WAN tried in order)" },
  // 
  "内网和外网是同一服务器的两条访问路径（家里用内网 IP，外出用公网域名），无需手动切换——插件每 2 分钟自动重测全部地址（测延迟），自动切到最快可达的一条，外网/内网切换自动识别。": { en: "LAN and WAN are two paths to the same server (LAN IP at home, public domain away) — no manual switching: the plugin re-tests all addresses every 2 minutes (latency) and keeps the fastest reachable one." },
  "访问地址": { en: "Access Addresses" },
  "认证与登录": { en: "Authentication & Login" },
  "开启后首页/运维页显示各 DP rank 的排队/运行/显存负载（SGLang /v1/loads）。内网/外网是同一集群的两条访问路径，插件自动探测最快可达的一条。没有本地部署模型的用户保持关闭——零痕迹。": { en: "When enabled, the home/ops pages show per-DP-rank queue/running/memory load (SGLang /v1/loads). LAN/WAN are two paths to the same cluster — the plugin picks the fastest reachable one. Keep it off if you have no local model cluster — zero footprint." },
  "导出配置含全部地址但不含密码/token（显示为 ***）——导入不会覆盖现有凭据。诊断包 = 脱敏配置 + 自检结果，用于排查问题时交给管理员。": { en: "Config export contains all addresses but no passwords/tokens (shown as ***) — importing never overwrites existing credentials. The diagnostic package = redacted config + self-check results, for handover to your admin when troubleshooting." },
  "聊天页面": { en: "Chat Page" },
  "集群负载（可选模块）": { en: "Cluster Load (optional module)" },
  "L1 专属——只有部署了本地 SGLang 推理集群才需要开启": { en: "L1 only — enable only if you run a local SGLang inference cluster" },
  "Matrix 登录": { en: "Matrix Login" },
  "自动（默认：最快可达自动切换）": { en: "Auto (default: switch to fastest reachable)" },
  "固定内网（失败不自动切换）": { en: "Pin LAN (no auto-failover on failure)" },
  "固定外网（失败不自动切换）": { en: "Pin WAN (no auto-failover on failure)" },
  "固定档下后台探测照跑（连通性测试仍可见另一条路径状态），但请求不再自动切换；失败会明确报错。": {
    en: "In pinned mode the background probe keeps running (connectivity test still shows the other path), but requests no longer auto-switch; failures report an explicit error.",
  },
 // 地址模式变更即自动落盘——替换 14.7 的
  // 「需点保存生效」提示串，并新增保存成功/失败两条 toast 串。
  "切换即自动保存并生效。固定档下后台探测照跑（连通性测试仍可见另一条路径状态），但请求不再自动切换；失败会明确报错。": {
    en: "Switching auto-saves and takes effect immediately. In pinned mode the background probe keeps running (connectivity test still shows the other path), but requests no longer auto-switch; failures report an explicit error.",
  },
  "地址模式已保存并即时生效": { en: "Address mode saved and applied" },
  "地址模式保存失败，请重试": { en: "Failed to save address mode; please retry" },
  "固定": { en: "Pinned" },
  // ── 地址覆盖凭据（公网 Basic 门 / API key 门）──
  // 「none」label 加清除语义（旧版 label 已退役）。
  "使用服务自身认证（内网默认，留空即用；选此项=清除该地址已存凭据）": { en: "Use the service's own auth (LAN default — leave empty; picking this clears saved credentials for this address)" },
  "Basic 认证（公网网关 Basic 门，如 Caddy）": { en: "Basic auth (public gateway Basic gate, e.g. Caddy)" },
  "API Key（Bearer，公网网关 API key 门，如 Higress）": { en: "API key (Bearer; public gateway key gate, e.g. Higress)" },
  "API Key（Bearer token）": { en: "API key (Bearer token)" },
  "用户名（与网关一致）": { en: "Username (matching the gateway)" },
  "密码（与网关一致）": { en: "Password (matching the gateway)" },
  // ── ：空框=保持不变 占位 + 状态总览 ──
  "密码（已保存 · 留空保持不变）": { en: "Password (saved — leave blank to keep)" },
  "API Key（已保存 · 留空保持不变）": { en: "API key (saved — leave blank to keep)" },
  "Controller token": { en: "Controller token" },
  "Controller 地址凭据": { en: "Controller address credential" },
  "Higress 账号（Console 会话）": { en: "Higress account (Console session)" },
  "Higress 地址凭据": { en: "Higress address credential" },
  "SGLang 地址凭据（通常不需要）": { en: "SGLang address credential (usually not needed)" },
  "SGLang 通常不需要凭据（本地推理服务自身无认证）——仅当访问地址经公网网关 Basic 门时填写，默认留空。": {
    en: "SGLang usually needs no credential (a local inference service has no auth of its own) — fill only when the address is behind a public gateway Basic door; leave empty by default.",
  },
  "事件流：已连接": { en: "Event stream: connected" },
  "事件流：已断开——自动重连中（上次断开 {time}）": {
    en: "Event stream: disconnected — auto-reconnecting (last down {time})",
  },
  "详情": { en: "Detail" },
  "测试目标": { en: "Target" },
  "分步过程": { en: "Steps" },
  "完整原始异常": { en: "Raw exception" },
  "客户端环境": { en: "Client env" },
  "测试时间": { en: "Tested at" },
  "全部成功（无异常）": { en: "All OK (no exception)" },
  "代理环境变量": { en: "Proxy env" },
  "（未设置）": { en: "(not set)" },
  "逐个地址测延迟（失败重试一次），识别外网/内网，测完自动切到最快；后台按状态自适应重测（稳定时低频、单地址不探测）": {
    en: "Measures latency per address (one retry on failure); auto-switches to the fastest after testing; background re-probes adaptively (low freq when stable, none for single address)",
  },
  "已自动切换到最快可达": { en: "Auto-switched to the fastest reachable" },
  "当前生效地址已是最快，无变化": {
    en: "Current effective address is already the fastest — no change",
  },
  "测的是未保存的地址——保存后自动按延迟切换生效": {
    en: "Tested unsaved addresses — auto-switching by latency takes effect after saving",
  },
  "最后消息": { en: "Last message" },
  "当前只显示你已加入房间的项目": { en: "Only showing projects in rooms you've joined" },
  "——Controller 正源未接通（token 未配置或无效）。配置页填入 controller_token（L1）后可查看全部项目（含 Leader 创建、你不在其房间内的）": {
    en: "— Controller primary source not connected (token missing or invalid). Set controller_token (L1) on the Settings page to see all projects (including Leader-created ones whose room you're not in)",
  },
  "——Controller 未升级到含 workflow API 的版本（404）": {
    en: "— Controller not upgraded to a version with the workflow API (404)",
  },
  "——Controller 正源不可用": { en: "— Controller primary source unavailable" },
  "项目产物（Controller 正源）未接通": {
    en: "Project artifacts (Controller primary source) not connected",
  },
  "——token 未配置或无效。配置页填入 controller_token（L1）后可见全部项目产物（含 Leader 创建、你不在其房间内的）": {
    en: "— token missing or invalid. Set controller_token (L1) on the Settings page to see all project artifacts (including Leader-created ones whose room you're not in)",
  },
  "——Controller 未升级到含项目产物的版本（404），当前只显示房间附件": {
    en: "— Controller not upgraded to a version with project artifacts (404); showing room attachments only",
  },
  "——Controller 请求失败，当前只显示房间附件": {
    en: "— Controller request failed; showing room attachments only",
  },
  "（Controller 的 MinIO 客户端 mc 别名异常——需在 Controller 宿主机重新注册 mc 别名，自检 L2 有指引）": {
    en: "(Controller's MinIO client (mc alias) is broken — re-register the mc alias on the Controller host; see self-check L2)",
  },
  "发起任务 · 选择 Leader": { en: "New Task · Pick a Leader" },
  "选 Leader 派发新任务": { en: "Pick a leader to dispatch a task" },
  "跨团队": { en: "Cross-team" },
  "跨团队入口": { en: "cross-team entry" },
  "未找到 Leader（团队结构未加载或 Controller 未接入）。请先到配置页检查 Controller 连接，再重新打开本弹窗。": {
    en: "No leaders found (team structure not loaded or Controller not connected). Check the Controller connection on the Settings page and reopen this dialog.",
  },
  "已创建私聊，等待对方接受邀请": {
    en: "DM created, waiting for the other side to accept the invite",
  },
  "房间创建返回成功但未出现在房间列表（homeserver 配置可能错位），请检查配置后重试": {
    en: "Room creation reported success but the room is missing from the room list (homeserver config may be misaligned). Check settings and retry.",
  },
  "自动刷新 30 秒": { en: "Auto-refresh 30s" },
  "运行时版本": { en: "Runtime version" },
  // （F4：SGLang 卡「要手动刷新才更新」观感真根因=标注
  // 误导——卡片标「自动刷新 1 秒」但数据源是 SGLang 侧快照发布，服务端
  // 默认 15s 才出新值，数字冻结 14s 被误判卡死、手动刷新又读同一快照。
  // 改双节奏标注：刷新（1s/15s 自适应检查）× 数据（~15s 快照，服务端参数
  // 可调）分开说清。
  // 14.26 的「数据快照 ~15s」
  // 标注错误（参数单位误读）——SGLang 快照忙态 ≥1Hz；卡片慢档 15s→5s，
  // 副标改检查节奏 + 快照年龄（新鲜度自证）。
  "自动刷新（活跃 1s / 稳定 5s）": {
    en: "Auto refresh (1s active / 5s idle)",
  },
  // 14.34：「快照 N 秒前」age 文字在 1s 轮询下恒显 0、无可感知性（用户
  // 点名删）——改绿点脉冲（每帧亮一次），tooltip/提示键同步换新。
  "每收到一帧负载快照亮一次——正在实时刷新": {
    en: "Lights up once per load snapshot — refreshing live",
  },
  "SGLang 每 DP rank 排队/运行/显存（可选模块——配置页开启并填 SGLang 地址）。卡片按数据变化自适应检查：负载在变 1s 一轮，稳定 5s 一轮。绿点每收到一帧快照亮一次=正在实时刷新。": {
    en: "SGLang queue/running/GPU per DP rank (optional module — enable and set the SGLang address on the Settings page). The card adapts its check cadence to data: 1s while load changes, 5s when stable. The green dot lights up once per snapshot = refreshing live.",
  },
  "点击展开": { en: "Click to expand" },
  "私聊 {name}": { en: "DM {name}" },
  "暂无活跃会话——接入 spawn 端点后显示": {
    en: "No active sessions — shown once the spawn endpoint is connected",
  },
  "工具白名单": { en: "Allowed tools" },
  "技能白名单": { en: "Allowed skills" },
  /* 补录 beta.13 收尾新增 UI 的漏登记词条（此前 EN 回退中文）。 */
  "展开快捷操作（员工入职 / 创建团队 / 新建 Worker）": {
    en: "Expand quick actions (onboard employee / create team / new worker)",
  },
  "收起快捷操作（员工入职 / 创建团队 / 新建 Worker）": {
    en: "Collapse quick actions (onboard employee / create team / new worker)",
  },
  "忽略宽窄判定：房间列表与聊天框始终左右分栏、各自独立滚动。窄面板下可用拖动条调宽、⟨ 可收起列表。": {
    en: "Ignore aspect-ratio heuristic: room list and chat pane always split left/right with independent scrolling. On narrow panels drag the handle to resize; ⟨ collapses the list.",
  },
  "spec": { en: "Spec" },
  "管理数据获取失败（连续 {n} 次）": {
    en: "Admin data fetch failed ({n} consecutive)",
  },
  "拓扑来自公开接口；CRD 管理表需要 Controller 管理接口——检查 Controller 地址与 token 后重试。": {
    en: "Topology comes from the public endpoint; the CRD tables need the Controller admin API — check the Controller address and token, then retry.",
  },
  "管理数据加载中——团队/用户/Manager 全量状态": {
    en: "Loading admin data — teams/users/managers",
  },
  "自检": { en: "Self-check" },
  "运维": { en: "Operations" },
  "配置": { en: "Settings" },
  "登录": { en: "Sign in" },
  "刷新": { en: "Refresh" },
  "加载中…": { en: "Loading…" },
  "模型网关路由": { en: "Model gateway routes" },
  "授权 consumer": { en: "Authorized consumers" },
  "频道接入 API 不可用（Controller 版本较低）": {
    en: "Channel API unavailable (Controller version too low)",
  },
  "当前 Controller 版本（< 合并频道端点的版本，如 v1.2.3）无此 API。升级 Controller 后本节自动点亮（schema 驱动表单，零 per-channel 代码）。": {
    en: "Current Controller version (< the one that merged the channel endpoints, e.g. v1.2.3) lacks this API. After upgrading the Controller this section lights up automatically (schema-driven forms, zero per-channel code).",
  },
  "Worker 状态": { en: "Worker state" },
  "容器状态": { en: "Container state" },
  "团队群（{n}）": { en: "Group chat ({n})" },
  "下次打开插件时先看到哪里": { en: "What you see first when the plugin opens next time" },
  "暂无工作流事件": { en: "No workflow events" },
  // 工作流首载状态机（冷启动空快照不渲染
  // 空表格；3s 自动重试 ≤180s，超时留手动重试提示）。
  "首次聚合中（自动刷新）…": {
    en: "First aggregation in progress (auto-refreshing)…",
  },
  "暂无可显示的工作流；可点击右上刷新重试": {
    en: "No workflows to show yet; click Refresh to retry",
  },
  "循环任务": { en: "Loop tasks" },
  "已发送 {n} 个文件": { en: "{n} file(s) sent" },
  // ── ──
  "① Controller 认证（管理面：CRD/全量视图/日志）": {
    en: "① Controller auth (admin plane: CRD / full view / logs)",
  },
  "Controller 只认 SA token 与 Matrix token（Matrix 路径只放行 L2/L3 只读，L1 明确 401，无密码登录端点）——admin 能力只能来自管理员 token。": {
    en: "Controller only accepts SA tokens and Matrix tokens (the Matrix path allows L2/L3 read-only; L1 explicitly 401s; there is no password login endpoint) — admin capability can only come from the admin token.",
  },
  "Higress Console 自己的账号体系（admin 账号+密码），与 Controller 认证互不相关、可各自独立配置。": {
    en: "Higress Console has its own account system (admin username + password), unrelated to Controller auth — each can be configured independently.",
  },
  "「Matrix 登录」= AgentTeams 消息系统账号（与上方 Matrix 地址同一账号，L2 只读）；与 QwenPaw 页面自身的登录是两回事，不冲突。": {
    en: "“Matrix login” is the AgentTeams messaging-system account (the same account as the Matrix address above, L2 read-only) — it is a different thing from the QwenPaw page login itself; they do not conflict.",
  },
  "使用当前登录的 Matrix 账号，无需 token。注意：Controller 的 Matrix 认证只接受权限等级 2（level 2）的 Human 账号——level 1 的 admin 账号会 401，请改用管理员 token 模式，或让部署管理员把该 Human 改为 level 2（权限自检可见当前账号等级）。": {
    en: "Uses the logged-in Matrix account, no token needed. Note: the Controller's Matrix auth only accepts Human accounts with permissionLevel=2 — a level-1 admin account gets 401. Use admin-token mode, or ask the deploy admin to set that Human to level 2 (the permission self-check shows the current level).",
  },
  // ── ──
  "Controller L1 全量": { en: "Controller L1 full" },
  // ── L1 双轨（Controller token / Higress Console 账号，两块独立）+ 网关 alias + 运行时 ──
  /* ：
 术语纠偏——「Controller 数据面」是 Higress 的平面词汇误用到 Controller 上
 （Controller 只有管理 API，没有数据面；数据面=Higress 6867）；「Console
 会话」补 Higress 前缀防与 QwenPaw console 混淆。 */
  "① Controller 管理员 token": { en: "① Controller admin token" },
  "admin 账号（如 admin）": { en: "admin account (e.g. admin)" },
  "验证": { en: "Verify" },
  "验证通过（{mode}）": { en: "Verified ({mode})" },
  "admin 账号密码（Higress Console 会话已持有）": { en: "admin account + password (Higress Console session held)" },
  "管理员 token": { en: "admin token" },
  "验证失败：{err}": { en: "Verification failed: {err}" },
  "验证通过后自动保存（仅建立 Higress Console 会话；与 Controller token 无关，两者可同时配置）": { en: "Saved automatically once verification passes (establishes only the Higress Console session; independent of the Controller token — the two can be configured together)" },
  "Higress alias（路由可解析）": { en: "Higress alias (route resolvable)" },
  "在服+在用": { en: "Serving + in use" },
  "模型（留空=跟随集群默认；下拉=在服∪在用∪Higress alias）": { en: "Model (empty = cluster default; dropdown = serving ∪ in-use ∪ Higress alias)" },
  "模型（留空=不改；新建跟随集群默认；下拉=在服∪在用∪Higress alias）": { en: "Model (empty = unchanged; new = cluster default; dropdown = serving ∪ in-use ∪ Higress alias)" },
  "多运行时": { en: "Runtimes" },
  "Workers": { en: "Workers" },
  "运行时": { en: "Runtime" },
  "说明": { en: "Description" },
  // ── ──
  // token 文件路径删除（保留命令形式）——
  // 获取命令 + 粘贴 + env。
  "获取命令（在 Controller 宿主机执行，复制输出粘贴到下方）：": { en: "Fetch command (run on the Controller host, copy the output and paste it below):" },
  "非 docker 部署：部署期给 QwenPaw 进程注入环境变量 AGENTTEAMS_CONTROLLER_TOKEN（注入值优先于粘贴值需重贴才覆盖）。": { en: "Non-docker deployments: inject the AGENTTEAMS_CONTROLLER_TOKEN env var into the QwenPaw process at deploy time (pasted values take precedence over env)." },
  "粘贴 token 内容（见上方获取命令；部署期注入 env 时留空即可）": { en: "Paste the token content (see the fetch command above; leave empty when env-injected)" },
  "当前使用 QwenPaw 宿主环境变量 AGENTTEAMS_CONTROLLER_TOKEN（手动粘贴的值优先。）": { en: "Using the QwenPaw host env var AGENTTEAMS_CONTROLLER_TOKEN (a manually pasted value takes precedence.)" },
  "token 内容含非法字符（复制时混入不可见字符）——重新复制纯 ASCII 内容，或改用 env 注入。": { en: "Token contains invalid characters (invisible chars mixed in when copying) — re-copy pure ASCII content, or use env injection." },
  /* 六件新增键（工作流中断横幅任务定位 /
 引用条按需加载 / 项目文件面板重构 / 下载反馈）。 */
  "任务 {n}": { en: "Task {n}" },
  "正在加载…": { en: "Loading…" },
  "加载原消息": { en: "Load original message" },
  "原消息不在可加载历史": { en: "Original message not in loadable history" },
  "该项目工作流拉取失败": { en: "Failed to fetch this project's workflow" },
  "该项目暂无已声明的文件（任务完成并产出结果后会显示）": { en: "This project has no declared files yet (they will appear after tasks produce results)" },
  "未获取到任何项目工作流（Controller 未连通或无注册项目）——点刷新重试": { en: "No project workflows retrieved (Controller unreachable or no registered projects) — click refresh to retry" },
  "当前房间项目": { en: "Current room's project(s)" },
  "当前房间无直接关联项目（项目可能从 QQ 等其他通道发起，或尚未在 Controller 注册）": { en: "No projects directly linked to this room (a project may have been started from another channel such as QQ, or is not yet registered in the Controller)" },
  "下载失败，请稍后重试": { en: "Download failed, please try again later" },
  // Higress 双地址（旧单值键已删——代码引用清零）。
  "Higress 地址·内网（Console 管理面；宿主端口部署时自选，默认 18001）": { en: "Higress URL · LAN (Console admin plane; host port chosen at deploy time, default 18001)" },
  "Higress 地址·外网（公网入口，可留空；内网不可达时自动降级）": { en: "Higress URL · WAN (public entry, optional; auto-fails over when LAN is unreachable)" },
  /* L669 此前无 en 条目（en 界面显示中文）——补条目，
 并修「模型网关都依赖它」= Controller/Higress 混淆（模型网关=Higress
 数据面，与 Controller 地址无关）。 */
  "Controller 地址（L1/CRD 管理/Worker/Team 状态依赖；不填仅房间侧功能）": { en: "Controller URL (L1 / CRD management / Worker & Team status depend on it; without it only room-side features)" },
  "token 模式无 Higress Console 会话——Higress alias 层当前不可见。配置 admin 账号密码后，「Higress alias（路由可解析）」与「Higress 内置 alias」分组将出现在模型下拉中；或等待上游支持 controller_token 直连 Higress Console 的 PR 合入。": { en: "Token mode has no Higress Console session — the Higress alias layer is currently hidden. After configuring the admin account + password, the 'Higress alias (route resolvable)' and 'Higress built-in alias' groups will appear in the model dropdown; or wait for the upcoming upstream PR (controller_token directly to Higress Console) to merge." },
  "token 模式无 Higress Console 会话——「Higress alias」分组当前不可见。配置 admin 账号密码后可读；或等待上游支持 controller_token 直连 Higress Console 的 PR 合入。": { en: "Token mode has no Higress Console session — the 'Higress alias' group is currently hidden. Configure the admin account + password to enable it; or wait for the upcoming upstream PR (controller_token directly to Higress Console) to merge." },
  "已打开 {target} 的个人房间": { en: "Opened {target}'s personal room" },
  "个人房间打开失败（{e}），回退新建 DM": { en: "Failed to open the personal room ({e}); falling back to a new DM" },
  "镜像": { en: "Image" },
  "个人房间": { en: "Personal room" },
  "私聊（个人房间）": { en: "DM (personal room)" },
  "日志（最近 300 行）": { en: "Logs (last 300 lines)" },
  "Worker 状态（Controller CR phase）": { en: "Worker status (Controller CR phase)" },
  "Worker 运行时（Controller CR runtime）": { en: "Worker runtime (Controller CR runtime)" },
  // #1233 事件流时间线（WorkflowEventsTimeline）。
  "事件流": { en: "Event stream" },
  // AgentActivityTrack（composer 上方任务进度+HITL 内联轨）。
  "点击打开项目工作流": { en: "Click to open the project workflow" },
  "任务 {done}/{total}": { en: "Tasks {done}/{total}" },
  "迭代 {cur}/{max}": { en: "Iteration {cur}/{max}" },
  "等待人工介入（{n}）": { en: "Awaiting human input ({n})" },
  "+{n} 更多": { en: "+{n} more" },
  "全部任务已完成（{n}）": { en: "All tasks completed ({n})" },
  // 团队配置弹窗完整化（13.20 团队的技能等团队配置也要放在团队配置里面）。
  "子代理默认模型（留空 = 继承各 Worker 主模型）": { en: "Subagent default model (blank = inherit each Worker's primary model)" },
  "子代理默认模型（如 qwen3.6:27b-fp8；留空 = 继承）": { en: "Subagent default model (e.g. qwen3.6:27b-fp8; blank = inherit)" },
  "团队技能（目录 / 分配矩阵 / MCP）": { en: "Team skills (catalog / assignment matrix / MCP)" },
  "技能/分配/MCP 的保存独立于上方「保存」按钮（走技能中心原端点）；L2 用户经「技能中心（我的团队）」入口，同能力、服务端限本团队。": { en: "Skill/assignment/MCP saves are independent of the Save button above (they use the Skill Center endpoints); L2 users go through the Skill Center (My Team) entry — same capabilities, server-side scoped to their own team." },
  // undo（删团队快照重建）。
  "团队 {name} 已删除（房间历史与容器状态不随之恢复）": { en: "Team {name} deleted (room history and container state are not restored)" },
  "撤销（按快照重建）": { en: "Undo (recreate from snapshot)" },
  "团队 {name} 已按快照重建": { en: "Team {name} recreated from snapshot" },
  "重建失败": { en: "Recreate failed" },
  // #1247 心跳态 UI（Worker 详情心跳任务运行态四字段）。
  "心跳态": { en: "Agent status" },
  "在跑任务": { en: "Running tasks" },
  "上次运行": { en: "Last run" },
  "上次完成": { en: "Last finished" },
  // DAG/Mermaid 合并——mermaid 专属键
  // （"Mermaid" / "DAG（交互）" / Mermaid DAG / mermaid 端点 404 / 渲染失败）
  // 随视图退役一并清除；拓扑 tooltip 更新为单一 DAG 语义。
  "项目列表/项目卡片/看板/拓扑 四种视图；项目卡片与拓扑为左侧项目列表+右侧详情（对齐 dashboard 任务看板「项目」区）；看板列映射与 dashboard 同源（workflow API）；拓扑依赖图=DAG（交互，节点点看任务；13.24 起单一视图，Mermaid 快照已合并退役）": { en: "Four views: project list / project card / board / topology; project card and topology are a left project list + right detail (aligned with the dashboard task board Projects area); board columns share the same source as the dashboard (workflow API); the topology dependency graph = DAG (interactive, click node to inspect; single view since 13.24 — the Mermaid snapshot was merged and retired)" },
  // 存量缺键补齐（CrdManage/模型设置 12.2-12.3 遗留，i18n 全量核对抓出）。
  "Higress alias 自检：{n} 条路由 / 0 个可解析 alias——精确匹配（EXACT/EQUAL）且 provider 存在的路由才会进模型下拉；若路由已配仍为 0，检查模型匹配规则是否为「精确匹配」": { en: "Higress alias self-check: {n} route(s) / 0 resolvable alias(es) — only EXACT/EQUAL routes with an existing provider reach the model dropdown; if routes exist but it is still 0, check that the model matching rule is set to exact match" },
  "Higress alias 自检：{n} 条路由 / {m} 个可解析 alias（模型下拉可见）": { en: "Higress alias self-check: {n} route(s) / {m} resolvable alias(es) (visible in the model dropdown)" },
  "Leader (team_leader)": { en: "Leader (team_leader)" },
  "Manager 模型已保存（重启容器后生效）": { en: "Manager model saved (takes effect after the container restarts)" },
  "SOUL（可选，多行，worker≤150 行）": { en: "SOUL (optional, multi-line, worker ≤150 lines)" },
  "Worker (worker)": { en: "Worker (worker)" },
  "{msg}": { en: "{msg}" },
  "名称 / 角色": { en: "Name / role" },
  "已保存（提示：{t}）": { en: "Saved (note: {t})" },
  "模型（留空=跟随集群默认）": { en: "Model (empty = follow cluster default)" },
  "留空=跟随集群默认": { en: "empty = follow cluster default" },
  "（{n} 条）": { en: "({n})" },
  "Controller 未部署事件流端点（需升级到含 #1233 的版本）": { en: "Controller has no event-stream endpoint yet (upgrade to a version containing #1233 required)" },
  "事件流加载失败": { en: "Failed to load event stream" },
  "（更早事件超出窗口，显示最近 2000 条）": { en: "(older events beyond the window; showing the latest 2000)" },
  "by": { en: "by" },
  // ── 设置页：Controller token 与 Higress 认证分家（15.24）──
  "L1 管理面（Controller 管理员 token）": { en: "L1 admin plane (Controller admin token)" },
  "② Higress Console 认证（模型面：alias/提供商/路由）——独立认证系统，与 ① Controller 认证互不相关": {
    en: "② Higress Console auth (model plane: aliases / providers / routes) — an independent auth system, unrelated to ① Controller auth",
  },
  "Higress Console 自己的账号体系（admin 账号+密码），与 Controller 认证互不相关、可各自独立配置。即使某部署中两者恰好同值，它们仍是两个不同系统的凭证——不可互相替代。": {
    en: "Higress Console has its own account system (admin account + password), unrelated to Controller auth and configurable independently. Even if both happen to be the same value in some deployment, they are credentials of two different systems — not interchangeable.",
  },
  "Matrix 登录（L2）：查看本账号可访问的团队 + 项目操作（启动/暂停/产物），日常够用。两套独立的 L1 认证：① Controller 管理员 token（L1 管理面模式内配置）——CRD 管理（入职/建队/改配/删除）+ 全部 Worker/Team 状态视图（Controller 唯一凭证，无接口获取——上游安全设计，部署管理员提供，粘贴一次永久记住）；② Higress 账号+密码（下方独立段配置，与 L1/L2 模式无关）——建 Higress Console 会话（模型下拉 alias 层）。两者是不同系统的凭证，互不替代、可同时配置。": {
    en: "Matrix login (L2): view teams this account can access + project operations (start / pause / artifacts) — enough for daily use. Two independent L1 auths: ① Controller admin token (configured in L1 admin mode) — CRD management (onboard / create team / edit / delete) + all Worker/Team status views (the Controller's only credential, no endpoint issues it — upstream security design; provided by the deployment admin, paste once and it is remembered forever); ② Higress account + password (configured in the standalone section below, independent of L1/L2 mode) — establishes a Higress Console session (model dropdown alias layer). They are credentials of different systems, not interchangeable, and can be configured together.",
  },
};
