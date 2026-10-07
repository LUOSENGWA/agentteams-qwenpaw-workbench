# PREEMBED-EXEMPT · 死码审计豁免清单

**规则（两次重犯纠正，14.19 定案）：**
任何死码审计（任务书 / 自研审计 / pre-commit 钩子）在把符号列入删除名单前，
**必须对照本清单**。清单内符号**永不删除**（除非仓库 owner 明确拍板移除）；
代码 JSDoc 的【预埋，勿删】/【历史替代，勿删】/【预埋清单 Pn】标记与本清单
双写——**标记优先于审计名单**：审计发现目标符号带此类标记 → 跳过 + 报告，
不得按名单硬删。

来源：方案与设计 §5.5c 预埋接口清单（v5.29 起维护）。

| # | 符号 | 位置 | 性质 | 备注 |
|---|------|------|------|------|
| P1 | `sendInboxNotify` | frontend/src/api.ts | 预埋 | UI 主动推送通知通用入口（产物完成通知等未来触发点，方案 v5.29「产物通知待评估」）；后端 `/agentteams-proxy/notify` 配对 |
| P2 | `fetchTeamsRooms` | frontend/src/api.ts | 历史替代 | `/teams/rooms` 实时无缓存版，现役用 `/teams/sync`（缓存+force 超集）；排查缓存问题时用；后端 `/teams/rooms` 配对 |
| P3 | `spawn_tree` 三桥接定义 | agentteams_connector/spawn_tree.py | 预埋 | `_SESSION_ID_RE` + `normalize_room_session_id` + `room_id_to_session_id`——「团队桥接」（spawn 树↔房间跳转定位）消费；文件头【预埋，勿删】块注释 |
| P4 | `replanProject` | frontend/src/api.ts | 已落地 | 原预埋（中断三件套），现已有消费方——**保留但已非豁免对象**（按正常死码规则审） |
| P5 | MemberDetail 死 import | — | 已删 | 早期清埋批唯一"删"项，已执行完毕（留档） |

## 事故记录（本清单的由来）
- 14.17 批：自研审计误删 `fetchTeamsRooms` 后恢复 → 教训「动手前先查【勿删】标记」。
- 14.19 批（第二次重犯）：两批死码审计任务书把 P1/P2/P3 列入删除名单（未对照 §5.5c），
  执行方照删（对应审计报告如实记录「被任务书显式删除指令覆盖」）→ 两次恢复。
  **根因**：豁免清单只存在于方案文档（人读），审计/任务书流程无机器可查副本。
  **治本**：本文件 = 仓库内机器可查豁免源；死码任务书模板增加「对照 PREEMBED-EXEMPT.md」
  为派单前置检查项。
