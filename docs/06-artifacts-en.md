# Artifacts & Projects

A one-screen aggregation of project deliverables: project artifacts (Controller as source of truth) + room attachments (room-side fallback scan).

## Two data planes

| Plane | Content | Source & conditions |
|-------|---------|---------------------|
| **Project artifacts (source of truth)** | Deliverables from projects registered via projectflow, organized by project/category, with file preview | Controller API. **With an L1 token you see everything** (including Leader-created projects you're not a room member of); without a valid token a "not connected" warning bar shows |
| **Room attachments** | Files posted in team rooms, scanned and aggregated by room/time | Matrix room messages — independent of Controller project registration; the only path for unregistered projects |

> Version note: if the Controller predates project-artifact support the source 404s → the page automatically shows room attachments only (a hint bar explains why), with no error.

## Project operations

For accessible projects (L2: your account's accessible scope; L1: everything):

- **Start / pause / resume** a project (write operations; button only appears when the Controller version supports it)
- **Artifacts** jump straight to this page for that project

## File preview

Click a file → preview (text/Markdown rendered; binaries show metadata). Project artifacts and room attachments share the same preview component.

## Common situations

- "No registered projects yet — projects registered via projectflow will appear here": the team hasn't run the projectflow registration; room attachments still show normally
- "No files in this category yet": the current category filter is empty — switch category or show all
- "Source not connected" warning bar: add an L1 token in the [Configuration reference](./12-config-en.md)
