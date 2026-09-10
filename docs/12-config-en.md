# Configuration Reference

Three inputs on the Settings page: **Matrix address** (required) + **auth mode** (pick one) + **Controller address** (effectively required — L1 auth, CRD management, model-gateway derivation and full views all depend on it; only L2 room-side features work without it). Saved settings persist locally (browser + plugin backend) and survive restarts/upgrades.

## Matrix address (at least one required)

- Two entries — LAN + WAN (`http://lan-ip:6867` / `https://domain:6867`); one is enough
- LAN/WAN are two access paths to the same server — **no manual switching needed**: the plugin automatically re-measures all addresses on a schedule (latency, one retry on failure), auto-switches to the fastest reachable one, and detects LAN/WAN transitions
- The "current" badge on the page shows the address in effect right now

## Auth mode

Three tiers: **L2 Matrix login** (default) / **L1 admin** (two credential methods, either/or — since beta.12).

| | Matrix login (L2, default) | L1 admin |
|---|---|---|
| Input | Your own **Matrix account + password** (handed over at onboarding) | one of two credentials (below) |
| Persistence | login session (switching accounts = switching data sources: local caches are cleared and refetched) | persisted after successful verification, **remembered permanently** |
| Capabilities | Teams your account can access + project operations (start/pause/artifacts) + chat/approvals/notifications/knowledge base | Everything in L2 + CRD management (onboarding/team creation/reconfiguration/deletion) + full Worker/Team status + cluster load |

After login the "current identity" (your Matrix mxid) is displayed.

### L1 admin: two credential methods, either/or (since beta.12)

