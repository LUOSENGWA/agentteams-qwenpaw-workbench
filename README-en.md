# AgentTeams QwenPaw Workbench

**Version**: 0.5.0-beta.12 ｜ **Author**: LUOSENGWA
**Requirements**: QwenPaw 2.0 – 2.2 (`qwenpaw_version: >=2.0.0, <3.0.0` — 2.1+ unlocks host-skill details / knowledge graph / reindex; on 2.0 those features auto-degrade) + AgentTeams Controller (HiClaw cluster)

> 中文版本: [README.md](README.md)

## Overview

A team workbench for AgentTeams (HiClaw) clusters through QwenPaw: manage teams, workflows, projects, deliverables, workers and a 2D/3D knowledge graph, with in-room `@mentions` and approval of worker tool-execution security levels. Works both as an **in-console page** and a **desktop app window (PawApp)** — no host code changes required.

## Features

| Tab | Capabilities |
|-----|--------------|
| 🏠 Home | Teams / tasks / workers / artifacts / recent activity / cluster load overview + pending-approval cards (approve/deny via the host's native approval chain) + quick actions + host-skills entry |
| 💬 Chat | Team room chat (direct Matrix), thread panel, member detail cards, room favorites / mute / leave / delete (Element-style), "All" single timeline (group/DM interleaved), message search, `@mentions` |
| 🔔 Notifications | Notification center (aggregated inbox of `@mentions` / task progress; click a card to jump to the room and locate the message) |
| 🔀 Workflows | Four views (list / card / board / topology tree) + project task graph (pause / resume / replan) + current view & selected project remembered across reloads |
| 📦 Artifacts | Project artifact file tree + online preview + download |
| 👷 Team Management | Worker hierarchy tree, approval mode (4 tool-execution security levels: strict / smart / auto / off), Team / Worker / Human CRD management + team access matrix (L1), create workers while creating teams; "Channels" sub-tab (worker channel config / enable-disable / health check / restart / QR-code auth / conflict pre-check, pending upstream PR #1219); "Skill Center" sections (skill catalog, pending upstream PR #1211 / Worker × skill assignment matrix / MCP servers matrix) |
| 📚 Knowledge Base | Remote worker KB and local memory: browse, preview, download, 2D/3D knowledge graph (click a node to open the file preview directly) |
| 🎯 Host Skills | Skill management for the local QwenPaw instance (SkillPool — host skills, not worker skills) |
| 🔍 Self-check | L0-L3 layered self-check (L0 local environment / L1 connectivity / L2 auth & API / L3 per-room live test) |
| 🛠️ Ops | Cluster load, container logs (L1) |
| ⚙️ Config | Controller address / credentials, Matrix login, dark theme, start-page toggle |

## Documentation

Product-grade feature docs (bilingual, one page per feature): [docs/](./docs/README.md) ｜ [English](./docs/README-en.md)

## Installation

> Consistent with the official QwenPaw plugin docs: plugin operations can only be performed while QwenPaw is **offline**.

**Option 1: Console UI (recommended)**

1. Open the QwenPaw console → **Settings → Plugin Manager**
2. Click **Install** and select the ZIP file (`agentteams-qwenpaw-workbench-v0.5.0-beta.12.zip`, available in [Releases](https://github.com/LUOSENGWA/agentteams-qwenpaw-workbench/releases))
3. Refresh the console after install — **🏢 AgentTeams QwenPaw Workbench** appears in the sidebar

**Option 2: CLI**

```bash
# stop QwenPaw first, then install from a local path
qwenpaw plugin install /path/to/agentteams-qwenpaw-workbench-v0.5.0-beta.12.zip

# install from a URL (ZIP supported)
qwenpaw plugin install https://example.com/agentteams-qwenpaw-workbench-v0.5.0-beta.12.zip

# force reinstall (in-place upgrade)
qwenpaw plugin install /path/to/agentteams-qwenpaw-workbench-v0.5.0-beta.12.zip --force
```

**Option 3: GitHub Release URL**

```bash
qwenpaw plugin install https://github.com/LUOSENGWA/agentteams-qwenpaw-workbench/releases/download/v0.5.0-beta.12/agentteams-qwenpaw-workbench-v0.5.0-beta.12.zip
```

(The Console install dialog also accepts a URL.)

**Upgrading**:

- Console: **remove the old version first** in the installed list, then install the new ZIP (the host rejects re-uploading an installed plugin with 409 "Uninstall it first before reinstalling"; no in-place overwrite via UI)
- CLI: `--force` overwrites in place (see above)

Configuration (Controller address/credentials) is kept in the plugin config and preferences such as favorites in browser localStorage — both survive the upgrade.

## Configuration

Open the workbench → **⚙️ Config**:

1. **Matrix address** (at least one required): two entries — LAN + WAN (`http://<node>:6867`); auto latency probing, auto-switch to the fastest, periodic re-probe — no manual switching
2. **Auth mode** (choose one):
   - **L2 regular member (default)**: select "Matrix login" and enter your own Matrix account (username + password, delivered at onboarding). L2 can only read/write data within its `accessibleTeams` scope (upstream A2 auth + scope filtering)
   - **L1 admin**: paste the Controller admin token (`docker exec agentteams-controller cat /var/run/agentteams/cli-token`, one-time, remembered permanently after saving)
3. **Controller address** (optional, only needed for the full cross-team views): the AgentTeams Controller API address; multi-address failover supported
4. Click **Save & self-check** — the 🔍 Self-check tab verifies L0-L3 item by item (local environment / connectivity / auth & API / per-room live test)

## Uninstall

- Console: Settings → Plugin Manager → Installed → Remove
- CLI:

```bash
qwenpaw plugin uninstall agentteams-qwenpaw-workbench
```

## FAQ

| Symptom | Resolution |
|---------|------------|
| Console re-upload of a ZIP returns 409 | Remove the old version first, then install (or use CLI `--force`) |
| Self-check L1 fails (Controller unreachable) | Verify the Controller address and network; for multi-node deployments list all addresses |
| L2 shows "no permission" | Expected — L2 can only access its own team's data; admin operations such as worker config changes require L1 |
| 3D graph unavailable | Falls back to the 2D graph automatically when the browser lacks WebGL |
| Room not visible / cannot enter | You must be invited first (team-scope rooms are invited automatically by the platform; accept in the "Invites" area once invited) |

## Open-Source Acknowledgments

- **Bundled third-party components** (three.js / 3d-force-graph / three-spritetext / fflate / lucide, with full license texts): [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
- **Ported code / protocol integration / design references** (QwenPaw, agentteams-dashboard, AgentTeams, Element, etc., each with its source noted): [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md)

## License

This plugin is open-sourced under the **Apache License 2.0** (see `LICENSE` in the repository root), consistent with the upstream AgentTeams project. Third-party components bundled in the package (three.js / 3d-force-graph / three-spritetext / fflate / lucide) carry their own licenses, with full texts in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Changelog

Version history: [CHANGELOG.md](CHANGELOG.md) (中文) / [CHANGELOG-en.md](CHANGELOG-en.md)

---

> **Repository**: [LUOSENGWA/agentteams-qwenpaw-workbench](https://github.com/LUOSENGWA/agentteams-qwenpaw-workbench) (source + release packages; plugin registration ID is `agentteams-qwenpaw-workbench`)
