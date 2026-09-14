# 5-Minute Quickstart

## Step 1: open the plugin page

After install, the **AgentTeams Workbench** entry appears on the console home page — click it. It also opens as a PawApp desktop window.

## Step 2: configure (Settings tab)

Three inputs on the Settings page: **Matrix address (required) → auth mode (pick one) → Controller address (optional)**.

### ① Matrix address (at least one required)

Two entries — LAN + WAN (one is enough). LAN/WAN are two access paths to the same server, **no manual switching needed** — the plugin automatically re-measures all addresses on a schedule (latency) and auto-switches to the fastest reachable one; LAN/WAN transitions are detected automatically.

### ② Auth mode (pick one)

| Mode | What it needs | What it can do | For whom |
|------|---------------|----------------|----------|
| **Matrix login (L2, default)** | Your own **Matrix account + password** (handed over at onboarding; the "current identity" mxid shows after login) | View the teams this account can access; project operations (start/pause/artifacts); full chat / approvals / notifications / knowledge base | Day-to-day team members (L2 Humans) |
| **Admin token (L1)** | Paste the content of `/var/run/agentteams/cli-token` from the server (one-time; remembered permanently after saving) | Everything in L2 + CRD management (onboarding / team creation / reconfiguration / deletion) + full Worker/Team status views + cluster load | Deployment admins / cluster owners |

> Note: the Controller's Matrix auth only accepts **level-2 Human accounts** — level-1 admin accounts get 401. If your Matrix account is an admin, use L1 token mode, or ask your deployment admin to change that Human to level 2 (the permission self-check shows your current level).

### ③ Controller address (optional)

- **Only needed for the full cross-team views.** Enter one or more addresses (e.g. `http://<node>:8090`); on save the plugin measures latency to each and auto-switches to the fastest, then re-probes adaptively in the background (low frequency when stable; a single address is not probed).
- If left empty: the plugin works off room-side data (chat / approvals / attachment scanning still work); cross-team project/artifact overviews are unavailable.

Hit **Save & self-check** — the Self-check tab verifies L0-L3 item by item. Saved settings persist locally (browser + plugin backend) and survive restarts.

## Step 3: go

- **Home**: team/task/approval overview, click "Dispatch task" to pick a Leader
- **Chat**: join team rooms, @-mention members
- **Team management**: team structure, Worker status, model configuration
- **Self-check**: L0-L3 layered health checks anytime

## Permission cheat sheet (L1 vs L2)

| Capability | L2 (Matrix) | L1 (token) |
|------------|:---:|:---:|
| Team/Worker lists (within the account's accessible scope) | ✅ | ✅ |
| Chat / approvals / notifications / knowledge base | ✅ | ✅ |
| Project operations (start/pause/artifacts) | ✅ (accessible projects) | ✅ |
| CRD management (team creation / onboarding / reconfiguration / deletion) | ❌ | ✅ |
| Full Worker/Team status | ❌ | ✅ |
| Cluster load (SGLang/GPU) | ❌ | ✅ |
| Skill matrix / MCP matrix writes | own team only | full |

Full matrix in [Configuration reference](./12-config-en.md).
