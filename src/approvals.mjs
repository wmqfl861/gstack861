import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, object } from './json.mjs';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = code => { throw new Error(code); };

function subjectHash(subject) {
  if (!object(subject) || Object.keys(subject).sort().join(',') !== 'action,host,policyHash,runId,sessionId'
    || !['zcode', 'dsh'].includes(subject.host)
    || !['runId', 'sessionId'].every(k => typeof subject[k] === 'string' && subject[k].length > 0 && subject[k].length <= 256)
    || !/^[a-f0-9]{64}$/.test(subject.policyHash) || !object(subject.action)) fail('INVALID_SUBJECT');
  return digest(subject);
}

/** Trusted-controller API only. Not exposed to model tools or the CLI. */
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
    return path.join(this.directory, `${id}.json`);
  }
  issue(subject, { ttlMs = 300000 } = {}) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 86400000) fail('INVALID_TTL');
    const id = randomUUID();
    const record = { schemaVersion: 1, id, subjectHash: subjectHash(subject), state: 'pending', issuedAt: this.now() };
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
      const record = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (record.schemaVersion !== 1 || record.id !== id || !Number.isSafeInteger(record.expiresAt)) fail('INVALID_APPROVAL_RECORD');
      if (record.subjectHash !== subjectHash(subject)) fail('APPROVAL_BINDING_MISMATCH');
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
}
