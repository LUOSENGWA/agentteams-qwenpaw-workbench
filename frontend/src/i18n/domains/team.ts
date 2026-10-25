// team 域 i18n 字典（自 i18n.ts 按域拆分）：团队（共享文件引用/访问矩阵/邀请区）。

export const teamDict: Record<string, { en: string }> = {
  // ── #87 团队共享文件引用 ──
  "引用工作区文件": { en: "Reference workspace files" },
  "返回上级": { en: "Up one level" },
  "团队共享根目录": { en: "Team shared root" },
  "此目录暂无文件": { en: "No files in this directory" },
  "已选 {n} 个文件": { en: "{n} file(s) selected" },
  "插入引用": { en: "Insert reference" },
  "保存": { en: "Save" },
  "返回": { en: "Back" },
  "发送": { en: "Send" },
  "回复": { en: "Reply" },
  "复制": { en: "Copy" },
  "下载": { en: "Download" },
  "预览": { en: "Preview" },
  "收起": { en: "Collapse" },
  "{n} 步": { en: "{n} steps" },
  "点击展开步骤详情": { en: "Click to expand step details" },
  "一张图片": { en: "Image" },
  "一个文件": { en: "File" },
  // ── TruncatedId + 团队访问矩阵 ──
  "点击右侧按钮复制完整 {label}": { en: "Click the button to copy the full {label}" },
  "复制 {label}": { en: "Copy {label}" },
  "团队访问配置（员工 × 团队）": { en: "Team access (employee × team)" },
  "已改动": { en: "changed" },
  "级别": { en: "Level" },
  // ── 邀请区（Element 同款接受/拒绝入群）──
  "邀请（{n}）": {
    en: "Invites ({n})",
  },
  "邀请人：": {
    en: "Invited by: ",
  },
  "已接受邀请，正在进入房间列表": {
    en: "Invite accepted, entering the room list",
  },
  "已拒绝邀请": {
    en: "Invite declined",
  },
  "接受邀请失败": {
    en: "Accept invite failed",
  },
  "拒绝邀请失败": {
    en: "Decline invite failed",
  },
  "拒绝邀请「{name}」？（系统团队房间可能被 Controller 调和器自动重新邀请）": {
    en: "Decline the invite to “{name}”? (System team rooms may be re-invited automatically by the Controller reconciler)",
  },
  // 知识图谱对齐 QwenPaw 最新版（三级配色 + 详情面板）
  "分类根": { en: "Category root" },
  "根邻接": { en: "Root-adjacent" },
  "引用方向": { en: "Reference direction" },
  "点节点查看 · 滚轮缩放 · 拖拽平移 · 点簇根聚焦 · 双击节点邻域 · Esc 退出": {
    en: "Click a node for details · Wheel to zoom · Drag to pan · Click a cluster hub to focus · Double-click a node for its neighborhood · Esc to exit",
  },
  // 5.0.0-beta.2：对齐 QwenPaw 知识图谱详情面板命名（开源移植，
  // 见 THIRD-PARTY-NOTICES.md）
  "已索引文件": { en: "Indexed file" },
  "未解析链接": { en: "Unresolved link" },
  "打开 Markdown": { en: "Open Markdown" },
  "出链 · {n}": { en: "Outbound · {n}" },
  "入链 · {n}": { en: "Incoming · {n}" },
  "未解析引用（对应文件不存在）": { en: "Unresolved reference (file not found)" },
  // 技能 tab（宿主 Agent，参考 QwenPaw SkillPool）
  "上传技能（zip）": { en: "Upload skill (zip)" },
  "上传失败": { en: "Upload failed" },
  // DirNode 目录树（早期遗留补登记）
  "工作区目录（点文件夹展开）": {
    en: "Workspace directories (click a folder to expand)",
  },
  "空目录": { en: "Empty directory" },
  // 3D 知识图谱（3d-force-graph + three.js，MIT 引用见
  // THIRD-PARTY-NOTICES.md）
  "自动旋转": { en: "Auto-rotate" },
  "适配视图": { en: "Fit view" },
  "回到 2D": { en: "Back to 2D" },
  "3D 布局计算中…": { en: "Computing 3D layout…" },
  "拖拽旋转 · 滚轮缩放 · 右键平移 · 点节点选中（邻接高亮）· 点空白取消": {
    en: "Drag to rotate · Wheel to zoom · Right-drag to pan · Click node to select · Click empty to clear",
  },
  "引擎：{e}": { en: "Engine: {e}" },
  "当前浏览器/设备不支持 WebGL，3D 图谱不可用": {
    en: "WebGL not supported by this browser/device; 3D graph unavailable",
  },
  "已自动保留 2D 图谱视图": { en: "The 2D graph view is kept automatically" },
  "3D 图谱初始化失败，已回退 2D": {
    en: "3D graph initialization failed; fell back to 2D",
  },
  // ── 千锻（Millforge）模板卡：导入/浏览/预览/建队预填（MVP）──
  "千锻模板": { en: "Millforge templates" },
  "导入千锻（Millforge）模板库——浏览 + 建队预填（MVP，不执行编译器）": {
    en: "Import Millforge template packs — browse + prefill team creation (MVP, compiler not executed)",
  },
  "导入千锻（Millforge）开源模板库（GitHub / GitCode / Gitee），浏览并在建队时预填模板来源（MVP：不执行千锻编译器）": {
    en: "Import the open-source Millforge template library (GitHub / GitCode / Gitee), browse it, and prefill the template source when creating a team (MVP: Millforge compiler not executed)",
  },
  "仓库 URL（https）": { en: "Repository URL (https)" },
  "分支 / Tag（ref）": { en: "Branch / tag (ref)" },
  "仓库 URL 必填": { en: "Repository URL is required" },
  "导入成功：{pack}（{n} 个文件）": { en: "Imported {pack} ({n} files)" },
  "模板列表加载失败": { en: "Failed to load template packs" },
  "尚未导入模板包——在上方填入千锻仓库地址（默认 GitHub，可换 GitCode / Gitee 镜像）并点导入": {
    en: "No template packs yet — enter a Millforge repository URL above (GitHub by default; GitCode / Gitee mirrors work) and click Import",
  },
  "skeletons（骨架）": { en: "skeletons" },
  "industry（行业）": { en: "industry" },
  "domain（领域）": { en: "domain" },
  "fragments（片段）": { en: "fragments" },
  "适用": { en: "Applies to" },
  "预算": { en: "Budget" },
  "用此模板建队": { en: "Create team with this template" },
  "删除模板包「{name}」？": { en: "Delete template pack “{name}”?" },
  "已导入的 templates 文件将从本地移除（源仓库不受影响）。": {
    en: "The imported templates files will be removed locally (the source repository is unaffected).",
  },
  "导入时间": { en: "Imported at" },
  "INDEX 解析失败": { en: "INDEX parse failed" },
  "（无条目）": { en: "(no entries)" },
  "模板预览": { en: "Template preview" },
  "读取模板文件失败": { en: "Failed to read template file" },
  "选择左侧模板条目查看预览（只读）": {
    en: "Select a template entry on the left to preview (read-only)",
  },
  "需要 L1 管理员（已配置 Controller token）才能打开建队表单": {
    en: "An L1 admin (Controller token configured) is required to open the team-creation form",
  },
  "模板来源（千锻模板 pack/id，仅记录，不执行编译器）": {
    en: "Template source (Millforge pack/id — recorded only, compiler not executed)",
  },
  // ── DM 房间命名 + 房间 ID 可见 ──
  "私聊 · {name}": { en: "DM · {name}" },
  "私聊 · {team} · {name}": { en: "DM · {team} · {name}" },
  "复制房间 ID": { en: "Copy room ID" },
};
