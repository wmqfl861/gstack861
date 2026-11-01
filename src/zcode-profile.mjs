import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { object, canonical, freeze, textDigest } from './json.mjs';
import { inspectPlainPath, assertPlainPathUnchanged, assertPlainFileDescriptor, readPlainFile } from './fs-utils.mjs';

const fail = code => { throw new Error(code); };
const CONFIG_DIR = '.zcode';
const CONFIG_FILE = 'config.json';
const MAX_CONFIG_BYTES = 1024 * 1024;
const LOCK = '.gstack861-zcode-config.lock';
export const ZCODE_RECEIPT_FILE = '.gstack861-zcode-receipt.json';
const plans = new WeakMap();
const has = (value, key) => Object.hasOwn(value, key);
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const sameBytes = (a, b) => a === null ? b === null : b !== null && a.equals(b);
const entryIdentity = entry => canonical(entry);
const ownedHook = ({nodePath, cliPath, policyPath}) => ({matcher:'.*', hooks:[{type:'process', command:nodePath, args:[cliPath,'hook','zcode','--policy',policyPath], timeoutMs:10000}]});
const ioCode = error => /^[A-Z][A-Z0-9_]*$/.test(error?.code) ? error.code
  : /^[A-Z][A-Z0-9_]*$/.test(error?.message) ? error.message : 'ZCODE_CONFIG_IO_ERROR';
