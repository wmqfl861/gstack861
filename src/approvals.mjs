import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, object } from './json.mjs';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = code => { throw new Error(code); };

export function subjectDigest(subject) {
  if (!object(subject) || Object.keys(subject).sort().join(',') !== 'action,host,policyHash,runId,sessionId'
    || !['zcode', 'dsh'].includes(subject.host)
    || !['runId', 'sessionId'].every(k => typeof subject[k] === 'string' && subject[k].length > 0 && subject[k].length <= 256)
    || !/^[a-f0-9]{64}$/.test(subject.policyHash) || !object(subject.action)) fail('INVALID_SUBJECT');
  return digest(subject);
}

/**
 * Transitions are trusted-controller only; the human operator CLI is one such controller
 * (its state directory must stay outside the model-writable workspace, and model tools must
 * not be able to invoke that CLI under the guard). Read-only get/list also serve the operator
 * CLI. Neither channel is exposed to model tools.
 */
export class ApprovalStore {
  constructor(directory, { clock = Date.now } = {}) {
    if (!path.isAbsolute(directory)) fail('ABSOLUTE_STATE_PATH_REQUIRED');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== path.resolve(directory)) fail('UNSAFE_STATE_DIRECTORY');
    if (process.platform !== 'win32' && ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()))) fail('UNSAFE_STATE_PERMISSIONS');
    this.directory = directory;
    this.clock = clock;
  }
  now() {
    const time = this.clock();
    if (!Number.isSafeInteger(time) || time < 0) fail('INVALID_CLOCK');
    return time;
  }
  file(id) {
    if (typeof id !== 'string' || !ID.test(id)) fail('INVALID_APPROVAL_ID');
    // Filename namespace: approval-<id>.json keeps this store's records invisible to
    // any other store sharing the same --state directory (task-<id>.json is foreign).
    return path.join(this.directory, `approval-${id}.json`);
  }
  issue(subject, { ttlMs = 300000 } = {}) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 86400000) fail('INVALID_TTL');
    const id = randomUUID();
    const record = { schemaVersion: 1, id, subjectHash: subjectDigest(subject), state: 'pending', issuedAt: this.now() };
    record.expiresAt = record.issuedAt + ttlMs;
    fs.writeFileSync(this.file(id), JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
    return id;
  }
  transition(id, subject, from, to) {
    const filename = this.file(id), lock = `${filename}.lock`;
    try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { fail('APPROVAL_BUSY'); }
    try {
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) fail('UNSAFE_APPROVAL_FILE');
      if (process.platform !== 'win32' && (stat.mode & 0o077)) fail('UNSAFE_APPROVAL_PERMISSIONS');
      let record;
      try { record = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { fail('INVALID_APPROVAL_RECORD'); }
      if (!object(record) || record.schemaVersion !== 1 || record.id !== id || !Number.isSafeInteger(record.expiresAt)) fail('INVALID_APPROVAL_RECORD');
      if (record.subjectHash !== subjectDigest(subject)) fail('APPROVAL_BINDING_MISMATCH');
      if (this.now() >= record.expiresAt) fail('APPROVAL_EXPIRED');
      if (!from.includes(record.state)) fail('APPROVAL_WRONG_STATE');
      const next = { ...record, state: to, changedAt: this.now() };
      const temp = `${filename}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temp, JSON.stringify(next) + '\n', { flag: 'wx', mode: 0o600 });
        fs.renameSync(temp, filename);
      } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
      return Object.freeze(next);
    } finally { fs.rmdirSync(lock); }
  }
  approve(id, subject) { return this.transition(id, subject, ['pending'], 'approved'); }
  reject(id, subject) { return this.transition(id, subject, ['pending', 'approved'], 'rejected'); }
  consume(id, subject) { return this.transition(id, subject, ['approved'], 'consumed'); }
  /**
   * Read-only binding check for the operator CLI: computes the subject digest from
   * the operator-supplied fields and compares it to the record's subjectHash.
   * Never transitions, never stores the action payload — records keep digests only.
   */
  verify(id, subject) {
    const record = this.get(id);
    return Object.freeze({ id: record.id, state: record.state,
      binding: record.subjectHash === subjectDigest(subject) ? 'match' : 'mismatch' });
  }
  get(id) {
    const filename = this.file(id);
    let stat;
    try { stat = fs.lstatSync(filename); }
    catch (error) { if (error.code === 'ENOENT') fail('NOT_FOUND'); throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) fail('UNSAFE_APPROVAL_FILE');
    let record;
    try { record = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { fail('INVALID_APPROVAL_RECORD'); }
    // Read views only ever surface records in a real state-machine state.
    if (!object(record) || record.schemaVersion !== 1 || record.id !== id || !Number.isSafeInteger(record.expiresAt)
      || !['pending', 'approved', 'rejected', 'consumed'].includes(record.state)) fail('INVALID_APPROVAL_RECORD');
    return Object.freeze(record);
  }
  /** Read-only operator view; reads only its own approval-<uuid>.json namespace. */
  list() {
    return fs.readdirSync(this.directory)
      .filter(name => name.startsWith('approval-') && name.endsWith('.json') && ID.test(name.slice(9, -5)))
      .map(name => this.get(name.slice(9, -5)))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}
