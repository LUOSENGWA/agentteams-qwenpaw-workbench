# Architecture & Security

## Product form

- **Zero host-code changes**: a pure plugin (QwenPaw plugin spec) — installable into any 2.0–2.2 QwenPaw instance
- Both entry forms are feature-identical: in-console page / standalone PawApp desktop window
- Frontend = a React single-page app (built dist, zero bare imports, host blob-environment compatible); backend = the `agentteams_connector` package (in-process Python modules)

## In-process proxy & the zero-credential principle

```
browser page JS ──(local host API only)──> /agentteams-proxy/* routes (in the host process)
                                          │
                              agentteams_connector backend
                                          │ server-side credentials (stored locally)
                              ┌───────────┴───────────┐
                          Matrix homeserver      AgentTeams Controller
```

- **Zero browser credentials**: page JavaScript never holds Matrix/Controller tokens or connects to external services directly — every external call goes through the in-host in-process proxy; credentials live only on this machine (browser localStorage + the backend's local config)
- The proxy layer handles uniformly: multi-address auto-probing/switching, error normalization, and the L1/L2 permission gate (route-level interception)

## Sources of truth

| Data | Source of truth | Notes |
|------|-----------------|-------|
| Team/Worker CRDs, projects, skills, cluster status | Controller API | the single source of truth for structured data |
| Room messages, approvals, attachments, ``s | Matrix | room-side facts (views the Controller doesn't have) |
| Workflow execution trees | Controller (spawn source of truth) | the topology view renders from this |

## Permission model

Two levels — L1 (admin token) / L2 (Matrix level-2 Human) — with a route-level permission gate. The capability matrix is in [Configuration reference](./12-config-en.md). L2's boundary is exactly what that Matrix account can access in the cluster (room membership + project permissions) — nothing the plugin widens.

## Dual-version compatibility strategy

- Version gate `>=2.0.0, <3.0.0` (incompatible hosts refused at registration)
- Features depending on 2.1+ host APIs (the host inbox approval bridge) are **probed at runtime** — if the host lacks the API, the whole bridge disables itself silently and everything else is unaffected (on host 2.0, approvals still have the three in-plugin surfaces: toast / notification center / home card)

## Known limitations

| Limitation | Status |
|------------|--------|
| Skill-catalog section / channels section 404 placeholders | light up automatically once upstream PRs #1211 / #1219 merge (no plugin upgrade needed) |
| 3D graph falls back to 2D without WebGL | a browser capability boundary, auto-degradation |
| The host-inbox approval tab filters by session, so records under the synthetic `agentteams` session may not appear there | nav wobble / red dot / in-plugin approval cards are unaffected (the record itself is queryable via the host's full API) |
| Worker containers cannot accept Matrix room invites themselves (no Matrix CLI in the image) | an upstream platform limit — a Manager can join on their behalf; project-room invites are accepted manually from the Team management page |
| In group rooms, unmentioned messages never enter a Worker's consumer queue | Matrix/Worker protocol behavior (not a plugin defect) — every plugin command-sending path carries the triple @ to sidestep it |

## Security commitments

- Credentials stored on this machine only, never leave it (except the necessary Matrix/Controller API calls)
- No telemetry, no third-party reporting
- Open-source license: Apache-2.0; third-party components in [THIRD-PARTY-NOTICES](../THIRD-PARTY-NOTICES-en.md)
