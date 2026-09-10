# Notifications

An aggregated inbox: room ``s, task progress, approval requests, and room invites — one screen, click through to the scene.

## Notification types

| Type | Source | Click behavior |
|------|--------|----------------|
| 📣 Room `` | mentions in team rooms (primary check `m.mentions.user_ids` + body fallback) | jumps to the room and locates the message |
| 🛡️ Approval request | Worker Tool Guard approval | jumps to the approval scene (one-click approve/deny, see [Approvals](./09-approvals-en.md)) |
| 📊 Task progress | workflow status changes | jumps to the workflow view |
| ✉️ Room invite | invited into a new room | jumps to the Team management invite area (single source of truth: accept/reject happens there) |

- Notification-center cards **click straight through** (v0.5.0-beta.11)
- The notifications tab label carries an unread badge; the home quick entry shows the "approvals & room ``s" unread count
- Muted rooms don't push (same semantics as `@me`)

## Desktop toasts

- New approval request / new room invite: a desktop toast pops immediately (no need to open the page)
- **Offline back-check**: the plugin backend sync is resident — ``s, approvals, and invites that happened while you were offline (page closed / network down / machine off) are all back-checked on the **first sync after you return** — nothing is lost

## Baseline suppression

When the room baseline is first established (right after setup, the first full-history sync), pre-existing old ``s / old invites are **not notified** — only events that happen after the baseline trigger notifications, so historical messages don't bombard you.
