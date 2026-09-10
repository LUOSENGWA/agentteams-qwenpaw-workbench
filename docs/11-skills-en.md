# Skill Center & MCP

A unified surface for team skills (Team Management → "Skill Center", three collapsible sections) plus the local host skills (a separate tab).

## The three Skill Center sections

### ① Skill catalog (read-only)

The Controller-side skill list (`GET /api/v1/skills`) — which skills are available in the cluster.
**Depends on upstream PR #1211 merging**: until then a 404 placeholder card shows (expected, not a fault).

### ② Worker × skill assignment matrix

Rows = Workers, columns = skills, checkbox = assign/revoke.

- Assigned state is **pre-populated** (you see the real state on open, not an empty form)
- Saving goes through the skills field of `PUT /workers` (**merge semantics** — only the skills field changes, no other Worker config is touched)
- **Permissions**: L1 can write; L2 is limited to its own team; rejections (403/404) show the reason explicitly, never silent

### ③ MCP Servers matrix

MCP Server list and assignment: **name / url / transport edited inline**, writable by L1.

## Host skills (separate tab)

"Host skills" = **this machine's own QwenPaw instance SkillPool** (the host's skills), not the Workers' team skills — renamed from "Skills" in v0.5.0-beta.11 to disambiguate, with a quick entry on the home page.

## Common situations

- The matrix opens empty: the Worker has no skills assigned (or L2 and the Worker is outside your team scope)
- A save is rejected: the hint carries the 403/404 reason (insufficient permission / Controller version doesn't support it)
- The skill catalog shows a placeholder card: it lights up automatically once upstream #1211 merges — no plugin upgrade needed
