# Alias Task 2 fix report

Plan: `.superpowers/m3-local-acceptance/fix-plan.md`, approved Task 2. Baseline checkout `680b2f19b2dbef8831e3be1fd996203589b5c41d`; upstream source `5755601dac5d35ebd7dde181fdefe52a023c73d9`. This lane owns only `src/aliases.mjs` and `test/aliases.test.mjs`. No commits or subagents. Original audit evidence under `docs/evidence/local-m3-2026-10-30/aliases/` remains unchanged.

Status: Task 2 implementation and self-review complete. Final exact alias run: **51 pass / 0 fail / 0 skip**. Final focused aliases + install + fs-utils run: **164 pass / 0 fail / 0 skip**. Pinned upstream source fixture lifecycles: **4 pass / 0 fail / 0 skip**. All exit 0 with empty stderr. Earlier in-flight shared-installer failures are preserved below and resolved in these final runs. No assertions were loosened to conceal integration failures.

## Changes

- Complete manifest-map preflight before listed-file reads or output writes: undefined versus null, map type, SHA256 string values, reserved top-level files/prefixes, casefold duplicates, and whole-segment file/directory collisions.
- Shared `inspectPlainPath`, `assertPlainPathUnchanged`, and `readPlainFile` for all source and output paths. Shared `policy.inside` compares native real paths, rejecting mixed namespace and 8.3 physical overlap. Existing lexical ancestors are inspected before native normalization. File leaves require one link; directory identity is dev/ino/type only.
- Expected directory creation is rebased only after checking the saved existing ancestors. Created output/alias/auxiliary directory identities are retained and rechecked between writes and before success; fresh inspection cannot adopt a replacement.
- Frontmatter rename splices the exact ASCII canonical name token into the raw Buffer. CRLF, whitespace, non-UTF8 body bytes, and canonical bytes remain unchanged.
- Output writes open files exclusively and verify the fd identity. Cleanup individually unlinks only created files whose identities and expected contents still match, then uses nonrecursive `rmdir` for created directories. Existing output, concurrent siblings/nested children, replacement files, same-inode edits, and collision directories survive. Arbitrary content written by another writer into a failing output is never adopted as cleanup-owned; a verified expected partial prefix is eligible for cleanup.

## RED/GREEN evidence

All command records include the exact executable/arguments/cwd, duration, exit status, complete stdout/stderr and source hashes. Child environments copy a noncredential allowlist, set `GSTACK861_MODEL_CALL=0`, and confine TEMP/TMP to this lane's scratch.

| Record stem | Exact command | Outcome |
| --- | --- | --- |
| `fix-red` | `node --test test/aliases.test.mjs` | 37 tests, 9 pass / 28 fail / 0 skip; initial short-path fixture quoting issue retained |
| `fix-red-verified` | same | 37 tests, 9 pass / 28 fail / 0 skip; Windows short-path quoting corrected, overlap fails for expected missing refusal |
| `fix-green-first` | same | 37 tests, 37 pass / 0 fail / 0 skip |
| `fix-red-cleanup-followup` | same | 42 tests, 38 pass / 4 fail / 0 skip; two native Windows in-write rename probes hit open-file EPERM |
| `fix-red-cleanup-verified` | same | 42 tests, 38 pass / 4 fail / 0 skip; swaps moved after file close so all four fail for the intended ownership behavior |
| `fix-green-ownership` | same | 42 tests, 42 pass / 0 fail / 0 skip |
| `fix-red-case-parent` | same | 44 tests, 41 pass / 3 fail / 0 skip; valid NTFS case-aliased parent refused, plus two transient installer `stagingFile` ReferenceErrors |
| `fix-green-case-parent` | same | 44 tests, 42 pass / 2 fail / 0 skip; case-parent issue fixed, shared installer still mid-refactor |
| `fix-suffix-controls` | same | 50 tests, 48 pass / 2 fail / 0 skip; only shared installer lifecycle failures |
| `fix-green-final` | same | 50 tests, 48 pass / 2 fail / 0 skip; shared installer now fails `INVALID_TARGET` in `prepareTarget` |
| `fix-red-success-digest` | same | 51 tests, 50 pass / 1 fail / 0 skip; same-inode generated-byte edit was not detected before successful return |
| `fix-green-complete` | same | **51 tests, 51 pass / 0 fail / 0 skip**; final generated content verified, both shared installer lifecycles GREEN |
| `fix-focused-integration` | `node --test test/aliases.test.mjs test/install.test.mjs test/fs-utils.test.mjs` | **164 tests, 164 pass / 0 fail / 0 skip**, 71.970 seconds |
| `fix-pinned-source` | `node --test .superpowers/m3-local-acceptance/aliases/verify-fixed.test.mjs` | **4 tests, 4 pass / 0 fail / 0 skip**, 10.048 seconds |
| `fix-source-syntax`, `fix-test-syntax` | `node --check` on each owned file | exit 0; empty stdout/stderr |

