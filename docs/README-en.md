# AgentTeams Workbench Documentation

AgentTeams QwenPaw Workbench (`agentteams-qwenpaw-workbench`) is a **one-stop team collaboration workbench** for AgentTeams (HiClaw) clusters inside QwenPaw: team management, workflow tracking, project artifacts, team knowledge base & knowledge graph, team chat, approvals & notifications, and skill/MCP management — all in a single console page (or a standalone desktop window), with zero changes to host code.

- 中文文档：[README.md](./README.md)
- Version: v0.5.0-beta.11.1 (supports QwenPaw 2.0 – 2.2)

## Quick start (3 steps)

1. **Install**: `qwenpaw plugin install agentteams-qwenpaw-workbench-v0.5.0-beta.11.1.zip` (see [Install & upgrade](./01-install-en.md))
2. **Configure**: open the plugin page → Settings tab → default Matrix login mode (L2, no token); paste the admin token (L1) only if you need full management rights (see [5-minute quickstart](./02-quickstart-en.md))
3. **Go**: home overview, dispatch a task, join a team room, handle approvals

## Feature docs

| # | Doc | Contents |
|---|-----|----------|
| 01 | [Install & upgrade](./01-install-en.md) | Prerequisites, install / upgrade / uninstall, dual-version support |
| 02 | [5-minute quickstart](./02-quickstart-en.md) | First-time setup, L1/L2 permission choice |
| 03 | [Home](./03-home-en.md) | Collaboration overview, task dispatch, overview cards, pending approvals |
| 04 | [Team management](./04-teams-en.md) | Teams / Users / Managers / Channels / Skill Center sub-tabs |
| 05 | [Workflows](./05-workflows-en.md) | Events / Cards / Board / Topology views |
| 06 | [Artifacts & projects](./06-artifacts-en.md) | Project artifacts (Controller as source of truth) + room attachments |
| 07 | [Knowledge base](./07-knowledge-en.md) | Four categories, cross-agent search, 2D/3D knowledge graph |
| 08 | [Team chat](./08-chat-en.md) | Single timeline, threads, room management, message search |
| 09 | [Approvals](./09-approvals-en.md) | In-plugin approvals + host inbox approval bridge (@ mechanism explained) |
| 10 | [Notifications](./10-notifications-en.md) | Notification center, room invites, desktop toasts |
| 11 | [Skill center & MCP](./11-skills-en.md) | Skill catalog, Worker×skill matrix, MCP matrix |
| 12 | [Configuration reference](./12-config-en.md) | Address auto-probing, dual auth modes, L1/L2 permission matrix |
| 13 | [Self-check & ops](./13-selfcheck-ops-en.md) | L0-L3 layered self-check, cluster load |
| 14 | [Architecture & security](./14-architecture-en.md) | In-process proxy, zero-credential principle, known limitations |

## Requirements

| Component | Requirement |
|-----------|-------------|
| QwenPaw host | 2.0 – 2.2.x (on 2.0, 2.1+ features auto-degrade) |
| AgentTeams cluster | Controller (API source of truth) + Matrix homeserver (rooms/chat) |
| Browser | Modern Chromium-based (3D graph needs WebGL; auto-falls back to 2D) |

## License

[Apache-2.0](../LICENSE)
