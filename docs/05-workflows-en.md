# Workflows

Execution views for team tasks/workflows. Data source: Controller projects/workflows (L2 limited to accessible projects).

## Four views (Segmented switcher; the chosen view persists across refreshes)

| View | Best for |
|------|----------|
| 📋 **Events** | the timeline — what happened in a workflow, replayed in order |
| 🗂️ **Cards** | one card per workflow — status/phase/owner at a glance |
| 📊 **Board** | tasks in phase columns (live counts) — team load and blockers |
| 🌳 **Topology** | execution force graph (live node counts) — dispatch chains and structure |

- The current view and the topology's selected runId **persist in page state** — refreshes / switching top tabs don't lose them
- **15s auto-refresh** (since v0.5.0-beta.12, A1, aligned with the dashboard `refetchInterval:15000`): silent polling only while the Workflows tab is active (stops when switched away, no flicker)
- If the selected runId becomes invalid (workflow ended/rebuilt), it auto-falls back to the first workflow with nodes — no blank page

## Topology details

- One execution tree per workflow: nodes = execution units (Worker task cells, filled from the spawn source of truth), edges = dispatch/dependency
- Only workflows with nodes appear in the topology view (the Segment count is the number of workflows with a topology)
- Click a node for details

## Relationship to other pages

- Home's "Task progress" card is the workflow count summary — clicking through lands here
- The Artifacts page aggregates deliverables per project; workflows are the process, artifacts are the results
- L2 users see only projects their account can access; L1 sees everything
