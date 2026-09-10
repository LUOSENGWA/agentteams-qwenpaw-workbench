# Acknowledgments

The development of agentteams-qwenpaw-workbench draws on and reuses
results from several open-source projects. Entries are registered in
three classes by **depth of borrowing**, each with its source noted — a
basic respect for the open-source community's work.

中文版：[ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md)

## 1. Ported code (source-level reuse, provenance noted at each site)

### QwenPaw ([agentscope-ai/QwenPaw](https://github.com/agentscope-ai/QwenPaw), Apache-2.0)

| Ported content | Upstream source | Landing spot |
|----------------|-----------------|--------------|
| Knowledge-graph node detail panel (status badges "indexed files / unresolved links / category root" + clickable out-links·n / in-links·n lists + open-Markdown + node description) | `console/src/features/files-workspace/MemoryGraphView.tsx` | KB graph detail panel (shared by 2D/3D) |
| 3D graph rendering recipe (custom node structure, layout params charge -108 / link distance 72 / alpha decay 0.038, four-light lighting rig, FogExp2 fog, camera `fitGraphModel` three-timing adaptation, zoom limits, node radius / label rules) | same (MemoryGraphView 3D branch) | `frontend/src/components/Graph3D.tsx` (provenance in file header) |
| Four-level tool-execution-security card selector (icon mapping STRICT=Ban / SMART=AlertTriangle / AUTO=Shield / OFF=CircleCheck + whole-card click select + official info hint row) | official console `ToolExecutionLevelCard` + official docs `website/public/docs/security.zh.md` execution-level chapter | approval component `ApprovalControl.tsx` |
| Official approval-mode description content (official four-level table text + console screenshot hot-links + console management feature list) | same (official docs security chapter) | approval component "Description (official)" |
| 3D component version baseline (three 0.185.1 / 3d-force-graph 1.80.0 / three-spritetext 1.10.0) | `console/package.json` | build dependencies |
| README installation-instructions format | QwenPaw official docs "Plugin System" chapter | this repo's README / README-en |

The ported code above follows Apache-2.0 requirements: source-file header
comments note the upstream provenance; full license text in the QwenPaw
repo's LICENSE.

### agentteams-dashboard ([agentteams-group/agentteams-dashboard](https://github.com/agentteams-group/agentteams-dashboard), license not declared)

| Ported content | Upstream source | Landing spot |
|----------------|-----------------|--------------|
| TruncatedId long-identifier truncation component (>16 chars "first 8…last 4" + hover full value + one-click copy) | `manager-card.tsx` | `frontend/src/components/TruncatedId.tsx` (provenance in file header) |
| Docker log stream parsing algorithm (8-byte header type+size+payload) | `parseDockerLogs` | `agentteams_connector/router.py::_parse_docker_stream` (independent TS → Python rewrite, algorithm aligned bit for bit) |
| Task board state mapping (workflow state → board column, 14 cases aligned one by one) | `workflowToBoard` (#85) | `frontend/src/components/WorkflowBoard.tsx` |
| Component-name → container-name mapping (`resolveContainerName`), ops data-source endpoint selection | ops panel | `router.py`, `OpsPanel.tsx` |
| Workflow state color coding / three-view layout design | project workflow page | `WorkflowCard.tsx` / `WorkflowBoard.tsx` |

## 2. Interop protocols & mechanisms (API / protocol-level integration, not code copying)

### AgentTeams / HiClaw ([agentscope-ai/AgentTeams](https://github.com/agentscope-ai/AgentTeams), Apache-2.0)

- `agentteams.workflow` event format (workerflow `nodes` DAG: id / subagent /
  task / dependsOn) and project/task-level state semantics
- TeamHarness tool-message display format (`🔧` / `✅` prefix renderer convention)
- Long-message attachment metadata (`com.agentteams.long_message`)
- Deliverables mechanism (artifact publish → Matrix `m.file`)
- Three-tier credential chain design (L1 admin token / L2 Matrix token +
  Human CR scope filtering / room-aggregation fallback)
- Controller REST API (teams / workers / humans / projects / workflow /
  checkpoints / artifacts / docker proxy)

### Matrix CS-API v3 (open standard, [spec.matrix.org](https://spec.matrix.org/v1.11/client-server-api/))

Chat, threads (m.thread), read receipts (m.read + m.fully_read), invite
accept/decline, room muting (m.muted_room account data), edits (m.replace) /
removals, /sync long-polling, m.direct DM naming — all implemented against
standard CS-API endpoints.

### SGLang

Cluster load read-only `GET /v1/loads` REST interface (field semantics
checked against SGLang's `load_snapshot.py` source); no code referenced.

## 3. Interaction-design references (independent implementation, no code copied)

### Element Web / matrix-react-sdk ([element-hq/element-web](https://github.com/element-hq/element-web), AGPL-3.0 / GPL-3.0 dual license)

Chat UI interaction design patterns (UI behavior and layout thinking):
message-thread collapsing ("N replies"), reply-quote form (ReplyTile: left
color bar + small avatar + colored name + one-line preview), hover action
bar, `@mention` completion popover (@ trigger / substring match / ↑↓ keyboard
navigation), time-grouping rules (>24h or crossing local midnight),
timestamp hover de-noising, optimistic echo with three-state badges,
composer draft persistence, hidden send button in empty state, IME
composition guard, single-timeline room list (group/DM interleaved),
sender grouping, file-card form.

**AGPL compliance note**: this plugin contains no Element source files or
derived code; only interaction design patterns were borrowed (UI
interaction patterns are not subject to copyright), so the plugin's
overall license is not infected by AGPL. Should line-by-line porting of
Element code ever be required, it must be released under AGPL-3.0 at the
same time — not the case currently.

### Others

- The 2D force-directed knowledge graph, the md renderer (tables
  included), CSV parsing, the JSON highlight tokenizer, and the
  three-level fuzzy room-name search (substring / ordered subsequence /
  Levenshtein) are all in-house implementations with no third-party
  dependency.
- React 18 / antd 5 are provided by the QwenPaw host runtime (the plugin
  declares the type contract only; it does not bundle or distribute
  them).

## Related documents

- Bundled third-party component list with full license texts: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
