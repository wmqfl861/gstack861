import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { object, canonical, digest, freeze } from './json.mjs';

const fail = code => { throw new Error(code); };
const CONFIG_DIR = '.zcode';
const CONFIG_FILE = 'config.json';
const RECEIPT = '.gstack861-zcode-config.json';
const LOCK = '.gstack861-zcode-config.lock';
const plans = new WeakMap();
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !/[\x00-\x1f]/.test(value);
const identity = stat => `${stat.dev}/${stat.ino}`;
const version = (stat, dev = stat.dev) => `${dev}/${stat.ino}/${stat.size}/${stat.mtimeNs}/${stat.ctimeNs}/${stat.mode}`;
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

function bindDescriptor(file, stat, descriptor, label, directory = false) {
  const sameMetadata = directory ? stat.ino === descriptor.ino && stat.mode === descriptor.mode : version(stat, descriptor.dev) === version(descriptor);
  if (!sameMetadata) fail(label + '_CHANGED');
  const device = descriptor.dev === stat.dev || (process.platform === 'win32' && descriptor.dev === (stat.dev & 0xffffffffn));
  const missingDevice = process.platform === 'win32' && stat.dev === 0n;
  if (device && !missingDevice) return;
  if (!missingDevice) fail(label + '_CHANGED');
  // Some Windows path queries report dev=0. Bind that path through a second,
  // independent open instead of treating zero as an identity wildcard. Keep
  // both original source versions; directory contents may change their times.
  let witness;
  try { witness = fs.openSync(file, READ_FLAGS); } catch { fail(label + '_UNSAFE'); }
  try {
    const observed = fs.fstatSync(witness, { bigint: true });
    if (directory) {
      if (!observed.isDirectory() || observed.isSymbolicLink() || identity(observed) !== identity(descriptor) || observed.mode !== descriptor.mode) fail(label + '_CHANGED');
    } else {
      safeFile(observed, label);
      if (version(observed) !== version(descriptor)) fail(label + '_CHANGED');
    }
    const current = fs.lstatSync(file, { throwIfNoEntry: false, bigint: true });
    if (!current || current.isSymbolicLink() || (directory ? !current.isDirectory() || identity(current) !== identity(stat) : version(current) !== version(stat))) fail(label + '_CHANGED');
  } finally { fs.closeSync(witness); }
}
function safeFile(stat, label) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > 1024n * 1024n) fail(label + '_UNSAFE');
}
function captureIdentity(file, stat, label, directory = false) {
  let fd;
  try { fd = fs.openSync(file, READ_FLAGS); } catch { fail(label + '_UNSAFE'); }
  try {
    const descriptor = fs.fstatSync(fd, { bigint: true });
    if (directory) {
      if (!descriptor.isDirectory() || descriptor.isSymbolicLink()) fail(label + '_UNSAFE');
    } else { safeFile(stat, label); safeFile(descriptor, label); }
    bindDescriptor(file, stat, descriptor, label, directory);
    const after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(file, { throwIfNoEntry: false, bigint: true });
    if (!current || current.isSymbolicLink() || (directory ? !current.isDirectory() || identity(current) !== identity(stat) || identity(after) !== identity(descriptor) : version(current) !== version(stat) || version(after) !== version(descriptor))) fail(label + '_CHANGED');
    return { path: identity(stat), descriptor: identity(descriptor) };
  } finally { fs.closeSync(fd); }
}
function directoryIdentity(file, stat, code) {
  if (process.platform !== 'win32' || stat.dev !== 0n) return { path: identity(stat), descriptor: null };
  try { return captureIdentity(file, stat, 'ZCODE_CONFIG_DIR', true); }
  catch { fail(code); }
}

