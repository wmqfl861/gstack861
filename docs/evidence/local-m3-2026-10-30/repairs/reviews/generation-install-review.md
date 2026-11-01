# Independent generation/installer task review — 2026-10-31

Spec+quality verdict: REQUEST CHANGES; two Important findings reproduced. Alias scope had no Important finding.

R1 src/dsh-profile.mjs cleanup originally at :139 only checks identity; a later cordis.yml numeric-fd write seam edits already-written package.json in place to OPERATOR DATA then EIO. Cleanup removes edited file and output. Without EIO generation returns success with modified package.json. Keep expected bytes/digests per owned file, verify before success and before unlink, preserve drift and ambiguous failed-write contents. Add same-inode failure/success regressions. This is observable drift between operations, not final-syscall ZC-07.

R2 src/install.mjs cleanCreated originally at :95 only checks identity. During temp manifest.json write, overwrite previously written temporary SKILL.md in place to OPERATOR DATA then EIO; cleanup deletes operator content and temp directory. Require identity+expected bytes before unlink, preserve drift and nonempty directory. Add regression beside operator-sibling fault test.

All six reviewed source/test files matched supplied fingerprints. Recorded aliases51/51, integration164/164, pinned source4/4; installer106/106; DSH47/47, integration102/102; scoped diff whitespace clean. Reviewer performed only narrow disposable fixtures and read-only review; no source writes, broad reruns, host/model/network/dependencies/commits. ZC-07 remains OPEN.
