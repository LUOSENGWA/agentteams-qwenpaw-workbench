# Changelog

Version history of agentteams-qwenpaw-workbench.
Chinese version: [CHANGELOG.md](CHANGELOG.md)

## 0.5.0-beta.16.23 (2026-10-26 - Millforge inject fix)

**Fixed**
- **Every Millforge injection failed (HTTP 301 / Controller unreachable)**: `_ctl_call` takes a path only (the base is prepended from the ordered address list), but the injection call sites historically passed a full URL (`f"{base}/api/v1/..."`). Prepending the base again produced a double-base URL (`https://h:7113https://h:7113/api/v1/...`) that the gateway answered with 301 or stalled until timeout, so SOUL updates, worker creation and core-skill attach all failed. The entry point now normalizes the target to path+query, accepting both full URLs and path-only strings.
- **Core-skill upload returned 400 (`the zip must contain a single top-level skill directory`)**: the core-skill zip put `SKILL.md` / `references/` / `scripts/` at the archive root while the controller requires exactly one top-level skill directory (its name becomes the skill name; root-level entries are rejected). Every entry is now wrapped under `millforge-core/`.
- **Core-skill attach reported "no skills data" for every worker**: the attach step read assigned skills from `GET /api/v1/workers`, but the controller lists workers under `"workers"` (with a `total` sibling) while the code looked at `"items"`, so the map stayed empty. Read `"workers"` instead; the fake controller in the tests is corrected too (it returned `"items"`, which hid the mismatch).
- Added the regression test `test_ctl_call_normalizes_full_url_and_path_only` (fails on the double-base URL, passes with both forms normalized) and tightened the I3 core-skill test to assert the single top-level directory.

## 0.5.0-beta.16.22 (2026-10-26 - provider prefill)

**Fixed**
- **Provider was not pre-filled like the model**: the older Controller's `WorkerResponse` does not return `modelProvider`, so the field appeared empty. The dialog now uses the Controller's `modelProvider` when available and otherwise derives it from the selected alias's `binding.providerName` — the current provider is pre-filled just like the model (the rebuilt Controller's real value still wins).

## 0.5.0-beta.16.21 (2026-10-26 - model hot-reload + worker/manager restart)

**Added**
- **Worker / Manager restart buttons**: the worker detail panel and the Manager table now have a Restart action — no more SSH. The Controller exposes `POST /api/v1/workers/{name}/restart` and `POST /api/v1/managers/{name}/restart` (stop + start; the container is recreated and reads its config/model fresh).

**Fixed**
- **Model changes did not take effect hot**: `model` is excluded from the container-recreation hash (config-only), but the primary model was only written to the runtime config and never triggered QwenPaw's in-process reload, so it looked like a restart was required. The reconcile now also PATCHes `active_model` through the worker's `model-settings` endpoint (same path as the subagent model), which mutates agent.json and schedules an in-process agent reload.

## 0.5.0-beta.16.20 (2026-10-26 - model editor carries the provider)

**Fixed**
- **Model selection had no effect with multiple Higress providers**: the Worker CR's `model` is only the request alias; the actual upstream is chosen by `modelProvider` (the APIG Model API name). The editor used to send `model` only, leaving the provider on the old value, so switching aliases still hit the old provider. The standalone worker model dialog now has a **Provider** field: picking a configured alias auto-fills its provider (from Higress alias→binding.providerName), and it can also be selected/cleared manually; save sends only changed fields (`model` plus `modelProvider` when changed) under PUT merge semantics.

## 0.5.0-beta.16.19 (2026-10-26 - WeChat QR via direct iLink, no Controller rebuild)

**Fixed**
- **WeChat QR login works without rebuilding the Controller**: iLink's `get_qrcode_status` is a long-poll the server holds for ~31s, and the Controller's channel proxy (5s) aborts it. The plugin backend now polls iLink **directly** (45s timeout) and then writes the resulting `bot_token` through the normal channel `PUT` (a fast write; 5s is plenty). So the plugin's WeChat QR flow completes even on an un-upgraded Controller. The Controller's 45s long-poll fix (commit `290195f8`) is still worth shipping with the next release for consistent semantics and other long-poll routes.

## 0.5.0-beta.16.18 (2026-10-26 - QR long-poll + standalone worker models)

**Fixed**
- **WeChat QR login could never complete**: QwenPaw's WeChat login relies on iLink `get_qrcode_status`, a long-poll that the server holds for ~30s. The plugin backend proxy read timeout (6s) and the Controller channel proxy (5s) both aborted it before it returned, so the plugin never saw `confirmed` and the phone showed "please upgrade the WeChat interface version in OpenClaw". All three hops now allow the long-poll: the plugin backend uses a 45s read timeout for `…/qrcode/status`, the Controller uses a dedicated 45s long-poll client for that route, and the QwenPaw client stays at 60s. Consecutive polling failures are now surfaced in the UI instead of being swallowed.
- **Ungrouped (standalone) workers could not change models**: workers without a team are grouped under the pseudo-team "未分组"; its gear opened the team-config entry, which looked the name up in the CRD team list and failed with "team data not loaded or team missing" — and that dialog was the only place to edit a model. The gear now opens a standalone-worker model dialog (`PUT /workers/{name}` with `model` only; merge semantics leave provider and other fields untouched).
- **WeChat channel fields aligned with the QwenPaw Console**: framework-internal keys the Console's WeChat drawer never shows (`base_url` / `dm_policy` / `group_policy` / `allow_from` / `deny_message` / `dm_disabled` / `group_disabled`) are hidden and no longer written back on save.

**Verification**: frontend tsc 0 · vite build 2,092.65 kB single file (gzip 590.63 kB) · Controller go build/vet 0 + full server package tests green (new long-poll regression test) · plugin backend py_compile/import ok

## 0.5.0-beta.16 (2026-10-22 - official release)

**Merged release of sub-batches 15.1–15.41 (full mobile/portrait + touch support, local offline mode, full AgentTeams 1.2.5 feature integration, complete Coding CLI management chain, LLM tuning + runtime batch upgrades, layout audit to zero overflow, regression fixes; pytest 374→456, i18n 1,424→1,616 keys)**

- **Mobile/portrait + touch support everywhere**: full dark-mode adaptation (40 hardcoded colors tiered, black-translucent texts + gray/black translucent backgrounds migrated to theme tokens) + all 58 tooltips tappable + 44px touch targets + safe-area + unified portrait detection (root-cause fix for landscape being misjudged as portrait) + compact chat header (6+ controls folded into a ⋯ menu) + 9 rounds of per-page portrait polish (chat input rebuild / workflow cluster rework / 3-tier board layout / skill-detail dialog / tab-slide root fix / chat file references / approval-color convergence) + knowledge-graph touch gestures (two-finger pinch / one-finger pan / double-tap focus + wheel zoom) + version number on the home page
- **Local offline mode + audit panel**: data plane makes zero network calls when there is no QwenPaw backend (entry mount suppressed — the 503 banner flood is structurally gone) + config plane kept locally (masked credentials, backup/restore import) + honest two-step connection probe (reachability / CORS attributed separately) + audit tab (upstream persistent audit, L1 full / L2 own team, 3-dimension filters + keyset pagination)
- **AgentTeams 1.2.5 integration + two-axis host contract**: worker env-var editor + gateway probe / coding-run log viewer / runtime upgrade panel (4-gate precheck + two-phase in-place upgrade) / per-worker runtime version (measured in-container) + two-axis host contract (host.env.kind + caps, consistent feature surface in standalone mode) + three-source version-consistency gate
- **Complete Coding CLI management chain**: install / upgrade / uninstall for all 3 CLIs (qwen-code / opencode / qoder) + update check (npm registry queried host-side) + settings forms driven by the official schema (all fields, EN/ZH adaptive, empty state editable) + collapsible section cards with current-value summary (unsaved-change badge + adaptive layout) + credential migration + up-front warnings for known CLI pitfalls
- **LLM tuning + runtime batch upgrade + cluster version card**: LLM tuning panel (worker + team default, two layers, 10 fields with hot-apply / restart-required labels) + batch runtime upgrade (team-grouped selection, inline current versions) + cluster version card (real AgentTeams + Higress versions, topology-aligned) + update check 7× faster
- **Cardification + layout audit to zero overflow**: CLI card accordion + 11 tabs × 6 widths = 72-cell real-overflow audit at 0 + 44px touch-target probe 51/51 + 111 dead strings cleaned up + room list bounded loading (76 rooms 21.9s → 5.8–8.6s) + event stream connected instantly (~15s → 0.003s) + window-drag stutter root-caused
- **Regression fixes + member detail card session entry**: full-page whiteout when opening a session detail (root-cause fix of a 14.x latent conditional-hook bug) / missing input box misreported as "no permission" / half-clipped board cards / narrow-screen field overflow / 3 real Coding CLI bugs (model-name save always disabled / array corruption / empty leaves not stripped) + new "View Sessions" button on the worker member detail card (same target and gate as the avatar entry)
- **Security hardening + tech debt (no user-visible changes)**: password gate for full-config export/import (separate 0600 store, default deny) + model-format root-cause fix + 180s-timeout read-back verification + noUnused dead-code gate + dedicated tech-debt batch (18 oversized files split, 10 duplicated groups consolidated, 75 redundant exports collapsed — zero user-visible)

**Verification**: tsc 0 · vite build single file 2,009.70 kB (gzip 567.63 kB, 0 import statements) · pytest 456/456 · i18n 1,616 keys 0 missing 0 dup 0 empty · harness-cli 50/50 · 137 24/24 · 138 35/35 · sensitive scan 0 (staged added lines + full chain 80b637d..HEAD messages CJK 0 / MARK 0)

## 0.5.0-beta.15.41 (2026-10-21 - session view entry on member detail card)

**Added**
- **"View Sessions" button on the member detail card**: the member detail card for worker members now has a "View Sessions" button — it opens the worker's full sessions directly, with the same behavior and visibility conditions as the "View Sessions" entry from clicking an avatar in chat.

## 0.5.0-beta.15.40 (2026-10-21 - session detail white-screen crash fix)

**Fixed**
- **Opening a session detail white-screened the whole plugin**: opening any session from a worker's chat list (clicking the card or its "View" button) crashed the entire plugin UI to a blank screen. The issue existed since the 14.x series and is now fixed at the root; session details open and close normally.

## 0.5.0-beta.15.39 (2026-10-21 - chat regression fix + message-stream polish)

**Fixed**
- **Room composer disappeared**: opening a group/DM room incorrectly showed "You don't have permission to send messages in this room" and hid the input box, blocking sending. Fixed: the composer is back and you can type and send normally.

**Improved**
- **Jump-to-bottom button easier to tap**: when you scroll up in the message stream, the "↓" button now has a larger tap area and press feedback, so it is easier to hit and responds to presses.
- **New-message badge capped**: in long-running conversations the "N new messages" badge is capped at 99 so it no longer grows without bound.

## 0.5.0-beta.15.38 (2026-10-20 - tech-debt batch: oversized file splits + dead code removal + duplication convergence)

Pure internal code-structure refactoring (7 batches, 20 commits). UI and behavior are identical to 15.37 with zero user-visible change; the goal is maintainability (the full audit found 18 oversized files of 1,100-4,600 lines, 6 dead functions, 75 redundant exports and 10 duplication clusters - all addressed).

**Improved**
- **Dead code removed**: 6 repo-wide unreferenced functions and 2 dead types deleted; 75 redundant `export` keywords removed (module public surface unchanged); 2 `print` calls converted to `logger`; 2 export names aligned with their file names.
- **Oversized files split**: 18 large files (1,100-4,599 lines) split into domain submodules, each with a verified "public-surface identity":
  - Frontend API layer: 4,583 lines -> 22-line barrel + 14 domain modules, 228 public exports identity-verified
  - i18n dictionary: 2,669 lines -> 73-line merge shell + 10 domain dictionaries, 1,616 keys identity-verified
  - 4 backend modules: all 68 registered routes identity-verified, 456 tests unchanged
  - 13 large component files: 1,139-4,599 lines -> shells of <=1,400 lines + domain submodules (logic hooks / rendering / constants separated by responsibility)
- **Type hardening**: all 11 `any` annotations in the 3D graph component replaced with concrete types (0 remaining).
- **Duplication converged**: 7 of 10 duplication clusters extracted into shared components/helpers (the other 3 analyzed as "shape-similar, logic-different" and left as-is to avoid over-engineering).

**Verification**
- Per-file non-empty-line conservation checks + public-surface set diffs empty (228 frontend exports / 68 backend routes / 1,616 dictionary keys)
- 72-cell DOM overflow full scan x 11 rounds: 0 true overflows (identical to the 15.37 baseline)
- tsc 0 | vite build 593 modules (2,008.60 kB / gzip 567.32 kB) | pytest 456/456 | i18n gate 1,616 keys, 0 missing, 0 dup | staged-diff sensitive scan 0

## 0.5.0-beta.15.37 (2026-10-20 - full-audit fix batch: narrow-viewport overflow cleared + touch targets + room-list latency)

Systematic fixes following the full audit (11 tabs x 6 widths x light/dark themes x touch/narrow cross-sections); every finding root-caused, fixed and re-verified to zero.

**Fixed**
- **Room list loading slow**: pages depending on the room list (home / chats) took 20+ seconds with many rooms (~76), hanging up to 2 minutes when the upstream slowed down. Now bounded loading: per-request time limit, parallel fetch, worst case ~14s with partial results returned on timeout instead of a full-page hang.
- **Event-stream connection delay**: the home "events: connected" indicator could take up to 15s on slow networks / first open; the connection is now established immediately (first heartbeat no longer blocks response headers).
- **Narrow / portrait content clipped horizontally**: 5 measured overflows cleared to zero - home SGLang status card and header row (390/480px), model gateway route table (390px), ops upgrade version table (390/480/600px), knowledge-base agent card (390px). Route and version tables scroll horizontally on narrow screens to show all columns; status card and header row wrap/truncate on narrow screens, wide-screen rendering unchanged.
- **Ops component log row (768px mid screen)**: the auto-refresh toggle could be pushed against the right edge and the refresh button could wrap on transient layout widening. The row is now immune to transient widening (hint text can shrink), button no longer wraps.

**Added**
- **Touch tap-target size class**: on touch devices (phone / tablet), buttons, icon buttons, inputs, selects, segmented controls, tabs and switches get a unified >=44px hit area (industry-standard tap target; previously ~24px, easy to mis-tap). Switch appearance unchanged, only the vertical hit area grows; desktop (hover available) is completely unaffected.
- **Repro audit pages**: `dev-alltabs-overflow.html` (all-tab x 6-width overflow scan, with touch repro mode `?touch=1`) and `dev-theme-input.html` (theme input / 44px probes) for future regression.

**Improved**
- **Touch chat time visibility**: on touch, the first row of a chat message group (avatar + name) always shows the time; no longer requires a tap to reveal.
- **Dictionary and code convergence**: 111 zero-reference dead i18n entries removed (1727 -> 1616), 1 dead icon removed; 4 duplicated message-send code paths converged to a single implementation (byte-equivalent behavior, no UI change).

**Verification**
- **11 tabs x 6 widths = 72-cell DOM overflow scan: 0 true overflows** (audit baseline: 15 true overflows / 50 sources / max +76px)
- **Touch probes (390px + touch mode): 9 buttons / 19 segmented / 13 inputs / 4 selects / 5 switches = 51/51 pass**, with no new overflows
- **Room list measured**: 76 rooms 21.9s -> 5.8-8.6s (bounded); event stream first response 0.003s (previously ~15s)
- tsc 0 | vite build 514 modules | pytest 456/456 | i18n gate 1616 keys, 0 missing, 0 dup | staged-diff sensitive scan 0

## 0.5.0-beta.15.36 (2026-10-19 - team management portrait overflow fix: manage-entry row wraps, zero overflow on narrow screens)

Addresses fielding feedback: in team management, after expanding a worker, the manage entries (runtime config / environment variables & gateway probe / coding CLI / LLM tuning / resources) "were not laid out well in portrait and ran past the container edge".

**Fixed**
- **Manage-entry row overflowing the container in portrait**: in narrow mode the worker manage-info area renders five entries (wake/sleep + runtime config + env vars + coding CLI + LLM tuning) in a single non-wrapping flex row. The buttons' total min-content width is 461px, while a 390px phone viewport leaves only 274px of container width — the "Coding CLI" button's right edge exceeded the container by 69px and "LLM tuning" by 170px (measured in the DOM). The row now wraps (at 390px it naturally breaks into 3+2 rows with every button fully visible and tappable); the wide-screen single-row layout is unchanged.
- **Audit pages restored**: an earlier hygiene commit stripped the empty arrow-function parameter lists (`() => {}` became `=> {}`) from the inline scripts of `dev-overflow.html` / `dev-split.html`, leaving the two overflow-audit pages uncompilable. Restored as-is.

**Added**
- **Expanded-area overflow audit page** (`dev-manage-overflow.html`): the previous audit page only rendered the collapsed team tree, so the worker expanded area (manage info + the five section cards / entry rows) was blind. The new page covers both modes — narrow compact-button rows / wide inline cards — with per-entry probes (row clientWidth vs scrollWidth vs container right edge) plus a full out-of-bounds element scan, quantifiable across many widths in one run.