function directories(directory, code, missingLeaf = false) {
  const anchor = path.parse(directory).root;
  let current = anchor;
  const result = [];
  for (const segment of ['', ...path.relative(anchor, directory).split(path.sep).filter(Boolean)]) {
    current = segment ? path.join(current, segment) : current;
    const stat = fs.lstatSync(current, { throwIfNoEntry: false, bigint: true });
    if (!stat && missingLeaf && current === directory) return result;
    if (!stat?.isDirectory() || stat.isSymbolicLink()) fail(code);
    result.push([current, directoryIdentity(current, stat, code)]);
  }
  return result;
}
function locations(workspace) {
  if (!absolute(workspace)) fail('ABSOLUTE_PATH_REQUIRED');
  if (workspace.split(path.sep).includes('..')) fail('WORKSPACE_INVALID');
  const root = path.resolve(workspace);
  if (root === path.parse(root).root) fail('WORKSPACE_INVALID');
  const roots = directories(root, 'WORKSPACE_INVALID');
  const zdir = path.join(root, CONFIG_DIR);
  const chain = directories(zdir, 'ZCODE_CONFIG_DIR_UNSAFE', true);
  return { root, zdir, configPath: path.join(zdir, CONFIG_FILE), receiptPath: path.join(zdir, RECEIPT), roots, chain };
}
function verifyDirectories(expected) {
  for (const [directory, id] of expected) {
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false, bigint: true });
    if (!stat?.isDirectory() || stat.isSymbolicLink() || identity(stat) !== id.path) fail('ZCODE_CONFIG_DIR_UNSAFE');
    if (id.descriptor && directoryIdentity(directory, stat, 'ZCODE_CONFIG_DIR_UNSAFE').descriptor !== id.descriptor) fail('ZCODE_CONFIG_DIR_UNSAFE');
  }
}
function readExisting(file, label = 'ZCODE_CONFIG') {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false, bigint: true });
  if (!stat) return { config: {}, exists: false, bytes: null, version: null, descriptorVersion: null, pathIdentity: null, descriptorIdentity: null };
  safeFile(stat, label);
  let fd;
  try { fd = fs.openSync(file, READ_FLAGS); }
  catch { fail(label + '_UNSAFE'); }
  try {
    const descriptor = fs.fstatSync(fd, { bigint: true }); safeFile(descriptor, label);
    bindDescriptor(file, stat, descriptor, label);
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true }); safeFile(after, label);
    const current = fs.lstatSync(file, { throwIfNoEntry: false, bigint: true });
    if (!current) fail(label + '_CHANGED');
    safeFile(current, label);
    if (bytes.length > 1024 * 1024 || version(after) !== version(descriptor) || version(current) !== version(stat)) fail(label + '_CHANGED');
    let config;
    try { config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail(label + '_INVALID'); }
    if (!object(config)) fail(label + '_INVALID');
    return { config, exists: true, bytes, version: version(stat), descriptorVersion: version(descriptor), pathIdentity: identity(stat), descriptorIdentity: identity(descriptor) };
  } finally { fs.closeSync(fd); }
}
function unchanged(file, expected, label = 'ZCODE_CONFIG') {
  const current = readExisting(file, label);
  if (current.exists !== expected.exists || current.version !== expected.version || current.descriptorVersion !== expected.descriptorVersion ||
      (current.exists && !current.bytes.equals(expected.bytes))) fail(label + '_CHANGED');
  return current;
}
function validateHooks(config) {
  if (!Object.hasOwn(config, 'hooks')) return;
  if (!object(config.hooks) || (Object.hasOwn(config.hooks, 'enabled') && typeof config.hooks.enabled !== 'boolean')) fail('ZCODE_HOOKS_INVALID');
  if (!Object.hasOwn(config.hooks, 'events')) return;
  if (!object(config.hooks.events)) fail('ZCODE_EVENTS_INVALID');
  for (const entries of Object.values(config.hooks.events)) {
    if (!Array.isArray(entries) || entries.some(entry => !object(entry) || !Array.isArray(entry.hooks) ||
        entry.hooks.some(hook => !object(hook)))) fail('ZCODE_EVENTS_INVALID');
  }
}
function hookIdentity(entry) { return canonical(entry); }
function ownedHook(nodePath, cliPath, policyPath) {
  return { matcher: '.*', hooks: [{ type: 'process', command: nodePath, args: [cliPath, 'hook', 'zcode', '--policy', policyPath], timeoutMs: 10000 }] };
}
function ownership(location) {
  const snapshot = readExisting(location.receiptPath, 'ZCODE_RECEIPT');
  if (!snapshot.exists) return { snapshot, record: null };
  const { sha256, ...record } = snapshot.config;
  if (Object.keys(record).sort().join(',') !== 'enabledCreated,entries,eventsCreated,hooksCreated,preToolUseCreated,schemaVersion,workspace' ||
      record.schemaVersion !== 1 || record.workspace !== location.root || !Array.isArray(record.entries) || !record.entries.length ||
      ['hooksCreated', 'enabledCreated', 'eventsCreated', 'preToolUseCreated'].some(key => typeof record[key] !== 'boolean') || digest(record) !== sha256) fail('ZCODE_RECEIPT_INVALID');
  for (const entry of record.entries) {
    const hook = entry?.hooks?.[0], args = hook?.args;
    if (!Array.isArray(args) || args.length !== 5 || ![hook.command, args[0], args[4]].every(absolute) ||
        canonical(entry) !== canonical(ownedHook(hook.command, args[0], args[4]))) fail('ZCODE_RECEIPT_INVALID');
  }
  if (new Set(record.entries.map(hookIdentity)).size !== record.entries.length) fail('ZCODE_RECEIPT_INVALID');
  return { snapshot, record };
}
function plan(location, current, receipt, config, next, nextReceipt) {
  const before = canonical(config), after = canonical(next);
  const receiptConfig = nextReceipt ? { ...nextReceipt, sha256: digest(nextReceipt) } : null;
  const receiptChanged = canonical(receipt.snapshot.exists ? receipt.snapshot.config : null) !== canonical(receiptConfig);
  const result = freeze({ workspace: location.root, configPath: location.configPath, existed: current.exists,
    before, after, config: next, changed: before !== after || receiptChanged });
  plans.set(result, { location, current, receipt: receipt.snapshot, nextReceipt: receiptConfig, receiptChanged });
  return result;
}

