# Task5 / I1 shared installer remediation

Date: 2026-10-30; approved R2 review correction completed 2026-10-31. Platform: native Windows, Node v24.21.0. Repository: `C:\Users\Administrator\.zcode\workspace\9c06bcdc-025c-4764-9ec1-da6db48d1f77\gstack861-m3-audit`. Baseline/unchanged HEAD: `680b2f19b2dbef8831e3be1fd996203589b5c41d`; branch `work/m3-command-aliases-20261029`.

The initial I1 evidence below is preserved as historical evidence. The approved R2 section at the end supplies the current results and frozen file hashes; its content-ownership correction supersedes the initial identity-only cleanup claim.

Only `src/install.mjs` and `test/install.test.mjs` were edited by this lane. Logs and this explicitly requested report are under `.superpowers/m3-local-acceptance/install/`. Other dirty files belong to the concurrent coordinator/lanes. No commits, subagents, network/model calls, new dependencies, global installs, or user configuration changes were made. All 68 original native-Windows installer tests were preserved without changing assertions; 38 I1 tests and four narrow R2 tests were appended.

## Implemented behavior

- Target paths are inspected with the coordinator-owned `inspectPlainPath` before staging reads, install/dry-run/uninstall registry reads, lock acquisition, or target creation. Full lexical ancestry, including native Windows junctions above an absent target suffix, is checked. `loadRegistry` also validates its target and uses a verified plain-file read.
- Existing target and component identities are retained with `assertPlainPathUnchanged` and rechecked around reads and immediately before mutations. Expected mkdir refreshes validate the saved existing ancestor entries first with `missing: []`, then inspect the created suffix. A newly accepted snapshot cannot hide an original ancestor replacement.
- Staging root, per-skill directory, manifest, SKILL.md, and listed auxiliary paths use the shared helpers. File reads use `readPlainFile` and verified descriptors; the exact validated byte buffers are installed, without reopening staging sources at apply time.
- Registry commits retain temporary-file + rename behavior. Registry snapshots, lock identities, destination/backup identities, ownership tree reads, and cleanup now use the same guards. Existing registry merging, backup recovery, skip semantics, foreign/drift refusal, multi-file skills, and rollback fault controls pass unchanged.
- Temporary cleanup records only successfully created resources. It checks their saved identities before removing individual files or nonrecursively removing empty directories. A colliding mkdir grants no ownership; concurrent operator entries and replacement locks are preserved. Rollback of an installed skill first rechecks its saved tree and content ownership. Backups remain if the active tree cannot safely be removed.
- Backup containment uses the existing `policy.inside` helper over native real paths, without a second containment implementation.
- Public mapping is local: unsafe/changed target ancestry -> `INVALID_TARGET`; invalid staging root ancestry -> `INVALID_STAGING`; manifest/skill directory or source-file identity refusal -> `STAGING_INVALID`; unsafe registry/destination/backup/lock components -> `USER_FILE_REFUSED`. Existing auxiliary-file missing/link/content refusal remains `TAMPERED_STAGING`, as required by the preserved tests. Existing `INSTALL_BUSY`, `REGISTRY_INVALID`, batch validation, and byte-digest errors remain covered.
- Both dry-run paths remain structurally read-only and take no lock. Snapshots compare bytes, identity and modification times in the added zero-write fixtures.

## RED / GREEN evidence

Commands below used absolute test paths; they are equivalent to running `node --test test/install.test.mjs` and `node --test test/aliases.test.mjs` from the repository root. Full command output was redirected to the named log, not truncated into this report.

