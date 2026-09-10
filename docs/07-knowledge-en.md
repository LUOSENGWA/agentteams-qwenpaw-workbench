# Knowledge Base

Browse, search, and graph team knowledge: local (host) and remote (team Agent) files unified in one screen, cross-agent search, and a 2D/3D force-directed knowledge graph.

## File browsing (four categories)

Aligned with the latest QwenPaw file management, four categories:

| Category | Content |
|----------|---------|
| 📄 Files | regular files |
| 🗄️ Archives | archived material |
| 📔 Diary | diary/log entries |
| 📚 Knowledge | accumulated knowledge (MEMORY/digest etc.) |

- Every file carries a **source badge**: local (host workspace) or remote (team Agent workspace), with two category color palettes to tell them apart
- Team Agents' workspaces are read through the Controller proxy (L2 limited to your team)

## Cross-agent search

- One search box queries **all accessible Agents'** knowledge files (`/kb/search`)
- Results are badged with the source Agent; click through to file preview

## Knowledge graph (2D/3D force-directed)

- **Merged team graph**: aggregates the knowledge links of all team members (`/kb/graph/merged`); an in-page team Select switches teams (defaults to the current Agent's team)
- **2D / 3D modes**: 3D needs WebGL; browsers without it **auto-fall back to 2D** (no error)
- Tiered node colors: root (virtual category root, orange) / category / file; **node size = degree**
- **Clicking a file node opens its preview directly** (2D/3D alike; virtual roots / unresolved references keep the hint)
  - slow responses can never clobber a later click (request-sequence guard)
  - re-clicking the same node refreshes the preview
  - in 3D, a light tap (<5px and <500ms) counts as a click; orbit-drag never misfires

## Permissions

- L2: files/graphs for teams your account can access
- L1: all teams
