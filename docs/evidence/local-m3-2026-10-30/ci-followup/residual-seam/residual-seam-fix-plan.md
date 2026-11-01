# Residual Windows CI seam repair plan — 2026-10-31

## Context

`f4d1bd3` (Windows identity witnesses) passed Ubuntu and render CI; hosted Windows
CI failed 6 fault-injection cases (run 41131365406, attempt 1, annotations saved as
`repair-windows-annotations.json`). All six reproduce **locally byte-for-byte**
when the hosted runner's path-metadata split is injected with
`windows-identity/preload-zero-device.mjs` (`fs.lstatSync` returns dev 0 for every
entry; `fstatSync` untouched), exactly the recorded runner condition
(lstat/stat dev=0 vs fstat dev≠0, same inode/kind/nlink).

## Reproduction (completed, RED evidence)

Command shape (win32, repo root):

```
node --test --import file://<abs>/.superpowers/m3-local-acceptance/windows-identity/preload-zero-device.mjs \
  --test-name-pattern="<case names>" test/<file>.test.mjs
```

| Case | Local failure (identical to CI annotation) |
| --- | --- |
| test/install.test.mjs:1708 R2 unreadable completed file | `unreadable ownership evidence cannot authorize deletion / false !== true` (temp removed; refused never set) |
| test/fs-utils.test.mjs:259 primary native read error | caught `PATH_CHANGED` instead of denied EACCES (stack: `independentDescriptor` fs-utils.mjs:121 ← witness close fault) |
| test/aliases.test.mjs:369 same-inode edit before success report | `Missing expected exception /STAGING_NOT_EMPTY/` |
| test/aliases.test.mjs:252/276/298 directory replacements | `ENOENT ... operator.txt` after half-applied replacement |

A full-suite zero-device baseline run is being recorded in
`windows-identity/zero-device-full-baseline.log`; expectation: exactly these 6
failures, matching hosted CI (verification gate before any edit).

## Root cause (single, shared)

Under dev=0 paths every generated file gains readonly descriptor-witness
open/close traffic *inside* the data fd's lifecycle (inspect capture,
`assertPlainFileDescriptor`, `unchanged` sweeps). The six old injection seams key
on "any close of fd whose open path was X" / "any read whose fstat dev equals the
lstat-recorded dev". Witness traffic therefore fires the injection at the wrong
moment (before the data write, while the wx fd still pins the directory for
rename) or never (dev 0 never equals fstat dev).

## Repair — injection seams only, product code untouched (`src/` unchanged)

Per the approved windows-identity-plan rule: adjust only the precise injection
seam so it keeps reproducing the same real change; error sets and every
assertion stay byte-identical.

1. **test/aliases.test.mjs 252/276/298/369** — descriptors map stores
   `{ name, flags }` from the open call; the closeSync hook fires only when
   `name === <target> && flags === 'wx'` (the generated write fd). This is the
   cases' own stated moment ("generated file closes", "between generated
   writes", write fd closed, no witness or data handle pinning the directory).
   The `'wx'`-aware open filter is already an established seam idiom in this
   file (`failManifestWrite` matches `args[0] === 'wx'`). No assertion changes:
   STAGING_NOT_EMPTY refusal, operator bytes preserved, directory listing, and
   `edited/replaced === true` all stay.
2. **test/fs-utils.test.mjs 259** — the close fault is gated to fire only after
   the primary read fault has been raised (a `readFailed` flag set by the read
   override), i.e. during the cleanup close the case is actually about. Witness
   closes during pre-read verification no longer abort the read. Assertions
   unchanged: caught error `=== denied` with code EACCES; every opened handle
   closed.
3. **test/install.test.mjs 1708** — the readFileSync hook matches the recorded
   original by `ino` (the temp directory holds exactly one file; inode equality
   is the cross-API identity the runner itself preserves), dropping the
   `stat.dev === original.dev` conjunct that can never hold under the recorded
   path/handle dev split. Assertions unchanged: EIO primary error, temp
   retained with original bytes and inode, `refused === true` ("cleanup must
   read the original file through a verified descriptor"), target/registry/lock
   final state.

## Verification gates

1. Zero-device full baseline (pre-edit): exactly the 6 CI failures.
2. Post-edit zero-device targeted reruns: all 6 cases green under the preload.
3. Post-edit zero-device full suite: 0 failures (1383 tests / 20 skips as on
   Node 22), same totals as normal local runs.
4. Normal-condition regressions (no preload): full `node --test test/*.test.mjs`
   on Node 24 and pinned Node 22.16.0 — 0 failures; plus `npm run check`,
   `verify-offline`, `doctor`.
5. Diff audit: only the three test files change; `git diff` shows seam edits
   only; frozen source hashes of `src/*` unchanged.

## Limits

- No product (src) change; no CI workflow change; no assertion weakened; no new
  dependency.
- zcode-profile.test.mjs's own fd-keyed write seam is not touched (it did not
  fail hosted or zero-device runs; repair scope = reproduced failures only).
- Coverage-gap disclosure required by plan review (agent_3966d0e5): after the
  `readFailed` gate, the f4d1bd3 witness close-fault branch
  (`src/fs-utils.mjs:118-123`, `catch { if (!failed) fail(code) }` in
  `independentDescriptor`) loses its only suite coverage — the fs-utils:265
  close fault was its sole (and incidental) trigger, and no win32 zero-device
  case injects a close fault. That branch had no coverage on green platforms
  either (no witnesses there) and is fail-closed; this repair removes no
  *intentional* coverage. Recorded here and in the final CI addendum as a
  candidate for a future dedicated test; deliberately out of this repair's
  scope (scope = reproduced failures, matching the approved repair boundary).
- Independent subagent review of this plan before editing, and of the diff after
  gates 1–4, as before. Publication stays on `audit/local-m3-windows-20261030`
  only; no main push; CI watched for all three jobs.
