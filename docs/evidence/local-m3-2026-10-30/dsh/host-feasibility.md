# Installed DSH feasibility for M3 Windows acceptance

**Historical research snapshot.** The statements below saying “not run” or “unlaunched” describe the pre-acceptance research stage on 2026-10-30. Subsequent verified execution is recorded separately in `run-2026-10-30T16-41-27.706Z-a740898f/run-result.json` and the final LOCAL-M3 report: five isolated generated-profile/fixture-tool controls passed. Keep this snapshot distinct from that later execution evidence.

Date: 2026-10-30. Research baseline: PR3 `680b2f19b2dbef8831e3be1fd996203589b5c41d`. This is a source/API feasibility report, not evidence that the generated profile or host tools have passed acceptance. The scratch harness described below has not been launched. Its invocation remains gated on fix-plan review, shared-helper/profile fixes, and explicit approval.

## Conclusion and evidence classes

The installed runtime supports taskless profile boot, real Cordis services, system-prompt assembly, and direct `ToolRuntime.execute()` without an Agent, model, API key, or installed additional dependency. The relevant exports were imported and inspected without constructing services. An installation-only runtime-resolution calculation also succeeded without creating a Harness home. Actual generated-profile boot and fixture tool execution remain **not run**.

At the research baseline, `src/dsh-profile.mjs:31` declares `gstack861-skills` in dependencies and the patch, but the file list at lines 51–53 emits only the guard package. Acceptance must report the absent generated skills package, never supply it itself. `test/host-setup-cli.test.mjs:21–26` already requires the missing skills shim. `test/dsh-profile.test.mjs:18–27` checks the patch string and guard shim, so those checks alone cannot establish a complete profile. The remediation contract is `.superpowers/m3-local-acceptance/fix-plan.md`, Task 3.

| Class | What was established in this research |
| --- | --- |
| Installed metadata/CLI observation | Launcher version `0.2.1-rc.3`; CLI help; embedded Node `24.21.0`; Cordis package `4.0.5` |
| Imported API observation | Public profile/boot exports; `ToolRuntime.register/guard/execute`; `SystemPrompt.section/assemble`; no exported `Profile` class |
| Read-only resolution observation | `createRuntimeResolution` with no profile produced 542 installed entries, including tools and system-prompt; no Harness home was created |
| Installed-source inspection | Isolation overrides, process-only launch environment, profile composition, loader state/warning semantics, direct tool pipeline |
| Repository contract/history | Adapter and fixture tests, historical activation/keyed reports; not rerun or promoted by this research |
| New host acceptance | **Not run**: actual generated-profile activation, prompt index, tool controls, startup failure controls |

The installed-version to upstream-lock commit `22ddee3792402c3e70ec5f86a63c3e3e895a2f60` mapping remains unverified. A later successful run would establish only the tested composition, not `host_verified`, full parity, PTC, subagent behavior, shell containment, or OS security.

## Installed entrypoints and source anchors

The installed root is `C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness`. The module-root abbreviation **R** below means:

```text
C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/
```

| Location | Relevant evidence |
| --- | --- |
| `resources/runtime/cli/bin/dsh.cmd:3–4` under the installed root | Sets `ELECTRON_RUN_AS_NODE=1`, invokes the installed executable with `--expose-internals` and ASAR `dsh-desktop-host/lib/cli.js` |
| `R/dsh/package.json` | Exports `./profile-boot`; installed package version `0.2.1-rc.3` |
| `R/dsh/lib/profile-boot.js:1–2` | Exports `prepareProfile`, `runProfile`, `INSTALL_ANCHOR`, `PROFILE_ROOT_FILENAME`, initialization/home-patch helpers |
| `R/dsh/lib/profile-boot-C14i-8IN.js:115–127,216–246` | Home patch resolution; installation manifest anchor; empty root; profile preparation and runtime resolution |
| `R/dsh/lib/profile-boot-C14i-8IN.js:255–318` | `runProfile(options)` returns `{ctx, shutdown}`, supplies profile context, runtime package resolution and cmdline services to the real Loader |
| `R/dsh-app-boot/lib/index.js:1015–1050` | `loadProfileDirectory(binName, dir, installAnchor, options={})` returns parsed profile data, bundle layers, patch path, patches, skipped bundles |
| `R/dsh-app-boot/lib/index.js:766–798,850–853` | Runtime package resolution; local direct dependency requires a declaration and `node_modules/<name>/package.json` |
| `R/dsh-app-boot/lib/index.js:1127–1136,3492–3507` | Profile/home/overlay/telemetry patch order; `PluginPackages` installs runtime ESM/CJS resolution and disposes it with the tree |
| `R/dsh/lib/bin.js:215–216`; `R/dsh-app-boot/lib/index.js:3736–3758` | Ordinary CLI profile boot calls `loadLayeredEnv`, which reads invoking-directory and Harness-home `.env` files |
| `R/dsh-launch-environment/lib/index.js:30–53` | `createLaunchEnvironmentSnapshot([{source:'process',values:{}}])` constructs an explicit snapshot without file reads |
| `R/dsh-home-paths/lib/index.js:101–124` | Nonempty absolute `DSH_HOME` and `DSH_AGENTS_HOME` override their default roots; whitespace-only values fall back |
| `R/dsh-app-boot/lib/index.js:1093–1110` | Any nonempty `DSH_TELEMETRY_DISABLED` disables the telemetry row; no patch is needed when the custom composition has no such row |