function inspect(file, kind, allowMissing, code) {
  try { return inspectPlainPath(file, {kind, allowMissing}); }
  catch (error) {
    if (['PATH_UNSAFE','PATH_CHANGED','ABSOLUTE_PATH_REQUIRED'].includes(error.message)) fail(code);
    fail(ioCode(error));
  }
}
function record(file, code) {
  const snapshot = inspect(file, 'file', true, code);
  if (!snapshot.exists) return {snapshot, bytes:null};
  let bytes;
  try { bytes = readPlainFile(snapshot); }
  catch (error) { fail(['PATH_UNSAFE','PATH_CHANGED'].includes(error.message) ? code : ioCode(error)); }
  if (bytes.length > (code === 'ZCODE_RECEIPT_UNSAFE' ? 4 * MAX_CONFIG_BYTES : MAX_CONFIG_BYTES)) fail(code);
  return {snapshot, bytes};
}
function json(bytes, code) {
  if (bytes === null) return {};
  try { const value = JSON.parse(bytes.toString('utf8')); if (!object(value)) fail(code); return value; }
  catch { fail(code); }
}
function validateConfig(config) {
  if (!object(config)) fail('ZCODE_CONFIG_INVALID');
  if (!has(config,'hooks')) return;
  const hooks = config.hooks;
  if (!object(hooks)) fail('ZCODE_HOOKS_INVALID');
  if (has(hooks,'enabled') && typeof hooks.enabled !== 'boolean') fail('ZCODE_HOOKS_INVALID');
  if (!has(hooks,'events')) return;
  if (!object(hooks.events)) fail('ZCODE_EVENTS_INVALID');
  for (const entries of Object.values(hooks.events)) {
    if (!Array.isArray(entries)) fail('ZCODE_EVENTS_INVALID');
    for (const entry of entries) {
      if (!object(entry) || typeof entry.matcher !== 'string' || !Array.isArray(entry.hooks)) fail('ZCODE_EVENTS_INVALID');
      for (const hook of entry.hooks) {
        if (!object(hook) || typeof hook.type !== 'string' || !hook.type
          || (has(hook,'command') && (typeof hook.command !== 'string' || !hook.command))
          || (['process','command'].includes(hook.type) && typeof hook.command !== 'string')
          || (has(hook,'args') && (!Array.isArray(hook.args) || hook.args.some(arg => typeof arg !== 'string')))
          || (has(hook,'timeoutMs') && (!Number.isFinite(hook.timeoutMs) || hook.timeoutMs <= 0))) fail('ZCODE_EVENTS_INVALID');
      }
    }
  }
  canonical(config);
}
function workspaceIdentity(snapshot) {
  const entry = snapshot.entries.at(-1);
  return {path:snapshot.realPath, dev:entry.dev, ino:entry.ino,
    ...(entry.descriptor ? {descriptor:{dev:entry.descriptor.dev,ino:entry.descriptor.ino,kind:entry.descriptor.kind}} : {})};
}
function validateReceipt(bytes, state) {
  if (bytes === null) return null;
  const receipt = json(bytes, 'ZCODE_RECEIPT_INVALID');
  if (receipt.schemaVersion !== 1 || receipt.owner !== 'gstack861') fail('ZCODE_RECEIPT_INVALID');
  if (receipt.status === 'pending') fail('ZCODE_CONFIG_RECOVERY_REQUIRED');
  if (receipt.status !== 'committed' || !object(receipt.workspace) || !object(receipt.identity)
    || !object(receipt.original) || !object(receipt.entry)) fail('ZCODE_RECEIPT_INVALID');
  if (Object.keys(receipt).some(key => !['schemaVersion','owner','status','workspace','identity','entry','original'].includes(key))) fail('ZCODE_RECEIPT_INVALID');
  if (canonical(receipt.workspace) !== canonical(workspaceIdentity(state.workspace))) fail('ZCODE_RECEIPT_CONFLICT');
  for (const key of ['nodePath','cliPath','policyPath']) {
    if (typeof receipt.identity[key] !== 'string' || !path.isAbsolute(receipt.identity[key])) fail('ZCODE_RECEIPT_INVALID');
  }
  if (Object.keys(receipt.identity).length !== 3 || entryIdentity(receipt.entry) !== entryIdentity(ownedHook(receipt.identity))) fail('ZCODE_RECEIPT_INVALID');
  const flags = ['configExisted','hooksPresent','eventsPresent','preToolUsePresent','enabledPresent'];
  if (Object.keys(receipt.original).length !== flags.length || flags.some(key => typeof receipt.original[key] !== 'boolean')
    || (!receipt.original.hooksPresent && (receipt.original.eventsPresent || receipt.original.enabledPresent))
    || (!receipt.original.eventsPresent && receipt.original.preToolUsePresent)) fail('ZCODE_RECEIPT_INVALID');
  if (canonical(receipt.identity) !== canonical(state.identity)) fail('ZCODE_RECEIPT_CONFLICT');
  return receipt;
}
function inspectState(options) {
  const {workspace,nodePath,cliPath,policyPath} = options;
  if (![workspace,nodePath,cliPath,policyPath].every(p => typeof p === 'string' && path.isAbsolute(p) && !/[\x00-\x1f]/.test(p))) fail('ABSOLUTE_PATH_REQUIRED');
  const root = inspect(workspace, 'directory', false, 'WORKSPACE_INVALID');
  const dirPath = path.join(root.path, CONFIG_DIR), dir = inspect(dirPath, 'directory', true, 'ZCODE_CONFIG_DIR_UNSAFE');
  const state = {workspace:root, dir, identity:{nodePath,cliPath,policyPath}, configPath:path.join(dirPath,CONFIG_FILE), receiptPath:path.join(dirPath,ZCODE_RECEIPT_FILE)};
  state.configRecord = record(state.configPath, 'ZCODE_CONFIG_UNSAFE');
  state.receiptRecord = record(state.receiptPath, 'ZCODE_RECEIPT_UNSAFE');
  state.config = json(state.configRecord.bytes, 'ZCODE_CONFIG_INVALID');
  validateConfig(state.config);
  state.receipt = validateReceipt(state.receiptRecord.bytes, state);
  return state;
}
function assertRecord(value) {
  assertPlainPathUnchanged(value.snapshot);
  if (value.bytes !== null && !sameBytes(readPlainFile(value.snapshot), value.bytes)) fail('ZCODE_CONFIG_CHANGED');
}
function assertDirectories(state) {
  assertPlainPathUnchanged(state.workspace);
  assertPlainPathUnchanged(state.dir);
  if (state.lock) assertPlainPathUnchanged(state.lock);
}
function assertCurrent(state) {
  try { assertDirectories(state); assertRecord(state.configRecord); assertRecord(state.receiptRecord); }
  catch (error) {
    fail(['PATH_UNSAFE','PATH_CHANGED','ABSOLUTE_PATH_REQUIRED'].includes(error.message) ? 'ZCODE_CONFIG_CHANGED' : ioCode(error));
  }
}
function makePlan(state, config, receipt, operation, applicable = true) {
  const nextBytes = canonical(config) === canonical(state.config) ? state.configRecord.bytes : encode(config);
  const removeConfig = operation === 'uninstall' && state.receipt && !state.receipt.original.configExisted && Object.keys(config).length === 0;
  const desiredConfig = removeConfig ? null : nextBytes;
  if (desiredConfig !== null && desiredConfig.length > MAX_CONFIG_BYTES) fail('ZCODE_CONFIG_UNSAFE');
  const desiredReceipt = receipt === state.receipt ? state.receiptRecord.bytes : receipt === null ? null : encode(receipt);
  const changed = !sameBytes(desiredConfig,state.configRecord.bytes) || !sameBytes(desiredReceipt,state.receiptRecord.bytes);
  const plan = freeze({workspace:state.workspace.path, configPath:state.configPath, existed:state.configRecord.bytes !== null,
    before:canonical(state.config), after:canonical(config), config:structuredClone(config), changed});
  plans.set(plan, {...state, desiredConfig, desiredReceipt, operation, applicable});
  return plan;
}

