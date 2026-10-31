# Independent review of the residual seam repair result — 2026-10-31

Reviewer: agent_3966d0e5 (same reviewer as the plan approval; read-only).
Verdict: **批准 (APPROVE)** for publication, with one pre-push record-labeling
correction (completed by the coordinator before publishing, see below).

## (a) Diff matches the approved plan exactly

- `residual-seam-diff-review.diff` is byte-identical to the working tree's
  `git diff` (verified with a diff tool: DIFF-IDENTICAL).
- All six seam adjustments correspond precisely: aliases four hooks
  (252/276/298/369) store `{name, flags}` and fire only on
  `opened?.name === <target> && opened.flags === 'wx'`; fs-utils 259 one
  `readFailed` gate (the read override sets the flag before throwing; close
  throws only `if (readFailed)`); install 1708 drops the
  `stat.dev === original.dev` conjunct, keeping inode matching. Witness opens
  use readonly flags (numeric 0) and can never equal `'wx'`; the gate selects
  uniquely.
- **Zero assertion/error-set changes**: every assertion line appears in the
  hunks as unchanged context; denied EACCES / closeError EIO / EIO write fault
  / EACCES deletion refusal all intact. The only added lines beyond the gates
  are three explanatory comments consistent with the plan's rationale. No
  out-of-plan changes.
- Scope: only the three test files; the five `src/` SHA256 digests match the
  frozen review hashes character for character (cbff271d / 02eaf82f /
  131d1b21 / 4f098532 / 0c525632); the three test file hashes match
  `residual-seam-test-hashes.txt`. The witness close-fault coverage-gap
  disclosure required in plan review is present in the plan's Limits with
  correct attribution and scope.

## (b) Log spot-checks match the reported numbers (one labeling exception)

| Log | Claimed | Verified |
| --- | --- | --- |
| zero-device-full-baseline.log | 1383/1357/6 = the CI six | ✓ exactly the CI set (matches reviewer's own independent RED) |
| zero-device-targeted-green.log | 6/6, exit 0 | ✓ 4+1+1 all pass |
| zero-device-full-green-isolated.log | 1383/1363/0/20 | ✓ |
| regular-node24-full-isolated.log | 1383/1363/0/20 | ✓ |
| regular-node22-full-isolated.log | 1383/1363/0/20 | ✓ (TAP format) |
| node22 check/offline/doctor | all exit 0 | no failures in content, but runtime labeling was wrong (see correction) |

Hard evidence the node22 full logs are genuine: under redirected output
Node 24 emits spec format while Node 22 emits TAP (confirmed experimentally on
both runtimes by the reviewer); both node22 full logs are TAP, so they were
really run by Node 22.16.0.

## (c) Reviewer's own isolated reruns against the repaired tree

- Targeted six under preload: 4/4 + 1/1 + 1/1, **0 failures**.
- Zero-device full suite: **1383/1363/0 fail/20 skip, exit 0**.
- Regular full suite (Node 24.21.0): **1383/1363/0/20, exit 0**.
- Pinned Node 22.16.0 binary directly running `scripts/check.mjs`,
  `scripts/verify-offline.mjs`, `bin/gstack861.mjs doctor`: **all exit 0**
  (check 119 modules; offline 9/9; doctor self-reports v22.16.0).
- `git status` before and after: only the three test files modified, no stash,
  `src/` untouched.

## (d) Overload-flake handling is honest

All three parallel-round logs retained (zd 1361/2, n24 1362/1, n22 1362/1 —
four flakes total). Verified individually: 'dsh-profile-stage CLI creates
scaffold and never runs package manager' lives at host-setup-cli.test.mjs:21,
error `null !== 0` (spawnSync timeout state), durations 10.16/10.48/10.28 s —
exactly ×3; 'installs canonical and alias independently with shared registry
(dsh)' 29.0 s stall ×1. Neither case is in the change set; both passed in the
pre-fix single-task baselines (coordinator's and the reviewer's independent
RED), and isolated serial reruns are fully green, corroborated by the
reviewer's own two serial full runs with zero failures. Not hidden, contrasted,
and rerun per the rules.

## Required correction before push (completed)

`regular-node22-doctor.log` contained `"node": "v24.21.0"`: `npm run` resolved
the inner `node` from PATH (system Node 24), so the npm-mediated logs were not
真 Node 22 runs. Substance unaffected (the reviewer had already rerun all three
commands with the true Node 22.16.0 binary, all exit 0, identical behavior),
but per evidence discipline the coordinator regenerated the three logs by
invoking the pinned Node 22 binary directly (`node22 scripts/check.mjs`,
`node22 scripts/verify-offline.mjs`, `node22 bin/gstack861.mjs doctor`): all
exit 0, doctor self-reports v22.16.0. The npm-mediated mislabeled logs were
replaced before publication; the published `regular-node22-check.log`,
`regular-node22-offline.log`, `regular-node22-doctor.log` are the corrected
direct-invocation logs.

## Red lines

No product-code change disguised as a seam repair; no assertion weakening or
error-set widening; all local evidence labeled as local reproduction (hosted
CI remains the final gate); nothing outside `.superpowers` touched during
review. Approved to commit and push, then watch all three hosted CI jobs and
the Windows annotations.