**Verification**
- **DOM overflow scan at 6 viewports (390/480/600/768/800/1024): manage-entry rows all at zero** (before: 390px overflowed 187px, 480px 97px; after: every row's right edge ≤ container right edge, wide-screen 800/1024 inline-card sections show no regression)
- tsc 0 | vite build 514 modules | pytest 456/456 | staged-diff sensitive scan 0

## 0.5.0-beta.15.35 (2026-10-19 - coding-CLI settings cards: dynamic layout/sizing fixes, zero overflow on narrow screens)

Addresses the fielding feedback: the 15.34 section cards "did not dynamically adjust their layout, size and content — some content overflowed the container and the cards looked rough overall". Each item fixed and verified by quantified DOM overflow scans at 5 viewport widths (390/500/700/1000/1280).

**Fixed**
- **Field controls overflowing section cards on narrow screens**: field rows were fixed-label + fixed-control non-wrapping rows, so on narrow cards (~300px portrait) the combined width exceeded the container — at 390px the Model card overflowed by 123px and the Tools card by 100px, controls clipped into slivers. Rows now wrap, labels size to content, and controls are elastic (`flex: 1 1 200px`) — **on wide screens label and control share a row and the control stretches with the card; on narrow screens the control wraps under the label at full width** (the standard mobile form pattern). Long monospace field names may break anywhere and no longer force row width.
- **300px minimum card width bursting very narrow containers**: at a 390px viewport the panel content is only ~280px, and the `minmax(300px, 1fr)` track floor of 300px exceeded the container, overflowing the whole card by 20px. Now `minmax(min(300px, 100%), 1fr)` — tracks may shrink below 300px when the container is smaller (unchanged at ≥300px).
- **Layout/size chain completed**: the settings editor root, object containers, section card bodies and the JSON-patch container all use `minmax(0, 1fr)` tracks (preventing grid items' `min-width:auto` from pushing content past the container); field rows get `min-width: 0` + `flex-wrap`.

**Improved**
- **Section cards at natural height, top-aligned**: `align-items: start` — tall (9-field) and short (1-field) cards in the same row are no longer stretched to equal height; the dead space under short cards is gone and 2/3-column layouts look tidy.
- **Form sizing follows the container**: text inputs 200px elastic basis (wraps to full width when narrow, up to 460px when wide), enum selects 220px elastic, number inputs shrinkable — one codebase stays fully usable from a 390px phone to a 1280px desktop with no hard-coded breakpoints.

**Verification**
- **DOM overflow scan at 5 viewports (390/500/700/1000/1280) = 0** (before: 390 +123/+100px, 500 +33/+10px, 1000 +12px, 1280 +12px, 390 CLI card +8px)
- tsc 0 (noUnused) | vite build | i18n gate 1727 keys | pytest 456/456
- ui-harness-cli **50/50** (full S1–S12 regression: card toggles / section cards / current-value summary / change dots / adaptive layout / touch all unaffected)

## 0.5.0-beta.15.34 (2026-10-19 - coding-CLI settings second-level cards: section cards with current-value summary + adaptive layout)

The coding-CLI settings form is upgraded from "one long field list" to **section cards** — one collapsible card per top-level group (Model / Context / General / Tools / Security / ...), isomorphic to the 15.33 CLI cards. Card header = group title + **current-value summary** (the values already present in the config file / seed template, visible at a glance even while collapsed) + **unsaved-changes dot** (lit when that section has unsaved edits); **sections with content are expanded by default, empty ones collapsed** — existing configuration is visible at a glance while catalog-only empty sections no longer occupy the screen. Each card toggles **independently** (not an accordion — settings work often means comparing two groups while editing).

**Added**
- **Section cards**: every top-level group in the settings form is a card. Click the header to expand/collapse (chevron, `role=button` + `aria-expanded`, screen-reader friendly); any number of cards can be open at once.
- **Header current-value summary**: the header shows the group's existing leaf values (up to 2 + "+N", single-line clamp) — e.g. `useRipgrep=true`, `auth.apiKey=•••` (redacted values render as •••); empty sections show no summary. Expanded form fields are likewise pre-filled from the current config file.
- **Per-section unsaved-changes dot**: editing any field in a section (including the dedicated model row) lights an orange dot on that card's header; it clears after saving.
- **Adaptive layout**: the section grid uses `repeat(auto-fit, minmax(300px, 1fr))` — multiple columns on wide screens, a single column on portrait/narrow, same auto-fit approach as the CLI cards, no hard-coded breakpoints.
- **Touch + mouse support**: section card headers get a ≥44px touch target + `userSelect:none`; mouse gets cursor pointer + chevron with no hover-only information.

**Fixed**
- **Catalog groups silently missing**: since 15.32 the top-level group list only took dot-free catalog keys, while groups such as context / general / ui / modelFamily / goals / memory / agents / mcp / serve / advanced / experimental are only defined via dotted keys (e.g. `context.autoCompactThreshold`) — **those groups did not render at all when absent from the config file**. Top-level groups are now catalog keys ∪ dotted-key prefixes, so every group renders (21 groups for qwen-code; same logic for opencode / qoder).

**Verification**
- tsc 0 (noUnused) | vite build | i18n gate 1727 keys, 0 missing, 0 duplicates | pytest 456/456
- ui-harness-cli **50/50** (new S12 section-card suite, 6 assertions: content section expanded by default / empty section collapsed by default / header current-value summary / header click expands / second click collapses / field edit → per-section unsaved-changes dot)

## 0.5.0-beta.15.33 (2026-10-19 - coding-CLI panel reworked into collapsible cards + adaptive layout + touch/mouse support)

The coding-CLI panel (install / upgrade / settings) is reworked from "three-row list + single settings area" into **collapsible cards** — one card per CLI; clicking a card header expands it to show that CLI's actions (install / upgrade / uninstall) + the structured settings form, clicking again collapses it; **accordion** semantics (at most one card expanded at a time — expanding another auto-collapses the previous one). Settings-field **coverage for all three CLIs confirmed** (qwen-code 107 / opencode 36 / qoder 21, official-schema driven, landed in 15.31/15.32, re-verified here).

**Added**
- **Collapsible cards**: one card per CLI. Card header = CLI name + installed/version/update/auth badges (click = expand/collapse, with a chevron); the expanded card spans full width and shows that CLI's actions row + settings form. The former standalone "edit settings" button is retired — **expanding reveals the form** (settings are fetched on demand when expanding; zero requests if already cached).
- **Accordion interaction**: clicking a card header while another card is expanded auto-collapses the previous one — at most one card is open at any time, so long forms never stack.
- **Adaptive layout**: the card grid uses `repeat(auto-fit, minmax(260px, 1fr))` — 3 columns on wide screens, 2 on medium, 1 on narrow, reflowing automatically with container width and no hard-coded breakpoints.
- **Touch + mouse support**: card header ≥44px touch target + `userSelect:none` (no accidental double-tap text selection on touch); action buttons at middle size + `wb-touch-lg` (hit area enlarged to ≥44 without changing visual size); in the portrait NarrowSheet, small buttons get a 32px height floor and the tap highlight flash is removed. Mouse path is unchanged (cursor pointer + chevron, no hover-only information).

**Improved**
- **Settings attribution, no cross-card bleed**: the settings shown for an expanded card are attributed by the `cli` field carried in the response, so a previous card's stale data never shows during the cross-card fetch window.
- **Cache kept on collapse**: collapsing a card only hides the DOM, it does not drop the fetched settings — reopening the same card costs zero requests.
- **All-3-CLIs coverage confirmed**: qwen-code 107 fields / opencode 36 / qoder 21 (full official schema, catalog-driven, empty states also rendered), same source as the dashboard.

**Verification**
- tsc 0 (noUnused) | vite build 514 modules | i18n gate 1726 keys, 0 missing 0 dup | pytest 456/456 (incl. three-source version alignment — fixing the 15.32 leftover where the connector version was not bumped)
- ui-harness-cli **44/44** (new S11 card-ification, 6 assertions: initial all-collapsed / header-click = expand + auto-fetch / accordion switch / re-click to collapse / narrow 390px single column / wide 1280px multi-column; mock gains an opencode settings route — the real API serves any CLI, the old mock only had qwen-code)

## 0.5.0-beta.15.32 (2026-10-18 - coding-CLI settings forms completed: field-catalog driven + bilingual zh/en + modelProviders marked as Higress-managed)

The three CLI settings forms are upgraded to be **field-catalog driven** — the documented field list (type + bilingual zh/en labels) is registered in a catalog, so **fields that are not yet set also appear in the form (as empty states)**, and only the fields you actually change and save are written to the config file. The forms are also **bilingual (zh/en, auto-switching with host language)**.

**Added**
- **Complete settings forms (field-catalog driven)**: qwen-code covers the bulk of the fields editable in the Web Shell's in-browser Settings page (~100 fields across model subfields, model family, context, tools, memory, agents, mcp, security, serve, advanced, experimental); opencode (server/shell/per-tool toggles/image attachments/per-action permission/compaction, etc.); qoder (outputStyle/language/full ui/model subfields/tools/full security/statusLine). Fields outside the catalog remain reachable via the JSON patch.
- **Bilingual (zh/en) forms**: field labels, section titles, and input hints carry both languages and switch automatically with the host locale.

**Improved**
- **qwen-code `modelProviders` is now marked as "managed by the Higress gateway (defaults to the Worker)"**: the empty-state form no longer pre-fills route cards; when the file already has `modelProviders`, a gateway-managed notice is shown while the route cards stay editable (gateway behavior depends on the actual deployment).
- **Empty-state seeds slimmed to the few pre-fills that carry meaning** (model request timeout / approval mode / compact threshold / theme / auto-update), so CLI defaults are no longer written into the config file.

## 0.5.0-beta.15.31 (2026-10-18 - coding-CLI settings forms for all 3 CLIs completed to the full official schema + deprecated credential-field migration + 3 real-bug fixes + UI harness rebuilt)

The settings forms for all three CLIs are completed to the **full official schema** (every field read from the official docs, none guessed), credentials move to the canonical location, and the rebuilt UI harness surfaces **3 real bugs** in the process (2 latent regressions + 1 introduced by this batch). Background: Qwen Code's settings previously showed **only a few fields — security / auth / selectedType / JSON patch** — because the 15.30 seed template carried just 3 fields, and its credential fields `security.auth.apiKey/baseUrl` are **marked Deprecated** by the official docs (the 0.25.x "New Configuration Format").

**Added**
- **Full official-schema empty-state forms for all 3 CLIs** (`codingCliPresets.ts`; every field verified against the official docs):
  - **qwen-code** (qwenlm.github.io settings + model-providers, full field tables): `model` (reasoningEffort/maxToolCalls/generationConfig), `fastModel`, `modelProviders` (canonical credential home), `tools` (approvalMode/shell), `permissions` (allow/ask/deny), `context` (autoCompactThreshold), `mcp` (allowed/excluded), `mcpServers`, `security` (folderTrust/auth.selectedType), `telemetry`, `general`, `ui`.
  - **opencode** (opencode.ai/docs/config): `$schema`/`small_model`/`permission` (edit/bash/webfetch)/`tools`/`mcp`; provider goes through the JSON patch (the project-level-only caveat stays a warning).
  - **qoder** (docs.qoder.com/cli/settings, qwen-code's same-origin three-tier config): `outputStyle`/`language`/`ui` (theme/autoThemeSwitching/maxTurns)/`tools` (useRipgrep/shell)/`security` (folderTrust/disableYoloMode)/`mcp`/`mcpServers`.
- **Per-CLI JSON-patch placeholder** (`patchPlaceholder`): qwen-code shows an `env`-block + model-generation-config example, opencode a provider example, qoder an mcpServers example — surfacing "the field this CLI most often needs a patch for" right in the input box.

**Improved**
- **Credentials moved off the deprecated field**: qwen-code no longer prefills `security.auth.apiKey` (Deprecated). The API key goes to **`modelProviders[].envKey` + the top-level `env` block** (JSON patch `{"env":{"OPENAI_API_KEY":"sk-..."}}`) or the container `~/.qwen/.env` — per the official Model Providers docs. Added **deprecated-field detection**: a non-empty `security.auth.apiKey/baseUrl` in base (including the read-back redacted shape) → red Alert with the migration path (a redacted value never false-positives; neither does an empty string).
- **`modelProviders` route arrays become structured cards**: previously a whole-array JSON textarea (one direct cause of "I only see security/auth"). Each provider's model routes are now individual cards (`id`/`name`/`envKey`/`baseUrl`/`wireApi` form + add/remove), with `envKey` defaulting per provider (openai/anthropic/gemini) — "add a route" goes from hand-typed JSON to click-and-fill.
- **qwen-code `model` object's `name` subkey is owned by the model row**: skipped in the tree (with a "← managed by the Model row above" hint row) to avoid a dual source; on save `{name}` **deep-merges** with the tree's subfields (reasoningEffort/generationConfig) (a direct overwrite would drop subfields edited in the tree).
- **i18n fixes**: the `{cli} settings (structured form…)` title was hardcoded Chinese (showed Chinese even in EN mode) → now a template key; the 3 CLI warning texts realigned to the new source text; +7 keys (1724 keys, 0 missing, 0 dup).

**Fixed (3 real bugs, all surfaced by the rebuilt UI harness)**
- **[regression since 15.27] the save button stays disabled when only the model name changes**: when 15.27 added the "model row", the model value was wired into `handleSave` but **missed the editor's `dirty` flag** → changing only the model name (with no tree field touched) left `diffSettings` empty → "no changes" + save button disabled, **so the model could not be changed**. Extracted a `modelNameOf()` helper (object `{name}` / flat-string dual format) so `settingsModel` (read) / `dirty` (check) / `handleSave` (base compare) all share **one code path** (no drift); `modelDirty` now joins `dirty`.
- **[introduced by this batch] `assignPath` corrupted an array into an object**: 15.31's route cards build a path that passes **through an array** (`modelProviders.openai[i].field`); the old `assignPath` saw `child` was an Array, judged "not an object", and set `cursor[key]={}` — **overwriting the whole route array with an object** (`openai:{"0":{...}}`, losing the array). Arrays are valid containers: keep them; only create a missing/invalid intermediate by the **next key** (digit index → array, else object).
- **[introduced by this batch] `stripEmptyLeavesNotInBase` did not recurse into array elements**: it handled only top-level "empty array/object/empty string" shapes, **not objects inside array elements** → an empty-state save wrote the seed route entry `{id:"",name:"",baseUrl:""}` verbatim (dirty fields). Now each element is stripped against its base element (a user-clearing-`""` of a non-empty base field keeps clear semantics; an all-new element stripping to `{}` is dropped; a key left as `[]` with an empty base is dropped too — zero dirty fields).

**Verification**
- **UI harness `ui-harness-cli.mjs` rebuilt and made real** (it had gone stale after the 15.30 tree-editor rewrite and was red without anyone noticing): the mock GET response now uses the real `{cli,path,exists,settings}` shape (the old bare settings object was defensively unwrapped to an empty tree by `getCliSettings` → S4+ were all blind); dropped the S6 preset assertion (retired in 15.28); fixed selectors (save button "保存改动" / model placeholder / version placeholder / JSON-patch textarea excluding antd's hidden textarea / model row via `input.ant-select-selection-search-input` + Playwright fill); **+S9** (routes: route cards ×2 + add + model.name owned-by-row hint + row reads the object name + route edit → patch has modelProviders + redacted sentinel) and **+S10** (seed: prefill visible in input values + save produces a zero-dirty patch + model object merge) = **36/36 green, pageerror 0**.
- **Pure-function gate** (real source extraction executed, not copy-paste): strip 7 + strip-array-element 4 + assignPath 4 = **15/15 green**.
- **Real E2E** (local production android-dev, the only worker with qwen-code installed): empty-state seed full save → read-back all fields, zero dirty; a complete route + env key read back redacted (on disk); the deprecated-field detector judged the redacted / clean / plaintext three states correctly; final state = model `qwen3.6-27b-fp8` + route → local SGLang 7113 + `envKey`/`env`, deprecated fields cleared.
- tsc 0 (incl. noUnused gate) · vite build 1,977 kB (514 modules) · **pytest 456/456** · i18n 1724 keys 0 missing 0 dup · sensitive scan 0 · version trio 15.31 (`test_version_consistency` gate caught a missed bump in `frontend/package.json`, now fixed).

## 0.5.0-beta.15.30 (2026-10-18 - stream-timeout prefill flaky fix (8s exec cap + 120s TTL cache + stale fallback + fresh bypass) + coding-CLI settings empty-state structured form real fix (incl. 2 latent render/merge bugs) + three-CLI known-pitfall warnings)

This batch = 15.29 acceptance feedback (3 items: (1) LLM-tuning "first-output / idle timeout" prefill is **present on some workers and absent on others**; (2) Qwen Code settings **still not usable** (no structured form); (3) is the *other* coding CLI (opencode / qoder) config **covered**?). All three are attributed layer-by-layer and fixed at a single point.

**Fixed**
- **Stream-timeout "present on some, absent on others" = a runtime-env read that is flaky (the real root cause, not a config difference)**: 15.28 wired the stream-group prefill chain to `GET /workers/{name}/runtime-env`, which reads the container PID 1 effective value. But measured, that endpoint is **intermittently flaky** — of 29 same-image/same-runtime workers, 5 came back `count=0` and 24 `count=55`, and the same worker flaps 55↔empty across re-reads; digging in, the flaky shape is a **docker-exec hang of ~20-30s, bursty** (12 consecutive reads: 3 hung 20s+, the good reads are 1.3s), not a simple empty read. On an empty read/hang the prefill degrades to QwenPaw's built-in default of 30s (the true effective value is the 300s the entrypoint sets) — both wrong → the user sees "present on some, absent on others". Fix (`runtime_env_api.py`, following the existing `upgrade_api._probe_cache` precedent): (1) **exec cap 8s** (normal 1.3s; a hang fails fast at 8s instead of 30s); (2) **120s TTL cache** (env values only change on a container rebuild / an llm stream hot-apply, so after the first success the panel is immune to the flakiness); (3) **stale fallback** (if a fresh read fails but a prior cache exists → return the last value, never empty, never hang — the prefill chain always gets a real value); (4) **`?fresh=1` bypass** (post-save confirm reads the hot-applied true value). +4 regression tests (cache hit = no re-exec / stale fallback / no-cache 502 / fresh bypass). **Real E2E**: sysdev-lead first fresh 1.65s then 11× ~0s cache hits; 5-worker real reads max latency 8.01s (tech-writer's hang capped at 8s → 502, not 20-30s).
- **Coding-CLI settings "not usable / no structured form" — the real root cause is two latent bugs, not a missing field**: (1) **the tree editor rendered from `base`, not `draft`**: `SettingsTreeEditor` used `topEntries=Object.entries(base)` while the inputs' `onChange` wrote `draft` → the controlled value was bound to base while edits went to draft, **so a typed change did not update the input box**; worse, when `base` is empty (the fresh-CLI norm, controller contract `exists:false, settings:{}`) `topEntries` is always empty → **the form is just a single "model" row with no structured fields** (15.26's switch to a content-driven tree editor dropped the dashboard's "JSON patch" escape hatch). Fix: **render from `draft`** (structure and values both reflect edits; first frame identical to base, then genuinely updates). (2) **shallow-merge clobber**: on save, `Object.assign(patch, buildSecretPatch(...))` shallow-merged — a secret field and a non-secret field at the *same* level (qwen-code `security.auth` `apiKey` + `baseUrl`, opencode `provider` `apiKey` + `baseUrl`) overwrote each other, **losing the edit to the sibling field**. Now `deepMergePatch`. (3) **empty-state structured form (seed template)**: when base is empty, prefill the common fields as an editable starting point per CLI (qwen-code = `security.auth{selectedType/apiKey/baseUrl}`; opencode/qoder leave the template empty, rely on the JSON patch) — saving PUT-merge-creates the file; **the dashboard's "JSON patch" escape hatch is restored** (any field, patch wins on same key, malformed is blocked); seed-secret paths render as password boxes and are **stripped on save when left blank** (`stripEmptyLeavesNotInBase`: base non-empty and user-cleared → keep `""`; seed-prefilled-and-blank → drop); a user actively clearing a non-empty base field still keeps `""` (clear semantics).
- **Coverage status of the other two coding CLIs (verified against the author's coding-cli SKILL.md field notes, not guessed)**: the controller writes the **global** `~/.config/opencode/opencode.json`, but **OpenCode 1.19.0 `run --dir` reads only the project-level** `<workspace>/.config/opencode/opencode.json` → global config may not take effect for headless runs; **Qoder authenticates via the `QODER_PERSONAL_ACCESS_TOKEN` env var (not settings)**, so the form only manages model/tools/mcp; **Qwen Code 0.25.1 default-model bug** (the settings model may still request `qwen3.7-max`; a custom gateway without that model → 403). All three pitfalls surface as a **top warning Alert for the selected CLI**, not hidden.

**Verified**: tsc 0 (incl. noUnused gate) · vite build single file 1,971 kB (514 modules) · **pytest 456/456** (452 baseline +4 new runtime-env tests: cache hit no re-exec / stale fallback / no-cache 502 / fresh bypass) · i18n gate 1718 keys, 0 missing / 0 dup (incl. back-filling the `导出` key missed in 15.29) · secret scan 0 · **save-flow logic standalone gate 8/8** (qwen-code empty-state seed+apiKey+model object format + baseUrl empty-string strip / opencode JSON-patch mcp deep-merge + model flat string / clearing a non-empty base field keeps "" + secret sentinel `***` retained) · **real E2E** (runtime-env cache immunity + 8s-cap 502; qwen-code structured-patch round-trip lands + empty-string strip) · three version sources aligned (15.30).

## 0.5.0-beta.15.29 (2026-10-18 - coding-CLI "saved but not applied" model-format root fix + runtime-upgrade picker back to a team-grouped dropdown + tsconfig dead-code gate + full technical-debt cleanup)

This batch = 15.28 acceptance feedback (2 items: the worker upgrade picker should be **inside a dropdown**, grouped by team, showing current version / upgradable-to / upgradable-status right in the menu; Qwen Code settings **still not working**) + a full technical-debt cross-check (re-audited against the 10-07 external audit list item by item).

**Fixed**
- **[P0 security] gate credential-bearing full-config export/import behind a backup password**: with host QwenPaw auth turnable off (the local-self-use norm) and 8088 bound to `0.0.0.0`, the "same-origin = local" premise breaks — an anonymous LAN request could `GET /config/export` and grab the whole cluster's **plaintext** controller_token and other credentials. The full-backup channel (`/config/export` + `/config/import`) now has an independent gate password: `X-Export-Password` header + salted-SHA-256 (`hmac.compare_digest`, constant-time); **no password set = refused by default** (secure-by-default — actually closes the hole rather than "allow first, set later"); the password is stored only in a separate `export_key.json` (`0600`, **not inside `config.json`** → the export output never contains password material and import-overwrite does not clear it). Adds set/status/clear endpoints + frontend set / pre-export prompt / import password-field UI. The redacted endpoint `GET /config` is not gated. `docs/12-config-en.md` gains a "Full-backup gate password" section.
- **Coding CLI "saved but not applied" — model write-format root cause + false timeout failure**: (1) **model format root cause**: qwen-code's current `~/.qwen/settings.json` uses `model` as an **object `{name}`** (confirmed by the official "New Configuration Format" docs; the early flat string is auto-migrated by the CLI), while opencode/qoder use a **flat string** (confirmed by the controller test fixture `"model":"updated"`). The old code wrote `{name}` unconditionally → the other CLIs couldn't read it ("saved but has no effect"). Now **per-CLI**: `qwen-code` writes `{name}`, the rest write a flat string; **reads are dual-format** (accept both string and `{name}`). (2) **false timeout**: the controller's settings write is a synchronous chain (exec read → merge → mkdir → archive write → exec mv → **synchronous audit write to MinIO**); under slow disk / audit tail-latency the response measured **240s+** (the file itself is written within seconds). The old 30s frontend timeout gave up first → the user saw "failed" but the file was actually written (state mismatch). Timeout is now 30s→180s and **timeout ≠ failure**: on an `isTimeout` it **reads back and verifies** (compares each top-level key against what was sent, skipping the `***` secret sentinel); if reflected it's treated as success and the baseline is updated, otherwise it reports honestly — never fakes success.
- **Worker upgrade picker back to a dropdown (reverts the 15.28 flat card grid)**: 15.28 changed the multi-select dropdown into a **team-grouped flat card list** (feedback: "group by team, but keep it inside a dropdown, don't just list it out"). Restored to an **`antd.Select` multi-select dropdown with team-grouped `options`**, each menu item showing in-line the worker name + **current qwenpaw runtime version** `→ upgradable-to-latest` + an upgradable / latest / unknown / probe-failed badge (check-updates probe results merged into the item); `showSearch` + `optionFilterProp="label"`, `maxTagCount="responsive"`. Picking one = single upgrade.

**Improved**
- **tsconfig enables `noUnusedLocals` + `noUnusedParameters` (dead-code gate: by gate, not by discipline)**: the codebase was "clean by discipline" — the new gate's first run immediately caught **37 real dead locals/params/imports** (imports, state, functions, unused params), cleaned one by one (truly-dead deleted; signature-preserving params get a `_` prefix). From now on new dead code makes tsc red.
- **Full technical-debt cleanup (re-audited against the 10-07 external audit, registry takes priority over the audit list)**: (1) **7 dead scaffold files** (`harness/entry-1322/1323/1324.tsx` + `page-*.html` + `archive/MermaidDagView-13.24.tsx`, zero references) `git rm`'d; (2) **13 zero-call fake-public API functions** removed (a 5-function memory-fetch cluster with no UI consumer / 3 single-upgrade probes superseded by check-all / 2 team-file functions superseded by newer endpoints / controller-version / agent-id-list / channel-types) — **but `fetchProjectsWorkflow` is self-referenced by `loadWorkflowProjectsRaw` inside api.ts, and the tsc gate caught it on the spot and it was restored** (the zero-call grep excluded api.ts itself and missed the internal self-reference — proof of the gate's value); (3) **6 orphaned exported types** removed (the Memory series / ControllerVersion / 3 single-upgrade types / the UpgradeGate series), shared types (`MemorySection`/`TeamsRoomsResponse`) kept; (4) **15 stale root-level ZIPs archived** to `archive/`; (5) **`PREEMBED-EXEMPT.md` exemption list takes priority** — the audit mis-flagged `sendInboxNotify` (P1 reserved) and `fetchTeamsRooms` (P2 history replacement) as dead, but **registry-listed items are never deleted** (the external audit didn't read the exemption list).
- **Docs sync + version three-source alignment**: the `plugin.py` module docstring capability list completed (it registers 4 groups of startup/shutdown background hooks — address auto-reorder / inbox approval bridge / Matrix proxy keepalive / config 600 perms — the old text listed only the 3 user-facing capabilities); **fixed the Python source that 15.28 failed to bump** (plugin.json/package.json were 15.28 but `__init__.py` still 15.27 — the three-source consistency gate correctly caught it) — all three sources now 15.29.
- **181-audit performance items re-checked (verdict: mostly already-solved / not a real problem — no whack-a-mole)**: (1) "4 always-on pollers" → already solved by the unified `usePoller` gate (built-in `!document.hidden`, stops when the tab is hidden; the remaining always-on ones are legitimate root-level pieces: index backstop / authPoller session keepalive); (2) "no virtual scrolling" → the three longest lists are all bounded (RoomChat server-side `limit`+load-more prepend / KB files `limit=80`+`maxHeight` / version table ≤30 rows); adding a virtualization library = a high-risk big change for zero gain — **know when to stop**.

**Verified**: tsc 0 (with the new noUnused gate) · vite build single-file 1,958 kB · **pytest 447/447** (zero regressions) · i18n gate 1692 keys · sensitive scan 0 · version sources consistent (15.29) · live E2E: qwen-code settings `model:{name}` write → read-back `{'name':...}` matches (object format lands correctly); the timeout read-back verification chain holds.

## 0.5.0-beta.15.28 (2026-10-18 - LLM stream-timeout prefill from live env + coding-CLI editable when config empty + runtime-upgrade single mode retired (team-grouped picker with current version + upgradable badge) + scene presets removed)

This batch = 15.27 acceptance feedback (6 items: the two LLM stream-timeout fields still not prefilled / coding-CLI "config empty" not settable even when the CLI is installed / target-version menu should collapse by default / the worker picker should be grouped by team and show current version + upgradable status / drop the single-upgrade mode (picking one worker in batch = single) / scene presets are not the right shape (remove for now; AgentCom will carry them in team management once mature)).

**Fixed**
- **LLM tuning now prefills "first-content timeout" / "stream idle timeout" with the live value**: when neither the Worker override nor the team default is set, the worker-entrypoint `AGENTTEAMS_LLM_STREAM_TIMEOUT_S` fallback (300s in the live cluster; controller hot-applies overrides into container env) was the real source — the old prefill chain (worker → team → registry) had no registry default for the stream group, so the two fields were always blank. A fourth layer, the **runtime env actual value**, reads `QWENPAW_LLM_STREAM_FIRST_CONTENT_TIMEOUT` / `_IDLE_TIMEOUT` via the read-only `/workers/{name}/runtime-env` endpoint (15.27) and joins the chain (worker → team → live env → registry); after save it re-reads env (hot-apply truth). Graceful fallback to the original three layers on fetch failure (L2 read-only / older controller). 8-assertion logic gate on the real TS.
- **Coding CLI is editable when the config file is empty**: a container rebuild leaves the CLI installed but `~/.qwen/settings.json` absent (controller contract: `exists:false, settings:{}`), and the old empty state hid the model row — "installed but cannot configure". The structured editor now renders even on empty config: the model row (list picker + free text) is always visible, and **saving a model name PUT-merges to create the settings file** (controller read-modify-merge + atomic write); other fields appear in the form afterwards.

**Improved**
- **Target-version menu collapsed by default** (ops page): the version table no longer mounts open and fires its PyPI proxy request immediately — the row shows "Target version" + the picked version tag + a "Version table" button; expanding on first click fetches the list ("Refresh" re-fetches).
- **Worker upgrade picker grouped by team with current version + upgradable badge**: the multi-select became a **team-grouped list** (controller `/workers` `team` field; ungrouped last; team names sorted), each row = checkbox + worker name + **current qwenpaw runtime version** (check-updates probe results merged in-line; cached instant before probing) + **upgradable / latest / unknown** badge (with → target hint). Checking a row enrolls it in the batch run — **checking one is a single upgrade**.
- **Single-upgrade mode retired**: the "single / batch" switch is gone; the team-grouped list is the only path (its per-worker light-check / gate section went with it — the batch flow's check-all + confirmation covers the capability surface; per-worker job tracking cards are kept).
- **Coding CLI scene presets removed**: the six scene buttons and the suggestion list are gone (scene presets are not the right shape here — their proper home is AgentCom's team management once it matures); the preset data and applyPreset chain were deleted (-250 lines).

**Verified**: tsc 0 · vite build single-file 1,956 kB · **pytest 447/447** (zero regressions) · i18n gate 1685 keys, 0 missing / 0 duplicate / 0 empty (14 dead preset keys cleaned, 3 added) · LLM env-layer logic gate 8/8 (esbuild on the real TS) · sensitive scan 0 · version sources consistent (15.28).

## 0.5.0-beta.15.27 (2026-10-18 - runtime env-var prefill + check-for-updates v3 (batch + cache) + target-version table + coding-CLI model list picker)

This batch = 15.26 usage feedback (4 items: QwenPaw runtime env vars not prefilled / check-for-updates still slow + the version picker should be a table / coding-CLI settings not integrated + model picker should be a list like the Worker's) + a full cross-check.

**Added**
- **Runtime environment-variable prefill (Worker detail “Environment variables” section)**: new read-only endpoint `GET /workers/{name}/runtime-env` (L1 only), which reads the **container PID 1 effective environment** (`/proc/1/environ`) through the Controller Docker API proxy `docker exec` (fixed constant command, zero injection surface). **Root cause**: the Controller `GET /workers/{name}` detail response **does not echo the `env` key** (verified on live v1.2.5 — `env` is absent from the detail keys while the `PUT env` write path works), so the old “custom variables” area was always empty and looked “unconfigured”. The panel gains a **“Runtime environment” read-only area** (lazy: dials only on first expand) showing the **effective values** of QwenPaw_* / AGENTTEAMS_* / image defaults + saved custom variables (the prefill source of truth), with **sensitive keys masked by default** (`TOKEN/SECRET/GATEWAY_KEY/PASSWORD/…` → first-4+…+last-4) and an explicit “show plaintext” toggle to fetch `?reveal=1`; plus key filter, grouping (QwenPaw / platform-injected / other) and refresh. The “custom variables” area notes that the Controller currently does not echo saved values — saved values are visible in the runtime environment after container recreation.
- **Check-for-updates v3 (Ops page “Runtime upgrade” — one call, local matching for all; cold 6 s / warm 8 ms)**: new `GET /upgrade/check-all` (L1 only) — the server **`asyncio.gather` truly parallel-probes all Workers** (semaphore capped at 10) for the in-container qwenpaw runtime version + fetches the latest stable from PyPI, with a **per-Worker 10-minute server-side cache** (invalidated per Worker when an upgrade run starts) + a **60 s worker-list cache** (that endpoint measured 2–2.9 s on a 29-Worker cluster; caching makes repeated clicks hit all three caches). The probe command is **made cheap**: the primary path reads `Version:` from `qwenpaw-*.dist-info/METADATA` (**no Python venv startup** — measured 0.84 s vs 2.37 s for venv-importlib; falls back to venv-python when dist-info is absent), with the glob placed outside the double quotes (no glob expansion inside quotes). **Cold start 41.6 s → 5.9 s (7×), warm 0.008 s (8 ms)**. The frontend “Check for updates” is now a **single call** + local `compareVersions` matching (up-to-date / available / unknown, with per-Worker probe failure degrading without blocking the rest); **a second click = cache hit = zero exec (millisecond-level)**. On Ops-tab activation a **background prefetch is delayed 3 s** (yielding the first frame) so even the first click is usually fast. The single-Worker light check (`/upgrade/check`) **shares the same probe cache**. Replaces 15.26’s “N× frontend per-Worker light probes”.
- **Target-version table (version picker, replacing free-text input)**: new `GET /upgrade/versions` (L1 only) — the PyPI `releases` dict sorted by upload time descending (top 30), each row `{version, upload_time, size, prerelease, yanked, is_latest}` (prerelease detected per version segment on `a/alpha/b/beta/c/rc/dev/pre/preview`; post-releases are not prereleases), **sharing the same PyPI cache as `/upgrade/latest`** (zero extra network round-trips). The frontend `VersionTablePicker` (antd.Table single-select rows + version/released/size/flags columns) replaces the free-text target-version input in both dialogs; a “custom version (advanced)” field remains as an arbitrary-tag fallback.

**Improved**
- **Coding-CLI model list picker (Worker detail Coding CLI section)**: the settings tree editor gains a **model row** — the **same source** as the Worker model picker, `useModelUnionOptions` (candidates = SGLang serving ∪ currently-in-use ∪ gateway aliases, grouped) as an `AutoComplete` (list pick + free-text fallback) with **pre-write validation** `validateModelValue` (path/URL/whitespace = error, blocks save; not in the serving list = warning, save proceeds). Saving writes `model.name` as a diff (empty = clear the override, fall back to CLI default), with a **save read-back summary** (model changed = show the new value / cleared). The CLI card row gains a **model badge** (shows the current effective model once settings load, same semantics as the Worker model-column badge). **Cleanup**: removed the `modelName` state that was declared but never used (leftover from 15.26).

**Fixed**
- **pytest cache isolation extended across domains**: after `upgrade_api` gained a module-level `_probe_cache` (light-probe 10-min cache), adjacent tests using the same Worker name would hit the previous test’s cache (e.g. `test_check_light_unsupported_image` right after `test_check_light` saw the stale HAS/HAS). `conftest._clear_module_caches` now clears `*_cache` dicts on **router + all domain modules**, automatically covering future module-level caches.

**Verification**: tsc 0 · vite build single-file 1,978 kB · **pytest 447/447** (+13 new: check-all 200 / cache zero-exec + worker-list cache / run invalidation / PyPI degradation / versions ordering + prerelease + yanked / 502 offline / runtime-env 200 + masking + reveal + 403 + 400 / light-check shared cache) · i18n gate 1696 keys 0 missing 0 duplicate · sensitive scan 0 · three source versions consistent (15.27) · live E2E (29-Worker cluster): check-all cold 5.9 s (was 41.6 s) / warm 8 ms, 29/29 versions probed; versions returns 30 rows in 10 ms (latest 2.2.2 + prereleases 2.2.2b6…); runtime-env live masking + reveal verified.

---

## 0.5.0-beta.15.26 (2026-10-17 - Simplified check-for-updates + structured coding-CLI settings form + settings-response unwrap fix + LLM-tuning effective-value prefill)

This batch = the four 15.25 acceptance-feedback items (check-for-updates too slow / Workers should not occupy a full row / LLM tuning should prefill the current value / coding-CLI settings should be structured + keep L1/L2 separation).

**Improved**
- **Simplified check-for-updates (Ops "Runtime upgrade" batch mode)**: the old "Check for updates" ran a `docker exec` light-probe per Worker on every check (N Workers = N× latency — the root cause of the slowness). Now: **current version** = each Worker's in-container qwenpaw runtime version (probed once, then **module-cached** — re-checks are instant, no per-check exec); **latest stable** = a single PyPI query (**new `GET /upgrade/latest`** endpoint, L1-only, server-side 10-minute cache, falls back to the stale cache on outage). Workers are compared locally (`compareVersions`) into "Latest / Update available / Unknown" states. **Key decision**: the Worker image tag (e.g. `v1.2.5`) is the AgentTeams image version, NOT the qwenpaw runtime (e.g. `2.2.1`) — comparing the image tag against the PyPI qwenpaw latest always mis-fires "update available", so the current-version source is the in-container qwenpaw version (verified live: PyPI latest `2.2.2`, cluster in-container `2.2.1`). After a successful upgrade the Worker's cache entry is cleared (version changed, so the next check re-probes the truth).
- **Structured coding-CLI full-settings form (Worker details, Coding CLI section)**: the old settings editor was a model-name input + secret fields + a **free-form JSON patch** (loose). Now a **structured tree editor** renders the settings tree recursively: redacted secrets → password field (leave empty = keep stored / enter = replace), object → nested group, array → JSON text, scalar → typed input (boolean switch / number / string). **No per-CLI schema hardcoding** (qwen-code / opencode / qoder settings are each CLI's own JSON with no fixed schema; any field renders dynamically). **Network transfer reduced**: saving sends only the **leaf-level diff patch** (changed fields only) and **reuses the PUT response's merged settings** (no extra GET re-fetch). The whole form is disabled in read-only mode (L2).

**Fixed**
- **Coding-CLI settings-response unwrap (wrapper-unwrap, real bug)**: the settings endpoint actually returns a **wrapper** `{cli, exists, path, settings}` (the `settings` subtree is the real config-file tree, with the redaction sentinels inside it), not a bare tree. The old code treated the wrapper as the tree → ① model name always read empty (it read `wrapper.model`, not `wrapper.settings.model`); ② secret-field paths carried a spurious `settings.` prefix (secrets would have been written to the wrong nesting). Now the code unwraps to `.settings` as the tree, and diff/secret patches are sent config-file-relative (the controller deep-merges the real tree). Defensive fallbacks on both GET/PUT (a missing `settings` key → empty tree, no crash).

**LLM tuning**
- **Effective-value prefill (Worker details, "LLM tuning" card)**: the panel previously showed only the Worker's **explicit overrides** (unset = empty = greyed registry default). Now, on expand, it fetches the Worker's team and **resolves the current effective value** (Worker override → team default → QwenPaw registry fallback), prefilling the fields with the actual in-use values rather than defaults. Write semantics are per-field: editing a value writes a Worker override; reverting to the inherited value clears the override (no redundant write); no change = no diff. A team-fetch failure does not block (falls back to the two-level Worker → registry resolution).

**Permissions (decided from controller source; no frontend change needed)**: the coding-CLI surface is enforced **server-side** — L1 (admin/manager) full scope + read/write; L2 (team leader) own-team scope + **read-only** (settings PUT / install return 403); L3 (human) same own-team scope. The frontend keeps its existing "assume-writable + 403 → read-only" pattern (already correct).

**Verification**: tsc 0 · vite build single file 1,965 kB · pytest 434/434 (incl. 5 new `/upgrade/latest` tests: L1 gate / success / cache-hit no re-dial / outage stale-fallback / no-cache outage 502) · i18n gate 1672 keys 0 missing 0 dup · secret-scan 0 (source diff 0 personal identifiers / 0 internal IPs; dist 0 internal IPs) · three-source version consistent (15.26).

---

## 0.5.0-beta.15.25 (2026-10-17 - Cluster version cards + per-worker runtime upgrade rewire + LLM tuning panels + batch runtime upgrade + coding CLI check-for-updates/upgrade + coding runs moved to Worker sessions)

This batch = the plugin side consuming AgentTeams 1.2.5's three new capabilities (cluster version observability / in-place runtime upgrade / LLM tuning) + coding-CLI management surface enhancements.

**Added**
- **Cluster version cards (Ops page, new `/cluster-info` endpoint, L1-only + 10-minute cache)**: two version cards above the Ops status grid show the **real** versions of the cluster's two systems — "AgentTeams version" = the agentteams-controller **image tag** (the release version; `/api/v1/version` hardcodes `dev` and is unusable, so the image tag is the authoritative source); "Higress version" = a three-tier probe (in-container `/etc/higress_version` file → `HIGRESS_VERSION` env → null), **never guessed** — when the probe misses it shows "—" (hover for the reason; no error; Higress has no console REST version endpoint, 404 verified). The team-management header version badge is removed (single source of truth; avoids two places drifting).
- **Per-worker runtime upgrade rewire (fixes a v1.2.5 packaging gap)**: the old design proxied the in-container `agentteams-upgrade` plugin (127.0.0.1 loopback), but v1.2.5's `_prepare_default_plugins` never registers that plugin (a packaging gap, verified in the image) → the loopback always 404'd, a structural dead end. Now rewired to **`docker exec` the built-in upgrade scripts directly**: "Check for updates" = a light probe (current runtime version + check-script availability, run via the venv python — the system python lacks the `qwenpaw_worker` package, verified); "Trigger upgrade" = a detached `upgrade_qwenpaw_runtime.sh --phase pre-restart` (explicit absolute `--state-file`/`--pending-file` — docker exec's env ≠ the app process's env, so default paths would orphan pending.json); "Status" reads the on-disk state file + pending.json (the truth, survives restarts). **QwenPaw-only gate**: a non-qwenpaw Worker returns an explicit 400 (with reason). worker/version/job_id are regex-validated before command construction (injection surface closed). 17 unit tests (L1 gate / light·full check / checker-missing 404 / qwenpaw-only 400 / injection 400 zero-dial / run detached command shape / status parse / job_not_found 404).
- **LLM tuning panels (worker-level + team-default, two layers, AgentTeams 1.2.5+)**: the dashboard's LLM tuning is ported into the workbench, covering the full inheritance chain (Worker override → team default → QwenPaw registry default). 10 `llm*` fields with field-level diff PUT (omitted = keep / empty string = clear-and-fall-back / value = override); **all fields L1-only** (L2/L3 accounts see the whole section read-only; no error); the 2 stream fields apply hot (no container rebuild), the 8 startup fields are env-projected and require a container rebuild to take effect (labelled in the UI). The Worker details "LLM tuning" card (wide-screen inline + narrow-screen sheet, **collapsible** — collapsed by default, lazy-loads on first expand to save requests, aligned with its Runtime config / Env & gateway probe / Coding CLI siblings on the x=33 section-header track); the team-management CRD edit dialog gains a "Team LLM tuning" section (same field grid, field-level diff merged into the team update body, whole-group validation).
- **Batch runtime upgrade (new "Batch" mode in the Ops "Runtime upgrade" panel)**: the panel header now has a "Single Worker | Batch" switch (the single-Worker flow is untouched). Batch mode multi-selects qwenpaw Workers — "Check for updates" light-probes each selected Worker's current runtime version and in-place-upgrade availability (sequentially, to avoid a dial storm); after entering a target version, "Batch upgrade" triggers **sequentially** (one Worker at a time, to avoid container-restart interference) and tracks each job (phase / start-end / log tail), rolling back automatically on a failed boot self-check — the same two-phase semantics as single-Worker, with a destructive confirmation before triggering.
- **Coding CLI check-for-updates + upgrade (Worker details Coding CLI section)**: a "Check for updates" button in the section header now queries the npm registry's latest version for each CLI **from the plugin backend (host)** — a new `/coding-cli/latest` endpoint (L1-only + clis allowlist + fixed npmjs base to prevent SSRF + 5-minute cache) — **instead of a browser-direct registry fetch** (an intranet operator machine may not reach the public registry; if the host also can't reach it, each CLI degrades gracefully to "registry unreachable", and manual tag entry still works). Each installed CLI shows an "Update available → X" / "Up to date" / "Registry latest X" badge next to its version. Installed CLIs gain an "Upgrade" action (reinstall at the chosen version tag; empty = latest); the version input is re-labelled "Version tag (install/upgrade)". **Upgrading is still just sending one install command (consumes upstream 1.2.5 #1360) — no new mechanism.**
- **Coding runs moved into the Worker session area**: the "Coding runs" section is removed from the Ops page; the Worker session drawer gains a third "Coding CLI" tab — alongside Active / Archived — showing the selected Worker's coding CLI runs (1.2.5+ read-only transcripts), silently polling every 30s with visibility gating (stops when hidden); open any run to see its full log. Data source and renderers are reused from the ops-page component (no drift).

**Verified**: tsc 0 · single-file vite build 1,960 kB · pytest 429/429 · i18n gate 1661 keys, 0 missing, 0 duplicates · sensitive scan 0 · three sources agree (15.25) · dist verified (contains `coding-cli/latest`, `0.5.0-beta.15.25` ×2, browser-direct registry URL removed) · new-endpoint unit tests: `/cluster-info` (image-tag source / three-tier Higress probe / L1 gate / cache) + `/upgrade` rewire (17 cases) + `/coding-cli/latest` (8 cases: L1 gate / success / allowlist 400 / cache / refresh / registry-500 degrade / non-JSON degrade / subset)

---

## 0.5.0-beta.15.24 (2026-10-17 - Per-node runtime version + settings auth split + coding CLI management)

**Added**
- **Worker "Runtime version" is now measured in-container (per-node probe)**: expanding any Worker in Team Management now shows the runtime version actually running inside that Worker's container (e.g. QwenPaw 2.2.1, OpenClaw x.y) — probed by the Controller executing `--version` inside the container (10-minute cache), covering the qwenpaw / openclaw runtime family. The QwenPaw version on the host can differ from the one in the container (e.g. host 2.2.2 vs container 2.2.1), so it must be probed per node rather than read from the host. The old "Runtime version" label actually showed the Worker image tag, which was semantically wrong — it is now split into two items: "AgentTeams version" = the Worker image tag (authoritative CRD image source; hover for the full image reference) and "Runtime version" = the measured in-container runtime version. The Manager table's "Version" column is renamed and shows the tag accordingly. Older Controllers without the probe show "—" (hover for the reason; no error).
- **Coding CLI management (new section in Worker details, AgentTeams 1.2.5+)**: manage the three coding CLIs (qwen-code / opencode / qoder) per Worker — install (version pin optional, empty = latest), upgrade, uninstall (with confirmation). Long-running tasks execute inside the target Worker container; the panel polls automatically until completion (showing the stderr tail on failure). Settings editing: change the model name, enter secrets (read-back is server-side redacted and never echoed; leave empty to keep the saved value), and an optional JSON deep-merge patch. Six built-in scenario presets (frontend / backend / data / iOS / embedded / minimal) — applying one writes only the settings patch (e.g. model name); shared toolchain volumes, env vars and MCP are rendered as a human-confirm suggestion list and are never auto-applied. L2 accounts get the whole section read-only; older Controllers show an upgrade hint (no error).
- **Settings page: the two L1 auth systems are now separate**: the Controller admin token (L1 admin plane) and the Higress Console account + password (model plane) are credentials of two independent systems. The Higress section used to live inside the "L1 admin plane" radio branch, so switching to Matrix login (L2) hid it entirely, making them look like one system. The Higress section is now standalone — always visible regardless of L1/L2 mode — with its heading and description stating that "even if the values happen to be the same in a deployment, they are credentials of two different systems — not interchangeable", and verify failures are reported to their own section (Controller failures in the Controller block, Higress failures in the Higress block).

**Improved**
- **Worker detail section-header alignment**: the five sections (Runtime config / Env & gateway probe / Coding CLI / Resource management / Tool execution security) now share the same icon-title gap, so the title x-position no longer drifts between collapsed and expanded states (x=33 track).

**Verified**: tsc 0 · single-file vite build 1,927 kB · pytest 412/412 · i18n gate 1589 keys, 0 missing, 0 duplicates · sensitive scan 0 · node-version endpoint 10 unit tests green (image-tag source / exec probe / cache / L1-only 403)

---

## 0.5.0-beta.15.23 (2026-10-17 - Worker detail version display + topology section alignment)

**Added**
- **Worker "Runtime version"**: expanding any Worker in Team management now shows a "Runtime version" field in the info grid - the version tag of the Worker's running image (e.g. v1.2.5); hover for the full image reference (registry path + tag). Shows "—" (no error) on older Controller versions that do not provide the field.
- **Team management page "AgentTeams version" badge**: the page header now shows the AgentTeams Controller version (value of the /api/v1/version endpoint; source builds show "dev") and deployment mode; hover explains where to see each node's actual release version (Worker detail "Runtime version" / Manager table "Version" column).

**Improved**
- **Worker detail topology section alignment**: the four sections "Runtime config / Environment variables & gateway probe / Resource management / Tool execution security" are unified into the same card-row style - left edge, border radius and icon x-position aligned row by row, and collapsed/expanded section header titles use a consistent font size, so the topology reads more rigorously.

---

## 0.5.0-beta.15.22 (2026-10-17 - AgentTeams 1.2.5 adaptation + standalone-mode two-axis host contract)

**This batch = adapting to the new AgentTeams 1.2.5 capabilities (three things that were previously only visible from the command line are now inspectable/operable from the UI): (1) a Coding Runs viewer - every delegated coding CLI execution is now reviewable; (2) a Runtime Upgrade panel - preflight, in-place upgrade, and live progress tracking for this host's QwenPaw runtime; (3) Worker environment variables & gateway probe - per-worker custom env editing plus one-click model/MCP gateway connectivity probes.**

**Also includes the plugin side of the standalone-mode adaptation (paired with the QwenPaw mobile local-plugin host shell v8): the host environment contract moves from the single `isOffline` boolean to a two-axis model - Axis A host form `host.env.kind` (server/local/desktop, declarative, says whether the plugin backend exists) and Axis B capability bits `host.env.caps` (net/secureStore/notify, probed, what the device-side bridge provides) - while "offline" is renamed to "standalone" across UI and code (offline is kept only for connectivity semantics).**

**Added**
- **Worker env variables & gateway probe (new per-worker section, 1.2.5+)**: expand any Worker to edit its custom environment variables - add/remove key-value rows with the same key-name rules and system-reserved-key checks as the server. Saving uses whole-map replacement semantics (removing a row deletes the key; clearing everything requires explicit confirmation), and takes effect on container recreation (running tasks may be interrupted - stated in the UI). The same section includes a gateway probe: it sends one minimal request through the gateway using the Worker's saved model/MCP configuration and identity to verify Consumer authorization, routing and upstream connectivity, showing success/failure, latency and consumer name. The server only dials with persisted configuration and changes nothing. The section is visible to admin/manager accounts only (hidden automatically for L2 accounts and pre-1.2.5 controllers, without errors).
- **Coding Runs viewer (new Ops-page section)**: since 1.2.5, every time a Worker executes a coding CLI task (Claude Code / Codex, etc.) it leaves an execution record and raw log. The Ops page now shows them directly - a list sorted newest-first with execution time, CLI used, worker, status, exit code and log size; open any row for details: a metadata grid, the execution's input (prompt, shown only when the record is readable), and the full raw log. Shows an empty state when there are no runs, and a notice (no error) on Controller versions that do not expose the capability yet.
- **Runtime Upgrade panel (new Ops-page section)**: a one-click upgrade entry point for this host's QwenPaw runtime. Preflight is read-only first - current version, upgradeable candidates (with prerelease and recommended markers), the four gates per candidate (C1 version resolution / C2 pinned dependencies / C3 compat patch / C4 optional deps, hover for evidence), and preflight warnings. After confirming the upgrade, it runs the two-phase in-place upgrade (automatic rollback to the previous version on failure) and tracks the job live (phase / start-end times / log tail). Triggering an upgrade restarts the container and may interrupt running tasks, so it requires confirmation. Hosts without the built-in upgrade service (older images) show a notice (no error).
- **Two-axis host contract (hostEnv.ts)**: `hostKind()` / `hostCaps()` / `isLocalHost()`. Shells without the `env` field fall back to the `isOffline` boolean (15.12 behavior); console hosts have neither → server, so the online path is unchanged. Entry branching (index.tsx) and the config-domain mock layer (api.ts → localConfigBackend) both use this.

**Changed (naming/structure, behavior unchanged)**
- `offlineBackend.ts` → `localConfigBackend.ts`, `WorkbenchOfflinePage.tsx` → `StandaloneConfigPage.tsx`; page title "Local Offline Mode" → "Standalone mode (local host)" with matching banner copy.
- The localStorage persistence key value `agentteams-qwenpaw-workbench:offline-config` is intentionally unchanged (changing it would lose saved connection config); only the constant was renamed to `LOCAL_CONFIG_KEY`.

**Fixed**
- **Version number mismatch across three sources**: in the initial package of this batch the backend Python version constant was not synced at release time (host logs / selfcheck printed the old version while the frontend and install directory already carried the new one). Now synced, and a three-source consistency gate was added (plugin.json / frontend package.json / Python version constant must always agree; a missed sync fails the build gate).

**Verification**: tsc 0 · vite build (dist 1,885 kB) · pytest 402 · i18n 1530 keys, 0 missing / 0 duplicate · secret scan 0 · coding-runs / runtime-upgrade panels verified in a real browser with 39 assertions (list / detail / empty / 404 degradation / trigger flow / polling progression) · env & gateway-probe panel verified with a 22-assertion UI harness (key validation states / whole-map save / read-back baseline / clear-all confirm / model probe success card / L2 masked / pre-1.2.5 hidden) · dist bundle inspection (two-axis branch / standalone copy / storage key present) · live install: +21 dials in a 45s steady-state window (budget <50)

---

## 0.5.0-beta.15.21 (2026-10-16 - 2D graph touch gestures + narrow-screen height/toggle fixes + DAG wheel zoom)

**This batch = finger interaction for the 2D knowledge graph (two-finger pinch zoom / one-finger pan / tap select / double-tap focus) + two narrow-screen (phone) fixes for the knowledge graph (the 3D/2D toggle getting squeezed out of the viewport, and the graph being too tall to scroll the page) + mouse wheel zoom for the workflow dependency graph.**

**Added**
- **Touch gestures on the 2D knowledge graph**: the 2D view was mouse-only before (wheel zoom / drag / click). It now works with fingers too - two-finger pinch zoom (anchored on the pinch midpoint), one-finger drag to pan, tap to select a node (same semantics as a mouse click: neighbor highlight / details / open file, tap a cluster root to focus, tap blank to deselect), and double-tap to focus a node's neighborhood.
- **Mouse wheel zoom on the dependency graph**: the workflow dependency graph could only be zoomed via the toolbar +/- buttons or two-finger pinch. Mouse wheel now zooms as well (anchored on the cursor, same 0.4-2.0 range as pinch), complementing the existing drag-pan and pinch for full desktop and touch coverage.

**Fixed**
- **3D/2D toggle squeezed out of view on narrow screens**: on phones, the legend, the node/edge count and the 3D/2D segmented control all shared the card header row and did not fit - the toggle was pushed off-screen, so after switching from 3D to 2D you could not get back to 3D. On narrow screens the legend and the count now move out of the header (the legend shows inside the 2D view), so the toggle is always visible.
- **Knowledge graph too tall on narrow screens**: the fixed graph heights (3D 480px / 2D 420px) took up most of a phone screen, leaving the page unable to scroll. On narrow screens the graph is now shorter (3D 300px / 2D 280px) and the page scrolls normally.

**Verification**: tsc 0 · vite build · pytest 393 · i18n 0 missing · sensitive scan 0 · 8 smoke suites

---

## 0.5.0-beta.15.20 (2026-10-16 - board wide screen 3-col 2-row + card height grows with content)

**This batch = another board layout adjustment (wide screens >= 950px become 3 columns x 2 rows; mid widths keep 2x3; portrait keeps 1x6) + a root-cause fix for board cards being vertically compressed/clipped (card heights now grow with their content; text is no longer cut off mid-line).**

**Fixed**
- **Board cards vertically compressed / clipped (root fix)**: the card body (project-title row) used a 2-line clamp style, but that clamp silently did not take effect in current browsers - it degraded to a fixed max-height with overflow hidden, leaking a partial third line below the clamp (the half-cut "... " text visible in the report screenshots). The clamp classes now use the proper line-clamp implementation (benefiting all 8 usages site-wide - no more partial-line leaks). Additionally, the board card project-title row now shows its full text, so the card height grows with its content and nothing is occluded at any width; the in-column vertical scroll kicks in beyond about 3 cards per column (about 2 on wide screens). The portrait 1-column 6-row mode shares this fix.
- **Board wide screen 3-col 2-row**: wide screens (window >= 950px) used the 2-column layout; they now use a 3-column grid with the per-column card area capped at about 2 cards - columns are 1/3 of the container width, so cards are wider and wrap into fewer lines. Mid widths (500-949px) keep 2 columns x 3 cards, and portrait (<500px) keeps the 1-column 6-row stack. The 500/950 breakpoints are covered by unit-test guards.

**Verification**: tsc 0 · vite build · 393 backend tests · 0 i18n missing · sensitive scan 0 · breakpoint smoke on 18 widths

---

## 0.5.0-beta.15.19 (2026-10-16 - board wide screen back to 2-col 3-row + left-rail name wrapping)

**This batch = board layout adjustment (the wide-screen 6-column single-row horizontal scroll is replaced by the 2-column 3-row layout, fixing clipped right-side columns and clipped card text) + left-rail name auto-wrapping on three pages (project/room names are no longer cut by ellipsis; card heights grow with the content).**

**Fixed**
- **Board wide screen back to 2-column 3-row**: the wide screen (window >= 950px) used a 6-column single-row layout (8 columns fixed at 250px with horizontal scroll) — the full board needs 2000px, so only very wide windows show all columns; slightly narrower windows clip the right-side columns (e.g. "Done") out of view, and inside a 250px column card text wraps to 3+ lines and gets clipped. Wide screens now use the same 2-column 3-row layout as mid widths (columns = half the container width, no board-level horizontal scroll, each column capped at about 3 cards with in-column vertical scroll) — wider windows mean wider columns, so cards are no longer cramped and the board is never clipped. The 2-column 3-row and the portrait single-column layouts were already correct and are unchanged.
- **Left-rail name auto-wrapping on three pages**: names in the left rails of the chat page (group / DM / invite cards), the artifacts page (projects / rooms), and the workflow topology & card views were single-line with ellipsis — the rails are drag-resizable, but no width showed the full name. These names now wrap, so the full name is visible at any width and card heights grow with the wrapped lines (the project-card view's project name already wrapped; the three rails now use the same wrapping). Message preview rows and file-name detail rows keep the single-line style.

**Verification**: tsc 0 · vite build · 393 backend tests · 0 i18n missing · sensitive scan 0

---

## 0.5.0-beta.15.18 (2026-10-16 - landscape misjudgment fix + KB / skill-center simplification + board monolith split)

**This batch = root-cause fix for "landscape wide screen misjudged as portrait" (a 2412px landscape Desktop OS window was judged portrait single-column, stretching every page) + product simplification (KB remote-only / skill-center keeps upload only) + WorkflowBoard monolith split (N-07).**

**Fixed**
- **Landscape wide screen misjudged as portrait (root-cause fix)**: the QwenPaw host console's plugin-mount compatibility layer uses `display:contents` CSS (no layout box, width permanently 0), and the plugin's narrow/wide judgment walks the parent chain taking the minimum width — the permanent 0 layer pinned the visible width to 0, so a 2412px landscape window was stuck as portrait single-column (artifacts / workflow topology / chat / team management all stretched). Fix: the parent-chain walk now skips 0-width layers (a 0-width box does not constrain its children), so the real visible width is read at any window size and follows resizing; plus "force re-measure on tab switch" and "force re-measure on window focus return" as double safety nets. The self-check diagnostics card now prints the per-layer clientWidth of the whole parent chain (0-width layers marked "excluded") — if it recurs, one screen identifies the layer dragging the visible width down.

**Simplification (product decision)**
- **Knowledge base is remote-only**: the "local host agent" fallback view and the "re-probe" button are removed; only the remote team KB remains (Controller reads Worker container workspaces directly). When the remote is unavailable (no token / L2 user / no workers), a top-of-page configuration guide is shown instead of falling back to local.
- **Skill center drops the "skill catalog" card**: the catalog list / search / download is no longer rendered (low real-world value in team ops); only the "Upload skill (zip)" and "Create custom skill" entries remain. The Worker skill-assignment matrix is unaffected (it still reads the catalog data layer for source tags).

**Tech-debt cleanup**
- **WorkflowBoard (board) 4449 -> 759L**: split into 7 `workflowboard/` modules (DagTopo 607 / BoardView 446 / blocks 418 / panels 359 / timeline 174 / rail 137 / helpers 232 / types 28); external contract unchanged (default export + named `WfView`); behavior-preserving (pure moves).

**Verification**: tsc 0 - vite build 503 modules - sensitive-info scan 0

---

## 0.5.0-beta.15.17 (2026-10-15 - 15.x optimization batch: chat file refs + three monolith splits + approval color convergence)

**This batch = the beta 15.x UI / performance / tech-debt cleanup batch (nightly autonomous batch, package 1 = safe batch): 1 new feature (#87 chat references to team shared-workspace files) + three frontend monolith splits (CrdManage / KB / board layout) + approval-severity color single-source convergence.**

**Added**
- **Chat references to team shared-workspace files (#87)**: the chat composer can `@`-reference files in the team shared workspace (FileRefPicker + connector `/team-files` endpoint); a reference renders as a file badge and is attached on send; the receiver can open it — closing the "reference a workspace file directly in chat" collaboration loop.

**Tech-debt cleanup (three monolith splits, behavior-preserving)**
- **CrdManage (team management) 2540 -> 353L**: split into 15 `crdmanage/` modules (pure leaves types/helpers/FieldLabel <- 4 hooks <- 8 render components <- main assembly layer), one-way dependency, no cycles; word-for-word moves + anchor-located + full identifier audit (0 UNEXPLAINED); the main file is now a thin "props -> 4 hooks -> JSX" assembly layer.
- **Knowledge base (KB) 3162 -> 142L**: two-column KB containerized + split into 9 modules (useKbColHeight equal-height containerization); smoke 160 asserts green.
- **Board layout-mode extracted to a pure module**: the landscape/portrait layout decision is now a pure function module + breakpoint-regression smoke (the anti-regression guard for the 15.15 landscape fix; 667<800 no longer falls into the portrait stacked layout).

**Fixed**
- **Approval severity color single-source (P1-6)**: SEV_COLOR was copy-pasted in NotificationCenter + ApprovalCard, and HomePage inlined a `#ff4d4f` drift for the same CRITICAL/HIGH semantic -> extracted to `util.ts` as the single source (CRITICAL/HIGH = `#f5222d` antd error red / MEDIUM orange / LOW green); all three approval-severity consumers now use `sevColor()` (per-consumer fallback preserved: NotificationCenter gray, ApprovalCard/HomePage orange).

**Verification**: tsc 0 · vite build 1,860kB · i18n full key set · crdmanageHelpers smoke SMOKE_OK (esbuild transform, fixed a script defect) · kbLayout2d smoke 160 green · portrait+landscape x touch+mouse spot-check, team-management + workflow pages zero regression

---

## 0.5.0-beta.15.16 (2026-10-15 - audit panel A7: consumes the upstream #1270 durable audit store)

**New "Audit" tab — reads the Controller's durable audit store (upstream #1270 `GET /api/v1/audit`, MinIO JSONL append-only, covering every entry point: dashboard / CLI / API)**

- **Audit tab (new)**: a read-only governance-event panel, semantically aligned with dashboard B6 (audit-section) but on a different data path — the plugin has no BFF layer; the frontend proxies `/api/v1/audit` straight through the connector catch-all, and the scope is enforced server-side by the Controller (**L1 = full** / **L2 = `?team=` mandatory, cross-team reads hidden as 404 anti-probing** / worker identities denied 403 by default).
- **Scope adaptation**: the team options are returned by the Controller scoped to the caller (L1 = all teams, L2 = own team) — "the token is the scope boundary", zero extra frontend logic. L1 defaults to "all teams" and can drill into a single team; L2 auto-locks to its own team and shows a "Scoped to your team" badge.
- **Filters**: type (all / capability / approval level / channel / source) × time range (1 day / 7 days / 30 days / all) × team, three-way filtering; keyset pagination "Load more" (the cursor is held in a ref, out of the dependency chain, so loading more never resets the list back to page 1).
- **Severity derivation**: Controller events carry no severity field — it is derived from the action's semantics (failed / denied / revoke / delete = error; grant / add / credential-write = warning; read / readback = info), the same approach as dashboard B6's normalization.
- **Honest degradation**: 404 = old Controller without the endpoint → a version-gated info notice (available automatically after upgrade); 403 = identity not allowed → a permission notice; 30 s auto-refresh (gated on tab active, stops when you leave).

**Verification**: tsc 0 · i18n 1,457 keys 0 missing / 0 duplicate / 0 empty · live audit endpoint 200 with real events (channel-kind sample checked against the field shape: targetTeam/before/after optional, capability prefix, cursor present only on a full page) · three carriers in sync at 15.16

---

## 0.5.0-beta.15.15 (2026-10-15 - board landscape regression fix + home-page version number)

**Board landscape regression fix: landscape phones (container width 500–950) were previously mis-classified into the portrait stacked layout (a landscape 667px is always "narrow" since <800, so the 15.13 Jira rework swept the landscape band into the portrait interaction). The layout is now branched three ways on the **measured** container width: portrait (<500) keeps the 15.11 mobile layout; landscape / mid width (500–950) restores the "two fixed-width column grid + at most 3 cards per column, the rest scroll vertically inside the column" (board columns are a fixed size, never compressed, no whole-board horizontal scroll); desktop widescreen (≥950) keeps the 250px Jira horizontal scroll. The layout mode is driven by the measured container width (phone rotation does not flip the narrow/wide snapshot — both values are <800 — so a ResizeObserver callback corrects a stale snapshot). The home-page welcome bar now appends the plugin version to the identity line (the header version line is hidden in portrait by `!narrow`, so on a portrait phone the version was previously uncheckable anywhere)**

- **Workflow / board (landscape regression)**: the layout decision changes from a binary narrow(<800)/wide split to a **measured-container-width** three-way split — `stacked` (W<500, portrait phone: status columns stacked full-width + an in-column 165px card row that scrolls horizontally, 15.11 layout untouched) / `grid2` (500≤W<950, landscape phone 667 / tablet portrait / mid width: a two fixed-width column grid `minmax(0,1fr)`, each column = half the container, **never compressed, no whole-board horizontal scroll**; each column's card area is height-capped at `min(40vh,320px)` ≈ 3 cards, with **vertical scroll inside the column** for the overflow) / `jira` (W≥950, desktop: 8 columns fixed 250px horizontal scroll + equal-height columns, untouched). Root cause of the regression: 15.13 changed everything ≥800 to the Jira horizontal scroll to fix the desktop mid-width "squeezed strips", but a landscape phone at 667px is always judged "narrow" (<800) → it ended up with the portrait stacked layout ("landscape is broken"). The layout mode is now driven by the wrapRef measured width + a ResizeObserver — phone rotation 376↔667 does not flip the narrow/wide snapshot (both <800), so the measured width is the single source of truth.
- **Home / version number**: the welcome-bar identity line (current account · Controller level) now appends `· v0.5.0-beta.x` — the header version line is hidden in portrait by `!narrow` (to save vertical space), so on a portrait phone the plugin version was previously uncheckable anywhere; it is now always visible on the home page, injected at build time and sourced from the same place as the header.

**Verification**: tsc 0 · three version carriers in sync at 15.15 (plugin.json / connector `__version__` / package.json)

---

## 0.5.0-beta.15.14 (2026-10-15 - portrait round 9 + offline diagnostics real dial: board thin-strip root fix / clamp unification / send button always visible / topic-window ghost fix / tab wheel scroll / config long-URL wrap / offline two-step probe)

**Portrait round 9 + offline-diagnostics root fix: the board card "thin strip" (title / project name collapsing to 0 height, only the tag row left) is root-fixed from the dual root cause of the card container's `overflow:hidden` + the Chromium 154 clamp; eight inline text-clamp sites are unified into a global standard class (safe across Chromium versions); the chat composer's send button is now always visible (disabled when empty, no longer disappears); the portrait "topic-window ghost popup" is fixed (only a topic the user explicitly opened on portrait may auto-open as a Drawer); every "pure horizontal scroll strip" in the plugin now supports mouse-wheel horizontal scroll (global delegation, does not steal the message list, releases at the boundary); long addresses on the config page no longer break narrow containers; the offline "connectivity test" is now a real two-step probe (reachability + whether CORS is enabled), with layered attribution pointing to the real switch**

- **Workflow / board**: root fix for the wide/landscape board card "thin strip" — the card container's `overflow:hidden + display:grid` makes the grid item's `min-height:auto` collapse to 0 (on Chromium 154 a 20-card column collapsed 18px per card), so the title / project-name rows collapse to 0 height and only the tag row remains (the "squeezed together" look). The container-level overflow is removed; the title / project-name clamp divs each carry their own `overflow:hidden` height cap and the tag row flex-wraps, so the container no longer needs to be the backstop.
- **Global / text truncation**: eight inline `display:-webkit-box + -webkit-line-clamp` sites (board cards / global message search / notification center) are unified into the global standard class `wb-clamp-1/2/3` — the standardized `line-clamp` property (Chromium 135+) plus a `max-height` fallback (older versions degrade to "hard truncation, no mid-line cut"), consistent behavior across Chromium versions.
- **Chat / composer**: the send button is **always visible** — disabled when the input is empty (does not send), instead of the whole block disappearing with the draft (the old code dropped the whole block when empty, so on mobile it looked like "there is no send button").
- **Chat / topic window**: fixes the "topic-window ghost popup" — when a wide-screen window is narrowed, a topic opened inline on wide / restored from persistence would auto-convert into a Drawer popup; the plugin now remembers "was this topic explicitly opened by the user on portrait," and only in that case may the Drawer auto-open, so narrowing the window no longer pops wide-screen topics.
- **Global / tab strip**: every "pure horizontal scroll strip" in the plugin (top tab bar / view switcher / skill tab bar / antd Tabs nav, etc.) now supports **mouse-wheel horizontal scroll** — delegated on `document` in the capture phase (covers all strips at once), does not steal the message list (the list still scrolls vertically), and releases at the horizontal boundary (reaching the edge and continuing the wheel outward does not `preventDefault`, so the page scrolls normally).
- **Config / connectivity test (offline)**: the offline "connectivity test" is now a **real two-step probe** — ① a no-cors probe = pure network reachability (DNS / routing / TCP / TLS; "reached the server but blocked by cross-origin" returns an opaque response without throwing); ② a cors probe = whether the server has CORS enabled. Honest layered attribution: unreachable = address/network issue; reachable but CORS not enabled = browser direct dial blocked, fix = set `QWENPAW_CORS_ORIGINS` on the remote server (the upstream switch already exists), or put a same-origin reverse proxy in front of it. The offline banner diagnostics text is corrected to match.
- **Config / long address**: long URLs / addresses on the config page no longer break the narrow container (verified overflowing at 320/340) — inline-block + max-width 100% clamp with `break-all` wrapping inside the URL.

**Verification**: tsc 0 · single-file vite build 1,836.12kB (gzip 513.72kB) · pytest 374/374 · 1436 i18n keys, 0 missing / 0 duplicate / 0 empty · sensitive scan 0

---

## 0.5.0-beta.15.13 (2026-10-13 - portrait round 8: topo title scrolls, skill detail modal, board standard column width, tab scroll root fix)

**Portrait (376px) round 8: the workflow topology detail title bar now scrolls with its content instead of staying pinned at the top (reclaiming the vertical space it used to occupy); the project board on wide/landscape viewports adopts a standard board layout (status columns fixed at 250px, never squeezed, horizontal scroll when they don't fit one screen) — root fix for columns with more than three cards collapsing into a single thin line in landscape; skill cards in both skill centers (resource management + skill center) drop the two-line truncated description in favor of a "Details" button that opens a modal with the full description / source / version / runtime / channels / used-by; on portrait the upload / new-skill buttons in the resource-management skill tab move below the search box (no more overflow); the MCP edit button no longer overflows its row; the tab-strip horizontal scrolling in the runtime-config / resource-management modals is root-fixed; and the two long auth-mode labels (Matrix login / L1 admin) stack vertically on portrait**

- **Workflow / topology**: the project topology detail (interventions / interrupts / dependency graph / event stream) **title bar is no longer pinned to the top** — it scrolls together with the content below, reclaiming the vertical space on portrait so more of the graph and event stream is visible.
- **Workflow / board**: the wide/landscape board now uses a **standard board layout** (Jira/Trello style) — each status column is a **fixed 250px wide and is no longer compressed to fit the screen**, column height adapts to the viewport, and columns that don't fit one screen are reached by **horizontal scroll**. Previously, on landscape/intermediate widths, columns with more than three cards were squeezed into a single thin line. Portrait (<800) keeps the mobile board layout (columns stacked full-width, cards scrolling horizontally).
- **Team management / skill centers (resource management + skill center)**: skill cards **drop the two-line truncated description** — every skill card (assignment cards and the expanded materialized rows) gets a **"Details" button** opening a modal with the full description, source, version, runtime / load channels, and used-by. On portrait, the **upload-skill / new-custom-skill buttons in the resource-management skill tab move below the search box** (search takes the full row, the two buttons share a row at equal width) instead of overflowing the modal.
- **Team management / MCP**: the MCP service row's **edit button no longer overflows its container** — long service names / URLs wrap and shrink, the button always stays inside.
- **Global / tab strip**: the **janky horizontal scrolling of the tab strip** in the runtime-config / resource-management modals is root-fixed — the touch gesture declares horizontal panning up front (no direction-sampling delay) and the scroll chain is cut (scrolling the tabs to the end no longer drags the modal body with it).
- **Config / auth & login**: on portrait the two long labels **"Matrix login (L2, default) / L1 admin (token / Higress)" stack vertically** (wide keeps the horizontal segmented control), no more overflow.

**Verification**: real-data checks at 376px / 850px / 1440px viewports, item by item, plus a wide-viewport regression · tsc 0 · single-file vite build · 1428 i18n keys, zero duplicates · sensitive scan 0 · runtime smoke test clean

---

## 0.5.0-beta.15.12 (2026-10-13 - local offline mode: zero data dialing + config kept locally)

**Root fix for plugin behavior when running in a local environment (local plugin host, no QwenPaw server): the 503 error storm is eliminated structurally — the data domain (rooms / chat / workflows / artifacts) is not mounted at the entry point, so no data endpoint is ever dialed; the config domain stays fully usable — connection settings can be filled in and saved up front (kept locally, credentials redacted), and once a server is available this configuration can be applied via the Web console's "Backup & Restore → Import". Console host (online path) behavior is unchanged**

- **Offline detection**: the local plugin host shell exposes a static offline signal (`QP.host.isOffline`); the plugin entry branches on it at render time — the local host mounts the offline page, the console host mounts the full workbench as before. One artifact serves both ends; the online path is untouched.
- **Data domain**: the offline page mounts no data-page component — no dialing, no 503 errors, no polling; an offline banner explains why the data endpoints are unavailable and where the saved configuration goes.
- **Config domain**: the offline page embeds the original settings panel; config read/write (GET/PUT), export/import, connection test and admin verification run against a localStorage emulation layer — credential redaction (echoed as `***`, plaintext never returned), position-paired merging of address entries, pre-save credential-gap interception and enum downgrade rules aligned line by line with the server connector; a saved configuration survives reopening the plugin (browser local storage).
- **Connection test (offline)**: every address row honestly reports unreachable (the local host has no network path), with effective/pinned address computation identical to the online logic; admin verification returns a clear message — fill in and save now, verify once a server is connected.

**Verification**: tsc 0 · vite build single file (all guards passed) · sensitive scan 0

---

## 0.5.0-beta.15.11 (2026-10-13 - portrait round 7: board mobile layout + artifact name wrap + modal polish + container width alignment)

**Round 7 on the 376px device: the project board in portrait switches to a mobile kanban layout (status columns stack vertically at full width, task cards inside a column scroll horizontally — no more squeezed strips); long project names in the artifacts list wrap and stay fully visible (no more row-stretching or name loss); the "runtime config / resource management" modals get horizontally scrollable tab strips and skill cards now render fully inside the modal without clipping; the knowledge base column heights use the dynamic viewport so the mobile browser chrome no longer pushes content off-screen**

- **Workflow**: the project board in portrait (phone) now uses a **mobile kanban layout** — status columns (todo / dispatched / in progress / …) **stack vertically at full width**, and task cards inside a column keep a readable fixed width and **scroll horizontally** (about two and a half cards visible, native-list swipe feel). Previously a column with more than 3 cards collapsed into a vertical strip.
- **Artifacts**: **long project names wrap and stay fully visible** in the project artifacts list (previously overflow squeezed them into vertical single characters or stretched the row); long file names wrap instead of truncating; the artifacts area is **pinned to screen width** — no page-level horizontal scrolling no matter the content.
- **Team management**: the "runtime config / resource management" modals now have **horizontally scrollable tab strips** (in narrow widths tabs are not cut off or lost; the last tab stays reachable via the overflow menu), and skill list cards **render fully inside the modal** — name, source tag and description lay out with normal wrapping (previously the description was squeezed into single-character vertical text or clipped past the modal edge).
- **Global**: page containers uniformly hug the screen width (padding included); over-wide content no longer produces **page-level horizontal scrolling**; knowledge-base column heights use the dynamic viewport so the heights track the mobile address bar (no more content pushed off-page).

**Verification**: live-data tests at a 376px phone viewport (board / artifacts / both modals / zero page horizontal overflow) + 1280px wide regression unchanged · tsc 0 · vite build single file (468 modules) · sensitive scan 0

---

## 0.5.0-beta.15.10 (2026-10-13 - portrait round 6: root-cause fix for the 4 re-reported items + home workflow card)

**Round 6 on the 376px device: all 4 items re-reported as "still broken" fixed at the source level — the real root cause of horizontal drag in the team-management "runtime config / resource management" modals (150px fixed label column + 140–220px fixed-width controls exceeding the ~280px modal content width) is now a portrait-vertical form layout with controls clamped to the modal width; the workflow project topology (DAG) auto-fits the container width in portrait (whole graph visible at once) with node titles wrapping to 2 lines; board task-card worker tags wrap instead of bursting the card; the topology detail title bar now uses an opaque solid background (the previous "opaque" fix actually used a translucent color, so scrolling content still showed through); team-management topology-tree meta rows wrap to a second line in portrait**

- **Team management**: the "runtime config / resource management" modals **no longer drag horizontally** in portrait — form rows (label + control) **switch to vertical layout** (label on top, full-width control below) and all select/input controls are **clamped to the modal content width** (the 150px fixed label column plus 220px fixed controls previously summed past the ~280px modal content width — the actual root cause of the horizontal drag); all containers inside the modals hug the modal width. In the topology tree, a worker row's secondary info (model / runtime / version / MXID / spawn badge / DM button) **moves as a group to a second line** in portrait; long MXIDs can break.
- **Workflow**: the project topology (DAG) **auto-fits the container width** in portrait — when the DAG's layout width (columns × 200px nodes) exceeds the screen, it scales down so the whole graph is visible at once; pinch/zoom buttons explore in detail (reset = back to the fitted scale); DAG node titles **wrap to 2 lines** (previously hard-truncated at 14 chars); the topology detail **title bar uses an opaque solid background** (the previous "opaque" fix mistakenly used a translucent card color, so scrolled content still bled through), no more overlap when scrolling; the toolbar **back button is always leftmost**, with "Projects (xx)" to its right; board task-card worker tags **wrap / break** instead of overflowing the card.
- **Home**: new "Workflow" quick card (one tap into project progress and task topology).

**Verified**: tsc 0 · vite build single-file (468 modules) · sensitive scan 0

---

## 0.5.0-beta.15.9 (2026-10-13 - portrait round 5: composer rework + file bubble relayout + drag-jank root fix)

**376px measured round 5: chat composer rebuilt (attach/send inlined to the sides, emoji removed, long text auto-grows to 5 lines), file bubbles relayouted so 376px no longer crushes content, compact header tightened + larger back button; workflow toolbar merged into one row + board cards auto-wrap + topology back moved up; artifact project-topology pinned to screen width; team-management modals hugging width + sticky tab bar; home quick-cards 2-column in portrait; window-drag jank root-caused and fixed**

- **Chat**: the composer row is rebuilt — the **attach button sits on the left, the send button is inlined right next to the input**, and the **emoji button is removed**; the small bar above the input (the old manual height-drag handle) is gone, long text now **grows with content up to 5 lines max** (no manual dragging). File bubbles are relayouted into two rows — a name row (icon + full filename wrapping + size) and an action row (download/view right-aligned) — so at 376px nothing is crushed together. The portrait header is tightened further, content is **vertically centered**, and the **back button is enlarged for touch** (~40px target).
- **Workflow**: the toolbar is merged into a single row — the "Project (xx)" selector shares it with the **sort and refresh** buttons; the topology view's back button moves to the **left of the sort button** (the old spot cost a whole title-row of vertical space); the title container is no longer transparent (no more overlap when scrolling down); worker tags inside project-board cards now **wrap automatically** instead of blowing past the card container; task details show the worker's **short name** (e.g. @tech-writer, not a long address).
- **Artifacts**: the project-topology container under project artifacts is **pinned to the screen width** (columns used to get too wide); overflowing text wraps.
- **Team management**: the run-config / resource-management overlays are now **portrait-friendly modals** — inner containers hug the modal width, form fields go single-column in portrait, the **top tab bar sticks while the settings content below scrolls independently** at the modal's width.
- **Home**: the 7 quick cards go **2 equal columns** in portrait (no more uneven stretching); the screen-side left/right margins are trimmed.
- **Performance**: **window-drag jank root fix** — dragging the window previously recomputed and re-rendered the whole page for every 1px of change; pixels are now only recorded, and a re-render happens only on the exact frame the narrow/wide threshold is crossed, so the page stays smooth while dragging.

**Verified**: tsc 0 · vite build single-file (468 modules) · secret scan 0

---

## 0.5.0-beta.15.8 (2026-10-12 - portrait round 4: per-page layout tightening + button inlining + cards no-overflow)

**376px measured round-4 per-page refinement — chat composer buttons inlined / room name wraps / scroll-to-bottom stays round, workflow title removed / sort+refresh pinned to edges / board 2-column 3-card / cards no-overflow / topo back merged into title / worker short-name, artifacts kind under icon / actions stacked, team-management modal content hugging width**

- **Chat**: the emoji/attach/send buttons below the input are now **inlined into the same row as the input** (send hugs the right edge, shorter height; wide screens unchanged); the member @tag row drops the "tap a member to insert a mention" hint + no longer stretches vertically; the scroll-to-bottom button is a true circle (no longer stretched into a vertical bar in portrait); the portrait chat header is tightened further + the room name wraps (long names show fully instead of truncating)
- **Workflow**: the "Workflow" title is removed (the top tab already says it); the sort + refresh buttons are pinned to the left/right ends of the toolbar; the narrow board is 2 columns again with ~3 cards per column and inner-column scrolling beyond that; board cards no longer blow past the column width (long strings shrink/wrap); the topology back button is merged into the bottom title bar (the duplicate top title is removed, saving vertical space); the task detail shows the worker's short name (e.g. @tech-writer, not a long address)
- **Artifacts**: in the narrow file list the "kind" label moves under the file icon (saving horizontal room so filenames wrap less); the view/download action buttons stack vertically in portrait
- **Team management**: the run-config / resource-management modal inner containers tighten to hug the modal width (no more large side gaps); the top tabs scroll horizontally in portrait
- **Verified**: tsc 0 · vite build single-file (468 modules) · secret scan 0 · 5 commits (8a6c850/b0b71ba/661d2d0/260e4d6)

---

## 0.5.0-beta.15.7 (2026-10-12 - portrait workflow cluster + small-item refinement + drag initial fix)

**The workflow page is reworked for portrait (card-ified project list + 2-column board + topology pinch-zoom + worker detail modal) + a batch of portrait small-item refinements + a first pass on window-drag layout responsiveness**

- **Portrait workflow**: project list becomes tappable cards; the board returns to 2 columns; the topology supports **pinch-zoom** with node-card text wrapping; worker details move into a modal (no longer cramped in portrait).
- **Portrait small items**: top tab bar tightened; chat composer height reduced; the @mention candidate popup gets a height cap (long lists no longer push the screen); artifact-table column widths trimmed.
- **Performance (first pass)**: window-drag layout measurement is coalesced to at most once per frame and sub-pixel changes no longer re-render the whole page — dragging feels much more responsive (the complete root fix lands in 15.9).

**Verified**: tsc 0 · vite build single-file (468 modules) · secret scan 0

---

## 0.5.0-beta.15.6 (2026-10-12 - portrait touch polish: drill-in + touch targets + overflow)

**Portrait drill-in navigation (list → detail + back bar) + enlarged touch targets + portrait overflow cleanups, with zero wide-screen regressions**

- **Portrait drill-in**: the "list → tap → detail + back bar" pattern lands on more pages in portrait; detail views go full-width with one-tap back.
- **Touch targets**: small buttons get larger hit areas (easier to hit with a finger).
- **Overflow**: a batch of portrait horizontal overflows cleaned up (content no longer pushes past the screen edge); wide-screen layout unchanged.

**Verified**: tsc 0 · vite build single-file (468 modules) · secret scan 0

---

## 0.5.0-beta.15.5 (2026-10-12 - portrait overlay overflow guard + touch-reachable copy)

**Modals/drawers no longer overflow the screen in portrait (fixed-pixel-width overlays clamp to the viewport) + copy buttons in code blocks and chat bubbles are reachable on touch (no longer hover-only)**

- **Portrait overlay overflow guard**: a set of modals/drawers (create gateway, team config, file preview, workflow detail, etc.) had hard-coded 420-780px widths — on a 390px phone they overflow horizontally, with the right half pushed off-screen and unreadable. Now modals/drawers get an "effective width = min(set width, viewport width)" constraint: on a phone they always fit inside the screen (drawer = full width, modal = 8px side margins), and wide desktop is completely unchanged (a wide viewport takes the set width = as before). Applies to all modals/drawers; newly added ones get it automatically.
- **Touch-reachable copy**: the "copy" buttons in the top-right of code blocks and inside chat bubbles used to appear only on hover — phones have no "hover", so the buttons were invisible and untappable. Now on pure-touch devices these copy buttons are always visible and tappable at any time.

**Verification**: tsc 0 · vite build single file (0 import statements = host-blob safe) · pytest 374/374 · i18n 0 new keys · 5 smoke all pass · sensitive scan 0

---

## 0.5.0-beta.15.4 (2026-10-12 - unified portrait detection + compact chat header + tap-to-dismiss tooltips)

**One shared portrait/narrow judgment for the whole plugin (chat single-column ⇔ team cards always in sync) + portrait chat header compressed to 1 line (secondary controls moved into the "more" menu, giving room back to messages) + touch tooltips dismiss the instant you press elsewhere**

- **Unified portrait detection**: the chat "single/two-pane" judgment used one logic while the teams-table card layout and table edge-fade each used a different one (with different thresholds) — so the chat could already be single-column while the teams table had not gone to cards. Now there is a **single source of truth** for the whole plugin (the same container-visible-width < 800 the chat uses); the teams table, table edge-fade, and chat all share it — the moment the chat collapses to single column, the teams table becomes cards and the tables show the scroll-fade, together. Adjusting the threshold now means editing one place.
- **Portrait chat compact header**: the portrait chat header crammed 6+ controls on one line (room name + member count + phase badge + project files + search + more menu + tool toggle + member strip + start-task) — at 390px they wrap to 3-4 lines, squeezing the message area down to a sliver. Now the portrait header is **one line**: `← back | room name (ellipsized) | phase | more`, with the secondary controls (members / project files / search / tool toggle / start-task / rename / mute / leave) all inside the **more menu** (reachable in one screen). Wide-desktop header is unchanged.
- **Touch tooltip "press to dismiss"**: a touch-opened tooltip used to close only when you *released* elsewhere; now it closes the instant your finger *lands* elsewhere — no waiting for the release, snappier.

**Verification**: tsc 0 · vite build single-file (0 import statements = host blob-safe) · pytest 374/374 · i18n 1,425 keys 0 missing · 5 smoke all pass · sensitive scan 0

---

## 0.5.0-beta.15.3 (2026-10-11 - P1 portrait-refinement batch)

**Portrait discoverability: tab bar horizontal-scroll edge fade (11 tabs no longer "invisible" at 390px) + teams table card layout in narrow + right-edge fade on 7 scrollable tables + copy-MXID (the one context-menu-only avatar action) moved into the tap panel**

- **Tab bar scroll fade**: 11 tabs fit ~4 on a 390px phone — scrollable but no visual cue. Four-state mask-image fade (both/left/right/none) driven by scroll events (scroll-driven animation is not Safari-safe yet); switching tabs auto-scrolls the target into view (else the active highlight sits off-screen); bottom border moved outside the masked container so it can't fade
- **Teams table → cards** (<576px): 5 columns are unreadable at 390px — one card per team (name+status / Leader + ready-worker count / member tags wrapping), data layer untouched, render branch only. The other "three tables" checked out: Workers is a tree, sessions a drawer list, ops a card grid — already portrait-friendly, left alone
- **Right-edge fade on 7 scrollable tables** (artifacts / CRD ×3 / file preview / people ×2): scroll.x tables are always horizontally scrollable in narrow → a 16px gray translucent gradient at the right edge signals "more"; wide screens where content fits get no fade (no false signals)
- **Avatar menu touch closure**: copy-MXID was context-menu-only (no right-click on touch) → moved into the tap-reachable quick panel; the rest (view sessions / mention / worker config / DM) already lived there — the context menu is now a desktop-only extra
- **Workflow board checked**: no drag interaction exists (sortable list, not a drag kanban) — WCAG 2.5.7 passes by construction, no alternative path needed

**Verification**: tsc 0 · vite build single file 1,795.03 kB (gzip 501.31 kB, 0 import statements = host-blob safe) · pytest 374/374 · i18n gate pass · 5 smoke scripts pass · sensitive scan 0

---

## 0.5.0-beta.15.2 (2026-10-11 - P0 touch-reachability batch)

**All touch information reachable: 58 Tooltips unified on WbTooltip (tap-to-open on touch, hover unchanged on desktop) + 44px touch targets on high-frequency actions + message action bar tap-to-toggle + jump-to-bottom floaters lifted into the safe area**

- **WbTooltip shared wrapper**: default trigger = hover+focus+click — pure touch devices (phone/tablet/touch laptop) tap to reveal, desktop hover path untouched; the 6 sites wrapping **clickable buttons** auto-downgrade to tap=false (hover+focus only): a click trigger would double-fire with the button's own onClick, turning a touch tap into "action executed + tooltip noise"
- **58 sites migrated** (17 files): status dots / truncated IDs / icon buttons / model verdicts / error details — all touch-reachable (WCAG 1.4.13)
- **44px touch targets** (.wb-touch-lg, pseudo-element hit-area under coarse pointer, visual size unchanged): chat send + approval apply; dense table row actions stay 24px (WCAG 2.5.8 row-inline + spacing exemption — expanding would overlap neighbours)
- **Message hover action bar touch-ified**: on touch-only devices (hover:none) tap the message row to toggle the action bar; desktop mouse path unchanged
- **safe-area**: both chat jump-to-bottom / "N new messages" floaters move to `max(Npx, env(safe-area-inset-bottom))` — no longer covered by notch/home-indicator devices
- **Touch CSS infra verified** (already present from 13.x, confirmed effective this batch): touch-action: manipulation / transparent tap-highlight / overscroll-behavior: contain on nested scrollers / hover:none always-shows hover-only actions

**Verification**: tsc 0 · vite build single file 1,789.98 kB (gzip 499.92 kB, 0 import statements) · pytest 374/374 · i18n 1,424 keys 0 missing 0 dup · 5 smoke scripts pass · sensitive scan 0

---

## 0.5.0-beta.15.1 (2026-10-11 - dark-mode adaptation batch)

**Full dark-mode pass: homepage quick-action cards go translucent (black shows through) + all cards slightly translucent (dark = black through) + repo-wide hardcoded-color audit — 40 sites mode-branched, 12 black-translucent text sites and 9 gray/black-translucent backgrounds migrated to theme tokens**

- **Homepage quick-action cards**: dark mode background switches from accent-10%-on-white (a bright slab on a dark page) to accent-over-transparent (black shows through); border/label/description move to light-accent and the secondary-text token
- **Card translucency**: cardBg is 72% white in light mode (host off-white shows through) and 5% white in dark (over #141414, so black shows through) — depth from a luminance step, not a solid block
- **Dark-mode hard fails cleared**: yellow warning bars + dark-amber text (CRD/Worker management), error banners (dark-red text, light-red border), near-black `#333` text, solid `#f5f5f5` backgrounds — all switched to translucent semantic backgrounds + light-variant semantic colors in dark
- **Token migration**: 12 `rgba(0,0,0,x)` text sites (approval cards / runtime config / session step lines / gate cards) → `textSecondary`; 9 `rgba(0,0,0,x)` / `rgba(127,127,127,x)` backgrounds and borders (code blocks / diagnostic cards / progress tracks / self-check cards) → `toolBg` / `hoverBg` / `border`
- **Semantic light tints deepened in dark**: loop chips (awaiting-user / running), workflow pause cards, env hint bars — background opacity 0.06–0.12 → 0.14–0.16

**Verification**: tsc 0 · vite build single file 1,790.00 kB (gzip 499.72 kB, 0 import statements) · pytest 374/374 · sensitive scan 0

---

## 0.5.0-beta.15 (2026-10-09 - official release)

**Merged release of the 14.1–14.34 sub-batches (low-bandwidth full-link performance + config/credential security hardening + deployment resilience + SGLang observability + tech-debt cleanup; pytest 71→374)**

- **Low-bandwidth full-link performance**: message real-time triad (stream-break self-healing / background-tab message loss, root-cause fixed) + WAN disconnect root-cause fix (proxy 4xx semantics + direct-dial address-family failover) + WAN generic auth (per-address Basic / API key override); systematic performance batches (event-loop blocking / serial round-trips / polling backoff / blocking DNS / request-surface convergence / poll scheduler / dial gate / layered failover policy); low-bandwidth batches (initial sync payload −65%, zero message re-fetch, per-path bytes accounting, KB read compression + server-side preheat); controller request fan-out governance (status dots 25 paths→1, project workflow 36 paths→1); measurement-driven deep fixes (3D graph dormancy / fully incremental scanning / GPU effect soothing)
- **Config & credential security hardening**: credential memory + WAN full family + 0600 permissions + local volume + masking (scheme finalized); **config pinning** (write audit ring + 409 optimistic lock + defaults-overwrite guard — seals the default-form overwrite hole) + load-state isolation (fresh/read-error split: transient read failures take the 503 retry chain, the default form is never presented) + atomic write + backup self-heal + presence-by-error-type + credential self-attestation; console-session auto re-login (persisted credentials + three gates); **root-cause fix for "401 forcing password re-entry"**: the L2 "Controller projects" 401 is a structural 401 of the token path (upstream only permits level-2/3 accounts) — now surfaced as an amber expected state with an explicit "no need to re-enter the password" note, so the Basic credentials are no longer misread as wrong
- **Deployment resilience & weak forms**: theme real-time follow + first-frame consistency (follows QwenPaw 2.2.2+ color scheme), auth semantics + token-verification resilience, partial-connection hint (Controller up + Matrix unsigned-in = dismissible info banner), embedded deployment docs in the package, in-room project artifacts sharing one source and one speed
- **SGLang observability**: card adaptive cadence (1s active / 5s steady) + activity signal + dual-cadence labeling + home-page twin-card parity + "snapshot Ns ago" replaced by a pulse dot (lights once per frame received) + per-DP-rank status labels + throughput row
- **Feature completion**: model-config edit/delete (aligned with the dashboard), progressive workflow landing + background yielding, host-native top notifications, runtime reminder 8-panel, unified inline buttons
- **Tech debt & engineering**: tech-debt health-check batches (router domain split / time-format convergence / legacy cleanup), version-archaeology comment cleanup 1,646→0, test-suite isolation (seals the real-path write hole); pytest 71→**374**, i18n 1,376→**1,424** keys

**Verification**: tsc 0 · vite build single file 1,785.44kB (gzip 498.14kB, 0 import statements = host-blob safe) · pytest 374/374 · i18n 1,424 keys 0 missing 0 dup 0 empty · sensitive scan 0 (commit messages + content diff + full tree incl. dist decode)

---

## 0.5.0-beta.14.34 (2026-10-09 — "401 forces re-entry of password" root fix batch — expected-state surfacing + perceivable refresh)

**Three items from 14.33 install verification: (1) settings shows "WAN pinned + saved" yet a 401 forces re-entering the password while the controller test clearly connects — forensics verdict: the basic password itself was fine (after the 18:40 re-save all 7 URLs returned 200). The real culprit is the selfcheck L2 row "Controller projects (L2)" being a permanent 401 with a red cross — that check uses the Matrix-token path, which upstream admits only level-2/3 accounts; level-1 admin accounts always get 401 (unrelated to the WAN basic credentials), while the L1 admin-token primary source returns 200 at the same moment ("the controller connects"). The old code probed L1 *after* L2 and could not classify the expected state, so the red ✗ "HTTP 401" was read as "wrong password" → repeated re-entry. (2) SGLang refresh still feels sluggish. (3) The "snapshot 0s ago" label should go. This batch roots out all three: L2 expected-state surfacing (when L1 is usable the 401 is by design → amber ⚠️ + explicit "unrelated to basic credentials, no re-entry needed") / config/test same-family cross-check (when another same-family URL returns 200 with the same credentials, the 401 row says "more likely a transient tunnel/gateway failure, not necessarily a wrong password") / both SGLang cards drop the age text for a pulse dot (lights once per frame) + home card gains status tags and throughput**

### Fixes

- **selfcheck L2 "401 forces re-entry" root fix — expected-state surfacing**: the L1 admin-token probe now runs *before* L2; when L2 returns 401 and the L1 primary source returns 200, the row is classified **expected** (`ok=True, warn=True`, rendered amber ⚠️ instead of red ✗), with detail/hint stating "this account is a level-1 admin; this is upstream permission design, unrelated to WAN/LAN basic credentials, no re-entry needed". Without an L1 token, or with a dead L1 token, the row still shows as a real failure (no false expected-state). The L2 level is no longer dragged to ✗ by a structural 401
- **config/test same-family cross-check**: when another URL in the same family returns 200 (same credentials), the 401 row's detail gains "another same-family URL returns 200 (same credentials) — more likely a transient tunnel/gateway failure, not necessarily a wrong password". When a WAN tunnel briefly drops, edge gateways can return 401 directly; the old text always blamed the credentials → users re-entered the password for nothing
- **Both SGLang cards: drop "snapshot Ns ago" + pulse dot**: at a 1s poll the age text is permanently 0 with no perceptibility (user-named for removal) → a green dot lights once per load snapshot (remount re-plays the `wbSgTick` animation, so refresh is visible even when numbers are frozen)
- **Home "cluster load" card gains perception**: per-DP-rank status tag (idle green / queued orange / running blue, OpsPanel parity) + throughput line (tok/s — a second signal when request counts are frozen but inference is still at full speed; 0 shows "—") + subtitle "Auto refresh (1s active / 5s idle)"
- i18n: orphan key "snapshot Ns ago" removed, OpsPanel tooltip text refreshed, new pulse-dot hint key (zh+en)

### Tests

- New `test_14_34_401_perception.py` (5 regressions): L1 200 + L2 401 → expected state (incl. probe order L1-first + display order unchanged) / no token → still real failure / dead L1 token → still real failure / config/test same-family 200 → tunnel hint appended to the 401 row / all-401 → no hint
- pytest 374 green; tsc 0; i18n gate 0 missing / 0 dup; poller smoke green

---

## 0.5.0-beta.14.33 (2026-10-09 — "home SGLang card parity" batch — the twin card 14.26 missed)

**When 14.26 fixed "SGLang card refresh feels sluggish", it only fixed the Ops Panel card (slow tier 15s→5s + "snapshot Ns ago" freshness self-proof). The Home page "cluster load" card is its twin — missed in the same batch: slow tier still 15s, and its state has no snapshot time at all, so when idle the card shows zero change signals (running/waiting frozen + no age counter) — perceived as "not refreshing". This batch closes the gap: slow tier 15s→5s (OpsPanel parity — 14.26 already proved the underlying SGLang parameter is decode iterations, not seconds, snapshots publish ≥1Hz when busy with <1s staleness, so the slow tier itself was the culprit) + ported the snapshot-age self-proof (refreshed every poll, independent of the diff gate — when idle the numbers are frozen but "snapshot Ns ago" keeps ticking, proving the link is alive)**

### Fixes

- **Home SGLang card slow tier 15000ms → 5000ms**: aligned with the OpsPanel twin (1s fast tier while load changes / 5s slow tier after 2 stable cycles), removing the 14.26 gap
- **Home SGLang card gets the "snapshot Ns ago" freshness self-proof**: per-rank `snapshot_ts`, newest across ranks, refreshed on every poll (independent of the setSglang diff gate so the age keeps ticking when idle); reuses the existing i18n key (zero new keys)
- Removed 3 stale comment blocks contradicting the current adaptive logic (constant-5s dead-logic note / 1s-15s tier description)

### Tests

- pytest 369 green (real config untouched — 14.32 sentinel verified in the same run); tsc 0; i18n full coverage (0 new keys); sensitive scan 0

---

## 0.5.0-beta.14.32 (2026-10-09 — "test-suite isolation" batch — pytest real-path write hole sealed for good)

**10/9 16:39:49 field case: a full pytest gate run had `test_update_config_address_mode` (unisolated, calling `update_config` directly) write the real config three times (wan→auto→auto), silently reverting the user's "pinned WAN" to auto. The same case also explains every "nobody touched it but the mode flipped back to auto" disk event since 10/8: since 14.1, every full suite run (including all QC gate runs) rewrote the real config through this test, while pytest's own log capture and its in-process audit ring leave zero trace in the main log (earlier rounds misattributed this to "another session / external writer"). Structural fix: conftest autouse redirects `_CONFIG_PATH` to tmp for every test (same pattern as the existing KB-cache isolation) + a session sentinel (real config file must be byte- and mtime-identical across the whole run, else the entire suite fails and names the case) + explicit isolation on the offending test. Zero runtime behavior change — test-side only**

### Fixes

- **conftest autouse `_isolate_real_config`**: every test now redirects `_SECRET_DIR`/`_CONFIG_DIR`/`_CONFIG_PATH` to its own tmp — no test calling `update_config`/`save_config`/HTTP PUT directly can ever reach the real secret dir (individual tests may still override, LIFO last-set-wins)
- **session sentinel `_real_config_sentinel`**: snapshots the real config's mtime+sha256 at session start, compares at the end — any test touching the real path fails the whole run and names the file (belt-and-braces with the autouse: one blocks by path, one by outcome)
- **`test_update_config_address_mode` explicit isolation**: the offending test gets its own tmp redirect + field-case comment (defense in depth + self-documentation)

### Tests

- pytest 369 green; the real config file's sha256+mtime are bit-identical before and after the full run (independent external check, sentinel agrees) — this batch's own gate is the verification: the 14.31 batch's gate run (16:39:49) was the crime scene, and this batch re-runs the same conditions with zero touch

---

## 0.5.0-beta.14.31 (2026-10-09 — "fresh misclassification" fix — mount-layer immunity for the 14.30 discriminator itself)

**10/9 16:15 field case: opening Settings inside the cold-mount window after a Docker Desktop restart showed the editable "mode=auto + basic password to re-enter" form again. The 14.30 fresh/read-error discriminator stood on the same shaky ground — `Path.exists()` also returns False for paths that can't be stat'ed (EMFILE/EIO), so a transient mount-layer failure was misclassified as "file never existed" → `fresh` → GET 200 + default-state form (same chain as the 10/8 wipe, with the entry swapped for a fake-fresh identity). This release re-bases the discriminator on error types: only `FileNotFoundError` = truly absent (fresh — first-boot behavior unchanged); any other OSError = existence unknown → `read-error` (GET 503 + frontend retry chain, self-heals when the mount recovers). The defaults-fallback path also logs state+presence+errno now (previously these events left zero trace — forensics ran on mtime guesswork)**

### Fixes

- **fresh discriminator re-based on error type (root cause)**: `exists()` swallows OSError (CPython semantics: "doesn't exist **or can't be accessed**" → False) → replaced with explicit `stat()` three-state classification: success=present, `FileNotFoundError`=absent (fresh), other OSError=unknown (read-error). "Unknown" is never treated as absent — "we don't know if it's there" ≠ "it isn't"
- **defaults-fallback leaves a trace**: entering the defaults fallback (fresh/read-error) now logs a WARNING (state + presence + errno) — events like 10/9 16:15 get an exact timestamp and errno instead of mtime-based guesswork

### Tests

- +5 cases (stat/read/bak all EMFILE → read-error not fresh / GET 503 under EMFILE / truly-absent still fresh (no first-boot regression) / stat-ok-but-read-EMFILE-no-backup → read-error / EMFILE-then-recovery → next load self-heals to ok with real data); pytest 369 green; tsc 0; sensitive scan 0 new

---

## 0.5.0-beta.14.30 (2026-10-09 — "defaults masquerading as success" chain sealed — config mis-wipe root cause closed out)

**Final seal on the 10/8 "mode reverted to auto + all credentials gone" wipe chain: load-state split into `fresh` (first boot — legal, editable, savable) and `read-error` (file present but transient read failure — a fake state); on `read-error` GET /config returns 503 (defaults can never reach the user's decision surface) and saves are 409 (force_persist does not exempt); the "no config_rev in save = skip validation" backward compatibility is retired (it was the back door that let a default-state form / direct API call overwrite disk — first boot is unaffected); plus a latent-defect fix — `load_config` unconditionally stamped `ok` at the tail, wiping the `restored-from-backup` marker, so the "restored from backup, please verify" banner had never actually been shown; frontend locks the whole settings form to read-only while config is still loading (belt-and-braces with the disabled save button and the backend 409)**

### Fixes

- **Load-state semantics split (root cause)**: the old `defaults-fallback` conflated "no file on first boot (legal initial state)" with "file present but unreadable (fake state)" — the frontend could not tell "you may fill this in" from "do not touch this". Now: `fresh` = main file never existed → 200 + savable (first write = creation); `read-error` = file present but read failed → GET 503 into the retry chain, form unsavable
- **GET /config read-error → 503**: a transient read failure used to still return 200 with full defaults (fake success) — the frontend took the defaults for "saved config", the user saw "mode = auto, password blank", assumed loss, and saving wrote the defaults back over disk (the starting point of the 10/8 wipe chain). Now 503 forces the retry chain; when all retries fail the page shows a "load failed" banner
- **PUT /config without revision → 409 (when the file exists)**: "no config_rev = skip validation (backward compatibility)" used to allow a default-state form / script / stale tab to overwrite disk — the 10/8 wipe's back door. First boot (no file on disk) keeps working normally
- **read-error save → 409 (force_persist does not exempt)**: "explicit recovery" means rebuilding a *missing* file; a read-error file is very likely intact, and overwriting it with defaults is the last step of the wipe chain. Recovery path for a genuinely corrupt file = config import (explicit paste, with a backup rollback point)
- **update_config defense in depth**: in read-error state any call path's persist → IOError refusal (does not rely on the HTTP-layer check)
- **Restored banner never shown (latent defect fixed)**: `load_config`'s tail unconditionally set `ok`, wiping the `restored-from-backup` marker — the "config was auto-restored from backup, please verify" banner condition never held. Now only the plain disk-read path stamps `ok`
- **Frontend load-window form lock**: while config is still loading (load window / failure) the whole settings form goes 45% opacity + non-interactive (the banner stays clickable for retry) — the default-state form no longer presents the misleading "password box looks empty, must be re-typed" look; three layers (form lock / disabled save button / backend 409) back each other up — if any one layer fails, the rest still hold

### Tests

- +10 backend cases (fresh/read-error split ×3, GET 503/fresh 200 ×2, PUT 409 ×3 (read-error force not exempt / no-rev file-present / first-boot no-rev allowed), with-rev normal save regression, config.py-layer refusal); 7 14.27-semantics tests rewritten for the new semantics (including the "no-rev backward compat" test inverted to assert 409); pytest 364 green; tsc 0; sensitive scan 0 new

---

## 0.5.0-beta.14.29 (2026-10-09 — root-cause fix for "basic password needs re-entering / LAN-WAN mode reverts to auto")

**Root-cause fix for the recurring "basic-auth password needs re-entering after a new install" / "credentials vanish after switching to fixed LAN/WAN": config-read retry on transient mount-layer failure (no more false "corrupt file" → running on defaults) + anti-wipe guard (a single-field patch can never erase disk data it didn't touch — the 10/8 wipe mechanism, now blocked) + credential self-attestation (settings page shows per-entry "saved / username-only / none" so "do I need to re-type it" is a glance, not a guess)**

### Fixes

- **Config-read retry on transient failure (root cause)**: installing the plugin triggers a workspace reload storm during which the NFS/FUSE mount layer can momentarily return empty/truncated content — a single failed read was treated as "corrupt file" → fell back to defaults (address mode jumped back to auto, address credentials appeared fully lost), and the page displayed those defaults as if they were the saved config. A failed read now retries once (0.25 s) before declaring corruption, so a transient hiccup no longer triggers the defaults fallback
- **Anti-wipe guard (mechanism blocked)**: when the in-memory baseline was poisoned by a transient read failure (false corruption → defaults), a single-field patch (mode switch / login writing a session) persisted = wiping the entire on-disk address list and credentials (10/8 production incident: lan→auto silently rewritten, password and addresses all gone, zero log lines). Before persisting, the merged result is now checked against the actual disk state — any key the patch didn't touch, that has values on disk but would be dropped by the merge → persist refused with an explicit error, disk data preserved. Explicit recovery (`force_persist`) waives only "defaults over a corrupt file", never "dropping untouched data"
- **Credential self-attestation (`credential_state`)**: GET /config now carries per-entry presence flags (computed from the raw pre-redaction state, values never leak) — each address entry is `saved` / `username-only` (username stored, password missing) / `none`; the settings page surfaces an amber warning for `username-only`. A blank password field no longer reads as "maybe lost": `saved` = leave blank to keep, `username-only` = genuinely missing, fill it in

### Tests

- +6 backend cases (transient-read retry / persistent failure still falls back / poisoned-baseline wipe blocked / explicit family override still allowed / credential_state three-state decision / GET exposes credential_state); pytest 354 green; tsc 0; i18n 1311 keys 0 missing; sensitive scan 0

---

## 0.5.0-beta.14.28 (2026-10-09 — low-bandwidth P0/P1 perf batch + comment archaeology cleanup)

**Full-audit P0/P1 landing: bundle −25% (dead WebGPU path stripped) / sidebar approval badge goes subscription-based (4 dials/min → 1) / three idle re-render hotspots get value gates / three memory leaks plugged; two 14.27 review gaps fixed (SGLang snapshot-age read the wrong field; corrupted-config recovery path was blocked); password-field display semantics ("saved · leave blank to keep"); per-version changelog-style comments fully stripped from source (1646 → 0)**

### Fixes

- **SGLang "snapshot Ns ago" read the wrong field (14.27 gap)**: it measured request-processing time (≈ link RTT, always ~0s), which masked a genuinely stale snapshot — now reads each rank's real snapshot publish time (age hidden when the upstream lacks the field)
- **Corrupted-config "re-fill and save" was actually blocked (14.27 gap)**: the banner's second recovery path hit the same overwrite guard (200 response but nothing written, so the save looked successful) — explicit recovery channel: saving under the banner warning now carries `force_persist`; the button reads "Save (rebuild the config file with the current form values)"
- **Basic-auth password "memory gone" display semantics**: passwords are never echoed back for security, but a blank field read as "forgotten" — placeholder now "admin password (saved · leave blank to keep)" plus an explanatory line
- **Three memory leaks plugged**: avatar cache capped at 300 (unbounded growth in long sessions); media objectURLs over the cap are reference-counted and revoked on the last owner's unmount (previously unreclaimable blobs); FilePreview revokes its blob on unmount

### Changes

- **Bundle −25%**: three's 2.1 MB WebGPU path (statically imported by 3d-force-graph's transitive dep, never instantiated — the plugin only uses WebGLRenderer) is aliased to a stub — gzip 661.8 → 497.7 KB
- **Sidebar approval badge is now subscription-based**: real fetches are driven by active consumers (SSE approval events drive invalidation with zero extra dials); the icon is a pure subscriber + 60s backstop (only while the page is visible) — 4 dials/min → 1/min
- **Three idle re-render hotspots get value gates**: ① auth-status polling moves to the shared poller scheduler (auto-pauses when hidden, catch-up on return) + field-level value gate (previously a forced main-component re-render every 30s) ② worker status dots only update when running/lastUpdated actually change ③ SSE message frames drive the chat-drawer refresh only while the drawer is open
- **Cadence drops**: chat-drawer backstop poll 4s→10s (SSE is the primary path); 3D graph visibility re-check 2s→5s
- **Light console-fx tier**: the 1.2s infinite pulse animations pause (dots stay visible; the running semantics live in color/tooltip)
- **Comment archaeology cleanup**: all per-version changelog-style comments (version prefixes / internal task numbers / acceptance narratives — 1,646 lines → 0) removed from source, keeping only the "why" of the code in front of you; version history lives in the CHANGELOG and git history

### Tests

- +2 backend cases (explicit-recovery endpoint/unit); pytest 348 all green; tsc 0; i18n 1419 keys 0 missing 0 dup; secret scan 0; bundle gzip 497.7 KB

---

## 0.5.0-beta.14.27 (2026-10-09 — config pinning + native top toast + SGLang real-time correction)

**Three field-feedback items + a full write-path audit of the config: the 3rd recurrence of "address mode reverted to auto / basic login state gone" is handled by exhaustively instrumenting every write path (who changed it, the log says so) + concurrent-write protection + defaults-overwrite guard + load-state surfacing; the worker tool toggle now fires the host-native top toast (same mechanism as skill changes); the SGLang card's "~15s per frame" is proven to be the front-end slow tier (the upstream snapshot is measured at ≥1 Hz), so the slow tier drops 15s→5s and a snapshot-age self-check is shown**

### Fixes

- **Config silently rewritten (3rd recurrence — now pinned for good)**: field forensics found `config.json` being rewritten with no one touching it (address_mode lan→auto, and zero logs on any write path, so the culprit was untraceable). Four defense lines this batch:
  1. **Write audit ring** — every real write (save / login / auto-relogin / import / self-heal restore) records its source + the shape change of key fields (secret values never logged); the last 20 entries are exposed via GET /config. Next time it recurs, the log names the culprit.
  2. **Concurrent-write protection (optimistic lock)** — if the config changes on disk after the page opened (another tab / manual edit / import / self-heal), saving returns 409 and the page explicitly prompts to refresh & re-save, instead of silently clobbering the newer value.
  3. **Defaults-overwrite guard** — when the main config file is corrupt and no backup exists (backend running on defaults), patch writes no longer persist full defaults over the corrupt file.
  4. **Load-state surfacing** — a top banner in Settings explicitly states "main config missing/corrupt, running on defaults / restored from backup", so defaults and saved config are never confused.
- **Worker tool toggle → QwenPaw host-native top toast**: success/failure of toggling a tool or its async-execution moves from an in-page banner to a host-level top toast (the same mechanism as the skill-install "top popup" — same-page mount reuses the host antd notification context); failure text matches the final state.
- **SGLang card "~15s per frame" root-caused & corrected**: upstream source archaeology + live measurement prove the server-side load snapshot publishes multiple frames per second while busy (and stays fresh while idle — the interval parameter is in decode iterations, not seconds). The real culprit of "one frame per 15s" is the plugin's own 15s idle tier. Slow tier 15s→5s (load recovers back to the 1s real-time tier within 5s), and the card subtitle is now "1s active / 5s idle + snapshot Ns ago" — a ticking age with an unchanged number = fresh data, just no change; a stalled age = real stall, visible at a glance.

### Changes

- Settings save requests now carry a config revision (backwards-compatible with older plugin versions)
- GET /config gains `config_rev` / `config_health` fields (diagnostics + the front-end banner's data source)

### Tests

- +13 backend cases (write audit / guard / optimistic lock / health state); pytest 345 all green; tsc 0; i18n 1416 keys 0 missing; 5 front-end smoke suites pass

---

## 0.5.0-beta.14.26 (2026-10-09 — field-feedback batch: in-room artifacts same-source/same-speed + console session auto-relogin + tool banner matches final state + SGLang cadence label)

**Four field-feedback items, each root-caused before fixing (no whack-a-mole): same endpoint with divergent strategies → unified cache layer; session expiry only flagged, never renewed → auto-relogin + transparent replay; banner branched on field not value → 4-branch pure function; misleading label → dual-cadence label**

- **In-room project files panel now same source & speed as the artifacts tab** — both panels hit the same `workflow?includeTasks` endpoint but used divergent fetch strategies: the tab lazy-loads with an in-component cache, while the in-room panel bare-fetched every project on each Drawer open with zero cache layer (re-fetching all on reopen). Fix: new `api.ts fetchProjectWorkflow` (`cachedRequest`, 30s TTL + tag `project:{pid}`) shared by both panels — zero duplicate upstream fetches within 30s, in-flight dedup; manual refresh invalidates explicitly via `invalidateTags` and always bypasses. Local `TaskDetail`/`WorkflowResponse` promoted to shared `WorkflowTaskDetail`/`WorkflowDetailResponse` (render code unchanged via alias).
- **Console session auto-relogin** — root cause: the Console admin session cookie has a server TTL, and the old code only passively flagged expiry with **no auto relogin**, forcing a manual re-verify after every plugin reload / session expiry — even though the admin credentials were already persisted in `config.json` (600 perms) and never used for automatic recovery. Fix: `router.console_try_relogin` (persisted credentials → Console `/session/login`, same endpoint/semantics as `/config/verify` path A); gateway passthrough 401 → auto-relogin + **transparent replay of the request** (callers see normal data, unaware). Storm guards: 60s cooldown / asyncio.Lock concurrent merge / 400-401-403 auth-reject stops immediately. New session persisted + expiry flag cleared. The "address mode reverted to auto" report was investigated: disk and API both intact (the front-end first-load failure window is covered since 14.16 by the three-state loading indicator + save gating).
- **Tool toggle banner matches the final state** — root cause: the success banner branched on field only, not value, so disabling a tool still showed "enabled" and enabling async execution showed "disabled" (cross-wired). Fix: 4-branch pure function `toolToggleMessage` (`util.ts`, smoke-testable) + 2 new i18n keys.
- **SGLang card refresh feel** — the chain verified bug-free (no cache on either side, 1s/15s adaptive cadence works); root cause was a **misleading label**: the card said "auto-refresh 1s" but the data source is SGLang's load snapshot published server-side every ~15s, so a frozen number for 14s read as a freeze — and manual refresh read the same snapshot. Fix: the sub-label now states both cadences ("Auto (1s/15s adaptive) · data snapshot ~15s") and the tooltip explains data cadence + the `--load-snapshot-publish-interval` tuning entry.

**Gates**: pytest 332/332 (+5 F2 tests: transparent retry / auth-reject stays flagged / no-creds no-attempt / cooldown suppression / concurrent merge) / tsc 0 / i18n 1,411 keys 0 missing-dup / 4 smoke suites green (+4 toolToggle assertions) / sensitive scan 0.

## 0.5.0-beta.14.25 (2026-10-09 — tech-debt batch: router domain split + time-formatting convergence + test coverage)

**P0 tech-debt closure — the 6,833-line router single function split into 9 domain routers with zero behavior change; time formatting converged into 5 pure helpers; two zero-test modules gain 42 cases**

- **build_router split by domain** (router.py 6,833 → 997 lines): a full-stack audit flagged `build_router` as a 5,719-line single function (~50 nested handlers capturing function-local state) — the main cost of every subsequent backend change. It is now 9 sub-router modules under `agentteams_connector/routers/` (status / teams / config / gateway / matrix / kb / live / approval, the latter carrying the trailing catch-all proxy and assembled last); `build_router` is pure assembly. Mutable shared state (3 KB caches) is created by the assembler and passed explicitly — no module-level mutable globals. Zero behavior change guaranteed: handler bodies moved verbatim (only closure references became explicit parameters); route registration order identical to before (53-route table diffed entry by entry, including order — zero difference); full test suite 285 → 327, all green (+42 new).
- **Time-formatting convergence** (10 sites → 5 pure helpers): `util.ts` gains `formatTimeOfDay` / `formatDateTime` / `formatTimeOfDayNo12` / `formatDateShort` / `formatTimeShort`; 10 hand-rolled `toLocale*` call sites across 6 components (6 different locale/option combinations) now route through them — each site's locale and options preserved exactly, rendered output byte-identical. `WorkerChats`' `formatTime` (Z-suffix UTC normalization + two-level fallback) is outside the helpers' expressive range and is kept as-is by convention.
- **Zero-test modules covered** (+42 cases): `spawn_tree` (4 pure functions; the file header claimed "unit-tested" with no test file existing) gains 38 table-driven cases — normalization 14 / session mapping 6 (incl. idempotency) / role inference 14 (priority chains such as lead over critic) / scenarios 4; `bg_aggregator` (the background tick scheduler shared by projects_workflow and worker_status, previously zero direct tests) gains 4 concurrency-semantics cases — single-flight no-reentry / TTL dedup + force bypass / no-loop silent skip / per-round exception swallowed with state reset.

**Gates**: pytest 327/327 (285 baseline + 42 new) / tsc 0 / i18n 1,409 keys 0 missing-dup-empty / sensitive scan 0 / route table 53/53 zero diff.

## 0.5.0-beta.14.24 (2026-10-08 — weak-deployment batch: partial-connection banner + embedded deployment docs)

**The "silent partial-connection" blind spot exposed on an embedded all-in-one standalone node (no host port mapping, no Matrix login) — Controller data normal while chat/notifications/task status are limited, with zero indication on the home page before**

- **Partial-connection info banner** (product blind-spot fix): on a deployment where the Controller is reachable (team/workflow/worker data all render) but Matrix is not signed in (chat, notifications, @-mentions, task status sync unavailable), the home page showed a mixed "Teams 0 rooms 0 unread + Worker 1 teams" with no hint why the chat side was empty. Now a dismissible info banner appears at the top (condition: `/auth-status` `matrix_token === "none"` while the controller is reachable), separating what works from what is limited, with a "Sign in" action to Settings. Sits alongside — and is mutually exclusive from — the existing "Matrix login expired (error)" and "Higress session expired (warning)" banners. Dismissal persists to localStorage (the auth-status poll re-fetches, so non-persisted dismissal would re-nag on every reopen).

- **Embedded all-in-one deployment docs** (Controller address entry): testing found the `agentteams-embedded` all-in-one image's Controller API (container port 8090) is **not mapped to a host port** — unlike the production layout (mapped to a host-chosen port such as 6866), so the plugin cannot probe it and the docs previously covered only the production layout. `docs/12-config` gains an "Embedded all-in-one deployment" section (EN+ZH): on the same host, take the controller container's bridge IP (`docker inspect`) and enter `http://<bridge-IP>:8090` (stable, survives restarts); across hosts the deployment must add a port mapping. Token retrieval is unchanged from production (in-container `docker exec`, port-independent).

## 0.5.0-beta.14.23 (2026-10-07 - 14.22 acceptance batch: credential-verify separation + PATCH proxy pass-through + KB WAN bulk-read compression + server-side prewarm)

**System fixes for the 14.22 acceptance feedback — Higress verify mis-reporting a token error, "modification failed: HTTP 405" on the tools write path, slow KB cold path on WAN**

- **Higress / Controller credential verification separated** (N1): `verify-admin` resolved the Controller token **before** the path branch — a token with illegal characters in config made a pure Higress credential check (path A, username/password) fail with a token error, coupling the two verifiers. Now token resolution lives **inside path B only**: path A verifies the Console credential, path B verifies the Controller token — each independent, a credential error in one no longer mis-reports the other.
- **Tools write path 405** (N3, latent since beta.12.3): the catch-all proxy's `methods` list lacked **PATCH** while the Controller tools endpoint is exactly `PATCH /workers/{name}/tools/{tool}` — both write entries (worker tools tab + resource panel) failed with `Method Not Allowed`. WAN direct-to-controller measured PUT 200 / PATCH 200 (upstream exonerated). Fix: PATCH added to the catch-all methods (body read with POST/PUT semantics); write paths (POST/PUT/PATCH/DELETE) now log a warning on any non-2xx (method + path + upstream status + body head 200B), so upstream method-table mismatches are visible at a glance.
- **KB WAN cold path: bulk-read compression + server-side prewarm** (N2, K1/K2): root cause measured — the WAN cold path is a single ≤1.8MB raw graph bulk-read (≈3–5s on 5M); the warm path SWR is 8ms. (K1) the bulk-read script output is now a `===GZB1===` gzip+base64 envelope — the 1.8MB payload shrinks ~5× in transit; legacy responses (no magic prefix) pass through unchanged and a corrupt envelope safely falls back to the per-file path (frame protocol unchanged). (K2) after a `/kb/agents` response the server prewarms the last-agent's tree+graph in the background (silently skipped when missing / absent from the list / abnormal; single-flight), so a WAN "open knowledge base" usually hits a warm cache — complementing the existing client-side prewarm (14.18) and SWR caching.
- **Safety-net expansion (13 coverage points)**: D4 runtime pass-through A1–A7 (docker main + ctl fallback paths: `runtime` written only when non-empty, `runtimeDeprecated` only when truthy, legacy controller = key absent not null, malformed entries skipped safely, disk-cache passthrough, 401 wording, endpoint-level pass-through) and credential-guard B1–B6 (pre-save 400 naming the address position, type mismatch = same gap, explicit-clear 200 with on-disk downgrade, batch reject, `credential_check` per-position form str/basic/bearer). All test dial points are intercepted by a fake client — zero real HTTP.

---

## 0.5.0-beta.14.22 (2026-10-07 - 14.21 acceptance batch: SGLang activity signal + config/credential resilience + KB low-bandwidth adaptation + runtime notices (8 panels) + button alignment)

**System fixes for the 14.21 acceptance feedback — SGLang throughput-0 mislead, config/credential "saved but not effective", slow KB on WAN, non-QwenPaw runtime confusion, button look**

- **SGLang throughput-0 semantics + live activity signal**: `gen_throughput` is an upstream decode-window sample (SGLang zeroes it after 30s without decode) — the card could show `0.0 tok/s` while inference is actually running (KV still changing). Now the card self-samples `num_used_tokens` across consecutive polls and shows a green `●` "KV changed on last poll = inference running" dot; a `0` throughput renders as `—` with a tooltip explaining the decode-window sampling (0 ≠ idle). Two signals side by side (throughput = sample-window rate / activity = live occupancy change), no single misleading value.
- **Config "reverts to auto after install" + credential "saved but still 401"** (shared root cause closed): the install layer is proven clean (it never touches the secret dir, the ZIP has no config template, the config path is fixed). Two code-side gaps closed: **(A) silent credential downgrade** — when the user chose to override a credential (basic/bearer) but left it empty and no same-type old credential existed to inherit, the merge silently downgraded to a **credential-less string entry** (gateway 401 forever) while the save still reported success. Now a pre-save credential-intent check (`credential_gaps`) makes `PUT /config` return **400** naming the address position; a different type (basic↔bearer) = no field to inherit = same gap. **(B) config cold window** — a container swap / reinstall longer than the 15.5s retry chain left the whole page on **defaults** (mode=auto, empty password) that the user mistook for saved values. Now: post-failure low-frequency background self-recovery (10s × 6 = 60s), and the "change-to-persist" one-key PUTs (address mode / fx mode) are all gated while config is not yet loaded (a default `auto` can no longer overwrite a saved mode). A post-save read-back check (`credential_check`) returns the persisted per-position form (str/basic/bearer) for the four address families; the frontend reconciles it against form intent and warns on any mismatch.
- **Slow KB on WAN — SWR TTL adapts to the active network**: KB payloads are already small (~1MB total); the slowness was WAN RTT × round-trips (multiple cold fetches) + a fixed 60s SWR TTL unsuited to WAN. Now `kb_swr_ttl_for(address_mode)` (single point, 5 SWR consumers converged): WAN = **180s** (repeat KB visits within the window make zero background dials), LAN/auto = **60s** (freshness baseline). Config read goes through the `load_config` in-memory cache (zero disk); on error it falls back to the LAN value (TTL is not a security boundary).
- **Runtime notices (D4) — full 8-panel matrix**: for non-QwenPaw runtimes, QwenPaw-only features are now hidden/disabled **up front with an explanation**, killing the "dial fails → 400/502/blank" confusion. New shared predicate `isQwenpawOnlyDisabled` (empty/qwenpaw passes — legacy workers are not harmed) + a unified `RuntimeNotice` component. Panels: (1) running config — existing `spec.runtime=="qwenpaw"` gate + unified notice; (2) approval 4-levels — disabled card + notice (no dial); (3) channels — disabled tab + notice; (4) skill preload — disabled switch + notice (allocation-layer CRD view stays readable); (5) KB files — degraded empty state + notice (no file/graph dial); (6) worker chats — entry hidden; (7) execution timeline/checkpoints — disabled entry + notice (no dial); (8) legacy instances (`runtimeDeprecated`) — unified "Legacy · upgrade to QwenPaw" badge. The sole source of truth = controller API `spec.runtime` + `runtimeDeprecated` (older controllers omit the field = undefined, degrading to runtime-only judgment). The qwenpaw path has **zero behavior change** (regression gate).
- **Buttons aligned to the QwenPaw style**: host theme color already flows into every antd Button via `ConfigProvider`; the misaligned ones were 3 hand-written native `<button>`s (retry / search ×2 — pill radius 16 + custom hover, unlike the host's square buttons). Switched to antd Button (inherits theme tokens, structurally the same as the host).
- **Engineering hygiene**: code comments normalized — slang "shit-mountain" → formal "technical debt" (4 sites); commits formalized and sanitized (strict from this batch; no internal identifiers/credentials in commits).

---

## 0.5.0-beta.14.21 (2026-10-07 - 14.20 acceptance batch: progressive workflow landing + background foreground-yielding + token-verify resilience + inline action buttons unified)

**System fixes for the 14.20 acceptance feedback — workflow loading slow / contending with chat, Controller token verify 500, inline button look**

- **Workflow "slow to load" + "chat slows while it loads"** (low-bandwidth architecture fix): the `projects-workflow` aggregator waited for **all** 36+ projects before writing the snapshot (`asyncio.gather`) — on a 5M WAN link the first sweep took 1–3 minutes with the UI spinner idling; and the background sweep only checked foreground load once at round start, so a long round kept the shared dial gate (cap 24) and the same WAN uplink busy while the user switched to chat (room messages 0.8–2.5MB each). Now: the project list lands as soon as `/projects` returns (first screen waits one round trip only); each per-project `/workflow` result is written the moment it completes (progressive; the 15s frontend poll picks items up as they arrive; single-project failure keeps the old value; vanished projects are pruned at the end); and each dial backs off while foreground inflight > 8 (re-check every 0.5s, max 10s per item) — background scanning now politely yields to interactive foreground as a standing semantic.
- **Controller token verify HTTP 500** (misdiagnosis + resilience): LAN live address `GET /api/v1/teams` (Bearer JWT) = 200 <1s; the WAN path (Higress gateway → Controller) intermittently returns 500 = transient gateway/upstream error (**not a token problem**). Old code reported any non-200 as "token invalid" with a 3s timeout (tight for 5M WAN). Now: 5xx = transient → back off 1s and **retry once** on the same live address; 4xx = credential/permission (address-independent) → report "token invalid or credential error" immediately without retry; timeout/connection error = address-level → move to the next address; timeout 3s→5s (WAN live address <1s, headroom for jitter); and the **5xx body is surfaced**: "WAN/gateway anomaly (HTTP 500): <real body> — transient gateway or upstream error, not a token problem; retry later or check the WAN path".
- **Inline action buttons unified** (the "rushed look" cleanup): the inline "Download" / "View" actions on artifact tables, message file cards and project files were `type="text" size="small"` **icon-only** buttons (nearly invisible, no label), each written per component with its own font size / padding. New shared component `ActionBtn` (icon + text label + small bordered default, with href / download / onClick / authenticated blob-download support); artifact table (View + Download), message file card (Download + View) and project files (Download) now use the unified spec; the actions column width adapts to the text. **Reload icon-only buttons are kept** (universal convention + Tooltip, looks fine).

---

## 0.5.0-beta.14.20 (2026-10-07 - 14.19 acceptance batch: first-frame theme consistency + merged-graph race + slow-path system speedups + L2 gating)

**System fixes for all 8 items of the 14.19 acceptance feedback — each root-caused before the fix, no point patches**

- **Top version number showed 14.18 on a 14.19 install**: the 14.19 release commit missed the `frontend/package.json` bump; dist build injects `__PLUGIN_VERSION__` from it. Bumped (carrier `8aa2ff4`) and this version carries both (plugin.json + package.json).
- **KB "team merged graph" showed workers outside the selected team on first load (long-standing race, three-part)**: root cause (source-level; same family as the 14.18 agent-dropdown fix, different call site) — (1) `loadMerged` fired while team structure was still loading computed `agents=""`, and the backend's `agents`-absent semantics = **all agents**; (2) the SSE refreshTick effect had no teams-ready gate, so live-cluster SSE events raced the slow teams fetch on 5M WAN; (3) once the wrong response landed, the `!mergedGraph` guard blocked the corrected refetch forever — only a tab remount reset it. Fix (single invariant: displayed scope == selected team; empty-over-wrong per the 14.18 scopedAgents decision): empty-scope fetches are now impossible; `mergedForRef` (landed scope) + `mergedGenRef` (single-flight generation) make wrong-scope content self-heal and drop late stale responses; refreshTick refetches gated on teams-ready + throttled to 30s (the endpoint has a 30s SWR gate — per-tick refetches also forced full GraphCanvas relayout, a continuous "slow" feel). Cold first load = local per-worker KB graph compute (to_thread, semaphore 4 since 14.19); after that, 30s SWR + disk cache. The two fixable factors (wrong-graph refetch, per-tick relayout) are gone; the local cold-compute floor remains.
- **Save settings / connectivity test slow again (5M WAN)**: dead addresses cost timeout(4s) × retry = 8s one-way; reachable addresses are <1s and unaffected. Fix at the single choke point `_probe_with_retry`: **timeout-burn (≥80% of budget) = deterministic dead address → no retry** (the background adaptive retest picks up recovery; fast failures — refused/DNS — still retry, keeping the 14.12 transient semantics); default timeout 4→3s. Dead-address one-way cost 8s→3s (-63%); worst-case wall clock of the connectivity test 8.3s→~3s. 6 regression tests.
- **Controller-token verification "spinning forever"**: verify-admin path B probed in **config order** [LAN, WAN] at 8s each — on WAN the dead LAN burned ~8s before the live WAN answered. Fix: new `_ordered_ctl_urls` puts the **working-cache (last known reachable) address first**; per-address timeout 8→3s. Normal case answers <1s. 3 regression tests.
- **Address mode "reverts to auto every time" + basic auth re-entry**: the persistence chain was verified end-to-end on this machine (PUT → disk → read-back, including masked-credential positional merge: empty/`****` round-trip inherits the stored value — `merge_address_entries`). The symptom pattern (mode + password lost together = the whole PUT result lost) points outside the plugin (desktop container/volume lifecycle or a silent save failure). The plugin cannot inspect the host volume, so it now self-verifies on screen: a persistence health line next to the save button — "last persisted HH:MM:SS" (config-file mtime, returned by the backend since 14.12 but previously never consumed by the frontend) + directory writability (orange alert when not writable) + absolute config path on hover. Export/import config (14.14) remains the one-click backup/restore path. Reading guide in the acceptance doc.
- **Theme consistency ("every component loads its theme color at a different time")**: the host theme has two supply chains — CSS variables (written to :root at host page load, **present at first frame**) and the `/config/theme` network endpoint (round-trip delay). CSS-var components were host-colored at first frame while antd-token components flashed the default orange first. Fix (single source of truth first): `syncHostTheme()` reads the :root CSS variables **synchronously** at first render (module-level snapshot; they only change on full host page reload) to build the antd token theme; `useHostTheme()` initializes from it (**host color at first frame, zero flash**), with the network fetch demoted to detail-filling (radius etc.) and old-host fallback. CSS-var accent wins; fetch details merge in.
- **Higress 503 orange detail overflowed its row**: the `ConnRow` detail span was `flexShrink: 0` with no overflow control — long diagnostics pushed the row out of its container. Fix: shrinkable + ellipsis, full text in the hover title (same treatment as the URL span in the same row).
- **Model page hidden from L2**: L2 users (no Controller token) can never make the model page's requests succeed — the entry shouldn't exist. Fix: sidebar tab buttons + rc-tabs items both filter on `hasCtlToken`; a fallback effect returns L2 users with a remembered `models` tab to home after config is ready (not judged before config ready, to avoid kicking L1 users during the async config window; the 14.13 hasCtlToken false→true flip semantics are unchanged).
- **Mechanical convergence batch (QC T184, same package)**: time formatting ×3 → `util.formatChatTime` (7 call sites); byte humanize ×3 → `util.formatSize`; clipboard snippets ×5 → `util.copyText` (callback form, zero new i18n entries); WorkerChats 4s poller gated on tab-active (stops when hidden); net -43 lines. A TS 5.9.3 TS2774 compiler false positive (truthy function-reference check + plain call in the branch body) is guarded with `typeof` (minimal repro matrix in the QC report).

**Gates**: tsc 0 / poller smoke 8 asserts / i18n 1395 keys 0 missing 0 dup / pytest 211 (+6 new regressions)

## 0.5.0-beta.14.19 (2026-10-07 - login-state observability + credential scheme decision + SGLang adaptive cadence + frontend/backend deep-optimization)

**14.18 acceptance batch: credential lifecycle observability & final scheme decision / SGLang load-card refresh regression system-fixed (adaptive cadence) / message-approval-workflow P0 batch / frontend + backend perf deep-optimization / dead-code governance closeout**

- **Login-state observability (industry pattern: browser 401 re-prompt / Matrix token-invalidation re-auth flow)**: silent credential death is gone — 401/expired-token detection drives a dismissible top banner with a one-click jump to login; new public diagnostic endpoint `/api/agentteams-proxy/auth-status` (`{authenticated, mode, detail}`) for one-curl triage. Session (Higress console_session, process/cookie-scoped, dies on restart) and credential (basic auth, persisted) layers are now displayed and invalidated separately — the industry session/credential separation.
- **Credential scheme decision (deep industry research, decided)**: OS-native keystores (macOS Keychain / Windows Credential Manager / Linux Secret Service) are the industry first choice but **unreachable** for a plugin (the host API surface exposes React/antd/fetch/getApiToken only — no keystore bridge, verified in source). The industry-recognized fallback — config file with **strict 0600 permissions** — is exactly the current implementation (local container volume, never synced off-machine). Per-address credential scoping, masked display with "empty = keep", and 401-triggered re-authentication are all aligned with browser/Matrix practice. Deliberate non-decision: no WebCrypto encryption (the key has nowhere to live — same file makes it theater; a user passphrase is an anti-pattern for an ops plugin). If the host ever exposes a secret-storage API, migration is a single read/write choke point.
- **SGLang load-card refresh regression, system-fixed**: acceptance reported "the SGLang card barely refreshes now". Two stacked causes: (1) the 14.17 blanket 1s→5s constant cadence (bought bandwidth, killed gauge liveness); (2) the initial 14.19 diff gate tied "updated at" to last-*change* time, so idle clusters made the card look dead. System fix following the industry monitoring pattern (Prometheus adaptive scrape / nvidia-smi active sampling): **adaptive cadence** — data fingerprint changing (inference running) → **1s fast tier** (restores the 1s-era real-time feel); two consecutive stable cycles (idle) → **15s slow tier** (idle load data carries no information; saves the 5M line). Fingerprint = normalized JSON with the per-fetch server clock stripped. "Updated at" now means **last check time** (proof of liveness, ticks every check even when values are unchanged). Mechanism: `createPoller` gains a dynamic-interval (getter) mode, read every tick; smoke test P8 covers the tier switch. Verified by live dialing `/sglang/loads` (0.44s/round-trip; values vary per fetch while active; stable when idle).
- **Message/approval/workflow P0 batch**: message render window capped at 150 (long-session DOM cost bounded, scroll-back loading unchanged); approval queue single-point cache (multi-panel consumers share one poll); workflow double-poller merged; credential-override empty-value semantics unified across forms (empty = keep).
- **Frontend perf deep batch**: last raw `setInterval` (WorkerChannels) migrated to the unified `usePoller` system (tab-gated stop / visibility pause / catch-up / failure backoff / jitter); theme object memoized (was rebuilt per render); field-wise comparison reuse (identical payloads no longer re-render); `groupTurns` regroup memoized (result-only rounds no longer O(n) per tick); 300ms merge window on refreshTick (whole-cluster refresh debounce); 500ms merge window across the 5 SSE event classes; reconnect scheduling visibility-aware; `WorkerRuntimeConfig` split into `runtimeCfg/` (CfgRow / GateParam / GateSection / helpers; monolith −325 lines).
- **Backend perf batch**: KB tar parsing moved off the event loop (`to_thread`); `load_config` read cache (dedupes the hot read path); `BgTicker` skeleton unified (projects_workflow switch complete, tick lifecycle consolidated).
- **Dead-code + exemption governance**: dead-code cleanup batch (net −327 lines, 67 exports stripped); after two false-positive deletions of pre-embedded interfaces, **`PREEMBED-EXEMPT.md`** now ships as the machine-readable exemption list (mandatory pre-flight check for any dead-code audit task; `【预埋，勿删】` markers double-written with the list).

---

## 0.5.0-beta.14.18 (2026-10-06 - live host-theme follow + external credential coverage + auth semantics + KB first-paint)

**14.17 acceptance batch: host-theme alignment (~99 hardcoded accent literals → CSS variables, consistent after one reload) / external-path 401 root-fixed (per-address credential coverage 100%) / auth-card semantic split / KB first-paint race fix**

- **Host theme alignment (acceptance: "much of the plugin doesn't follow the QwenPaw theme color"; observation: "the QwenPaw host itself only updates on page reload, not live")**: true root cause — ~99 accent-family literals were hardcoded across the plugin (hex / gradients / tints), so even a page reload left those surfaces on the old color. All of them now reference `var(--app-accent, #FF7F16)` with fallback (hosts without the variables behave unchanged); transparent tints use `color-mix()` (the old `` `${PRIMARY}14` `` hex-alpha concatenation would have produced invalid CSS under a var() value). **Alignment semantics (decided against live-follow):** the plugin reads the host theme once per page load and does not poll or observe — when the host only applies a theme change on reload (the observed behavior of the field instance), live-follow would repaint the plugin *before* the host, producing a plugin/host color mismatch (worse than not following). On reload, the host's App.tsx writes the effective theme to `:root` CSS variables (verified in 2.2.2b4 source, `--app-accent` etc.) and the plugin remounts inheriting the new color — zero JS re-render, zero polling. Intentionally untouched: semantic colors, status lights, categorical palettes (roles/agents/categories — recoloring would collide), canvas/3D and SVG-attribute contexts (var() unsupported there), antd Tag presets.
- **External-path credential coverage completed (acceptance: "runtime log HTTP 502: Docker API 401")**: the `docker-logs`, approval-exec and joined-rooms scan dial points were missed by the beta.14.3 per-address credential fix — in fixed wan mode only a Bearer token was sent, so the public gateway's Basic gate rejected with 401. All 18+ dial points (controller/matrix/sglang/gateway) now uniformly go through `_headers_for` (per-address override credential when configured, native Bearer otherwise). Measured: external controller path with basic-only credentials → 200 (was 401); internal Bearer path unchanged. Higress probe 5xx detail now points at the tunnel/backend direction (external console addresses are tunnel-exposed; 503 = tunnel up, backend transiently down).
- **Settings auth semantics split (acceptance: "Higress auth and controller-token auth should be separate" / "is Matrix login redundant or conflicting with the auth card?" / "what credential does SGLang need?")**: inside the auth card the two credential blocks are now visually independent — ① Controller auth (admin plane: CRD / full view / logs) and ② Higress Console auth (model plane: alias / providers / routes), each with its system attribution and "unrelated, independently configurable" note. The Matrix-login option gets a one-line relation note (it is the AgentTeams messaging-system account — the same account as the Matrix address above, L2 read-only — and is a different thing from the QwenPaw page login). The SGLang credential row is annotated (local inference services have no auth of their own; fill only when the address is behind a public gateway Basic gate). The Ops panel's "model gateway routes" card is removed — the Models tab already carries the superset gateway-configuration view.
- **KB first-paint race fixed (acceptance: "the KB is sysdev-team, but at first it shows daily-* etc. — only after switching tabs does it show correctly")**: while the remote probe was in flight the default branch rendered the local-host-agent view (the flashed local list). Now probing renders a loading state; the terminal (remote/local) view appears only after the probe resolves. Copy corrected to match real permissions (L1 admin sees all teams, L2 sees own team).
- **Performance / scheduling full test (14.18 batch)**: 45s idle steady state **+8 dials / +8.4KB** (14.17 baseline +44 dials; criteria <50/<50KB met); inflight peak 13 / cap 24; approval-scan joined_rooms 30s TTL cache shows zero steady-state increment; `/workers/*/chats` at 4s is the active refresh of the open session panel (stops when the panel closes — not a leak). Gates: pytest 194/194, tsc 0, i18n 1384 keys 0 missing 0 dup, sensitive scan 0, dist 2,372.58kB.

## 0.5.0-beta.14.17 (2026-10-06 - credential memory + Higress conn-test + KB cold-start root fix + low-bandwidth perf batch 4)

**Per-system credential memory / Higress connectivity coverage / knowledge-base cold load root fix (cold: -64% to -78% measured) /  full-audit perf landing (steady-state dial-down, 45s baseline <50)**

- **Credential memory redone ( — acceptance: "after typing the Higress account, the controller basic auth asks again")**: root-caused at source level — (1) the masked `***` literal was echoed into the password field, so typing without clearing concatenated over the real credential; (2) the backfill effect depended on the config reference, so any validate/save/login config refresh wiped the unsaved form draft; (3) controller_token had the same literal-echo issue. Now: **empty field = keep unchanged** (secret fields are never pre-filled; a `***` placeholder is sent and the backend merge inherits the stored value; placeholder hint "saved — leave empty to keep"), **explicit clear = switch type back to "service auth"** (the old "type chosen but password empty = plain URL" silently wiped stored credentials — retired), **backfill frozen** (initialized once on first load / account switch; later config reference changes never reset the form). New six-system credential status overview card (Matrix login / controller token / controller address credentials / Higress console session / Higress address credentials / SGLang address credentials — green/gray at a glance). Zero backend changes (existing merge semantics already self-consistent; browser-verified that main save does not clobber auth).
- **Connectivity test covers Higress ( — acceptance: "the connectivity test should also test Higress")**: `_probe_gateway` checks reachability (GET /) + **session tri-state** (GET /v1/ai/routes: 200 = valid / 401|403 = expired, re-auth needed / 404 = not supported by this version). The four address classes (matrix/controller/sglang/**gateway**) now run fully parallel at the same level — total = slowest single address. Frontend: Higress row (detail = session state even when ok) + **both Higress dual addresses get credential editors** (the four address classes are credential-isomorphic; used when the public entry sits behind a Basic/key gate, persisted on save). Diagnostics semantics: not part of auto-reorder (the effective Higress address is selected by verify); background refresh without it = zero extra cost.
- **Knowledge-base cold load root-fixed (K batch — acceptance: "can the knowledge base load faster")**: true root cause (measured): cold tree 13.8-15.1s / graph 12.1s / merged 40.7s — driven by **HTTP round-trip count** (not bandwidth; KB data is local, payloads are KB-scale): graph compute read each md file individually (N requests), tree used 4-10 probes, merged had no cache.
  - **K1 batch read**: `GET /kb/{agent}/files-batch` — one exec, framed bulk read (`===FRAME:<size>:<path>` deterministic boundaries; embedded marker strings in content cannot desync the framing)
  - **K2 tree merged probe**: top/memory/digest + six profile files in one exec (`###SECTION:` segments); the original dual-channel logic is kept verbatim as the channel-down fallback
  - **K3 merged cache**: 30s TTL + single-flight (key = agent set)
  - **K5 file cache**: 30s TTL (text; the binary branch is never cached to prevent amplification)
  - **Cold measured** (deploy, kb-cache cleared, first call): tree 13.8-15.1s → **4.9-5.2s (-64%)**, graph 12.1s → **2.64s (-78%)**; second call tree 5.8ms (disk cache) / graph 11.5ms / merged 8.3ms (memory hit — K3 proven)
- **Low-bandwidth perf batch 4 (P batch —  read-only full audit landing, ad-hoc patching-proof edition)**: after the  audit (15 findings across endpoint caching / component rendering / 45s dial budget / dead code), every item was re-verified before coding — 2 of 3 P0s were downgraded/re-judged on evidence (see the re-judgment table); everything landed below has a proven root cause:
  - **/v1/loads polling 1s → 5s** (HomePage + OpsPanel, fast/slow tiers merged): the largest controllable frontend frequency (120 calls/36min → ~30); a 5s refresh still reads as "live" for a load gauge
  - **approvals/@ bootstrap scan cache 10s → 30s** (`_BOOTSTRAP_SCAN_TTL`): 10s TTL vs 15s polling = a guaranteed miss (full-room scan every poll); 30s = half hit (steady-state full-room scans 4.5 → ~1.5 /45s). **Zero real-time cost** — new approvals/@ go through the sync_watcher event buffer (zero latency); the TTL only governs how often history from the plugin-down window is re-harvested
  - **messagesCache FIFO → true LRU**: read-hit refreshes recency, so hot rooms are no longer evicted for "inserted early" (13.10 full-history semantics untouched)
  - **media objectURL module-level cache + de-dup** (same pattern as avatars): room switches / scroll remounts no longer re-fetch each blob (cap 300; beyond that fetch-but-don't-cache)
  - **member messages page cap 10 → 5**: limit ≤ 20 scattered beyond 500 events = the member is effectively silent; saves the worst case of 5 x ~250KB upstream dials
  - **i18n gate codified** (`scripts/i18n-gate.mjs`): 0 missing / 0 duplicate, with a lookbehind to exclude `setStr`-suffix false positives (previously hand-rolled inline every release)
  - Audit re-judgment table ( verdict vs verified final — evidence):  "member/messages payload not slimmed" → **re-judged: the response is already projected** (event_id/sender/body[:600]/ts), the 27.3MB is upstream /messages paging (user-triggered, non-steady); only the page cap landed.  "backend 1s single-flight cache" → **downgraded, not done**: with the frontend at 5s, the concurrent cold-fetch scenario is largely gone, single-flight benefit ≈ 0. Long-room list "P1 rendering (no virtualization)" → **P2 deferred**: measured 30 pages (~550-1550 messages) snapshot 1.2 → 1.8s, linear with no knee; real usage ceiling ≈ 1000 messages; virtualization would collide with the loadMore-anchoring / nearBottom / thread-expansion minefield (five regression rounds in 13.14-13.19). Dead code "fetchTeamsRooms / sendInboxNotify" → **kept, zero deletions**: both carry explicit do-not-delete/pre-embedded code annotations (troubleshooting tooling / artifact-notification placeholder), which outrank audit "candidate" labels.

## Verification

- pytest **194/194** (188 existing + 6 new KBBATCH) / tsc 0 / i18n 1378 keys 0 missing 0 duplicate (codified gate)
- 45s dial baseline +47 (criterion <50 passed; 14.6 acceptance was +127)
- secret scan 0
- KB cold comparison table: filled in (tree -64% / graph -78% / merged ms-level on memory hit)

---

## 0.5.0-beta.14.16 (2026-10-06 - acceptance round 4 + deep audit · six fixes)

**Config-memory root fix / settings cleanup / L2 gating / faster connectivity test / poller bug fix / god-file slimming**

- **Config memory root-caused (acceptance )**: "address mode / credentials
  not remembered" had two root causes, both fixed — (1) the first GET /config
  failure was silently swallowed with zero retry (hit during the plugin
  reload window or WAN flaps) → now 3 backoff retries (1.5/4/10s) + a
  in-progress lock; (2) the first load (null→payload) landed via a low-priority
  transition that high-priority update waves could starve, so React state was
  never filled → first load now commits at high priority, transitions stay for
  silent refreshes. Config load state is now three-valued
  (loading/ready/failed) with a visible banner (incl. "showing defaults —
  don't save as-is, it would overwrite" + retry) and the save button disabled
  until config is ready. E2E: real values backfilled; saving without changes
  no longer overwrites disk values.
- **Host-agent skills block removed from Settings **: the SkillsTab
  component (468 lines) and its 16 i18n keys are gone; persisted "skills"
  tab state migrates to Home. The SkillCenter team skill pool is unaffected.
- **L1-only sections hidden in L2 login mode **: the Higress Console
  address card and the SGLang "cluster load" card (previously marked
  L1-only in comments but always rendered) are now gated on login mode;
  L2 hides them, saved values persist.
- **Connectivity test sped up **: the three address classes
  (matrix/controller/sglang) ran as three serial awaits (each eating full
  timeout+retry ≈12.5s on WAN, ≈37.5s total) → now fully parallel
  (total = slowest single address, ≈8.3s); default timeout 6→4s. Per-address
  semantics/credentials/retries unchanged; 3 regression tests.
- **usePoller catch-up inactive gate (deep-audit real bug)**: when the window
  was hidden and the user switched tabs in the meantime, a visibility-restore
  catch-up could still fire a redundant fetch on the now-inactive poller.
  onVisibility now checks isActive first (inactive pollers only resume the
  scheduling chain, never run fn) + smoke assertion P7.
- **God-file slimming step 1 (deep audit)**: SettingsTab extracted from
  WorkbenchPage.tsx into its own module (4813→3200 lines; the 1430-line body
  block is byte-identical to the parent commit); 57 verifiably orphaned i18n
  DICT keys dropped (full-tree literal-occurrence method; dynamic tr
  scenarios all preserved). Pure structural change, zero behavior change.
- **Full self-install verification**: 11 tabs walked green (no UI errors);
  45s dial delta **+47** (vs 14.6 peak baseline +466/45s, −90%);
  responsiveness n=89 median 5ms / max 20ms; config file 600; pytest 183/183.

## 0.5.0-beta.14.15 (2026-10-06 - full self-verification + second debt audit · two fixes)

**PawApp entry dead-link fix / dead-code cleanup / full ZIP self-install verification**

- **PawApp entry dead-link fixed**: the web console's PawApp loader gates on `plugin_type`
  (`expectedType="app"`); this plugin's manifest carries `meta.tools` -> type inferred as
  TOOL -> opening `/apps/agentteams-qwenpaw-workbench` directly fails with "PawApp frontend
  plugin not found" (reproduced on 2.2.2b4, retry ineffective). `meta.pawapp.entry_page` now
  points at the mode-agnostic `/plugin/agentteams-qwenpaw-workbench` route; the `/apps/` route
  is kept for the desktop PawApp host. Entry docs in index.tsx note the divergence.
- **Dead-code cleanup (second audit)**: removed zero-reference export `fetchWorkerLoopStatus`
  (chat_id variant - consumer moved to `fetchWorkerLoopStatusBySession` since v13.6);
  `sendInboxNotify` re-verified as intentionally kept (comment says "reserved, do not delete" -
  future notification trigger entry point).
- **Full 14.14 self-install self-test (fresh install from ZIP, 生产部署)**: all 11 tabs
  walked green (home/chat/notify/workflow/artifacts/teams/KB/selfcheck/ops/models/config, no
  console errors); 45s dial delta steady-state +15 / with UI open +42 (criterion <50, headroom
  = worker-chats avatar-dot 30s poll + sync); response max 16ms; KB SWR cache 6ms hit;
  aggregate endpoints serving 29 workers / 36 projects; persistence readback + 600 perms +
  zero plugin ERRORs in install window; pytest 180/180; installed dist byte-identical to repo.
- Gates: tsc 0 · build ✓ · pytest 180/180 · i18n 1442 keys, 0 missing / 0 dup.

## 0.5.0-beta.14.14 (2026-10-06 - acceptance feedback batch 3 · five fixes)

**Cross-page effects tier / config backup+export-import / KB first-visit drag smooth / tab-click marginal CPU -83% / streaming render memo**

- **Effects tier now applies on ALL console pages **: the tier sync previously lived only in the workbench page - other pages stayed 'light' (effects ran even with config=off) - the true root cause of "the control has no effect". Plugin boot now fetches config and applies globally (measured: off = 0 animations / 0 blur on /chat and plugin pages; light keeps animations + 6px blur).
- **Config backup + self-heal + export/import **: atomic config.bak.json on save; auto-restore when primary is missing/corrupt; settings now has Backup & Restore - export the full config incl. credentials (copy), import to restore (auto-backups first, rejects masked exports). Export once, never re-enter again.
- **KB first-visit drag jank root-fix **: dist-level cause = the force engine ticks for 160 FRAMES after data load (~2.7s where physics competes with drag in-frame) - the exact "laggy at first, smooth later" mechanism. Fix = pre-settle before first frame (warmup + alphaMin tuning): engine-stop 3390->875ms, drag-window physics 0.7->0.00;  pause/resume semantics intact.
- **Tab-click marginal CPU -83% **: useTabActive boolean snapshots x4 panels (no full re-render on other-tab switches) + minPokeMs poke throttle + 2 panel memos. Measured marginal 259->45ms/click (heavy sequence); remaining ~50% baseline isolated to the host app (upstream topic).
- **Streaming render memo **: MdText/InlineMd memo, workerSessionState value-equality, RoomChat subcomponent memo - completed rows skip re-parse during streaming.
- Gates: tsc 0, build, pytest 180/180, i18n 1442 keys clean.

## 0.5.0-beta.14.13 (2026-10-05 - code-debt audit batch)

**Full plugin code-debt audit + cleanup: tracking surface / client dedupe / quantified backlog**

- **KB switch-away jank root-fix **: 3D graph freeze-on-leave/resume-on-show + resume-race fix (revisit first frame 1.2-2s -> 128-438ms); team polling gated by activeRef; 6 refresh setStates in startTransition. Measured: KB->home max frame gap 66.7->16.8ms flat; leave GL draws 2983->0/s; switch CPU busy 71%->29%; workflow ghost-band root-caused + 2 style fixes.

- **Tracking surface**: accidentally tracked harness build artifacts (bundle-1323/1324.js, esbuild-reproducible) untracked + ignored (ZIP ~1MB slimmer); .gitignore policy completed; root ZIP/archive/version-residue scans all clean; zero console.log/FIXME leftovers.
- **Code**: duplicated ordered-failover logic (router._ctl_json vs worker_status._ctl_get) consolidated into a single `ctl_client.ctl_json` (old names kept as thin wrappers; zero call-site changes).
- **Record**: state/plugin-audit-20261005.md (findings + dispositions + quantified backlog: router.py 5,892 lines/133 defs, god components, next candidates).
- Gates: pytest 170/170, tsc 0, i18n 1430.

## 0.5.0-beta.14.12 (2026-10-05 - usability batch)

**Fast save / background yielding / workflow first-load fix / effects tiers (light default) / persistence hardening + diagnostics**

- **Save speedup**: PUT /config no longer runs address probing synchronously - measured 4829ms -> sub-second; save errors surface with detail; connectivity test keeps real probe time but no longer blocks saves.
- **Background yielding (bg_slot)**: worker-status / projects-workflow / KB refreshes share one background channel (single-flight + yield when foreground busy + 90s timeout) - periodic sweeps no longer saturate the dial gate (peak=cap=24 observed) and queue foreground ops.
- **Workflow first-load state machine**: empty cold snapshot -> "first aggregation in progress (auto-refreshing)" + 3s auto-retry (<=180s), manual refresh passes ?refresh=1 to bypass TTL.
- **Console effects tiers (new, light default)**: light = keep animations (orbit keeps spinning) + cap glass blur radius at 6px (cost scales ~r2, ~10x cheaper) + pin ambient static; off = stop everything (most power-saving); full = upstream as-is. Dropdown in settings, saved on change.
- **Persistence hardening + diagnostics**: config write is re-read and verified (mismatch raises); GET /config gains configPath/configSavedAt/configWritable; /debug/tasks dumps asyncio task inventory for CPU-loop hunting.
- Also: fixed a half-migrated CSS attribute path from the parallel workstream (fxMode refill/save completed).
- Gates: pytest 168/168, tsc 0, build ok, i18n 1430 keys.

## 0.5.0-beta.14.11 (2026-10-05 - acceptance feedback batch 2)

**Auto-save address mode / KB team-scoped agents / KB change-detection refresh / blur calm / RunningGlow regression fix**

- **Address mode auto-save**: switching Auto/Fixed-LAN/Fixed-WAN persists immediately (previously save-button-only - users saw it revert to auto). Verified: UI switch -> config = wan without pressing save.
- **KB conditional revalidation**: the 60s background refresh now runs a cheap probe first (directory entry metadata only, no file reads) - unchanged signature = clock reset only (zero deep scan); changed = deep scan. Steady state = refresh-only-when-changed.
- **KB team scoping**: with an aggregate team selected, the agent dropdown lists only that team's workers; out-of-scope current agent collapses to the team's leader/first.
- **Console blur calm (extended)**: 17 backdrop-filter glass layers (sticky group header, floating sidebar, headers...) disabled in calm mode - measured console blur elements 17+ -> 0.
- **Regression fix**: 's calm-block rewrite dropped the ' *' descendant selector (the orbit animation lives on a classless span); restored, animations back to 0 per page.
- Gates: pytest 155/155, tsc 0, i18n 1423 keys.

## 0.5.0-beta.14.10 (2026-10-05 - acceptance feedback batch)

**Five fixes: credential memory / KB instant open (SWR) / newest-first logs / tab jank (memo+transition) / calm confirmed**

- **Address credential memory**: config refill only restored URLs before - basic/bearer selection and credentials were lost (user had to re-select + re-enter). Now refilled via `entryToAuthDraft` (password echoed as *** masked; save = keep existing).
- **KB instant open (SWR)**: cold container reads took 3-17s -> persistent disk cache + stale-while-revalidate: measured **8ms instant serve** (cached/age flags) + background single-flight refresh + startup prewarm of the last agent; survives restarts.
- **Component logs**: newest first.
- **Tab jank**: panel-level `React.memo` (previously zero memo anywhere; every update reconciled 36K lines) + `startTransition` on switches (baseline stalls 183-200ms addressed; chat switch max 183->50ms).
- **Console calm**: user confirmed effective (kept).

## 0.5.0-beta.14.9 (2026-10-05 - fan-out convergence batch)

**Controller request fan-out governance (T9/): status lights 25 req/30s -> 1; project workflows 36 reqs -> 1**

- **Worker status aggregation (T9)**: connector-side background 30s single-point sweep (29 workers aggregated cache + single-flight + keep-last), frontend now calls `/workers-status` only (was: per-worker /chats for all workers every 30s, duplicated per window). Measured: browser chats requests **25 -> 0**.
- **Projects-workflow aggregation **: connector aggregate `/projects-workflow` (36 projects' workflows + project list; cache/background refresh/gate), assembly logic stays in the frontend with legacy fallback. Measured: browser per-project workflow requests **36 -> 0** (single endpoint, 1 request).
- **Home artifacts deferral tweak**: 4s + skip when hidden.
- (14.8 content folded in: console effects calm, 3D graph sleep, incremental scans, elegant tab switching, Higress regrouping - see below.)

## 0.5.0-beta.14.8 (2026-10-05 - performance deep-fix batch)

**Measurement-driven fixes: console effects calm (GPU) / 3D graph sleep / incremental scans everywhere / elegant tab switching / Higress address regrouping**

- **Console effects calm (new setting, default on)**: the upstream RunningGlow ring (437x744 conic-gradient spinning 4s forever - sampled continuous rotation) and breathe layer are frozen into static visuals; toggleable in settings. Measured: persistent animations per console page **2 -> 0**.
- **3D knowledge graph sleep**: rendering paused when hidden/switched away (`pauseAnimation` gated by IntersectionObserver + visibility), measured hidden draw calls **2340 -> 0/s**, auto-resume on return.
- **Full scans -> incremental**: mentions/approvals/workflow/artifacts scans now skip rooms with no sync-probe advance (600s full-pass fallback); artifacts cold ~37s -> **incremental 3.9s (-95%)**; home artifacts card fetch deferred.
- **Elegant tab switching**: light pane transition (transform/opacity only, 170ms); no skeleton flash on revisits; KB switch **~2.1s -> ~1.2s**.
- **Higress address regrouping**: dual Console addresses live in the address section (with Matrix/Controller/SGLang); fixed LAN/WAN address mode now covers Higress.
- Also includes the full 14.7 line (credential file perms 600, initial sync -65%, zero message re-fetch, name caches - see below).

## 0.5.0-beta.14.7 (2026-10-04/05 - night batch)

**Low-bandwidth perf batch 3 + security hardening + Higress dual addresses — zero message re-fetch / sync payload -65% / per-path byte metering / credential file hardening**

- **Message plane zero re-fetch (T3+T4b)**: (1) the "recent activity" card now derives from server-provided room summaries (last_body/last_sender/last_ts) - the per-room full-refetch effect is deleted (measured: 45s +466 dials ~10/s before); (2) room_message SSE frames carry a minimal payload - plain text messages merge directly (zero re-fetch in the active room); complex messages keep the 600ms coalesced fetch fallback; (3) optimistic local echo on send (pre-existing, kept).
- **Transport bandwidth slimming (T4)**: (1) sync payload: timeline 10->2 + type allowlist - measured initial sync 1426KB -> 505KB (-65%); (2) /messages filtering at the proxy layer + internal sites - 5.2KB -> 1KB per page; (3) KB tree/graph server-side TTL caches (30s/60s) - repeat views read zero container archives (a single graph build used to do 381 archive reads file-by-file).
- **Observability (.1)**: dial counters now include byte metering (total + per-path bytes, top 100).
- **Security (T5a)**: config.json (plaintext credentials, was 644) -> 600 on save + 700 dir; persistence regression tests for address_mode and address-level credentials.
- **Higress dual LAN/WAN addresses (T5b)**: gateway_admin_urls list (legacy migrates, mirrors urls[0]); verify/passthrough fail over in order; dual inputs in settings.
- **Test engineering**: conftest auto-clears module-level caches; nightly tool tools/plugin-selftest.py.

**Verification**: pytest 135/135 · tsc 0 · node smokes 15 asserts · initial sync measured 505KB · 45s dial-delta baseline (14.6 idle: +127 -> 14.7: filled by the nightly run)

## 0.5.0-beta.14.6 (2026-10-04 - sub-release)

**Performance batch 2 ( systemic fixes) — request-surface convergence / poller scheduling / dial gate / failover policy layering, guarded against regressions**

- ** unified request cache** (`frontend/src/requestCache.ts`): TTL + in-flight dedupe (same-key concurrent calls collapse into one) + tag invalidation + LRU (cap 300) + force bypass; 15 read-mostly endpoints wired (teams/structure, admin, workflow, projects, gateway, skills, kb, sglang, artifacts, spawns); mutation paths (CRD/gateway/skills/lifecycle) invalidate by tag
- ** unified poller scheduler** (`usePoller`/`createPoller` + `tabActivity` single source): **17 poll sites migrated** — only fire when their tab is active and the page is visible (stops the moment you switch away), exponential backoff on failure, catch-up on resume, anti-sync jitter; covers the ops page's 1s cluster-load and log polls (WorkerChannels keeps its previously-gated raw interval)
- ** global dial gate** (`agentteams_connector/dial_gate.py`): **all 27 async dial sites go through `GatedAsyncClient`** (incl. the `_h.` alias form) + 7 sync dial sites wrapped by `sync_dial_slot` — "open every tab" concurrency no longer stacks (caps configurable: async 24 / sync 8 defaults)
- ** address-failover policy layering**: only address-level/transient errors (401/403/408/429/5xx/transport) fail over; **deterministic 4xx (404/409...) no longer retried across addresses** — kills the spawns-409 class of wasted round trips
- ** spawns fix**: `fetchWorkerSpawns` now passes `?team=` (disambiguates cross-team ids, no more 409) + 60s cache dedupes multiple callers
- ** cadence governance**: team-tab force refresh softened to stale-first (no force within 30s); cluster-load 1s poll gated by activity+visibility with adaptive slowdown on slow responses
- ** dial counters** (`GET /debug/dial-stats`): totals / in-flight / peak / top-20 paths — the reconciliation key for acceptance and troubleshooting
- **Regression guards**: 2 static tests (no bare `httpx.AsyncClient(`, sync sites must carry the slot)

**Verification**: pytest 124/124 · tsc 0 · node smokes 7+5 all green · build 2,359.90 kB (gzip 657.78 kB) · setInterval residual = 1 (pre-existing gated site) · secret scan 0 · commits `a449c2c` (backend) + `ee3d9f7` (frontend)

## 0.5.0-beta.14.5 (2026-10-04 - sub-release)

**Performance batch ( event-loop blocking +  serial round-trips +  poll backoff +  blocking DNS) — the plugin no longer freezes the host; slow endpoints 5–7× faster**

- ** all five bare blocking calls offloaded via `asyncio.to_thread`** (root cause of "opening a tab freezes the whole page"): `joined_rooms` in `/teams/rooms`, `create_dm` in `/dm`, `/login`, both `run_l2` call sites, and five sites in the L3/L4 self-check (including the **45s long-poll**) — measured event-loop stall **695ms → 21–49ms**
- ** serial round-trips → concurrent + TTL caches**: the full `approval/list` scan (≈31 containers, serial) now runs via `asyncio.gather` (concurrency capped at 12) with a 20s TTL cache (invalidated on all three `approval_set` write paths); measured **23.5s → 4.21s (cold) / instant (cache hit)**. `teams/rooms` fetches members + room name concurrently per room: **11.3s → 3.56s**
- ** docker-logs poll backoff**: after ≥3 consecutive failures the 15s poll backs off to 120s (auto-recovers to 15s); silent failures no longer clear the pane (last successful content is kept, with the "updated at" timestamp showing staleness)
- ** blocking-DNS fix in selfcheck**: `_resolve_ip_hint` gains a 60s TTL cache and `_attach`/`diagnose_target` are now offloaded via `to_thread`
- ** audit (no change)**: the "derive homeserver from user_id" trap is not present (all 18 homeserver resolutions go through `_pick_address/_ordered_addresses`)

**Verification**: pytest 116/116 (113 baseline + 3 new guard tests: concurrency / cache / failure tolerance) · tsc 0 · vite build single file ~2,356 kB (gzip ~656 kB, 0 imports) · i18n 1,417 keys, 0 missing 0 dup 0 empty · secret scan 0 · independent AST sweep for "direct blocking calls inside async" = 0 remaining · standalone measurements against the real WAN config with 31 containers: approval/list 4.21s / 0.00s cached, teams/rooms 3.56s, freeze probe 21–49ms

## 0.5.0-beta.14.4 (2026-10-04 - sub-release)

**Follow QwenPaw's theme color (2.2.2+) / model config edit & delete (aligned with the dashboard) / graceful degradation on Controller 5xx / settings page UI cleanup**

- **Follow QwenPaw's theme color (QwenPaw ≥2.2.2)**:
  1. **No more hard-coded orange** — the plugin's antd primary color (buttons / links / selection states and all derived tokens) now reads the host's effective theme (`GET /config/theme` via the host bridge, auth auto-injected). With the host on its default theme the look is unchanged (the default accent *is* `#FF7F16`); once the host's theme color is customized, the whole plugin follows (accent / accent_hover / accent_bg / border radius all mapped).
  2. **Dark mode follows independently** — the host's dark theme colors (`dark.accent` / `dark.accent_bg`) win in the plugin's dark mode; the "own bubble" background in chat is a tint derived from the primary color (8% alpha light / 18% dark) and follows it too.
  3. **Zero change on older hosts** — versions without the `/config/theme` endpoint (<2.2.2) fall back silently to the built-in default, pixel-identical to before.
- **Model config edit & delete (model gateway page, aligned with the dashboard's model management)**:
  1. **Per-row "Edit" for AI routes / LLM providers** — under the Console data source every row gains an Edit button; the dialog pre-fills from the Console's original record (upstreams + weights + model mappings / request-model predicates / auth & allowed consumers / type/protocol/url/mappings), saved via Higress Console `PUT /v1/ai/{routes,providers}/{name}` (same endpoints and semantics as the dashboard).
  2. **Per-row "Delete"** — Popconfirm double-check, same `DELETE` endpoints; success auto-refreshes the list.
  3. **Credential safety (same as the dashboard)** — when editing a provider, a blank token field keeps the existing credentials (not pre-filled, so a redacted echo is never written back); the name is locked in edit mode (the name lives in the URL path; rename is not supported).
  4. **Copy split by data source** — Console source = "create/edit/delete pass through the Console session (same endpoints as the dashboard)"; the Controller read-only catalog source shows a yellow "read-only now — enable editing/deletion after admin account verification (Console session)" (replacing the old wall-style "use Higress Console or the dashboard" note).
- **Graceful degradation on Controller 5xx (plugin-side UX fix for the "501 in the logs" seen in WAN acceptance)**: the model gateway page and the ops gateway-catalog card no longer print raw error noise when the Controller returns 5xx (501 = no gateway backend configured / 502 = Console unreachable, etc.) — they show an actionable hint ("check the Controller's gateway backend (Higress Console reachability and credentials) and retry") instead. Root-causing the server-side 501 is tracked separately (upstream issue).
- **Settings page UI cleanup**: the single long column is reorganized into **section cards** — "Chat Page" (split-view toggle + event-stream status) / "Access Addresses" (Matrix/Controller dual addresses + credentials + address mode + connectivity test) / "Authentication & Login" (Controller auth dual-mode + startup preferences) / "Cluster Load" (SGLang module) / "Config Migration & Diagnostics" / "Matrix Login" — each a card, with card background and border following the host theme; explanatory copy moved into i18n (bilingual); the save button gets its own row.

**Verification**: tsc 0 - vite build single file ~2,354 kB (gzip ~656 kB) - pytest 113/113 - i18n 1,417 keys, 0 missing 0 dup 0 empty - secret scan 0 (source + dist)

## 0.5.0-beta.14.3 (2026-10-04 - sub-release)

**WAN generic auth (plugin-side fix for the public-entry 401 root cause): per-address credential overrides (Basic gate / API-key gate) + 5-tier diagnostics + 4-tier error copy + SGLang WAN wiring**

- **Per-address credential overrides (generic design; LAN stays zero-config, zero behavior change)**:
  1. **Address entry = URL, or `{url, auth?}`** — every address row (Matrix LAN/WAN, Controller LAN/WAN, SGLang LAN/WAN) gains an optional WAN credential selector: none (default; the service's own auth) / Basic auth (public gateway Basic gate, e.g. Caddy) / API key (Bearer; public gateway key gate, e.g. Higress). LAN rows left empty stay plain URL strings, byte-compatible with the old config shape.
  2. **First-request auth, no retry loop** — an address with a credential override sends the right Authorization (Basic base64 / Bearer) on its very first request; no dependence on a 401 challenge. Credentials live only in the local config.json: redacted echo (`***`), never logged, never shown in plaintext in the UI.
  3. **Single-source dialing resolution** — all 20 dialing sites (proxy / /sync / workers family / KB container family / SGLang / L1-L2 selfcheck / admin verify / host bridge / Matrix user APIs) go through one address-credential-headers helper, so a new dialing site cannot miss it.
  4. **Credential merge semantics on save** — position-based merge: blank or `***` keeps the stored value (changing the URL does not clear the credential); a plain-string entry explicitly clears it; a selected type with missing fields degrades to a plain URL (honest, no fake success).
- **5-tier diagnostics + 4-tier error copy (spot the WAN break at a glance)**:
  1. probes per address now carry that address's credential override (a WAN-gated address can only return 200 with its credential, so auto-rerank can actually pick it; the old no-cred probe made WAN addresses permanently 401 and never effective);
  2. 401/403 triage by three signals: `WWW-Authenticate: Basic` = gateway Basic gate (hint: fill the WAN credential on that address) / no challenge + empty body = gateway API-key gate (hint: fill the API key) / no challenge + JSON body = service-level token rejected (check the token) / 403 = forbidden; a configured-but-rejected credential is called out explicitly.
- **SGLang WAN wiring (Q4 in batch)**: the SGLang WAN address can carry an API-key override (e.g. `https://higress.sat...:7113` with key) — the served-model list (worker creation) and the cluster-load card work over WAN too; the LAN address stays a bare dial.
- **Behavior change note**: `matrix_homeservers` / `controller_urls` / `sglang.urls` entries upgrade to `str | {url, auth?}` (old plain-string configs are auto-compatible, zero migration); `/config/test` accepts the same shape (draft credentials are testable before saving).

**Verification**: tsc 0 - vite build single file ~2,343 kB (gzip ~653 kB) - pytest 113/113 (incl. 23 new: entry parsing / credential matching / merge semantics / redaction / challenge triage / PUT round-trip) - i18n 1,393 keys, 0 missing 0 dup 0 empty - secret scan 0 (source + dist)

## 0.5.0-beta.14.2 (2026-10-03 - sub-batch)

**14.1 acceptance feedback, four items: WAN disconnect root-cause fix (proxy 4xx semantics + direct-dial address failover) / split layout accounts for the thread panel / follow-to-bottom survives DOM growth / stale approval notifications eliminated**

- **WAN "controller 401, knowledge graph 500, simply unreachable" — three root causes fixed **:
  ① **Proxy 4xx no longer poisons the working address** — the catch-all proxy previously marked *any* HTTP response (including 401) as the "working address"; a single 401 pinned a dead address at the front of the failover chain, so returning to LAN stayed 401 forever. Only success (<400) marks working now.
  ② **Proxy GET/HEAD fail over to the next address on 4xx/5xx** — when the WAN entry is a gateway proxy (401 = session required) and the direct controller is healthy, the old code never failed over. It now tries the next address and, after all fail, returns the first non-2xx response (upstream 401 diagnostic body preserved). Mutating requests (POST/PUT/DELETE) do not replay on another address on 4xx.
  ③ **All direct-dial call sites now use ordered address failover** — KB container channel / generic Controller JSON calls / teams-structure workers query: previously a single dial (working cache or first URL) with 4xx returned immediately, so network switches meant persistent 401 or full-timeout stalls. 200 wins; 4xx/5xx/transport errors move to the next address.
  ④ **Latent 500 in the KB removed** — the `/kb/agents` Docker-degraded fallback called the approval fallback helper with a variable that doesn't exist in scope (NameError → 500, triggered whenever the Docker channel returned 401/403/502, first seen on the WAN path after a network switch), with a response shape that didn't match the frontend contract. Now served from the controller workers API in KB contract shape.
- **Split layout accounts for the thread panel **: the single/dual-column decision previously ignored the thread panel's width — with a thread open, narrowing the window left the chat cramped while the decision stayed dual-column until much narrower. The open thread panel's width (280–560, live with dragging) now counts against the decision; below 800 effective width it switches to single column and recovers on close.
- **Follow-to-bottom no longer lost **: follow previously only ran when the message count changed; when images / cards / artifacts rendered and grew the content afterwards, users at the bottom watched the viewport get pushed up. A ResizeObserver on the scroll content now follows automatically while at bottom; reading history (scrolled up) is unaffected.
- **Stale approval notifications eliminated **: after approvals were resolved or timed out, opening the chat page still fired browser notifications for approvals that no longer existed — root cause: the "seen approvals" set lived only in the component instance, so reopening the plugin or switching rooms treated historical approvals as new. Two guards: ① the first (historical) batch of a room is registered without notifying; ② genuinely new arrivals are checked against the live pending source (realtime buffer + history scan) before notifying, with a fail-safe suppress when the check itself fails. In-chat approval cards and the notification center are unchanged.

**Verification**: tsc 0 · vite build single-file ~2,337kB (gzip ~651kB) · pytest 90/90 · i18n 0 new keys · sensitive scan 0

## 0.5.0-beta.14.1 (2026-10-03 - sub-batch)

**S1 chat-realtime trio (root-cause fix for "no self-recovery after stream death / no new messages in background tabs") + manual address pinning (address_mode)**

- **Chat realtime (S1)**: all three root causes fixed: ① **SSE reconnect state machine** — no more permanent stop after the backoff caps at 60 s (self-heals on host restart / container swap / network recovery; while down, the 60 s polling fallback runs in parallel); 401/403 session expiry no longer stops permanently — keeps probing on a 60 s cycle (auto-recovers on the next connect once the host token refreshes after re-login) ② **stream watchdog** — the backend sends a ": keepalive" comment frame every 15 s; no bytes at all for 45 s (keepalive included) = TCP half-dead hang (NAT timeout / proxy idle-kill without FIN) → abort into the reconnect path ③ **visibility catch-up** — background-tab setIntervals are throttled by the browser to ≥60 s, so returning to the foreground / window focus pulls messages + room list once immediately (3 s debounce against event storms) ④ **reconnect catch-up** — the watcher /sync does not replay events missed while down, so recovering after >5 s of downtime pulls the active room's messages + the full room list immediately ⑤ **event-stream state on the settings page** — green "connected" / amber "disconnected — auto-reconnecting (last down HH:MM:SS)", S1-class issues visible at a glance
- **Manual address pinning (address_mode)**: new three-way picker on the settings page (auto = default / pin LAN / pin WAN; list-order contract = [LAN, WAN]; saved and effective without restart). Pinned mode dials only the pinned address (the failover chain degrades to a single element); failures report an explicit "address mode = pinned LAN/WAN: no auto-failover on failure — check this link or switch back to auto" error — no silent failover. The background probe loop keeps running (connectivity test still shows the other path's latency; the pinned address gets a blue "Pinned" badge). Auto mode semantics unchanged (regression guardrail for existing behavior)
- **Behavior change note**: the three address kinds in the `GET /config` `effective` report change from "empty cache = empty string" to "cache first, fall back to the first address on cache miss" (more honest in auto mode; pinned mode reports the pinned value)

## 0.5.0-beta.14 (2026-09-25 - official release)

**Merged release of the 13.2–13.24 batch (chat / sessions / teams / workers / workflows / skills / knowledge base overhaul + build size −5.3MB)**

- **Element-style chat**: bidirectional Element @mention format (send: body short name + formatted_body matrix.to + m.mentions; receive: full MXID and short name rendered as one pill — Workers no longer miss mentions under `_require_mention`); "load original messages" with Element-style auto-continue at the top (chained pagination without a hard cap, anchor preserved, four real termination conditions); history prefetch pipeline (prefetch the next page as soon as a room opens, zero-wait on hit, the loading indicator is almost invisible); cross-room message fix; Element-style pinned bottom; tool bubbles with status colors, sectioned expansion, hover-copy code blocks
- **Sessions & status dots**: card-based session list (whole-card click, status dot always visible); session window event-driven via /sync→SSE (4s polling demoted to fallback); **status dot final spec, three placement points** (idle gray / running blue-breathing / done green: bottom-right corner of every in-room Worker avatar + member avatar strip + team-management member list)
- **Team management**: first paint ready in one pass + **three-layer cold-window root-cause fix for first load** (multi-address per-request failover for structure + 3s probe + 3s connect timeout + first-paint split — tree renders first, spawns merge in asynchronously); Element-style room list (SSE deltas, no more full refresh); sidebar role filter chips (Leader/Worker/Manager, list stays unsplit); **team config dialog made complete**: subagentModel (empty = inherit the Worker's main model) + embedded team-skills section (search/upload/create/download + assignment matrix + MCP card) + **batch model setting (Leader batch / Workers batch, single-team scope, reuses the per-row diff save path)**
- **Workers**: per-worker skills as first-class citizens (full materialized-layer fields + preload switch, hot reload); **four-tier tool-approval card** (approval data plane unified on the #1216 Controller primary path, automatic fallback on 404 for old controllers and on 502-unparsable, OFF capability surfaced); **six runtime-config tabs, system tab approval level now editable** (same four-tier control); resource management folded into the topology (two-layer skills / MCP / channels / tools in one place, no picker for single-worker); spawn-tree tool/skill whitelist display (#7004 consumer side); heartbeat state surfaced (#1247)
- **Workflows & board**: board with 8 equal-height columns (4×2 wide / 2×4 narrow, fully measured heights); topology polish (stats bar + zoom 0.4–2.0 + per-node subagent row + click node → task inspection + draggable left column 220–520, persisted); **DAG and Mermaid merged into a single DAG view** (rows horizontally centered + node hover highlight; mermaid dependency retired entirely, single-file build 7,624→**2,332kB**); team-deletion undo (snapshot rebuild, 6s undo window)
- **Skill center**: L2 dual mode (Matrix identity, team-scoped writes to the team's skill matrix; L1 unchanged); upload (zip multipart passthrough) / custom create (SKILL.md packed in the browser) / download (version-gated + upstream endpoint); two-layer skill display (assignment layer / materialized layer, green/yellow/gray)
- **Knowledge base**: 413 root-cause fix (whole-workspace tar upload column → dual-channel exec-find primary + tarball fallback; 180/176-file workspaces at 0.16–0.22s, all 200); symlink following; two equal-height columns + independently scrolling tree; stable 2D knowledge-graph highlighting (click a node, connections no longer flash out); **project-room↔project triple-source association** (workflow source ∪ `Project:` naming ∪ `TASK:<projectId>` task rooms)
- **Other**: Loop settings aligned with QwenPaw (4 templates + doom-loop parameters + editable memory backends); AgentActivityTrack task rail (project name + status + done/total + waiting-for-human chip); self-drawn unread bubbles (centered digits + 99+ + white outline ring); 70-glyph all-SVG icon set (UI emoji eliminated, 6 categories retained); dual-baseline wide/narrow layout (window ∩ measured container, ResizeObserver-followed)
- **Engineering**: group-message loading logic consolidated into a pure-TS `roomHistory.ts` state machine (invariants I1–I6 documented); five UI harness suites, 25+ regression anchors; 1,376 i18n keys mirrored zh/en; single-file build constraint (0 import statements, host-blob safe)

**Verification**: tsc 0 · vite build single file 2,332kB (gzip 650kB) · pytest 71/71 · i18n 1,376 keys 0 missing 0 dup 0 empty · ui-harness-1324 20/20 · sensitive scan 0 (all text entries in package)

---

- **Docs emoji → plain text (post-release fix)**: UI icon emojis (🏠💬🔔🔀📦👷📚🧩🎯🔍🛠⚙✉ etc.) removed from README + docs/ in favor of plain text labels — the icon library has been fully SVG since beta.13.13 (icons.tsx, 71 icons), so doc emojis no longer matched the actual UI; CHANGELOG historical entries keep their original emoji→SVG replacement records (history, not current description)

## 0.5.0-beta.13.24 (2026-09-25)

**13.23 install feedback, 6 items: team management first-load / manual refresh slowness (true root cause = dual-address cold window, full-chain fix) / tool-execution-security 502 (upstream missing /api prefix — plugin fallback + upstream fix branch) / approval level made editable ("System" tab in runtime config embeds the approval control) / unread bubble digits centered and always contained / DAG + Mermaid merged (mermaid dependency removed, −5.3MB; DAG centered + hover polish) / batch model editing in the team config dialog (Leader / Workers batches)**

- **Team management first load stuck + manual refresh also unresponsive, needs a wait (third recurrence — true root cause)**:
  the connector dual-address (LAN IP preferred + public domain) cold-start window — the in-process `_working_cache` resets on every container restart (i.e. every new beta install); for the first 15 s (probe delay) all requests dial the LAN IP in config order; on non-LAN networks the LAN IP's SYN is dropped → +12.3 s per request (6 s timeout × 2 retries) before failover to the public address; `/teams/structure` had **no per-request failover** at all (single address, 10 s timeout).
  Full-chain fix: ① the structure endpoint's controller dialing now uses a multi-address failover loop (same semantics as the catch-all proxy) and marks the working address on success ② the structure matrix fallback gets the same multi-address failover + a 30 s cap ③ all connect timeouts 6 s → 3 s (bad addresses identified fast) ④ probe delay 15 s → 3 s (convergence at session start) ⑤ frontend `refreshTree` split — structure renders the tree as soon as it arrives; spawns (per-project fan-out) merge asynchronously and never block the first frame ⑥ `requestJson` supports an AbortController timeout; structure/admin fetches are capped at 30 s.
- **Tool-execution-security "HTTP 502: worker returned an unparsable running config" (upstream bug confirmed, fixed on both ends)**:
  the upstream Controller's `worker_approval.go` (#1216) dials the QwenPaw upstream config **without the `/api` prefix** → hits the SPA catch-all, which returns 200 + index.html → JSON parse fails → 502 unparsable (GET and PUT both affected).
  Plugin side: read/write fallback condition 404 → **404 ∪ 502-unparsable** (legacy endpoints stay usable, no block); L2 fallback on 401 now shows a precise hint.
  Upstream side: new branch `fix/worker-approval-api-prefix` in `SC/AgentTeams` (2-line fix + unit test, go gates green) — the primary path becomes canonical once the controller is rebuilt (official image).
- **Runtime-config approval level is no longer read-only (user decision)**:
  the runtime-config card gains a "System" tab embedding the **same approval control** used by Worker management / room member cards (four-level card selector + read/write dual-path fallback + L1/L2 permission semantics + OFF capability hint — fully reused, zero new links); approval_level via the WRC PUT is rejected by the server (400), so it goes through the approval endpoints — no double-write.
- **Unread message bubble: digits centered + always contained**:
  the antd Badge on team-overview group / DM cards is replaced by a custom `UnreadBubble` — flex-centered on both axes, min-width 16 / height 16 / padding 0 4, `>99` shown as `99+`, 1.5 px white ring (clear contrast on card backgrounds). Any digit count renders fully visible and centered.
- **Workflow topology DAG and Mermaid merged ("they're the same thing — no need for two")**:
  the two views were isomorphic (the Mermaid view = an upstream `?format=mermaid` snapshot render, **non-interactive**; the DAG = a self-drawn layered SVG, **click a node to inspect**) → the Mermaid view and its dependency (the mermaid library) are removed (build **−5.3MB**, single file 7,624 → 2,332 kB), keeping the DAG, now optimized: layer rows are **horizontally centered** (were left-aligned), nodes get a **hover highlight** (bolder stroke), node size 190×40 → 200×44.
- **Batch model editing in the team config dialog ("two batches, leader/workers; per-team, not global")**:
  the team config dialog gains a "batch-set model" section (above the member rows): a Leader batch (team_leader rows) + a Workers batch (all other rows), each with one model picker — applying a value paints every row of that role and saves through the **existing per-row diff pipeline** (PUT /workers merge semantics, changed rows only, provider untouched, blank = no change); reset when the dialog opens.
- **i18n**: 1,376 keys, 0 missing / 0 duplicate / 0 empty

**Verification**: tsc 0 · vite single-file 2,332 kB (gzip 650 kB; 0 import statements = host-blob safe) · pytest 71/71 · ui-harness-1324 20/20 (bubble centering / zero overflow / 99+ · no Mermaid residue · centered layer rows · node hover stroke · batch paint row sync + diff tag + Workers-batch independence · System-tab four-level cards editable) · i18n 1,376 keys · sensitive scan 0 (source + decoded dist)

---

## 0.5.0-beta.13.23 (2026-09-25)

**Approval data plane unified on upstream #1216: L2 accounts gain team-scoped read/write / OFF permission (#1273) surfaced / edit-entry pointer**

- **Approval read/write primary path switched (upstream #1216, merged 09/16)**:
  reading/writing the approval level previously went only through the legacy endpoints (docker archive read of agent.json / PUT running-config — L1 admin token required, L2 always got 401). It now prefers the **Controller approval endpoint** (`GET/PUT /api/v1/workers/{name}/approval`, via the catch-all proxy: admin token present = L1, absent = Matrix credential = **L2 can read/write their own team's workers, team-scoped**). On an old Controller (pre-#1216) a 404 automatically falls back to the legacy endpoints (L1-only), preserving compatibility.
- **Stale permission copy removed**: the old hint "L2 account has no read access (L1 admin credentials required; opens automatically once the upstream L2 write-path PR merges)" no longer holds (#1216 has merged) → replaced with an accurate credential/scope message.
- **OFF permission surfaced (upstream #1273: approval_level=OFF gated behind the approval_policy capability)**:
  a static note under the four-mode cards — OFF requires the approval_policy permission (built-in for L1 admins; L2 needs an explicit grant; submitting without it returns 403 with the detail passed through).
- **Runtime config "System (read-only)" tab pointer**: the approval_level tooltip now points to the editable entry ("Tool execution security" card in the Worker management expanded row / room member card).
- **i18n**: 1,373 keys, 0 missing / 0 duplicate / 0 empty (+3 new, 1 stale key replaced)

**Verification**: tsc 0 · vite single-file 7,624kB (gzip ~2,151kB; 0 import statements = host-blob safe) · pytest 71/71 · ui-harness-1323 14/14 (primary read / fallback read / permission copy / primary write / fallback write / OFF 403 pass-through / stale-copy regression guard) · i18n 1,373 keys · sensitive scan 0 (source + dist decoded) · 10 version carriers

---

## 0.5.0-beta.13.22 (2026-09-24)

**Close of the 13.21 verification feedback (7 items): team skills scoped to the team only (catalog / assignment matrix / MCP) / Mermaid merged into the topology dependency graph (fifth view retired) / team-config dialog close animation / 2D knowledge-graph selection persistence / unread badge on the room card avatar / subagent default model gets the same picker as worker models / DM role partition becomes bottom filter chips**

- **Team skills section scoped to the team only** ("team skills (catalog / assignment matrix / MCP) should only cover this team"):
  the **assignment matrix** embedded in the team-config dialog's skills section previously used the full worker list — workers from other teams leaked into this team's matrix; it now renders only the `onlyTeam` workers (catalog / upload / MCP cards were already team-scoped in 13.21; this closes the last leak in the matrix).
- **Mermaid merged into the topology dependency graph** ("no need for a fifth view — just improve the topology's dependency graph"):
  the 13.21 fifth view "Mermaid" is retired — the topology dependency graph gains a **graph-style switch**: DAG (interactive, click a node to inspect its task) / Mermaid (upstream `?format=mermaid` snapshot rendered directly, better looking); the choice persists locally; users who had persisted `wfView="mermaid"` are migrated to "topo" automatically (no experience loss).
- **Team-config dialog close animation**: previously the dialog had an open animation but vanished instantly on close; closing now plays the antd exit transition (`afterClose` unmounts, so the content stays intact during the animation without flashing empty).
- **2D knowledge-graph selection persistence** ("clicking a node to see its connections, the arrows only flash once"):
  root cause = in merged mode the graph object passed to the graph view got a fresh reference on every render → the selection effect cleared the selected node on every re-render (the highlight flashed for one frame); it now clears **only when the selected node no longer exists in the new graph** (switching agent / re-fetching still clears it); the merged graph and legend are also memoized (the force layout no longer recomputes needlessly).
- **Unread badge on the room card avatar top-right** ("move it to the card's top-left, or give the room card an avatar and put it on the avatar's top-right"):
  group room cards gain an avatar, and the badge sits on the avatar's top-right (Element-style); DM card badges moved the same way; red = @-me / mention, grey = regular unread; the old grey capsule in the name row is retired (no more squeezing the name).
- **Subagent default model = the same picker as worker models** ("same source"):
  the plain Input became an AutoComplete — same data source (SGLang serving ∪ in-use models ∪ gateway aliases) and the same pre-save validation (path-shaped value = error, not in list = warning with hover hint), zero behavioral divergence from the worker-creation / team-config member model pickers.
- **DM role partition becomes bottom filter chips** ("add a role-based partition display below, instead of splitting the list directly"):
  the 13.21 implementation split the list into role segments with group headers; it is now **filter chips** above the DM list (All / Leader / Worker / Manager / Other, with counts; empty buckets hidden) — "All" (default) = one flat list (existing time/name order), picking a role = show only that role's DMs; if the selected role bucket disappears (no data after refresh) it auto-resets to "All".
- **i18n**: 1,371 keys, 0 missing / 0 duplicate / 0 empty (+3)

**Verification**: tsc 0 · vite single file 7,622kB (gzip ~2,150kB; 0 import statements = host-blob safe) · pytest 71/71 · ui-harness-1322 22/22 ( matrix scoping /  graph-style switch /  selection persistence across re-renders /  badge on avatar /  chip filtering) · i18n 1,371 keys · sensitive scan 0 (source + decoded dist) · version carriers 10 files

---

## 0.5.0-beta.13.21 (2026-09-24)

**Close of the 13.20 verification feedback + full remaining-inventory batch: team-management first screen ready in one shot / Element-style incremental room-list refresh / full team-config dialog (with team skills section) / worker config integrated into the topology / sidebar role grouping / composer activity track / Mermaid DAG view / delete-team undo / heartbeat status surfaced**

- **Team-management first screen ready in one shot** ("at first only the topology was visible; I had to wait and click refresh to see the rest"):
  all five structural gaps fixed — ① the mount effect now fetches admin data; ② re-fetch on the admin-token `false→true` flip (late-arriving token left the first screen empty); ③ first-visit early-return in the tab-switch effect (a persisted first open of the team tab never refreshed); ④ `fetchAdminData` made per-key fault-tolerant (a 404 on humans/managers no longer drags down workers/teams); ⑤ failures surfaced (consecutive-failure counter + warning strip, no more silent failures).
- **Element-style room list** ("is the refresh a bit slow and clunky — look at Element"):
  ① the backend watcher emits a new `room_list_update` SSE incremental event — deltas for room name/topic/unread/last_ts/member_count plus new-room summaries and leave events (diffed in place from the /sync event stream; no more full `/teams/sync` on every update);
  ② the frontend **merges and re-sorts in place** (no full-table refetch); mention/approval updates no longer trigger a full room refresh (full sync only on: first sync / login / explicit refresh / accepting an invite);
  ③ +7 incremental-diff regression tests.
- **Unread badge moved to the top-left** (sidebar icon badge, top-right → top-left).
- **Full team-config dialog** ("team skills and other team config should live inside team config"):
  ① added the **subagentModel** field (team-level default model for spawned subagents; blank = inherit each Worker's primary model) + save (PUT, same semantics as heartbeatEvery);
  ② an embedded **team skills section** = the Skill Center component in onlyTeam mode (catalog search / upload / custom create / download + per-member assignment matrix + MCP cards; saves go through the Skill Center endpoints, independent of the dialog's Save button; capped at 460px with inner scroll);
  ③ **L1/L2 separation preserved**: L1 can manage any team; L2 users go through the Skill Center (My Team) entry — same capabilities, server-side scoped to their own team.
- **Worker config integrated into the topology** ("workers too, all integrated into the topology"): the worker topology "Resource Management" skills tab gains the **catalog section** (search / upload / custom create / download, scoped to that Worker's team) plus the existing editable assignment matrix — one screen.
- **Sidebar role grouping**: the DM view groups by the counterparty's role (Leader / Worker / Manager / Other; within a group, still by time/name order); without L1 admin data it falls back to a flat list (L2 unaffected).
- **AgentActivityTrack (task progress + HITL above the composer)**: when the active room's project is live, an inline track above the input shows the project name + status + tasks done/total + iteration progress + an amber "awaiting human input" chip + open-task chips (≤5, with status dot + assignee); clicking the track opens that project's workflow; auto-hidden when the project is terminal or unmatched. Data = the existing workflow API (zero extra requests).
- **Mermaid DAG view (, fifth view)**: the workflow page gains a "Mermaid" view — renders the upstream `GET /projects/{id}/workflow?format=mermaid` snapshot directly (node color = task status, ready highlighted); mermaid 12.0.0 (MIT) is inlined into the single-file bundle (the host blob environment forbids dynamic imports, so `inlineDynamicImports` inlines everything; main bundle 2,308→7,620kB, offline-capable with zero network dependency); a 404 (Controller without the endpoint) shows an honest placeholder and does not affect the topology view.
- **Delete-team undo**: snapshot before delete → a 6-second "Undo (recreate from snapshot)" toast after a successful delete → `createTeam` re-applies the snapshot (teamName / description / workerMembers / heartbeat / peerMentions / subagentModel). Honest semantics = **recreate, not restore** (room history / container state do not come back with the CRD; the toast says so).
- **Heartbeat status surfaced (#1247)**: the worker detail panel shows the four heartbeat-task runtime fields (agentStatus / runningTaskCount / lastRunAt / lastFinishAt; the row hides entirely on older Controllers without the fields).
- **MCP L2 write permission**: the upstream capability-foundation is in flight (foundation only: CRD capabilities + audit client); the consumer branches are scheduled after it merges — L2 MCP writes remain blocked for now (not a plugin-side issue).
- **i18n**: 1,368 keys, 0 missing / 0 duplicate / 0 empty (+25)

**Verification**: tsc 0 · vite single file 7,620kB (gzip 2,150kB; 0 import statements = host-blob safe) · pytest 71/71 · i18n 1,368 keys · sensitive scan 0 (source + dist decoded) · version carriers 25

---

## 0.5.0-beta.13.20 (2026-09-24)

**Close of the 13.19 verification feedback: per-worker skills as first-class citizens (materialized-layer fields + preload switch) / team-config entry moved to the topology (gear beside "N members") / room-message loading converged (roomHistory single authority + deep-history fix on room-open)**

- **Per-worker skills** ("skills seem to exist per worker, not just per team"):
  ① materialized-layer fields completed — `GET /workers/{name}/skills` returns description / source / emoji / version / tags which the UI previously ignored, leaving bare skill names;
  ② the matrix's expanded worker view upgraded from bare tags to **per-skill rows**: enabled dot (green/gray), source tag, description (ellipsized, full on hover), assignment tag (assigned = blue / materialized-only = cyan);
  ③ **preload switch** (per worker × per skill): `PUT /workers/{name}/skills/{skill}/preload` — the full skill text stays in that worker's system prompt for every session (QwenPaw ≥ 2.2.1; validated + persisted + **hot-reloaded** on the worker, no restart); permissions = L1 any worker / L2 own team / team leader read-only; three honest failure toasts (403 = read-only identity / 404 = version gate or missing skill / 502 = worker unreachable).
- **Team-config entry moved up** ("move team config to the right of the team's 'N members' in the topology, add a gear icon"):
  a ⚙ gear next to "N members" on each topology team node (rendered only for L1 with admin data) opens the "Configure team" dialog (name / description / heartbeat / member models) — **the same entry as the team table's "Configure" button** (registered handle, no second dialog copy; auto-invalidated on L1 logout).
- **Room-message loading converged** ("the group-message loading logic still needs optimization — don't build a mess"):
  ① five rounds of verification fixes (13.10 merge / 13.16 concurrency gate / 13.17 pinned-top relay / 13.18 prefetch pipeline / 13.19 cursor monotonicity) — window cursor / prefetch slot / in-flight gate / empty-page walk — converged into a new `roomHistory.ts` module with **numbered invariants I1–I6** (cursor monotonic / merge-not-replace / single prefetch slot double-keyed / empty-page walk ≤8 / single in-flight / persist = full window + cursor), backed by an 8-case node smoke script, all green;
  ② **real bug fixed (room-open path)**: after a room switch the messages ref was zeroed, and the old merge used that empty base — the latest page **overwrote the deeper cached history** (the 13.10 "history survives room switches" guarantee had a hole on room-open); the base is now the longer of on-screen full list and cached window, so previously walked history survives;
  ③ the state-restore inline block (a 4th window-establishing path: no merge / no window cursor / shallow-page cache overwrite) retired — window establishment now has a **single authority** (the refresh path); 4 scattered refs + 1 dead mirror removed;
  ④ the chat display side (anchor keep / 0.6-viewport prefetch margin / pinned-top relay / "load original" auto-backfill) is untouched — 13.17–13.19 acceptance semantics preserved verbatim.
- **i18n**: 1343 keys, 0 missing / 0 duplicate / 0 empty (+16)

**Verified**: tsc 0 · vite 2,308.18kB · pytest 64/64 · i18n 1343 keys · roomHistory smoke 8/8 · sensitive scan 0 (incl. decoded dist) · version carriers 10 files / 25 sites

---

## 0.5.0-beta.13.19 (2026-09-23)

**Close of the 13.18 verification feedback: full-chain repair of "load original" (cursor regression root cause + empty-page walk + unlock-on-progress + automatic backfill after click) / Skill Center gains upload / custom create / download (version-gated)**

- **"Load original no longer loads / probably too many requests" — full-chain repair (real root causes)**:
  ① **cursor regression** (the main one): every refresh (room-open restore / post-action) reset the pagination cursor to the "latest-50 cursor" while the window still held deeper history — afterwards `loadMore` pages came back fully loaded already: zero new after dedupe → nothing committed → no prepend → the chain sat locked for 6s → **wasted page after wasted page** (one extra request each) until the 30s watchdog cancelled = "it never loads". Now the **cursor is established on the first window only**; refreshes merge new messages and never touch it (cache writes and prefetching use the window cursor too).
  ② **empty-page walk**: a page with zero new content that still has an older cursor is followed immediately (up to 8 pages, stops if the cursor stops advancing) — a dead patch is crossed in one call.
  ③ **unlock on progress**: the chain guard now resets whenever `messages` changes; the 6s timer is only a failure-path fallback.
  ④ **automatic backfill after click** (Element-style): "load original" no longer depends on the scroll position — it pages backwards until the message enters the window; a >3000-net-messages cap was added (30s stall watchdog / bottom / room switch still terminate).
  ⑤ prepend detection now uses the **raw** first message id (pages that are entirely folded/hidden no longer break the anchor restore).
- **Skill Center: package upload / custom create / download**:
  ① **upload (zip)**: a catalog-card action posts to `POST /api/v1/skills` (multipart) — **the connector gained raw multipart passthrough** (it previously parsed every body as JSON, so uploads reached the server empty and always 400'd); scan outcomes (pass/warn/skipped, 422 reasons) surface in the toast.
  ② **new custom skill**: name/description/body → the frontend packs `SKILL.md` (fflate) → same endpoint; names are pre-validated against the server regex.
  ③ **download**: a per-row action (team/shared sources, team layer adds `?team=`) calls `GET /api/v1/skills/{name}/download[?team=]`; **version-gated** — a 404 on the current Controller shows an honest "upstream endpoint pending" note. The **upstream endpoint is implemented and tested** (branch `feat/skills-download`, `go test ./...` green, PR draft in `PR/skills-download-endpoint/`) — it lights up automatically once the Controller is upgraded, no plugin change needed.
- **i18n**: 1328 keys, 0 missing, 0 empty (+16)

**Verification**: tsc 0 · vite 2,301.88kB · pytest 64/64 · i18n 1328 keys · controller `go test ./...` green · 8 version carriers

---

## 0.5.0-beta.13.18 (2026-09-23)

**Close of the 13.17 verification feedback: chat history now uses a prefetch pipeline + earlier margin — loading follows the window and is ready by the time you arrive (no more "triggered-then-fetch, slow")**

- **Prefetch pipeline (real fix for "auto-loading exists now, but it's slow and only loads when the 'load more' trigger fires, instead of preloading along with the window")**: ① **the next page starts prefetching as soon as a room opens** — keyed by (room + cursor), dropped on mismatch/room switch (never fetches across rooms); prefetch failures stay silent ② **after every landed page the following page is prefetched immediately** — the pipeline stays one page ahead, so when you reach the boundary the page is **already there (zero network wait)** ③ the near-top trigger point moves earlier: margin 0.25 → **0.6 of the viewport (min 400px)** ④ trigger → append share one path: a prefetch hit renders immediately with the scroll anchor preserved (no jump); **if a prefetch has already failed, that page falls back to a direct fetch** (history loading never rides on an earlier failure) ⑤ the "loading earlier messages…" state remains (most of the time you won't see it — the page is already prepared)
- Net effect: while you scroll up, loading **follows the window** (prepared before you arrive) instead of "hit the boundary → trigger → wait a round trip → content appears"

**Verification**: tsc 0 · vite build 2,286.90kB · pytest 64/64 · i18n 1312 keys, 0 missing, 0 duplicates, 0 empty · 8 version carriers

---

## 0.5.0-beta.13.17 (2026-09-23)

**Close of 3 feedback groups from the 13.16 verification: board height now fully measured (no more page-level scrollbar) / chat history switches to "preload when near the top + hold-at-top chaining + visible preload state + concurrency guard" / top-bar version now build-time injected (always equals the installed build)**

- **Board height fully measured ("still a bit too tall, causing an overall scrollbar")**: the old code estimated the available height as `viewport - 240px` (a guess at the page chrome) — systematically too tall, so the 8 columns overflowed the container and the page scrolled. Now: available height = "measured board top → bottom of the nearest scrollable ancestor (or the viewport bottom)", divided by row count, minus the column's fixed overhead (header / padding / row gap) — the board fits its container exactly, no page-level scrollbar; hidden keep-alive tabs (0 width) skip measurement and the ResizeObserver recomputes once visible again
- **Chat message preloading ("can't load as you scroll / no preloading")**: ① near-top margin 40px → **25% of the list viewport height (min 160px)** — loading starts before you reach the very top; ② **hold-at-top chaining**: after every render (page landed / loading state changed) the top position is re-checked and the next page is pulled while still inside the margin — shared by normal chat and the "load original" flow, stops as soon as you scroll away; ③ **preload made visible**: "loading earlier messages…" at the top; ④ **concurrency guard**: an in-flight gate on the parent (scroll preload and the manual button firing in the same window would prepend the same page twice); ⑤ reset paths: prepend detection (fast) + a 6s fallback (failure path), replacing the old fixed 4s lock
- **Top-bar version ("the version number is wrong")**: the primary display is now **build-time injected** (vite define `__PLUGIN_VERSION__`, sourced from package.json, shipped inside the dist) — **always equal to the build you actually installed**; the old code read the backend `/health` (a backend process that didn't restart with the install would report the old version, and a failed request left the placeholder "…"). The connector runtime version is still fetched via /health but only appears in the tooltip (shows "UI x · connector y" when they differ)
- **i18n**: 1312 keys, 0 missing, 0 empty (+3)

**Verification**: tsc 0 · vite build 2,286.39kB · pytest 64/64 · i18n 1312 keys, 0 missing, 0 duplicates, 0 empty · 8 version carriers

---

## 0.5.0-beta.13.16 (2026-09-23)

**Close of 4 feedback groups from the 13.15 verification: third source for project ↔ room association (root cause found by diffing 76 real rooms × 35 real projects — new projects only have task rooms named `TASK：<projectId>`, which those task-room projects lacked entirely) / topology resource area UX reworked ("资源治理" renamed to "资源管理"; skills & MCP now embed the Skill Center's editable cards in place; a single worker no longer requires re-selecting the worker) / "运行配置" collapse header unified into the same card style as resource management / project board: equal-height columns, 4×2 on wide screens, 2×4 on narrow, height proportional to the viewport**

- **Third association source for project ↔ room (the real root cause of "still shows 'no project directly linked to this room'")**: the dual-source fix (source_room_id ∪ `Project: <title>`) covered 15/22 project rooms, but **new projects (those created via the create_task_room convention) have no `Project:` room at all** — the teamharness MCP `create_task_room` convention names **task rooms `TASK：<projectId>`** (upstream server.py contract; the project ID is embedded in the room name). The matcher now has three sources: ① exact source_room_id match ② `Project: <title>` (quote-tolerant) ③ **`TASK：<projectId>` (full/half-width colon tolerant) → exact match against ev.runId**. **Verification method: the real compiled function run against real deployment data** (76 real rooms + 35 real projects/workflows fetched through the local plugin proxy, esbuild-compiled and executed under node): 21/28 hits (15 project rooms + **all 6 task rooms**); the remaining 7 are orphan rooms (project no longer in the Controller / historically diverged titles — no usable association source). The project-files drawer, room-card project names, and team-management room cards all benefit
- **Topology resource area UX rework ("the resource-governance name is odd + can Skill Center and MCP be fully merged into the worker topology + opening tools shouldn't ask me to pick a worker again")**: ① "资源治理" renamed to **"资源管理"**; ② the skills tab goes from a read-only summary + jump link to **the Skill Center's editable matrix embedded in place** (`SkillCenter onlyWorker+sections` — same component, same save path; the assigned/materialized two-layer semantics carry over; edit inline); ③ the MCP tab goes from a read-only list to **the MCP card embedded** (editable mcpServers on L1; read-only on L2 per the upstream contract); ④ the "edit in Skill Center (full matrix)" jump link is removed (editing is now in place; the bottom fold remains as the cross-worker full view); ⑤ **no duplicate worker picker**: the tools/channels panels auto-select and hide the selector for a single worker (name shown as a tag)
- **"运行配置" collapse header unified into a card (make it look nicer, same as the resource-management button)**: text link → the same card-style collapse header as resource management (▸/▾ + gear icon + title + qwenpaw tag + bordered card); the expanded state gains a collapse affordance (previously it could not be collapsed once open)
- **Project board: equal-height columns + responsive ("every column equal height, dynamically adjust with screen height, proportionally; 4×2 on wide, 2×4 on narrow")**: column count derives from the container width — ≥950px → 4 columns × 2 rows; otherwise 2 columns × 4 rows; the card-area height = usable viewport height ÷ row count (clamped 200–460px, scales proportionally; `ResizeObserver` + `resize` listeners) → **all 8 columns equal height**; overflow scrolls inside the column
- **i18n**: 1309 keys, 0 missing, 0 empty (1 dead key removed)

**Verification**: tsc 0 · vite build 2,285.52kB · pytest 64/64 · i18n 1309 keys, 0 missing, 0 duplicates, 0 empty · **third association source verified live at 21/28** (real source function × real 76 rooms/35 projects) · 8 version carriers

---

## 0.5.0-beta.13.15 (2026-09-23)

**Close of 8 feedback items from the 13.14 verification: check-mark icon re-oriented / "load original" now auto-loads while you stay at the top (Element-style) / project room ↔ project association fixed with dual-source matching (project files drawer + room-card project names) / Worker topology gains a "resource governance" block (skills + MCP + channels + tools in one place) / skills shown in two layers (assigned vs materialized — explaining "no assignment, yet it works") / project board to 4×2 with 3 cards per column + in-column scroll + time sort / group-chat sender-isolation switch (wires the upstream #1235 endpoint, isolated by default)**

- **Check-mark icon re-oriented ("your √ SVG was rotated 90° counter-clockwise")**: the old `CheckIcon` path rendered tilted 90° counter-clockwise — replaced with the standard Material filled check path; every usage site (chat / approvals, etc.) is upright again
- **"Load original" auto-loads as you scroll (Element-style)**: previously, after clicking "load original" you had to keep clicking / scrolling manually. Now, while the original-message search is in flight, **staying at the top of the list auto-pulls the next page** (anchor preserved, no jump); scroll away from the top and it stops (shares the 40px top-trigger and the 13.6 anchor mechanism's re-entrancy guard). Termination is the four real conditions from 13.14 (target message enters the window → auto-locate + highlight / pagination bottom / no new data / room switch voids the in-flight chain) — no manual clicking needed at all
- **Project room ↔ project association fixed with dual-source matching (root cause of "chat project files read incorrectly / room cards missing project names")**: the room → project mapping was built from `workflow.room_id` alone — for standard project rooms (created by `create-project.sh`, named `Project: <title>`) the workflow event's `room_id` points at the **originating room** (QQ/DM), so the project files drawer and room cards were always empty for those rooms. Now dual-source: ① workflow source (`room_id` / `source_room_id`) hit, ② standard project-room name `Project: <project title>` matching the project title (both conditions guard against false positives). The chat project-files drawer, chat room-list card project names, and team-management room cards all benefit
- **Worker topology gains "resource governance" (skills / MCP / channels / tools in one place)**: each Worker row in the team topology, when expanded, now shows a resource-governance block — skills (two-layer view, below), mounted MCP servers, channels (reusing the channel editor, lazy-loaded on first open), built-in tools (reusing the tools panel, lazy-loaded on first open) — all four on one screen; the skills section links into the Skill Center (full matrix). What used to require switching between three separate entries is now visible in one expansion
- **Skills shown in two layers — explaining "why nothing looks assigned, yet calls work fine" (the "check it" answer)**: Worker skills have **two layers** — the **assigned layer** (CRD `spec.skills`, explicit assignment, L2-writable) and the **materialized layer** (what the runtime actually loads). Empty assigned layer + non-empty materialized layer = skills **auto-materialized from the team layer / restored built-ins / shipped in the image** — callable without explicit assignment, by design. The Skill Center matrix and the Worker topology resource-governance block now render both layers: "assigned + materialized" (green) / "materialized only" (yellow, no explicit assignment) / "not loaded at runtime", with an inline explanation; the materialized layer comes from the runtime `GET /api/workers/{name}/skills` (degrades gracefully when the Controller lacks the endpoint or the identity has no access — the assigned layer is unaffected)
- **Project board to 4×2 with 3 cards per column + in-column scroll + time sort ("two rows, four columns, three cards per board, scroll for more, get time sort right")**: the board moves from an 8-column single row (cramped) to 4 columns × 2 rows; each column shows at most 3 cards with in-column scrolling beyond that; tasks within a column are sorted by update time, newest first (`ts` descending, empty timestamps last), with no cross-column duplication of the same task
- **Group-chat sender-isolation switch ("I did the upstream endpoint")**: wires the upstream `share_session_in_group` (#1235 merged) — the Worker channels panel gains a "group session sharing" switch: **off (default) = sender isolation** (each person in a group gets an independent session, no cross-context bleed); on = the whole group shares one session (collaboration mode, but everyone's context mixes). Uses the existing L2 whitelist write path; effective immediately (from the next message)
- **i18n**: 1310 keys, 0 missing, 0 empty en (24 new keys: scroll auto-load hints / resource-governance set / two-layer skill semantics / sender-isolation copy etc.)

**Verification**: tsc 0 · vite build 2,286.71kB · pytest 64/64 · i18n 1310 keys 0 missing 0 empty · icon library 70, 0 dangling refs · sensitive scan (source diff + full tree + decoded dist) 0 (the `192.168.x.x` placeholder form is an established allowed item) · 8 version carriers

---

## 0.5.0-beta.13.14 (2026-09-23)

**Close of 7 feedback items from the 13.13 verification + Skill Center L2 dual mode: "load original" 15-page cap removed / chat project files scoped to the current room / room cards show project names / project-files dialog (folder title + in-dialog preview + download) / four icon corrections (artifacts=box, event stream=pulse, skills=lightning, Worker=robot) / worker skill assignment matrix reworked into per-worker rows / Skill Center L2 dual mode (my-teams scope · skills writable · MCP read-only)**

- **"Load original" 15-page × 50 cap removed ("can it go further?")**: the chain previously stopped after 15 pages (750 messages) and reported "not in loadable history". It is now bounded by four real termination conditions — ① the target message enters the window ② the pagination bottom is reached (`!end`) ③ a page returns no new data (guards against a server anomaly looping) ④ switching rooms (a generation counter voids the in-flight chain); 500 pages (25,000 messages) is only a theoretical backstop and is never reached in normal rooms
- **Chat project files scoped to the current room ("can it show only this group's?")**: the project-files drawer previously listed every project — now it shows **only the projects belonging to the current room** (room → project mapping derived from the workflow source); other rooms' projects no longer bleed in
- **Room cards show project names ("add the project name under the room name")**: each room-list card now shows the project name(s) as small text under the room name (all of them when a room carries several projects)
- **Project-files dialog: folder icon in the title + redundant subtitle removed + in-dialog preview + download button**: ① the title gains a folder SVG and the duplicated "project files" line under the title is gone ② preview no longer jumps to an external app — it opens the same **in-dialog preview** as the Artifacts tab (text/Markdown inline) ③ every file gains a **download** button (same single-toast downloadViaHost as the Artifacts tab)
- **Four icon corrections ("artifacts should be a box… skills / event stream / worker icons too")**: ① artifacts = a real 3D cardboard box (the old path was actually a **shopping bag**, not a box) ② event stream = activity pulse waveform (old radar → waveform; semantics = event pulses) ③ skills = lightning bolt (Skill Center and the home-page skills entry; old puzzle → lightning) ④ Worker = robot (old org tree → robot)
- **Worker skill assignment matrix reworked ("the matrix takes too much space, is not intuitive, hard to use")**: the old UI was a full worker × skill grid (dual-axis scroll, one state per cell, no way to see which workers changed). The new UI is **row-per-worker**: each row = one worker (current skill tags + count inline); clicking a row expands that worker's skill editor (only one open at a time, panel always compact). **Server-baseline dirty detection** — only rows that differ from the baseline show "Save"; the baseline advances on success and the dirty mark clears; a failed save keeps the mark for retry
- **Skill Center L2 dual mode (employee-view skill/MCP self-service)**: per the upstream design docs (`docs/design/l2-worker-scoped-write.md` merged as #1274, `team-skills.md`, `skill-catalog-api.md`, all merged to main) and the 9/11 P0 decision — a Matrix-identity login (no admin token) now sees a "**Skill Center (My Teams)**" under Team Management: ① skill catalog = `GET /skills?team=<own team>` (a single accessibleTeams entry is auto-selected; several get a selector; cross-team is 404 per the anti-probing contract) ② worker skill assignment = L2-scoped workers (standalone hidden) + `PUT {skills}` writable (the only field on the upstream L2 whitelist) ③ MCP = **read-only** (mcpServers is closed to default L2 — the gateway bearer key is injected into every entry, and an L2-controlled URL would exfiltrate it; write access awaits the upstream elevated-capability design). **Iron rule**: the L2 path never uses the admin token (the proxy chain falls back from the admin token to the Matrix access_token; already implemented in the router.py catch-all). L1 admin surfaces (teams / users / managers / channels / tools) stay hidden from L2
- **i18n**: 1286 keys, 0 missing, 0 empty en (new keys: full L2 skill-center set — my teams / select a team / team catalog unavailable / L2 matrix & MCP titles / no workers (L2 visibility) etc.; matrix row-rework keys — click row to expand / no skills assigned / unsaved / edit skills / reset to current value etc.)

**Verification**: tsc 0 · vite build 2,271.85kB · pytest 64/64 · i18n 1286 keys 0 missing 0 empty · icon library 70 (71 − puzzle/radar/org-tree + pulse/robot) 0 dangling refs · sensitive scan (source diff) 0 · 12 version carriers

---

## 0.5.0-beta.13.13 (2026-09-23)

**Close of 10 feedback items from the 13.12 verification: workflow blocked banners carry info / workflow tab refreshes on open / chat-group project files fixed / Element-style "load original" instead of "scrolled out" / download destination made explicit (desktop) / KB equal-height + independent tree scroll / all emoji → SVG (27 files, 71-icon library)**

- **Workflow blocked banners carry info ("only '⚠ blocked' shows, feels abrupt")**: each interrupted-task banner (previously several rows showing a bare "⚠ blocked" word) now carries the task short ID + task status + assigned Worker + the reason inline (task interrupt description / project pause reason), so the specific task is directly locatable
- **Workflow tab refreshes on open ("it should auto-refresh as soon as it opens")**: previously only the 15s poll + manual refresh — switching to the workflow tab (or a workflow card appearing in chat) now fetches the source immediately, with a 2s debounce against rapid tab switching
- **Chat-group project files fixed ("cannot be read")**: three fixes — ① project list cap 20 → 100 (previously the current project's files never loaded when it fell outside the alphabetical top 20) ② matching model reworked: grouped by project ID (previously by project name, colliding/missing across teams) + per-project lazy loading (current room's project loads automatically, others load on expand, per-project error display + refresh) ③ download URLs now carry a &team= qualifier to prevent cross-team collisions
- **Element-style "scrolled out of history" ("Element still has the messages")**: when the original message is outside the loaded window it no longer shows the dead-end "scrolled out of history" — it now offers an Element-style "load original message" action (chained pagination rewinding up to 15 pages × 50 messages from the loaded window; inserted in place as a quote bar on hit, or an explicit "original message not in loadable history" + jump fallback when exhausted)
- **Download destination made explicit (desktop still unknown)**: a single-point toast in downloadViaHost (covers all 6 call sites) — browser: "default download directory + filename"; Electron desktop: explicitly names the OS "Downloads" folder (e.g. C:\Users\<name>\Downloads) and notes that no download list is provided
- **KB equal-height + independent tree scroll**: the knowledge-file column and preview column stretch to equal height; the file-tree column scrolls on its own and no longer bubbles the wheel into page scroll
- **All emoji → SVG (T7– + full sweep)**: new icons.tsx library (71 icons: 43 HarmonyOS ic_public_* fill paths inlined directly + 28 hand-drawn stroke icons for items with no system counterpart — brain/radar/shield/brick etc.); UI emoji replaced across 27 files (top 4 tab icons + per-panel buttons/labels/empty states/verdict symbols/menu items/download buttons/status markers). **Documented keep-list**: message protocol regexes (🔧✅❌ parsing, Approval Required detection) / emoji picker & quick reactions (Matrix emoji content) / outgoing review-message text / browser notification titles (platform strings) / host string-API limits (sidebar icon fallback 🏢) / single-char text glyphs (✓✗○▶☰↻) / code comments
- **i18n**: 1277 keys, 0 missing, 0 empty en (new: Matrix-not-configured hint / path-like·not matched·expected / de-emoji-fied SOUL upload placeholder; legacy "✗ path-like" and "⚠ not matched" keys reworked to plain text + SVG prefix)

**Verification**: tsc 0 · vite build 2,268.12kB · pytest 64/64 · i18n 1277 keys 0 missing 0 empty · full-repo emoji final scan = documented keep-list only · 12 version carriers (4 code + README×2 + docs×4 + CHANGELOG×2)

---

## 0.5.0-beta.13.12 (2026-09-23)

**Close of 7 feedback items from the 13.11 verification: always-visible session status dot / Element-style pinned scroll-to-bottom / measured visible width for wide-narrow / room list mentions section + sort / topology & team icons as SVG / team-tab manual refresh now instant (negative-cache root cause) / event-stream empty-state copy + cancelled as a first-class status**

- **Session status dot always visible ("never saw the dot")**: the card dot previously rendered only when running (no dot for idle/done, and most on-disk sessions are idle) — now the WorkerSessionDot always renders (idle = steady gray, running = breathing blue, with tooltip), same source as the detail header and the member-avatar corner dots
- **Element-style pinned scroll-to-bottom ("the ↓ button doesn't stick to the bottom")**: root cause = mid-smooth-scroll, a new-message effect re-computed nearBottom=false → the button re-appeared and the counter reset-then-incremented. Now an explicit atBottom state + an 800 ms pinned lock (incoming messages during the lock keep following without re-popping the button) + instant follow (smooth dropped — its target drifts as scrollHeight grows); scrolling up to read history is never interrupted; switching rooms pins to the latest
- **Measured visible width for wide-narrow ("auto single-column didn't kick in")**: the container width was measured only at the plugin `<main>`'s direct parent, while the host's real constraining layer (Desktop OS window frame) sits higher in the ancestor chain. Now the width is the min of clientWidth up the ancestor chain to body, intersected with the viewport, with a ResizeObserver on the whole chain — works uniformly across OS-window / classic-page / iframe hosts
- **Room list sorting**: ① new pinned "Mentions" section (Element X semantics: rooms with @me/highlighted unread float to the top, hidden when empty) ② sort toggle (Recent ↓ default / Name A–Z, persisted locally) ③ the three sections (mentions/favourites/main) now share one render helper, removing triplication
- **Icons as SVG**: workflow "Topology" button 🌳 → DAG icon (nodes + edges); team-management tab 👷 → two overlapping figures (both the horizontal tab and the top Tabs). Pure inline SVG (no icon-package dependency), tinted by active state
- **Team tab manual refresh now instant ("refuses to refresh manually; only the 30 s auto-refresh worked") root cause, both ends**: the backend /teams/structure 60 s TTL cache also cached **first-failure/empty-tree results for 60 s (negative cache)** — once the token was not ready and the first pull got an empty tree, every manual refresh within 60 s hit that empty cache; the 30 s tick happened to land after TTL expiry and "fixed" it. Now failure/degraded/empty results are negative-cached for only 5 s, and success (controller-workers, non-empty) gets the full 60 s (ttl stored per entry); the frontend forces `force=true` on manual refresh / tab switch / login, while the 30 s background tick still uses the cache; +4 TTL regression tests
- **Event-stream empty-state copy (platform gap, settled)**: Controller event ingestion is not wired (endpoint read-only POST→405, all existing projects' events empty, runtime has no reporting — on-site 9/23 full-chain investigation) → the empty state now states "data source not connected, this panel is always empty; see the topology/board for task status" instead of implying "agents will aggregate after running"; the copy drops report_progress, which the current runtime action set does not have
- **Cancelled promoted to a first-class status ("cancelled shown as blocked" mapping defect, full sweep)**: topology nodes get their own dark-red color (no longer folded into blocked orange); the board gains a "Cancelled" column (7→8 columns); cards / task-inspection drawer show "Cancelled" (dark red #cf1322, distinct from failed #ff4d4f — failure = execution error, cancellation = human termination); terminal-state detection includes cancelled; a cancelled node no longer gets a false "ready" cyan frame
- **i18n**: +5 new keys (zh/en mirror: Cancelled / Recent ↓ / Mentions (n) / the event-stream empty-state sentence)

**Verification**: tsc 0 · vite build 2,149.65 kB · pytest 64/64 (+4 negative-cache TTL regressions) · i18n dict 0 missing 0 duplicate · in-package version check across 3 carriers consistent · 13.12 file set vs 13.11 = +icons.tsx only

---

## 0.5.0-beta.13.11 (2026-09-22)

**Close of 12 feedback items from the 13.10 verification: session list as cards (the real E1 target) / event-driven live session window / cross-room history root cause / wide-narrow dual-baseline + full-width container / approval notification sync / tab shake / thread flag SVG / workflow topology zoom + executor / QwenPaw-style session avatars & copy**

- **Session list as cards (the real E1 target — the 13.10 decision was "card the *session list*", 13.10 mis-fired on artifact rows)**: the worker session list moves from antd.Table to a card list (mirroring the dashboard worker-chats-panel) — whole card opens the detail, full name / full session_id wrap without clipping, squeeze-resistant in narrow containers; the table sorter survives as a sort dropdown (last-activity ↓ / created ↓ / name A–Z); Active/Archived tabs and the worker selector are unchanged
- **Event-driven live session window ("a 4s round is a bit dumb")**: the main path is now the backend /sync watcher → SSE → the open session window refreshes **immediately** (latency ≈ one network RTT); the 4s poll is demoted to the SSE-disconnect fallback (same semantics as the RoomChat P6). The running/idle status light refreshes on the same event
- **Cross-room history root cause (why "messages scroll out of history" still mis-fired)**: switching rooms left the previous room's messages / end-token / pagination state behind, so the merge mixed two rooms' messages into one window ("scrambled") and the mixed body got written into the new room's cache (back = "gone"). Fix = per-room timeline state is wiped whole on room change (Element semantics: timeline state is per-room)
- **Wide-narrow dual baseline + full-width container**: the split decision is now **min(window width, measured plugin-container width) ≥ 800** — when the window is full-width the container fills the host and splits; a narrow host container (half-window panel / host margins) or a genuinely narrow window = the chat page auto-collapses to a single column (no forced split); container width tracks a ResizeObserver (host layout changes that don't fire window resize still switch it)
- **Approval notification sync ("I approved, but the panel still shows the un-approved card")**: root cause = the backend /sync watcher only clears the pending-approval buffer once it *sees the approval-command message* (async, ~1–2s) — the 30s poll landing inside that resolve window pulled the not-yet-cleared item back, resurrecting the card. Fix = re-fetch immediately after sending plus a 3s follow-up, forcing the panel state to align with the backend buffer
- **QwenPaw-style tab shake (new approvals)**: when a pending approval appears, the sidebar logo shakes once (bell shake, 1.2s, reduced-motion friendly) and shows a red count badge (15s poll of /room-approvals, same source as the notification center; silently degrades when not logged in)
- **Thread icon → message-flag bubble SVG (replacing the 🧵 emoji)**: unified across the message-row "N replies" badge, the thread panel title, and the narrow-screen drawer title
- **Workflow topology upgrades (mirroring the dashboard + improvements)**: ① a stats strip (N tasks · M deps · K external deps) ② a zoom toolbar (− / percent / +, 0.4–2.0) so wide graphs never clip and detail stays legible ③ nodes now carry the **subagent executor row** (the Controller nodes field, previously dropped by the projection) ④ clicking a node opens the task-inspection drawer (same entry as the board task cards)
- **Resizable left project list in topology**: 220–520px (default 320, persisted), shared between the card and topology views
- **Session window more QwenPaw-like ("still not close enough")**: user right bubble + avatar, assistant left bubble + avatar (HostBubbles-style sides); a hover copy button per bubble (ResponseActions semantics, copies all text parts)
- **Full @mention re-audit**: the four send paths (main chat / quote / thread / approval command) all confirmed to carry the Element triple (body short name + formatted_body matrix.to + m.mentions.user_ids) with no gaps
- **i18n**: +11 keys (zh/en mirrored), full reconciliation 0 missing / 0 duplicate

**Verification**: tsc 0 · vite build 2,146.06kB · pytest 60/60 · i18n dict 0 missing / 0 duplicate · sensitive scan src 0 real names

---

## 0.5.0-beta.13.10 (2026-09-22)

**Full close of 12 acceptance-verification items: bidirectional Element-format @mentions / messages no longer scroll out of history / live session window with stick-to-bottom / over-folding fix / two-credential L1 guidance / KB listing of symlinks + non-text files / window-based wide-narrow detection / artifact rows as cards**

- **Bidirectional Element-format @mentions (root-cause fix for "plain strings")**: send side — @-mentions in text (exact localpart/displayname match, same rules as the @ popup) now produce the Element triple: body keeps the readable short name, `formatted_body` uses matrix.to links, and the `m.mentions.user_ids` triple carries the notification (previously a bare body only — under group-room `_require_mention` the worker never received the message at all); receive side — full MXIDs and short @names now render as unified Element-style pills (short names were orange-bold text before)
- **Messages no longer scroll out of history / reorder (root-cause fix)**: `messagesCache` upgraded from "latest 50-item page" to "full loaded history" (including the older messages prepended by load-more); `refreshMessages` changed from full replacement to event_id-deduplicated merge — paged history no longer vanishes when switching pages/rooms, and the scroll anchor no longer jumps
- **Live session window + stick-to-bottom (QwenPaw dialog semantics)**: the session detail now polls every 4s (lightweight change detection on length + last message, zero re-render when unchanged) with the status dot synced (running→idle flips in real time); stick-to-bottom = auto-scroll only while within 100px of the bottom, reading older history is not interrupted
- **Over-folding fix ("too many messages swallowed into replies")**: every assistant message with text is now its own bubble (QwenPaw dialog semantics); only tool/thinking/text-less steps collapse into an "N steps" pill (collapsed = children not rendered, lazy render on expand)
- **Two-credential L1 guidance (B1 root cause)**: root cause = the `l1` prop was dropped in the TeamNode→WorkerRow layer (the runtime-config panel was permanently read-only even with a token) — fixed the whole prop chain; the L1 read-only alert now states precisely that the Console session and the Controller token are two different credentials, with an "Open Settings" jump; after L1 password verification succeeds without a token → a persistent hint in Settings (with the token retrieval command); "max iterations" is pre-filled with the runtime default 40 when not explicitly configured (what you see is what runs; persisted only on save)
- **KB full listing (symlinks + non-text files)**: top-level / ls now follows symlinks and marks them (🔗); non-text files are listed too but shown greyed and non-openable with a "non-text" badge; hidden/sensitive filtering and file caps unchanged; +regression tests
- **Window-based wide-narrow detection (acceptance decision)**: the split-layout decision now uses window width (`window.innerWidth` + resize tracking) — eliminates the false portrait detection caused by host left/right padding squeezing the measured container; the "force split" switch and "collapse list" escape hatch are kept
- **Artifact rows as cards (fixes the clipped "view" button)**: spec / result-artifact / deliverable rows are now cards — the path wraps fully with no truncation and the view/download buttons sit on their own row, never clipped (shared component, effective in both the task-inspection drawer and the topology row)
- **Session-list credential gating made explicit**: 401/502 now say "Controller token not configured / unreachable" with the retrieval command (previously a generic "failed to load" — the real identity of "often shows no workers"); 403 → "no access to this worker"
- **i18n**: +8 new keys (zh/en mirror), full cross-check 0 missing / 0 duplicates

**Verification**: tsc 0 · vite build 2,137.68kB · pytest 60/60 · browser harness 13.7 24/24 + 13.8 35/35 + window-shell all pass · i18n 1249 dict keys, 0 missing / 0 duplicates · sensitive scan dist 0 / src 0 real names

---

## 0.5.0-beta.13.9 (2026-09-22)

**Six-tab runtime config + QwenPaw loop templates ported + session-status-driven status dots + chat bubbles & @mention pills + full-width adaptive layout + root-cause fix for KB listing on large workspaces**

- **Runtime config six tabs + L1/L2 gating**: tabs = ReAct Agent / Agent Loop / LLM Auto Retry / LLM Concurrency Limits / Context Management / Long-term Memory / System (read-only), each domain an independent Card + form rows (label + hover ⓘ hint on the left, control on the right); gated by the Controller PUT whitelist — L1 editable (everything writable except approval_level), L2 read-only with a notice (9-key whitelist, verified against the live endpoint); context management merges the nested light_context_config (12 fields: token divisor / compaction threshold ratio / 8 tool-result pruning keys); long-term memory reme 5 keys editable + full JSON viewer; save goes through buildDiff and sends only changed keys
- **QwenPaw loop templates ported (open-source etiquette: source credited)**: 4 templates (safe run / budget research / quality first / blank pipeline) + 7 gate definitions with defaults, ported value-by-value from the QwenPaw console AgentLoopCard (comment keeps the upstream source file + line numbers; the template section is labeled "template design: QwenPaw upstream"); pick a template → "create custom mode from template" dialog (mode name / slash command / description / pipeline preview) → custom loop CRUD
- **Session list adaptive width** (follow-up to the 13.7 "still crowded" feedback): channel column 64→56 (short name + hover Tooltip, whole column hidden below a 640px container), session column is the only flexible column (min 120), action column 44 nowrap — the "view" button is always visible; per-session running dot; **real React #300 bug fixed**: two hooks sat after the detail-view early return → clicking "view" crashed (Rendered fewer hooks); moved before all early returns (harness-verified)
- **Global width adaptation + portrait mis-detection fix**: main container maxWidth:1160 → 100% full width (the root cause of the large side margins on 16:9 fullscreen); the wide-layout check drops the aspect-ratio term and uses pure width ≥800 (the aspect ratio mis-fired as "portrait → single column" inside fixed-height containers/panels — 16:9 fullscreen is now always two columns, phone 390 stays single, manual override kept)
- **Session window folding looks more like QwenPaw**: the "N steps" pill is upgraded to a full row header (icon + text + count + right-aligned rotating chevron, light rounded row; lazy-render semantics kept — collapsed children are not rendered)
- **Chat bubbles + @mention pills** (benchmarked against dashboard/QwenPaw/Element): mine/other themed bubbles; full-MXID @mentions render as Element-style pill chips (localpart shown + hover Tooltip with the full MXID + click to jump), short @names keep the old highlight
- **Status dots now read the real session status** (follow-up to the 13.7 "inaccurate" feedback): new workerChatStatus module polls /chats per-session status (idle|running — the correct session state maintained by the qwenpaw app itself; 30s tick / only while the page is visible / concurrency 4 / on failure it silently keeps the old value and degrades to the message-level heuristic); state precedence = heartbeat (if present) > chat.running > typing; chat.updated_at is not used for "done" (user messages also refresh it → false green)
- **i18n terminology fixes**: "token budget" (令牌预算) → "词元预算" (LLM token = 词元, 4 places), "retries per story" (每故事重试) → "max retries per Story" (每个 Story 最大重试次数, = the QwenPaw zh original of maxRetriesPerStory); ~70 new keys registered (zh/en), full cross-check 0 missing 0 duplicates
- **KB listing on large workspaces — root-cause fix for HTTP 413**: the old channel tarred the entire workspace and uploaded it to the Controller for listing (top level >20MB → 413; an 180MB production workspace always failed) → two channels: in-container `exec find` as the primary path (zero download, one request returns the full file list) with the tarball demoted to single-file reads / legacy-version fallback; top level and memory/digest subtrees covered by the same channel; +7 regression tests; live end-to-end verification: 180MB / 176MB / 21MB real workspaces list in 0.16–0.22s, all 200 (previously 413)

**Verification**: tsc 0 · pytest 57/57 · vite build 2,128.77kB · browser harness 13.7 24/24 + 13.8 35/35 (real React+antd mount: seven tabs / L2 read-only gate / L1 full values / 4 template tags + 4 gate checks + dialog preview / terminology / no page error) · i18n 1241 dict keys / 1137 used keys 0 missing 0 duplicates · antd reference cross-check 38 · dist anchors 14/14 + stale terms 0 + ant-slider=0 · sensitive scan 0 · live end-to-end (180MB workspace 0.22s 200)

---

## 0.5.0-beta.13.7 (2026-09-22)

**QwenPaw-style session message folding + session list hover-expand + loop settings aligned to the QwenPaw gate pipeline + chat rendering parity**

- **Session window messages now fold QwenPaw result-only**: each response turn shows only its last text (assistant bubble); intermediate tool calls/reasoning collapse into "N steps" pills with lazy rendering (collapsed = children not rendered at all, rendered only on expand); root-cause fix for tool blocks degenerating into raw JSON output (tool name was read from the wrong nesting level — it lives inside the data block); error messages stay always visible (QwenPaw behavior: errors are never folded)
- **Session list hover + click-to-expand**: long session names elide in a flexible column; hover shows the full name; click expands inline (full name + session ID), click again to collapse; the channel/activity/action columns each narrow to make room
- **Loop settings aligned to QwenPaw (slider retired)**: the iteration limit moves from a basic-tab slider to the Agent Loop → iteration gate (enable switch + number input 1..500 — the QwenPaw config surface has no sliders); the legacy top-level field is mirrored on save; added the doom-loop gate (window / similarity threshold / add-edit-remove intervention stages) and the completion rubric gate (rubric prompt / max interventions); added Goal/Mission built-in parameters (max iterations / token budget / retries per story / verify instructions / verify command); fixed the doom-loop window field name (window_size)
- **Runtime config surface full reconciliation**: memory backend is now editable (L2 whitelisted key — the old read-only label was wrong); the System tab gains read-only rows for LLM concurrency / QPM / rate-limit pause / jitter / slot acquire timeout / max input length / history length (QwenPaw rate-limiter card pattern)
- **Chat message rendering parity**: tool messages get status coloring (call / success / failure, failure name in red) + sectioned expansion (args / result / error, failure tinted red); markdown code blocks match the dashboard pattern (light card + border + copy button on hover only)
- **i18n**: ~60 new keys registered (zh/en)

**Verification**: tsc 0 · pytest 50/50 · vite build green · browser harness 24/24 (real React+antd mount: list expand/collapse / result-only folding with lazy render / no slider in basic tab / gate value ranges / window_size source / diff enables save / failure status color / hover copy button)

---

## 0.5.0-beta.13.6 (2026-09-22)

**Element-style chat timeline rebuild + session window scroll root-cause fix + runtime config panel aligned to QwenPaw console**

- **Element-style chat timeline**: plain-text messages drop the bubble box (flat timeline + hover row pill) — the old per-message colored boxes read as "ugly message boxes"; date separators become Element-style centered pills
- **History scrolling fixed (root cause)**: loading older messages (50 prepended) yanked the viewport to the very top — the anchor is now preserved on prepend (layout effect, restored before paint, no visible jump); scrolling within 40px of the top auto-loads older history (Element-style infinite scroll, explicit button kept); an "earliest messages" end marker; prepending no longer mis-counts as "new messages"
- **Session window scroll fixed (root cause, browser-harness proven)**: the 13.5 detail view used grid + align-content:end — when content exceeds the container, top overflow lands in the non-scrollable zone (scrollTop stays 0) and the upper half of the conversation was unreachable; replaced with a plain block flow + JS scroll-to-bottom (harness-verified scrollable)
- **Session list drops the "user" column**: five columns reduced to four (session / channel / last activity / actions) — the user column was unreadable and meaningless for worker-perspective sessions
- **Runtime config panel rebuilt to the QwenPaw console pattern**: the single crammed row becomes four tabs (Basic / Agent Loop / LLM Retry / System read-only) — each tab a Card with form rows (label + hover info tooltip left / control right); max iterations is a slider with value readout; retry fields auto-disable when the retry switch is off; data scope unchanged (whitelisted keys + diff-only changed keys), presentation only
- **Session-level loop state display location settled (source: QwenPaw console LoopModeSelector)**: moved from the session detail header to the **chat composer** (1:1 worker room; polls the room's active loop — running = blue pulse / awaiting input = amber + mode name + hover description; legacy runtimes (404) hide it)
- **"Room list" button no longer overlaps the back button**: after collapsing the list in wide mode, the toggle is injected at the top-bar prefix slot (Element hamburger position) instead of floating over the back button
- **Download destination made explicit**: every download (artifact preview / project files / workflow artifacts) shows a success toast with the target directory and file name
- **i18n**: 25 new keys registered (zh/en)

**Verification**: tsc 0 · pytest 50/50 · vite build green · browser harness 2 cases (grid-alignEnd unscrollable → block flow scrollable)

---


## 0.5.0-beta.13.5 (2026-09-22)

**Session window layout fixes (2) + artifact "view" behavior fix + runtime config panel endpoint reconciliation (#1231 endpoint family, 7/7 wired)**

- **Session list horizontal overflow fix**: the session table previously used five fixed column widths (528 px total) plus a 500 px minimum scroll width — when the drawer width was constrained by the window, the table grew a horizontal scrollbar and the "View" button got pushed to the far right (only reachable by dragging the bottom scrollbar). Now fixed table layout + container-relative column widths (unfixed columns share the remaining space, long values ellipsize inside the cell): no horizontal scroll at any drawer width, "View" always visible
- **Session context view scroll fix**: the session detail (agent context view) message area previously had a 420 px magic-number cap — on short windows the content was clipped by the drawer bottom and could not scroll. Now a container-relative height chain (detail area = the drawer's full remaining height, message area flex-scrolls, zero magic numbers); scrollable at any window size
- **Artifact "view" no longer collapses the panel**: the topology task row's expand toggle was previously bound to the whole card — clicking "View" bubbled up, toggled the row closed, and the preview modal unmounted with it ("clicking view collapsed the menu"). The toggle is now on the header row only; button clicks inside the expanded area no longer collapse it
- **Runtime config panel endpoint reconciliation**: the panel previously consumed only 1 of the 7 #1231 endpoint-group calls (runtime-config). This release wires the rest against the upstream contract —
  - **Loop mode catalog** (GET /loops): builtin/custom/plugin modes as color-coded tags (name + slash command + hover description)
  - **Custom loop CRUD** (GET/POST/PUT/DELETE /loops/custom): list rows with an enable switch (whole-object rewrite), id / name / slash command / gate count, and delete (with confirmation); creation via a full-JSON form (409 duplicate / 422 pipeline-validation errors surfaced verbatim)
  - **Per-session loop status** (GET /loops/status): wired into the session detail header — the active loop mode of that session shows as a tag (blue while running, default otherwise); older runtimes (404) hide it automatically
  - **Memory config surfaced**: the reme light memory / adbpg memory fields (contract 5-tab fields) show configured / not-configured, read-only, with a collapsible config JSON view
- **UI copy cleanup**: internal PR-number references removed from the runtime config panel (panel/banners no longer show #1231)
- **i18n**: 23 new keys registered (zh/en)
- **Gates**: tsc 0 / build 2054.71 kB / pytest 50/50 / window-shell-harness 4/4 / i18n 0 missing / dist anchors 9/9

## 0.5.0-beta.13.4 (2026-09-22)

**Container-relative height chain (root-cause scroll fix) + QwenPaw-style session window + unified result-artifact display +  runtime config panel**

- **Chat list scroll root-cause fix (the true cause of the beta.13.2/13.3 full-page scroll)**: the shell height was previously derived from a `100vh − topBar` magic number — the plugin container's outer height is fixed by the host (QwenPaw panel / browser window) while `100vh` tracks the OS window, so the two diverge: enlarging the window made the shell overflow its container (measured: 125 px overflow at a 1389 px window = exactly the bottom control strip pushed out of view) → the page scrolled and the input area was clipped. The whole chain was reworked to **container-relative heights** (Element model: flex container chain + `min-height: 0`, zero magic numbers, `100vh`/`100svh` removed from the plugin code entirely); the shell now follows the host container at any window size. Reproduced and verified by the jsdom harness `window-shell-harness.mjs` (old chain: 125 px overflow → new chain: 0, list scrolls internally, input pinned at the bottom and fully visible)
- **Session window rewritten to the QwenPaw Sessions standard**: opening a session now shows the worker's full QwenPaw session list on the right (session state / turns / token stats / last active), and selecting a session shows message detail + the session's produced-file list (open to preview or download); sessions, messages and files are all version-gated with graceful fallback when an endpoint is missing
- **Unified result-artifact display**: result-artifact "view/download" previously existed only in the team task list (dashboard standard) — topology-node task rows and plugin workflow-card tasks now have it too (shared `ArtifactLines` component, one standard across all three surfaces)
- **Third worker-management panel "Runtime config" (, consumes upstream #1231)**: workers with `spec.runtime = qwenpaw` can view/edit runtime settings with the same field names as the QwenPaw config panel — `loop.max_iters` (form + full-JSON advanced editing with validation); `approval_level` / `memory_manager_backend` / `context_manager_backend` / `shell_timeout` / model shown read-only; saving a loop change notes that the team Leader will be notified; 409 (worker running) / 403 (L2 scope) render friendly banners; non-qwenpaw runtimes show an unsupported notice
- **i18n**: 25 new keys registered (zh/en)
- **Quality gates**: tsc 0 / build 2046.26 kB / pytest 50/50 / window-shell-harness 4/4

## 0.5.0-beta.13.3 (2026-09-22)

**Chat height-chain regression fix + workflow task cancel / result-artifact dashboard parity**

- **Chat main list scrolling regression fix (introduced in beta.13.2)**: the relative wrapper added for jump-to-bottom lacked `min-height: 0` — an overflow-visible flex middle layer's automatic minimum size is its content's minimum size, so the list's `overflow: auto` clamping did not propagate through it; the wrapper stretched to the full message height (measured 7500+ px) and the list lost independent scrolling: wheel input bubbled into **page-level scrolling** and back-scrolling pushed older messages out of view (Element/dashboard keep a bounded height with internal scrolling). Proven by an A/B browser harness (13.2: list 7532 px / not scrollable; fixed: 367 px / 7165 px internally scrollable — identical to 13.1 item for item)
- **Workflow: task-level cancel in the inspection drawer**: cancel was previously reachable only from the kanban card — opening a task's detail (topo/card view) removed the entry, while the dashboard task row keeps it in every context. The kanban card and the drawer now share one cancel modal (reason required, terminal-status gate, upstream 409 idempotent convergence); a successful cancel refreshes the board
- **Workflow: result artifact (result_path) surfaced**: dashboard task rows show the result-artifact link while the plugin typed the field but never rendered it — the drawer now shows a "Result artifact" section with view (FilePreview) + download, and the topo task detail row shows a result_path hint line
- **i18n**: 1 new key registered (结果产物 / Result artifact)

**Verification**: tsc 0 · check-antd 38 · i18n 0 missing (934 used / 1020 defined) · vite build green · pytest 50/50

## 0.5.0-beta.13.2 (2026-09-21)

**Chat UX overhaul: dot-source fix (no more false green) + thread avatar dots + jump-to-bottom**

- **Session status dot source fix (root cause of "always green")**: the done fallback previously used the **room-level last_ts** — the user's own message in a room refreshed it and turned every worker in that room green (for up to 10 minutes). Now **per-sender** (same source as dashboard 9a9cc8d): the backend `/teams/sync` room entry carries `last_sender` (MXID of the last message's sender), and the frontend done fallback only counts the worker's **own** last message (<=10 min, then decays to gray). When heartbeat fields are present (Controller >= worker-agent-status contract) done is driven solely by `lastFinishAt` (task-level finish) and the fallback never fires; in team rooms a human message no longer turns any worker green, and a message from worker A only turns A green
- **Thread avatar status dots**: the thread panel's root-message avatar, the reply-list avatars, and the thread summary's "last replier" avatar in the main list all get the same corner dot (6px dot + white ring + tooltip; workers only, humans get nothing)
- **Jump-to-bottom (Element JumpToLatestButton-style interaction)**: main message list + thread panel — a floating circular "down" button appears at the bottom-right while the user is scrolled up; incoming non-own messages away from the bottom accumulate an "N new messages" badge; clicking smooth-scrolls to the bottom and clears the count; the 120px near-bottom threshold is shared with auto-follow (it never fights the user's back-scrolling); switching rooms resets the state and sticks to the bottom; the user's own sends are never counted (the send path already scrolls to bottom, preventing a race-induced false count)
- **done-to-idle decay tick 60s -> 15s** (aligned with the dashboard useSessionTick direction; pure derivation, zero network cost)
- **a11y**: status dots get `role="img"` + `aria-label` (screen readers announce the state; same fix the dashboard #127 maintainer applied at merge time)
- **i18n**: 2 new keys registered (zh + en)

**Verification**: pytest 50/50 (incl. 4 last_sender regressions), tsc 0, derivation logic live-run 11/11 (incl. "user message does not turn green" regression), vite build green

---

## 0.5.0-beta.13.1 (2026-09-19)

**Worker built-in tools + read-only chats panel (putting a head on the headless QwenPaw worker)**

- **Built-in tools tab (Team management)**: consumes upstream #1255 (merged to main) controller endpoints - per-worker "enabled / async execution" switches (optimistic update with rollback), `requiresConfig` shown as a badge only (tool config values are redacted at the controller proxy boundary and never surface in any client), 404 version-gate placeholder (older controller / L2 cross-team hide, one neutral banner by design), PATCH 403 (team leader read-only / L2) flips the whole panel read-only
- **Worker sessions (entry = click the worker avatar in the room, settled 9/19)**: consumes upstream #1295 chat endpoints (ready, awaiting review) - **entry moved out of team management** (the former chats tab removed; sessions belong to the chat context, and the goal is the worker's full sessions, not a last-activity list); in a group/DM, click a worker avatar -> popup / right-click "View Sessions" -> a drawer with the chat list (name / channel / last activity, pinned & archived tags) and a detail view with a constant **agent-context banner** (the agent's working context may include compacted history and unsent tool calls/output, distinct from sent room messages), conservative content-block rendering (text straight, tool blocks compressed to labels, unknown shapes truncated JSON), idle/running status tag (hidden on 404 = QwenPaw < 2.2.1, version-agnostic gate), 404 list = placeholder banner (older controller / L2 room-boundary exclusion, indistinguishable by design)
- **Session status light moves to the avatar corner (settled 9/19)**: blue (running, 1.2s breathing) / green (finished within the last 10 minutes) / gray (idle), moved from beside the sender name to the **bottom-right corner of each worker avatar in the room** (7px dot + white ring + tooltip; heartbeat-first derivation, human senders have no mapping and show nothing) - same placement as dashboard 330257e
- **Member avatar strip (settled 9/19: mimic the dashboard member list)**: a member strip on the room header's right side - worker avatars carry the same session dots; overflow collapses into **+N which expands in place on click** (collapse again to fold; on narrow screens the header wraps it below the title row); clicking an avatar opens the member panel (the existing drawer with all members, @mention and details - its avatar rows get the same dots) - zero new requests (members from the existing sync state, states from the existing derivation)
- **Data plane**: both reuse the existing generic Controller proxy (`/api/agentteams/*` pass-through) - zero new backend endpoints; read-only endpoints carry no audit (upstream-consistent precedent)
- **i18n**: 27 new keys registered (zh + en)

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
- **Worker session status dot (heartbeat-first)**: three states (blue running breathing / green done / gray idle) on group-chat sender avatars + wide-screen split layout; data source = worker heartbeat agentStatus authoritative (no 120 s typing ceiling) → live typing fallback → 10-minute done→idle decay
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
- **Workflow tab auto-refresh **: silent 15-second polling while the tab is visible (stops when you switch away), matching the dashboard's 15s polling real-time — the workflow board previously refreshed only on mount / manual refresh / login, so task progress did not update automatically
- **Comment & copy precision**: the "upstream not merged" wording in the channel-access and skill-catalog sections is updated to "Controller version gate" (the relevant endpoints are merged into the upstream mainline; only Controllers predating the merge return 404 and show the placeholder)

**Verification**: pytest 42/42 (+6 new: KB/approval L2 fallback) · tsc 0 · vite build green (439 modules) · i18n ui↔dict reconciliation (all new keys registered, orphan keys cleared)

---

## 0.5.0-beta.12.4 (2026-09-15)

**New: Worker session status indicator (zero backend changes)**
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