/** Read-only, immutable plan bound to the exact file bytes and plain-path identities. */
export function planZcodeConfig(options) {
  const state = inspectState(options);
  let config = state.config, applicable = true;
  if (options.existingConfig !== undefined) {
    validateConfig(options.existingConfig);
    applicable = canonical(options.existingConfig) === canonical(config);
    config = structuredClone(options.existingConfig);
  }
  if (config.hooks?.enabled === false) fail('ZCODE_HOOKS_DISABLED');
  const entry = ownedHook(state.identity), entries = config.hooks?.events?.PreToolUse ?? [];
  if (entries.some(item => entryIdentity(item) === entryIdentity(entry))) {
    // An already present hook is user-owned unless an existing receipt proves otherwise.
    // In particular, do not add enabled:true or create flag-only ownership.
    return makePlan(state, config, state.receipt, 'install', applicable);
  }
  if (state.receipt) fail('ZCODE_RECEIPT_CONFLICT');
  const result = structuredClone(config), original = {configExisted:state.configRecord.bytes !== null,
    hooksPresent:has(config,'hooks'), eventsPresent:has(config.hooks ?? {},'events'),
    preToolUsePresent:has(config.hooks?.events ?? {},'PreToolUse'), enabledPresent:has(config.hooks ?? {},'enabled')};
  result.hooks ??= {}; result.hooks.enabled = true; result.hooks.events ??= {};
  result.hooks.events.PreToolUse ??= []; result.hooks.events.PreToolUse.push(entry);
  const receipt = {schemaVersion:1, owner:'gstack861', status:'committed', workspace:workspaceIdentity(state.workspace), identity:state.identity, entry, original};
  return makePlan(state, result, receipt, 'install', applicable);
}

/** Remove at most one receipt-proven full entry; a missing receipt never grants ownership. */
export function planZcodeUninstall(options) {
  const state = inspectState(options);
  if (!state.receipt) return makePlan(state, state.config, null, 'uninstall');
  const result = structuredClone(state.config), receipt = state.receipt;
  const entries = result.hooks?.events?.PreToolUse;
  const index = entries?.findIndex(entry => entryIdentity(entry) === entryIdentity(receipt.entry)) ?? -1;
  if (index !== -1) entries.splice(index,1);
  if (result.hooks) {
    if (!receipt.original.preToolUsePresent && entries?.length === 0) delete result.hooks.events.PreToolUse;
    if (!receipt.original.eventsPresent && result.hooks.events && !Object.keys(result.hooks.events).length) delete result.hooks.events;
    if (!receipt.original.enabledPresent && result.hooks.enabled === true) delete result.hooks.enabled;
    if (!receipt.original.hooksPresent && !Object.keys(result.hooks).length) delete result.hooks;
  }
  return makePlan(state, result, null, 'uninstall');
}