/** Read-only merge plan. Ownership stays outside the host's configuration schema. */
export function planZcodeConfig({ workspace, nodePath, cliPath, policyPath, existingConfig }) {
  if (![workspace, nodePath, cliPath, policyPath].every(absolute)) fail('ABSOLUTE_PATH_REQUIRED');
  const location = locations(workspace), current = readExisting(location.configPath), receipt = ownership(location);
  const config = existingConfig === undefined ? current.config : existingConfig;
  if (!object(config)) fail('ZCODE_CONFIG_INVALID');
  validateHooks(current.config); validateHooks(config);
  if (config.hooks?.enabled === false) fail('ZCODE_HOOKS_DISABLED');
  const next = structuredClone(config), addition = ownedHook(nodePath, cliPath, policyPath);
  next.hooks ??= {};
  next.hooks.enabled = true;
  next.hooks.events ??= {};
  next.hooks.events.PreToolUse ??= [];
  const present = next.hooks.events.PreToolUse.some(entry => hookIdentity(entry) === hookIdentity(addition));
  let record = receipt.record ? structuredClone(receipt.record) : null;
  if (!present) {
    next.hooks.events.PreToolUse.push(addition);
    record ??= { schemaVersion: 1, workspace: location.root, hooksCreated: !Object.hasOwn(config, 'hooks'),
      enabledCreated: !Object.hasOwn(config.hooks ?? {}, 'enabled'), eventsCreated: !Object.hasOwn(config.hooks ?? {}, 'events'),
      preToolUseCreated: !Object.hasOwn(config.hooks?.events ?? {}, 'PreToolUse'), entries: [] };
    if (!record.entries.some(entry => hookIdentity(entry) === hookIdentity(addition))) record.entries.push(addition);
  }
  return plan(location, current, receipt, config, next, record);
}