| | ① Controller admin token | ② admin account + password |
|---|---|---|
| Input | **Pasted token content** (the UI provides the fetch command with one-click copy; leave empty when the env `AGENTTEAMS_CONTROLLER_TOKEN` is injected at deploy time) | admin account + admin password (+ Higress URL, required) |
| Unlocks | **Full Controller admin API**: CRD management, full Worker/Team views, cluster load, cross-team projects/artifacts | **Higress side**: holds a Higress Console session → Higress alias candidates in the model dropdown (AI routes + providers) |
| Verification | "Verify" button (GET /api/v1/teams, no trailing slash — Gin returns 404 for /teams/) — persisted only on success | "Verify" button (POST /session/login) — persisted only on success; empty password = keep existing, never echoed back |
| Prerequisite | No API can issue it (upstream security design) — provided offline by the deployment admin; **the token lives on tmpfs — every controller container restart mints a new one** (app.go: "free token rotation on every container start"), a pasted token is a snapshot — after a controller restart/rotation, re-fetch via the "Token fetch command" section and paste again | Higress URL = **required** (beta.12 decision: the Console shares the Controller's container on a different port, but the host port is operator-chosen at install time — `AGENTTEAMS_PORT_CONSOLE`, default 18001, differs per deployment → the 8001/6868 blind probe was removed; an empty value returns an actionable error) |

> **Port map (measured 8/14)**: host 6866=Controller API (container 8090) / **6868=Higress Console (container 8001)** / 6867=Higress data plane (container 8080) / 6869=Element+console (container 8088). Plugin Controller address = `http://<LAN-IP>:6866`; Higress URL = `http://<LAN-IP>:6868`. **This port map was chosen at the node's install time (install-script prompt, default 18001) — a different deployment maps different ports, and the plugin makes no port guesses (since beta.12).**

> **The two credentials do not substitute for each other**: ② cannot mint a Controller data-plane credential (the controller has no token-issuance endpoint) — after password-mode verification, L1 capabilities like CRD management stay locked; only the gateway aliases appear in the model dropdown. The UI states this explicitly.

### Token fetch command and env injection (beta.12 decision: file path removed, command kept)

The token has no API to fetch it (upstream security design) — the deployment admin provides it offline. Two supply paths (the Settings UI shows the fetch command with one-click copy; resolution precedence is computed per request on the connector side):

1. **Paste** (docker deployments, `tokenSource=config`) — run on the **Controller host**:

   ```
   docker exec agentteams-controller cat /var/run/agentteams/cli-token
   ```

   Copy the output into "Paste the token content". The pasted value is a snapshot — after a controller container restart/rotation (tmpfs mints a new token), re-run the command and paste again.
2. **Env injection** (non-docker / one-time at deploy time, `tokenSource=env`) — set `AGENTTEAMS_CONTROLLER_TOKEN` on the QwenPaw host process and leave the paste field empty.

Behavior rules:

- Pasted content with invisible / full-width characters → a clear "token contains a non-ASCII character (located)" error, not a raw UnicodeEncodeError
- Env values are **never persisted** (config stays empty); the pasted value is stored in the connector's local config (local machine only, see above) — after token rotation (controller re-signs), re-fetch via the command and paste again
- **The token value never leaves the QwenPaw process**: the browser/frontend only ever sees the `controllerTokenSource: "config"|"env"|"invalid"|""` source marker (since beta.12, `file`/`file_unreadable` no longer exist)

> **Security decision (why not password→token minting)**: the Controller has no token-issuance endpoint of any kind (upstream security design, not a defect) — a browser-side password→token exchange does not exist architecturally. The only safe equivalent is "injection at deploy time" (dashboard F1g decision B). The password still unlocks the gateway side (Higress Console) only; the token (config or env) unlocks the Controller admin API; both coexist.

> **Level-2 note**: the Controller's Matrix auth only accepts **level-2 Human accounts** — level-1 admin accounts get 401. If L2 mode 401s: use L1 token mode, or ask the deployment admin to change that Human to level 2 (the "permission self-check" on the Self-check page shows your current level).

## Controller address (optional)

**Only needed for the full cross-team views** (cross-team project/artifact overview, L1 cluster load).

- You can enter multiple addresses (primary/backup, multiple LAN/WAN entries)
- On save, **latency is measured per address** (one retry on failure), LAN/WAN is identified, and it **auto-switches to the fastest**
- **Adaptive re-probing** in the background: low frequency when stable; a single address is not probed (nothing to compare)
- What gets measured is the *unsaved* address — the latency-based switch takes effect only after saving
- If left empty: room-side features (chat/approvals/attachment scanning) work as usual; cross-team overviews are unavailable

## L1 / L2 permission matrix (full)

| Capability | L2 | L1 |
|------------|:---:|:---:|
| Team/Worker lists (accessible scope) | ✅ | ✅ (full) |
| Chat / approvals / notifications / knowledge base | ✅ | ✅ |
| Project operations (start/pause/resume) | ✅ accessible projects | ✅ |
| Project artifacts (incl. projects you're not a room member of) | ❌ | ✅ |
| CRD management (team creation/onboarding/reconfiguration/deletion) | ❌ | ✅ |
| Inline Worker model editing | own team only | ✅ |
| Channel config writes | own team only | ✅ |
| Skill matrix / MCP matrix writes | own team only | ✅ |
| Cluster load (SGLang/GPU) | ❌ | ✅ |
| Gateway aliases in model dropdown (gateway side) | ❌ | ✅ (needs ② password-mode verification) |

## Token security

- Stored **on this machine only** (browser localStorage + the plugin backend's local config) — zero-credential principle: page JavaScript never holds Matrix/Controller credentials directly; everything goes through the in-host in-process proxy
- The token has no API to fetch it (upstream security design); the deployment admin provides it offline; two supply paths: UI fetch command + paste (stored in the connector's local config) or the host env `AGENTTEAMS_CONTROLLER_TOKEN` (see "Token fetch command" above). The token **value never reaches the browser** — the frontend only ever sees the source marker (`tokenSource=config`/`env`)
- The admin password / Console session are also local-only; config exports always redact them as `***` (import never overwrites stored credentials)
