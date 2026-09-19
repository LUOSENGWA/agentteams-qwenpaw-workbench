# Controller version compatibility (why some features are not visible)

The workbench gets its data from the AgentTeams Controller. Some features depend on **newer controller endpoints**: when your controller version lacks an endpoint, the matching UI **is not rendered** or shows a **404 placeholder card** — this is **expected behavior, not a bug**. This page lists every data-dependent feature and its controller requirement.

## Quick check

1. Find your controller version: `docker exec agentteams-controller cat /etc/agentteams/version` (or the dashboard about page)
2. Cross-reference the table: features marked **"not in v1.2.3"** are **all merged into upstream main and ship in the upcoming v1.2.4 release** (upstream is cutting it around 2026-09-20; this feature batch *is* the body of v1.2.4). Upgrading the node controller to v1.2.4 lights them all up automatically — no plugin changes needed.

## Features × controller requirements

| Feature (workbench UI location) | Data endpoint | Controller requirement | Behavior when missing |
|------|------|------|------|
| Spawn tree (Teams → Team, per-project spawn aggregation) | projects `/spawns` aggregation endpoint | **not in v1.2.3 / in v1.2.4** (`64a77b5f`) | spawn tree not rendered |
| "Allowed tools / Allowed skills" tags on spawn nodes (v0.5.0-beta.13) | spawn endpoint `subagent_allowed_tools` / `subagent_skills` passthrough | **not in v1.2.3 / in v1.2.4** (same `64a77b5f`) | tags not shown (zero-noise by design) |
| Channels sub-tab (Teams → Channels) | worker channel configuration proxy endpoints | **not in v1.2.3 / in v1.2.4** (#1219) | 404 placeholder card (expected) |
| Worker runtime configuration editing | worker runtime configuration endpoints | **not in v1.2.3 / in v1.2.4** (#1231) | entry hidden |
| Worker built-in tool settings | worker tools settings endpoints | **not in v1.2.3 / in v1.2.4** (#1255) | entry hidden (consumer side next batch) |
| Team-scoped KB file reads (L2 data plane) | team worker KB file endpoint | **not in v1.2.3 / in v1.2.4** (#1208) | layer unavailable |
| Audit event query | audit events endpoint | **not in v1.2.3 / in v1.2.4** (#1270) | auto-hidden |
| Chat / knowledge graph / workflows / model gateway browse / CRD management / approvals | endpoints already in v1.2.3 | **v1.2.3 and later** | normal |

## What's in v1.2.4 (verified on upstream main 2026-09-19; 58 commits since v1.2.3)

- All endpoints above + the body of this PR batch: L2 permission model (capability foundation #1220/#1237, L2 write surface #1274/#1276, approvals #1216, skills #1212/#1252), skill center extensions (#1238/#1211), task state transition engine (#1233), audit (#1270/#1278), model/heartbeat/MCP catalog endpoints (#1242/#1247/#1250), Matrix group sender isolation (#1235), project workflow rendering + inspection API (#1230), and more
- **Runtime upgrades**: QwenPaw Worker runtime → 2.2.1 (`4179b9df`), Manager runtime → QwenPaw 2.2 (`d6150f20`) — v1.2.4 images ship the new runtimes
- All merged into main (author: predominantly LUOSENGWA); the tag awaits the release cut

## Rule (no version gate on the workbench side)

- The workbench **applies no version gate**: everything is "render if the data is there, hide if not" — new features on an old controller are invisible (not errors), and old features on a new controller are all visible.
- Upgrading the controller does **not** require reinstalling/upgrading the workbench plugin: when the endpoints appear, the corresponding UI lights up automatically (the Channels sub-tab has a built-in 404 placeholder card as the transition).
- "upstream #n" = upstream AgentTeams PR numbers; commit ids = merge points on main (verified 2026-09-19).