/** Remove exact entries; only a verified receipt permits removal of created scaffolding. */
export function planZcodeUninstall({ workspace, nodePath, cliPath, policyPath }) {
  if (![workspace, nodePath, cliPath, policyPath].every(absolute)) fail('ABSOLUTE_PATH_REQUIRED');
  const location = locations(workspace), current = readExisting(location.configPath), receipt = ownership(location);
  const config = current.config; validateHooks(config);
  const next = structuredClone(config), expected = hookIdentity(ownedHook(nodePath, cliPath, policyPath));
  const entries = next.hooks?.events?.PreToolUse;
  let record = receipt.record ? structuredClone(receipt.record) : null;
  if (entries?.some(entry => hookIdentity(entry) === expected)) {
    next.hooks.events.PreToolUse = entries.filter(entry => hookIdentity(entry) !== expected);
    if (record?.preToolUseCreated && !next.hooks.events.PreToolUse.length) delete next.hooks.events.PreToolUse;
  }
  if (record) {
    record.entries = record.entries.filter(entry => hookIdentity(entry) !== expected);
    if (!record.entries.length) {
      if (record.eventsCreated && next.hooks?.events && !Object.keys(next.hooks.events).length) delete next.hooks.events;
      const hooks = next.hooks;
      const foreign = hooks && (Object.keys(hooks).some(key => !['enabled', 'events'].includes(key)) ||
        Object.values(hooks.events ?? {}).some(value => value.length));
      if (record.enabledCreated && hooks?.enabled === true && !foreign) delete hooks.enabled;
      if (record.hooksCreated && hooks && !Object.keys(hooks).length) delete next.hooks;
      record = null;
    }
  }
  return plan(location, current, receipt, config, next, record);
}

/**
 * Explicit apply under a cooperative workspace-local lock. Rechecks exact bytes and
 * identities before publication. The two files are rolled back on ordinary failure;
 * portable filesystem APIs do not make this pair crash-atomic or fence writers that
 * ignore the lock and race the final rename. A leftover lock requires inspection.
 */