Absolute file-URL imports under the ASAR-aware installed Electron runtime were observed to work. Manifest-advertised `.d.ts` paths are not present in this installation; executable JavaScript and package READMEs were inspected instead. Do not infer an SDK class from the word “Profile”: the imported modules export profile-loading functions and `ProfileRuntimeResolution`, not a `Profile.load()` class.

## Isolation and actual-generated-profile loader

For each future host child, create new, independent `DSH_HOME`, `DSH_AGENTS_HOME`, temporary directory and trusted empty cwd. Set isolation and telemetry variables before importing any installed module. The controller uses a positive environment allowlist, not a copy of inherited variables: OS executable support only, explicit fixture paths, `ELECTRON_RUN_AS_NODE=1`, `DSH_TELEMETRY_DISABLED=1`, and `GSTACK861_MODEL_CALL=0`. Credentials, proxy variables, model routes and inherited acceptance switches are omitted. The last variable is a repository convention, not a host model-disable mechanism.

Use the existing generated local packages only. The controller may expose each existing `plugins/<name>` directory through an offline directory junction in that generated profile’s `node_modules`. It must verify package manifests and shims first, preserve generated package/patch/shim bytes, and stop before any host launch if either package is absent. It must not invoke pnpm, download dependencies, add shims, replace package/patch content or use the shipped headless/base templates.

The source-supported boot sequence is the following. This is a description of the unlaunched harness, not a transcript of a successful boot.

```js
const profile = loadProfileDirectory('dsh', actualGeneratedDirectory, INSTALL_ANCHOR);
const { ctx, shutdown } = await runProfile({
  profile: profile.name,
  patchFiles: [],
  args: [],
  environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]),
  resolvedProfile: { profile, installAnchor: INSTALL_ANCHOR },
});
// Inspect expected Loader entries before registering or dispatching any fixture tool.
// Always finish with await shutdown.shutdown(0).
```

Supplying the explicit snapshot to the exported `runProfile` avoids the CLI’s `loadLayeredEnv` call. `runProfile` still reads the profile and an optional patch in the fresh isolated home, and normally rewrites the generated `cordis.yml` to its standard empty-root template. That host-owned rewrite is expected and is recorded separately; all other emitted generated bytes must remain unchanged. The loader is not a sandbox for arbitrary trusted plugins. The scratch runner additionally refuses network and child-process entrypoints before runtime imports, records attempts, and requires zero attempts; these are process-level tripwires, not an OS network isolation claim.

A safely quoted launcher syntax, for an independently approved metadata probe only, is:

```powershell
# Assign a NEW fixture root to these variables for every child invocation.
$env:DSH_HOME = Join-Path $probeRoot 'home'
$env:DSH_AGENTS_HOME = Join-Path $probeRoot 'agents'
$env:DSH_TELEMETRY_DISABLED = '1'
Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
& 'C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' --version
```

The scratch acceptance controller uses the equivalent installed executable carrier directly to run its trusted script. It does not boot a CLI task or execute a metadata probe as an unrequested prelude.

## Activation, authentic adapters and prompt index

