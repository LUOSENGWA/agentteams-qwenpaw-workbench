// 千锻（Millforge）域 i18n 字典：建队表单折叠区（B）/ 团队管理「千锻注入」
// 对话框（C）/ 自定义团队 LLM 二次生成（D）。

export const millforgeDict: Record<string, { en: string }> = {
  // ── A 源切换 + pack ──
  "GitHub": { en: "GitHub" },
  "GitCode": { en: "GitCode" },
  "repo（org/repo）": { en: "repo (org/repo)" },
  "自定义仓库 URL（https）": { en: "Custom repo URL (https)" },
  "派生 URL": { en: "derived URL" },
  "源配置失败": { en: "Source configuration failed" },
  "更新": { en: "Update" },
  "模板包列表加载失败": { en: "Failed to load template packs" },
  "模板包（pack）": { en: "Template pack" },
  "选择已导入的模板包": { en: "Select an imported template pack" },
  "尚未导入模板包——先选择源并导入": {
    en: "No template pack imported yet — pick a source and import first",
  },
  "尚未导入模板包——选择源（GitHub / GitCode / 自定义）后点「导入」": {
    en: "No template pack imported yet — pick a source (GitHub / GitCode / custom) then click Import",
  },
  // ── B3 模板选择 ──
  "整队组合（可选，选中自动填成员比例/领域）": {
    en: "Full-team combo (optional; auto-fills member ratios/domains)",
  },
  "不选 = 按下方 industry/domains/members 组装": {
    en: "None = assemble from industry/domains/members below",
  },
  "行业（industry，单选）": { en: "Industry (single)" },
  "不选 = 通用": { en: "None = generic" },
  "领域（domains，多选）": { en: "Domains (multi)" },
  "不选 = 不附加领域片段": { en: "None = no domain fragments" },
  "整队组合的领域不属于所选行业——已清空 domains（可手动补选）": {
    en: "Combo domains don't belong to the selected industry — domains cleared (re-pick manually if needed)",
  },
  "成员（leader/workers/critic）": { en: "Members (leader/workers/critic)" },
  "Critic": { en: "Critic" },
  "合计 {n} 个角色": { en: "{n} role(s) in total" },
  "角色总数须 2-8": { en: "Total roles must be 2–8" },
  "实验": { en: "experimental" },
  "浏览模板条目（只读预览）": { en: "Browse template entries (read-only preview)" },
  "选择条目查看文件预览": { en: "Pick an entry to preview its file" },
  "选择左侧条目查看文件预览（只读）": {
    en: "Pick an entry on the left to preview its file (read-only)",
  },
  // ── B4 编译预览 ──
  "编译预览": { en: "Compile preview" },
  "编译（team_json）": { en: "Compile (team_json)" },
  "编译失败": { en: "Compilation failed" },
  "编译仅预览 SOUL——注入才写入 Worker CR": {
    en: "Compile only previews SOUL — injection writes to Worker CRs",
  },
  "编译预览（build {id} · {source}）": {
    en: "Compile preview (build {id} · {source})",
  },
  "模板": { en: "template" },
  "自定义（team_json）": { en: "custom (team_json)" },
  "行": { en: "lines" },
  "超支": { en: "over budget" },
  "超支：行数超出预算（须回模板层减片段或提预算走人审，否则不可注入）": {
    en: "Over budget: lines exceed the budget (reduce fragments or raise the budget via review, otherwise injection is blocked)",
  },
  "预算内": { en: "within budget" },
  "点击复制完整 sha256": { en: "Click to copy the full sha256" },
  "fragments 清单（{n}）": { en: "fragments ({n})" },
  "spawn-specs 清单（{n}）": { en: "spawn-specs ({n})" },
  "（无）": { en: "(none)" },
  // ── B5 注入 ──
  "更新已选 Worker": { en: "Update selected workers" },
  "新建 Worker 并注入": { en: "Create workers & inject" },
  "逐角色选现有 Worker（mapping）": {
    en: "Pick existing workers per role (mapping)",
  },
  "选择现有 Worker（不选 = 该角色不注入）": {
    en: "Pick an existing worker (none = skip this role)",
  },
  "新建 Worker 行（create_workers：name/role/model）": {
    en: "New worker rows (create_workers: name/role/model)",
  },
  "Worker 名": { en: "Worker name" },
  "模型（可选，留空跟随集群默认）": {
    en: "Model (optional; empty = cluster default)",
  },
  "core 技能打包（millforge-core，scope=team）": {
    en: "core skill packaging (millforge-core, scope=team)",
  },
  "写入 SOUL（mapping/新建行）": { en: "Write SOUL (mapping/new rows)" },
  "预算未全绿——后端将拒绝注入（回模板层减片段或提预算走人审）": {
    en: "Budget not all green — backend will refuse injection (reduce fragments or raise the budget via review)",
  },
  "注入到「{name}」": { en: "Inject into “{name}”" },
  "提交建队时自动执行：编译（若未编译）→ 千锻注入 → 创建团队": {
    en: "On team creation: auto compile (if not compiled) → Millforge inject → create team",
  },
  "注入失败": { en: "Injection failed" },
  "注入结果（全部成功）": { en: "Injection result (all succeeded)" },
  "注入结果（部分失败）": { en: "Injection result (partial failure)" },
  "注入部分失败——失败项见结果表，修正后再提交建队": {
    en: "Injection partially failed — see the result table for failures; fix and resubmit team creation",
  },
  "至少选择 1 个现有 Worker（mapping）": {
    en: "Select at least 1 existing worker (mapping)",
  },
  "请填写至少 1 个新建 Worker 名（create_workers）": {
    en: "Fill in at least 1 new worker name (create_workers)",
  },
  "Worker 名须小写字母/数字/-（≤64 字符）：{list}": {
    en: "Worker name must be lowercase letters/digits/- (≤64 chars): {list}",
  },
  "成功": { en: "OK" },
  "读回验证": { en: "read-back verified" },
  "更新 SOUL": { en: "update SOUL" },
  "新建 Worker": { en: "new worker" },
  "已挂接": { en: "attached" },
  "跳过": { en: "skipped" },
  "全部成功": { en: "all succeeded" },
  // ── C 对话框 + 历史 ──
  "千锻注入": { en: "Millforge inject" },
  "自定义团队": { en: "Custom team" },
  "注入历史（最近 50 条）": { en: "Injection history (last 50)" },
  "（暂无注入记录）": { en: "(no injection records yet)" },
  "整体": { en: "overall" },
  "新建": { en: "new" },
  "部分失败": { en: "partial failure" },
  // ── D 自定义团队（LLM 二次生成）──
  "成员（成员/任务类型/运行时 之一）": {
    en: "Members (one of members/task types/runtime required)",
  },
  "例：3 个前端工程师 + 1 个测试 + 1 个架构评审": {
    en: "e.g. 3 frontend engineers + 1 tester + 1 architecture reviewer",
  },
  "任务类型（members 缺省时必填）": {
    en: "Task types (required when members is empty)",
  },
  "例：React 组件开发、接口联调、回归测试": {
    en: "e.g. React component dev, API integration, regression tests",
  },
  "运行时（选填）": { en: "Runtime (optional)" },
  "团队名（选填）": { en: "Team name (optional)" },
  "留空用现有团队名": { en: "Empty = use current team name" },
  "最痛的 3 个问题（必填）": { en: "Top 3 pain points (required)" },
  "例：1) 联调环境不稳 2) 回归全靠人 3) 架构决策没记录": {
    en: "e.g. 1) unstable integration env 2) regression all manual 3) architecture decisions undocumented",
  },
  "生成提示词": { en: "Generate prompt" },
  "把提示词发给 LLM，将其返回的 JSON 粘回下方「校验」": {
    en: "Send the prompt to an LLM, then paste its returned JSON below to validate",
  },
  "生成提示词失败": { en: "Failed to generate prompt" },
  "提示词（发给 LLM）": { en: "Prompt (send to LLM)" },
  "LLM 返回的 JSON（粘贴）": { en: "JSON returned by the LLM (paste)" },
  "粘贴 LLM 返回的 JSON 全文": { en: "Paste the full JSON returned by the LLM" },
  "校验": { en: "Validate" },
  "校验失败": { en: "Validation failed" },
  "先粘贴 LLM 返回的 JSON 文本": { en: "Paste the LLM-returned JSON text first" },
  "校验未通过（{n} 处）": { en: "Validation failed ({n} issue(s))" },
  "校验通过（{n} 个角色）——点「编译（team_json）」进入预览": {
    en: "Validated ({n} roles) — click Compile (team_json) for preview",
  },
  // ── B 折叠区（建队表单）──
  "千锻模板（可选）": { en: "Millforge template (optional)" },
  "展开后：选源 → 选模板 →（可选）编译预览 → 选注入方式": {
    en: "When expanded: pick source → pick template → (optional) compile preview → pick inject mode",
  },
  "注入方式（提交建队时自动执行）": {
    en: "Inject mode (auto-runs on team creation submit)",
  },
  "core 技能：成功（已挂接：{list}）": {
    en: "core skill: OK (attached to {list})",
  },
  "core 技能：成功": { en: "core skill: OK" },
  "core 技能：跳过": { en: "core skill: skipped" },
  "core 技能：部分失败": { en: "core skill: partial failure" },
  "core 技能：失败": { en: "core skill: failed" },
  "可不预览——提交建队时自动编译 → 注入 → 创建": {
    en: "Preview optional — submitting team creation auto-runs compile → inject → create",
  },
};
