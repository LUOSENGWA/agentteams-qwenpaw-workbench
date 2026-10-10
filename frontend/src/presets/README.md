# Coding CLI Scenario Presets (six dev scenarios × team mapping)

> **preset = a JSON template inside the workbench plugin** (no central
> service) → one-click `PUT /api/coding-cli/{cli}/settings` (through the
> connector proxy) + a generated MCP-binding suggestion list (reuses the
> existing McpSelector chain, zero new endpoints).
> Status: ready — these JSON files are the templates consumed by the
> scenario-template UI.

## Layered content (aligned with upstream #1344 four-layer method)

| Layer | What the preset manages | Landing point |
|---|---|---|
| ① Toolchain | Where the scenario SDK/CLI lives and how it enters the container (shared volume, path-reachable) | Docs + worker env (CR layer; the preset only generates suggestions, never edits the CR automatically) |
| ② Model/version | `model.name` in settings.json (not pinned; the user picks the tag) | `PUT /api/coding-cli/{cli}/settings` |
| ③ Knowledge/file sharing | MCP binding list + shared-volume path conventions | Existing MCP chain (dashboard dir + McpSelector) |
| ④ Artifact flow | HAP/APK/Web packages → MinIO → workbench approval | Docs convention (the preset generates the directory template) |

**The preset writes ② automatically** (settings merge-write; `ENC:` secrets
preserved); ①③④ are suggestion lists for a human to confirm (toolchain
touches the CR, MCP touches bindings — team-level decisions, never done
silently).

## Six templates

| File | Scenario | Team mapping | Artifacts |
|---|---|---|---|
| `p-harmony.json` | HarmonyOS AI development | sysdev (harmony-dev) / embedded | HAP |
| `p-web.json` | Web development | sysdev | dist package / static site |
| `p-android.json` | Android development | sysdev extension | APK/AAB |
| `p-ios.json` | iOS development (Linux-side code + docs level; builds return to macOS) | sysdev extension (limited) | project snapshot (.ipa on macOS) |
| `p-embedded.json` | MCU / embedded | embedded | .bin/.elf |
| `p-gencode.json` | Generic coding (minimal form) | any | any code artifact |

**One preset per worker at a time** (settings is a single file; a later
preset write overrides the earlier preset fields); switching = applying
another template (merge semantics keep non-preset fields such as secrets).

## Known boundaries

1. The preset never edits the CR automatically (env / toolchain / MCP
   bindings) — team-level decisions stay with a human (permission discipline:
   L2 does not write team-level resources).
2. The preset never pins versions (the user picks the tag; changes must
   re-run verify).
3. The iOS build boundary on a Linux worker (macOS-side backfill) is
   structurally the same as the HarmonyOS simulator fallback — stated
   explicitly, not hidden.
4. The model list (`QWENCODE_MODEL_OPTIONS`) is rendered from the CR env into
   settings; the preset only writes `model.name` and does not touch the list.
5. **arm64 note (p-embedded)**: the earlier `tools.useBuiltinRipgrep:false`
   suggestion was a field-semantics misuse (source-verified: the field only
   switches bundled rg → system rg, and only takes effect when
   `useRipgrep=true`). Actual behavior: qwen 0.25.0 on 16K-page systems
   degrades gracefully to the built-in grep with **no configuration
   needed**; to pin it manually use `tools.useRipgrep:false`. See the
   `arch_note` in `p-embedded.json`.

## Verification

1. Every template's settings patch passes the connector PUT contract tests.
2. `p-harmony` follows the HarmonyOS plan's L0/L1 verification gates.
3. `p-embedded` Pi arm64 degradation is covered by existing measurement
   (bundled ripgrep crash → graceful degradation to built-in grep).
