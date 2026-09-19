# Changelog

Version history of agentteams-qwenpaw-workbench.
中文版：[CHANGELOG.md](CHANGELOG.md)

---

## 0.5.0-beta.13.1 (2026-09-19)

**Worker built-in tools + read-only chats panel (putting a head on the headless QwenPaw worker)**

- **Built-in tools tab (Team management)**: consumes upstream #1255 (merged to main) controller endpoints - per-worker "enabled / async execution" switches (optimistic update with rollback), `requiresConfig` shown as a badge only (tool config values are redacted at the controller proxy boundary and never surface in any client), 404 version-gate placeholder (older controller / L2 cross-team hide, one neutral banner by design), PATCH 403 (team leader read-only / L2) flips the whole panel read-only
- **Worker sessions (entry = click the worker avatar in the room, settled 9/19)**: consumes upstream #1295 chat endpoints (ready, awaiting review) - **entry moved out of team management** (the former chats tab removed; sessions belong to the chat context, and the goal is the worker's full sessions, not a last-activity list); in a group/DM, click a worker avatar -> popup / right-click "View Sessions" -> a drawer with the chat list (name / channel / last activity, pinned & archived tags) and a detail view with a constant **agent-context banner** (the agent's working context may include compacted history and unsent tool calls/output, distinct from sent room messages), conservative content-block rendering (text straight, tool blocks compressed to labels, unknown shapes truncated JSON), idle/running status tag (hidden on 404 = QwenPaw < 2.2.1, version-agnostic gate), 404 list = placeholder banner (older controller / L2 room-boundary exclusion, indistinguishable by design)
- **Session status light moves to the avatar corner (settled 9/19)**: blue (running, 1.2s breathing) / green (finished within the last 10 minutes) / gray (idle), moved from beside the sender name to the **bottom-right corner of each worker avatar in the room** (7px dot + white ring + tooltip; heartbeat-first derivation, human senders have no mapping and show nothing) - same placement as dashboard 330257e
- **Data plane**: both reuse the existing generic Controller proxy (`/api/agentteams/*` pass-through) - zero new backend endpoints; read-only endpoints carry no audit (upstream-consistent precedent)
- **i18n**: 26 new keys registered (zh + en)

**Verification**: pytest 46/46, tsc 0, i18n ui-vs-dict audit 0 missing, check-antd 38 references all legal, vite build green

---

## 0.5.0-beta.13 (2026-09-19 - official release)

New since beta.12 (the previous official release), grouped by area:

**Chat**
- **Side-by-side split with independent scrolling** (real root cause fixed): room list and chat pane scroll separately; wide/narrow decided **aspect-ratio-first** (landscape and >=600px -> split; portrait -> single column); new Settings toggle "Force side-by-side chat layout"; new self-check card "Chat layout diagnostics" (width/height, ratio, left-pane scroll numbers, one-click re-measure); adapted to the QwenPaw host's own antd prefix (ant- / qwenpaw- class duality) so the split truly works inside the host panel
- **Worker session status dots**: blue (running, breathing) / green (recently done) / grey (idle) on room cards, worker rows and 1:1 chat headers (heartbeat-first, typing fallback)
- Message refresh is now **/sync event-driven**
- Room cards: last-message preview + collapsible member list ("N people")

**Knowledge graph**
- **2D v4 cluster-block layout**; cursor-anchored zoom (0.25x-8x), drag pan, cluster focus, cluster separation, reset
- **Cluster-overlap real root cause fixed** (cumulative row stacking + CJK width weighting) + blank-area drag pan wired (previously inert)
- 3D force parameters aligned with the dashboard's settled values; sensitive-file rules extended (credentials.yaml/yml etc. -> direct read 404)

**Workflows**
- Card/topology views rebuilt **master-detail** + top-down layered DAG (ready highlight / external-dependency notes)
- **15s auto-refresh** while the tab is active; task inspection drawer (current worker / latest artifacts / state timeline / duration)
- **In-chat workflow cards go live** (15s overlay + LIVE badge; degraded track shows no badge)
- Topology / board task details: artifact **View** (inline preview: md/images/text next to Download)

**Model gateway**
- **Write actions: Add provider / Add route** (through the Console session; Console errors surface verbatim)
- Read-only model-gateway tab (providers / AI routes / model mappings) + aggregated resolvable-alias set
- Model-gateway read-only route catalog (ops tab, L1; hides itself when the controller endpoint is missing)

