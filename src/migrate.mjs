import fs from 'node:fs';
import path from 'node:path';
import { object } from './json.mjs';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = code => { throw new Error(code); };

/**
 * Closes the 0.3.1 namespace debt: 0.3.0 wrote unprefixed <uuid>.json records that
 * became invisible to the prefixed stores after the upgrade (the README documented
 * manual renaming as the only path). Migration is rename-only — bytes and mode are
 * untouched — and never guesses an ambiguous record's kind: it refuses it.
 *
 * pendingCount: in a dry run, the count that WOULD migrate; in a real run, the
 * refused remainder an operator must resolve by hand.
 */
export function migrateStateFiles({ stateDir, dryRun = false, log }) {
  if (!path.isAbsolute(stateDir)) fail('ABSOLUTE_STATE_PATH_REQUIRED');
  // Validate directly with fs, never via the store constructors: both mkdir
  // recursive, so a typo'd stateDir would silently create a directory here.
  let dirStat;
  try { dirStat = fs.lstatSync(stateDir); } catch { fail('UNSAFE_STATE_DIRECTORY'); }
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) fail('UNSAFE_STATE_DIRECTORY');
  const migrated = [], refused = [];
  for (const file of fs.readdirSync(stateDir).sort()) {
    // Candidates are exactly unprefixed <uuid>.json; prefixed (already migrated),
    // foreign and garbage names are not ours to touch.
    if (!file.endsWith('.json') || !ID.test(file.slice(0, -5))) continue;
    const id = file.slice(0, -5), source = path.join(stateDir, file);
    const refuse = reason => { refused.push({ file, reason }); log?.(`${file}: refused ${reason}`); };
    // Ordered checks, first failure wins — same file discipline the stores read with.
    let stat;
    try { stat = fs.lstatSync(source); } catch { refuse('UNSAFE_RECORD_FILE'); continue; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) { refuse('UNSAFE_RECORD_FILE'); continue; }
    let record;
    try { record = JSON.parse(fs.readFileSync(source, 'utf8')); } catch { refuse('MALFORMED_RECORD'); continue; }
    if (!object(record) || record.schemaVersion !== 1 || typeof record.id !== 'string' || record.id !== id) { refuse('ID_MISMATCH'); continue; }
    const hasAttempts = Number.isSafeInteger(record.attempts), hasExpiry = Number.isSafeInteger(record.expiresAt);
    const kind = hasAttempts && !hasExpiry ? 'task' : !hasAttempts && hasExpiry ? 'approval' : undefined;
    if (kind === undefined) { refuse('AMBIGUOUS_RECORD'); continue; }
    const destination = path.join(stateDir, `${kind}-${id}.json`);
    try { fs.lstatSync(destination); refuse('DESTINATION_EXISTS'); continue; } catch { /* ENOENT: the name is free */ }
    // On Windows renameSync silently overwrites an existing destination
    // (MOVEFILE_REPLACE_EXISTING); the lstat pre-check above is the only guard, and
    // the uuid-collision TOCTOU it leaves open is accepted (nil probability, single
    // trusted operator).
    if (!dryRun) fs.renameSync(source, destination);
    migrated.push({ file, kind });
    log?.(`${file}: ${dryRun ? 'would migrate' : 'migrated'} to ${kind}-${id}.json`);
  }
  return { migrated, refused, pendingCount: dryRun ? migrated.length : refused.length };
}
