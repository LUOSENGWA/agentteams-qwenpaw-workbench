# PREEMBED-EXEMPT · Reserved-Interface Registry

**Rule:** before any dead-code audit (task, pre-commit hook, or manual pass)
lists a symbol for deletion, it **must check this registry**. Symbols in the
registry are **never deleted** (unless the repository owner explicitly
removes them). The JSDoc markers in code —【预埋，勿删】/【历史替代，勿删】/
【预埋清单 Pn】— are dual-written with this registry, and **the marker wins
over the audit list**: if an audit finds a target symbol carrying one of
these markers → skip and report; do not force-delete from the list.

| # | Symbol | Location | Nature | Notes |
|---|------|------|------|------|
| P1 | `sendInboxNotify` | frontend/src/api.ts | reserved | generic UI push-notify entry (future triggers such as artifact-completion notification); paired with backend `/agentteams-proxy/notify` |
| P2 | `fetchTeamsRooms` | frontend/src/api.ts | legacy replacement | real-time, cache-free `/teams/rooms`; production uses `/teams/sync` (cache + force superset); kept for cache debugging; paired with backend `/teams/rooms` |
| P3 | `spawn_tree` bridge definitions | agentteams_connector/spawn_tree.py | reserved | `_SESSION_ID_RE` + `normalize_room_session_id` + `room_id_to_session_id` — consumed by the team bridge (spawn tree ↔ room jump); 【预埋，勿删】block comment at the file head |
| P4 | `replanProject` | frontend/src/api.ts | landed | originally reserved (interruption trio), now has consumers — **kept but no longer exempt** (audited under normal dead-code rules) |

## Maintenance
- Adding a reserved interface: add the JSDoc marker **and** a registry row in
  the same change.
- A registry symbol that gains consumers (P4): keep the code, update its
  Nature row so it leaves the exemption scope.