export function applyZcodeConfigPlan(plan) {
  const state = plans.get(plan);
  if (!state || canonical(plan.config) !== plan.after) fail('INVALID_PLAN');
  const { location, current, receipt } = state;
  verifyDirectories(location.chain);
  locations(plan.workspace);
  unchanged(location.configPath, current);
  unchanged(location.receiptPath, receipt, 'ZCODE_RECEIPT');
  if (canonical(current.config) !== plan.before) fail('ZCODE_CONFIG_CHANGED');
  if (!plan.changed) return { changed: false, path: plan.configPath };
  let createdDirectory = false, chain = location.chain;
  const lock = path.join(location.zdir, LOCK);
  let locked = false, lockIdentity;
  const staged = [], published = [];
  const samePath = (file, id, directory = false) => {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false, bigint: true });
    if (!stat || !id || stat.isSymbolicLink() || identity(stat) !== id.path || (directory ? !stat.isDirectory() : !stat.isFile())) return false;
    if (!id.descriptor) return true;
    const current = captureIdentity(file, stat, directory ? 'ZCODE_CONFIG_DIR' : 'ZCODE_CONFIG', directory);
    return current.path === id.path && current.descriptor === id.descriptor;
  };
  const stage = (file, bytes) => {
    const temp = path.join(location.zdir, path.basename(file) + '.' + randomUUID() + '.tmp');
    const fd = fs.openSync(temp, 'wx', 0o600);
    const item = { temp }; staged.push(item);
    try {
      const descriptor = fs.fstatSync(fd, { bigint: true }), stat = fs.lstatSync(temp, { bigint: true });
      safeFile(descriptor, 'ZCODE_CONFIG'); safeFile(stat, 'ZCODE_CONFIG');
      bindDescriptor(temp, stat, descriptor, 'ZCODE_CONFIG');
      item.identity = { path: identity(stat), descriptor: identity(descriptor) };
      fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
    }
    finally { fs.closeSync(fd); }
    return item;
  };
  const written = change => {
    const snapshot = readExisting(change.file, change.label);
    if (snapshot.exists !== Boolean(change.bytes) || (change.bytes &&
        (!snapshot.bytes.equals(change.bytes) || snapshot.pathIdentity !== change.identity.path || snapshot.descriptorIdentity !== change.identity.descriptor))) fail('ZCODE_CONFIG_ROLLBACK_CONFLICT');
    return snapshot;
  };
  try {
    if (!fs.lstatSync(location.zdir, { throwIfNoEntry: false })) {
      try { fs.mkdirSync(location.zdir, { mode: 0o755 }); createdDirectory = true; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    chain = directories(location.zdir, 'ZCODE_CONFIG_DIR_UNSAFE');
    verifyDirectories(location.chain);
    try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { fail('ZCODE_CONFIG_BUSY'); }
    locked = true; lockIdentity = directoryIdentity(lock, fs.lstatSync(lock, { bigint: true }), 'ZCODE_CONFIG_DIR_UNSAFE');
    const changes = [];
    if (state.receiptChanged) changes.push({ file: location.receiptPath, prior: receipt, bytes: state.nextReceipt ? Buffer.from(JSON.stringify(state.nextReceipt, null, 2) + '\n') : null, label: 'ZCODE_RECEIPT' });
    if (plan.before !== plan.after) changes.push({ file: location.configPath, prior: current, bytes: Buffer.from(JSON.stringify(plan.config, null, 2) + '\n'), label: 'ZCODE_CONFIG' });
    for (const change of changes) {
      if (change.bytes) {
        const item = stage(change.file, change.bytes); change.temp = item.temp; change.identity = item.identity;
      }
    }
    verifyDirectories(chain);
    unchanged(location.configPath, current); unchanged(location.receiptPath, receipt, 'ZCODE_RECEIPT');
    for (const change of changes) {
      verifyDirectories(chain);
      if (!samePath(lock, lockIdentity, true)) fail('ZCODE_CONFIG_BUSY');
      unchanged(change.file, change.prior, change.label);
      if (change.bytes) fs.renameSync(change.temp, change.file);
      else fs.unlinkSync(change.file);
      // Track the completed mutation before any fallible readback. If that read
      // fails, rollback can retry only after proving these are still our bytes
      // and the staged inode; it never adopts an external writer's version.
      const publication = { ...change }; published.push(publication);
      publication.installed = written(change);
    }
    for (const change of published) unchanged(change.file, change.installed, change.label);
    verifyDirectories(chain);
    return { changed: true, path: plan.configPath };
  } catch (error) {
    for (const change of published.reverse()) {
      try {
        verifyDirectories(chain);
        const installed = change.installed ?? written(change);
        unchanged(change.file, installed, change.label);
        if (!change.prior.exists) fs.unlinkSync(change.file);
        else {
          const item = stage(change.file, change.prior.bytes);
          unchanged(change.file, installed, change.label); fs.renameSync(item.temp, change.file);
        }
      } catch { fail('ZCODE_CONFIG_ROLLBACK_CONFLICT'); }
    }
    throw error;
  } finally {
    for (const item of staged) {
      if (item.identity && samePath(item.temp, item.identity)) fs.unlinkSync(item.temp);
    }
    if (locked && samePath(lock, lockIdentity, true)) fs.rmdirSync(lock);
    if (createdDirectory) {
      try { verifyDirectories(chain); fs.rmdirSync(location.zdir); }
      catch (error) { if (!['ENOTEMPTY', 'EEXIST'].includes(error.code) && error.message !== 'ZCODE_CONFIG_DIR_UNSAFE') throw error; }
    }
  }
}