1. RED, before any changes to `src/install.mjs`:

   `node --test C:/Users/Administrator/.zcode/workspace/9c06bcdc-025c-4764-9ec1-da6db48d1f77/gstack861-m3-audit/test/install.test.mjs > .superpowers/m3-local-acceptance/install/red.log 2>&1`

   Exit 1. **106 tests: 82 passed, 24 failed, 0 skipped, 0 cancelled**; duration 3156.0497 ms. All 68 original tests passed. The additional controls that already held account for the other 14 passes. The 24 failures were missing target-ancestor refusal (8); extended-namespace ancestor-junction bypass (1); staging-root ancestor traversal in real and dry-run install (2); junction/plain target ancestor swaps during reads for install/uninstall and both dry-runs (8); original ancestor replacement hidden by mkdir refresh (1); replacement target/lock preservation after lock creation (1); source ancestor replacement during manifest read (1); operator temp-mkdir collision deletion (1); operator sibling deletion on temp-write failure (1). The swap failures included wrong raw lock-cleanup errors where the old implementation removed or attempted to remove a lock under the replacement path. These were behavioral failures against the old implementation, not syntax/import failures.

2. GREEN, first complete run after the source integration:

   `node --test C:/Users/Administrator/.zcode/workspace/9c06bcdc-025c-4764-9ec1-da6db48d1f77/gstack861-m3-audit/test/install.test.mjs > .superpowers/m3-local-acceptance/install/green-attempt-1.log 2>&1`

   Exit 0. **106 tests: 106 passed, 0 failed, 0 skipped, 0 cancelled**; duration 44665.0943 ms. This includes all original audit rollback faults, foreign/user data controls, multi-file/deep-file lifecycle, two-process lock race, CLI previews, and all 38 added I1 tests. Source/test files were not changed after this run.

3. Canonical + alias integration, both host staging contracts:

   `node --test C:/Users/Administrator/.zcode/workspace/9c06bcdc-025c-4764-9ec1-da6db48d1f77/gstack861-m3-audit/test/aliases.test.mjs > .superpowers/m3-local-acceptance/install/alias-integration.log 2>&1`

   Exit 0. **51 tests: 51 passed, 0 failed, 0 skipped, 0 cancelled**; duration 6174.7445 ms. Both `installs canonical and alias independently with shared registry (zcode)` and `(dsh)` passed. No alias files were edited by this lane. The coordinator reported a transient `stagingFile` ReferenceError from a parallel test while this refactor was incomplete; every old `stagingFile`/`regularFile` caller has now been replaced, and this completed integration run has no such failure. The separate in-flight lane log remains coordinator-owned.

4. Additional read-only checks:

   - `node --check C:/Users/Administrator/.zcode/workspace/9c06bcdc-025c-4764-9ec1-da6db48d1f77/gstack861-m3-audit/src/install.mjs` — no syntax errors.
   - `node --check C:/Users/Administrator/.zcode/workspace/9c06bcdc-025c-4764-9ec1-da6db48d1f77/gstack861-m3-audit/test/install.test.mjs` — no syntax errors.
   - `git -C C:/Users/Administrator/.zcode/workspace/9c06bcdc-025c-4764-9ec1-da6db48d1f77/gstack861-m3-audit diff --check -- src/install.mjs test/install.test.mjs` — clean.
   - Owned test diff: 279 added lines, zero removed lines. Owned source diff: 311 added / 201 removed lines, all in the shared installer integration.

## Regression coverage and limits

The I1 tests exercise real native junctions on Windows and platform-appropriate directory symlinks elsewhere; no new blanket skips were added. Cases include a present/missing target through a linked ancestor for install/uninstall and both previews, extended namespace refusal and plain namespace lifecycle, linked staging ancestors/root/skill/auxiliary directories, hardlinked source files, multiple absent target components, normal multi-file install/repeat/uninstall, byte-identical plain directory replacement, junction replacement, observed creation/lock swaps, and source replacement during verified reads. Operator-created temp collision/sibling preservation is checked using real filesystem fault injection with restoration in `finally`.

**ZC-07 remains explicitly OPEN as an environment/security boundary.** Node pathname checks/rechecks narrow known or observed component swaps; they do not make an OS-atomic filesystem sandbox and do not prevent a hostile same-user swap after the final check and inside the final filesystem syscall. The swap regressions deliberately act after an observed read/create returns, leaving a subsequent check an opportunity to reject. This report does not change, weaken, count as passing, or claim to solve the original ZC-07 reproduction. A native handle-relative/no-reparse/CAS backend remains separate design scope.

