// settings 域 i18n 字典（自 i18n.ts 按域拆分）：设置与自检（WorkbenchPage 提示/备份恢复）。

export const settingsDict: Record<string, { en: string }> = {
  // ── 第五批：WorkbenchPage 提示 / 设置 / 自检 ──
  "导出失败": { en: "Export failed" },
  "诊断包导出失败": { en: "Failed to export diagnostics" },
  "先填写 Matrix 账号和密码": { en: "Fill in Matrix username and password first" },
  "当前": { en: "Active" },
  "内网：http://192.168.x.x:8090（可留空）": { en: "LAN: http://10.0.0.x:8090 (optional)" },
  "外网：https://你的域名:8090（可留空）": { en: "WAN: https://your-domain:8090 (optional)" },
  "自检失败": { en: "Self-check failed" },
  "获取房间列表失败": { en: "Failed to fetch rooms" },
  "获取团队结构失败": { en: "Failed to fetch team structure" },
  "获取消息失败": { en: "Failed to fetch messages" },
  "加载更早消息失败": { en: "Failed to load earlier messages" },
  "反应发送失败": { en: "Failed to send reaction" },
  "打开已有私聊": { en: "Open existing DM" },
  "已创建与 {target} 的私聊": { en: "Created DM with {target}" },
  "打开私聊失败": { en: "Failed to open DM" },
  "获取工作流失败": { en: "Failed to fetch workflows" },
  "获取管理视图失败": { en: "Failed to fetch admin view" },
  "点击进入配置页": { en: "Click to open settings" },
  "无回复": { en: "No reply" },
  "该房间历史暂时无法加载——可能是房间已失效，也可能是权限或服务端问题。可返回聊天页换其他房间。": {
    en: "This room's history cannot be loaded right now — the room may be gone, or it may be a permission/server issue. Go back to the chat page and try another room.",
  },
  "L1 管理员": { en: "L1 Admin" },
  "唤醒 {name}": { en: "Wake {name}" },
  "休眠 {name}（释放算力）": { en: "Sleep {name} (free resources)" },
  "{name} 已唤醒": { en: "{name} woken" },
  "{name} 已休眠": { en: "{name} slept" },
  "团队（{n}）": { en: "Teams ({n})" },
  "用户（{n}）": { en: "Users ({n})" },
  // ── 备份与恢复（含凭据完整配置导出/导入）──
  "备份与恢复": { en: "Backup & Restore" },
  "导出配置（含凭据）": { en: "Export config (with credentials)" },
  "导入配置（含凭据）": { en: "Import config (with credentials)" },
  "导出含密码/token 的完整配置 JSON，存到安全位置；换环境/重装插件后粘贴回来导入即快速还原，不必重填。导入前会先自动备份当前配置。注意：此导出含明文凭据，勿粘贴到公开渠道。": {
    en: "Exports the full config JSON including passwords/tokens — keep it in secure storage. After switching environments or reinstalling the plugin, paste it back and import to restore in seconds, no re-entry. Import auto-backs up the current config first. Note: this export contains plaintext credentials — never paste it into public channels.",
  },
  "以下为含明文凭据的完整配置——请只保存到可信位置。": {
    en: "The config below contains plaintext credentials — keep it in trusted storage only.",
  },
  "已复制到剪贴板": { en: "Copied to clipboard" },
  "请先粘贴配置 JSON": { en: "Paste the config JSON first" },
  "配置已导入（同步已自动重启）": {
    en: "Config imported (sync restarted automatically)",
  },
  "配置已导入（建议刷新页面确认生效）": {
    en: "Config imported (refresh the page to confirm it took effect)",
  },
  "粘贴「导出配置（含凭据）」得到的 JSON 全文。导入会校验并先自动备份当前配置，再覆盖。": {
    en: "Paste the full JSON from 'Export config (with credentials)'. Import validates it and auto-backs up the current config before overwriting.",
  },
  "导入": { en: "Import" },
  // 完整备份门密码（P0：宿主鉴权可关 + 8088 绑 0.0.0.0 → 防匿名局域网 dump 凭据）
  "完整备份密码": { en: "Backup password" },
  "已设置": { en: "Set" },
  "未设置（导出/导入暂不可用）": {
    en: "Not set (export/import unavailable)",
  },
  "设置密码": { en: "Set password" },
  "修改密码": { en: "Change password" },
  "清除密码": { en: "Clear password" },
  "设置完整备份密码": { en: "Set backup password" },
  "输入完整备份密码": { en: "Enter backup password" },
  "新密码（至少 8 位）": { en: "New password (at least 8 characters)" },
  "再次输入新密码": { en: "Re-enter new password" },
  "两次输入的密码不一致": {
    en: "The two passwords do not match",
  },
  "完整备份密码已设置": { en: "Backup password set" },
  "完整备份密码已清除（导出/导入将重新要求先设置）": {
    en: "Backup password cleared (export/import will require setting it again)",
  },
  "清除失败": { en: "Failed to clear" },
  "请先设置完整备份密码（见下方「备份与恢复」）": {
    en: "Please set a backup password first (see 'Backup & Restore' below)",
  },
  "读取备份密码状态失败": {
    en: "Failed to read backup password status",
  },
  "请输入完整备份密码": { en: "Please enter the backup password" },
  "备份密码保护「含凭据导出/导入」通道（本机 8088 若可被局域网访问，防匿名 dump 整集群凭据）。密码仅存哈希、不出现在备份文件里；设置一次即可，导出/导入时输入。": {
    en: "The backup password protects the 'export/import with credentials' channel (guards against anonymous LAN dumping of cluster credentials if this host's 8088 is reachable). Only a hash is stored — it never appears in the backup file. Set it once; enter it when exporting/importing.",
  },
  // 登录态/凭据失效横幅
  "Matrix 登录已失效": { en: "Matrix login expired" },
  "你的 Matrix 访问令牌已被服务器拒绝（通常是密码修改、设备被移除或管理员重置）。@提到我、通知与任务状态更新不可用——请重新登录后恢复。": {
    en: "Your Matrix access token was rejected by the server (usually after a password change, device removal, or admin reset). @-mentions, notifications and task status updates are unavailable until you log in again.",
  },
  "重新登录": { en: "Log in again" },
  "Higress 管理会话已过期": { en: "Higress admin session expired" },
  "模型 alias 层的 Console 管理会话已失效——设置页用管理员账号密码重新验证后恢复。": {
    en: "The Console admin session for the model alias layer has expired — re-verify with the admin account on the Settings page to restore it.",
  },
  "重新验证": { en: "Re-verify" },
  // 半连通横幅——Controller 通但 Matrix 未登录时，
  // 团队/工作流数据正常而聊天/通知/任务状态受限，此前首页静默零提示。
  "Matrix 未登录——部分功能受限": {
    en: "Matrix not signed in — some features limited",
  },
  "团队 / 工作流等数据来自 Controller，显示正常；但聊天、通知、@提醒与任务状态同步需要 Matrix 账号。在「配置」页完成 Matrix 登录后功能即补齐。": {
    en: "Team / workflow data from the Controller renders normally, but chat, notifications, @-mentions and task status sync require a Matrix account. Sign in on the Settings page to unlock the full feature set.",
  },
  // ── 15.36 D：控制台特效质量三档短 label（完整语义键在 creds.ts）──
  "轻量": { en: "Lightweight" },
  "关闭特效": { en: "Effects off" },
  "完整特效": { en: "Full effects" },
};
