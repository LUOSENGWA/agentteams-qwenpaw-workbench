# Home

Your whole cluster at a glance: teams, tasks, approvals, and cluster load, plus direct entries to the four highest-frequency actions.

## Layout

```
┌ Team collaboration overview ─────────────┐
│  👥 Teams   📋 Task progress   🛡️ Awaiting approval │
│  (L1: cluster-load card, optional)       │
├──────────────────────────────────────────┤
│ [Dispatch task] [Open team chat] [Inbox] [Knowledge graph] │
└──────────────────────────────────────────┘
```

## Overview cards

| Card | Content | Data source |
|------|---------|-------------|
| 👥 Teams | Team/Worker count & status summary (L1 = full scope, L2 = accessible scope) | Controller + room baseline |
| 📋 Task progress | In-progress task/workflow counts | Controller projects |
| 🛡️ Awaiting approval | **Room-approval source = the real Worker Tool Guard queue** (not a host-inbox snapshot): desktop toast on new requests, one-click approve/deny on the card | Matrix room sync detection |
| Cluster load (optional) | SGLang/GPU load (**L1 only**; when the backend feature is off the endpoint 404s and the card simply doesn't render — no error) | Controller `/api/v1/status` (same source as the dashboard cluster-status) |

## Quick entries

- **Dispatch task**: a modal to pick a Leader and hand it a new task. While the room baseline is not yet established (e.g. right after first setup) the modal keeps only the Manager entry and a warning banner shows at the top of Team management; full entries return once the baseline exists
- **Open team chat**: jumps to the Chat page (unread count shown when there are unread messages)
- **Inbox**: jumps to the notification center (shows the "approvals & room ``s" unread count)
- **Knowledge graph / Skill & MCP matrix**: jump to the knowledge-graph view / Skill Center

## About the approval card

- Approval requests come from Worker Tool Guard approval messages posted in the **room** (the real queue; a first-sync back-check covers the offline window)
- The card's approve/deny buttons send commands **carrying a triple `@Worker` mention** — in group rooms, unmentioned commands never enter the Worker's consumer queue (see [Approvals](./09-approvals-en.md))
- On QwenPaw 2.1+ hosts, the same approval also surfaces in the **host inbox** (nav wobble + red dot + approval entry) — either path works; one resolution closes the whole chain (see [Approvals § host-inbox bridge](./09-approvals-en.md))