If an ancestor or resource identity is no longer provable, cleanup intentionally preserves recovery artifacts rather than adopting the replacement or deleting it. A write that throws before successful ownership capture may similarly leave partial recovery data; the invocation never deletes an unproven file based only on its name. Identity-scoped file cleanup does not provide OS-level isolation from hostile same-user editing inside its final syscall.

Repeated full-chain checks have measurable cost: the native focused installer run increased from about 3.16 s (old implementation) to 44.67 s with all snapshot/recheck controls. No performance threshold was asserted or optimized in this Task5 security integration.

The repository-wide check/test/offline/doctor/inventory sequence is intentionally left to the coordinator per the task assignment. Only the focused installer and alias integration outcomes above are claimed. These are fixture/lifecycle tests, not native host discovery/render/model acceptance.

## Initial I1 tested file fingerprints (SHA-256; superseded by R2 below)

- `src/install.mjs`: `101a059d24374436e1ba31874f5fdc75b8afcd9cf6fb9a722e4e302debeb0172`
- `test/install.test.mjs`: `c4c9589c6c94c94990fe707e50b62f9f7681ada11cf480dbe102d6e803321bed`
- Coordinator-owned `src/fs-utils.mjs` dependency at initial verification: `0009a296f19807230ec2cf91b3a8e1a391e47bd2d6f36539f5f5152428725c0f`

## Approved R2 review correction — completed and FROZEN (2026-10-31)

Authority: independently approved `review-fix-plan.md`, R2; user GO for installer files only. Review confirmed a defect beyond the final-syscall boundary: initial `cleanCreated` proved dev/ino/type but not contents, so an in-place operator overwrite of an already completed temporary SKILL.md was deleted on a subsequent manifest write failure. Initial I1 GREEN did not cover that content-ownership gap. Existing evidence/logs were retained, and every previous test/assertion remains intact.

### Minimal correction

- `writeCreated` copies intended bytes before its exclusive write. Only a successful write plus checked created-path identity adds a file resource, now including the independent `expectedBytes` Buffer. A thrown/partial write still grants no cleanup ownership.
- `assertCreatedContents` uses the existing `readFile` wrapper and shared `readPlainFile` verified descriptor/ancestor checks, then exact Buffer equality. Cleanup requires both the saved identity and expected bytes immediately before unlink. A mismatch, missing proof, unreadable file, or identity uncertainty is preserved; empty directories use nonrecursive rmdir, so a retained child keeps its parent.
- `movedPath` carries the expected bytes when a created file is renamed. The existing `unchangedOwned` verification point checks that evidence when available and still runs the full existing tree/content ownership scan. This detects a same-inode metadata-only edit to the installed manifest while preserving the changed file during the existing rollback path. No new transaction or recovery mechanism was added; earlier installation/backup/registry behavior and checks remain in place.
- Four scoped regressions were added: unchanged generated bytes cleaned on manifest EIO; same-inode completed SKILL.md overwritten to literal `OPERATOR DATA` preserved on that same EIO; unreadable verified file preserved while the original EIO remains the reported failure; and metadata-only manifest drift after temp-to-installed rename rejected as `USER_FILE_REFUSED` with operator bytes retained and no registry commit. The repro checks the original bytes are complete and device/inode remain identical, independently of implementation helpers.

### R2 exact RED / GREEN evidence

All commands ran on native Windows Node v24.21.0. Test paths were absolute; log redirects below are within this authorized installer report directory. Old logs were not overwritten.

1. Full focused installer RED before production changes, after adding the three cleanup cases:

   `node --test C:/Users/Administrator/.zcode/workspace/9c06bcdc-025c-4764-9ec1-da6db48d1f77/gstack861-m3-audit/test/install.test.mjs > .superpowers/m3-local-acceptance/install/r2-red.log 2>&1`

   Exit 1; **109 tests: 107 passed, 2 failed, 0 skipped/cancelled**; duration 44115.9962 ms. All prior 106 tests and the ordinary-cleanup control passed. Both new preservation cases failed because the temp directory/file had been deleted (`false !== true`), not due to imports or fixture construction. This separately establishes the exact same-inode operator edit reproduction and inability-to-read preservation gap.