The expected generated IDs are `system-prompt`, `tools`, `gstack861-guard`, and `gstack861-skills`. Each must be present exactly once, enabled, and have `entry.fiber.state === 2` before dispatch. Verify `entry.options.name`, collect `entry.moduleNamespace`, and compare the guard/skills `name`, `inject`, and `apply` exports with the actual repository adapters imported by their file URLs. Never invoke their `apply` functions manually.

The installed state constants are explicit at `R/dsh-app-boot/lib/index.js:4259–4262`: pending `0`, active `2`, failed `3`, disposed `4`. `R/cordis-plugin-loader/lib/index.js:450–464` retains the raw imported namespace and starts the configured plugin through the registry. `R/dsh-app-boot/lib/index.js:4333–4395` classifies missing imports, pending services and failed fibers.

Exit zero is insufficient. The global required-ID list at `R/dsh-app-boot/lib/index.js:4270–4279` does not include the guard or skills plugin. `auditStartupEntries` at lines 4464–4474 warns for optional failures while successful siblings remain running, and ignores absent/disabled required IDs. Capture real boot stderr plus a second audit through its supported warning sink. An acceptance-level gate must independently refuse dispatch whenever an expected plugin is missing, disabled or inactive.

The dependency closure is system-prompt → tools → guard; skills separately injects systemPrompt. `R/dsh-tools/lib/index.js:2761,2797–2806` confirms the tools service injection. The repository declarations are `src/adapters/dsh.mjs:3–4` and `src/adapters/dsh-skills.mjs:6–7`.

Use `await ctx.systemPrompt.assemble({})` to inspect the real `gstack861:skills` section. Assert exact distinct canonical and alias entries (`open-gstack-browser`, `connect-chrome`), descriptions and absolute instruction paths, and compare the registry-backed skill hashes with installed bytes. The fixture store is built with `stageRender` → `stageCommandAliases` → `installSkills`; it is not an invented registry. `src/adapters/dsh-skills.mjs:37–63` validates registry/files/digests and contributes a section with order 3050 and `interpolate:false`. Installed `R/dsh-system-prompt/lib/index.js:253–255,356–405` implements registration and assembly.

The generated plugin contributes an index, not native `ctx.skills`. Installed `dsh-skill` does provide a native registry (`R/dsh-skill/lib/index.js:119–135`), and `dsh-skill-filesystem` can scan project/custom/user roots (`R/dsh-skill-filesystem/README.md:28,44–75`). Older repository statements that DSH has no directory scanning are overbroad for this installation. Those native plugins and their discovery roots are excluded from this acceptance composition.

## Genuine tools and controls

Register fixture tools using the installed `defineTool` and the activated `ctx.tools.register`. They declare explicit output `{schema,render}`, increment execution counters, and restrict their filesystem bodies to the fresh fixture. Use `ctx.tools.execute`, never the saved definition’s `execute` body and never a manually called guard callback.

```js
const outcome = await ctx.tools.execute({
  callId: 'accept-1',
  name: 'fixture_write',
  arguments: { path: absoluteFixturePath, content: 'fixture-only' },
  signal: new AbortController().signal,
});
```

Installed `R/dsh-tools/lib/index.js:2974–2982` implements registration; lines 3017–3031 register and consult monotonic guards. The public execute method is at 3212–3213. With no pre-execute policy plugin, line 3321 defaults to allow; line 3337 consults the real guard; lines 3342–3352 materialize denial; line 3406 invokes the body; lines 3478–3521 freeze and notify the final result. No Agent or model is required. Assertions inspect `isError`, `error.message`, rendered content, body counters and disk bytes rather than matching a diagnostic substring alone.

