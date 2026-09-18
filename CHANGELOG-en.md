# Changelog

Version history of agentteams-qwenpaw-workbench.
中文版：[CHANGELOG.md](CHANGELOG.md)

---

## 0.5.0-beta.12.6 (2026-09-18)

**Knowledge base 3D graph spacing aligned with the dashboard's accepted values**

- **KB 3D graph force parameters tightened**: charge -108→-60, link distance 72→44, link strength 0.46→0.5 — same values the dashboard's KB 3D graph settled on after install verification (the original values spread the nodes too far apart with sparse links); 2D/3D layout, node-click preview and all other interactions are unchanged

**Verification**: pytest 42/42 · tsc 0 · vite build green (single-file dist/index.js) · check-antd cross-check passed

---

## 0.5.0-beta.12.5 (2026-09-18)

**L2 permission surface completed + model gateway visibility + workflow auto-refresh (parity with dashboard real-time)**

- **Read-only model gateway route catalog (Ops tab, L1)**: new "Model gateway routes" card — route name (= gateway `/v1` entry, NOT a model ID) / upstream provider + weight / authorized consumers, sourced from the Controller read-only endpoint (token-authenticated, readable by L1 in token mode); the whole card hides automatically on 404 when the Controller predates the endpoint, and L2 callers see a permission notice. In token mode the model dropdown still lists built-in aliases + local SGLang only (editing gateway aliases needs the Console password path); this card gives read-only visibility into the gateway route configuration
- **Knowledge base readable for L2 (Controller data-plane fallback)**: team-scoped users (L2) previously always got 403 reading KB (KB went through the Docker proxy, L1-only). When the Docker channel is unavailable it now falls back to the Controller workspace-files endpoint: diary (memory/**) / knowledge base (digest/**) / MEMORY.md (profile) — three categories, scoped to the caller's own team; other profile files and the "files" category remain L1-only. L1 keeps the full four categories (Docker-first, unchanged)
- **Approval read/write for L2 (Controller data-plane fallback)**: L2 previously always got 403 setting Worker approval. When Docker is unavailable it now uses the Controller approval endpoint: L2 can set strict/smart/auto (off requires L1); team leaders are read-only; Manager approval stays L1-only (no corresponding endpoint)
- **Workflow tab auto-refresh (P1-7)**: silent 15-second polling while the tab is visible (stops when you switch away), matching the dashboard's 15s polling real-time — the workflow board previously refreshed only on mount / manual refresh / login, so task progress did not update automatically
- **Comment & copy precision**: the "upstream not merged" wording in the channel-access and skill-catalog sections is updated to "Controller version gate" (the relevant endpoints are merged into the upstream mainline; only Controllers predating the merge return 404 and show the placeholder)

**Verification**: pytest 42/42 (+6 new: KB/approval L2 fallback) · tsc 0 · vite build green (439 modules) · i18n ui↔dict reconciliation (all new keys registered, orphan keys cleared)

---

## 0.5.0-beta.12.4 (2026-09-15)

**New: Worker session status indicator (A17, zero backend changes)**
- New 8px status dot on room cards in the chat list, Worker rows in Worker Manage, and 1:1 chat headers: **blue (pulsing) = running / green = finished (activity within the last 10 minutes) / gray = idle**, with a tooltip describing the state
- All data comes from the existing Matrix `/sync` payload (typing events + last message timestamp + member list) — pure client-side derivation, no new endpoints or requests; auto-ages every 60 seconds so the done→idle transition works without new messages
- Pulse animation matches the QwenPaw console `AgentStatusIndicator` implementation (1.2s cycle, opacity + glow spread); animation is disabled automatically when the OS `prefers-reduced-motion` setting is on
- Team room cards/headers: show a blue dot when any worker is actively processing (no "last sender" data in group rooms, so green/gray are not shown there — avoids false positives from human messages)
- Known limitation: the typing signal has a hard 2-minute cap (workers renew it every 25s, then clear it), so tasks longer than 2 minutes may temporarily show green/gray instead of staying blue

## 0.5.0-beta.12.3 (2026-09-13)

**Security / Aligned**
- Knowledge-base file listing now applies the full sensitive-file filter (artifacts section aligned with the dashboard): matching the dashboard's ChatRoom file panel `SENSITIVE_PATTERNS` — `credentials/` (directory), `openclaw.json` (runtime config, includes provider info) and `*.lock` are excluded from the KB tree / directory listings, and direct reads of them return 404 (existence not leaked). Hidden files (`.ssh/`, `.hermes/config.yaml`) were already filtered at every listing point; this release completes the non-hidden portion and adds the direct-read guard. +7 regression tests (guard fires before any data-channel call / normal paths pass / existing format validation unchanged)

---

## 0.5.0-beta.12.2 (2026-09-13)

**Added**
- CRD management: new "Export JSON" button (same as the dashboard teams page) — one click exports all four CRD types (teams / workers / humans / managers) as `agentteams-crd-YYYY-MM-DD.json`
- Brand logo replaces the 🏢 emoji everywhere: app title bar / home welcome bar / sidebar menu icon / App Center card (`icon_url` embedded data URI; desktop mode shows the AgentTeams logo directly, same logo file as the dashboard)

**Fixed / Aligned**
- "Create Worker" is now an independent card instead of a collapsible section inside the create-team card (per user request): the team card focuses on team fields, the Worker card is always visible; behavior unchanged (a created worker is still auto-added to the team form's member rows)
- Create-worker runtime dropdown corrected: CoPaw removed (retired), DeepSeek Harness added (upstream's recent `deepseek-harness` runtime), default QwenPaw (= install-script default; the previous OpenClaw default was wrong)

---

## 0.5.0-beta.12.1 (2026-09-13)

**Added**
- Runtime selector in the create-worker form (OpenClaw / CoPaw / Hermes / QwenPaw, default OpenClaw = cluster default) — written into the Worker CR `spec.runtime`, aligned with the dashboard create-worker flow

---

## 0.5.0-beta.12 (2026-09-10 - official release)

New and fixed since beta.8 (grouped by feature):

**Model selection & gateway**
- Three grouped candidate tiers in every model dropdown: Higress aliases (route-resolvable) / Higress builtin aliases (need a route mapping) / the union of serving + in-use models — all four model entry points (create-team card / create-worker dialog / team-config row / Manager table) show the alias group on open
- Worker-row model selector in the create-team form (serving candidates + triple pre-write validation) + inline editing of existing Worker models in the team-config dialog (`PUT /workers` merge semantics, only changed fields submitted, provider untouched)
- L1 admin credentials, either/or: Higress Console admin account+password, or Controller admin token — each with a Verify button; verification is also a self-check (a permanent "N routes / M resolvable aliases" readout under the button)
- Higress Console's native AI routes (EQUAL exact-match form) work out of the box
- The Higress (Console) admin address is now explicitly required (fixed-port blind probing removed; empty = an actionable error)
- One-click copy of the Controller token fetch command (`docker exec agentteams-controller cat /var/run/agentteams/cli-token`) + env injection for non-docker deployments (`AGENTTEAMS_CONTROLLER_TOKEN`)
- The Manager table's model column is editable (merge semantics: only changed fields are submitted, provider untouched)

**Team management & runtimes**
- Worker channel config extended: health check / restart / QR-code credential auth (auto-backfill) / pre-save conflict check / PUT hot-reload + read-back verification (lights up automatically once the upstream channel endpoint merges; 404 placeholder until then)
- Skill center, three sections: skill catalog (lights up once the upstream skill endpoint merges) / Worker × skill assignment matrix (assigned shown + save) / MCP Servers matrix (inline name/url/transport editing)
- Host skills renamed (= the local QwenPaw instance's SkillPool) + home entry
- Per-Worker runtime color tags + phase status dots; Manager detail panel (image / version / MXID / personal room / logs / DM jump); Worker DM jumps straight to the personal room
- Last-message preview on room cards; 15s auto-refresh on the workflow page + view tab memory (events / cards / kanban / topology + selected project)
- Proactive invite / approval notifications: desktop toast for new room invites + notification-center entry (jumps to the team overview to accept/decline)
- Invite acceptance fixed: `invite-accept` now uses the `/join` route — fixes "invite not received / accept does nothing"
- QwenPaw 2.0 / 2.2 dual-version compatibility (`qwenpaw_version` gate `[2.0.0, 3.0.0)`)

**Approvals**
- Host inbox approval integration: Worker tool approval requests appear in the host inbox (auto navigation shake + red dot + approval entry), one-click approve/deny, the decision auto-sends the Matrix command back to the room (zero polling, zero monkey-patch, triple `@Worker`; auto-degrades on host <2.1, the in-plugin approval card is unaffected)
- Dual-path approval loop: after an approval is granted from the plugin card, the host inbox no longer re-sends a stale deny
- Approval commands carry `@Worker` (both forms recognized); the first sync pass re-checks approvals that arrived while offline

**Knowledge graph**
- Click a file node to open its preview directly (2D/3D, three-layer race fix); enlarged hit areas (3D adaptive spheres + 2D hit rings); 3D "unresponsive click" fix (self-held click layer, drag/click separation)
- Aggregated graph team-scoped (knowledge-base aggregate graph grouped by team)

**Fixes**
- Team-creation incident - (CRD read-back + staged polling create self-check)
- Skill-center re-spam root-cause fix / plugin crash fix (bare-`import` build guard, six forms) / chat "All" single timeline

**Docs & terminology**
- 14-page product docs, Chinese + English (this repo's `docs/`)
- Controller / Higress terminology fully separated (two independent systems, each configured with its own address)

**Layout & readability**
- Portrait / mobile layout system (container = viewport width, single-column create-team card, model column much more visible in first view)
- Field labels everywhere

**Verification**
In-package version triple-check consistent (plugin.json / backend / README); tsc 0 / build green / 29/29 unit tests / in-package sensitive scan clean

**Known limits**
- The skill-catalog / channel sections depend on upstream endpoints (skill catalog / channels); until they merge they show 404 placeholder cards (expected behavior)
- The 3D graph falls back to 2D when the browser lacks WebGL
- The host inbox approval tab, when filtered by session, may not show the synthetic `agentteams` session records (navigation shake / red dot / in-plugin approval card unaffected)

---

## 0.5.0-beta.8 (2026-08-30)

- Plugin renamed to **agentteams-qwenpaw-workbench** (full rename: plugin ID / entry_page / tool prefix / display name / route / localStorage keys, with automatic migration of old keys)
- **Chat page group / DM dual tabs** (Element-style): room list, DM naming fallback (`m.direct` → worker real name), unread / blue dot
- **Knowledge graph 2D/3D dual engine**: 2D force-directed (custom d3-free physics) + 3D (three.js rendering), nodes / edges / stats bar / file preview linked
- **Four-level approval-mode card selector** (aligned with official security levels): STRICT / SMART / AUTO / OFF, unified entry for worker level and team level
- **Worker channel configuration** (section inside Team Management): QQ / DingTalk / WeCom schema-driven forms, enable / disable / restart / health check / credential fill-back
- **Full-text message search**: three-level room-name fuzzy matching (substring / ordered subsequence / Levenshtein) + message keyword search
- **Long-ID truncation component**: >16 chars shows "first 8…last 4" + hover for full value + one-click copy
- **Notification center**: aggregated invites / approvals / system events, toast + desktop notifications
- **Self-check L0-L4**: five-tier layered diagnostics (host / credentials / network / services / behavior)
- Build hard guards: bare-`import` check + sensitive-data scan in the release pipeline


---

## Install

```
qwenpaw plugin install agentteams-qwenpaw-workbench-v0.5.0-beta.12.zip
```

(Remove the old version under "Installed" in the console before reinstalling, or use the CLI with `--force`; hard refresh Ctrl+Shift+R)