**Team management & permissions**
- L2 data-plane fallbacks: team-scoped KB read (diary / KB / MEMORY.md) + worker approval read/write (OFF still L1)
- New-worker dialog: runtime list updated (CoPaw removed, DeepSeek Harness added, QwenPaw default) and split out of the create-team card
- CRD management: export JSON (all four kinds) + compact cards + brand logo replaces the building emoji
- Quick-action trio (hire human / create team / new worker) now share ONE row and are collapsible
- **Spawn tool/skill whitelist display**: spawn tree nodes now show "Allowed tools / Allowed skills" tags when the data is available — tool narrowing applied to a subagent dispatch is persisted and surfaced to the workbench through the Controller spawn endpoint; workers without such data show nothing (zero noise)

**Verification**
tsc 0 - check-antd cross-check - vite build green - pytest 46/46 - version re-verified inside the shipped archive (all three places)

**Known limitations** (as in beta.12)
- Skill catalog / channels sections depend on upstream endpoints; 404 placeholders until merged (expected)
- 3D graph falls back to 2D where WebGL is unavailable

---

## 0.5.0-beta.12.16 (2026-09-19)

**Wide/narrow now aspect-ratio-first (portrait semantics)**

- The split decision no longer keys on width alone: **landscape (container width >= height) and >=600px -> split; portrait (height > width) -> single column** -- phone/portrait-window semantics, matching Element-style clients.
- The force toggle still overrides; the self-check diagnostics card now reports the **aspect ratio** (landscape/portrait).

**Verification**: tsc 0 · check-antd 38 · vite build green · pytest 46/46

---

## 0.5.0-beta.12.15 (2026-09-19)

**Real root cause (host prefix): qwenpaw-tabs-* height chain**

