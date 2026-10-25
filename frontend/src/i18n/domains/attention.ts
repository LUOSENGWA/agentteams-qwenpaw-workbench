// attention 决策域 i18n 字典：待决策 badge/弹窗/聚合页。
// 复用既有键：任务/状态/Worker/刷新/取消/推荐/升级/其他/{n} 条/加载失败/发送失败
// （不重复定义——i18n gate 要求 0 重键）。

export const attentionDict: Record<string, { en: string }> = {
  // ── 入口（badge / tab / 空态） ──
  "待决策": { en: "Pending Decisions" },
  "点击回答": { en: "click to answer" },
  "暂无待决策": { en: "No pending decisions" },
  "决策数据不可用（controller 端点未部署或未连接）": {
    en: "Decision data unavailable (controller endpoint not deployed or not connected)",
  },
  "刷新失败": { en: "Refresh failed" },

  // ── kind 标签（其余 kind 复用既有键：升级/其他） ──
  "审批": { en: "Approval" },
  "决策": { en: "Decision" },

  // ── 弹窗字段 ──
  "问题": { en: "Question" },
  "请求时间": { en: "Requested" },
  "期限": { en: "Deadline" },
  "已过期": { en: "Expired" },
  "快捷回答": { en: "Quick answer" },
  "自定义回答": { en: "Custom answer" },
  "依据（可选）": { en: "Basis (optional)" },
  "提交": { en: "Submit" },
  "发送中": { en: "Sending…" },
  "已回答": { en: "Answered" },
  "上一条": { en: "Previous" },
  "下一条": { en: "Next" },
  "未定位到任务房间（无法发送）": { en: "Task room not resolved (cannot send)" },
  "答案将以当前登录身份（人类）发回任务房间": {
    en: "The answer is sent back to the task room as the logged-in human.",
  },

  // ── P2 聚合页 ──
  "回答": { en: "Answer" },
  "已回答历史": { en: "Answered history" },
  "暂无已回答记录": { en: "No answered records yet" },
  "需要人工决策的 attention 请求（读 controller 聚合；回答以当前登录身份发回任务房间）。": {
    en: "Attention requests that need a human decision (read from the controller aggregate; answers are sent back to the task room as the logged-in human).",
  },
};
