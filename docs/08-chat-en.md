# Team Chat

Direct Matrix-connected team room chat — not a message relay: real-time sync (messages, typing, presence all live while online).

## Room views

- **All**: an Element-style **single timeline** — group and DM messages interleaved by `last_ts` descending; the whole team's activity in one screen (no more split sections)
- **Team rooms / DM switch**: top-level Segmented between team rooms (>2 members) and DMs
- Each room card shows unread count / latest message preview

## In-conversation features

| Feature | Notes |
|---------|-------|
| Threads | Element thread panel — long discussions collapse into threads, keeping the main timeline clean |
| Member card | click an avatar for details (MemberDetail: role/status/recent activity) |
| ``s | typing `@` opens a completion popover (substring match, ↑↓ keyboard navigation, Enter to select) — a Worker only consumes a message if it is mentioned |
| Message search | full-text search within a room (MessageSearch) |
| Message actions | hover a message for the action bar (copy / jump-to-location in room, etc.) |

## Room management

- **Favorite / mute**: favorites pin to the top, mutes silence notifications
- **Leave / delete room**: local view operations (leave = actually leaving the Matrix room)
- **Accepting invites**: new room invites arrive via [Notifications](./10-notifications-en.md) — the "Accept" in the toast/notification center jumps to Team management to complete the join

## Working with Agents

- Workers/Managers are Matrix users: @-ing them in a room is how you give tasks/commands
- **Approvals**: a Worker's Tool Guard approval messages are posted in the room — the plugin detects them, fires a desktop toast, and offers card approve/deny (see [Approvals](./09-approvals-en.md))
- When sending commands with @, the plugin guarantees triple mention markers (m.mentions + matrix.to + body) so the Worker's consumer queue never drops the message

## Offline behavior

The plugin's backend sync is resident: messages/approvals/invites that happen while you're offline are all back-checked on the first sync after you return (offline notification back-check).
