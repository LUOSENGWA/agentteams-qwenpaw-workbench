# Approvals (Worker Tool-Approval HITL)

When a Worker triggers the Tool Guard while running a sensitive tool (shell/file writes etc.), the approval request is posted to the team room. The plugin wires it into three surfaces: the **in-plugin approval card**, the **host inbox (QwenPaw 2.1+)**, and the **room message itself**. Approve or deny on any one surface — the whole chain closes exactly once.

## Approval flow

```
Worker posts 🛡️ Approval Required (room)
   │ plugin backend sync detects it (first-sync back-check covers the offline window)
   ├─→ ① desktop toast immediately
   ├─→ ② notification-center "approval request" entry (one-click approve/deny)
   ├─→ ③ home "Awaiting approval" card (one-click approve/deny)
   └─→ ④ host inbox: nav wobble + red dot + approval entry (host 2.1+, one-click approve/deny)

Approve/deny on any surface → a command with triple `` goes back to the room → the Worker's consumer queue continues
```

## Why the command must carry `` (triple mention)

In a Matrix group room, **a message that isn't mentioned only enters the history buffer, not the Worker's consumer queue** (`_require_mention`). Approval commands therefore carry three markers — missing any one can fail silently:

1. `m.mentions.user_ids` (structured mention)
2. a `matrix.to` link in `formatted_body` (rich-text rendered mention)
3. plain `@worker1` in the body (fallback for non-rich clients)

## Dual-path closure (fixed in v0.5.0-beta.11.1)

The same approval can be resolved from the **host inbox card** or the **in-plugin approval card** — each path closes the loop on its own, without interfering with the other:

| Path | How the decision reaches the Worker | How the host record is cleared |
|------|-------------------------------------|--------------------------------|
| **Host card** (normal path) | decision callback (`pending.future` completes — zero polling, zero monkey-patching) auto-sends the Matrix command to the room | the host clears it itself |
| **Plugin card** (command goes straight to the room) | the command itself (the watcher detects it in the room afterwards) | the watcher matches **precisely by the reply chain** (the approval command is a thread reply to the approval message; reply-to / thread root = the approval's event_id) → the host record is cleared immediately |

> What happens without this fix: after a plugin-card approval, the host record lingers until the 30-minute timeout → the bridge re-sends a **stale deny** to the room (the Worker already approved and is running, then gets a denial). Now a room-side resolution marks the bridge record "sent", and the decision callback skips the re-send. With multiple pending approvals in one room and no reply chain, the bridge **doesn't guess** — it keeps the timeout fallback rather than risk clearing the wrong record.

## All decision paths covered

On the host side, every decision path converges (all of them write `pending.future`): the custom approval card's POST `/approval/approve|deny`, the default card's chat command, the HTTP API, and **timeout-GC auto-reject** (30 minutes, since Worker tools may run long) — all captured by the single callback, which sends the matching Matrix command.

## Degradation

- Host <2.1 (no `create_pending_summary`) → the host-inbox bridge disables itself silently; the three in-plugin surfaces ①②③ are unaffected
- `GET /agentteams-proxy/host-bridge/status` reports bridge stats (injected/resolved/failed counts)