2. Additional narrow moved-proof RED, still before production changes:

   `node --test --test-name-pattern='R2 moved file content proof' C:/Users/Administrator/.zcode/workspace/9c06bcdc-025c-4764-9ec1-da6db48d1f77/gstack861-m3-audit/test/install.test.mjs > .superpowers/m3-local-acceptance/install/r2-moved-red.log 2>&1`

   Exit 1; **1 selected test: 0 passed, 1 failed, 0 skipped/cancelled**; duration 506.0023 ms. Failure was `Missing expected exception`: a same-inode metadata-only manifest edit after the temporary directory rename was accepted by the original field-based verification. Unselected tests were filtered, not run or counted.

3. Full focused installer GREEN after the minimal correction:

   `node --test C:/Users/Administrator/.zcode/workspace/9c06bcdc-025c-4764-9ec1-da6db48d1f77/gstack861-m3-audit/test/install.test.mjs > .superpowers/m3-local-acceptance/install/r2-green.log 2>&1`

   Exit 0; **110 tests: 110 passed, 0 failed/skipped/cancelled**; duration 44285.2726 ms. All original 68 tests, all 38 I1 tests, and all four R2 cases passed. Includes ordinary EIO cleanup, unchanged identity/ancestor controls, rollback faults, and the real-process mutex test. No source/test changes followed this run.

4. Affected alias integration only:

   `node --test --test-name-pattern='installs canonical and alias independently with shared registry' C:/Users/Administrator/.zcode/workspace/9c06bcdc-025c-4764-9ec1-da6db48d1f77/gstack861-m3-audit/test/aliases.test.mjs > .superpowers/m3-local-acceptance/install/r2-alias-integration.log 2>&1`

   Exit 0; **2 selected tests: 2 passed, 0 failed/skipped/cancelled**; duration 4099.3764 ms. Both zcode and dsh canonical/alias install/repeat/uninstall controls passed. Other alias tests were filtered; this is not a claim to have rerun the full alias suite for R2. No alias files were edited.

5. `node --check` for both absolute installer source/test paths and `git diff --check -- src/install.mjs test/install.test.mjs` completed successfully with no output. Against baseline, the owned test diff has 393 added and zero removed lines; the four R2 tests add 114 lines after I1. Production R2 changes are limited to successful file evidence, content guard, cleanup, proof propagation, and the existing verification loop. No broad or host test runs were performed by this lane.

### R2 frozen source and evidence fingerprints (SHA-256)

These supersede the initial I1 source/test fingerprints. Both owned files are FROZEN; no further lane edits are planned after this report.

- `src/install.mjs`: `1ff14916f23d19df2753e0878782cc645ebd5898cbc254981a96df93a7340514`
- `test/install.test.mjs`: `e53e9ef05a2fa23062bd484dc84f8cdbe2812d7dff2ff0af8fc0827da303f462`
- Shared `src/fs-utils.mjs` dependency, read-only for this lane: `0009a296f19807230ec2cf91b3a8e1a391e47bd2d6f36539f5f5152428725c0f`
- `r2-red.log`: `331b394b5520c342909c3c4c34b21cf5787327aac751853bbcb00d40d7a92b9f`
- `r2-moved-red.log`: `c3b43fd6cedb557042a2199a2591bd840a015af2da42218c3dec5c821e735c47`
- `r2-green.log`: `3e6f346dae83cac2531626efa05a6cad95dee6dbeb0a1e4224f8b5d775f0b5c4`
- `r2-alias-integration.log`: `d7e57576cc89017976cdecc8a50d60b0905b747422a6eae55cc9396f06b58a25`

**ZC-07 remains OPEN.** Exact-byte ownership checks narrow observed edits and ambiguous cleanup; they do not close a hostile same-user swap/edit after the final check inside the final filesystem syscall. Preserved edits/unreadable or partial files can leave recovery artifacts by design. Native no-reparse/handle-relative/CAS work remains separate scope. Full-suite/native acceptance belongs to the coordinator after all lane files freeze; this report claims only the commands and results above.
