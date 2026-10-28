import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { subjectDigest } from './approvals.mjs';
import { object } from './json.mjs';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATES = ['planned', 'running', 'completed', 'failed', 'cancelled', 'interrupted'];
const fail = code => { throw new Error(code); };
/** Optional operator label: a non-empty string of at most 256 characters. */
const validOwner = owner => typeof owner === 'string' && owner.length >= 1 && owner.length <= 256;
/** Lease durations share the approval TTL bounds: safe integer, 1 ms .. 24 h. */
const validLeaseMs = leaseMs => Number.isSafeInteger(leaseMs) && leaseMs >= 1 && leaseMs <= 86400000;

/** Durable task journal for trusted controllers. Mirrors ApprovalStore's on-disk security discipline. */
export class TaskStore {
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
    if (typeof id !== 'string' || !ID.test(id)) fail('INVALID_TASK_ID');
    // Filename namespace: task-<id>.json keeps this store's records invisible to any
    // other store sharing the same --state directory (approval-<id>.json is foreign).
    return path.join(this.directory, `task-${id}.json`);
  }
  create(subject, { owner } = {}) {
    if (owner !== undefined && !validOwner(owner)) fail('INVALID_OWNER');
    const id = randomUUID();
    const time = this.now();
    const record = { schemaVersion: 1, id, subjectHash: subjectDigest(subject), state: 'planned', attempts: 0, createdAt: time, updatedAt: time };
    if (owner !== undefined) record.owner = owner;
    fs.writeFileSync(this.file(id), JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
    return id;
  }
  read(id, filename, stat) {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) fail('UNSAFE_TASK_FILE');
    if (process.platform !== 'win32' && (stat.mode & 0o077)) fail('UNSAFE_TASK_PERMISSIONS');
    let record;
    try { record = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { fail('INVALID_TASK_RECORD'); }
    if (!object(record) || record.schemaVersion !== 1 || record.id !== id || !STATES.includes(record.state)
      || !Number.isSafeInteger(record.attempts) || record.attempts < 0
      || !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.updatedAt)
      || typeof record.subjectHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.subjectHash)
      || (record.owner !== undefined && !validOwner(record.owner))
      || (record.leaseExpiresAt !== undefined && (!Number.isSafeInteger(record.leaseExpiresAt) || record.leaseExpiresAt < 0))) fail('INVALID_TASK_RECORD');
    return record;
  }
  get(id) {
    const filename = this.file(id);
    let stat;
    try { stat = fs.lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') fail('NOT_FOUND'); throw error; }
    return Object.freeze(this.read(id, filename, stat));
  }
  list({ state } = {}) {
    const records = [];
    for (const name of fs.readdirSync(this.directory).sort()) {
      // Own namespace only: task-<uuid>.json. Foreign-prefixed, double-prefixed
      // (task-task-<uuid>.json) and garbage names are never even parsed.
      if (!name.startsWith('task-') || !name.endsWith('.json')) continue;
      const id = name.slice(5, -5);
      if (!ID.test(id)) continue;
      const record = this.get(id);
      if (state === undefined || record.state === state) records.push(record);
    }
    return records;
  }
  transition(id, subject, from, to, { bumpAttempts = false, owner, lease, guard } = {}) {
    if (owner !== undefined && !validOwner(owner)) fail('INVALID_OWNER');
    const filename = this.file(id), lock = `${filename}.lock`;
    try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { fail('TASK_BUSY'); }
    try {
      let stat;
      try { stat = fs.lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') fail('NOT_FOUND'); throw error; }
      const record = this.read(id, filename, stat);
      if (record.subjectHash !== subjectDigest(subject)) fail('TASK_BINDING_MISMATCH');
      if (!from.includes(record.state)) fail('TASK_WRONG_STATE');
      if (guard !== undefined) guard(record);
      const next = { ...record, state: to, updatedAt: this.now() };
      if (bumpAttempts) next.attempts = record.attempts + 1;
      if (owner !== undefined) next.owner = owner;
      // lease: a number arms leaseExpiresAt, null clears it, undefined leaves it untouched.
      if (lease === null) delete next.leaseExpiresAt;
      else if (lease !== undefined) next.leaseExpiresAt = lease;
      const temp = `${filename}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temp, JSON.stringify(next) + '\n', { flag: 'wx', mode: 0o600 });
        fs.renameSync(temp, filename);
      } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
      return Object.freeze(next);
    } finally { fs.rmdirSync(lock); }
  }
  start(id, subject, { owner, leaseMs } = {}) {
    if (leaseMs !== undefined && !validLeaseMs(leaseMs)) fail('INVALID_LEASE');
    // Entering running leaseless clears any stale lease: "omitted" constrains the
    // resulting record, so a leaseless start/resume can never be phantom-reaped.
    return this.transition(id, subject, ['planned', 'interrupted'], 'running',
      { bumpAttempts: true, owner, lease: leaseMs === undefined ? null : this.now() + leaseMs });
  }
  resume(id, subject, { leaseMs } = {}) {
    if (leaseMs !== undefined && !validLeaseMs(leaseMs)) fail('INVALID_LEASE');
    return this.transition(id, subject, ['interrupted'], 'running',
      { bumpAttempts: true, lease: leaseMs === undefined ? null : this.now() + leaseMs });
  }
  // Liveness is proven by the call itself: an expired-but-present lease may still be
  // extended (GC lag); a leaseless record may not invent one, and a reaped task fails
  // the from-state check above.
  heartbeat(id, subject, { leaseMs } = {}) {
    if (!validLeaseMs(leaseMs)) fail('INVALID_LEASE');
    return this.transition(id, subject, ['running'], 'running',
      { lease: this.now() + leaseMs, guard: record => { if (record.leaseExpiresAt === undefined) fail('TASK_LEASE_REQUIRED'); } });
  }
  // Fail-closed crash proof: only an expired lease is evidence; lease absence is not.
  reap(id, subject) {
    return this.transition(id, subject, ['running'], 'interrupted', { lease: null, guard: record => {
      if (record.leaseExpiresAt === undefined) fail('TASK_LEASE_REQUIRED');
      if (this.now() < record.leaseExpiresAt) fail('TASK_LEASE_ACTIVE');
    } });
  }
  requeue(id, subject) { return this.transition(id, subject, ['failed'], 'planned', { lease: null }); }
  // Every path leaving running drops the lease: parked and terminal states carry no expiry claim.
  complete(id, subject) { return this.transition(id, subject, ['running'], 'completed', { lease: null }); }
  fail(id, subject) { return this.transition(id, subject, ['running'], 'failed', { lease: null }); }
  cancel(id, subject) { return this.transition(id, subject, ['planned', 'running', 'interrupted'], 'cancelled', { lease: null }); }
  interrupt(id, subject) { return this.transition(id, subject, ['running'], 'interrupted', { lease: null }); }
}
