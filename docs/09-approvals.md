# 审批（Worker 工具审批 HITL）

Worker 执行敏感工具（shell/文件写等）触发 Tool Guard 时，审批请求发到团队房间——插件把它接到三个面：**插件内审批卡、宿主收件箱（QwenPaw 2.1+）、房间消息**。任一面批准/拒绝，全链路一次闭环。

## 审批流

```
Worker 发 🛡️ Approval Required（房间）
   │ 插件后端 sync 检出（离线期间首轮 sync 补检）
   ├─→ ① 桌面 toast 立即提醒
   ├─→ ② 通知中心「审批请求」条目（一键批/拒）
   ├─→ ③ 首页「待审批」卡（一键批/拒）
   └─→ ④ 宿主收件箱：导航抖动 + 红点 + 审批条目（宿主 2.1+，一键批/拒）
   
任一面批/拒 → 发带三重 `` 的命令回房间 → Worker 消费队列继续执行
```

## 为什么命令必须带 ``（三重 mention）

Matrix 群房间里，**不被 mention 的消息只进历史缓冲区，不进 Worker 消费队列**（`_require_mention`）。插件发的审批命令因此带三重标记，缺一都可能静默失败：

1. `m.mentions.user_ids`（结构化 mention）
2. `formatted_body` 里的 `matrix.to` 链接（富文本渲染的 mention）
3. 正文里的 `@worker1` 纯文本（非富文本客户端兜底）

## 双路径闭环（v0.5.0-beta.11.1 修）

同一个审批可以从**宿主收件箱卡**或**插件审批卡**批——两条路各自闭环，互不干扰：

| 路径 | 决议如何到达 Worker | 宿主记录如何消解 |
|------|--------------------|------------------|
| **宿主卡**（正常路径） | 决议回调（`pending.future` 完成，零轮询零 monkey-patch）自动发 Matrix 命令回房间 | 宿主自己消解 |
| **插件卡**（命令直接发房间） | 命令本身（watcher 随后在房间检出） | watcher 按 **reply 链精确匹配**（审批命令是审批消息的 thread reply，reply-to/线程根 = 审批 event_id）→ 立即消解宿主记录 |

> 不修这个会发生什么：插件卡批准后宿主记录挂到 30 分钟超时 → 桥补发一条**陈旧的 deny** 回房间（Worker 已批准执行，又收到拒绝）。现在房间侧决议会被桥标记「已发」，决议回调跳过补发。同房间多条 pending 且 reply 链缺失时**不猜**——保持超时兜底，宁可不消也不错消。

## 决议路径全覆盖

宿主侧任何决议路径殊途同归（都写 `pending.future`）：自定义审批卡 POST `/approval/approve|deny`、默认卡聊天命令、HTTP API、**超时 GC 自动拒绝**（30 分钟，Worker 工具可能长跑）——全部被单回调捕获并发对应 Matrix 命令。

## 降级

- 宿主 <2.1（无 `create_pending_summary`）→ 宿主收件箱桥整桥静默禁用；①②③ 三个插件内面不受影响
- `GET /agentteams-proxy/host-bridge/status` 可查桥状态（注入/已决/失败计数）
