#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy } from '../src/policy.mjs';
import { handleZcode, denyZcode, zcodeHookConfig } from '../src/adapters/zcode.mjs';
import { inventory } from '../src/inventory.mjs';
import { generateSkills } from '../src/generate.mjs';
import { installSkills, uninstallSkills } from '../src/install.mjs';
import { ApprovalStore } from '../src/approvals.mjs';
import { TaskStore } from '../src/tasks.mjs';

const args = process.argv.slice(2);
const print = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
function flags(tokens, allowed, booleans = []) {
  const result = {};
  for (let i = 0; i < tokens.length; i++) {
    const key = tokens[i];
    if (booleans.includes(key)) {
      if (Object.hasOwn(result, key)) throw new Error('INVALID_ARGUMENTS');
      result[key] = true;
      continue;
    }
    if (!allowed.includes(key) || Object.hasOwn(result, key) || !tokens[i + 1] || tokens[i + 1].startsWith('--')) throw new Error('INVALID_ARGUMENTS');
    result[key] = tokens[i + 1];
    i++;
  }
  return result;
}
const absolute = value => {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('ABSOLUTE_PATH_REQUIRED');
  return value;
};
/** Rebuild a subject from operator flags plus the action file; only its digest is ever persisted. */
const subjectFrom = options => {
  let action;
  try { action = JSON.parse(fs.readFileSync(absolute(options['--action-file']), 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) throw new Error('INVALID_ACTION_FILE'); throw error; }
  return { host: options['--host'], sessionId: options['--session'], runId: options['--run'],
    policyHash: options['--policy-hash'], action };
};
const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const lock = () => JSON.parse(fs.readFileSync(new URL('../upstream.lock.json', import.meta.url), 'utf8'));

if (args[0] === 'hook') {
  let result;
  try {
    if (args[1] !== 'zcode') throw new Error('UNKNOWN_HOST');
    const options = flags(args.slice(2), ['--policy']);
    const policy = loadPolicy(options['--policy']);
    const chunks = []; let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      // 4 MiB cap: hosts may embed whole file contents in tool_input, which the old
      // 1 MiB limit refused; the cap still bounds memory before JSON.parse runs.
      if (bytes > 4 * 1024 * 1024) throw new Error('INPUT_TOO_LARGE');
      chunks.push(chunk);
    }
    // Decode once: per-chunk decoding splits multi-byte UTF-8 characters at chunk boundaries.
    result = handleZcode(JSON.parse(Buffer.concat(chunks).toString('utf8')), policy);
  } catch (error) { result = denyZcode(/^[A-Z][A-Z0-9_]*$/.test(error?.message) ? error.message : 'HOOK_INPUT_OR_POLICY_ERROR'); }
  print(result.output);
  process.exitCode = result.exitCode;
} else {
  try {
    if (args[0] === 'doctor' && args.length === 1) {
      print({ version, node: process.version, platform: process.platform, baseline: lock(),
        hosts: { zcode: 'not-host-verified', dsh: 'not-host-verified' },
        networkCalls: 0, modelCalls: 0,
        safety: 'guard-protocol foundation; not an OS sandbox; no full-parity certification' });
    } else if (args[0] === 'inventory') {
      const options = flags(args.slice(1), ['--upstream']);
      if (!options['--upstream']) throw new Error('UPSTREAM_PATH_REQUIRED');
      print(inventory(path.resolve(options['--upstream']), lock().gstack.commit));
    } else if (args[0] === 'zcode-config') {
      const options = flags(args.slice(1), ['--policy', '--matcher']);
      loadPolicy(absolute(options['--policy']));
      print(zcodeHookConfig({ nodePath: process.execPath, cliPath: fileURLToPath(import.meta.url),
        policyPath: absolute(options['--policy']), matcher: options['--matcher'] }));
    } else if (args[0] === 'generate') {
      const options = flags(args.slice(1), ['--upstream', '--staging', '--host']);
      // GSTACK861_TEST_COMMIT overrides the lock pin for fixtures only; production
      // flows read the lock file. When the override is active it is announced on stderr.
      const override = process.env.GSTACK861_TEST_COMMIT;
      const commit = override ?? lock().gstack.commit;
      if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('FULL_COMMIT_REQUIRED');
      if (override !== undefined) process.stderr.write(`gstack861: TEST_COMMIT_OVERRIDE active (${commit.slice(0, 12)})\n`);
      print(generateSkills({ upstream: absolute(options['--upstream']), commit,
        staging: absolute(options['--staging']), host: options['--host'] }));
    } else if (args[0] === 'install') {
      const options = flags(args.slice(1), ['--staging', '--target']);
      print(installSkills({ staging: absolute(options['--staging']), target: absolute(options['--target']) }));
    } else if (args[0] === 'uninstall') {
      const options = flags(args.slice(1), ['--target'], ['--purge']);
      print(uninstallSkills({ target: absolute(options['--target']), purge: options['--purge'] === true }));
    } else if (args[0] === 'approvals') {
      const options = flags(args.slice(2), ['--state', '--id', '--host', '--session', '--run', '--policy-hash', '--action-file', '--ttl-ms']);
      // Validate before constructing the store: a rejected subcommand or argument
      // must not leave a state directory behind.
      if (!['list', 'show', 'issue', 'approve', 'reject', 'consume', 'verify'].includes(args[1])) throw new Error('UNKNOWN_SUBCOMMAND');
      const ttlRaw = options['--ttl-ms'];
      const ttlMs = ttlRaw === undefined ? undefined : Number(ttlRaw);
      // Same bounds as ApprovalStore.issue, checked here so a refused value cannot
      // leave a freshly created state directory behind.
      if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 86400000)) throw new Error('INVALID_TTL');
      const store = new ApprovalStore(absolute(options['--state']));
      if (args[1] === 'list') print(store.list().map(({ id, state, issuedAt, expiresAt }) => ({ id, state, issuedAt, expiresAt })));
      else if (args[1] === 'show') print(store.get(options['--id']));
      else if (args[1] === 'issue') {
        print(store.issue(subjectFrom(options), ttlMs === undefined ? {} : { ttlMs }));
      } else if (args[1] === 'verify') print(store.verify(options['--id'], subjectFrom(options)));
      else {
        const subject = subjectFrom(options);
        print(args[1] === 'approve' ? store.approve(options['--id'], subject)
          : args[1] === 'consume' ? store.consume(options['--id'], subject)
          : store.reject(options['--id'], subject));
      }
    } else if (args[0] === 'tasks') {
      const options = flags(args.slice(2), ['--state', '--id', '--host', '--session', '--run', '--policy-hash', '--action-file', '--owner']);
      // Validate before constructing the store: a rejected subcommand or argument
      // must not leave a state directory behind.
      if (!['create', 'start', 'resume', 'complete', 'fail', 'cancel', 'interrupt', 'show', 'list'].includes(args[1])) throw new Error('UNKNOWN_SUBCOMMAND');
      const owner = options['--owner'];
      if (owner !== undefined && !['create', 'start'].includes(args[1])) throw new Error('INVALID_ARGUMENTS');
      // Same shape as TaskStore.create/start, checked before any directory is created.
      if (owner !== undefined && (owner.length < 1 || owner.length > 256)) throw new Error('INVALID_OWNER');
      const store = new TaskStore(absolute(options['--state']));
      if (args[1] === 'list') print(store.list());
      else if (args[1] === 'show') print(store.get(options['--id']));
      else if (args[1] === 'create') print(store.create(subjectFrom(options), owner === undefined ? {} : { owner }));
      else if (args[1] === 'start') print(store.start(options['--id'], subjectFrom(options), owner === undefined ? {} : { owner }));
      else print(store[args[1]](options['--id'], subjectFrom(options)));
    } else {
      process.stderr.write('Usage: gstack861 doctor | inventory --upstream PATH | zcode-config --policy ABS_PATH\n'
        + '  generate --upstream PATH --staging DIR --host zcode|dsh\n'
        + '    (env GSTACK861_TEST_COMMIT overrides the upstream lock pin for TESTS only; default = upstream.lock.json)\n'
        + '  install --staging DIR --target DIR | uninstall --target DIR [--purge]\n'
        + '  approvals list --state DIR | show --state DIR --id ID\n'
        + '  approvals issue --state DIR --host H --session S --run R --policy-hash HASH --action-file F [--ttl-ms N]\n'
        + '  approvals approve|reject|consume --state DIR --id ID --host H --session S --run R --policy-hash HASH --action-file F\n'
        + '  approvals verify --state DIR --id ID --host H --session S --run R --policy-hash HASH --action-file F\n'
        + '  tasks create|start --state DIR [--id ID] --host H --session S --run R --policy-hash HASH --action-file F [--owner O]\n'
        + '  tasks resume|complete|fail|cancel|interrupt --state DIR --id ID --host H --session S --run R --policy-hash HASH --action-file F\n'
        + '  tasks show --state DIR --id ID | tasks list --state DIR\n');
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`gstack861: ${error.code ?? error.message}\n`);
    process.exitCode = 1;
  }
}