Final pinned-source fixture check reuses the preserved audit's Git blob and SHA256 assertions. It covers both host labels with the unmodified canonical blob, then the explicitly augmented real pinned browse auxiliary blob. Each case verifies exact alias bytes, unchanged canonical bytes, manifest SHA256/git blob/status, independent shared-registry install/repeat/uninstall. This is source fixture evidence, not actual host rendering/discovery.

`git diff --check -- src/aliases.mjs test/aliases.test.mjs` passed. No source outside these owned files was written by this lane; other lanes' shared changes were consumed as integration dependencies.

The source was unchanged before `fix-red-verified`. Non-UTF8 bytes/whitespace, hardlink refusal, multi-level missing suffix creation/cleanup and same-inode edit tests added later are positive controls for already specified behavior. The valid case-parent regression caught an implementation overrestriction and was fixed using dev/ino/type identity, preserving the separate path collision refusals.

## Coverage mapping

- A1: source/output symlink and native junction ancestors; link/namespace/8.3 physical overlap; same-content source ancestor replacement; output parent replacement; created alias/output/auxiliary directory replacement after close.
- A2: new versus preexisting output failures; concurrent sibling and nested child; mkdir collision; generated-file replacement; same-inode edit; arbitrary content inserted in failed file; partial write cleanup; nested missing-output suffix cleanup.
- A3: null/array/string file maps; SKILL.md/manifest.json case variants; file/directory prefix conflicts; casefold duplicate keys; null/numeric/malformed hashes. Each preflight regression snapshots the full fixture tree and requires no mutation.
- A4: exact CRLF bytes, explicit LF expected bytes, whitespace and invalid UTF8 body preservation.
- Integration: both host labels, independent canonical/alias files, frontmatter names, SHA256/git blob, auxiliary equality, shared registry coexistence, repeat skips and uninstall.

## Limits and concerns

- Shared path checks reject existing links and observed replacements. They cannot prevent a hostile same-user change after the final check inside the final filesystem syscall; no OS-atomic containment guarantee is claimed.
- A cleanup identity/content mismatch preserves entries for recovery rather than deleting them. Concurrent edits matching the generated contents are indistinguishable from generated bytes; the implementation does not claim authorship beyond exclusive creation plus identity/content evidence.
- Unit/integration fixtures and pinned-source fixture verification do not prove host skill discovery or browser-command execution. Bun 1.4.2 remains unavailable; no real host-specific renderer was run.
- Windows short-path and namespace probes are native Windows-only branches, not skipped tests. Non-Windows uses directory symlinks instead of junctions; no new test skips.
- Self-review was performed against the approved Task 2 plan. The coordinator owns the final independent whole-branch review and full-suite/check/offline/doctor/inventory execution. This lane does not run the full suite, per the task boundary.
- No changes to `fs-utils.mjs`, `install.mjs`, policy semantics, user configuration, credentials, dependencies, or upstream source by this lane.

## Rulings and process notes

- Required scratch/report paths override the generic execution skill's separate workspace scripts. No extra workspace or cross-lane ledger was created.
- No commits/subagents or full-suite run are performed by this lane, per explicit task instructions; coordinator performs the whole-branch gate.
- Fault injection follows exclusive fd writes as well as pathname writes. Moving to fd writes is the implementation, so the test fault targets the actual opened manifest fd while retaining pathname support. No production-only testing interface was introduced.
- Windows directory swaps occur after the generated file closes because an open fd prevents the rename; this reproduces an observable replacement rather than asserting on an environment EPERM artifact.
