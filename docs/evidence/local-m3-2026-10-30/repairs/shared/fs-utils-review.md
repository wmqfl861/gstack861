# Scoped shared-helper / CLI review — 2026-10-30

**Verdict: APPROVE — spec and quality. No Critical or Important actionable findings in the reviewed scope.**

Baseline: `680b2f19b2dbef8831e3be1fd996203589b5c41d`. Reviewed `src/fs-utils.mjs`, new/untracked `test/fs-utils.test.mjs` (including its explicit no-index diff), and only the imports / changed policy-workspace block in `bin/gstack861.mjs`. Requirements: approved `fix-plan.md` shared contract, Task 1 and Task 4.8. Adjacent policy/JSON definitions and CLI regression assertions were read only to establish the contract.

## Spec and quality assessment

- `src/fs-utils.mjs:56–83`: absolute/control/traversal validation precedes component inspection. Existing root/ancestor/leaf components are lstat-checked before native realpath; links, wrong types, and multiply linked regular files refuse. Missing paths retain an absent suffix. Snapshot identities use bigint-derived strings and the entire result is deeply frozen. Existing `mkdirpSync` behavior is unchanged.
- `src/fs-utils.mjs:88–117`: rechecks compare dev/ino/type and expected absence, enforcing single-link status only for files. Directory nlink/mtime are correctly excluded. Reads validate the chain before open, verify the actual fd with fstat before and after reading, recheck the chain, and close through finally. The regression exercises a replacement at open and descriptor closure.
- Namespace handling strips the ordinary extended-drive prefix before component inspection. Read-only checks on native Windows Node v24.21.0 confirmed ordinary / extended-drive / existing `ADMINI~1` spellings have equal canonical paths and leaf identities; missing-suffix canonicalization and deep freezing also held. Trailing-dot/space namespace probes refused.
- `bin/gstack861.mjs:140–148`: install loads the compiled external policy, strictly inspects the selected workspace, compares canonical workspaces using mutual `inside`, and checks the policy is outside the selected workspace before planning/applying. Policy mismatch and linked-workspace failures precede configuration mutation. The adjacent uninstall branch does not load/read policy, preserving missing/corrupt-policy removal.
- Cleanup is a caller obligation: after expected mkdir, validate the original existing entries with only the expected absence relaxed, then snapshot the created suffix. Keep the original identities; remove only invocation-created resources whose identities still match. The helper/test express this contract without introducing cleanup side effects.

## Evidence and limits

Inspected supplied `fs-utils-red.log` (0/7, helpers absent) and `fs-utils-green.log` (7/7, zero skips), plus `cli-red.log`. Focused CLI binding 3/3 GREEN is supplied task evidence; no corresponding CLI green log was present among the named CLI evidence files. No broad/full tests were rerun. Narrow checks were read-only path probes and scoped `git diff --check` (clean).

Reviewed Git blob fingerprints: helper `bf225f4158089252d568dacad86789128332279d`; tests `acca39e9faeafcc7eaab3864b79673119feea7c3`; CLI `0fce28b73c508295b74abfbe4d22e909f05b8976` (only the stated block reviewed).

## Declined to judge

- **ZC-07 remains OPEN:** portable pathname checks detect observed replacements; this approval does not claim OS-atomic final-syscall containment.
- Alias/install/DSH/ZCode lane implementations and their cleanup/transaction logic: outside this review's ownership and concurrently edited.
- UNC/network paths, host execution, home configuration, and end-to-end acceptance: outside the authorized checks.

Only this requested review artifact was written. No source/test edits, commits, network access, host launches, or home configuration reads.
