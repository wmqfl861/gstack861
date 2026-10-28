// fs-utils — filesystem helpers shared by the redact/sealed ports
// (batch 23, Lane A).
//
// Upstream lineage: gstack lib/fs-utils.ts (27 lines, the whole file is
// mkdirpSync) at pinned submodule commit
// 5755601dac5d35ebd7dde181fdefe52a023c73d9. Ported verbatim; consumers in
// upstream are bin/gstack-redact install-prepush-hook and friends (the
// Lane B/C binaries import it from here).
//
// Divergence ledger (bun/TS → node ESM):
//   1. TypeScript erased: the `void` return and the
//      `(e as NodeJS.ErrnoException | null)` cast become plain JSDoc;
//      the `?.code` optional chain is kept verbatim. Nothing else changes.

import { mkdirSync, statSync } from 'node:fs';

/**
 * mkdir -p that tolerates the target directory already existing.
 *
 * Node's mkdirSync(dir, { recursive: true }) is a no-op when dir already
 * exists, but bun on Windows throws EEXIST in the same situation (#2635),
 * which crashed `gstack-redact install-prepush-hook` on any repo whose
 * .git/hooks already existed. Swallow EEXIST only when statSync confirms the
 * path is an existing directory; anything else - a regular file occupying the
 * path, a stat failure, a different errno - rethrows the original error, so a
 * real collision still fails loudly.
 *
 * @param {string} dir
 * @returns {void}
 */
export function mkdirpSync(dir) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    if (e?.code === 'EEXIST') {
      try {
        if (statSync(dir).isDirectory()) return;
      } catch {
        // stat failed - fall through and rethrow the original mkdir error
      }
    }
    throw e;
  }
}