| Case | Required observations; no successful result is presumed |
| --- | --- |
| Clean generated profile | All four expected IDs active; only the expected minimal plugin roster; tools/systemPrompt present; model/credential/Agent services absent; genuine prompt index contains canonical+alias |
| Allow | In-scope write succeeds, counter increments once, exact bytes appear; a fixture read returns exact bytes |
| Outside scope | `gstack861:OUTSIDE_SCOPE`, counter unchanged, target absent |
| `.git` protection | `gstack861:PROTECTED_PATH`, counter unchanged, sentinel bytes unchanged; workspace is inside writeRoots so this tests protection rather than outside-scope rejection |
| Policy corrupt after activation | `gstack861:POLICY_UNAVAILABLE`, counter unchanged, no write |
| Policy recovery | Restore original policy bytes; same loaded guard accepts the next in-scope write/read |
| Invalid policy before startup | Real guard fails activation; warnings captured; tools may still be active; acceptance refuses **all** tool dispatch |
| Missing systemPrompt | Separate labelled disable overlay; generated bytes unchanged; tools/guard/skills pending, missing-service warnings captured; no dispatch |
| Corrupt skill registry | Registry damaged only after generation; skills fails with `REGISTRY_INVALID`; index absent; no dispatch |
| Tampered installed skill | One installed skill byte changes after generation; skills fails with `SKILL_TAMPERED`; index absent; no dispatch |

Each startup-negative case uses its own fresh home/profile/store/cwd. Fixture Git repositories are initialized with the installed Git executable under an empty system/global configuration, template and hook suppression, and an explicit fresh directory; no credential or user Git configuration is consulted. None adds a plugin or patches in a missing generated shim. In a fully passing run, clean-pipeline controls and startup-negative controls are reported separately; the latter do not become evidence of fail-closed DSH startup. The guard reload behavior is in `src/adapters/dsh.mjs:7–18`; policy ordering is in `src/policy.mjs:261–297`.

Restrictions: DSH adapter paths remain absolute-only. A pre-aborted signal is intercepted by the host before the guard and returns `ABORTED_BEFORE_DISPATCH` (`R/dsh-tools/lib/index.js:3314–3318,3791–3805`), not necessarily `gstack861:CANCELLED`. Native first-party file tools require a larger fs/working-directory/service closure; testing that would be a separately labelled expanded composition. PTC and native skill-tool/model consumption are not exercised.

## Scratch artifacts and proposed invocation

The explicitly requested scratch artifacts are `.superpowers/m3-local-acceptance/dsh-host/run.mjs` (fixture/controller/clean-child launcher) and `host.mjs` (installed runtime consumer). They are outside source/test ownership. Normal Node `--check` and the controller’s read-only `--fingerprint` mode do not start DSH. Runtime results are not present yet.

After independent fix-plan review and the helper/profile fixes, obtain the reviewed plan and source fingerprints with:

```powershell
node .superpowers/m3-local-acceptance/dsh-host/run.mjs --fingerprint
```

Submit the following concrete operation with those exact reviewed values for invocation approval; do not substitute automatically calculated new values after approval:

```powershell
node .superpowers/m3-local-acceptance/dsh-host/run.mjs --run-approved `
  --reviewed-plan-sha256 <REVIEWED_PLAN_SHA256> `
  --expected-source-fingerprint <REVIEWED_SOURCE_FINGERPRINT>
```

The controller refuses changed fingerprints or missing shared-helper/generated-package prerequisites before its first installed-host spawn. Each child has bounded time/output. Raw local stdout/stderr remain under the scratch run; public JSON/logs are path-redacted to `<repo>`, `<run>` and `<case>` while preserving installed runtime paths. A manifest hashes the emitted evidence files. A launch/spawn/timeout failure is a failure, not a skipped or passing control. No automatic retry, installation, shim repair, profile substitution or paid fallback is implemented.

## Early launch disclosure

The parent acceptance plan records two early DSH version probes using ordinary host paths before the stricter per-launch isolation correction. These were version-only probes, with no intended session, tool or key lookup; they must not be described as fully isolated.

This research lane also performed version/help calls with both home overrides and telemetry disabled, but reused one reserved nonexistent research-home name rather than allocating a fresh pair for each call. Both directories were subsequently observed absent. Several Electron invocations used only ASAR-aware filesystem reads of installed sources/package metadata without those overrides. Later export-import and installation-resolution checks supplied both overrides, disabled telemetry, removed the DeepSeek key from the child environment, and did not construct services. Reused names and source-only Electron invocations still do not satisfy the later stricter “fresh isolation before every host launch” rule.

No research invocation booted a profile, ran a fixture tool, invoked a model, installed dependencies or intentionally accessed credentials/user configuration. The source-only calls are not a filesystem access audit and are not claimed as proof of complete isolation. The mismatch was disclosed to the coordinator; further host launches stopped. The new harness remains unlaunched pending the stated review/fix/approval conditions.
