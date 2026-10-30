# ZCode real-host acceptance feasibility — Windows, 2026-10-30

Code baseline: `680b2f19b2dbef8831e3be1fd996203589b5c41d` (PR #3). This document records installed-source inspection and file metadata, not execution of a ZCode acceptance session.

## Installed environment

- Desktop executable: `C:/Program Files/ZCode/ZCode.exe`, product/file version `3.17.1.9553` (file metadata).
- Shipped CLI bundle: `C:/Program Files/ZCode/resources/glm/zcode.cjs`, source version `0.17.1` (separate version from the desktop executable).
- Research performed without launching a ZCode process, creating a conversation, reading saved credentials or existing user configuration, or changing config/trust stores.

## Supported interfaces found in installed source (not executed)

| Interface | Potential evidence | Current disposition |
|---|---|---|
| `zcode skills list --cwd ABS --json` | Native skill catalog/discovery | Blocked pending complete supported home/config isolation |
| `zcode skills inspect NAME --cwd ABS --json` | Native skill content/metadata loading | Same blocker; does not establish conversational triggering |
| `zcode hooks trust status --workspace ABS --json` | Declarations and trust state | Inspection only, same isolation blocker |
| `zcode hooks trust review --workspace ABS --json` | Commands/digests/sources | Inspection only, same isolation blocker |
| `app-server --stdio`, `skills/referenceCatalog`, workspace parameters without session ID | Workspace catalog without model conversation | Server startup not established isolated |

Relevant installed-source anchors: CLI help `zcode.cjs:14760`, skills handlers `:15606`/`:15613`, trust commands `:15542`, catalog `:15529`. The documented Settings → Skills / slash Skills UI inspection is a possible manual follow-up in a separately authorized disposable host environment.

## Why host launches are blocked

The shipped runtime defaults to `~/.zcode/cli/config.json`. Its configuration loader reads that file before environment overrides and can persist automatic plugin-identifier migrations. `ZCODE_STORAGE_DIR` changes storage location, not the user config path. Skill and trust roots separately resolve the real user home. Partial controls (`ZCODE_DATA_BASE_DIR`, `ZCODE_LOG_DIR`, telemetry's `ZCODE_HOME`) do not establish complete config/home isolation, and the public parser exposes no supported config/home/skip-user-config override. Internal dependency options are not a supported standalone CLI launch interface.

Installed-source anchors: configuration reading/migration `zcode.cjs:2180`, atomic migration writes `:2181`, default config constants/environment mapping/skill roots `:2182`, trust root `:1946`, public parser `:76`.

No supported native file-tool invocation CLI or hook-test API was found in the command/protocol method tables (`:88`, `:106`). Session-bound MCP calls are not native file-tool calls. Saved workflows require an initialized session app; external-command execution cannot be presented as a native Read/Write/Edit test.

The current workspace hook gate requires `workspaceHookTrustEnabled === true` (`:14905`); its explicit enabling path belongs to app-server session creation (`:15528`). Existing headless restrictions therefore remain material.

## Per-check status

Fresh-conversation skill discovery, live hook execution, allowed/outside/.git file actions, startup failure, timeout, updatedInput coexistence and removal/rollback in a live session are **not run / blocked** under current no-model, no-user-config-mutation constraints. No current `host_verified` upgrade is justified.

Fixture configuration install/uninstall and raw adapter stdin subprocess checks are **offline contract evidence** only. Repository historical desktop evidence (`docs/evidence-2026-10-29-batch27-desktop-session.md`) remains historical; it does not verify this PR/revision/current installed stack. In particular policy-corruption denial after a successful adapter process start does not prove executable-start failure or timeout denial.

The installed hook runner error path (`zcode.cjs:2273`) denies an uncancelled PreToolUse execution failure only when the declaration opts into `onError: "deny"`. Current generated repository declarations omit that field. Startup/timeout fail-closed behavior consequently remains open; adapter deny output alone cannot certify it. No runtime policy was changed during this research.

## Follow-up prerequisites

Use a documented complete isolated ZCode home/config environment or a disposable Windows account/VM with separate explicit authorization; obtain a supported zero-model native tool driver or separately authorized manual session. Recheck skill discovery, hook trust/execution, startup/timeout, coexistence and rollback there. Do not launch the keyed acceptance harness using existing login under the current task's zero-model restriction.
