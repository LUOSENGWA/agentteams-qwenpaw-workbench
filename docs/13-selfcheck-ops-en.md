# Self-check & Ops

## Layered self-check (L0 → L3)

When something breaks, run the self-check first — each layer isolates one fault surface; the first red layer is where the problem is:

| Layer | What it checks | Red means |
|-------|----------------|-----------|
| **L0 local environment** | plugin backend alive + host QwenPaw version | plugin not installed properly / incompatible host version |
| **L1 connectivity** | every configured address (Matrix / Controller) probed, with error detail | network down / address typo / service not running |
| **L2 auth & API** | Matrix whoami + joined_rooms (+ Controller projects) | invalid token / wrong Human level (level 1 → 401) / API version unsupported |
| **L3 per-room live test** | per-room permissions + a real `[selfcheck] ping` | single-room permission / delivery issues (it actually posts a ping in the room — be careful in production rooms) |

- Run each layer alone, or all at once (`/selfcheck/all`)
- L2's permission self-check shows the **current Matrix account's permission level** (tells you whether an L2-mode 401 is a level-1 issue)

## Ops panel

> **Where runtimes show now (since v0.5.0-beta.12)**: the multi-runtime card (5 static cards + live counts) was **removed from the Ops page** — the static list was incomplete and it was in the wrong place. Runtime management lives in **Team management**: each Worker row and the Manager table show their own `runtime` (plus a `phase` badge, and 1:1 Worker rooms show the badge pair in the chat header), sourced from the Worker/Manager CR fields (zero new endpoints).

**Cluster load** (L1 only, optional module):

- Source = Controller `/api/v1/status` (same source as the dashboard cluster-status)
- SGLang / GPU load overview
- When the backend feature is off the endpoint 404s → the card simply **doesn't render** (silent, no error) — not seeing this module in L2 mode is expected

## Suggested triage order

1. L0 red → reinstall the plugin / check the host version ([Install & upgrade](./01-install-en.md))
2. L1 red → cross-check each address against Settings (with multiple addresses it names the failing one)
3. L2 red → read the error detail: 401 = auth (token / level); 404 = version
4. L3 red → single-room issue: check that room's membership/permissions, or test another room to see if it's systemic
5. All green but a feature misbehaves → check the known limitations in [Architecture & security](./14-architecture-en.md), then the browser console
