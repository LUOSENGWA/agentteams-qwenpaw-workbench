# Changelog

Version history of agentteams-qwenpaw-workbench.
中文版：[CHANGELOG.md](CHANGELOG.md)

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
- Worker channel config extended: health check / restart / QR-code credential auth (auto-backfill) / pre-save conflict check / PUT hot-reload + read-back verification (lights up automatically once upstream PR #1219 merges; 404 placeholder until then)
- Skill center, three sections: skill catalog (lights up once upstream PR #1211 merges) / Worker × skill assignment matrix (assigned shown + save) / MCP Servers matrix (inline name/url/transport editing)
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
- Team-creation incident G1-G5 (CRD read-back + staged polling create self-check)
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
- The skill-catalog / channel sections depend on upstream PRs (#1211 / #1219); until they merge they show 404 placeholder cards (expected behavior)
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
