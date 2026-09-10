# Team Management

Five sub-tabs: **Teams (n) / Users (n) / Managers (n) / Channels / Skill Center**. Team structure data comes from the real Team/Worker CRDs (L1 = full scope, L2 = accessible scope).

## Teams (n)

- **Team list + Worker tree**: each team shows its real Worker structure (spawn tree filled from the source of truth); Worker cards show runtime status/phase
- **Inline Worker model editing** (since v0.5.0-beta.9): change a Worker's model right on the card (provider untouched, diff sends only what changed, save goes through `PUT /workers` merge semantics, read-back verification after save); rebinding a Worker re-fetches the baseline
- **Model dropdown = union** (since v0.5.0-beta.12, extended to the Manager table in beta.12): all three entry points (create-worker dialog / team-create row / team-config inline) + the Manager table model column (beta.12) share one candidate union (`../modelUnion`, same pre-write validation) = ① gateway aliases (route-resolvable, fetched live from Higress AI routes + providers via the L1 password-mode Console session) ② builtin aliases (the 16 official AgentTeams aliases) ③ serving SGLang ∪ in-use models; without a Console session the alias layer hides, **with an explicit hint in token mode** (beta.12: amber notice at the CRD panel top + above the Manager table — configure admin account+password to make it visible, or wait for P1-3), free input unchanged
- **Create team / onboard / reconfigure / delete** (L1): CRD management. The creation flow has built-in defenses: row-level model/SOUL lands on the Worker CR before the Team is created, pre-write validation at three entry points (path-shape hard reject), post-create self-check (CRD read-back + phase polling)
- **Room-baseline warning**: right after first setup, before the room baseline is established, a warning banner shows at the top (Home's "Dispatch task" modal keeps only the Manager entry meanwhile)
- **Worker-row phase/runtime badges** (since v0.5.0-beta.12, A8b): each Worker row shows a `phase` status dot + `runtime` (+ version), sourced from the Worker CR fields; when admin data isn't loaded it falls back to the team-structure passthrough (zero new requests); **1:1 Worker rooms also show the phase/runtime badge pair in the chat header**
- **Private chat jumps to the personal room** (since v0.5.0-beta.12, A8a-fix): clicking a Worker's "DM" jumps straight to that Worker's personal room (CR `roomID`) — a Worker container cannot accept a Matrix invite, so a freshly created DM room the Worker can never join (a dead end); it only falls back to creating a DM when there is no `roomID`

## Users (n)

Human CRD list: Matrix human accounts + permission level (level 1 admin / level 2 regular member). The Controller's Matrix auth only admits level 2 — a level-mismatched account in L2 mode gets 401 (see [Configuration reference](./12-config-en.md)).

## Managers (n)

Manager instances and their status. A Manager is the in-team coordinator (messaging, room management, Worker status inspection) — not a human account.

- **Model column is editable** (since v0.5.0-beta.12, aligned with the dashboard manager-edit dialog): same model union dropdown + pre-write validation; save goes through `PUT /managers/{name} {model}` (Controller merge semantics — only non-empty fields applied, provider unchanged); the Controller reconcile restarts the Manager container to apply it (minute-scale)
- **Runtime column** (since v0.5.0-beta.12): each Manager shows its own `runtime` (a Manager CR field, zero new endpoints) — runtime management lives in Team management; the Ops page no longer carries the multi-runtime card
- **Detail panel (row expand)** (since v0.5.0-beta.12, A6): expanding a row shows image / version / MXID / personal room + **DM (jumps to the personal room)** + **Logs** (L1, last 300 lines, via the existing docker-logs proxy, zero new endpoints)

## Channels

**Worker channel configuration** (lights up automatically once upstream AgentTeams PR #1219 merges; until then a 404 placeholder card — expected):

- **Schema-driven form / JSON dual mode**: per-Worker channel cards (QQ/DingTalk etc.), form and JSON convert both ways from one source
- **Enable / disable, health check, restart**: per-Worker channel operations
- **QR-code authorization**: scan, and credentials auto-fill into the config (no hand-copying tokens)
- **Pre-save conflict pre-check**: compared against the Worker's existing config, conflicts flagged first
- **PUT hot-reload read-back verification**: re-read after save to confirm it took effect
- On 2.0 hosts, worker-level 404s are skipped automatically (no error)

## Skill Center

Three sections: skill catalog / Worker×skill matrix / MCP matrix. See [Skill center & MCP](./11-skills-en.md).

## Permissions

| Operation | L2 | L1 |
|-----------|:---:|:---:|
| View teams/Workers (accessible scope) | ✅ | ✅ |
| Model editing (CRD three entry points + Manager table) | ❌ (Worker card is read-only) | ✅ |
| Create/onboard/reconfigure/delete (CRD) | ❌ | ✅ |
| Channel config writes | own team only | ✅ |
| Skill matrix / MCP matrix writes | own team only | ✅ |