// After expected creation, retain every saved ancestor identity before capturing the
// new suffix. Dropping missing entries is never permission to rebase old ancestors.
function assertExisting(snapshot) {
  assertPlainPathUnchanged({...snapshot, missing:[]});
}
function prepareDirectory(state) {
  if (state.dir.exists) return false;
  const old = state.dir;
  assertCurrent(state);
  fs.mkdirSync(old.path, {mode:0o755});
  assertExisting(old);
  assertExisting(state.configRecord.snapshot); assertExisting(state.receiptRecord.snapshot);
  state.dir = inspectPlainPath(old.path, {kind:'directory'});
  for (const key of ['configRecord','receiptRecord']) {
    const value = state[key], snapshot = inspectPlainPath(value.snapshot.path, {kind:'file',allowMissing:true});
    if (snapshot.exists) fail('ZCODE_CONFIG_CHANGED');
    state[key] = {snapshot,bytes:null};
  }
  return true;
}
function fingerprint(value) {
  return {exists:value !== null, sha256:value === null ? null : textDigest(value)};
}
function pendingIntent(state) {
  return encode({schemaVersion:1, owner:'gstack861', status:'pending', operation:state.operation, transactionId:randomUUID(),
    workspace:workspaceIdentity(state.workspace), identity:state.identity,
    ownership:state.desiredReceipt === null ? state.receipt : json(state.desiredReceipt,'ZCODE_RECEIPT_INVALID'),
    before:{config:{...fingerprint(state.configRecord.bytes), bytesBase64:state.configRecord.bytes?.toString('base64') ?? null},
      receipt:{...fingerprint(state.receiptRecord.bytes), bytesBase64:state.receiptRecord.bytes?.toString('base64') ?? null}},
    after:{config:fingerprint(state.desiredConfig),receipt:fingerprint(state.desiredReceipt)}});
}
function readWritten(state, value) {
  assertDirectories(state);
  if (value.bytes === null && inspectPlainPath(value.snapshot.path,{kind:'file',allowMissing:true}).exists) fail('ZCODE_CONFIG_CHANGED');
  assertRecord(value);
}
// A successful syscall advances the expected state before fallible verification.
// Only transplant the proven temp leaf; never rebase the saved ancestor identities.
function writtenRecord(current, bytes, owned) {
  const snapshot = current.snapshot;
  const ancestors = snapshot.exists ? snapshot.entries.slice(0,-1) : snapshot.entries;
  const entries = bytes === null ? ancestors : [...ancestors, {...owned.entries.at(-1),path:snapshot.path}];
  return {snapshot:freeze({...snapshot,exists:bytes !== null,entries,missing:bytes === null ? [snapshot.path] : []}),bytes};
}
function replaceRecord(state, key, bytes) {
  assertCurrent(state);
  const current = state[key], filename = current.snapshot.path;
  if (sameBytes(current.bytes,bytes)) return;
  if (bytes === null) {
    fs.unlinkSync(filename);
    state[key] = writtenRecord(current,null);
    readWritten(state,state[key]);
    return;
  }
  const temp = filename + '.' + randomUUID() + '.tmp';
  let owned = null, moved = false, cleanupBytes = Buffer.alloc(0);
  try {
    // Exclusive creation gives cleanup an identity before a potentially partial write.
    const fd = fs.openSync(temp,'wx',0o600);
    try {
      const candidate = inspectPlainPath(temp,{kind:'file'});
      try { assertPlainFileDescriptor(candidate,fd); }
      catch { fail('ZCODE_CONFIG_CHANGED'); }
      owned = candidate;
    } finally { fs.closeSync(fd); }
    assertCurrent(state); assertPlainPathUnchanged(owned);
    const intendedBytes = Buffer.from(bytes);
    fs.writeFileSync(temp,bytes,{flag:'r+',mode:0o600});
    cleanupBytes = intendedBytes;
    assertCurrent(state); assertPlainPathUnchanged(owned);
    if (!sameBytes(readPlainFile(owned),bytes)) fail('ZCODE_CONFIG_CHANGED');
    // These pathname checks detect observed changes; they cannot make rename OS-atomic
    // against a hostile same-user swap inside its final syscall (ZC-07 remains open).
    assertCurrent(state); assertPlainPathUnchanged(owned);
    fs.renameSync(temp,filename); moved = true;
    state[key] = writtenRecord(current,bytes,owned);
    readWritten(state,state[key]);
  } finally {
    if (owned && !moved) {
      try {
        assertDirectories(state); assertPlainPathUnchanged(owned);
        if (readPlainFile(owned).equals(cleanupBytes)) fs.unlinkSync(temp);
      } catch { /* Retain unproven recovery data and preserve the primary failure. */ }
    }
  }
}
function rollback(state, originalConfig, originalReceipt) {
  // Unexpected user edits or identity changes invalidate the current write proof;
  // retain the pending receipt rather than overwrite those edits during recovery.
  assertCurrent(state);
  replaceRecord(state,'configRecord',originalConfig);
  replaceRecord(state,'receiptRecord',originalReceipt);
}

