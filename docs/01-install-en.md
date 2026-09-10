# Install & Upgrade

## Prerequisites

| Item | Notes |
|------|-------|
| QwenPaw host | 2.0 – 2.2.x (plugin version gate `>=2.0.0, <3.0.0`) |
| AgentTeams cluster | Deployed Controller + Matrix homeserver (the plugin reaches them through an in-process backend proxy; credentials live server-side, the browser stays zero-credential) |
| Install media | The ZIP from the GitHub Releases page (`agentteams-qwenpaw-workbench-v0.5.0-beta.11.1.zip`) |

## Install

**Option 1: CLI (recommended)**

```
qwenpaw plugin install agentteams-qwenpaw-workbench-v0.5.0-beta.11.1.zip
```

**Option 2: Console**

QwenPaw console → plugin management → upload the ZIP.

After install, the **AgentTeams Workbench entry** appears on the console home page. The plugin also works as a standalone PawApp desktop window (same feature set in both forms).

## Upgrade

1. Remove the old version first (console plugin management → remove; or CLI uninstall)
2. Install the new ZIP (CLI supports `--force` for in-place overwrite)
3. Hard refresh the browser: `Ctrl+Shift+R`

Upgrades keep your configuration: Controller addresses and auth settings are stored locally (browser localStorage + plugin backend config) and survive upgrades.

## Uninstall

Console plugin management → remove the plugin. No server-side state remains (room messages and approval records live in Matrix/Controller, independent of the plugin lifecycle).

## Dual-version compatibility

| Host version | Behavior |
|--------------|----------|
| 2.2.x | Full feature set |
| 2.0 | Core features work; features depending on 2.1+ APIs (e.g. the host inbox approval bridge) auto-degrade — no crash, the entry points silently disappear |
| <2.0 / ≥3.0 | Registration refused by the version gate (expected) |

## Verify after install

Open the plugin page → **Self-check tab**: L0 (backend alive) should be green; then run L1/L2 to check connectivity and auth. See [Self-check & ops](./13-selfcheck-ops-en.md).