- **Reproduced in the real host** (the user's own QwenPaw instance): the host ships a **custom-prefixed antd fork** -- `.ant-tabs-*` classnames do NOT exist there (`qwenpaw-tabs-content-holder/content/tabpane-active` instead) -> the whole height chain from 12.10/12.11 never matched: the left pane grew to **8193px** (74 rooms), the outer wrapper scrolled ("whole page scrolls"), the list itself could not scroll.
- Fix: the height chain + overflow guards + 575px single-column rules are now written for **both prefixes**; re-measured in the real host: left pane 300x488 bounded, last card 8208->504px internal scroll, container box unmoved.
- 12.14's threshold / force toggle / diagnostics are kept (container width 990px was the separate half of the story).

**Verification**: tsc 0 · check-antd 38 · vite build green · pytest 46/46 · **real-host verification (local QwenPaw 2.2.1 console)**

---

## 0.5.0-beta.12.14 (2026-09-19)

**Chat split trio: threshold 600 + force toggle + diagnostics**

- **Split threshold 1024 -> 600** (container width): repeated "no split" reports came from 1024-classifying host panels/narrow windows as narrow forever; below 600 keeps phone semantics, above gets the side-by-side layout.
- **New Settings toggle "Force side-by-side chat layout"**: ignores width detection entirely (narrow panels can still drag-resize / collapse the list).
- **New self-check card "Chat layout diagnostics (client-side)"**: window/container sizes, mode + threshold + forced flag, left-pane visible/content heights and overflowY -- the numeric scene for split/scroll issues, one-click re-measure.
- Reproduction bench verified: 900px -> split; 500px -> narrow; force toggle -> split at 500px; diagnostics numbers accurate.

**Verification**: tsc 0 · check-antd 38 · vite build green · pytest 46/46

---

## 0.5.0-beta.12.13 (2026-09-19)

**Model page write actions (Add provider / Add route) + container-based split**

- **Add provider / Add route (P7b)**: two write actions on the model page with the same field shapes as the dashboard models-section (provider = name/type/protocol/tokens/rawConfigs{openaiCustomUrl,pathPrefix,modelMapping}/tokenFailoverConfig; route = name/pathPredicate(PRE)/upstreams[]/modelPredicates[]/authConfig); proxied through the connector /gateway/* POST to the Higress Console (console_session). Console errors (e.g. 409 conflicts) surface in the UI.
- **Split decision now uses the container width** (investigation of the persistent report): wide/narrow detection switched from window.innerWidth to a ResizeObserver on the actual container, so an embedded panel narrower than the window no longer mis-detects as wide. Verified with a real-frontend reproduction bench (fixture data): the left pane scrolls independently (last room 5210 -> 542px, pane box unmoved).
- 4 new regression tests for the write plane (POST passthrough / no-session guard / name guard / Console detail).

**Verification**: tsc 0 · check-antd 38 · vite build green · pytest 46/46 · reproduction-bench UI smoke (create flow success + list refresh)

---

## 0.5.0-beta.12.12 (2026-09-19)

**True root-cause fix for cluster overlap (both ends) + drag-pan wiring**

- **2D cluster-block row stacking (root cause)**: `yTop = ri * (this row's max height + gap)` overlapped rows whenever heights differed (numeric repro: 588x104 px block overlap; 30-dataset fuzz: old formula 1027 overlapping chip pairs -> new formula 0). Now uses cumulative row heights.
- **Drag-pan wiring**: `onSvgPanMove` was defined but never attached to the SVG (move was a no-op after mousedown) - wired, with hover paused while dragging.
- Mirrored on the dashboard side (same row stacking fix + CJK width port); 2D look stays consistent across both ends.

**Verification**: tsc 0 - check-antd 38 - vite build green - pytest 42/42 - layout fuzz zero overlaps across 30 datasets

---

## 0.5.0-beta.12.11 (2026-09-19)

**True fix for split-pane independent scrolling (last hop of the height chain)**

- **Chat split-pane independent scrolling, completed**: 12.10 locked only the antd Tabs CSS height chain; the content-area wrapper was not flex-enabled, so Tabs `flex:1` was a no-op and the whole chain collapsed — the left pane still could not scroll independently (re-reported at install verification). This release: wrapper `display:flex` + pane `overflow-y:auto` fallback — the chain is now truly connected.
- Everything else is identical to 12.10.

**Verification**: tsc 0 · check-antd cross-check · vite build green · pytest 42/42

---

## 0.5.0-beta.12.10 (2026-09-19)

**Verification-feedback batch: chat split-pane independent scroll + topo detail sections + 2D CJK width fix + model page full display**

- **Chat split-pane independent scrolling**: fixed the antd Tabs content height chain collapse that clipped the room list — Tabs container flex fill + content-holder/content/tabpane height lock + left-pane overflow-y with overscroll-contain
- **Room-card member list hidden by default**: rooms with many members no longer stretch the card; tap the "N members" tag to expand/collapse (DM-on-member unchanged)
- **Workflow topo detail sections** (aligned with the dashboard task detail page): task distribution (status counts) + task details (N) (expandable rows: spec/summary/deliverables/transition audit) + nodes (N) two-column grid
- **Workflow view-tab counts removed**: header "Projects (N)" kept; redundant kanban/topo tab counts dropped
- **2D graph CJK width weighting**: fixed under-estimated chip widths for Chinese filenames causing horizontal overlap (root cause of "cluster overlap"); label truncation uses the same metric
- **Model gateway page full display**: requestable-model alias union block; request-model (alias) and allowed-consumer columns split (fixed the catalog source putting consumers into the alias column); fixed the per-character alias rendering bug (string spread)
- **KB sensitive-file rule extension**: standalone credentials.yaml/yml credential files now filtered (aligned with the dashboard-side B1 fix)
- **CRD management cards compacted**: padding/gap/gutter density pass
- **i18n**: new keys registered (EN+ZH)

**Verification**: pytest 42/42 · tsc 0 · check-antd cross-check pass · vite build green · i18n ui↔dict reconciliation

---

## 0.5.0-beta.12.9 (2026-09-19)

**2D knowledge graph v4 cluster-block layout + workflow-page / chat UX batch (dashboard-aligned)**

- **2D knowledge graph v4 cluster-block grid layout**: rectangular cluster blocks + chip nodes with always-visible labels + cross-cluster edge convergence at block level (aligned with the dashboard v4, replacing the intra-cluster overlap of the radial layout)
- **Workflow tab wired to the event stream**: task-transition timeline (created→running→finished/failed, upstream task-transition event stream pairing, legacy-cursor compatible with zero backfill) + i18n missing-key backlog cleared
- **Workflow page header project count**: the page header shows only the total "Projects (num)"; per-view counts dropped from each view (view labels kept)
- **Task inspection drawer**: clicking a board/card task opens a drawer with the task-level inspection (current Worker/runtime, latest artifact, transition timeline, duration)
- **A17 worker session status dot (heartbeat-first)**: three states (blue running breathing / green done / gray idle) on group-chat sender avatars + wide-screen split layout; data source = worker heartbeat agentStatus authoritative (no 120 s typing ceiling) → live typing fallback → 10-minute done→idle decay
- **Chat /sync event-driven refresh**: message refresh driven by the Matrix /sync long-poll (replacing the blunt interval); split-pane width/collapse parameterized
- **Model gateway configuration tab (read-only)**: dashboard-same-source AI gateway model configuration view (Providers / AI Routes / model mapping, read-only)

**Verification**: union four-step gate all green (pytest full pass · tsc 0 · check-antd cross-check · vite build green · i18n cross-check)

---

## 0.5.0-beta.12.8 (2026-09-18)

**2D knowledge graph zoom/focus/cluster separation + in-chat workflow card live refresh (aligned with the dashboard)**

- **2D knowledge graph zoom/pan**: cursor-anchored wheel zoom (clamped 0.25×–8×, out-of-range clamps re-anchored on the view center) + drag to pan + +/−/reset buttons; labels auto-cull above 2.5× (cluster roots + hovered label only, SVG text scales with the view)
- **2D knowledge graph cluster focus**: single-click a virtual cluster root (category/Worker root) → animated zoom to that cluster's bounding box (320 ms easeOutCubic) with out-of-cluster elements dimmed to 0.1 + a "focus · exit" chip; double-click a file node → neighborhood focus (node + 1st-degree neighbors); in a rootless graph, double-clicking a pseudo-root (highest-degree file) focuses its sector (single-click on a pseudo-root still opens the file preview — unchanged); Esc / background click / chip / reset to exit
- **2D knowledge graph cluster separation**: a GAP wedge between sectors (R≤6 sectors: 0.38 rad / >6: 0.24 rad, with 2×half+GAP = full-circle identity — fixes adjacent arc-band overlap of the old formula at R≥8) + dashed sector boundary arcs (hub color, 14% opacity); R=1 single sector = full-circle even distribution (the old 0.92-factor empty wedge is dropped)
- **In-chat workflow card live refresh**: project workflow cards are one-shot published snapshots while task progress only happens on the Controller side, so cards stayed stale. Now, when the chat tab's active room contains a workflow card, it reuses the workflow tab's 15 s controller-source poll (Controller projects/workflow dual track) to overlay status / steps / participating Workers (per-field fallback to the snapshot), with a LIVE badge (pulsing green dot + event timestamp) shown only when the controller track is connected; on source degradation (no Controller token, joined-room scan track) nothing is passed — no overlay, no badge (no misleading); workerflow cards (subagent fan-out) are already live via m.replace on the message itself — zero extra requests
- **i18n**: 1 new key registered (ZH/EN)

**Verification**: pytest 42/42 · tsc 0 · check-antd cross-check pass · vite build green (440 modules, dual guard) · i18n ui↔dict cross-check (new key registered)

---

## 0.5.0-beta.12.7 (2026-09-18)

**Major 2D/3D knowledge graph overhaul + workflow page rework (cards/topology → project list + detail)**

- **2D knowledge graph switched to a hierarchical radial layout**: category roots (Wiki/Personal/SOP) or Workers (aggregated mode) form sectors, hubs centered, files arranged by BFS depth rings sorted by name, crowded rings auto-overflow into concentric rings, labels get a halo stroke and the viewbox fits the content — replacing the old pure force layout (cross-category nodes intermixed, hairball edges, overlapping labels); same algorithm and values as the dashboard KB 2D graph
- **3D knowledge graph tightened further**: charge -60→-50, link distance 44→38, link strength 0.5→0.52 (one more step of clustering, same values on both surfaces); label policy aligned with the dashboard (all nodes labeled; the old count≤42 condition dropped)
- **Workflow cards view reworked to master-detail**: left = project list (time/status/name sorting, independent scroll, status-color bar highlight), right = detail of the selected project (event card + task-card grid reusing the board's task cards incl. cancel/retry); the left selection is shared between the cards and topology views
- **Workflow topology view reworked into a layered DAG**: ports the dashboard task-board algorithm (edges from dependsOn, top-down layering, bezier edges with arrows, ready-state dashed cyan frame/dot, external-dependency note) replacing the old indented tree; cyclic/rootless graphs still get an honest hint
- **More specific empty states**: a selected project still in planning now says "may still be planning (Coordinator drafting)" in the cards/topology views instead of a generic empty state

**Verification**: pytest 42/42 · tsc 0 · vite build green (440 modules, dual guards) · i18n ui↔dict cross-check (6 new keys registered, zero orphans)

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