/** Explicit apply of an authentic plan. Cooperative lock + recoverable intent, not an OS sandbox. */
export function applyZcodeConfigPlan(plan) {
  const saved = plan && plans.get(plan);
  if (!saved) fail('INVALID_PLAN');
  if (!saved.applicable) fail('ZCODE_CONFIG_CHANGED');
  const state = {...saved};
  assertCurrent(state);
  if (!plan.changed) return {changed:false,path:plan.configPath};
  let createdDirectory = false, committed = false, failure = null;
  try {
    createdDirectory = prepareDirectory(state);
    assertCurrent(state);
    const lockPath = path.join(state.dir.path,LOCK);
    try { fs.mkdirSync(lockPath,{mode:0o700}); }
    catch (error) { fail(error.code === 'EEXIST' ? 'ZCODE_CONFIG_BUSY' : ioCode(error)); }
    state.lock = inspectPlainPath(lockPath,{kind:'directory'});
    assertCurrent(state);
    const originalConfig = state.configRecord.bytes, originalReceipt = state.receiptRecord.bytes;
    const originalReceiptRecord = state.receiptRecord, intent = pendingIntent(state);
    try {
      replaceRecord(state,'receiptRecord',intent);
      replaceRecord(state,'configRecord',state.desiredConfig);
      replaceRecord(state,'receiptRecord',state.desiredReceipt);
      committed = true;
    } catch (error) {
      // The initial intent may already be published even if its readback threw.
      if (state.receiptRecord !== originalReceiptRecord) {
        const finalized = sameBytes(state.receiptRecord.bytes,state.desiredReceipt);
        try {
          // Final receipt promotion/deletion removed the blocking intent. Restore
          // it before config rollback so a second fault cannot appear committed.
          if (finalized) replaceRecord(state,'receiptRecord',intent);
          rollback(state,originalConfig,originalReceipt);
        } catch {
          try { assertDirectories(state); assertRecord(state.receiptRecord); }
          catch { fail('ZCODE_CONFIG_RECOVERY_UNCERTAIN'); }
          fail(sameBytes(state.receiptRecord.bytes,intent) ? 'ZCODE_CONFIG_RECOVERY_REQUIRED'
            : finalized ? 'ZCODE_CONFIG_COMMITTED_RECOVERY_FAILED' : 'ZCODE_CONFIG_RECOVERY_UNCERTAIN');
        }
      }
      fail(ioCode(error));
    }
  } catch (error) { failure = error; }
  finally {
    if (state.lock) {
      try { assertDirectories(state); fs.rmdirSync(state.lock.path); }
      catch (error) {
        failure ??= new Error(committed ? 'ZCODE_CONFIG_COMMITTED_CLEANUP_FAILED' : 'ZCODE_CONFIG_RECOVERY_REQUIRED');
        failure.cleanupCode = ioCode(error);
      }
      state.lock = null;
    }
    if (failure && createdDirectory) {
      try {
        assertPlainPathUnchanged(state.workspace); assertPlainPathUnchanged(state.dir);
        // Nonrecursive removal only; concurrent foreign entries remain untouched.
        if (fs.readdirSync(state.dir.path).length === 0) fs.rmdirSync(state.dir.path);
      } catch { /* Preserve nonempty, replaced or otherwise unproven resources. */ }
    }
  }
  if (failure) throw failure;
  return {changed:true,path:plan.configPath};
}
